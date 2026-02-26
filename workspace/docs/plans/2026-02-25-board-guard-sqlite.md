# Board-Full Guard SQLite Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the `recently-planned.json` board count in `daily-planner.js` with a live SQLite query against `daily_plans`, so the board-full guard is authoritative from the database rather than the JSON file.

**Architecture:** One targeted change inside `main()` — replace the 6-line block that loads the cooldown JSON and counts today's entries with a single `db.prepare(...).get(planDate).n` query. The JSON file (`recently-planned.json`) is not deleted — it still serves the 90-day cooldown filter and the `/api/contacts/today` endpoint. Only the board count moves to SQLite.

**Tech Stack:** Node.js, `better-sqlite3` via `/root/.openclaw/lib/db.js`, `/root/.openclaw/workspace/daily-planner.js`.

---

### Task 1: Replace the board-full guard

**Files:**
- Modify: `/root/.openclaw/workspace/daily-planner.js` (lines ~335–346)

**Step 1: Locate the block to replace**

Read the file and find the `─── BOARD STATE CHECK ───` section. It currently looks like this:

```javascript
// ─── BOARD STATE CHECK ───────────────────────────────────────────────────
const cooldown = loadCooldown();
const today = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' });
const todayCount = Object.values(cooldown).filter(e =>
    e.plannedAt && new Date(e.plannedAt).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' }) === today
).length;
const targetCalls = DAILY_TARGET - todayCount;
if (targetCalls <= 0) {
    console.log(`Board is full — ${todayCount} contacts already planned today. Nothing to do.`);
    return;
}
console.log(`Today's board: ${todayCount} already planned. Slots available: ${targetCalls}.`);
// ─────────────────────────────────────────────────────────────────────────
```

**Step 2: Replace it**

Replace the entire block above (10 lines including the banner comments) with:

```javascript
// ─── BOARD STATE CHECK ───────────────────────────────────────────────────
const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const cooldown = loadCooldown();
const todayCount = db.prepare(
    'SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = ?'
).get(planDate).n;
const targetCalls = DAILY_TARGET - todayCount;
if (targetCalls <= 0) {
    console.log(`Board is full — ${todayCount} contacts already planned today. Nothing to do.`);
    return;
}
console.log(`Today's board: ${todayCount} already planned. Slots available: ${targetCalls}.`);
// ─────────────────────────────────────────────────────────────────────────
```

Key changes:
- `planDate` uses `en-CA` (YYYY-MM-DD) locale — matching the format `writeToDB` already uses for `plan_date`
- `todayCount` now comes from SQLite, not JSON iteration
- `cooldown` load is kept (still needed for the 90-day cooldown filter below)
- `today` variable (en-AU format) is removed — only needed by the old JSON comparison

**Step 3: Update the writeToDB comment**

The comment above `writeToDB` (lines ~191–194) currently says:
```javascript
// If SQLite fails the error is logged but the script does NOT crash —
// recently-planned.json remains the authoritative fallback throughout migration.
```

Replace those two lines with:
```javascript
// If SQLite fails the error is logged but the script does NOT crash —
// recently-planned.json is kept for the 90-day cooldown filter; SQLite is authoritative for board count.
```

**Step 4: Verify syntax**

```bash
node --check /root/.openclaw/workspace/daily-planner.js && echo "✅ syntax ok"
```

Expected: `✅ syntax ok`

---

### Task 2: Verify the guard reads from SQLite

**Files:** No edits — verification only.

**Step 1: Check current daily_plans count for today**

```bash
cd /root/.openclaw && node -e "
const { db } = require('./lib/db.js');
const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const n = db.prepare('SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = ?').get(planDate).n;
console.log('SQLite daily_plans for', planDate + ':', n, 'rows');
"
```

Note the count — the live run will exit early if it's ≥ 80.

**Step 2: Run --dry-run to confirm the write path still works**

```bash
cd /root/.openclaw && node workspace/daily-planner.js --dry-run
```

Expected output (unchanged from before):
```
[dry-run] Skipping real data load — verifying SQLite writes with 3 mock contacts.
[db] SQLite: 3 contacts upserted → contacts + daily_plans.
[dry-run] daily_plans rows for <today>: [ ... ]
[dry-run] contacts rows: [ ... ]
[dry-run] Complete — recently-planned.json untouched, no Anthropic calls made.
```

**Step 3: Confirm the board guard logic with a manual trace**

```bash
cd /root/.openclaw && node -e "
const { db } = require('./lib/db.js');
const DAILY_TARGET = 80;
const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const todayCount = db.prepare('SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = ?').get(planDate).n;
const targetCalls = DAILY_TARGET - todayCount;
console.log('planDate:', planDate);
console.log('todayCount:', todayCount);
console.log('targetCalls:', targetCalls);
console.log(targetCalls <= 0 ? 'Would exit: board full' : 'Would proceed: slots available');
"
```

Expected: Matches the count from Step 1. If count ≥ 80, shows "Would exit: board full".

**Step 4: Commit**

```bash
cd /root/.openclaw
git add workspace/daily-planner.js
git commit -m "feat: migrate board-full guard from recently-planned.json to SQLite daily_plans"
```

---

## Completion Checklist

- [ ] Board-full guard reads from `daily_plans` SQLite table (not JSON iteration)
- [ ] `planDate` uses `en-CA` format, consistent with `writeToDB`
- [ ] `cooldown` is still loaded for the 90-day filter downstream
- [ ] `writeToDB` comment updated
- [ ] Syntax check passes
- [ ] Dry-run passes
- [ ] Manual trace shows correct board count
- [ ] Committed
