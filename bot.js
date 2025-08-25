// bot.js — POS bot: inline /sale (Girl/Set/Payment/Table/Amount) + PayNow QR + /history (QR/Cash/All)
// Requirements: Node 18+, "type":"module" in package.json
// npm i telegraf qrcode dotenv

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// ENV
// ────────────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');

const MODE = (process.env.PAYNOW_MODE || 'mobile').toLowerCase(); // 'uen' | 'mobile'
const UEN = process.env.PAYNOW_UEN || '';
const MOBILE = process.env.PAYNOW_MOBILE || '';
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Receiver';
const MERCHANT_CITY = process.env.MERCHANT_CITY || 'Singapore';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;  // string or number

// Set → default price (edit to your real prices)
const SET_PRICE = {
  'Set 1': 50,
  'Set 2': 100,
  'Set 3': 150,
  'Set 4': 200,
  'Set 5': 300,
};

// QR lifetime
const QR_LIFETIME_MS = 2 * 60 * 1000; // 2 minutes

// ────────────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ────────────────────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────────────────────
const DB_PATH = path.resolve('./sales-log.json');
let DB = { users: {}, sales: [] };

async function loadDB() {
  try {
    DB = JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
  } catch {
    DB = { users: {}, sales: [] };
  }
}
async function saveDB() {
  await fs.writeFile(DB_PATH, JSON.stringify(DB, null, 2));
}
await loadDB();

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
function nano(size = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: size }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}
function fmt(n) { return Number(n).toFixed(2); }
async function tryDelete(ctx, messageId) { if (!messageId) return; try { await ctx.deleteMessage(messageId); } catch {} }

function tlv(id, value) {
  const v = String(value);
  const len = v.length.toString().padStart(2, '0');
  return id + len + v;
}
function crc16ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function buildMAI_PayNow({ mode, uen, mobile, editable = false, expiry }) {
  const gui = tlv('00', 'SG.PAYNOW');
  let proxyType, proxyValue;
  if (mode === 'mobile') {
    proxyType = tlv('01', '0');
    const digits = String(mobile || '').replace(/[^\d]/g, '');
    const msisdn = digits.startsWith('65') ? digits : ('65' + digits);
    if (!/^\d{10,15}$/.test(msisdn)) throw new Error('Invalid PAYNOW_MOBILE');
    proxyValue = tlv('02', msisdn);
  } else {
    proxyType = tlv('01', '2');
    if (!uen) throw new Error('PAYNOW_UEN required for mode=uen');
    proxyValue = tlv('02', uen);
  }
  const editableFlag = tlv('03', editable ? '1' : '0');
  const parts = [gui, proxyType, proxyValue, editableFlag];
  if (expiry) parts.push(tlv('04', expiry));
  return tlv('26', parts.join(''));
}
function buildPayNowPayload({
  mode = MODE, uen = UEN, mobile = MOBILE,
  amount, reference = '', merchantName = MERCHANT_NAME, merchantCity = MERCHANT_CITY,
  editable = false, expiry
}) {
  if (!(amount > 0)) throw new Error('Amount must be > 0');
  const id00 = tlv('00', '01');
  const id01 = tlv('01', '12');
  const id26 = buildMAI_PayNow({ mode, uen, mobile, editable, expiry });
  const id52 = tlv('52', '0000');
  const id53 = tlv('53', '702'); // SGD
  const id54 = tlv('54', Number(amount).toFixed(2));
  const id58 = tlv('58', 'SG');
  const id59 = tlv('59', merchantName.slice(0, 25));
  const id60 = tlv('60', merchantCity || 'Singapore');
  const bill = tlv('01', String(reference || '').slice(0, 25)); // 62-01 Bill Number
  const id62 = tlv('62', bill);
  const body = id00 + id01 + id26 + id52 + id53 + id54 + id58 + id59 + id60 + id62;
  const crc = crc16ccitt(body + '63' + '04');
  return body + tlv('63', crc);
}
async function generatePayNowQR({ amount, reference }) {
  const payload = buildPayNowPayload({ amount, reference });
  return await QRCode.toBuffer(payload, { margin: 1, scale: 8 });
}

