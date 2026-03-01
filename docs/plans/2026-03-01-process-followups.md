# Follow-up Processor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `scripts/process-followups.js` — a one-off script that reads appraisals + contact notes from jarvis.db and inserts follow-up reminders/tasks into the reminders table.

**Architecture:** Two sequential passes. Pass 1 matches 132 appraisals to contacts by address and creates staggered reminders. Pass 2 strips system-noise CRM notes, groups remaining notes by contact, batches them to Haiku for timing-intent classification, and inserts reminders for actionable contacts.

**Tech Stack:** Node.js, better-sqlite3 (`/root/.openclaw/node_modules/better-sqlite3`), axios (`/root/.openclaw/node_modules/axios`), dotenv (`/root/.openclaw/node_modules/dotenv`), Anthropic Haiku (`claude-haiku-4-5-20251001`), `/root/.openclaw/lib/db.js`

---

## Reference: Key Constraints

- `reminders.contact_name` is **NOT NULL** — always supply a fallback (e.g. `"Appraisal — 65 Laurel St"`)
- `reminders.note` is **NOT NULL**
- `reminders.fire_at` is nullable — when `is_task = 1`, leave null
- Haiku call pattern (from snapshot-server.js): `axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [...] }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 })`
- Strip Haiku response of markdown fences before `JSON.parse`
- Use `require('/root/.openclaw/node_modules/dotenv').config({ path: '/root/.openclaw/.env', override: true })`
- Use `require('/root/.openclaw/node_modules/axios')` (NOT the agentbox-willoughby copy)
- Script lives in `/root/.openclaw/scripts/process-followups.js`

---

## Task 1: Script skeleton + CLI flags

**Files:**
- Create: `scripts/process-followups.js`

**Step 1: Create the file with boilerplate**

```javascript
'use strict';
/**
 * process-followups.js
 * Pass 1: Appraisal follow-ups (132 appraisals → reminders)
 * Pass 2: Contact notes AI scan (Haiku → reminders)
 *
 * Usage:
 *   node scripts/process-followups.js
 *   node scripts/process-followups.js --dry-run
 *   node scripts/process-followups.js --dry-run --limit 50
 *   node scripts/process-followups.js --skip-notes
 *   node scripts/process-followups.js --skip-appraisals
 */
require('/root/.openclaw/node_modules/dotenv').config({ path: '/root/.openclaw/.env', override: true });
const axios  = require('/root/.openclaw/node_modules/axios');
const { db } = require('/root/.openclaw/lib/db.js');

const DRY_RUN         = process.argv.includes('--dry-run');
const SKIP_NOTES      = process.argv.includes('--skip-notes');
const SKIP_APPRAISALS = process.argv.includes('--skip-appraisals');
const limitIdx        = process.argv.indexOf('--limit');
const LIMIT           = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1]) : null;

const TODAY = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10) + 'T09:00:00';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log(`process-followups starting [${DRY_RUN ? 'DRY RUN' : 'LIVE'}]`);

(async () => {
  if (!SKIP_APPRAISALS) await runAppraisalsPass();
  if (!SKIP_NOTES)      await runNotesPass();
  console.log('\nAll done.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
```

**Step 2: Verify syntax (node --check)**

```bash
node --check /root/.openclaw/scripts/process-followups.js
```
Expected: no output (no syntax errors). Note: `runAppraisalsPass` and `runNotesPass` are not yet defined — add stubs before running check:

```javascript
async function runAppraisalsPass() { console.log('appraisals pass (stub)'); }
async function runNotesPass()      { console.log('notes pass (stub)'); }
```

**Step 3: Run with --dry-run to confirm it starts cleanly**

```bash
node /root/.openclaw/scripts/process-followups.js --dry-run
```
Expected output:
```
process-followups starting [DRY RUN]
appraisals pass (stub)
notes pass (stub)
All done.
```

---

## Task 2: Deduplication helper + reminder insert

**Files:**
- Modify: `scripts/process-followups.js` — add helpers before the `(async () => {` block

**Step 1: Add the hasOpenReminder query and insertReminder function**

