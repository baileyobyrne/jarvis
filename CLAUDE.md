# JARVIS: Real Estate Automation (Willoughby)
Technical architecture for an autonomous real estate monitoring and prospecting engine.

## 🏗️ System Architecture: The Dual-Stream Pipeline
1. **Pipeline A (Reactive):** `monitor-email.js`
   - **Trigger:** Cron job 3× daily — approx. 7am, 12pm, 5pm AEDT (21:00, 02:00, 07:00 UTC). *(Previously documented as "every 15 minutes" — corrected to match `cron/jobs.json`.)*
   - **Function:** Monitors Gmail for REA, Domain, and Homely alerts[cite: 1569, 2393]. Also parses CoreLogic/RP Data forwarded emails.
   - **Logic:** Applies a 1.5km geofence and Haversine proximity scoring to AgentBox contacts[cite: 1569, 2394]. CoreLogic rentals write `occupancy: "Investor"` back to the shadow DB.
   - **Output:** All email sources (CoreLogic, REA/Domain, Weekly Wrap, Proping) funnel through `processMarketEvent(details, rpMap, opts)` — the single save path. Steps: farm gate → score 20 contacts → write `market_events` → write `listing-alerts.json` (listing/sold only) → optional individual Telegram. CoreLogic and Proping skip individual Telegram (Proping sends a consolidated digest instead). `opts.sendTelegram = true` for REA/Domain/Weekly Wrap.
   - **Call board vs Market data sources (CRITICAL):** `listing-alerts.json` is the ONLY data source for the Just Sold/Just Listed call board columns (`GET /api/alerts`). `market_events` SQLite feeds the Market page only. An event that only reaches `market_events` (without also writing `listing-alerts.json`) will appear in Market but NOT in the call board. Always use `processMarketEvent()` to guarantee both are written.
   - **`processProping()` signature (updated 2026-02-28):** `processProping(events, receivedDate, testMode, rpMap = new Map())` — rpMap is now 4th param. Each Proping event now routes through `processMarketEvent()` for full contact scoring and `listing-alerts.json` write.

2. **Pipeline B (Proactive):** `daily-planner.js`
   - **Trigger:** Cron job Mon–Fri at 7:00 AM AEDT[cite: 1599, 2397] (`0 20 * * 1-5` UTC).
   - **Function:** Parses CoreLogic/RP Data CSVs and McGrath email forwards[cite: 1570, 2393].
   - **Logic:** Calculates "Propensity to Sell" scores (Tenure > 7yrs = +20, past appraisals = +30, investor status = +15, Past Vendor = +25, Prospective Vendor = +15)[cite: 2398]. Score tiers: Prime ≥45, Warm 20–44, Cold <20. Distribution (3,327 contacts): prime=149, warm=406, low=1374, zero=1446. Syncs Notion contacted statuses → 180-day local cooldown. Local planned contacts get 90-day cooldown.
   - **Output:** Writes scored contacts with Claude-generated talking points to **SQLite** (`daily_plans` + `contacts` tables). Board-full guard (30 slots) reads from SQLite `daily_plans` ✅.

## 📋 Notion Command Center Schema
The pipeline writes to a single Notion database. Confirmed property schema:

| Property | Notion Type | Notes |
|---|---|---|
| `Contact Name` | title | Primary key — used for name-matching in cooldown sync |
| `Property Address` | rich_text | Street address + suburb |
| `Mobile` | phone_number | AgentBox mobile number |
| `Propensity Score` | number | 0–65 range (tenure + appraisals + investor) |
| `AI Strategy` | rich_text | Bullet-point talking points; also written as page body block |
| `Status` | status | `🎯 To Call Today` · `🗣️ Connected` · `⏳ Left Message` · `🤝 Appraisal Booked` · `🚫 Not Interested` |
| `Source` | select | `Market Event` (Pipeline A) · `Daily Planner` (Pipeline B) |
| `Tenure` | rich_text | e.g. "11 years" |

Cooldown rules driven by Status: `🗣️ Connected`, `⏳ Left Message`, `🤝 Appraisal Booked`, `🚫 Not Interested` → 180-day lockout in `recently-planned.json`.

## 🔄 Planned Migration: Notion → Custom Web Dashboard
The Notion Command Center will be replaced by a self-hosted web dashboard on the VPS. Migration layers:

