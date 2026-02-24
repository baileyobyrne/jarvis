const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 4242;
const PASSWORD = 'jarvis2026';
const FILES = [
  // Pipeline B — Daily Planner (Notion + scoring)
  '/root/.openclaw/workspace/daily-planner.js',
  // Pipeline A — Reactive Email Monitor
  '/root/.openclaw/skills/agentbox-willoughby/monitor-email.js',
  // Pipeline A — Contact proximity engine
  '/root/.openclaw/skills/agentbox-willoughby/get-contacts.js',
  // Pipeline A — Haversine geocoder
  '/root/.openclaw/skills/agentbox-willoughby/geo-utils.js',
  // Pipeline A — RP Data merger + scorer
  '/root/.openclaw/skills/agentbox-willoughby/data-merger.js',
  // Shadow DB enrichment engine
  '/root/.openclaw/workspace/enrich-contacts.js',
  // Contact data schema
  '/root/.openclaw/workspace/willoughby-contacts-schema.json',
  // Cron schedule — what actually runs and when
  '/root/.openclaw/cron/jobs.json',
  // Claude Code instruction set for this workspace
  '/root/.openclaw/CLAUDE.md',
  // Agent behaviour definitions
  '/root/.openclaw/workspace/AGENTS.md',
];
function generateSnapshot() {
  const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  let content = `# Jarvis System Snapshot\n`;
  content += `**Generated:** ${timestamp} AEDT\n\n`;
  content += `This file is auto-generated from the live VPS. Always reflects current file versions.\n\n`;
  content += `---\n\n`;
  // Summary table
  content += `## Files Included\n\n`;
  for (const filePath of FILES) {
    const filename = path.basename(filePath);
    const exists = fs.existsSync(filePath);
    const size = exists ? `${(fs.statSync(filePath).size / 1024).toFixed(1)}KB` : 'MISSING';
    content += `- \`${filename}\` — ${size}\n`;
  }
  content += `\n---\n\n`;
  // File contents
  for (const filePath of FILES) {
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).replace('.', '');
    const lang = ext === 'js' ? 'javascript' : ext === 'json' ? 'json' : 'markdown';
    content += `## ${filename}\n`;
    content += `*Path: ${filePath}*\n\n`;
    if (fs.existsSync(filePath)) {
      const code = fs.readFileSync(filePath, 'utf8');
      content += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    } else {
      content += `> ⚠️ FILE NOT FOUND AT THIS PATH\n\n`;
    }
    content += `---\n\n`;
  }
  return content;
}
function loginPage(error = false) {
  return `
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;padding:20px">
      <h2>🤖 Jarvis Snapshot Server</h2>
      <p style="color:#666">Download the latest version of all key Jarvis scripts</p>
      ${error ? `<p style="color:#dc2626;font-size:14px">Incorrect password. Please try again.</p>` : ''}
      <form method="POST" action="/">
        <input name="key" type="password" placeholder="Password" autofocus
          style="padding:12px;font-size:16px;width:100%;box-sizing:border-box;border:1px solid ${error ? '#dc2626' : '#ccc'};border-radius:6px">
        <br><br>
        <button type="submit"
          style="padding:12px 24px;font-size:16px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;width:100%">
          📥 Generate &amp; Download Snapshot
        </button>
      </form>
    </body>
    </html>
  `;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      resolve(params.get('key') || '');
    });
  });
}

const server = http.createServer(async (req, res) => {
  // GET / — show login form
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginPage());
    return;
  }

  // POST / — check password
  if (req.method === 'POST') {
    const pass = await parseBody(req);
    if (pass !== PASSWORD) {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end(loginPage(true));
      return;
    }
    // Correct password — generate and download
    console.log(`[${new Date().toISOString()}] Snapshot downloaded`);
    const snapshot = generateSnapshot();
    const filename = `JARVIS_SNAPSHOT_${new Date().toISOString().slice(0,10)}.md`;
    res.writeHead(200, {
      'Content-Type': 'text/markdown',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.end(snapshot);
    return;
  }

  // Any other method — 405
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
});
server.listen(PORT, () => {
  console.log(`✅ Jarvis Snapshot Server running on port ${PORT}`);
  console.log(`🌐 Access at: http://72.62.74.105:${PORT}`);
});
