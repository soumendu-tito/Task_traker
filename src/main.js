const { app, BrowserWindow, ipcMain, desktopCapturer, shell, dialog, Notification, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

let win;
const dataDir = () => path.join(app.getPath('userData'), 'tracker-data');
const stateFile = () => path.join(dataDir(), 'state.json');
const stateBackupFile = () => `${stateFile()}.bak`;
let state;
let captureTimer;
let captureBusy = false;
let telegramTimer;
let relayPairTimer;
let pendingPair;
let telegramOffset = 0;
let telegramBusy = false;
let relayBusy = false;
let sessionStartedAt = null;

function defaults() {
  return {
    profile: { name: '', email: '', role: 'Team member' },
    tracking: { active: false, since: null, totalSeconds: 0 },
    tasks: [], screenshots: [], sessions: [], members: [],
    preferences: { screenshots: true, intervalMinutes: 5 },
    telegram: { token: '', chatId: '', connected: false, botName: '', offset: 0, error: '' },
    relay: { url: '', adminKey: '', adminReady: false, username: '', agentToken: '', deviceId: '', pendingCode: '' },
  };
}
function persist() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = `${stateFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (fs.existsSync(stateFile())) fs.copyFileSync(stateFile(), stateBackupFile());
  fs.renameSync(tmp, stateFile());
}
function load() {
  try {
    state = { ...defaults(), ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(stateBackupFile())) state = defaults();
    else {
      try {
        state = { ...defaults(), ...JSON.parse(fs.readFileSync(stateBackupFile(), 'utf8')) };
        fs.copyFileSync(stateBackupFile(), stateFile());
        console.warn(`Recovered desktop state from backup: ${error.message}`);
      } catch (backupError) {
        throw new Error(`Saved Task Tracker data could not be read. The app did not overwrite it. Keep these files for recovery: ${stateFile()} and ${stateBackupFile()}. ${backupError.message}`);
      }
    }
  }
  state.preferences = { ...state.preferences, screenshots: true, intervalMinutes: 5 };
  state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
  state.members = Array.isArray(state.members) ? state.members : [];
  state.relay = { ...defaults().relay, ...state.relay, adminReady: false, deviceId: state.relay?.deviceId || crypto.randomUUID() };
  for (const member of state.members) { member.sessions = member.sessions || []; if (member.status === 'online') memberStop(member); }
  if (state.tracking.active && state.tracking.since) sessionStartedAt = new Date(state.tracking.since).getTime();
  else state.tracking.active = false;
  telegramOffset = Number(state.telegram.offset) || 0;
  persist();
}
function snapshot() {
  return { ...state, tracking: { ...state.tracking, activeSeconds: state.tracking.totalSeconds + (sessionStartedAt ? Math.floor((Date.now() - sessionStartedAt) / 1000) : 0) } };
}
function publish() { if (win && !win.isDestroyed()) win.webContents.send('state:update', snapshot()); }
function relayUrl() { return String(state.relay?.url || '').trim().replace(/\/$/, ''); }
async function relayRequest(route, options = {}, needsAdmin = false) {
  const base = relayUrl(); if (!base) throw new Error('Enter the public HTTPS relay URL first.');
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (needsAdmin) headers['x-relay-admin'] = state.relay.adminKey;
  else if (state.relay.agentToken) headers.authorization = `Bearer ${state.relay.agentToken}`;
  const response = await fetch(`${base}${route}`, { ...options, headers });
  const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || `Relay returned HTTP ${response.status}.`); return result;
}
async function reportAgentStatus() {
  if (!state?.relay?.agentToken || !relayUrl()) return;
  try { await relayRequest('/agent/status', { method: 'POST', body: JSON.stringify({ online: state.tracking.active, totalSeconds: snapshot().tracking.activeSeconds }) }); }
  catch (err) { console.warn('Relay status update:', err.message); }
}
async function pollAgentRelay() {
  if (relayBusy || !state?.relay?.agentToken || !relayUrl()) return;
  relayBusy = true;
  try {
    const result = await relayRequest('/agent/poll', { method: 'POST', body: '{}' });
    for (const command of result.commands || []) {
      if (command.action === 'start') startTracking();
      else if (command.action === 'stop') stopTracking();
      else if (command.action === 'task') addTask(command.title, '', 'Telegram');
    }
  } catch (err) { if (err.message !== 'fetch failed') console.warn('Relay agent polling:', err.message); }
  finally { relayBusy = false; }
}
function startAgentRelay() { if (telegramTimer) clearInterval(telegramTimer); telegramTimer = setInterval(pollAgentRelay, 2500); pollAgentRelay(); }
function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 1120, minHeight: 760, title: 'Task Tracker', backgroundColor: '#f4f7fb', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
}
function stopCapture() { if (captureTimer) clearInterval(captureTimer); captureTimer = null; }
function startCapture() {
  stopCapture();
  if (!state.tracking.active) return;
  captureScreen();
  captureTimer = setInterval(captureScreen, Math.max(1, Number(state.preferences.intervalMinutes) || 5) * 60_000);
}
async function captureScreen() {
  if (!state.tracking.active || !win || win.isDestroyed()) return { ok: false, message: 'Start tracking first. Required screenshots are captured only during an active work session.' };
  if (captureBusy) return { ok: false, message: 'A screenshot is already being captured.' };
  captureBusy = true;
  if (Notification.isSupported()) new Notification({ title: 'Screenshot capture', body: 'A required screenshot is being captured now.' }).show();
  if (win && !win.isDestroyed()) win.webContents.send('capture:notice', { phase: 'started', capturedAt: new Date().toISOString() });
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1440, height: 900 } });
    const source = sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Windows did not provide a screen image. Check that a display is awake and unlocked, then try again.');
    const dir = path.join(dataDir(), 'screenshots'); fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = crypto.randomUUID(); const file = path.join(dir, `${stamp}-${id}.jpg`);
    fs.writeFileSync(file, source.thumbnail.toJPEG(82));
    state.screenshots.unshift({ id, file, capturedAt: new Date().toISOString(), display: source.name });
    state.preferences.captureError = '';
    persist(); publish(); win.webContents.send('capture:notice', { phase: 'complete', capturedAt: new Date().toISOString() });
    return { ok: true };
  } catch (err) {
    console.error('Screenshot capture failed:', err.message);
    state.preferences.captureError = err.message || 'Screenshot capture failed.';
    publish();
    return { ok: false, message: state.preferences.captureError };
  } finally { captureBusy = false; }
}
function startTracking() {
  if (state.tracking.active) return snapshot();
  sessionStartedAt = Date.now(); state.tracking.active = true; state.tracking.since = new Date().toISOString(); persist(); startCapture(); publish(); reportAgentStatus(); return snapshot();
}
function stopTracking() {
  if (!state.tracking.active) return snapshot();
  const durationSeconds = sessionStartedAt ? Math.floor((Date.now() - sessionStartedAt) / 1000) : 0;
  state.tracking.totalSeconds += durationSeconds;
  if (durationSeconds > 0) state.sessions.unshift({ startedAt: state.tracking.since, endedAt: new Date().toISOString(), durationSeconds, memberId: 'owner' });
  state.tracking.active = false; state.tracking.since = null; sessionStartedAt = null; persist(); stopCapture(); publish(); reportAgentStatus(); return snapshot();
}
function addTask(title, note = '', source = 'Desktop') {
  title = String(title || '').trim().slice(0, 180); if (!title) return null;
  const task = { id: crypto.randomUUID(), title, note: String(note || '').trim().slice(0, 1000), status: 'In progress', source, createdAt: new Date().toISOString(), completedAt: null };
  state.tasks.unshift(task); persist(); publish(); return task;
}

function normalizeTelegramUsername(value) { return String(value || '').trim().replace(/^@/, '').toLowerCase(); }
function addWorkspaceMember(name, telegramUsername) {
  name = String(name || '').trim().slice(0, 100);
  telegramUsername = String(telegramUsername || '').trim().replace(/^@/, '').slice(0, 32);
  if (!state.telegram.token || !state.telegram.botName) throw new Error('Connect your Telegram bot before inviting workspace members.');
  if (!name || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegramUsername)) throw new Error('Enter a name and a valid Telegram username (5–32 letters, numbers or underscores).');
  if (state.members.some(member => normalizeTelegramUsername(member.telegramUsername) === normalizeTelegramUsername(telegramUsername))) throw new Error('That Telegram username is already in this workspace.');
  const member = { id: crypto.randomUUID(), name, telegramUsername, telegramId: '', chatId: '', inviteCode: `dm_${crypto.randomBytes(5).toString('hex')}`, status: 'pending', lastSeen: null, totalSeconds: 0, startedAt: null, photoFile: '', addedAt: new Date().toISOString() };
  state.members.push(member); persist(); publish(); return { id: member.id, name, telegramUsername, botName: state.telegram.botName, inviteCode: member.inviteCode, inviteLink: `https://t.me/${state.telegram.botName}?start=${member.inviteCode}` };
}
function memberStart(member) {
  if (member.status === 'online') return;
  member.status = 'online'; member.startedAt = Date.now(); publish(); persist();
}
function memberStop(member) {
  if (member.status !== 'online') { member.status = 'offline'; member.lastSeen = new Date().toISOString(); persist(); publish(); return; }
  const durationSeconds = member.startedAt ? Math.floor((Date.now() - member.startedAt) / 1000) : 0;
  member.totalSeconds += durationSeconds;
  if (durationSeconds > 0) {
    member.sessions = member.sessions || [];
    member.sessions.unshift({ startedAt: new Date(member.startedAt).toISOString(), endedAt: new Date().toISOString(), durationSeconds, memberId: member.id });
  }
  member.startedAt = null; member.status = 'offline'; member.lastSeen = new Date().toISOString(); persist(); publish();
}
async function saveMemberPhoto(member) {
  try {
    const photos = await telegram('getUserProfilePhotos', { user_id: Number(member.telegramId), limit: 1 });
    const sizes = photos.photos?.[0] || []; const photo = sizes[sizes.length - 1]; if (!photo) return;
    const file = await telegram('getFile', { file_id: photo.file_id }); if (!file.file_path) return;
    const response = await fetch(`https://api.telegram.org/file/bot${state.telegram.token}/${file.file_path}`);
    if (!response.ok) return;
    const ext = path.extname(file.file_path) || '.jpg'; const dir = path.join(dataDir(), 'member-photos'); fs.mkdirSync(dir, { recursive: true });
    const destination = path.join(dir, `${member.id}${ext}`); fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer())); member.photoFile = destination; persist(); publish();
  } catch (err) { console.warn('Could not fetch Telegram profile photo:', err.message); }
}
function workspaceMembers() {
  const activeSeconds = state.tracking.totalSeconds + (sessionStartedAt ? Math.floor((Date.now() - sessionStartedAt) / 1000) : 0);
  const owner = { id: 'owner', name: state.profile.name || 'Workspace owner', telegramId: '', status: state.tracking.active ? 'online' : 'offline', lastSeen: null, totalSeconds: activeSeconds, isOwner: true, photo: '' };
  return [owner, ...state.members.map(member => ({ ...member, totalSeconds: member.totalSeconds + (member.status === 'online' && member.startedAt ? Math.floor((Date.now() - member.startedAt) / 1000) : 0), photo: member.photoFile && fs.existsSync(member.photoFile) ? `data:${member.photoFile.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${fs.readFileSync(member.photoFile).toString('base64')}` : '' }))];
}
function weekBounds(date = new Date()) { const start = new Date(date); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); const end = new Date(start); end.setDate(end.getDate() + 7); return { start, end }; }
function dayBounds(date = new Date()) { const start = new Date(date); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 1); return { start, end }; }
function trackedSecondsForRange(start, end) {
  const sessions = [...state.sessions, ...state.members.flatMap(member => member.sessions || [])];
  if (state.tracking.active && state.tracking.since) sessions.push({ startedAt: state.tracking.since, endedAt: new Date().toISOString() });
  for (const member of state.members) if (member.status === 'online' && member.startedAt) sessions.push({ startedAt: new Date(member.startedAt).toISOString(), endedAt: new Date().toISOString() });
  return sessions.reduce((sum, session) => { const from = Math.max(start.getTime(), new Date(session.startedAt).getTime()); const to = Math.min(end.getTime(), new Date(session.endedAt).getTime()); return sum + Math.max(0, Math.floor((to - from) / 1000)); }, 0);
}
function weeklyTrackedSeconds() {
  const { start, end } = weekBounds(); return trackedSecondsForRange(start, end);
}

