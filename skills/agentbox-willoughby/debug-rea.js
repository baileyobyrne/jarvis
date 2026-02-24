const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Intercept ALL network requests and log API calls
  const apiCalls = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('api') || url.includes('graphql') || url.includes('lexa') || url.includes('json')) {
      apiCalls.push({
        url: url,
        method: request.method(),
        headers: request.headers(),
        postData: request.postData()
      });
    }
  });

  page.on('response', async response => {
    const url = response.url();
    if ((url.includes('lexa') || url.includes('graphql')) && response.status() === 200) {
      try {
        const text = await response.text();
        console.log('\n=== API RESPONSE ===');
        console.log('URL:', url);
        console.log('Preview:', text.substring(0, 500));
      } catch(e) {}
    }
  });

  await page.goto('https://www.realestate.com.au/buy/in-willoughby%2C+nsw+2068/list-1', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(8000);

  console.log('\n=== ALL API CALLS INTERCEPTED ===');
  apiCalls.forEach(c => {
    console.log(`${c.method} ${c.url}`);
    if (c.postData) console.log('  Body:', c.postData.substring(0, 200));
  });

  await browser.close();
})();
