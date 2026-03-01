# Call Intelligence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Record prospecting calls via Mac Continuity + Audio Hijack, transcribe with OpenAI Whisper, extract outcomes/action-items/SMS drafts via Claude Haiku, and automatically create reminders + iCloud calendar events.

**Architecture:** Mac companion (Node.js, runs locally) watches Audio Hijack's output folder and uploads recordings to the Jarvis VPS. The VPS processes audio through Whisper → Claude → auto-actions pipeline and sends a Telegram notification. Falls back to manual BlackHole recording if Audio Hijack is not active.

**Tech Stack:** Node.js 22, chokidar, express, axios, form-data, OpenAI Whisper API, Claude Haiku API, existing iCal + Telegram + SQLite infrastructure.

---

## Context

- **VPS server:** `/root/.openclaw/snapshot-server.js` (PM2: `jarvis-snapshot`, port 4242 HTTPS)
- **DB schema:** `/root/.openclaw/lib/db.js` — add tables using IIFE + `db.prepare(...).run()` pattern
- **Multer:** already configured for `workspace/intel/` — we add a second instance for audio
- **Claude calls:** raw axios POSTs to `https://api.anthropic.com/v1/messages` with `x-api-key` header
- **Telegram:** `sendTelegramMessage(text)` function already in server, HTML parse_mode
- **iCal:** `createCalendarEvent({ uid, summary, description, dtstart, dtend })` in `lib/ical-calendar.js`
- **Dashboard:** Babel JSX SPA — `do NOT run node --check on it`. Page `'calls'` is taken (call board). New page id = `'recordings'`
- **Auth:** all API endpoints use `requireAuth` middleware checking `Authorization: Bearer {DASHBOARD_PASSWORD}`

---

## Task 1: DB Schema — call_recordings table

**Files:**
- Modify: `/root/.openclaw/lib/db.js`

**Step 1: Add migration IIFE at end of lib/db.js (before the exports line)**

Find the exports line:
```
module.exports = { db, migrate };
```

Insert this block immediately before it:

```js
// ---------------------------------------------------------------------------
// Schema migrations — call_recordings table
// ---------------------------------------------------------------------------
(function migrateCallRecordingsTable() {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='call_recordings'"
  ).get();
  if (!exists) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS call_recordings (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id          INTEGER REFERENCES contacts(id),
        contact_name        TEXT,
        audio_filename      TEXT,
        duration_seconds    INTEGER,
        transcript          TEXT,
        summary             TEXT,
        outcome             TEXT,
        action_items        TEXT,
        sms_draft           TEXT,
        calendar_event_uid  TEXT,
        reminder_id         INTEGER,
        created_at          DATETIME DEFAULT (datetime('now','localtime')),
        processed_at        DATETIME
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_call_rec_contact ON call_recordings(contact_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_call_rec_created ON call_recordings(created_at DESC)').run();
    console.log('[db] call_recordings table created');
  }
})();
```

**Step 2: Verify schema loads correctly**

```bash
node -e "const { db } = require('/root/.openclaw/lib/db.js'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='call_recordings'\").get());"
```

Expected: `{ name: 'call_recordings' }`

**Step 3: Commit**

```bash
cd /root/.openclaw
git add lib/db.js
git commit -m "feat: add call_recordings table to schema"
```

---

## Task 2: Server — Dependencies + Multer for Audio

**Files:**
- Modify: `/root/.openclaw/package.json`
- Modify: `/root/.openclaw/snapshot-server.js`

**Step 1: Add form-data package**

In `package.json`, add to dependencies:
```json
"form-data": "^4.0.1"
```

Run:
```bash
cd /root/.openclaw && npm install
```

Expected: `added 1 package` (form-data)

**Step 2: Add calls directory creation and second multer instance**

In `snapshot-server.js`, right after the existing `const upload = multer({...})` block (around line 13), add:

```js
// Audio upload — separate multer instance for call recordings
const CALLS_DIR = '/root/.openclaw/workspace/calls';
if (!fs.existsSync(CALLS_DIR)) fs.mkdirSync(CALLS_DIR, { recursive: true });
const uploadAudio = multer({
  dest: CALLS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB — ~10 min MP3
});
```

**Step 3: Restart server and verify it boots**

```bash
pm2 restart jarvis-snapshot --update-env && sleep 3 && pm2 logs jarvis-snapshot --lines 10 --nostream
```

Expected: No errors, server starts on port 4242.

**Step 4: Commit**

```bash
cd /root/.openclaw
git add package.json package-lock.json snapshot-server.js
git commit -m "feat: add audio upload multer config + calls dir"
```

---

## Task 3: Server — GET /api/calls endpoints

**Files:**
- Modify: `/root/.openclaw/snapshot-server.js`

Add both read endpoints together. Find a logical section break (e.g., near the end of the file before the `https.createServer` call) and insert:

**Step 1: Add the endpoints**

