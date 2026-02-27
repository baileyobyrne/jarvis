# Contact Edit, Notes & iCloud Calendar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add edit-contact and timestamped-notes modals to every ProspectCard on the Calls page, plus iCloud CalDAV calendar sync (with user-chosen event duration) when reminders are saved.

**Architecture:** New `contact_notes` DB table for standalone notes; `PATCH /api/contacts/:id` for edits; `GET`/`POST` `/api/contacts/:id/notes` for the notes feed; `lib/ical-calendar.js` generates RFC 5545 VEVENT and PUTs it to iCloud CalDAV using an app-specific password (no OAuth). Duration is chosen by the user in the reminder UI each time and passed through to the calendar event.

**Tech Stack:** better-sqlite3, Express, React 18 (Babel), lucide-react UMD, iCloud CalDAV (axios + raw ICS generation)

---

## Task 1: DB migration — `contact_notes` table + `duration_minutes` on reminders

**Files:**
- Modify: `lib/db.js` (add two IIFEs before the `// Exports` comment)

**Step 1: Add contact_notes migration IIFE**

In `lib/db.js`, directly before the `// Exports` comment block (after the `migrateCallQueueTable` IIFE), add:

```js
// ---------------------------------------------------------------------------
// contact_notes — timestamped standalone notes on a contact
// ---------------------------------------------------------------------------
(function migrateContactNotesTable() {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_notes'"
  ).get();
  if (!exists) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS contact_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        note       TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY(contact_id) REFERENCES contacts(id)
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id, created_at DESC)'
    ).run();
    console.log('[db] contact_notes table created.');
  }
})();

// ---------------------------------------------------------------------------
// reminders — add duration_minutes column
// ---------------------------------------------------------------------------
(function migrateRemindersDuration() {
  const cols = db.pragma('table_info(reminders)').map(r => r.name);
  if (!cols.includes('duration_minutes')) {
    db.prepare('ALTER TABLE reminders ADD COLUMN duration_minutes INTEGER DEFAULT 30').run();
    console.log('[db] reminders.duration_minutes column added.');
  }
  if (!cols.includes('calendar_event_uid')) {
    db.prepare('ALTER TABLE reminders ADD COLUMN calendar_event_uid TEXT').run();
    console.log('[db] reminders.calendar_event_uid column added.');
  }
})();
```

**Step 2: Verify**

```bash
cd /root/.openclaw
node -e "
  const {db} = require('./lib/db.js');
  console.log('contact_notes:', db.prepare(\"SELECT name FROM sqlite_master WHERE name='contact_notes'\").get());
  console.log('duration_minutes:', db.pragma('table_info(reminders)').find(c => c.name === 'duration_minutes'));
"
```
Expected: both objects printed (not undefined).

**Step 3: Commit**

```bash
cd /root/.openclaw
git add lib/db.js
git commit -m "feat: add contact_notes table and reminders.duration_minutes column"
```

---

## Task 2: API — `PATCH /api/contacts/:id`

**Files:**
- Modify: `snapshot-server.js` (add before line ~1101, before the existing `POST /api/contacts/:id/notes`)

**Step 1: Add the endpoint**

Insert immediately before the `// POST /api/contacts/:id/notes` comment:

```js
// PATCH /api/contacts/:id — edit contact fields
app.patch('/api/contacts/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const ALLOWED = ['name', 'mobile', 'address', 'suburb', 'do_not_call'];
    const sets = [];
    const vals = [];
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(req.body[key]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No valid fields provided' });
    sets.push(`updated_at = datetime('now','localtime')`);
    vals.push(id);
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
```

**Step 2: Test with curl**

```bash
TOKEN=$(node -e "require('dotenv').config({path:'/root/.openclaw/.env',override:true}); console.log(process.env.DASHBOARD_PASSWORD)")
ID=$(sqlite3 /root/.openclaw/workspace/jarvis.db "SELECT id FROM contacts WHERE mobile IS NOT NULL LIMIT 1;")
curl -sk -X PATCH "https://localhost:4242/api/contacts/$ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mobile":"0400 000 000"}'
```
Expected: `{"ok":true,"contact":{...,"mobile":"0400 000 000",...}}`

**Step 3: Commit**

```bash
git add snapshot-server.js
git commit -m "feat: add PATCH /api/contacts/:id endpoint"
```

---

## Task 3: API — `GET` and `POST` `/api/contacts/:id/notes`

**Files:**
- Modify: `snapshot-server.js:1101-1132` (replace existing POST handler; add GET above it)

**Step 1: Replace the existing `POST /api/contacts/:id/notes` block (lines 1101–1132)**

Replace the entire block with:

