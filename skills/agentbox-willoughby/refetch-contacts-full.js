require('dotenv').config({ path: '../../.env' });
const { chromium } = require('playwright');
const fs = require('fs');

const STATEFILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const CONTACTSFILE = '/root/.openclaw/workspace/willoughby-contacts.json';
const BASE = 'https://mcgrathlovelocal.agentboxcrm.com.au/admin/api';

const SAVE_INTERVAL = 50; // Save every 50 pages

const SUBURBS = [
  { suburb: 'Willoughby',       postcode: '2068' },
  { suburb: 'North Willoughby', postcode: '2068' },
  { suburb: 'Willoughby East',  postcode: '2068' },
  { suburb: 'Naremburn',        postcode: '2065' },
  { suburb: 'Artarmon',         postcode: '2064' },
  { suburb: 'Chatswood',        postcode: '2067' },
  { suburb: 'Castle Cove',      postcode: '2069' },
  { suburb: 'Middle Cove',      postcode: '2068' },
  { suburb: 'Northbridge',      postcode: '2063' },
  { suburb: 'Lane Cove',        postcode: '2066' },
  { suburb: 'St Leonards',      postcode: '2065' },
  { suburb: 'Crows Nest',       postcode: '2065' }
];

function formatContact(c) {
  return {
    id: c.id,
    name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    salutation: c.salutation,
    email: c.email,
    mobile: c.mobile || c.homePhone || c.workPhone,
    homePhone: c.homePhone,
    workPhone: c.workPhone,
    address: c.streetAddress?.address || c.address,
    suburb: c.streetAddress?.suburb || c.suburb,
    state: c.streetAddress?.state || c.state || 'NSW',
    postcode: c.streetAddress?.postcode || c.postcode,
    contactClass: Array.isArray(c.contactClasses)
      ? c.contactClasses.filter(cc => cc.type === 'Standard').map(cc => cc.name).join(', ')
      : c.contactClass,
    source: c.source,
    status: c.status,
    doNotCall: c.communicationRestrictions?.doNotCall ? 'YES' : '',
    doNotEmail: c.communicationRestrictions?.doNotEmail ? 'YES' : '',
    lastModified: c.lastModified
  };
}