```js
// ─── Call Recordings ──────────────────────────────────────────────────────

// GET /api/calls — list recent recordings (newest first)
app.get('/api/calls', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(`
      SELECT id, contact_id, contact_name, audio_filename,
             duration_seconds, summary, outcome, sms_draft,
             created_at, processed_at
      FROM call_recordings
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/calls]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/calls/:id — full record including transcript + action_items
app.get('/api/calls/:id', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM call_recordings WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.action_items) {
      try { row.action_items = JSON.parse(row.action_items); } catch (_) {}
    }
    res.json(row);
  } catch (e) {
    console.error('[GET /api/calls/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

**Step 2: Restart + smoke test**

```bash
pm2 restart jarvis-snapshot --update-env && sleep 2
node -e "
  require('dotenv').config({path:'/root/.openclaw/.env',override:true});
  const https=require('https'),a=process.env.DASHBOARD_PASSWORD;
  const req=https.request({hostname:'localhost',port:4242,path:'/api/calls',rejectUnauthorized:false,headers:{'Authorization':'Bearer '+a}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b))});req.end();
"
```

Expected: `[]` (empty array — no recordings yet)

**Step 3: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js
git commit -m "feat: add GET /api/calls and GET /api/calls/:id endpoints"
```

---

## Task 4: Server — POST /api/calls/upload + processing pipeline

This is the core task. The endpoint accepts an audio file, saves it, kicks off async processing, and returns immediately.

**Files:**
- Modify: `/root/.openclaw/snapshot-server.js`

**Step 1: Add the Whisper transcription helper function**

Add this helper function near the other async helper functions in the file (search for `async function` to find a good spot):

```js
// Transcribe audio file using OpenAI Whisper API
async function transcribeAudio(audioFilePath, originalName) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(audioFilePath), {
    filename: originalName || 'audio.mp3',
    contentType: 'audio/mpeg',
  });
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('response_format', 'text');

  const res = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    }
  );
  return (res.data || '').trim();
}
```

**Step 2: Add the Claude analysis helper function**

```js
// Analyse call transcript with Claude Haiku → structured JSON
async function analyseCallTranscript(transcript, contactContext) {
  const contextStr = contactContext
    ? `Contact: ${contactContext.name || 'Unknown'}. Address: ${contactContext.address || 'N/A'}.`
    : 'No contact context provided.';

  const systemPrompt = `You are an assistant helping a Sydney real estate agent analyse call transcripts.
${contextStr}
Extract the following from the transcript and respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": "connected|left_message|not_interested|callback_requested|appraisal_booked|other",
  "summary": "3-5 sentence summary of the call",
  "action_items": ["array", "of", "concrete", "next", "actions"],
  "follow_up": { "date": "YYYY-MM-DD or null", "note": "brief note or null" },
  "calendar_event": { "date": "YYYY-MM-DD or null", "time": "HH:MM or null", "address": "property address or null", "duration_minutes": 60, "title": "event title or null" },
  "sms_draft": "personalized follow-up SMS text, 1-3 sentences, sounds natural and professional"
}
Rules:
- outcome must be exactly one of the listed values
- follow_up.date: only if a specific callback time was agreed, format YYYY-MM-DD relative to today (${new Date().toISOString().slice(0,10)})
- calendar_event: only if an appointment (appraisal, meeting) was explicitly booked; otherwise null
- sms_draft: write as the agent Bailey, warm and professional, tailored to the outcome`;

  const apiRes = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Transcript:\n${transcript}` }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const raw = apiRes.data.content[0].text.trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(clean);
}
```

**Step 3: Add the main processing pipeline function**

```js
// Full async pipeline: transcribe → analyse → auto-actions → telegram
async function processCallRecording(callId, audioFilePath, originalName, contactContext) {
  try {
    // 1. Transcribe
    console.log(`[call-intel] Transcribing call ${callId}…`);
    const transcript = await transcribeAudio(audioFilePath, originalName);
    if (!transcript) throw new Error('Whisper returned empty transcript');

    // 2. Analyse with Claude
    console.log(`[call-intel] Analysing call ${callId}…`);
    const analysis = await analyseCallTranscript(transcript, contactContext);

    const {
      outcome = 'other',
      summary = '',
      action_items = [],
      follow_up,
      calendar_event,
      sms_draft = '',
    } = analysis;

    // 3. Create reminder if follow_up date present
    let reminderId = null;
    if (follow_up && follow_up.date && contactContext) {
      try {
        const fireAt = new Date(`${follow_up.date}T09:00:00`);
        const r = db.prepare(`
          INSERT INTO reminders (contact_id, contact_name, contact_mobile, note, fire_at)
          VALUES (?, ?, ?, ?, datetime(?))
        `).run(
          contactContext.contact_id || null,
          contactContext.name || 'Unknown',
          contactContext.mobile || null,
          follow_up.note || 'Follow up from call',
          fireAt.toISOString().replace('T', ' ').slice(0, 19)
        );
        reminderId = r.lastInsertRowid;
      } catch (e) {
        console.warn('[call-intel] Reminder insert failed:', e.message);
      }
    }

    // 4. Create iCloud calendar event if appointment booked
    let calendarUid = null;
    if (calendar_event && calendar_event.date && calendar_event.time) {
      try {
        const dtstart = new Date(`${calendar_event.date}T${calendar_event.time}:00`);
        const dtend = new Date(dtstart.getTime() + (calendar_event.duration_minutes || 60) * 60000);
        const { randomBytes } = require('crypto');
        const uid = `jarvis-call-${randomBytes(8).toString('hex')}@jarvis`;
        await createCalendarEvent({
          uid,
          summary: calendar_event.title || `Appraisal — ${contactContext?.name || 'Contact'}`,
          description: `Booked during prospecting call.\n\n${summary}`,
          dtstart,
          dtend,
        });
        calendarUid = uid;
      } catch (e) {
        console.warn('[call-intel] iCal event failed:', e.message);
      }
    }

    // 5. Update contact outcome in daily_plans if contact_id known
    if (contactContext?.contact_id) {
      try {
        const outcomeMap = {
          connected: 'connected',
          left_message: 'left_message',
          not_interested: 'not_interested',
          callback_requested: 'callback_requested',
          appraisal_booked: 'appraisal_booked',
        };
        const mappedOutcome = outcomeMap[outcome] || 'connected';
        db.prepare(`
          UPDATE daily_plans SET outcome = ?, updated_at = datetime('now','localtime')
          WHERE contact_id = ? AND plan_date = date('now','localtime') AND outcome IS NULL
        `).run(mappedOutcome, contactContext.contact_id);
      } catch (e) {
        console.warn('[call-intel] daily_plans update failed:', e.message);
      }
    }

    // 6. Persist everything to call_recordings
    db.prepare(`
      UPDATE call_recordings
      SET transcript = ?, summary = ?, outcome = ?, action_items = ?,
          sms_draft = ?, calendar_event_uid = ?, reminder_id = ?,
          processed_at = datetime('now','localtime')
      WHERE id = ?
    `).run(
      transcript,
      summary,
      outcome,
      JSON.stringify(action_items),
      sms_draft,
      calendarUid,
      reminderId,
      callId
    );

    // 7. Telegram notification
    const outcomeEmoji = {
      connected: '✅',
      left_message: '📬',
      not_interested: '❌',
      callback_requested: '🔁',
      appraisal_booked: '🏠',
      other: '📞',
    }[outcome] || '📞';

    const outcomeLabel = {
      connected: 'Connected',
      left_message: 'Left Message',
      not_interested: 'Not Interested',
      callback_requested: 'Callback Requested',
      appraisal_booked: 'Appraisal Booked',
      other: 'Other',
    }[outcome] || outcome;

    let msg = `📞 <b>CALL COMPLETE${contactContext?.name ? ` — ${contactContext.name}` : ''}</b>`;
    if (contactContext?.address) msg += `\n📍 ${contactContext.address}`;
    msg += `\n\nOutcome: ${outcomeEmoji} <b>${outcomeLabel}</b>`;
    if (summary) msg += `\n\n${summary}`;
    if (calendarUid && calendar_event) {
      msg += `\n\n📅 <b>Calendar event created:</b> ${calendar_event.title || 'Appointment'} on ${calendar_event.date} at ${calendar_event.time}`;
    }
    if (follow_up?.date && !calendarUid) {
      msg += `\n\n🔁 <b>Follow-up:</b> ${follow_up.date}${follow_up.note ? ` — ${follow_up.note}` : ''}`;
    }
    if (action_items.length > 0) {
      msg += `\n\n<b>Action items:</b>\n${action_items.map(a => `• ${a}`).join('\n')}`;
    }
    if (sms_draft) {
      msg += `\n\n📱 <b>SMS Draft:</b>\n"${sms_draft}"`;
    }
    msg += `\n\n<a href="https://72.62.74.105:4242">View in Jarvis</a>`;

    await sendTelegramMessage(msg);
    console.log(`[call-intel] Call ${callId} processed: ${outcome}`);

  } catch (e) {
    console.error(`[call-intel] Processing failed for call ${callId}:`, e.message);
    db.prepare(`UPDATE call_recordings SET summary = ?, processed_at = datetime('now','localtime') WHERE id = ?`)
      .run(`Processing failed: ${e.message}`, callId);
    sendTelegramMessage(`⚠️ Call recording ${callId} failed to process: ${e.message}`).catch(() => {});
  }
}
```

**Step 4: Add the upload endpoint**

```js
// POST /api/calls/upload — accepts multipart audio file + contact metadata
app.post('/api/calls/upload', requireAuth, uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const contactId   = req.body.contact_id   ? parseInt(req.body.contact_id) : null;
    const contactName = (req.body.contact_name || '').trim() || null;
    const mobile      = (req.body.mobile || '').trim() || null;
    const address     = (req.body.address || '').trim() || null;
    const duration    = req.body.duration ? parseInt(req.body.duration) : null;

    // Move file to final name (multer uses temp filename)
    const ext = path.extname(req.file.originalname || '.mp3') || '.mp3';
    const finalName = `call-${Date.now()}${ext}`;
    const finalPath = path.join(CALLS_DIR, finalName);
    fs.renameSync(req.file.path, finalPath);

    // Insert stub record
    const r = db.prepare(`
      INSERT INTO call_recordings (contact_id, contact_name, audio_filename, duration_seconds)
      VALUES (?, ?, ?, ?)
    `).run(contactId, contactName, finalName, duration);

    const callId = r.lastInsertRowid;
    res.json({ call_id: callId, status: 'processing' });

    // Process asynchronously — do not await
    setImmediate(() => {
      const contactContext = (contactId || contactName) ? {
        contact_id: contactId,
        name: contactName,
        mobile,
        address,
      } : null;
      processCallRecording(callId, finalPath, req.file.originalname, contactContext)
        .catch(e => console.error('[call-intel] setImmediate error:', e.message));
    });

  } catch (e) {
    console.error('[POST /api/calls/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

**Step 5: Restart and smoke-test upload**

```bash
pm2 restart jarvis-snapshot --update-env && sleep 3
```

Create a tiny test audio file (silence) to verify the endpoint accepts it:
```bash
# Create a 1-second silent MP3 (requires ffmpeg on VPS, or just test with any small file)
node -e "
  require('dotenv').config({path:'/root/.openclaw/.env',override:true});
  const https = require('https');
  const a = process.env.DASHBOARD_PASSWORD;
  const req = https.request({hostname:'localhost',port:4242,path:'/api/calls',rejectUnauthorized:false,headers:{'Authorization':'Bearer '+a}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log('calls list:', b))});
  req.end();
