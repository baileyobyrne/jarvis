# Jarvis Call Companion — Mac Setup Guide

Records prospecting calls via iPhone Continuity + Audio Hijack and uploads them to Jarvis for AI transcription and analysis.

## Prerequisites

- macOS (any recent version)
- iPhone on the same iCloud account as your Mac
- Audio Hijack by Rogue Amoeba ($65 USD) — https://rogueamoeba.com/audiohijack/
- Node.js 18+
- ffmpeg (for fallback recording): `brew install ffmpeg`

## One-Time Mac Setup (~20 minutes)

### 1. Install BlackHole 2ch (free)
Download from https://existential.audio/blackhole/ (free, requires email signup).
Run the installer and restart your Mac.

### 2. Configure Audio MIDI Setup
Open **Audio MIDI Setup** (search Spotlight: "Audio MIDI Setup").

**Create a Multi-Output Device:**
- Click `+` at the bottom left → **Create Multi-Output Device**
- In the right panel, check both:
  - Built-in Output (or your headset/AirPods)
  - BlackHole 2ch
- Right-click the new device → **Rename** → "Jarvis Playback"

**Set as System Output:**
- In the left panel, right-click "Jarvis Playback" → **Use This Device For Sound Output**

**Create an Aggregate Device:**
- Click `+` → **Create Aggregate Device**
- Check both:
  - Built-in Microphone (or your headset mic)
  - BlackHole 2ch
- Rename to "Jarvis Record"

> **Why?** When a call comes in on your Mac via Continuity, the caller's voice plays through your speakers — and BlackHole captures that same audio stream. Your microphone captures your voice. The Aggregate Device combines both into one recording input.

### 3. Configure Audio Hijack

Open Audio Hijack. Create a new session:

1. **File → New Session** — name it "Jarvis Calls"
2. Click **+** to add a source → **Application Audio** → select **FaceTime** (handles all Continuity calls)
3. Click **+** again → **Input Device** → select "Jarvis Record" (your Aggregate Device)
4. Click **+** → **Recorder block**:
   - Format: **MP3**
   - Quality: **Good (128 kbps)**
   - Output folder: `~/Music/Jarvis Calls`
   - Filename template: `{Date} {Time}`
5. In session settings (top of screen) → check **"Run session automatically when source app is active"**
6. **Audio Hijack → Preferences → General** → check **"Launch Audio Hijack at login"**

> Audio Hijack will now automatically start recording whenever a FaceTime/Continuity call is active, and stop when it ends. No manual button pressing required.

### 4. Enable iPhone Continuity Calling

On your iPhone:
**Settings → Phone → Calls on Other Devices** → toggle on your Mac.

On your Mac:
**FaceTime → Preferences → Settings** → check **"Calls from iPhone"**.

You should now be able to make and answer calls from your Mac — they route through your iPhone's cellular connection but audio plays through the Mac.

### 5. Install and Configure the Companion

Clone or copy this folder to your Mac:
```bash
# Option A: clone the repo (if you have GitHub access)
git clone https://github.com/baileyobyrne/jarvis.git
cd jarvis/mac-companion

# Option B: copy manually from VPS
# scp -r root@72.62.74.105:/root/.openclaw/mac-companion ~/jarvis-companion
# cd ~/jarvis-companion
```

Install dependencies:
```bash
npm install
```

Configure:
```bash
cp .env.example .env
# Edit .env and set JARVIS_TOKEN to your Jarvis dashboard password
```

Test it works:
```bash
node companion.js
# Should print: [companion] Watching: Jarvis Calls
# Should print: [companion] Server running at http://localhost:5678
```

Open http://localhost:5678 in your browser to see the companion UI.

## Daily Use

1. **Start companion** (or configure auto-start below):
   ```bash
   node companion.js
   ```

2. **Audio Hijack runs in background** — it auto-starts when you make a call.

3. **Click any Call button in the Jarvis dashboard** — the companion is pre-tagged with that contact's details.

4. **Make your call** — iPhone dials, audio plays on Mac through your headset.

5. **Hang up** — Audio Hijack saves the recording → companion detects it → uploads to Jarvis.

6. **~30–60 seconds later** — Telegram notification with:
   - Call summary
   - Outcome (Connected / Left Message / Appraisal Booked / etc.)
   - Action items
   - Personalised SMS draft to copy and send
   - iCloud calendar event created (if appointment was booked)
   - Follow-up reminder created (if callback was agreed)

## Fallback Recording (if Audio Hijack not active)

If Audio Hijack isn't running, use the manual recorder:

1. Open http://localhost:5678 in your browser
2. Click **Start Recording** before your call
3. Click **Stop & Upload** after hanging up

This uses ffmpeg to capture your Mac's default audio input (make sure "Jarvis Record" is set as default or the Aggregate Device is selected).

## Auto-Start on Login

To run the companion automatically when you log in:

**Option A — Login Items (simplest):**
1. System Settings → General → Login Items & Extensions
2. Click `+` and add a shell script that runs `node /path/to/companion.js`
3. Or drag a `.command` file that contains `cd /path/to/mac-companion && node companion.js`

**Option B — launchd (background daemon):**
Create `~/Library/LaunchAgents/com.jarvis.companion.plist` with:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jarvis.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOUR_USERNAME/jarvis/mac-companion/companion.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOUR_USERNAME/jarvis/mac-companion</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/jarvis-companion.log</string>
  <key>StandardErrorPath</key><string>/tmp/jarvis-companion.log</string>
</dict>
</plist>
```
Then: `launchctl load ~/Library/LaunchAgents/com.jarvis.companion.plist`

## Troubleshooting

**Caller's voice not recording / only your voice captured:**
Check that "Jarvis Playback" is set as the System Output in Audio MIDI Setup. The caller's voice must route through BlackHole to be captured.

**No recording files appearing in ~/Music/Jarvis Calls:**
Open Audio Hijack, check the Jarvis Calls session is green (active). Verify the FaceTime app is set as the source — not "Phone" (which is a separate app on older macOS).

**Upload fails: 401 Unauthorized:**
Check `JARVIS_TOKEN` in `.env` matches `DASHBOARD_PASSWORD` on the VPS.

**Upload fails: SSL certificate error:**
The VPS uses a self-signed certificate. The companion sets `rejectUnauthorized: false` to handle this — if you're still seeing SSL errors, check your Node.js version (requires 18+).

**ffmpeg not found (fallback mode):**
```bash
brew install ffmpeg
```

**Port 5678 already in use:**
Set `PORT=5679` (or another port) in `.env`. The Jarvis dashboard pre-tag will still work — it silently ignores connection failures.

**No Telegram notification after upload:**
Check the VPS logs: `pm2 logs jarvis-snapshot --lines 50`. The processing may have failed (Whisper or Claude error). The error will also appear in the Telegram "Processing failed" message.

## Architecture

```
  iPhone (cellular)
       ↕ Continuity
  Mac (Audio Hijack auto-records)
       → ~/Music/Jarvis Calls/ (new MP3)
       → Companion detects file (chokidar)
       → Uploads to VPS POST /api/calls/upload
       ↕
  VPS (Jarvis)
       → OpenAI Whisper (transcription)
       → Claude Haiku (analysis)
       → iCloud CalDAV (calendar event)
       → SQLite (reminders, call_recordings)
       → Telegram (notification + SMS draft)
```