**1. Database — SQLite on VPS**
- Single `contacts` table mirrors the Notion schema above
- `status_history` audit table for status transitions
- `cooldowns` table replaces `recently-planned.json` JSON file
- Cooldown sync logic (`syncNotionCooldowns`) becomes a SQL `COUNT`/`WHERE` query

**2. API — Express on VPS**
- Write endpoints (replace `notion.pages.create` calls in both pipelines)
  - `POST /api/contacts` — called by `daily-planner.js` and `monitor-email.js`
- Read/update endpoints for the React frontend
  - `GET /api/contacts?status=...` — fetch board columns
  - `PATCH /api/contacts/:id/status` — update status (replaces Notion UI interaction)
  - `GET /api/stats` — board counts for pre-flight check in `daily-planner.js`
- Both pipeline scripts updated to `POST` to `http://localhost:{PORT}/api/contacts` instead of `notion.pages.create`

**3. Frontend — React served by Express**
- Kanban board with the five status columns
- Propensity Score + AI Strategy display per card
- Click-to-call mobile links
- Daily Planner view: today's 80 contacts with scores + talking points
- Source badge (Market Event vs Daily Planner)

**Migration state (as of 2026-02-25):** Pipeline scripts write to SQLite ✅. Notion dependency decommissioned ✅. `contacts` table has 3,327 rows with real data (backfilled via `workspace/backfill-contacts.js`). Dashboard is a 3-file React SPA: `workspace/dashboard/index.html` (CDN shell, 18 lines), `workspace/dashboard/dashboard.js` (React components, Babel), `workspace/dashboard/dashboard.css` (Intelligence Terminal design tokens). `/api/contacts/today` is a legacy endpoint reading `recently-planned.json` — use `/api/plan/today` (SQLite) for current data. `/api/history` queries `call_log JOIN contacts` for real call history. Board-full guard and `/api/status` both read from SQLite ✅. Pricefinder integration: 3 local scripts (`pricefinder-estimates-local.js`, `pricefinder-market-local.js`, `pricefinder-prospecting-local.js`) run on Mac and POST to VPS endpoints.

## 🛡️ Critical Safety Rules
- **READ-ONLY CRM:** Never write automated data directly to AgentBox via API to avoid scraping bans.
- **Shadow Database:** Query the local `willoughby-contacts.json` (67,316 contacts) instead of the live CRM[cite: 2392, 2398].
- **Geocoding Hygiene:** Respect Nominatim rate limits (1.1s delay) and use `geo-cache.json` for geocoding[cite: 2346, 2347].
- **API Tokens:** Use `../../.env` for all secrets — resolves to `/root/.openclaw/.env` (AgentBox, OpenAI, Anthropic, Telegram)[cite: 1209, 2388].
- **`snapshot-server.js`:** `DASHBOARD_PASSWORD` is loaded from `.env` via `process.env.DASHBOARD_PASSWORD` — startup guard refuses to start if missing. CLAUDE.md is intentionally excluded from `SNAPSHOT_FILES` to avoid bundling documentation. Server runs on HTTPS port 4242 at `72.62.74.105`.

## 📂 Workspace Topology
- **Production Scripts:** `/root/.openclaw/skills/agentbox-willoughby/`
- **Data Layer:** `/root/.openclaw/workspace/`
- **Core Files:** `monitor-email.js`, `get-contacts.js`, `geo-utils.js`, `willoughby-contacts.json`[cite: 1567, 1585].
- **Cron Schedule:** `/root/.openclaw/cron/jobs.json`
- **Snapshot Server:** `/root/.openclaw/snapshot-server.js` (PM2-managed, port 4242)
- **DB initialisation & migrations:** `/root/.openclaw/lib/db.js` — `snapshot-server.js` delegates to this. Add new columns here using `try { db.prepare('ALTER TABLE t ADD COLUMN ...').run(); } catch (_) {}` pattern.