```js
// GET /api/contacts/:id/notes
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

// POST /api/contacts/:id/notes
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
```

**Step 2: Test**

```bash
TOKEN=$(node -e "require('dotenv').config({path:'/root/.openclaw/.env',override:true}); console.log(process.env.DASHBOARD_PASSWORD)")
ID=$(sqlite3 /root/.openclaw/workspace/jarvis.db "SELECT id FROM contacts WHERE mobile IS NOT NULL LIMIT 1;")
curl -sk -X POST "https://localhost:4242/api/contacts/$ID/notes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note":"Wrong number — belongs to Jenny, not Stan."}'
curl -sk "https://localhost:4242/api/contacts/$ID/notes" -H "Authorization: Bearer $TOKEN"
```
Expected: POST returns `{"ok":true,"note":{...}}`, GET returns array with the note.

**Step 3: Restart and verify**

```bash
pm2 restart jarvis-snapshot && pm2 logs jarvis-snapshot --lines 10 --nostream
```

**Step 4: Commit**

```bash
git add snapshot-server.js
git commit -m "feat: add GET/POST /api/contacts/:id/notes (contact_notes table)"
```

---

## Task 4: iCloud CalDAV helper — `lib/ical-calendar.js`

**Files:**
- Create: `lib/ical-calendar.js`

**Step 1: Create the file**

```js
'use strict';
/**
 * lib/ical-calendar.js
 * Creates a calendar event in iCloud via CalDAV (RFC 4791 + RFC 5545 ICS).
 * Silently no-ops if ICLOUD_APPLE_ID or ICLOUD_APP_PASSWORD are not set.
 *
 * Required .env vars (set after running scripts/icloud-setup.js):
 *   ICLOUD_APPLE_ID        e.g. bailey@icloud.com
 *   ICLOUD_APP_PASSWORD    app-specific password from appleid.apple.com
 *   ICLOUD_CALENDAR_URL    e.g. https://caldav.icloud.com/12345678/calendars/home/
 */
const axios = require('axios');
const { randomBytes } = require('crypto');

/**
 * Format a JS Date to iCal local datetime string: YYYYMMDDTHHmmss
 * in Australia/Sydney time. We manually offset from UTC (+11 in AEDT, +10 in AEST).
 * For correctness we use toLocaleString with en-CA (gives us ISO-ish format).
 */
function toIcalLocal(date) {
  const str = date.toLocaleString('sv-SE', { timeZone: 'Australia/Sydney' });
  // sv-SE gives "2026-02-27 09:00:00"
  return str.replace(/[-: ]/g, '').slice(0, 15); // "20260227T090000"
}

function toIcalUtc(date) {
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

/**
 * Generate an RFC 5545 VCALENDAR / VEVENT ICS string.
 */
function buildIcs({ uid, summary, description, dtstart, dtend, reminderMinutes = 15 }) {
  const now = toIcalUtc(new Date());
  const start = toIcalLocal(dtstart);
  const end   = toIcalLocal(dtend);
  const escapedDesc = (description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,');
  const escapedSummary = (summary || '').replace(/,/g, '\\,');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jarvis//Jarvis//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=Australia/Sydney:${start}`,
    `DTEND;TZID=Australia/Sydney:${end}`,
    `SUMMARY:${escapedSummary}`,
    `DESCRIPTION:${escapedDesc}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `TRIGGER:-PT${reminderMinutes}M`,
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Create a calendar event in iCloud.
 * @param {object} opts
 * @param {string} opts.contact_name
 * @param {string} [opts.contact_mobile]
 * @param {string} [opts.contact_address]
 * @param {string} opts.note
 * @param {string} opts.fire_at        ISO string
 * @param {number} [opts.duration_minutes]  defaults to 30
 * @returns {Promise<string|null>}  the event UID on success, null on failure/skip
 */
async function createCalendarEvent(opts) {
  const appleId    = process.env.ICLOUD_APPLE_ID;
  const appPass    = process.env.ICLOUD_APP_PASSWORD;
  const calUrl     = process.env.ICLOUD_CALENDAR_URL;

  if (!appleId || !appPass || !calUrl) return null; // not configured — silent no-op

  const { contact_name, contact_mobile, contact_address, note, fire_at, duration_minutes = 30 } = opts;

  const uid   = randomBytes(16).toString('hex') + '@jarvis';
  const start = new Date(fire_at);
  const end   = new Date(start.getTime() + duration_minutes * 60 * 1000);

  const descLines = [note || ''];
  if (contact_mobile)  descLines.push(`Mobile: ${contact_mobile}`);
  if (contact_address) descLines.push(`Address: ${contact_address}`);

  const ics = buildIcs({
    uid,
    summary:     `Follow up — ${contact_name}`,
    description: descLines.join('\n'),
    dtstart:     start,
    dtend:       end,
    reminderMinutes: 15,
  });

  const eventUrl = calUrl.replace(/\/?$/, '/') + uid + '.ics';

  try {
    await axios.put(eventUrl, ics, {
      auth:    { username: appleId, password: appPass },
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    console.log(`[icloud] Calendar event created for ${contact_name} at ${fire_at} (${duration_minutes}min)`);
    return uid;
  } catch (e) {
    console.warn('[icloud] Failed to create calendar event:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

module.exports = { createCalendarEvent };
```