// ────────────────────────────────────────────────────────────────────────────
// State for /sale
// ────────────────────────────────────────────────────────────────────────────
/*
 stepState[uid] = {
   mode:'nickname'|'sale',
   awaiting: null|'nick'|'girl'|'table'|'amount',
   promptMsgId: number|null,
   overviewMsgId: number|null,
   fields: { girl, set, payment, table, amount }
 }
*/
const stepState = {};

// UI builders
function saleOverviewText(s) {
  const f = s.fields;
  const setPrice = f.set ? SET_PRICE[f.set] : null;
  const effectiveAmount = (f.amount != null && f.amount > 0) ? f.amount : setPrice;
  return [
    '🪷 <b>Creating individual flower sale</b>',
    'Please follow the buttons below to input the necessary details.',
    '',
    `• <b>Girl’s name</b>: ${f.girl ? `<code>${f.girl}</code>` : '—'}`,
    `• <b>Set #</b>: ${f.set ? `<code>${f.set}</code>` : '—'}`,
    `• <b>Payment Method</b>: ${f.payment ? `<code>${f.payment}</code>` : '—'}`,
    `• <b>Table number</b>: ${f.table ? `<code>${f.table}</code>` : '—'}`,
    `• <b>Amount</b>: ${
      (f.amount != null && f.amount > 0)
        ? `<code>SGD ${fmt(f.amount)} (custom)</code>`
        : (effectiveAmount ? `<code>SGD ${fmt(effectiveAmount)}${f.set ? ' (from set)' : ''}</code>` : '—')
    }`
  ].join('\n');
}
function canGenerateQR(s) {
  const f = s.fields;
  const setPrice = f.set ? SET_PRICE[f.set] : null;
  const effectiveAmount = (f.amount != null && f.amount > 0) ? f.amount : setPrice;
  return !!(f.girl && f.set && f.payment === 'QR Code' && f.table && effectiveAmount > 0);
}
function canFinalizeCash(s) {
  const f = s.fields;
  return !!(f.girl && f.set && f.payment === 'Cash' && f.table);
}
function saleOverviewKeyboard(s) {
  const f = s.fields;
  const rows = [
    [
      { text: f.girl ? `Girl’s name: ${f.girl}` : 'Girl’s name', callback_data: 'sale_edit_girl' },
      { text: f.set ? `Set #: ${f.set}` : 'Set #', callback_data: 'sale_edit_set' },
    ],
    [
      { text: f.payment ? `Payment: ${f.payment}` : 'Payment Method', callback_data: 'sale_edit_pay' },
      { text: f.table ? `Table: ${f.table}` : 'Table number', callback_data: 'sale_edit_table' },
    ],
    [
      { text: (f.amount != null && f.amount > 0) ? `Amount: SGD ${fmt(f.amount)}` : 'Amount', callback_data: 'sale_edit_amount' },
      ...(f.amount ? [{ text: 'Clear', callback_data: 'sale_amount_clear' }] : [])
    ],
  ];
  if (canGenerateQR(s)) rows.push([{ text: '✅ Generate QR', callback_data: 'sale_generate_qr' }]);
  else if (canFinalizeCash(s)) rows.push([{ text: '✅ Mark Cash Collected', callback_data: 'sale_finalize_cash' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'sale_cancel' }]);
  return { inline_keyboard: rows };
}
async function saleShowOverview(ctx, s) {
  const text = saleOverviewText(s);
  const keyboard = saleOverviewKeyboard(s);
  const chatId = ctx.chat.id;
  if (s.overviewMsgId) {
    try {
      await ctx.telegram.editMessageText(chatId, s.overviewMsgId, undefined, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      return;
    } catch {}
  }
  const msg = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  s.overviewMsgId = msg.message_id;
}

// ────────────────────────────────────────────────────────────────────────────
// /history helpers (10h window, per-operator)
// ────────────────────────────────────────────────────────────────────────────
function tenHoursAgoMs() { return Date.now() - (10 * 60 * 60 * 1000); }
function filterMySales(uid, payment /* 'QR Code' | 'Cash' | 'ALL' */) {
  const cutoff = tenHoursAgoMs();
  return DB.sales
    .filter(s => {
      const ts = new Date(s.timestamp).getTime();
      if (isNaN(ts) || ts < cutoff) return false;
      if (String(s.operatorId || '') !== String(uid)) return false;
      if (payment === 'ALL') return true;
      return s.payment === payment;
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // newest first
}
function renderHistoryChunk(sales, operator) {
  if (!sales.length) return `📭 No sales for ${operator} in the last 10 hours.`;
  let out = `📜 <b>Sales for ${operator} (last 10h)</b>\n\n`;
  for (let i = 0; i < sales.length; i++) {
    const s = sales[i];
    const date = new Date(s.timestamp).toLocaleString('en-SG', {
      hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    out += `${i + 1}. ${s.girl} | ${s.set || '-'} | Table ${s.table || '-'} | ${s.payment}\n`;
    out += `   Amount: <b>SGD ${fmt(s.amount)}</b> | Invoice: <code>${s.invoice}</code>\n`;
    if (s.payment === 'QR Code' && s.reference) out += `   Ref: <code>${s.reference}</code>\n`;
    out += `   Date: ${date}\n\n`;
  }
  return out;
}
async function replyBig(ctx, htmlText) {
  const MAX = 3500;
  if (htmlText.length <= MAX) return ctx.reply(htmlText, { parse_mode: 'HTML' });
  let i = 0;
  while (i < htmlText.length) {
    const chunk = htmlText.slice(i, i + MAX);
    // avoid chopping HTML tags mid-way
    await ctx.reply(chunk, { parse_mode: 'HTML' });
    i += MAX;
  }
}
// ===== /report helpers =====
function tenHoursAgoForReport() { return Date.now() - (10 * 60 * 60 * 1000); }

function getSalesForWindow(startMs) {
  return DB.sales
    .filter(s => {
      const ts = new Date(s.timestamp).getTime();
      return !isNaN(ts) && ts >= startMs;
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // oldest → newest
}

// fixed-width table — keep columns compact
function pad(str = '', len = 14) {
  str = String(str);
  return (str.length >= len) ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function renderTableRows(rows) {
  // Header
  let out = '```\n' +
    pad('Timestamp', 17) + pad('Sales', 14) + pad('Value', 10) + pad('Set', 8) + pad('Table', 8) + pad('Method', 8) + '\n' +
    pad('───────────', 17) + pad('────────', 14) + pad('──────', 10) + pad('────', 8) + pad('─────', 8) + pad('──────', 8) + '\n';

  for (const r of rows) {
    out += pad(r.timestamp, 17) +
           pad(r.salesPerson, 14) +
           pad(`$${Number(r.value).toFixed(2)}`, 10) +
           pad(r.set || '-', 8) +
           pad(r.table || '-', 8) +
           pad(r.method, 8) + '\n';
  }

  out += '```';
  return out;
}

async function writeCsvFile(rows) {
  const header = ['Timestamp','Sales Person','Flower Value','Set','Table No.','Method'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const line = [
      r.timestamp,
      csvEscape(r.salesPerson),
      Number(r.value).toFixed(2),
      csvEscape(r.set || ''),
      csvEscape(r.table || ''),
      r.method
    ].join(',');
    lines.push(line);
  }
  const csv = lines.join('\n');
  const fname = `report_${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;
  await fs.writeFile(fname, csv, 'utf8');
  return fname;
}

function csvEscape(s = '') {
  s = String(s);
  return (/[",\n]/.test(s)) ? `"${s.replace(/"/g,'""')}"` : s;
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const uid = String(ctx.from.id);
  if (DB.users[uid]?.nickname) {
    return ctx.reply(`👋 Welcome back, ${DB.users[uid].nickname}! Use /sale to start.`);
  } else {
    const m = await ctx.reply('Hi! What would you like me to address you as?');
    stepState[uid] = { mode: 'nickname', awaiting: 'nick', promptMsgId: m.message_id, overviewMsgId: null, fields: {} };
  }
});

bot.command('sale', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!DB.users[uid]?.nickname) {
    const m = await ctx.reply('Please tell me your name first. What should I call you?');
    stepState[uid] = { mode: 'nickname', awaiting: 'nick', promptMsgId: m.message_id, overviewMsgId: null, fields: {} };
    return;
  }
  stepState[uid] = {
    mode: 'sale',
    awaiting: null,
    promptMsgId: null,
    overviewMsgId: null,
    fields: { girl: null, set: null, payment: null, table: null, amount: null }
  };
  await ctx.reply('Creating individual flower sale. Please follow the buttons below to input the necessary details.');
  await saleShowOverview(ctx, stepState[uid]);
});

bot.command('history', async (ctx) => {
  const uid = String(ctx.from.id);
  const op = DB.users[uid]?.nickname;
  if (!op) return ctx.reply('❌ You need to set your name first with /start or /sale.');
  const kb = {
    inline_keyboard: [[
      { text: 'QR Payment', callback_data: 'hist_qr' },
      { text: 'Cash', callback_data: 'hist_cash' },
      { text: 'All', callback_data: 'hist_all' }
    ]]
  };
  await ctx.reply('📑 <b>History</b> — pick a filter (last 10 hours):', { parse_mode: 'HTML', reply_markup: kb });
});
// /report — admin-only: posts a table + CSV to the admin group (last 10 hours)
bot.command('report', async (ctx) => {
    const callerId = String(ctx.from.id);
    if (!ADMIN_IDS.includes(callerId)) {
      return ctx.reply('🚫 You are not authorized to use /report.');
    }
    if (!ADMIN_CHAT_ID) {
      return ctx.reply('⚠️ ADMIN_CHAT_ID is not set in .env');
    }
  
    // Window: last 10 hours (adjust here if needed)
    const since = tenHoursAgoForReport();

    // Build normalized rows from DB.sales (supports your current "single" entries)
    const sales = getSalesForWindow(since);
    const rows = sales.map(s => {
      const ts = new Date(s.timestamp).toLocaleString('en-SG', {
        hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
      return {
        timestamp: ts,                         // Column A
        salesPerson: s.operator || '-',        // Column B
        value: s.amount ?? s.total ?? 0,       // Column C (fall back if you later add group totals)
        set: s.set || (s.items ? 'GROUP' : ''),// Column D
        table: s.table || '',                  // Column E
        method: s.payment || (s.items ? 'QR/CASH' : '-') // Column F
      };
    });
  
    // If no rows
    if (!rows.length) {
      await ctx.reply('📭 No sales in the last 10 hours.');
      return;
    }
  
    // 1) Send human-readable table to the admin group
    const tableText = renderTableRows(rows);
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, tableText, { parse_mode: 'MarkdownV2' })
      .catch(async () => {
        // Some clients prefer HTML; fallback if MarkdownV2 runs into escape noise
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, tableText.replace(/`/g,''), { parse_mode: 'HTML' });
      });
  
    // 2) Write & send CSV
    const csvPath = await writeCsvFile(rows);
    await ctx.telegram.sendDocument(ADMIN_CHAT_ID, { source: csvPath, filename: csvPath });
  
    // Optional: acknowledge to the caller (if they triggered from DM)
    if (ctx.chat.id !== Number(ADMIN_CHAT_ID) && String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) {
      await ctx.reply('📮 Report sent to the admin group.');
    }
  });
  

// ────────────────────────────────────────────────────────────────────────────
// /history filter actions
// ────────────────────────────────────────────────────────────────────────────
bot.action('hist_qr', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const op = DB.users[uid]?.nickname || 'Unknown';
  const sales = filterMySales(uid, 'QR Code');
  await replyBig(ctx, renderHistoryChunk(sales, op));
});
bot.action('hist_cash', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const op = DB.users[uid]?.nickname || 'Unknown';
  const sales = filterMySales(uid, 'Cash');
  await replyBig(ctx, renderHistoryChunk(sales, op));
});
bot.action('hist_all', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const op = DB.users[uid]?.nickname || 'Unknown';
  const sales = filterMySales(uid, 'ALL');
  await replyBig(ctx, renderHistoryChunk(sales, op));
});

// ────────────────────────────────────────────────────────────────────────────
// Inline actions for /sale
// ────────────────────────────────────────────────────────────────────────────
bot.action('sale_edit_girl', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  const prompt = await ctx.reply('👧 <b>Girl’s name</b> — Enter the girl name for this sale:', { parse_mode: 'HTML' });
  s.promptMsgId = prompt.message_id; s.awaiting = 'girl';
});
bot.action('sale_edit_set', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  const kb = { inline_keyboard: [
    [{ text: 'Set 1', callback_data: 'sale_set_1' }, { text: 'Set 2', callback_data: 'sale_set_2' }, { text: 'Set 3', callback_data: 'sale_set_3' }],
    [{ text: 'Set 4', callback_data: 'sale_set_4' }, { text: 'Set 5', callback_data: 'sale_set_5' }, { text: '⬅️ Back', callback_data: 'sale_back' }],
  ]};
  const m = await ctx.reply('📦 <b>Set #</b> — Choose a set:', { parse_mode: 'HTML', reply_markup: kb });
  s.promptMsgId = m.message_id; s.awaiting = null;
});
bot.action(/^sale_set_(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  s.fields.set = `Set ${ctx.match[1]}`;
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId = null;
  await saleShowOverview(ctx, s);
});
bot.action('sale_back', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId = null;
  await saleShowOverview(ctx, s);
});
bot.action('sale_edit_pay', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  const kb = { inline_keyboard: [
    [{ text: 'QR Code', callback_data: 'sale_pay_qr' }, { text: 'Cash', callback_data: 'sale_pay_cash' }],
    [{ text: '⬅️ Back', callback_data: 'sale_back' }]
  ]};
  const m = await ctx.reply('💳 <b>Payment Method</b> — choose one:', { parse_mode: 'HTML', reply_markup: kb });
  s.promptMsgId = m.message_id;
});
bot.action('sale_pay_qr', async (ctx) => {
  await ctx.answerCbQuery('QR Code selected');
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  s.fields.payment = 'QR Code';
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId = null;
  await saleShowOverview(ctx, s);
});
bot.action('sale_pay_cash', async (ctx) => {
  await ctx.answerCbQuery('Cash selected');
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  s.fields.payment = 'Cash';
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId = null;
  const warn = await ctx.reply('⚠️ <b>Cash must be collected immediately.</b>', { parse_mode: 'HTML' });
  setTimeout(() => tryDelete(ctx, warn.message_id), 10_000);
  await saleShowOverview(ctx, s);
});
bot.action('sale_edit_table', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  const m = await ctx.reply('🍽️ <b>Table number</b> — Enter the table number:', { parse_mode: 'HTML' });
  s.promptMsgId = m.message_id; s.awaiting = 'table';
});
bot.action('sale_edit_amount', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  const m = await ctx.reply('💵 <b>Amount</b> — Enter custom amount in SGD (e.g. 127):', { parse_mode: 'HTML' });
  s.promptMsgId = m.message_id; s.awaiting = 'amount';
});
bot.action('sale_amount_clear', async (ctx) => {
  await ctx.answerCbQuery('Amount cleared');
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  s.fields.amount = null; await saleShowOverview(ctx, s);
});

// Generate QR
bot.action('sale_generate_qr', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  const operator = DB.users[uid]?.nickname || 'Unknown';

  const f = s.fields;
  const setPrice = f.set ? SET_PRICE[f.set] : null;
  const effectiveAmount = (f.amount != null && f.amount > 0) ? f.amount : setPrice;

  if (!(f.girl && f.set && f.payment === 'QR Code' && f.table && effectiveAmount > 0)) {
    return ctx.reply('❌ Missing details. Ensure Girl, Set, Payment=QR Code, Table, and Amount are provided.');
  }

  const invoiceId = nano();
  let ref = `${operator}-${f.girl}-${invoiceId}`.replace(/\s+/g, '_').slice(0, 25);

  try {
    const buffer = await generatePayNowQR({ amount: effectiveAmount, reference: ref });
    const caption =
      `💳 <b>PayNow</b>\n` +
      `Operator: <b>${operator}</b>\n` +
      `Girl: <b>${f.girl}</b>\n` +
      `Set: <b>${f.set}</b>\n` +
      `Table: <b>${f.table}</b>\n` +
      `Amount: <b>SGD ${fmt(effectiveAmount)}</b>${(f.amount != null && f.amount > 0) ? ' (custom)' : (f.set ? ' (from set)' : '')}\n` +
      `Invoice: <code>${invoiceId}</code>\n` +
      `Ref (QR): <code>${ref}</code>\n\n` +
      `⚠️ This QR will auto-expire in 2 minutes.`;

    const msg = await ctx.replyWithPhoto({ source: buffer }, { caption, parse_mode: 'HTML' });
    setTimeout(() => tryDelete(ctx, msg.message_id), QR_LIFETIME_MS);

    // Log single sale
    DB.sales.push({
      operatorId: uid,
      operator,
      type: 'single',
      girl: f.girl,
      set: f.set,
      table: f.table,
      payment: 'QR Code',
      amount: effectiveAmount,
      invoice: invoiceId,
      reference: ref,
      timestamp: new Date().toISOString()
    });
    await saveDB();

    await tryDelete(ctx, s.overviewMsgId);
    await tryDelete(ctx, s.promptMsgId);
    delete stepState[uid];
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Failed to generate QR.');
  }
});

// Finalize Cash
bot.action('sale_finalize_cash', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s || s.mode !== 'sale') return;
  const operator = DB.users[uid]?.nickname || 'Unknown';

  const f = s.fields;
  const setPrice = f.set ? SET_PRICE[f.set] : null;
  const effectiveAmount = (f.amount != null && f.amount > 0) ? f.amount : setPrice;

  if (!(f.girl && f.set && f.payment === 'Cash' && f.table && effectiveAmount > 0)) {
    return ctx.reply('❌ Missing details. Ensure Girl, Set, Payment=Cash, Table, and Amount are provided.');
  }

  const invoiceId = nano();

  DB.sales.push({
    operatorId: uid,
    operator,
    type: 'single',
    girl: f.girl,
    set: f.set,
    table: f.table,
    payment: 'Cash',
    amount: effectiveAmount,
    invoice: invoiceId,
    reference: null,
    timestamp: new Date().toISOString()
  });
  await saveDB();

  await ctx.reply(
    `✅ <b>Cash recorded</b>\n` +
    `Operator: <b>${operator}</b>\n` +
    `Girl: <b>${f.girl}</b>\n` +
    `Set: <b>${f.set}</b>\n` +
    `Table: <b>${f.table}</b>\n` +
    `Amount: <b>SGD ${fmt(effectiveAmount)}</b>\n` +
    `Invoice: <code>${invoiceId}</code>`,
    { parse_mode: 'HTML' }
  );

  await tryDelete(ctx, s.overviewMsgId);
  await tryDelete(ctx, s.promptMsgId);
  delete stepState[uid];
});

// Cancel
bot.action('sale_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  const uid = String(ctx.from.id); const s = stepState[uid]; if (!s) return;
  await tryDelete(ctx, s.overviewMsgId);
  await tryDelete(ctx, s.promptMsgId);
  delete stepState[uid];
  await ctx.reply('❌ Sale cancelled.');
});

// ────────────────────────────────────────────────────────────────────────────
// Text capture (nickname, girl, table, amount)
// ────────────────────────────────────────────────────────────────────────────
bot.on('text', async (ctx, next) => {
  const uid = String(ctx.from.id);
  const msg = ctx.message.text?.trim() || '';
  if (msg.startsWith('/')) return next();

  const s = stepState[uid];
  if (!s) return next();

  // Nickname capture
  if (s.mode === 'nickname' && s.awaiting === 'nick') {
    DB.users[uid] = { nickname: msg };
    await saveDB();
    await tryDelete(ctx, ctx.message.message_id);
    await tryDelete(ctx, s.promptMsgId);
    delete stepState[uid];
    return ctx.reply(`✅ Got it. I’ll call you "${msg}". Use /sale to start.`);
  }

  // Sale text capture
  if (s.mode === 'sale' && s.awaiting) {
    if (s.awaiting === 'girl') {
      s.fields.girl = msg;
    } else if (s.awaiting === 'table') {
      s.fields.table = msg;
    } else if (s.awaiting === 'amount') {
      const val = Number(msg);
      if (!Number.isFinite(val) || val <= 0) {
        return ctx.reply('❌ Please enter a valid number greater than 0.');
      }
      s.fields.amount = val;
    }

    await tryDelete(ctx, ctx.message.message_id);
    await tryDelete(ctx, s.promptMsgId);
    s.awaiting = null; s.promptMsgId = null;
    await saleShowOverview(ctx, s);
    return;
  }

  return next();
});

// ────────────────────────────────────────────────────────────────────────────
// Launch
// ────────────────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('✅ POS bot ready. Use /start then /sale or /history');
});
