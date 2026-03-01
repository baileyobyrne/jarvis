# Call Intelligence — Design Document
_2026-03-01_

## Overview

A post-call intelligence system integrated with Jarvis that records prospecting calls, transcribes them, extracts structured insights, and takes automated follow-up actions — all without interrupting your calling workflow.

## Constraints

- Calls must originate from the user's real mobile number (no VoIP number substitution)
- No automated recording announcement played to the other party
- Fully professional — zero friction added to the call itself

## Architecture

Two environments cooperate:

```
  Mac (local)                           VPS (72.62.74.105)
  ──────────────────────────────        ──────────────────────────────
  BlackHole (virtual audio)             snapshot-server.js
  Audio Hijack (auto-record)     ──→    POST /api/calls/upload
  Jarvis Companion (Node.js)            → Whisper transcript
    - watches ~/Music/Jarvis Calls/     → Claude analysis
    - localhost:5678 (fallback UI)      → iCloud calendar event
    - contact pre-tagging               → reminders table
  Jarvis Dashboard (browser)            → Telegram notification
    - tel: click → pings companion      → call_recordings table
```

## Mac Setup (one-time)

1. **BlackHole 2ch** — free virtual audio driver (existential.audio/blackhole). Routes system audio into a recording input.
2. **Multi-Output Device** — created in macOS Audio MIDI Setup:
   - Outputs: Built-in Output (or headset) + BlackHole 2ch
   - Set as System Output — call audio plays to headset AND feeds into BlackHole
3. **Aggregate Device** — for recording input:
   - Inputs: Built-in Microphone + BlackHole 2ch
   - Captures both your voice and the caller's voice
4. **Audio Hijack session** (Rogue Amoeba, $65 USD):
   - Source: System Audio (using BlackHole/Aggregate Device)
   - Add Microphone source
   - Recorder block: MP3, 128kbps, saves to `~/Music/Jarvis Calls/`
   - Trigger: auto-start when Phone or FaceTime app is active
5. **iPhone Continuity calling** — Settings → Phone → Calls on Other Devices → enable Mac

## Jarvis Companion (Mac-local Node.js app)

A lightweight script the user runs on their Mac (not on VPS). Lives in its own folder.

### Responsibilities

- **File watcher** (chokidar): monitors `~/Music/Jarvis Calls/` for new MP3 files
- **Contact pre-tagging**: receives `{contact_id, name, mobile}` from dashboard when a tel: link is clicked; stores in memory for next upload
- **Uploader**: when new file detected (stable for 3 seconds), POSTs to Jarvis `/api/calls/upload` with audio + contact metadata
- **Fallback recorder**: if Audio Hijack isn't running, provides manual Start/Stop recording via ffmpeg + BlackHole → same upload pipeline
- **Localhost UI** at `localhost:5678`:
  - `/` — simple web page with Start/Stop button (fallback mode)
  - `POST /upcoming-call` — called by Jarvis dashboard on tel: click

### Dashboard integration

When the user clicks any **Call** button (tel: link) in the Jarvis dashboard, JavaScript pings `localhost:5678/upcoming-call` before opening the dialer:

```js
fetch('http://localhost:5678/upcoming-call', {
  method: 'POST',
  body: JSON.stringify({ contact_id, name, mobile }),
  headers: { 'Content-Type': 'application/json' }
}).catch(() => {}); // silently ignore if companion not running
```

The companion stores this and attaches it to the next recording that arrives.

### Startup

- Run manually: `node companion.js`
- Or install as a launchd service to auto-start on login

## Jarvis Server Additions

### New API endpoints (snapshot-server.js)

#### `POST /api/calls/upload`

Accepts multipart form data:
- `audio` — MP3/WAV/M4A file
- `contact_id` — integer (optional)
- `contact_name` — string (fallback if no contact_id)
- `duration` — seconds (optional)
- `started_at` — ISO timestamp (optional)

Response: `{ call_id, status: "processing" }` (returns immediately)

Processing runs async:
1. Save audio file to `/root/.openclaw/workspace/calls/`
2. POST to OpenAI Whisper API → transcript
3. POST transcript + contact context to Claude → structured output
4. Execute auto-actions (see below)
5. Send Telegram notification
6. Update `call_recordings.processed_at`

#### `GET /api/calls`

Returns paginated list of recent calls with: contact_name, outcome, summary, created_at, processed_at.

#### `GET /api/calls/:id`

Returns full call record including transcript, action_items JSON, sms_draft.

### Database (lib/db.js)

New table `call_recordings`:

```sql
CREATE TABLE IF NOT EXISTS call_recordings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER REFERENCES contacts(id),
  contact_name      TEXT,
  audio_filename    TEXT,
  duration_seconds  INTEGER,
  transcript        TEXT,
  summary           TEXT,
  outcome           TEXT,          -- connected|left_message|not_interested|callback_requested|appraisal_booked|other
  action_items      TEXT,          -- JSON array of strings
  sms_draft         TEXT,
  calendar_event_uid TEXT,
  reminder_id       INTEGER,
  created_at        DATETIME DEFAULT (datetime('now','localtime')),
  processed_at      DATETIME
);
```