**Step 2: Verify syntax**

```bash
node -e "require('/root/.openclaw/lib/ical-calendar.js'); console.log('ok')"
```
Expected: `ok`

**Step 3: Commit**

```bash
cd /root/.openclaw
git add lib/ical-calendar.js
git commit -m "feat: add iCloud CalDAV calendar event helper"
```

---

## Task 5: iCloud setup / discovery script — `scripts/icloud-setup.js`

**Files:**
- Create: `scripts/icloud-setup.js`

**Step 1: Create the script**

```js
#!/usr/bin/env node
'use strict';
/**
 * scripts/icloud-setup.js
 * Discovers your iCloud CalDAV calendar URL and writes it to .env.
 *
 * Prerequisites — add these to .env first:
 *   ICLOUD_APPLE_ID=your@icloud.com (or your Apple ID email)
 *   ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx  (from appleid.apple.com → App-Specific Passwords)
 *
 * Usage:
 *   node scripts/icloud-setup.js
 *
 * On success writes ICLOUD_CALENDAR_URL to .env, then restart jarvis-snapshot.
 */
require('dotenv').config({ path: '/root/.openclaw/.env', override: true });
const axios = require('/root/.openclaw/node_modules/axios').default || require('/root/.openclaw/node_modules/axios');
const fs    = require('fs');

const ENV_PATH  = '/root/.openclaw/.env';
const APPLE_ID  = process.env.ICLOUD_APPLE_ID;
const APP_PASS  = process.env.ICLOUD_APP_PASSWORD;

if (!APPLE_ID || !APP_PASS) {
  console.error('ERROR: Set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env first.');
  process.exit(1);
}

const AUTH   = { username: APPLE_ID, password: APP_PASS };
const HEADERS = { 'Content-Type': 'application/xml; charset=utf-8', 'Depth': '0' };

function writeEnvKey(key, value) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

function extractHref(xml) {
  const m = xml.match(/<[^:>]*:?href[^>]*>\s*([^\s<]+)\s*<\/[^:>]*:?href>/i);
  return m ? m[1].trim() : null;
}

async function main() {
  console.log(`\nConnecting to iCloud CalDAV as ${APPLE_ID}…\n`);

  // Step 1: Discover principal URL
  const propfindPrincipal = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:">
  <A:prop><A:current-user-principal/></A:prop>
</A:propfind>`;

  let principalPath;
  try {
    const r1 = await axios({
      method:  'PROPFIND',
      url:     'https://caldav.icloud.com/',
      auth:    AUTH,
      headers: HEADERS,
      data:    propfindPrincipal,
    });
    principalPath = extractHref(r1.data);
    if (!principalPath) throw new Error('Could not find current-user-principal in response');
    console.log('✓ Principal path:', principalPath);
  } catch (e) {
    console.error('✗ Failed to connect to iCloud CalDAV.');
    console.error('  Check ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env');
    console.error('  Error:', e.response?.status, e.message);
    process.exit(1);
  }

  const principalUrl = principalPath.startsWith('http')
    ? principalPath
    : 'https://caldav.icloud.com' + principalPath;

  // Step 2: Discover calendar home set
  const propfindHome = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:prop><C:calendar-home-set/></A:prop>
