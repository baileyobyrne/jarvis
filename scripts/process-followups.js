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

// System-generated note patterns to exclude (case-insensitive prefix/contains match)
const NOISE_PATTERNS = [
  /^MDT\s*[-–]/i,
  /conflicting contact details/i,
  /duplicate contact detected/i,
  /contact pre-import modifications/i,
  /contact categories notes/i,
  /original mobile.*myportfolio/i,
  /duplicate email.*mobile.*detected/i,
];

function isNoise(note) {
  return NOISE_PATTERNS.some(re => re.test(note));
}

/**
 * Loads manual/agent notes grouped by contact_id.
 * Returns Map<contactId, { contact, notes: string[] }>
 */
function loadActionableNotes() {
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

const HAIKU_SYSTEM = `You are analyzing real estate CRM notes written by agents about their contacts.
Today's date is ${TODAY}.

These notes are from a McGrath real estate office. The agents you are helping are Bailey O'Byrne and Jason Georges.

For each contact, review the note history and return a JSON array with one object per contact:
{
  "contact_id": "<id>",
  "action_needed": true|false,
  "fire_at": "<YYYY-MM-DD>"|null,
  "reason": "<one sentence>"
}

ONLY set action_needed=true if the notes indicate at least ONE of the following:
1. A direct interaction with Bailey O'Byrne or Jason Georges (e.g. they spoke to, visited, or sent something to this contact)
2. The contact has expressed interest in selling, listing, or getting an appraisal — now or in the future
3. The contact is an active buyer looking for property in the area
4. There is a genuine referral or lead opportunity (e.g. someone who knows a seller, a vendor referred by another agent)
5. A specific follow-up was mentioned or implied in the notes (e.g. "follow up", "call back", "check in")

Set action_needed=false for everything else, including:
- "no plans", "not interested", "going with another agency", "never selling", "happy where they are"
- Notes about other agents' deals or activities with no relevance to Bailey/Jason
- Generic prospecting mass-notes with no personal context or interaction
- Administrative/import notes

fire_at rules:
- Extract explicit dates: "ANZAC Day" → "${new Date().getFullYear()}-04-25", "after school term" → next July 1st
- Relative timing: "2 years" → add 2 years to today, "6 months" → add 6 months, "next year" → Jan 1 next year
- Vague intent (no timing): null (caller will default to 3 months)
- No valid follow-up: null

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
    const apDate    = new Date(ap.appraisal_date);
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

    // Build a Set of contact_ids that Haiku flagged as action_needed
    // (Haiku may omit contacts entirely instead of returning action_needed=false)
    const actionSet = new Set(
      results.filter(r => r.action_needed).map(r => String(r.contact_id))
    );
    const resultMap = new Map(results.map(r => [String(r.contact_id), r]));

    for (const b of batch) {
      const cid = String(b.contact_id);
      if (!actionSet.has(cid)) { skipped++; continue; }

      const r     = resultMap.get(cid);
      const entry = grouped.get(cid);
      if (!entry) { skipped++; continue; }

      const { contact } = entry;

      // Resolve fire_at — default to DEFAULT_WEEKS weeks from today if vague
      let fireAt = r.fire_at || null;
      if (!fireAt) fireAt = addDays(DEFAULT_WEEKS * 7);

      const note = `Follow-up from CRM notes: ${r.reason}`;

      createReminder({
        contactId:     cid,
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

console.log(`process-followups starting [${DRY_RUN ? 'DRY RUN' : 'LIVE'}]`);

(async () => {
  if (!SKIP_APPRAISALS) await runAppraisalsPass();
  if (!SKIP_NOTES)      await runNotesPass();
  console.log('\nAll done.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
