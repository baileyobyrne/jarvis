require('dotenv').config({ path: '/root/.openclaw/.env', override: true });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { getProximityContacts } = require('./get-contacts.js');
const fs = require('fs');
const https = require('https');

// ─── SQLite database (shared Jarvis data layer) ───────────────────────────────
const { db } = require('../../lib/db.js');

const SEEN_FILE        = '/root/.openclaw/workspace/seen-listings.json';
const CONTACTS_FILE    = '/root/.openclaw/workspace/willoughby-contacts.json';

let seen = fs.existsSync(SEEN_FILE)
  ? JSON.parse(fs.readFileSync(SEEN_FILE))
  : { listings: [], sold: [], emailIds: [], addresses: [] };
if (!seen.emailIds) seen.emailIds = [];
if (!seen.addresses) seen.addresses = [];

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
    req.on('error', err => console.error('[sendTelegram] HTTPS error:', err.message));
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

// ─── SQLITE HELPERS ───────────────────────────────────────────────────────────

/**
 * Extract the suburb from an address string.
 * Handles both "Street, Suburb" (Proping) and "STREET SUBURB NSW POSTCODE" (CoreLogic) formats.
 */
function extractSuburb(address) {
  if (!address) return '';
  const commaIdx = address.lastIndexOf(',');
  if (commaIdx !== -1) {
    // "26/166 Mowbray Road, Willoughby" → "Willoughby"
    return address.slice(commaIdx + 1).trim().replace(/\s+NSW.*$/i, '').replace(/\s+\d{4}.*$/, '').trim();
  }
  // "31 WALTER STREET WILLOUGHBY NSW 2068" — scan for known suburb
  const m = address.match(/\b(Willoughby|North Willoughby|Willoughby East|Northbridge|Castlecrag|Middle Cove|Castle Cove|Naremburn|Artarmon|Chatswood)\b/i);
  return m ? m[1] : '';
}

// Lazy-initialised prepared statement — prepared once on first call.
let _insertMarketEventStmt = null;

/**
 * Write one market event to the market_events SQLite table.
 * Uses INSERT OR IGNORE — safe to call multiple times for the same event.
 * Never throws; errors are logged non-fatally.
 *
 * @param {object} event   - Normalised event object (fields from any parser track).
 * @param {Array}  [topContacts] - Optional [{name, mobile}] array for proximity contacts.
 */
function writeMarketEvent(event, topContacts) {
  if (!_insertMarketEventStmt) {
    _insertMarketEventStmt = db.prepare(`
      INSERT OR IGNORE INTO market_events
        (detected_at, event_date, type, address, suburb,
         price, price_previous, price_withheld,
         proping_estimate, estimate_delta, days_on_market,
         beds, baths, cars, property_type,
         agent_name, agency, source, is_rental, top_contacts)
      VALUES
        (@detected_at, @event_date, @type, @address, @suburb,
         @price, @price_previous, @price_withheld,
         @proping_estimate, @estimate_delta, @days_on_market,
         @beds, @baths, @cars, @property_type,
         @agent_name, @agency, @source, @is_rental, @top_contacts)
    `);
  }

  const detectedAt = new Date().toISOString();
  const rawDate    = event.eventDate || event.receivedDate;
  const eventDate  = rawDate
    ? (rawDate.length > 10 ? rawDate.substring(0, 10) : rawDate)
    : detectedAt.substring(0, 10);

  try {
    _insertMarketEventStmt.run({
      detected_at:      detectedAt,
      event_date:       eventDate,
      type:             event.type || event.eventType || null,
      address:          event.address,
      suburb:           event.suburb || extractSuburb(event.address || ''),
      price:            event.price || event.listPrice || event.soldPrice || null,
      price_previous:   event.price_previous || null,
      price_withheld:   event.priceWithheld ? 1 : 0,
      proping_estimate: event.propingEstimate || event.proping_estimate || null,
      estimate_delta:   event.estimateDelta  || event.estimate_delta  || null,
      days_on_market:   (event.daysOnMarket  != null) ? event.daysOnMarket
                      : (event.days_on_market != null ? event.days_on_market : null),
      beds:             event.beds           || null,
      baths:            event.baths          || null,
      cars:             event.cars           || null,
      property_type:    event.propertyType   || event.property_type || null,
      agent_name:       event.agentName      || event.agent_name    || null,
      agency:           event.agency         || null,
      source:           event.source         || 'Unknown',
      is_rental:        event.isRental       ? 1 : 0,
      top_contacts:     topContacts          ? JSON.stringify(topContacts) : null
    });
  } catch (err) {
    console.error('[db] market_events write failed (non-fatal):', err.message);
  }
}