</A:propfind>`;

  let homeUrl;
  try {
    const r2 = await axios({
      method:  'PROPFIND',
      url:     principalUrl,
      auth:    AUTH,
      headers: HEADERS,
      data:    propfindHome,
    });
    const homePath = extractHref(r2.data);
    if (!homePath) throw new Error('Could not find calendar-home-set in response');
    homeUrl = homePath.startsWith('http') ? homePath : 'https://caldav.icloud.com' + homePath;
    console.log('✓ Calendar home:', homeUrl);
  } catch (e) {
    console.error('✗ Failed to discover calendar home set:', e.message);
    process.exit(1);
  }

  // Step 3: List calendars
  const propfindCals = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:prop>
    <A:displayname/>
    <C:supported-calendar-component-set/>
  </A:prop>
</A:propfind>`;

  let calendars = [];
  try {
    const r3 = await axios({
      method:  'PROPFIND',
      url:     homeUrl,
      auth:    AUTH,
      headers: { ...HEADERS, 'Depth': '1' },
      data:    propfindCals,
    });
    // Parse hrefs + displaynames from multi-response
    const hrefRe    = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/gi;
    const nameRe    = /<[^:>]*:?displayname[^>]*>([^<]*)<\/[^:>]*:?displayname>/gi;
    const compRe    = /VEVENT/gi;
    const xmlBlocks = r3.data.split(/<\/?[^:>]*:?response>/i).filter(b => b.includes('href'));

    for (const block of xmlBlocks) {
      const href = (block.match(/<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i) || [])[1];
      const name = (block.match(/<[^:>]*:?displayname[^>]*>([^<]*)<\/[^:>]*:?displayname>/i) || [])[1];
      const hasVevent = /VEVENT/i.test(block);
      if (href && hasVevent) {
        const fullUrl = href.startsWith('http') ? href : 'https://caldav.icloud.com' + href;
        calendars.push({ name: name || '(unnamed)', url: fullUrl });
      }
    }
  } catch (e) {
    console.error('✗ Failed to list calendars:', e.message);
    process.exit(1);
  }

  if (calendars.length === 0) {
    console.error('✗ No VEVENT calendars found. Make sure iCloud Calendar is enabled on your account.');
    process.exit(1);
  }

  console.log('\nAvailable calendars:');
  calendars.forEach((c, i) => console.log(`  [${i}] ${c.name}  →  ${c.url}`));

  // Pick the first one (or the one named "Home" / "Calendar" if present)
  const preferred = calendars.find(c => /^(home|calendar)$/i.test(c.name)) || calendars[0];
  console.log(`\n✓ Using: "${preferred.name}"`);
  console.log(`  If you want a different calendar, manually set ICLOUD_CALENDAR_URL in .env`);
  console.log(`  to one of the URLs listed above.\n`);

  writeEnvKey('ICLOUD_CALENDAR_URL', preferred.url);
  console.log('✓ ICLOUD_CALENDAR_URL written to .env');
  console.log('\nNext steps:');
  console.log('  pm2 restart jarvis-snapshot');
  console.log('  Reminders will now sync to iCloud Calendar automatically.\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

**Step 2: Verify syntax**

```bash
node --check /root/.openclaw/scripts/icloud-setup.js && echo "syntax ok"
```
Expected: `syntax ok`

> **Note — before running this script**, Bailey must:
> 1. Go to https://appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate
> 2. Add to `.env`:
>    ```
>    ICLOUD_APPLE_ID=bailey@icloud.com
>    ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
>    ```
> 3. Then run: `node scripts/icloud-setup.js`

**Step 3: Commit**

```bash
cd /root/.openclaw
git add scripts/icloud-setup.js
git commit -m "feat: add iCloud CalDAV discovery and setup script"
```

---

## Task 6: Wire iCloud into `POST /api/reminders`

**Files:**
- Modify: `snapshot-server.js` (top require + reminders endpoint at line ~925)

**Step 1: Add require at top of snapshot-server.js**

After the `const axios = require('axios');` line, add:

```js
const { createCalendarEvent } = require('./lib/ical-calendar.js');
```

**Step 2: Replace `POST /api/reminders` handler (lines 925–938)**

```js
// POST /api/reminders
app.post('/api/reminders', requireAuth, async (req, res) => {
  try {
    const { contact_id, contact_name, contact_mobile, note, fire_at, duration_minutes } = req.body;
    const dur = duration_minutes ? parseInt(duration_minutes, 10) : 30;
    db.prepare(`
      INSERT INTO reminders (contact_id, contact_name, contact_mobile, note, fire_at, duration_minutes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(contact_id, contact_name, contact_mobile, note, fire_at, dur);

    // iCloud CalDAV sync — fire-and-forget, never blocks the response
    createCalendarEvent({
      contact_name:    contact_name || 'Unknown',
      contact_mobile:  contact_mobile || null,
      contact_address: null,
      note:            note || '',
      fire_at,
      duration_minutes: dur,
    }).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/reminders]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

**Step 3: Restart and test**

```bash
pm2 restart jarvis-snapshot && pm2 logs jarvis-snapshot --lines 10 --nostream

TOKEN=$(node -e "require('dotenv').config({path:'/root/.openclaw/.env',override:true}); console.log(process.env.DASHBOARD_PASSWORD)")
curl -sk -X POST "https://localhost:4242/api/reminders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contact_name":"Test Contact","note":"test reminder","fire_at":"2026-03-01T09:00:00.000Z","duration_minutes":60}'
```
Expected: `{"ok":true}` — iCloud silently skipped until setup script is run.

**Step 4: Commit**

```bash
git add snapshot-server.js
git commit -m "feat: wire iCloud CalDAV into POST /api/reminders with duration_minutes"
```

---

## Task 7: Dashboard — `EditContactModal` component

**Files:**
- Modify: `workspace/dashboard/dashboard.js`

**Step 1: Add `ClipboardList` and `FileEdit` to the lucide imports (lines 8–14)**

Replace the destructure block:

```js
const {
  Phone, ChevronDown, ChevronUp, Bell, TrendingUp, Users, Clock,
  MapPin, Calendar, Check, X, AlertCircle, Home, Activity,
  MessageSquare, PhoneCall, PhoneOff, PhoneMissed, Star, RefreshCw,
  History, Menu, Building2, CheckCircle, Bed, Bath, Car, Plus, Mail,
  Search, Pencil, Trash2, Copy, SortAsc, Send, ClipboardList, FileEdit
} = LucideReact;
```

**Step 2: Add `EditContactModal` component before `function ProspectCard`**

```jsx
// ── Edit Contact Modal ──────────────────────────────────────────────────────
function EditContactModal({ contact, token, onSaved, onClose }) {
  const [name,    setName]    = useState(contact.name || '');
  const [mobile,  setMobile]  = useState(contact.mobile || '');
  const [address, setAddress] = useState(contact.address || '');
  const [suburb,  setSuburb]  = useState(contact.suburb || '');
  const [dnc,     setDnc]     = useState(!!contact.do_not_call);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(), mobile: mobile.trim(),
          address: address.trim(), suburb: suburb.trim(),
          do_not_call: dnc ? 1 : 0
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      onSaved(data.contact);
      onClose();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }, [contact.id, name, mobile, address, suburb, dnc, token, onSaved, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Edit Contact</span>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          {[['Name', name, setName, 'text', ''],
            ['Mobile', mobile, setMobile, 'text', '04xx xxx xxx'],
            ['Address', address, setAddress, 'text', ''],
            ['Suburb', suburb, setSuburb, 'text', '']
          ].map(([label, val, setter, type, ph]) => (
            <div className="edit-field" key={label}>
              <label className="edit-label">{label}</label>
              <input className="edit-input" type={type} value={val}
                placeholder={ph} onChange={e => setter(e.target.value)} />
            </div>
          ))}
          <div className="edit-field edit-field--inline">
            <label className="edit-label">Do Not Call</label>
            <input type="checkbox" className="edit-checkbox" checked={dnc}
              onChange={e => setDnc(e.target.checked)} />
          </div>
          {error && <div className="edit-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 3: Verify in browser** — open dashboard, check console for parse errors.

**Step 4: Commit**

```bash
git add workspace/dashboard/dashboard.js
git commit -m "feat: add EditContactModal component"
```

---

## Task 8: Dashboard — `ContactNotesModal` with duration picker

**Files:**
- Modify: `workspace/dashboard/dashboard.js` (add after `EditContactModal`)

**Step 1: Add `ContactNotesModal` component**

Insert after `EditContactModal`, before `function ProspectCard`:

```jsx
// ── Contact Notes Modal ─────────────────────────────────────────────────────
const DURATION_OPTIONS = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
];

