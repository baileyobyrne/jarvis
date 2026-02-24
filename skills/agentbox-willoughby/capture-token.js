const { chromium } = require('playwright');
require('dotenv').config({ path: '/root/.openclaw/.env' });

const STATE_FILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = fs.existsSync(STATE_FILE)
    ? await browser.newContext({ storageState: STATE_FILE })
    : await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
      });
  const page = await context.newPage();

  // Intercept ALL requests to AgentBox and capture headers
  let capturedHeaders = null;
  page.on('request', request => {
    if (request.url().includes('agentboxcrm.com.au')) {
      const headers = request.headers();
      console.log('Intercepted AgentBox request:', request.url());
      console.log('Headers:', JSON.stringify(headers, null, 2));
      capturedHeaders = headers;
    }
  });

  try {
    // Load the app - it will make API calls automatically on load
    await page.goto('https://app.sales.reapit.com.au/contacts');
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    const currentUrl = page.url();
    console.log('URL:', currentUrl);

    if (currentUrl.includes('auth.au.rc.reapit.cloud')) {
      console.log('Session expired - need to re-login');
    } else {
      // Wait a bit for background API calls to fire
      await page.waitForTimeout(5000);

      // Also check localStorage for Cognito tokens
      const tokens = await page.evaluate(() => {
        const results = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key.toLowerCase().includes('token') || 
              key.toLowerCase().includes('cognito') ||
              key.toLowerCase().includes('auth') ||
              key.toLowerCase().includes('reapit')) {
            results[key] = localStorage.getItem(key);
          }
        }
        return results;
      });

      console.log('\nRelevant localStorage keys:');
      console.log(JSON.stringify(tokens, null, 2));
    }

  } catch (error) {
    console.log('Error:', error.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
})();
