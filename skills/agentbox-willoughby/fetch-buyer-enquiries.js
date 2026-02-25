/**
 * fetch-buyer-enquiries.js
 *
 * Fetches buyer enquiries from AgentBox for Bailey O'Byrne's active listings
 * and saves them to SQLite buyers table.
 *
 * Usage:
 *   node fetch-buyer-enquiries.js              # normal run
 *   node fetch-buyer-enquiries.js --discover   # dump raw structures to debug
 *
 * How it works:
 *   1. Navigate to app.sales.reapit.com.au/contacts to capture Bearer token
 *   2. Navigate to admin master to capture x-api-key + x-csrf-token
 *   3. Scan last listing pages to find Bailey's active listings (McGrath Willoughby, Available)
 *   4. For each listing: fetch enquiries via admin proxy API (filter[listingId])
 *   5. For each enquiry: fetch detail (Bearer) to get contact ID, then fetch contact
 *   6. Save new buyers to SQLite
 *
 * Requires browser-state.json (from refetch-contacts-full.js session).
 */

require('dotenv').config({ path: '../../.env' });
const { chromium } = require('playwright');
const fs = require('fs');
const { db } = require('../../lib/db.js');

const STATEFILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const BASE_API  = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';
const ADMIN_API = '/mcgrathlovelocal/admin/api';
const DISCOVER  = process.argv.includes('--discover');

// ─── helpers ────────────────────────────────────────────────────────────────

function listingAddress(listing) {
  const a = (listing.property && listing.property.address) || listing.address || {};
  const streetAddress = a.streetAddress || `${a.streetNum || ''} ${a.streetName || ''} ${a.streetType || ''}`.trim();
  const suburb = a.suburb || '';
  if (streetAddress && suburb) return `${streetAddress}, ${suburb}`;
  if (streetAddress) return streetAddress;
  return a.displayAddress || a.fullAddress || `Listing ${listing.id}`;
}

function enqType(src) {
  if (!src) return 'other';
  const s = src.toLowerCase();
  if (s.includes('inspect')) return 'inspection';
  if (s.includes('online') || s.includes('portal') || s.includes('web')) return 'online_enquiry';
  if (s.includes('callback') || s.includes('call back')) return 'callback';
  return 'other';
}