```javascript
// Returns true if contact already has an uncompleted reminder
const _hasOpenReminder = db.prepare(
  `SELECT id FROM reminders WHERE contact_id = ? AND completed_at IS NULL LIMIT 1`
);
function hasOpenReminder(contactId) {
  if (!contactId) return false;
  return !!_hasOpenReminder.get(String(contactId));
}

const _insertReminder = db.prepare(`
  INSERT INTO reminders (contact_id, contact_name, contact_mobile, note, fire_at, is_task, priority)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function createReminder({ contactId, contactName, contactMobile, note, fireAt, isTask, priority = 'normal' }) {
  if (DRY_RUN) {
    console.log(`  [dry] REMINDER contact="${contactName}" fire_at=${fireAt || 'null (task)'} note="${note.slice(0, 80)}"`);
    return;
  }
  _insertReminder.run(
    contactId   ? String(contactId) : null,
    contactName,
    contactMobile || null,
    note,
    fireAt || null,
    isTask ? 1 : 0,
    priority
  );
}
```

**Step 2: Verify syntax check passes**

```bash
node --check /root/.openclaw/scripts/process-followups.js
```

---

## Task 3: Address matching helper

**Files:**
- Modify: `scripts/process-followups.js` — add `findContactByAddress` before the async block

**Step 1: Add the function**

Appraisals have addresses like `"65 Laurel Street"` or `"14/2 Church Street"`. The contacts table stores addresses in mixed case. Match by stripping the leading number/unit and doing a LIKE on the remainder.

```javascript
/**
 * Attempts to match an appraisal address to a contact.
 * Strips leading unit/number (e.g. "14/2" or "65") then LIKE-matches the rest.
 * Returns { id, name, mobile } or null.
 */
const _findContact = db.prepare(
  `SELECT id, name, mobile FROM contacts
   WHERE LOWER(address) LIKE LOWER(?) AND LOWER(suburb) LIKE LOWER(?)
   LIMIT 1`
);

function findContactByAddress(address, suburb) {
  // Strip leading unit/number prefix — e.g. "14/2 Church St" → "Church St"
  //                                         "65 Laurel St"   → "Laurel St"
  const streetPart = address.replace(/^\d+\/\d+\s+/, '').replace(/^\d+\s+/, '').trim();
  if (!streetPart) return null;
  return _findContact.get('%' + streetPart + '%', '%' + suburb + '%') || null;
}
```

**Step 2: Quick manual test in the same file (remove after confirming)**

Add temporarily inside the stub `runAppraisalsPass`:
```javascript
const test = findContactByAddress('65 Laurel Street', 'Willoughby');
console.log('address match test:', test);
```

Run:
```bash
node /root/.openclaw/scripts/process-followups.js --dry-run --skip-notes
```
Expected: prints `address match test: { id: '...', name: 'Sandra Darbon', mobile: '...' }` (or similar).

Remove the test line before moving on.

---

## Task 4: Pass 1 — Appraisals follow-ups

**Files:**
- Modify: `scripts/process-followups.js` — replace the `runAppraisalsPass` stub

**Step 1: Implement runAppraisalsPass**

```javascript
async function runAppraisalsPass() {
  console.log('\n=== Pass 1: Appraisals ===');
  const appraisals = db.prepare(
    `SELECT agentbox_id, address, suburb, appraisal_date FROM appraisals ORDER BY appraisal_date DESC`
  ).all();
  console.log(`  ${appraisals.length} appraisals to process`);

  let created = 0, skipped = 0, noMatch = 0;

  for (const ap of appraisals) {
    const contact = findContactByAddress(ap.address, ap.suburb);

    // Calculate days since appraisal
    const apDate  = new Date(ap.appraisal_date);
    const daysSince = Math.floor((Date.now() - apDate.getTime()) / 86400000);

    // Determine fire_at and is_task based on recency
    let fireAt = null;
    let isTask = false;
    if      (daysSince < 30)  { fireAt = addDays(14); }
    else if (daysSince < 90)  { fireAt = addDays(7);  }
    else if (daysSince < 180) { fireAt = addDays(3);  }
    else                      { isTask = true;         }

    // Skip if contact already has open reminder
    if (contact && hasOpenReminder(contact.id)) {
      skipped++;
      continue;
    }

    const contactName   = contact ? contact.name   : `Appraisal — ${ap.address}`;
    const contactMobile = contact ? contact.mobile : null;
    const contactId     = contact ? contact.id     : null;
    const apDateStr     = ap.appraisal_date ? ap.appraisal_date.slice(0, 10) : 'unknown date';
    const note          = `Appraisal follow-up — had appraisal at ${ap.address}, ${ap.suburb} on ${apDateStr}. Worth a check-in on their plans?`;

    if (!contact) noMatch++;

    createReminder({ contactId, contactName, contactMobile, note, fireAt, isTask });
    created++;
  }

  console.log(`  Created: ${created} | Skipped (dup): ${skipped} | No address match: ${noMatch}`);
}
```

**Step 2: Dry-run test**

```bash
node /root/.openclaw/scripts/process-followups.js --dry-run --skip-notes
```
Expected: prints ~132 `[dry] REMINDER` lines with staggered fire_at dates, summary at end.

**Step 3: Verify the counts look right**

Check output — `Created: ~132`, `Skipped: 0` (no existing reminders), `No address match: some small number`.

---

## Task 5: Notes pre-filter + contact grouping

**Files:**
- Modify: `scripts/process-followups.js` — add `loadActionableNotes` function

**Step 1: Define system noise patterns and add loader**

```javascript
// System-generated note patterns to exclude (case-insensitive prefix/contains match)
const NOISE_PATTERNS = [
  /^MDT\s*[-–]/i,
  /conflicting contact details/i,
  /duplicate contact detected/i,
  /contact pre-import modifications/i,
  /contact categories notes/i,
];

