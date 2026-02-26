'use strict';

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH            = path.join(__dirname, '..', 'workspace', 'jarvis.db');
const RECENTLY_PLANNED   = path.join(__dirname, '..', 'workspace', 'recently-planned.json');

// ---------------------------------------------------------------------------
// Open / create the database
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);

// Enable WAL for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------
db.exec(`
  -- -------------------------------------------------------------------------
  -- contacts
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS contacts (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    mobile           TEXT,
    address          TEXT,
    suburb           TEXT,
    state            TEXT DEFAULT 'NSW',
    postcode         TEXT,
    email            TEXT,
    contact_class    TEXT,
    source           TEXT,
    do_not_call      INTEGER DEFAULT 0,
    occupancy        TEXT,
    beds             TEXT,
    baths            TEXT,
    cars             TEXT,
    property_type    TEXT,
    tenure_years     INTEGER,
    propensity_score INTEGER DEFAULT 0,
    last_modified    TEXT,
    notes_raw        TEXT,
    notes_summary    TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now'))
  );

  -- -------------------------------------------------------------------------
  -- call_log
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS call_log (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id                TEXT NOT NULL,
    called_at                 TEXT DEFAULT (datetime('now')),
    outcome                   TEXT CHECK(outcome IN (
                                'connected','left_message','no_answer',
                                'not_interested','appraisal_booked',
                                'callback_requested','wrong_number'
                              )),
    notes                     TEXT,
    summary_for_agentbox      TEXT,
    planned_source            TEXT,
    propensity_score_at_call  INTEGER,
    FOREIGN KEY(contact_id) REFERENCES contacts(id)
  );

  -- -------------------------------------------------------------------------
  -- reminders
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id      TEXT,
    contact_name    TEXT NOT NULL,
    contact_mobile  TEXT,
    note            TEXT NOT NULL,
    fire_at         TEXT NOT NULL,
    sent            INTEGER DEFAULT 0,
    sent_at         TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  -- -------------------------------------------------------------------------
  -- market_events
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS market_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at       TEXT NOT NULL,
    event_date        TEXT,
    type              TEXT CHECK(type IN (
                        'listing','sold','price_change','unlisted',
                        'relisted','rental'
                      )),
    address           TEXT NOT NULL,
    suburb            TEXT,
    price             TEXT,
    price_previous    TEXT,
    price_withheld    INTEGER DEFAULT 0,
    proping_estimate  TEXT,
    estimate_delta    TEXT,
    days_on_market    INTEGER,
    beds              TEXT,
    baths             TEXT,
    cars              TEXT,
    property_type     TEXT,
    agent_name        TEXT,
    agency            TEXT,
    source            TEXT,
    is_rental         INTEGER DEFAULT 0,
    top_contacts      TEXT,
    created_at        TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_market_events_dedup
    ON market_events(address, type, event_date);

  CREATE INDEX IF NOT EXISTS idx_market_events_date
    ON market_events(detected_at DESC);

  -- -------------------------------------------------------------------------
  -- buyers
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS buyers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_address     TEXT NOT NULL,
    listing_agentbox_id TEXT,
    buyer_name          TEXT NOT NULL,
    buyer_mobile        TEXT,
    buyer_email         TEXT,
    enquiry_type        TEXT CHECK(enquiry_type IN (
                          'online_enquiry','inspection','callback','other'
                        )),
    enquiry_date        TEXT,
    notes               TEXT,
    status              TEXT DEFAULT 'active',
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now'))
  );

  -- -------------------------------------------------------------------------
  -- listing_details
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS listing_details (
    agentbox_id      TEXT PRIMARY KEY,
    address          TEXT,
    suburb           TEXT,
    beds             TEXT,
    baths            TEXT,
    cars             TEXT,
    land_area        TEXT,
    building_area    TEXT,
    category         TEXT,
    price_guide      TEXT,
    method           TEXT,
    auction_date     TEXT,
    headline         TEXT,
    description      TEXT,
    features         TEXT,
    council_rates    TEXT,
    water_rates      TEXT,
    strata_admin     TEXT,
    strata_sinking   TEXT,
    strata_total     TEXT,
    web_link         TEXT,
    listing_status   TEXT DEFAULT 'active',
    faqs             TEXT DEFAULT '[]',
    updated_at       TEXT DEFAULT (datetime('now','localtime'))
  );

  -- -------------------------------------------------------------------------
  -- intel_docs
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS intel_docs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filename        TEXT NOT NULL,
    file_type       TEXT,
    content_raw     TEXT,
    content_parsed  TEXT,
    uploaded_at     TEXT DEFAULT (datetime('now')),
    processed       INTEGER DEFAULT 0
  );

  -- -------------------------------------------------------------------------
  -- daily_plans
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS daily_plans (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date        TEXT NOT NULL,
    contact_id       TEXT NOT NULL,
    propensity_score INTEGER,
    intel            TEXT,
    angle            TEXT,
    tenure           TEXT,
    property_type    TEXT,
    occupancy        TEXT,
    called_at        TEXT,
    outcome          TEXT,
    notes            TEXT,
    source           TEXT DEFAULT 'daily_planner',
    created_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(plan_date, contact_id)
  );
`);

// ---------------------------------------------------------------------------
// Migration: recently-planned.json → contacts + daily_plans
// ---------------------------------------------------------------------------

/**
 * Reads recently-planned.json and populates:
 *   - contacts  (id, name — minimal stub so FK constraints are satisfied)
 *   - daily_plans (one row per entry, using plannedAt as plan_date)
 *
 * Safe to call multiple times — will only run when daily_plans is empty.
 */
