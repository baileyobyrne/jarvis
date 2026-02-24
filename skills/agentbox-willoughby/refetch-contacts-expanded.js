require('dotenv').config({ path: '/root/.openclaw/.env' });
const { chromium } = require('playwright');
const fs = require('fs');

const STATE_FILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';
const CONTACTS_FILE = '/root/.openclaw/workspace/willoughby-contacts.json';

const TARGET_SUBURBS = [
  'Willoughby', 'North Willoughby', 'Willoughby East', 
  'Chatswood', 'Artarmon', 'Naremburn', 
  'Castle Cove', 'Middle Cove', 'St Leonards', 'Crows Nest'
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = fs.existsSync(STATE_FILE)
    ? await browser.newContext({ storageState: STATE_FILE })
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
  await page.waitForTimeout(4000);
  if (!authToken) throw new Error('Could not capture auth token');

  let allContacts = [];
  
  for (const suburb of TARGET_SUBURBS) {
    let page_num = 1, lastPage = 1;
    console.log(`\nFetching contacts for ${suburb}...`);
    do {
      const res = await context.request.get(
        `https://api.agentboxcrm.com.au/contacts?filter[suburb]=${encodeURIComponent(suburb)}&limit=100&page=${page_num}&version=2`,
        { headers: { 'Authorization': authToken, 'x-client-id': clientId, 'Accept': 'application/json' } }
      );
      
      const data = await res.json();
      const contacts = data.response?.contacts || [];
      lastPage = parseInt(data.response?.last) || 1;
      
      allContacts = allContacts.concat(contacts);
      console.log(`  Page ${page_num}/${lastPage} — ${contacts.length} fetched`);
      
      page_num++;
    } while (page_num <= lastPage);
  }

  // Deduplicate to ensure no overlaps
  const uniqueContacts = Array.from(new Map(allContacts.map(c => [c.id || `${c.firstName}${c.lastName}${c.mobile}`, c])).values());
  console.log(`\nTotal unique contacts fetched across all suburbs: ${uniqueContacts.length}`);

  const formatted = uniqueContacts.map(c => ({
    name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    salutation: c.salutation || '',
    email: c.email || '',
    mobile: c.mobile || c.homePhone || c.workPhone || '',
    homePhone: c.homePhone || '',
    workPhone: c.workPhone || '',
    address: c.address || c.streetAddress || c.homeAddress || '',
    suburb: c.suburb || c.city || '',
    state: c.state || '',
    postcode: c.postcode || '',
    contactClass: Array.isArray(c.contactClass) ? c.contactClass.join(' / ') : (c.contactClass || ''),
    source: c.source || '',
    status: c.status || '',
    lastModified: c.lastModified || ''
  }));

  // Overwrite the existing JSON file used by the bot
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify({ 
    fetchedAt: new Date().toISOString(), 
    total: formatted.length, 
    contacts: formatted 
  }, null, 2));

  // Write an updated CSV for you to download
  const headers = ['Name','Email','Mobile','Home Phone','Work Phone','Address','Suburb','State','Postcode','Contact Class','Source','Status','Last Modified'];
  const rows = formatted.map(c => 
    [c.name, c.email, c.mobile, c.homePhone, c.workPhone, c.address, c.suburb, c.state, c.postcode, c.contactClass, c.source, c.status, c.lastModified]
    .map(v => JSON.stringify(v || '')).join(',')
  );
  const csv = [headers.join(','), ...rows].join('\n');
  fs.writeFileSync('/root/.openclaw/workspace/expanded-contacts.csv', csv);
  
  console.log(`\nDone! Saved to ${CONTACTS_FILE} and expanded-contacts.csv`);
  await browser.close();
})();
