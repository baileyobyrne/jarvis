'use strict';
/**
 * import-pricefinder.js
 * One-time import of all Pricefinder CSV data into jarvis.db
 * Safe to re-run via UPSERT / INSERT OR IGNORE logic.
 *
 * Usage: node /root/.openclaw/scripts/import-pricefinder.js
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH  = path.join(__dirname, '..', 'workspace', 'jarvis.db');
const PF_DIR   = path.join(__dirname, '..', 'pricefinder');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // disable FK checks during bulk import

// Ensure tables exist (db.js migrations run on first require — but we don't require db.js
// here to avoid side effects; ensure tables exist directly)
db.prepare(`
  CREATE TABLE IF NOT EXISTS properties (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    government_number TEXT UNIQUE,
    address           TEXT NOT NULL,
    unit              TEXT,
    street_number     TEXT,
    street_name       TEXT,
    suburb            TEXT,
    postcode          TEXT DEFAULT '2068',
    beds              INTEGER,
    baths             INTEGER,
    cars              INTEGER,
    property_type     TEXT,
    land_area         TEXT,
    building_area     TEXT,
    build_year        TEXT,
    owner_name        TEXT,
    owner_occupier    INTEGER DEFAULT 1,
    valuation_amount  TEXT,
    valuation_date    TEXT,
    last_sale_price   TEXT,
    last_sale_date    TEXT,
    pf_phone          TEXT,
    do_not_call       INTEGER DEFAULT 0,
    contact_id        TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  )
`).run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_properties_street  ON properties(street_name, suburb)').run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_properties_suburb  ON properties(suburb)').run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_properties_contact ON properties(contact_id)').run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS historical_sales (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    address           TEXT NOT NULL,
    suburb            TEXT,
    sale_price        TEXT,
    sale_date         TEXT,
    settlement_date   TEXT,
    beds              INTEGER,
    baths             INTEGER,
    cars              INTEGER,
    property_type     TEXT,
    land_area         TEXT,
    agent_name        TEXT,
    agency            TEXT,
    government_number TEXT,
    days_on_market    INTEGER,
    created_at        TEXT DEFAULT (datetime('now')),
    UNIQUE(address, sale_date)
  )
`).run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_hist_sales_date   ON historical_sales(sale_date DESC)').run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_hist_sales_suburb ON historical_sales(suburb)').run();

// ─── CSV Parser ───────────────────────────────────────────────────────────────
/**
 * Parse a single CSV line, respecting quoted fields that may contain commas.
 * Returns array of field strings with surrounding quotes stripped.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Read all non-empty lines from a CSV file, split by '\n'.
 * Returns [headerFields, ...dataRows] where each row is an array of field strings.
 */
function readCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  return lines.map(parseCsvLine);
}

/**
 * Convert "DD/MM/YYYY" → "YYYY-MM-DD" (ISO format for SQLite sorting).
 * Returns null if the input doesn't match.
 */
