/**
 * fetch-buyer-enquiries.js (v3 — hybrid fast)
 *
 * Fetches buyer enquiries for Bailey O'Byrne's listings and saves to SQLite.
 *
 * Architecture:
 *   - Browser (Playwright) handles ONLY the admin API (enquiry ID lists).
 *     The admin API session is tied to the live browser context.
 *   - Node.js native fetch handles ALL Bearer API calls (enquiry details +
 *     contacts). These run in parallel and are much faster than page.evaluate.
 *   - All 5 listings have their enquiry IDs collected up-front, then all
 *     detail/contact fetching happens in parallel across listings.
 *
 * Usage:
 *   node fetch-buyer-enquiries.js          # fast: page 1 only (50 most recent per listing)
 *   node fetch-buyer-enquiries.js --full   # deep backfill: all pages (slow, first run only)
 */

require('dotenv').config({ path: '../../.env' });
const { chromium } = require('playwright');
const fs   = require('fs');
const { db } = require('../../lib/db.js');

const STATEFILE  = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const BEARER_API = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';
const ADMIN_API  = '/mcgrathlovelocal/admin/api'; // relative — used in page.evaluate
const FULL_SYNC  = process.argv.includes('--full'); // paginate all pages when true

// Bailey's confirmed active listings. Update manually when listings change.
// To find IDs: app.sales.reapit.com.au/properties → All My Properties →
//   View My Listings → Refine → Assigned Staff: Bailey O'Byrne.
const BAILEY_LISTING_IDS = [
  '264P23772', // 85 Sydney Street, Willoughby
  '264P31107', // 26/166 Mowbray Road, Willoughby
  '264P21442', // 15A Second Avenue, Willoughby
  '264P23657', // 24 Waratah Street, Roseville
  '264P31230', // 206/72 Laurel Street, Willoughby
];

// ─── helpers ────────────────────────────────────────────────────────────────

function enqType(src) {
  if (!src) return 'other';
  const s = src.toLowerCase();
  if (s.includes('inspect') || s.includes('online') || s.includes('portal') || s.includes('web')) return 'online_enquiry';
  if (s.includes('callback') || s.includes('call back')) return 'callback';
  return 'other';
}

