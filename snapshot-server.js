require('dotenv').config({ path: '/root/.openclaw/.env', override: true });
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');
const { spawn } = require('child_process');
const { db }    = require('./lib/db.js');
const multer    = require('multer');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const { createCalendarEvent, fetchTodayEvents } = require('./lib/ical-calendar.js');
const upload  = multer({
  dest: '/root/.openclaw/workspace/intel/',
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Audio upload — separate multer instance for call recordings
const CALLS_DIR = '/root/.openclaw/workspace/calls';
if (!fs.existsSync(CALLS_DIR)) fs.mkdirSync(CALLS_DIR, { recursive: true });
const uploadAudio = multer({
  dest: CALLS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB — ~10 min MP3
});

const app  = express();
const PORT = 4242;

const SSL_KEY  = '/root/.openclaw/ssl/key.pem';
const SSL_CERT = '/root/.openclaw/ssl/cert.pem';

// ─── Guard: must have a password configured ────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
if (!DASHBOARD_PASSWORD) {
  console.error('FATAL: DASHBOARD_PASSWORD is not set in .env — refusing to start.');
  process.exit(1);
}

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// General: 300 req / 15 min per IP (plenty for normal use)
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));
// Auth: 10 failed attempts / 15 min per IP — only fires on 401 responses
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,   // only counts failed (non-2xx) requests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed attempts — try again in 15 minutes' },
});
app.use('/api/', authLimiter);

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONTACTS_FILE  = '/root/.openclaw/workspace/willoughby-contacts.json';
const RP_DATA_FILE   = '/root/.openclaw/workspace/rp_data.csv';
const COOLDOWN_FILE  = '/root/.openclaw/workspace/recently-planned.json';
const LOG_FILE       = '/root/.openclaw/workspace/daily-planner.log';
const ALERTS_FILE    = '/root/.openclaw/workspace/listing-alerts.json';
const GEO_CACHE_FILE = '/root/.openclaw/workspace/geo-cache.json';
const DASHBOARD_DIR  = '/root/.openclaw/workspace/dashboard';

// ─── In-memory cache (refreshed every hour) ───────────────────────────────────
let _contactsMap     = null;   // Map<id, contactObject>           — AgentBox JSON (67k)
let _rpMap           = null;   // Map<"STREET SUBURB", rpEntry>    — RP Data CSV
let _geoCache        = null;   // Map<address_string, {lat,lon}>   — geo-cache.json
let _sqlContactsMap  = null;   // Map<id, contact>                 — SQLite contacts + pf_phone
let _recentCallMap   = null;   // Map<contact_id, [{outcome, called_at}]> — last 90 days
let _agentboxAddrSet = null;   // Set<normalizedAddr>              — addresses with AgentBox coverage
let _cacheTs         = 0;
const CACHE_TTL      = 60 * 60 * 1000; // 1 hour

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resolve);
    req.on('error', err => console.error('[sendTelegramMessage]', err.message));
    req.write(body); req.end();
  });
}

// Normalise an address string to a canonical form for dedup (strips suburb, abbreviates street types)
function normalizeAddrForDedup(addr) {
  return (addr || '').toUpperCase()
    .split(',')[0]  // strip suburb component
    .replace(/\bAVENUE\b/g, 'AVE').replace(/\bSTREET\b/g, 'ST')
    .replace(/\bROAD\b/g, 'RD').replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bLANE\b/g, 'LN').replace(/\bPLACE\b/g, 'PL')
    .replace(/\bCLOSE\b/g, 'CL').replace(/\bCRESCENT\b/g, 'CRES')
    .replace(/\bCOURT\b/g, 'CT').replace(/\bPARADE\b/g, 'PDE')
    .replace(/\bTERRACE\b/g, 'TCE').replace(/\bGROVE\b/g, 'GR')
    .replace(/\s+/g, ' ').trim();
}

function normalizeSuburb(suburb) {
  if (!suburb) return '';
  const s = suburb.toUpperCase().trim();
  if (s === 'NORTH WILLOUGHBY' || s === 'WILLOUGHBY EAST' || s === 'WILLOUGHBY') return 'WILLOUGHBY';
  return s;
}

function parseRPData() {
  if (!fs.existsSync(RP_DATA_FILE)) return new Map();
  const content    = fs.readFileSync(RP_DATA_FILE, 'utf8');
  const lines      = content.split('\n');
  const headerLine = lines[2]; // headers on line 3 (index 2)
  if (!headerLine) return new Map();

  const parseLine = (line) => {
    const values = [];
    let current = '', inQuotes = false;
    for (const char of line) {
      if (char === '"')             { inQuotes = !inQuotes; }
      else if (char === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else                          { current += char; }
    }
    values.push(current.trim());
    return values;
  };

  const headers = parseLine(headerLine).map(h => h.replace(/"/g, ''));
  const map = new Map();
  for (let i = 3; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals  = parseLine(lines[i]).map(v => v.replace(/"/g, ''));
    const entry = {};
    headers.forEach((h, idx) => { entry[h] = vals[idx] || ''; });
    const street = (entry['Street Address'] || '').toUpperCase().trim();
    const suburb = normalizeSuburb(entry['Suburb']);
    const key    = `${street} ${suburb}`.trim();
    map.set(key, entry);
  }
  return map;
}

function loadCache(force = false) {
  if (!force && _contactsMap && (Date.now() - _cacheTs < CACHE_TTL)) return;
  console.log('[cache] Loading contacts + RP data...');
  const raw = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  _contactsMap = new Map();
  for (const c of raw.contacts) {
    const key = c.id || c.mobile;
    if (key) _contactsMap.set(String(key), c);
  }
  _rpMap   = parseRPData();
  _cacheTs = Date.now();

  // ── AgentBox address set (for suppressing pf_ duplicates) ──────────────────
  // Any address covered by AgentBox takes priority over a pf_ contact at the same address.
  _agentboxAddrSet = new Set();
  for (const [, c] of _contactsMap) {
    const norm = normalizeAddrForDedup(c.address || '');
    if (norm) _agentboxAddrSet.add(norm);
  }

  // ── geo-cache ──────────────────────────────────────────────────────────────
  _geoCache = new Map();
  try {
    if (fs.existsSync(GEO_CACHE_FILE)) {
      const geoData = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(geoData)) _geoCache.set(k, v);
    }
  } catch (e) { console.warn('[cache] geo-cache load failed:', e.message); }

  // ── SQL contacts (AgentBox + pricefinder, with phones) ─────────────────────
  _sqlContactsMap = new Map();
  try {
    const sqlContacts = db.prepare(`
      SELECT c.id, c.name, c.address, c.suburb, c.propensity_score, c.tenure_years,
             c.beds, c.property_type,
             COALESCE(c.mobile, p.pf_phone) AS effective_phone
      FROM contacts c
      LEFT JOIN properties p ON c.id = p.contact_id
      WHERE (c.mobile IS NOT NULL OR p.pf_phone IS NOT NULL)
        AND (c.do_not_call = 0 OR c.do_not_call IS NULL)
        AND (p.do_not_call IS NULL OR p.do_not_call = 0)
      GROUP BY c.id
    `).all();
    for (const c of sqlContacts) _sqlContactsMap.set(String(c.id), c);
  } catch (e) { console.warn('[cache] SQL contacts load failed:', e.message); }

  // ── recent call map (last 90 days) ──────────────────────────────────────────
  _recentCallMap = new Map();
  try {
    const callRows = db.prepare(`
      SELECT contact_id, outcome, called_at FROM call_log
      WHERE called_at >= datetime('now', '-90 days')
      ORDER BY called_at DESC
    `).all();
    for (const row of callRows) {
      const id = String(row.contact_id);
      if (!_recentCallMap.has(id)) _recentCallMap.set(id, []);
      _recentCallMap.get(id).push({ outcome: row.outcome, called_at: row.called_at });
    }
  } catch (e) { console.warn('[cache] call log load failed:', e.message); }

  console.log(`[cache] Ready — ${_contactsMap.size} AgentBox (${_agentboxAddrSet.size} addrs), ${_sqlContactsMap.size} SQL contacts, ${_rpMap.size} RP entries, ${_geoCache.size} geo entries.`);
}

// Warm cache on startup (non-fatal if data files are not yet present)
try { loadCache(true); } catch (e) {
  console.warn('[cache] Warm failed (non-fatal):', e.message);
}

// ── Startup: dedup listing-alerts.json (fix pre-existing duplicate entries) ──
try {
  if (fs.existsSync(ALERTS_FILE)) {
    let alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    const seen = new Set();
    // Keep last occurrence of each street-part (reverse → filter → reverse)
    alerts = alerts.slice().reverse().filter(a => {
      const normStreetPart = (a.address || '').toUpperCase().split(',')[0].trim();
      if (seen.has(normStreetPart)) return false;
      seen.add(normStreetPart);
      return true;
    }).reverse();
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    console.log('[startup] listing-alerts.json deduped');
  }
} catch (e) {
  console.warn('[startup] alerts dedup failed (non-fatal):', e.message);
}

// ─── Geo utilities ────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ORDINALS = { FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6 };
function extractOrdinal(streetKeyword) {
  return ORDINALS[(streetKeyword || '').toUpperCase()] || null;
}

async function geocodeAddress(streetPart, suburb) {
  if (!_geoCache) return null;
  if (_geoCache.has(streetPart)) return _geoCache.get(streetPart);
  const withSuburb = suburb ? `${streetPart}, ${suburb}` : null;
  if (withSuburb && _geoCache.has(withSuburb)) return _geoCache.get(withSuburb);

  const query = `${streetPart}${suburb ? ', ' + suburb : ''}, NSW, Australia`;
  try {
    await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit
    const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: query, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'JarvisRE/1.0' },
      timeout: 8000,
    });
    if (resp.data && resp.data[0]) {
      const result = { lat: parseFloat(resp.data[0].lat), lon: parseFloat(resp.data[0].lon) };
      _geoCache.set(streetPart, result);
      try {
        const geoObj = Object.fromEntries(_geoCache);
        fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoObj, null, 2));
      } catch (_) {}
      return result;
    }
  } catch (e) {
    console.warn('[geocode] Nominatim error for "' + streetPart + '":', e.message);
  }
  return null;
}

// ─── updateAlertsFileEntry helper ─────────────────────────────────────────────
function updateAlertsFileEntry(address, topContacts) {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return;
    let alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    const normStreetPart = address.toUpperCase().split(',')[0].trim();
    const idx = alerts.findIndex(a => a.address.toUpperCase().split(',')[0].trim() === normStreetPart);
    if (idx >= 0) {
      alerts[idx] = { ...alerts[idx], topContacts };
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    }
  } catch (e) {
    console.warn('[updateAlertsFileEntry]', e.message);
  }
}

// ── Startup: async rebuild of Manual event contacts from last 30 days ─────────
setImmediate(async () => {
  try {
    const staleEvents = db.prepare(`
      SELECT id, address, type, beds, property_type
      FROM market_events WHERE source = 'Manual'
      AND created_at >= datetime('now', '-30 days')
    `).all();
    for (const ev of staleEvents) {
      const scored = await buildScoredContactsForManual(
        ev.address, { propertyType: ev.property_type, beds: ev.beds }, 0
      );
      db.prepare('UPDATE market_events SET top_contacts = ? WHERE id = ?')
        .run(JSON.stringify(scored), ev.id);
      updateAlertsFileEntry(ev.address, scored);
      console.log(`[startup] Rebuilt ${ev.address} → ${scored.length} contacts`);
    }
  } catch (e) {
    console.warn('[startup] Manual event rebuild failed (non-fatal):', e.message);
  }
});

// ─── Scoring helpers (mirrors daily-planner.js logic exactly) ─────────────────
function calcScore(contact, rpEntry) {
  let score = 0;
  if (rpEntry?.['Sale Date']) {
    const m = rpEntry['Sale Date'].match(/\d{4}/);
    if (m && new Date().getFullYear() - parseInt(m[0]) > 7) score += 20;
  }
  if (contact.appraisals?.length > 0) score += 30;
  if (rpEntry?.['Owner Type'] === 'Rented')              score += 15;
  return score;
}

function buildIntel(contact, rpEntry) {
  const lines = [];
  if (rpEntry) {
    const saleDate = rpEntry['Sale Date'];
    if (saleDate && saleDate !== '-') {
      const m = saleDate.match(/\d{4}/);
      if (m) {
        const yrs = new Date().getFullYear() - parseInt(m[0]);
        lines.push(`📌 Owned ${yrs} yr${yrs !== 1 ? 's' : ''} — last transacted ${saleDate}`);
      }
    }
    const ownerType = rpEntry['Owner Type'];
    if (ownerType && ownerType !== '-') {
      lines.push(ownerType.toLowerCase().includes('rent') ? '🏦 Investor / Rented' : '🏡 Owner Occupied');
    }
  }
  if (contact.appraisals?.length) {
    lines.push(`📋 ${contact.appraisals.length} prior appraisal(s) on record`);
  }
  if (contact.notes?.length) {
    const headline = contact.notes[0]?.headline;
    if (headline) lines.push(`💬 "${headline}"`);
  }
  return lines.join('\n');
}

function buildAngle(contact, rpEntry) {
  const ownerType = (rpEntry?.['Owner Type'] || '').toLowerCase();
  if (ownerType.includes('rent')) {
    return '🎯 Discuss yield vs capital growth — compelling investor exit market';
  }
  if (contact.appraisals?.length) {
    return '🎯 Revisit past appraisal — market has shifted significantly since then';
  }
  const m = rpEntry?.['Sale Date']?.match(/\d{4}/);
  if (m) {
    const yrs = new Date().getFullYear() - parseInt(m[0]);
    if (yrs >= 7) return `🎯 ${yrs} years of equity growth — float a no-pressure appraisal`;
  }
  return '🎯 Float a no-pressure market appraisal to validate current equity';
}

function isToday(isoString) {
  if (!isoString) return false;
  const opts = { timeZone: 'Australia/Sydney' };
  return (
    new Date().toLocaleDateString('en-AU', opts) ===
    new Date(isoString).toLocaleDateString('en-AU', opts)
  );
}

// ─── Buyer matching helpers ────────────────────────────────────────────────────

function parsePriceToInt(priceStr) {
  if (!priceStr) return null;
  const s = String(priceStr).replace(/[$,\s]/g, '').toLowerCase();
  if (s.includes('withheld') || s.includes('contact')) return null;
  const mMatch = s.match(/^([\d.]+)\s*m/);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1e6);
  const kMatch = s.match(/^([\d.]+)\s*k/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1e3);
  const stripped = s.replace(/[^0-9.]/g, '');
  if ((stripped.match(/\./g) || []).length > 1) return null; // reject malformed like "1.8.5"
  const num = parseFloat(stripped);
  return isNaN(num) ? null : Math.round(num);
}

function findMatchingBuyers(event) {
  // event = { address, suburb, type, beds, baths, cars, property_type, price, id (market_event_id) }
  const buyers = db.prepare("SELECT * FROM buyer_profiles WHERE status = 'active'").all();
  if (buyers.length === 0) return [];

  const eventSuburb = (event.suburb || '').toUpperCase().trim();
  const eventBeds = event.beds ? parseInt(event.beds) : null;
  const eventPriceNum = parsePriceToInt(event.price || event.confirmed_price);
  const eventTypeLower = (event.property_type || '').toLowerCase();

  const matches = [];

  for (const buyer of buyers) {
    // Parse buyer suburbs
    let suburbsWanted = [];
    try { suburbsWanted = JSON.parse(buyer.suburbs_wanted || '[]'); } catch (_) {}
    const suburbsNorm = suburbsWanted.map(s => s.toUpperCase().trim());

    // Suburb match — required unless buyer has no preferences
    const suburbMatch = suburbsNorm.length === 0 || suburbsNorm.includes(eventSuburb);
    if (!suburbMatch) continue;

    // Dedup check — prevent re-notifying same buyer for same address within 14 days
    if (event.id) {
      const recent = db.prepare(
        "SELECT id FROM buyer_matches WHERE buyer_id = ? AND market_event_id = ? AND matched_at >= datetime('now', '-14 days')"
      ).get(buyer.id, event.id);
      if (recent) continue;
    } else {
      // No event ID — deduplicate by address
      const recent = db.prepare(
        "SELECT id FROM buyer_matches WHERE buyer_id = ? AND event_address = ? AND matched_at >= datetime('now', '-14 days')"
      ).get(buyer.id, (event.address || '').toUpperCase());
      if (recent) continue;
    }

    let score = 0;
    const reasons = [];

    // Suburb score
    if (suburbsNorm.length === 0) {
      score += 10; // no preference = soft match
    } else {
      score += 40;
      reasons.push(`Suburb: ${eventSuburb}`);
    }

    // Beds score
    if (eventBeds !== null && (buyer.beds_min || buyer.beds_max)) {
      const bedsMin = buyer.beds_min || 0;
      const bedsMax = buyer.beds_max || 99;
      if (eventBeds >= bedsMin && eventBeds <= bedsMax) {
        score += 30;
        reasons.push(`${eventBeds}bd in range ${bedsMin}–${bedsMax}`);
      } else {
        score -= 10;
      }
    } else if (!buyer.beds_min && !buyer.beds_max) {
      score += 10; // no preference
    }

    // Property type score
    const buyerType = (buyer.property_type || 'any').toLowerCase();
    if (buyerType === 'any' || !buyerType) {
      score += 10;
    } else if (eventTypeLower && eventTypeLower.includes(buyerType)) {
      score += 20;
      reasons.push(`Type: ${buyerType}`);
    } else if (buyerType !== 'any' && eventTypeLower && !eventTypeLower.includes(buyerType)) {
      score -= 5;
    }

    // Price score (10% tolerance)
    if (eventPriceNum && (buyer.price_min || buyer.price_max)) {
      const priceMin = buyer.price_min || 0;
      const priceMax = buyer.price_max || Infinity;
      if (eventPriceNum >= priceMin * 0.9 && eventPriceNum <= priceMax * 1.1) {
        score += 25;
        reasons.push(`Price $${(eventPriceNum/1e6).toFixed(2)}M in budget`);
      } else if (eventPriceNum > priceMax * 1.1) {
        score -= 15; // over budget
      }
      // Under budget: neutral
    }

    if (score > 0) {
      matches.push({ buyer, matchScore: score, reasons });
    }
  }

  matches.sort((a, b) => b.matchScore - a.matchScore);
  return matches;
}