async function telegram(method, params = {}) {
  const token = state.telegram.token;
  if (!token) throw new Error('Add your Telegram bot token first.');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const data = await response.json(); if (!data.ok) throw new Error(data.description || 'Telegram request failed'); return data.result;
}
async function telegramLoop() {
  if (telegramBusy || !state.telegram.token) return;
  telegramBusy = true;
  try {
    const updates = await telegram('getUpdates', { offset: telegramOffset, timeout: 1, allowed_updates: ['message'] });
    if (state.telegram.error) { state.telegram.error = ''; publish(); }
    for (const update of updates) {
      telegramOffset = update.update_id + 1;
      state.telegram.offset = telegramOffset;
      const msg = update.message; if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id); const text = msg.text.trim();
      if (pendingPair && text.split(/\s+/).some(part => part === pendingPair.code) && Date.now() < pendingPair.expiresAt) {
        state.telegram.chatId = chatId; state.telegram.connected = true; pendingPair = null; persist(); publish();
        await telegram('sendMessage', { chat_id: chatId, text: '✅ Connected to Task Tracker. Commands: /online, /break, /task Your task, /status, /help' }); continue;
      }
      if (!state.telegram.connected || chatId !== String(state.telegram.chatId)) continue;
      const command = text.split(/\s+/)[0].toLowerCase().replace(/@[^@]+$/, '');
      if (command === '/on' || command === '/online' || command === 'online' || command === 'on') { startTracking(); await telegram('sendMessage', { chat_id: chatId, text: '🟢 You are online. Your work timer is running.' }); }
      else if (command === '/break' || command === '/off' || command === 'break' || command === 'off') { stopTracking(); await telegram('sendMessage', { chat_id: chatId, text: '⏸️ Tracking paused. Enjoy your break.' }); }
      else if (command === '/task' || command === 'task') { const taskText = text.replace(/^\/?task\s*/i, ''); if (!taskText) await telegram('sendMessage', { chat_id: chatId, text: 'Try: /task Prepare the weekly report' }); else { addTask(taskText, '', 'Telegram'); await telegram('sendMessage', { chat_id: chatId, text: `📝 Task saved: ${taskText}` }); } }
      else if (command === '/status') { const secs = snapshot().tracking.activeSeconds; await telegram('sendMessage', { chat_id: chatId, text: `${state.tracking.active ? '🟢 Online' : '⏸️ On break'} · Today ${Math.floor(secs / 3600)}h ${Math.floor(secs % 3600 / 60)}m` }); }
      else await telegram('sendMessage', { chat_id: chatId, text: 'Commands: /online, /break, /task Your task, /status, /help' });
    }
    if (updates.length) persist();
  } catch (err) { console.warn('Telegram polling:', err.message); if (state.telegram.error !== err.message) { state.telegram.error = err.message; publish(); } }
  finally { telegramBusy = false; }
}
async function telegramLoop() {
  if (telegramBusy || !state.telegram.token) return;
  telegramBusy = true;
  try {
    const updates = await telegram('getUpdates', { offset: telegramOffset, timeout: 1, allowed_updates: ['message'] });
    if (state.telegram.error) { state.telegram.error = ''; publish(); }
    for (const update of updates) {
      telegramOffset = update.update_id + 1; state.telegram.offset = telegramOffset;
      const msg = update.message; if (!msg?.text) continue;
      const chatId = String(msg.chat.id); const text = msg.text.trim(); const parts = text.split(/\s+/);
      const startCode = parts[0].toLowerCase() === '/start' ? (parts[1] || '') : '';
      const invitee = startCode ? state.members.find(member => member.inviteCode === startCode) : null;
      if (invitee) {
        const usernameMatches = invitee.telegramUsername ? normalizeTelegramUsername(msg.from?.username) === normalizeTelegramUsername(invitee.telegramUsername) : String(msg.from?.id) === invitee.telegramId;
        if (!usernameMatches) {
          await telegram('sendMessage', { chat_id: chatId, text: `This invite is for @${invitee.telegramUsername || 'the assigned account'}. Switch to that Telegram account or ask the workspace owner for a new invite.` });
        } else {
          invitee.chatId = chatId; invitee.telegramId = String(msg.from.id); invitee.telegramUsername = msg.from.username || invitee.telegramUsername; invitee.inviteCode = ''; invitee.status = 'offline'; invitee.lastSeen = new Date().toISOString(); persist(); publish();
          saveMemberPhoto(invitee);
          await telegram('sendMessage', { chat_id: chatId, text: `Welcome to ${state.profile.name || 'the workspace'}'s team workspace, ${invitee.name}! Use /on or /online, /off or /break, /task Your task and /status.` });
        }
        continue;
      }
      if (pendingPair && parts.includes(pendingPair.code) && Date.now() < pendingPair.expiresAt) {
        state.telegram.chatId = chatId; state.telegram.ownerUserId = String(msg.from?.id || ''); state.telegram.connected = true; pendingPair = null; persist(); publish();
        await telegram('sendMessage', { chat_id: chatId, text: 'Connected to Task Tracker. Commands: /on or /online, /off or /break, /task Your task, /status, /help' }); continue;
      }
      const command = parts[0].toLowerCase().replace(/@[^@]+$/, ''); const member = state.members.find(item => item.chatId === chatId);
      const isOwner = state.telegram.connected && chatId === String(state.telegram.chatId);
      if (!member && !isOwner) {
        if (command === '/start' || command === 'start') await telegram('sendMessage', { chat_id: chatId, text: 'Ask your workspace owner to add your Telegram ID and send you a workspace invite link.' });
        continue;
      }
      const displayName = member?.name || state.profile.name || 'Team member';
      if (command === '/on' || command === '/online' || command === 'online' || command === 'on') {
        if (member) memberStart(member); else startTracking();
        await telegram('sendMessage', { chat_id: chatId, text: 'You are online. Your work timer is running.' });
      } else if (command === '/break' || command === '/off' || command === 'break' || command === 'off') {
        if (member) memberStop(member); else stopTracking();
        await telegram('sendMessage', { chat_id: chatId, text: 'Tracking paused. Enjoy your break.' });
      } else if (command === '/task' || command === 'task') {
        const taskText = text.replace(/^\/?task\s*/i, '');
        if (!taskText) await telegram('sendMessage', { chat_id: chatId, text: 'Try: /task Prepare the weekly report' });
        else { addTask(taskText, '', `Telegram · ${displayName}`); await telegram('sendMessage', { chat_id: chatId, text: `Task saved: ${taskText}` }); }
      } else if (command === '/status') {
        const seconds = member ? member.totalSeconds + (member.status === 'online' && member.startedAt ? Math.floor((Date.now() - member.startedAt) / 1000) : 0) : snapshot().tracking.activeSeconds;
        const online = member ? member.status === 'online' : state.tracking.active;
        await telegram('sendMessage', { chat_id: chatId, text: `${online ? 'Online' : 'Offline'} · Today ${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` });
      } else await telegram('sendMessage', { chat_id: chatId, text: 'Commands: /on or /online, /off or /break, /task Your task, /status, /help' });
    }
    if (updates.length) persist();
  } catch (err) { console.warn('Telegram polling:', err.message); if (state.telegram.error !== err.message) { state.telegram.error = err.message; publish(); } }
  finally { telegramBusy = false; }
}
function startTelegram() { if (telegramTimer) clearInterval(telegramTimer); telegramTimer = setInterval(telegramLoop, 2200); telegramLoop(); }

