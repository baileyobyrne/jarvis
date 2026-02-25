'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// pricefinder-prospecting-local.js
// Run this on your LOCAL MACHINE (Mac/PC) — not the VPS.
// Uses Pricefinder's Prospecting / Suburb Reports tool to pull owner lists
// for the Willoughby farm suburbs and upsert them into JARVIS contacts.
//
// Run ONCE WEEKLY at most (bulk import, not per-contact).
// No Claude/AI calls — pure data extraction.
//
// First run: use --debug to save screenshots and inspect the UI.
//   node pricefinder-prospecting-local.js --debug
//   (review pricefinder-debug/ screenshots, then refine selectors if needed)
//
// Normal run:
//   node pricefinder-prospecting-local.js
//   node pricefinder-prospecting-local.js --suburb Willoughby
//
// .env (same directory as this script):
//   PRICEFINDER_USER=your-pricefinder-email@example.com
//   PRICEFINDER_PASS=your-pricefinder-password
//   JARVIS_API_URL=https://72.62.74.105:4242
//   JARVIS_API_KEY=<your-DASHBOARD_PASSWORD>
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
const DEBUG     = process.argv.includes('--debug');
const _subIdx   = process.argv.indexOf('--suburb');
const ONE_SUB   = _subIdx !== -1 && process.argv[_subIdx + 1] ? process.argv[_subIdx + 1] : null;
const DEBUG_DIR = path.join(__dirname, 'pricefinder-debug');

if (!PF_USER || !PF_PASS || !API_URL || !API_KEY) {
  console.error('FATAL: PRICEFINDER_USER, PRICEFINDER_PASS, JARVIS_API_URL and JARVIS_API_KEY must be set in .env');
  process.exit(1);
}

const api = axios.create({
  baseURL:    API_URL,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers:    { Authorization: `Bearer ${API_KEY}` },
});

// Willoughby farm suburbs
const SUBURBS = ONE_SUB ? [ONE_SUB] : [
  'Willoughby', 'North Willoughby', 'Willoughby East',
  'Castlecrag', 'Middle Cove', 'Castle Cove',
  'Naremburn', 'Chatswood', 'Artarmon',
  'Northbridge', 'Lane Cove', 'St Leonards', 'Crows Nest',
];

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
  console.log('[prospecting] Login successful. URL:', page.url());
}

// Tries several common Pricefinder navigation patterns to reach prospecting/suburb tools.
// Returns true if we found a relevant page, false otherwise.
async function navigateToProspecting(page, screenshotFn) {
  // Strategy 1: direct URL patterns (common Pricefinder routes)
  const candidates = [
    'https://www.pricefinder.com.au/portal/app?page=SuburbProfile',
    'https://www.pricefinder.com.au/portal/app?page=Prospecting',
    'https://www.pricefinder.com.au/portal/app?page=ProspectingTool',
    'https://www.pricefinder.com.au/portal/app?page=SuburbReport',
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (!page.url().includes('NativeLogin')) {
        await screenshotFn(`prospect-direct-${url.split('=')[1]}`);
        console.log(`[prospecting] Navigated to ${url}`);
        return true;
      }
    } catch { /* try next */ }
  }

  // Strategy 2: click nav items
  await page.goto('https://www.pricefinder.com.au/portal/app', { waitUntil: 'networkidle', timeout: 20000 });
  await screenshotFn('prospect-home');

  const navTexts = ['Prospecting', 'Suburb', 'Reports', 'Tools', 'Market'];
  for (const text of navTexts) {
    try {
      const el = page.locator(`text=/${text}/i`).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await screenshotFn(`prospect-click-${text.toLowerCase()}`);
        console.log(`[prospecting] Clicked "${text}" nav item. URL: ${page.url()}`);
        return true;
      }
    } catch { /* try next */ }
  }

  return false;
}