async function notifyBuyerMatches(matches, eventAddress, marketEventId) {
  if (matches.length === 0) return;

  const insertMatch = db.prepare(
    'INSERT OR IGNORE INTO buyer_matches (buyer_id, market_event_id, event_address, notified_telegram) VALUES (?, ?, ?, 1)'
  );
  const insertReminder = db.prepare(
    "INSERT INTO reminders (contact_name, contact_mobile, note, fire_at, is_task, contact_id) VALUES (?, ?, ?, datetime('now', '+1 day', 'start of day', '+9 hours'), 0, ?)"
  );
  const updateMatch = db.prepare('UPDATE buyer_matches SET reminder_created=1, reminder_id=? WHERE buyer_id=? AND market_event_id=? AND event_address=?');

  const notified = [];
  for (const m of matches) {
    try {
      const matchResult = insertMatch.run(m.buyer.id, marketEventId || null, (eventAddress || '').toUpperCase());
      if (matchResult.changes > 0) {
        const remId = insertReminder.run(
          m.buyer.name,
          m.buyer.mobile || null,
          `Buyer match — call ${m.buyer.name} re: ${eventAddress}`,
          m.buyer.contact_id || null
        ).lastInsertRowid;
        if (marketEventId) {
          updateMatch.run(remId, m.buyer.id, marketEventId, (eventAddress || '').toUpperCase());
        }
        notified.push(m);
      }
    } catch (e) {
      console.warn('[buyer-match] Failed to record match:', e.message);
    }
  }

  // Only send Telegram if at least one new notification was created
  if (notified.length === 0) return;

  const msgLines = notified.slice(0, 5).map(m => {
    const parts = [m.buyer.name];
    if (m.buyer.mobile) parts.push(m.buyer.mobile);
    if (m.reasons.length) parts.push(`(${m.reasons.join(', ')})`);
    return `• ${parts.join(' — ')}`;
  });

  const msg = `🏠 <b>BUYER MATCH — ${eventAddress}</b>\n\n${notified.length} active buyer profile${notified.length > 1 ? 's' : ''} match:\n${msgLines.join('\n')}${notified.length > 5 ? `\n...and ${notified.length - 5} more` : ''}\n\nCheck Buyers page to follow up.`;

  sendTelegramMessage(msg).catch(e => console.warn('[buyer-match] Telegram failed:', e.message));
}

// Automation 2: check active buyer *referrals* against a market event suburb and notify
async function notifyReferralBuyerMatches(event) {
  try {
    const eventSuburb = (event.suburb || '').toUpperCase().trim();
    if (!eventSuburb) return;

    const activeReferrals = db.prepare(
      "SELECT r.*, c.name AS contact_name, c.mobile AS contact_mobile, p.name AS partner_name " +
      "FROM referrals r " +
      "LEFT JOIN contacts c ON c.id = r.contact_id " +
      "LEFT JOIN partners p ON p.id = r.partner_id " +
      "WHERE r.type = 'buyer' AND r.status IN ('referred','introduced','active')"
    ).all();

    if (activeReferrals.length === 0) return;

    const priceNum = parsePriceToInt(event.price || event.confirmed_price);
    const eventAddr = (event.address || '').trim();
    const eventType = (event.property_type || event.type || '').toLowerCase();
    const eventBeds = event.beds ? parseInt(event.beds) : null;

    for (const ref of activeReferrals) {
      let brief = {};
      try { brief = JSON.parse(ref.buyer_brief || '{}'); } catch (_) { continue; }

      // suburbs can be a JSON array or a comma-sep string or brief.suburbs_wanted
      let suburbs = [];
      if (Array.isArray(brief.suburbs)) {
        suburbs = brief.suburbs;
      } else if (typeof brief.suburbs === 'string') {
        suburbs = brief.suburbs.split(',').map(s => s.trim()).filter(Boolean);
      } else if (typeof brief.suburbs_wanted === 'string') {
        suburbs = brief.suburbs_wanted.split(',').map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(brief.suburbs_wanted)) {
        suburbs = brief.suburbs_wanted;
      }
      if (suburbs.length === 0) continue;

      const suburbsUpper = suburbs.map(s => s.toUpperCase().trim());
      const matched = suburbsUpper.some(s => eventSuburb.includes(s) || s.includes(eventSuburb));
      if (!matched) continue;

      // Build match message
      const priceStr  = priceNum ? `$${(priceNum/1e6).toFixed(2).replace(/\.?0+$/, '')}M` : null;
      const budgetMin = brief.budget_min ? `$${(brief.budget_min/1e6).toFixed(1)}M` : null;
      const budgetMax = brief.budget_max ? `$${(brief.budget_max/1e6).toFixed(1)}M` : null;
      const budgetStr = budgetMin && budgetMax ? `${budgetMin}–${budgetMax}` : budgetMin || budgetMax || null;
      const bedsStr   = eventBeds ? `${eventBeds}` : null;
      const bathsStr  = event.baths ? `${event.baths}` : null;

      let matchedSuburb = suburbsUpper.find(s => eventSuburb.includes(s) || s.includes(eventSuburb)) || eventSuburb;

      let msg = `🎯 BUYER MATCH ALERT\n\nProperty: ${eventAddr}`;
      const detailParts = [];
      if (eventType) detailParts.push(`Type: ${eventType}`);
      if (priceStr) detailParts.push(`Price: ${priceStr.replace('M', ',000,000').replace('$', '$').replace(/\.\d+,/, ',')}`);
      if (detailParts.length) msg += `\n${detailParts.join(' | ')}`;
      const specParts = [];
      if (bedsStr) specParts.push(`Beds: ${bedsStr}`);
      if (bathsStr) specParts.push(`Baths: ${bathsStr}`);
      if (specParts.length) msg += `\n${specParts.join(' | ')}`;
      msg += `\n\nMatches buyer brief for:\n👤 ${ref.contact_name || 'Unknown'} → ${ref.partner_name || 'Unknown'}`;
      if (budgetStr) msg += `\n💰 ${budgetStr} budget · ${matchedSuburb} ✓`;
      if (ref.contact_mobile) msg += `\n📞 ${ref.contact_mobile}`;

      sendTelegramMessage(msg).catch(e => console.warn('[referral-buyer-match] Telegram failed:', e.message));
    }
  } catch (e) {
    console.warn('[referral-buyer-match] failed:', e.message);
  }
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
  }
  next();
}

// ─── API ──────────────────────────────────────────────────────────────────────

const MONITOR_LOG_FILE = '/root/.openclaw/workspace/monitor.log';

// GET /api/status — public, used by dashboard header health indicator
app.get('/api/status', (req, res) => {
  try {
    loadCache();
    const todayCount  = db.prepare(
      "SELECT COUNT(*) AS n FROM call_queue WHERE status IN ('active','snoozed')"
    ).get().n;
    const calledCount = db.prepare(
      "SELECT COUNT(*) AS n FROM call_queue WHERE last_called_at IS NOT NULL AND date(last_called_at,'localtime') = date('now','localtime')"
    ).get().n;
    let lastRun = null;
    if (fs.existsSync(LOG_FILE)) {
      lastRun = fs.statSync(LOG_FILE).mtime.toISOString();
    }
    // Read last email scan time from monitor.log
    let lastEmailScan = null;
    try {
      if (fs.existsSync(MONITOR_LOG_FILE)) {
        const logContent = fs.readFileSync(MONITOR_LOG_FILE, 'utf8');
        const lines = logContent.split('\n');
        // Find the last line containing a timestamp at the start (ISO format)
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line)) {
            const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*)/);
            if (isoMatch) { lastEmailScan = isoMatch[1]; break; }
          }
          // Also look for lines containing "Checking email" with surrounding timestamp
          if (/Checking email/i.test(line)) {
            const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*)/);
            if (isoMatch) { lastEmailScan = isoMatch[1]; break; }
          }
        }
        // If no inline timestamp found, use file mtime as fallback
        if (!lastEmailScan) {
          lastEmailScan = fs.statSync(MONITOR_LOG_FILE).mtime.toISOString();
        }
      }
    } catch (_) { /* non-fatal */ }
    res.json({
      healthy:       true,
      lastRun,
      lastEmailScan,
      totalContacts: _contactsMap?.size ?? 0,
      todayCount,
      calledCount,
      target:        30,
    });
  } catch (e) {
    res.status(500).json({ healthy: false, error: e.message });
  }
});

// ── GET /api/stats/today — call counts for today ─────────────────────────────
app.get('/api/stats/today', requireAuth, (req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = db.prepare(`
    SELECT outcome, COUNT(*) as n
    FROM call_log
    WHERE called_at >= datetime(?, 'localtime')
    GROUP BY outcome
  `).all(todayStart.toISOString());

  const counts = { calls: 0, connected: 0, left_message: 0, no_answer: 0, not_interested: 0, callback_requested: 0, appraisal_booked: 0 };
  rows.forEach(r => {
    counts.calls += r.n;
    if (counts[r.outcome] !== undefined) counts[r.outcome] = r.n;
  });
  res.json(counts);
});

// ── GET /api/agenda/today ─────────────────────────────────────────────────
app.get('/api/agenda/today', requireAuth, async (req, res) => {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

  const reminders = db.prepare(`
    SELECT id, contact_name, contact_mobile, note, fire_at
    FROM reminders
    WHERE sent = 0 AND fire_at >= ? AND fire_at <= ?
    ORDER BY fire_at ASC
  `).all(todayStart.toISOString(), todayEnd.toISOString());

  const planCount = db.prepare(`
    SELECT COUNT(*) as n FROM daily_plans WHERE date(created_at) = date('now','localtime')
  `).get().n;

  const calEvents = await fetchTodayEvents();

  res.json({ events: calEvents, reminders, planCount });
});