"
```

Expected: `[]` still (no recordings uploaded yet — full test requires the companion)

**Step 6: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js
git commit -m "feat: add call intelligence processing pipeline (Whisper + Claude)"
```

---

## Task 5: Dashboard — RecordingsPage component

**Files:**
- Modify: `/root/.openclaw/workspace/dashboard/dashboard.js`

The page goes AFTER the `HistoryPage` function and BEFORE the `Sidebar` function.

Find the `function Sidebar` declaration and insert the following component immediately before it:

**Step 1: Add RecordingsPage component**

```jsx
// ── Recordings Page ────────────────────────────────────────────────────────
function RecordingsPage({ token }) {
  const [recordings, setRecordings] = React.useState([]);
  const [selected, setSelected] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [copied, setCopied] = React.useState(false);

  const outcomeColors = {
    connected: '#22c55e',
    left_message: '#f59e0b',
    not_interested: '#ef4444',
    callback_requested: '#3b82f6',
    appraisal_booked: '#C8A96E',
    other: '#64748b',
  };
  const outcomeLabels = {
    connected: 'Connected',
    left_message: 'Left Message',
    not_interested: 'Not Interested',
    callback_requested: 'Callback Requested',
    appraisal_booked: 'Appraisal Booked',
    other: 'Other',
  };

  React.useEffect(() => {
    apiFetch('/api/calls', token)
      .then(r => r.json())
      .then(data => { setRecordings(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const loadDetail = async (id) => {
    const r = await apiFetch(`/api/calls/${id}`, token);
    const data = await r.json();
    setSelected(data);
  };

  const copySms = () => {
    if (!selected?.sms_draft) return;
    navigator.clipboard.writeText(selected.sms_draft).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (loading) return <div style={{ padding: 32, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Loading recordings…</div>;

  if (recordings.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🎙️</div>
        <div style={{ marginBottom: 8 }}>No call recordings yet.</div>
        <div style={{ opacity: 0.6 }}>Start the Mac companion and make a call from the dashboard.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 160px)', overflow: 'hidden' }}>
      {/* List panel */}
      <div style={{ width: 320, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {recordings.map(rec => (
          <div
            key={rec.id}
            onClick={() => loadDetail(rec.id)}
            style={{
              background: selected?.id === rec.id ? 'rgba(200,169,110,0.08)' : 'rgba(255,255,255,0.02)',
              border: `1px solid ${selected?.id === rec.id ? 'rgba(200,169,110,0.3)' : 'rgba(255,255,255,0.06)'}`,
              borderRadius: 8,
              padding: '12px 14px',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
                {rec.contact_name || 'Unknown Contact'}
              </div>
              {rec.outcome && (
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
                  padding: '2px 6px', borderRadius: 3,
                  background: `${outcomeColors[rec.outcome]}20`,
                  color: outcomeColors[rec.outcome],
                  border: `1px solid ${outcomeColors[rec.outcome]}40`,
                }}>
                  {outcomeLabels[rec.outcome] || rec.outcome}
                </span>
              )}
            </div>
            {rec.summary && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {rec.summary}
              </div>
            )}
            {!rec.processed_at && (
              <div style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'var(--font-mono)', marginTop: 4 }}>⏳ Processing…</div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 6, opacity: 0.5 }}>
              {new Date(rec.created_at).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })}
            </div>
          </div>
        ))}
      </div>

      {/* Detail panel */}
      <div style={{ flex: 1, overflowY: 'auto', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 20 }}>
        {!selected ? (
          <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12, paddingTop: 40, textAlign: 'center' }}>
            Select a recording to view details
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-primary)', fontWeight: 700, marginBottom: 4 }}>
                {selected.contact_name || 'Unknown Contact'}
              </div>
              {selected.outcome && (
                <span style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
                  padding: '3px 8px', borderRadius: 4,
                  background: `${outcomeColors[selected.outcome]}20`,
                  color: outcomeColors[selected.outcome],
                  border: `1px solid ${outcomeColors[selected.outcome]}40`,
                }}>
                  {outcomeLabels[selected.outcome] || selected.outcome}
                </span>
              )}
            </div>

            {selected.summary && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 6 }}>SUMMARY</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{selected.summary}</div>
              </div>
            )}

            {selected.action_items && selected.action_items.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 6 }}>ACTION ITEMS</div>
                {(Array.isArray(selected.action_items) ? selected.action_items : []).map((item, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    • {item}
                  </div>
                ))}
              </div>
            )}

            {selected.sms_draft && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 6 }}>SMS DRAFT</div>
                <div style={{
                  background: 'rgba(200,169,110,0.06)', border: '1px solid rgba(200,169,110,0.2)',
                  borderRadius: 8, padding: '12px 14px', marginBottom: 8,
                  fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6, fontStyle: 'italic'
                }}>
                  "{selected.sms_draft}"
                </div>
                <button
                  onClick={copySms}
                  style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em',
                    padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
                    background: copied ? 'rgba(34,197,94,0.15)' : 'rgba(200,169,110,0.1)',
                    border: `1px solid ${copied ? 'rgba(34,197,94,0.4)' : 'rgba(200,169,110,0.3)'}`,
                    color: copied ? '#22c55e' : '#C8A96E',
                    transition: 'all 0.2s',
                  }}
                >
                  {copied ? '✓ Copied' : 'Copy SMS'}
                </button>
              </div>
            )}

            {selected.transcript && (
              <div>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 6 }}>FULL TRANSCRIPT</div>
                <div style={{
                  background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '12px 14px',
                  fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7,
                  whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {selected.transcript}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Test dashboard renders without error**

Open the dashboard in a browser and check the console — no JS errors from the new component.

**Step 3: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add RecordingsPage component to dashboard"
```

