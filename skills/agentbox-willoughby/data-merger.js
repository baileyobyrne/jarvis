const fs = require('fs');
const csv = require('csv-parser');
const readline = require('readline');

function normalise(addr) {
  if (!addr) return '';
  return addr.toLowerCase()
    .replace(/\b(street|st|road|rd|avenue|ave|drive|dr|court|ct|place|pl|crescent|cres|way|close|lane|ln|parade|pde|boulevard|blvd)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Treats North Willoughby and Willoughby East as synonymous with Willoughby.
 */
function normaliseSuburb(suburb) {
  if (!suburb) return '';
  let s = suburb.toLowerCase().trim();
  if (s.includes('willoughby')) return 'willoughby';
  return s.replace(/[^a-z0-9]/g, '');
}

/**
 * Groups property types into 'House' or 'Unit' categories.
 */
function categorizePropertyType(type) {
  if (!type) return 'Unknown';
  const t = type.toLowerCase();
  if (/house|semi|terrace|townhouse/i.test(t)) return 'House';
  if (/unit|apartment|flat|studio/i.test(t)) return 'Unit';
  return 'Other';
}

async function loadRPData() {
  const rpMap = new Map();
  const fileStream = fs.createReadStream('/root/.openclaw/skills/agentbox-willoughby/rp_data.csv');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineCount = 0;
  const rows = [];
  for await (const line of rl) {
    lineCount++;
    if (lineCount <= 2) continue;
    rows.push(line);
  }

  const { Readable } = require('stream');
  const s = Readable.from(rows.join('\n'));

  return new Promise((resolve) => {
    s.pipe(csv())
      .on('data', (row) => {
        const addr = row['Street Address'];
        const suburb = row['Suburb'];
        if (addr && suburb) {
          const key = normalise(addr) + '|' + normaliseSuburb(suburb);
          rpMap.set(key, {
            lastSaleDate: row['Sale Date'],
            ownerType: row['Owner Type'],
            propertyType: row['Property Type']
          });
        }
      })
      .on('end', () => resolve(rpMap));
  });
}

function calculatePropensityScore(contact, rpData, proximityScore) {
  let score = proximityScore;
  let tenure = 0;
  let occupancy = 'Unknown';

  if (rpData) {
    // Tenure: +10 points for every year owned
    if (rpData.lastSaleDate && rpData.lastSaleDate !== '-') {
      const saleDate = new Date(rpData.lastSaleDate);
      if (!isNaN(saleDate)) {
        const years = (new Date().getFullYear() - saleDate.getFullYear());
        tenure = years > 0 ? years : 0;
        score += (tenure * 10);
      }
    }

    // Occupancy: +20 points if 'Owner Occupier'
    occupancy = rpData.ownerType || 'Unknown';
    if (occupancy.toLowerCase().includes('owner occupied')) {
      score += 20;
    }
  }

  return { score, tenure, occupancy };
}

module.exports = { loadRPData, normalise, normaliseSuburb, calculatePropensityScore, categorizePropertyType };