## 🛠️ Common Commands
- **API testing (curl):** `source /root/.openclaw/.env && curl -sk -X POST https://localhost:4242/api/... -H "Authorization: Bearer $DASHBOARD_PASSWORD" -H "Content-Type: application/json" -d '{...}'` — NOTE: `source /root/.openclaw/.env` fails in bash (non-bash content on line 8). Use Node.js `require('dotenv').config()` instead; never source .env directly in shell scripts.
- **dotenv outside agentbox-willoughby dir:** use `require('/root/.openclaw/skills/agentbox-willoughby/node_modules/dotenv').config(...)` for scripts in `/tmp` or `/root/.openclaw/scripts/`.
- **Background process watching:** `wait PID` only works for child PIDs of the current shell. Use `while kill -0 PID 2>/dev/null; do sleep 60; done` to watch an arbitrary PID from a different shell session.
- **Test Pipeline A:** `node monitor-email.js` [cite: 2388]
- **Test Pipeline B:** `node daily-planner.js` [cite: 1215]
- **Update Database:** `node refetch-contacts-full.js` (uses Playwright session-interception)[cite: 1699, 2335].
- **SQLite positional params:** `db.prepare(...).get(Array.from(set))` — NOT `.get(...Array.from(set))`. Spreading a Set/Array as rest args silently binds only the first value; pass a single array.
- **Suburb filter discrepancy:** `workspace/backfill-contacts.js` covers 9 suburbs (core farm). `daily-planner.js` covers 12 (adds NORTHBRIDGE, LANE COVE, ST LEONARDS, CROWS NEST). Contacts from the extra 4 suburbs get minimal stubs in `contacts`, no RP enrichment.
- **lucide-react CDN (index.html):** `lucide-react` UMD factory looks for `global.react` (lowercase). React CDN sets `window.React` (uppercase). Fix: add `<script>window.react = window.React;</script>` **before** the lucide-react script tag. Global destructure: `const { Phone, ... } = LucideReact;` (PascalCase).
- **Playwright on VPS root:** Global install at `/usr/lib/node_modules/playwright`. Launch flags required: `args: ['--no-sandbox', '--disable-dev-shm-usage']`. Pricefinder lookup: `node workspace/pricefinder-lookup.js` (batch) or `node workspace/pricefinder-lookup.js --address "123 Main St"` (single). **MCP Playwright (`mcp__plugin_playwright`) cannot run as root** — Chrome sandbox restriction; use a project Playwright Node.js script instead.
- **SQLite string literals:** Use single quotes `'|'` not double quotes `"|"`. Double quotes are identifier delimiters in SQLite.
- **`buildScoredContactsForManual()` (snapshot-server.js):** Extracts a street keyword from the event address (strips leading number/unit + trailing street type, takes last word), awards +1000 score bonus to contacts on the same street, and excludes the vendor (contact whose address matches the event property). Returns up to 30 contacts.
- **`properties` table address format:** UPPERCASE, abbreviated street types (AVENUE→AVE, STREET→ST, ROAD→RD). Suburbs covered: ARTARMON, CASTLECRAG, CHATSWOOD, MIDDLE COVE, NAREMBURN, NORTH WILLOUGHBY, WILLOUGHBY, WILLOUGHBY EAST. Not every street is present. When matching against market_events addresses, normalise abbreviations first. `market_events.proping_estimate` stores the pricefinder valuation for that property.
- **Manual market events:** Addresses are normalised to UPPERCASE before DB storage to match the `properties` table format. After fixing scoring logic, delete and re-POST an event via API to rebuild its `top_contacts`.
- **`market_events` lifecycle columns (added 2026-02-27):** `confirmed_price TEXT`, `sold_date TEXT`, `status TEXT` (active/sold/withdrawn — backfilled from type), `linked_event_id INTEGER`. `PATCH /api/market-events/:id` accepts all four.
- **`GET /api/search`** — UNION ALL across `properties` + unlinked `contacts` (~11,554 total records). `_sort` col uses `printf('%06d', CAST(address AS INTEGER))` prefix for correct numeric address ordering (handles "15a" → 15).
- **PM2 env caching:** PM2 stores env vars at launch; even blank values block `dotenv.config()` from overriding. Use `require('dotenv').config({ path: '/root/.openclaw/.env', override: true })` in any server file managed by PM2.
- **PM2 new env vars:** `pm2 restart jarvis-snapshot --update-env` — plain `restart` silently ignores new vars added to `.env` since last launch.
- **Dashboard CSS tokens:** Always use `var(--gold)` (`#C8A96E`), `var(--gold-bright)` (`#DFC08A`), `var(--gold-glow)` for gold accents. Never hardcode `#d4a843` — it's a different shade. Backgrounds: `--bg-base` (#080C0F), `--bg-surface` (#0D1117), `--bg-raised` (#121920). Text: `--text-primary` (#E8DFD0).
- **`contact_notes` table:** Standalone timestamped notes per contact — `id, contact_id, note, created_at`. Endpoints: `GET/POST /api/contacts/:id/notes`. `PATCH /api/contacts/:id` edits name/mobile/address/suburb/do_not_call.
- **iCloud CalDAV:** `lib/ical-calendar.js` — exports `{ createCalendarEvent, fetchTodayEvents }`. `fetchTodayEvents()` returns `[]` silently if iCloud not configured. Configured via `ICLOUD_APPLE_ID`, `ICLOUD_APP_PASSWORD`, `ICLOUD_CALENDAR_URL` in `.env`. Setup/discovery: `node scripts/icloud-setup.js`.
- **`POST /api/contacts`** — create manual contact (`local_TIMESTAMP_RANDOM` id, source='manual'). Fields: name*, mobile, address, suburb, beds, baths, property_type, do_not_call.
- **`GET /api/stats/today`** — returns `{calls, connected, left_message, no_answer, not_interested, callback_requested, appraisal_booked}` counts from `call_log` for today.
- **`GET /api/agenda/today`** — returns `{events, reminders, planCount}` — iCloud CalDAV events + today's unsent reminders + daily_plans count.
- **Unified `ContactCard` (dashboard.js):** single component for all columns. `context` prop: `'circle' | 'sold' | 'listed' | 'search'`. Circle uses `PATCH /api/plan/:id/outcome`; others use `POST /api/log-call`. Note prefix auto-built as `"ContextLabel — Address | Outcome"`. `ContactNotesModal` accepts optional `prefilledNote` prop.
- **`CallStatsBar.refresh`:** static function property — call `if (typeof CallStatsBar.refresh === 'function') CallStatsBar.refresh()` after any outcome log to refresh the header stats bar.
- **Dynamic SQL params (user input):** Never interpolate `req.query.*` directly into SQL strings. Use a whitelist: `const VALID = ['a','b','c']; const val = VALID.includes(req.query.x) ? req.query.x : 'default';`
- **AgentBox API filters:** `filter[staffId]` is BROKEN — returns entire office, not Bailey's. `filtersuburb` + `filterpostcode` combined IS working — returns suburb-specific contacts (~63,200 across 12 suburbs). `filtermobile` is BROKEN — returns wrong contacts.
- **Post-refetch pipeline (always run in order after refetch):** `node backfill-contacts.js` → property linking SQL (link NULL contact_id rows) → pf_ upgrade SQL (replace pf_ links where AgentBox contact now exists). See `scripts/lookup-missing-contacts.js` for the SQL patterns.
- **AgentBox buyer enquiries sync:** `node fetch-buyer-enquiries.js` — listing IDs hardcoded as `BAILEY_LISTING_IDS` (top of script). `filter[staffId]` is BROKEN — returns entire office, not Bailey's. Admin API `x-api-key` is a **server-side session key invalidated when browser closes** — Node.js direct calls always return 401 ("Api Key does not exists.") even with correct cookies/headers. Architecture: browser stays open for admin API calls (page.evaluate), bearer API calls happen from Node.js in parallel (much faster). Default sync: page 1 only (50 most recent per listing); `--full` flag for deep backfill. Performance floor: ~2 min (Reapit admin API latency ~60s, irreducible). Triggered from dashboard via POST `/api/buyers/sync`. To add a new listing: append its ID to `BAILEY_LISTING_IDS`.
- **`reminders` table (updated 2026-02-27):** `fire_at` is now nullable (tasks have no fire_at). New columns: `completed_at TEXT` (set on completion), `is_task INTEGER DEFAULT 0`. Tasks skip iCal and Telegram dispatch.
- **`reminder-bot.js` dispatch query:** Must include `AND is_task = 0` — tasks with a fire_at date would otherwise fire as "JARVIS REMINDER" Telegram messages.
- **`buyer_profiles` table (added 2026-02-27):** Manual buyer CRM — 22 cols including price_min/max, beds_min/max, property_type, suburbs_wanted (comma-sep), timeframe, features, status (active/paused/purchased/archived), contact_id. `buyer_matches` table tracks which buyers were matched to which market events (partial unique index on buyer_id+market_event_id WHERE market_event_id IS NOT NULL).
- **Buyer matching:** `findMatchingBuyers(event)` in snapshot-server.js — 4-dimension scoring (suburb 40, beds 30, property_type 20, price 25). `notifyBuyerMatches()` sends Telegram + creates reminders. Triggered via `setImmediate` after POST/PATCH market events. Endpoints: `GET/POST /api/buyer-profiles`, `GET/PATCH/DELETE /api/buyer-profiles/:id`, `POST /api/buyer-profiles/:id/log-call`, `GET /api/buyer-profiles/matches/recent`, `POST /api/buyer-profiles/match-event`.
- **Express route order:** Static sub-paths (e.g. `/api/buyer-profiles/matches/recent`) MUST be registered before parameterised routes (`/api/buyer-profiles/:id`) or Express will capture them as `:id`.
- **Dashboard CSS undefined tokens:** `--bg-card` and `--border` are NOT defined in dashboard.css — using them silently falls back to transparent/default. Use defined tokens: `--bg-raised`, `--bg-surface`, `--border-subtle`, `--border-gold`.
- **`GET /api/market` filter params (added 2026-02-27):** `?property_type=house|unit|townhouse` and `?sort=newest|oldest|price_high|price_low` — validated against VALID_PROPERTY_TYPES/VALID_SORTS whitelists.
- **Farm area canonical filter:** `!/willoughby/i.test(address)` — covers Willoughby, North Willoughby, Willoughby East (all contain "Willoughby"). Applied per-property inside `processMarketEvent()` and as a safety net in `GET /api/alerts`. Do NOT rely on `isWilloughbyArea()` for per-property filtering — it checks the full email body, not individual addresses.
- **Email digest multi-suburb gotcha:** REA/Domain digest emails can contain addresses from multiple suburbs. `isWilloughbyArea()` passes if "Willoughby" appears anywhere in the email body, so Northbridge/Castlecrag addresses in the same digest will be parsed. Farm gate is enforced per-property inside `processMarketEvent()`.
- **`better-sqlite3` for ad-hoc scripts:** `require('/root/.openclaw/node_modules/better-sqlite3')` — NOT in `agentbox-willoughby/node_modules/`.