---

## Task 6: Dashboard — Nav + routing + tel: pre-tagging

**Files:**
- Modify: `/root/.openclaw/workspace/dashboard/dashboard.js`

**Step 1: Add 'recordings' to navItems**

Find the `navItems` array (around line 3877). Add after the `history` entry:

```js
{ id: 'recordings', label: 'Recordings', Icon: Mic },
```

Note: `Mic` is already in Lucide React UMD (`const { Mic } = LucideReact;`). Add it to the destructure at the top of the file. Find the existing Lucide destructure line (e.g. `const { Phone, ... } = LucideReact;`) and add `Mic` to it.

**Step 2: Add to MobileHeader labels**

Find the `labels` object in `MobileHeader`:
```js
const labels = {
  calls: 'Calls',
  // ...
  history: 'Call History'
};
```
Add: `recordings: 'Call Recordings',`

**Step 3: Add to pageTitles**

Find `const pageTitles = {` and add:
```js
recordings: { title: 'Call Recordings', subtitle: 'AI TRANSCRIPTS & POST-CALL INTELLIGENCE' },
```

**Step 4: Add to renderPage switch**

Find the `switch (page)` block and add:
```js
case 'recordings': return <RecordingsPage token={token} />;
```

**Step 5: Add tel: link pre-tagging**

