'use strict';
/**
 * sync-agentbox-activities.js
 * Backfills AgentBox contact notes into the contact_notes table.
 *
 * API discovery results:
 *   - Notes endpoint: GET /notes?filter[contactId]={id}&limit=50&version=2
 *   - Note text field: `headline`
 *   - Date fields: `date` (event date), `firstCreated` (system creation date)
 *   - Approach: iterate over all contacts in jarvis.db, fetch notes per contact,
 *     filter by firstCreated >= SINCE_DATE
 *
 * Usage: node /root/.openclaw/scripts/sync-agentbox-activities.js
 *        node /root/.openclaw/scripts/sync-agentbox-activities.js --dry-run
 *        node /root/.openclaw/scripts/sync-agentbox-activities.js --dry-run --limit 20
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '/home/claude/.cache/ms-playwright';
require('/root/.openclaw/skills/agentbox-willoughby/node_modules/dotenv').config({ path: '/root/.openclaw/.env', override: true });
const { chromium } = require('/root/.openclaw/skills/agentbox-willoughby/node_modules/playwright');
const fs   = require('fs');
const { db } = require('/root/.openclaw/lib/db.js');

const STATEFILE   = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const BASE        = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';
const SINCE       = '2025-05-01';
const PAGE_SIZE   = 50;
const DELAY_MS    = 1100;
const DRY_RUN     = process.argv.includes('--dry-run');
const limitArgIdx = process.argv.indexOf('--limit');
const CONTACT_LIMIT = limitArgIdx > -1 ? parseInt(process.argv[limitArgIdx + 1]) : null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function captureBearer() {
  const browser = await chromium.launch({
    executablePath: '/opt/google/chrome/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = fs.existsSync(STATEFILE)
    ? await browser.newContext({ storageState: STATEFILE, bypassCSP: true })
    : await browser.newContext({ bypassCSP: true });
  const page = await ctx.newPage();
  let bearer = null, clientId = null;

  page.on('request', request => {
    if (request.url().includes('agentboxcrm.com.au') && request.headers()['authorization']) {
      bearer = request.headers()['authorization'];
      clientId = request.headers()['x-client-id'];
    }
  });

  await page.goto('https://app.sales.reapit.com.au/contacts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  if (page.url().includes('auth.au.rc.reapit.cloud')) {
    console.log('Session expired — re-logging in...');
    await page.evaluate((creds) => {
      const u = document.querySelector('#signInFormUsername');
      const p = document.querySelector('#signInFormPassword');
      const f = document.querySelector('form');
      if (u && p) {
        u.value = creds.username;
        u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = creds.password;
        p.dispatchEvent(new Event('input', { bubbles: true }));
        f.submit();
      }
    }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });
    await page.waitForURL('**/app.sales.reapit.com.au/**', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(5000);
    await ctx.storageState({ path: STATEFILE });
    console.log('Re-login successful.');
  }

  if (!bearer) {
    await page.waitForTimeout(5000);
  }
  if (!bearer) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
  }
  await browser.close();
  if (!bearer) throw new Error('Failed to capture bearer token — session expired. Re-run refetch-contacts-full.js first.');
  return { bearer, clientId };
}

const insertNote = db.prepare(
  'INSERT OR IGNORE INTO contact_notes (contact_id, note, created_at) VALUES (?, ?, ?)'
);

// Check if a note already exists (for dry-run counting)
const noteExists = db.prepare(
  'SELECT id FROM contact_notes WHERE contact_id = ? AND note = ? AND created_at = ?'
);

(async () => {
  console.log(`Activities sync — since ${SINCE}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const { bearer, clientId } = await captureBearer();
  console.log('Bearer captured.');

  const headers = { Authorization: bearer };
  if (clientId) headers['x-client-id'] = clientId;

  // Load all contacts from jarvis.db
  let contacts = db.prepare('SELECT id FROM contacts WHERE id IS NOT NULL').all();
  if (CONTACT_LIMIT) {
    contacts = contacts.slice(0, CONTACT_LIMIT);
    console.log(`Processing ${contacts.length} contacts (limited to ${CONTACT_LIMIT})...`);
  } else {
    console.log(`Processing ${contacts.length} contacts...`);
  }

  let total = 0, inserted = 0, skipped = 0, errors = 0;
  let contactsWithNotes = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contactId = contacts[i].id;
    let pageNum = 1;
    let contactNoteCount = 0;

    while (true) {
      const url = `${BASE}/notes?filter[contactId]=${contactId}&filter[firstCreated][gte]=${SINCE}&limit=${PAGE_SIZE}&page=${pageNum}&version=2`;
      let data;
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          if (res.status === 404) break; // Contact not found in AgentBox — skip
          errors++;
          break;
        }
        data = await res.json();
      } catch (e) {
        errors++;
        break;
      }

      const notes = data.response?.notes || [];
      if (notes.length === 0) break;

      for (const note of notes) {
        total++;
        const noteText  = (note.headline || '').trim();
        const createdAt = note.firstCreated || note.date || new Date().toISOString();

        if (!noteText) { skipped++; continue; }

        if (DRY_RUN) {
          const exists = noteExists.get(String(contactId), noteText, createdAt);
          if (!exists) {
            inserted++;
            contactNoteCount++;
            if (inserted <= 10) {
              console.log(`  [dry] contact=${contactId} note="${noteText.slice(0, 60)}"...`);
            }
          } else {
            skipped++;
          }
        } else {
          const before = db.prepare('SELECT changes()').get();
          insertNote.run(String(contactId), noteText, createdAt);
          const after = db.prepare('SELECT changes() as c').get();
          if (after.c > 0) { inserted++; contactNoteCount++; }
          else skipped++;
        }
      }

      const lastPage = parseInt(data.response?.last || '1');
      if (pageNum >= lastPage || notes.length < PAGE_SIZE) break;
      pageNum++;
      await sleep(DELAY_MS);
    }

    if (contactNoteCount > 0) contactsWithNotes++;

    // Rate limiting: delay between contacts
    if ((i + 1) % 50 === 0) {
      process.stdout.write(`\r  Progress: ${i + 1}/${contacts.length} contacts | Inserted: ${inserted} | Contacts with notes: ${contactsWithNotes}`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n\nDone.`);
  console.log(`  Total notes seen: ${total}`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (empty/duplicate): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Contacts with new notes: ${contactsWithNotes}`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
