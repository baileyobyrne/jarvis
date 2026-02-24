require('dotenv').config({ path: '../../.env' });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { getProximityContacts } = require('./get-contacts.js');
const fs = require('fs');
const https = require('https');
const { Client } = require('@notionhq/client');

const SEEN_FILE        = '/root/.openclaw/workspace/seen-listings.json';
const CONTACTS_FILE    = '/root/.openclaw/workspace/willoughby-contacts.json';

let seen = fs.existsSync(SEEN_FILE)
  ? JSON.parse(fs.readFileSync(SEEN_FILE))
  : { listings: [], sold: [], emailIds: [], addresses: [] };
if (!seen.emailIds) seen.emailIds = [];
if (!seen.addresses) seen.addresses = [];

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return console.log('Telegram not configured');
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

function normaliseAddress(address) {
  return address
    .toLowerCase()
    .replace(/\b(street|st|road|rd|avenue|ave|drive|dr|court|ct|place|pl|crescent|cres|way|close|lane|ln|parade|pde|boulevard|blvd)\b/g, match => {
      const map = { street:'st',road:'rd',avenue:'ave',drive:'dr',court:'ct',place:'pl',crescent:'cres',way:'way',close:'cl',lane:'ln',parade:'pde',boulevard:'blvd' };
      return map[match] || match;
    })
    .replace(/[^a-z0-9]/g, '');
}

// ─── PARSERS ──────────────────────────────────────────────────────────────────

function parseHomely(subject, body) {
  const result = { type: 'listing', address: '', price: '', beds: '', baths: '', cars: '', source: 'Homely', extra: '', propertyType: 'House' };
  if (/sold|result/i.test(subject)) result.type = 'sold';
  if (/unit|apartment|flat|studio/i.test(body + subject)) result.propertyType = 'Unit';
  const addrMatch = subject.match(/NEW:\s*(.+?)\s+is now/i);
  if (addrMatch) result.address = addrMatch[1].trim();
  const bedMatch = body.match(/(\d+)\s*Bed/i);
  const bathMatch = body.match(/(\d+)\s*Bath/i);
  const carMatch = body.match(/(\d+)\s*Car/i);
  if (bedMatch) result.beds = bedMatch[1];
  if (bathMatch) result.baths = bathMatch[1];
  if (carMatch) result.cars = carMatch[1];
  const priceMatch = body.match(/\$[\d,]+(?:\s*(?:million|m|k))?/i);
  if (priceMatch) result.price = priceMatch[0];
  return result;
}

function parseWeeklyWrap(body, senderName) {
  const results = [];
  const SUBURBS = 'Willoughby|Northbridge|Castlecrag|Middle Cove|Castle Cove|Naremburn';

  const newBlock = body.match(/New Listings?:([\s\S]*?)(?:Sold:|Auctions?:|$)/i);
  if (newBlock) {
    const lines = newBlock[1].split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(new RegExp(`^(.+?(?:${SUBURBS})[^–\\-]*)[–\\-]\\s*(.+)$`, 'i'));
      if (m) {
        results.push({
          type: 'listing', address: m[1].trim(), price: m[2].trim(),
          beds: '', baths: '', cars: '', source: senderName, extra: '📋 Weekly Wrap',
          propertyType: /unit|apartment|flat|studio/i.test(line) ? 'Unit' : 'House'
        });
      }
    }
  }

  const soldBlock = body.match(/Sold:([\s\S]*?)(?:Auctions?:|New Listings?:|$)/i);
  if (soldBlock) {
    const lines = soldBlock[1].split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(new RegExp(`^(.+?(?:${SUBURBS})[^–\\-]*)[–\\-]\\s*(.+)$`, 'i'));
      if (m) {
        results.push({
          type: 'sold', address: m[1].trim(), price: m[2].trim(),
          beds: '', baths: '', cars: '', source: senderName, extra: '📋 Weekly Wrap',
          propertyType: /unit|apartment|flat|studio/i.test(line) ? 'Unit' : 'House'
        });
      }
    }
  }

  return results;
}

