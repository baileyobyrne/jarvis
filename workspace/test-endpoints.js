const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
require('dotenv').config({ path: '/root/.openclaw/.env' });

async function getAgentBoxAuth() {
    const STATE_FILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
    const browser = await chromium.launch({ headless: true });
    // Re-use state if it exists, otherwise start fresh with a real user agent
    const context = fs.existsSync(STATE_FILE)
        ? await browser.newContext({ storageState: STATE_FILE })
        : await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
        });
    const page = await context.newPage();

    let authToken = null;
    let clientId = null;

    // Listen for requests to capture the authorization headers
    page.on('request', request => {
        if (request.url().includes('api.agentboxcrm.com.au') && request.headers()['authorization']) {
            authToken = request.headers()['authorization'];
            clientId = request.headers()['x-client-id'];
        }
    });

    try {
        console.log('Capturing AgentBox auth tokens via McGrath Love Local...');
        // The user specified this URL redirects to Reapit
        await page.goto('https://mcgrathlovelocal.agentboxcrm.com.au/admin/master');
        await page.waitForLoadState('networkidle', { timeout: 20000 });

        // If redirected to login, perform login using credentials from .env
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

        // Wait for a background API call to happen and headers to be captured
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

async function testEndpoints() {
    try {
        const { authToken, clientId } = await getAgentBoxAuth();
        const contactId = '369'; // Swapping to 369 to see if it has more data
        const axiosConfig = {
            headers: {
                'Authorization': authToken,
                'x-client-id': clientId,
                'Accept': 'application/json'
            }
        };

        const patterns = [
            { name: 'Pattern 1: contact appraisals', url: `https://api.agentboxcrm.com.au/contacts/${contactId}/appraisals?version=2` },
            { name: 'Pattern 2: filter notes (369)', url: `https://api.agentboxcrm.com.au/notes?filter[contactId]=${contactId}&version=2` },
            { name: 'Pattern 6: individual note detail', url: `https://api.agentboxcrm.com.au/notes/33292?version=2` }
        ];

        for (const pattern of patterns) {
            console.log(`\nTesting ${pattern.name}: ${pattern.url}`);
            try {
                const response = await axios.get(pattern.url, axiosConfig);
                console.log(`Status: ${response.status} ${response.statusText}`);
                if (response.data.response) {
                    const resKeys = Object.keys(response.data.response);
                    console.log('Response.response Keys:', JSON.stringify(resKeys, null, 2));
                    
                    if (pattern.name.includes('individual note detail')) {
                        console.log('Note detail content:', JSON.stringify(response.data.response.note, null, 2));
                    } else if (pattern.name.includes('filter')) {
                        const resourceName = pattern.name.split(' ').pop().replace(')', '');
                        if (response.data.response[resourceName]) {
                            console.log(`${resourceName} count:`, response.data.response[resourceName].length);
                        }
                    } else if (pattern.name.includes('contact appraisals')) {
                         console.log('Appraisals content:', JSON.stringify(response.data.response, null, 2));
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

testEndpoints();
