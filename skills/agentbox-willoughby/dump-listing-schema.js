/**
 * dump-listing-schema.js
 * Fetches the full raw JSON for Bailey's first active listing and saves it.
 * Run: node dump-listing-schema.js
 */
require('dotenv').config({ path: '../../.env' });
const { chromium } = require('/usr/lib/node_modules/playwright');
const fs = require('fs');

const STATEFILE  = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const ADMIN_API  = '/mcgrathlovelocal/admin/api';
const BASE_API   = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';
const STAFF_ID   = '264stf0039'; // Bailey O'Byrne
const OUT        = '/tmp/listing-schema-dump.json';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security'],
  });
  const context = fs.existsSync(STATEFILE)
    ? await browser.newContext({ storageState: STATEFILE, bypassCSP: true })
    : await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();

  let authToken = null, clientId = null, xApiKey = null, xCsrfToken = null;
  page.on('request', req => {
    const u = req.url();
    if (u.includes('api.agentboxcrm.com.au') && req.headers()['authorization']) {
      authToken = req.headers()['authorization'];
      clientId  = req.headers()['x-client-id'];
    }
    if (u.includes('/mcgrathlovelocal/admin/api/') && req.headers()['x-api-key']) {
      xApiKey    = req.headers()['x-api-key'];
      xCsrfToken = req.headers()['x-csrf-token'];
    }
  });

  console.log('Loading session...');
  await page.goto('https://app.sales.reapit.com.au/contacts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);

  if (page.url().includes('auth.au.rc.reapit.cloud')) {
    console.log('Re-logging in...');
    await page.evaluate((creds) => {
      const u = document.querySelector('#signInFormUsername');
      const p = document.querySelector('#signInFormPassword');
      if (u && p) {
        u.value = creds.username; u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = creds.password; p.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('form')?.submit();
      }
    }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });
    await page.waitForURL('**/app.sales.reapit.com.au/**', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(6000);
    await context.storageState({ path: STATEFILE });
  }

  if (!authToken) { await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(6000); }

  // Load admin page to get x-api-key
  await page.goto('https://app.sales.reapit.com.au/mcgrathlovelocal/admin/master?iframe_in_react_app=1', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);

  if (!authToken || !xApiKey) {
    console.error('❌ Failed to capture tokens. authToken:', !!authToken, 'xApiKey:', !!xApiKey);
    await browser.close(); return;
  }
  console.log('✅ Tokens captured.');

  const result = await page.evaluate(async ({ BASE_API, ADMIN_API, authToken, clientId, xApiKey, xCsrfToken, STAFF_ID }) => {
    const bearerH = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: authToken, 'x-client-id': clientId };
    const adminH  = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'x-api-key': xApiKey, 'x-csrf-token': xCsrfToken };

    // Step 1: Find Bailey's active listings via admin API
    const listRes = await fetch(`${ADMIN_API}/listings?filter[staffId]=${STAFF_ID}&filter[marketingStatus]=Available&limit=10&page=1&version=2`, {
      credentials: 'include', headers: adminH
    });
    const listData = await listRes.json();
    const listings = listData?.response?.listings || [];
    if (!listings.length) return { error: 'No active listings found' };

    // Step 2: Fetch full detail for the first listing (Bearer API gives richer data)
    const firstId = listings[0].id;
    const detailRes = await fetch(`${BASE_API}/listings/${firstId}?version=2`, {
      credentials: 'include', headers: bearerH
    });
    const detailData = await detailRes.json();
    const fullListing = detailData?.response?.listing || detailData?.response || null;

    // Step 3: Fetch all listing IDs (summary) to show what we found
    const listingSummaries = listings.map(l => ({
      id: l.id,
      status: l.marketingStatus || l.status,
      address: l.property?.address?.streetAddress,
      suburb: l.property?.address?.suburb,
      price: l.displayPrice,
    }));

    return { fullListing, listingSummaries, firstId };
  }, { BASE_API, ADMIN_API, authToken, clientId, xApiKey, xCsrfToken, STAFF_ID });

  if (result.error) { console.error('Error:', result.error); await browser.close(); return; }

  const output = {
    activeListings: result.listingSummaries,
    fullDetailForFirstListing: result.fullListing,
    fetchedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved full schema dump to ${OUT}`);
  console.log(`\nActive listings found (${result.listingSummaries.length}):`);
  result.listingSummaries.forEach(l => console.log(`  ${l.id}  ${l.status}  ${l.address}, ${l.suburb}  ${l.price || '(no price)'}`));
  console.log(`\nFull detail keys for ${result.firstId}:`);
  console.log(Object.keys(result.fullListing || {}).join(', '));

  await browser.close();
})();
