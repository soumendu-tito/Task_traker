'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.RELAY_ADMIN_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'relay.json');
const DB_BACKUP_FILE = `${DB_FILE}.bak`;
let db;

function blankDb() { return { botToken: '', botName: '', webhookSecret: '', members: [], pairs: [], offset: 0, processedUpdates: [] }; }
function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
  fs.renameSync(tmp, DB_FILE);
}
function parseDb(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Relay database has an invalid format.');
  return { ...blankDb(), ...parsed };
}
function loadDb() {
  try {
    db = parseDb(DB_FILE);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (fs.existsSync(DB_BACKUP_FILE)) {
        try {
          db = parseDb(DB_BACKUP_FILE);
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.copyFileSync(DB_BACKUP_FILE, DB_FILE);
          console.warn('Recovered relay database from its backup file.');
        } catch (backupError) {
          throw new Error(`Relay database and backup could not be read. Preserve ${DB_FILE} and ${DB_BACKUP_FILE} for recovery. ${backupError.message}`);
        }
      } else {
        db = blankDb();
        saveDb();
      }
    } else {
      try {
        db = parseDb(DB_BACKUP_FILE);
        fs.copyFileSync(DB_BACKUP_FILE, DB_FILE);
        console.warn(`Recovered unreadable relay database from backup: ${error.message}`);
      } catch (backupError) {
        throw new Error(`Refusing to start with an empty relay database. Database error: ${error.message}. Backup error: ${backupError.message}`);
      }
    }
  }
  db.members = Array.isArray(db.members) ? db.members : [];
  db.pairs = Array.isArray(db.pairs) ? db.pairs : [];
  db.processedUpdates = Array.isArray(db.processedUpdates) ? db.processedUpdates : [];
}
function normalizeUsername(value) { return String(value || '').trim().replace(/^@/, '').toLowerCase(); }
function tokenHash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function secureEqual(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function json(res, status, body) { const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-relay-admin', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' }); res.end(data); }
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Request body is too large.'); } return raw ? JSON.parse(raw) : {}; }
function admin(req) { return !!ADMIN_TOKEN && secureEqual(req.headers['x-relay-admin'] || '', ADMIN_TOKEN); }
function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function agentFor(req) { const hash = tokenHash(bearer(req)); return db.members.find(member => member.deviceTokenHash && secureEqual(member.deviceTokenHash, hash)); }
async function telegramFetch(url, options = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error.name === 'AbortError') throw new Error('Telegram did not respond within 10 seconds. Check Telegram API availability and try again.');
    throw new Error(`Could not reach Telegram: ${error.message}`);
  } finally { clearTimeout(timeout); }
}
async function tg(method, params = {}) {
  if (!db.botToken) throw new Error('Telegram bot is not configured on the relay.');
  const response = await telegramFetch(`https://api.telegram.org/bot${db.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const result = await response.json(); if (!result.ok) throw new Error(result.description || 'Telegram API request failed.'); return result.result;
}
function publicMember(member) {
  const { telegramId, chatId, inviteCode, deviceTokenHash, commands, ...safe } = member;
  const deviceOnline = !!member.lastHeartbeat && Date.now() - member.lastHeartbeat < 25_000;
  return { ...safe, status: deviceOnline ? member.status : 'offline', invitePending: !!inviteCode, deviceOnline, paired: !!deviceTokenHash };
}
function memberByTelegram(from) { return db.members.find(member => member.telegramId && String(member.telegramId) === String(from?.id)); }
async function handleTelegramMessage(msg) {
  if (!msg?.text || !msg.chat?.id) return;
  const text = msg.text.trim(); const parts = text.split(/\s+/); const chatId = String(msg.chat.id);
  const command = parts[0].toLowerCase().replace(/@[^@]+$/, '');
  const arg = parts[1] || '';

  if (command === '/start' && arg.startsWith('dm_')) {
    const member = db.members.find(item => item.inviteCode === arg);
    if (!member) { await tg('sendMessage', { chat_id: chatId, text: 'This workspace invite is no longer valid. Ask the workspace owner for a new one.' }); return; }
    if (normalizeUsername(msg.from?.username) !== normalizeUsername(member.telegramUsername)) {
      await tg('sendMessage', { chat_id: chatId, text: `This invite is for @${member.telegramUsername}. Switch to that Telegram account or ask for a new invite.` }); return;
    }
    member.telegramId = String(msg.from.id); member.chatId = chatId; member.inviteCode = ''; member.status = 'offline'; member.lastSeen = Date.now(); saveDb();
    await tg('sendMessage', { chat_id: chatId, text: `Welcome, ${member.name}! Install and open Task Tracker, then pair this computer from the Telegram connection screen. Use /on, /off, /online, /offline, /task Your task, or /status.` }); return;
  }

  if (command === '/start' && arg.startsWith('dv_')) {
    const pair = db.pairs.find(item => item.code === arg && item.expiresAt > Date.now());
    const member = pair && db.members.find(item => item.id === pair.memberId);
    const telegramId = String(msg.from?.id || ''); const usernameMatches = normalizeUsername(msg.from?.username) === normalizeUsername(member?.telegramUsername);
    if (!pair || !member || (member.telegramId ? String(member.telegramId) !== telegramId : !usernameMatches)) { await tg('sendMessage', { chat_id: chatId, text: 'That computer link is expired, belongs to another Telegram account, or your username has not been added to this workspace. Ask the workspace owner to confirm your username and generate a fresh link.' }); return; }
    if (!member.telegramId) { member.telegramId = telegramId; member.chatId = chatId; member.inviteCode = ''; member.status = 'offline'; member.lastSeen = Date.now(); }
    const agentToken = crypto.randomBytes(32).toString('base64url'); member.deviceTokenHash = tokenHash(agentToken); member.deviceId = pair.deviceId; member.lastHeartbeat = Date.now(); pair.agentToken = agentToken; pair.paired = true; saveDb();
    await tg('sendMessage', { chat_id: chatId, text: 'Telegram authorization accepted. Keep Task Tracker open on the computer that generated this link; it will finish pairing and then show as connected. After that, use /on to start tracking or /off to stop.' }); return;
  }

  const member = memberByTelegram(msg.from);
  if (!member || member.chatId !== chatId) {
    if (command === '/start' || command === 'start') await tg('sendMessage', { chat_id: chatId, text: 'Ask your workspace owner for an invite link first.' });
    return;
  }
  if (command === '/on' || command === 'on' || command === '/online' || command === 'online') {
    member.status = 'online'; member.statusSince = Date.now(); member.lastSeen = Date.now(); member.commands.push({ id: crypto.randomUUID(), action: 'start', createdAt: Date.now() }); saveDb();
    const computerOnline = !!member.deviceTokenHash && !!member.lastHeartbeat && Date.now() - member.lastHeartbeat < 25_000;
    await tg('sendMessage', { chat_id: chatId, text: computerOnline ? 'Online command sent to your connected computer. Its timer and screenshot capture will start.' : 'You are marked online, but your computer is not connected right now. Open Task Tracker on the computer you want to control, pair it from Telegram connection, and keep the app running. The command will run when it reconnects.' });
  } else if (command === '/off' || command === 'off' || command === '/offline' || command === 'offline' || command === '/break' || command === 'break') {
    member.status = 'offline'; member.statusSince = null; member.lastSeen = Date.now(); member.commands.push({ id: crypto.randomUUID(), action: 'stop', createdAt: Date.now() }); saveDb();
    const computerOnline = !!member.deviceTokenHash && !!member.lastHeartbeat && Date.now() - member.lastHeartbeat < 25_000;
    await tg('sendMessage', { chat_id: chatId, text: computerOnline ? 'Off command sent to your connected computer. Its timer and screenshot capture will stop.' : 'You are marked offline, but your computer is not connected right now. Open Task Tracker on the paired computer to receive the stop command when it reconnects.' });
  } else if ((command === '/task' || command === 'task') && parts.length > 1) {
    const title = text.replace(/^\/?task\s*/i, '').slice(0, 180); member.commands.push({ id: crypto.randomUUID(), action: 'task', title, createdAt: Date.now() }); saveDb();
    await tg('sendMessage', { chat_id: chatId, text: `Task saved: ${title}` });
  } else if (command === '/status' || command === 'status') {
    await tg('sendMessage', { chat_id: chatId, text: `You are ${member.status}. Computer ${member.lastHeartbeat && Date.now() - member.lastHeartbeat < 25_000 ? 'connected' : 'not connected'}.` });
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && url.pathname === '/') return json(res, 200, { ok: true, service: 'task-tracker-relay', message: 'Relay is running. Use /health for the health check.' });
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'task-tracker-relay', databasePresent: fs.existsSync(DB_FILE), backupPresent: fs.existsSync(DB_BACKUP_FILE), persistentDataDirConfigured: !!process.env.DATA_DIR });
  if (req.method === 'POST' && url.pathname.startsWith('/webhook/')) {
    if (!db.webhookSecret || url.pathname !== `/webhook/${db.webhookSecret}` || !secureEqual(req.headers['x-telegram-bot-api-secret-token'] || '', db.webhookSecret)) return json(res, 401, { error: 'Unauthorized webhook.' });
    const update = await body(req);
    if (Number.isInteger(update.update_id) && db.processedUpdates.includes(update.update_id)) return json(res, 200, { ok: true, duplicate: true });
    if (Number.isInteger(update.update_id)) { db.processedUpdates.push(update.update_id); db.processedUpdates = db.processedUpdates.slice(-500); saveDb(); }
    await handleTelegramMessage(update.message); saveDb(); return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith('/admin/')) {
    if (!admin(req)) return json(res, 401, { error: 'Invalid relay admin token.' });
    if (req.method === 'GET' && url.pathname === '/admin/verify') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/admin/setup') {
      if (!PUBLIC_URL) return json(res, 500, { error: 'Set PUBLIC_URL to this relay’s HTTPS address before connecting Telegram.' });
      const input = await body(req); const botToken = String(input.botToken || '').trim(); if (!botToken) return json(res, 400, { error: 'Telegram bot token is required.' });
      const whoResponse = await telegramFetch(`https://api.telegram.org/bot${botToken}/getMe`); const who = await whoResponse.json(); if (!who.ok) return json(res, 400, { error: who.description || 'Invalid Telegram bot token.' });
      db.botToken = botToken; db.botName = who.result.username; db.webhookSecret = crypto.randomBytes(24).toString('hex');
      const webhookResponse = await telegramFetch(`https://api.telegram.org/bot${botToken}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${PUBLIC_URL}/webhook/${db.webhookSecret}`, secret_token: db.webhookSecret, allowed_updates: ['message'], drop_pending_updates: false }) });
      const webhook = await webhookResponse.json(); if (!webhook.ok) return json(res, 502, { error: webhook.description || 'Could not configure Telegram webhook.' });
      saveDb(); return json(res, 200, { ok: true, botName: db.botName });
    }
    if (req.method === 'GET' && url.pathname === '/admin/members') return json(res, 200, { members: db.members.map(publicMember) });
    if (req.method === 'POST' && url.pathname === '/admin/members') {
      const input = await body(req); const username = String(input.telegramUsername || '').trim().replace(/^@/, '');
      if (!input.name || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) || !input.inviteCode) return json(res, 400, { error: 'Name, a valid Telegram username and invite code are required.' });
      let member = db.members.find(item => item.id === input.id || normalizeUsername(item.telegramUsername) === normalizeUsername(username));
      if (!member) { member = { id: input.id || crypto.randomUUID(), commands: [], status: 'offline', totalSeconds: 0 }; db.members.push(member); }
      Object.assign(member, { name: String(input.name).slice(0, 100), telegramUsername: username });
      if (input.telegramId) { member.telegramId = String(input.telegramId); member.chatId = String(input.chatId || input.telegramId); member.inviteCode = ''; }
      else if (!member.telegramId) member.inviteCode = input.inviteCode;
      else member.inviteCode = '';
      member.commands ||= []; saveDb(); return json(res, 200, { member: publicMember(member), inviteLink: member.inviteCode ? `https://t.me/${db.botName}?start=${member.inviteCode}` : '' });
    }
    const invite = url.pathname.match(/^\/admin\/members\/([^/]+)\/invite$/);
    if (req.method === 'POST' && invite) {
      const member = db.members.find(item => item.id === decodeURIComponent(invite[1]));
      if (!member) return json(res, 404, { error: 'Workspace member not found on the relay. Re-add or sync this person first.' });
      if (member.telegramId) return json(res, 409, { error: 'This Telegram account already accepted its workspace invite. Generate a computer link from the desktop app instead.' });
      if (!db.botName) return json(res, 409, { error: 'Connect the workspace bot to the relay before creating invites.' });
      member.inviteCode = `dm_${crypto.randomBytes(8).toString('hex')}`; saveDb();
      return json(res, 200, { inviteCode: member.inviteCode, inviteLink: `https://t.me/${db.botName}?start=${member.inviteCode}` });
    }
    const remove = url.pathname.match(/^\/admin\/members\/([^/]+)$/);
    if (req.method === 'DELETE' && remove) { db.members = db.members.filter(member => member.id !== decodeURIComponent(remove[1])); saveDb(); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'Unknown admin route.' });
  }
  if (req.method === 'POST' && url.pathname === '/agent/pair') {
    const input = await body(req); const username = normalizeUsername(input.username); const member = db.members.find(item => normalizeUsername(item.telegramUsername) === username);
    if (!member) return json(res, 403, { error: 'This Telegram username has not been added to the workspace. Ask the workspace owner to add or sync it, then try again.' });
    const code = `dv_${crypto.randomBytes(12).toString('hex')}`; const deviceId = String(input.deviceId || crypto.randomUUID());
    db.pairs = db.pairs.filter(pair => pair.expiresAt > Date.now()); db.pairs.push({ code, memberId: member.id, deviceId, expiresAt: Date.now() + 10 * 60_000, paired: false, agentToken: '' }); saveDb();
    return json(res, 200, { code, botName: db.botName, inviteLink: `https://t.me/${db.botName}?start=${code}` });
  }
  const pairStatus = url.pathname.match(/^\/agent\/pair\/(dv_[a-f0-9]+)$/);
  if (req.method === 'GET' && pairStatus) {
    const pair = db.pairs.find(item => item.code === pairStatus[1] && item.expiresAt > Date.now()); if (!pair) return json(res, 404, { error: 'Pairing link expired. Generate a new one.' });
    if (!pair.paired || !pair.agentToken) return json(res, 200, { pending: true });
    // Keep the short-lived pairing token available until the code expires so a
    // desktop retry can recover if it missed the first HTTP response.
    return json(res, 200, { pending: false, agentToken: pair.agentToken });
  }
  if (req.method === 'POST' && url.pathname === '/agent/poll') {
    const member = agentFor(req); if (!member) return json(res, 401, { error: 'This computer pairing is no longer active. Generate a fresh computer link; a newer pairing may have replaced it.' });
    member.lastHeartbeat = Date.now(); member.commands ||= []; const commands = member.commands.slice(0, 50); saveDb(); return json(res, 200, { commands, status: member.status });
  }
  if (req.method === 'POST' && url.pathname === '/agent/ack') {
    const member = agentFor(req); if (!member) return json(res, 401, { error: 'This computer is not paired.' });
    const input = await body(req); const ids = new Set(Array.isArray(input.commandIds) ? input.commandIds.map(String) : []);
    member.commands = (member.commands || []).filter(command => !ids.has(String(command.id)));
    member.lastHeartbeat = Date.now(); saveDb(); return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/agent/status') {
    const member = agentFor(req); if (!member) return json(res, 401, { error: 'This computer is not paired.' });
    const input = await body(req); member.lastHeartbeat = Date.now(); member.deviceOnline = true;
    if (typeof input.online === 'boolean') { member.status = input.online ? 'online' : 'offline'; member.statusSince = input.online ? (member.statusSince || Date.now()) : null; }
    if (Number.isFinite(input.totalSeconds)) member.totalSeconds = Math.max(member.totalSeconds || 0, input.totalSeconds);
    saveDb(); return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found.' });
}

loadDb();
const server = http.createServer((req, res) => { route(req, res).catch(error => { console.error(error); if (!res.headersSent) json(res, 500, { error: error.message || 'Relay error.' }); else res.destroy(); }); });
server.listen(PORT, '0.0.0.0', () => console.log(`Task Tracker relay listening on ${PORT}`));
