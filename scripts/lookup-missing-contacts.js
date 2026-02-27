'use strict';
/**
 * lookup-missing-contacts.js
 * Two-phase contact enrichment:
 *  Phase 1: Fetch full details (address) for contacts already in the DB that
 *            have IDs but no address (e.g. imported from AgentBox without address).
 *  Phase 2: Search by mobile for contacts that aren't in the DB at all
 *            (complete misses from previous refetches).
 *
 * Usage: node /root/.openclaw/scripts/lookup-missing-contacts.js
 */
require('dotenv').config({ path: '/root/.openclaw/.env' });
const { chromium } = require('/root/.openclaw/skills/agentbox-willoughby/node_modules/playwright');
const fs   = require('fs');
const { db } = require('/root/.openclaw/lib/db.js');

const STATEFILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const BASE      = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';
const CONCUR    = 10;

// ── Phase 2 seed: known-missing contacts not in DB at all ────────────────────
// Add more here as needed (mobile numbers from AgentBox that search doesn't return)
const KNOWN_MISSING_MOBILES = [
  '0411 144 462', // Ian Hobson          — 5 Second Ave, Willoughby
  '0402 955 749', // Cathy Kell          — 5 Second Ave, Willoughby
  '0406 947 071', // Christopher Kell    — 5 Second Ave, Willoughby
  '0416 544 118', // Felicity Maher & Jason Salman — 5 Second Ave, Willoughby
  '0450 605 319', // Eamon Roles         — 1 Second Ave, Willoughby
  '0411 548 908', // Hans Gerber         — 17 Second Ave, Willoughby
  '0414 423 236', // Luke Silcock        — 18 Second Ave, Willoughby
  '0418 739 849', // David Bickerstaff   — 47 Second Ave, Willoughby East
  '0434 909 869', // Christopher Younger — 15a Second Ave, Willoughby East
];

const AREA_SUBURBS = new Set([
  'WILLOUGHBY', 'NORTH WILLOUGHBY', 'WILLOUGHBY EAST',
  'NAREMBURN', 'ARTARMON', 'CHATSWOOD', 'CASTLE COVE',
  'MIDDLE COVE', 'CASTLECRAG',
]);