// Try to extract a property/owner table from the current page.
// Returns array of contact objects (may be empty if UI not recognised).
async function extractProspectingData(page, suburb) {
  return page.evaluate((suburb) => {
    const results = [];
    // Look for table rows (common pattern for property lists)
    const rows = document.querySelectorAll('table tr, [class*="row" i], [class*="property" i] [class*="item" i]');
    rows.forEach(row => {
      const text = row.innerText || '';
      // Try to find address pattern: number + street + type
      const addrMatch = text.match(/(\d+\s+[\w\s]+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Place|Pl|Court|Ct|Lane|Ln|Way|Crescent|Cres|Close|Cl)[\w\s]*)/i);
      if (!addrMatch) return;
      const address = addrMatch[1].trim();

      // Try to find tenure/year pattern
      const yearMatch = text.match(/\b(19[89]\d|20[012]\d)\b/);
      const tenure_years = yearMatch ? new Date().getFullYear() - parseInt(yearMatch[1]) : null;

      // Occupancy hints
      const occupancy = /invest|rent/i.test(text) ? 'Investor' : /owner.occup/i.test(text) ? 'Owner Occupied' : null;

      // Owner name (often appears before address)
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const name = lines[0] && lines[0].length < 60 && !/^\d/.test(lines[0]) ? lines[0] : 'Unknown Owner';

      results.push({ name, address, suburb, state: 'NSW', occupancy, tenure_years, property_type: '' });
    });
    return results;
  }, suburb);
}

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  let screenshotIdx = 0;
  const browser = await chromium.launch({ headless: !DEBUG });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page    = await context.newPage();

  const screenshotFn = async (label) => {
    if (DEBUG) {
      const file = path.join(DEBUG_DIR, `${String(++screenshotIdx).padStart(3, '0')}-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  📷 ${file}`);
    }
  };

  // Also dump nav links in debug mode
  const dumpLinks = async () => {
    if (!DEBUG) return;
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button, [role="menuitem"]'))
        .map(el => ({ text: el.innerText?.trim(), href: el.href || '' }))
        .filter(l => l.text && l.text.length < 80)
    );
    console.log('[debug] Page elements:', JSON.stringify(links.slice(0, 40), null, 2));
  };

  try {
    await login(page);
    await screenshotFn('00-after-login');
    await dumpLinks();

    const found = await navigateToProspecting(page, screenshotFn);
    if (!found) {
      console.warn('[prospecting] Could not find prospecting section automatically.');
      console.warn('  Run with --debug and review pricefinder-debug/ screenshots.');
      console.warn('  Share screenshots with Claude to refine selectors.');
      await screenshotFn('not-found-state');
      await dumpLinks();
      await browser.close();
      return;
    }

    let totalUpserted = 0;
    for (const suburb of SUBURBS) {
      console.log(`\n[prospecting] Processing: ${suburb}`);
      try {
        // Try to enter suburb in any visible search field
        const searchSel = 'input[placeholder*="suburb" i], input[placeholder*="search" i], input[type="search"]';
        const searchEl = page.locator(searchSel).first();
        if (await searchEl.isVisible({ timeout: 3000 })) {
          await searchEl.fill(suburb);
          await page.waitForTimeout(1000);
          // Click first suggestion
          const suggSel = '[role="option"]:first-child, [class*="suggestion" i]:first-child, li:first-child';
          try {
            await page.waitForSelector(suggSel, { timeout: 3000 });
            await page.click(suggSel);
          } catch {
            await page.keyboard.press('Enter');
          }
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        }

        await screenshotFn(`suburb-${suburb.toLowerCase().replace(/\s+/g, '-')}`);

        // Try export/download button first (most efficient)
        const exportSel = 'button:has-text("Export"), button:has-text("Download"), a:has-text("Export"), a:has-text("CSV")';
        const exportBtn = page.locator(exportSel).first();
        if (await exportBtn.isVisible({ timeout: 2000 })) {
          console.log(`  Found export button for ${suburb} — attempting download`);
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
            exportBtn.click(),
          ]);
          if (download) {
            const savePath = path.join(DEBUG_DIR, `${suburb.replace(/\s+/g, '-')}-export.csv`);
            await download.saveAs(savePath);
            console.log(`  Downloaded: ${savePath}`);
            // TODO: parse CSV and POST to API (format varies — review downloaded file first)
            continue;
          }
        }

        // Fall back to page scraping
        const contacts = await extractProspectingData(page, suburb);
        if (contacts.length > 0) {
          const { data } = await api.post('/api/prospecting/ingest', contacts);
          console.log(`  ✓ ${suburb}: ${data.upserted} contacts upserted`);
          totalUpserted += data.upserted;
        } else {
          console.log(`  ✗ ${suburb}: no data extracted (UI may need selector update)`);
          await screenshotFn(`no-data-${suburb.toLowerCase().replace(/\s+/g, '-')}`);
        }
      } catch (err) {
        console.error(`  !! ${suburb}: ${err.message}`);
        await screenshotFn(`error-${suburb.toLowerCase().replace(/\s+/g, '-')}`);
      }
      await page.waitForTimeout(1500);
    }

    console.log(`\n[prospecting] Done. Total contacts upserted: ${totalUpserted}`);
    if (totalUpserted === 0) {
      console.log('  Tip: run with --debug and share screenshots to refine UI selectors.');
    }
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