function migrate() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM daily_plans').get().n;
  if (count > 0) {
    // Already migrated — skip
    return;
  }

  if (!fs.existsSync(RECENTLY_PLANNED)) {
    console.log('[db] No recently-planned.json found — skipping migration.');
    return;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RECENTLY_PLANNED, 'utf8'));
  } catch (err) {
    console.error('[db] Failed to parse recently-planned.json:', err.message);
    return;
  }

  const entries = Object.entries(raw); // [ [contactId, { plannedAt, name, cooldownDays }], ... ]
  if (entries.length === 0) {
    console.log('[db] recently-planned.json is empty — nothing to migrate.');
    return;
  }

  const upsertContact = db.prepare(`
    INSERT INTO contacts (id, name, created_at, updated_at)
    VALUES (@id, @name, @ts, @ts)
    ON CONFLICT(id) DO NOTHING
  `);

  const insertPlan = db.prepare(`
    INSERT OR IGNORE INTO daily_plans
      (plan_date, contact_id, source, created_at)
    VALUES
      (@plan_date, @contact_id, 'daily_planner', @created_at)
  `);

  const runMigration = db.transaction(() => {
    let imported = 0;
    for (const [contactId, entry] of entries) {
      const { plannedAt, name, cooldownDays } = entry;  // eslint-disable-line no-unused-vars

      // Ensure a contact stub exists so the FK in daily_plans is satisfied
      upsertContact.run({
        id:   contactId,
        name: name || contactId,
        ts:   plannedAt || new Date().toISOString(),
      });

      // Map plannedAt ISO string → YYYY-MM-DD date for plan_date
      let planDate = null;
      if (plannedAt) {
        planDate = plannedAt.substring(0, 10); // "2026-02-24"
      }

      insertPlan.run({
        plan_date:   planDate,
        contact_id:  contactId,
        created_at:  plannedAt || new Date().toISOString(),
      });

      imported++;
    }
    return imported;
  });

  try {
    const n = runMigration();
    console.log(`[db] Migration complete — ${n} entries imported from recently-planned.json.`);
  } catch (err) {
    console.error('[db] Migration failed:', err.message);
  }
}

// Run migration on first initialisation
migrate();

// ---------------------------------------------------------------------------
// Schema migrations — buyer call tracking columns
// ---------------------------------------------------------------------------
(function migrateBuyerColumns() {
  const existing = db.pragma('table_info(buyers)').map(r => r.name);
  if (!existing.includes('called_at')) {
    db.prepare('ALTER TABLE buyers ADD COLUMN called_at TEXT').run();
    console.log('[db] buyers.called_at column added.');
  }
  if (!existing.includes('outcome')) {
    db.prepare("ALTER TABLE buyers ADD COLUMN outcome TEXT CHECK(outcome IN ('interested','not_interested','appointment_booked','no_answer','left_message','voicemail','wrong_number'))").run();
    console.log('[db] buyers.outcome column added.');
  }
  if (!existing.includes('done_date')) {
    db.prepare('ALTER TABLE buyers ADD COLUMN done_date TEXT').run();
    console.log('[db] buyers.done_date column added.');
  }
})();

// ---------------------------------------------------------------------------
// Schema migrations — Pricefinder valuation columns
// ---------------------------------------------------------------------------
(function migratePriceFinderColumns() {
  const existing = db.pragma('table_info(contacts)').map(r => r.name);
  if (!existing.includes('pricefinder_estimate')) {
    db.prepare('ALTER TABLE contacts ADD COLUMN pricefinder_estimate TEXT').run();
    console.log('[db] contacts.pricefinder_estimate column added.');
  }
  if (!existing.includes('pricefinder_fetched_at')) {
    db.prepare('ALTER TABLE contacts ADD COLUMN pricefinder_fetched_at TEXT').run();
    console.log('[db] contacts.pricefinder_fetched_at column added.');
  }
})();

// ---------------------------------------------------------------------------
// Schema migrations — listing_details table
// ---------------------------------------------------------------------------
(function migrateListingDetailsTable() {
  const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listing_details'").get();
  if (!tableRow) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS listing_details (
        agentbox_id      TEXT PRIMARY KEY,
        address          TEXT,
        suburb           TEXT,
        beds             TEXT,
        baths            TEXT,
        cars             TEXT,
        land_area        TEXT,
        building_area    TEXT,
        category         TEXT,
        price_guide      TEXT,
        method           TEXT,
        auction_date     TEXT,
        headline         TEXT,
        description      TEXT,
        features         TEXT,
        council_rates    TEXT,
        water_rates      TEXT,
        strata_admin     TEXT,
        strata_sinking   TEXT,
        strata_total     TEXT,
        web_link         TEXT,
        listing_status   TEXT DEFAULT 'active',
        faqs             TEXT DEFAULT '[]',
        updated_at       TEXT DEFAULT (datetime('now','localtime'))
      )
    `).run();
    console.log('[db] listing_details table created.');
  }
})();

// ---------------------------------------------------------------------------
// Schema migrations — properties table (Pricefinder CSV import)
// ---------------------------------------------------------------------------
(function migratePropertiesTable() {
  const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='properties'").get();
  if (!tableRow) {
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
    console.log('[db] properties table created.');
  }
})();

// ---------------------------------------------------------------------------
// Schema migrations — historical_sales table (Pricefinder CSV import)
// ---------------------------------------------------------------------------
(function migrateHistoricalSalesTable() {
  const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='historical_sales'").get();
  if (!tableRow) {
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
    console.log('[db] historical_sales table created.');
  }
})();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { db, migrate };