function parseDirectAgent(subject, body, from) {
  const result = { type: 'listing', address: '', price: '', beds: '', baths: '', cars: '', source: '', extra: '', propertyType: 'House' };
  const nameMatch = from.match(/^([^<]+)/);
  result.source = nameMatch ? nameMatch[1].trim() : from;
  if (/unit|apartment|flat|studio/i.test(body + subject)) result.propertyType = 'Unit';
  if (/just\s*sold|sold\s*prior|sold$/i.test(subject)) result.type = 'sold';

  const addrPatterns = [
    /(?:just listed|just sold|open \w+ \d+[\w:]*(?:am|pm)?)\s*[\-\|]\s*(.+?(?:Willoughby|Northbridge|Castlecrag|Middle Cove|Castle Cove|Naremburn)[^|]*)/i,
    /(\d+[A-Za-z/]*\s+[\w\s]+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Place|Pl|Crescent|Cres|Way|Close|Lane|Ln|Parade|Pde|Boulevard|Blvd)[,\s]+(?:\w+\s+)?(?:Willoughby|Northbridge|Castlecrag|Middle Cove|Castle Cove|Naremburn))/i
  ];
  for (const pattern of addrPatterns) {
    const m = subject.match(pattern);
    if (m) { result.address = m[1].trim(); break; }
  }
  if (!result.address) {
    const bodyAddr = body.match(/(?:Willoughby|Northbridge|Castlecrag|Middle Cove|Castle Cove|Naremburn),\s*([\d][^\n]+)/i);
    if (bodyAddr) result.address = `${bodyAddr[1].trim()}, ${bodyAddr[0].split(',')[0].trim()}`;
  }

  const priceMatch = body.match(/(?:Guide|Auction Guide|Price Guide|Buyers Guide)[:\s]*\$?([\d,]+(?:\s*(?:million|m|k))?)/i)
    || body.match(/\$[\d,]+(?:\s*(?:million|m|k))?/i);
  if (priceMatch) result.price = priceMatch[0].replace(/^(?:Guide|Auction Guide|Price Guide|Buyers Guide)[:\s]*/i, '');

  const bedMatch = body.match(/(\d+)\s*(?:bed|bedroom)/i);
  const bathMatch = body.match(/(\d+)\s*(?:bath|bathroom)/i);
  const carMatch = body.match(/(\d+)\s*(?:car|garage|parking)/i);
  if (bedMatch) result.beds = bedMatch[1];
  if (bathMatch) result.baths = bathMatch[1];
  if (carMatch) result.cars = carMatch[1];

  if (/pocket listing|off.?market/i.test(subject + body)) result.extra = '🔒 Off-Market';
  else if (/just\s*sold/i.test(subject)) result.extra = '🔨 Direct Agent';
  else if (/just\s*listed/i.test(subject)) result.extra = '🆕 Direct Agent';
  else if (/open\s+(?:tomorrow|saturday|sunday)/i.test(subject)) result.extra = '🏡 Open Home';

  return result;
}

function parseTheAgencyAlert(body) {
  const results = [];
  const blocks = body.match(/(?:Willoughby|Northbridge|Castlecrag|Middle Cove|Castle Cove|Naremburn)\s*([\d][^\n]+)\n(\d+\s*bed[^\n]+)/gi) || [];
  for (const block of blocks) {
    const addrMatch = block.match(/([\d][^\n]+)/);
    const bedMatch = block.match(/(\d+)\s*bed/i);
    const bathMatch = block.match(/(\d+)\s*bath/i);
    const carMatch = block.match(/(\d+)\s*car/i);
    const suburbMatch = block.match(/^(Willoughby|Northbridge|Castlecrag|Middle Cove|Castle Cove|Naremburn)/i);
    if (addrMatch) {
      results.push({
        type: 'listing',
        address: `${addrMatch[1].trim()}${suburbMatch ? ', ' + suburbMatch[1] : ''}`,
        price: '', beds: bedMatch ? bedMatch[1] : '',
        baths: bathMatch ? bathMatch[1] : '', cars: carMatch ? carMatch[1] : '',
        source: 'The Agency', extra: '📋 Matched Alert',
        propertyType: /unit|apartment|flat|studio/i.test(block) ? 'Unit' : 'House'
      });
    }
  }
  return results;
}

// ─── CORELOGIC PIPELINE ──────────────────────────────────────────────────────

