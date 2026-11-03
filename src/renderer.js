const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let appState;
let currentFilter = 'All';
let toastTimer;
let workspaceStatusKey = '';
let workspaceRefreshing = false;

function ensureCaptureUi() {
  const captureToggle = $('#screenshots-toggle');
  if (captureToggle) {
    const switchLabel = captureToggle.closest('.switch');
    if (switchLabel) switchLabel.outerHTML = '<span class="mandatory-chip">Required</span>';
    const description = $('.preference-row p');
    if (description) description.textContent = 'Screenshots are captured every 5 minutes whenever tracking is active.';
  }
  const heading = $('.screenshot-heading');
  const privacyText = $('.privacy-banner p');
  if (privacyText) privacyText.textContent = 'Required screenshots are captured every 5 minutes while tracking is active. They stay on this device.';
  const emptyText = $('#screenshots-empty p');
  if (emptyText) emptyText.textContent = 'Start tracking to begin your private screenshot history.';
  if (heading && !$('#capture-now')) {
    const actions = document.createElement('div'); actions.className = 'capture-actions';
    actions.append($('#screenshot-total'));
    const button = document.createElement('button'); button.id = 'capture-now'; button.className = 'button button-secondary button-small'; button.textContent = 'Capture now';
    actions.append(button); heading.append(actions);
    const error = document.createElement('div'); error.id = 'capture-error'; error.className = 'capture-error'; heading.after(error);
    button.addEventListener('click', async () => { const result = await window.tracker.captureScreenshot(); if (result.ok) toast('Screenshot saved.'); else toast(result.message); });
  }
  const note = $('.settings-content .settings-panel:nth-child(2) .notice-copy');
  if (note && !$('#settings-capture-error')) { const error = document.createElement('div'); error.id = 'settings-capture-error'; error.className = 'capture-error'; note.before(error); }
}

function ensureWorkspaceUi() {
  const nav = $('.sidebar .nav');
  if (nav && !$('.nav-item[data-view="workspace"]')) {
    const item = document.createElement('button'); item.className = 'nav-item'; item.dataset.view = 'workspace'; item.innerHTML = '<span class="nav-icon">♧</span>Workspace';
    const tasks = nav.querySelector('[data-view="tasks"]'); tasks?.after(item); item.addEventListener('click', () => go('workspace'));
  }
  const content = $('.content-wrap');
  if (content && !$('#view-workspace')) {
    const section = document.createElement('section'); section.className = 'view'; section.id = 'view-workspace';
    section.innerHTML = `<div class="page-title-row"><div><div class="eyebrow"><span class="eyebrow-line"></span> WORK BETTER TOGETHER</div><h1>Workspace</h1><p class="subtitle">Invite your team and see who's in focus.</p></div></div><div class="team-invite-notice"><b>How Telegram invites work</b><p>Telegram bots cannot start a chat with someone first. Add their Telegram username, then share the invite link. They join the bot by opening the link and pressing Start.</p></div><article class="panel invite-panel"><form id="member-form" class="member-form"><label><span>NAME</span><input id="member-name" required maxlength="100" placeholder="Teammate name"></label><label><span>TELEGRAM USERNAME</span><input id="member-telegram-username" required placeholder="@teammate" autocomplete="username"></label><button class="button button-primary">＋ Add person</button></form><div id="member-form-error" class="inline-error"></div></article><div class="section-heading team-heading"><div><div class="card-kicker">YOUR PEOPLE</div><h2>Workspace members</h2></div><span id="member-count" class="capture-count">0 people</span></div><div id="workspace-members" class="member-grid"></div></section>`;
    const memberHelp = section.querySelector('.team-invite-notice'); memberHelp.id = 'member-invite-help'; memberHelp.hidden = true;
    const adminNote = document.createElement('div'); adminNote.id = 'member-admin-note'; adminNote.className = 'team-invite-notice'; adminNote.hidden = true; adminNote.innerHTML = '<b>Workspace managed by your administrator</b><p>Ask your workspace administrator to add people and manage invitations.</p>'; memberHelp.before(adminNote);
    section.querySelector('.invite-panel').id = 'member-admin-panel'; section.querySelector('.invite-panel').hidden = true;
    section.querySelector('.team-heading').id = 'member-list-heading'; section.querySelector('.team-heading').hidden = true;
    content.append(section);
    $('#member-form').addEventListener('submit', async event => {
      event.preventDefault(); const error = $('#member-form-error'); error.textContent = '';
      try {
        const member = await window.tracker.addWorkspaceMember({ name: $('#member-name').value, telegramUsername: $('#member-telegram-username').value });
        $('#member-form').reset(); await window.tracker.copyWorkspaceInvite(member.id); await renderWorkspace();
        toast(`Added ${member.name}. Share their invite link so they can join the bot.`);
      } catch (err) { error.textContent = err.message; }
    });
    $('#workspace-members').addEventListener('click', async event => {
      const invite = event.target.closest('[data-invite]');
      if (invite) { await window.tracker.copyWorkspaceInvite(invite.dataset.invite); toast('Invite link copied. Send it to this person.'); }
      const remove = event.target.closest('[data-remove-member]');
      if (remove && confirm('Remove this person from the workspace? They will no longer be able to send commands to this bot.')) { await window.tracker.removeWorkspaceMember(remove.dataset.removeMember); renderWorkspace(); }
    });
  }
}

