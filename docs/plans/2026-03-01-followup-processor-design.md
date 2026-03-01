# Follow-up Processor Design
**Date:** 2026-03-01
**Script:** `scripts/process-followups.js`

## Purpose

Automatically generate reminders/tasks from two data sources now available in jarvis.db:
- **132 appraisals** synced from AgentBox (people who had a market appraisal)
- **86k+ contact notes** synced from AgentBox (agent-added notes with timing signals)

People who agreed to an appraisal are warm leads by definition. Notes with timing intent (e.g. "waiting til after ANZAC day to list", "3 years away") need follow-up at the right time.

---

## Pass 1 — Appraisal Follow-ups

**Source:** `appraisals` table (132 rows, all status=active)

**Steps:**
1. For each appraisal, match address → contacts table (LIKE on street name + suburb)
2. Skip if contact already has an uncompleted reminder (`completed_at IS NULL`)
3. DNC contacts are **not** skipped — still worth tracking
4. Create reminder:
   - `note`: `"Appraisal follow-up — [address], appraisal [date]. Worth a check-in on their plans?"`
   - `contact_id`, `contact_name`, `contact_mobile` from matched contact (or address-only task if no match)
   - `fire_at` staggered by age to avoid all firing on same day:
     - < 30 days ago → +14 days from today
     - 30–90 days ago → +7 days
     - 90–180 days ago → +3 days
     - > 180 days ago → `is_task = 1`, no `fire_at` (manual work-through)
   - `priority`: `'normal'`

---

## Pass 2 — Contact Notes AI Scan

**Source:** `contact_notes` table (86k rows)

**Pre-filter (reduce to manual/agent notes only):**

Strip system-generated noise matching any of these patterns:
- `MDT - *` (Mass Communicator, General, etc.)
- `Conflicting contact details detected`
- `Duplicate Contact Detected on Import`
- `Contact Pre-import Modifications`
- `Contact Categories Notes`

**Group by contact:** Aggregate all remaining notes per contact_id chronologically.
Unlike a one-note-per-contact approach, this gives Haiku the full interaction history.

**Scope:** Notes from 2025-06-01 onward (within the backfill window).

**Haiku batch prompt (10–15 contacts per API call):**

```
You are analyzing real estate CRM notes written by agents about their contacts.
For each contact below, review their note history and determine:
- action_needed: true/false
- fire_at: ISO date string (infer from timing cues like "ANZAC Day" → ~2026-04-25,
  "2 years away" → ~2028-03-01, "after school term" → ~2026-07-01), or null
- reason: 1-sentence summary of why to follow up (or why not)

Skip (action_needed: false) if notes indicate:
- "no plans", "not interested", "happy where they are", "going with another agency"
- Only campaign mass-notes with no personal context

If timing is vague but intent exists, default fire_at to 3 months from today.

Return a JSON array, one object per contact_id.
```

**Reminder creation:**
- `note`: `"Follow-up from CRM notes: [reason]"`
- `fire_at`: from Haiku output (or 3 months default)
- `contact_id`, `contact_name`, `contact_mobile` from contacts table
- DNC contacts included

**Deduplication:** skip if contact already has an open uncompleted reminder.

---

## CLI Flags

| Flag | Behaviour |
|---|---|
| `--dry-run` | Print what would be inserted; no DB writes |
| `--limit N` | Process only first N contacts in notes pass |
| `--skip-notes` | Run appraisals pass only |
| `--skip-appraisals` | Run notes pass only |

---

## Expected Output

- Appraisals: up to 132 reminders/tasks (minus existing open reminders)
- Notes: Haiku will heavily filter — expect 100–500 actionable reminders
- Summary printed to stdout: created, skipped (dup), errors

---

## Files Touched

| File | Change |
|---|---|
| `scripts/process-followups.js` | New script (created) |
| `jarvis.db` → `reminders` | New rows inserted |