// Bearer API: called directly from Node.js — no browser overhead
async function bearerGet(path, auth) {
  const res = await fetch(`${BEARER_API}${path}`, {
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Authorization: auth.bearerToken,
      'x-client-id': auth.clientId,
    },
  });
  if (!res.ok) {
    const err = new Error(`Bearer API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ─── DB statements ───────────────────────────────────────────────────────────

const upsertListing = db.prepare(`
  INSERT INTO listing_details
    (agentbox_id, address, suburb, beds, baths, cars,
     land_area, building_area, category, price_guide, method,
     auction_date, headline, description, features,
     council_rates, water_rates, strata_admin, strata_sinking, strata_total,
     web_link, listing_status, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
  ON CONFLICT(agentbox_id) DO UPDATE SET
    address=excluded.address, suburb=excluded.suburb,
    beds=excluded.beds, baths=excluded.baths, cars=excluded.cars,
    land_area=excluded.land_area, building_area=excluded.building_area,
    category=excluded.category, price_guide=excluded.price_guide,
    method=excluded.method, auction_date=excluded.auction_date,
    headline=excluded.headline, description=excluded.description,
    features=excluded.features,
    council_rates=excluded.council_rates, water_rates=excluded.water_rates,
    strata_admin=excluded.strata_admin, strata_sinking=excluded.strata_sinking,
    strata_total=excluded.strata_total, web_link=excluded.web_link,
    listing_status=excluded.listing_status,
    updated_at=datetime('now','localtime')
`);

const insertBuyer = db.prepare(`
  INSERT INTO buyers
    (listing_address, listing_agentbox_id, buyer_name, buyer_mobile, buyer_email,
     enquiry_type, enquiry_date, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── main ───────────────────────────────────────────────────────────────────

(async () => {
  const t0 = Date.now();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = fs.existsSync(STATEFILE)
    ? await browser.newContext({ storageState: STATEFILE, bypassCSP: true })
    : await browser.newContext({ bypassCSP: true });

  const page = await context.newPage();

  // Capture both auth tokens
  let bearerToken = null, clientId = null, xApiKey = null, xCsrfToken = null;

  page.on('request', req => {
    const u = req.url();
    if (u.includes('api.agentboxcrm.com.au') && req.headers()['authorization']) {
      bearerToken = req.headers()['authorization'];
      clientId    = req.headers()['x-client-id'];
    }
    if (u.includes('/mcgrathlovelocal/admin/api/') && req.headers()['x-api-key']) {
      xApiKey    = req.headers()['x-api-key'];
      xCsrfToken = req.headers()['x-csrf-token'];
    }
  });

  // ── Step 1: Capture Bearer token ──────────────────────────────────────────
  console.log('🔑 Loading session…');
  await page.goto('https://app.sales.reapit.com.au/contacts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  if (page.url().includes('auth.au.rc.reapit.cloud')) {
    console.log('   Session expired — re-logging in…');
    await page.evaluate((c) => {
      const u = document.querySelector('#signInFormUsername');
      const p = document.querySelector('#signInFormPassword');
      if (u && p) {
        u.value = c.username; u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = c.password; p.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('form')?.submit();
      }
    }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });
    await page.waitForURL('**/app.sales.reapit.com.au/**', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(4000);
    await context.storageState({ path: STATEFILE });
  }

  if (!bearerToken) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);
  }

  if (!bearerToken) {
    console.error('❌ Failed to capture Bearer token.');
    await browser.close();
    process.exit(1);
  }
  console.log('   Bearer: ✓');

  // ── Step 2: Capture admin tokens ──────────────────────────────────────────
  await page.goto('https://app.sales.reapit.com.au/mcgrathlovelocal/admin/master?iframe_in_react_app=1', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(5000);

  if (!xApiKey) {
    console.error('❌ Failed to capture admin API key.');
    await browser.close();
    process.exit(1);
  }
  console.log('   Admin key: ✓');
  await context.storageState({ path: STATEFILE });

  const auth = { bearerToken, clientId, xApiKey, xCsrfToken };

  // ── Step 3: Upsert listing details via Bearer API (from Node.js, parallel) ─
  console.log('\n📐 Upserting listing details…');
  await Promise.all(BAILEY_LISTING_IDS.map(async lid => {
    try {
      const data = await bearerGet(`/listings/${lid}?version=2`, auth);
      const detail = data?.response?.listing;
      if (!detail) return;
      const p = detail.property || {}, o = detail.outgoings || {}, addr = p.address || {};
      const fmt = (obj) => obj?.value ? `${obj.value} / ${obj.period || 'year'}` : '';
      upsertListing.run(
        lid, addr.streetAddress || lid, addr.suburb || '',
        p.bedrooms || '', p.bathrooms || '', p.totalParking || p.carSpaces || '',
        p.landArea?.value ? `${p.landArea.value} ${p.landArea.unit || 'sqm'}`.trim() : '',
        p.buildingArea?.value ? `${p.buildingArea.value} ${p.buildingArea.unit || 'sqm'}`.trim() : '',
        p.category || '', detail.displayPrice || '', detail.method || '',
        detail.auctionDate || '', detail.mainHeadline || '', detail.mainDescription || '',
        JSON.stringify(Array.isArray(p.features) ? p.features : []),
        fmt(o.councilRates), fmt(o.waterRates),
        fmt(o.strataAdmin), fmt(o.strataSinking), fmt(o.strataTotal),
        detail.webLink || '', 'active',
      );
      console.log(`   ✓ ${addr.streetAddress || lid}`);
    } catch (e) {
      console.log(`   ⚠️  ${lid}: ${e.message}`);
    }
  }));

  // Build address map for buyer insert
  const addrMap = {};
  BAILEY_LISTING_IDS.forEach(lid => {
    const row = db.prepare('SELECT address, suburb FROM listing_details WHERE agentbox_id = ?').get(lid);
    addrMap[lid] = row ? `${row.address}, ${row.suburb}`.replace(/, *$/, '') : lid;
  });

  // ── Step 4: Collect enquiry IDs via admin API (browser, all listings parallel) ─
  // Admin API requires the live browser session — page.evaluate is the only way.
  // All listings fetched in ONE page.evaluate call to avoid per-call browser overhead.
  // Default: page 1 only (50 most recent). Pass --full to paginate all pages.
  console.log(`\n📋 Collecting enquiry IDs${FULL_SYNC ? ' (all pages — full sync)' : ' (page 1 only, parallel)'}…`);

  const rawResults = await page.evaluate(async ({ ADMIN_API, xApiKey, xCsrfToken, listingIds, fullSync }) => {
    const headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'x-api-key': xApiKey,
      'x-csrf-token': xCsrfToken,
    };

    async function fetchPage(lid, p) {
      const res = await fetch(`${ADMIN_API}/enquiries?filter[listingId]=${lid}&limit=50&page=${p}&version=2`, {
        credentials: 'include', headers,
      });
      if (!res.ok) return { ok: false, status: res.status, lid, p };
      const data = await res.json();
      const resp = data?.response || {};
      return { ok: true, lid, p, last: parseInt(resp.last || 1), total: resp.items || 0, ids: (resp.enquiries || []).map(e => String(e.id)) };
    }

    // Fetch page 1 for all listings in parallel
    const page1Results = await Promise.all(listingIds.map(lid => fetchPage(lid, 1)));

    if (!fullSync) return page1Results;

    // --full: fetch remaining pages for listings that have more than 1 page
    const extraFetches = [];
    for (const r of page1Results) {
      if (r.ok && r.last > 1) {
        for (let p = 2; p <= r.last; p++) extraFetches.push(fetchPage(r.lid, p));
      }
    }
    const extraResults = await Promise.all(extraFetches);
    return [...page1Results, ...extraResults];
  }, { ADMIN_API, xApiKey, xCsrfToken, listingIds: BAILEY_LISTING_IDS, fullSync: FULL_SYNC });

  // Merge results by listing
  const enquiryIdsByListing = {};
  for (const r of rawResults) {
    if (!r.ok) { console.log(`   ⚠️  ${r.lid} page ${r.p}: admin API ${r.status}`); continue; }
    if (r.p === 1) {
      const pageNote = FULL_SYNC ? `${r.last} page(s)` : `page 1 of ${r.last}`;
      console.log(`   ${r.lid}: ${r.total} total enquiries (fetching ${pageNote})`);
      enquiryIdsByListing[r.lid] = [];
    }
    enquiryIdsByListing[r.lid].push(...r.ids);
  }

  // Browser is no longer needed — close it now
  await browser.close();
  console.log('   Browser closed ✓');

  // ── Step 5: Fetch enquiry details + contacts via Node.js (parallel) ────────
  console.log('\n📬 Fetching enquiry details and contacts (parallel)…');

  const existingKeys = new Set(
    db.prepare("SELECT listing_agentbox_id || '|' || COALESCE(buyer_email,'') AS k FROM buyers")
      .all().map(r => r.k)
  );

  // Count existing buyers per listing for early-exit check
  const existingCountByListing = {};
  BAILEY_LISTING_IDS.forEach(lid => {
    existingCountByListing[lid] = db.prepare('SELECT COUNT(*) AS c FROM buyers WHERE listing_agentbox_id = ?').get(lid)?.c || 0;
  });

  const BATCH = 20; // parallel fetch size
  let totalNew = 0, totalSkipped = 0;

  for (const lid of BAILEY_LISTING_IDS) {
    const enquiryIds = enquiryIdsByListing[lid] || [];
    if (enquiryIds.length === 0) continue;

    // Skip bearer calls entirely if we already have at least as many buyers as IDs fetched
    // (means page 1 is fully cached — no new enquiries on this listing)
    if (!FULL_SYNC && existingCountByListing[lid] >= enquiryIds.length) {
      console.log(`   ${lid} (${addrMap[lid]}): skipped — already up to date`);
      continue;
    }

    // Fetch all enquiry details in parallel batches
    const enriched = [];
    for (let i = 0; i < enquiryIds.length; i += BATCH) {
      const batch = enquiryIds.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async id => {
        try {
          const d = await bearerGet(`/enquiries/${id}?version=2`, auth);
          const enq = d?.response?.enquiry || {};
          return {
            id,
            contactId: enq.attachedContact?.id || null,
            date: enq.date || enq.firstCreated || null,
            comment: enq.comment || null,
            type: enq.type || enq.origin || null,
          };
        } catch { return null; }
      }));
      enriched.push(...results.filter(Boolean).filter(r => r.contactId));
    }

    // Fetch all contacts in parallel batches
    let newCount = 0, skipped = 0;
    for (let i = 0; i < enriched.length; i += BATCH) {
      const batch = enriched.slice(i, i + BATCH);
      const contacts = await Promise.all(batch.map(async item => {
        try {
          const d = await bearerGet(`/contacts/${item.contactId}?version=2`, auth);
          return { ...item, contact: d?.response?.contact || {} };
        } catch { return null; }
      }));

      for (const row of contacts.filter(Boolean)) {
        const c = row.contact;
        const name  = `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown';
        const mobile = c.mobile || c.homePhone || c.workPhone || null;
        const email  = c.email || null;
        const key    = `${lid}|${email || ''}`;

        if (existingKeys.has(key)) { skipped++; continue; }

        try {
          insertBuyer.run(addrMap[lid], lid, name, mobile, email, enqType(row.type || ''), row.date || null, row.comment || null);
          existingKeys.add(key);
          newCount++;
        } catch (e) {
          console.warn(`   ⚠️  Insert failed (${name}): ${e.message}`);
        }
      }
    }

    console.log(`   ${lid} (${addrMap[lid]}): +${newCount} new, ${skipped} already existed`);
    totalNew     += newCount;
    totalSkipped += skipped;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s — ${totalNew} new buyers saved, ${totalSkipped} skipped.`);
})();