function isNoise(note) {
  return NOISE_PATTERNS.some(re => re.test(note));
}

/**
 * Loads manual/agent notes grouped by contact_id.
 * Returns Map<contactId, { contact, notes: string[] }>
 */
function loadActionableNotes() {
  // Fetch contacts with open-reminder check info
  const contactMap = new Map();
  db.prepare(`SELECT id, name, mobile, do_not_call FROM contacts`).all()
    .forEach(c => contactMap.set(String(c.id), c));

  const rows = db.prepare(`
    SELECT contact_id, note, created_at
    FROM contact_notes
    WHERE LENGTH(note) > 15
      AND created_at >= '2025-06-01'
    ORDER BY contact_id, created_at ASC
  `).all();

  const grouped = new Map(); // contactId → string[]

  for (const row of rows) {
    if (isNoise(row.note)) continue;
    const cid = String(row.contact_id);
    if (!grouped.has(cid)) grouped.set(cid, []);
    grouped.get(cid).push(`[${row.created_at.slice(0,10)}] ${row.note}`);
  }

  // Filter to contacts we know about
  const result = new Map();
  for (const [cid, notes] of grouped) {
    const contact = contactMap.get(cid);
    if (!contact) continue;
    result.set(cid, { contact, notes });
  }

  return result;
}
```

**Step 2: Add a quick stats check inside the notes pass stub**

Replace `runNotesPass` stub temporarily:
```javascript
async function runNotesPass() {
  const grouped = loadActionableNotes();
  console.log(`Notes pass: ${grouped.size} contacts with manual notes`);
  let sample = 0;
  for (const [cid, { contact, notes }] of grouped) {
    if (sample++ >= 3) break;
    console.log(`  ${contact.name}: ${notes.length} notes`);
    notes.forEach(n => console.log('    ', n.slice(0, 100)));
  }
}
```

Run:
```bash
node /root/.openclaw/scripts/process-followups.js --dry-run --skip-appraisals
```
Expected: prints unique contact count (probably 3,000–6,000) and sample notes that look like real agent-written content, not system noise.

---

## Task 6: Haiku batch function

**Files:**
- Modify: `scripts/process-followups.js` — add `classifyNotesWithHaiku`

**Step 1: Add the batch classifier**

The prompt asks Haiku to return a JSON array. We send 10 contacts per call to keep tokens manageable.

```javascript
const HAIKU_SYSTEM = `You are analyzing real estate CRM notes written by agents about their contacts.
Today's date is ${TODAY}.

For each contact, review the note history and return a JSON array with one object per contact:
{
  "contact_id": "<id>",
  "action_needed": true|false,
  "fire_at": "<YYYY-MM-DD>"|null,
  "reason": "<one sentence>"
}

fire_at rules:
- Extract explicit dates: "ANZAC Day" → "${new Date().getFullYear()}-04-25", "after school term" → next July 1st
- Relative timing: "2 years" → add 2 years to today, "6 months" → add 6 months, "next year" → Jan 1 next year
- Vague intent (no timing): null (caller will default to 3 months)
- No valid follow-up: null

Set action_needed=false (and fire_at=null) when notes clearly say:
- "no plans", "not interested", "going with another agency", "never selling", "happy where they are"
- Notes are only mass campaign references with no personal context

Return ONLY the JSON array. No markdown, no explanation.`;

async function classifyNotesWithHaiku(batch) {
  // batch: [{ contact_id, contact_name, notes: string[] }]
  const userContent = batch.map(c =>
    `CONTACT_ID: ${c.contact_id}\nNAME: ${c.contact_name}\nNOTES:\n${c.notes.join('\n')}`
  ).join('\n\n---\n\n');

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     HAIKU_SYSTEM,
      messages:   [{ role: 'user', content: userContent }],
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

  const raw   = res.data.content[0].text.trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(clean); // throws on bad JSON — caught in caller
}
```

**Step 2: Syntax check**

```bash
node --check /root/.openclaw/scripts/process-followups.js
```

---

## Task 7: Pass 2 — Notes follow-ups

**Files:**
- Modify: `scripts/process-followups.js` — replace `runNotesPass` with full implementation

**Step 1: Implement runNotesPass**

```javascript
const BATCH_SIZE    = 10;
const DEFAULT_WEEKS = 12; // ~3 months for vague intent

