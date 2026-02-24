const fs = require('fs');
const { geocode, getDistance } = require('./geo-utils.js');

const CONTACTS_FILE = '/root/.openclaw/workspace/willoughby-contacts.json';
const contactsData = JSON.parse(fs.readFileSync(CONTACTS_FILE));
const contacts = contactsData.contacts || [];

const LOCAL_SUBURBS = [
  'willoughby', 'north willoughby', 'willoughby east',
  'chatswood', 'artarmon', 'naremburn', 'castle cove', 'middle cove'
];

// ─────────────────────────────────────────────────────────────────────────────
// STREET ADJACENCY MAP
// ─────────────────────────────────────────────────────────────────────────────
const ADJACENT_STREETS = {
  'penshurst': ['laurel', 'mowbray', 'willoughby', 'frenchs', 'victoria'],
  'willoughby': ['penshurst', 'mowbray', 'frenchs', 'laurel', 'clive'],
  'mowbray': ['penshurst', 'willoughby', 'sydney', 'artarmon'],
  'frenchs': ['willoughby', 'penshurst', 'clive', 'stanley'],
  'first avenue': ['second avenue', 'rosewall', 'penkivil', 'willoughby east'],
  'second avenue': ['first avenue', 'third avenue', 'rosewall'],
  'third avenue': ['second avenue', 'fourth avenue'],
  'fourth avenue': ['third avenue', 'willoughby east'],
  'rosewall': ['first avenue', 'second avenue', 'edith', 'mcclelland'],
  'penkivil': ['first avenue', 'rosewall', 'stanley'],
  'laurel': ['penshurst', 'willoughby', 'high'],
  'high': ['laurel', 'clive', 'penshurst'],
  'artarmon': ['mowbray', 'sydney', 'willoughby'],
  'sydney': ['mowbray', 'artarmon', 'willoughby'],
  'clive': ['willoughby', 'frenchs', 'high'],
  'stanley': ['frenchs', 'penkivil', 'willoughby']
};

function extractStreetName(address) {
  if (!address) return null;
  // Match number + street name (ignoring common suffixes)
  const match = address.match(/\d+[A-Za-z]?\s+([A-Za-z\s]+?)\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Place|Pl|Crescent|Cres|Way|Close|Lane|Ln|Parade|Pde|Boulevard|Blvd)/i);
  return match ? match[1].trim().toLowerCase() : null;
}

function isAdjacent(street1, street2) {
  if (!street1 || !street2) return false;
  const s1 = street1.toLowerCase().trim();
  const s2 = street2.toLowerCase().trim();
  if (s1 === s2) return true;
  return (ADJACENT_STREETS[s1] && ADJACENT_STREETS[s1].includes(s2)) ||
         (ADJACENT_STREETS[s2] && ADJACENT_STREETS[s2].includes(s1));
}

function isLocalSuburb(suburb) {
  if (!suburb) return false;
  const s = suburb.toLowerCase().trim();
  return LOCAL_SUBURBS.some(local => s.includes(local) || local.includes(s));
}

async function getProximityContacts(listingAddress, n = 20) {
  const listingStreet = extractStreetName(listingAddress);
  const listingSuburb = listingAddress.split(',').map(s => s.trim().toLowerCase()).find(s => LOCAL_SUBURBS.includes(s)) || 'willoughby';
  const listingCoords = await geocode(listingAddress);
  
  console.log(`Listing: "${listingAddress}" | Suburb: "${listingSuburb}" | Street: "${listingStreet}" | Coords: ${listingCoords ? JSON.stringify(listingCoords) : 'Failed to geocode'}`);

  // 1. FAST STRING-BASED PRE-FILTER
  // We filter 67k+ contacts down to a pool of ~100 high-potential matches before geocoding.
  const filteredPool = contacts
    .filter(c => c.mobile && c.doNotCall !== 'YES')
    .map(c => {
      let stringScore = 0;
      const contactStreet = extractStreetName(c.address);
      const contactSuburb = (c.suburb || '').toLowerCase().trim();

      if (contactSuburb === listingSuburb) stringScore += 50;
      if (contactStreet === listingStreet) stringScore += 100;
      else if (isAdjacent(listingStreet, contactStreet)) stringScore += 80;
      
      return { ...c, stringScore };
    })
    .filter(c => c.stringScore > 0)
    .sort((a, b) => b.stringScore - a.stringScore)
    .slice(0, 100); // Only geocode the top 100 most likely candidates

  console.log(`Pre-filtered to ${filteredPool.length} high-potential contacts.`);

  const scored = [];
  for (const c of filteredPool) {
    const contactStreet = extractStreetName(c.address);
    const contactSuburb = c.suburb || listingSuburb; // Fallback to listing suburb if missing
    
    // 1. IMPROVED GEOCODING ACCURACY: Append suburb to contact address
    const fullContactAddress = `${c.address}, ${contactSuburb}, NSW`;
    const contactCoords = await geocode(fullContactAddress);
    
    const distance = (listingCoords && contactCoords) 
      ? getDistance(listingCoords.lat, listingCoords.lon, contactCoords.lat, contactCoords.lon) 
      : null;

    // 2. STRICT DISTANCE CAP: Exclude if > 1500m
    if (distance === null || distance > 1500) {
      continue;
    }

    let score = c.stringScore; // Start with the string-based score
    let reasons = [];

    // Geographic Radius Scoring (High Priority)
    if (distance < 50) { score += 200; reasons.push('Super Close'); }
    else if (distance < 200) { score += 150; reasons.push('Next Door'); }
    else if (distance < 500) { score += 100; reasons.push('Within 500m'); }
    else if (distance < 1000) { score += 50; reasons.push('Within 1km'); }
    else { score += 10; reasons.push('Within 1.5km'); }

    // Recency boost
    const daysSinceModified = (Date.now() - new Date(c.lastModified)) / (1000 * 60 * 60 * 24);
    if (daysSinceModified < 30) score += 20;
    else if (daysSinceModified < 90) score += 10;
    else if (daysSinceModified < 365) score += 5;

    scored.push({ 
      ...c, 
      score, 
      reason: reasons[0] || (score > 100 ? 'Street Match' : 'Local'), 
      distance,
      allReasons: reasons.join(', ')
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

async function formatContacts(listingAddress, n = 20) {
  const results = await getProximityContacts(listingAddress, n);
  return results
    .map((c, i) => {
      const distStr = c.distance !== null ? ` (${c.distance}m away)` : '';
      return `${i+1}. ${c.name} — ${c.mobile}${c.address ? ' — ' + c.address : ''}${distStr} [${c.reason}]`;
    })
    .join('\n');
}

module.exports = { getProximityContacts, formatContacts, extractStreetName };