// Writes occupancy: "Investor" onto any contact whose address matches the
// rental address extracted from a CoreLogic "For Rent Alerts" section.
function updateContactOccupancy(streetAddress) {
  try {
    const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    const normTarget = normaliseAddress(streetAddress);
    let updated = false;

    for (const contact of data.contacts) {
      if (!contact.address) continue;
      if (normaliseAddress(contact.address) === normTarget) {
        contact.occupancy = 'Investor';
        updated = true;
        console.log(`  → [CoreLogic] Investor flag written: ${contact.name} @ ${streetAddress}`);
      }
    }

    if (updated) {
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2));
      console.log('  → willoughby-contacts.json saved.');
    } else {
      console.log(`  → No contact match for rental: ${streetAddress}`);
    }
  } catch (e) {
    console.error('  → occupancy update failed:', e.message);
  }
}

// Parses CoreLogic alert emails.
// Format A — sectioned: "Listed Alerts:", "For Rent Alerts:", "Sold Alerts:"
// Format B — territory sale: "Territory - Recent Sale" + address on next line
function parseCoreLogicAlerts(subject, body) {
  const results = [];

  // ── Unwrap Outlook / Gmail forwarding so section regexes see the original body ──
  let content = body;

  // Outlook plain-text forward: "-----Original Message-----" + From/Sent/To/Subject headers
  // The original body starts after the Subject: line + blank line.
  const outlookMatch = content.match(/[-]{4,}\s*Original Message\s*[-]{4,}[\s\S]*?Subject:[^\n]*\n+([\s\S]*)/i);
  if (outlookMatch) {
    content = outlookMatch[1].trimStart();
  } else {
    // Gmail forward: "---------- Forwarded message ---------" + From/Date/Subject/To headers
    const gmailMatch = content.match(/[-]{8,}\s*Forwarded message\s*[-]{8,}[\s\S]*?Subject:[^\n]*\n+([\s\S]*)/i);
    if (gmailMatch) {
      content = gmailMatch[1].trimStart();
    } else {
      // Outlook "bare" forward: body starts directly with From: / Sent: / To: / Subject: headers
      // (no dashes divider) — strip those header lines so section regexes see the real body.
      const bareOutlookMatch = content.match(/^\s*From:[^\n]+\n(?:Sent:|Date:)[^\n]+\n(?:To:|Cc:)[^\n]+(?:\n(?:Cc:|To:|Bcc:)[^\n]+)*\nSubject:[^\n]*\n+([\s\S]*)/i);
      if (bareOutlookMatch) content = bareOutlookMatch[1].trimStart();
    }
  }

  // Strip Outlook-style leading > quote characters (e.g. "> Listed Alerts:")
  content = content.replace(/^>+\s?/gm, '');

  // ─────────────────────────────────────────────────────────────────────────────

  const extractStreet = (line) => line.split(',')[0].trim();

  const extractAddressLines = (block) =>
    block
      .split('\n')
      .map(l => l.replace(/^[\s\u2022\-\*•]+/, '').trim())
      .filter(l => /^\d+\w*\s+\w/.test(l)); // must start with a number

  const sectionDefs = [
    { pattern: /Listed Alerts?:([\s\S]*?)(?=For Rent Alerts?:|Sold Alerts?:|Territory|$)/i,   type: 'listing', label: 'CoreLogic Listed'   },
    { pattern: /For Rent Alerts?:([\s\S]*?)(?=Listed Alerts?:|Sold Alerts?:|Territory|$)/i,   type: 'rental',  label: 'CoreLogic For Rent' },
    { pattern: /Sold Alerts?:([\s\S]*?)(?=Listed Alerts?:|For Rent Alerts?:|Territory|$)/i,   type: 'sold',    label: 'CoreLogic Sold'     }
  ];

  for (const { pattern, type, label } of sectionDefs) {
    const match = content.match(pattern);
    if (!match) continue;

    for (const fullAddr of extractAddressLines(match[1])) {
      const isRental = type === 'rental';

      // Rentals reveal investor ownership — update our local DB immediately
      if (isRental) {
        updateContactOccupancy(extractStreet(fullAddr));
      }

      results.push({
        type: isRental ? 'listing' : type,  // treat rentals as listings for proximity scoring
        address: fullAddr,
        streetOnly: extractStreet(fullAddr),
        price: '', beds: '', baths: '', cars: '',
        source: 'CoreLogic',
        extra: `📊 ${label}`,
        propertyType: /unit|apartment|flat|studio/i.test(fullAddr) ? 'Unit' : 'House',
        isRental
      });
    }
  }

  // ── Format C: Watchlist sections ─────────────────────────────────────────────
  // Sent by CoreLogic/Cotality with section headings like:
  //   "Watchlist - Listing Price Changes"
  //   "Watchlist - Sold"
  //   "Watchlist - For Rent"
  // Each property block inside looks like:
  //   [image URL]
  //   31 WALTER STREET WILLOUGHBY NSW 2068
  //   List: Willoughby – For Sale
  //   Sale price $2,875,000
  const watchlistDefs = [
    { pattern: /Watchlist\s*[-–]\s*Listing\s*(?:Price\s*Changes?|Alerts?)([\s\S]*?)(?=Watchlist\s*[-–]|You are receiving|$)/i, type: 'listing', label: 'CoreLogic Watchlist Listed' },
    { pattern: /Watchlist\s*[-–]\s*(?:Sold|Recent\s*Sales?)([\s\S]*?)(?=Watchlist\s*[-–]|You are receiving|$)/i,               type: 'sold',    label: 'CoreLogic Watchlist Sold'   },
    { pattern: /Watchlist\s*[-–]\s*(?:For\s*Rent|Rental)([\s\S]*?)(?=Watchlist\s*[-–]|You are receiving|$)/i,                  type: 'rental',  label: 'CoreLogic Watchlist Rental' }
  ];

  for (const { pattern, type, label } of watchlistDefs) {
    const match = content.match(pattern);
    if (!match) continue;

    // Strip inline image placeholders like [https://...] so they don't look like addresses
    const block = match[1].replace(/\[[^\]]{10,}\]/g, '');
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

    let currentAddr = null;
    let currentPrice = '';

    const flushWatchlist = () => {
      if (!currentAddr) return;
      const isRental = type === 'rental';
      if (isRental) updateContactOccupancy(extractStreet(currentAddr));
      results.push({
        type: isRental ? 'listing' : type,
        address: currentAddr,
        streetOnly: extractStreet(currentAddr),
        price: currentPrice,
        beds: '', baths: '', cars: '',
        source: 'CoreLogic',
        extra: `📊 ${label}`,
        propertyType: /unit|apartment|flat|studio/i.test(currentAddr) ? 'Unit' : 'House',
        isRental
      });
      currentAddr = null;
      currentPrice = '';
    };

    for (const line of lines) {
      if (/^\d+\w*\s+\w/.test(line)) {
        // New address — flush the previous one first
        flushWatchlist();
        currentAddr = line;
      } else if (/^sale\s+price/i.test(line)) {
        const pm = line.match(/\$[\d,]+/);
        if (pm) currentPrice = pm[0];
      }
    }
    flushWatchlist(); // flush the last entry
  }

  // Format B: Territory - Recent Sale
  const territoryMatch = content.match(/Territory\s*[-–]\s*Recent Sale[\s\S]{0,100}?(\d+\w*\s+[^\n,]+(?:,[^\n]+)?)/i);
  if (territoryMatch) {
    const fullAddr = territoryMatch[1].trim();
    results.push({
      type: 'sold',
      address: fullAddr,
      streetOnly: extractStreet(fullAddr),
      price: '', beds: '', baths: '', cars: '',
      source: 'CoreLogic',
      extra: '📊 CoreLogic Territory Sale',
      propertyType: /unit|apartment|flat|studio/i.test(fullAddr) ? 'Unit' : 'House',
      isRental: false
    });
  }

  return results;
}

