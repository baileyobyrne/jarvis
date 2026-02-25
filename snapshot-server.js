require('dotenv').config({ path: '/root/.openclaw/.env' });
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { spawn } = require('child_process');
const { db }  = require('./lib/db.js');
const multer  = require('multer');
const axios   = require('axios');
const upload  = multer({ dest: '/root/.openclaw/workspace/intel/' });

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

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONTACTS_FILE = '/root/.openclaw/workspace/willoughby-contacts.json';
const RP_DATA_FILE  = '/root/.openclaw/workspace/rp_data.csv';
const COOLDOWN_FILE = '/root/.openclaw/workspace/recently-planned.json';
const LOG_FILE      = '/root/.openclaw/workspace/daily-planner.log';
const ALERTS_FILE   = '/root/.openclaw/workspace/listing-alerts.json';
const DASHBOARD_DIR = '/root/.openclaw/workspace/dashboard';

// ─── In-memory cache (refreshed every hour) ───────────────────────────────────
let _contactsMap = null;   // Map<id, contactObject>
let _rpMap       = null;   // Map<"STREET SUBURB", rpEntry>
let _cacheTs     = 0;
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour

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
  console.log(`[cache] Ready — ${_contactsMap.size} contacts, ${_rpMap.size} RP entries.`);
}

// Warm cache on startup (non-fatal if data files are not yet present)
try { loadCache(true); } catch (e) {
  console.warn('[cache] Warm failed (non-fatal):', e.message);
}

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

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
  }
  next();
}

// ─── API ──────────────────────────────────────────────────────────────────────