This intercepts tel: link clicks and pings the Mac companion at localhost:5678 with contact context.

Find the `ProspectCard` component (it contains the main call button for the call board). The tel: link looks like:
```jsx
<a className="prospect-tel" href={`tel:${localContact.mobile}`}>
```

Replace it with a version that also fires the pre-tag ping:

```jsx
<a
  className="prospect-tel"
  href={`tel:${localContact.mobile}`}
  onClick={() => {
    fetch('http://localhost:5678/upcoming-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: localContact.id || localContact.contact_id,
        name: localContact.name,
        mobile: localContact.mobile,
        address: localContact.address,
      }),
    }).catch(() => {}); // silently ignore if companion not running
  }}
>
```

Do the same for the other primary call buttons (SearchCard at line ~3420, the Referral Prospects page at ~4865). They follow the same pattern — add an `onClick` that fires the companion ping.

**Step 6: Verify in browser**

Open dashboard, click Recordings in sidebar — should see RecordingsPage with empty state message.

**Step 7: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add recordings nav, routing, tel pre-tagging for companion"
```

---

## Task 7: Mac Companion — companion.js

The companion runs on the user's **local Mac**, not the VPS. We create the files in `/root/.openclaw/mac-companion/` so they're committed to GitHub and the user can clone them to their Mac.

**Files:**
- Create: `/root/.openclaw/mac-companion/companion.js`
- Create: `/root/.openclaw/mac-companion/package.json`
- Create: `/root/.openclaw/mac-companion/.env.example`

**Step 1: Create package.json**

```json
{
  "name": "jarvis-companion",
  "version": "1.0.0",
  "description": "Jarvis call recording companion for Mac",
  "main": "companion.js",
  "scripts": {
    "start": "node companion.js"
  },
  "dependencies": {
    "axios": "^1.13.5",
    "chokidar": "^4.0.3",
    "express": "^4.21.2",
    "form-data": "^4.0.1"
  }
}
```

**Step 2: Create .env.example**

```
# Jarvis VPS URL
JARVIS_URL=https://72.62.74.105:4242

