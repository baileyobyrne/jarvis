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

const MONITOR_LOG_FILE = '/root/.openclaw/workspace/monitor.log';

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
app.get('/api/alerts', (req, res) => {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return res.json([]);
    const alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));

    // Collect all unique contact IDs across all alert topContacts
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
      const placeholders = contactIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT contact_id, outcome, called_at FROM call_log
         WHERE contact_id IN (${placeholders})
         ORDER BY called_at DESC`
      ).all(...contactIds);
      for (const row of rows) {
        if (!outcomeMap[row.contact_id]) outcomeMap[row.contact_id] = row.outcome;
      }
    }

    // Inject outcome into each topContact (null if never called)
    const enriched = alerts.map(alert => ({
      ...alert,
      topContacts: (alert.topContacts || []).map(c => ({
        ...c,
        outcome: c.id ? (outcomeMap[String(c.id)] || null) : null
      }))
    }));

    res.json([...enriched].reverse());
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
    const days              = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const includeHistorical = req.query.include_historical === '1' || req.query.include_historical === 'true';

    const liveRows = db.prepare(`
      SELECT *, 'market_event' AS record_source FROM market_events
      WHERE detected_at >= datetime('now', '-' || ? || ' days')
      ORDER BY detected_at DESC LIMIT 100
    `).all(String(days));

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
    merged.sort((a, b) => {
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
 * Uses the contacts already loaded in _contactsMap + _rpMap.
 * Progressive relaxation ladder: same category ±1bed → ±2bed → any bed → all types.
 */
function buildScoredContactsForManual(address, details, minCount = 20) {
  loadCache();
  const listingCategory = categorizePropertyType(details.propertyType || 'House');
  const listingBeds = details.beds ? parseInt(details.beds) : null;

  // Normalize event address and extract the street name keyword for proximity ranking
  // e.g. "15A Second Avenue, Willoughby East" → streetKeyword = "SECOND"
  // e.g. "3/89 Penshurst Street"              → streetKeyword = "PENSHURST"
  const normEventAddr = address.toUpperCase().replace(/\s+/g, ' ').trim();
  const eventStreetPart = normEventAddr.split(',')[0].trim();
  const streetKeyword = (() => {
    let s = eventStreetPart
      .replace(/^[\d]+[A-Z]?\s*\/\s*[\d]+[A-Z]?\s+/, '') // "3/89 " unit prefix
      .replace(/^[\d]+[A-Z]?\s+/, '');                     // "15A " or "22 " number prefix
    // Strip trailing street type (STREET, AVE, etc.)
    s = s.replace(/\s+(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|PLACE|PL|CLOSE|CL|CRESCENT|CRES|COURT|CT|PARADE|PDE|TERRACE|TCE|WAY|GROVE|GR|BOULEVARD|BLVD)(\s.*)?$/i, '').trim();
    const parts = s.split(/\s+/);
    return parts[parts.length - 1] || '';
  })();

  const LOCAL_SUBURBS = ['WILLOUGHBY', 'NORTH WILLOUGHBY', 'WILLOUGHBY EAST',
                         'CHATSWOOD', 'ARTARMON', 'NAREMBURN', 'CASTLE COVE', 'MIDDLE COVE'];

  // Build candidate pool: all contacts in local suburbs, excluding the event property itself
  const candidates = [];
  for (const [id, contact] of (_contactsMap || new Map())) {
    if (!contact.mobile) continue;
    const cSuburb = normalizeSuburb(contact.suburb || '');
    if (!LOCAL_SUBURBS.includes(cSuburb)) continue;
    // Exclude the vendor — contact lives at the property being sold/listed
    const contactAddrNorm = (contact.address || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const contactStreetPart = contactAddrNorm.split(',')[0].trim();
    if (eventStreetPart && contactStreetPart && eventStreetPart === contactStreetPart) continue;
    const rpKey   = `${contactAddrNorm} ${cSuburb}`.trim();
    const rpEntry = _rpMap?.get(rpKey);
    const score   = calcScore(contact, rpEntry);
    // Proximity bonus: contacts on the same street rank first
    const onSameStreet = streetKeyword.length >= 3 && contactAddrNorm.includes(streetKeyword);
    candidates.push({ id, contact, rpEntry, score, onSameStreet });
  }

  function scoreWithFilter(bedTolerance, dropCategory) {
    return candidates.map(({ id, contact, rpEntry, score, onSameStreet }) => {
      if (!dropCategory) {
        if (!rpEntry) return null;
        const contactCat = categorizePropertyType(rpEntry['Property Type'] || '');
        if (contactCat !== listingCategory) return null;
      }
      if (!dropCategory && bedTolerance !== null && listingBeds !== null && rpEntry) {
        const contactBeds = parseInt(rpEntry['Bed'] || '0');
        if (contactBeds > 0 && Math.abs(listingBeds - contactBeds) > bedTolerance) return null;
      }
      return {
        id,
        name:     contact.name    || 'Unknown',
        mobile:   contact.mobile  || '',
        address:  [contact.address, contact.suburb].filter(Boolean).join(', '),
        distance: null,
        score:    score + (onSameStreet ? 1000 : 0)
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
  }

  const levels = [
    () => scoreWithFilter(1, false),
    () => scoreWithFilter(2, false),
    () => scoreWithFilter(null, false),
    () => scoreWithFilter(null, true),
  ];
  for (const level of levels) {
    const scored = level();
    if (scored.length >= minCount) return scored.slice(0, 30);
  }
  return scoreWithFilter(null, true).slice(0, 30);
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
app.post('/api/market-events/manual', requireAuth, (req, res) => {
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
      // Strip leading number/unit and trailing street type to get the keyword
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

    // 2. Build scored contacts
    const details = { propertyType: property_type || 'House', beds: beds || null };
    const scoredContacts = buildScoredContactsForManual(normAddress, details, 20);
    const topContacts = scoredContacts.map(c => ({
      id:       c.id       || '',
      name:     c.name,
      mobile:   c.mobile   || '',
      address:  c.address  || '',
      distance: c.distance ? Math.round(c.distance) : null
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

    // 4. Rebuild listing-alerts.json entry for this address+type
    try {
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
        topContacts
      };
      let alerts = [];
      if (fs.existsSync(ALERTS_FILE)) {
        try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch (_) { alerts = []; }
      }
      const idx = alerts.findIndex(a => a.address === normAddress && a.type === type);
      if (idx >= 0) alerts[idx] = newEntry; else alerts.push(newEntry);
      alerts = alerts.slice(-20);
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
      console.error('[/api/market-events/manual] alerts write failed:', e.message);
    }

    console.log(`[POST /api/market-events/manual] ${type} @ ${normAddress} — ${topContacts.length} contacts, est=${pfEstimate}`);
    res.json({ ok: true, contactCount: topContacts.length, id: newEventId, pfEstimate });
  } catch (e) {
    console.error('[POST /api/market-events/manual]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/market-events/:id — edit an existing market event
app.patch('/api/market-events/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = db.prepare('SELECT * FROM market_events WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const { address, type, beds, baths, cars, property_type, price, suburb } = req.body;
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

    // Rebuild contacts if address or property type changed
    let topContacts;
    if (address || property_type || beds) {
      const details = { propertyType: property_type || existing.property_type || 'House', beds: beds || existing.beds || null };
      const scored = buildScoredContactsForManual(normAddress, details, 20);
      topContacts = scored.map(c => ({
        id: c.id || '', name: c.name, mobile: c.mobile || '', address: c.address || '', distance: null
      }));
    } else {
      topContacts = existing.top_contacts ? JSON.parse(existing.top_contacts) : [];
    }

    db.prepare(`
      UPDATE market_events SET
        address = ?, suburb = ?, type = ?, price = ?, proping_estimate = ?,
        beds = ?, baths = ?, cars = ?, property_type = ?, top_contacts = ?
      WHERE id = ?
    `).run(normAddress, newSuburb, newType, price !== undefined ? (price || null) : existing.price,
           pfEstimate,
           beds !== undefined ? (beds || null) : existing.beds,
           baths !== undefined ? (baths || null) : existing.baths,
           cars !== undefined ? (cars || null) : existing.cars,
           property_type !== undefined ? (property_type || null) : existing.property_type,
           JSON.stringify(topContacts), id);

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
  } catch (e) {
    console.error('[PATCH /api/market-events/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
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

    const conditions = [];
    const params     = [];

    if (street) {
      // Normalize full street type names to match the abbreviated format in the properties table
      const normalizedStreet = abbrevStreetType(street.toLowerCase());
      conditions.push("(LOWER(p.street_name) LIKE ? OR LOWER(p.address) LIKE ?)");
      params.push(`%${normalizedStreet}%`, `%${normalizedStreet}%`);
    }
    if (suburb && suburb !== 'all') {
      // Willoughby / Willoughby East / North Willoughby are all the same farm area.
      // AgentBox often records contacts under "Willoughby" regardless of exact sub-suburb.
      // We search the properties table (which has accurate Pricefinder suburb data) so
      // filtering by specific sub-suburb here works correctly.
      conditions.push("LOWER(p.suburb) LIKE ?");
      params.push(`%${suburb.toLowerCase()}%`);
    }
    if (type && type !== 'all') {
      conditions.push("LOWER(p.property_type) = ?");
      params.push(type.toLowerCase());
    }
    if (beds_min) {
      conditions.push("p.beds >= ?");
      params.push(parseInt(beds_min));
    }
    if (beds_max) {
      conditions.push("p.beds <= ?");
      params.push(parseInt(beds_max));
    }
    if (owner) {
      conditions.push("(LOWER(p.owner_name) LIKE ? OR LOWER(c.name) LIKE ?)");
      params.push(`%${owner.toLowerCase()}%`, `%${owner.toLowerCase()}%`);
    }
    if (!showDnc) {
      conditions.push("(p.do_not_call = 0 OR p.do_not_call IS NULL)");
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // ORDER BY depends on sort_by param
    let orderBy;
    if (sort_by === 'address_asc') {
      orderBy = 'ORDER BY p.street_name ASC, CAST(p.street_number AS INTEGER) ASC, p.street_number ASC';
    } else if (sort_by === 'last_contacted') {
      orderBy = 'ORDER BY lc.last_called_at DESC NULLS LAST, COALESCE(c.propensity_score, 0) DESC';
    } else {
      // default: propensity score descending, then address
      orderBy = 'ORDER BY CASE WHEN c.propensity_score > 0 THEN 0 ELSE 1 END, COALESCE(c.propensity_score, 0) DESC, p.suburb, p.street_name, CAST(p.street_number AS INTEGER) ASC';
    }

    const countRow = db.prepare(`
      SELECT COUNT(*) AS n
      FROM properties p
      LEFT JOIN contacts c ON p.contact_id = c.id
      LEFT JOIN (
        SELECT cl.contact_id, cl.called_at AS last_called_at, cl.outcome AS last_outcome, cl.notes AS last_note
        FROM call_log cl
        INNER JOIN (SELECT contact_id, MAX(called_at) AS max_at FROM call_log GROUP BY contact_id) latest
          ON cl.contact_id = latest.contact_id AND cl.called_at = latest.max_at
      ) lc ON c.id = lc.contact_id
      ${where}
    `).get(...params);

    const rows = db.prepare(`
      SELECT
        p.id AS property_id,
        p.address, p.street_number, p.street_name, p.suburb,
        p.beds, p.baths, p.cars, p.property_type,
        p.owner_name, p.government_number,
        p.pf_phone, p.do_not_call,
        p.contact_id,
        c.id AS crm_contact_id,
        c.name AS crm_name,
        c.mobile AS crm_mobile,
        c.propensity_score,
        c.tenure_years,
        c.occupancy,
        c.contact_class,
        COALESCE(c.mobile, p.pf_phone) AS contact_mobile,
        lc.last_called_at,
        lc.last_outcome,
        lc.last_note
      FROM properties p
      LEFT JOIN contacts c ON p.contact_id = c.id
      LEFT JOIN (
        SELECT cl.contact_id, cl.called_at AS last_called_at, cl.outcome AS last_outcome, cl.notes AS last_note
        FROM call_log cl
        INNER JOIN (SELECT contact_id, MAX(called_at) AS max_at FROM call_log GROUP BY contact_id) latest
          ON cl.contact_id = latest.contact_id AND cl.called_at = latest.max_at
      ) lc ON c.id = lc.contact_id
      ${where}
      ${orderBy}
      LIMIT ${pageSize} OFFSET ${offset}
    `).all(...params);

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

// POST /api/plan/add — add a single contact to today's plan from search results
app.post('/api/plan/add', requireAuth, (req, res) => {
  try {
    const { contact_id } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });

    const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    const r = db.prepare(`
      INSERT OR IGNORE INTO daily_plans (plan_date, contact_id, source, created_at)
      VALUES (?, ?, 'search', datetime('now', 'localtime'))
    `).run(planDate, String(contact_id));

    res.json({ ok: true, added: r.changes > 0 });
  } catch (e) {
    console.error('[POST /api/plan/add]', e.message);
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
