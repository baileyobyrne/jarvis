'use strict';
/**
 * lib/ical-calendar.js
 * Creates a calendar event in iCloud via CalDAV (RFC 4791 + RFC 5545 ICS).
 * Silently no-ops if ICLOUD_APPLE_ID or ICLOUD_APP_PASSWORD are not set.
 *
 * Required .env vars (set after running scripts/icloud-setup.js):
 *   ICLOUD_APPLE_ID        e.g. bailey@icloud.com
 *   ICLOUD_APP_PASSWORD    app-specific password from appleid.apple.com
 *   ICLOUD_CALENDAR_URL    e.g. https://caldav.icloud.com/12345678/calendars/home/
 */
const axios = require('axios');
const { randomBytes } = require('crypto');

/**
 * Format a JS Date to iCal local datetime string: YYYYMMDDTHHmmss
 * in Australia/Sydney time.
 */
function toIcalLocal(date) {
  const str = date.toLocaleString('sv-SE', { timeZone: 'Australia/Sydney' });
  // sv-SE gives "2026-02-27 09:00:00" — replace space with T, strip hyphens and colons
  return str.slice(0, 10).replace(/-/g, '') + 'T' + str.slice(11).replace(/:/g, '');
}

function toIcalUtc(date) {
  const iso = date.toISOString().slice(0, 19); // "2026-02-27T09:00:00"
  return iso.replace(/-/g, '').replace(/:/g, '') + 'Z'; // "20260227T090000Z"
}

/**
 * Generate an RFC 5545 VCALENDAR / VEVENT ICS string.
 */
