// bot.js — POS bot: /sale (Name/Table + Payment + Amount) + PayNow QR (+3%) + /history + /report
// Highlights in this version:
// • SINGLE FIELD: “Name / Table” (operator types one line; we store it as `name`)
// • QR charges base × 1.03 (e.g., 100 → 103.00), but /history and /report show NET (base, without 3%)
// • Inactivity auto-expire for /sale (2 min); QR posts auto-delete (2 min)
// • First start asks Name → Company (Lunar/Wave/Ion/101)
// • Company-based TxnID (L/W/I/1 + 3 digits) with noon reset; Bill Ref "TxnID - Operator - Name" (≤25)
// • /history (QR/Cash/All, last 10 hours, per-operator) — shows NET
// • /report (admin): Company → Individual/All → (if Individual) pick Operator; table + CSV to admin group, includes TxnID & Name and a NET subtotal
//
// Requirements: Node 18+, "type":"module" in package.json
// Install: npm i telegraf qrcode dotenv

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// ENV / constants
// ────────────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
const PORT = process.env.PORT || 8080;

const MODE = (process.env.PAYNOW_MODE || 'uen').toLowerCase(); // 'uen' | 'mobile'
const UEN = process.env.PAYNOW_UEN || '';
const MOBILE = process.env.PAYNOW_MOBILE || '';
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Receiver';
const MERCHANT_CITY = process.env.MERCHANT_CITY || 'Singapore';

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

const QR_LIFETIME_MS = 2 * 60 * 1000;       // QR auto delete
const SALE_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // sale session expire
const MIN_AMOUNT = 100;                     // base minimum before +3%

// ────────────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ────────────────────────────────────────────────────────────────────────────
// DB
// ────────────────────────────────────────────────────────────────────────────
const DB_PATH = path.resolve('./sales-log.json');
// DB = { users:{uid:{nickname,company}}, sales:[...],
//        counters:{date:'YYYY-MM-DD-noon', Lunar:0, Wave:0, Ion:0, '101':0 } }
let DB = { users:{}, sales:[], counters:{ date:null, Lunar:0, Wave:0, Ion:0, '101':0 } };

async function loadDB() {
  try { DB = JSON.parse(await fs.readFile(DB_PATH, 'utf8')); }
  catch { DB = { users:{}, sales:[], counters:{ date:null, Lunar:0, Wave:0, Ion:0, '101':0 } }; }
  if (!DB.counters) DB.counters = { date:null, Lunar:0, Wave:0, Ion:0, '101':0 };
}
async function saveDB() { await fs.writeFile(DB_PATH, JSON.stringify(DB, null, 2)); }
await loadDB();

// ────────────────────────────────────────────────────────────────────────────
// Utils / helpers
// ────────────────────────────────────────────────────────────────────────────
function fmt(n) { return Number(n).toFixed(2); }
async function tryDelete(ctx, mid) { if (!mid) return; try { await ctx.deleteMessage(mid); } catch {} }

// SGQR helpers
function tlv(id, value){ const v=String(value); const len=v.length.toString().padStart(2,'0'); return id+len+v; }
function crc16ccitt(str){
  let crc=0xffff;
  for(let i=0;i<str.length;i++){
    crc^=str.charCodeAt(i)<<8;
    for(let b=0;b<8;b++){ crc=(crc&0x8000)?((crc<<1)^0x1021):(crc<<1); crc&=0xffff; }
  }
  return crc.toString(16).toUpperCase().padStart(4,'0');
}
function buildMAI_PayNow({ mode, uen, mobile, editable=false, expiry }){
  const gui = tlv('00','SG.PAYNOW'); let proxyType, proxyValue;
  if (mode==='mobile'){
    proxyType = tlv('01','0');
    // Normalize to 8-digit local number (DBS/GXS strict)
    const digits = String(mobile||'').replace(/[^\d]/g,'');
    const local8 = digits.length===8 ? digits
      : (digits.startsWith('65') && digits.length===10 ? digits.slice(2)
        : (digits.startsWith('065') && digits.length===11 ? digits.slice(3)
          : (digits.startsWith('0065') && digits.length===12 ? digits.slice(4) : null)));
    if (!local8 || !/^[89]\d{7}$/.test(local8)) throw new Error('Invalid PAYNOW_MOBILE');
    proxyValue = tlv('02', local8);
  } else {
    proxyType = tlv('01','2');
    if (!uen) throw new Error('PAYNOW_UEN required for UEN mode');
    proxyValue = tlv('02', uen);
  }
  const editableFlag = tlv('03', editable?'1':'0');
  const parts = [gui, proxyType, proxyValue, editableFlag]; if (expiry) parts.push(tlv('04',expiry));
  return tlv('26', parts.join(''));
}
function buildPayNowPayload({ mode=MODE, uen=UEN, mobile=MOBILE, amount, reference='', merchantName=MERCHANT_NAME, merchantCity=MERCHANT_CITY, editable=false, expiry }){
  if (!(amount>0)) throw new Error('Amount must be > 0');
  const id00 = tlv('00','01');
  const id01 = tlv('01','12');
  const id26 = buildMAI_PayNow({ mode, uen, mobile, editable, expiry });
  const id52 = tlv('52','0000');
  const id53 = tlv('53','702'); // SGD
  const id54 = tlv('54', Number(amount).toFixed(2));
  const id58 = tlv('58','SG');
  const id59 = tlv('59', MERCHANT_NAME.slice(0,25));
  const id60 = tlv('60', MERCHANT_CITY || 'Singapore');
  const bill = tlv('01', String(reference||'').slice(0,25));
  const id62 = tlv('62', bill);
  const body = id00+id01+id26+id52+id53+id54+id58+id59+id60+id62;
  const crc = crc16ccitt(body+'63'+'04');
  return body + tlv('63', crc);
}
async function generatePayNowQR({ amount, reference }){
  const payload = buildPayNowPayload({ amount, reference });
  return await QRCode.toBuffer(payload, { margin:1, scale:8, errorCorrectionLevel:'M' });
}