// ─── PROPING PARSER ───────────────────────────────────────────────────────────

/**
 * Parse a Proping daily digest email body.
 *
 * Sections detected: Price Change(N) | Newly Listed(N) | Sold(N) | Unlisted(N)
 * Each property block contains: address, beds+DOM line, price line, [price-withheld], agent/agency.
 *
 * @param {string} subject      - Email subject (unused for parsing, kept for API parity).
 * @param {string} body         - Plain-text email body.
 * @param {string} receivedDate - YYYY-MM-DD string (Sydney date when email was processed).
 * @returns {Array<object>}     - One object per property found.
 */
function parseProping(subject, body, receivedDate) {
  const results = [];

  const sectionTypeMap = {
    'price change': 'price_change',
    'newly listed': 'listing',
    'sold':         'sold',
    'unlisted':     'unlisted'
  };

  // Split body on section headers.  Using a capturing group means the split array
  // alternates: [pre-text, header, content, header, content, ...]
  const parts = body.split(/^(Price Change|Newly Listed|Sold|Unlisted)\s*\(\d+\)\s*$/mi);

  // parts[0] = anything before the first section (ignored)
  // parts[1] = first header name, parts[2] = first section content, etc.
  for (let i = 1; i < parts.length; i += 2) {
    const sectionName = parts[i].toLowerCase().trim();
    const sectionContent = (parts[i + 1] || '');
    const sectionType = sectionTypeMap[sectionName];
    if (!sectionType) continue;

    // Filter and split section content into non-empty lines
    // Strip markdown-style image links [img]<url> and bare <url> artifacts from Proping emails
    const cleanLine = (l) => l
      .replace(/\[https?:\/\/[^\]]+\]\s*<https?:\/\/[^>]+>\s*/g, '')  // strip [img]<url>
      .replace(/<https?:\/\/[^>]+>/g, '')                               // strip bare <url>
      .trim();
    const lines = sectionContent.split('\n').map(l => cleanLine(l.trim())).filter(Boolean);

    // Detect the start of a new property block.
    // Address lines: start with a digit, contain a comma (suburb separator),
    // and do NOT contain '$' or 'bed' (which would identify a price or beds line).
    const isAddressLine = (line) =>
      /^\d/.test(line) &&
      /,/.test(line) &&
      !/\$/.test(line) &&
      !/\bbed\b/i.test(line);

    let currentBlock = [];

    const flushBlock = () => {
      if (currentBlock.length < 3) { currentBlock = []; return; }

      // ── Line 0: address ────────────────────────────────────────────────────
      const address = currentBlock[0];
      const suburb = extractSuburb(address);

      // ── Line 1: beds + days on market ──────────────────────────────────────
      const bedsLine = currentBlock[1] || '';
      const bedsMatch    = bedsLine.match(/(\d+)\s*bed/i);
      const daysMatch    = bedsLine.match(/(\d+)\s*days?\s*listed/i);
      const beds         = bedsMatch ? bedsMatch[1] : '';
      const daysOnMarket = daysMatch ? parseInt(daysMatch[1], 10) : null;

      // ── Line 2: price line ─────────────────────────────────────────────────
      let lineIdx = 2;
      const priceLine = currentBlock[lineIdx] || '';

      // Proping estimate: first $X,XXX before "Proping Estimate"
      const estMatch = priceLine.match(/\$([\d,]+)\s+Proping\s+Estimate/i);
      const propingEstimate = estMatch ? `$${estMatch[1]}` : null;

      // Any additional dollar amount appearing AFTER the estimate marker
      const afterMarker = estMatch
        ? priceLine.slice(priceLine.search(/Proping\s+Estimate\*/i) + 'Proping Estimate*'.length).trim()
        : '';
      const secondAmtMatch = afterMarker.match(/\$([\d,]+)/);

      // For listings, the second amount (if present) is the actual list price;
      // for price_change the second amount is the change delta — not a list price.
      let listPrice      = null;
      let estimateDelta  = null;

      if (sectionType === 'listing' && secondAmtMatch) {
        listPrice = `$${secondAmtMatch[1]}`;
      }

      if (listPrice && propingEstimate) {
        const lpNum = parseInt(listPrice.replace(/[\$,]/g, ''), 10);
        const epNum = parseInt(propingEstimate.replace(/[\$,]/g, ''), 10);
        const delta = lpNum - epNum;
        estimateDelta = (delta >= 0 ? '+' : '-') + '$' + Math.abs(delta).toLocaleString('en-AU');
      }

      lineIdx++;

      // ── Sold: check for explicit price or "Price Withheld" ─────────────────
      let soldPrice    = null;
      let priceWithheld = false;

      if (sectionType === 'sold') {
        const nextLine = currentBlock[lineIdx] || '';
        if (/price withheld/i.test(nextLine)) {
          priceWithheld = true;
          soldPrice     = 'Price Withheld';
          lineIdx++;
        } else {
          const soldPriceMatch = nextLine.match(/^\$[\d,]+/);
          if (soldPriceMatch) {
            soldPrice = soldPriceMatch[0];
            lineIdx++;
          }
        }
      }

      // ── Agent / Agency ─────────────────────────────────────────────────────
      const agentLine = currentBlock[lineIdx] || '';
      let agentName = '';
      let agency    = '';
      if (agentLine.includes('/')) {
        const agentParts = agentLine.split('/');
        agentName = agentParts[0].trim();
        agency    = agentParts.slice(1).join('/').trim();
      } else {
        agentName = agentLine.trim();
      }

      results.push({
        type:             sectionType,
        address,
        suburb,
        beds,
        daysOnMarket,
        listPrice,
        soldPrice:        sectionType === 'sold' ? soldPrice : null,
        priceWithheld,
        propingEstimate,
        estimateDelta,
        agentName,
        agency,
        eventDate:        receivedDate,
        source:           'Proping'
      });

      currentBlock = [];
    };

    for (const line of lines) {
      if (isAddressLine(line) && currentBlock.length > 0) {
        flushBlock();
      }
      currentBlock.push(line);
    }
    flushBlock(); // flush the last block in this section
  }

  return results;
}

