# JARVIS: Real Estate Automation (Willoughby)
Technical architecture for an autonomous real estate monitoring and prospecting engine.

## 🏗️ System Architecture: The Dual-Stream Pipeline
1. **Pipeline A (Reactive):** `monitor-email.js`
   - **Trigger:** Cron job 3× daily — approx. 7am, 12pm, 5pm AEDT (21:00, 02:00, 07:00 UTC). *(Previously documented as "every 15 minutes" — corrected to match `cron/jobs.json`.)*
   - **Function:** Monitors Gmail for REA, Domain, and Homely alerts[cite: 1569, 2393]. Also parses CoreLogic/RP Data forwarded emails.
   - **Logic:** Applies a 1.5km geofence and Haversine proximity scoring to AgentBox contacts[cite: 1569, 2394]. CoreLogic rentals write `occupancy: "Investor"` back to the shadow DB.
   - **Output:** Writes up to 30 scored neighbours per market event to SQLite (`market_events`, `contacts`). Fires a concise heads-up to `@willoughby_monitor_bot` Telegram.

2. **Pipeline B (Proactive):** `daily-planner.js`
   - **Trigger:** Cron job Mon–Fri at 7:00 AM AEDT[cite: 1599, 2397] (`0 20 * * 1-5` UTC).
   - **Function:** Parses CoreLogic/RP Data CSVs and McGrath email forwards[cite: 1570, 2393].
   - **Logic:** Calculates "Propensity to Sell" scores (Tenure > 7yrs = +20, past appraisals = +30, investor status = +15, Past Vendor = +25, Prospective Vendor = +15)[cite: 2398]. Score tiers: Prime ≥45, Warm 20–44, Cold <20. Distribution (3,327 contacts): prime=149, warm=406, low=1374, zero=1446. Syncs Notion contacted statuses → 180-day local cooldown. Local planned contacts get 90-day cooldown.
   - **Output:** Writes scored contacts with Claude-generated talking points to **SQLite** (`daily_plans` + `contacts` tables). Board-full guard (80 slots) reads from SQLite `daily_plans` ✅.

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

## 🛠️ Common Commands
- **Test Pipeline A:** `node monitor-email.js` [cite: 2388]
- **Test Pipeline B:** `node daily-planner.js` [cite: 1215]
- **Update Database:** `node refetch-contacts-full.js` (uses Playwright session-interception)[cite: 1699, 2335].
- **SQLite positional params:** `db.prepare(...).get(Array.from(set))` — NOT `.get(...Array.from(set))`. Spreading a Set/Array as rest args silently binds only the first value; pass a single array.
- **Suburb filter discrepancy:** `workspace/backfill-contacts.js` covers 9 suburbs (core farm). `daily-planner.js` covers 12 (adds NORTHBRIDGE, LANE COVE, ST LEONARDS, CROWS NEST). Contacts from the extra 4 suburbs get minimal stubs in `contacts`, no RP enrichment.
- **lucide-react CDN (index.html):** `lucide-react` UMD factory looks for `global.react` (lowercase). React CDN sets `window.React` (uppercase). Fix: add `<script>window.react = window.React;</script>` **before** the lucide-react script tag. Global destructure: `const { Phone, ... } = LucideReact;` (PascalCase).
- **Playwright on VPS root:** Global install at `/usr/lib/node_modules/playwright`. Launch flags required: `args: ['--no-sandbox', '--disable-dev-shm-usage']`. Pricefinder lookup: `node workspace/pricefinder-lookup.js` (batch) or `node workspace/pricefinder-lookup.js --address "123 Main St"` (single).

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
- **Primary Suburb:** Willoughby (NSW 2068)[cite: 1552, 1704].
- **Coverage:** North Willoughby, Willoughby East, Castlecrag, Middle Cove, Castle Cove, Naremburn, Chatswood, Artarmon[cite: 2092, 2397].
