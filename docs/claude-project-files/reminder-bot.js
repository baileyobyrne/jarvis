'use strict';

require('dotenv').config({ path: '/root/.openclaw/.env' });
const https = require('https');
const { db } = require('../../lib/db.js');

// ─── Send a Telegram message (HTML parse mode, optional inline keyboard) ──────
async function sendTelegram(message, replyMarkup) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[reminder-bot] Telegram not configured — skipping.');
    return;
  }
  const payload = { chat_id: chatId, text: message, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const body = JSON.stringify(payload);
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resolve);
    req.write(body);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const due = db.prepare(`
    SELECT * FROM reminders
    WHERE fire_at <= datetime('now')
      AND sent = 0
      AND completed_at IS NULL
      AND is_task = 0
  `).all();

  if (due.length === 0) {
    console.log(`[reminder-bot] ${new Date().toISOString()} — no due reminders.`);
    return;
  }

  console.log(`[reminder-bot] ${new Date().toISOString()} — ${due.length} reminder(s) due.`);

  const markSent = db.prepare(`
    UPDATE reminders
    SET sent = 1, sent_at = datetime('now')
    WHERE id = ?
  `);

  for (const reminder of due) {
    const message =
      `⏰ <b>JARVIS REMINDER</b>\n` +
      `👤 ${reminder.contact_name}\n` +
      `📞 ${reminder.contact_mobile || 'N/A'}\n` +
      `📝 ${reminder.note}\n` +
      `<i>Set originally for: ${reminder.fire_at}</i>`;

    const doneButton = {
      inline_keyboard: [[{ text: '✅ Done', callback_data: `complete_reminder_${reminder.id}` }]]
    };

    try {
      await sendTelegram(message, doneButton);
      markSent.run(reminder.id);
      console.log(`[reminder-bot] Sent & marked — reminder #${reminder.id} for ${reminder.contact_name}`);
    } catch (err) {
      console.error(`[reminder-bot] Failed for reminder #${reminder.id}:`, err.message);
    }
  }
}

main().catch(err => {
  console.error('[reminder-bot] Fatal:', err.message);
  process.exit(1);
});