// ─── main ───────────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security'],
  });

  const context = fs.existsSync(STATEFILE)
    ? await browser.newContext({ storageState: STATEFILE, bypassCSP: true })
    : await browser.newContext({ bypassCSP: true });

  const page = await context.newPage();

  // Capture both auth mechanisms simultaneously
  let authToken = null;
  let clientId  = null;
  let xApiKey   = null;
  let xCsrfToken = null;

  page.on('request', request => {
    const u = request.url();
    if (u.includes('api.agentboxcrm.com.au') && request.headers()['authorization']) {
      authToken = request.headers()['authorization'];
      clientId  = request.headers()['x-client-id'];
    }
    if (u.includes('/mcgrathlovelocal/admin/api/') && request.headers()['x-api-key']) {
      xApiKey    = request.headers()['x-api-key'];
      xCsrfToken = request.headers()['x-csrf-token'];
    }
  });

  // ── Step 1: Load contacts page to capture Bearer token ──────────────────
  console.log('🔑 Loading session…');
  await page.goto('https://app.sales.reapit.com.au/contacts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  if (page.url().includes('auth.au.rc.reapit.cloud')) {
    console.log('⚠️  Session expired — re-logging in…');
    await page.evaluate((creds) => {
      const u = document.querySelector('#signInFormUsername');
      const p = document.querySelector('#signInFormPassword');
      if (u && p) {
        u.value = creds.username;
        u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = creds.password;
        p.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('form')?.submit();
      }
    }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });
    await page.waitForURL('**/app.sales.reapit.com.au/**', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(5000);
    await context.storageState({ path: STATEFILE });
    console.log('✅ Re-login successful — session saved.');
  }

  if (!authToken) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
  }

  if (!authToken) {
    console.error('❌ Failed to capture Bearer token. Exiting.');
    await browser.close();
    return;
  }

  console.log('   Bearer token: ✓');

  // ── Step 2: Load admin master to capture x-api-key + x-csrf-token ───────
  console.log('   Loading admin session…');
  await page.goto('https://app.sales.reapit.com.au/mcgrathlovelocal/admin/master?iframe_in_react_app=1', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(6000);

  if (!xApiKey) {
    console.error('❌ Failed to capture admin API key. Exiting.');
    await browser.close();
    return;
  }
  console.log('   Admin API key:  ✓');
  await context.storageState({ path: STATEFILE });

  // ── Step 3: Find Bailey's active listings ────────────────────────────────
  console.log('\n📋 Scanning listings for McGrath Willoughby (Available)…');

  const pageCount = await page.evaluate(async ({ BASE_API, authToken, clientId }) => {
    const res = await fetch(`${BASE_API}/listings?limit=50&page=1&version=2`, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: authToken, 'x-client-id': clientId },
    });
    const data = await res.json();
    return parseInt(data?.response?.last || 1);
  }, { BASE_API, authToken, clientId });

  const scanFrom = Math.max(1, pageCount - 20);
  console.log(`   Scanning pages ${scanFrom}–${pageCount} (of ${pageCount} total)…`);

  const myListings = [];
  for (let p = scanFrom; p <= pageCount; p++) {
    const listings = await page.evaluate(async ({ BASE_API, authToken, clientId, p }) => {
      const res = await fetch(`${BASE_API}/listings?limit=50&page=${p}&version=2`, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: authToken, 'x-client-id': clientId },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.response?.listings || []).filter(l => {
        const mkt = (l.marketingStatus || l.status || '').toLowerCase();
        const isAvailable = mkt === 'available' || mkt === 'current';
        const isWilloughby = String(l.officeId || '') === '270' ||
          (l.officeName || '').toLowerCase().includes('willoughby');
        return isAvailable && isWilloughby;
      });
    }, { BASE_API, authToken, clientId, p });
    myListings.push(...listings);
  }

  if (myListings.length === 0) {
    console.warn('⚠️  No active listings found for McGrath Willoughby.');
    await browser.close();
    return;
  }

  console.log(`✅ Found ${myListings.length} active listing(s).`);

  // ── DISCOVER mode ────────────────────────────────────────────────────────
  if (DISCOVER) {
    const lid = String(myListings[0].id);
    const addr = listingAddress(myListings[0]);
    console.log(`\n─── DISCOVER: ${addr} (${lid}) ───`);

    const r = await page.evaluate(async ({ ADMIN_API, BASE_API, authToken, clientId, xApiKey, xCsrfToken, lid }) => {
      const adminH = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'x-api-key': xApiKey, 'x-csrf-token': xCsrfToken };
      const bearerH = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: authToken, 'x-client-id': clientId };

      const enqList = await fetch(`${ADMIN_API}/enquiries?filter[listingId]=${lid}&limit=5&page=1&version=2`, { credentials: 'include', headers: adminH });
      const enqData = await enqList.json();
      const enqs = enqData?.response?.enquiries || [];
      const firstEnq = enqs[0];

      let enqDetail = null, contact = null;
      if (firstEnq?.id) {
        const dr = await fetch(`${BASE_API}/enquiries/${firstEnq.id}?version=2`, { credentials: 'include', headers: bearerH });
        enqDetail = (await dr.json())?.response?.enquiry;
        if (enqDetail?.attachedContact?.id) {
          const cr = await fetch(`${BASE_API}/contacts/${enqDetail.attachedContact.id}?version=2`, { credentials: 'include', headers: bearerH });
          contact = (await cr.json())?.response?.contact;
        }
      }
      return { total: enqData?.response?.items, lastPage: enqData?.response?.last, enqKeys: enqs[0] ? Object.keys(enqs[0]) : [], firstEnq, enqDetail, contact };
    }, { ADMIN_API, BASE_API, authToken, clientId, xApiKey, xCsrfToken, lid });

    console.log(`Enquiries for this listing: ${r.total} (${r.lastPage} page(s))`);
    console.log('Enquiry list keys:', r.enqKeys.join(', '));
    console.log('\nFirst enquiry:', JSON.stringify(r.firstEnq, null, 2));
    console.log('\nEnquiry detail:', JSON.stringify(r.enqDetail, null, 2));
    console.log('\nContact:', JSON.stringify(r.contact, null, 2));
    await browser.close();
    return;
  }

  // ── Step 4: Fetch and save enquiries for each listing ────────────────────

  const existingSet = new Set(
    db.prepare("SELECT listing_agentbox_id || '|' || COALESCE(buyer_email,'') AS key FROM buyers")
      .all().map(r => r.key)
  );

  const insertBuyer = db.prepare(`
    INSERT INTO buyers
      (listing_address, listing_agentbox_id, buyer_name, buyer_mobile, buyer_email,
       enquiry_type, enquiry_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalNew = 0;
  let totalSkipped = 0;

  for (const listing of myListings) {
    const lid     = String(listing.id);
    const address = listingAddress(listing);
    console.log(`\n🏠 ${address} (${lid})`);

    // Fetch all enquiry pages via admin proxy API
    const enquiryIds = [];
    let enqLastPage = 1;

    for (let p = 1; p <= enqLastPage; p++) {
      const enqRaw = await page.evaluate(async ({ ADMIN_API, xApiKey, xCsrfToken, lid, p }) => {
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'x-api-key': xApiKey, 'x-csrf-token': xCsrfToken };
        const res = await fetch(`${ADMIN_API}/enquiries?filter[listingId]=${lid}&limit=50&page=${p}&version=2`, { credentials: 'include', headers });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        const resp = data?.response || {};
        return { ok: true, last: parseInt(resp.last || 1), total: resp.items || 0, ids: (resp.enquiries || []).map(e => e.id) };
      }, { ADMIN_API, xApiKey, xCsrfToken, lid, p });

      if (!enqRaw.ok) {
        console.log(`   ⚠️  Admin API returned ${enqRaw.status}`);
        break;
      }
      if (p === 1) {
        enqLastPage = enqRaw.last;
        console.log(`   ${enqRaw.total} enquirie(s) found across ${enqRaw.last} page(s).`);
      }
      enquiryIds.push(...enqRaw.ids);
    }

    if (enquiryIds.length === 0) continue;

    // Batch-fetch enquiry details (Bearer token) to get attachedContact.id
    const BATCH = 10;
    const contactIds = [];

    for (let i = 0; i < enquiryIds.length; i += BATCH) {
      const batch = enquiryIds.slice(i, i + BATCH);
      const details = await page.evaluate(async ({ BASE_API, authToken, clientId, ids }) => {
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: authToken, 'x-client-id': clientId };
        return Promise.all(ids.map(async id => {
          try {
            const res = await fetch(`${BASE_API}/enquiries/${id}?version=2`, { credentials: 'include', headers });
            const data = await res.json();
            const enq = data?.response?.enquiry || {};
            return {
              id,
              contactId: enq.attachedContact?.id || null,
              listingId: enq.attachedListing?.id || null,
              date: enq.date || enq.firstCreated || null,
              comment: enq.comment || null,
              type: enq.type || enq.origin || null,
            };
          } catch { return null; }
        }));
      }, { BASE_API, authToken, clientId, ids: batch });

      details.filter(Boolean).forEach(d => {
        if (d.contactId) contactIds.push({ ...d });
      });
    }

    // Batch-fetch contact details
    for (let i = 0; i < contactIds.length; i += BATCH) {
      const batch = contactIds.slice(i, i + BATCH);
      const contacts = await page.evaluate(async ({ BASE_API, authToken, clientId, items }) => {
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: authToken, 'x-client-id': clientId };
        return Promise.all(items.map(async item => {
          try {
            const res = await fetch(`${BASE_API}/contacts/${item.contactId}?version=2`, { credentials: 'include', headers });
            const data = await res.json();
            const c = data?.response?.contact || {};
            return { ...item, contact: c };
          } catch { return null; }
        }));
      }, { BASE_API, authToken, clientId, items: batch });

      for (const row of contacts.filter(Boolean)) {
        const c = row.contact;
        const firstName = c.firstName || '';
        const lastName  = c.lastName  || '';
        const name   = `${firstName} ${lastName}`.trim() || 'Unknown';
        const mobile = c.mobile || c.homePhone || c.workPhone || null;
        const email  = c.email  || null;
        const type   = enqType(row.type || '');
        const date   = row.date   || null;
        const notes  = row.comment || null;

        const key = `${lid}|${email || ''}`;
        if (existingSet.has(key)) { totalSkipped++; continue; }

        try {
          insertBuyer.run(address, lid, name, mobile, email, type, date, notes);
          existingSet.add(key);
          totalNew++;
        } catch (e) {
          console.warn(`   ⚠️  Insert failed for ${name}: ${e.message}`);
        }
      }
    }
  }

  console.log(`\n✅ Done. ${totalNew} new enquiries saved, ${totalSkipped} already existed.`);
  await browser.close();
})();