// Sends a payload array directly to Notion as database pages.
async function sendToNotion(payload) {
  let success = 0;
  let failed = 0;
  for (const contact of payload) {
    try {
      await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          'Contact Name': { title: [{ text: { content: contact.Name || '' } }] },
          'Property Address': { rich_text: [{ text: { content: contact.Address || '' } }] },
          'Mobile': { phone_number: contact.Mobile || null },
          'Propensity Score': { number: contact.Score },
          'AI Strategy': { rich_text: [{ text: { content: contact.StrategicTalkingPoint || '' } }] },
          'Source': { select: { name: contact.Source || 'Market Event' } },
          'Tenure': { rich_text: [{ text: { content: contact.Tenure || '' } }] },
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
                    content: contact.StrategicTalkingPoint || ''
                  }
                }
              ]
            }
          }
        ]
      });
      success++;
    } catch (err) {
      console.error(`  → Notion error for ${contact.Name}: ${err.message}`);
      failed++;
    }
  }
  console.log(`  → Notion write: ${success} created, ${failed} failed.`);
}

// Full pipeline for a single CoreLogic address:
// proximity match → score → AI strategy → Make.com webhook
async function processCoreLogicListing(details, rpMap) {
  const address = details.address;
  const listingCategory = categorizePropertyType(details.propertyType || 'House');
  const proximityContacts = await getProximityContacts(address, 200);

  const scoredContacts = proximityContacts.map(c => {
    const key = normalise(c.address) + '|' + normaliseSuburb(c.suburb);
    const rpData = rpMap.get(key);
    if (!rpData) return null;
    const contactCategory = categorizePropertyType(rpData.propertyType);
    if (contactCategory !== listingCategory) return null;
    const { score, tenure, occupancy } = calculatePropensityScore(c, rpData, c.score);
    return { ...c, propensityScore: score, tenure, occupancy, propertyType: rpData.propertyType };
  }).filter(Boolean);

  const top10 = scoredContacts
    .sort((a, b) => b.propensityScore - a.propensityScore)
    .slice(0, 10);

  if (top10.length === 0) {
    console.log(`  → No scored contacts found near ${address}`);
    return;
  }

  console.log(`  → Sending ${top10.length} CoreLogic contacts to Notion...`);
  const payload = top10.map(c => ({
    Name: c.name,
    Mobile: c.mobile,
    Address: `${c.address || ''}, ${c.suburb || ''}`.trim().replace(/,\s*$/, ''),
    Score: c.propensityScore,
    StrategicTalkingPoint:
      `🚨 URGENT MARKET EVENT:\n📌 TRIGGER: A property nearby at ${address} just ${details.type === 'sold' ? 'sold' : 'listed'}.\n🎯 ANGLE: Call to provide instant market context and validate their equity.`,
    Source: 'Market Event',
    Tenure: c.tenure ? `${c.tenure} years` : 'Unknown'
  }));

  await sendToNotion(payload);
  console.log(`  ✅ CoreLogic → Notion: ${payload.length} contacts for ${address}`);
}