function ensureRelayUiLegacy() {
  const view = $('#view-telegram'); if (!view || $('#relay-setup')) return;
  const panel = document.createElement('article'); panel.className = 'panel relay-setup-panel'; panel.id = 'relay-setup';
  panel.innerHTML = `<div class="eyebrow"><span class="eyebrow-line"></span> MULTI-COMPUTER TRACKING</div><h2>Connect this computer to the workspace relay</h2><p class="subtitle">The relay delivers Telegram commands to each running desktop app. Configure it once for the workspace, then pair every teammate’s computer.</p><label class="relay-field"><span>PUBLIC HTTPS RELAY URL</span><input id="relay-url" type="url" placeholder="https://your-relay.example.com"></label><div class="relay-owner-setup"><h3>Workspace owner setup</h3><p>On the owner computer, enter the relay admin token and bot token to switch this bot to the secure webhook relay.</p><div class="relay-form-grid"><label class="relay-field"><span>RELAY ADMIN TOKEN</span><input id="relay-admin-key" type="password" placeholder="From relay hosting settings"></label><label class="relay-field"><span>TELEGRAM BOT TOKEN</span><input id="relay-bot-token" type="password" placeholder="123456:ABC..."></label></div><button id="relay-configure" class="button button-primary">Connect bot to relay</button></div><div class="relay-device-pair"><h3>Pair this computer</h3><p>Each user enters their Telegram username, generates a link and opens it in Telegram to authorize this computer.</p><div class="relay-form-grid"><label class="relay-field"><span>YOUR TELEGRAM USERNAME</span><input id="relay-username" placeholder="@username" autocomplete="username"></label><div class="relay-pair-action"><button id="relay-pair-device" class="button button-secondary">Generate computer link</button><span id="relay-device-status" class="relay-device-status">Not paired</span></div></div><div class="relay-link-row" id="relay-link-row"><code id="relay-link"></code><button id="relay-copy-link" class="text-link">Copy link</button></div></div><div id="relay-message" class="relay-message"></div><div class="relay-server-note">A public Node.js relay and HTTPS domain must be deployed before these controls can connect. See <b>README.md</b> under “Remote computer relay”.</div></article>`;
  const target = view.querySelector('.telegram-setup-grid'); target.before(panel);
  $('#relay-configure').addEventListener('click', async () => {
    const button = $('#relay-configure'); button.disabled = true; $('#relay-message').textContent = 'Configuring the Telegram webhook…';
    try { const result = await window.tracker.configureRelay({ url: $('#relay-url').value, adminKey: $('#relay-admin-key').value, botToken: $('#relay-bot-token').value }); $('#relay-bot-token').value = ''; $('#relay-message').textContent = `Bot @${result.botName} is connected to the relay. Add members in Workspace, then pair each computer.`; toast('Telegram bot is using the workspace relay.'); }
    catch (error) { $('#relay-message').classList.add('error'); $('#relay-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#relay-pair-device').addEventListener('click', async () => {
    const button = $('#relay-pair-device'); button.disabled = true; $('#relay-message').textContent = 'Creating a secure computer pairing link…';
    try { await window.tracker.saveRelayAgentSettings({ url: $('#relay-url').value, username: $('#relay-username').value }); const result = await window.tracker.pairRelayDevice({}); $('#relay-link').textContent = result.inviteLink; $('#relay-link-row').classList.add('visible'); $('#relay-message').textContent = `Open this link in Telegram while signed in as @${$('#relay-username').value.replace(/^@/, '')}. The app will pair automatically after you press Start.`; }
    catch (error) { $('#relay-message').classList.add('error'); $('#relay-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#relay-copy-link').addEventListener('click', async () => { await window.tracker.copyText($('#relay-link').textContent); toast('Computer pairing link copied.'); });
}

function ensureRelayUi() {
  const view = $('#view-telegram'); if (!view || $('#relay-setup')) return;
  const panel = document.createElement('article'); panel.className = 'panel relay-setup-panel'; panel.id = 'relay-setup';
  panel.innerHTML = `<div class="eyebrow"><span class="eyebrow-line"></span> MULTI-COMPUTER TRACKING</div><h2>Connect this computer to the workspace relay</h2><p class="subtitle">Workspace management is restricted to the administrator. Teammates can pair their own computer below.</p><label class="relay-field"><span>PUBLIC HTTPS RELAY URL</span><input id="relay-url" type="url" placeholder="https://your-relay.example.com"></label><section id="relay-admin-gate" class="relay-admin-gate"><h3>Administrator access</h3><p>Enter the private relay admin token to unlock bot and workspace management.</p><div class="relay-form-grid"><label class="relay-field"><span>RELAY ADMIN TOKEN</span><input id="relay-admin-key" type="password" placeholder="Administrator token from Render" autocomplete="off"></label><div class="relay-pair-action"><button id="relay-admin-unlock" class="button button-secondary">Verify administrator</button></div></div></section><section class="relay-owner-setup" hidden><h3>Administrator controls</h3><p>Connect the workspace Telegram bot. These controls are available only after the relay verifies the administrator token.</p><label class="relay-field"><span>TELEGRAM BOT TOKEN</span><input id="relay-bot-token" type="password" placeholder="123456:ABC..." autocomplete="off"></label><button id="relay-configure" class="button button-primary">Connect bot to relay</button></section><section class="relay-device-pair"><h3>Pair this computer</h3><p>Enter your Telegram username, generate a link and open it in Telegram to authorize this computer.</p><div class="relay-form-grid"><label class="relay-field"><span>YOUR TELEGRAM USERNAME</span><input id="relay-username" placeholder="@username" autocomplete="username"></label><div class="relay-pair-action"><button id="relay-pair-device" class="button button-secondary">Generate computer link</button><span id="relay-device-status" class="relay-device-status">Not paired</span></div></div><div class="relay-link-row" id="relay-link-row"><code id="relay-link"></code><button id="relay-copy-link" class="text-link">Copy link</button></div></section><div id="relay-message" class="relay-message"></div><div class="relay-server-note">Ask your workspace administrator for the relay URL and a workspace invite before pairing.</div></article>`;
  const target = view.querySelector('.telegram-setup-grid'); target.before(panel);
  $('#relay-admin-unlock').addEventListener('click', async () => {
    const button = $('#relay-admin-unlock'); button.disabled = true; $('#relay-message').classList.remove('error'); $('#relay-message').textContent = 'Verifying administrator access…';
    try { await window.tracker.verifyRelayAdmin({ url: $('#relay-url').value, adminKey: $('#relay-admin-key').value }); $('#relay-admin-key').value = ''; $('#relay-message').textContent = 'Administrator access verified. Bot and workspace management are unlocked on this computer.'; toast('Administrator access verified.'); const state = await window.tracker.getState(); render(state); await renderWorkspace(); }
    catch (error) { $('#relay-message').classList.add('error'); $('#relay-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#relay-configure').addEventListener('click', async () => {
    const button = $('#relay-configure'); button.disabled = true; $('#relay-message').classList.remove('error'); $('#relay-message').textContent = 'Configuring the Telegram webhook…';
    try { const result = await window.tracker.configureRelay({ url: $('#relay-url').value, botToken: $('#relay-bot-token').value }); $('#relay-bot-token').value = ''; $('#relay-message').textContent = `Bot @${result.botName} is connected to the relay. Add people from Workspace.`; toast('Telegram bot connected to the relay.'); await renderWorkspace(); }
    catch (error) { $('#relay-message').classList.add('error'); $('#relay-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#relay-pair-device').addEventListener('click', async () => {
    const button = $('#relay-pair-device'); button.disabled = true; $('#relay-message').classList.remove('error'); $('#relay-message').textContent = 'Creating a secure computer pairing link…';
    try { await window.tracker.saveRelayAgentSettings({ url: $('#relay-url').value, username: $('#relay-username').value }); const result = await window.tracker.pairRelayDevice({}); $('#relay-link').textContent = result.inviteLink; $('#relay-link-row').classList.add('visible'); $('#relay-message').textContent = `Open this link in Telegram while signed in as @${$('#relay-username').value.replace(/^@/, '')}. Press Start to pair this computer.`; }
    catch (error) { $('#relay-message').classList.add('error'); $('#relay-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#relay-copy-link').addEventListener('click', async () => { await window.tracker.copyText($('#relay-link').textContent); toast('Computer pairing link copied.'); });
}

async function renderWorkspace() {
  if (!$('#view-workspace')) return;
  const isAdmin = !!appState?.relay?.adminReady;
  $('#member-admin-note').hidden = isAdmin; $('#member-invite-help').hidden = !isAdmin; $('#member-admin-panel').hidden = !isAdmin; $('#member-list-heading').hidden = !isAdmin;
  if (!isAdmin) { $('#workspace-members').innerHTML = ''; $('#member-count').textContent = 'Administrator only'; return; }
  if (workspaceRefreshing) return;
  workspaceRefreshing = true;
  let members;
  try { members = await window.tracker.listWorkspaceMembers(); }
  catch (error) { $('#member-form-error').textContent = error.message; return; }
  finally { workspaceRefreshing = false; }
  const host = $('#workspace-members');
  $('#member-count').textContent = `${members.length} ${members.length === 1 ? 'person' : 'people'}`;
  host.innerHTML = members.map(member => {
    const initial = escapeHtml((member.name || '?').trim()[0] || '?'); const pending = member.status === 'pending' || member.invitePending;
    const statusLabel = pending ? 'Invite pending' : member.status === 'online' ? 'Online' : 'Offline';
    const seen = member.status === 'online' ? 'Active now' : pending ? 'Waiting for invite acceptance' : member.deviceOnline === false ? (member.paired ? 'Computer paired · Task Tracker is not running' : 'Computer not paired') : member.lastSeen ? `Last active ${new Date(member.lastSeen).toLocaleString()}` : 'Not tracking';
    const hours = Math.floor(member.totalSeconds / 3600); const minutes = Math.floor(member.totalSeconds % 3600 / 60);
    return `<article class="member-card"><div class="member-card-top"><div class="member-avatar-wrap">${member.photo ? `<img class="member-photo" src="${member.photo}" alt="${escapeHtml(member.name)}">` : `<div class="member-avatar">${initial}</div>`}<span class="member-presence ${member.status === 'online' ? 'online' : pending ? 'pending' : ''}"></span></div><div class="member-main"><b>${escapeHtml(member.name)}${member.isOwner ? ' <span class="owner-label">YOU</span>' : ''}</b><small>${member.isOwner ? 'Workspace owner' : `Telegram · @${escapeHtml(member.telegramUsername || 'username unavailable')}`}</small></div><span class="member-status ${member.status}">${statusLabel}</span></div><div class="member-detail"><span>${seen}</span><span>${hours}h ${String(minutes).padStart(2, '0')}m tracked</span></div>${member.isOwner ? '' : `<div class="member-actions">${pending ? `<button class="text-link" data-invite="${member.id}">Copy invite link →</button>` : '<span class="member-linked">Telegram connected</span>'}<button class="member-delete" data-remove-member="${member.id}" title="Remove person">Delete</button></div>`}</article>`;
  }).join('') || '<div class="empty-state show"><div class="empty-illustration">♧</div><h3>Your team starts here.</h3><p>Add a teammate with their Telegram username to invite them.</p></div>';
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
}
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function go(view) {
  if (!document.querySelector(`#view-${view}`)) return;
  $$('.view').forEach(node => node.classList.toggle('active', node.id === `view-${view}`));
  $$('.nav-item[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  const labels = { overview: 'Overview', tasks: 'My tasks', screenshots: 'Screenshots', reports: 'Reports', telegram: 'Telegram', settings: 'Settings', workspace: 'Workspace' };
  $('#breadcrumb-current').textContent = labels[view] || 'Overview';
  if (view === 'screenshots') renderScreenshots();
  if (view === 'tasks') renderTasks();
  if (view === 'reports') renderReports();
  if (view === 'workspace') renderWorkspace();
}
function fmt(n) { return String(n).padStart(2, '0'); }
function prettyDate(date) { return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function setTimer(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  $('#clock-h').textContent = fmt(h); $('#clock-m').textContent = fmt(m); $('#clock-s').textContent = fmt(s);
  $('#stat-time').innerHTML = `${h}h <small>${fmt(m)}m</small>`;
  $('#time-progress').style.width = `${Math.min(100, seconds / 28800 * 100)}%`;
  $('#report-hours').innerHTML = `${h}<span>h</span> ${fmt(m)}<span>m</span>`;
}
function render(state) {
  const nextWorkspaceKey = JSON.stringify({ tracking: state.tracking.active, adminReady: !!state.relay?.adminReady, members: (state.members || []).map(member => [member.id, member.status, member.lastSeen, member.name, member.telegramUsername]) });
  const workspaceChanged = nextWorkspaceKey !== workspaceStatusKey; workspaceStatusKey = nextWorkspaceKey;
  appState = state;
  const name = state.profile.name || 'Alex Morgan';
  const first = name.trim().split(/\s+/)[0] || 'there';
  $('#welcome-title').innerHTML = `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${escapeHtml(first)} <span class="wave">✳</span>`;
  $('#side-name').textContent = name; $('#side-email').textContent = state.profile.email || 'Personal workspace';
  $('#mini-avatar').textContent = first[0].toUpperCase(); $('#top-avatar').textContent = first[0].toUpperCase();
  const active = state.tracking.active;
  $('#status-pill').textContent = active ? 'Tracking' : 'Paused'; $('#status-pill').classList.toggle('live', active);
  $('#status-message').textContent = active ? 'Your focus time is being recorded' : 'Ready when you are';
  $('#session-label').textContent = active ? `Session started ${new Date(state.tracking.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Start tracking to begin your work session';
  $('#live-indicator').style.opacity = active ? '1' : '.45';
  $('#tracking-toggle').classList.toggle('stop', active); $('#tracking-icon').textContent = active ? '■' : '▶'; $('#tracking-text').textContent = active ? 'Stop tracking' : 'Start tracking';
  const seconds = state.tracking.activeSeconds || 0; setTimer(seconds);
  const tasks = state.tasks || [], open = tasks.filter(t => t.status !== 'Completed'), done = tasks.filter(t => t.status === 'Completed');
  $('#focus-open').textContent = open.length; $('#focus-done').textContent = done.length;
  $('#stat-open').textContent = open.length; $('#stat-completed').textContent = done.length;
  $('#nav-task-count').textContent = open.length;
  $('#stat-screenshots').textContent = state.screenshots.length;
  $('#capture-foot').textContent = state.preferences.screenshots ? 'Captured during tracked time' : 'Disabled in settings';
  $('#focus-task').textContent = open[0]?.title || 'Add your first task';
  $('#telegram-status').textContent = state.telegram.connected ? 'CONNECTED' : state.telegram.botName ? 'BOT READY · NOT PAIRED' : 'NOT CONNECTED';
  $('#telegram-nav-dot').classList.toggle('connected', state.telegram.connected);
  $('#pair-button').disabled = !state.telegram.botName;
  $('#connected-message').textContent = state.telegram.connected ? `✓ Connected as ${state.telegram.botName}. Telegram commands are ready.` : '';
  $('#telegram-error').textContent = state.telegram.error ? `Telegram polling failed: ${state.telegram.error}` : '';
  if (document.activeElement !== $('#profile-name')) $('#profile-name').value = state.profile.name || '';
  if (document.activeElement !== $('#profile-email')) $('#profile-email').value = state.profile.email || '';
  if (document.activeElement !== $('#profile-role')) $('#profile-role').value = state.profile.role || '';
  ensureCaptureUi();
  ensureWorkspaceUi();
  ensureRelayUi();
  const adminReady = !!state.relay?.adminReady;
  $('#relay-admin-gate').hidden = adminReady;
  $('.relay-owner-setup').hidden = !adminReady;
  const localTelegramSetup = $('#view-telegram .telegram-setup-grid'); if (localTelegramSetup) localTelegramSetup.hidden = !!state.relay?.url || !adminReady;
  if (!$('#relay-url').value && state.relay?.url) $('#relay-url').value = state.relay.url;
  if (!$('#relay-username').value && state.relay?.username) $('#relay-username').value = `@${state.relay.username}`;
  $('#relay-device-status').textContent = state.relay?.agentToken ? 'This computer is paired' : state.relay?.pendingCode ? 'Waiting for Telegram confirmation…' : 'Not paired';
  if (workspaceChanged && $('#view-workspace')?.classList.contains('active')) renderWorkspace();
  const captureError = state.preferences.captureError || '';
  if ($('#capture-error')) $('#capture-error').textContent = captureError;
  if ($('#settings-capture-error')) $('#settings-capture-error').textContent = captureError;
  renderRecent(); renderTasks(); renderReports();
  if (!state.profile.name) setTimeout(() => { if (!$('#view-settings').classList.contains('active')) go('settings'); }, 300);
}
function renderRecent() {
  const items = appState.tasks.slice(0, 4); const host = $('#recent-tasks');
  host.innerHTML = items.length ? items.map(t => `<div class="recent-item"><button class="task-check ${t.status === 'Completed' ? 'done' : ''}" data-complete="${t.id}" title="Toggle complete">✓</button><div class="recent-copy"><div class="recent-task-name">${escapeHtml(t.title)}</div><div class="recent-task-meta">Added ${prettyDate(t.createdAt)}</div></div><span class="task-source">${escapeHtml(t.source)}</span></div>`).join('') : '<div class="recent-empty">Your task list is a clean slate. Add something to get started.</div>';
}
function renderTasks() {
  if (!appState) return;
  const search = ($('#task-search')?.value || '').toLowerCase();
  const all = appState.tasks;
  const filtered = all.filter(t => (currentFilter === 'All' || t.status === currentFilter) && `${t.title} ${t.note}`.toLowerCase().includes(search));
  $('#all-count').textContent = all.length; $('#progress-count').textContent = all.filter(t => t.status === 'In progress').length; $('#complete-count').textContent = all.filter(t => t.status === 'Completed').length;
  const host = $('#task-list'); host.innerHTML = filtered.map(t => `<article class="task-row"><button class="task-check ${t.status === 'Completed' ? 'done' : ''}" data-complete="${t.id}" title="Toggle complete">✓</button><div class="task-row-content"><div class="task-row-title ${t.status === 'Completed' ? 'completed' : ''}">${escapeHtml(t.title)}</div>${t.note ? `<div class="task-row-note">${escapeHtml(t.note)}</div>` : ''}</div><span class="task-row-date">${prettyDate(t.createdAt)}</span><span class="task-status ${t.status === 'Completed' ? 'completed' : ''}">${t.status}</span><button class="row-menu" data-delete="${t.id}" title="Delete task">···</button></article>`).join('');
  $('#task-empty').classList.toggle('show', filtered.length === 0);
  host.style.display = filtered.length ? 'grid' : 'none';
}
function renderReports() {
  if (!appState) return;
  const tasks = appState.tasks; $('#report-done').textContent = tasks.filter(t => t.status === 'Completed').length; $('#report-total').textContent = tasks.length;
  $('#report-table').innerHTML = tasks.length ? tasks.map(t => `<tr><td>${escapeHtml(t.title)}</td><td><span class="task-status ${t.status === 'Completed' ? 'completed' : ''}">${t.status}</span></td><td>${new Date(t.createdAt).toLocaleDateString()}</td><td>${escapeHtml(t.source)}</td></tr>`).join('') : '<tr><td colspan="4">No work recorded yet. Your next task is a great place to start.</td></tr>';
  renderDailyReport();
  renderWeeklyReport();
}
function renderDailyReport() {
  const panel = $('.report-table-panel'); if (!panel) return;
  let section = $('#daily-report-section');
  if (!section) {
    section = document.createElement('section'); section.id = 'daily-report-section'; section.className = 'weekly-report-section daily-report-section';
    section.innerHTML = '<div class="weekly-title-row"><div><div class="card-kicker">TODAY</div><h2>Daily report</h2><p id="daily-range" class="subtitle"></p></div><button id="export-daily-pdf" class="button button-secondary button-small">↓ &nbsp;Download daily PDF</button></div><div class="weekly-metrics"><article class="weekly-metric"><span>TRACKED TIME</span><b id="daily-time">0h 00m</b></article><article class="weekly-metric"><span>TASKS ADDED</span><b id="daily-added">0</b></article><article class="weekly-metric"><span>TASKS COMPLETED</span><b id="daily-completed">0</b></article></div><div class="weekly-tasks"><h3>Today’s tasks</h3><div class="table-wrap"><table><thead><tr><th>TASK</th><th>STATUS</th><th>ADDED</th><th>SOURCE</th></tr></thead><tbody id="daily-task-table"></tbody></table></div></div>';
    const weeklySection = $('#weekly-report-section'); (weeklySection || panel).before(section);
    $('#export-daily-pdf').addEventListener('click', async () => { try { if (await window.tracker.exportDailyPdf()) toast('Daily report PDF saved.'); } catch (error) { toast(error.message); } });
  }
  const start = new Date(); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 1); const now = new Date();
  const sessions = [...(appState.sessions || []), ...(appState.members || []).flatMap(member => member.sessions || [])];
  if (appState.tracking.active && appState.tracking.since) sessions.push({ startedAt: appState.tracking.since, endedAt: now.toISOString() });
  for (const member of appState.members || []) if (member.status === 'online' && member.startedAt) sessions.push({ startedAt: new Date(member.startedAt).toISOString(), endedAt: now.toISOString() });
  const seconds = sessions.reduce((total, session) => { const from = Math.max(start.getTime(), new Date(session.startedAt).getTime()); const to = Math.min(end.getTime(), new Date(session.endedAt).getTime()); return total + Math.max(0, Math.floor((to - from) / 1000)); }, 0);
  const tasks = appState.tasks.filter(task => new Date(task.createdAt) >= start && new Date(task.createdAt) < end);
  const completed = appState.tasks.filter(task => task.completedAt && new Date(task.completedAt) >= start && new Date(task.completedAt) < end);
  $('#daily-range').textContent = start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('#daily-time').textContent = `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
  $('#daily-added').textContent = tasks.length; $('#daily-completed').textContent = completed.length;
  $('#daily-task-table').innerHTML = tasks.length ? tasks.map(task => `<tr><td>${escapeHtml(task.title)}</td><td><span class="task-status ${task.status === 'Completed' ? 'completed' : ''}">${task.status}</span></td><td>${new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td>${escapeHtml(task.source)}</td></tr>`).join('') : '<tr><td colspan="4">No tasks added today.</td></tr>';
}
function weekRange() {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(end.getDate() + 7); return { start, end };
}
function renderWeeklyReport() {
  const panel = $('.report-table-panel'); if (!panel) return;
  let section = $('#weekly-report-section');
  if (!section) {
    section = document.createElement('section'); section.id = 'weekly-report-section'; section.className = 'weekly-report-section';
    section.innerHTML = '<div class="weekly-title-row"><div><div class="card-kicker">END OF WEEK</div><h2>Weekly report</h2><p id="week-range" class="subtitle"></p></div><button id="export-weekly-pdf" class="button button-secondary button-small">↓ &nbsp;Export weekly PDF</button></div><div class="weekly-metrics"><article class="weekly-metric"><span>TRACKED TIME</span><b id="week-time">0h 00m</b></article><article class="weekly-metric"><span>TASKS ADDED</span><b id="week-added">0</b></article><article class="weekly-metric"><span>TASKS COMPLETED</span><b id="week-completed">0</b></article></div><div class="weekly-days" id="weekly-days"></div><div class="weekly-tasks"><h3>This week’s tasks</h3><div class="table-wrap"><table><thead><tr><th>TASK</th><th>STATUS</th><th>ADDED</th><th>SOURCE</th></tr></thead><tbody id="weekly-task-table"></tbody></table></div></div>';
    panel.before(section);
    $('#export-weekly-pdf').addEventListener('click', async () => { try { if (await window.tracker.exportWeeklyPdf()) toast('Weekly report PDF saved.'); } catch (error) { toast(error.message); } });
  }
  const { start, end } = weekRange(); const now = new Date(); const clippedEnd = new Date(Math.min(now.getTime(), end.getTime()));
  const sessions = [...(appState.sessions || []), ...(appState.members || []).flatMap(member => member.sessions || [])];
  if (appState.tracking.active && appState.tracking.since) sessions.push({ startedAt: appState.tracking.since, endedAt: now.toISOString() });
  for (const member of appState.members || []) if (member.status === 'online' && member.startedAt) sessions.push({ startedAt: new Date(member.startedAt).toISOString(), endedAt: now.toISOString() });
  const secondsIn = (from, to) => sessions.reduce((total, session) => { const a = Math.max(from.getTime(), new Date(session.startedAt).getTime()); const b = Math.min(to.getTime(), new Date(session.endedAt).getTime()); return total + Math.max(0, Math.floor((b - a) / 1000)); }, 0);
  const total = secondsIn(start, clippedEnd); const added = appState.tasks.filter(task => new Date(task.createdAt) >= start && new Date(task.createdAt) < end);
  const completed = appState.tasks.filter(task => task.completedAt && new Date(task.completedAt) >= start && new Date(task.completedAt) < end);
  $('#week-range').textContent = `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(end.getTime() - 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  $('#week-time').textContent = `${Math.floor(total / 3600)}h ${String(Math.floor(total % 3600 / 60)).padStart(2, '0')}m`;
  $('#week-added').textContent = added.length; $('#week-completed').textContent = completed.length;
  $('#weekly-days').innerHTML = Array.from({ length: 7 }, (_, i) => { const day = new Date(start); day.setDate(start.getDate() + i); const next = new Date(day); next.setDate(day.getDate() + 1); const secs = secondsIn(day, next); return `<div class="week-day"><span>${day.toLocaleDateString(undefined, { weekday: 'short' })}</span><div class="week-bar"><i data-width="${Math.min(100, secs / 28800 * 100)}"></i></div><b>${secs ? `${Math.floor(secs / 3600)}h ${String(Math.floor(secs % 3600 / 60)).padStart(2, '0')}m` : '—'}</b></div>`; }).join('');
  $('#weekly-days').querySelectorAll('.week-bar i').forEach(bar => { bar.style.width = `${bar.dataset.width}%`; });
  $('#weekly-task-table').innerHTML = added.length ? added.map(task => `<tr><td>${escapeHtml(task.title)}</td><td><span class="task-status ${task.status === 'Completed' ? 'completed' : ''}">${task.status}</span></td><td>${new Date(task.createdAt).toLocaleDateString()}</td><td>${escapeHtml(task.source)}</td></tr>`).join('') : '<tr><td colspan="4">No tasks added this week.</td></tr>';
}
async function renderScreenshots() {
  const items = await window.tracker.getScreenshots(); const grid = $('#screenshot-grid');
  $('#screenshot-total').textContent = `${items.length} capture${items.length === 1 ? '' : 's'}`;
  $('#screenshots-empty').classList.toggle('show', !items.length); grid.style.display = items.length ? 'grid' : 'none';
  grid.innerHTML = items.map(item => `<article class="screenshot-card"><div class="screenshot-thumb" data-image="${item.id}">◷</div><div class="screenshot-card-info"><span>${new Date(item.capturedAt).toLocaleString()}</span><button data-open-shot="${item.id}">Open ↗</button></div></article>`).join('');
  for (const item of items) { const node = grid.querySelector(`[data-image="${item.id}"]`); const image = await window.tracker.getScreenshotImage(item.id); if (node && image) { node.innerHTML = ''; const img = document.createElement('img'); img.src = image; img.alt = `Screenshot captured ${new Date(item.capturedAt).toLocaleString()}`; img.className = 'screenshot-image'; node.append(img); } }
}
function openModal(id) { $(`#${id}`).classList.add('show'); }
function closeModal(id) { $(`#${id}`).classList.remove('show'); }
$$('[data-view]').forEach(node => node.addEventListener('click', () => go(node.dataset.view)));
$$('[data-close]').forEach(node => node.addEventListener('click', () => closeModal(node.dataset.close)));
$('#quick-add').addEventListener('click', () => openModal('task-modal'));
$('#add-task-button').addEventListener('click', () => openModal('task-modal'));
$('#empty-add').addEventListener('click', () => openModal('task-modal'));
$('#task-form').addEventListener('submit', async e => { e.preventDefault(); const data = { title: $('#new-task-title').value, note: $('#new-task-note').value }; if (await window.tracker.addTask(data)) { e.target.reset(); closeModal('task-modal'); toast('Task added to your list.'); } });
document.addEventListener('click', async e => {
  const complete = e.target.closest('[data-complete]');
  if (complete) { const item = appState.tasks.find(t => t.id === complete.dataset.complete); await window.tracker.updateTask(item.id, { status: item.status === 'Completed' ? 'In progress' : 'Completed' }); }
  const del = e.target.closest('[data-delete]'); if (del && confirm('Delete this task?')) { await window.tracker.deleteTask(del.dataset.delete); toast('Task deleted.'); }
  const shot = e.target.closest('[data-open-shot]'); if (shot) await window.tracker.openScreenshot(shot.dataset.openShot);
});
$$('.task-filter').forEach(btn => btn.addEventListener('click', () => { currentFilter = btn.dataset.filter; $$('.task-filter').forEach(x => x.classList.toggle('selected', x === btn)); renderTasks(); }));
$('#task-search').addEventListener('input', renderTasks);
$('#tracking-toggle').addEventListener('click', async () => { if (appState.tracking.active) await window.tracker.stop(); else await window.tracker.start(); });
$('#save-settings').addEventListener('click', async () => {
  await window.tracker.saveProfile({ name: $('#profile-name').value, email: $('#profile-email').value, role: $('#profile-role').value });
  await window.tracker.setPreferences({ screenshots: true, intervalMinutes: 5 });
  toast('Your workspace is up to date.');
});
$('#register-form').addEventListener('submit', async e => { e.preventDefault(); const profile = { name: $('#register-name').value, email: $('#register-email').value, role: $('#register-role').value || 'Team member' }; await window.tracker.saveProfile(profile); closeModal('register-modal'); toast(`Welcome, ${profile.name.trim().split(/\s+/)[0]}! Your workspace is ready.`); });
$('#save-bot').addEventListener('click', async () => { const btn = $('#save-bot'); btn.disabled = true; $('#bot-message').textContent = 'Connecting securely…'; try { const result = await window.tracker.telegramSave({ token: $('#bot-token').value }); $('#bot-token').value = ''; $('#bot-message').textContent = `✓ Connected to @${result.botName}. Generate your pairing code below.`; toast('Telegram bot connected.'); } catch (err) { $('#bot-message').textContent = err.message; } finally { btn.disabled = false; } });
$('#pair-button').addEventListener('click', async () => { try { const data = await window.tracker.telegramPair(); $('#pair-code').textContent = data.code; $('#connected-message').textContent = `Open t.me/${data.botName} and send: /start ${data.code}`; } catch (err) { toast(err.message); } });
$('#disconnect-telegram').addEventListener('click', async () => { if (confirm('Disconnect your Telegram bot from this workspace?')) { await window.tracker.telegramDisconnect(); $('#pair-code').textContent = '— — — — — —'; $('#bot-message').textContent = ''; toast('Telegram disconnected.'); } });
$('#export-pdf').addEventListener('click', async () => { try { const result = await window.tracker.exportPdf(); if (result) toast('Your PDF report is saved.'); } catch (err) { toast(err.message); } });
$('#email-report').addEventListener('click', () => openModal('email-modal'));
$('#email-form').addEventListener('submit', async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.target).entries()); const button = e.target.querySelector('button[type="submit"],button:not([type])'); button.disabled = true; button.textContent = 'Sending…'; try { await window.tracker.sendEmail(data); closeModal('email-modal'); e.target.reset(); toast('Your report has been sent.'); } catch (err) { toast(err.message); } finally { button.disabled = false; button.textContent = 'Send report'; } });
function addChat(text, who) { const node = document.createElement('div'); node.className = `chat-message ${who === 'user' ? 'user-message' : 'bot-message'}`; const body = document.createTextNode(text); const time = document.createElement('span'); time.textContent = 'just now'; node.append(body, time); $('#chat-messages').append(node); $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; }
$('#chat-form').addEventListener('submit', async e => { e.preventDefault(); const input = $('#chat-question'); const question = input.value.trim(); if (!question) return; addChat(question, 'user'); input.value = ''; addChat(await window.tracker.askAssistant(question), 'bot'); });
$$('.suggestion').forEach(button => button.addEventListener('click', async () => { addChat(button.textContent, 'user'); addChat(await window.tracker.askAssistant(button.textContent), 'bot'); }));
$('#top-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
$('#footer-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
window.tracker.onUpdate(render);
setInterval(() => { if ($('#view-workspace')?.classList.contains('active') && appState?.relay?.adminReady) renderWorkspace(); }, 5000);
window.tracker.onCapture(notice => { if (notice.phase === 'started') toast('Screenshot capture is starting now.'); else { if ($('#view-screenshots').classList.contains('active')) renderScreenshots(); toast('A screenshot was saved to your private work journal.'); } });
window.tracker.getState().then(state => { render(state); if (!state.profile.name) openModal('register-modal'); }).catch(err => toast(err.message));
