/**
 * Sessions tab — everywhere you're connected, with the ability to sign things
 * out. Two kinds, both self-scoped (no elevation needed to manage your own):
 *   - Console logins   GET /me/security/sessions  (browser sessions)
 *   - Connected apps   GET /me/sessions           (MCP clients, streamable-http)
 *
 * Look/feel stays on the Atelier tokens like the rest of the console. Each row
 * shows a friendly identity, activity recency, current/elevated badges, a revoke
 * action, and a "View logs" jump that filters the Logs tab to that session
 * (console session_ids map to the log entries' `web-console:<id>` form).
 */

import { get, post, del } from './api.js';

let host;
let notify = () => {};
let viewLogs = null; // ctx.viewSessionLogs(logSessionId) — set by the shell

const state = { console: [], mcp: [], loading: true, error: false };

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  viewLogs = ctx.viewSessionLogs || null;
  host.innerHTML = shell();
  host.querySelector('#sess-refresh').addEventListener('click', load);
  host.querySelector('#sess-revoke-others').addEventListener('click', signOutEverywhereElse);
  await load();
  // Re-fetch when the user returns to the tab (sessions drift over time).
  globalThis.addEventListener('dh:tab-activated', (e) => { if (e.detail?.name === 'sessions') load(); });
}

/* ── Data ───────────────────────────────────────────────────────────────── */

async function load() {
  state.loading = true;
  state.error = false;
  renderBody();
  const [sec, mcp] = await Promise.all([
    get('/me/security/sessions').catch(() => null),
    get('/me/sessions').catch(() => null),
  ]);
  state.console = sec?.status === 200 && Array.isArray(sec.body?.sessions) ? sec.body.sessions : [];
  state.mcp = mcp?.status === 200 && Array.isArray(mcp.body) ? mcp.body : [];
  state.error = !sec || sec.status !== 200;
  state.loading = false;
  renderBody();
}

/* ── Markup ─────────────────────────────────────────────────────────────── */

function shell() {
  return `
  <div class="sessions-bar">
    <span class="sessions-title">Sessions</span>
    <div class="sessions-bar-actions">
      <button class="btn btn-ghost" id="sess-refresh" type="button">&#x21bb; Refresh</button>
      <button class="btn btn-ghost session-danger" id="sess-revoke-others" type="button">Sign out everywhere else</button>
    </div>
  </div>
  <div id="sessions-body"></div>`;
}

function renderBody() {
  const body = host.querySelector('#sessions-body');
  if (!body) return;
  if (state.loading) { body.innerHTML = '<div class="panel-placeholder">Loading sessions…</div>'; return; }
  if (state.error) { body.innerHTML = '<div class="panel-placeholder">Couldn\'t load your sessions.</div>'; return; }

  body.innerHTML = `
    <section class="session-section">
      <h3 class="session-section-title">This console <span class="session-count">${state.console.length}</span></h3>
      <p class="session-section-sub">Browser sessions signed in to this console.</p>
      <div class="session-list">${state.console.map(consoleCard).join('') || emptyRow('No console sessions.')}</div>
    </section>
    <section class="session-section">
      <h3 class="session-section-title">Connected apps <span class="session-count">${state.mcp.length}</span></h3>
      <p class="session-section-sub">MCP clients connected to your account (Claude Desktop, Claude Code, …).</p>
      <div class="session-list">${state.mcp.map(mcpCard).join('') || emptyRow('No connected apps.')}</div>
    </section>`;

  body.querySelectorAll('[data-revoke-console]').forEach(b =>
    b.addEventListener('click', () => revokeConsole(b.dataset.revokeConsole, b.dataset.current === '1')));
  body.querySelectorAll('[data-disconnect-mcp]').forEach(b =>
    b.addEventListener('click', () => disconnectMcp(b.dataset.disconnectMcp)));
  body.querySelectorAll('[data-logs-console]').forEach(b =>
    b.addEventListener('click', () => jumpToLogs('web-console:' + b.dataset.logsConsole)));
  body.querySelectorAll('[data-logs-mcp]').forEach(b =>
    b.addEventListener('click', () => jumpToLogs(b.dataset.logsMcp)));
  body.querySelectorAll('[data-copy-id]').forEach(b =>
    b.addEventListener('click', () => copyId(b.dataset.copyId)));
}