// ─── ROUTING ─────────────────────────────────────────────────────────────────

function isWilloughbyArea(text) {
  return /willoughby/i.test(text);
}

function isPropertyEmail(subject, body) {
  return /just listed|just sold|pocket listing|off.?market|weekly wrap|open tomorrow|open saturday|open sunday|new listing|price guide|auction guide/i.test(subject)
    && isWilloughbyArea(subject + body);
}

function routeEmail(subject, body, from) {
  const sender = from.toLowerCase();

  if (sender.includes('homely.com.au') && /is now for sale/i.test(subject)) {
    return [parseHomely(subject, body)];
  }
  if (/weekly wrap/i.test(subject)) {
    const nameMatch = from.match(/^([^<]+)/);
    return parseWeeklyWrap(body, nameMatch ? nameMatch[1].trim() : 'Agent');
  }
  if (sender.includes('hello@theagency.com.au') && /matched properties/i.test(subject)) {
    return parseTheAgencyAlert(body);
  }
  const isCoreLogicContent =
    sender.includes('corelogic.com.au') ||
    /fw:.*(?:rp\s*data|your rp data)/i.test(subject) ||
    (sender.includes('baileyobyrne@mcgrath.com.au') && /rp\s*data|corelogic/i.test(subject));
  if (isCoreLogicContent) {
    return parseCoreLogicAlerts(subject, body);
  }
  if (isPropertyEmail(subject, body)) {
    return [parseDirectAgent(subject, body, from)];
  }
  return [];
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { loadRPData, normalise, normaliseSuburb, calculatePropensityScore, categorizePropertyType } = require('./data-merger.js');

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function generateCallStrategy(contact, listingAddress, details) {
  const distStr = contact.distance !== null ? `${contact.distance}m` : 'nearby';
  
  const prompt = `
You are a highly strategic real estate analyst. Generate a punchy, 1-sentence strategic reason to call this contact because a new property has just been listed/sold nearby.

LISTING DETAILS:
- Address: ${listingAddress}
- Suburb: ${details.suburb || 'Willoughby'}
- Type: ${details.beds} bed, ${details.baths} bath, ${details.cars} car
- Price: ${details.price || 'Contact Agent'}
- Status: ${details.type.toUpperCase()}

CONTACT DATA:
- Name: ${contact.name}
- Address: ${contact.address || 'Unknown'}
- Proximity: ${distStr}
- Tenure: ${contact.tenure} years owned
- Occupancy: ${contact.occupancy}
- Classification: ${contact.contactClass}

GOAL: Provide exactly ONE punchy, strategic reason to call them. Focus on their tenure (e.g. "likely ready to downsize after 15 years") or occupancy (e.g. "investor who might want to capitalise on the high local sale price"). Be specific and professional.

Output ONLY the 1-sentence strategy.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.7
    });
    return response.choices[0].message.content.trim().replace(/^"|"$/g, '');
  } catch (e) {
    console.error('OpenAI Error:', e.message);
    return `Owned for ${contact.tenure} years; check if they're considering their next move given the proximity of ${listingAddress}.`;
  }
}

