const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config({ path: '/root/.openclaw/.env' });

const SEEN_FILE = '/root/.openclaw/workspace/seen-listings.json';
const CONTACTS_FILE = '/root/.openclaw/workspace/willoughby-contacts.json';
const STATE_FILE = '/root/.openclaw/skills/agentbox-willoughby/browser-state.json';

// Load seen listings
let seen = fs.existsSync(SEEN_FILE)
  ? JSON.parse(fs.readFileSync(SEEN_FILE))
  : { listings: [], sold: [] };

// Load contacts
const contactsData = JSON.parse(fs.readFileSync(CONTACTS_FILE));
const contacts = contactsData.contacts;

// Send Telegram message
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return console.log('Telegram not configured');
  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
  const https = require('https');
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resolve);
    req.write(body);
    req.end();
  });
}

// Get top 15 most recently active contacts
function getTopContacts(n = 15) {
  return [...contacts]
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
    .slice(0, n)
    .map((c, i) => `${i+1}. ${c.name} — ${c.mobile || 'no mobile'} — ${c.email || 'no email'}`)
    .join('\n');
}

// Query Lexa GraphQL — works for both buy and sold
async function fetchREAListings(channel) {
  const res = await fetch('https://lexa.realestate.com.au/graphql?operationName=getSearchResults', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'da2-tqoyjxogtbhjljohnwmomlgyea',
      'x-caller-id': 'rea-search',
      'accept': '*/*',
      'origin': 'https://www.realestate.com.au',
      'referer': 'https://www.realestate.com.au/'
    },
    body: JSON.stringify({
      operationName: "getSearchResults",
      variables: {
        query: {
          channel: channel,
          filters: { surroundingSuburbs: false, excludeNoSalePrice: false, furnished: false, petsAllowed: false },
          localities: [{ searchLocation: "Willoughby, NSW 2068" }],
          sort: { sortKey: "LISTED_DATE", direction: "DESCENDING" }
        },
        page: 1,
        pageSize: 25
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "bf5f7f668de4a4a94e61ea2c6e4cdb97dda4bfac95dfb43d0bd28ad86fa6ffde"
        }
      }
    })
  });

  if (!res.ok) throw new Error(`Lexa HTTP ${res.status}`);
  const data = await res.json();
  return data?.data?.getLiveListingsWithMap?.results || 
         data?.data?.getSearchResults?.results ||
         data?.data?.results || [];
}

(async () => {
  console.log(`[${new Date().toLocaleString('en-AU', {timeZone:'Australia/Sydney'})}] Running Willoughby monitor...`);

  let newListings = [];
  let newSales = [];

  // --- CHECK NEW FOR SALE LISTINGS ---
  try {
    console.log('Checking FOR SALE listings...');
    const listings = await fetchREAListings('buy');
    console.log(`Found ${listings.length} active listings`);

    for (const item of listings) {
      const l = item?.listing || item;
      const id = l?.id || l?.listingId;
      const address = l?.address?.display?.fullAddress || l?.address?.displayAddress || 'Unknown address';
      const price = l?.price?.display || l?.priceDetails?.displayPrice || 'POA';
      const beds = l?.generalFeatures?.bedrooms?.value || '?';
      const baths = l?.generalFeatures?.bathrooms?.value || '?';
      const cars = l?.generalFeatures?.parkingSpaces?.value || '?';
      const type = l?.propertyType || '';
      const url = `https://www.realestate.com.au/property-${type}-nsw-willoughby-${id}`;

      if (id && !seen.listings.includes(String(id))) {
        newListings.push({ id, address, price, beds, baths, cars, type, url });
        seen.listings.push(String(id));
      }
    }
  } catch (e) {
    console.error('FOR SALE error:', e.message);
  }

  // --- CHECK NEW SOLD RESULTS ---
  try {
    console.log('Checking SOLD results...');
    const sales = await fetchREAListings('sold');
    console.log(`Found ${sales.length} sold results`);

    for (const item of sales) {
      const l = item?.listing || item;
      const id = l?.id || l?.listingId;
      const address = l?.address?.display?.fullAddress || l?.address?.displayAddress || 'Unknown address';
      const price = l?.price?.display || l?.priceDetails?.displayPrice || 'Undisclosed';
      const beds = l?.generalFeatures?.bedrooms?.value || '?';
      const baths = l?.generalFeatures?.bathrooms?.value || '?';
      const type = l?.propertyType || '';

      if (id && !seen.sold.includes(String(id))) {
        newSales.push({ id, address, price, beds, baths, type });
        seen.sold.push(String(id));
      }
    }
  } catch (e) {
    console.error('SOLD error:', e.message);
  }

  // --- SEND TELEGRAM ALERTS ---
  const contactList = getTopContacts(15);

  for (const listing of newListings) {
    const msg = `🏠 <b>NEW LISTING — Willoughby</b>\n\n` +
      `📍 <b>${listing.address}</b>\n` +
      `💰 ${listing.price}\n` +
      `🛏 ${listing.beds} bed | 🚿 ${listing.baths} bath | 🚗 ${listing.cars} car\n` +
      `🔗 ${listing.url}\n\n` +
      `📋 <b>Top Contacts to Call:</b>\n${contactList}`;
    await sendTelegram(msg);
    console.log(`✅ Alert sent: NEW LISTING ${listing.address}`);
  }

  for (const sale of newSales) {
    const msg = `🔨 <b>NEW SALE — Willoughby</b>\n\n` +
      `📍 <b>${sale.address}</b>\n` +
      `💰 ${sale.price}\n` +
      `🛏 ${sale.beds} bed | 🚿 ${sale.baths} bath\n\n` +
      `📋 <b>Top Contacts to Call:</b>\n${contactList}`;
    await sendTelegram(msg);
    console.log(`✅ Alert sent: NEW SALE ${sale.address}`);
  }

  if (newListings.length === 0 && newSales.length === 0) {
    console.log('No new listings or sales detected.');
  }

  // Save updated seen list
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
  console.log('Done. Seen list updated.');
})();