// ─── PROPING PROCESSING ───────────────────────────────────────────────────────

/**
 * Build the consolidated Telegram message for a Proping daily digest.
 */
function buildPropingTelegramSummary(events, receivedDate) {
  const listings     = events.filter(e => e.type === 'listing');
  const sold         = events.filter(e => e.type === 'sold');
  const priceChanges = events.filter(e => e.type === 'price_change');
  const unlisted     = events.filter(e => e.type === 'unlisted');

  const pl = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;

  let msg = `📊 PROPING DAILY DIGEST — ${receivedDate}\n`;
  msg += `🆕 NEW: ${pl(listings.length, 'listing')}\n`;
  msg += `💰 SOLD: ${pl(sold.length, 'sale')}\n`;
  msg += `📉 PRICE CHANGE: ${pl(priceChanges.length, 'adjustment')}\n`;
  msg += `🚫 UNLISTED: ${pl(unlisted.length, 'withdrawn')}`;

  if (unlisted.length > 0) {
    msg += '\n\n🚫 WITHDRAWN — potential motivated vendor:';
    for (const u of unlisted) {
      const domStr = u.daysOnMarket != null ? `${u.daysOnMarket}DOM` : 'DOM unknown';
      const estStr = u.propingEstimate || 'est. unknown';
      msg += `\n• ${u.address} — ${u.beds}bed — ${domStr} — Est. ${estStr}`;
      const agentStr = [u.agentName, u.agency].filter(Boolean).join(' / ');
      if (agentStr) msg += `\n  ${agentStr}`;
    }
  }

  msg += '\n\nOpen your Jarvis dashboard for full details.';
  return msg;
}

/**
 * Process a batch of Proping events:
 *   1. Write each to market_events (INSERT OR IGNORE)
 *   2. Send (or in test mode, print) one consolidated Telegram summary
 *
 * @param {Array}   propingEvents - Parsed Proping event objects.
 * @param {string}  receivedDate  - YYYY-MM-DD for the Telegram header.
 * @param {boolean} [testMode]    - If true, print Telegram message instead of sending.
 * @returns {number} Number of net-new rows written to SQLite.
 */