async function buildContactList(address, details, rpMap) {
  const listingCategory = categorizePropertyType(details.propertyType || 'House'); // Default to House if unknown
  const proximityContacts = await getProximityContacts(address, 200); // Increase pool size since we filter strictly
  
  const scoredContacts = proximityContacts.map(c => {
    const key = normalise(c.address) + '|' + normaliseSuburb(c.suburb);
    const rpData = rpMap.get(key);
    
    // 3. PROPERTY TYPE MATCHING (Apples to Apples)
    if (!rpData) return null;
    const contactCategory = categorizePropertyType(rpData.propertyType);
    if (contactCategory !== listingCategory) return null;

    const { score, tenure, occupancy } = calculatePropensityScore(c, rpData, c.score);
    return { ...c, propensityScore: score, tenure, occupancy, propertyType: rpData.propertyType };
  }).filter(Boolean);

  const top30 = scoredContacts
    .sort((a, b) => b.propensityScore - a.propensityScore)
    .slice(0, 30);

  // ─── URGENT MARKET EVENT → NOTION (direct write, no board limit) ────────────
  if (top30.length > 0) {
    const notionPayload = top30.map(c => ({
      Name: c.name,
      Mobile: c.mobile,
      Address: `${c.address || ''}, ${c.suburb || ''}`.trim().replace(/,\s*$/, ''),
      Score: c.propensityScore,
      StrategicTalkingPoint:
        `🚨 URGENT MARKET EVENT:\n📌 TRIGGER: A property nearby at ${address} just ${details.type === 'sold' ? 'sold' : 'listed'}.\n🎯 ANGLE: Call to provide instant market context and validate their equity.`,
      Source: 'Market Event',
      Tenure: c.tenure ? `${c.tenure} years` : 'Unknown'
    }));
    try {
      await sendToNotion(notionPayload);
      console.log(`  ✅ Market event → Notion: ${notionPayload.length} contacts pushed.`);
    } catch (e) {
      console.error('  → Notion write failed:', e.message);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const formatted = [];
  console.log(`Generating AI Strategies for ${top30.length} contacts...`);
  
  for (let i = 0; i < top30.length; i++) {
    const c = top30[i];
    const distStr = c.distance !== null ? ` (${c.distance}m)` : '';
    const angle = await generateCallStrategy(c, address, details);
    
    formatted.push(
      `<b>${c.name}</b> | <code>${c.mobile}</code>\n` +
      `${c.address || '—'}${distStr}\n` +
      `📊 Intel: ${c.tenure}yrs owned | ${c.occupancy}\n` +
      `🎯 Angle: ${angle}`
    );
    process.stdout.write('.');
  }
  console.log(' Done.');
  return formatted;
}

async function checkEmails() {
  console.log(`[${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}] Checking email alerts...`);

  const rpMap = await loadRPData();
  console.log(`Loaded ${rpMap.size} properties from RP Data.`);

  const killTimer = setTimeout(() => {
    console.error('TIMEOUT: IMAP took >5min — exiting');
    process.exit(1);
  }, 300000);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // ✅ All Mail covers Inbox + Promotions + Updates + Social — nothing missed
    await client.mailboxOpen('[Gmail]/All Mail');

    const knownSenders = [
      'alerts@realestate.com.au',
      'alerts@homely.com.au',
      'noreply@domain.com.au',
      'alerts@allhomes.com.au',
      'noreply@allhomes.com.au',
      'alerts@email.view.com.au',
      'email@campaign.realestate.com.au',
      'hello@email.realestate.com.au',
      'rickwoodward@theagency.com.au',
      'hello@theagency.com.au',
      'lindfield@stonerealestate.com.au',
      'jasongeorges@mcgrath.com.au',
      'noreply@corelogic.com.au',
      'baileyobyrne@mcgrath.com.au'
    ];

    const keywordSubjects = [
      'just listed',
      'just sold',
      'pocket listing',
      'weekly wrap',
      'open tomorrow',
      'open saturday',
      'revised guide',
      'price guide',
      'Penshurst',
      'RP Data',
      'Your RP Data'
    ];

    let allMessageUids = new Set();

    // TEMPORARY LIVE TEST: Search for Penshurst bypassing all other filters
    const testMsgs = await client.search({ subject: 'Penshurst', seen: false });
    testMsgs.forEach(uid => allMessageUids.add(uid));

    for (const sender of knownSenders) {
      const msgs = await client.search(process.env.SEARCH_ALL ? { from: sender } : { from: sender, seen: false });
      msgs.forEach(uid => allMessageUids.add(uid));
    }

    for (const keyword of keywordSubjects) {
      const msgs = await client.search(process.env.SEARCH_ALL ? { subject: keyword } : { subject: keyword, seen: false });
      // Pre-filter by area before adding — avoids fetching irrelevant emails
      msgs.forEach(uid => allMessageUids.add(uid));
    }

    const messageList = [...allMessageUids];
    console.log(`Total unique unread messages to check: ${messageList.length}`);

    if (messageList.length === 0) {
      console.log('No new property alert emails.');
      await client.logout();
      clearTimeout(killTimer);
      console.log('Done.');
      return;
    }

    await client.messageFlagsAdd(messageList, ['\\Seen']);

    let found = 0;

    for await (const msg of client.fetch(messageList, { envelope: true, source: true })) {
      const uidStr = String(msg.uid);
      if (seen.emailIds.includes(uidStr)) continue;
      seen.emailIds.push(uidStr);

      const parsed = await simpleParser(msg.source);
      const subject = parsed.subject || '';
      const body = parsed.text || '';
      const from = parsed.from?.text || '';

      // CoreLogic territory alerts are pre-scoped to our area — skip the suburb filter
      const fromSender = from.toLowerCase();
      const isCoreLogicEmail =
        fromSender.includes('corelogic.com.au') ||
        /fw:.*(?:rp\s*data|your rp data)/i.test(subject) ||
        (fromSender.includes('baileyobyrne@mcgrath.com.au') && /rp\s*data|corelogic/i.test(subject));

      if (!isCoreLogicEmail && !isWilloughbyArea(subject + body)) {
        console.log(`  → Skipped: Property not in Willoughby: ${subject}`);
        continue;
      }

      console.log(`  → ${subject}`);

      const detailsList = routeEmail(subject, body, from);

      if (detailsList.length === 0) {
        console.log('  → No parseable listings found');
        continue;
      }

      for (const details of detailsList) {
        if (!details.address) {
          console.log('  → Could not parse address, skipping');
          continue;
        }

        const dedupKey = `${details.type}:${normaliseAddress(details.address)}`;
        if (seen.addresses.includes(dedupKey)) {
          console.log(`  → DUPLICATE skipped: ${details.address}`);
          continue;
        }
        seen.addresses.push(dedupKey);

        // CoreLogic alerts bypass Telegram and go directly to Notion
        if (details.source === 'CoreLogic') {
          await processCoreLogicListing(details, rpMap);
          found++;
          fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
          continue;
        }

        // Push scored neighbours to Notion
        await buildContactList(details.address, details, rpMap);

        // Send a single concise heads-up to Telegram — contact lists now live in Notion
        const alertMsg =
          `🚨 URGENT MARKET EVENT: A property at ${details.address} just ${details.type === 'sold' ? 'sold' : 'listed'}.\n\n` +
          `🎯 The nearest high-priority neighbours have been pushed to the top of your Notion Command Center!`;
        await sendTelegram(alertMsg);

        console.log(`  ✅ Alert sent: ${details.address} [${details.type}] via ${details.source}`);
        found++;

        fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
      }
    }

    if (found === 0) console.log('No new property alerts found.');
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
    await client.logout();
    clearTimeout(killTimer);
    console.log('Done.');

  } catch (err) {
    clearTimeout(killTimer);
    console.error('Error:', err.message);
    try { await client.logout(); } catch (_) {}
    process.exit(1);
  }
}

checkEmails();
