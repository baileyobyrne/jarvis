'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// pricefinder-market-local.js
// Run this on your LOCAL MACHINE (Mac/PC) — not the VPS.
// Scrapes Pricefinder's Market Activity section for recent sales/listings
// across Willoughby farm suburbs and pushes them to the JARVIS market_events
// table — the same table that Pipeline A (monitor-email.js) writes to.
//
// Run DAILY or every few days (only new events get inserted — deduped by
// address + type + event_date index).
// No Claude/AI calls.
//
// First run: use --debug to map the UI.
//   node pricefinder-market-local.js --debug
//
// Normal run:
//   node pricefinder-market-local.js
//   node pricefinder-market-local.js --days 30   # look back 30 days (default 14)
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
const _daysIdx  = process.argv.indexOf('--days');
const DAYS_BACK = _daysIdx !== -1 && process.argv[_daysIdx + 1]
  ? (parseInt(process.argv[_daysIdx + 1]) || 14)
  : 14;
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

const SUBURBS = [
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
  console.log('[market] Login successful.');
}

async function navigateToMarketActivity(page, screenshotFn) {
  // Strategy 1: direct URL patterns
  const candidates = [
    'https://www.pricefinder.com.au/portal/app?page=MarketActivity',
    'https://www.pricefinder.com.au/portal/app?page=RecentSales',
    'https://www.pricefinder.com.au/portal/app?page=SuburbActivity',
    'https://www.pricefinder.com.au/portal/app?page=SalesActivity',
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (!page.url().includes('NativeLogin')) {
        await screenshotFn(`market-direct-${url.split('=')[1]}`);
        return true;
      }
    } catch { /* try next */ }
  }

  // Strategy 2: nav click
  await page.goto('https://www.pricefinder.com.au/portal/app', { waitUntil: 'networkidle', timeout: 20000 });
  await screenshotFn('market-home');

  const navTexts = ['Market Activity', 'Market', 'Recent Sales', 'Sales', 'Activity'];
  for (const text of navTexts) {
    try {
      const el = page.locator(`text=/${text}/i`).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await screenshotFn(`market-click-${text.toLowerCase().replace(/\s+/g, '-')}`);
        console.log(`[market] Clicked "${text}". URL: ${page.url()}`);
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

// Extract sales/listing rows from the current page.
// Returns array of market_event objects.
async function extractMarketData(page, suburb) {
  return page.evaluate((suburb) => {
    const events = [];
    // Common Pricefinder table/list patterns
    const rows = document.querySelectorAll(
      'table tr[class*="row" i], table tbody tr, [class*="sale" i], [class*="listing" i], [class*="activity" i] [class*="item" i]'
    );
    rows.forEach(row => {
      const text = row.innerText || '';
      if (!text.trim()) return;

      // Address
      const addrMatch = text.match(/(\d+\s+[\w\s]+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Place|Pl|Court|Ct|Lane|Ln|Way|Crescent|Cres|Close|Cl)[\w\s]*)/i);
      if (!addrMatch) return;
      const address = addrMatch[1].trim();

      // Price — $XXX,XXX or $X.XXM
      const priceMatch = text.match(/\$[\d,]+(?:\.\d+)?[KMkm]?/);
      const price = priceMatch ? priceMatch[0] : null;

      // Date — various formats; detect ISO (YYYY-MM-DD) before treating as D/M/Y
      const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
      let event_date = null;
      if (dateMatch) {
        const raw = dateMatch[1];
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          event_date = raw; // already ISO — don't rearrange
        } else {
          const parts = raw.split(/[\/\-]/);
          if (parts.length === 3) {
            const y = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
            const m = parts[1].padStart(2, '0');
            const d = parts[0].padStart(2, '0');
            event_date = `${y}-${m}-${d}`;
          }
        }
      }

      // Type
      const type = /sold|sale/i.test(text) ? 'sold'
                 : /list/i.test(text) ? 'listing'
                 : /rent/i.test(text) ? 'rental'
                 : 'sold';

      // Beds/baths/cars
      const bedsM  = text.match(/(\d)\s*(?:bed|br)/i);
      const bathsM = text.match(/(\d)\s*(?:bath|ba)/i);
      const carsM  = text.match(/(\d)\s*(?:car|garage|park)/i);

      // Property type
      const propMatch = text.match(/house|unit|apartment|townhouse|villa/i);

      // Agent/agency (often in last columns)
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const agent_name = lines.length > 3 ? lines[lines.length - 2] : null;

      events.push({
        type,
        address,
        suburb,
        price,
        event_date,
        beds:          bedsM  ? bedsM[1]  : null,
        baths:         bathsM ? bathsM[1] : null,
        cars:          carsM  ? carsM[1]  : null,
        property_type: propMatch ? propMatch[0].toLowerCase() : null,
        agent_name,
        agency:        null,
      });
    });
    return events;
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

  try {
    await login(page);
    await screenshotFn('00-after-login');

    const found = await navigateToMarketActivity(page, screenshotFn);
    if (!found) {
      console.warn('[market] Could not find Market Activity section automatically.');
      console.warn('  Run with --debug and share pricefinder-debug/ screenshots with Claude.');
      await screenshotFn('not-found-state');
      await browser.close();
      return;
    }

    let totalInserted = 0;
    for (const suburb of SUBURBS) {
      console.log(`\n[market] Processing: ${suburb}`);
      try {
        // Set date range filter if available
        const fromInput = page.locator('input[type="date"], input[placeholder*="from" i], input[placeholder*="start" i]').first();
        if (await fromInput.isVisible({ timeout: 2000 })) {
          const fromDate = new Date(Date.now() - DAYS_BACK * 86400000).toISOString().slice(0, 10);
          await fromInput.fill(fromDate);
        }

        // Enter suburb
        const searchSel = 'input[placeholder*="suburb" i], input[placeholder*="search" i], input[type="search"]';
        const searchEl = page.locator(searchSel).first();
        if (await searchEl.isVisible({ timeout: 3000 })) {
          await searchEl.fill(suburb);
          await page.waitForTimeout(1000);
          try {
            const suggSel = '[role="option"]:first-child, [class*="suggestion" i]:first-child, li:first-child';
            await page.waitForSelector(suggSel, { timeout: 3000 });
            await page.click(suggSel);
          } catch {
            await page.keyboard.press('Enter');
          }
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        }

        await screenshotFn(`market-suburb-${suburb.toLowerCase().replace(/\s+/g, '-')}`);

        // Try CSV export first
        const exportSel = 'button:has-text("Export"), a:has-text("Export"), button:has-text("CSV"), a:has-text("CSV")';
        const exportBtn = page.locator(exportSel).first();
        if (await exportBtn.isVisible({ timeout: 2000 })) {
          console.log(`  Found export button for ${suburb}`);
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
            exportBtn.click(),
          ]);
          if (download) {
            const savePath = path.join(DEBUG_DIR, `market-${suburb.replace(/\s+/g, '-')}.csv`);
            await download.saveAs(savePath);
            console.log(`  Downloaded: ${savePath}`);
            // TODO: parse CSV and POST (format varies — check downloaded file)
            continue;
          }
        }

        // Fall back to page scraping
        const events = await extractMarketData(page, suburb);
        if (events.length > 0) {
          const { data } = await api.post('/api/market-events/ingest', events);
          console.log(`  ✓ ${suburb}: ${data.inserted}/${events.length} new events`);
          totalInserted += data.inserted;
        } else {
          console.log(`  ✗ ${suburb}: no events extracted (may need selector update)`);
          await screenshotFn(`no-data-${suburb.toLowerCase().replace(/\s+/g, '-')}`);
        }
      } catch (err) {
        console.error(`  !! ${suburb}: ${err.message}`);
        await screenshotFn(`error-${suburb.toLowerCase().replace(/\s+/g, '-')}`);
      }
      await page.waitForTimeout(1500);
    }

    console.log(`\n[market] Done. New events inserted: ${totalInserted}`);
    if (totalInserted === 0) {
      console.log('  Tip: run with --debug and share screenshots to refine selectors.');
    }
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
