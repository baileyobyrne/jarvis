/**
 * Post-refetch summary report — sends a Telegram message after refetch-contacts-full.js completes.
 * Reports total contact count, DNC contacts, status breakdown, and delta vs previous run.
 *
 * Usage: node post-refetch-report.js
 * Called by cron immediately after refetch-contacts-full.js
 */

require('dotenv').config({ path: '../../.env' });
const fs    = require('fs');
const https = require('https');

const CONTACTS_FILE  = '/root/.openclaw/workspace/willoughby-contacts.json';
const STATS_FILE     = '/root/.openclaw/workspace/refetch-stats.json';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
  console.error('[report] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

function telegramSend(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  if (!fs.existsSync(CONTACTS_FILE)) {
    console.error('[report] contacts file not found:', CONTACTS_FILE);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const contacts = data.contacts || [];
  const fetchedAt = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : 'unknown';

  // Load previous stats for delta
  let prevStats = null;
  if (fs.existsSync(STATS_FILE)) {
    try { prevStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) {}
  }

  // Compute breakdown
  const total   = contacts.length;
  const dncCall = contacts.filter(c => c.doNotCall === 'YES').length;
  const dncEmail = contacts.filter(c => c.doNotEmail === 'YES').length;
  const withMobile = contacts.filter(c => c.mobile).length;

  // Status breakdown
  const statusMap = {};
  for (const c of contacts) {
    const s = (c.status || 'Unknown').trim();
    statusMap[s] = (statusMap[s] || 0) + 1;
  }
  const statusLines = Object.entries(statusMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, n]) => `  • ${s}: ${n.toLocaleString()}`)
    .join('\n');

  // Delta
  const delta = prevStats ? total - prevStats.total : null;
  const deltaStr = delta !== null
    ? (delta >= 0 ? ` (+${delta})` : ` (${delta})`)
    : '';

  // Save new stats
  const newStats = { total, dncCall, dncEmail, withMobile, fetchedAt: data.fetchedAt };
  fs.writeFileSync(STATS_FILE, JSON.stringify(newStats, null, 2));

  const msg = [
    `📋 <b>Jarvis Weekly Contact Refresh</b>`,
    `🕐 Completed: ${fetchedAt}`,
    ``,
    `<b>Totals</b>`,
    `  Total contacts: <b>${total.toLocaleString()}${deltaStr}</b>`,
    `  With mobile: ${withMobile.toLocaleString()} (${Math.round(withMobile / total * 100)}%)`,
    `  DNC call: ${dncCall.toLocaleString()}`,
    `  DNC email: ${dncEmail.toLocaleString()}`,
    ``,
    `<b>Status breakdown</b>`,
    statusLines,
    ``,
    `✅ Cache will rebuild on next pm2 restart or manual refresh.`
  ].join('\n');

  console.log('[report] Sending Telegram summary...');
  console.log(msg.replace(/<[^>]+>/g, ''));

  try {
    await telegramSend(msg);
    console.log('[report] Sent.');
  } catch (e) {
    console.error('[report] Telegram send failed:', e.message);
  }
})();