async function runNotesPass() {
  console.log('\n=== Pass 2: Contact Notes ===');

  const grouped = loadActionableNotes();
  let contacts  = Array.from(grouped.entries()); // [cid, { contact, notes }]

  if (LIMIT) {
    contacts = contacts.slice(0, LIMIT);
    console.log(`  (limited to ${LIMIT} contacts)`);
  }

  // Filter out contacts that already have an open reminder
  const toProcess = contacts.filter(([cid]) => !hasOpenReminder(cid));
  console.log(`  ${grouped.size} contacts with manual notes | ${toProcess.length} without open reminder`);

  let created = 0, skipped = 0, errors = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE).map(([cid, { contact, notes }]) => ({
      contact_id:   cid,
      contact_name: contact.name,
      notes,
    }));

    let results;
    try {
      results = await classifyNotesWithHaiku(batch);
    } catch (e) {
      console.warn(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${e.message}`);
      errors += batch.length;
      await sleep(2000);
      continue;
    }

    for (const r of results) {
      if (!r.action_needed) { skipped++; continue; }

      const entry   = grouped.get(String(r.contact_id));
      if (!entry)            { skipped++; continue; }

      const { contact } = entry;

      // Resolve fire_at — default to DEFAULT_WEEKS weeks from today if vague
      let fireAt = r.fire_at || null;
      if (!fireAt) fireAt = addDays(DEFAULT_WEEKS * 7);

      const note = `Follow-up from CRM notes: ${r.reason}`;

      createReminder({
        contactId:     String(r.contact_id),
        contactName:   contact.name,
        contactMobile: contact.mobile || null,
        note,
        fireAt,
        isTask:        false,
      });
      created++;
    }

    // Progress
    if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= toProcess.length) {
      process.stdout.write(`\r  Progress: ${Math.min(i + BATCH_SIZE, toProcess.length)}/${toProcess.length} | Created: ${created} | Skipped: ${skipped} | Errors: ${errors}`);
    }

    await sleep(500); // gentle rate limit
  }

  console.log(`\n  Created: ${created} | Skipped (no action): ${skipped} | Errors: ${errors}`);
}
```

**Step 2: Dry-run test with --limit to check Haiku is working**

```bash
node /root/.openclaw/scripts/process-followups.js --dry-run --skip-appraisals --limit 30
```
Expected:
- Prints 30 contacts being processed
- Prints `[dry] REMINDER` lines for the ones Haiku flagged
- No fatal errors

Check that Haiku is correctly filtering — majority of contacts should be skipped (generic notes), only real timing/intent ones create reminders.

**Step 3: Run appraisals in live mode first (safe — only 132 rows)**

```bash
node /root/.openclaw/scripts/process-followups.js --skip-notes
```
Expected: `Created: ~132` reminders.

Verify in DB:
```bash
node -e "const { db } = require('/root/.openclaw/lib/db.js'); const r = db.prepare('SELECT COUNT(*) as c FROM reminders').get(); console.log('Total reminders:', r.c);"
```
Expected: ~135 (132 new + the 3 that existed).

**Step 4: Run the full script live**

```bash
node /root/.openclaw/scripts/process-followups.js --skip-appraisals
```
This processes all ~6k contacts through Haiku in batches of 10. Will take several minutes. Watch for errors.

Final DB check:
```bash
node -e "
const { db } = require('/root/.openclaw/lib/db.js');
const total = db.prepare('SELECT COUNT(*) as c FROM reminders').get();
const tasks = db.prepare('SELECT COUNT(*) as c FROM reminders WHERE is_task=1').get();
const timed = db.prepare('SELECT COUNT(*) as c FROM reminders WHERE fire_at IS NOT NULL AND is_task=0').get();
const sample = db.prepare('SELECT contact_name, fire_at, note FROM reminders ORDER BY created_at DESC LIMIT 5').all();
console.log('Total reminders:', total.c, '| Tasks:', tasks.c, '| Timed:', timed.c);
sample.forEach(r => console.log(r.fire_at, r.contact_name, '|', r.note.slice(0,80)));
"
```

**Step 5: Commit**

```bash
cd /root/.openclaw
git add scripts/process-followups.js docs/plans/2026-03-01-process-followups.md docs/plans/2026-03-01-followup-processor-design.md
git commit -m "feat: add process-followups.js — appraisal + notes AI follow-up generator"
```

---

## Summary of What Gets Created

| Source | Count | Type | fire_at |
|---|---|---|---|
| Appraisals < 30 days | varies | reminder | +14 days |
| Appraisals 30–90 days | varies | reminder | +7 days |
| Appraisals 90–180 days | varies | reminder | +3 days |
| Appraisals > 180 days | varies | task (is_task=1) | null |
| Notes w/ timing signal | Haiku-determined | reminder | extracted date |
| Notes w/ vague intent | Haiku-determined | reminder | +12 weeks |
| Notes — no action | — | skipped | — |