function copyId(id) {
  if (!id) return;
  navigator.clipboard?.writeText(id)
    .then(() => notify('Session ID copied.', 'success'))
    .catch(() => notify('Could not copy.', 'warn'));
}

function consoleCard(s) {
  const current = s.current === true;
  const elevated = s.elevated_until && new Date(s.elevated_until).getTime() > Date.now();
  const badges = [
    current ? '<span class="session-badge session-badge--you">This device</span>' : '',
    elevated ? '<span class="session-badge session-badge--admin">&#x2b06; Admin</span>' : '',
    recencyBadge(s.last_used_at),
  ].join('');
  return `
    <div class="session-card${current ? ' session-card--current' : ''}">
      <span class="session-icon" aria-hidden="true">&#x1f5a5;</span>
      <div class="session-main">
        <div class="session-id-line">${escapeHtml(describeBrowser(s.user_agent))}${s.last_ip ? ` · <span class="session-ip">${escapeHtml(s.last_ip)}</span>` : ''}</div>
        <div class="session-sub">signed in ${relAgo(s.created_at)} · last used ${relAgo(s.last_used_at)}</div>
        ${sidLine(s.session_id)}
      </div>
      <div class="session-badges">${badges}</div>
      <div class="session-actions">
        <button class="btn btn-ghost session-link" data-logs-console="${escapeHtml(s.session_id)}" type="button">View logs</button>
        <button class="btn btn-ghost session-danger" data-revoke-console="${escapeHtml(s.session_id)}" data-current="${current ? '1' : '0'}" type="button">Sign out</button>
      </div>
    </div>`;
}

function mcpCard(s) {
  const version = s.client_info?.version ? ' ' + s.client_info.version : '';
  const name = s.client_info?.name
    ? `${s.client_info.name}${version}`
    : 'MCP client';
  return `
    <div class="session-card">
      <span class="session-icon" aria-hidden="true">&#x1f50c;</span>
      <div class="session-main">
        <div class="session-id-line">${escapeHtml(name)}</div>
        <div class="session-sub">connected ${relAgo(s.created_at)} · last active ${relAgo(s.last_active_at)}${usageFragment(s)}</div>
        ${sidLine(s.session_id)}
      </div>
      <div class="session-badges">${recencyBadge(s.last_active_at)}</div>
      <div class="session-actions">
        <button class="btn btn-ghost session-link" data-logs-mcp="${escapeHtml(s.session_id)}" type="button">View logs</button>
        <button class="btn btn-ghost session-danger" data-disconnect-mcp="${escapeHtml(s.session_id)}" type="button">Disconnect</button>
      </div>
    </div>`;
}

function emptyRow(text) {
  return `<div class="session-empty">${escapeHtml(text)}</div>`;
}

// Per-session request/error counts (from the presence row). Requests always
// shown; errors only when non-zero, emphasized.
function usageFragment(s) {
  const requests = Number(s.request_count || 0);
  const errors = Number(s.error_count || 0);
  const reqText = ` · ${requests.toLocaleString()} request${requests === 1 ? '' : 's'}`;
  const errSuffix = errors === 1 ? '' : 's';
  const errText = errors > 0 ? ` · <span class="session-err">${errors.toLocaleString()} error${errSuffix}</span>` : '';
  return reqText + errText;
}

// The full session ID — small and muted, click to copy. It's the value you'd
// match against log entries, so it's worth surfacing even though it's long.
function sidLine(id) {
  const v = escapeHtml(id);
  return `<button class="session-sid" type="button" data-copy-id="${v}" title="Click to copy"><span class="session-sid-key">ID</span> ${v}</button>`;
}

/* ── Actions ────────────────────────────────────────────────────────────── */