ipcMain.handle('state:get', () => snapshot());
ipcMain.handle('workspace:list', async () => {
  if (relayUrl() && state.relay.adminReady && state.relay.adminKey) {
    try {
      const result = await relayRequest('/admin/members', {}, true);
      const localPhotos = new Map(workspaceMembers().map(member => [normalizeTelegramUsername(member.telegramUsername), member.photo]));
      return [{ id: 'owner', name: state.profile.name || 'Workspace owner', status: state.tracking.active ? 'online' : 'offline', totalSeconds: snapshot().tracking.activeSeconds, isOwner: true }, ...result.members.map(member => ({ ...member, telegramId: '', inviteCode: '', photo: localPhotos.get(normalizeTelegramUsername(member.telegramUsername)) || '', lastSeen: member.lastSeen ? new Date(member.lastSeen).toISOString() : null }))];
    } catch (err) { console.warn('Relay workspace list:', err.message); }
  }
  return workspaceMembers().map(member => ({ ...member, inviteLink: member.inviteCode ? `https://t.me/${state.telegram.botName}?start=${member.inviteCode}` : '' }));
});
ipcMain.handle('workspace:add-member', async (_e, data) => {
  if (!state.relay.adminReady) throw new Error('Only the workspace administrator can add people.');
  const username = String(data.telegramUsername || '').trim().replace(/^@/, '').slice(0, 32);
  let member = state.members.find(item => normalizeTelegramUsername(item.telegramUsername) === normalizeTelegramUsername(username));
  if (!member) member = addWorkspaceMember(data.name, username);
  else {
    if (!String(data.name || '').trim()) throw new Error('Enter a name for this person.');
    member.name = String(data.name).trim().slice(0, 100);
    if (!member.telegramId && !member.inviteCode) member.inviteCode = `dm_${crypto.randomBytes(5).toString('hex')}`;
    persist(); publish();
  }
  if (relayUrl() && state.relay.adminKey) {
    const inviteCode = member.inviteCode || `dm_${crypto.randomBytes(5).toString('hex')}`;
    const synced = await relayRequest('/admin/members', { method: 'POST', body: JSON.stringify({ id: member.id, name: member.name, telegramUsername: member.telegramUsername, telegramId: member.telegramId || '', chatId: member.chatId || '', inviteCode }) }, true);
    if (synced.member?.id) member.id = synced.member.id;
    if (synced.member && !synced.member.invitePending) member.inviteCode = '';
    persist(); publish();
  }
  return { id: member.id, name: member.name, telegramUsername: member.telegramUsername, botName: state.telegram.botName, inviteCode: member.inviteCode, inviteLink: member.inviteCode && state.telegram.botName ? `https://t.me/${state.telegram.botName}?start=${member.inviteCode}` : '' };
});
ipcMain.handle('workspace:copy-invite', async (_e, id) => {
  if (!state.relay.adminReady) throw new Error('Only the workspace administrator can manage invites.');
  if (relayUrl() && state.relay.adminKey) {
    const result = await relayRequest(`/admin/members/${encodeURIComponent(id)}/invite`, { method: 'POST', body: '{}' }, true);
    const localMember = state.members.find(item => item.id === id);
    if (localMember) { localMember.inviteCode = result.inviteCode; persist(); }
    clipboard.writeText(result.inviteLink); return true;
  }
  const member = state.members.find(item => item.id === id);
  if (!member?.inviteCode || !state.telegram.botName) return false;
  clipboard.writeText(`https://t.me/${state.telegram.botName}?start=${member.inviteCode}`); return true;
});
ipcMain.handle('workspace:remove-member', async (_e, id) => { if (!state.relay.adminReady) throw new Error('Only the workspace administrator can remove people.'); const member = state.members.find(item => item.id === id); if (member?.status === 'online') memberStop(member); state.members = state.members.filter(item => item.id !== id); persist(); publish(); if (relayUrl() && state.relay.adminKey) await relayRequest(`/admin/members/${encodeURIComponent(id)}`, { method: 'DELETE' }, true); return true; });
ipcMain.handle('profile:save', (_e, profile) => { state.profile = { ...state.profile, name: String(profile.name || '').trim(), email: String(profile.email || '').trim(), role: String(profile.role || 'Team member').trim() }; persist(); publish(); return snapshot(); });
ipcMain.handle('preferences:set', (_e, prefs) => { state.preferences = { ...state.preferences, ...prefs, screenshots: true, intervalMinutes: 5 }; persist(); startCapture(); publish(); return snapshot(); });
ipcMain.handle('tracking:start', startTracking); ipcMain.handle('tracking:stop', stopTracking);
ipcMain.handle('task:add', (_e, data) => addTask(data.title, data.note));
ipcMain.handle('task:update', (_e, id, data) => { const task = state.tasks.find(t => t.id === id); if (!task) return false; task.status = data.status; task.completedAt = task.status === 'Completed' ? new Date().toISOString() : null; persist(); publish(); return true; });
ipcMain.handle('task:delete', (_e, id) => { state.tasks = state.tasks.filter(t => t.id !== id); persist(); publish(); return true; });
ipcMain.handle('screenshots:list', () => state.screenshots.map(({ id, capturedAt, display }) => ({ id, capturedAt, display })));
ipcMain.handle('screenshots:capture', captureScreen);
ipcMain.handle('screenshots:image', (_e, id) => { const item = state.screenshots.find(s => s.id === id); if (!item || !fs.existsSync(item.file)) return ''; return `data:image/jpeg;base64,${fs.readFileSync(item.file).toString('base64')}`; });
ipcMain.handle('screenshots:open', async (_e, id) => { const item = state.screenshots.find(s => s.id === id); if (!item || !fs.existsSync(item.file)) return false; await shell.openPath(item.file); return true; });
ipcMain.handle('report:pdf', async (_event, mode = 'all') => {
  const weekly = mode === 'weekly'; const daily = mode === 'daily'; const { start, end } = weekly ? weekBounds() : dayBounds();
  const reportTasks = weekly || daily ? state.tasks.filter(task => new Date(task.createdAt) >= start && new Date(task.createdAt) < end) : state.tasks;
  const reportSeconds = weekly ? weeklyTrackedSeconds() : daily ? trackedSecondsForRange(start, end) : snapshot().tracking.activeSeconds;
  const reportTitle = weekly ? 'End of week report' : daily ? 'Daily report' : 'Task Tracker report';
  const prefix = weekly ? 'weekly' : daily ? 'daily' : 'task';
  const out = await dialog.showSaveDialog(win, { title: `Save ${reportTitle}`, defaultPath: `${prefix}-report-${new Date().toISOString().slice(0, 10)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (out.canceled || !out.filePath) return false;
  const report = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const rows = reportTasks.map(t => `<tr><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.source)}</td><td>${new Date(t.createdAt).toLocaleString()}</td></tr>`).join('');
  const range = weekly ? `${start.toLocaleDateString()} – ${new Date(end.getTime() - 1).toLocaleDateString()}` : daily ? start.toLocaleDateString() : new Date().toLocaleString();
  const html = `<!doctype html><html><meta charset="utf-8"><style>body{font:14px Arial;color:#172033;padding:38px}h1{color:#5646df}p{color:#65708a}table{width:100%;border-collapse:collapse;margin-top:26px}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}th{background:#f2f2fb}</style><h1>${reportTitle}</h1><p>${escapeHtml(range)} · ${escapeHtml(state.profile.name || 'Team member')}</p><p>Tracked time: ${Math.floor(reportSeconds / 3600)}h ${Math.floor(reportSeconds % 3600 / 60)}m</p><table><thead><tr><th>Task</th><th>Status</th><th>Source</th><th>Added</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No tasks recorded</td></tr>'}</tbody></table></html>`;
  await report.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); const pdf = await report.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } }); fs.writeFileSync(out.filePath, pdf); report.close(); return out.filePath;
});
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
ipcMain.handle('email:send', async (_e, data) => {
  const nodemailer = require('nodemailer'); const { host, port, user, password, to } = data;
  if (![host, user, password, to].every(Boolean)) throw new Error('Enter SMTP host, username, password and recipient.');
  const transport = nodemailer.createTransport({ host, port: Number(port) || 587, secure: Number(port) === 465, auth: { user, pass: password } });
  const tasks = state.tasks.map(t => `• ${t.title} — ${t.status} (${t.source})`).join('\n') || 'No tasks recorded.';
  await transport.sendMail({ from: user, to, subject: `Task Tracker report — ${new Date().toLocaleDateString()}`, text: `${state.profile.name || 'Team member'}\nTracked time: ${Math.floor(snapshot().tracking.activeSeconds / 3600)}h ${Math.floor(snapshot().tracking.activeSeconds % 3600 / 60)}m\n\n${tasks}` }); return true;
});
ipcMain.handle('telegram:save', async (_e, data) => { const token = String(data.token || '').trim(); if (!token) throw new Error('Paste a Telegram bot token.'); const response = await fetch(`https://api.telegram.org/bot${token}/getMe`); const result = await response.json(); if (!result.ok) throw new Error(result.description || 'Could not connect bot.'); state.telegram = { token, chatId: '', connected: false, botName: result.result.username, offset: 0, error: '' }; telegramOffset = 0; persist(); if (relayUrl() && state.relay.adminKey) await relayRequest('/admin/setup', { method: 'POST', body: JSON.stringify({ botToken: token }) }, true); else startTelegram(); publish(); return { botName: result.result.username }; });
ipcMain.handle('telegram:pair', async () => { if (!state.telegram.token) throw new Error('Save a bot token first.'); const code = String(crypto.randomInt(100000, 999999)); pendingPair = { code, expiresAt: Date.now() + 10 * 60_000 }; return { code, botName: state.telegram.botName }; });
ipcMain.handle('telegram:disconnect', () => { state.telegram = { token: '', chatId: '', connected: false, botName: '', offset: 0, error: '' }; telegramOffset = 0; pendingPair = null; persist(); publish(); return true; });
ipcMain.handle('relay:configure', async (_e, input) => {
  const url = String(input.url || state.relay.url || '').trim().replace(/\/$/, ''); const adminKey = String(input.adminKey || state.relay.adminKey || '').trim(); const token = String(input.botToken || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('The relay address must start with https://.');
  if (!adminKey || !token) throw new Error('Enter the relay admin token and Telegram bot token.');
  if (telegramTimer) { clearInterval(telegramTimer); telegramTimer = null; }
  state.relay.url = url; state.relay.adminKey = adminKey; state.relay.adminReady = false;
  try {
    await relayRequest('/admin/verify', {}, true);
    const result = await relayRequest('/admin/setup', { method: 'POST', body: JSON.stringify({ botToken: token }) }, true);
    state.relay.adminReady = true;
    state.telegram = { ...state.telegram, token, botName: result.botName, connected: false, chatId: '', error: '' };
    for (const member of state.members) {
      const synced = await relayRequest('/admin/members', { method: 'POST', body: JSON.stringify({ id: member.id, name: member.name, telegramUsername: member.telegramUsername, telegramId: member.telegramId || '', chatId: member.chatId || '', inviteCode: member.inviteCode || `dm_${crypto.randomBytes(5).toString('hex')}` }) }, true);
      if (synced.member?.id) member.id = synced.member.id;
      if (synced.member && !synced.member.invitePending) member.inviteCode = '';
    }
    persist(); publish(); return { botName: result.botName };
  } catch (err) { state.relay.adminReady = false; persist(); publish(); throw err; }
});
ipcMain.handle('relay:verify-admin', async (_e, input) => {
  const url = String(input.url || '').trim().replace(/\/$/, ''); const adminKey = String(input.adminKey || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('The relay address must start with https://.');
  if (!adminKey) throw new Error('Enter the relay admin token from Render.');
  const previous = { url: state.relay.url, adminKey: state.relay.adminKey, adminReady: state.relay.adminReady };
  state.relay.url = url; state.relay.adminKey = adminKey;
  try {
    await relayRequest('/admin/verify', {}, true);
    state.relay.adminReady = true; persist(); publish(); return { ok: true };
  } catch (error) {
    Object.assign(state.relay, previous); throw error;
  }
});
ipcMain.handle('relay:save-agent-settings', (_e, input) => {
  const url = String(input.url || '').trim().replace(/\/$/, ''); const username = String(input.username || '').trim().replace(/^@/, '');
  if (!/^https:\/\//i.test(url)) throw new Error('The relay address must start with https://.');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new Error('Enter a valid Telegram username.');
  state.relay.url = url; state.relay.username = username; persist(); return true;
});
ipcMain.handle('relay:copy-text', (_e, value) => { clipboard.writeText(String(value || '')); return true; });
ipcMain.handle('relay:pair-device', async (_e, input) => {
  if (input?.url || input?.username) { const url = String(input.url || state.relay.url).trim().replace(/\/$/, ''); const username = String(input.username || state.relay.username).trim().replace(/^@/, ''); if (!/^https:\/\//i.test(url)) throw new Error('The relay address must start with https://.'); state.relay.url = url; state.relay.username = username; }
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(state.relay.username)) throw new Error('Enter a valid Telegram username.');
  const result = await relayRequest('/agent/pair', { method: 'POST', body: JSON.stringify({ username: state.relay.username, deviceId: state.relay.deviceId }) });
  state.relay.pendingCode = result.code; state.telegram.botName = result.botName; persist(); publish();
  if (relayPairTimer) clearInterval(relayPairTimer); relayPairTimer = setInterval(checkRelayPair, 2500); checkRelayPair();
  return result;
});
async function checkRelayPair() {
  if (!state.relay.pendingCode || state.relay.agentToken) { if (relayPairTimer) clearInterval(relayPairTimer); relayPairTimer = null; return; }
  try {
    const result = await relayRequest(`/agent/pair/${encodeURIComponent(state.relay.pendingCode)}`);
    if (!result.pending && result.agentToken) { state.relay.agentToken = result.agentToken; state.relay.pendingCode = ''; state.telegram.connected = true; persist(); publish(); if (relayPairTimer) clearInterval(relayPairTimer); relayPairTimer = null; startAgentRelay(); }
  } catch (err) { if (err.message.includes('expired')) { state.relay.pendingCode = ''; persist(); publish(); if (relayPairTimer) clearInterval(relayPairTimer); relayPairTimer = null; } }
}
ipcMain.handle('assistant:ask', (_e, question) => {
  const q = String(question || '').trim().toLowerCase(); const open = state.tasks.filter(t => t.status !== 'Completed');
  if (/help|what can|command/.test(q)) return 'I can summarize your work, show open tasks and explain Telegram commands. Try “show my open tasks” or use /task, /online and /break in Telegram.';
  if (/task|todo|open|pending/.test(q)) return open.length ? `You have ${open.length} open task${open.length === 1 ? '' : 's'}: ${open.slice(0, 5).map(t => t.title).join('; ')}${open.length > 5 ? '; and more' : ''}.` : 'You have no open tasks. Nice work!';
  if (/time|hour|worked|today/.test(q)) { const s = snapshot().tracking.activeSeconds; return `You have tracked ${Math.floor(s / 3600)} hours, ${Math.floor(s % 3600 / 60)} minutes and ${s % 60} seconds in this session${state.tracking.active ? ', which is still running' : ''}.`; }
  if (/done|complete/.test(q)) return `${state.tasks.filter(t => t.status === 'Completed').length} tasks completed so far. Keep marking tasks complete as you go.`;
  return 'I’m your local task helper. Ask me about your open tasks, completed work or tracked time. You can also add a task from the Tasks tab.';
});
app.whenReady().then(() => {
  try { load(); }
  catch (error) { dialog.showErrorBox('Could not load saved Task Tracker data', error.message); app.quit(); return; }
  createWindow(); setInterval(publish, 1000);
  if (state.tracking.active) { state.tracking.active = false; state.tracking.since = null; sessionStartedAt = null; persist(); }
  if (state.telegram.token && !state.relay.url) startTelegram();
  if (state.relay.agentToken) { startAgentRelay(); reportAgentStatus(); }
  if (state.relay.pendingCode) { relayPairTimer = setInterval(checkRelayPair, 2500); checkRelayPair(); }
});
app.on('before-quit', () => { if (state?.tracking.active) stopTracking(); for (const member of state?.members || []) if (member.status === 'online') memberStop(member); stopCapture(); if (telegramTimer) clearInterval(telegramTimer); if (relayPairTimer) clearInterval(relayPairTimer); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
