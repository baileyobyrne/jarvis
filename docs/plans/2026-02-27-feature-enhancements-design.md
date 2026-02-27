# Feature Enhancements Design
**Date:** 2026-02-27
**Status:** Approved

---

## Overview

Four interconnected improvements to the Jarvis dashboard:

1. Unified `ContactCard` component (replaces `CallCard` + `ProspectCard`)
2. Daily Agenda widget (iCloud Calendar + reminders + call plan)
3. Call tracker header widget (live daily stats)
4. Smart note pre-fill (context headline auto-prefixed on every log)

---

## Feature 1: Unified ContactCard + Add/Edit Contacts

### Problem
`CallCard` (Circle Prospecting) and `ProspectCard` (Just Sold/Listed) are separate components with diverging capabilities. `ProspectCard` has edit/notes actions; `CallCard` does not. `SearchCard` also lacks edit. There is no way to add a new contact.

### Solution
Replace `CallCard` and `ProspectCard` with a single `ContactCard` component. A `context` prop identifies the calling column and drives the smart note prefix. All actions (edit, notes, outcome log, follow-up picker) are available in every context.

### Context Labels

| `context` prop | Pre-fill prefix  | Example stored note                     |
|----------------|------------------|-----------------------------------------|
| `circle`       | Prospecting      | `Prospecting — 5 Elm St \| Connected`   |
| `sold`         | Just Sold        | `Just Sold — 20 Smith St \| Left Message` |
| `listed`       | Just Listed      | `Just Listed — 8 Oak Ave \| No Answer`  |
| `search`       | Search           | `Search — 12 Bay Rd \| Connected`       |

### Add New Contact
- "+" button in the header or Circle Prospecting column footer
- `NewContactModal` with fields: name (required), mobile, address, suburb, beds, baths, property_type, do_not_call toggle
- **New endpoint:** `POST /api/contacts` — generates local ID, inserts into `contacts` table, returns new contact

### Edit Contact
- Edit icon (FileEdit) available on `ContactCard` in all contexts
- Reuses existing `EditContactModal` and `PATCH /api/contacts/:id`
- No change to existing server logic

---

## Feature 2: Daily Agenda Widget

### Overview
A collapsible "Today" panel at the top of the dashboard. Merges three data sources into a single time-sorted view.

### Data Sources
1. **iCloud Calendar events** — fetched via CalDAV REPORT with time-range filter (today 00:00–23:59). Uses existing `ICLOUD_APPLE_ID`, `ICLOUD_APP_PASSWORD`, `ICLOUD_CALENDAR_URL` env vars.
2. **Pending reminders** — from `reminders` table WHERE `fire_at` is today AND `sent = 0`.
3. **Call plan summary** — count of contacts in today's `daily_plans` as a single summary line.

### Priority Order (manually adjustable)
Callbacks/reminders first → Calendar events (time-sorted) → Call plan summary.

### UI
- Time-sorted list; calendar events show time + title; reminders show contact name + note
- Checkbox per item (localStorage, resets daily)
- "Add task" inline input for one-off manual items
- Collapses to a slim bar showing just the next due item

### New Server Changes
- `lib/ical-calendar.js` — add `fetchTodayEvents()` function (CalDAV REPORT request, parses VEVENT blocks, returns `[{ title, startTime, endTime }]`)
- `GET /api/agenda/today` — returns `{ events: [...], reminders: [...], planCount: N }`

---

## Feature 3: Call Tracker Header Widget

### Overview
A persistent counter strip in the top header bar. Always visible. Updates live after every call logged.

### Display
```
📞 Calls: 14   ✓ Connects: 5   ✉ Messages: 3   ○ No Answer: 6
```

### Behaviour
- Queries `call_log WHERE called_at >= today (local midnight)`
- Frontend polls `GET /api/stats/today` every 60 seconds
- Also refreshes immediately after any outcome is logged
- Tapping opens a mini modal with hourly breakdown and full outcome split

### New Server Changes
- `GET /api/stats/today` — returns `{ calls, connected, left_message, no_answer, not_interested, callback_requested, appraisal_booked }`
- Single SQL query: `SELECT outcome, COUNT(*) as n FROM call_log WHERE called_at >= ? GROUP BY outcome`

---

## Feature 4: Smart Note Pre-fill

### Overview
Every call log and standalone note is automatically prefixed with a context headline. No typing required — the card knows its context from the `context` prop.

### Call Outcome Logging
When an outcome button is tapped on `ContactCard`, the `notes` field sent to `POST /api/log-call` is constructed as:

```
{context_label} — {address} | {outcome_label}[ user note]
```

Examples:
- `Just Sold — 20 Smith St | Connected`
- `Prospecting — 5 Elm St | Left Message — will call back Thursday`

### Standalone Notes Modal
The note textarea in `ContactNotesModal` is pre-filled with `"{context_label} — {address} | "` so the user types immediately after the pipe.

### No Server Changes
Purely client-side. The prefix is composed in `ContactCard` before calling existing endpoints.

---

## Out of Scope (Not in this design)
- AI/ML pattern learning (deferred — use rule-based priority for now)
- Outlook/Microsoft 365 integration (user is on iCloud)
- Call history graphs or weekly reporting

---

## Implementation Order
1. `ContactCard` unification (enables features 1 and 4 together)
2. `POST /api/contacts` + `NewContactModal`
3. `GET /api/stats/today` + header widget
4. `GET /api/agenda/today` + `fetchTodayEvents()` + agenda widget
