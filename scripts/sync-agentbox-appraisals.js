'use strict';
/**
 * sync-agentbox-appraisals.js
 * Imports appraisals from AgentBox into the `appraisals` table.
 *
 * API discovery results:
 *   - Appraisals are stored as listings with status=Appraisal
 *   - Endpoint: GET /listings?filter[status]=Appraisal&filter[suburb]={suburb}&limit=50&version=2
 *   - Staff filter (filter[staffId]) is BROKEN — returns all listings
 *   - Use officeName === 'McGrath Willoughby' as the Bailey/Jason proxy
 *   - Listing fields: id, property.address, property.category, property.bedrooms,
 *     property.bathrooms, firstCreated, lastModified, officeName
 *   - No contact_id available in listing response
 *
 * Usage: node /root/.openclaw/scripts/sync-agentbox-appraisals.js
 *        node /root/.openclaw/scripts/sync-agentbox-appraisals.js --dry-run
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '/home/claude/.cache/ms-playwright';
require('/root/.openclaw/skills/agentbox-willoughby/node_modules/dotenv').config({ path: '/root/.openclaw/.env', override: true });
const { chromium } = require('/root/.openclaw/skills/agentbox-willoughby/node_modules/playwright');
const fs   = require('fs');
const { db } = require('/root/.openclaw/lib/db.js');

const STATEFILE   = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const BASE        = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';
const SINCE_DATE  = '2025-01-01';
const PAGE_SIZE   = 50;
const DELAY_MS    = 1100;
const DRY_RUN     = process.argv.includes('--dry-run');

// Suburbs to import appraisals for
const SUBURB_FILTER = ['Willoughby', 'North Willoughby', 'Willoughby East'];

// Only import appraisals from McGrath Willoughby office
// (filter[staffId] is broken — officeName is the reliable proxy for Bailey/Jason's team)
const OFFICE_FILTER = 'McGrath Willoughby';

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

  if (!bearer) { await page.waitForTimeout(5000); }
  if (!bearer) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
  }
  await browser.close();
  if (!bearer) throw new Error('Failed to capture bearer token — session expired.');
  return { bearer, clientId };
}

const upsertAppraisal = db.prepare(`
  INSERT OR REPLACE INTO appraisals
    (agentbox_id, contact_id, address, suburb, appraisal_date, status,
     booked_by, beds, baths, property_type, price_estimate, notes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

(async () => {
  console.log(`Appraisals sync — since ${SINCE_DATE}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`Suburbs: ${SUBURB_FILTER.join(', ')}`);
  console.log(`Office filter: ${OFFICE_FILTER}`);

  const { bearer, clientId } = await captureBearer();
  console.log('Bearer captured.');

  const headers = { Authorization: bearer };
  if (clientId) headers['x-client-id'] = clientId;

  let totalFetched = 0, totalInserted = 0, officeFiltered = 0, dateFiltered = 0;

  for (const suburb of SUBURB_FILTER) {
    console.log(`\nFetching appraisals for: ${suburb}...`);
    let pageNum = 1;
    let suburbInserted = 0;

    while (true) {
      const url = `${BASE}/listings?filter[status]=Appraisal&filter[suburb]=${encodeURIComponent(suburb)}&limit=${PAGE_SIZE}&page=${pageNum}&version=2`;
      let data;
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) { console.error(`  API ${res.status} on page ${pageNum}`); break; }
        data = await res.json();
      } catch (e) {
        console.error(`  Fetch error: ${e.message}`);
        break;
      }

      const listings = data.response?.listings || [];
      const lastPage  = parseInt(data.response?.last || '1');

      if (pageNum === 1) {
        console.log(`  Total in AgentBox: ${data.response?.items}`);
      }

      if (listings.length === 0) break;

      for (const listing of listings) {
        totalFetched++;

        // Filter by office (staff filter is broken)
        if (listing.officeName !== OFFICE_FILTER) {
          officeFiltered++;
          continue;
        }

        // Filter by date (use lastModified as the recency proxy)
        const appraisalDate = listing.lastModified || listing.firstCreated || '';
        if (appraisalDate && appraisalDate < SINCE_DATE) {
          dateFiltered++;
          continue;
        }

        const agentboxId   = listing.id;
        const prop         = listing.property || {};
        const addr         = prop.address || {};
        const streetAddr   = addr.streetAddress || '';
        const propSuburb   = addr.suburb || suburb;
        const propertyType = prop.category || prop.type || '';
        const beds         = String(prop.bedrooms || '');
        const baths        = String(prop.bathrooms || '');
        const priceEst     = listing.displayPrice || listing.searchPrice || '';
        const notes        = listing.mainHeadline || '';
        const status       = 'active';
        // booked_by: use officeName as proxy since no per-agent data available
        const bookedBy     = listing.officeName || '';

        if (DRY_RUN) {
          console.log(`  [dry] ${agentboxId} | ${streetAddr}, ${propSuburb} | ${propertyType} ${beds}bed | ${appraisalDate.slice(0, 10)}`);
          suburbInserted++;
          totalInserted++;
        } else {
          upsertAppraisal.run(
            agentboxId,
            null,        // contact_id: not available in listing response
            streetAddr,
            propSuburb,
            appraisalDate,
            status,
            bookedBy,
            beds,
            baths,
            propertyType,
            priceEst,
            notes
          );
          suburbInserted++;
          totalInserted++;
        }
      }

      console.log(`  Page ${pageNum}/${lastPage}: ${listings.length} fetched | suburb inserted: ${suburbInserted}`);
      if (pageNum >= lastPage || listings.length < PAGE_SIZE) break;
      pageNum++;
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Total fetched: ${totalFetched}`);
  console.log(`  Inserted/updated: ${totalInserted}`);
  console.log(`  Filtered (wrong office): ${officeFiltered}`);
  console.log(`  Filtered (before ${SINCE_DATE}): ${dateFiltered}`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