// GET /api/status — public, used by dashboard header health indicator
app.get('/api/status', (req, res) => {
  try {
    loadCache();
    const todayCount  = db.prepare(
      "SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = date('now','localtime')"
    ).get().n;
    const calledCount = db.prepare(
      "SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = date('now','localtime') AND called_at IS NOT NULL"
    ).get().n;
    let lastRun = null;
    if (fs.existsSync(LOG_FILE)) {
      lastRun = fs.statSync(LOG_FILE).mtime.toISOString();
    }
    res.json({
      healthy:       true,
      lastRun,
      totalContacts: _contactsMap?.size ?? 0,
      todayCount,
      calledCount,
      target:        30,
    });
  } catch (e) {
    res.status(500).json({ healthy: false, error: e.message });
  }
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
app.get('/api/alerts', (req, res) => {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return res.json([]);
    const alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    res.json([...alerts].reverse());
  } catch (e) {
    console.error('[GET /api/alerts]', e.message);
    res.json([]);
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
    content += fs.existsSync(filePath)
      ? `\`\`\`${lang}\n${fs.readFileSync(filePath, 'utf8')}\n\`\`\`\n\n`
      : `> ⚠️ FILE NOT FOUND AT THIS PATH\n\n`;
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

// GET /api/plan/today
app.get('/api/plan/today', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT dp.*,
             c.name, c.mobile, c.address, c.suburb,
             c.propensity_score AS contact_score,
             c.tenure_years, c.occupancy AS contact_occupancy,
             c.beds, c.baths, c.cars, c.property_type AS contact_property_type,
             c.pricefinder_estimate, c.pricefinder_fetched_at
      FROM daily_plans dp
      LEFT JOIN contacts c ON c.id = dp.contact_id
      WHERE dp.plan_date = date('now', 'localtime')
      ORDER BY
        CASE WHEN dp.called_at IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(dp.propensity_score, c.propensity_score) DESC
    `).all();
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/plan/today]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/plan/topup?n=10 — score & add N more contacts to today's plan on demand
app.post('/api/plan/topup', requireAuth, (req, res) => {
  try {
    loadCache();
    const n = Math.min(Math.max(parseInt(req.query.n) || 10, 1), 30);

    const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    // Contacts already on today's board
    const plannedToday = new Set(
      db.prepare("SELECT contact_id FROM daily_plans WHERE plan_date = ?").all(planDate).map(r => r.contact_id)
    );

    // Contacts on 90-day cooldown
    const rawCooldown = fs.existsSync(COOLDOWN_FILE)
      ? JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'))
      : {};
    const now = Date.now();
    const onCooldown = new Set(
      Object.entries(rawCooldown)
        .filter(([, e]) => now - new Date(e.plannedAt).getTime() < (e.cooldownDays || 90) * 86400000)
        .map(([id]) => id)
    );

    // Score all eligible contacts
    const scored = [];
    for (const [id, contact] of _contactsMap) {
      if (plannedToday.has(id) || onCooldown.has(id)) continue;
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
    const insertPlan = db.prepare(`
      INSERT OR IGNORE INTO daily_plans
        (plan_date, contact_id, propensity_score, intel, angle, tenure, property_type, occupancy, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'topup', datetime('now', 'localtime'))
    `);

    let added = 0;
    const nowIso = new Date().toISOString();
    const updatedCooldown = { ...rawCooldown };

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

      const r = insertPlan.run(
        planDate, id, score,
        buildIntel(contact, rpEntry),
        buildAngle(contact, rpEntry),
        tenure,
        rpEntry?.['Property Type'] || contact.propertyType || '',
        rpEntry?.['Owner Type']    || contact.occupancy    || ''
      );
      if (r.changes) added++;

      // Lock contact into 90-day cooldown
      updatedCooldown[id] = {
        plannedAt:     nowIso,
        name:          contact.name,
        cooldownDays:  90,
        address:       contact.address,
        mobile:        contact.mobile,
        propensityScore: score,
        source:        'topup',
      };
    }

    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(updatedCooldown, null, 2));
    console.log(`[POST /api/plan/topup] Added ${added} contacts to today's plan.`);
    res.json({ ok: true, added, requested: n });
  } catch (e) {
    console.error('[POST /api/plan/topup]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/plan/:contactId/outcome
app.patch('/api/plan/:contactId/outcome', requireAuth, (req, res) => {
  try {
    const { contactId } = req.params;
    const { outcome, notes } = req.body;
    const result = db.prepare(`
      UPDATE daily_plans
      SET called_at = datetime('now', 'localtime'), outcome = ?, notes = ?
      WHERE plan_date = date('now', 'localtime') AND contact_id = ?
    `).run(outcome, notes, contactId);
    if (!result.changes) {
      return res.status(404).json({ error: 'Contact not in today\'s plan' });
    }
    db.prepare(`
      INSERT INTO call_log (contact_id, called_at, outcome, notes)
      VALUES (?, datetime('now', 'localtime'), ?, ?)
    `).run(contactId, outcome, notes);
    res.json({ ok: true });
  } catch (e) {
    console.error('[PATCH /api/plan/:contactId/outcome]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reminders
app.post('/api/reminders', requireAuth, (req, res) => {
  try {
    const { contact_id, contact_name, contact_mobile, note, fire_at } = req.body;
    db.prepare(`
      INSERT INTO reminders (contact_id, contact_name, contact_mobile, note, fire_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(contact_id, contact_name, contact_mobile, note, fire_at);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/reminders]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reminders/upcoming
app.get('/api/reminders/upcoming', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM reminders WHERE sent = 0 ORDER BY fire_at ASC LIMIT 50
    `).all();
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/reminders/upcoming]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market
app.get('/api/market', requireAuth, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const rows = db.prepare(`
      SELECT * FROM market_events
      WHERE detected_at >= datetime('now', '-' || ? || ' days')
      ORDER BY detected_at DESC LIMIT 100
    `).all(String(days));
    res.json(rows);
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

// POST /api/contacts/:id/notes
app.post('/api/contacts/:id/notes', requireAuth, async (req, res) => {
  try {
    const { id }        = req.params;
    const { notes_raw } = req.body;
    db.prepare(`UPDATE contacts SET notes_raw = ? WHERE id = ?`).run(notes_raw, id);
    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-3-haiku-20240307',
        max_tokens: 200,
        messages: [{
          role:    'user',
          content: `Summarise these real estate CRM notes into 2-3 clean sentences suitable for pasting into an agent's CRM. Be factual and concise. Notes: ${notes_raw}`,
        }],
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
      }
    );
    const notes_summary = aiRes.data.content[0].text;
    db.prepare(`UPDATE contacts SET notes_summary = ? WHERE id = ?`).run(notes_summary, id);
    res.json({ ok: true, notes_summary });
  } catch (e) {
    console.error('[POST /api/contacts/:id/notes]', e.message);
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

// GET /api/buyers/calllist — active buyers not yet done, grouped by listing
app.get('/api/buyers/calllist', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM buyers
      WHERE (done_date IS NULL OR done_date = '')
        AND (status IS NULL OR status = 'active')
      ORDER BY listing_address ASC, enquiry_date DESC
    `).all();
    // Group by listing_address
    const grouped = {};
    for (const b of rows) {
      const key = b.listing_address || 'Unknown Listing';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(b);
    }
    res.json(grouped);
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
