const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
require('dotenv').config({ path: '/root/.openclaw/.env' });

async function getAgentBoxAuth() {
    const STATE_FILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
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
        console.log('Capturing AgentBox auth tokens via McGrath Love Local...');
        await page.goto('https://mcgrathlovelocal.agentboxcrm.com.au/admin/master');
        await page.waitForLoadState('networkidle', { timeout: 20000 });

        if (page.url().includes('auth.au.rc.reapit.cloud') || page.url().includes('signInForm')) {
            console.log('Session expired - Logging in to Reapit...');
            await page.evaluate((creds) => {
                const usernameField = document.querySelector('#signInFormUsername');
                const passwordField = document.querySelector('#signInFormPassword');
                const form = document.querySelector('form');
                if (usernameField && passwordField) {
                    usernameField.value = creds.username;
                    usernameField.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordField.value = creds.password;
                    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                    form.submit();
                }
            }, { username: process.env.AGENTBOX_USERNAME, password: process.env.AGENTBOX_PASSWORD });
            
            await page.waitForURL('**/app.sales.reapit.com.au/**', { timeout: 30000 });
            await page.waitForLoadState('networkidle', { timeout: 20000 });
            await context.storageState({ path: STATE_FILE });
            console.log('Login successful and state saved.');
        }

        let attempts = 0;
        while (!authToken && attempts < 15) {
            await page.waitForTimeout(2000);
            attempts++;
        }

        if (!authToken) throw new Error('Failed to capture AgentBox auth tokens.');
        console.log('Auth tokens captured successfully.');
        return { authToken, clientId };
    } finally {
        await browser.close();
    }
}

async function testProperties() {
    try {
        const { authToken, clientId } = await getAgentBoxAuth();
        const contactId = '94689';
        const axiosConfig = {
            headers: {
                'Authorization': authToken,
                'x-client-id': clientId,
                'Accept': 'application/json'
            }
        };

        const patterns = [
            { name: 'Pattern 1: filter listings', url: `https://api.agentboxcrm.com.au/listings?filter[contactId]=${contactId}&version=2` },
            { name: 'Pattern 4: listing detail', url: `https://api.agentboxcrm.com.au/listings/264P3373?version=2` }
        ];

        for (const pattern of patterns) {
            console.log(`
Testing ${pattern.name}: ${pattern.url}`);
            try {
                const response = await axios.get(pattern.url, axiosConfig);
                console.log(`Status: ${response.status} ${response.statusText}`);
                if (response.data.response) {
                    const resKeys = Object.keys(response.data.response);
                    console.log('Response.response Keys:', JSON.stringify(resKeys, null, 2));
                    
                    if (pattern.name.includes('listing detail')) {
                        const listing = response.data.response.listing;
                        if (listing) {
                            console.log('Listing Keys:', JSON.stringify(Object.keys(listing), null, 2));
                            if (listing.appraisal) {
                                console.log('Appraisal data:', JSON.stringify(listing.appraisal, null, 2));
                            } else {
                                console.log('No appraisal key found in listing detail.');
                            }
                        }
                    } else {
                        const resourceName = pattern.name.split(' ').pop();
                        if (response.data.response[resourceName]) {
                            console.log(`${resourceName} count:`, response.data.response[resourceName].length);
                            if (response.data.response[resourceName].length > 0) {
                                console.log(`Sample ${resourceName} entry:`, JSON.stringify(response.data.response[resourceName][0], null, 2));
                            }
                        }
                    }
                } else {
                   console.log('Response Keys:', JSON.stringify(Object.keys(response.data), null, 2));
                }
            } catch (error) {
                if (error.response) {
                    console.log(`Status: ${error.response.status} ${error.response.statusText}`);
                    if (error.response.data) {
                       console.log('Error data:', JSON.stringify(error.response.data, null, 2));
                    }
                } else {
                    console.log(`Error: ${error.message}`);
                }
            }
        }

    } catch (error) {
        console.error('Fatal execution error:', error.message);
    }
}

testProperties();