# Dashboard password (same as DASHBOARD_PASSWORD on VPS)
JARVIS_TOKEN=your_dashboard_password_here

# Folder where Audio Hijack saves recordings
AUDIO_HIJACK_FOLDER=/Users/YOUR_USERNAME/Music/Jarvis Calls

# Port for local companion server (default 5678)
PORT=5678
```

**Step 3: Create companion.js**

```js
'use strict';
require('dotenv').config();

const express  = require('express');
const chokidar = require('chokidar');
const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const { execSync, spawn } = require('child_process');

const JARVIS_URL   = process.env.JARVIS_URL || 'https://72.62.74.105:4242';
const JARVIS_TOKEN = process.env.JARVIS_TOKEN;
const WATCH_FOLDER = process.env.AUDIO_HIJACK_FOLDER || path.join(process.env.HOME, 'Music', 'Jarvis Calls');
const PORT         = parseInt(process.env.PORT) || 5678;

if (!JARVIS_TOKEN) { console.error('ERROR: JARVIS_TOKEN not set in .env'); process.exit(1); }

// Ensure watch folder exists
if (!fs.existsSync(WATCH_FOLDER)) { fs.mkdirSync(WATCH_FOLDER, { recursive: true }); }
console.log(`[companion] Watching: ${WATCH_FOLDER}`);

// ── Contact pre-tag state ─────────────────────────────────────────────────
let pendingContact = null;
let pendingTimeout = null;

function setPending(contact) {
  pendingContact = contact;
  if (pendingTimeout) clearTimeout(pendingTimeout);
  // Clear after 10 minutes (call should be done)
  pendingTimeout = setTimeout(() => { pendingContact = null; }, 10 * 60 * 1000);
  console.log(`[companion] Pending contact: ${contact.name || contact.mobile}`);
}