// GET /api/contacts/today — returns today's planned contacts, enriched from RP data
app.get('/api/contacts/today', requireAuth, (req, res) => {
  try {
    loadCache();
    const cooldown = fs.existsSync(COOLDOWN_FILE)
      ? JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'))
      : {};

    const todayEntries = Object.entries(cooldown)
      .filter(([, e]) => isToday(e.plannedAt));

    const contacts = todayEntries.map(([id, planned]) => {
      const contact = _contactsMap?.get(String(id)) || {};

      // RP data lookup key: "STREET ADDRESS SUBURB" (uppercase, Willoughby variants normalised)
      const street  = (contact.address || '').toUpperCase().trim();
      const suburb  = normalizeSuburb(contact.suburb || '');
      const rpKey   = `${street} ${suburb}`.trim();
      const rpEntry = rpKey ? _rpMap?.get(rpKey) : null;

      const score       = calcScore(contact, rpEntry);
      const saleDate    = rpEntry?.['Sale Date'] || '';
      const saleYearM   = saleDate.match(/\d{4}/);
      const tenureYears = saleYearM ? new Date().getFullYear() - parseInt(saleYearM[0]) : null;
      const tenure      = tenureYears !== null ? `${tenureYears} years` : 'Unknown';
      const occupancy   = rpEntry?.['Owner Type'] || contact.occupancy || '';
      const lastSaleDate = saleDate;

      // Angle: prefer AI-generated from cooldown entry; fall back to deterministic summary
      const storedAngle = planned.angle;
      const hasAiAngle  = storedAngle && storedAngle.trim().length > 0;
      const angle       = hasAiAngle
        ? storedAngle
        : `Owned ${tenure} — ${occupancy || 'Unknown'} — last sold ${lastSaleDate || 'Unknown'}`;
      const angleSource = hasAiAngle ? 'ai' : 'fallback';

      return {
        id,
        name:            contact.name  || planned.name || 'Unknown',
        mobile:          contact.mobile || '',
        address:         [contact.address, contact.suburb].filter(Boolean).join(', '),
        tenure,
        propensityScore: score,
        intel:           buildIntel(contact, rpEntry),
        angle,
        angleSource,
        beds:            rpEntry?.['Bed']            || contact.beds         || '',
        baths:           rpEntry?.['Bath']           || contact.baths        || '',
        cars:            rpEntry?.['Car']            || contact.cars         || '',
        propertyType:    rpEntry?.['Property Type']  || contact.propertyType || '',
        occupancy,
        lastSaleDate,
        plannedAt:       planned.plannedAt,
        calledAt:        planned.calledAt || null,
        source:          planned.source   || 'Daily Planner',
      };
    });

    // Uncalled first (highest score first), called contacts last
    contacts.sort((a, b) => {
      if (!!a.calledAt !== !!b.calledAt) return a.calledAt ? 1 : -1;
      return b.propensityScore - a.propensityScore;
    });

    res.json({ contacts, count: contacts.length, target: 80 });
  } catch (e) {
    console.error('[GET /api/contacts/today]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/contacts/:id/called — stamps calledAt on a contact in recently-planned.json
app.post('/api/contacts/:id/called', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (!fs.existsSync(COOLDOWN_FILE)) {
      return res.status(404).json({ error: 'No planned contacts file found.' });
    }
    const cooldown = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
    if (!cooldown[id]) {
      return res.status(404).json({ error: `Contact ${id} not found in planned list.` });
    }
    const calledAt = new Date().toISOString();
    cooldown[id].calledAt = calledAt;
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown, null, 2));
    console.log(`[${calledAt}] ✓ Called: ${cooldown[id].name} (id: ${id})`);
    res.json({ ok: true, id, name: cooldown[id].name, calledAt });
  } catch (e) {
    console.error('[POST /api/contacts/:id/called]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/alerts — public (no auth), returns latest listing/sale alerts newest-first
// Enriches each topContact with their most recent call_log outcome so the UI
// can correctly show "already called" state after a page reload.
// Also applies cross-event dedup: each contact only appears in the event where they score highest.
app.get('/api/alerts', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return res.json([]);
    let alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));

    // Only show events in the Willoughby farm area (Willoughby, North Willoughby, Willoughby East)
    alerts = alerts.filter(a => /willoughby/i.test(a.address || ''));

    // ── Cross-event contact deduplication ─────────────────────────────────────
    // Each contact ID appears in at most one event — the one where they score highest.
    const bestEvent = new Map(); // contactId → { eventIdx, score }
    alerts.forEach((ev, i) => {
      (ev.topContacts || []).forEach(c => {
        const existing = bestEvent.get(c.id);
        if (!existing || (c.score || 0) > existing.score) {
          bestEvent.set(c.id, { eventIdx: i, score: c.score || 0 });
        }
      });
    });
    alerts = alerts.map((ev, i) => ({
      ...ev,
      topContacts: (ev.topContacts || []).filter(c => (bestEvent.get(c.id) || {}).eventIdx === i)
    }));

    // ── Collect all unique contact IDs for outcome enrichment ─────────────────
    const contactIds = [];
    const seen = new Set();
    for (const alert of alerts) {
      for (const c of (alert.topContacts || [])) {
        if (c.id && !seen.has(String(c.id))) {
          contactIds.push(String(c.id));
          seen.add(String(c.id));
        }
      }
    }

    // Build outcome map: most recent call_log entry per contact
    const outcomeMap = {};
    if (contactIds.length > 0) {
      const safeIds = contactIds.slice(0, 500);
      const placeholders = safeIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT contact_id, outcome, called_at FROM call_log
         WHERE contact_id IN (${placeholders})
         ORDER BY called_at DESC`
      ).all(...safeIds);
      for (const row of rows) {
        if (!outcomeMap[row.contact_id]) outcomeMap[row.contact_id] = { outcome: row.outcome, called_at: row.called_at };
      }
    }

    // Watching flags for listing contacts (Bell icon state)
    const listingAddrs = alerts.filter(a => a.type === 'listing').map(a => normalizeAddrForDedup(a.address));
    const watchingSet = new Set();
    if (listingAddrs.length > 0) {
      const ph = listingAddrs.map(() => '?').join(',');
      db.prepare(`SELECT contact_id, address FROM listing_watchers WHERE address IN (${ph})`)
        .all(...listingAddrs)
        .forEach(r => watchingSet.add(`${r.contact_id}|${r.address}`));
    }

    // Watcher call-back list for sold events
    const soldAddrs = alerts.filter(a => a.type === 'sold').map(a => normalizeAddrForDedup(a.address));
    const soldWatchersMap = new Map();
    if (soldAddrs.length > 0) {
      const ph = soldAddrs.map(() => '?').join(',');
      db.prepare(`
        SELECT lw.contact_id, lw.address AS norm_addr, lw.added_at,
               c.name, c.mobile, c.address AS contact_address
        FROM listing_watchers lw
        LEFT JOIN contacts c ON c.id = lw.contact_id
        WHERE lw.address IN (${ph})
      `).all(...soldAddrs).forEach(r => {
        if (!soldWatchersMap.has(r.norm_addr)) soldWatchersMap.set(r.norm_addr, []);
        soldWatchersMap.get(r.norm_addr).push({
          id: r.contact_id, name: r.name || r.contact_id,
          mobile: r.mobile || '', address: r.contact_address || '',
          watchedAt: r.added_at, isWatcher: true,
          outcome:   (outcomeMap[r.contact_id] || {}).outcome   || null,
          called_at: (outcomeMap[r.contact_id] || {}).called_at || null,
        });
      });
    }

    // Inject outcome + watcher data into each alert
    const enriched = alerts.map(alert => {
      const normAddr = normalizeAddrForDedup(alert.address);
      const watcherIds = new Set((soldWatchersMap.get(normAddr) || []).map(w => w.id));
      const enrichedContacts = (alert.topContacts || [])
        .filter(c => !watcherIds.has(c.id))   // don't duplicate watcher in topContacts
        .map(c => ({
          ...c,
          outcome:    c.id ? ((outcomeMap[String(c.id)] || {}).outcome    || null) : null,
          called_at:  c.id ? ((outcomeMap[String(c.id)] || {}).called_at  || null) : null,
          watching: alert.type === 'listing' && c.id
                      ? watchingSet.has(`${c.id}|${normAddr}`) : undefined,
        }));
      return {
        ...alert,
        topContacts: enrichedContacts,
        watchers: alert.type === 'sold' ? (soldWatchersMap.get(normAddr) || []) : undefined,
      };
    });

    res.json([...enriched].reverse());
  } catch (e) {
    console.error('[GET /api/alerts]', e.message);
    res.json([]);
  }
});

// DELETE /api/alerts — remove a single alert entry by address (requires auth)
app.delete('/api/alerts', requireAuth, (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!fs.existsSync(ALERTS_FILE)) return res.json({ success: true, remaining: 0 });
    let alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    const before = alerts.length;
    alerts = alerts.filter(a => (a.address || '').trim().toLowerCase() !== address.trim().toLowerCase());
    if (alerts.length === before) return res.status(404).json({ error: 'address not found' });
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    res.json({ success: true, remaining: alerts.length });
  } catch (e) {
    console.error('[DELETE /api/alerts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Snapshot download (preserved — moved from GET/POST / to GET/POST /snapshot) ──
function snapshotLoginPage(error = false) {
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;padding:20px">
  <h2>🤖 Jarvis Snapshot Server</h2>
  <p style="color:#666">Download the latest version of all key Jarvis scripts</p>
  ${error ? '<p style="color:#dc2626;font-size:14px">Incorrect password. Please try again.</p>' : ''}
  <form method="POST" action="/snapshot">
    <input name="key" type="password" placeholder="Password" autofocus
      style="padding:12px;font-size:16px;width:100%;box-sizing:border-box;border:1px solid ${error ? '#dc2626' : '#ccc'};border-radius:6px">
    <br><br>
    <button type="submit"
      style="padding:12px 24px;font-size:16px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;width:100%">
      📥 Generate &amp; Download Snapshot
    </button>
  </form>
</body>
</html>`;
}

const SNAPSHOT_FILES = [
  '/root/.openclaw/snapshot-server.js',
  '/root/.openclaw/workspace/daily-planner.js',
  '/root/.openclaw/skills/agentbox-willoughby/monitor-email.js',
  '/root/.openclaw/skills/agentbox-willoughby/get-contacts.js',
  '/root/.openclaw/skills/agentbox-willoughby/geo-utils.js',
  '/root/.openclaw/skills/agentbox-willoughby/data-merger.js',
  '/root/.openclaw/workspace/enrich-contacts.js',
  '/root/.openclaw/workspace/willoughby-contacts-schema.json',
  '/root/.openclaw/cron/jobs.json',
  '/root/.openclaw/workspace/AGENTS.md',
];

function generateSnapshot() {
  const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  let content = `# Jarvis System Snapshot\n**Generated:** ${timestamp} AEDT\n\n`;
  content += `This file is auto-generated from the live VPS. Always reflects current file versions.\n\n---\n\n`;
  content += `## Files Included\n\n`;
  for (const filePath of SNAPSHOT_FILES) {
    const filename = path.basename(filePath);
    const exists   = fs.existsSync(filePath);
    const size     = exists ? `${(fs.statSync(filePath).size / 1024).toFixed(1)}KB` : 'MISSING';
    content += `- \`${filename}\` — ${size}\n`;
  }
  content += `\n---\n\n`;
  for (const filePath of SNAPSHOT_FILES) {
    const filename = path.basename(filePath);
    const ext      = path.extname(filePath).replace('.', '');
    const lang     = ext === 'js' ? 'javascript' : ext === 'json' ? 'json' : 'markdown';
    content += `## ${filename}\n*Path: ${filePath}*\n\n`;
    let fileContent;
    try {
      fileContent = fs.existsSync(filePath)
        ? `\`\`\`${lang}\n${fs.readFileSync(filePath, 'utf8')}\n\`\`\`\n\n`
        : `> ⚠️ FILE NOT FOUND AT THIS PATH\n\n`;
    } catch (e) {
      fileContent = `> ⚠️ ERROR READING FILE: ${e.message}\n\n`;
    }
    content += fileContent;
    content += `---\n\n`;
  }
  return content;
}

app.get('/snapshot', (req, res) => {
  res.type('html').send(snapshotLoginPage());
});

app.post('/snapshot', (req, res) => {
  const pass = req.body?.key || '';
  if (pass !== DASHBOARD_PASSWORD) {
    return res.status(401).type('html').send(snapshotLoginPage(true));
  }
  console.log(`[${new Date().toISOString()}] Snapshot downloaded`);
  const filename = `JARVIS_SNAPSHOT_${new Date().toISOString().slice(0, 10)}.md`;
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(generateSnapshot());
});

// ─── DB-backed API routes ──────────────────────────────────────────────────────

// GET /api/plan/today — reads from persistent call_queue
app.get('/api/plan/today', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        cq.*,
        cq.last_outcome   AS outcome,
        cq.last_called_at AS called_at,
        c.name, c.mobile, c.address, c.suburb,
        c.propensity_score AS contact_score,
        c.tenure_years, c.occupancy AS contact_occupancy,
        c.beds, c.baths, c.cars, c.property_type AS contact_property_type,
        c.contact_class, c.pricefinder_estimate, c.pricefinder_fetched_at,
        COALESCE((
          SELECT 1 FROM market_events me
          WHERE me.detected_at >= datetime('now', '-30 days')
            AND me.top_contacts IS NOT NULL
            AND (me.top_contacts LIKE '%"id":"' || cq.contact_id || '"%'
              OR me.top_contacts LIKE '%"id": "' || cq.contact_id || '"%')
          LIMIT 1
        ), 0) AS market_boost,
        CAST((julianday('now') - julianday(COALESCE(cq.last_called_at, cq.added_at))) AS INTEGER)
          AS days_since_last_call
      FROM call_queue cq
      LEFT JOIN contacts c ON c.id = cq.contact_id
      WHERE (cq.status = 'active')
         OR (cq.status = 'snoozed' AND cq.snooze_until <= datetime('now','localtime'))
      ORDER BY
        market_boost DESC,
        cq.propensity_score DESC,
        days_since_last_call DESC,
        cq.added_at ASC
      LIMIT 30
    `).all();
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/plan/today]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/plan/topup?n=10 — score & add N more contacts to the persistent call_queue
app.post('/api/plan/topup', requireAuth, (req, res) => {
  try {
    loadCache();
    const n = Math.min(Math.max(parseInt(req.query.n) || 10, 1), 30);

    // Contacts already in queue (active, snoozed, or done-with-cooldown)
    const inQueue = new Set(
      db.prepare(`
        SELECT contact_id FROM call_queue
        WHERE status IN ('active','snoozed')
           OR (status = 'done' AND (cooldown_until IS NULL OR cooldown_until > datetime('now','localtime')))
      `).all().map(r => r.contact_id)
    );

    // Score all eligible contacts (not already in queue with active lock)
    const scored = [];
    for (const [id, contact] of _contactsMap) {
      if (inQueue.has(id)) continue;
      const street  = (contact.address || '').toUpperCase().trim();
      const suburb  = normalizeSuburb(contact.suburb || '');
      const rpKey   = `${street} ${suburb}`.trim();
      const rpEntry = rpKey ? _rpMap?.get(rpKey) : null;
      const score   = calcScore(contact, rpEntry);
      if (score > 0) scored.push({ id, contact, rpEntry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const topN = scored.slice(0, n);

    const upsertContact = db.prepare(`
      INSERT INTO contacts (id, name, mobile, address, suburb, propensity_score, created_at, updated_at)
      VALUES (@id, @name, @mobile, @address, @suburb, @score, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        propensity_score = excluded.propensity_score,
        updated_at       = datetime('now')
    `);
    const upsertQueue = db.prepare(`
      INSERT INTO call_queue
        (contact_id, status, propensity_score, intel, angle, tenure, property_type,
         occupancy, added_at, updated_at)
      VALUES (?, 'active', ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
      ON CONFLICT(contact_id) DO UPDATE SET
        status           = 'active',
        propensity_score = excluded.propensity_score,
        intel            = excluded.intel,
        angle            = excluded.angle,
        tenure           = excluded.tenure,
        property_type    = excluded.property_type,
        occupancy        = excluded.occupancy,
        snooze_until     = NULL,
        cooldown_until   = NULL,
        updated_at       = datetime('now','localtime')
    `);

    let added = 0;
    for (const { id, contact, rpEntry, score } of topN) {
      const saleDate    = rpEntry?.['Sale Date'] || '';
      const saleYearM   = saleDate.match(/\d{4}/);
      const tenureYears = saleYearM ? new Date().getFullYear() - parseInt(saleYearM[0]) : null;
      const tenure      = tenureYears !== null ? `${tenureYears} years` : 'Unknown';

      upsertContact.run({
        id, score,
        name:    contact.name    || 'Unknown',
        mobile:  contact.mobile  || '',
        address: contact.address || '',
        suburb:  contact.suburb  || '',
      });

      const r = upsertQueue.run(
        id, score,
        buildIntel(contact, rpEntry),
        buildAngle(contact, rpEntry),
        tenure,
        rpEntry?.['Property Type'] || contact.propertyType || '',
        rpEntry?.['Owner Type']    || contact.occupancy    || ''
      );
      if (r.changes) added++;
    }

    console.log(`[POST /api/plan/topup] Added/re-activated ${added} contacts in call_queue.`);
    res.json({ ok: true, added, requested: n });
  } catch (e) {
    console.error('[POST /api/plan/topup]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue/reactivate-cooldowns — flip expired 'done' entries back to 'active'
app.post('/api/queue/reactivate-cooldowns', requireAuth, (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE call_queue
      SET status         = 'active',
          cooldown_until = NULL,
          snooze_until   = NULL,
          updated_at     = datetime('now','localtime')
      WHERE status = 'done'
        AND cooldown_until IS NOT NULL
        AND cooldown_until <= datetime('now','localtime')
    `).run();
    console.log(`[POST /api/queue/reactivate-cooldowns] Reactivated ${result.changes} contacts.`);
    res.json({ ok: true, reactivated: result.changes });
  } catch (e) {
    console.error('[POST /api/queue/reactivate-cooldowns]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/plan/:contactId/outcome
app.patch('/api/plan/:contactId/outcome', requireAuth, (req, res) => {
  try {
    const { contactId } = req.params;
    const { outcome, notes } = req.body;

    // Compute queue state from outcome
    const plusDays = (d) => {
      const dt = new Date();
      dt.setDate(dt.getDate() + d);
      // Format as SQLite localtime string
      const pad = n => String(n).padStart(2, '0');
      return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    };

    let queueStatus, snoozeUntil = null, cooldownUntil = null;
    if (outcome === 'left_message') {
      queueStatus  = 'snoozed';
      snoozeUntil  = plusDays(3);
    } else if (outcome === 'no_answer') {
      queueStatus  = 'snoozed';
      snoozeUntil  = plusDays(2);
    } else {
      queueStatus  = 'done';
      if (outcome === 'connected' || outcome === 'not_interested') {
        cooldownUntil = plusDays(120);
      }
    }

    const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    const stmtEnsureQueue = db.prepare(`
      INSERT OR IGNORE INTO call_queue (contact_id, status, added_at, updated_at)
      VALUES (?, 'active', datetime('now','localtime'), datetime('now','localtime'))
    `);
    const stmtUpdateQueue = db.prepare(`
      UPDATE call_queue
      SET status         = ?,
          last_outcome   = ?,
          last_called_at = datetime('now','localtime'),
          snooze_until   = ?,
          cooldown_until = ?,
          updated_at     = datetime('now','localtime')
      WHERE contact_id = ?
    `);
    const stmtCallLog = db.prepare(`
      INSERT INTO call_log (contact_id, called_at, outcome, notes)
      VALUES (?, datetime('now', 'localtime'), ?, ?)
    `);
    const stmtPlanInsert = db.prepare(`
      INSERT OR IGNORE INTO daily_plans (plan_date, contact_id, source, created_at)
      VALUES (?, ?, 'queue', datetime('now','localtime'))
    `);
    const stmtPlanUpdate = db.prepare(`
      UPDATE daily_plans
      SET called_at = datetime('now','localtime'), outcome = ?, notes = ?
      WHERE plan_date = ? AND contact_id = ?
    `);

    db.transaction(() => {
      stmtEnsureQueue.run(contactId);
      stmtUpdateQueue.run(queueStatus, outcome, snoozeUntil, cooldownUntil, contactId);
      stmtCallLog.run(contactId, outcome, notes);
      stmtPlanInsert.run(planDate, contactId);
      stmtPlanUpdate.run(outcome, notes, planDate, contactId);
    })();

    res.json({ ok: true, queueStatus, snoozeUntil, cooldownUntil });
  } catch (e) {
    console.error('[PATCH /api/plan/:contactId/outcome]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reminders/parse-nl — natural language → structured reminder data via Haiku
app.post('/api/reminders/parse-nl', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    const todayStr = new Date().toLocaleString('en-AU', {
      weekday: 'long', day: '2-digit', month: 'short',
      year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Australia/Sydney',
    });

    const systemPrompt = `You are a real estate agent's scheduling assistant. Parse the user's natural language input into a structured reminder or task.

Today is ${todayStr}.

Return ONLY a JSON object — no markdown, no explanation, no code fences:
{
  "contact_name": string | null,
  "contact_mobile": string | null,
  "fire_at": "YYYY-MM-DDTHH:mm" | null,
  "note": string,
  "ical_title": string,
  "priority": "high" | "normal" | "low",
  "is_task": boolean
}

Rules:
- is_task = true only when no specific date/time is mentioned; in that case fire_at = null
- Resolve relative dates relative to today. If a date is mentioned but no time, default to 09:00.
- "next [weekday]" means the next occurrence of that weekday strictly after today.
- note: clean, concise, actionable. E.g. "Follow up re appraisal booking" not "remind me to..."
- ical_title: if contact present use "Call: {contact_name} — {brief action}"; otherwise "Reminder: {brief action}". Maximum 50 chars.
- priority: "high" if input contains urgent/ASAP/important/!! — "low" if someday/eventually/no rush — otherwise "normal"
- contact_mobile: only if a phone number is explicitly stated in the input, otherwise null`;

    const apiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: text.trim() }],
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 15000,
      }
    );

    const raw   = apiRes.data.content[0].text.trim();
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (_) {
      console.warn('[parse-nl] Haiku returned non-JSON:', raw.slice(0, 200));
      return res.status(422).json({ error: 'Could not parse AI response — try rephrasing' });
    }

    // Sanitise output
    const result = {
      contact_name:   (parsed.contact_name  || '').trim() || 'Manual Task',
      contact_mobile: (parsed.contact_mobile || '').trim() || null,
      fire_at:        parsed.fire_at   || null,
      note:           parsed.note      || text.trim(),
      ical_title:     parsed.ical_title || parsed.note || text.trim(),
      priority:       ['high', 'normal', 'low'].includes(parsed.priority) ? parsed.priority : 'normal',
      is_task:        !!parsed.is_task,
    };

    // Fuzzy contact match — word overlap on name, threshold 50%
    if (result.contact_name && result.contact_name !== 'Manual Task') {
      const norm  = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const words = s => norm(s).split(/\s+/).filter(w => w.length > 1);
      const contacts = db.prepare(
        'SELECT id, name, mobile FROM contacts WHERE name IS NOT NULL ORDER BY name LIMIT 10000'
      ).all();
      let bestId = null, bestScore = 0, bestMobile = null;
      for (const c of contacts) {
        const cw    = new Set(words(c.name));
        const qw    = words(result.contact_name);
        if (!cw.size || !qw.length) continue;
        const shared = qw.filter(w => cw.has(w)).length;
        const score  = shared / Math.max(cw.size, qw.length);
        if (score > bestScore) { bestScore = score; bestId = c.id; bestMobile = c.mobile; }
      }
      if (bestScore >= 0.5) {
        result.contact_id     = bestId;
        result.contact_mobile = result.contact_mobile || bestMobile || null;
      }
    }

    res.json(result);
  } catch (e) {
    console.error('[POST /api/reminders/parse-nl]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reminders
app.post('/api/reminders', requireAuth, async (req, res) => {
  try {
    const { contact_id, contact_name, contact_mobile, note, fire_at, duration_minutes, is_task, priority, ical_title } = req.body;
    const isTask = is_task ? 1 : 0;
    if (!contact_name || !note) return res.status(400).json({ error: 'contact_name and note are required' });
    if (!isTask && !fire_at) return res.status(400).json({ error: 'fire_at required for reminders (use is_task=true for tasks)' });
    const dur = duration_minutes ? parseInt(duration_minutes, 10) : 30;
    const r = db.prepare(`
      INSERT INTO reminders (contact_id, contact_name, contact_mobile, note, fire_at, duration_minutes, is_task, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contact_id || null, contact_name, contact_mobile || null, note, fire_at || null, dur, isTask, priority || 'normal');

    // iCloud CalDAV sync — skip for tasks or when no fire_at
    if (!isTask && fire_at) {
      createCalendarEvent({
        contact_name:     contact_name || 'Unknown',
        contact_mobile:   contact_mobile || null,
        contact_address:  null,
        note:             note || '',
        fire_at,
        duration_minutes: dur,
        ical_title:       ical_title || null,
      }).then(uid => {
        if (uid) {
          db.prepare('UPDATE reminders SET calendar_event_uid = ? WHERE id = ?').run(uid, r.lastInsertRowid);
        }
      }).catch(calErr => {
        console.warn('[reminders] iCal sync failed:', calErr.message);
      });
    }

    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    console.error('[POST /api/reminders]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reminders/upcoming
app.get('/api/reminders/upcoming', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM reminders
      WHERE sent = 0 AND completed_at IS NULL
      ORDER BY
        CASE WHEN fire_at IS NULL THEN 1 ELSE 0 END,
        fire_at ASC
      LIMIT 100
    `).all();
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/reminders/upcoming]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reminders/:id/complete
app.post('/api/reminders/:id/complete', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const result = db.prepare(
      "UPDATE reminders SET completed_at = datetime('now','localtime') WHERE id = ? AND completed_at IS NULL"
    ).run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'not found or already completed' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/reminders/:id/complete]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/reminders/:id
app.patch('/api/reminders/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    // Pre-fetch to get existence + guard state
    const existing = db.prepare('SELECT id, sent, completed_at FROM reminders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    if (existing.completed_at) return res.status(409).json({ error: 'cannot edit a completed reminder' });
    // Validate: a non-task reminder must have a fire_at date
    const finalIsTask = req.body.is_task !== undefined ? Number(req.body.is_task) : existing.is_task;
    const finalFireAt = 'fire_at' in req.body ? req.body.fire_at : existing.fire_at;
    if (finalIsTask === 0 && !finalFireAt) {
      return res.status(400).json({ error: 'A reminder (non-task) must have a fire_at date.' });
    }
    const ALLOWED = ['note', 'fire_at', 'contact_name', 'contact_mobile', 'is_task', 'priority', 'duration_minutes'];
    const sets = [], vals = [];
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(req.body[key] === '' ? null : req.body[key]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no valid fields to update' });
    vals.push(id);
    db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    res.json({ ok: true, reminder });
  } catch (e) {
    console.error('[PATCH /api/reminders/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reminders/:id
app.delete('/api/reminders/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT calendar_event_uid FROM reminders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    if (existing.calendar_event_uid) {
      console.warn(`[reminders] DELETE id=${id} — orphaned iCal event: ${existing.calendar_event_uid}`);
    }
    db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/reminders/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market
app.get('/api/market', requireAuth, (req, res) => {
  try {
    const days              = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 365);
    const includeHistorical = req.query.include_historical === '1' || req.query.include_historical === 'true';
    const VALID_STATUSES    = ['all', 'active', 'sold', 'withdrawn'];
    const statusFilter      = VALID_STATUSES.includes(req.query.status) ? req.query.status : 'all';

    let statusWhere = '';
    const statusParams = [];
    if (statusFilter !== 'all') {
      statusWhere = `AND COALESCE(status, CASE WHEN type='sold' THEN 'sold' WHEN type='unlisted' THEN 'withdrawn' ELSE 'active' END) = ?`;
      statusParams.push(statusFilter);
    }

    const VALID_PROPERTY_TYPES = ['house', 'unit', 'townhouse', 'all'];
    const propertyTypeParam   = (req.query.property_type || '').toLowerCase();
    const propertyTypeFilter  = VALID_PROPERTY_TYPES.includes(propertyTypeParam) ? propertyTypeParam : 'all';
    const propertyTypeWhere   = propertyTypeFilter !== 'all'
      ? `AND LOWER(COALESCE(property_type, '')) LIKE ?`
      : '';

    const VALID_SORTS = ['newest', 'oldest', 'price_high', 'price_low'];
    const sortParam   = VALID_SORTS.includes(req.query.sort) ? req.query.sort : 'newest';
    const orderBy     = {
      newest:     'ORDER BY detected_at DESC',
      oldest:     'ORDER BY detected_at ASC',
      price_high: "ORDER BY CAST(REPLACE(REPLACE(COALESCE(confirmed_price, price, ''), '$', ''), ',', '') AS INTEGER) DESC",
      price_low:  "ORDER BY CAST(REPLACE(REPLACE(COALESCE(confirmed_price, price, ''), '$', ''), ',', '') AS INTEGER) ASC",
    }[sortParam];

    const liveParams = [String(days), ...statusParams];
    if (propertyTypeFilter !== 'all') liveParams.push(`%${propertyTypeFilter}%`);

    const liveRows = db.prepare(`
      SELECT *, 'market_event' AS record_source FROM market_events
      WHERE detected_at >= datetime('now', '-' || ? || ' days')
      ${statusWhere}
      ${propertyTypeWhere}
      ${orderBy} LIMIT 200
    `).all(...liveParams);

    // Build pf_estimate lookup map from properties table (normalise street type abbreviations)
    const normForPf = (addr) => (addr || '').toUpperCase()
      .replace(/\bAVENUE\b/g, 'AVE').replace(/\bSTREET\b/g, 'ST')
      .replace(/\bROAD\b/g, 'RD').replace(/\bDRIVE\b/g, 'DR')
      .replace(/\bLANE\b/g, 'LN').replace(/\bPLACE\b/g, 'PL')
      .replace(/\bCLOSE\b/g, 'CL').replace(/\bCRESCENT\b/g, 'CRES')
      .replace(/\bCOURT\b/g, 'CT').replace(/\bPARADE\b/g, 'PDE')
      .replace(/\bTERRACE\b/g, 'TCE').replace(/\s+/g, ' ').trim();
    const pfProps = db.prepare(
      "SELECT address, valuation_amount FROM properties WHERE valuation_amount IS NOT NULL AND valuation_amount != ''"
    ).all();
    const pfMap = new Map(pfProps.map(p => [normForPf(p.address), p.valuation_amount]));
    const addPfEstimate = rows => rows.map(r => ({
      ...r,
      pf_estimate: r.proping_estimate || pfMap.get(normForPf(r.address)) || null
    }));

    if (!includeHistorical) {
      return res.json(addPfEstimate(liveRows));
    }

    // Merge with historical_sales for the same date window
    const histRows = db.prepare(`
      SELECT
        NULL AS id,
        datetime(sale_date) AS detected_at,
        sale_date           AS event_date,
        'sold'              AS type,
        address,
        suburb,
        sale_price          AS price,
        NULL                AS price_previous,
        0                   AS price_withheld,
        NULL                AS proping_estimate,
        NULL                AS estimate_delta,
        days_on_market,
        beds,
        baths,
        cars,
        property_type,
        agent_name,
        agency,
        'pricefinder_import' AS source,
        0                   AS is_rental,
        NULL                AS top_contacts,
        created_at,
        'historical_sale'   AS record_source
      FROM historical_sales
      WHERE sale_date >= date('now', '-' || ? || ' days')
      ORDER BY sale_date DESC LIMIT 200
    `).all(String(days));

    // Merge and sort by detected_at desc, de-duplicate by normalised address
    const seen = new Set(liveRows.map(r => normForPf(r.address)));
    const merged = [...liveRows];
    for (const h of histRows) {
      if (!seen.has(normForPf(h.address))) {
        merged.push(h);
        seen.add(normForPf(h.address));
      }
    }
    const parsePrice = (r) => {
      const raw = (r.confirmed_price || r.price || '').toString().replace(/[$,]/g, '');
      return parseInt(raw, 10) || 0;
    };
    merged.sort((a, b) => {
      if (sortParam === 'oldest') {
        const ta = new Date(a.detected_at || a.event_date || 0).getTime();
        const tb = new Date(b.detected_at || b.event_date || 0).getTime();
        return ta - tb;
      }
      if (sortParam === 'price_high') return parsePrice(b) - parsePrice(a);
      if (sortParam === 'price_low')  return parsePrice(a) - parsePrice(b);
      // default: newest
      const ta = new Date(a.detected_at || a.event_date || 0).getTime();
      const tb = new Date(b.detected_at || b.event_date || 0).getTime();
      return tb - ta;
    });

    res.json(addPfEstimate(merged.slice(0, 200)));
  } catch (e) {
    console.error('[GET /api/market]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/history — call log (today by default; ?days=N for wider range up to 90)
app.get('/api/history', requireAuth, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 1, 1), 90);
    const rows = db.prepare(`
      SELECT cl.id, cl.contact_id, cl.called_at, cl.outcome, cl.notes,
             c.name, c.mobile, c.address, c.suburb, c.propensity_score
      FROM call_log cl
      LEFT JOIN contacts c ON c.id = cl.contact_id
      WHERE cl.called_at >= datetime('now', 'localtime', '-' || ? || ' days')
      ORDER BY cl.called_at DESC LIMIT 200
    `).all(String(days));
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/history]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/history/:id — remove an individual call log entry
app.delete('/api/history/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const result = db.prepare('DELETE FROM call_log WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/history/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/nearby
app.get('/api/contacts/nearby', requireAuth, (req, res) => {
  try {
    const { address = '', limit = 5 } = req.query;
    // Strip the leading street number to get the street name
    const parts      = address.trim().split(/\s+/);
    const streetName = parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '';
    const rows = db.prepare(`
      SELECT * FROM contacts
      WHERE address LIKE ?
      ORDER BY propensity_score DESC
      LIMIT ?
    `).all(`%${streetName}%`, parseInt(limit));
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/contacts/nearby]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/search
app.get('/api/contacts/search', requireAuth, (req, res) => {
  try {
    const { q = '' } = req.query;
    const rows = db.prepare(`
      SELECT * FROM contacts
      WHERE name LIKE ? OR address LIKE ?
      LIMIT 10
    `).all(`%${q}%`, `%${q}%`);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/contacts/search]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/contacts — create new contact ─────────────────────────────────
app.post('/api/contacts', requireAuth, (req, res) => {
  try {
    const { name, mobile, address, suburb, beds, baths, property_type, do_not_call } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    db.prepare(`
      INSERT INTO contacts (id, name, mobile, address, suburb, beds, baths, property_type, do_not_call, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', datetime('now','localtime'), datetime('now','localtime'))
    `).run(
      id,
      name.trim(),
      (mobile || '').trim(),
      (address || '').trim(),
      (suburb || '').trim(),
      (beds || '').toString().trim(),
      (baths || '').toString().trim(),
      (property_type || '').trim(),
      do_not_call ? 1 : 0
    );

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    res.json({ ok: true, contact });
  } catch (e) {
    console.error('[POST /api/contacts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/contacts/:id — remove a contact with full cascade cleanup
app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const exists = db.prepare('SELECT id FROM contacts WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'not found' });
    db.transaction(() => {
      db.prepare('DELETE FROM call_queue WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM contact_notes WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM reminders WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM daily_plans WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM listing_watchers WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM call_log WHERE contact_id = ?').run(id);
      db.prepare('UPDATE buyer_profiles SET contact_id = NULL WHERE contact_id = ?').run(id);
      db.prepare('UPDATE properties SET contact_id = NULL WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/contacts/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:id — fetch a single contact by id
app.get('/api/contacts/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const contact = db.prepare(
      'SELECT id, name, mobile, address, suburb, do_not_call FROM contacts WHERE id = ?'
    ).get(id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ ok: true, contact });
  } catch (e) {
    console.error('[GET /api/contacts/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/contacts/:id — edit contact fields
app.patch('/api/contacts/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const ALLOWED = ['name', 'mobile', 'address', 'suburb', 'do_not_call'];
    const sets = [];
    const vals = [];
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        let val = req.body[key];
        if (key === 'do_not_call') val = (val === true || val === 1 || val === '1') ? 1 : 0;
        sets.push(`${key} = ?`);
        vals.push(val);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No valid fields provided' });
    sets.push(`updated_at = datetime('now','localtime')`);
    vals.push(id);
    const exists = db.prepare('SELECT id FROM contacts WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'Contact not found' });
    db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const updated = db.prepare(
      'SELECT id, name, mobile, address, suburb, do_not_call FROM contacts WHERE id = ?'
    ).get(id);
    res.json({ ok: true, contact: updated });
  } catch (e) {
    console.error('[PATCH /api/contacts/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:id/notes — fetch standalone notes for a contact
app.get('/api/contacts/:id/notes', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, note, created_at FROM contact_notes
      WHERE contact_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(req.params.id);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/contacts/:id/notes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/contacts/:id/notes — add a timestamped note
app.post('/api/contacts/:id/notes', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: 'note is required' });
    const result = db.prepare(
      `INSERT INTO contact_notes (contact_id, note) VALUES (?, ?)`
    ).run(id, note.trim());
    const row = db.prepare(
      'SELECT id, note, created_at FROM contact_notes WHERE id = ?'
    ).get(result.lastInsertRowid);
    res.json({ ok: true, note: row });
  } catch (e) {
    console.error('[POST /api/contacts/:id/notes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat — Jarvis AI assistant
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // ── Build live farm context from DB ──────────────────────────────────
    const recentEvents = db.prepare(`
      SELECT type, address, price, confirmed_price, status, beds, property_type,
             agent_name, event_date, days_on_market
      FROM market_events
      WHERE detected_at >= datetime('now', '-30 days')
      ORDER BY detected_at DESC LIMIT 20
    `).all();

    const farmStats = db.prepare(`
      SELECT
        COUNT(*) AS total_contacts,
        SUM(CASE WHEN propensity_score >= 45 THEN 1 ELSE 0 END) AS prime_contacts,
        SUM(CASE WHEN propensity_score >= 20 AND propensity_score < 45 THEN 1 ELSE 0 END) AS warm_contacts
      FROM contacts
    `).get();

    const recentSolds = db.prepare(`
      SELECT address, COALESCE(confirmed_price, price) AS sale_price, beds, property_type, days_on_market, event_date
      FROM market_events WHERE type = 'sold'
      ORDER BY detected_at DESC LIMIT 10
    `).all();

    const eventsText = recentEvents.map(e =>
      `- ${(e.type || '').toUpperCase()}: ${e.address} | ${e.beds ? e.beds + 'bd ' : ''}${e.property_type || ''} | Price: ${e.confirmed_price || e.price || 'not disclosed'} | Status: ${e.status || 'active'} | Date: ${e.event_date || 'recent'}`
    ).join('\n') || 'None';

    const soldsText = recentSolds.map(e =>
      `- ${e.address}: ${e.sale_price || 'price withheld'} | ${e.beds ? e.beds + 'bd ' : ''}${e.property_type || ''} | DOM: ${e.days_on_market || '?'}`
    ).join('\n') || 'None';

    const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const systemPrompt = `You are Jarvis, an AI assistant for Bailey O'Byrne, a real estate agent at McGrath Willoughby in Sydney's lower north shore. Today is ${today}.

FARM AREA: Willoughby, North Willoughby, Willoughby East, Castlecrag, Middle Cove, Naremburn, Chatswood, Artarmon.

DATABASE STATS:
- Total contacts: ${farmStats?.total_contacts || 0}
- Prime (score \u226545): ${farmStats?.prime_contacts || 0}
- Warm (score 20-44): ${farmStats?.warm_contacts || 0}

RECENT MARKET ACTIVITY (last 30 days):
${eventsText}

RECENT SOLD RESULTS:
${soldsText}

CAPABILITIES:
- Answer questions about market conditions, comparable sales, property values
- Suggest talking points for prospecting calls near recent sales/listings
- To update a sale price, include UPDATE_PRICE:{event_id}:{price} on its own line
- Help analyse which contacts to prioritise

Be concise, direct, and use your knowledge of the Willoughby property market. Use Australian English. Prices in AUD. When unsure, say so.`;

    const apiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system:     systemPrompt,
        messages:   messages.map(m => ({ role: m.role, content: m.content })),
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 30000,
      }
    );

    let reply = apiRes.data.content[0].text;

    // ── Handle inline tool call: UPDATE_PRICE:{id}:{price} ───────────────
    const updateMatch = reply.match(/UPDATE_PRICE:(\d+):([^\n]+)/);
    if (updateMatch) {
      const eventId  = parseInt(updateMatch[1]);
      const newPrice = updateMatch[2].trim();
      const existing = db.prepare('SELECT id FROM market_events WHERE id = ?').get(eventId);
      if (existing) {
        db.prepare('UPDATE market_events SET confirmed_price = ?, status = ? WHERE id = ?')
          .run(newPrice, 'sold', eventId);
        reply = reply.replace(/UPDATE_PRICE:\d+:[^\n]+\n?/, '').trim();
        return res.json({ reply, action: { type: 'price_updated', event_id: eventId, price: newPrice } });
      }
    }

    res.json({ reply });
  } catch (e) {
    console.error('[POST /api/chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/buyers
app.post('/api/buyers', requireAuth, (req, res) => {
  try {
    const { listing_address, buyer_name, buyer_mobile, buyer_email,
            enquiry_type, enquiry_date, notes } = req.body;
    db.prepare(`
      INSERT INTO buyers
        (listing_address, buyer_name, buyer_mobile, buyer_email, enquiry_type, enquiry_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(listing_address, buyer_name, buyer_mobile, buyer_email,
           enquiry_type, enquiry_date, notes);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/buyers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/buyers
app.get('/api/buyers', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM buyers ORDER BY enquiry_date DESC`).all();
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/buyers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/buyers/calllist — active buyers not yet done, grouped by listing or type
// Query params: ?sort=newest|oldest (default: newest), ?group=listing|type (default: listing)
app.get('/api/buyers/calllist', requireAuth, (req, res) => {
  try {
    const sort  = req.query.sort  === 'oldest' ? 'oldest' : 'newest';
    const group = req.query.group === 'type'   ? 'type'   : 'listing';
    const sortDir = sort === 'newest' ? 'DESC' : 'ASC';

    const rows = db.prepare(`
      SELECT b.*,
        ld.address as ld_address, ld.suburb, ld.beds, ld.baths, ld.cars,
        ld.land_area, ld.building_area, ld.category, ld.price_guide, ld.method,
        ld.auction_date, ld.headline, ld.description, ld.features,
        ld.council_rates, ld.water_rates, ld.strata_admin, ld.strata_sinking,
        ld.strata_total, ld.web_link, ld.listing_status as ld_listing_status, ld.faqs,
        ld.agentbox_id as ld_agentbox_id
      FROM buyers b
      LEFT JOIN listing_details ld ON ld.agentbox_id = b.listing_agentbox_id
      WHERE (b.done_date IS NULL OR b.done_date = '')
        AND (b.status IS NULL OR b.status = 'active')
      ORDER BY b.enquiry_date ${sortDir}
    `).all();

    const active   = {};
    const archived = {};

    if (group === 'listing') {
      for (const b of rows) {
        const isArchived = b.ld_listing_status === 'withdrawn' || b.ld_listing_status === 'sold';
        const bucket = isArchived ? archived : active;

        // Build listing address key from listing_details if available, else fall back to buyer's field
        const addrKey = b.ld_address && b.suburb
          ? `${b.ld_address}, ${b.suburb}`
          : (b.listing_address || 'Unknown Listing');

        if (!bucket[addrKey]) {
          bucket[addrKey] = {
            listing: b.ld_agentbox_id ? {
              agentbox_id:   b.ld_agentbox_id,
              address:       b.ld_address,
              suburb:        b.suburb,
              beds:          b.beds,
              baths:         b.baths,
              cars:          b.cars,
              land_area:     b.land_area,
              building_area: b.building_area,
              category:      b.category,
              price_guide:   b.price_guide,
              method:        b.method,
              auction_date:  b.auction_date,
              headline:      b.headline,
              description:   b.description,
              features:      b.features,
              council_rates: b.council_rates,
              water_rates:   b.water_rates,
              strata_admin:  b.strata_admin,
              strata_sinking: b.strata_sinking,
              strata_total:  b.strata_total,
              web_link:      b.web_link,
              faqs:          b.faqs || '[]'
            } : null,
            buyers: []
          };
        }

        // Strip ld_* fields from the buyer row before pushing
        const { ld_address, suburb, beds, baths, cars, land_area, building_area, category,
                price_guide, method, auction_date, headline, description, features,
                council_rates, water_rates, strata_admin, strata_sinking, strata_total,
                web_link, ld_listing_status, faqs, ld_agentbox_id, ...buyerRow } = b;
        bucket[addrKey].buyers.push(buyerRow);
      }
    } else {
      // group === 'type': group by enquiry_type within active/archived
      for (const b of rows) {
        const isArchived = b.ld_listing_status === 'withdrawn' || b.ld_listing_status === 'sold';
        const bucket = isArchived ? archived : active;
        const typeKey = b.enquiry_type || 'other';

        if (!bucket[typeKey]) bucket[typeKey] = [];

        // Include listing address + listing detail fields inline on the buyer row
        const buyerWithListing = Object.assign({}, b, {
          listing_address: b.listing_address || (b.ld_address && b.suburb ? `${b.ld_address}, ${b.suburb}` : null)
        });
        bucket[typeKey].push(buyerWithListing);
      }
    }

    res.json({ sort, group, active, archived });
  } catch (e) {
    console.error('[GET /api/buyers/calllist]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/buyers/:id/outcome — log a buyer call outcome
app.patch('/api/buyers/:id/outcome', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, notes } = req.body;
    db.prepare(`
      UPDATE buyers SET called_at = datetime('now','localtime'), outcome = ?,
        notes = CASE WHEN ? IS NOT NULL THEN ? ELSE notes END,
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(outcome, notes, notes, id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[PATCH /api/buyers/:id/outcome]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/buyers/:id/done — mark buyer as done (remove from call list)
app.patch('/api/buyers/:id/done', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare(`
      UPDATE buyers SET done_date = date('now','localtime'), updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[PATCH /api/buyers/:id/done]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/buyers/sync — spawn fetch-buyer-enquiries.js in background
const buyerSync = { running: false, startedAt: null, log: [], exitCode: null };
app.post('/api/buyers/sync', requireAuth, (req, res) => {
  if (buyerSync.running) {
    return res.json({ ok: false, message: 'Sync already running', state: buyerSync });
  }
  buyerSync.running  = true;
  buyerSync.startedAt = new Date().toISOString();
  buyerSync.log      = [];
  buyerSync.exitCode = null;

  const child = spawn(
    'node',
    ['fetch-buyer-enquiries.js'],
    { cwd: '/root/.openclaw/skills/agentbox-willoughby', env: process.env }
  );
  child.stdout.on('data', d => buyerSync.log.push(d.toString().trimEnd()));
  child.stderr.on('data', d => buyerSync.log.push('ERR: ' + d.toString().trimEnd()));
  child.on('close', code => {
    buyerSync.running  = false;
    buyerSync.exitCode = code;
    console.log(`[buyers/sync] exited with code ${code}`);
  });

  res.json({ ok: true, message: 'Sync started', startedAt: buyerSync.startedAt });
});

// GET /api/buyers/sync/status
app.get('/api/buyers/sync/status', requireAuth, (req, res) => {
  res.json(buyerSync);
});

// GET /api/listing-details — all listing details for display
app.get('/api/listing-details', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM listing_details ORDER BY listing_status ASC, address ASC').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/listing-details/:agentboxId — update FAQs (manual entry only)
app.put('/api/listing-details/:agentboxId', requireAuth, (req, res) => {
  try {
    const { agentboxId } = req.params;
    const { faqs } = req.body;
    db.prepare(`
      UPDATE listing_details SET faqs = ?, updated_at = datetime('now','localtime') WHERE agentbox_id = ?
    `).run(faqs != null ? JSON.stringify(faqs) : '[]', agentboxId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/intel/upload
app.post('/api/intel/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { originalname, mimetype } = req.file;
    db.prepare(`
      INSERT INTO intel_docs (filename, file_type, uploaded_at)
      VALUES (?, ?, datetime('now', 'localtime'))
    `).run(originalname, mimetype);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/intel/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/contacts/:id/pricefinder — called by local pricefinder-estimates-local.js
app.patch('/api/contacts/:id/pricefinder', requireAuth, (req, res) => {
  try {
    const { id }       = req.params;
    const { estimate } = req.body;
    if (!estimate) return res.status(400).json({ error: 'estimate required' });
    db.prepare(`
      UPDATE contacts
      SET pricefinder_estimate = ?, pricefinder_fetched_at = datetime('now','localtime')
      WHERE id = ?
    `).run(estimate, id);
    res.json({ ok: true, id, estimate });
  } catch (e) {
    console.error('[PATCH /api/contacts/:id/pricefinder]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Market Events helpers ────────────────────────────────────────────────────

function categorizePropertyType(type) {
  if (!type) return 'Unknown';
  const t = type.toLowerCase();
  if (/house|semi|terrace|townhouse/i.test(t)) return 'House';
  if (/unit|apartment|flat|studio/i.test(t)) return 'Unit';
  return 'Other';
}

/**
 * Build scored proximity contacts for a manual market event.
 * Async: may geocode the event address via Nominatim if not in geo-cache.
 * Single-pass scoring: propensity + geo gradient + call bonus + comparable bonus.
 * Returns up to 30 contacts sorted by total score. No minimum padding.
 */
async function buildScoredContactsForManual(address, details, minCount = 0) {
  loadCache();
  const listingCategory = categorizePropertyType(details.propertyType || 'House');
  const listingBeds     = details.beds ? parseInt(details.beds) : null;

  // Extract street keyword from event address
  // e.g. "15A SECOND AVENUE, WILLOUGHBY EAST" → "SECOND"
  const normEventAddr   = address.toUpperCase().replace(/\s+/g, ' ').trim();
  const eventStreetPart = normEventAddr.split(',')[0].trim();
  function extractStreetKeyword(addrPart) {
    let s = addrPart
      .replace(/^[\d]+[A-Z]?\s*\/\s*[\d]+[A-Z]?\s+/, '') // unit prefix "3/89 "
      .replace(/^[\d]+[A-Z]?\s+/, '');                     // number prefix "15A "
    s = s.replace(/\s+(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|PLACE|PL|CLOSE|CL|CRESCENT|CRES|COURT|CT|PARADE|PDE|TERRACE|TCE|WAY|GROVE|GR|BOULEVARD|BLVD)(\s.*)?$/i, '').trim();
    const parts = s.split(/\s+/);
    return parts[parts.length - 1] || '';
  }
  const streetKeyword  = extractStreetKeyword(eventStreetPart);
  const eventOrdinal   = extractOrdinal(streetKeyword);

  // Extract suburb from event address
  const eventAddrParts = normEventAddr.split(',');
  const eventSuburb    = eventAddrParts.length > 1 ? eventAddrParts[eventAddrParts.length - 1].trim() : 'WILLOUGHBY';

  // Geocode the event address
  const eventGeo = await geocodeAddress(eventStreetPart, eventSuburb);

  const LOCAL_SUBURBS = new Set(['WILLOUGHBY', 'NORTH WILLOUGHBY', 'WILLOUGHBY EAST',
    'CHATSWOOD', 'ARTARMON', 'NAREMBURN', 'CASTLE COVE', 'MIDDLE COVE', 'CASTLECRAG']);

  // ── Build candidate pool ──────────────────────────────────────────────────
  // Primary: _sqlContactsMap (CRM + pricefinder contacts with phones, ~3k)
  const candidateMap = new Map();

  for (const [id, c] of (_sqlContactsMap || new Map())) {
    const cSuburb = (c.suburb || '').toUpperCase().trim();
    if (!LOCAL_SUBURBS.has(cSuburb)) continue;
    if (!c.effective_phone) continue;
    const contactAddrNorm = (c.address || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const contactStreetPart = contactAddrNorm.split(',')[0].trim();
    // Exclude vendor (exact street-part match including number)
    if (eventStreetPart && contactStreetPart && eventStreetPart === contactStreetPart) continue;
    // AgentBox priority: suppress pf_ contacts when AgentBox has a contact at the same address
    if (id.startsWith('pf_')) {
      const norm = normalizeAddrForDedup(c.address || '');
      if (norm && _agentboxAddrSet && _agentboxAddrSet.has(norm)) continue;
    }
    candidateMap.set(id, {
      id,
      name:         c.name || 'Unknown',
      address:      c.address || '',
      suburb:       c.suburb  || '',
      phone:        c.effective_phone,
      propensity:   c.propensity_score || 0,
      beds:         c.beds != null ? parseInt(c.beds) : null,
      propertyType: c.property_type || '',
    });
  }

  // Secondary: AgentBox-only contacts not already in candidateMap
  for (const [id, contact] of (_contactsMap || new Map())) {
    if (candidateMap.has(id)) continue;
    if (!contact.mobile) continue;
    const cSuburb = normalizeSuburb(contact.suburb || '');
    if (!LOCAL_SUBURBS.has(cSuburb) && !LOCAL_SUBURBS.has((contact.suburb || '').toUpperCase().trim())) continue;
    const contactAddrNorm   = (contact.address || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const contactStreetPart = contactAddrNorm.split(',')[0].trim();
    if (eventStreetPart && contactStreetPart && eventStreetPart === contactStreetPart) continue;
    const rpKey   = `${contactAddrNorm} ${cSuburb}`.trim();
    const rpEntry = _rpMap?.get(rpKey);
    candidateMap.set(id, {
      id,
      name:         contact.name || 'Unknown',
      address:      contact.address || '',
      suburb:       contact.suburb  || '',
      phone:        contact.mobile,
      propensity:   calcScore(contact, rpEntry),
      beds:         rpEntry?.['Bed'] ? parseInt(rpEntry['Bed']) : null,
      propertyType: rpEntry?.['Property Type'] || contact.propertyType || '',
    });
  }

  // ── Score each candidate ───────────────────────────────────────────────────
  const now    = Date.now();
  const scored = [];

  for (const [id, cand] of candidateMap) {
    const contactAddrNorm = (cand.address || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const contactStrPart  = contactAddrNorm.split(',')[0].trim();

    // ── geo_score ────────────────────────────────────────────────────────────
    let geoScore = 15; // same suburb floor

    const onSameStreet = streetKeyword.length >= 3 && contactAddrNorm.includes(streetKeyword);
    if (onSameStreet) {
      geoScore = 1000;
    } else {
      // Try Haversine if both are geocoded
      const contactGeo = (() => {
        const bareAddr = contactStrPart;
        if (_geoCache.has(bareAddr)) return _geoCache.get(bareAddr);
        const withSub = cand.suburb ? `${bareAddr}, ${cand.suburb}` : null;
        if (withSub && _geoCache.has(withSub)) return _geoCache.get(withSub);
        return null;
      })();

      if (eventGeo && contactGeo) {
        const dist = haversine(eventGeo.lat, eventGeo.lon, contactGeo.lat, contactGeo.lon);
        if      (dist <= 150)  geoScore = 800;
        else if (dist <= 350)  geoScore = 500;
        else if (dist <= 700)  geoScore = 250;
        else if (dist <= 1300) geoScore = 80;
        else                   geoScore = 15;
      } else if (eventOrdinal !== null) {
        // Ordinal avenue heuristic (First/Second/Third/Fourth Ave)
        const contactKeyword = extractStreetKeyword(contactStrPart);
        const contactOrdinal = extractOrdinal(contactKeyword);
        if (contactOrdinal !== null) {
          const diff = Math.abs(eventOrdinal - contactOrdinal);
          if      (diff === 1) geoScore = Math.max(geoScore, 500);
          else if (diff === 2) geoScore = Math.max(geoScore, 200);
        }
      }
    }

    // ── call_bonus ────────────────────────────────────────────────────────────
    let callBonus = 0;
    const calls   = _recentCallMap?.get(id) || [];
    for (const c of calls) {
      const ageDays = (now - new Date(c.called_at).getTime()) / 86400000;
      if (c.outcome === 'callback_requested') {
        if (ageDays < 30)  { callBonus = Math.max(callBonus, 200); break; }
        if (ageDays < 90)  { callBonus = Math.max(callBonus, 100); }
      } else {
        if (ageDays < 30)  callBonus = Math.max(callBonus, 50);
        else if (ageDays < 90) callBonus = Math.max(callBonus, 20);
      }
    }

    // ── comparable_bonus / penalty ────────────────────────────────────────────
    let comparableBonus = 0;
    if (cand.propertyType && listingCategory) {
      const candCategory = categorizePropertyType(cand.propertyType);
      if (candCategory === listingCategory) {
        comparableBonus += 40;
      } else if (candCategory !== 'Unknown' && listingCategory !== 'Unknown') {
        // Wrong property type — penalise so wrong-type contacts sort below same-type
        // Unit appearing near a House listing: strong penalty
        // House appearing near a Unit listing: lighter penalty
        comparableBonus += (candCategory === 'Unit' && listingCategory === 'House') ? -60 : -20;
      }
    }
    if (listingBeds !== null && cand.beds != null && cand.beds > 0) {
      const diff = Math.abs(listingBeds - cand.beds);
      if      (diff <= 1) comparableBonus += 25;
      else if (diff <= 2) comparableBonus += 10;
    }

    const totalScore = cand.propensity + geoScore + callBonus + comparableBonus;
    // Avoid duplicating suburb when it's already embedded in the address (pf_ contacts)
    const addrStr = (() => {
      const a = (cand.address || '').trim();
      const s = (cand.suburb  || '').trim();
      if (!s || a.toUpperCase().includes(s.toUpperCase())) return a;
      return [a, s].filter(Boolean).join(', ');
    })();
    scored.push({
      id,
      name:     cand.name,
      mobile:   cand.phone,
      address:  addrStr,
      distance: null,
      score:    totalScore,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 30);
}

// POST /api/log-call — log a call outcome for a Just Sold / Just Listed contact
app.post('/api/log-call', requireAuth, (req, res) => {
  try {
    const { contact_id, outcome, notes } = req.body;
    if (!contact_id || !outcome) {
      return res.status(400).json({ error: 'contact_id and outcome are required' });
    }
    db.prepare(`
      INSERT INTO call_log (contact_id, called_at, outcome, notes)
      VALUES (?, datetime('now', 'localtime'), ?, ?)
    `).run(contact_id, outcome, notes || null);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/log-call]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market-events/manual — manually inject a market event (dashboard + Telegram bot)
app.post('/api/market-events/manual', requireAuth, async (req, res) => {
  try {
    const { address, type, beds, baths, cars, property_type, price, suburb } = req.body;
    if (!address || !type) {
      return res.status(400).json({ error: 'address and type are required' });
    }
    // Normalise to UPPERCASE for consistency with pricefinder data in the DB
    const normAddress = address.toUpperCase().replace(/\s+/g, ' ').trim();
    const detectedSuburb = suburb
      ? suburb.toUpperCase().trim()
      : (() => {
          const parts = normAddress.split(',').map(s => s.trim());
          return parts.length > 1 ? parts[parts.length - 1] : 'WILLOUGHBY';
        })();

    // 1. Look up pricefinder estimate for this specific property
    let pfEstimate = null;
    const streetPart = normAddress.split(',')[0].trim();
    const numMatch   = streetPart.match(/^(\d+)/);
    if (numMatch) {
      const num = numMatch[1];
      const kw = streetPart
        .replace(/^[\d]+[A-Z]?\s*\/?\s*[\d]*[A-Z]?\s+/, '')
        .replace(/\s+(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|PLACE|PL|CLOSE|CL|CRESCENT|CRES|COURT|CT|PARADE|PDE|TERRACE|TCE|WAY|GROVE|GR|BOULEVARD|BLVD)(\s.*)?$/i, '')
        .split(/\s+/)[0] || '';
      if (kw.length >= 3) {
        const pfRow = db.prepare(
          "SELECT valuation_amount FROM properties WHERE UPPER(address) LIKE ? AND UPPER(address) LIKE ? AND valuation_amount IS NOT NULL LIMIT 1"
        ).get(`${num}%`, `%${kw}%`);
        pfEstimate = pfRow?.valuation_amount || null;
      }
    }

    // 2. Build scored contacts (async — may geocode via Nominatim)
    const details = { propertyType: property_type || 'House', beds: beds || null };
    const scoredContacts = await buildScoredContactsForManual(normAddress, details, 0);
    const topContacts = scoredContacts.map(c => ({
      id:       c.id       || '',
      name:     c.name,
      mobile:   c.mobile   || '',
      address:  c.address  || '',
      distance: c.distance ? Math.round(c.distance) : null,
      score:    c.score    || 0,
    }));

    // 3. Insert into market_events (INSERT OR REPLACE logic: delete then insert)
    db.prepare(`
      DELETE FROM market_events
      WHERE address = ? AND type = ? AND date(detected_at) = date('now', 'localtime')
    `).run(normAddress, type);
    const insertResult = db.prepare(`
      INSERT INTO market_events
        (detected_at, event_date, type, address, suburb, price, proping_estimate,
         beds, baths, cars, property_type, source, top_contacts)
      VALUES
        (datetime('now','localtime'), date('now','localtime'), ?, ?, ?, ?, ?,
         ?, ?, ?, ?, 'Manual', ?)
    `).run(type, normAddress, detectedSuburb, price || null, pfEstimate,
           beds || null, baths || null, cars || null,
           property_type || null, JSON.stringify(topContacts));
    const newEventId = insertResult.lastInsertRowid;

    if (type === 'sold') {
      notifyWatchersOnSold(normalizeAddrForDedup(normAddress)).catch(console.error);
    }

    // 4. Rebuild listing-alerts.json entry — street-part dedup to avoid duplicates
    try {
      const normStreetPart = normAddress.split(',')[0].trim();
      const newEntry = {
        detectedAt:   new Date().toISOString(),
        type,
        address:      normAddress,
        price:        price        || '',
        beds:         beds         || '',
        baths:        baths        || '',
        cars:         cars         || '',
        propertyType: property_type || '',
        source:       'Manual',
        topContacts,
      };
      let alerts = [];
      if (fs.existsSync(ALERTS_FILE)) {
        try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch (_) { alerts = []; }
      }
      // Strip any existing entry with the same street part (handles address-format variants)
      alerts = alerts.filter(a => a.address.toUpperCase().split(',')[0].trim() !== normStreetPart);
      alerts.push(newEntry);
      alerts = alerts.slice(-20);
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
      console.error('[/api/market-events/manual] alerts write failed:', e.message);
    }

    console.log(`[POST /api/market-events/manual] ${type} @ ${normAddress} — ${topContacts.length} contacts, est=${pfEstimate}`);
    res.json({ ok: true, contactCount: topContacts.length, id: newEventId, pfEstimate });

    // Trigger buyer matching async (after response sent)
    setImmediate(async () => {
      try {
        const matches = findMatchingBuyers({ address: normAddress, suburb: detectedSuburb || '', type, beds, baths, cars, property_type, price, id: newEventId });
        if (matches.length > 0) await notifyBuyerMatches(matches, normAddress, newEventId);
      } catch (e) { console.warn('[buyer-match] manual event match failed:', e.message); }
      // Also check active buyer referrals against this event's suburb
      await notifyReferralBuyerMatches({ address: normAddress, suburb: detectedSuburb || '', type, beds, baths, cars, property_type, price });
    });
  } catch (e) {
    console.error('[POST /api/market-events/manual]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/market-events/:id — edit an existing market event
app.patch('/api/market-events/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT * FROM market_events WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const { address, type, beds, baths, cars, property_type, price, suburb,
            confirmed_price, sold_date, status } = req.body;
    const normAddress = address
      ? address.toUpperCase().replace(/\s+/g, ' ').trim()
      : existing.address;
    const newType    = type    || existing.type;
    const newSuburb  = suburb
      ? suburb.toUpperCase().trim()
      : (() => {
          const parts = normAddress.split(',').map(s => s.trim());
          return parts.length > 1 ? parts[parts.length - 1] : existing.suburb;
        })();

    // Re-look up pf estimate if address changed
    let pfEstimate = existing.proping_estimate;
    if (address) {
      const streetPart = normAddress.split(',')[0].trim();
      const numMatch   = streetPart.match(/^(\d+)/);
      if (numMatch) {
        const num = numMatch[1];
        const kw = streetPart
          .replace(/^[\d]+[A-Z]?\s*\/?\s*[\d]*[A-Z]?\s+/, '')
          .replace(/\s+(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|PLACE|PL|CLOSE|CL|CRESCENT|CRES|COURT|CT|PARADE|PDE|TERRACE|TCE|WAY|GROVE|GR|BOULEVARD|BLVD)(\s.*)?$/i, '')
          .split(/\s+/)[0] || '';
        if (kw.length >= 3) {
          const pfRow = db.prepare(
            "SELECT valuation_amount FROM properties WHERE UPPER(address) LIKE ? AND UPPER(address) LIKE ? AND valuation_amount IS NOT NULL LIMIT 1"
          ).get(`${num}%`, `%${kw}%`);
          pfEstimate = pfRow?.valuation_amount || null;
        }
      }
    }

    // Rebuild contacts if address, property type, or beds changed (or explicit refresh with no body fields)
    let topContacts;
    if (address || property_type || beds !== undefined) {
      const details = { propertyType: property_type || existing.property_type || 'House', beds: beds !== undefined ? beds : existing.beds };
      const scored = await buildScoredContactsForManual(normAddress, details, 0);
      topContacts = scored.map(c => ({
        id: c.id || '', name: c.name, mobile: c.mobile || '', address: c.address || '',
        distance: null, score: c.score || 0,
      }));
    } else {
      topContacts = existing.top_contacts ? JSON.parse(existing.top_contacts) : [];
    }

    const newStatus = status !== undefined ? status : existing.status;
    db.prepare(`
      UPDATE market_events SET
        address = ?, suburb = ?, type = ?, price = ?, proping_estimate = ?,
        beds = ?, baths = ?, cars = ?, property_type = ?, top_contacts = ?,
        confirmed_price = ?, sold_date = ?, status = ?
      WHERE id = ?
    `).run(
      normAddress, newSuburb, newType,
      price !== undefined ? (price || null) : existing.price,
      pfEstimate,
      beds !== undefined ? (beds || null) : existing.beds,
      baths !== undefined ? (baths || null) : existing.baths,
      cars !== undefined ? (cars || null) : existing.cars,
      property_type !== undefined ? (property_type || null) : existing.property_type,
      JSON.stringify(topContacts),
      confirmed_price !== undefined ? (confirmed_price || null) : existing.confirmed_price,
      sold_date !== undefined ? (sold_date || null) : existing.sold_date,
      newStatus,
      id
    );

    if (newType === 'sold' && existing.type !== 'sold') {
      notifyWatchersOnSold(normalizeAddrForDedup(normAddress)).catch(console.error);
    }

    // Auto-link: when a listing transitions to sold status, record the link
    if (newStatus === 'sold' && existing.status !== 'sold' && existing.type === 'listing') {
      const soldEvent = db.prepare(
        `SELECT id FROM market_events WHERE address = ? AND type = 'sold' AND id != ? ORDER BY detected_at DESC LIMIT 1`
      ).get(existing.address, id);
      if (soldEvent) {
        db.prepare('UPDATE market_events SET linked_event_id = ? WHERE id = ?').run(soldEvent.id, id);
      }
    }

    // Update listing-alerts.json too
    try {
      if (fs.existsSync(ALERTS_FILE)) {
        let alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
        const idx = alerts.findIndex(a => a.address === existing.address && a.type === existing.type);
        if (idx >= 0) {
          alerts[idx] = { ...alerts[idx], address: normAddress, type: newType,
            price: price || '', beds: beds || '', baths: baths || '', cars: cars || '',
            propertyType: property_type || '', topContacts };
          fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
        }
      }
    } catch (_) {}

    res.json({ ok: true, contactCount: topContacts.length });

    // Trigger buyer matching async for all event types (after response sent)
    setImmediate(async () => {
      if (newType === 'listing') {
        try {
          const effectiveBeds = beds !== undefined ? beds : existing.beds;
          const effectiveBaths = baths !== undefined ? baths : existing.baths;
          const effectiveCars = cars !== undefined ? cars : existing.cars;
          const effectivePt = property_type !== undefined ? property_type : existing.property_type;
          const effectivePrice = price !== undefined ? price : existing.price;
          const matches = findMatchingBuyers({ address: normAddress, suburb: newSuburb || '', type: newType, beds: effectiveBeds, baths: effectiveBaths, cars: effectiveCars, property_type: effectivePt, price: effectivePrice, id });
          if (matches.length > 0) await notifyBuyerMatches(matches, normAddress, id);
        } catch (e) { console.warn('[buyer-match] patch event match failed:', e.message); }
      }
      // Also check active buyer referrals — fires for all event types (listing, sold, etc.)
      try {
        const effectivePt2  = property_type !== undefined ? property_type : existing.property_type;
        const effectivePrice2 = price !== undefined ? price : existing.price;
        const effectiveBeds2  = beds !== undefined ? beds : existing.beds;
        const effectiveBaths2 = baths !== undefined ? baths : existing.baths;
        await notifyReferralBuyerMatches({ address: normAddress, suburb: newSuburb || '', type: newType, beds: effectiveBeds2, baths: effectiveBaths2, property_type: effectivePt2, price: effectivePrice2 });
      } catch (e) { console.warn('[buyer-match] patch referral match failed:', e.message); }
    });
  } catch (e) {
    console.error('[PATCH /api/market-events/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function notifyWatchersOnSold(normAddress) {
  const watchers = db.prepare(`
    SELECT lw.contact_id, c.name, c.mobile
    FROM listing_watchers lw
    LEFT JOIN contacts c ON c.id = lw.contact_id
    WHERE lw.address = ? AND lw.notified = 0
  `).all(normAddress);
  if (watchers.length === 0) return;

  const lines = watchers.map(w => `• ${w.name || w.contact_id}${w.mobile ? ' — ' + w.mobile : ''}`);
  await sendTelegramMessage(
    `🔔 <b>WATCHERS TO CALL — ${normAddress} SOLD</b>\n\n` +
    `${watchers.length} contact${watchers.length > 1 ? 's' : ''} asked for the result:\n` +
    lines.join('\n') + `\n\nCall them back with the sale news!`
  );
  db.prepare(`UPDATE listing_watchers SET notified=1, notified_at=datetime('now') WHERE address=? AND notified=0`)
    .run(normAddress);
  console.log(`[notifyWatchersOnSold] ${watchers.length} watchers notified for ${normAddress}`);
}

// POST /api/listing-watchers — mark a contact as wanting the result of a listing
app.post('/api/listing-watchers', requireAuth, (req, res) => {
  try {
    const { contact_id, address } = req.body;
    if (!contact_id || !address) return res.status(400).json({ error: 'contact_id and address required' });
    db.prepare('INSERT OR IGNORE INTO listing_watchers (contact_id, address) VALUES (?, ?)')
      .run(String(contact_id), normalizeAddrForDedup(address));
    res.json({ ok: true, watching: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/listing-watchers', requireAuth, (req, res) => {
  try {
    const { contact_id, address } = req.body;
    if (!contact_id || !address) return res.status(400).json({ error: 'contact_id and address required' });
    db.prepare('DELETE FROM listing_watchers WHERE contact_id = ? AND address = ?')
      .run(String(contact_id), normalizeAddrForDedup(address));
    res.json({ ok: true, watching: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/market-events/:id — remove a market event
app.delete('/api/market-events/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT address, type FROM market_events WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM market_events WHERE id = ?').run(id);
    // Remove from listing-alerts.json
    try {
      if (fs.existsSync(ALERTS_FILE)) {
        let alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
        alerts = alerts.filter(a => !(a.address === existing.address && a.type === existing.type));
        fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
      }
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/market-events/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market-events/ingest — bulk ingest from pricefinder-market-local.js
app.post('/api/market-events/ingest', requireAuth, (req, res) => {
  try {
    const events = req.body;
    if (!Array.isArray(events)) return res.status(400).json({ error: 'Expected array' });
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO market_events
        (detected_at, event_date, type, address, suburb, price,
         beds, baths, cars, property_type, agent_name, agency, source)
      VALUES (datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pricefinder')
    `);
    const run = db.transaction((evts) => {
      let n = 0;
      for (const e of evts) {
        const r = stmt.run(
          e.event_date || null, e.type || 'sold',
          e.address, e.suburb, e.price || null,
          e.beds || null, e.baths || null, e.cars || null,
          e.property_type || null, e.agent_name || null, e.agency || null
        );
        if (r.changes) n++;
      }
      return n;
    });
    const inserted = run(events);
    console.log(`[POST /api/market-events/ingest] ${inserted}/${events.length} new events`);
    res.json({ ok: true, inserted, total: events.length });
  } catch (e) {
    console.error('[POST /api/market-events/ingest]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/prospecting/ingest — bulk upsert from pricefinder-prospecting-local.js
app.post('/api/prospecting/ingest', requireAuth, (req, res) => {
  try {
    const contacts = req.body;
    if (!Array.isArray(contacts)) return res.status(400).json({ error: 'Expected array' });
    const stmt = db.prepare(`
      INSERT INTO contacts
        (id, name, address, suburb, state, postcode, occupancy, tenure_years,
         property_type, source, created_at, updated_at)
      VALUES
        (@id, @name, @address, @suburb, @state, @postcode, @occupancy, @tenure_years,
         @property_type, 'pricefinder', datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        occupancy      = CASE WHEN excluded.occupancy    IS NOT NULL THEN excluded.occupancy    ELSE contacts.occupancy    END,
        tenure_years   = CASE WHEN excluded.tenure_years IS NOT NULL THEN excluded.tenure_years ELSE contacts.tenure_years END,
        property_type  = CASE WHEN excluded.property_type != ''      THEN excluded.property_type ELSE contacts.property_type END,
        updated_at     = datetime('now')
    `);
    const run = db.transaction((items) => {
      let n = 0;
      for (const c of items) {
        const addrKey = (c.address || '').toLowerCase().replace(/\s+/g, '_');
        stmt.run({
          id:            c.id || `pf_${addrKey}_${(c.suburb || '').toLowerCase()}`,
          name:          c.name          || 'Unknown Owner',
          address:       c.address       || '',
          suburb:        c.suburb        || '',
          state:         c.state         || 'NSW',
          postcode:      c.postcode      || '',
          occupancy:     c.occupancy     || null,
          tenure_years:  c.tenure_years  || null,
          property_type: c.property_type || '',
        });
        n++;
      }
      return n;
    });
    const upserted = run(contacts);
    console.log(`[POST /api/prospecting/ingest] ${upserted} contacts upserted`);
    res.json({ ok: true, upserted });
  } catch (e) {
    console.error('[POST /api/prospecting/ingest]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Normalise full street type words to abbreviations used in the properties table
// e.g. "second avenue" → "second ave", "penshurst street" → "penshurst st"
function abbrevStreetType(s) {
  if (!s) return s;
  return s
    .replace(/\bavenue\b/gi, 'ave')
    .replace(/\bstreet\b/gi, 'st')
    .replace(/\broad\b/gi, 'rd')
    .replace(/\bdrive\b/gi, 'dr')
    .replace(/\bplace\b/gi, 'pl')
    .replace(/\bclose\b/gi, 'cl')
    .replace(/\bcrescent\b/gi, 'cres')
    .replace(/\bcourt\b/gi, 'ct')
    .replace(/\bparade\b/gi, 'pde')
    .replace(/\bterrace\b/gi, 'tce')
    .replace(/\bgrove\b/gi, 'gr')
    .replace(/\bboulevard\b/gi, 'blvd');
}

// GET /api/search — query properties + contacts with prospecting filters
app.get('/api/search', requireAuth, (req, res) => {
  try {
    const { street, suburb, type, beds_min, beds_max, owner, show_dnc, page, sort_by } = req.query;
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const pageSize = 50;
    const offset   = (pageNum - 1) * pageSize;
    const showDnc  = show_dnc === '1' || show_dnc === 'true';

    // ── Build WHERE conditions for both sources in parallel ──────────────
    const linkedConds   = [];
    const linkedParams  = [];
    const unlinkedConds = [
      "c.id NOT LIKE 'pf_%'",
      "NOT EXISTS (SELECT 1 FROM properties p2 WHERE p2.contact_id = c.id)",
      "(c.address IS NOT NULL AND c.address != '')",
    ];
    const unlinkedParams = [];

    if (street) {
      const normalizedStreet = abbrevStreetType(street.toLowerCase());
      linkedConds.push("(LOWER(p.street_name) LIKE ? OR LOWER(p.address) LIKE ?)");
      linkedParams.push(`%${normalizedStreet}%`, `%${normalizedStreet}%`);
      unlinkedConds.push("LOWER(c.address) LIKE ?");
      unlinkedParams.push(`%${normalizedStreet}%`);
    }
    if (suburb && suburb !== 'all') {
      linkedConds.push("LOWER(p.suburb) LIKE ?");
      linkedParams.push(`%${suburb.toLowerCase()}%`);
      unlinkedConds.push("LOWER(c.suburb) LIKE ?");
      unlinkedParams.push(`%${suburb.toLowerCase()}%`);
    }
    if (type && type !== 'all') {
      linkedConds.push("LOWER(p.property_type) = ?");
      linkedParams.push(type.toLowerCase());
      unlinkedConds.push("LOWER(c.property_type) LIKE ?");
      unlinkedParams.push(`%${type.toLowerCase()}%`);
    }
    if (beds_min) {
      linkedConds.push("p.beds >= ?");
      linkedParams.push(parseInt(beds_min));
      unlinkedConds.push("CAST(c.beds AS INTEGER) >= ?");
      unlinkedParams.push(parseInt(beds_min));
    }
    if (beds_max) {
      linkedConds.push("p.beds <= ?");
      linkedParams.push(parseInt(beds_max));
      unlinkedConds.push("CAST(c.beds AS INTEGER) <= ?");
      unlinkedParams.push(parseInt(beds_max));
    }
    if (owner) {
      linkedConds.push("(LOWER(p.owner_name) LIKE ? OR LOWER(c.name) LIKE ?)");
      linkedParams.push(`%${owner.toLowerCase()}%`, `%${owner.toLowerCase()}%`);
      unlinkedConds.push("LOWER(c.name) LIKE ?");
      unlinkedParams.push(`%${owner.toLowerCase()}%`);
    }
    if (!showDnc) {
      linkedConds.push("(p.do_not_call = 0 OR p.do_not_call IS NULL)");
      unlinkedConds.push("(c.do_not_call = 0 OR c.do_not_call IS NULL)");
    }

    const linkedWhere   = linkedConds.length ? 'WHERE ' + linkedConds.join(' AND ') : '';
    const unlinkedWhere = 'WHERE ' + unlinkedConds.join(' AND ');

    const callLogSubq = `
      SELECT cl.contact_id, cl.called_at AS last_called_at, cl.outcome AS last_outcome, cl.notes AS last_note
      FROM call_log cl
      INNER JOIN (SELECT contact_id, MAX(called_at) AS max_at FROM call_log GROUP BY contact_id) latest
        ON cl.contact_id = latest.contact_id AND cl.called_at = latest.max_at
    `;

    // UNION of Pricefinder properties (with optional linked contact) +
    // AgentBox contacts that have no property row linking to them.
    // Both halves expose identical columns so SQLite can sort/page the combined set.
    const unionSql = `
      SELECT
        p.id AS property_id,
        p.address, p.street_number, p.street_name, p.suburb,
        p.beds, p.baths, p.cars, p.property_type,
        p.owner_name, p.government_number,
        p.pf_phone,
        CASE WHEN p.do_not_call = 1 OR c.do_not_call = 1 THEN 1 ELSE 0 END AS do_not_call,
        p.contact_id,
        c.id     AS crm_contact_id,
        c.name   AS crm_name,
        c.mobile AS crm_mobile,
        COALESCE(c.propensity_score, 0) AS propensity_score,
        c.tenure_years, c.occupancy, c.contact_class,
        COALESCE(c.mobile, p.pf_phone) AS contact_mobile,
        lc.last_called_at, lc.last_outcome, lc.last_note,
        COALESCE(c.propensity_score, 0)                                                    AS _score,
        printf('%06d', CAST(p.address AS INTEGER)) || ' ' || p.street_name || ' ' || COALESCE(p.street_number, '') AS _sort
      FROM properties p
      LEFT JOIN contacts c ON p.contact_id = c.id
      LEFT JOIN (${callLogSubq}) lc ON c.id = lc.contact_id
      ${linkedWhere}

      UNION ALL

      SELECT
        NULL AS property_id,
        UPPER(c.address) AS address, NULL AS street_number, NULL AS street_name,
        UPPER(COALESCE(c.suburb, '')) AS suburb,
        CAST(c.beds AS INTEGER) AS beds,
        CAST(c.baths AS INTEGER) AS baths,
        CAST(c.cars AS INTEGER) AS cars,
        c.property_type,
        NULL AS owner_name, NULL AS government_number, NULL AS pf_phone,
        c.do_not_call,
        NULL AS contact_id,
        c.id     AS crm_contact_id,
        c.name   AS crm_name,
        c.mobile AS crm_mobile,
        COALESCE(c.propensity_score, 0) AS propensity_score,
        c.tenure_years, c.occupancy, c.contact_class,
        c.mobile AS contact_mobile,
        lc.last_called_at, lc.last_outcome, lc.last_note,
        COALESCE(c.propensity_score, 0)                                                              AS _score,
        printf('%06d', CAST(c.address AS INTEGER)) || ' ' || UPPER(COALESCE(c.address, '')) AS _sort
      FROM contacts c
      LEFT JOIN (${callLogSubq}) lc ON c.id = lc.contact_id
      ${unlinkedWhere}
    `;

    let orderBy;
    if (sort_by === 'address_asc') {
      orderBy = 'ORDER BY _sort ASC';
    } else if (sort_by === 'last_contacted') {
      orderBy = 'ORDER BY last_called_at DESC NULLS LAST, _score DESC';
    } else {
      orderBy = 'ORDER BY CASE WHEN _score > 0 THEN 0 ELSE 1 END, _score DESC, _sort ASC';
    }

    const allParams = [...linkedParams, ...unlinkedParams];

    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM (${unionSql})`).get(allParams);
    const rows     = db.prepare(`SELECT * FROM (${unionSql}) ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`).all(allParams);

    res.json({
      results:     rows,
      total_count: countRow.n,
      page:        pageNum,
      page_size:   pageSize,
      total_pages: Math.ceil(countRow.n / pageSize),
    });
  } catch (e) {
    console.error('[GET /api/search]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:id/history — full call log for a contact (for history view)
app.get('/api/contacts/:id/history', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT called_at, outcome, notes
      FROM call_log
      WHERE contact_id = ?
      ORDER BY called_at DESC
      LIMIT 30
    `).all(req.params.id);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/contacts/:id/history]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/plan/add — add a single contact to the call_queue (and daily_plans audit trail)
app.post('/api/plan/add', requireAuth, (req, res) => {
  try {
    const { contact_id } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });

    const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const cid = String(contact_id);

    // Audit trail: daily_plans
    db.prepare(`
      INSERT OR IGNORE INTO daily_plans (plan_date, contact_id, source, created_at)
      VALUES (?, ?, 'search', datetime('now', 'localtime'))
    `).run(planDate, cid);

    // Enrich from contacts table for queue metadata
    const c = db.prepare(
      'SELECT propensity_score, tenure_years, property_type, occupancy, contact_class FROM contacts WHERE id = ?'
    ).get(cid);

    // Add to call_queue — re-activate if previously done
    const r = db.prepare(`
      INSERT INTO call_queue
        (contact_id, status, propensity_score, tenure, property_type, occupancy,
         contact_class, added_at, updated_at)
      VALUES (?, 'active', ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
      ON CONFLICT(contact_id) DO UPDATE SET
        status         = CASE WHEN status = 'done' THEN 'active' ELSE status END,
        updated_at     = datetime('now','localtime')
      WHERE excluded.status = 'done' OR call_queue.status != 'done'
    `).run(
      cid,
      c?.propensity_score || 0,
      c?.tenure_years ? `${c.tenure_years} years` : null,
      c?.property_type || null,
      c?.occupancy     || null,
      c?.contact_class || null
    );

    res.json({ ok: true, added: r.changes > 0 });
  } catch (e) {
    console.error('[POST /api/plan/add]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Buyer Profiles ────────────────────────────────────────────────────────────

// GET /api/buyer-profiles/matches/recent (static sub-path — must be before /:id)
app.get('/api/buyer-profiles/matches/recent', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT bm.*, bp.name AS buyer_name, bp.mobile AS buyer_mobile
      FROM buyer_matches bm
      JOIN buyer_profiles bp ON bp.id = bm.buyer_id
      WHERE bm.matched_at >= datetime('now', '-30 days')
      ORDER BY bm.matched_at DESC
      LIMIT 50
    `).all();
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/buyer-profiles/matches/recent]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/buyer-profiles/match-event (static sub-path — must be before /:id)
app.post('/api/buyer-profiles/match-event', requireAuth, async (req, res) => {
  try {
    const { address, suburb, type, beds, baths, cars, property_type, price, market_event_id } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });
    const matches = findMatchingBuyers({ address, suburb, type, beds, baths, cars, property_type, price, id: market_event_id });
    if (matches.length > 0) {
      await notifyBuyerMatches(matches, address, market_event_id || null);
    }
    res.json({ ok: true, matchCount: matches.length, matches: matches.map(m => ({ buyer_id: m.buyer.id, buyer_name: m.buyer.name, score: m.matchScore, reasons: m.reasons })) });
  } catch (e) {
    console.error('[POST /api/buyer-profiles/match-event]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/buyer-profiles — list buyers
app.get('/api/buyer-profiles', requireAuth, (req, res) => {
  try {
    const VALID_STATUSES = ['active', 'paused', 'purchased', 'archived', 'all'];
    const status = VALID_STATUSES.includes(req.query.status) ? req.query.status : 'active';
    const contactId = req.query.contact_id || null;
    const conditions = [];
    const params = [];
    if (status !== 'all') { conditions.push('bp.status = ?'); params.push(status); }
    if (contactId) { conditions.push('bp.contact_id = ?'); params.push(contactId); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT bp.*,
             COUNT(bm.id) AS recent_match_count
      FROM buyer_profiles bp
      LEFT JOIN buyer_matches bm
        ON bm.buyer_id = bp.id
        AND bm.matched_at >= datetime('now', '-30 days')
      ${where}
      GROUP BY bp.id
      ORDER BY
        CASE bp.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
        bp.created_at DESC
    `).all(...params);
    res.json(rows.map(r => ({
      ...r,
      suburbs_wanted: (() => { try { return JSON.parse(r.suburbs_wanted || '[]'); } catch (_) { return []; } })()
    })));
  } catch (e) {
    console.error('[GET /api/buyer-profiles]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/buyer-profiles — create a buyer profile
app.post('/api/buyer-profiles', requireAuth, (req, res) => {
  try {
    const { name, mobile, email, address, suburb, contact_id,
            price_min, price_max, beds_min, beds_max, property_type,
            suburbs_wanted, timeframe, features, status, source, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const VALID_BP_STATUSES = ['active', 'paused', 'purchased', 'archived'];
    const safeStatus = VALID_BP_STATUSES.includes(status) ? status : 'active';
    const r = db.prepare(`
      INSERT INTO buyer_profiles
        (name, mobile, email, address, suburb, contact_id,
         price_min, price_max, beds_min, beds_max, property_type,
         suburbs_wanted, timeframe, features, status, source, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      name.trim(), mobile||null, email||null, address||null, suburb||null, contact_id||null,
      price_min||null, price_max||null, beds_min||null, beds_max||null, property_type||null,
      suburbs_wanted ? JSON.stringify(Array.isArray(suburbs_wanted) ? suburbs_wanted : [suburbs_wanted]) : null,
      timeframe||null, features||null, safeStatus, source||null, notes||null
    );
    const buyer = db.prepare('SELECT * FROM buyer_profiles WHERE id = ?').get(r.lastInsertRowid);
    try { buyer.suburbs_wanted = JSON.parse(buyer.suburbs_wanted || '[]'); } catch (_) { buyer.suburbs_wanted = []; }
    res.json({ ok: true, buyer });
  } catch (e) {
    console.error('[POST /api/buyer-profiles]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/buyer-profiles/:id — get one buyer with recent matches
app.get('/api/buyer-profiles/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const buyer = db.prepare('SELECT * FROM buyer_profiles WHERE id = ?').get(id);
    if (!buyer) return res.status(404).json({ error: 'not found' });
    try { buyer.suburbs_wanted = JSON.parse(buyer.suburbs_wanted || '[]'); } catch (_) { buyer.suburbs_wanted = []; }
    const matches = db.prepare(
      'SELECT * FROM buyer_matches WHERE buyer_id = ? ORDER BY matched_at DESC LIMIT 20'
    ).all(id);
    res.json({ ...buyer, matches });
  } catch (e) {
    console.error('[GET /api/buyer-profiles/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/buyer-profiles/:id — edit a buyer profile
app.patch('/api/buyer-profiles/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT id FROM buyer_profiles WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const ALLOWED = ['name','mobile','email','address','suburb','contact_id',
                     'price_min','price_max','beds_min','beds_max','property_type',
                     'suburbs_wanted','timeframe','features','status','source','notes'];
    const sets = ["updated_at = datetime('now','localtime')"], vals = [];
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        const v = req.body[key];
        if (key === 'status') {
          const VALID_BP_STATUSES = ['active', 'paused', 'purchased', 'archived'];
          vals.push(VALID_BP_STATUSES.includes(v) ? v : 'active');
        } else if (key === 'suburbs_wanted') {
          vals.push(v ? JSON.stringify(Array.isArray(v) ? v : [v]) : null);
        } else {
          vals.push(v === '' ? null : v);
        }
      }
    }
    vals.push(id);
    db.prepare(`UPDATE buyer_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const buyer = db.prepare('SELECT * FROM buyer_profiles WHERE id = ?').get(id);
    try { buyer.suburbs_wanted = JSON.parse(buyer.suburbs_wanted || '[]'); } catch (_) { buyer.suburbs_wanted = []; }
    res.json({ ok: true, buyer });
  } catch (e) {
    console.error('[PATCH /api/buyer-profiles/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/buyer-profiles/:id — soft-archive
app.delete('/api/buyer-profiles/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const result = db.prepare(
      "UPDATE buyer_profiles SET status='archived', updated_at=datetime('now','localtime') WHERE id = ?"
    ).run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/buyer-profiles/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/buyer-profiles/:id/log-call — log a call outcome for a buyer
app.post('/api/buyer-profiles/:id/log-call', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const { outcome, notes } = req.body;
    const VALID_OUTCOMES = ['connected','left_message','no_answer','not_interested',
                            'callback_requested','appraisal_booked','wrong_number'];
    if (!VALID_OUTCOMES.includes(outcome)) return res.status(400).json({ error: 'invalid outcome' });
    const buyer = db.prepare('SELECT id, contact_id FROM buyer_profiles WHERE id = ?').get(id);
    if (!buyer) return res.status(404).json({ error: 'not found' });
    db.prepare(`
      UPDATE buyer_profiles
      SET last_contacted_at = datetime('now','localtime'),
          last_outcome = ?,
          updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(outcome, id);
    if (buyer.contact_id) {
      db.prepare(`INSERT INTO call_log (contact_id, called_at, outcome, notes) VALUES (?, datetime('now','localtime'), ?, ?)`)
        .run(buyer.contact_id, outcome, notes || null);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/buyer-profiles/:id/log-call]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REFERRAL BUSINESS — Partners + Referrals CRUD + AI endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// ─── AI endpoints first (must be before parameterised routes) ─────────────────

// POST /api/referrals/polish-brief — Haiku polishes a buyer brief into a compelling paragraph
app.post('/api/referrals/polish-brief', requireAuth, async (req, res) => {
  try {
    const { budget_min, budget_max, suburbs, property_type, timeframe, pre_approved, raw_notes } = req.body;

    const userContent = [
      budget_min    ? `Budget: $${budget_min}–$${budget_max}` : '',
      suburbs       ? `Target suburbs: ${Array.isArray(suburbs) ? suburbs.join(', ') : suburbs}` : '',
      property_type ? `Property type: ${property_type}` : '',
      timeframe     ? `Timeframe: ${timeframe}` : '',
      pre_approved  !== undefined ? `Pre-approved: ${pre_approved ? 'Yes' : 'No'}` : '',
      raw_notes     ? `Notes: ${raw_notes}` : '',
    ].filter(Boolean).join('\n');

    if (!userContent.trim()) return res.status(400).json({ error: 'at least one brief field is required' });

    const apiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system:     'You are a premium real estate referral specialist. Given a buyer\'s brief, write ONE concise professional paragraph (2-4 sentences, max 80 words) that a buyers agent would find compelling. Focus on: budget, target suburbs, property requirements, urgency/motivation, and pre-approval status. Write in third person ("My buyer is..."). Be specific, professional, and compelling. Return only the paragraph, no preamble.',
        messages:   [{ role: 'user', content: userContent }],
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 15000,
      }
    );

    const brief = apiRes.data.content[0].text.trim();
    res.json({ brief });
  } catch (e) {
    console.error('[POST /api/referrals/polish-brief]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/referral-prospects/outreach-script — Haiku generates a personalised SMS opener
app.post('/api/referral-prospects/outreach-script', requireAuth, async (req, res) => {
  try {
    const { name, suburb, address, contact_class, last_modified } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const userContent = [
      `Name: ${name}`,
      suburb        ? `Suburb: ${suburb}` : '',
      address       ? `Address: ${address}` : '',
      contact_class ? `Contact class: ${contact_class}` : '',
      last_modified ? `Last contact: ${last_modified}` : '',
    ].filter(Boolean).join('\n');

    const apiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system:     'You are Bailey O\'Byrne, a top-performing real estate agent at McGrath Willoughby. Generate a short, natural, personalised outreach SMS (max 160 chars) to reconnect with a contact. Use their name, suburb context, and contact class to personalise. Sound genuine, not salesy. The goal is to open a conversation about their property plans. Return only the SMS text, no quotes or preamble.',
        messages:   [{ role: 'user', content: userContent }],
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 15000,
      }
    );

    const script = apiRes.data.content[0].text.trim();
    res.json({ script });
  } catch (e) {
    console.error('[POST /api/referral-prospects/outreach-script]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/referral-prospects?type=buyer|vendor|all&suburb=X&page=1
app.get('/api/referral-prospects', requireAuth, (req, res) => {
  const VALID_TYPES = ['buyer', 'vendor', 'all'];
  const type = VALID_TYPES.includes(req.query.type) ? req.query.type : 'buyer';
  const suburb = typeof req.query.suburb === 'string' ? req.query.suburb.trim() : null;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  const PATCH_SUBURBS = ['Willoughby', 'North Willoughby', 'Willoughby East', 'Castlecrag', 'Middle Cove'];

  const conditions = [
    `suburb NOT IN (${PATCH_SUBURBS.map(() => '?').join(',')})`,
    "(do_not_call IS NULL OR do_not_call = '' OR do_not_call != 'YES')",
    'mobile IS NOT NULL',
    "mobile != ''"
  ];
  const params = [...PATCH_SUBURBS];

  if (suburb) { conditions.push('suburb = ?'); params.push(suburb); }

  if (type === 'buyer') {
    conditions.push("(contact_class LIKE '%Buyer%' OR contact_class LIKE '%Prospective Buyer%')");
  } else if (type === 'vendor') {
    conditions.push("(contact_class LIKE '%Vendor%' OR contact_class LIKE '%Prospective Vendor%')");
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  try {
    const total = db.prepare(`SELECT COUNT(*) as n FROM agentbox_contacts ${where}`).get(...params).n;
    const rows = db.prepare(`
      SELECT * FROM agentbox_contacts ${where}
      ORDER BY last_modified DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ rows, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    console.error('[GET /api/referral-prospects]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Partners CRUD ────────────────────────────────────────────────────────────

const VALID_PARTNER_TYPES = ['selling_agent', 'buyers_agent', 'mortgage_broker'];
const PARTNER_UPDATE_FIELDS = ['name', 'type', 'suburb_focus', 'fee_type', 'fee_value', 'mobile', 'email', 'notes'];

// GET /api/partners — list all partners ordered by type, name
app.get('/api/partners', requireAuth, (req, res) => {
  try {
    const partners = db.prepare('SELECT * FROM partners ORDER BY type, name').all();
    res.json({ partners });
  } catch (e) {
    console.error('[GET /api/partners]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/partners — create a partner
app.post('/api/partners', requireAuth, (req, res) => {
  try {
    const { name, type, fee_type, fee_value, suburb_focus, mobile, email, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!type || !VALID_PARTNER_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_PARTNER_TYPES.join(', ')}` });
    }
    if (fee_value === undefined || fee_value === null || fee_value === '') {
      return res.status(400).json({ error: 'fee_value is required' });
    }
    const parsedFee = parseFloat(fee_value);
    if (isNaN(parsedFee)) {
      return res.status(400).json({ error: 'fee_value must be a valid number' });
    }
    const result = db.prepare(`
      INSERT INTO partners (name, type, suburb_focus, fee_type, fee_value, mobile, email, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      type,
      suburb_focus || null,
      fee_type || 'percentage',
      parsedFee,
      mobile || null,
      email  || null,
      notes  || null
    );
    const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ok: true, partner });
  } catch (e) {
    console.error('[POST /api/partners]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/partners/:id — update partner (dynamic SET builder, whitelisted fields)
app.put('/api/partners/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT id FROM partners WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const sets = [], vals = [];
    for (const key of PARTNER_UPDATE_FIELDS) {
      if (req.body[key] !== undefined) {
        if (key === 'type' && !VALID_PARTNER_TYPES.includes(req.body[key])) {
          return res.status(400).json({ error: `type must be one of: ${VALID_PARTNER_TYPES.join(', ')}` });
        }
        sets.push(`${key} = ?`);
        vals.push(key === 'fee_value' ? parseFloat(req.body[key]) : (req.body[key] === '' ? null : req.body[key]));
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no valid fields to update' });
    vals.push(id);
    db.prepare(`UPDATE partners SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(id);
    res.json({ ok: true, partner });
  } catch (e) {
    console.error('[PUT /api/partners/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/partners/:id — delete (block if partner has referrals)
app.delete('/api/partners/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT id FROM partners WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const referralCount = db.prepare('SELECT COUNT(*) AS cnt FROM referrals WHERE partner_id = ?').get(id);
    if (referralCount && referralCount.cnt > 0) {
      return res.status(409).json({ error: `Cannot delete: partner has ${referralCount.cnt} referral(s)` });
    }
    db.prepare('DELETE FROM partners WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/partners/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Referrals CRUD ───────────────────────────────────────────────────────────

const VALID_REFERRAL_TYPES    = ['vendor', 'buyer', 'finance'];
const VALID_REFERRAL_STATUSES = ['referred', 'accepted', 'active', 'settled', 'paid', 'cancelled'];
const REFERRAL_UPDATE_FIELDS  = ['status', 'actual_fee', 'notes', 'settled_at', 'paid_at', 'buyer_brief', 'disclosure_sent', 'expected_fee'];

// GET /api/referrals — list all referrals, JOIN contacts + partners for display names
app.get('/api/referrals', requireAuth, (req, res) => {
  try {
    const referrals = db.prepare(`
      SELECT
        r.*,
        c.name   AS contact_name,
        c.mobile AS contact_mobile,
        c.address AS contact_address,
        p.name   AS partner_name,
        p.type   AS partner_type,
        p.mobile AS partner_mobile
      FROM referrals r
      LEFT JOIN contacts c ON c.id = r.contact_id
      LEFT JOIN partners p ON p.id = r.partner_id
      ORDER BY r.referred_at DESC
    `).all();
    res.json({ referrals });
  } catch (e) {
    console.error('[GET /api/referrals]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/referrals — create a referral
app.post('/api/referrals', requireAuth, (req, res) => {
  try {
    const { contact_id, partner_id, type, expected_fee, buyer_brief, notes, disclosure_sent } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });
    if (!partner_id) return res.status(400).json({ error: 'partner_id is required' });
    if (!type || !VALID_REFERRAL_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_REFERRAL_TYPES.join(', ')}` });
    }
    const contactExists = db.prepare('SELECT id FROM contacts WHERE id = ?').get(String(contact_id));
    if (!contactExists) return res.status(400).json({ error: `contact_id ${contact_id} not found` });
    const partnerExists = db.prepare('SELECT id FROM partners WHERE id = ?').get(parseInt(partner_id));
    if (!partnerExists) return res.status(400).json({ error: `partner_id ${partner_id} not found` });

    const result = db.prepare(`
      INSERT INTO referrals (contact_id, partner_id, type, expected_fee, buyer_brief, notes, disclosure_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(contact_id),
      parseInt(partner_id),
      type,
      expected_fee !== undefined ? parseFloat(expected_fee) : null,
      buyer_brief  ? (typeof buyer_brief === 'string' ? buyer_brief : JSON.stringify(buyer_brief)) : null,
      notes        || null,
      disclosure_sent ? 1 : 0
    );
    const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(result.lastInsertRowid);
    // Fetch contact + partner names for notification
    const refContact = db.prepare('SELECT name, mobile, address FROM contacts WHERE id = ?').get(String(contact_id));
    const refPartner  = db.prepare('SELECT name, type FROM partners WHERE id = ?').get(parseInt(partner_id));
    res.status(201).json({ ok: true, referral });

    // Automation 1: fire-and-forget Telegram notification on referral creation
    setImmediate(async () => {
      try {
        const cName    = refContact?.name    || 'Unknown';
        const cAddr    = refContact?.address || '';
        const pName    = refPartner?.name    || 'Unknown';
        const pType    = refPartner?.type    || '';
        const feeStr   = expected_fee ? `$${Number(expected_fee).toLocaleString()}` : null;

        let msg = '';
        if (type === 'buyer') {
          let brief = {};
          try { brief = JSON.parse(buyer_brief || '{}'); } catch (_) {}
          const budgetMin = brief.budget_min ? `$${(brief.budget_min/1e6).toFixed(1)}M` : null;
          const budgetMax = brief.budget_max ? `$${(brief.budget_max/1e6).toFixed(1)}M` : null;
          const budgetStr = budgetMin && budgetMax ? `${budgetMin}–${budgetMax}` : budgetMin || budgetMax || null;
          const suburbsStr = Array.isArray(brief.suburbs) ? brief.suburbs.join(', ') : (brief.suburbs_wanted || '');
          const tfStr = brief.timeframe || '';
          const preApproved = brief.pre_approved;
          msg = `🎯 New Buyer Referral\n\n👤 ${cName}`;
          if (cAddr) msg += `\n📍 ${cAddr}`;
          if (budgetStr) msg += `\n💰 Budget: ${budgetStr}`;
          if (suburbsStr) msg += `\n🏡 ${suburbsStr}`;
          if (tfStr) msg += `\n⏱️ Timeframe: ${tfStr}`;
          if (preApproved) msg += `\n✅ Pre-approved`;
          msg += `\n\n→ Partner: ${pName}${pType ? ` (${pType})` : ''}`;
          if (feeStr) msg += `\n→ Expected fee: ${feeStr}`;
        } else if (type === 'vendor') {
          msg = `🏆 New Vendor Referral\n\n👤 ${cName}`;
          if (cAddr) msg += `\n📍 ${cAddr}`;
          msg += `\n→ Partner: ${pName}${pType ? ` (${pType})` : ''}`;
          if (feeStr) {
            // Include fee with 20% note if it looks like a commission
            msg += `\n→ Expected fee: ~${feeStr}`;
          }
        } else if (type === 'finance') {
          msg = `💼 New Finance Referral\n\n👤 ${cName}`;
          if (cAddr) msg += `\n📍 ${cAddr}`;
          msg += `\n→ Partner: ${pName}${pType ? ` (${pType})` : ''}`;
          if (feeStr) msg += `\n→ Expected fee: ${feeStr}`;
        }
        if (msg) await sendTelegramMessage(msg);
      } catch (e) {
        console.warn('[referral-notify] Telegram failed:', e.message);
      }
    });
  } catch (e) {
    console.error('[POST /api/referrals]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/referrals/:id — update status/fee/notes + auto-set timestamps on status transitions
app.put('/api/referrals/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT * FROM referrals WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const sets = [], vals = [];

    for (const key of REFERRAL_UPDATE_FIELDS) {
      if (req.body[key] !== undefined) {
        if (key === 'status' && !VALID_REFERRAL_STATUSES.includes(req.body[key])) {
          return res.status(400).json({ error: `status must be one of: ${VALID_REFERRAL_STATUSES.join(', ')}` });
        }
        sets.push(`${key} = ?`);
        if (key === 'actual_fee' || key === 'expected_fee') {
          vals.push(req.body[key] === null || req.body[key] === '' ? null : parseFloat(req.body[key]));
        } else if (key === 'disclosure_sent') {
          vals.push(req.body[key] ? 1 : 0);
        } else {
          vals.push(req.body[key] === '' ? null : req.body[key]);
        }
      }
    }

    // Auto-set settled_at / paid_at on status transition (only if not already provided)
    const newStatus = req.body.status;
    if (newStatus === 'settled' && !existing.settled_at && req.body.settled_at === undefined) {
      sets.push("settled_at = datetime('now')");
    }
    if (newStatus === 'paid' && !existing.paid_at && req.body.paid_at === undefined) {
      sets.push("paid_at = datetime('now')");
    }

    if (!sets.length) return res.status(400).json({ error: 'no valid fields to update' });
    vals.push(id);
    db.prepare(`UPDATE referrals SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(id);
    res.json({ ok: true, referral });
  } catch (e) {
    console.error('[PUT /api/referrals/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Automation 3: Daily stale referral digest — Mon–Fri 8:30am AEDT (22:30 UTC prev day) ──
// AEDT = UTC+11 in summer / UTC+10 in winter. Cron target: 30 22 * * 1-5 UTC (= 8:30am AEDT)
// Implementation: poll every minute, fire once per day when UTC time matches.
let _staleDigestLastFired = null; // tracks date string (YYYY-MM-DD) of last fire
setInterval(async () => {
  try {
    const now = new Date();
    const utcDay  = now.getUTCDay();   // 0=Sun, 1=Mon...5=Fri, 6=Sat
    const utcHour = now.getUTCHours();
    const utcMin  = now.getUTCMinutes();
    const todayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Fire Mon–Fri at 22:30 UTC (= 8:30am AEDT)
    if (utcDay >= 1 && utcDay <= 5 && utcHour === 22 && utcMin === 30 && _staleDigestLastFired !== todayKey) {
      _staleDigestLastFired = todayKey;
      const staleReferrals = db.prepare(`
        SELECT r.*, c.name AS contact_name, p.name AS partner_name
        FROM referrals r
        LEFT JOIN contacts c ON c.id = r.contact_id
        LEFT JOIN partners p ON p.id = r.partner_id
        WHERE r.status IN ('referred', 'introduced', 'active')
          AND r.referred_at < datetime('now', '-7 days')
        ORDER BY r.referred_at ASC
      `).all();

      if (staleReferrals.length === 0) {
        console.log('[stale-digest] No stale referrals — skipping Telegram');
        return;
      }

      const lines = staleReferrals.map(r => {
        const typeLabel = r.type.charAt(0).toUpperCase() + r.type.slice(1);
        const refDate = new Date(r.referred_at + (r.referred_at.includes('T') ? '' : 'T00:00:00Z'));
        const ageDays = Math.floor((Date.now() - refDate.getTime()) / 86400000);
        return `• ${r.contact_name || 'Unknown'} (${typeLabel} → ${r.partner_name || 'Unknown'}) — ${ageDays} days`;
      });

      const msg = `⚠️ STALE REFERRAL DIGEST\n\n${staleReferrals.length} referral${staleReferrals.length > 1 ? 's' : ''} need follow-up:\n\n${lines.join('\n')}`;
      await sendTelegramMessage(msg);
      console.log(`[stale-digest] Sent digest for ${staleReferrals.length} stale referrals`);
    }
  } catch (e) {
    console.warn('[stale-digest] Error:', e.message);
  }
}, 60 * 1000); // check every minute

// ─── Automation 4: Weekly AgentBox sync — Sunday 8am AEDT (21:00 UTC Sat) ─────
// Chains: sync-agentbox-activities → sync-agentbox-appraisals → process-followups --since-days 8
let _weeklySyncLastFired = null;
function spawnScript(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    child.stdout.on('data', d => process.stdout.write(`[weekly-sync] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[weekly-sync] ERR: ${d}`));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)));
  });
}
setInterval(async () => {
  try {
    const now = new Date();
    const utcDay  = now.getUTCDay();   // 0=Sun
    const utcHour = now.getUTCHours();
    const utcMin  = now.getUTCMinutes();
    const todayKey = now.toISOString().slice(0, 10);

    // Fire Sunday at 21:00 UTC (= 8am AEDT Monday / 7am AEST Monday)
    if (utcDay === 0 && utcHour === 21 && utcMin === 0 && _weeklySyncLastFired !== todayKey) {
      _weeklySyncLastFired = todayKey;
      console.log('[weekly-sync] Starting weekly AgentBox sync chain...');

      const SCRIPTS = '/root/.openclaw/scripts';

      await spawnScript('node', ['/root/.openclaw/scripts/sync-agentbox-activities.js'],  SCRIPTS);
      console.log('[weekly-sync] Activities sync done.');
      await spawnScript('node', ['/root/.openclaw/scripts/sync-agentbox-appraisals.js'],  SCRIPTS);
      console.log('[weekly-sync] Appraisals sync done.');
      await spawnScript('node', ['/root/.openclaw/scripts/process-followups.js', '--since-days', '8'], SCRIPTS);
      console.log('[weekly-sync] Follow-up processing done.');

      const total = db.prepare('SELECT COUNT(*) as c FROM reminders WHERE created_at >= datetime(\'now\',\'-1 hour\')').get();
      const msg = `📋 *Weekly AgentBox Sync Complete*\n✅ Activities, appraisals & notes synced\n🔔 ${total.c} new follow-up reminder${total.c === 1 ? '' : 's'} created`;
      setImmediate(async () => { try { await sendTelegramMessage(msg); } catch (_) {} });
    }
  } catch (e) {
    console.warn('[weekly-sync] Error:', e.message);
    setImmediate(async () => { try { await sendTelegramMessage(`⚠️ Weekly AgentBox sync failed: ${e.message}`); } catch (_) {} });
  }
}, 60 * 1000); // check every minute

// ─── Call Recordings ──────────────────────────────────────────────────────

// Transcribe audio file using OpenAI Whisper API
async function transcribeAudio(audioFilePath, originalName) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(audioFilePath), {
    filename: originalName || 'audio.mp3',
    contentType: 'audio/mpeg',
  });
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('response_format', 'text');

  const res = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    }
  );
  return (res.data || '').trim();
}

// Analyse call transcript with Claude Haiku → structured JSON
async function analyseCallTranscript(transcript, contactContext) {
  const contextStr = contactContext
    ? `Contact: ${contactContext.name || 'Unknown'}. Address: ${contactContext.address || 'N/A'}.`
    : 'No contact context provided.';

  const systemPrompt = `You are an assistant helping a Sydney real estate agent analyse call transcripts.
${contextStr}
Extract the following from the transcript and respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": "connected|left_message|not_interested|callback_requested|appraisal_booked|other",
  "summary": "3-5 sentence summary of the call",
  "action_items": ["array", "of", "concrete", "next", "actions"],
  "follow_up": { "date": "YYYY-MM-DD or null", "note": "brief note or null" },
  "calendar_event": { "date": "YYYY-MM-DD or null", "time": "HH:MM or null", "address": "property address or null", "duration_minutes": 60, "title": "event title or null" },
  "sms_draft": "personalized follow-up SMS text, 1-3 sentences, sounds natural and professional"
}
Rules:
- outcome must be exactly one of the listed values
- follow_up.date: only if a specific callback time was agreed, format YYYY-MM-DD relative to today (${new Date().toISOString().slice(0,10)})
- calendar_event: only if an appointment (appraisal, meeting) was explicitly booked; otherwise null
- sms_draft: write as the agent Bailey, warm and professional, tailored to the outcome`;

  const apiRes = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Transcript:\n${transcript}` }],
    },
    {
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      timeout: 30000,
    }
  );

  const raw = apiRes.data.content[0].text.trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch (_) {
    throw new Error(`Claude returned non-JSON: ${clean.slice(0, 200)}`);
  }
}

// Full async pipeline: transcribe → analyse → auto-actions → telegram
async function processCallRecording(callId, audioFilePath, originalName, contactContext) {
  try {
    // 1. Transcribe
    console.log(`[call-intel] Transcribing call ${callId}…`);
    const transcript = await transcribeAudio(audioFilePath, originalName);
    if (!transcript) throw new Error('Whisper returned empty transcript');

    // Save transcript immediately so it's preserved even if analysis fails
    db.prepare('UPDATE call_recordings SET transcript = ? WHERE id = ?').run(transcript, callId);

    // 2. Analyse with Claude
    console.log(`[call-intel] Analysing call ${callId}…`);
    const analysis = await analyseCallTranscript(transcript, contactContext);

    const {
      outcome = 'other',
      summary = '',
      action_items = [],
      follow_up,
      calendar_event,
      sms_draft = '',
    } = analysis;

    // 3. Create reminder if follow_up date present
    let reminderId = null;
    if (follow_up && follow_up.date && contactContext) {
      try {
        const fireAt = new Date(`${follow_up.date}T09:00:00`);
        const r = db.prepare(`
          INSERT INTO reminders (contact_id, contact_name, contact_mobile, note, fire_at)
          VALUES (?, ?, ?, ?, datetime(?))
        `).run(
          contactContext.contact_id || null,
          contactContext.name || 'Unknown',
          contactContext.mobile || null,
          follow_up.note || 'Follow up from call',
          fireAt.toISOString().replace('T', ' ').slice(0, 19)
        );
        reminderId = r.lastInsertRowid;
      } catch (e) {
        console.warn('[call-intel] Reminder insert failed:', e.message);
      }
    }

    // 4. Create iCloud calendar event if appointment booked
    let calendarUid = null;
    if (calendar_event && calendar_event.date && calendar_event.time) {
      try {
        const dtstart = new Date(`${calendar_event.date}T${calendar_event.time}:00`);
        const dtend = new Date(dtstart.getTime() + (calendar_event.duration_minutes || 60) * 60000);
        const { randomBytes } = require('crypto');
        const uid = `jarvis-call-${randomBytes(8).toString('hex')}@jarvis`;
        await createCalendarEvent({
          uid,
          summary: calendar_event.title || `Appraisal — ${contactContext?.name || 'Contact'}`,
          description: `Booked during prospecting call.\n\n${summary}`,
          dtstart,
          dtend,
        });
        calendarUid = uid;
      } catch (e) {
        console.warn('[call-intel] iCal event failed:', e.message);
      }
    }

    // 5. Update contact outcome in daily_plans if contact_id known
    if (contactContext?.contact_id) {
      try {
        const outcomeMap = {
          connected: 'connected',
          left_message: 'left_message',
          not_interested: 'not_interested',
          callback_requested: 'callback_requested',
          appraisal_booked: 'appraisal_booked',
        };
        const mappedOutcome = outcomeMap[outcome] || 'connected';
        db.prepare(`
          UPDATE daily_plans SET outcome = ?, updated_at = datetime('now')
          WHERE contact_id = ? AND plan_date = date('now') AND outcome IS NULL
        `).run(mappedOutcome, contactContext.contact_id);
      } catch (e) {
        console.warn('[call-intel] daily_plans update failed:', e.message);
      }
    }

    // 6. Persist everything to call_recordings
    db.prepare(`
      UPDATE call_recordings
      SET transcript = ?, summary = ?, outcome = ?, action_items = ?,
          sms_draft = ?, calendar_event_uid = ?, reminder_id = ?,
          processed_at = datetime('now')
      WHERE id = ?
    `).run(
      transcript,
      summary,
      outcome,
      JSON.stringify(action_items),
      sms_draft,
      calendarUid,
      reminderId,
      callId
    );

    // 7. Telegram notification
    const outcomeEmoji = {
      connected: '✅',
      left_message: '📬',
      not_interested: '❌',
      callback_requested: '🔁',
      appraisal_booked: '🏠',
      other: '📞',
    }[outcome] || '📞';

    const outcomeLabel = {
      connected: 'Connected',
      left_message: 'Left Message',
      not_interested: 'Not Interested',
      callback_requested: 'Callback Requested',
      appraisal_booked: 'Appraisal Booked',
      other: 'Other',
    }[outcome] || outcome;

    let msg = `📞 <b>CALL COMPLETE${contactContext?.name ? ` — ${contactContext.name}` : ''}</b>`;
    if (contactContext?.address) msg += `\n📍 ${contactContext.address}`;
    msg += `\n\nOutcome: ${outcomeEmoji} <b>${outcomeLabel}</b>`;
    if (summary) msg += `\n\n${summary}`;
    if (calendarUid && calendar_event) {
      msg += `\n\n📅 <b>Calendar event created:</b> ${calendar_event.title || 'Appointment'} on ${calendar_event.date} at ${calendar_event.time}`;
    }
    if (follow_up?.date && !calendarUid) {
      msg += `\n\n🔁 <b>Follow-up:</b> ${follow_up.date}${follow_up.note ? ` — ${follow_up.note}` : ''}`;
    }
    if (action_items.length > 0) {
      msg += `\n\n<b>Action items:</b>\n${action_items.map(a => `• ${a}`).join('\n')}`;
    }
    if (sms_draft) {
      msg += `\n\n📱 <b>SMS Draft:</b>\n"${sms_draft}"`;
    }
    msg += `\n\n<a href="https://72.62.74.105:4242">View in Jarvis</a>`;

    await sendTelegramMessage(msg);
    console.log(`[call-intel] Call ${callId} processed: ${outcome}`);

  } catch (e) {
    console.error(`[call-intel] Processing failed for call ${callId}:`, e.message);
    db.prepare(`UPDATE call_recordings SET summary = ?, processed_at = datetime('now') WHERE id = ?`)
      .run(`Processing failed: ${e.message}`, callId);
    sendTelegramMessage(`⚠️ Call recording ${callId} failed to process: ${e.message}`).catch(() => {});
  }
}

// POST /api/calls/upload — accepts multipart audio file + contact metadata
app.post('/api/calls/upload', requireAuth, uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const contactId   = req.body.contact_id   ? String(req.body.contact_id).trim() : null;
    const contactName = (req.body.contact_name || '').trim() || null;
    const mobile      = (req.body.mobile || '').trim() || null;
    const address     = (req.body.address || '').trim() || null;
    const duration    = req.body.duration ? parseInt(req.body.duration) : null;

    // Move file to final name (multer uses temp filename)
    const ext = path.extname(req.file.originalname || '.mp3') || '.mp3';
    const finalName = `call-${Date.now()}${ext}`;
    const finalPath = path.join(CALLS_DIR, finalName);
    fs.renameSync(req.file.path, finalPath);

    // Insert stub record
    const r = db.prepare(`
      INSERT INTO call_recordings (contact_id, contact_name, audio_filename, duration_seconds)
      VALUES (?, ?, ?, ?)
    `).run(contactId, contactName, finalName, duration);

    const callId = r.lastInsertRowid;
    res.json({ call_id: callId, status: 'processing' });

    // Process asynchronously — do not await
    setImmediate(() => {
      const contactContext = (contactId || contactName) ? {
        contact_id: contactId,
        name: contactName,
        mobile,
        address,
      } : null;
      processCallRecording(callId, finalPath, req.file.originalname, contactContext)
        .catch(e => console.error('[call-intel] setImmediate error:', e.message));
    });

  } catch (e) {
    console.error('[POST /api/calls/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/calls — list recent recordings (newest first)
app.get('/api/calls', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(`
      SELECT id, contact_id, contact_name, audio_filename,
             duration_seconds, summary, outcome, sms_draft,
             created_at, processed_at
      FROM call_recordings
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/calls]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/calls/:id — full record including transcript + action_items
app.get('/api/calls/:id', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM call_recordings WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.action_items) {
      try { row.action_items = JSON.parse(row.action_items); } catch (_) {}
    }
    res.json(row);
  } catch (e) {
    console.error('[GET /api/calls/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Static dashboard (catches all unmatched routes — must be last) ───────────
app.use(express.static(DASHBOARD_DIR));

// ─── Fallback 404 ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ─── Start HTTPS server on port 4242 ──────────────────────────────────────────
const sslOptions = {
  key:  fs.readFileSync(SSL_KEY),
  cert: fs.readFileSync(SSL_CERT),
};

https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`✅ Jarvis Command Center running on HTTPS port ${PORT}`);
  console.log(`🌐 Dashboard : https://72.62.74.105:${PORT}/`);
  console.log(`🌐 Snapshot  : https://72.62.74.105:${PORT}/snapshot`);
  console.log(`🌐 API status: https://72.62.74.105:${PORT}/api/status`);
});

// ─── HTTP redirect server on port 4241 ────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://72.62.74.105:${PORT}/` });
  res.end();
}).listen(4241, () => {
  console.log(`↩️  HTTP redirect: port 4241 → https://72.62.74.105:${PORT}/`);
});