function ContactNotesModal({ contact, token, onClose }) {
  const [notes,        setNotes]        = useState([]);
  const [history,      setHistory]      = useState([]);
  const [noteText,     setNoteText]     = useState('');
  const [saving,       setSaving]       = useState(false);
  const [loading,      setLoading]      = useState(true);
  const [showReminder, setShowReminder] = useState(false);
  const [remDays,      setRemDays]      = useState(1);
  const [remNote,      setRemNote]      = useState('');
  const [remDuration,  setRemDuration]  = useState(30);
  const [savingRem,    setSavingRem]    = useState(false);
  const [remSaved,     setRemSaved]     = useState(false);

  useEffect(() => {
    if (!contact.id) { setLoading(false); return; }
    Promise.all([
      apiFetch(`/api/contacts/${contact.id}/notes`, token).then(r => r.json()),
      apiFetch(`/api/contacts/${contact.id}/history`, token).then(r => r.json()),
    ]).then(([n, h]) => {
      setNotes(Array.isArray(n) ? n : []);
      setHistory(Array.isArray(h) ? h : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [contact.id, token]);

  const handleSaveNote = useCallback(async () => {
    if (!noteText.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/notes`, token, {
        method: 'POST', body: JSON.stringify({ note: noteText.trim() })
      });
      const data = await res.json();
      if (data.note) setNotes(prev => [data.note, ...prev]);
      setNoteText('');
    } catch (_) {}
    finally { setSaving(false); }
  }, [contact.id, noteText, token]);

  const handleSaveReminder = useCallback(async () => {
    setSavingRem(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + remDays);
      d.setHours(9, 0, 0, 0);
      await apiFetch('/api/reminders', token, {
        method: 'POST',
        body: JSON.stringify({
          contact_id:      contact.id,
          contact_name:    contact.name,
          contact_mobile:  contact.mobile,
          note:            remNote || `Follow up — ${contact.name}`,
          fire_at:         d.toISOString(),
          duration_minutes: remDuration,
        })
      });
      setRemSaved(true);
      setShowReminder(false);
    } catch (_) {}
    finally { setSavingRem(false); }
  }, [contact, token, remDays, remNote, remDuration]);

  const timeline = [
    ...notes.map(n   => ({ type: 'note', text: n.note, ts: n.created_at })),
    ...history.map(h => ({ type: 'call', text: `${OUTCOME_LABELS[h.outcome] || h.outcome}${h.notes ? ' — ' + h.notes : ''}`, ts: h.called_at })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--notes" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Notes — {contact.name}</span>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">

          <div className="notes-add-section">
            <textarea className="notes-textarea" placeholder="Add a note…"
              value={noteText} onChange={e => setNoteText(e.target.value)} rows={3} />
            <div className="notes-add-actions">
              <button className="notes-btn-reminder-toggle"
                onClick={() => setShowReminder(v => !v)}>
                <Bell size={12} /> {showReminder ? 'Hide Reminder' : 'Set Reminder'}
              </button>
              <button className="modal-btn modal-btn--save"
                onClick={handleSaveNote} disabled={saving || !noteText.trim()}>
                {saving ? 'Saving…' : 'Save Note'}
              </button>
            </div>
          </div>

          {showReminder && (
            <div className="notes-reminder-section">
              <div className="followup-label">Follow up in:</div>
              <div className="followup-row">
                {[[1,'Tomorrow'],[2,'2 Days'],[7,'1 Week']].map(([days, label]) => (
                  <button key={days}
                    className={`followup-quick${remDays === days ? ' active' : ''}`}
                    onClick={() => setRemDays(days)}>{label}</button>
                ))}
              </div>
              <div className="reminder-duration-row">
                <span className="reminder-duration-label">Duration:</span>
                {DURATION_OPTIONS.map(opt => (
                  <button key={opt.value}
                    className={`duration-quick${remDuration === opt.value ? ' active' : ''}`}
                    onClick={() => setRemDuration(opt.value)}>{opt.label}</button>
                ))}
              </div>
              <input className="followup-note-input" type="text"
                placeholder="Reminder note (optional)…"
                value={remNote} onChange={e => setRemNote(e.target.value)} />
              <div className="followup-actions">
                <button className="followup-skip" onClick={() => setShowReminder(false)}>Cancel</button>
                <button className="followup-save" onClick={handleSaveReminder} disabled={savingRem}>
                  {savingRem ? 'Saving…' : 'Save Reminder'}
                </button>
              </div>
              {remSaved && <div className="notes-reminder-saved"><Check size={11} /> Reminder saved</div>}
            </div>
          )}

          <div className="notes-timeline">
            {loading && <div className="notes-loading">Loading…</div>}
            {!loading && timeline.length === 0 && (
              <div className="notes-empty">No notes or calls yet.</div>
            )}
            {timeline.map((item, i) => (
              <div key={i} className={`notes-entry notes-entry--${item.type}`}>
                <div className="notes-entry-meta">
                  <span className="notes-entry-type">{item.type === 'note' ? '📝 Note' : '📞 Call'}</span>
                  <span className="notes-entry-ts">{fmtDate(item.ts)} {fmtTime(item.ts)}</span>
                </div>
                <div className="notes-entry-text">{item.text}</div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add workspace/dashboard/dashboard.js
git commit -m "feat: add ContactNotesModal with duration picker"
```

---

## Task 9: Dashboard — Wire buttons into `ProspectCard` + update follow-up flow

**Files:**
- Modify: `workspace/dashboard/dashboard.js:523-681`

**Step 1: Add state for modals and localContact in `ProspectCard`**

Inside the function after existing state declarations (~line 532), add:

```js
const [showEdit,     setShowEdit]     = useState(false);
const [showNotes,    setShowNotes]    = useState(false);
const [localContact, setLocalContact] = useState(contact);
const [remDuration,  setRemDuration]  = useState(30);
```

**Step 2: Add duration picker to the existing follow-up prompt**

In the `showFollowUp` section (~line 652), add the duration row after the existing date quick-buttons row and before the note input:

```jsx
<div className="reminder-duration-row">
  <span className="reminder-duration-label">Duration:</span>
  {DURATION_OPTIONS.map(opt => (
    <button key={opt.value}
      className={`duration-quick${remDuration === opt.value ? ' active' : ''}`}
      onClick={() => setRemDuration(opt.value)}>{opt.label}</button>
  ))}
</div>
```

**Step 3: Pass `duration_minutes` in `saveFollowUp`**

In the `saveFollowUp` callback, add `duration_minutes: remDuration` to the POST body:

```js
body: JSON.stringify({
  contact_id:      contact.id,
  contact_name:    contact.name,
  contact_mobile:  contact.mobile,
  note:            followUpNote || `Follow up — ${OUTCOME_LABELS[localOutcome] || localOutcome}`,
  fire_at:         d.toISOString(),
  duration_minutes: remDuration,
})
```

Also add `remDuration` to the `useCallback` dependency array.

**Step 4: Add icon buttons to card header**

In the `prospect-card-right` div, after the copy button block (before the `eventType === 'listing'` watcher check), add:

```jsx
<button className="prospect-edit-btn"
  onClick={e => { e.stopPropagation(); setShowEdit(true); }}
  title="Edit contact"><FileEdit size={11} /></button>
<button className="prospect-notes-btn"
  onClick={e => { e.stopPropagation(); setShowNotes(true); }}
  title="Notes & history"><ClipboardList size={11} /></button>
```

**Step 5: Update card display to use `localContact`**

Replace the three static references in the card JSX:
- `{contact.name}` → `{localContact.name}`
- `{contact.mobile}` (in tel href, SMS href, display text) → `{localContact.mobile}`
- `{contact.address}` → `{localContact.address}`

**Step 6: Render modals at bottom of `ProspectCard` return (before closing `</div>`)**

```jsx
{showEdit && localContact.id && (
  <EditContactModal
    contact={localContact}
    token={token}
    onSaved={updated => setLocalContact(prev => ({ ...prev, ...updated }))}
    onClose={() => setShowEdit(false)}
  />
)}
{showNotes && (
  <ContactNotesModal
    contact={localContact}
    token={token}
    onClose={() => setShowNotes(false)}
  />
)}
```

**Step 7: Verify in browser**

1. ProspectCard shows ✏️ + 📋 icon buttons in header
2. ✏️ opens EditContactModal, save updates card in-place
3. 📋 opens ContactNotesModal with note textarea + Set Reminder toggle
4. Reminder section shows: date picker (Tomorrow/2 Days/1 Week) + duration picker (15 min/30 min/1 hour/2 hours)
5. Save Reminder → confirmation shown
6. Existing follow-up flow (after logging a call outcome) also shows the duration picker
7. Timeline section shows combined call history + standalone notes

**Step 8: Commit**

```bash
git add workspace/dashboard/dashboard.js
git commit -m "feat: wire edit/notes buttons into ProspectCard, add duration picker to all reminder flows"
```

---

## Task 10: Add CSS styles

**Files:**
- Modify: `workspace/dashboard/dashboard.css` (append to end)

**Step 1: Append styles**

```css
/* ── Edit / Notes buttons on ProspectCard ─────────────────────────────── */
.prospect-edit-btn,
.prospect-notes-btn {
  background: none; border: none;
  color: var(--text-muted, #888);
  cursor: pointer; padding: 2px 3px;
  display: inline-flex; align-items: center;
  opacity: 0.6; transition: opacity 0.15s, color 0.15s;
}
.prospect-edit-btn:hover  { opacity: 1; color: #d4a843; }
.prospect-notes-btn:hover { opacity: 1; color: #d4a843; }

/* ── Modal shared ─────────────────────────────────────────────────────── */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6);
  z-index: 1000; display: flex; align-items: center; justify-content: center;
}
.modal-box {
  background: #1a1a1a; border: 1px solid #333; border-radius: 8px;
  width: 360px; max-width: 95vw; max-height: 80vh;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
}
.modal-box--notes { width: 420px; }
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px 10px; border-bottom: 1px solid #2a2a2a;
}
.modal-title  { font-size: 13px; font-weight: 600; color: #d4a843; letter-spacing: 0.04em; }
.modal-close  { background: none; border: none; color: #666; cursor: pointer; padding: 2px; }
.modal-close:hover { color: #aaa; }
.modal-body   { padding: 14px; overflow-y: auto; flex: 1; }
.modal-footer { padding: 10px 14px; border-top: 1px solid #2a2a2a; display: flex; justify-content: flex-end; gap: 8px; }
.modal-btn    { font-size: 12px; padding: 5px 14px; border-radius: 4px; cursor: pointer; border: none; font-weight: 500; }
.modal-btn--cancel { background: #2a2a2a; color: #aaa; }
.modal-btn--cancel:hover { background: #333; }
.modal-btn--save   { background: #d4a843; color: #111; }
.modal-btn--save:hover   { background: #e0b54c; }
.modal-btn:disabled { opacity: 0.5; cursor: default; }

/* ── Edit Contact form ────────────────────────────────────────────────── */
.edit-field { margin-bottom: 10px; }
.edit-field--inline { display: flex; align-items: center; gap: 10px; }
.edit-label { display: block; font-size: 11px; color: #888; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.05em; }
.edit-input {
  width: 100%; background: #111; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-size: 13px; padding: 6px 8px; box-sizing: border-box;
}
.edit-input:focus { outline: none; border-color: #d4a843; }
.edit-checkbox { width: 16px; height: 16px; accent-color: #d4a843; cursor: pointer; }
.edit-error    { color: #f87171; font-size: 12px; margin-top: 6px; }

/* ── Notes Modal ──────────────────────────────────────────────────────── */
.notes-add-section { margin-bottom: 12px; }
.notes-textarea {
  width: 100%; background: #111; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-size: 13px; padding: 8px; box-sizing: border-box;
  resize: vertical; min-height: 70px;
}
.notes-textarea:focus { outline: none; border-color: #d4a843; }
.notes-add-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
.notes-btn-reminder-toggle {
  background: none; border: 1px solid #333; color: #888; border-radius: 4px;
  font-size: 11px; padding: 4px 8px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.notes-btn-reminder-toggle:hover { color: #d4a843; border-color: #d4a843; }

.notes-reminder-section {
  background: #111; border: 1px solid #2a2a2a; border-radius: 6px;
  padding: 10px 12px; margin-bottom: 12px;
}
.notes-reminder-saved { color: #22c55e; font-size: 11px; margin-top: 6px; display: flex; align-items: center; gap: 4px; }

/* ── Duration picker (shared by notes modal + follow-up flow) ─────────── */
.reminder-duration-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 8px 0;
}
.reminder-duration-label { font-size: 11px; color: #666; }
.duration-quick {
  font-size: 11px; padding: 3px 8px; border-radius: 4px; cursor: pointer;
  border: 1px solid #333; background: #1a1a1a; color: #aaa;
  transition: all 0.15s;
}
.duration-quick:hover { border-color: #d4a843; color: #d4a843; }
.duration-quick.active { background: #2a2010; border-color: #d4a843; color: #d4a843; }

/* ── Notes timeline ───────────────────────────────────────────────────── */
.notes-timeline { margin-top: 4px; }
.notes-loading, .notes-empty { color: #555; font-size: 12px; text-align: center; padding: 12px 0; }
.notes-entry { border-left: 2px solid #333; padding: 6px 0 6px 10px; margin-bottom: 10px; }
.notes-entry--note { border-left-color: #d4a843; }
.notes-entry--call { border-left-color: #555; }
.notes-entry-meta  { display: flex; gap: 8px; align-items: center; margin-bottom: 2px; }
.notes-entry-type  { font-size: 10px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
.notes-entry--note .notes-entry-type { color: #d4a843; }
.notes-entry-ts    { font-size: 10px; color: #555; }
.notes-entry-text  { font-size: 12px; color: #ccc; line-height: 1.4; }
```

**Step 2: Commit**

```bash
git add workspace/dashboard/dashboard.css
git commit -m "feat: add CSS for modals, duration picker, notes timeline"
```

---

## Task 11: Push to GitHub

```bash
cd /root/.openclaw
git push origin main
```

---

## iCloud Setup Instructions (run after deployment)

1. **Generate an app-specific password** at https://appleid.apple.com:
   - Sign in → Sign-In and Security → App-Specific Passwords → Generate a password
   - Label it "Jarvis", copy the `xxxx-xxxx-xxxx-xxxx` password

2. **Add to `/root/.openclaw/.env`**:
   ```
   ICLOUD_APPLE_ID=your@icloud.com
   ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

3. **Run the discovery script**:
   ```bash
   node /root/.openclaw/scripts/icloud-setup.js
   ```
   It will list your calendars and write `ICLOUD_CALENDAR_URL` to `.env`.

4. **Restart the server**:
   ```bash
   pm2 restart jarvis-snapshot
   ```

From this point, every saved reminder will create a calendar event in iCloud with your chosen duration and a 15-min alert. Events appear on your iPhone and Mac automatically.