## Processing Pipeline

### Step 1 — Transcription (Whisper)

POST to `https://api.openai.com/v1/audio/transcriptions`:
- model: `whisper-1`
- language: `en`
- response_format: `verbose_json` (includes word timestamps for speaker diarization hints)
- Cost: ~$0.006/min of audio

### Step 2 — Claude Analysis

Single prompt sends transcript + contact context and requests structured JSON output:

```
Fields to extract:
- outcome: one of [connected, left_message, not_interested, callback_requested, appraisal_booked, other]
- summary: 3-5 sentences capturing key points
- action_items: array of concrete next actions
- follow_up: { date: ISO|null, note: string|null }
- calendar_event: { date: ISO|null, time: string|null, address: string|null, duration_minutes: number|null, title: string|null } or null
- sms_draft: personalized text message based on outcome (sounds natural, 1-3 sentences)
```

Model: `claude-haiku-4-5-20251001` (fast, cheap, sufficient for extraction)

### Step 3 — Auto-actions

Executed synchronously in order:
1. **Update contact status** — PATCH daily_plans / contacts outcome if contact_id known
2. **Create reminder** — if `follow_up.date` present, INSERT into reminders table
3. **Create iCloud calendar event** — if `calendar_event` non-null, use existing `ical-calendar.js`
4. **Store everything** — UPDATE call_recordings with all extracted fields + calendar_event_uid

### Step 4 — Telegram notification

Rich HTML message:

```
📞 CALL COMPLETE — {name}
📍 {address}

Outcome: {outcome_emoji} {outcome_label}

{summary}

📅 Calendar: {calendar details if booked}

📱 SMS Draft:
"{sms_draft}"

Action items:
• {item 1}
• {item 2}

[View in Jarvis] [Mark outcome]
```

## Dashboard — Calls Page

New 7th nav item "CALLS" (sidebar + mobile tab bar).

### CallsPage component

- List of recent calls, newest first
- Each card shows: contact name + address, outcome badge (coloured), summary preview, timestamp
- Click card → expands to show full transcript, SMS draft with Copy button, action items
- Filter by outcome type

### Contact card integration

On the Call Board (columns 1-3), if a contact has ≥1 recorded call, show a small phone/mic icon. Clicking it links to the Calls page filtered to that contact.

## Audio Hijack session configuration

User configures manually in Audio Hijack:

1. New session → "Jarvis Call Recording"
2. Add source: **Application Audio** → Phone (or FaceTime)
3. Add source: **Input Device** → Built-in Microphone (or headset mic)
4. Add block: **Recorder** → Format: MP3, Quality: Good, Output: `~/Music/Jarvis Calls/`, Filename: `{Date} {Time}`
5. Advanced → Check "Launch Audio Hijack at login" and "Run session automatically when source app is active"

## Fallback — Manual Recording (Approach A)

If Audio Hijack is not running:
1. Open `http://localhost:5678` in browser
2. Click **Start Recording** — companion records mic + BlackHole via `ffmpeg`
3. After call ends, click **Stop & Upload**
4. Same processing pipeline as automatic path

Companion detects whether Audio Hijack is recording by checking if `~/Music/Jarvis Calls/` has a file modified in the last 5 seconds. If Audio Hijack is active, the manual button is hidden.

## Mac Companion — File Structure

```
~/jarvis-companion/
  companion.js        -- main script
  package.json        -- deps: chokidar, axios, form-data, express
  README.md           -- setup instructions
```

## Security

- All uploads to VPS require `Authorization: Bearer {DASHBOARD_PASSWORD}` header
- Companion stores the password in a local `.env` file
- Audio files stored server-side in `/root/.openclaw/workspace/calls/` (not publicly accessible)
- No audio is stored longer than needed — option to auto-delete after processing (configurable)

## Dependencies

| Component | Tool | Cost |
|---|---|---|
| Virtual audio routing | BlackHole 2ch | Free |
| Auto call recording | Audio Hijack | $65 USD one-time |
| Transcription | OpenAI Whisper | ~$0.006/min |
| Analysis | Claude Haiku | ~$0.001/call |
| Calendar | Existing ical-calendar.js | Free |
| Telegram alerts | Existing telegram-bot.js | Free |

Estimated per-call cost: ~$0.03–0.10 depending on call length.

## Out of Scope

- Real-time transcription during the call
- Automated SMS sending (user copies draft and sends manually from iPhone)
- CRM sync back to AgentBox (read-only policy)
- Speaker diarization (Whisper output is a single stream; sufficient for extraction)
