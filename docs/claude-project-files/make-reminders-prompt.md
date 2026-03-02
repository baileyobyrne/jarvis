I need to integrate Apple Reminders with Jarvis using Make.com. You have access to Make.com as a connector so use it directly to build the scenarios — only ask me to do something manually in the browser when it is absolutely required (such as OAuth authorization steps).

## What we are building

When a reminder is created in the Jarvis dashboard (from any device), it automatically appears in my Apple Reminders "Work" list. When I tap ✅ Done in Telegram, it also marks the reminder complete in Apple Reminders.

## Architecture

```
Any device → Jarvis dashboard → POST /api/reminders (VPS)
                                      ↓
                            Fire webhook to Make.com
                                      ↓
                        Make.com creates Apple Reminder in Work list
                                      ↓
                        Returns externalId → stored in DB

Telegram ✅ Done → POST /api/reminders/:id/complete (VPS)
                                      ↓
                            Fire webhook to Make.com
                                      ↓
                        Make.com marks Apple Reminder complete
```

## Jarvis system context

- VPS: Node.js/Express, `snapshot-server.js` is the main API file
- Database: SQLite via better-sqlite3, migrations in `db.js`
- `.env` at `/root/.openclaw/.env` — new vars loaded with `pm2 restart jarvis-snapshot --update-env`
- axios is already required in `snapshot-server.js`
- Telegram ✅ Done button calls `POST /api/reminders/:id/complete` — already implemented in `telegram-bot.js`
- Auth token: `solar-atlas-cedar-ember`

## What I need built

### Phase 1 — Make.com (use your connector)

Use the Make.com connector to:

1. Create **Scenario 1 — Create Reminder**:
   - Trigger: Custom Webhook (name it `jarvis-reminder-create`)
   - Expects JSON body: `{ "title": "...", "notes": "...", "due_date": "...", "reminder_id": 123 }`
   - Action: Apple Reminders → Create Reminder (list = "Work", title from webhook, notes from webhook, due date from webhook)
   - Response: return the created reminder's ID back to the webhook caller
   - Activate the scenario

2. Create **Scenario 2 — Complete Reminder**:
   - Trigger: Custom Webhook (name it `jarvis-reminder-complete`)
   - Expects JSON body: `{ "apple_reminder_id": "..." }`
   - Action: Apple Reminders → Complete Reminder (by the ID from webhook body)
   - Activate the scenario

3. Give me the two webhook URLs so I can add them to `.env`

For any step that requires me to authorize Apple Reminders in the browser, tell me exactly what to click and wait for my confirmation before continuing.

### Phase 2 — VPS code changes (provide exact code to paste)

Once I have the webhook URLs, provide:

1. The two new lines to add to `/root/.openclaw/.env`:
   ```
   MAKE_CREATE_WEBHOOK=https://hook.make.com/...
   MAKE_COMPLETE_WEBHOOK=https://hook.make.com/...
   ```

2. The DB migration to add to `db.js` (use the existing pattern):
   ```javascript
   try { db.prepare('ALTER TABLE reminders ADD COLUMN apple_reminder_id TEXT').run(); } catch(_) {}
   ```

3. The update to `POST /api/reminders` in `snapshot-server.js` — after the reminder is saved to DB, fire-and-forget POST to `MAKE_CREATE_WEBHOOK` with `{ title, notes, due_date, reminder_id }`, and when Make responds store the returned Apple reminder ID via `UPDATE reminders SET apple_reminder_id = ? WHERE id = ?`

4. The update to `POST /api/reminders/:id/complete` in `snapshot-server.js` — after marking complete in DB, if `apple_reminder_id` is set fire-and-forget POST to `MAKE_COMPLETE_WEBHOOK` with `{ apple_reminder_id }`

5. The `pm2 restart` command to apply the changes

### Phase 3 — Testing

1. Create a test reminder from the Jarvis dashboard and confirm it appears in Apple Reminders Work list within a few seconds
2. Tap ✅ Done in Telegram and confirm it completes in Apple Reminders

## Code constraints for Phase 2

- All datetimes UTC: `datetime('now')` never `datetime('now','localtime')`
- Never await Make.com webhook calls inside a request handler — always fire-and-forget using `setImmediate(async () => { try { ... } catch(e) { console.warn('[make]', e.message); } })`
- If the Make.com call fails, log a warning but never fail the API response — the reminder is already saved in Jarvis
- No new npm dependencies — use axios (already imported in snapshot-server.js)
- Parameterised SQL only, never string interpolation

## Start here

Use the Make.com connector now to begin Phase 1. Create Scenario 1 first, and tell me if you need me to do anything in the browser for the Apple Reminders authorization.