function buildIcs({ uid, summary, description, dtstart, dtend, reminderMinutes = 15 }) {
  const now = toIcalUtc(new Date());
  const start = toIcalLocal(dtstart);
  const end   = toIcalLocal(dtend);
  const escapedDesc    = (description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,');
  const escapedSummary = (summary || '').replace(/,/g, '\\,');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jarvis//Jarvis//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=Australia/Sydney:${start}`,
    `DTEND;TZID=Australia/Sydney:${end}`,
    `SUMMARY:${escapedSummary}`,
    `DESCRIPTION:${escapedDesc}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `TRIGGER:-PT${reminderMinutes}M`,
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}

function toVtodoPriority(priority) {
  if (priority === 'high')   return '1';
  if (priority === 'low')    return '9';
  return '5'; // normal
}

function buildVtodoIcs({ uid, summary, description, dueDate, priority = 'normal', completed = false }) {
  const now = toIcalUtc(new Date());
  const escapedDesc    = (description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,');
  const escapedSummary = (summary || '').replace(/,/g, '\\,');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jarvis//Jarvis//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escapedSummary}`,
    `DESCRIPTION:${escapedDesc}`,
    `PRIORITY:${toVtodoPriority(priority)}`,
  ];
  if (completed) {
    lines.push('STATUS:COMPLETED');
    lines.push(`COMPLETED:${now}`);
  } else {
    lines.push('STATUS:NEEDS-ACTION');
    if (dueDate) {
      lines.push(`DUE;TZID=Australia/Sydney:${toIcalLocal(dueDate)}`);
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push('TRIGGER:-PT0M');
      lines.push('DESCRIPTION:Jarvis Reminder');
      lines.push('END:VALARM');
    }
  }
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

async function createAppleReminder(opts) {
  const remUrl  = process.env.ICLOUD_REMINDERS_URL;
  const appleId = process.env.ICLOUD_APPLE_ID;
  const appPass = process.env.ICLOUD_APP_PASSWORD;
  if (!remUrl || !appleId || !appPass) return null;

  const { contact_name, contact_mobile, note, fire_at, priority = 'normal', ical_title } = opts;
  const uid = randomBytes(16).toString('hex') + '@jarvis';

  const summary = ical_title || (() => {
    const notePart = (note || '').slice(0, 40).trim();
    if (contact_name && contact_name !== 'Manual Task') {
      return notePart ? `Call: ${contact_name} — ${notePart}` : `Call: ${contact_name}`;
    }
    return notePart ? `Reminder: ${notePart}` : 'Jarvis Reminder';
  })();

  const descLines = [note || ''];
  if (contact_mobile) descLines.push(`Mobile: ${contact_mobile}`);

  const dueDate = fire_at ? new Date(fire_at) : null;
  const ics     = buildVtodoIcs({ uid, summary, description: descLines.join('\n'), dueDate, priority });
  const eventUrl = remUrl.replace(/\/?$/, '/') + uid + '.ics';

  try {
    await axios.put(eventUrl, ics, {
      auth:    { username: appleId, password: appPass },
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    console.log(`[icloud] Apple Reminder created: ${summary}`);
    return uid;
  } catch (e) {
    console.warn('[icloud] Failed to create Apple Reminder:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

async function completeAppleReminder(uid) {
  const remUrl  = process.env.ICLOUD_REMINDERS_URL;
  const appleId = process.env.ICLOUD_APPLE_ID;
  const appPass = process.env.ICLOUD_APP_PASSWORD;
  if (!remUrl || !appleId || !appPass || !uid) return;

  const eventUrl = remUrl.replace(/\/?$/, '/') + uid + '.ics';
  let existingSummary = 'Jarvis Reminder';
  let existingDesc    = '';
  try {
    const r = await axios.get(eventUrl, { auth: { username: appleId, password: appPass } });
    existingSummary = (r.data.match(/^SUMMARY:(.+)$/m) || [])[1]?.trim() || existingSummary;
    existingDesc    = (r.data.match(/^DESCRIPTION:(.+)$/m) || [])[1]?.trim() || existingDesc;
  } catch (_) { /* best-effort */ }

  const ics = buildVtodoIcs({ uid, summary: existingSummary, description: existingDesc, completed: true });
  try {
    await axios.put(eventUrl, ics, {
      auth:    { username: appleId, password: appPass },
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    console.log(`[icloud] Apple Reminder marked complete: ${uid}`);
  } catch (e) {
    console.warn('[icloud] Failed to complete Apple Reminder:', e.response?.status, e.message);
  }
}

async function deleteAppleReminder(uid) {
  const remUrl  = process.env.ICLOUD_REMINDERS_URL;
  const appleId = process.env.ICLOUD_APPLE_ID;
  const appPass = process.env.ICLOUD_APP_PASSWORD;
  if (!remUrl || !appleId || !appPass || !uid) return;

  const eventUrl = remUrl.replace(/\/?$/, '/') + uid + '.ics';
  try {
    await axios.delete(eventUrl, { auth: { username: appleId, password: appPass } });
    console.log(`[icloud] Apple Reminder deleted: ${uid}`);
  } catch (e) {
    if (e.response?.status !== 404) {
      console.warn('[icloud] Failed to delete Apple Reminder:', e.response?.status, e.message);
    }
  }
}

/**
 * Create a calendar event in iCloud.
 * @param {object} opts
 * @param {string} opts.contact_name
 * @param {string} [opts.contact_mobile]
 * @param {string} [opts.contact_address]
 * @param {string} opts.note
 * @param {string} opts.fire_at        ISO string
 * @param {number} [opts.duration_minutes]  defaults to 30
 * @returns {Promise<string|null>}  the event UID on success, null on failure/skip
 */
async function createCalendarEvent(opts) {
  const appleId = process.env.ICLOUD_APPLE_ID;
  const appPass = process.env.ICLOUD_APP_PASSWORD;
  const calUrl  = process.env.ICLOUD_CALENDAR_URL;

  if (!appleId || !appPass || !calUrl) return null; // not configured — silent no-op

  const { contact_name, contact_mobile, contact_address, note, fire_at, duration_minutes = 30, ical_title } = opts;

  const uid   = randomBytes(16).toString('hex') + '@jarvis';
  const start = new Date(fire_at);
  const end   = new Date(start.getTime() + duration_minutes * 60 * 1000);

  const descLines = [note || ''];
  if (contact_mobile)  descLines.push(`Mobile: ${contact_mobile}`);
  if (contact_address) descLines.push(`Address: ${contact_address}`);

  const ics = buildIcs({
    uid,
    summary: ical_title || (() => {
      const notePart = (note || '').replace(/^\[Imported\]\s*/i, '').slice(0, 40).trim();
      if (contact_name && contact_name !== 'Manual Task') {
        return notePart ? `Call: ${contact_name} — ${notePart}` : `Call: ${contact_name}`;
      }
      return notePart ? `Reminder: ${notePart}` : 'Jarvis Reminder';
    })(),
    description:     descLines.join('\n'),
    dtstart:         start,
    dtend:           end,
    reminderMinutes: 15,
  });

  const eventUrl = calUrl.replace(/\/?$/, '/') + uid + '.ics';

  try {
    await axios.put(eventUrl, ics, {
      auth:    { username: appleId, password: appPass },
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    console.log(`[icloud] Calendar event created for ${contact_name} at ${fire_at} (${duration_minutes}min)`);
    return uid;
  } catch (e) {
    console.warn('[icloud] Failed to create calendar event:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

/**
 * Fetch today's calendar events from iCloud via CalDAV REPORT.
 * Returns [] if iCloud is not configured or on any error.
 * @returns {Promise<Array<{title:string, startTime:string, endTime:string, allDay:boolean}>>}
 */
async function fetchTodayEvents() {
  const appleId = process.env.ICLOUD_APPLE_ID;
  const appPass = process.env.ICLOUD_APP_PASSWORD;
  const calUrl  = process.env.ICLOUD_CALENDAR_URL;

  if (!appleId || !appPass || !calUrl) return [];

  // Build today's date range in UTC (iCloud uses UTC for time-range filter)
  const todayLocal = new Date();
  const start = new Date(todayLocal); start.setHours(0, 0, 0, 0);
  const end   = new Date(todayLocal); end.setHours(23, 59, 59, 999);

  const startStr = toIcalUtc(start);
  const endStr   = toIcalUtc(end);

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag /><c:calendar-data /></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startStr}" end="${endStr}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  try {
    const response = await axios({
      method: 'REPORT',
      url: calUrl,
      auth: { username: appleId, password: appPass },
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
      },
      data: body,
    });

    return parseVEvents(response.data, todayLocal);
  } catch (e) {
    console.warn('[icloud] fetchTodayEvents failed:', e.response?.status, e.message);
    return [];
  }
}

/**
 * Parse VEVENT blocks from a CalDAV REPORT XML response.
 */
function parseVEvents(xml, todayDate) {
  const events = [];
  // Extract calendar-data text blocks
  const dataMatches = xml.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi) || [];

  for (const block of dataMatches) {
    // Strip XML tags to get raw ICS content
    const ics = block.replace(/<[^>]+>/g, '').trim();

    const summary = (ics.match(/^SUMMARY:(.+)$/m) || [])[1]?.trim();
    if (!summary) continue;

    const dtstart = (ics.match(/^DTSTART[^:]*:(.+)$/m) || [])[1]?.trim();
    const dtend   = (ics.match(/^DTEND[^:]*:(.+)$/m)   || [])[1]?.trim();

    const allDay = dtstart && !dtstart.includes('T');

    let startTime = null, endTime = null;
    if (dtstart && !allDay) {
      const d = parseIcalDate(dtstart);
      startTime = d ? d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' }) : null;
    }
    if (dtend && !allDay) {
      const d = parseIcalDate(dtend);
      endTime = d ? d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' }) : null;
    }

    events.push({ title: summary, startTime, endTime, allDay });
  }

  // Sort timed events before all-day
  events.sort((a, b) => {
    if (a.allDay && !b.allDay) return 1;
    if (!a.allDay && b.allDay) return -1;
    return (a.startTime || '').localeCompare(b.startTime || '');
  });

  return events;
}

function parseIcalDate(str) {
  if (!str) return null;
  // Handles: 20260227T090000Z  20260227T090000  20260227T090000+1100
  const m = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mm, ss, utc] = m;
  if (utc) return new Date(`${yr}-${mo}-${dy}T${hh}:${mm}:${ss}Z`);
  // Treat as Sydney local time
  return new Date(new Date(`${yr}-${mo}-${dy}T${hh}:${mm}:${ss}`).toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
}

module.exports = { createCalendarEvent, fetchTodayEvents, createAppleReminder, completeAppleReminder, deleteAppleReminder };