// history helpers (10h)
function tenHoursAgoMs(){ return Date.now() - (10*60*60*1000); }
function filterMySales(uid, payment){
  const cut=tenHoursAgoMs();
  return DB.sales.filter(s=>{
    const ts=new Date(s.timestamp).getTime();
    if (isNaN(ts)||ts<cut) return false;
    if (String(s.operatorId||'')!==String(uid)) return false;
    return payment==='ALL' ? true : s.payment===payment;
  }).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
}
async function replyBig(ctx, html){
  const MAX=3500; if (html.length<=MAX) return ctx.reply(html,{parse_mode:'HTML'});
  for(let i=0;i<html.length;i+=MAX){ await ctx.reply(html.slice(i,i+MAX),{parse_mode:'HTML'}); }
}
function renderHistoryChunk(sales, operator){
  if (!sales.length) return `📭 No sales for ${operator} in the last 10 hours.`;
  let out = `📜 <b>Sales for ${operator} (last 10h)</b>\n\n`;
  for (let i=0;i<sales.length;i++){
    const s=sales[i];
    const date=new Date(s.timestamp).toLocaleString('en-SG',{hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    const net = (s.amountBase ?? s.amount ?? 0); // show NET (without 3%)
    out += `${i+1}. ${s.name || '-'} | ${s.payment}\n`;
    out += `   Amount (net): <b>SGD ${fmt(net)}</b> | Txn: <code>${s.transactionId || '-'}</code>\n`;
    if (s.payment==='QR Code' && s.reference) out += `   Ref: <code>${s.reference}</code>\n`;
    out += `   Date: ${date}\n\n`;
  }
  return out;
}

// TxnID helpers (noon boundary reset)
function resetKeyNoon(){
  const d=new Date();
  if (d.getHours()<12) d.setDate(d.getDate()-1);
  const mm=String(d.getMonth()+1).padStart(2,'0');
  const dd=String(d.getDate()).padStart(2,'0');
  return `${d.getFullYear()}-${mm}-${dd}-noon`;
}
function companyPrefix(company){
  switch((company||'').toLowerCase()){
    case 'lunar': return 'L';
    case 'wave':  return 'W';
    case 'ion':   return 'I';
    case '101':   return '1';
    default:      return 'X';
  }
}
function nextTxnId(company){
  const keyDate=resetKeyNoon();
  if (DB.counters.date!==keyDate){ DB.counters={ date:keyDate, Lunar:0, Wave:0, Ion:0, '101':0 }; }
  const key = (company==='101') ? '101' : (company||'').charAt(0).toUpperCase()+ (company||'').slice(1).toLowerCase();
  if (!(key in DB.counters)) DB.counters[key]=0;
  DB.counters[key] = (DB.counters[key]%999)+1;
  return `${companyPrefix(company)}${String(DB.counters[key]).padStart(3,'0')}`;
}
function buildReference(txnId, operator, name){ return `${txnId} - ${operator} - ${name}`.slice(0,25); }

// ────────────────────────────────────────────────────────────────────────────
// /sale state (with inactivity)
// ────────────────────────────────────────────────────────────────────────────
/*
stepState[uid] = {
  mode:'nickname'|'company'|'sale'|'report',
  awaiting: null|'nick'|'company'|'name'|'amount'|'rep_company'|'rep_scope'|'rep_operator',
  promptMsgId:null|number,
  overviewMsgId:null|number,
  expiryTimer:null|Timeout,
  fields:{ name, payment, amount },
  report?:{ company?:string, scope?:'ME'|'ALL' }
}
*/
const stepState = {};
function resetSaleTimer(ctx, s){
  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  s.expiryTimer = setTimeout(async ()=>{
    await tryDelete(ctx, s.overviewMsgId);
    await tryDelete(ctx, s.promptMsgId);
    delete stepState[String(ctx.from.id)];
    await ctx.reply('⌛ This sale session expired due to inactivity (2 minutes). Start a new one with /sale.');
  }, SALE_IDLE_TIMEOUT_MS);
}
function touch(ctx,s){ if (s && s.mode==='sale') resetSaleTimer(ctx,s); }

// UI for sale (single Name/Table field)
function saleOverviewText(s){
  const f=s.fields;
  return [
    '🪷 <b>Creating individual flower sale</b>',
    'Please use the buttons below:',
    '',
    `• <b>Name / Table</b>: ${f.name?`<code>${f.name}</code>`:'—'}`,
    `• <b>Payment</b>: ${f.payment?`<code>${f.payment}</code>`:'—'}`,
    `• <b>Amount</b>: ${f.amount?`<code>SGD ${fmt(f.amount)}</code>`:'—'}`
  ].join('\n');
}
function canGenerateQR(s){
  const f=s.fields;
  return !!(f.name && f.payment==='QR Code' && (f.amount??0)>=MIN_AMOUNT);
}
function canFinalizeCash(s){
  const f=s.fields;
  return !!(f.name && f.payment==='Cash' && (f.amount??0)>=MIN_AMOUNT);
}
function saleOverviewKeyboard(s){
  const f=s.fields; const rows=[
    [{text:f.name?`Name/Table: ${f.name}`:'Name / Table', callback_data:'sale_edit_name'},
     {text:f.payment?`Payment: ${f.payment}`:'Payment Method', callback_data:'sale_edit_pay'}],
    [{text:f.amount?`Amount: SGD ${fmt(f.amount)}`:`Amount (min ${MIN_AMOUNT})`, callback_data:'sale_edit_amount'},
     ...(f.amount?[{text:'Clear', callback_data:'sale_amount_clear'}]:[])],
  ];
  if (canGenerateQR(s)) rows.push([{text:'✅ Generate QR', callback_data:'sale_generate_qr'}]);
  else if (canFinalizeCash(s)) rows.push([{text:'✅ Mark Cash Collected', callback_data:'sale_finalize_cash'}]);
  rows.push([{text:'❌ Cancel', callback_data:'sale_cancel'}]);
  return { inline_keyboard: rows };
}
async function saleShowOverview(ctx,s){
  const text=saleOverviewText(s), keyboard=saleOverviewKeyboard(s), chatId=ctx.chat.id;
  if (s.overviewMsgId){
    try{ await ctx.telegram.editMessageText(chatId, s.overviewMsgId, undefined, text, {parse_mode:'HTML', reply_markup:keyboard}); return; }catch{}
  }
  const msg=await ctx.reply(text,{parse_mode:'HTML', reply_markup:keyboard}); s.overviewMsgId=msg.message_id;
}

// ────────────────────────────────────────────────────────────────────────────
// Commands: /start /sale /history
// ────────────────────────────────────────────────────────────────────────────
bot.start(async (ctx)=>{
  const uid=String(ctx.from.id); const user=DB.users[uid];
  if (user?.nickname && user?.company) return ctx.reply(`👋 Welcome back, ${user.nickname} (${user.company})! Use /sale to start.`);
  if (!user?.nickname){
    const m=await ctx.reply('Hi! What would you like me to address you as?');
    stepState[uid]={mode:'nickname', awaiting:'nick', promptMsgId:m.message_id, overviewMsgId:null, expiryTimer:null, fields:{}};
    return;
  }
  const kb={inline_keyboard:[[ {text:'Lunar',callback_data:'company_Lunar'}, {text:'Wave',callback_data:'company_Wave'},
                               {text:'Ion',callback_data:'company_Ion'}, {text:'101',callback_data:'company_101'} ]]};
  const m=await ctx.reply(`Hello ${user.nickname}! Choose your company:`,{reply_markup:kb});
  stepState[uid]={mode:'company', awaiting:'company', promptMsgId:m.message_id, overviewMsgId:null, expiryTimer:null, fields:{}};
});

bot.command('sale', async (ctx)=>{
  const uid=String(ctx.from.id); const user=DB.users[uid];
  if (!user?.nickname){
    const m=await ctx.reply('Please tell me your name first. What should I call you?');
    stepState[uid]={mode:'nickname', awaiting:'nick', promptMsgId:m.message_id, overviewMsgId:null, expiryTimer:null, fields:{}};
    return;
  }
  if (!user?.company){
    const kb={inline_keyboard:[[ {text:'Lunar',callback_data:'company_Lunar'}, {text:'Wave',callback_data:'company_Wave'},
                                 {text:'Ion',callback_data:'company_Ion'}, {text:'101',callback_data:'company_101'} ]]};
    const m=await ctx.reply(`Hi ${user.nickname}! Choose your company:`,{reply_markup:kb});
    stepState[uid]={mode:'company', awaiting:'company', promptMsgId:m.message_id, overviewMsgId:null, expiryTimer:null, fields:{}};
    return;
  }
  stepState[uid]={mode:'sale', awaiting:null, promptMsgId:null, overviewMsgId:null, expiryTimer:null, fields:{name:null,payment:null,amount:null}};
  await ctx.reply('Creating individual flower sale. Please use the buttons below.');
  await saleShowOverview(ctx, stepState[uid]); resetSaleTimer(ctx, stepState[uid]);
});

bot.command('history', async (ctx)=>{
  const uid=String(ctx.from.id); const op=DB.users[uid]?.nickname;
  if (!op) return ctx.reply('❌ You need to set your name first with /start or /sale.');
  const kb={inline_keyboard:[[ {text:'QR Payment',callback_data:'hist_qr'}, {text:'Cash',callback_data:'hist_cash'}, {text:'All',callback_data:'hist_all'} ]]};
  await ctx.reply('📑 <b>History</b> — pick a filter (last 10 hours):',{parse_mode:'HTML', reply_markup:kb});
});

// ────────────────────────────────────────────────────────────────────────────
// /report (admin) — company → scope → (operator) | NET subtotal
// ────────────────────────────────────────────────────────────────────────────
function getSalesSince(ms){
  return DB.sales
    .filter(s=>{ const ts=new Date(s.timestamp).getTime(); return !isNaN(ts) && ts>=ms; })
    .sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)); // oldest → newest
}
function pad(str='',len=14){ str=String(str); return (str.length>=len)?str.slice(0,len):str+' '.repeat(len-str.length); }
function renderTableRows(rows){
  const subtotal = rows.reduce((sum,r)=> sum + (Number(r.value)||0), 0);
  let out='```\n'+
    pad('Timestamp',17)+pad('Sales',14)+pad('Value',10)+pad('Method',8)+pad('TxnID',8)+pad('Name/Table',16)+'\n'+
    pad('───────────',17)+pad('────────',14)+pad('──────',10)+pad('──────',8)+pad('─────',8)+pad('──────────',16)+'\n';
  for (const r of rows){
    out += pad(r.timestamp,17)+
           pad(r.salesPerson,14)+
           pad(`$${Number(r.value).toFixed(2)}`,10)+
           pad(r.method,8)+
           pad(r.txnId||'-',8)+
           pad(r.name||'-',16)+'\n';
  }
  out += pad('',17)+pad('TOTAL',14)+pad(`$${subtotal.toFixed(2)}`,10)+pad('',8)+pad('',8)+pad('',16)+'\n';
  out+='```'; return out;
}
function csvEscape(s=''){ s=String(s); return (/[",\n]/.test(s))?`"${s.replace(/"/g,'""')}"`:s; }
async function writeCsvFile(rows){
  const header=['Timestamp','Sales Person','Flower Value (NET)','Method','TxnID','Name/Table'];
  const lines=[header.join(',')];
  let subtotal=0;
  for (const r of rows){
    const val=Number(r.value)||0; subtotal+=val;
    lines.push([ r.timestamp, csvEscape(r.salesPerson), val.toFixed(2), r.method, r.txnId||'-', csvEscape(r.name||'') ].join(','));
  }
  lines.push('');
  lines.push(['','TOTAL', subtotal.toFixed(2),'','',''].join(','));
  const csv=lines.join('\n'); const fname=`report_${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;
  await fs.writeFile(fname,csv,'utf8'); return fname;
}
function buildReportRows({ sinceMs, company, operatorId }){
  const sales=getSalesSince(sinceMs).filter(s=> (s.company||'')===company);
  const filtered = operatorId? sales.filter(s=>String(s.operatorId||'')===String(operatorId)) : sales;
  return filtered.map(s=>{
    const ts=new Date(s.timestamp).toLocaleString('en-SG',{hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    return {
      timestamp: ts,
      salesPerson: s.operator || '-',
      value: (s.amountBase ?? s.amount ?? 0), // NET (no 3%)
      method: s.payment || '-',
      txnId: s.transactionId || '-',
      name: s.name || '-'
    };
  });
}
async function sendReportToAdmin(ctx, rows, label){
  if (!rows.length){ await ctx.reply(`📭 No sales in the last 10 hours${label?` (${label})`:''}.`); return; }
  const tableText=renderTableRows(rows);
  try{ await ctx.telegram.sendMessage(ADMIN_CHAT_ID, tableText, {parse_mode:'MarkdownV2'}); }
  catch{ await ctx.telegram.sendMessage(ADMIN_CHAT_ID, tableText.replace(/`/g,''), {parse_mode:'HTML'}); }
  const csvPath=await writeCsvFile(rows);
  await ctx.telegram.sendDocument(ADMIN_CHAT_ID, { source:csvPath, filename:csvPath });
  if (String(ctx.chat.id)!==String(ADMIN_CHAT_ID)) await ctx.reply(`📮 Report ${label?`(${label}) `:''}sent to the admin group.`);
}

bot.command('report', async (ctx)=>{
  const uid=String(ctx.from.id);
  if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 You are not authorized to use /report.');
  if (!ADMIN_CHAT_ID) return ctx.reply('⚠️ ADMIN_CHAT_ID is not set in .env');
  try { await ctx.telegram.getChat(ADMIN_CHAT_ID); } catch(e){ return ctx.reply(`⚠️ I can’t access ADMIN_CHAT_ID (${ADMIN_CHAT_ID}). Add me to that group.\n${e.message}`); }

  const rows = [
    [{ text:'Lunar', callback_data:'rep_company_Lunar' }, { text:'Wave', callback_data:'rep_company_Wave' }],
    [{ text:'Ion',   callback_data:'rep_company_Ion'   }, { text:'101',  callback_data:'rep_company_101'  }]
  ];
  const m = await ctx.reply('📑 <b>Report</b> — Step 1/3: Choose <b>Company</b>', { parse_mode:'HTML', reply_markup:{ inline_keyboard:rows } });
  stepState[uid]={ mode:'report', awaiting:'rep_company', promptMsgId:m.message_id, overviewMsgId:null, expiryTimer:null, fields:{}, report:{} };
});

bot.action(/^rep_company_(Lunar|Wave|Ion|101)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const company=ctx.match[1]; s.report.company=company;

  const kb={ inline_keyboard:[
    [{ text:'Individual', callback_data:'rep_scope_ME' }, { text:'All', callback_data:'rep_scope_ALL' }],
    [{ text:'❌ Cancel', callback_data:'rep_cancel' }]
  ]};
  const m=await ctx.reply(`📑 <b>Report</b> — Step 2/3: Scope for <b>${company}</b>`, { parse_mode:'HTML', reply_markup:kb });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_scope';
});

bot.action(/^rep_scope_(ME|ALL)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const scope=ctx.match[1]; s.report.scope=scope;

  if (scope==='ALL'){
    const rows = buildReportRows({ sinceMs: tenHoursAgoMs(), company: s.report.company, operatorId: null });
    await sendReportToAdmin(ctx, rows, `${s.report.company} • All Operators`);
    await tryDelete(ctx, s.promptMsgId); delete stepState[uid]; return;
  }

  // Individual → pick operator in that company
  const ops = Object.entries(DB.users)
    .filter(([id,u]) => (u?.company || '') === s.report.company)
    .map(([id,u]) => ({ id, nickname: u.nickname || id }));
  if (!ops.length){
    await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
    return ctx.reply(`📭 No operators found for ${s.report.company}.`);
  }
  const rows=[];
  for (let i=0;i<ops.length;i+=2){ rows.push(ops.slice(i,i+2).map(o=>({ text:o.nickname, callback_data:`rep_op_${o.id}` }))); }
  rows.push([{ text:'⬅️ Back', callback_data:'rep_scope_back' }, { text:'❌ Cancel', callback_data:'rep_cancel' }]);

  const m=await ctx.reply(`📑 <b>Report</b> — Step 3/3: Pick <b>Operator</b> in ${s.report.company}`, { parse_mode:'HTML', reply_markup:{inline_keyboard:rows} });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_operator';
});

bot.action('rep_scope_back', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const kb={ inline_keyboard:[
    [{ text:'Individual', callback_data:'rep_scope_ME' }, { text:'All', callback_data:'rep_scope_ALL' }],
    [{ text:'❌ Cancel', callback_data:'rep_cancel' }]
  ]};
  const m=await ctx.reply(`📑 <b>Report</b> — Step 2/3: Scope for <b>${s.report.company}</b>`, { parse_mode:'HTML', reply_markup:kb });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_scope';
});

bot.action(/^rep_op_(\d+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;

  const targetId = ctx.match[1];
  const rows = buildReportRows({ sinceMs: tenHoursAgoMs(), company: s.report.company, operatorId: targetId });
  const opName = DB.users[targetId]?.nickname || targetId;

  await sendReportToAdmin(ctx, rows, `${s.report.company} • ${opName}`);
  await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
});

bot.action('rep_cancel', async (ctx)=>{
  await ctx.answerCbQuery('Cancelled');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='report') return;
  await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
  await ctx.reply('❌ Report cancelled.');
});

// ────────────────────────────────────────────────────────────────────────────
// Inline actions for /sale (Name/Payment/Amount)
// ────────────────────────────────────────────────────────────────────────────
bot.action('sale_edit_name', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const m=await ctx.reply('👤 <b>Name / Table</b> — Enter a single line (either a name or a table number):',{parse_mode:'HTML'});
  s.promptMsgId=m.message_id; s.awaiting='name'; touch(ctx,s);
});
bot.action('sale_edit_pay', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const kb={inline_keyboard:[[ {text:'QR Code',callback_data:'sale_pay_qr'},{text:'Cash',callback_data:'sale_pay_cash'} ],[ {text:'⬅️ Back',callback_data:'sale_back'} ]]};
  const m=await ctx.reply('💳 <b>Payment Method</b> — choose one:',{parse_mode:'HTML', reply_markup:kb});
  s.promptMsgId=m.message_id; touch(ctx,s);
});
bot.action('sale_pay_qr', async (ctx)=>{
  await ctx.answerCbQuery('QR Code selected');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.payment='QR Code'; await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('sale_pay_cash', async (ctx)=>{
  await ctx.answerCbQuery('Cash selected');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.payment='Cash'; await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null;
  const warn=await ctx.reply('⚠️ <b>Cash must be collected immediately.</b>',{parse_mode:'HTML'}); setTimeout(()=>tryDelete(ctx,warn.message_id),10_000);
  await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('sale_edit_amount', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const kb={inline_keyboard:[
    [{text:'100',callback_data:'amt_100'},{text:'200',callback_data:'amt_200'},{text:'300',callback_data:'amt_300'}],
    [{text:'500',callback_data:'amt_500'},{text:'1000',callback_data:'amt_1000'},{text:'2000',callback_data:'amt_2000'}],
    [{text:'Custom',callback_data:'amt_custom'},{text:'⬅️ Back',callback_data:'sale_back'}]
  ]};
  const m=await ctx.reply('💵 <b>Amount</b> — choose or pick custom (min 100):',{parse_mode:'HTML', reply_markup:kb});
  s.promptMsgId=m.message_id; s.awaiting=null; touch(ctx,s);
});
bot.action(/^amt_(\d+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.amount=Math.max(Number(ctx.match[1]), MIN_AMOUNT);
  await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('amt_custom', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const m=await ctx.reply('💵 <b>Custom Amount</b> — Enter amount (min 100):',{parse_mode:'HTML'});
  s.promptMsgId=m.message_id; s.awaiting='amount'; touch(ctx,s);
});
bot.action('sale_amount_clear', async (ctx)=>{
  await ctx.answerCbQuery('Amount cleared');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.amount=null; await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('sale_back', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s);
});

// Generate QR (+3% on base)
bot.action('sale_generate_qr', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const operator=DB.users[uid]?.nickname || 'Unknown';
  const companyName=DB.users[uid]?.company || '';
  const companyTag=companyName?` (${companyName})`:'';

  const f=s.fields;
  if (!(f.name && f.payment==='QR Code')) return ctx.reply('❌ Missing details. Ensure Name/Table and Payment=QR Code are provided.');
  const baseAmt=(f.amount && f.amount>=MIN_AMOUNT)?f.amount:MIN_AMOUNT;
  const payAmt=Number((baseAmt*1.03).toFixed(2));

  const txnId=nextTxnId(companyName);
  const ref=buildReference(txnId, operator, f.name);
  await saveDB();

  try{
    const buffer=await generatePayNowQR({ amount:payAmt, reference:ref });
    const caption=
      `💳 <b>PayNow</b>\n`+
      `Transaction ID: <b>${txnId}</b>\n`+
      `Operator: <b>${operator}${companyTag}</b>\n`+
      `Name/Table: <b>${f.name}</b>\n`+
      `Base: <b>SGD ${fmt(baseAmt)}</b>  (+3% fee)\n`+
      `Charged: <b>SGD ${fmt(payAmt)}</b>\n`+
      `Ref (QR): <code>${ref}</code>\n\n`+
      `⚠️ This QR will auto-expire in 2 minutes.`;
    const msg=await ctx.replyWithPhoto({source:buffer},{caption,parse_mode:'HTML'});
    setTimeout(()=>tryDelete(ctx,msg.message_id),QR_LIFETIME_MS);

    DB.sales.push({ operatorId:uid, operator, company:companyName||null, type:'single',
      name:f.name, payment:'QR Code', amountBase:baseAmt, amount:payAmt,
      transactionId:txnId, reference:ref, timestamp:new Date().toISOString()
    });
    await saveDB();

    if (s.expiryTimer) clearTimeout(s.expiryTimer);
    await tryDelete(ctx,s.overviewMsgId); await tryDelete(ctx,s.promptMsgId); delete stepState[uid];
  }catch(e){ console.error(e); await ctx.reply('❌ Failed to generate QR.'); }
});

// Cash (no +3% by default)
bot.action('sale_finalize_cash', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const operator=DB.users[uid]?.nickname || 'Unknown';
  const companyName=DB.users[uid]?.company || '';
  const f=s.fields;
  if (!(f.name && f.payment==='Cash')) return ctx.reply('❌ Missing details. Ensure Name/Table and Payment=Cash are provided.');
  const baseAmt=(f.amount && f.amount>=MIN_AMOUNT)?f.amount:MIN_AMOUNT;

  const txnId=nextTxnId(companyName);
  await saveDB();
  DB.sales.push({ operatorId:uid, operator, company:companyName||null, type:'single',
    name:f.name, payment:'Cash', amountBase:baseAmt, amount:baseAmt,
    transactionId:txnId, reference:null, timestamp:new Date().toISOString()
  });
  await saveDB();

  await ctx.reply(
    `✅ <b>Cash recorded</b>\n`+
    `Transaction ID: <b>${txnId}</b>\n`+
    `Operator: <b>${operator}${companyName?` (${companyName})`:''}</b>\n`+
    `Name/Table: <b>${f.name}</b>\n`+
    `Collected: <b>SGD ${fmt(baseAmt)}</b>`,
    {parse_mode:'HTML'}
  );

  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  await tryDelete(ctx,s.overviewMsgId); await tryDelete(ctx,s.promptMsgId); delete stepState[uid];
});

// Cancel sale
bot.action('sale_cancel', async (ctx)=>{
  await ctx.answerCbQuery('Cancelled');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s) return;
  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  await tryDelete(ctx,s.overviewMsgId); await tryDelete(ctx,s.promptMsgId); delete stepState[uid];
  await ctx.reply('❌ Sale cancelled.');
});

// Company selection (first-run)
bot.action(/^company_(Lunar|Wave|Ion|101)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const company=ctx.match[1];
  const user=DB.users[uid]||{}; user.company=company; DB.users[uid]=user; await saveDB();
  const s=stepState[uid]; if (s?.promptMsgId) await tryDelete(ctx,s.promptMsgId); delete stepState[uid];
  await ctx.reply(`✅ Company set to ${company}. Use /sale to start.`);
});

// history filters
bot.action('hist_qr', async (ctx)=>{ await ctx.answerCbQuery(); const uid=String(ctx.from.id); const op=DB.users[uid]?.nickname||'Unknown'; await replyBig(ctx, renderHistoryChunk(filterMySales(uid,'QR Code'), op)); });
bot.action('hist_cash', async (ctx)=>{ await ctx.answerCbQuery(); const uid=String(ctx.from.id); const op=DB.users[uid]?.nickname||'Unknown'; await replyBig(ctx, renderHistoryChunk(filterMySales(uid,'Cash'), op)); });
bot.action('hist_all', async (ctx)=>{ await ctx.answerCbQuery(); const uid=String(ctx.from.id); const op=DB.users[uid]?.nickname||'Unknown'; await replyBig(ctx, renderHistoryChunk(filterMySales(uid,'ALL'), op)); });

// Text capture (first-run name; /sale name + amount)
bot.on('text', async (ctx,next)=>{
  const uid=String(ctx.from.id); const msg=ctx.message.text?.trim()||''; if (msg.startsWith('/')) return next();
  const s=stepState[uid]; if (!s) return next();

  if (s.mode==='nickname' && s.awaiting==='nick'){
    const user=DB.users[uid]||{}; user.nickname=msg; DB.users[uid]=user; await saveDB();
    await tryDelete(ctx,ctx.message.message_id); await tryDelete(ctx,s.promptMsgId);
    const kb={inline_keyboard:[[ {text:'Lunar',callback_data:'company_Lunar'},{text:'Wave',callback_data:'company_Wave'},
                                 {text:'Ion',callback_data:'company_Ion'},{text:'101',callback_data:'company_101'} ]]};
    const m=await ctx.reply(`Nice to meet you, ${user.nickname}! Choose your company:`,{reply_markup:kb});
    s.mode='company'; s.awaiting='company'; s.promptMsgId=m.message_id; return;
  }

  if (s.mode==='sale' && s.awaiting){
    if (s.awaiting==='name'){
      s.fields.name=msg;
      await tryDelete(ctx,ctx.message.message_id); await tryDelete(ctx,s.promptMsgId);
      s.awaiting=null; s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s); return;
    } else if (s.awaiting==='amount'){
      let val=Number(msg);
      if (!Number.isFinite(val) || val<MIN_AMOUNT){ val=MIN_AMOUNT; await ctx.reply(`ℹ️ Amount set to minimum: ${MIN_AMOUNT}`); }
      s.fields.amount=val;
      await tryDelete(ctx,ctx.message.message_id); await tryDelete(ctx,s.promptMsgId);
      s.awaiting=null; s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s); return;
    }
  }

  return next();
});

// ────────────────────────────────────────────────────────────────────────────
// /report flow (company → scope → operator) with NET subtotal
// ────────────────────────────────────────────────────────────────────────────
bot.command('report', async (ctx)=>{
  const uid=String(ctx.from.id);
  if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 You are not authorized to use /report.');
  if (!ADMIN_CHAT_ID) return ctx.reply('⚠️ ADMIN_CHAT_ID is not set in .env');
  try { await ctx.telegram.getChat(ADMIN_CHAT_ID); } catch(e){ return ctx.reply(`⚠️ I can’t access ADMIN_CHAT_ID (${ADMIN_CHAT_ID}). Add me to that group.\n${e.message}`); }

  const rows = [
    [{ text:'Lunar', callback_data:'rep_company_Lunar' }, { text:'Wave', callback_data:'rep_company_Wave' }],
    [{ text:'Ion',   callback_data:'rep_company_Ion'   }, { text:'101',  callback_data:'rep_company_101'  }]
  ];
  const m = await ctx.reply('📑 <b>Report</b> — Step 1/3: Choose <b>Company</b>', { parse_mode:'HTML', reply_markup:{ inline_keyboard:rows } });
  stepState[uid]={ mode:'report', awaiting:'rep_company', promptMsgId:m.message_id, overviewMsgId:null, expiryTimer:null, fields:{}, report:{} };
});
bot.action(/^rep_company_(Lunar|Wave|Ion|101)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const company=ctx.match[1]; s.report.company=company;

  const kb={ inline_keyboard:[
    [{ text:'Individual', callback_data:'rep_scope_ME' }, { text:'All', callback_data:'rep_scope_ALL' }],
    [{ text:'❌ Cancel', callback_data:'rep_cancel' }]
  ]};
  const m=await ctx.reply(`📑 <b>Report</b> — Step 2/3: Scope for <b>${company}</b>`, { parse_mode:'HTML', reply_markup:kb });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_scope';
});

bot.action(/^rep_scope_(ME|ALL)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const scope=ctx.match[1]; s.report.scope=scope;

  if (scope==='ALL'){
    const rows = buildReportRows({ sinceMs: tenHoursAgoMs(), company: s.report.company, operatorId: null });
    await sendReportToAdmin(ctx, rows, `${s.report.company} • All Operators`);
    await tryDelete(ctx, s.promptMsgId); delete stepState[uid]; return;
  }

  // Individual → pick operator in that company
  const ops = Object.entries(DB.users)
    .filter(([id,u]) => (u?.company || '') === s.report.company)
    .map(([id,u]) => ({ id, nickname: u.nickname || id }));
  if (!ops.length){
    await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
    return ctx.reply(`📭 No operators found for ${s.report.company}.`);
  }
  const rows=[];
  for (let i=0;i<ops.length;i+=2){ rows.push(ops.slice(i,i+2).map(o=>({ text:o.nickname, callback_data:`rep_op_${o.id}` }))); }
  rows.push([{ text:'⬅️ Back', callback_data:'rep_scope_back' }, { text:'❌ Cancel', callback_data:'rep_cancel' }]);

  const m=await ctx.reply(`📑 <b>Report</b> — Step 3/3: Pick <b>Operator</b> in ${s.report.company}`, { parse_mode:'HTML', reply_markup:{inline_keyboard:rows} });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_operator';
});

bot.action('rep_scope_back', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const kb={ inline_keyboard:[
    [{ text:'Individual', callback_data:'rep_scope_ME' }, { text:'All', callback_data:'rep_scope_ALL' }],
    [{ text:'❌ Cancel', callback_data:'rep_cancel' }]
  ]};
  const m=await ctx.reply(`📑 <b>Report</b> — Step 2/3: Scope for <b>${s.report.company}</b>`, { parse_mode:'HTML', reply_markup:kb });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_scope';
});

bot.action(/^rep_op_(\d+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;

  const targetId = ctx.match[1];
  const rows = buildReportRows({ sinceMs: tenHoursAgoMs(), company: s.report.company, operatorId: targetId });
  const opName = DB.users[targetId]?.nickname || targetId;

  await sendReportToAdmin(ctx, rows, `${s.report.company} • ${opName}`);
  await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
});

bot.action('rep_cancel', async (ctx)=>{
  await ctx.answerCbQuery('Cancelled');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='report') return;
  await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
  await ctx.reply('❌ Report cancelled.');
});

// ────────────────────────────────────────────────────────────────────────────
// Inline actions for /sale (Name/Payment/Amount)
// ────────────────────────────────────────────────────────────────────────────
bot.action('sale_edit_name', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const m=await ctx.reply('👤 <b>Name / Table</b> — Enter a single line (either a name or a table number):',{parse_mode:'HTML'});
  s.promptMsgId=m.message_id; s.awaiting='name'; touch(ctx,s);
});
bot.action('sale_edit_pay', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const kb={inline_keyboard:[[ {text:'QR Code',callback_data:'sale_pay_qr'},{text:'Cash',callback_data:'sale_pay_cash'} ],[ {text:'⬅️ Back',callback_data:'sale_back'} ]]};
  const m=await ctx.reply('💳 <b>Payment Method</b> — choose one:',{parse_mode:'HTML', reply_markup:kb});
  s.promptMsgId=m.message_id; touch(ctx,s);
});
bot.action('sale_pay_qr', async (ctx)=>{
  await ctx.answerCbQuery('QR Code selected');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.payment='QR Code'; await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('sale_pay_cash', async (ctx)=>{
  await ctx.answerCbQuery('Cash selected');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.payment='Cash'; await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null;
  const warn=await ctx.reply('⚠️ <b>Cash must be collected immediately.</b>',{parse_mode:'HTML'}); setTimeout(()=>tryDelete(ctx,warn.message_id),10_000);
  await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('sale_edit_amount', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const kb={inline_keyboard:[
    [{text:'100',callback_data:'amt_100'},{text:'200',callback_data:'amt_200'},{text:'300',callback_data:'amt_300'}],
    [{text:'500',callback_data:'amt_500'},{text:'1000',callback_data:'amt_1000'},{text:'2000',callback_data:'amt_2000'}],
    [{text:'Custom',callback_data:'amt_custom'},{text:'⬅️ Back',callback_data:'sale_back'}]
  ]};
  const m=await ctx.reply('💵 <b>Amount</b> — choose or pick custom (min 100):',{parse_mode:'HTML', reply_markup:kb});
  s.promptMsgId=m.message_id; s.awaiting=null; touch(ctx,s);
});
bot.action(/^amt_(\d+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.amount=Math.max(Number(ctx.match[1]), MIN_AMOUNT);
  await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('amt_custom', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const m=await ctx.reply('💵 <b>Custom Amount</b> — Enter amount (min 100):',{parse_mode:'HTML'});
  s.promptMsgId=m.message_id; s.awaiting='amount'; touch(ctx,s);
});
bot.action('sale_amount_clear', async (ctx)=>{
  await ctx.answerCbQuery('Amount cleared');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  s.fields.amount=null; await saleShowOverview(ctx,s); touch(ctx,s);
});
bot.action('sale_back', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  await tryDelete(ctx,s.promptMsgId); s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s);
});

// ────────────────────────────────────────────────────────────────────────────
// Generate QR (+3%) and Cash (NET only) handlers
// ────────────────────────────────────────────────────────────────────────────
bot.action('sale_generate_qr', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const operator=DB.users[uid]?.nickname || 'Unknown';
  const companyName=DB.users[uid]?.company || ''; const companyTag=companyName?` (${companyName})`:'';

  const f=s.fields;
  if (!(f.name && f.payment==='QR Code')) return ctx.reply('❌ Missing details. Ensure Name/Table and Payment=QR Code are provided.');
  const baseAmt=(f.amount && f.amount>=MIN_AMOUNT)?f.amount:MIN_AMOUNT;
  const payAmt=Number((baseAmt*1.03).toFixed(2));

  const txnId=nextTxnId(companyName);
  const ref=buildReference(txnId, operator, f.name);
  await saveDB();

  try{
    const buffer=await generatePayNowQR({ amount:payAmt, reference:ref });
    const caption=
      `💳 <b>PayNow</b>\n`+
      `Transaction ID: <b>${txnId}</b>\n`+
      `Operator: <b>${operator}${companyTag}</b>\n`+
      `Name/Table: <b>${f.name}</b>\n`+
      `Base: <b>SGD ${fmt(baseAmt)}</b>  (+3% fee)\n`+
      `Charged: <b>SGD ${fmt(payAmt)}</b>\n`+
      `Ref (QR): <code>${ref}</code>\n\n`+
      `⚠️ This QR will auto-expire in 2 minutes.`;
    const msg=await ctx.replyWithPhoto({source:buffer},{caption,parse_mode:'HTML'});
    setTimeout(()=>tryDelete(ctx,msg.message_id),QR_LIFETIME_MS);

    DB.sales.push({ operatorId:uid, operator, company:companyName||null, type:'single',
      name:f.name, payment:'QR Code', amountBase:baseAmt, amount:payAmt,
      transactionId:txnId, reference:ref, timestamp:new Date().toISOString()
    });
    await saveDB();

    if (s.expiryTimer) clearTimeout(s.expiryTimer);
    await tryDelete(ctx,s.overviewMsgId); await tryDelete(ctx,s.promptMsgId); delete stepState[uid];
  }catch(e){ console.error(e); await ctx.reply('❌ Failed to generate QR.'); }
});

bot.action('sale_finalize_cash', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='sale') return;
  const operator=DB.users[uid]?.nickname || 'Unknown';
  const companyName=DB.users[uid]?.company || '';
  const f=s.fields;
  if (!(f.name && f.payment==='Cash')) return ctx.reply('❌ Missing details. Ensure Name/Table and Payment=Cash are provided.');
  const baseAmt=(f.amount && f.amount>=MIN_AMOUNT)?f.amount:MIN_AMOUNT;

  const txnId=nextTxnId(companyName);
  await saveDB();
  DB.sales.push({ operatorId:uid, operator, company:companyName||null, type:'single',
    name:f.name, payment:'Cash', amountBase:baseAmt, amount:baseAmt,
    transactionId:txnId, reference:null, timestamp:new Date().toISOString()
  });
  await saveDB();

  await ctx.reply(
    `✅ <b>Cash recorded</b>\n`+
    `Transaction ID: <b>${txnId}</b>\n`+
    `Operator: <b>${operator}${companyName?` (${companyName})`:''}</b>\n`+
    `Name/Table: <b>${f.name}</b>\n`+
    `Collected: <b>SGD ${fmt(baseAmt)}</b>`,
    {parse_mode:'HTML'}
  );

  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  await tryDelete(ctx,s.overviewMsgId); await tryDelete(ctx,s.promptMsgId); delete stepState[uid];
});

// ────────────────────────────────────────────────────────────────────────────
// Company selection (first-run)
// ────────────────────────────────────────────────────────────────────────────
bot.action(/^company_(Lunar|Wave|Ion|101)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const company=ctx.match[1];
  const user=DB.users[uid]||{}; user.company=company; DB.users[uid]=user; await saveDB();
  const s=stepState[uid]; if (s?.promptMsgId) await tryDelete(ctx,s.promptMsgId); delete stepState[uid];
  await ctx.reply(`✅ Company set to ${company}. Use /sale to start.`);
});

// ────────────────────────────────────────────────────────────────────────────
// history filters
// ────────────────────────────────────────────────────────────────────────────
bot.action('hist_qr', async (ctx)=>{ await ctx.answerCbQuery(); const uid=String(ctx.from.id); const op=DB.users[uid]?.nickname||'Unknown'; await replyBig(ctx, renderHistoryChunk(filterMySales(uid,'QR Code'), op)); });
bot.action('hist_cash', async (ctx)=>{ await ctx.answerCbQuery(); const uid=String(ctx.from.id); const op=DB.users[uid]?.nickname||'Unknown'; await replyBig(ctx, renderHistoryChunk(filterMySales(uid,'Cash'), op)); });
bot.action('hist_all', async (ctx)=>{ await ctx.answerCbQuery(); const uid=String(ctx.from.id); const op=DB.users[uid]?.nickname||'Unknown'; await replyBig(ctx, renderHistoryChunk(filterMySales(uid,'ALL'), op)); });

// ────────────────────────────────────────────────────────────────────────────
// Text capture (first-run name; /sale name + amount)
// ────────────────────────────────────────────────────────────────────────────
bot.on('text', async (ctx,next)=>{
  const uid=String(ctx.from.id); const msg=ctx.message.text?.trim()||''; if (msg.startsWith('/')) return next();
  const s=stepState[uid]; if (!s) return next();

  if (s.mode==='nickname' && s.awaiting==='nick'){
    const user=DB.users[uid]||{}; user.nickname=msg; DB.users[uid]=user; await saveDB();
    await tryDelete(ctx,ctx.message.message_id); await tryDelete(ctx,s.promptMsgId);
    const kb={inline_keyboard:[[ {text:'Lunar',callback_data:'company_Lunar'},{text:'Wave',callback_data:'company_Wave'},
                                 {text:'Ion',callback_data:'company_Ion'},{text:'101',callback_data:'company_101'} ]]};
    const m=await ctx.reply(`Nice to meet you, ${user.nickname}! Choose your company:`,{reply_markup:kb});
    s.mode='company'; s.awaiting='company'; s.promptMsgId=m.message_id; return;
  }

  if (s.mode==='sale' && s.awaiting){
    if (s.awaiting==='name'){
      s.fields.name=msg;
      await tryDelete(ctx,ctx.message.message_id); await tryDelete(ctx,s.promptMsgId);
      s.awaiting=null; s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s); return;
    } else if (s.awaiting==='amount'){
      let val=Number(msg);
      if (!Number.isFinite(val) || val<MIN_AMOUNT){ val=MIN_AMOUNT; await ctx.reply(`ℹ️ Amount set to minimum: ${MIN_AMOUNT}`); }
      s.fields.amount=val;
      await tryDelete(ctx,ctx.message.message_id); await tryDelete(ctx,s.promptMsgId);
      s.awaiting=null; s.promptMsgId=null; await saleShowOverview(ctx,s); touch(ctx,s); return;
    }
  }

  return next();
});

// ────────────────────────────────────────────────────────────────────────────
// /report flow (company → scope → operator) — NET reporting
// ────────────────────────────────────────────────────────────────────────────
bot.command('report', async (ctx)=>{
  const uid=String(ctx.from.id);
  if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 You are not authorized to use /report.');
  if (!ADMIN_CHAT_ID) return ctx.reply('⚠️ ADMIN_CHAT_ID is not set in .env');
  try { await ctx.telegram.getChat(ADMIN_CHAT_ID); } catch(e){ return ctx.reply(`⚠️ I can’t access ADMIN_CHAT_ID (${ADMIN_CHAT_ID}). Add me to that group.\n${e.message}`); }

  const rows = [
    [{ text:'Lunar', callback_data:'rep_company_Lunar' }, { text:'Wave', callback_data:'rep_company_Wave' }],
    [{ text:'Ion',   callback_data:'rep_company_Ion'   }, { text:'101',  callback_data:'rep_company_101'  }]
  ];
  const m = await ctx.reply('📑 <b>Report</b> — Step 1/3: Choose <b>Company</b>', { parse_mode:'HTML', reply_markup:{ inline_keyboard:rows } });
  stepState[uid]={ mode:'report', awaiting:'rep_company', promptMsgId:m.message_id, overviewMsgId:null, expiryTimer:null, fields:{}, report:{} };
});

bot.action(/^rep_company_(Lunar|Wave|Ion|101)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const company=ctx.match[1]; s.report.company=company;

  const kb={ inline_keyboard:[
    [{ text:'Individual', callback_data:'rep_scope_ME' }, { text:'All', callback_data:'rep_scope_ALL' }],
    [{ text:'❌ Cancel', callback_data:'rep_cancel' }]
  ]};
  const m=await ctx.reply(`📑 <b>Report</b> — Step 2/3: Scope for <b>${company}</b>`, { parse_mode:'HTML', reply_markup:kb });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_scope';
});
bot.action(/^rep_scope_(ME|ALL)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const scope=ctx.match[1]; s.report.scope=scope;

  if (scope==='ALL'){
    const rows = buildReportRows({ sinceMs: tenHoursAgoMs(), company: s.report.company, operatorId: null });
    await sendReportToAdmin(ctx, rows, `${s.report.company} • All Operators`);
    await tryDelete(ctx, s.promptMsgId); delete stepState[uid]; return;
  }

  // Individual → pick operator in that company
  const ops = Object.entries(DB.users)
    .filter(([id,u]) => (u?.company || '') === s.report.company)
    .map(([id,u]) => ({ id, nickname: u.nickname || id }));
  if (!ops.length){
    await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
    return ctx.reply(`📭 No operators found for ${s.report.company}.`);
  }
  const rows=[];
  for (let i=0;i<ops.length;i+=2){ rows.push(ops.slice(i,i+2).map(o=>({ text:o.nickname, callback_data:`rep_op_${o.id}` }))); }
  rows.push([{ text:'⬅️ Back', callback_data:'rep_scope_back' }, { text:'❌ Cancel', callback_data:'rep_cancel' }]);

  const m=await ctx.reply(`📑 <b>Report</b> — Step 3/3: Pick <b>Operator</b> in ${s.report.company}`, { parse_mode:'HTML', reply_markup:{inline_keyboard:rows} });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_operator';
});
bot.action('rep_scope_back', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s || s.mode!=='report') return;
  const kb={ inline_keyboard:[
    [{ text:'Individual', callback_data:'rep_scope_ME' }, { text:'All', callback_data:'rep_scope_ALL' }],
    [{ text:'❌ Cancel', callback_data:'rep_cancel' }]
  ]};
  const m=await ctx.reply(`📑 <b>Report</b> — Step 2/3: Scope for <b>${s.report.company}</b>`, { parse_mode:'HTML', reply_markup:kb });
  await tryDelete(ctx, s.promptMsgId); s.promptMsgId=m.message_id; s.awaiting='rep_scope';
});
bot.action(/^rep_op_(\d+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const uid=String(ctx.from.id); if (!ADMIN_IDS.includes(uid)) return ctx.reply('🚫 Not authorized.');
  const s=stepState[uid]; if (!s || s.mode!=='report') return;

  const targetId = ctx.match[1];
  const rows = buildReportRows({ sinceMs: tenHoursAgoMs(), company: s.report.company, operatorId: targetId });
  const opName = DB.users[targetId]?.nickname || targetId;

  await sendReportToAdmin(ctx, rows, `${s.report.company} • ${opName}`);
  await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
});
bot.action('rep_cancel', async (ctx)=>{
  await ctx.answerCbQuery('Cancelled');
  const uid=String(ctx.from.id); const s=stepState[uid]; if (!s||s.mode!=='report') return;
  await tryDelete(ctx, s.promptMsgId); delete stepState[uid];
  await ctx.reply('❌ Report cancelled.');
});

const app = express();
app.use(express.json());

// Health check
app.get('/', (req,res)=>res.send('OK'));

// Webhook endpoint
app.post('/bot', (req,res,next)=>{
  bot.handleUpdate(req.body, res).catch(next);
  res.sendStatus(200);
});

// Start Express
app.listen(PORT, ()=>console.log(`Server listening on port ${PORT}`));

// ────────────────────────────────────────────────────────────────────────────
// Launch
// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// Set webhook (Cloud Run will call /bot)
// ────────────────────────────────────────────────────────────────────────────
const WEBHOOK_URL = process.env.CLOUD_RUN_URL; // e.g., https://your-service-xyz.a.run.app

if (WEBHOOK_URL) {
  bot.telegram.setWebhook(`${WEBHOOK_URL}/bot`)
    .then(() => console.log(`✅ Webhook set to ${WEBHOOK_URL}/bot`))
    .catch(err => console.error('❌ Failed to set webhook:', err));
}
