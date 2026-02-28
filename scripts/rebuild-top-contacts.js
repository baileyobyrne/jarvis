'use strict';
/**
 * rebuild-top-contacts.js
 * Re-triggers top_contacts scoring for all active market events.
 * Run once after any change to buildScoredContactsForManual scoring logic.
 *
 * Usage: node /root/.openclaw/scripts/rebuild-top-contacts.js
 */
require('dotenv').config({ path: '/root/.openclaw/.env', override: true });
const https = require('https');

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 4242, path, method,
      rejectUnauthorized: false,
      headers: {
        Authorization: 'Bearer ' + process.env.DASHBOARD_PASSWORD,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const { status, body } = await apiRequest('GET', '/api/market?include_historical=0');
  if (status !== 200) { console.error('Failed to fetch events:', status); process.exit(1); }
  const events = JSON.parse(body);
  console.log(`Rebuilding top_contacts for ${events.length} events…`);
  let ok = 0, fail = 0;
  for (const ev of events) {
    const r = await apiRequest('PATCH', `/api/market-events/${ev.id}`, { address: ev.address });
    if (r.status === 200) { ok++; process.stdout.write('.'); }
    else { fail++; console.log(`\n  Event ${ev.id} (${ev.address}): ${r.status}`); }
    await sleep(200);
  }
  console.log(`\nDone. OK: ${ok} | Failed: ${fail}`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
