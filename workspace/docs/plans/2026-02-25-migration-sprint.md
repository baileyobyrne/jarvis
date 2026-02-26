# JARVIS Migration Sprint Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the JARVIS dashboard fully functional with real data — backfill the `contacts` table with all 3,327 core-area contacts (scored from RP data), align the `/api/status` endpoint to read from SQLite instead of `recently-planned.json`, and remove dead code.

**Architecture:** Three independent changes sharing the existing `lib/db.js` connection. No new packages. The backfill script is a one-shot tool (run once, idempotent via `ON CONFLICT DO UPDATE`). The status API change is a 3-line swap. Dead-code removal is a single-line delete.

**Tech Stack:** Node.js, `better-sqlite3` via `/root/.openclaw/lib/db.js`, Express (`/root/.openclaw/snapshot-server.js`), source data at `/root/.openclaw/workspace/willoughby-contacts.json` and `/root/.openclaw/workspace/rp_data.csv`.

---

### Task 1: Create `backfill-contacts.js`

**Files:**
- Create: `/root/.openclaw/workspace/backfill-contacts.js`

**Step 1: Write the file**

```javascript
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
  return score;
}

function main() {
  console.log('[backfill] Loading contacts and RP data...');
  const raw     = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const rpMap   = parseRPData();
  const core    = raw.contacts.filter(c =>
    c.suburb && AREA_SUBURBS.has(c.suburb.toUpperCase().trim())
  );
  console.log(`[backfill] ${core.length} core-area contacts to upsert.`);
  console.log(`[backfill] ${rpMap.size} RP data entries loaded.`);

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
        do_not_call:      c.doNotCall === 'Yes' ? 1 : 0,
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
    WHERE suburb IN (${Array.from(AREA_SUBURBS).map(() => '?').join(',')})
  `).get(...Array.from(AREA_SUBURBS));
  console.log('[backfill] Score distribution:', JSON.stringify(dist));
}

main();
```

**Step 2: Verify the file exists**

Run: `ls -la /root/.openclaw/workspace/backfill-contacts.js`
Expected: file exists, non-zero size

---

### Task 2: Run the backfill and verify

**Files:**
- Run: `/root/.openclaw/workspace/backfill-contacts.js` (no edits)

**Step 1: Run the backfill**

Run from `/root/.openclaw`:
```bash
node workspace/backfill-contacts.js
```

Expected output (exact numbers may vary):
```
[backfill] Loading contacts and RP data...
[backfill] 3327 core-area contacts to upsert.
[backfill] <N> RP data entries loaded.
[backfill] ✅ Done — 3327 contacts upserted.
[backfill] contacts table now has <≥3327> total rows.
[backfill] Score distribution: {"high":...,"medium":...,"low":...,"zero":...}
```

**Step 2: Verify search API works against real data**

Run:
```bash
node -e "
const { db } = require('./lib/db.js');
const results = db.prepare('SELECT id, name, mobile, address, suburb, propensity_score FROM contacts WHERE name LIKE ? LIMIT 5').all('%Wilson%');
console.log(JSON.stringify(results, null, 2));
console.log('Total contacts:', db.prepare('SELECT COUNT(*) as n FROM contacts').get().n);
"
```

Expected: At least one result with non-null address, mobile, propensity_score. Total >= 3000.

**Step 3: Verify nearby query works**

Run:
```bash
node -e "
const { db } = require('./lib/db.js');
const rows = db.prepare('SELECT name, address, suburb, propensity_score FROM contacts WHERE address LIKE ? ORDER BY propensity_score DESC LIMIT 5').all('%Alexander%');
console.log(JSON.stringify(rows, null, 2));
"
```

Expected: Rows with real addresses and propensity scores.

---

### Task 3: Update `GET /api/status` to read from SQLite

**Files:**
- Modify: `/root/.openclaw/snapshot-server.js` (lines ~178–201)

**Step 1: Locate the status handler**

The current handler reads `recently-planned.json`:
```javascript
const cooldown = fs.existsSync(COOLDOWN_FILE)
  ? JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'))
  : {};
