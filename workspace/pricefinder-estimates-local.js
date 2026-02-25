'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// pricefinder-estimates-local.js
// Run this on your LOCAL MACHINE (Mac/PC) — not the VPS.
// It fetches today's contacts from the JARVIS API, looks up Pricefinder
// estimates, and POSTs each result back.
//
// Setup (one-time):
//   npm install playwright axios dotenv
//   npx playwright install chromium
//
// .env (same directory as this script):
//   PRICEFINDER_USER=your-pricefinder-email@example.com
//   PRICEFINDER_PASS=your-pricefinder-password
//   JARVIS_API_URL=https://72.62.74.105:4242
//   JARVIS_API_KEY=<your-DASHBOARD_PASSWORD>
//
// Usage:
//   node pricefinder-estimates-local.js           # all of today's contacts missing estimates
//   node pricefinder-estimates-local.js --refresh # re-fetch even contacts that already have estimates
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { chromium } = require('playwright');
const https  = require('https');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');

const PF_USER   = process.env.PRICEFINDER_USER;
const PF_PASS   = process.env.PRICEFINDER_PASS;
const API_URL   = (process.env.JARVIS_API_URL || 'https://72.62.74.105:4242').replace(/\/$/, '');
const API_KEY   = process.env.JARVIS_API_KEY;
const REFRESH   = process.argv.includes('--refresh');
const DEBUG_DIR = path.join(__dirname, 'pricefinder-debug');

if (!PF_USER || !PF_PASS || !API_URL || !API_KEY) {
  console.error('FATAL: PRICEFINDER_USER, PRICEFINDER_PASS, JARVIS_API_URL and JARVIS_API_KEY must be set in .env');
  process.exit(1);
}

const api = axios.create({
  baseURL:    API_URL,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }), // self-signed cert on VPS
  headers:    { Authorization: `Bearer ${API_KEY}` },
});

// ---------------------------------------------------------------------------
async function login(page) {
  await page.goto('https://www.pricefinder.com.au/portal/app?page=NativeLogin&service=page',
    { waitUntil: 'networkidle', timeout: 30000 });
  const emailSel = 'input[type="email"], input[name="username"], input[name="email"]';
  await page.waitForSelector(emailSel, { timeout: 10000 });
  await page.fill(emailSel, PF_USER);
  await page.fill('input[type="password"]', PF_PASS);
  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('NativeLogin'), { timeout: 15000 });
  console.log('[estimates] Login successful.');
}

async function lookupEstimate(page, address) {
  await page.goto('https://www.pricefinder.com.au/portal/app', { waitUntil: 'networkidle', timeout: 20000 });
  const searchSel = 'input[placeholder*="address" i], input[placeholder*="search" i], input[aria-label*="address" i]';
  await page.waitForSelector(searchSel, { timeout: 8000 });
  await page.fill(searchSel, address);
  await page.waitForTimeout(1500);
  const dropdownSel = '[class*="suggestion" i]:first-child, [role="option"]:first-child, [class*="autocomplete" i] li:first-child';
  try {
    await page.waitForSelector(dropdownSel, { timeout: 5000 });
    await page.click(dropdownSel);
  } catch {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => {
    const body = document.body.innerText;
    const pats = [
      /estimated[^\n$]*\$[\d,.]+[KMkm]?/i,
      /current value[^\n$]*\$[\d,.]+[KMkm]?/i,
      /avm[^\n$]*\$[\d,.]+[KMkm]?/i,
      /property value[^\n$]*\$[\d,.]+[KMkm]?/i,
      /valuation[^\n$]*\$[\d,.]+[KMkm]?/i,
    ];
    for (const p of pats) {
      const m = body.match(p);
      if (m) {
        const d = m[0].match(/\$[\d,.]+[KMkm]?/);
        return d ? d[0] : null;
      }
    }
    const fb = body.match(/\$[1-9][\d,]{5,}/); // require $100k+ to avoid fee/subscription amounts
    return fb ? fb[0] : null;
  });
}

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // Fetch today's contacts from VPS
  const { data: rows } = await api.get('/api/plan/today');
  const targets = rows.filter(r =>
    r.contact_id && r.address &&
    (REFRESH || !r.pricefinder_estimate)
  );

  if (!targets.length) {
    console.log('[estimates] Nothing to look up — all contacts already have estimates.');
    return;
  }
  console.log(`[estimates] ${targets.length} contacts to look up (of ${rows.length} on today's plan)`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  try {
    await login(page);
    let hits = 0, misses = 0;
    for (const row of targets) {
      const addr = [row.address, row.suburb].filter(Boolean).join(', ');
      try {
        const estimate = await lookupEstimate(page, addr);
        if (estimate) {
          await api.patch(`/api/contacts/${row.contact_id}/pricefinder`, { estimate });
          console.log(`  ✓  ${addr}  →  ${estimate}`);
          hits++;
        } else {
          console.log(`  ✗  ${addr}  →  no estimate found`);
          misses++;
        }
      } catch (err) {
        console.error(`  !!  ${addr}  →  ${err.message}`);
        await page.screenshot({ path: path.join(DEBUG_DIR, `error-${Date.now()}.png`) });
      }
      await page.waitForTimeout(2000);
    }
    console.log(`\n[estimates] Done: ${hits} estimates saved, ${misses} not found.`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
