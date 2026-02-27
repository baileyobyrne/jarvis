# Design: Contact Edit, Timestamped Notes & Outlook Calendar Integration
**Date:** 2026-02-27
**Status:** Approved

## Problem
On the Calls page (ProspectCard), there is no way to:
1. Correct contact information (e.g. wrong phone number)
2. Leave a standalone timestamped note on a contact (not tied to a call outcome)
3. Sync reminders to Outlook calendar

## Section 1 — Data Layer

### New table: `contact_notes`
Added in `lib/db.js` using the standard `try { ALTER TABLE } catch {}` migration pattern:

```sql
CREATE TABLE IF NOT EXISTS contact_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(contact_id) REFERENCES contacts(id)
);
```

### New/updated API endpoints in `snapshot-server.js`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `PATCH` | `/api/contacts/:id` | Edit contact fields: name, mobile, address, suburb, do_not_call |
| `GET` | `/api/contacts/:id/notes` | Return all notes newest-first |
| `POST` | `/api/contacts/:id/notes` | Add a new timestamped note to `contact_notes` |

> The existing `POST /api/contacts/:id/notes` currently writes to `notes_raw` + AI summary. It will be repurposed to write to `contact_notes` instead. The `notes_raw` field is not shown in the UI.

## Section 2 — UI Components

### ProspectCard additions
Two new icon buttons added to the card header row (right side):
- `Pencil` icon → opens **EditContactModal**
- `ClipboardList` icon → opens **ContactNotesModal**

Both use `lucide-react` icons consistent with existing card buttons.

### EditContactModal
Fields:
- Name (text)
- Mobile (text)
- Address (text)
- Suburb (text)
- Do Not Call (checkbox)

Behaviour:
- `PATCH /api/contacts/:id` on save
- On success: updates card display in-place (no page reload) via callback prop
- Validation: mobile must not be blank if changed

### ContactNotesModal
Three sections:

**1. Add Note**
- Textarea for free-text note
- "Save Note" button → `POST /api/contacts/:id/notes`

**2. Set Reminder** (optional, collapsible)
- Quick date buttons: Tomorrow / 2 Days / 1 Week
- Note input (pre-filled from note text above)
- "Save Reminder" → `POST /api/reminders` (existing endpoint) + Outlook Graph event (if configured)

**3. History Timeline**
- Combined feed: standalone notes (gold) + call log entries (existing `/api/contacts/:id/history`)
- Sorted newest-first
- Each entry: timestamp + content/outcome label

### Styling
Matches existing dark/gold "Intelligence Terminal" theme. Modals use existing modal patterns from AddEventModal.

## Section 3 — Outlook Calendar Integration

### Architecture
Additive layer on top of `POST /api/reminders`. Outlook sync failure never blocks the reminder save.

### Setup (one-time, per deployment)
1. Register Azure AD app at portal.azure.com
2. Grant delegated permission: `Calendars.ReadWrite`
3. Add to `.env`: `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID`
4. Run one-time device-code OAuth script (`scripts/outlook-auth.js`) → stores `OUTLOOK_REFRESH_TOKEN` in `.env`

### Runtime flow
On `POST /api/reminders`:
1. Save reminder to SQLite (as today)
2. If `OUTLOOK_REFRESH_TOKEN` is set in env:
   - Exchange refresh token for access token via Graph token endpoint
   - Store new refresh token back to `.env`
   - `POST https://graph.microsoft.com/v1.0/me/events` with:
     - Subject: `Follow up — {contact_name}`
     - Start/End: `fire_at` to `fire_at + 30 min`
     - Body: note text + contact mobile + address
     - ReminderMinutesBeforeStart: 15
3. Log Graph errors as warnings; never throw

### New files
- `scripts/outlook-auth.js` — one-time device-code OAuth flow, writes token to `.env`
- `lib/outlook-calendar.js` — `createCalendarEvent(reminder)` helper used by snapshot-server.js

## Out of Scope
- Syncing existing/historical reminders to Outlook
- Two-way sync (Outlook → Jarvis)
- Editing or deleting notes once created
- Bulk contact editing
