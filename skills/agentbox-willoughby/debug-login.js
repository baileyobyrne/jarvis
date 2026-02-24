const { chromium } = require('playwright');
require('dotenv').config({ path: '/root/.openclaw/.env' });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  await page.goto('https://app.sales.reapit.com.au/contacts');
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/login-page.png', fullPage: true });

  // Try filling via JavaScript instead of Playwright native
  const result = await page.evaluate((creds) => {
    const usernameField = document.querySelector('#signInFormUsername');
    const passwordField = document.querySelector('#signInFormPassword');
    const submitBtn = document.querySelector('[name="signInSubmitButton"]');

    if (!usernameField) return 'username field not found';
    if (!passwordField) return 'password field not found';

    // Simulate real user input
    usernameField.value = creds.username;
    usernameField.dispatchEvent(new Event('input', { bubbles: true }));
    usernameField.dispatchEvent(new Event('change', { bubbles: true }));

    passwordField.value = creds.password;
    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
    passwordField.dispatchEvent(new Event('change', { bubbles: true }));

    return `fields found and filled. Submit button exists: ${!!submitBtn}`;
  }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });

  console.log('JS fill result:', result);
  await page.screenshot({ path: '/tmp/after-fill.png', fullPage: true });

  // Click submit
  try {
    await page.click('[name="signInSubmitButton"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('After submit URL:', page.url());
    await page.screenshot({ path: '/tmp/after-submit.png', fullPage: true });
  } catch(e) {
    console.log('Submit error:', e.message.split('\n')[0]);
  }

  await browser.close();
})();