const todayVals   = Object.values(cooldown).filter(e => isToday(e.plannedAt));
const todayCount  = todayVals.length;
const calledCount = todayVals.filter(e => e.calledAt).length;
```

**Step 2: Replace with SQLite queries**

Replace the 6 lines above with:
```javascript
const todayCount  = db.prepare(
  "SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = date('now','localtime')"
).get().n;
const calledCount = db.prepare(
  "SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = date('now','localtime') AND called_at IS NOT NULL"
).get().n;
```

Also remove the now-unused `cooldown` variable and the `isToday()` function call from this handler (the `isToday` helper itself can stay — it's used elsewhere). The updated `res.json(...)` block should still include `todayCount`, `calledCount`, `target: 80`, and `lastRun`.

**Step 3: Verify the change compiles**

Run:
```bash
node -e "require('/root/.openclaw/snapshot-server.js')" 2>&1 | head -5
```

Expected: Server starts (or fails on SSL cert — that's fine, not a syntax error). If you see `SyntaxError`, there's a code issue to fix.

**Step 4: Test the endpoint (if server is running)**

Run:
```bash
curl -sk https://localhost:4242/api/status | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d))" 2>/dev/null || echo "server not running — syntax check passed, manual restart needed"
```

---

### Task 4: Remove dead `MAKE_WEBHOOK_URL` import from `daily-planner.js`

**Files:**
- Modify: `/root/.openclaw/workspace/daily-planner.js` (line 14)

**Step 1: Confirm the variable is never used**

Run:
```bash
grep -n "MAKE_WEBHOOK_URL" /root/.openclaw/workspace/daily-planner.js
```

Expected: Only one line — the `const MAKE_WEBHOOK_URL = ...` declaration. No usages.

**Step 2: Delete the dead line**

Remove line 14:
```javascript
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
```

**Step 3: Verify the file still parses**

Run:
```bash
node --check /root/.openclaw/workspace/daily-planner.js && echo "✅ syntax ok"
```

Expected: `✅ syntax ok`

**Step 4: Commit**

```bash
cd /root/.openclaw
git add workspace/backfill-contacts.js workspace/daily-planner.js snapshot-server.js
git commit -m "feat: backfill contacts, migrate status API to SQLite, remove dead code"
```

---

### Task 5: Run daily-planner dry-run → verify → live run

**Files:**
- Run: `/root/.openclaw/workspace/daily-planner.js` (no edits)

**Step 1: Dry-run to verify SQLite write path works**

Run:
```bash
cd /root/.openclaw && node workspace/daily-planner.js --dry-run
```

Expected output:
```
[dry-run] Skipping real data load — verifying SQLite writes with 3 mock contacts.
[db] SQLite: 3 contacts upserted → contacts + daily_plans.
[dry-run] daily_plans rows for <today>: [ ... ]
[dry-run] contacts rows: [ ... ]
[dry-run] Complete — recently-planned.json untouched, no Anthropic calls made.
```

**Step 2: Check today's plan count before live run**

Run:
```bash
node -e "
const { db } = require('/root/.openclaw/lib/db.js');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const n = db.prepare('SELECT COUNT(*) as n FROM daily_plans WHERE plan_date = ?').get(today).n;
console.log('Plans for today:', n);
"
```

Expected: 3 (the DRY_RUN contacts from earlier). The live run will skip if board >= 80.

**Step 3: Live run (generates today's real call list)**

> ⚠️ This calls the Anthropic API (~80 contacts × ~$0.001 = ~$0.08). Confirm `.env` has `ANTHROPIC_API_KEY` set before running.

Check key is set:
```bash
grep "ANTHROPIC_API_KEY" /root/.openclaw/.env | cut -c1-30
```

If set, run the planner:
```bash
cd /root/.openclaw && node workspace/daily-planner.js 2>&1 | tee /tmp/planner-run.log
```

Expected output (abridged):
```
Loading contacts and RP data...
Area filter: ... contacts outside territory excluded. <N> in area.
Cooldown filter: ... contacts excluded. <M> eligible.
Scoring contacts...
<K> candidates selected. Generating talking points via Claude...
[db] SQLite: <K> contacts upserted → contacts + daily_plans.
```

**Step 4: Verify live plan data landed**

Run:
```bash
node -e "
const { db } = require('/root/.openclaw/lib/db.js');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const rows = db.prepare('SELECT dp.contact_id, c.name, c.mobile, c.address, dp.propensity_score, SUBSTR(dp.intel, 1, 60) as intel_preview FROM daily_plans dp LEFT JOIN contacts c ON c.id = dp.contact_id WHERE dp.plan_date = ? ORDER BY dp.propensity_score DESC LIMIT 5').all(today);
console.log(JSON.stringify(rows, null, 2));
"
```

Expected: 5 rows with real names, mobile numbers, addresses, propensity scores >= 20, and intel previews with bullet points.

---

## Completion Checklist

- [ ] `backfill-contacts.js` created and run successfully
- [ ] `contacts` table has ≥ 3,000 rows with real address/mobile/score data
- [ ] `GET /api/status` reads from `daily_plans` table (no `recently-planned.json` reads)
- [ ] `MAKE_WEBHOOK_URL` dead import removed from `daily-planner.js`
- [ ] Daily planner dry-run passes
- [ ] Daily planner live run generates today's call list with full intel/angle/tenure
- [ ] Changes committed
