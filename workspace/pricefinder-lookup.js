'use strict';
require('dotenv').config({ path: '/root/.openclaw/.env' });
const { chromium } = require('/usr/lib/node_modules/playwright');
const { db } = require('../lib/db.js');
const fs = require('fs');
const path = require('path');

const PF_USER = process.env.PRICEFINDER_USER;
const PF_PASS = process.env.PRICEFINDER_PASS;
if (!PF_USER || !PF_PASS) {
  console.error('[pricefinder] FATAL: PRICEFINDER_USER and PRICEFINDER_PASS must be set in .env');
  process.exit(1);
}
const DEBUG_DIR = path.join(__dirname, 'pricefinder-debug');
const LOGIN_URL = 'https://www.pricefinder.com.au/portal/app?page=NativeLogin&service=page';

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: path.join(DEBUG_DIR, 'login-page.png') });

  // Try multiple selectors for email field
  const emailSel = 'input[type="email"], input[name="username"], input[name="email"], input[placeholder*="email" i], input[placeholder*="username" i]';
  await page.waitForSelector(emailSel, { timeout: 10000 });
  await page.fill(emailSel, PF_USER);

  const passSel = 'input[type="password"]';
  await page.fill(passSel, PF_PASS);

  await page.screenshot({ path: path.join(DEBUG_DIR, 'login-filled.png') });

  // Click submit
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")';
  await page.click(submitSel);

  // Wait for redirect away from login
  await page.waitForFunction(() => !window.location.href.includes('NativeLogin'), { timeout: 15000 });
  await page.screenshot({ path: path.join(DEBUG_DIR, 'after-login.png') });
}

// ---------------------------------------------------------------------------
// Property lookup
// ---------------------------------------------------------------------------
async function lookupProperty(page, address) {
  // Navigate to search
  await page.goto('https://www.pricefinder.com.au/portal/app', { waitUntil: 'networkidle', timeout: 20000 });

  // Find search input
  const searchSel = 'input[placeholder*="address" i], input[placeholder*="search" i], input[placeholder*="property" i], input[aria-label*="address" i], input[aria-label*="search" i]';
  await page.waitForSelector(searchSel, { timeout: 8000 });
  await page.fill(searchSel, address);
  await page.waitForTimeout(1500);

  // Click first autocomplete result
  const dropdownSel = '[class*="suggestion" i]:first-child, [class*="autocomplete" i] li:first-child, [class*="result" i]:first-child, [role="option"]:first-child';
  try {
    await page.waitForSelector(dropdownSel, { timeout: 5000 });
    await page.click(dropdownSel);
  } catch {
    // Try pressing Enter if no dropdown
    await page.keyboard.press('Enter');
  }

  // Wait for property detail page
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Extract estimate
  const estimate = await page.evaluate(() => {
    const body = document.body.innerText;
    const dollarPatterns = [
      /estimated[^\n\$]*\$[\d,\.]+[KMkm]?/i,
      /current value[^\n\$]*\$[\d,\.]+[KMkm]?/i,
      /avm[^\n\$]*\$[\d,\.]+[KMkm]?/i,
      /property value[^\n\$]*\$[\d,\.]+[KMkm]?/i,
      /valuation[^\n\$]*\$[\d,\.]+[KMkm]?/i,
    ];
    for (const pat of dollarPatterns) {
      const m = body.match(pat);
      if (m) {
        // Extract just the dollar amount
        const dollarMatch = m[0].match(/\$[\d,\.]+[KMkm]?/);
        return dollarMatch ? dollarMatch[0] : null;
      }
    }
    // Fallback: any large dollar amount
    const fallback = body.match(/\$[1-9][\d,]{4,}/);
    return fallback ? fallback[0] : null;
  });

  return estimate;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Get addresses to look up
  const cliAddress = process.argv.find(a => a.startsWith('--address'))
    ? process.argv[process.argv.indexOf('--address') + 1]
    : null;

  let targets;
  if (cliAddress) {
    // Single address mode
    targets = [{ address: cliAddress, suburb: '', id: null }];
  } else {
    // Today's plan contacts without estimates
    targets = db.prepare(`
      SELECT c.id, c.address, c.suburb
      FROM daily_plans dp
      JOIN contacts c ON c.id = dp.contact_id
      WHERE dp.plan_date = date('now','localtime')
        AND (c.pricefinder_estimate IS NULL OR c.pricefinder_estimate = '')
      LIMIT 20
    `).all();
  }

  if (!targets.length) {
    console.log('[pricefinder] No targets to look up. All today\'s contacts already have estimates, or board is empty.');
    return;
  }
  console.log(`[pricefinder] Looking up ${targets.length} addresses...`);

  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    await login(page);
    console.log('[pricefinder] Login successful.');

    for (const target of targets) {
      const fullAddr = [target.address, target.suburb].filter(Boolean).join(', ');
      try {
        const estimate = await lookupProperty(page, fullAddr);
        if (estimate && target.id) {
          db.prepare('UPDATE contacts SET pricefinder_estimate = ?, pricefinder_fetched_at = datetime("now","localtime") WHERE id = ?')
            .run(estimate, target.id);
          console.log(`[pricefinder] ${fullAddr} -> ${estimate}`);
        } else {
          console.log(`[pricefinder] ${fullAddr} -> no estimate found`);
        }
      } catch (err) {
        console.error(`[pricefinder] Failed for ${fullAddr}:`, err.message);
        await page.screenshot({ path: path.join(DEBUG_DIR, `error-${Date.now()}.png`) });
      }
      await page.waitForTimeout(2000);
    }
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
