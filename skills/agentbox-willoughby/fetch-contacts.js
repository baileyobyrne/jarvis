const { chromium } = require('playwright');
require('dotenv').config({ path: '/root/.openclaw/.env' });

const STATE_FILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const CONTACTS_FILE = '/root/.openclaw/workspace/willoughby-contacts.json';
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = fs.existsSync(STATE_FILE)
    ? await browser.newContext({ storageState: STATE_FILE })
    : await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
      });
  const page = await context.newPage();

  let authToken = null;
  let clientId = null;
  page.on('request', request => {
    if (request.url().includes('api.agentboxcrm.com.au') && request.headers()['authorization']) {
      authToken = request.headers()['authorization'];
      clientId = request.headers()['x-client-id'];
    }
  });

  try {
    await page.goto('https://app.sales.reapit.com.au/contacts');
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    if (page.url().includes('auth.au.rc.reapit.cloud')) {
      console.log('Re-logging in...');
      await page.evaluate((creds) => {
        const form = document.querySelector('form');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(document.querySelector('#signInFormUsername'), creds.username);
        document.querySelector('#signInFormUsername').dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(document.querySelector('#signInFormPassword'), creds.password);
        document.querySelector('#signInFormPassword').dispatchEvent(new Event('input', { bubbles: true }));
        form.submit();
      }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });
      await page.waitForURL('**/app.sales.reapit.com.au/**', { timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 });
      await page.waitForTimeout(3000);
      await context.storageState({ path: STATE_FILE });
    }

    await page.waitForTimeout(4000);
    if (!authToken) throw new Error('Could not capture auth token');

    // Fetch ALL pages of contacts
    let allContacts = [];
    let currentPage = 1;
    let lastPage = 1;

    console.log('Fetching all Willoughby contacts...');

    do {
      const response = await context.request.get(
        `https://api.agentboxcrm.com.au/contacts?filter[suburb]=Willoughby&filter[postcode]=2068&limit=100&page=${currentPage}&version=2`,
        {
          headers: {
            'Authorization': authToken,
            'x-client-id': clientId,
            'Accept': 'application/json',
            'Referer': 'https://app.sales.reapit.com.au/'
          }
        }
      );

      const data = await response.json();
      const contacts = data.response?.contacts || [];
      lastPage = parseInt(data.response?.last) || 1;

      allContacts = allContacts.concat(contacts);
      console.log(`Page ${currentPage}/${lastPage} — ${contacts.length} contacts fetched (total: ${allContacts.length})`);
      currentPage++;

    } while (currentPage <= lastPage);

    // Format for output
    const formatted = allContacts.map(c => ({
      name: `${c.firstName} ${c.lastName}`.trim(),
      salutation: c.salutation || c.firstName,
      email: c.email || '',
      mobile: c.mobile || c.homePhone || c.workPhone || '',
      source: c.source || '',
      status: c.status,
      lastModified: c.lastModified
    })).filter(c => c.mobile || c.email);

    // Save to workspace
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      total: formatted.length,
      contacts: formatted
    }, null, 2));

    console.log(`\n✅ Done! ${formatted.length} contacts with contact details saved.`);
    console.log(`File: ${CONTACTS_FILE}`);

    // Print sample
    console.log('\nSample contacts:');
    formatted.slice(0, 5).forEach(c => {
      console.log(`  ${c.name} | ${c.mobile} | ${c.email}`);
    });

  } catch (error) {
    console.log('Error:', error.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
})();