function formatContact(c) {
  return {
    id:           String(c.id),
    name:         `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    mobile:       c.mobile || c.homePhone || c.workPhone || null,
    email:        c.email || null,
    address:      c.streetAddress?.address || c.address || null,
    suburb:       c.streetAddress?.suburb  || c.suburb  || null,
    state:        c.streetAddress?.state   || c.state   || 'NSW',
    postcode:     c.streetAddress?.postcode|| c.postcode|| null,
    contact_class: Array.isArray(c.contactClasses)
      ? c.contactClasses.filter(cc => cc.type === 'Standard').map(cc => cc.name).join(', ')
      : (c.contactClass || null),
    source:       c.source       || null,
    do_not_call:  (c.communicationRestrictions?.doNotCall) ? 1 : 0,
    last_modified:c.lastModified || null,
  };
}

async function fetchDetails(page, ids, authToken, clientId) {
  const results = [];
  for (let i = 0; i < ids.length; i += CONCUR) {
    const batch = ids.slice(i, i + CONCUR);
    const res = await page.evaluate(async ({ BASE, ids, authToken, clientId }) => {
      return Promise.all(ids.map(async id => {
        try {
          const r = await fetch(`${BASE}/contacts/${id}?version=2`, {
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'Authorization': authToken,
              'x-client-id': clientId,
            },
          });
          const d = await r.json();
          return d.response?.contact || null;
        } catch { return null; }
      }));
    }, { BASE, ids: batch, authToken, clientId });
    results.push(...res.filter(Boolean));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return results;
}

async function searchByMobile(page, mobiles, authToken, clientId) {
  const results = [];
  for (let i = 0; i < mobiles.length; i += CONCUR) {
    const batch = mobiles.slice(i, i + CONCUR);
    const res = await page.evaluate(async ({ BASE, mobiles, authToken, clientId }) => {
      return Promise.all(mobiles.map(async mobile => {
        try {
          const m = mobile.replace(/\s/g, '');
          const url = `${BASE}/contacts?filtermobile=${encodeURIComponent(m)}&limit=5&page=1&version=2`;
          const r = await fetch(url, {
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'Authorization': authToken,
              'x-client-id': clientId,
            },
          });
          const data = await r.json();
          const list = data.response?.contacts || [];
          if (list.length === 0) return null;
          // Fetch full detail for first match
          const det = await fetch(`${BASE}/contacts/${list[0].id}?version=2`, {
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'Authorization': authToken,
              'x-client-id': clientId,
            },
          });
          const d = await det.json();
          return d.response?.contact || null;
        } catch { return null; }
      }));
    }, { BASE, mobiles: batch, authToken, clientId });
    results.push(...res.filter(Boolean));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return results;
}

(async () => {
  // ── Load IDs-but-no-address contacts from DB ─────────────────────────────
  const noAddr = db.prepare(`
    SELECT id, name, mobile FROM contacts
    WHERE id NOT LIKE 'pf_%' AND mobile IS NOT NULL AND (address IS NULL OR address = '')
  `).all();
  console.log(`Phase 1: ${noAddr.length} contacts in DB have IDs but no address`);

  // ── Launch browser ────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security'],
  });
  const context = fs.existsSync(STATEFILE)
    ? await browser.newContext({ storageState: STATEFILE, bypassCSP: true })
    : await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();

  let authToken = null, clientId = null;
  page.on('request', req => {
    if (req.url().includes('api.agentboxcrm.com.au') && req.headers()['authorization']) {
      authToken = req.headers()['authorization'];
      clientId  = req.headers()['x-client-id'];
    }
  });

  await page.goto('https://app.sales.reapit.com.au/contacts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  if (page.url().includes('auth.au.rc.reapit.cloud')) {
    console.log('Session expired — re-logging in...');
    await page.evaluate((creds) => {
      const u = document.querySelector('#signInFormUsername');
      const p = document.querySelector('#signInFormPassword');
      if (u && p) {
        u.value = creds.username; u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = creds.password; p.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('form').submit();
      }
    }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });
    await page.waitForURL('**/app.sales.reapit.com.au/**', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(3000);
    await context.storageState({ path: STATEFILE });
    console.log('Re-login successful.');
  }

  await page.waitForTimeout(5000);
  if (!authToken) { await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(5000); }
  if (!authToken) {
    console.error('Could not capture auth token. Exiting.');
    await browser.close();
    process.exit(1);
  }
  console.log('Auth token captured.');

  // ── Phase 1: Enrich existing contacts with addresses ─────────────────────
  console.log('\nPhase 1: Fetching addresses for contacts-with-IDs-but-no-address...');
  const phase1IDs = noAddr.map(c => c.id);
  const phase1Details = await fetchDetails(page, phase1IDs, authToken, clientId);
  console.log(`Phase 1: Got details for ${phase1Details.length}/${phase1IDs.length} contacts`);

  // ── Phase 2: Search for completely-missing contacts by mobile ─────────────
  console.log('\nPhase 2: Searching for known-missing contacts by mobile...');
  // Filter out mobiles already in DB
  const existingMobiles = new Set(
    db.prepare("SELECT mobile FROM contacts WHERE mobile IS NOT NULL").all().map(r => r.mobile)
  );
  const mobilesToSearch = KNOWN_MISSING_MOBILES.filter(m => !existingMobiles.has(m));
  console.log(`Phase 2: ${mobilesToSearch.length} mobiles to search (${KNOWN_MISSING_MOBILES.length - mobilesToSearch.length} already in DB)`);
  const phase2Details = mobilesToSearch.length > 0
    ? await searchByMobile(page, mobilesToSearch, authToken, clientId)
    : [];
  console.log(`Phase 2: Got details for ${phase2Details.length}/${mobilesToSearch.length} contacts`);

  await browser.close();

  // ── Upsert all resolved contacts into DB ─────────────────────────────────
  const allDetails = [...phase1Details, ...phase2Details];
  if (allDetails.length === 0) {
    console.log('\nNo contact data retrieved.');
    return;
  }

  const updateAddr = db.prepare(`
    UPDATE contacts SET
      address       = @address,
      suburb        = COALESCE(suburb, @suburb),
      state         = COALESCE(state, @state),
      postcode      = COALESCE(postcode, @postcode),
      contact_class = COALESCE(contact_class, @contact_class),
      updated_at    = datetime('now')
    WHERE id = @id AND (address IS NULL OR address = '')
  `);

  const insertNew = db.prepare(`
    INSERT INTO contacts
      (id, name, mobile, email, address, suburb, state, postcode,
       contact_class, source, do_not_call, last_modified, updated_at)
    VALUES
      (@id, @name, @mobile, @email, @address, @suburb, @state, @postcode,
       @contact_class, @source, @do_not_call, @last_modified, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name          = excluded.name,
      mobile        = COALESCE(excluded.mobile, mobile),
      address       = COALESCE(excluded.address, address),
      suburb        = COALESCE(excluded.suburb, suburb),
      updated_at    = datetime('now')
  `);

  const run = db.transaction(() => {
    let updated = 0, inserted = 0;
    for (const c of allDetails) {
      const fmt = formatContact(c);
      if (!fmt.id || !fmt.name) continue;
      const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(fmt.id);
      if (existing) {
        const r = updateAddr.run(fmt);
        if (r.changes > 0) updated++;
      } else if (fmt.suburb && AREA_SUBURBS.has((fmt.suburb || '').toUpperCase().trim())) {
        insertNew.run({ ...fmt, email: null, source: fmt.source });
        inserted++;
      }
    }
    return { updated, inserted };
  });

  const { updated, inserted } = run();
  console.log(`\nDB: updated ${updated} contact addresses, inserted ${inserted} new contacts.`);

  // ── Re-link properties for newly-addressed contacts ───────────────────────
  const linkResult = db.prepare(`
    UPDATE properties SET contact_id = (
      SELECT c.id FROM contacts c
      WHERE (
        LOWER(c.address) LIKE LOWER(properties.street_number) || ' ' || LOWER(properties.street_name) || '%'
        OR LOWER(c.address) LIKE '% ' || LOWER(properties.street_number) || ' ' || LOWER(properties.street_name) || '%'
        OR LOWER(c.address) LIKE LOWER(properties.street_number) || '/' || LOWER(properties.street_name) || '%'
        OR LOWER(c.address) LIKE '% ' || LOWER(properties.street_number) || '/' || LOWER(properties.street_name) || '%'
      )
      AND (LOWER(COALESCE(c.suburb,'')) LIKE '%willoughby%' OR LOWER(COALESCE(properties.suburb,'')) LIKE '%willoughby%')
      AND c.id NOT LIKE 'pf_%'
      ORDER BY c.id
      LIMIT 1
    )
    WHERE contact_id IS NULL
      AND street_number IS NOT NULL
      AND street_number NOT LIKE '%-%'
      AND street_name IS NOT NULL
  `).run();
  console.log(`Re-linked ${linkResult.changes} properties.`);
  console.log('\n✅ Done!');
})();
