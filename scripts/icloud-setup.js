#!/usr/bin/env node
'use strict';
/**
 * scripts/icloud-setup.js
 * Discovers your iCloud CalDAV calendar URL and writes it to .env.
 *
 * Prerequisites — add these to .env first:
 *   ICLOUD_APPLE_ID=your@icloud.com (or your Apple ID email)
 *   ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx  (from appleid.apple.com -> App-Specific Passwords)
 *
 * Usage:
 *   node scripts/icloud-setup.js
 *
 * On success writes ICLOUD_CALENDAR_URL to .env, then restart jarvis-snapshot.
 */
require('dotenv').config({ path: '/root/.openclaw/.env', override: true });
const axios = require('/root/.openclaw/node_modules/axios').default || require('/root/.openclaw/node_modules/axios');
const fs    = require('fs');

const ENV_PATH = '/root/.openclaw/.env';
const APPLE_ID = process.env.ICLOUD_APPLE_ID;
const APP_PASS = process.env.ICLOUD_APP_PASSWORD;

if (!APPLE_ID || !APP_PASS) {
  console.error('ERROR: Set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env first.');
  process.exit(1);
}

const AUTH    = { username: APPLE_ID, password: APP_PASS };
const HEADERS = { 'Content-Type': 'application/xml; charset=utf-8', 'Depth': '0' };

function writeEnvKey(key, value) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

function extractHref(xml) {
  const m = xml.match(/<[^:>]*:?href[^>]*>\s*([^\s<]+)\s*<\/[^:>]*:?href>/i);
  return m ? m[1].trim() : null;
}

async function main() {
  console.log(`\nConnecting to iCloud CalDAV as ${APPLE_ID}...\n`);

  // Step 1: Discover principal URL
  const propfindPrincipal = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:">
  <A:prop><A:current-user-principal/></A:prop>
</A:propfind>`;

  let principalPath;
  try {
    const r1 = await axios({
      method:  'PROPFIND',
      url:     'https://caldav.icloud.com/',
      auth:    AUTH,
      headers: HEADERS,
      data:    propfindPrincipal,
    });
    const principalMatch = r1.data.match(/<[^:>]*:?current-user-principal[^>]*>\s*<[^:>]*:?href[^>]*>\s*([^\s<]+)/i);
    principalPath = principalMatch ? principalMatch[1].trim() : null;
    if (!principalPath) throw new Error('Could not find current-user-principal in response');
    console.log('OK Principal path:', principalPath);
  } catch (e) {
    console.error('FAILED to connect to iCloud CalDAV.');
    console.error('  Check ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env');
    console.error('  Error:', e.response?.status, e.message);
    process.exit(1);
  }

  const principalUrl = principalPath.startsWith('http')
    ? principalPath
    : 'https://caldav.icloud.com' + principalPath;

  // Step 2: Discover calendar home set
  const propfindHome = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:prop><C:calendar-home-set/></A:prop>
</A:propfind>`;

  let homeUrl;
  try {
    const r2 = await axios({
      method:  'PROPFIND',
      url:     principalUrl,
      auth:    AUTH,
      headers: HEADERS,
      data:    propfindHome,
    });
    const homeMatch = r2.data.match(/<[^:>]*:?calendar-home-set[^>]*>\s*<[^:>]*:?href[^>]*>\s*([^\s<]+)/i);
    const homePath = homeMatch ? homeMatch[1].trim() : null;
    if (!homePath) throw new Error('Could not find calendar-home-set in response');
    homeUrl = homePath.startsWith('http') ? homePath : 'https://caldav.icloud.com' + homePath;
    console.log('OK Calendar home:', homeUrl);
  } catch (e) {
    console.error('FAILED to discover calendar home set:', e.message);
    process.exit(1);
  }

  // Step 3: List calendars
  const propfindCals = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:prop>
    <A:displayname/>
    <C:supported-calendar-component-set/>
  </A:prop>
</A:propfind>`;

  let calendars = [];
  let xmlBlocks = [];
  try {
    const r3 = await axios({
      method:  'PROPFIND',
      url:     homeUrl,
      auth:    AUTH,
      headers: { ...HEADERS, 'Depth': '1' },
      data:    propfindCals,
    });
    xmlBlocks = r3.data.split(/<\/?[^:>]*:?response>/i).filter(b => b.includes('href'));

    for (const block of xmlBlocks) {
      const href = (block.match(/<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i) || [])[1];
      const name = (block.match(/<[^:>]*:?displayname[^>]*>([^<]*)<\/[^:>]*:?displayname>/i) || [])[1];
      const hasVevent = /VEVENT/i.test(block);
      if (href && hasVevent) {
        const fullUrl = href.startsWith('http') ? href : 'https://caldav.icloud.com' + href;
        calendars.push({ name: name || '(unnamed)', url: fullUrl });
      }
    }
  } catch (e) {
    console.error('FAILED to list calendars:', e.message);
    process.exit(1);
  }

  if (calendars.length === 0) {
    console.error('No VEVENT calendars found. Make sure iCloud Calendar is enabled on your account.');
    process.exit(1);
  }

  console.log('\nAvailable calendars:');
  calendars.forEach((c, i) => console.log(`  [${i}] ${c.name}  ->  ${c.url}`));

  // Pick the one named "Home" or "Calendar", otherwise first
  const preferred = calendars.find(c => /^(home|calendar)$/i.test(c.name)) || calendars[0];
  console.log(`\nUsing: "${preferred.name}"`);
  console.log(`  To use a different calendar, manually set ICLOUD_CALENDAR_URL in .env\n`);

  writeEnvKey('ICLOUD_CALENDAR_URL', preferred.url);
  console.log('ICLOUD_CALENDAR_URL written to .env');

  // ── VTODO (Reminders) list discovery ──────────────────────────────────────
  const caldavBase = new URL(homeUrl).origin;
  const reminderLists = [];
  for (const block of xmlBlocks) {
    const href = (block.match(/<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i) || [])[1];
    const name = (block.match(/<[^:>]*:?displayname[^>]*>([^<]*)<\/[^:>]*:?displayname>/i) || [])[1];
    const hasVtodo = /VTODO/i.test(block);
    if (href && hasVtodo) {
      const fullUrl = href.startsWith('http') ? href : caldavBase + href;
      reminderLists.push({ name: (name || '').trim() || '(unnamed)', url: fullUrl });
    }
  }

  console.log('\nAvailable Reminders lists (VTODO):');
  reminderLists.forEach((c, i) => console.log(`  [${i}] ${c.name}  ->  ${c.url}`));

  const preferredReminders = reminderLists.find(c => /^work$/i.test(c.name))
    || reminderLists.find(c => !/inbox|outbox|notification/i.test(c.url))
    || reminderLists[0];

  if (preferredReminders) {
    console.log(`\nUsing Reminders list: "${preferredReminders.name}"`);
    writeEnvKey('ICLOUD_REMINDERS_URL', preferredReminders.url);
    console.log('ICLOUD_REMINDERS_URL written to .env');
  } else {
    console.warn('\nNo VTODO Reminders list found. Create a list in Apple Reminders app first, then re-run this script.');
  }

  console.log('\nNext steps:');
  console.log('  pm2 restart jarvis-snapshot --update-env');
  console.log('  Reminders and tasks will now sync to iCloud Calendar + Apple Reminders.\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
