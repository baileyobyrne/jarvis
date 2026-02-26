const fs = require('fs');
const https = require('https');
const axios = require('axios');
require('dotenv').config({ path: '/root/.openclaw/.env', override: true });

function sendTelegram(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return Promise.resolve();
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    return new Promise(resolve => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, resolve);
        req.write(body);
        req.end();
    });
}

const { db } = require('../lib/db.js');

const DRY_RUN = process.argv.includes('--dry-run');

const CONTACTS_FILE = '/root/.openclaw/workspace/willoughby-contacts.json';
const RP_DATA_FILE = '/root/.openclaw/workspace/rp_data.csv';
const COOLDOWN_FILE = '/root/.openclaw/workspace/recently-planned.json';
const COOLDOWN_DAYS = 120;        // days before a daily-planned contact is eligible again
const DAILY_TARGET = 30;          // maximum cards on the board at any one time
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
    // Respect per-entry cooldownDays (local planned contacts use 90 days)
    const days = entry.cooldownDays || COOLDOWN_DAYS;
    const daysSince = (Date.now() - new Date(entry.plannedAt).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince < days;
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

    // 4. Past Vendor (+25 — previously listed/sold through McGrath)
    const contactClass = contact.contactClass || '';
    if (contactClass.includes('Past Vendor')) {
        score += 25;
    }

    // 5. Prospective Vendor (+15 — flagged as potential seller, not already Past Vendor)
    if (contactClass.includes('Prospective Vendor') && !contactClass.includes('Past Vendor')) {
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

    // Pull real recent sold events from SQLite (last 30 days only — older is stale)
    const recentSoldEvents = db.prepare(`
        SELECT address, price, beds, baths, property_type, detected_at
        FROM market_events
        WHERE type = 'sold'
          AND detected_at > datetime('now', '-30 days')
        ORDER BY detected_at DESC
        LIMIT 5
    `).all();
    const recentSalesText = recentSoldEvents.length > 0
        ? recentSoldEvents.map(s => {
            const d = new Date(s.detected_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
            const detail = [s.beds ? `${s.beds}bed` : null, s.property_type || null].filter(Boolean).join(' ');
            return `• ${s.address}${detail ? ` (${detail})` : ''} — ${s.price || 'price withheld'} — ${d}`;
          }).join('\n')
        : null;

    const context = {
        name: contact.name,
        address: contact.address || truthEntry?.['Street Address'],
        tenure: saleDateStr,
        tenureYears: tenureYears,
        ownerType: truthEntry?.['Owner Type'] || 'Unknown',
        appraisals: contact.appraisals?.length || 0,
        contactClass: contact.contactClass || 'Unknown',
        notes: contact.notes?.map(n => [n.headline, n.description].filter(Boolean).join(' — ')).join('; ') || 'None'
    };

    const prompt = `You are a strategic real estate analyst generating a call prep brief for Bailey O'Byrne at McGrath Willoughby.

The current year is ${currentYear}. All references to timing, market conditions, and strategic asks must reflect ${currentYear} — do not reference any prior year.

Generate 4 to 5 highly concise, punchy bullet points for a phone call with ${context.name} at ${context.address}.

Data available:
- Current Year: ${currentYear}
- Tenure: ${context.tenure} (${context.tenureYears} years)
- Owner Type: ${context.ownerType}
- Contact Class: ${context.contactClass}
- Past Appraisals: ${context.appraisals}
- Notes: ${context.notes}
${recentSalesText ? `\nConfirmed recent sales in the area (last 30 days — use ONLY these if referencing specific comps):\n${recentSalesText}` : '\nNo confirmed recent sales available in the last 30 days.'}

You must format the output identically for every single contact. Do NOT use Markdown asterisks (**). Use clean bullet points and standard emojis so it renders cleanly in a structured text field.

Cover these 4 areas in order, each as exactly one tight bullet point (add a 5th only if there is a genuinely strong additional angle):

📌 DATA TRIGGER: [Tenure or occupancy signal — e.g. "Owned 11 years — statistically overdue for a move" or "Investor — not emotionally attached, motivated by yield"]
📈 VALUE ADD: [If confirmed recent sales are listed above, reference one specifically by address, price, and date. If no confirmed sales are listed, reference strong current buyer demand or market conditions in general terms — do NOT invent or assume any specific address, street name, or sale price.]
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

// ─── SQLITE WRITE ─────────────────────────────────────────────────────────────
// Runs after saveCooldown on every normal execution (and standalone in --dry-run).
// If SQLite fails the error is logged but the script does NOT crash —
// recently-planned.json is kept for the 90-day cooldown filter; SQLite is authoritative for board count.
function writeToDB(finalPayload) {
    // en-CA locale gives YYYY-MM-DD, respecting Sydney timezone for plan_date
    const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const now      = new Date().toISOString();

    const upsertContact = db.prepare(`
        INSERT INTO contacts
            (id, name, mobile, address, suburb, tenure_years, propensity_score,
             notes_raw, beds, baths, cars, property_type, occupancy, updated_at)
        VALUES
            (@id, @name, @mobile, @address, @suburb, @tenure_years, @propensity_score,
             @notes_raw, @beds, @baths, @cars, @property_type, @occupancy, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
            name             = excluded.name,
            mobile           = excluded.mobile,
            address          = excluded.address,
            suburb           = excluded.suburb,
            tenure_years     = excluded.tenure_years,
            propensity_score = excluded.propensity_score,
            notes_raw        = excluded.notes_raw,
            beds             = excluded.beds,
            baths            = excluded.baths,
            cars             = excluded.cars,
            property_type    = excluded.property_type,
            occupancy        = excluded.occupancy,
            updated_at       = excluded.updated_at
    `);

    const upsertPlan = db.prepare(`
        INSERT INTO daily_plans
            (plan_date, contact_id, propensity_score, intel, angle, tenure,
             property_type, occupancy, source, created_at)
        VALUES
            (@plan_date, @contact_id, @propensity_score, @intel, @angle, @tenure,
             @property_type, @occupancy, 'daily_planner', @created_at)
        ON CONFLICT(plan_date, contact_id) DO UPDATE SET
            propensity_score = excluded.propensity_score,
            intel            = excluded.intel,
            angle            = excluded.angle,
            tenure           = excluded.tenure,
            property_type    = excluded.property_type,
            occupancy        = excluded.occupancy
    `);

    const upsertQueue = db.prepare(`
        INSERT INTO call_queue
            (contact_id, status, propensity_score, intel, angle, tenure,
             property_type, occupancy, contact_class, added_at, updated_at)
        VALUES
            (?, 'active', ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
        ON CONFLICT(contact_id) DO UPDATE SET
            propensity_score = excluded.propensity_score,
            intel            = excluded.intel,
            angle            = excluded.angle,
            tenure           = excluded.tenure,
            property_type    = excluded.property_type,
            occupancy        = excluded.occupancy,
            contact_class    = excluded.contact_class,
            updated_at       = datetime('now','localtime')
        WHERE call_queue.status = 'active'
    `);

    const runWrites = db.transaction(() => {
        for (const contact of finalPayload) {
            const tenureInt = parseInt(contact.tenure);
            upsertContact.run({
                id:               contact.id,
                name:             contact.name,
                mobile:           contact.mobile       || null,
                address:          contact.address      || null,
                suburb:           contact.suburb       || null,
                tenure_years:     Number.isFinite(tenureInt) ? tenureInt : null,
                propensity_score: contact.score,
                notes_raw:        contact.intel        || null,
                beds:             contact.beds         || null,
                baths:            contact.baths        || null,
                cars:             contact.cars         || null,
                property_type:    contact.propertyType || null,
                occupancy:        contact.occupancy    || null,
                updated_at:       now
            });

            upsertPlan.run({
                plan_date:        planDate,
                contact_id:       contact.id,
                propensity_score: contact.score,
                intel:            contact.intel        || null,
                angle:            contact.angle        || null,
                tenure:           contact.tenure       || null,
                property_type:    contact.propertyType || null,
                occupancy:        contact.occupancy    || null,
                created_at:       now
            });

            upsertQueue.run(
                contact.id,
                contact.score,
                contact.intel        || null,
                contact.angle        || null,
                contact.tenure       || null,
                contact.propertyType || null,
                contact.occupancy    || null,
                contact.contactClass || null
            );
        }
    });

    try {
        runWrites();
        console.log(`[db] SQLite: ${finalPayload.length} contacts upserted → contacts + daily_plans + call_queue.`);
    } catch (err) {
        console.error('[db] SQLite write failed (non-fatal):', err.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    // ─── DRY RUN MODE ─────────────────────────────────────────────────────────
    // Skips real contact loading and Anthropic calls. Writes 3 mock contacts to
    // SQLite then reads them back so the full write path can be verified safely.
    if (DRY_RUN) {
        console.log('[dry-run] Skipping real data load — verifying SQLite writes with 3 mock contacts.');
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
        const mockPayload = [
            {
                id: 'DRY001', name: 'Test Contact Alpha', mobile: '0400000001',
                address: '1 Jarvis St, WILLOUGHBY', suburb: 'WILLOUGHBY',
                score: 50, tenure: '12 years',
                intel: '📌 DATA TRIGGER: Owned 12 years — statistically overdue.\n📈 VALUE ADD: Recent comp strong.\n📋 CRM HOOK: No prior notes.',
                angle: '🎯 STRATEGIC ASK: Float a no-pressure appraisal.',
                beds: '4', baths: '2', cars: '2', propertyType: 'House', occupancy: 'Owner Occupied'
            },
            {
                id: 'DRY002', name: 'Test Contact Beta', mobile: '0400000002',
                address: '2 Test Rd, ARTARMON', suburb: 'ARTARMON',
                score: 35, tenure: '8 years',
                intel: '📌 DATA TRIGGER: Investor — not emotionally attached.\n📈 VALUE ADD: Rental yields shifting.',
                angle: '🎯 STRATEGIC ASK: Explore selling vs. holding.',
                beds: '3', baths: '1', cars: '1', propertyType: 'Apartment', occupancy: 'Rented'
            },
            {
                id: 'DRY003', name: 'Test Contact Gamma', mobile: '0400000003',
                address: '3 Mock Ln, NAREMBURN', suburb: 'NAREMBURN',
                score: 20, tenure: 'Unknown',
                intel: '📌 DATA TRIGGER: Tenure unknown — appraisal history trigger.',
                angle: '🎯 STRATEGIC ASK: Offer free market update.',
                beds: '', baths: '', cars: '', propertyType: '', occupancy: ''
            }
        ];
        writeToDB(mockPayload);
        // Read back to confirm the rows landed correctly
        const planRows = db.prepare(
            `SELECT contact_id, propensity_score, tenure FROM daily_plans WHERE plan_date = ?`
        ).all(today);
        console.log(`[dry-run] daily_plans rows for ${today}:`, planRows);
        const contactRows = db.prepare(
            `SELECT id, name, tenure_years, suburb FROM contacts WHERE id IN ('DRY001','DRY002','DRY003')`
        ).all();
        console.log('[dry-run] contacts rows:', contactRows);
        console.log('[dry-run] Complete — recently-planned.json untouched, no Anthropic calls made.');
        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    console.log('Loading contacts and RP data...');
    const contactsData = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    const truthLookup = parseRPData(RP_DATA_FILE);
    const contacts = contactsData.contacts;

    // ─── BOARD STATE CHECK ───────────────────────────────────────────────────
    // Board-full guard reads from call_queue (persistent — not date-partitioned)
    const todayCount = db.prepare(
        "SELECT COUNT(*) AS n FROM call_queue WHERE status IN ('active','snoozed')"
    ).get().n;
    const targetCalls = DAILY_TARGET - todayCount;
    if (targetCalls <= 0) {
        console.log(`Queue is full — ${todayCount} contacts active/snoozed. Nothing to add.`);
        return;
    }
    console.log(`Queue: ${todayCount} active/snoozed. Slots available: ${targetCalls}.`);
    const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const cooldown = loadCooldown();
    // ─────────────────────────────────────────────────────────────────────────

    // Filter to McGrath Willoughby territory
    const AREA_SUBURBS = new Set([
        'WILLOUGHBY', 'NORTH WILLOUGHBY', 'WILLOUGHBY EAST',
        'NAREMBURN', 'ARTARMON', 'CHATSWOOD', 'CASTLE COVE',
        'MIDDLE COVE', 'NORTHBRIDGE', 'LANE COVE', 'ST LEONARDS', 'CROWS NEST'
    ]);
    const areaContacts = contacts.filter(c => {
        const suburb = (c.suburb || '').trim().toUpperCase();
        return AREA_SUBURBS.has(suburb);
    });
    console.log(`Area filter: ${contacts.length - areaContacts.length} contacts outside territory excluded. ${areaContacts.length} in area.`);

    // Build exclusion set from call_queue (active/snoozed/done-with-cooldown)
    const queueExcluded = new Set(
        db.prepare(`
            SELECT contact_id FROM call_queue
            WHERE status IN ('active','snoozed')
               OR (status = 'done' AND (cooldown_until IS NULL OR cooldown_until > datetime('now','localtime')))
        `).all().map(r => r.contact_id)
    );

    // Filter out contacts already in queue or on local JSON cooldown
    const eligibleContacts = areaContacts.filter(c => {
        const id = c.id || c.mobile;
        return !queueExcluded.has(id) && !isOnCooldown(id, cooldown);
    });
    console.log(`Exclusion filter: ${areaContacts.length - eligibleContacts.length} contacts excluded (queue+cooldown). ${eligibleContacts.length} eligible.`);

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

        // Split AI brief into intel (data bullets) and angle (🎯 STRATEGIC ASK)
        const talkingLines = talkingPoint.split('\n').filter(l => l.trim());
        const angleLine = talkingLines.find(l => l.includes('🎯')) || '';
        const intelLines = talkingLines.filter(l => !l.includes('🎯')).join('\n');

        finalPayload.push({
            id:           contact.id || contact.mobile,
            name:         contact.name,
            mobile:       contact.mobile,
            suburb:       contact.suburb || contact.truthEntry?.['Suburb'] || '',
            address:      `${contact.address || contact.truthEntry?.['Street Address']}, ${contact.suburb || contact.truthEntry?.['Suburb'] || ''}`.trim().replace(/,\s*$/, ''),
            score:        contact.score,
            strategicTalkingPoint: talkingPoint,
            source:       'Daily Planner',
            tenure,
            intel:        intelLines,
            angle:        angleLine,
            beds:         contact.truthEntry?.['Bed']           || '',
            baths:        contact.truthEntry?.['Bath']          || '',
            cars:         contact.truthEntry?.['Car']           || '',
            propertyType: contact.truthEntry?.['Property Type'] || '',
            occupancy:    contact.truthEntry?.['Owner Type']    || ''
        });
        process.stdout.write('.');
    }
    console.log('\nTalking points generated.');

    // Lock sent contacts out for 90 days and write full enriched objects
    const now = new Date().toISOString();
    for (const contact of finalPayload) {
        const id = contact.id || contact.mobile;
        cooldown[id] = {
            plannedAt:       now,
            name:            contact.name,
            cooldownDays:    COOLDOWN_DAYS,
            address:         contact.address,
            mobile:          contact.mobile,
            tenure:          contact.tenure,
            propensityScore: contact.score,
            intel:           contact.intel,
            angle:           contact.angle,
            beds:            contact.beds,
            baths:           contact.baths,
            cars:            contact.cars,
            propertyType:    contact.propertyType,
            occupancy:       contact.occupancy,
            source:          contact.source
        };
    }
    saveCooldown(cooldown);
    console.log(`Cooldown tracker updated: ${finalPayload.length} contacts locked out for ${COOLDOWN_DAYS} days.`);

    // ─── SQLITE (parallel write — JSON above is the fallback during migration) ─
    writeToDB(finalPayload);
    // ─────────────────────────────────────────────────────────────────────────

    // ─── RE-ACTIVATE EXPIRED COOLDOWNS ───────────────────────────────────────
    try {
        const reactivated = db.prepare(`
            UPDATE call_queue
            SET status         = 'active',
                cooldown_until = NULL,
                snooze_until   = NULL,
                updated_at     = datetime('now','localtime')
            WHERE status = 'done'
              AND cooldown_until IS NOT NULL
              AND cooldown_until <= datetime('now','localtime')
        `).run();
        if (reactivated.changes > 0) {
            console.log(`[queue] Re-activated ${reactivated.changes} contacts with expired cooldowns.`);
        }
    } catch (e) {
        console.error('[queue] Re-activation pass failed (non-fatal):', e.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ─── TELEGRAM MORNING BRIEFING ────────────────────────────────────────────
    try {
        const dateStr = new Date().toLocaleDateString('en-AU', {
            weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Australia/Sydney'
        });
        const top3 = finalPayload.slice(0, 3).map((c, i) => {
            const tenureStr = c.tenure && c.tenure !== 'Unknown' ? ` — ${c.tenure} owned` : '';
            const classStr = c.occupancy && c.occupancy !== 'Unknown' ? ` · ${c.occupancy}` : '';
            return `${i + 1}. <b>${c.name}</b>${tenureStr}${classStr}`;
        }).join('\n');
        const telegramMsg =
            `🌅 <b>Good morning, Bailey!</b>\n\n` +
            `📋 <b>${finalPayload.length} calls loaded for ${dateStr}</b>\n\n` +
            `🎯 Top priority today:\n${top3}\n\n` +
            `Dashboard is ready. Let's get after it. 💪`;
        await sendTelegram(telegramMsg);
        console.log('Morning Telegram briefing sent.');
    } catch (e) {
        console.error('Telegram briefing failed (non-fatal):', e.message);
    }
    // ─────────────────────────────────────────────────────────────────────────
}

main();