## 🔒 Security Notes
- **SSH:** Password authentication disabled (Feb 2026). Key-only login — key fingerprint `SHA256:/EG3Acc/UmSHIR157ZJU/IzYY8/3pPWVdGf+K7vlHXk`. `iptables-persistent` installed; rules in `/etc/iptables/rules.v4`.
- **Cryptominer incident (Feb 2026):** `claude` OS user was brute-forced via SSH. Miner pattern: numeric-named ELF binaries in `/tmp`, `/var/tmp`, `/dev/shm` + `@reboot` crontab in `claude` user's crontab + binary at `~/.config/systemd/cpupower`. Check `cat /proc/*/cmdline` and `/var/log/auth.log` for `Failed password` if suspicious CPU spike occurs.
- **Mining pool blocked:** `64.89.161.144` blocked outbound via iptables.

## 🔌 Active Plugins
Plugins installed and their primary use in this system:

| Plugin | Primary Jarvis Use |
|---|---|
| Notion | Query/inspect live Command Center board state; ad-hoc cooldown audits |
| Playwright | Session-interception contact pulls from AgentBox (`refetch-contacts-full.js`) |
| Context7 | Live library docs for ImapFlow, @notionhq/client, Playwright during debugging |
| Feature Dev | Structured implementation for the dashboard migration |
| Code Review | Pre-deploy audit of pipeline scripts before cron changes |
| GitHub | Version control for production scripts (currently unversioned on VPS) |
| Claude MD Management | Keep this file and `AGENTS.md` accurate as the system evolves |
| Security Guidance | Audit Express endpoints, `.env` handling, snapshot-server password fix |
| Superpowers | Parallel execution for complex multi-file operations |
| Frontend Design | React UI for the custom dashboard (replaces Notion interface) |
| Playground | Sandbox testing of new Express endpoints and SQLite queries before production |

## 📍 Geographic Focus
- **Primary Suburb:** Willoughby (NSW 2068).
- **Call board farm (Just Sold/Just Listed):** Willoughby, North Willoughby, Willoughby East only — enforced by `/willoughby/i` filter in `processMarketEvent()` and `GET /api/alerts`.
- **Coverage (Market page + scoring pool):** North Willoughby, Willoughby East, Castlecrag, Middle Cove, Castle Cove, Naremburn, Chatswood, Artarmon.