function save(contacts, lastPage, lastSuburbIdx) {
  console.log(`\n💾 Saving ${contacts.length} contacts to disk...`);
  fs.writeFileSync(CONTACTSFILE, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    total: contacts.length,
    lastPage: lastPage,
    lastSuburbIdx: lastSuburbIdx,
    contacts: contacts
  }, null, 2));

  const headers = 'Name,Email,Mobile,Home Phone,Work Phone,Address,Suburb,State,Postcode,Contact Class,Source,Status,Do Not Call,Do Not Email,Last Modified';
  const rows = contacts.map(c =>
    [c.name,c.email,c.mobile,c.homePhone,c.workPhone,c.address,c.suburb,c.state,
     c.postcode,c.contactClass,c.source,c.status,c.doNotCall,c.doNotEmail,c.lastModified]
    .map(v => JSON.stringify(v ?? '')).join(',')
  );
  fs.writeFileSync('/root/.openclaw/workspace/willoughby-contacts-full.csv', headers + '\n' + rows.join('\n'));
  console.log(`✅ Progress saved at Suburb Index ${lastSuburbIdx}, Page ${lastPage}.\n`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security'] });
  const context = fs.existsSync(STATEFILE)
    ? await browser.newContext({ storageState: STATEFILE, bypassCSP: true })
    : await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();

  let authToken = null;
  let clientId = null;
  page.on('request', request => {
    if (request.url().includes('api.agentboxcrm.com.au') && request.headers()['authorization']) {
      authToken = request.headers()['authorization'];
      clientId = request.headers()['x-client-id'];
    }
  });

  // Load existing contacts and detect resume point
  let allContacts = [];
  let resumePage = 1;
  let resumeSuburbIdx = 0;

  if (fs.existsSync(CONTACTSFILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONTACTSFILE));
      allContacts = data.contacts || [];
      // Rule 3: Automatically detect resume point
      if (data.lastPage) {
        resumePage = data.lastPage + 1;
        resumeSuburbIdx = data.lastSuburbIdx || 0;
        console.log(`Detected resume point: Suburb ${resumeSuburbIdx} (${SUBURBS[resumeSuburbIdx]?.suburb}), Page ${resumePage}`);
      } else {
          // Fallback if metadata missing: estimate from contact count (approx 100 per page)
          resumePage = Math.floor(allContacts.length / 100) + 1;
          console.log(`Metadata missing. Estimating resume point from contact count: Page ${resumePage}`);
      }
      console.log(`Loaded ${allContacts.length} existing contacts.`);
    } catch (e) {
      console.log('Error reading existing contacts, starting fresh.');
    }
  }
  
  // Use a map for deduplication
  const contactMap = new Map();
  allContacts.forEach(c => {
    const key = c.id || `${c.name}|${c.email}|${c.mobile}`;
    contactMap.set(key, c);
  });

  // Navigate to AgentBox directly so session cookies are scoped correctly
  await page.goto('https://app.sales.reapit.com.au/contacts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  if (page.url().includes('auth.au.rc.reapit.cloud')) {
    console.log('Session expired - re-logging in...');
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
    await page.waitForTimeout(3000);
    await context.storageState({ path: STATEFILE });
    console.log('Re-login successful and state saved.');
  }

  // Ensure we have the headers captured
  await page.waitForTimeout(5000);
  if (!authToken) {
    console.log('Waiting for background API call to capture headers...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
  }

  if (!authToken) {
    console.error('Failed to capture auth token. Exiting.');
    await browser.close();
    return;
  }

  for (let sIdx = resumeSuburbIdx; sIdx < SUBURBS.length; sIdx++) {
    const { suburb, postcode } = SUBURBS[sIdx];
    console.log(`\nFetching: ${suburb} (${postcode})...`);
    
    let p = (sIdx === resumeSuburbIdx) ? resumePage : 1;
    let last = p;

    do {
      const result = await page.evaluate(async ({ BASE, suburb, postcode, p, authToken, clientId }) => {
        const url = `${BASE}/contacts?filtersuburb=${encodeURIComponent(suburb)}&filterpostcode=${postcode}&limit=100&page=${p}&version=2`;
        const res = await fetch(url, {
          credentials: 'include',
          headers: { 
            'Accept': 'application/json', 
            'X-Requested-With': 'XMLHttpRequest',
            'Authorization': authToken,
            'x-client-id': clientId
          }
        });
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          return { status: res.status, contacts: data.response?.contacts || [], last: parseInt(data.response?.last) || 1 };
        } catch(e) {
          return { status: res.status, error: text.substring(0, 200), contacts: [], last: 1 };
        }
      }, { BASE, suburb, postcode, p, authToken, clientId });

      if (result.error) {
        console.log(`  ❌ Page ${p} Error (status ${result.status}): ${result.error}`);
        if (result.status === 401) {
            console.log('Unauthorized. Session might have expired.');
            break;
        }
        p++;
        continue;
      }

      last = result.last;
      const newIds = result.contacts.map(c => c.id).filter(id => !contactMap.has(id));
      
      if (newIds.length > 0) {
        process.stdout.write(`  Page ${p}/${last} — Fetching details for ${newIds.length} new contacts...`);
        
        const CONCURRENCY = 10;
        for (let i = 0; i < newIds.length; i += CONCURRENCY) {
          const batch = newIds.slice(i, i + CONCURRENCY);
          const detailsResults = await page.evaluate(async ({ BASE, ids, authToken, clientId }) => {
            return Promise.all(ids.map(async id => {
              try {
                const res = await fetch(`${BASE}/contacts/${id}?version=2`, {
                  credentials: 'include',
                  headers: { 
                    'Accept': 'application/json', 
                    'X-Requested-With': 'XMLHttpRequest',
                    'Authorization': authToken,
                    'x-client-id': clientId
                  }
                });
                const data = await res.json();
                return data.response?.contact || null;
              } catch(e) { return null; }
            }));
          }, { BASE, ids: batch, authToken, clientId });

          detailsResults.filter(Boolean).forEach(c => {
            contactMap.set(c.id, formatContact(c));
          });
          process.stdout.write(`.`);
        }
        process.stdout.write(` Total: ${contactMap.size}\n`);
      } else {
        console.log(`  Page ${p}/${last} — All contacts already processed. Total: ${contactMap.size}`);
      }
      
      // Rule 2: Batch the saves every 50 pages
      if (p % SAVE_INTERVAL === 0) {
          save(Array.from(contactMap.values()), p, sIdx);
      }
      
      p++;
    } while (p <= last);

    // Save at end of each suburb just in case
    save(Array.from(contactMap.values()), last, sIdx);
  }

  // Final save
  console.log(`\nFinal save...`);
  save(Array.from(contactMap.values()), 0, SUBURBS.length);

  console.log(`\n✅ Done! Total unique contacts: ${contactMap.size}`);
  await browser.close();
})();
