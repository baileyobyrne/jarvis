require('dotenv').config({ path: '../../.env' });
const { chromium } = require('playwright');
const fs = require('fs');
const STATEFILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const BASE = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = fs.existsSync(STATEFILE)
    ? await browser.newContext({ storageState: STATEFILE })
    : await browser.newContext();
  const page = await context.newPage();
  
  let authToken = null, clientId = null;
  page.on('request', request => {
    if (request.url().includes('api.agentboxcrm.com.au') && request.headers()['authorization']) {
      authToken = request.headers()['authorization'];
      clientId = request.headers()['x-client-id'];
    }
  });

  await page.goto('https://app.sales.reapit.com.au/contacts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  if (authToken) {
      const suburb = 'Willoughby', postcode = '2068';
      const result = await page.evaluate(async ({ BASE, suburb, postcode, authToken, clientId }) => {
        const url = `${BASE}/contacts?filtersuburb=${encodeURIComponent(suburb)}&filterpostcode=${postcode}&limit=100&page=1&version=2`;
        const res = await fetch(url, {
          headers: { 
            'Accept': 'application/json', 
            'Authorization': authToken,
            'x-client-id': clientId
          }
        });
        const data = await res.json();
        return { 
            count: data.response?.contacts?.length, 
            last: data.response?.last, 
            total: data.response?.total 
        };
      }, { BASE, suburb, postcode, authToken, clientId });
      console.log('Result:', result);
  }
  await browser.close();
})();