function toIsoDate(dmyStr) {
  if (!dmyStr || !dmyStr.trim()) return null;
  const m = dmyStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Strip dollar sign, commas and spaces from price strings like "$1,250,000" */
function cleanPrice(p) {
  if (!p || !p.trim()) return null;
  const s = p.trim();
  if (s === '$0' || s === '0') return null;
  return s; // Keep formatted e.g. "$2,820,000"
}

/** Infer property type from building style and land use */
function inferPropertyType(buildingStyle, legalDesc, landUse, beds) {
  const bs = (buildingStyle || '').toUpperCase();
  const lu = (landUse || '').toUpperCase();
  const ld = (legalDesc || '').toUpperCase();

  if (/HOUSE|SEMI|VILLA|TERRACE|COTTAGE|BUNGALOW|DUPLEX/.test(bs)) return 'House';
  if (/APARTMENT|UNIT|FLAT|STUDIO/.test(bs)) return 'Unit';
  if (/TOWNHOUSE/.test(bs)) return 'Townhouse';
  if (ld.startsWith('SP') || /\/SP\d/.test(ld)) return 'Unit';
  if (lu === 'RESIDENCE') {
    const b = parseInt(beds) || 0;
    return b >= 4 ? 'House' : 'Unit';
  }
  return 'House';
}

// ─── Step A: pricefinder.csv → properties ─────────────────────────────────────
console.log('\n[import] Step A — pricefinder.csv → properties');

const pfRows = readCsv(path.join(PF_DIR, 'pricefinder.csv'));
const pfHeader = pfRows[0];
const pfData   = pfRows.slice(1);

// Column indices (0-based) verified against actual CSV header:
// Unit=4, Number=5, Street Name=6, Locality=7, Postcode=8
// Legal Description=9, Area=11, Building Area=12
// Bedrooms=13, Bathrooms=14, Car Parks=15, Build Year=17, Building Style=18
// Current Owners=22, Phone Number=24
// Last Sale=27, Last Sale Date=28, Owner Occupier=29, Land Use=30
// Valuation Date=33, Valuation Amount=34, Government Number=36

const upsertProperty = db.prepare(`
  INSERT INTO properties
    (government_number, address, unit, street_number, street_name, suburb, postcode,
     beds, baths, cars, property_type, land_area, building_area, build_year,
     owner_name, owner_occupier, valuation_amount, valuation_date,
     last_sale_price, last_sale_date, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?,
     ?, ?, ?, ?, ?, ?, ?,
     ?, ?, ?, ?,
     ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(government_number) DO UPDATE SET
    address          = excluded.address,
    unit             = excluded.unit,
    street_number    = excluded.street_number,
    street_name      = excluded.street_name,
    suburb           = excluded.suburb,
    beds             = excluded.beds,
    baths            = excluded.baths,
    cars             = excluded.cars,
    property_type    = excluded.property_type,
    land_area        = excluded.land_area,
    building_area    = excluded.building_area,
    build_year       = excluded.build_year,
    owner_name       = excluded.owner_name,
    owner_occupier   = excluded.owner_occupier,
    valuation_amount = excluded.valuation_amount,
    valuation_date   = excluded.valuation_date,
    last_sale_price  = excluded.last_sale_price,
    last_sale_date   = excluded.last_sale_date,
    updated_at       = datetime('now')
`);

let pfUpserted = 0;
let pfSkipped  = 0;

const runStepA = db.transaction(() => {
  for (const row of pfData) {
    const govNum        = row[36] || '';
    const ownerName     = row[22] || '';
    const unit          = row[4]  || '';
    const streetNum     = row[5]  || '';
    const streetName    = row[6]  || '';
    const locality      = row[7]  || '';
    const postcode      = row[8]  || '2068';
    const legalDesc     = row[9]  || '';
    const area          = row[11] || '';
    const buildingArea  = row[12] || '';
    const beds          = row[13] || '';
    const baths         = row[14] || '';
    const cars          = row[15] || '';
    const buildYear     = row[17] || '';
    const buildingStyle = row[18] || '';
    const lastSalePrice = row[27] || '';
    const lastSaleDate  = row[28] || '';
    const ownerOccupier = row[29] || '';
    const landUse       = row[30] || '';
    const valDate       = row[33] || '';
    const valAmount     = row[34] || '';

    // Skip strata body corporate rows
    if (ownerName.trim() === 'THE PROPRIETORS') {
      pfSkipped++;
      continue;
    }

    // Skip rows with no street data
    if (!streetName.trim() && !govNum.trim()) {
      pfSkipped++;
      continue;
    }

    const address = unit
      ? `${unit}/${streetNum} ${streetName}, ${locality}`
      : `${streetNum} ${streetName}, ${locality}`;

    const propertyType = inferPropertyType(buildingStyle, legalDesc, landUse, beds);
    const isOwnerOccupier = (ownerOccupier || '').toLowerCase() === 'true' ? 1 : 0;
    const saleDate = toIsoDate(lastSaleDate);
    const salePrice = cleanPrice(lastSalePrice);

    upsertProperty.run(
      govNum || null,
      address,
      unit || null,
      streetNum || null,
      streetName || null,
      locality || null,
      postcode || '2068',
      parseInt(beds) || null,
      parseInt(baths) || null,
      parseInt(cars) || null,
      propertyType,
      area || null,
      buildingArea || null,
      buildYear || null,
      ownerName || null,
      isOwnerOccupier,
      valAmount || null,
      valDate || null,
      salePrice,
      saleDate
    );
    pfUpserted++;
  }
});
runStepA();
console.log(`[import] properties: ${pfUpserted} upserted, ${pfSkipped} skipped (THE PROPRIETORS / empty)`);

// ─── Step B: pricefinder_sales.csv → historical_sales + market_events ──────────
console.log('\n[import] Step B — pricefinder_sales.csv → historical_sales');

const salesRows   = readCsv(path.join(PF_DIR, 'pricefinder_sales.csv'));
const salesData   = salesRows.slice(1); // skip header

// Column indices (0-based) verified against actual CSV header:
// Street Display=2, Unit=5, Number=6, Street Name=7, Locality=8
// Office Name=20, Agent Name=21, Days To Sell=26
// Sale Price=27, Sale Date=28, Settlement Date=29
// Area=31, Bedrooms=33, Bathrooms=34, Car Parks=35, Property Type=36
// Government Number=55

const insertSale = db.prepare(`
  INSERT OR IGNORE INTO historical_sales
    (address, suburb, sale_price, sale_date, settlement_date,
     beds, baths, cars, property_type, land_area,
     agent_name, agency, government_number, days_on_market)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMarketEvent = db.prepare(`
  INSERT OR IGNORE INTO market_events
    (detected_at, event_date, type, address, suburb, price,
     beds, baths, cars, property_type, agent_name, agency, source)
  VALUES (datetime('now','localtime'), ?, 'sold', ?, ?, ?,
          ?, ?, ?, ?, ?, ?, 'pricefinder_import')
`);

let salesInserted    = 0;
let eventsInjected   = 0;
const today = new Date();
const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

const runStepB = db.transaction(() => {
  for (const row of salesData) {
    const unit         = row[5]  || '';
    const streetNum    = row[6]  || '';
    const streetName   = row[7]  || '';
    const locality     = row[8]  || '';
    const agency       = row[20] || '';
    const agentName    = row[21] || '';
    const daysToSell   = row[26] || '';
    const salePrice    = row[27] || '';
    const saleDateRaw  = row[28] || '';
    const settleDateRaw = row[29] || '';
    const area         = row[31] || '';
    const beds         = row[33] || '';
    const baths        = row[34] || '';
    const cars         = row[35] || '';
    const propType     = row[36] || '';
    const govNum       = row[55] || '';

    if (!streetName.trim()) continue;

    const address = unit
      ? `${unit}/${streetNum} ${streetName}, ${locality}`
      : `${streetNum} ${streetName}, ${locality}`;

    const saleDate     = toIsoDate(saleDateRaw);
    const settleDate   = toIsoDate(settleDateRaw);
    const cleanedPrice = cleanPrice(salePrice);

    const r = insertSale.run(
      address,
      locality || null,
      cleanedPrice,
      saleDate,
      settleDate,
      parseInt(beds) || null,
      parseInt(baths) || null,
      parseInt(cars) || null,
      propType || null,
      area || null,
      agentName || null,
      agency || null,
      govNum || null,
      parseInt(daysToSell) || null
    );
    if (r.changes) salesInserted++;

    // Backfill recent sales into market_events (within 30 days)
    if (saleDate) {
      const saleDateObj = new Date(saleDate);
      if (saleDateObj >= thirtyDaysAgo) {
        const mr = insertMarketEvent.run(
          saleDate,
          address,
          locality || null,
          cleanedPrice,
          parseInt(beds) || null,
          parseInt(baths) || null,
          parseInt(cars) || null,
          propType || null,
          agentName || null,
          agency || null
        );
        if (mr.changes) eventsInjected++;
      }
    }
  }
});
runStepB();
console.log(`[import] historical_sales: ${salesInserted} inserted`);
console.log(`[import] market_events: ${eventsInjected} recent sales injected`);

// ─── Step C: Phone CSVs → enrich contacts + properties ────────────────────────
console.log('\n[import] Step C — phone CSVs → contacts + properties');

const phoneFiles = [
  path.join(PF_DIR, 'pricefinder_phone_willoughby.csv'),
  path.join(PF_DIR, 'pricefinder_phone_northwilloughby.csv'),
  path.join(PF_DIR, 'pricefinder_phone_willoughbyeast.csv'),
];

const updateContactMobile = db.prepare(`
  UPDATE contacts SET mobile = ?
  WHERE id = ? AND (mobile IS NULL OR mobile = '')
`);
const updateContactDnc = db.prepare(`
  UPDATE contacts SET do_not_call = 1 WHERE id = ?
`);
const updatePropertyPhone = db.prepare(`
  UPDATE properties SET pf_phone = ?
  WHERE LOWER(address) LIKE ?
    AND (pf_phone IS NULL OR pf_phone = '')
`);
const insertNewContact = db.prepare(`
  INSERT OR IGNORE INTO contacts
    (id, name, mobile, address, suburb, postcode, source, do_not_call, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, '2068', 'Pricefinder', ?, datetime('now'), datetime('now'))
`);

let mobilesEnriched   = 0;
let newContactsCreated = 0;
let dncFlagged        = 0;

for (const filePath of phoneFiles) {
  if (!fs.existsSync(filePath)) {
    console.log(`[import] Skipping missing file: ${path.basename(filePath)}`);
    continue;
  }

  const rows   = readCsv(filePath);
  const data   = rows.slice(1); // skip header

  // Columns: Street Number=0, Street=1, Locality=2, Surname=4, Initials=5, Phone No.=7
  for (const row of data) {
    const streetNum  = (row[0] || '').trim();
    const street     = (row[1] || '').trim();
    const locality   = (row[2] || '').trim();
    const surname    = (row[4] || '').trim();
    const initials   = (row[5] || '').trim();
    const phoneField = (row[7] || '').trim();

    if (!streetNum || !street) continue;

    const isDnc   = phoneField === 'Phone no. exists on DNCR';
    const phone   = isDnc ? null : (phoneField || null);
    const addrKey = `${streetNum} ${street}`.toLowerCase();
    const fullAddress = `${streetNum} ${street}, ${locality}`;

    // Find matching contact by address
    const matchingContacts = db.prepare(`
      SELECT id FROM contacts
      WHERE LOWER(address) LIKE ?
      LIMIT 3
    `).all(`%${addrKey}%`);

    if (matchingContacts.length > 0) {
      for (const { id } of matchingContacts) {
        if (phone) {
          const r = updateContactMobile.run(phone, id);
          if (r.changes) mobilesEnriched++;
        }
        if (isDnc) {
          updateContactDnc.run(id);
          dncFlagged++;
        }
      }
      // Also update the property record
      if (phone) {
        updatePropertyPhone.run(phone, `%${addrKey}%`);
      }
    } else {
      // No contact match — create new contact
      const contactId = `pf_${addrKey.replace(/\s+/g, '_')}_${locality.toLowerCase().replace(/\s+/g, '_')}`;
      const name = [initials, surname].filter(Boolean).join(' ') || 'Unknown';
      const r = insertNewContact.run(
        contactId,
        name,
        phone || null,
        fullAddress,
        locality,
        isDnc ? 1 : 0
      );
      if (r.changes) {
        newContactsCreated++;
        if (isDnc) dncFlagged++;
      }
      // Update property pf_phone if we have one
      if (phone) {
        updatePropertyPhone.run(phone, `%${addrKey}%`);
      }
    }
  }
}

console.log(`[import] contacts: ${mobilesEnriched} mobiles enriched, ${newContactsCreated} new contacts created, ${dncFlagged} DNCR flagged`);

// ─── Step D: Link properties ↔ contacts ───────────────────────────────────────
console.log('\n[import] Step D — linking properties to contacts');

const linkResult = db.prepare(`
  UPDATE properties SET contact_id = (
    SELECT c.id FROM contacts c
    WHERE LOWER(c.address) LIKE '%' || LOWER(properties.street_number) || ' ' || LOWER(properties.street_name) || '%'
      AND (LOWER(COALESCE(c.suburb,'')) LIKE '%willoughby%' OR LOWER(COALESCE(properties.suburb,'')) LIKE '%willoughby%')
    LIMIT 1
  )
  WHERE contact_id IS NULL
    AND properties.street_number IS NOT NULL
    AND properties.street_name IS NOT NULL
`).run();

console.log(`[import] contact_id links: ${linkResult.changes} properties linked`);

// ─── Step E: Enrich contacts from properties ───────────────────────────────────
console.log('\n[import] Step E — enriching contacts from properties');

const enrichResult = db.prepare(`
  UPDATE contacts SET
    beds             = COALESCE(NULLIF(contacts.beds, ''),   CAST(p.beds AS TEXT)),
    baths            = COALESCE(NULLIF(contacts.baths, ''),  CAST(p.baths AS TEXT)),
    property_type    = COALESCE(NULLIF(contacts.property_type, ''), p.property_type),
    pricefinder_estimate = COALESCE(NULLIF(contacts.pricefinder_estimate, ''), p.valuation_amount)
  FROM properties p
  WHERE contacts.id = p.contact_id
    AND p.contact_id IS NOT NULL
`).run();

console.log(`[import] contact enrichment: ${enrichResult.changes} contacts enriched with beds/baths/type/valuation`);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n[import] ✅ Complete.');
const propCount  = db.prepare('SELECT COUNT(*) AS n FROM properties').get().n;
const salesCount = db.prepare('SELECT COUNT(*) AS n FROM historical_sales').get().n;
const dncCount   = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE do_not_call = 1").get().n;
console.log(`[import] Final counts:`);
console.log(`  properties:       ${propCount}`);
console.log(`  historical_sales: ${salesCount}`);
console.log(`  contacts DNCR:    ${dncCount}`);

db.close();