// ── Upload to Jarvis ──────────────────────────────────────────────────────
async function uploadRecording(filePath, contact) {
  console.log(`[companion] Uploading: ${path.basename(filePath)}`);
  const form = new FormData();
  form.append('audio', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'audio/mpeg',
  });
  if (contact) {
    if (contact.contact_id) form.append('contact_id', String(contact.contact_id));
    if (contact.name)       form.append('contact_name', contact.name);
    if (contact.mobile)     form.append('mobile', contact.mobile);
    if (contact.address)    form.append('address', contact.address);
  }

  const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // self-signed cert on VPS
  const res = await axios.post(`${JARVIS_URL}/api/calls/upload`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${JARVIS_TOKEN}`,
    },
    httpsAgent,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 60000,
  });
  console.log(`[companion] Uploaded → call_id: ${res.data.call_id}`);
  return res.data;
}

// ── File watcher ──────────────────────────────────────────────────────────
const pendingFiles = new Map(); // filepath → debounce timer

chokidar.watch(WATCH_FOLDER, {
  ignored: /(^|[/\\])\../, // hidden files
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
}).on('add', async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.mp3', '.m4a', '.wav', '.aac', '.flac'].includes(ext)) return;

  console.log(`[companion] New file detected: ${path.basename(filePath)}`);
  const contact = pendingContact;
  pendingContact = null; // consume

  try {
    await uploadRecording(filePath, contact);
  } catch (e) {
    console.error('[companion] Upload failed:', e.message);
  }
});

// ── Fallback recorder (ffmpeg + BlackHole) ────────────────────────────────
let recordingProcess = null;
let recordingFile = null;

function startRecording() {
  if (recordingProcess) return { error: 'Already recording' };
  const filename = `manual-${Date.now()}.mp3`;
  recordingFile = path.join(WATCH_FOLDER, filename);

  // Capture BlackHole 2ch (system audio) + default mic via ffmpeg
  // Uses aggregate device named "Jarvis Record" — falls back to default input
  recordingProcess = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-i', ':0',            // default input (Aggregate Device if set as default)
    '-ar', '44100',
    '-ac', '1',
    '-b:a', '128k',
    recordingFile,
  ]);
  recordingProcess.stderr.on('data', () => {}); // suppress ffmpeg logs
  recordingProcess.on('exit', () => { recordingProcess = null; });
  console.log(`[companion] Manual recording started: ${filename}`);
  return { recording: true, filename };
}

function stopRecording() {
  if (!recordingProcess) return { error: 'Not recording' };
  recordingProcess.stdin.write('q'); // graceful ffmpeg stop
  recordingProcess = null;
  const file = recordingFile;
  recordingFile = null;
  console.log(`[companion] Manual recording stopped: ${file}`);
  // chokidar will pick it up and upload automatically
  return { stopped: true, file: path.basename(file) };
}

// ── Express server ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// POST /upcoming-call — called by Jarvis dashboard on tel: click
app.post('/upcoming-call', (req, res) => {
  const { contact_id, name, mobile, address } = req.body || {};
  setPending({ contact_id, name, mobile, address });
  res.json({ ok: true });
});

// GET /status — companion health check
app.get('/status', (req, res) => {
  res.json({
    watching: WATCH_FOLDER,
    pendingContact: pendingContact?.name || null,
    recording: !!recordingProcess,
  });
});

// Fallback UI — simple page with Start/Stop button
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Jarvis Companion</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { background: #080C0F; color: #C8A96E; font-family: 'DM Mono', monospace;
           display: flex; flex-direction: column; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; gap: 20px; }
    h2 { font-size: 14px; letter-spacing: 0.15em; margin: 0; }
    .status { font-size: 11px; color: #64748b; }
    button { padding: 16px 40px; font-size: 13px; font-family: inherit; letter-spacing: 0.1em;
             border-radius: 8px; cursor: pointer; border: 1px solid rgba(200,169,110,0.4);
             background: rgba(200,169,110,0.1); color: #C8A96E; transition: all 0.2s; }
    button:hover { background: rgba(200,169,110,0.2); }
    button.danger { border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.1); color: #ef4444; }
    #msg { font-size: 11px; color: #22c55e; min-height: 20px; }
  </style>
</head>
<body>
  <h2>JARVIS COMPANION</h2>
  <div class="status" id="status">Checking…</div>
  <button id="btn" onclick="toggle()">Start Recording</button>
  <div id="msg"></div>
  <script>
    let recording = false;
    async function refresh() {
      const s = await fetch('/status').then(r=>r.json());
      document.getElementById('status').textContent =
        'Watching: ' + s.watching.split('/').pop() +
        (s.pendingContact ? ' | Contact: ' + s.pendingContact : '') +
        (s.recording ? ' | 🔴 RECORDING' : '');
      recording = s.recording;
      const btn = document.getElementById('btn');
      btn.textContent = recording ? 'Stop & Upload' : 'Start Recording';
      btn.className = recording ? 'danger' : '';
    }
    async function toggle() {
      const endpoint = recording ? '/stop' : '/start';
      const r = await fetch(endpoint, {method:'POST'}).then(x=>x.json());
      document.getElementById('msg').textContent = JSON.stringify(r);
      setTimeout(refresh, 500);
    }
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`);
});

app.post('/start', (req, res) => res.json(startRecording()));
app.post('/stop',  (req, res) => res.json(stopRecording()));

app.listen(PORT, () => {
  console.log(`[companion] Server running at http://localhost:${PORT}`);
  console.log(`[companion] Jarvis: ${JARVIS_URL}`);
});
```

**Step 4: Commit**

```bash
cd /root/.openclaw
git add mac-companion/
git commit -m "feat: add Mac companion for call recording upload"
```

---

## Task 8: Mac Companion — README setup guide

**Files:**
- Create: `/root/.openclaw/mac-companion/README.md`

**Step 1: Create README.md**

```markdown
# Jarvis Call Companion — Mac Setup Guide

Records prospecting calls via iPhone Continuity + Audio Hijack and uploads them to Jarvis for AI transcription and analysis.

## One-time Mac Setup (~20 minutes)

### 1. Install BlackHole 2ch
Download from https://existential.audio/blackhole/ (free, requires email).
Install the 2ch version.

### 2. Configure Audio MIDI Setup
Open **Audio MIDI Setup** (search Spotlight).

**Create Multi-Output Device:**
- Click `+` → Multi-Output Device
- Check: Built-in Output (or your headset) AND BlackHole 2ch
- Rename: "Jarvis Playback"

