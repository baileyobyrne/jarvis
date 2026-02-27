# Contact Edit, Notes & Outlook Calendar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add edit-contact and timestamped-notes modals to every ProspectCard on the Calls page, plus optional Outlook calendar sync when reminders are saved.

**Architecture:** New `contact_notes` DB table for standalone notes; `PATCH /api/contacts/:id` for edits; `GET`/`POST` `/api/contacts/:id/notes` for the notes feed; `lib/outlook-calendar.js` helper fires a Graph API event creation whenever a reminder is saved (silently skipped if not configured).

**Tech Stack:** better-sqlite3, Express, React 18 (Babel), lucide-react UMD, Microsoft Graph API (axios)

---

## Task 1: DB migration — `contact_notes` table

**Files:**
- Modify: `lib/db.js:571` (add IIFE before the `module.exports` line)

**Step 1: Add the migration IIFE**

In `lib/db.js`, directly before the `// Exports` comment block (line 484 area — after the `migrateCallQueueTable` IIFE), add:

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
```

**Step 2: Verify the table is created**

```bash
cd /root/.openclaw
node -e "const {db} = require('./lib/db.js'); console.log(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get('contact_notes'));"
```
Expected output: `{ name: 'contact_notes' }`

**Step 3: Commit**

```bash
cd /root/.openclaw
git add lib/db.js
git commit -m "feat: add contact_notes table migration"
```

---

## Task 2: API — `PATCH /api/contacts/:id`

**Files:**
- Modify: `snapshot-server.js` (add new endpoint after line ~1099, before the existing `POST /api/contacts/:id/notes`)

**Step 1: Add the endpoint**

Insert this block immediately before the `// POST /api/contacts/:id/notes` comment (line 1101):

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
    const updated = db.prepare('SELECT id, name, mobile, address, suburb, do_not_call FROM contacts WHERE id = ?').get(id);
    res.json({ ok: true, contact: updated });
  } catch (e) {
    console.error('[PATCH /api/contacts/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

**Step 2: Test with curl**

```bash
source /root/.openclaw/.env 2>/dev/null; TOKEN=$(node -e "require('dotenv').config({path:'/root/.openclaw/.env',override:true}); console.log(process.env.DASHBOARD_PASSWORD)")
# Get a real contact ID first
ID=$(sqlite3 /root/.openclaw/workspace/jarvis.db "SELECT id FROM contacts WHERE mobile IS NOT NULL LIMIT 1;")
curl -sk -X PATCH "https://localhost:4242/api/contacts/$ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mobile":"0400 000 000"}'
```
Expected: `{"ok":true,"contact":{...,"mobile":"0400 000 000",...}}`

**Step 3: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js
git commit -m "feat: add PATCH /api/contacts/:id endpoint"
```

---

## Task 3: API — `GET` and `POST` `/api/contacts/:id/notes`

**Files:**
- Modify: `snapshot-server.js:1101-1132` (replace existing POST handler; add GET above it)

**Step 1: Replace the existing `POST /api/contacts/:id/notes` block**

The current block (lines 1101–1132) writes to `notes_raw` and calls AI. Replace the entire block with:

```js
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
    const row = db.prepare('SELECT id, note, created_at FROM contact_notes WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ok: true, note: row });
  } catch (e) {
    console.error('[POST /api/contacts/:id/notes]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

**Step 2: Test POST then GET**

```bash
TOKEN=$(node -e "require('dotenv').config({path:'/root/.openclaw/.env',override:true}); console.log(process.env.DASHBOARD_PASSWORD)")
ID=$(sqlite3 /root/.openclaw/workspace/jarvis.db "SELECT id FROM contacts WHERE mobile IS NOT NULL LIMIT 1;")

# POST a note
curl -sk -X POST "https://localhost:4242/api/contacts/$ID/notes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note":"Wrong number — belongs to Jenny, not Stan."}'

# GET notes back
curl -sk "https://localhost:4242/api/contacts/$ID/notes" \
  -H "Authorization: Bearer $TOKEN"
```
Expected: POST returns `{"ok":true,"note":{...}}`, GET returns array with the note.

**Step 3: Restart server and confirm PM2 picks up changes**

```bash
pm2 restart jarvis-snapshot && pm2 logs jarvis-snapshot --lines 10 --nostream
```
Expected: no startup errors.

**Step 4: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js
git commit -m "feat: add GET/POST /api/contacts/:id/notes (contact_notes table)"
```

---

## Task 4: Outlook calendar helper — `lib/outlook-calendar.js`

**Files:**
- Create: `lib/outlook-calendar.js`

**Step 1: Create the file**

```js
'use strict';
/**
 * lib/outlook-calendar.js
 * Creates a calendar event in Outlook via Microsoft Graph API.
 * Called when a reminder is saved. Silently no-ops if env vars are absent.
 *
 * Required .env vars:
 *   OUTLOOK_CLIENT_ID
 *   OUTLOOK_CLIENT_SECRET
 *   OUTLOOK_TENANT_ID
 *   OUTLOOK_REFRESH_TOKEN
 */
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * Read a single key from the .env file (raw text, not dotenv-parsed).
 * Used to retrieve the current refresh token.
 */
function readEnvKey(key) {
  try {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(new RegExp(`^${key}=(.*)$`));
      if (match) return match[1].trim();
    }
  } catch (_) {}
  return null;
}

/**
 * Write/update a key=value pair in the .env file.
 */
function writeEnvKey(key, value) {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf8');
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
  } catch (e) {
    console.warn('[outlook] Failed to write refresh token to .env:', e.message);
  }
}

/**
 * Exchange refresh token for a fresh access token.
 * Stores the new refresh token back to .env.
 * Returns the access token string, or null on failure.
 */
async function getAccessToken() {
  const clientId     = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
  const tenantId     = process.env.OUTLOOK_TENANT_ID;
  const refreshToken = readEnvKey('OUTLOOK_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !tenantId || !refreshToken) return null;

  try {
    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'https://graph.microsoft.com/Calendars.ReadWrite offline_access',
    });
    const res = await axios.post(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    // Persist new refresh token
    if (res.data.refresh_token) {
      writeEnvKey('OUTLOOK_REFRESH_TOKEN', res.data.refresh_token);
      process.env.OUTLOOK_REFRESH_TOKEN = res.data.refresh_token;
    }
    return res.data.access_token;
  } catch (e) {
    console.warn('[outlook] Token refresh failed:', e.response?.data?.error_description || e.message);
    return null;
  }
}

/**
 * Create a 30-minute calendar event for a reminder.
 * @param {object} opts
 * @param {string} opts.contact_name
 * @param {string} [opts.contact_mobile]
 * @param {string} [opts.contact_address]
 * @param {string} opts.note
 * @param {string} opts.fire_at  ISO string, e.g. "2026-03-01T09:00:00.000Z"
 */
async function createCalendarEvent(opts) {
  const accessToken = await getAccessToken();
  if (!accessToken) return; // Not configured — silent no-op

  const { contact_name, contact_mobile, contact_address, note, fire_at } = opts;

  const start = new Date(fire_at);
  const end   = new Date(start.getTime() + 30 * 60 * 1000);

  const bodyLines = [note];
  if (contact_mobile)  bodyLines.push(`Mobile: ${contact_mobile}`);
  if (contact_address) bodyLines.push(`Address: ${contact_address}`);

  const event = {
    subject: `Follow up — ${contact_name}`,
    start:   { dateTime: start.toISOString(), timeZone: 'Australia/Sydney' },
    end:     { dateTime: end.toISOString(),   timeZone: 'Australia/Sydney' },
    body:    { content: bodyLines.join('\n'), contentType: 'text' },
    isReminderOn: true,
    reminderMinutesBeforeStart: 15,
  };

  try {
    await axios.post(
      'https://graph.microsoft.com/v1.0/me/events',
      event,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[outlook] Calendar event created for ${contact_name} at ${fire_at}`);
  } catch (e) {
    console.warn('[outlook] Failed to create calendar event:', e.response?.data?.error?.message || e.message);
  }
}

module.exports = { createCalendarEvent };
```

**Step 2: Verify syntax**

```bash
node -e "require('/root/.openclaw/lib/outlook-calendar.js'); console.log('ok')"
```
Expected: `ok`

**Step 3: Commit**

```bash
cd /root/.openclaw
git add lib/outlook-calendar.js
git commit -m "feat: add Outlook Graph API calendar helper"
```

---

## Task 5: One-time OAuth setup script — `scripts/outlook-auth.js`

**Files:**
- Create: `scripts/outlook-auth.js`

**Step 1: Create the script**

```js
#!/usr/bin/env node
'use strict';
/**
 * scripts/outlook-auth.js
 * One-time device-code OAuth flow to get a Microsoft Graph refresh token.
 *
 * Usage:
 *   node scripts/outlook-auth.js
 *
 * Prerequisites in .env:
 *   OUTLOOK_CLIENT_ID=<your Azure app client ID>
 *   OUTLOOK_CLIENT_SECRET=<your Azure app client secret>
 *   OUTLOOK_TENANT_ID=<your Azure tenant ID or "common">
 *
 * After running, OUTLOOK_REFRESH_TOKEN will be written to .env.
 */
require('dotenv').config({ path: '/root/.openclaw/.env', override: true });
const axios  = require('/root/.openclaw/node_modules/axios');
const fs     = require('fs');
const path   = require('path');
const readline = require('readline');

const ENV_PATH     = '/root/.openclaw/.env';
const CLIENT_ID    = process.env.OUTLOOK_CLIENT_ID;
const CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET;
const TENANT_ID    = process.env.OUTLOOK_TENANT_ID;

if (!CLIENT_ID || !TENANT_ID) {
  console.error('ERROR: Set OUTLOOK_CLIENT_ID and OUTLOOK_TENANT_ID in .env first.');
  process.exit(1);
}

const SCOPE = 'https://graph.microsoft.com/Calendars.ReadWrite offline_access';

async function main() {
  // Step 1: Request device code
  const dcRes = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/devicecode`,
    new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const { device_code, user_code, verification_uri, interval, expires_in } = dcRes.data;

  console.log('\n=== Outlook Calendar Auth ===');
  console.log(`1. Go to: ${verification_uri}`);
  console.log(`2. Enter code: ${user_code}`);
  console.log(`3. Sign in with your work Microsoft account.`);
  console.log(`\nWaiting for you to complete sign-in (expires in ${expires_in}s)...\n`);

  // Step 2: Poll for token
  const pollMs = (interval + 1) * 1000;
  const deadline = Date.now() + expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    try {
      const tokenRes = await axios.post(
        `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
        new URLSearchParams({
          grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
          client_id:   CLIENT_ID,
          device_code,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token, refresh_token } = tokenRes.data;

      // Write refresh token to .env
      let content = fs.readFileSync(ENV_PATH, 'utf8');
      const re = /^OUTLOOK_REFRESH_TOKEN=.*$/m;
      if (re.test(content)) {
        content = content.replace(re, `OUTLOOK_REFRESH_TOKEN=${refresh_token}`);
      } else {
        content += `\nOUTLOOK_REFRESH_TOKEN=${refresh_token}`;
      }
      fs.writeFileSync(ENV_PATH, content, 'utf8');

      console.log('✓ Authenticated! OUTLOOK_REFRESH_TOKEN written to .env.');
      console.log('Restart jarvis-snapshot to pick up the new token:');
      console.log('  pm2 restart jarvis-snapshot');
      process.exit(0);
    } catch (e) {
      const err = e.response?.data?.error;
      if (err === 'authorization_pending') continue; // still waiting
      if (err === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
      console.error('Auth error:', e.response?.data || e.message);
      process.exit(1);
    }
  }
  console.error('Timed out waiting for sign-in.');
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

**Step 2: Verify syntax**

```bash
node --check /root/.openclaw/scripts/outlook-auth.js && echo "syntax ok"
```
Expected: `syntax ok`

**Step 3: Commit**

```bash
cd /root/.openclaw
git add scripts/outlook-auth.js
git commit -m "feat: add outlook-auth.js one-time OAuth device-code setup script"
```

---

## Task 6: Hook Outlook into `POST /api/reminders`

**Files:**
- Modify: `snapshot-server.js` (top-level require + modify reminders endpoint at line 925)

**Step 1: Add require at top of snapshot-server.js**

After the existing `const axios = require('axios');` line (~line 10), add:

```js
const { createCalendarEvent } = require('./lib/outlook-calendar.js');
```

**Step 2: Modify the `POST /api/reminders` handler**

Replace the current handler (lines 925–938) with:

```js
// POST /api/reminders
app.post('/api/reminders', requireAuth, async (req, res) => {
  try {
    const { contact_id, contact_name, contact_mobile, note, fire_at } = req.body;
    db.prepare(`
      INSERT INTO reminders (contact_id, contact_name, contact_mobile, note, fire_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(contact_id, contact_name, contact_mobile, note, fire_at);

    // Outlook calendar sync — fire-and-forget, never throws
    createCalendarEvent({
      contact_name:    contact_name || 'Unknown',
      contact_mobile,
      contact_address: null, // address not in reminder payload
      note:            note || '',
      fire_at,
    }).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/reminders]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

**Step 3: Restart and verify**

```bash
pm2 restart jarvis-snapshot && pm2 logs jarvis-snapshot --lines 15 --nostream
```
Expected: clean startup, no errors about `outlook-calendar`.

**Step 4: Test reminder creation still works**

```bash
TOKEN=$(node -e "require('dotenv').config({path:'/root/.openclaw/.env',override:true}); console.log(process.env.DASHBOARD_PASSWORD)")
curl -sk -X POST "https://localhost:4242/api/reminders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contact_name":"Test Contact","note":"test reminder","fire_at":"2026-03-01T09:00:00.000Z"}'
```
Expected: `{"ok":true}` (Outlook silently skipped since token not configured yet)

**Step 5: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js
git commit -m "feat: trigger Outlook calendar event creation when reminder saved"
```

---

## Task 7: Dashboard — `EditContactModal` component

**Files:**
- Modify: `workspace/dashboard/dashboard.js`

**Step 1: Add `ClipboardList` to the lucide imports (line 8–14)**

Replace the destructure block with (add `ClipboardList` and `FileEdit`):

```js
const {
  Phone, ChevronDown, ChevronUp, Bell, TrendingUp, Users, Clock,
  MapPin, Calendar, Check, X, AlertCircle, Home, Activity,
  MessageSquare, PhoneCall, PhoneOff, PhoneMissed, Star, RefreshCw,
  History, Menu, Building2, CheckCircle, Bed, Bath, Car, Plus, Mail,
  Search, Pencil, Trash2, Copy, SortAsc, Send, ClipboardList, FileEdit
} = LucideReact;
```

**Step 2: Add `EditContactModal` component**

Insert this component immediately before the `function ProspectCard` definition (before line 523):

```jsx
// ── Edit Contact Modal ──────────────────────────────────────────────────────
function EditContactModal({ contact, token, onSaved, onClose }) {
  const [name,      setName]      = useState(contact.name || '');
  const [mobile,    setMobile]    = useState(contact.mobile || '');
  const [address,   setAddress]   = useState(contact.address || '');
  const [suburb,    setSuburb]    = useState(contact.suburb || '');
  const [dnc,       setDnc]       = useState(!!contact.do_not_call);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState(null);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), mobile: mobile.trim(), address: address.trim(), suburb: suburb.trim(), do_not_call: dnc ? 1 : 0 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      onSaved(data.contact);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [contact.id, name, mobile, address, suburb, dnc, token, onSaved, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Edit Contact</span>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="edit-field">
            <label className="edit-label">Name</label>
            <input className="edit-input" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="edit-field">
            <label className="edit-label">Mobile</label>
            <input className="edit-input" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="04xx xxx xxx" />
          </div>
          <div className="edit-field">
            <label className="edit-label">Address</label>
            <input className="edit-input" value={address} onChange={e => setAddress(e.target.value)} />
          </div>
          <div className="edit-field">
            <label className="edit-label">Suburb</label>
            <input className="edit-input" value={suburb} onChange={e => setSuburb(e.target.value)} />
          </div>
          <div className="edit-field edit-field--inline">
            <label className="edit-label">Do Not Call</label>
            <input type="checkbox" className="edit-checkbox" checked={dnc} onChange={e => setDnc(e.target.checked)} />
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

**Step 3: Verify Babel syntax via browser**

Open the dashboard in the browser and check the console for parse errors. No toolchain in this project — browser Babel is the linter.

**Step 4: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add EditContactModal component to dashboard"
```

---

## Task 8: Dashboard — `ContactNotesModal` component

**Files:**
- Modify: `workspace/dashboard/dashboard.js` (add after `EditContactModal`)

**Step 1: Add `ContactNotesModal` component**

Insert immediately after `EditContactModal` and before `function ProspectCard`:

```jsx
// ── Contact Notes Modal ─────────────────────────────────────────────────────
function ContactNotesModal({ contact, token, onClose }) {
  const [notes,        setNotes]        = useState([]);
  const [history,      setHistory]      = useState([]);
  const [noteText,     setNoteText]     = useState('');
  const [saving,       setSaving]       = useState(false);
  const [loading,      setLoading]      = useState(true);
  // Reminder section
  const [showReminder, setShowReminder] = useState(false);
  const [remDays,      setRemDays]      = useState(1);
  const [remNote,      setRemNote]      = useState('');
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
        method: 'POST',
        body: JSON.stringify({ note: noteText.trim() })
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
          contact_id:     contact.id,
          contact_name:   contact.name,
          contact_mobile: contact.mobile,
          note:           remNote || `Follow up — ${contact.name}`,
          fire_at:        d.toISOString()
        })
      });
      setRemSaved(true);
      setShowReminder(false);
    } catch (_) {}
    finally { setSavingRem(false); }
  }, [contact, token, remDays, remNote]);

  // Merge notes + history into one sorted timeline
  const timeline = [
    ...notes.map(n => ({ type: 'note', text: n.note, ts: n.created_at })),
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

          {/* Add Note */}
          <div className="notes-add-section">
            <textarea
              className="notes-textarea"
              placeholder="Add a note…"
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              rows={3}
            />
            <div className="notes-add-actions">
              <button
                className="notes-btn-reminder-toggle"
                onClick={() => setShowReminder(v => !v)}
              >
                <Bell size={12} /> {showReminder ? 'Hide Reminder' : 'Set Reminder'}
              </button>
              <button
                className="modal-btn modal-btn--save"
                onClick={handleSaveNote}
                disabled={saving || !noteText.trim()}
              >
                {saving ? 'Saving…' : 'Save Note'}
              </button>
            </div>
          </div>

          {/* Reminder section */}
          {showReminder && (
            <div className="notes-reminder-section">
              <div className="followup-label">Follow up in:</div>
              <div className="followup-row">
                {[[1,'Tomorrow'],[2,'2 Days'],[7,'1 Week']].map(([days, label]) => (
                  <button
                    key={days}
                    className={`followup-quick${remDays === days ? ' active' : ''}`}
                    onClick={() => setRemDays(days)}
                  >{label}</button>
                ))}
              </div>
              <input
                className="followup-note-input"
                type="text"
                placeholder="Reminder note (optional)…"
                value={remNote}
                onChange={e => setRemNote(e.target.value)}
              />
              <div className="followup-actions">
                <button className="followup-skip" onClick={() => setShowReminder(false)}>Cancel</button>
                <button className="followup-save" onClick={handleSaveReminder} disabled={savingRem}>
                  {savingRem ? 'Saving…' : 'Save Reminder'}
                </button>
              </div>
              {remSaved && <div className="notes-reminder-saved"><Check size={11} /> Reminder saved</div>}
            </div>
          )}

          {/* Timeline */}
          <div className="notes-timeline">
            {loading && <div className="notes-loading">Loading…</div>}
            {!loading && timeline.length === 0 && (
              <div className="notes-empty">No notes or calls yet.</div>
            )}
            {timeline.map((item, i) => (
              <div key={i} className={`notes-entry notes-entry--${item.type}`}>
                <div className="notes-entry-meta">
                  <span className={`notes-entry-type`}>{item.type === 'note' ? '📝 Note' : '📞 Call'}</span>
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
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add ContactNotesModal component to dashboard"
```

---

## Task 9: Dashboard — Wire buttons into `ProspectCard`

**Files:**
- Modify: `workspace/dashboard/dashboard.js:523-681`

**Step 1: Add state and callbacks to `ProspectCard`**

Add inside the `ProspectCard` function, after the existing state declarations (~line 532):

```js
const [showEdit,       setShowEdit]       = useState(false);
const [showNotes,      setShowNotes]      = useState(false);
const [localContact,   setLocalContact]   = useState(contact);
```

**Step 2: Add icon buttons to the card header**

In the `prospect-card-right` div (around line 594), add two new buttons after the existing copy button block (after the `</button>` closing the copy button, before the `eventType === 'listing'` check):

```jsx
<button
  className="prospect-edit-btn"
  onClick={e => { e.stopPropagation(); setShowEdit(true); }}
  title="Edit contact"
>
  <FileEdit size={11} />
</button>
<button
  className="prospect-notes-btn"
  onClick={e => { e.stopPropagation(); setShowNotes(true); }}
  title="Notes & history"
>
  <ClipboardList size={11} />
</button>
```

**Step 3: Render modals at bottom of `ProspectCard` return**

Just before the closing `</div>` of the component return (before line 680):

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

**Step 4: Update name/mobile/address display to use `localContact`**

In the card JSX, replace the three static references:
- `{contact.name}` → `{localContact.name}`
- `{contact.mobile}` (the tel link and SMS href) → `{localContact.mobile}`
- `{contact.address}` → `{localContact.address}`

This ensures the card reflects edits without a page reload.

**Step 5: Verify in browser**

1. Open the dashboard Calls page
2. Each ProspectCard should now show two new small icon buttons (✏️ FileEdit, 📋 ClipboardList) in the header row
3. Click ✏️ → EditContactModal opens with contact fields pre-filled
4. Edit mobile, save → card updates in place
5. Click 📋 → ContactNotesModal opens, shows empty timeline for a fresh contact
6. Type a note, click Save Note → note appears in timeline immediately
7. Click "Set Reminder" → reminder date picker appears → save → "Reminder saved" confirmation

**Step 6: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add edit and notes buttons to ProspectCard"
```

---

## Task 10: Add CSS styles

**Files:**
- Modify: `workspace/dashboard/dashboard.css`

**Step 1: Append styles**

Add to the end of `dashboard.css`:

```css
/* ── Edit / Notes buttons on ProspectCard ─────────────────────────────── */
.prospect-edit-btn,
.prospect-notes-btn {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  padding: 2px 3px;
  display: inline-flex;
  align-items: center;
  opacity: 0.6;
  transition: opacity 0.15s, color 0.15s;
}
.prospect-edit-btn:hover  { opacity: 1; color: var(--gold, #d4a843); }
.prospect-notes-btn:hover { opacity: 1; color: var(--gold, #d4a843); }

/* ── Modal shared base ────────────────────────────────────────────────── */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  z-index: 1000;
  display: flex; align-items: center; justify-content: center;
}
.modal-box {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  width: 360px;
  max-width: 95vw;
  max-height: 80vh;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
}
.modal-box--notes { width: 420px; }

.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px 10px;
  border-bottom: 1px solid #2a2a2a;
}
.modal-title { font-size: 13px; font-weight: 600; color: #d4a843; letter-spacing: 0.04em; }
.modal-close  { background: none; border: none; color: #666; cursor: pointer; padding: 2px; }
.modal-close:hover { color: #aaa; }

.modal-body {
  padding: 14px;
  overflow-y: auto;
  flex: 1;
}
.modal-footer {
  padding: 10px 14px;
  border-top: 1px solid #2a2a2a;
  display: flex; justify-content: flex-end; gap: 8px;
}
.modal-btn {
  font-size: 12px; padding: 5px 14px; border-radius: 4px;
  cursor: pointer; border: none; font-weight: 500;
}
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
.edit-error { color: #f87171; font-size: 12px; margin-top: 6px; }

/* ── Notes Modal ──────────────────────────────────────────────────────── */
.notes-add-section { margin-bottom: 12px; }
.notes-textarea {
  width: 100%; background: #111; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-size: 13px; padding: 8px; box-sizing: border-box;
  resize: vertical; min-height: 70px;
}
.notes-textarea:focus { outline: none; border-color: #d4a843; }
.notes-add-actions {
  display: flex; justify-content: space-between; align-items: center; margin-top: 6px;
}
.notes-btn-reminder-toggle {
  background: none; border: 1px solid #333; color: #888; border-radius: 4px;
  font-size: 11px; padding: 4px 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
}
.notes-btn-reminder-toggle:hover { color: #d4a843; border-color: #d4a843; }

.notes-reminder-section {
  background: #111; border: 1px solid #2a2a2a; border-radius: 6px;
  padding: 10px 12px; margin-bottom: 12px;
}
.notes-reminder-saved { color: #22c55e; font-size: 11px; margin-top: 6px; display: flex; align-items: center; gap: 4px; }

.notes-timeline { margin-top: 4px; }
.notes-loading, .notes-empty { color: #555; font-size: 12px; text-align: center; padding: 12px 0; }

.notes-entry {
  border-left: 2px solid #333;
  padding: 6px 0 6px 10px;
  margin-bottom: 10px;
}
.notes-entry--note { border-left-color: #d4a843; }
.notes-entry--call { border-left-color: #555; }
.notes-entry-meta {
  display: flex; gap: 8px; align-items: center; margin-bottom: 2px;
}
.notes-entry-type { font-size: 10px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
.notes-entry--note .notes-entry-type { color: #d4a843; }
.notes-entry-ts   { font-size: 10px; color: #555; }
.notes-entry-text { font-size: 12px; color: #ccc; line-height: 1.4; }
```

**Step 2: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.css
git commit -m "feat: add CSS for EditContactModal and ContactNotesModal"
```

---

## Task 11: Push to GitHub

```bash
cd /root/.openclaw
git push origin main
```

---

## Outlook Setup Instructions (run after deployment)

Once the code is live, set up Outlook calendar sync:

1. **Register Azure AD app** at https://portal.azure.com:
   - Azure Active Directory → App registrations → New registration
   - Name: "Jarvis Calendar Sync", Supported account types: "Accounts in this organizational directory only"
   - No redirect URI needed (device code flow)
   - After creation: note the **Application (client) ID** and **Directory (tenant) ID**
   - Certificates & secrets → New client secret → note the **Value** (shown once)
   - API permissions → Add permission → Microsoft Graph → Delegated → `Calendars.ReadWrite` → Grant admin consent

2. **Add to `.env`**:
   ```
   OUTLOOK_CLIENT_ID=<your client ID>
   OUTLOOK_CLIENT_SECRET=<your client secret>
   OUTLOOK_TENANT_ID=<your tenant ID>
   ```

3. **Run the auth script**:
   ```bash
   node /root/.openclaw/scripts/outlook-auth.js
   ```
   Follow the on-screen URL + code to sign in.

4. **Restart the server**:
   ```bash
   pm2 restart jarvis-snapshot
   ```

From this point, every saved reminder will also create a 30-min Outlook calendar event with a 15-min alert.
