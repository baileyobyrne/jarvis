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
  // sv-SE gives "2026-02-27 09:00:00"
  return str.replace(/[-: ]/g, '').slice(0, 15); // "20260227T090000"
}

function toIcalUtc(date) {
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
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
  ].join('\r\n');
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

  const { contact_name, contact_mobile, contact_address, note, fire_at, duration_minutes = 30 } = opts;

  const uid   = randomBytes(16).toString('hex') + '@jarvis';
  const start = new Date(fire_at);
  const end   = new Date(start.getTime() + duration_minutes * 60 * 1000);

  const descLines = [note || ''];
  if (contact_mobile)  descLines.push(`Mobile: ${contact_mobile}`);
  if (contact_address) descLines.push(`Address: ${contact_address}`);

  const ics = buildIcs({
    uid,
    summary:         `Follow up — ${contact_name}`,
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

module.exports = { createCalendarEvent };