**Create Aggregate Device:**
- Click `+` → Aggregate Device
- Check: Built-in Microphone AND BlackHole 2ch
- Rename: "Jarvis Record"

**Set System Output:**
- Right-click "Jarvis Playback" → Use this device for sound output

### 3. Install Audio Hijack ($65 USD — Rogue Amoeba)
Download from https://rogueamoeba.com/audiohijack/

**Create a new session:**
1. New Session → name it "Jarvis Calls"
2. Add source: **Application Audio** → FaceTime (handles Continuity calls)
3. Add source: **Input Device** → "Jarvis Record" (Aggregate Device)
4. Add block: **Recorder**
   - Format: MP3
   - Quality: Good (128kbps)
   - Output folder: `~/Music/Jarvis Calls`
   - Filename: `{Date} {Time}`
5. In session settings: Enable "Run session automatically when source app is active"
6. Audio Hijack → Preferences → check "Launch at Login"

### 4. Enable iPhone Continuity Calling
On iPhone: **Settings → Phone → Calls on Other Devices** → enable your Mac.

### 5. Set up Jarvis Companion
```bash
# Clone or copy this folder to your Mac, then:
cd jarvis-companion
cp .env.example .env
# Edit .env with your values (JARVIS_TOKEN = your dashboard password)
npm install
node companion.js
```

## Daily Use

1. **Companion runs in background** — `node companion.js` (or set up as a launchd service)
2. **Audio Hijack runs in background** — auto-starts recording when you make a call
3. **Click Call in Jarvis dashboard** — companion is pre-tagged with contact info
4. **Make the call** — iPhone routes through Mac via Continuity
5. **Hang up** — Audio Hijack saves the MP3 → companion detects it → uploads to Jarvis
6. **~30 seconds later** — Telegram notification with transcript, summary, SMS draft, and any calendar events/reminders created

## Fallback (if Audio Hijack not running)

Open http://localhost:5678 in your browser.
Click **Start Recording** before your call, **Stop & Upload** when done.

## Auto-start on Login

To run companion automatically, create a launchd plist:
```bash
# Create ~/Library/LaunchAgents/com.jarvis.companion.plist
# (see Apple documentation for launchd format)
# Or simply add to your Login Items via System Preferences
```

## Troubleshooting

**No audio from caller:** Check that "Jarvis Playback" is set as System Output in Audio MIDI Setup.

**No recording files appearing:** Open Audio Hijack and verify the Jarvis Calls session is active (green light).

**Upload fails:** Check your .env JARVIS_TOKEN matches the Jarvis dashboard password.

**ffmpeg not found (fallback mode):** Install via `brew install ffmpeg`.
```

**Step 2: Commit**

```bash
cd /root/.openclaw
git add mac-companion/README.md
git commit -m "docs: add Mac companion setup guide"
```

---

## Task 9: Push + verify

**Step 1: Push to GitHub**

```bash
cd /root/.openclaw
git push origin main
```

**Step 2: Restart server and verify all endpoints**

```bash
pm2 restart jarvis-snapshot --update-env && sleep 3 && pm2 logs jarvis-snapshot --lines 20 --nostream
```

Expected: Server starts cleanly, `[db] call_recordings table created` in logs (first boot only).

**Step 3: Verify endpoints exist**

```bash
node -e "
  require('dotenv').config({path:'/root/.openclaw/.env',override:true});
  const https=require('https'),a=process.env.DASHBOARD_PASSWORD;
  ['GET /api/calls'].forEach(label => {
    const req=https.request({hostname:'localhost',port:4242,path:'/api/calls',rejectUnauthorized:false,headers:{'Authorization':'Bearer '+a}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(label,r.statusCode,b.slice(0,80)))});
    req.end();
  });
"
```

Expected: `GET /api/calls 200 []`

**Step 4: Verify dashboard renders Recordings page**

Open the dashboard in browser, click "Recordings" in the sidebar.
Expected: Recordings page with empty state message and microphone emoji.

---

## Audio Hijack Setup (Manual — User Action Required)

After code is deployed, follow the README steps to:
1. Install BlackHole 2ch
2. Configure Audio MIDI Setup (Multi-Output + Aggregate devices)
3. Configure Audio Hijack session
4. Enable iPhone Continuity calling
5. Clone mac-companion to Mac and run `node companion.js`

---

## Summary of Files Changed

| File | Change |
|---|---|
| `lib/db.js` | Add `call_recordings` table migration |
| `snapshot-server.js` | Add `uploadAudio` multer, 3 endpoints, processing pipeline |
| `workspace/dashboard/dashboard.js` | Add `RecordingsPage`, nav, routing, tel: pre-tag |
| `mac-companion/companion.js` | New: Mac companion script |
| `mac-companion/package.json` | New: companion dependencies |
| `mac-companion/.env.example` | New: config template |
| `mac-companion/README.md` | New: setup guide |
| `package.json` | Add `form-data` dependency |