async function revokeConsole(sessionId, isCurrent) {
  const ok = await confirmDialog(
    isCurrent
      ? 'Sign out of this device? You\'ll be returned to the login screen.'
      : 'Sign out this console session?',
    'Sign out');
  if (!ok) return;
  const res = await del('/me/security/sessions/' + encodeURIComponent(sessionId)).catch(() => null);
  if (!res || (res.status !== 200 && res.status !== 204)) { notify('Could not sign out that session.', 'error'); return; }
  if (isCurrent || res.body?.current_session_revoked) { globalThis.location.href = '/ui'; return; }
  notify('Signed out.', 'success');
  await load();
}

async function disconnectMcp(sessionId) {
  const ok = await confirmDialog('Disconnect this app? It will need to reconnect to use your account.', 'Disconnect');
  if (!ok) return;
  const res = await del('/me/sessions/' + encodeURIComponent(sessionId)).catch(() => null);
  if (!res || (res.status !== 202 && res.status !== 200)) { notify('Could not disconnect that app.', 'error'); return; }
  notify('Disconnect requested.', 'info');
  setTimeout(load, 900); // termination is async (202 accepted)
}

async function signOutEverywhereElse() {
  const ok = await confirmDialog(
    'Sign out of all your other console sessions and disconnect all connected apps? This device stays signed in.',
    'Sign out others');
  if (!ok) return;
  let consoleRevoked = 0;
  let appsDisconnected = 0;
  const [c, m] = await Promise.all([
    post('/me/security/sessions/revoke-all-others').catch(() => null),
    post('/me/sessions/revoke-all').catch(() => null),
  ]);
  if (c?.status === 200) consoleRevoked = Number(c.body?.revoked ?? 0);
  if (m && (m.status === 202 || m.status === 200)) appsDisconnected = Number(m.body?.requested ?? 0);
  notify(`Signed out ${consoleRevoked} other session(s); disconnected ${appsDisconnected} app(s).`, 'success');
  setTimeout(load, 900);
}

function jumpToLogs(logSessionId) {
  if (viewLogs) viewLogs(logSessionId);
  else notify('Logs are unavailable right now.', 'warn');
}

/* ── Confirm dialog (Atelier-styled) ─────────────────────────────────────── */

function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    document.getElementById('confirm-modal')?.remove();
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-backdrop"></div>
      <div class="confirm-card" role="dialog" aria-modal="true">
        <p class="confirm-msg">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" data-confirm="0" type="button">Cancel</button>
          <button class="btn btn-primary" data-confirm="1" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const done = (val) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    modal.querySelector('.confirm-backdrop').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="0"]').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="1"]').addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey);
  });
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const ACTIVE_WINDOW_MS = 90_000;

function recencyBadge(ts) {
  const rel = relAgo(ts);
  const active = ts && (Date.now() - new Date(ts).getTime()) < ACTIVE_WINDOW_MS;
  return `<span class="session-badge${active ? ' session-badge--active' : ''}">${active ? '&#x25cf; active' : escapeHtml(rel)}</span>`;
}

function relAgo(ts) {
  if (!ts) return 'unknown';
  const age = Date.now() - new Date(ts).getTime();
  if (age < 0 || age < 60_000) return 'just now';
  const m = Math.floor(age / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Friendly browser/OS from a user-agent string (best-effort, display only).
function matchLabel(text, table, fallback) {
  for (const [pattern, label] of table) {
    if (pattern.test(text)) return label;
  }
  return fallback;
}

function describeBrowser(ua) {
  if (!ua) return 'Console session';
  const browser = matchLabel(ua, [
    [/Edg\//, 'Edge'],
    [/Chrome\//, 'Chrome'],
    [/Firefox\//, 'Firefox'],
    [/Safari\//, 'Safari'],
  ], 'Browser');
  const os = matchLabel(ua, [
    [/Windows/, 'Windows'],
    [/Mac OS X|Macintosh/, 'macOS'],
    [/Android/, 'Android'],
    [/iPhone|iPad|iOS/, 'iOS'],
    [/Linux/, 'Linux'],
  ], '');
  return os ? `${browser} on ${os}` : browser;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
