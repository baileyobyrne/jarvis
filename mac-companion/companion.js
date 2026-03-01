'use strict';
require('dotenv').config();

const express  = require('express');
const chokidar = require('chokidar');
const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const { spawn } = require('child_process');

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
  // Clear after 10 minutes (call should be done by then)
  pendingTimeout = setTimeout(() => { pendingContact = null; }, 10 * 60 * 1000);
  console.log(`[companion] Pending contact: ${contact.name || contact.mobile || 'unknown'}`);
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
chokidar.watch(WATCH_FOLDER, {
  ignored: /(^|[/\\])\../,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
}).on('add', async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.mp3', '.m4a', '.wav', '.aac', '.flac'].includes(ext)) return;

  console.log(`[companion] New file detected: ${path.basename(filePath)}`);
  const contact = pendingContact;
  pendingContact = null; // consume pending contact

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

  recordingProcess = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-i', ':0',
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
  console.log(`[companion] Manual recording stopped: ${path.basename(file)}`);
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
    pendingContact: pendingContact ? (pendingContact.name || pendingContact.mobile || 'set') : null,
    recording: !!recordingProcess,
  });
});

// GET / — fallback UI with Start/Stop button
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
      try {
        const s = await fetch('/status').then(r=>r.json());
        document.getElementById('status').textContent =
          'Watching: ' + s.watching.split('/').pop() +
          (s.pendingContact ? ' | Contact: ' + s.pendingContact : '') +
          (s.recording ? ' | 🔴 RECORDING' : '');
        recording = s.recording;
        const btn = document.getElementById('btn');
        btn.textContent = recording ? 'Stop & Upload' : 'Start Recording';
        btn.className = recording ? 'danger' : '';
      } catch(e) { document.getElementById('status').textContent = 'Companion offline'; }
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
  console.log(`[companion] Jarvis target: ${JARVIS_URL}`);
});
