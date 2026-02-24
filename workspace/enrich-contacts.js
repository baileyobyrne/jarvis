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

        // Wait a bit to ensure a background API call happens and headers are captured
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

function normalizeSuburb(suburb) {
    if (!suburb) return '';
    const s = suburb.toUpperCase().trim();
    if (s === 'NORTH WILLOUGHBY' || s === 'WILLOUGHBY EAST' || s === 'WILLOUGHBY') {
        return 'WILLOUGHBY';
    }
    return s;
}

function parseRPData(filePath) {
    if (!fs.existsSync(filePath)) {
        console.warn(`RP Data file not found: ${filePath}`);
        return new Map();
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const headerLine = lines[2]; // Headers are on line 3 (index 2)
    if (!headerLine) return new Map();
    
    // Simple CSV parser for quoted values
    const parseLine = (line) => {
        const values = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') inQuotes = !inQuotes;
            else if (char === ',' && !inQuotes) {
                values.push(current.trim());
                current = '';
            } else current += char;
        }
        values.push(current.trim());
        return values;
    };

    const headers = parseLine(headerLine).map(h => h.replace(/"/g, ''));
    const lookup = new Map();

    for (let i = 3; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const values = parseLine(line).map(v => v.replace(/"/g, ''));
        const entry = {};
        headers.forEach((h, idx) => {
            entry[h] = values[idx] || '';
        });

        // Key: Normalized Address + Normalized Suburb
        const street = (entry['Street Address'] || '').toUpperCase().trim();
        const suburb = normalizeSuburb(entry['Suburb']);
        const addressKey = `${street} ${suburb}`.trim();
        lookup.set(addressKey, entry);
    }
    return lookup;
}

(async () => {
    try {
        // 1. Capture Authentication Tokens
        const { authToken, clientId } = await getAgentBoxAuth();

        // 2. Load Contacts
        const contactsPath = '/root/.openclaw/workspace/willoughby-contacts.json';
        const contactsData = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
        const contacts = contactsData.contacts;

        // 3. Load Truth Data (RP Data)
        const truthDataPath = './rp_data.csv';
        console.log('Loading RP Data for cross-referencing...');
        const truthLookup = parseRPData(truthDataPath);
        console.log(`RP Data loaded: ${truthLookup.size} unique addresses.`);

        const axiosConfig = {
            headers: {
                'Authorization': authToken,
                'x-client-id': clientId,
                'Accept': 'application/json'
            }
        };

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // 4. Enrichment and Clean Loop
        console.log(`Starting enrichment for ${contacts.length} contacts...`);
        let processedCount = 0;
        let skippedCount = 0;

        for (let i = 0; i < contacts.length; i++) {
            const contact = contacts[i];
            
            // Skip if no ID (cannot fetch history)
            if (!contact.id) {
                skippedCount++;
                continue;
            }

            // Optimization: Pre-filter by address in RP Data
            const street = (contact.address || '').toUpperCase().trim();
            const suburb = normalizeSuburb(contact.suburb);
            const contactAddressKey = `${street} ${suburb}`.trim();
            
            const truthEntry = truthLookup.get(contactAddressKey);
            
            if (!truthEntry) {
                skippedCount++;
                continue;
            }

            try {
                // Fetch History (Read-Only GET requests)
                // 200ms delay between every call as requested
                
                // Fetch Notes
                await sleep(200);
                const notesRes = await axios.get(`https://api.agentboxcrm.com.au/notes?filter[contactId]=${contact.id}&version=2`, axiosConfig);
                contact.notes = notesRes.data.response?.notes || [];

                // Fetch Tasks
                await sleep(200);
                const tasksRes = await axios.get(`https://api.agentboxcrm.com.au/tasks?filter[contactId]=${contact.id}&version=2`, axiosConfig);
                contact.tasks = tasksRes.data.response?.tasks || [];

                // Fetch Listings (mapped to appraisals key for consistency)
                await sleep(200);
                const listingsRes = await axios.get(`https://api.agentboxcrm.com.au/listings?filter[contactId]=${contact.id}&version=2`, axiosConfig);
                contact.appraisals = listingsRes.data.response?.listings || [];

                // Data Injection from RP Data
                contact.beds = contact.beds || truthEntry['Bed'];
                contact.baths = contact.baths || truthEntry['Bath'];
                contact.cars = contact.cars || truthEntry['Car'];
                contact.propertyType = contact.propertyType || truthEntry['Property Type'];
                
                processedCount++;

                // Logging progress every 10 enriched contacts
                if (processedCount % 10 === 0) {
                    console.log(`Enriched and Cleaned ${processedCount} contacts... (Total scanned: ${i + 1}/${contacts.length})`);
                }

                // Periodic save every 50 enriched contacts to prevent data loss
                if (processedCount % 50 === 0) {
                    fs.writeFileSync(contactsPath, JSON.stringify(contactsData, null, 2));
                }

            } catch (error) {
                console.error(`Error for contact ${contact.name} (${contact.id}):`, error.message);
                if (error.response && error.response.status === 401) {
                    console.error('Unauthorized - Token may have expired. Stopping.');
                    break;
                }
            }
        }

        // 5. Final Save
        fs.writeFileSync(contactsPath, JSON.stringify(contactsData, null, 2));
        console.log(`Successfully completed enrichment. Enriched: ${processedCount}, Skipped: ${skippedCount}`);

    } catch (error) {
        console.error('Fatal execution error:', error.message);
    }
})();
