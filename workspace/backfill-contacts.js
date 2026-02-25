'use strict';
require('dotenv').config({ path: '/root/.openclaw/.env' });
const fs   = require('fs');
const path = require('path');
const { db } = require('../lib/db.js');

const CONTACTS_FILE = path.join(__dirname, 'willoughby-contacts.json');
const RP_DATA_FILE  = path.join(__dirname, 'rp_data.csv');

const AREA_SUBURBS = new Set([
  'WILLOUGHBY', 'NORTH WILLOUGHBY', 'WILLOUGHBY EAST',
  'NAREMBURN', 'ARTARMON', 'CHATSWOOD', 'CASTLE COVE',
  'MIDDLE COVE', 'CASTLECRAG',
]);

function normalizeSuburb(suburb) {
  if (!suburb) return '';
  const s = suburb.toUpperCase().trim();
  if (s === 'NORTH WILLOUGHBY' || s === 'WILLOUGHBY EAST') return 'WILLOUGHBY';
  return s;
}

function parseRPData() {
  if (!fs.existsSync(RP_DATA_FILE)) return new Map();
  const content = fs.readFileSync(RP_DATA_FILE, 'utf8');
  const lines   = content.split('\n');
  const headerLine = lines[2];
  if (!headerLine) return new Map();

  const parseLine = (line) => {
    const values = [];
    let current = '', inQuotes = false;
    for (const char of line) {
      if (char === '"')                  { inQuotes = !inQuotes; }
      else if (char === ',' && !inQuotes){ values.push(current.trim()); current = ''; }
      else                               { current += char; }
    }
    values.push(current.trim());
    return values;
  };

  const headers = parseLine(headerLine).map(h => h.replace(/"/g, ''));
  const map = new Map();
  for (let i = 3; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals  = parseLine(lines[i]).map(v => v.replace(/"/g, ''));
    const entry = {};
    headers.forEach((h, idx) => { entry[h] = vals[idx] || ''; });
    const street = (entry['Street Address'] || '').toUpperCase().trim();
    const suburb = normalizeSuburb(entry['Suburb']);
    const key    = `${street} ${suburb}`.trim();
    map.set(key, entry);
  }
  return map;
}

function calcScore(contact, rpEntry) {
  let score = 0;
  if (rpEntry?.['Sale Date']) {
    const m = rpEntry['Sale Date'].match(/\d{4}/);
    if (m && new Date().getFullYear() - parseInt(m[0]) > 7) score += 20;
  }
  if (contact.appraisals?.length > 0) score += 30;
  if (rpEntry?.['Owner Type'] === 'Rented') score += 15;
  const contactClass = contact.contactClass || '';
  if (contactClass.includes('Past Vendor')) score += 25;
  if (contactClass.includes('Prospective Vendor') && !contactClass.includes('Past Vendor')) score += 15;
  return score;
}

function main() {
  console.log('[backfill] Loading contacts and RP data...');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  } catch (err) {
    console.error(`[backfill] ❌ Failed to load contacts file: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw?.contacts)) {
    console.error('[backfill] ❌ Contacts file must have a top-level "contacts" array — aborting.');
    process.exit(1);
  }
  const rpMap   = parseRPData();
  const core    = raw.contacts.filter(c =>
    c.suburb && AREA_SUBURBS.has(c.suburb.toUpperCase().trim())
  );
  console.log(`[backfill] ${core.length} core-area contacts to upsert.`);
  console.log(`[backfill] ${rpMap.size} RP data entries loaded.`);

  const invalid = core.filter(c => !c.id || !c.name);
  if (invalid.length > 0) {
    console.error(`[backfill] ❌ ${invalid.length} contacts missing id or name — aborting.`);
    process.exit(1);
  }

  const upsert = db.prepare(`
    INSERT INTO contacts
      (id, name, mobile, email, address, suburb, state, postcode,
       contact_class, source, do_not_call, beds, baths, cars,
       property_type, occupancy, propensity_score, last_modified, updated_at)
    VALUES
      (@id, @name, @mobile, @email, @address, @suburb, @state, @postcode,
       @contact_class, @source, @do_not_call, @beds, @baths, @cars,
       @property_type, @occupancy, @propensity_score, @last_modified, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name             = excluded.name,
      mobile           = excluded.mobile,
      email            = excluded.email,
      address          = excluded.address,
      suburb           = excluded.suburb,
      state            = excluded.state,
      postcode         = excluded.postcode,
      contact_class    = excluded.contact_class,
      source           = excluded.source,
      do_not_call      = excluded.do_not_call,
      beds             = excluded.beds,
      baths            = excluded.baths,
      cars             = excluded.cars,
      property_type    = excluded.property_type,
      occupancy        = excluded.occupancy,
      propensity_score = excluded.propensity_score,
      last_modified    = excluded.last_modified,
      updated_at       = datetime('now')
  `);

  const runAll = db.transaction(() => {
    let upserted = 0;
    for (const c of core) {
      const street  = (c.address || '').toUpperCase().trim();
      const suburb  = normalizeSuburb(c.suburb || '');
      const rpKey   = `${street} ${suburb}`.trim();
      const rpEntry = rpKey ? rpMap.get(rpKey) : null;
      const score   = calcScore(c, rpEntry);
      const occupancy = rpEntry?.['Owner Type'] || null;

      upsert.run({
        id:               c.id,
        name:             c.name,
        mobile:           c.mobile       || null,
        email:            c.email        || null,
        address:          c.address      || null,
        suburb:           c.suburb       || null,
        state:            c.state        || 'NSW',
        postcode:         c.postcode     || null,
        contact_class:    c.contactClass || null,
        source:           c.source       || null,
        do_not_call:      (String(c.doNotCall || '').toUpperCase() === 'YES') ? 1 : 0,
        beds:             c.beds         || null,
        baths:            c.baths        || null,
        cars:             c.cars         || null,
        property_type:    c.propertyType || null,
        occupancy,
        propensity_score: score,
        last_modified:    c.lastModified || null,
      });
      upserted++;
    }
    return upserted;
  });

  const count = runAll();
  console.log(`[backfill] ✅ Done — ${count} contacts upserted.`);

  const total = db.prepare('SELECT COUNT(*) as n FROM contacts').get().n;
  console.log(`[backfill] contacts table now has ${total} total rows.`);

  const dist = db.prepare(`
    SELECT
      COUNT(CASE WHEN propensity_score >= 45 THEN 1 END) as high,
      COUNT(CASE WHEN propensity_score >= 20 AND propensity_score < 45 THEN 1 END) as medium,
      COUNT(CASE WHEN propensity_score > 0  AND propensity_score < 20 THEN 1 END) as low,
      COUNT(CASE WHEN propensity_score = 0  THEN 1 END) as zero
    FROM contacts
    WHERE UPPER(suburb) IN (${Array.from(AREA_SUBURBS).map(() => '?').join(',')})
  `).get(Array.from(AREA_SUBURBS));
  console.log('[backfill] Score distribution:', JSON.stringify(dist));
}

main();