async function processProping(propingEvents, receivedDate, testMode, rpMap = new Map()) {
  if (propingEvents.length === 0) {
    console.log('  → [Proping] No events to process.');
    return 0;
  }

  // Route every Proping event through the unified pipeline (no individual Telegram —
  // the consolidated digest below handles that for the whole batch).
  let newRows = 0;
  for (const event of propingEvents) {
    const saved = await processMarketEvent(event, rpMap, { sendTelegram: false });
    if (saved) newRows++;
  }
  console.log(`  → [Proping] ${newRows} new events processed.`);

  // Send consolidated Telegram digest for the full batch
  const summary = buildPropingTelegramSummary(propingEvents, receivedDate);
  if (testMode) {
    console.log('\n[test-proping] Telegram summary (NOT sent in test mode):');
    console.log('─'.repeat(55));
    console.log(summary);
    console.log('─'.repeat(55));
  } else {
    await sendTelegram(summary);
    console.log('  → [Proping] Consolidated Telegram digest sent.');
  }

  return newRows;
}

// ─── CORELOGIC PIPELINE ──────────────────────────────────────────────────────

// Writes occupancy: "Investor" onto any contact whose address matches the
// rental address extracted from a CoreLogic "For Rent Alerts" section.
function updateContactOccupancy(streetAddress) {
  try {
    const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    const normTarget = normaliseAddress(streetAddress);
    let updated = false;

    for (const contact of Object.values(data.contacts)) {
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

// ─── SCORED CONTACTS BUILDER (with progressive filter relaxation) ─────────────

/**
 * Build a scored list of proximity contacts for a market event.
 * Uses a 4-level relaxation ladder to guarantee at least minCount results:
 *   1. Same property category + ±1 bed
 *   2. Same property category + ±2 beds
 *   3. Same property category only (no bed filter)
 *   4. All types (drop category + bed filter)
 * Returns up to 20 scored contact objects.
 */
async function buildScoredContacts(address, details, rpMap, minCount = 20) {
  const listingCategory = categorizePropertyType(details.propertyType || 'House');
  const listingBeds = details.beds ? parseInt(details.beds) : null;
  const proximityContacts = await getProximityContacts(address, 200);

  function scoreContacts(bedTolerance, dropCategory) {
    return proximityContacts.map(c => {
      const key = normalise(c.address) + '|' + normaliseSuburb(c.suburb);
      const rpData = rpMap.get(key);
      if (!rpData) return null;
      if (!dropCategory) {
        const contactCategory = categorizePropertyType(rpData.propertyType);
        if (contactCategory !== listingCategory) return null;
      }
      if (!dropCategory && bedTolerance !== null && listingBeds !== null && rpData.beds) {
        const contactBeds = parseInt(rpData.beds);
        if (!isNaN(listingBeds) && contactBeds > 0 && Math.abs(listingBeds - contactBeds) > bedTolerance) return null;
      }
      const { score, tenure, occupancy } = calculatePropensityScore(c, rpData, c.score);
      return { ...c, propensityScore: score, tenure, occupancy, propertyType: rpData.propertyType, beds: rpData.beds };
    }).filter(Boolean).sort((a, b) => b.propensityScore - a.propensityScore);
  }

  const levels = [
    () => scoreContacts(1, false),    // Same category + ±1 bed
    () => scoreContacts(2, false),    // Same category + ±2 beds
    () => scoreContacts(null, false), // Same category, any beds
    () => scoreContacts(null, true),  // All types, any beds
  ];

  for (const level of levels) {
    const scored = level();
    if (scored.length >= minCount) return scored.slice(0, 20);
  }

  // Return whatever is available from the broadest filter
  return scoreContacts(null, true).slice(0, 20);
}

// Export for use by snapshot-server.js manual event endpoint
module.exports = { buildScoredContacts };

// ─── UNIFIED MARKET EVENT PIPELINE ────────────────────────────────────────────
// Every source (CoreLogic, REA/Domain, Weekly Wrap, Proping) funnels through here.
// Guarantees consistent data across all paths:
//   farm check → score contacts → write market_events → write listing-alerts.json
//   → optional individual Telegram notification.
//
// opts.sendTelegram (default false):
//   true  = send individual Telegram alert per event (REA/Domain, Weekly Wrap)
//   false = silent save only (CoreLogic, Proping — those handle Telegram separately)
async function processMarketEvent(details, rpMap = new Map(), opts = {}) {
  const { sendTelegram = false } = opts;
  const address = details.address;

  // 1. Farm area gate — only Willoughby, North Willoughby, Willoughby East
  if (!/willoughby/i.test(address)) {
    console.log(`  → Skipped: Out of farm area: ${address}`);
    return false;
  }

  // 2. Score contacts
  const scoredContacts = await buildScoredContacts(address, details, rpMap, 20);
  const topContacts = scoredContacts.map(c => ({
    id:       c.id       || '',
    name:     c.name,
    mobile:   c.mobile   || '',
    address:  c.address  || '',
    distance: c.distance ? Math.round(c.distance) : null
  }));

  // 3. Write to SQLite market_events
  writeMarketEvent(details, topContacts);

  // 4. Write to listing-alerts.json (listing and sold events only)
  if (details.type === 'listing' || details.type === 'sold') {
    try {
      const ALERTS_FILE = '/root/.openclaw/workspace/listing-alerts.json';
      const newEntry = {
        detectedAt:   new Date().toISOString(),
        type:         details.type,
        address,
        price:        details.price        || '',
        beds:         details.beds         || '',
        baths:        details.baths        || '',
        cars:         details.cars         || '',
        propertyType: details.propertyType || '',
        source:       details.source       || '',
        topContacts
      };
      let alerts = [];
      if (fs.existsSync(ALERTS_FILE)) {
        try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch (_) { alerts = []; }
      }
      const idx = alerts.findIndex(a => a.address === address && a.type === details.type);
      if (idx >= 0) alerts[idx] = newEntry; else alerts.push(newEntry);
      alerts = alerts.slice(-200);
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
      console.error('  → Alert log write failed:', e.message);
    }
  }

  // 5. Optional individual Telegram notification
  if (sendTelegram) {
    const isSold = details.type === 'sold';
    const propParts = [
      details.beds   ? `${details.beds}bed`   : null,
      details.baths  ? `${details.baths}bath`  : null,
      details.cars   ? `${details.cars}car`    : null,
      details.propertyType || null
    ].filter(Boolean).join(' · ');
    const priceStr = details.price ? `💰 ${details.price}` : '💰 Price withheld';
    let commentary;
    if (isSold) {
      const cat = categorizePropertyType(details.propertyType || '');
      commentary = cat === 'Unit'
        ? `Unit comp in the pocket — any similar owner nearby who's been sitting on it should be getting a call this week.`
        : `Strong house comp — opens the conversation with long-tenure owners in the street. Dashboard has the ranked list.`;
    } else {
      commentary = `Fresh listing on the market — buyers who miss out are your best prospective vendors. Keep an eye on the campaign.`;
    }
    const alertMsg = `${isSold ? '🔨' : '🏠'} <b>${isSold ? 'SOLD' : 'NEW LISTING'} — ${address}</b>\n\n` +
      `${priceStr}\n` +
      (propParts ? `🏠 ${propParts}\n` : '') +
      `\n💡 ${commentary}`;
    await sendTelegram(alertMsg);
  }

  console.log(`  ✅ ${details.type.toUpperCase()} @ ${address} [${details.source}] — ${topContacts.length} contacts`);
  return true;
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

  // ── Proping daily digest ──────────────────────────────────────────────────
  if (sender.includes('proping@proping.com.au') || /Changes in Your Market/i.test(subject)) {
    const receivedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    return parseProping(subject, body, receivedDate);
  }
  // ─────────────────────────────────────────────────────────────────────────

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

    // 4. BED COUNT MATCHING: must be within ±1 of listing bed count
    if (details.beds) {
      const listingBeds = parseInt(details.beds);
      const contactBeds = parseInt(rpData.beds || '0');
      if (!isNaN(listingBeds) && contactBeds > 0 && Math.abs(listingBeds - contactBeds) > 1) return null;
    }

    const { score, tenure, occupancy } = calculatePropensityScore(c, rpData, c.score);
    return { ...c, propensityScore: score, tenure, occupancy, propertyType: rpData.propertyType, beds: rpData.beds };
  }).filter(Boolean);

  const top30 = scoredContacts
    .sort((a, b) => b.propensityScore - a.propensityScore)
    .slice(0, 30);

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
      'baileyobyrne@mcgrath.com.au',
      'proping@proping.com.au'         // Proping daily digest
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
      'RP Data',
      'Your RP Data',
      'Changes in Your Market'         // Proping subject line
    ];

    let allMessageUids = new Set();

    for (const sender of knownSenders) {
      const msgs = await client.search(process.env.SEARCH_ALL ? { from: sender } : { from: sender, seen: false });
      msgs.forEach(uid => allMessageUids.add(uid));
    }

    for (const keyword of keywordSubjects) {
      const msgs = await client.search(process.env.SEARCH_ALL ? { subject: keyword } : { subject: keyword, seen: false });
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
      const body    = parsed.text    || '';
      const from    = parsed.from?.text || '';

      // CoreLogic territory alerts are pre-scoped to our area — skip the suburb filter
      const fromSender = from.toLowerCase();
      const isCoreLogicEmail =
        fromSender.includes('corelogic.com.au') ||
        /fw:.*(?:rp\s*data|your rp data)/i.test(subject) ||
        (fromSender.includes('baileyobyrne@mcgrath.com.au') && /rp\s*data|corelogic/i.test(subject));

      // Proping emails contain Australia-wide data — let routeEmail filter; no area check needed
      const isPropingEmail =
        fromSender.includes('proping@proping.com.au') ||
        /Changes in Your Market/i.test(subject);

      if (!isCoreLogicEmail && !isPropingEmail && !isWilloughbyArea(subject + body)) {
        console.log(`  → Skipped: Property not in Willoughby: ${subject}`);
        continue;
      }

      console.log(`  → ${subject}`);

      const detailsList = routeEmail(subject, body, from);

      if (detailsList.length === 0) {
        console.log('  → No parseable listings found');
        continue;
      }

      // ── PROPING TRACK: batch process entire digest, one Telegram summary ────
      if (detailsList[0]?.source === 'Proping') {
        const receivedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
        await processProping(detailsList, receivedDate, false, rpMap);
        found += detailsList.length;
        fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
        continue;
      }
      // ────────────────────────────────────────────────────────────────────────

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

        // All sources route through the unified pipeline.
        // CoreLogic is high-volume territory data — skip individual Telegram.
        // REA/Domain/Weekly Wrap get individual Telegram notifications.
        const sendTelegram = details.source !== 'CoreLogic';
        const saved = await processMarketEvent(details, rpMap, { sendTelegram });
        if (saved) found++;

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

// ─── TEST: --test-proping ──────────────────────────────────────────────────────

async function testProping() {
  console.log('[test-proping] Running Proping parser with hardcoded sample body...\n');

  const receivedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

  const sampleBody = `Price Change(1)
26/166 Mowbray Road, Willoughby
2 bed  7 Days listed
$975,000 Proping Estimate*  $50,000
Jason Georges / McGrath Willoughby
Newly Listed(3)
136/2 Artarmon Road, Willoughby
2 bed  0 Days listed
$1,500,000 Proping Estimate*
Rick D'Amico / Forsyth Real Estate
41 Tyneside Avenue, Willoughby
5 bed  0 Days listed
$3,800,000 Proping Estimate*
Daniel Campbell / DiJones - Willoughby
Sold(1)
23 Wallace Street, Willoughby
4 bed  23 Days listed
$4,100,000 Proping Estimate*
Price Withheld Sold Price
Jason Conroy / The Agency North
Unlisted(1)
56 Tulloh Street, Willoughby
4 bed  14 Days listed
$4,200,000 Proping Estimate*
Nicholas Dunn / McGrath Willoughby`;

  const events = parseProping('Changes in Your Market', sampleBody, receivedDate);

  console.log(`[test-proping] Parsed ${events.length} events:\n`);
  events.forEach((e, i) => {
    console.log(`  [${i + 1}] ${e.type.toUpperCase()} @ ${e.address}`);
    console.log(`       suburb=${e.suburb} beds=${e.beds} DOM=${e.daysOnMarket}`);
    console.log(`       estimate=${e.propingEstimate} priceWithheld=${e.priceWithheld}`);
    console.log(`       agent="${e.agentName}" / agency="${e.agency}"`);
  });
  console.log('');

  // processProping writes to SQLite and prints (not sends) Telegram summary
  const newRows = await processProping(events, receivedDate, true /* testMode */);

  // Verification query — confirm rows in DB
  const rows = db.prepare(
    `SELECT address, type, event_date FROM market_events WHERE source = 'Proping' AND event_date = ?`
  ).all(receivedDate);

  console.log(`\n[test-proping] Verification: market_events rows for ${receivedDate}:`);
  rows.forEach(r => console.log(`  → [${r.type}] ${r.address}`));
  console.log(`\n[test-proping] ${newRows} new rows inserted this run. ${rows.length} total Proping rows for today in market_events.`);

  if (rows.length >= 5) {
    console.log('[test-proping] ✅ PASS — at least 5 Proping rows confirmed in market_events.');
  } else {
    console.log(`[test-proping] ⚠️  Expected 5 rows, found ${rows.length}. (Duplicates are suppressed by INSERT OR IGNORE on repeated runs.)`);
  }
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

if (process.argv.includes('--test-proping')) {
  testProping().catch(err => {
    console.error('[test-proping] Fatal:', err.message);
    process.exit(1);
  });
} else {
  checkEmails();
}
