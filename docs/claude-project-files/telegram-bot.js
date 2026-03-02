/**
 * Jarvis AI Telegram Bot
 * Two-way natural language interface for logging market events and querying pipeline status.
 * Uses Claude Haiku for intent extraction + structured action execution.
 *
 * PM2: pm2 start telegram-bot.js --name jarvis-telegram --cwd /root/.openclaw/skills/agentbox-willoughby
 */

require('dotenv').config({ path: '../../.env' });
const fs   = require('fs');
const https = require('https');
const { db } = require('../../lib/db.js');

const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const DASHBOARD_TOKEN = process.env.DASHBOARD_PASSWORD;
const DASHBOARD_URL   = 'https://localhost:4242';

const STATE_FILE = '/root/.openclaw/workspace/telegram-bot-state.json';

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT || !ANTHROPIC_KEY) {
  console.error('[bot] Missing env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY');
  process.exit(1);
}

// ─── State persistence ────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { lastUpdateId: 0 };
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {}
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────
function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let chunks = '';
      res.on('data', d => { chunks += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getUpdates(offset) {
  try {
    const res = await telegramRequest('getUpdates', {
      offset,
      timeout: 20,
      allowed_updates: ['message', 'callback_query']
    });
    return res.ok ? (res.result || []) : [];
  } catch (e) {
    console.error('[bot] getUpdates error:', e.message);
    return [];
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await telegramRequest('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
  } catch (e) {
    console.error('[bot] answerCallbackQuery error:', e.message);
  }
}

async function editMessageText(chatId, messageId, text) {
  try {
    await telegramRequest('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML'
    });
  } catch (e) {
    console.error('[bot] editMessageText error:', e.message);
  }
}

async function sendMessage(chatId, text) {
  try {
    await telegramRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
  } catch (e) {
    console.error('[bot] sendMessage error:', e.message);
  }
}

// ─── Anthropic API helper ─────────────────────────────────────────────────────
function anthropicRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      let chunks = '';
      res.on('data', d => { chunks += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Dashboard API call (to POST /api/market-events/manual) ─────────────────
function dashboardPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    // Use http.request to call localhost with self-signed cert bypass
    const req = require('https').request({
      hostname: 'localhost',
      port: 4242,
      path,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${DASHBOARD_TOKEN}`
      }
    }, res => {
      let chunks = '';
      res.on('data', d => { chunks += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Claude intent extraction ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Jarvis, the AI backbone of a real estate prospecting system for Bailey O'Byrne at McGrath Willoughby, Sydney. Bailey will send you natural language messages about market events, pipeline questions, or requests. Extract structured intent from each message.

Return ONLY valid JSON in this format:
{
  "intent": "log_sold" | "log_listing" | "query_status" | "query_contacts" | "unknown",
  "address": "full street address if present, else null",
  "beds": number or null,
  "baths": number or null,
  "cars": number or null,
  "property_type": "Unit" | "House" | null,
  "price": "price string or null",
  "suburb": "suburb name if mentioned, else null",
  "reply": "your conversational reply as Jarvis to send back to Bailey"
}

The reply field should be brief, direct, and Jarvis-like — no fluff.
If intent is unknown, reply with a short helpful clarification question.
For log_sold/log_listing: confirm the details you extracted in the reply.
For query_status: the reply will be filled in after querying the DB.`;

async function extractIntent(text) {
  try {
    const res = await anthropicRequest({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }]
    });
    const raw = res.content?.[0]?.text || '';
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[bot] Claude parse error:', e.message);
    return { intent: 'unknown', reply: 'I had trouble parsing that. Could you rephrase?' };
  }
}

// ─── Intent handlers ──────────────────────────────────────────────────────────
async function handleLogEvent(parsed) {
  const type = parsed.intent === 'log_sold' ? 'sold' : 'listing';
  const body = {
    address:       parsed.address,
    type,
    beds:          parsed.beds   ? String(parsed.beds)  : '',
    baths:         parsed.baths  ? String(parsed.baths) : '',
    cars:          parsed.cars   ? String(parsed.cars)  : '',
    property_type: parsed.property_type || 'House',
    price:         parsed.price  || '',
    suburb:        parsed.suburb || ''
  };

  try {
    const result = await dashboardPost('/api/market-events/manual', body);
    if (result.status === 200 && result.body.ok) {
      const n = result.body.contactCount || 0;
      const typeLabel = type === 'sold' ? 'sold' : 'listed';
      return `✅ Logged — <b>${parsed.address}</b> (${typeLabel}).\n${n > 0 ? `${n} matching contacts flagged on dashboard.` : 'No matching contacts found.'}`;
    } else {
      return `⚠️ Logged with issues: ${result.body.error || 'unknown error'}`;
    }
  } catch (e) {
    return `❌ Failed to log event: ${e.message}`;
  }
}

async function handleQueryStatus() {
  try {
    const planDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const total    = db.prepare("SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = ?").get(planDate)?.n ?? 0;
    const called   = db.prepare("SELECT COUNT(*) AS n FROM daily_plans WHERE plan_date = ? AND called_at IS NOT NULL").get(planDate)?.n ?? 0;
    const remaining = total - called;

    // Find top uncalled contact
    const top = db.prepare(`
      SELECT dp.contact_id, c.name, c.propensity_score, dp.propensity_score as dp_score, dp.tenure
      FROM daily_plans dp
      LEFT JOIN contacts c ON c.id = dp.contact_id
      WHERE dp.plan_date = ? AND dp.called_at IS NULL
      ORDER BY COALESCE(dp.propensity_score, c.propensity_score) DESC
      LIMIT 1
    `).get(planDate);

    let msg = `📋 <b>${remaining}</b> of <b>${total}</b> remaining today.`;
    if (called > 0) msg += ` (${called} called)`;
    if (top?.name) {
      msg += `\n\nTop uncalled: <b>${top.name}</b>`;
      if (top.tenure) msg += ` — ${top.tenure}`;
    }
    return msg;
  } catch (e) {
    return `❌ DB error: ${e.message}`;
  }
}

// ─── Handle inline keyboard callback (Done button on reminders) ──────────────
async function handleCallbackQuery(cbq) {
  const data = cbq.data || '';
  if (!data.startsWith('complete_reminder_')) {
    await answerCallbackQuery(cbq.id, '');
    return;
  }

  const id = parseInt(data.replace('complete_reminder_', ''), 10);
  if (!id) {
    await answerCallbackQuery(cbq.id, 'Invalid reminder ID');
    return;
  }

  try {
    const result = await dashboardPost(`/api/reminders/${id}/complete`, {});
    if (result.status === 200 && result.body.ok) {
      await answerCallbackQuery(cbq.id, '✅ Marked as done!');
      if (cbq.message) {
        const original = cbq.message.text || '';
        await editMessageText(
          cbq.message.chat.id,
          cbq.message.message_id,
          original + '\n\n<i>✅ Completed</i>'
        );
      }
      console.log(`[bot] Reminder #${id} marked complete via Telegram button`);
    } else {
      await answerCallbackQuery(cbq.id, result.body?.error || 'Failed to complete');
    }
  } catch (e) {
    console.error('[bot] handleCallbackQuery error:', e.message);
    await answerCallbackQuery(cbq.id, 'Error completing reminder');
  }
}

// ─── Process a single update ──────────────────────────────────────────────────
async function processUpdate(update) {
  // Handle inline button callbacks
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const msg  = update.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text   = msg.text.trim();

  // Only respond to the configured chat
  if (chatId !== String(TELEGRAM_CHAT)) {
    console.log(`[bot] Ignored message from chat ${chatId}`);
    return;
  }

  console.log(`[bot] Received: "${text.slice(0, 80)}"`);

  const parsed = await extractIntent(text);
  console.log(`[bot] Intent: ${parsed.intent}`);

  let replyText = parsed.reply || "I'm not sure what you mean. Try again?";

  switch (parsed.intent) {
    case 'log_sold':
    case 'log_listing':
      if (!parsed.address) {
        replyText = "I need an address to log this. What's the full street address?";
      } else {
        replyText = await handleLogEvent(parsed);
      }
      break;

    case 'query_status':
      replyText = await handleQueryStatus();
      break;

    case 'query_contacts':
    case 'unknown':
    default:
      // Use Claude's reply as-is
      break;
  }

  await sendMessage(chatId, replyText);
}

// ─── Main polling loop ────────────────────────────────────────────────────────
async function main() {
  console.log('[bot] Jarvis Telegram Bot starting...');
  const state = loadState();
  let offset  = state.lastUpdateId + 1;

  console.log(`[bot] Polling from update_id offset ${offset}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await getUpdates(offset);

      for (const update of updates) {
        try {
          await processUpdate(update);
        } catch (e) {
          console.error('[bot] Error processing update:', e.message);
        }
        offset = update.update_id + 1;
        state.lastUpdateId = update.update_id;
        saveState(state);
      }
    } catch (e) {
      console.error('[bot] Poll loop error:', e.message);
    }

    // 2-second pause between polls
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(e => {
  console.error('[bot] Fatal error:', e);
  process.exit(1);
});
