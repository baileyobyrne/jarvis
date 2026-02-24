const fs = require('fs');
const axios = require('axios');
const { Client } = require('@notionhq/client');
require('dotenv').config({ path: '/root/.openclaw/.env', override: true });

const CONTACTS_FILE = '/root/.openclaw/workspace/willoughby-contacts.json';
const RP_DATA_FILE = '/root/.openclaw/workspace/rp_data.csv';
const COOLDOWN_FILE = '/root/.openclaw/workspace/recently-planned.json';
const COOLDOWN_DAYS = 90;         // days before a daily-planned contact is eligible again
const NOTION_COOLDOWN_DAYS = 180; // days before a Notion-contacted contact is eligible again
const DAILY_TARGET = 80;          // maximum cards on the board at any one time
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function normalizeSuburb(suburb) {
    if (!suburb) return '';
    const s = suburb.toUpperCase().trim();
    if (s === 'NORTH WILLOUGHBY' || s === 'WILLOUGHBY EAST' || s === 'WILLOUGHBY') {
        return 'WILLOUGHBY';
    }
    return s;
}

function parseRPData(filePath) {
    if (!fs.existsSync(filePath)) {
        console.warn(`RP Data file not found: ${filePath}`);
        return new Map();
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const headerLine = lines[2]; // Headers are on line 3 (index 2)
    if (!headerLine) return new Map();
    
    const parseLine = (line) => {
        const values = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') inQuotes = !inQuotes;
            else if (char === ',' && !inQuotes) {
                values.push(current.trim());
                current = '';
            } else current += char;
        }
        values.push(current.trim());
        return values;
    };

    const headers = parseLine(headerLine).map(h => h.replace(/"/g, ''));
    const lookup = new Map();

    for (let i = 3; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const values = parseLine(line).map(v => v.replace(/"/g, ''));
        const entry = {};
        headers.forEach((h, idx) => {
            entry[h] = values[idx] || '';
        });

        const street = (entry['Street Address'] || '').toUpperCase().trim();
        const suburb = normalizeSuburb(entry['Suburb']);
        const addressKey = `${street} ${suburb}`.trim();
        lookup.set(addressKey, entry);
    }
    return lookup;
}

// ─── COOLDOWN TRACKER ────────────────────────────────────────────────────────

function loadCooldown() {
    if (!fs.existsSync(COOLDOWN_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveCooldown(cooldown) {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown, null, 2));
}

function isOnCooldown(contactId, cooldown) {
    const entry = cooldown[contactId];
    if (!entry) return false;
    // Respect per-entry cooldownDays (Notion-synced contacts use 180 days; local planned use 90)
    const days = entry.cooldownDays || COOLDOWN_DAYS;
    const daysSince = (Date.now() - new Date(entry.plannedAt).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince < days;
}

// ─── NOTION HELPERS ───────────────────────────────────────────────────────────

// Returns the total number of pages in the database matching a given Status value.
async function countNotionStatus(notion, databaseId, status) {
    let count = 0;
    let cursor = undefined;
    do {
        const res = await notion.databases.query({
            database_id: databaseId,
            filter: { property: 'Status', status: { equals: status } },
            start_cursor: cursor,
            page_size: 100
        });
        count += res.results.length;
        cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return count;
}

// Queries Notion for all cards with a "contacted" status, matches them against
// the local AgentBox contacts by name, and writes them into the cooldown map
// with a 180-day lockout so they are excluded from future scoring runs.
async function syncNotionCooldowns(notion, databaseId, contacts, cooldown) {
    const CONTACTED_STATUSES = [
        '🗣️ Connected',
        '⏳ Left Message',
        '🤝 Appraisal Booked',
        '🚫 Not Interested'
    ];

    // Build a lowercase-name → contact lookup for fast matching
    const nameMap = new Map();
    for (const c of contacts) {
        if (c.name) nameMap.set(c.name.toLowerCase().trim(), c);
    }

    let synced = 0;
    let unmatched = 0;

    for (const status of CONTACTED_STATUSES) {
        let cursor = undefined;
        do {
            const res = await notion.databases.query({
                database_id: databaseId,
                filter: { property: 'Status', status: { equals: status } },
                start_cursor: cursor,
                page_size: 100
            });

            for (const page of res.results) {
                // Extract the contact name from the page title property
                const titleProp = Object.values(page.properties).find(p => p.type === 'title');
                const name = titleProp?.title?.[0]?.plain_text?.trim();
                if (!name) continue;

                const contact = nameMap.get(name.toLowerCase().trim());
                if (contact) {
                    const id = contact.id || contact.mobile;
                    // Don't overwrite an existing entry with a shorter cooldown
                    if (!cooldown[id] || (cooldown[id].cooldownDays || COOLDOWN_DAYS) < NOTION_COOLDOWN_DAYS) {
                        cooldown[id] = {
                            plannedAt: new Date().toISOString(),
                            name: contact.name,
                            cooldownDays: NOTION_COOLDOWN_DAYS,
                            source: `notion:${status}`
                        };
                        synced++;
                    }
                } else {
                    unmatched++;
                }
            }

            cursor = res.has_more ? res.next_cursor : undefined;
        } while (cursor);
    }

    console.log(`Notion sync: ${synced} contacts locked out for ${NOTION_COOLDOWN_DAYS} days, ${unmatched} names unmatched in AgentBox.`);
}

// ─────────────────────────────────────────────────────────────────────────────

function calculateScore(contact, truthEntry) {
    let score = 0;

    // 1. High Tenure (+20 points if owned > 7 years)
    if (truthEntry && truthEntry['Sale Date']) {
        const saleDateStr = truthEntry['Sale Date'];
        const saleYearMatch = saleDateStr.match(/\d{4}/);
        if (saleYearMatch) {
            const saleYear = parseInt(saleYearMatch[0]);
            const currentYear = new Date().getFullYear();
            if (currentYear - saleYear > 7) {
                score += 20;
            }
        }
    }

    // 2. Past Appraisals (+30 points if they have an appraisal history)
    if (contact.appraisals && contact.appraisals.length > 0) {
        score += 30;
    }

    // 3. Investor Status (+15 points if RP data shows it is rented/not owner-occupied)
    if (truthEntry && truthEntry['Owner Type'] === 'Rented') {
        score += 15;
    }

    return score;
}

async function generateTalkingPoint(contact, truthEntry) {
    const currentYear = new Date().getFullYear();
    const saleDateStr = truthEntry?.['Sale Date'] || 'Unknown';
    let tenureYears = 'Unknown';
    if (saleDateStr !== 'Unknown') {
        const saleYearMatch = saleDateStr.match(/\d{4}/);
        if (saleYearMatch) {
            tenureYears = currentYear - parseInt(saleYearMatch[0]);
        }
    }

    const context = {
        name: contact.name,
        address: contact.address || truthEntry?.['Street Address'],
        tenure: saleDateStr,
        tenureYears: tenureYears,
        ownerType: truthEntry?.['Owner Type'] || 'Unknown',
        appraisals: contact.appraisals?.length || 0,
        notes: contact.notes?.map(n => n.description).join('; ') || 'None'
    };

    const prompt = `You are a strategic real estate analyst generating a call prep brief for Bailey O'Byrne at McGrath Willoughby.

The current year is ${currentYear}. All references to timing, market conditions, and strategic asks must reflect ${currentYear} — do not reference any prior year.

Generate 4 to 5 highly concise, punchy bullet points for a phone call with ${context.name} at ${context.address}.

Data available:
- Current Year: ${currentYear}
- Tenure: ${context.tenure} (${context.tenureYears} years)
- Owner Type: ${context.ownerType}
- Past Appraisals: ${context.appraisals}
- Notes: ${context.notes}

You must format the output identically for every single contact. Do NOT use Markdown asterisks (**). Use clean bullet points and standard emojis so it renders beautifully in a Notion database text field.

Cover these 4 areas in order, each as exactly one tight bullet point (add a 5th only if there is a genuinely strong additional angle):

📌 DATA TRIGGER: [Tenure or occupancy signal — e.g. "Owned 11 years — statistically overdue for a move" or "Investor — not emotionally attached, motivated by yield"]
📈 VALUE ADD: [Specific local market intel to offer — e.g. "Recent comp at 42 Smith St sold $2.1M — strong conversation anchor"]
📋 CRM HOOK: [Reference past notes or appraisal history to personalise the call — e.g. "Appraised in 2021 — worth revisiting given where the market sits now"]
🎯 STRATEGIC ASK: [The one clear ask for this call — e.g. "Float a no-pressure market appraisal"]

Keep every bullet to one punchy line. No paragraphs. No fluff. No extra commentary. No Markdown asterisks.`;

    try {
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: "claude-sonnet-4-6",
            max_tokens: 350,
            messages: [{ role: "user", content: prompt }]
        }, {
            headers: {
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            }
        });

        return response.data.content[0].text.trim();
    } catch (error) {
        console.error('Anthropic error:', error.response?.data || error.message);
        return "• WHY TO CALL: Long-term tenure trigger.\n• VALUE ADD: Local market update offer.";
    }
}

async function main() {
    console.log('Loading contacts and RP data...');
    const contactsData = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    const truthLookup = parseRPData(RP_DATA_FILE);
    const contacts = contactsData.contacts;

    // ─── NOTION PRE-FLIGHT ────────────────────────────────────────────────────
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    const databaseId = process.env.NOTION_DATABASE_ID;

    console.log('Checking Notion board...');
    const currentCount = await countNotionStatus(notion, databaseId, '🎯 To Call Today');
    console.log(`Current "🎯 To Call Today" count: ${currentCount} / ${DAILY_TARGET}`);

    const targetCalls = DAILY_TARGET - currentCount;
    if (targetCalls <= 0) {
        console.log('Board is full. No new contacts needed.');
        return;
    }
    console.log(`Slots available: ${targetCalls} new contacts to generate.`);

    // Sync Notion "contacted" statuses → local cooldown (180-day lockout)
    const cooldown = loadCooldown();
    console.log('Syncing Notion contacted statuses into cooldown...');
    await syncNotionCooldowns(notion, databaseId, contacts, cooldown);
    saveCooldown(cooldown); // persist Notion sync before scoring
    // ─────────────────────────────────────────────────────────────────────────

    // Filter out contacts on cooldown (local 90-day + Notion 180-day)
    const eligibleContacts = contacts.filter(c => {
        const id = c.id || c.mobile;
        return !isOnCooldown(id, cooldown);
    });
    console.log(`Cooldown filter: ${contacts.length - eligibleContacts.length} contacts excluded. ${eligibleContacts.length} eligible.`);

    console.log('Scoring contacts...');
    const scoredContacts = eligibleContacts.map(contact => {
        const street = (contact.address || '').toUpperCase().trim();
        const suburb = normalizeSuburb(contact.suburb || '');
        const addressKey = `${street} ${suburb}`.trim();
        const truthEntry = truthLookup.get(addressKey);

        const score = calculateScore(contact, truthEntry);
        return { ...contact, score, truthEntry };
    });

    // Select exactly targetCalls contacts (not a hardcoded 80)
    const topContacts = scoredContacts
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, targetCalls);

    console.log(`${topContacts.length} candidates selected. Generating talking points via Claude...`);
    const finalPayload = [];

    for (const contact of topContacts) {
        const talkingPoint = await generateTalkingPoint(contact, contact.truthEntry);
        const saleYearMatch = contact.truthEntry?.['Sale Date']?.match(/\d{4}/);
        const tenure = saleYearMatch ? `${new Date().getFullYear() - parseInt(saleYearMatch[0])} years` : 'Unknown';
        finalPayload.push({
            name: contact.name,
            mobile: contact.mobile,
            address: `${contact.address || contact.truthEntry?.['Street Address']}, ${contact.suburb || contact.truthEntry?.['Suburb'] || ''}`.trim().replace(/,\s*$/, ''),
            score: contact.score,
            strategicTalkingPoint: talkingPoint,
            source: 'Daily Planner',
            tenure
        });
        process.stdout.write('.');
    }
    console.log('\nTalking points generated.');

    console.log('Writing contacts to Notion...');
    let notionSuccess = 0;
    let notionFailed = 0;
    for (const contact of finalPayload) {
        try {
            await notion.pages.create({
                parent: { database_id: databaseId },
                properties: {
                    'Contact Name': { title: [{ text: { content: contact.name || '' } }] },
                    'Property Address': { rich_text: [{ text: { content: contact.address || '' } }] },
                    'Mobile': { phone_number: contact.mobile || null },
                    'Propensity Score': { number: contact.score },
                    'AI Strategy': { rich_text: [{ text: { content: contact.strategicTalkingPoint || '' } }] },
                    'Status': { status: { name: '🎯 To Call Today' } }
                },
                children: [
                    {
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [
                                {
                                    type: 'text',
                                    text: {
                                        content: contact.strategicTalkingPoint || ''
                                    }
                                }
                            ]
                        }
                    }
                ]
            });
            notionSuccess++;
            process.stdout.write('.');
        } catch (err) {
            console.error(`\n  → Notion error for ${contact.name}: ${err.message}`);
            notionFailed++;
        }
    }
    console.log(`\nNotion write complete: ${notionSuccess} created, ${notionFailed} failed.`);

    // Lock sent contacts out for 90 days so they never repeat in the daily pool
    const now = new Date().toISOString();
    for (const contact of topContacts) {
        const id = contact.id || contact.mobile;
        cooldown[id] = { plannedAt: now, name: contact.name, cooldownDays: COOLDOWN_DAYS };
    }
    saveCooldown(cooldown);
    console.log(`Cooldown tracker updated: ${topContacts.length} contacts locked out for ${COOLDOWN_DAYS} days.`);
}

main();
