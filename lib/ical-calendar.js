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

/**
 * Build a VTODO ICS string for Apple Reminders.
 */
function buildVTodo({ uid, summary, description, due, priority = 0 }) {
  const now = toIcalUtc(new Date());
  const escapedDesc    = (description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,');
  const escapedSummary = (summary || '').replace(/,/g, '\\,');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jarvis//Jarvis//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `CREATED:${now}`,
    `LAST-MODIFIED:${now}`,
    `SUMMARY:${escapedSummary}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapedDesc}`);
  if (due) lines.push(`DUE;TZID=Australia/Sydney:${toIcalLocal(new Date(due))}`);
  if (priority) lines.push(`PRIORITY:${priority}`); // 1=high, 5=normal, 9=low
  lines.push('STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Create a reminder in Apple Reminders via CalDAV VTODO PUT.
 * Uses the default reminders list (ICLOUD_REMINDERS_URL).
 * Returns the uid string on success, null on failure.
 */
async function createReminder(opts) {
  const appleId      = process.env.ICLOUD_APPLE_ID;
  const appPass      = process.env.ICLOUD_APP_PASSWORD;
  const remindersUrl = process.env.ICLOUD_REMINDERS_URL;
  if (!appleId || !appPass || !remindersUrl) return null;

  const { contact_name, note, fire_at, ical_title, priority = 'normal' } = opts;

  const summary = ical_title || (() => {
    const notePart = (note || '').slice(0, 40).trim();
    if (contact_name && contact_name !== 'Manual Task') {
      return notePart ? `Call: ${contact_name} — ${notePart}` : `Call: ${contact_name}`;
    }
    return notePart ? `Reminder: ${notePart}` : 'Jarvis Reminder';
  })();

  const descLines = [note || ''];
  if (opts.contact_mobile) descLines.push(`Mobile: ${opts.contact_mobile}`);

  const priorityMap = { high: 1, normal: 5, low: 9 };
  const icalPriority = priorityMap[priority] || 5;

  const uid = randomBytes(16).toString('hex') + '@jarvis-todo';
  const ics = buildVTodo({
    uid,
    summary,
    description: descLines.join('\n'),
    due: fire_at || null,
    priority: icalPriority,
  });

  const todoUrl = remindersUrl.replace(/\/?$/, '/') + uid + '.ics';
  try {
    await axios.put(todoUrl, ics, {
      auth:    { username: appleId, password: appPass },
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    console.log(`[icloud] Reminder created: "${summary}"`);
    return uid;
  } catch (e) {
    console.warn('[icloud] createReminder failed:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

/**
 * Mark a VTODO complete in Apple Reminders by UID.
 * Fetches the existing ICS, patches STATUS:COMPLETED + COMPLETED timestamp, re-PUTs it.
 * Returns true on success, false on failure.
 */
async function completeReminder(uid) {
  const appleId      = process.env.ICLOUD_APPLE_ID;
  const appPass      = process.env.ICLOUD_APP_PASSWORD;
  const remindersUrl = process.env.ICLOUD_REMINDERS_URL;
  if (!appleId || !appPass || !remindersUrl || !uid) return false;

  const todoUrl = remindersUrl.replace(/\/?$/, '/') + uid + '.ics';
  const now     = toIcalUtc(new Date());

  try {
    const getRes = await axios.get(todoUrl, {
      auth: { username: appleId, password: appPass },
    });
    let ics = getRes.data;

    if (/^STATUS:/m.test(ics)) {
      ics = ics.replace(/^STATUS:.*$/m, 'STATUS:COMPLETED');
    } else {
      ics = ics.replace(/^END:VTODO/m, `STATUS:COMPLETED\r\nEND:VTODO`);
    }
    if (!/^COMPLETED:/m.test(ics)) {
      ics = ics.replace(/^END:VTODO/m, `COMPLETED:${now}\r\nEND:VTODO`);
    } else {
      ics = ics.replace(/^COMPLETED:.*$/m, `COMPLETED:${now}`);
    }
    ics = ics.replace(/^LAST-MODIFIED:.*$/m, `LAST-MODIFIED:${now}`);

    await axios.put(todoUrl, ics, {
      auth:    { username: appleId, password: appPass },
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    console.log(`[icloud] Reminder completed: ${uid}`);
    return true;
  } catch (e) {
    console.warn('[icloud] completeReminder failed:', e.response?.status, e.response?.data || e.message);
    return false;
  }
}

/**
 * Fetch all reminders from Apple Reminders CalDAV.
 * Returns array of { uid, summary, due, status }.
 */
async function fetchReminders() {
  const appleId      = process.env.ICLOUD_APPLE_ID;
  const appPass      = process.env.ICLOUD_APP_PASSWORD;
  const remindersUrl = process.env.ICLOUD_REMINDERS_URL;
  if (!appleId || !appPass || !remindersUrl) return [];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag /><c:calendar-data /></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO" />
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  try {
    const response = await axios({
      method: 'REPORT',
      url: remindersUrl,
      auth: { username: appleId, password: appPass },
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Depth': '1' },
      data: body,
    });
    return parseVTodos(response.data);
  } catch (e) {
    console.warn('[icloud] fetchReminders failed:', e.response?.status, e.message);
    return [];
  }
}

function parseVTodos(xml) {
  const results = [];
  const dataMatches = xml.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi) || [];
  for (const block of dataMatches) {
    const ics     = block.replace(/<[^>]+>/g, '').trim();
    const uid     = (ics.match(/^UID:(.+)$/m)     || [])[1]?.trim();
    const summary = (ics.match(/^SUMMARY:(.+)$/m) || [])[1]?.trim();
    const status  = (ics.match(/^STATUS:(.+)$/m)  || [])[1]?.trim() || 'NEEDS-ACTION';
    const due     = (ics.match(/^DUE[^:]*:(.+)$/m)|| [])[1]?.trim() || null;
    if (uid && summary) results.push({ uid, summary, due, status });
  }
  return results;
}

module.exports = { createCalendarEvent, fetchTodayEvents, createReminder, completeReminder, fetchReminders };
