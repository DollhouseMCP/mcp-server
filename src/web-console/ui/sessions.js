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
import { noConsoleRoute } from './console-meta.js';
import { createSessionDetail } from './session-detail.js';
import { isAbortError, pollUntilTerminal } from './polling.js';
import { confirmDialog, escapeHtml, relAgo } from './ui-utils.js';

// app.js memoizes each tab's load/init promise, so this module is mounted once
// per page. Module-level state and the global listener intentionally share that
// same page lifetime.
let host;
let notify = () => {};
let viewLogs = null; // ctx.viewSessionLogs(logSessionId) — set by the shell
let canViewLogs = false;
let routeAvailable = noConsoleRoute;
let tabVisible = true;
let listController;
let detailController;
let detailSessionId = null;
const commandControllers = new Map();
const availableActions = {
  revokeConsole: false,
  revokeOtherConsoleSessions: false,
  disconnectMcp: false,
  disconnectAllMcp: false,
  inspectMcp: false,
  commandStatus: false,
};

const state = {
  console: [],
  consoleTruncated: false,
  consoleLimit: 0,
  mcp: [],
  loading: true,
  error: false,
  commands: new Map(),
  bulkCommandSessions: new Set(),
  bulkStatus: '',
};
let globalListenersBound = false;

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  viewLogs = ctx.viewSessionLogs || null;
  routeAvailable = ctx.hasRoute || routeAvailable;
  canViewLogs = ctx.hasRoute?.('GET', '/me/logs') === true;
  availableActions.revokeConsole = ctx.hasRoute?.('DELETE', '/me/security/sessions/:session_id') === true;
  availableActions.revokeOtherConsoleSessions = ctx.hasRoute?.('POST', '/me/security/sessions/revoke-all-others') === true;
  availableActions.disconnectMcp = ctx.hasRoute?.('DELETE', '/me/sessions/:session_id') === true;
  availableActions.disconnectAllMcp = ctx.hasRoute?.('POST', '/me/sessions/revoke-all') === true;
  availableActions.inspectMcp = ctx.hasRoute?.('GET', '/me/sessions/:session_id') === true;
  availableActions.commandStatus = ctx.hasRoute?.('GET', '/me/sessions/commands/:command_id') === true;
  showList();
  await load();
  bindGlobalListeners();
}

function showList({ refresh = false } = {}) {
  detailController?.destroy();
  detailController = undefined;
  detailSessionId = null;
  host.innerHTML = shell();
  host.querySelector('#sess-refresh').addEventListener('click', load);
  host.querySelector('#sess-revoke-others')?.addEventListener('click', signOutEverywhereElse);
  renderBody();
  if (refresh) load();
}

async function showDetail(sessionId) {
  listController?.abort();
  detailController?.destroy();
  detailSessionId = sessionId;
  detailController = await createSessionDetail(host, sessionId, {
    toast: notify,
    hasRoute: routeAvailable,
    confirm: confirmDialog,
    onBack: () => showList({ refresh: true }),
    onDisconnect: disconnectMcp,
  });
  detailController.setVisible(tabVisible);
}

function bindGlobalListeners() {
  if (globalListenersBound) return;
  globalThis.addEventListener('dh:tab-activated', onTabActivated);
  globalListenersBound = true;
}

function onTabActivated(event) {
  tabVisible = event.detail?.name === 'sessions';
  detailController?.setVisible(tabVisible);
  if (!tabVisible) {
    listController?.abort();
    abortCommandPolling();
    return;
  }
  resumeCommandPolling();
  if (!detailController) load();
}

/* ── Data ───────────────────────────────────────────────────────────────── */

async function load() {
  if (!tabVisible || detailController) return;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  state.loading = true;
  state.error = false;
  renderBody();
  try {
    const [sec, mcp] = await Promise.all([
      get('/me/security/sessions', { signal: controller.signal }),
      get('/me/sessions', { signal: controller.signal }),
    ]);
    state.console = sec.status === 200 && Array.isArray(sec.body?.sessions) ? sec.body.sessions : [];
    state.consoleTruncated = sec.status === 200 && sec.body?.truncated === true;
    state.consoleLimit = sec.status === 200 && Number.isSafeInteger(sec.body?.limit) ? sec.body.limit : 0;
    state.mcp = mcp.status === 200 && Array.isArray(mcp.body?.sessions) ? mcp.body.sessions : [];
    state.error = sec.status !== 200 || mcp.status !== 200;
    state.loading = false;
    renderBody();
  } catch (error) {
    if (isAbortError(error)) return;
    state.loading = false;
    state.error = true;
    renderBody();
  } finally {
    if (listController === controller) listController = undefined;
  }
}

/* ── Markup ─────────────────────────────────────────────────────────────── */

function shell() {
  const bulkAction = bulkActionConfig();
  return `
  <div class="sessions-bar">
    <span class="sessions-title">Sessions</span>
    <div class="sessions-bar-actions">
      <button class="btn btn-ghost" id="sess-refresh" type="button">&#x21bb; Refresh</button>
      ${bulkAction ? `<button class="btn btn-ghost session-danger" id="sess-revoke-others" type="button">${bulkAction.label}</button>` : ''}
    </div>
  </div>
  <div class="session-command-summary" id="sessions-command-summary" role="status" aria-live="polite">${escapeHtml(state.bulkStatus)}</div>
  <div id="sessions-body"></div>`;
}

function bulkActionConfig() {
  const consoleAvailable = availableActions.revokeOtherConsoleSessions;
  const mcpAvailable = availableActions.disconnectAllMcp;
  if (consoleAvailable && mcpAvailable) {
    return {
      label: 'Sign out everywhere else',
      prompt: 'Sign out of all your other console sessions and disconnect all connected apps? This device stays signed in.',
      confirmLabel: 'Sign out others',
    };
  }
  if (consoleAvailable) {
    return {
      label: 'Sign out other console sessions',
      prompt: 'Sign out of all your other console sessions? This device stays signed in.',
      confirmLabel: 'Sign out others',
    };
  }
  if (mcpAvailable) {
    return {
      label: 'Disconnect all connected apps',
      prompt: 'Disconnect all connected apps? They will need to reconnect.',
      confirmLabel: 'Disconnect apps',
    };
  }
  return null;
}

function renderBody() {
  const summary = host.querySelector('#sessions-command-summary');
  if (summary) summary.textContent = state.bulkStatus;
  const body = host.querySelector('#sessions-body');
  if (!body) return;
  if (state.loading) { body.innerHTML = '<div class="panel-placeholder">Loading sessions…</div>'; return; }
  if (state.error) { body.innerHTML = '<div class="panel-placeholder">Couldn\'t load your sessions.</div>'; return; }

  body.innerHTML = `
    <section class="session-section">
      <h3 class="session-section-title">This console <span class="session-count">${sessionCountLabel(state.console.length, state.consoleTruncated)}</span></h3>
      <p class="session-section-sub">Browser sessions signed in to this console.</p>
      ${browserSessionTruncationNotice(state.consoleTruncated, state.consoleLimit)}
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
  body.querySelectorAll('[data-inspect-mcp]').forEach(b =>
    b.addEventListener('click', () => showDetail(b.dataset.inspectMcp)));
  body.querySelectorAll('[data-logs-console]').forEach(b =>
    b.addEventListener('click', () => jumpToLogs('web-console:' + b.dataset.logsConsole)));
  body.querySelectorAll('[data-logs-mcp]').forEach(b =>
    b.addEventListener('click', () => jumpToLogs(b.dataset.logsMcp)));
  body.querySelectorAll('[data-copy-id]').forEach(b =>
    b.addEventListener('click', () => copyId(b.dataset.copyId)));
}

export function sessionCountLabel(visibleCount, truncated) {
  return `${visibleCount}${truncated ? '+' : ''}`;
}

export function browserSessionTruncationNotice(truncated, limit) {
  if (!truncated) return '';
  const visibleLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
  return `<p class="session-section-sub session-list-notice" role="status">Showing the ${visibleLimit} most recent browser sessions. Older active sessions are not shown here.</p>`;
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
        ${canViewLogs ? `<button class="btn btn-ghost session-link" data-logs-console="${escapeHtml(s.session_id)}" type="button">View logs</button>` : ''}
        ${consoleRevokeAction(s.session_id, current)}
      </div>
    </div>`;
}

function consoleRevokeAction(sessionId, current) {
  if (!availableActions.revokeConsole) return '';
  const currentFlag = current ? '1' : '0';
  return `<button class="btn btn-ghost session-danger" data-revoke-console="${escapeHtml(sessionId)}" data-current="${currentFlag}" type="button">Sign out</button>`;
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
        ${availableActions.inspectMcp ? `<button class="btn btn-primary" data-inspect-mcp="${escapeHtml(s.session_id)}" type="button">Inspect</button>` : ''}
        ${canViewLogs ? `<button class="btn btn-ghost session-link" data-logs-mcp="${escapeHtml(s.session_id)}" type="button">View logs</button>` : ''}
        ${availableActions.disconnectMcp ? `<button class="btn btn-ghost session-danger" data-disconnect-mcp="${escapeHtml(s.session_id)}" type="button">Disconnect</button>` : ''}
      </div>
      ${sessionCommandMarkup(state.commands.get(s.session_id))}
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
  const commandId = res.body?.command_id;
  if (state.bulkCommandSessions.delete(sessionId)) updateBulkCommandStatus();
  updateCommand(sessionId, { phase: 'accepted', status: 'accepted', commandId });
  notify('Disconnect accepted.', 'info');
  if (!commandId || !availableActions.commandStatus) {
    updateCommand(sessionId, { phase: 'unavailable', status: 'accepted' });
    return;
  }
  await trackTerminationCommand(sessionId, commandId);
}

async function signOutEverywhereElse() {
  const bulkAction = bulkActionConfig();
  if (!bulkAction) return;
  const ok = await confirmDialog(bulkAction.prompt, bulkAction.confirmLabel);
  if (!ok) return;
  state.bulkStatus = '';
  state.bulkCommandSessions.clear();
  let consoleRevoked = 0;
  let appsDisconnected = 0;
  const [c, m] = await Promise.all([
    availableActions.revokeOtherConsoleSessions
      ? post('/me/security/sessions/revoke-all-others').catch(() => null)
      : null,
    availableActions.disconnectAllMcp
      ? post('/me/sessions/revoke-all').catch(() => null)
      : null,
  ]);
  const consoleFailed = availableActions.revokeOtherConsoleSessions && c?.status !== 200;
  const appsFailed = availableActions.disconnectAllMcp && m?.status !== 202 && m?.status !== 200;
  if (!consoleFailed) consoleRevoked = Number(c?.body?.revoked ?? 0);
  if (!appsFailed) appsDisconnected = Number(m?.body?.requested ?? 0);
  const outcome = bulkActionResult(consoleRevoked, appsDisconnected, consoleFailed, appsFailed);
  notify(outcome.message, outcome.kind);
  const commands = Array.isArray(m?.body?.commands) ? m.body.commands : [];
  if (commands.length > 0) {
    commands.forEach(command => state.bulkCommandSessions.add(command.session_id));
    commands.forEach(command => updateCommand(command.session_id, {
      phase: 'accepted',
      status: 'accepted',
      commandId: command.command_id,
    }));
    if (availableActions.commandStatus) {
      await Promise.all(commands.map(command => trackTerminationCommand(command.session_id, command.command_id)));
    } else {
      commands.forEach(command => updateCommand(command.session_id, {
        phase: 'unavailable',
        status: 'accepted',
        commandId: command.command_id,
      }));
    }
    updateBulkCommandStatus();
  } else {
    renderBody();
  }
}

function bulkActionResult(consoleRevoked, appsDisconnected, consoleFailed, appsFailed) {
  if (consoleFailed && appsFailed) {
    return {
      message: 'Could not sign out other console sessions or disconnect connected apps.',
      kind: 'error',
    };
  }
  if (consoleFailed) {
    const message = availableActions.disconnectAllMcp
      ? `Could not sign out other console sessions; disconnected ${appsDisconnected} app(s).`
      : 'Could not sign out other console sessions.';
    return { message, kind: availableActions.disconnectAllMcp ? 'warn' : 'error' };
  }
  if (appsFailed) {
    const message = availableActions.revokeOtherConsoleSessions
      ? `Signed out ${consoleRevoked} other session(s); could not disconnect connected apps.`
      : 'Could not disconnect connected apps.';
    return { message, kind: availableActions.revokeOtherConsoleSessions ? 'warn' : 'error' };
  }
  if (availableActions.revokeOtherConsoleSessions && availableActions.disconnectAllMcp) {
    return {
      message: `Signed out ${consoleRevoked} other session(s); disconnected ${appsDisconnected} app(s).`,
      kind: 'success',
    };
  }
  if (availableActions.revokeOtherConsoleSessions) {
    return { message: `Signed out ${consoleRevoked} other session(s).`, kind: 'success' };
  }
  return { message: `Disconnected ${appsDisconnected} app(s).`, kind: 'success' };
}

async function trackTerminationCommand(sessionId, commandId) {
  if (!commandId) return;
  commandControllers.get(sessionId)?.abort();
  const controller = new AbortController();
  commandControllers.set(sessionId, controller);
  try {
    const result = await pollUntilTerminal(
      async signal => {
        const response = await get(`/me/sessions/commands/${encodeURIComponent(commandId)}`, { signal });
        if (response.status === 200) return response.body;
        return { status: 'failed', error_code: response.problemCode || 'command_status_unavailable' };
      },
      {
        signal: controller.signal,
        onUpdate: status => updateCommand(sessionId, {
          phase: 'pending',
          status: status?.status || 'pending',
          commandId,
        }),
      },
    );
    if (result.timedOut) {
      updateCommand(sessionId, { phase: 'timeout', status: 'pending', commandId });
      return;
    }
    updateCommand(sessionId, {
      phase: 'acknowledged',
      status: result.status?.status,
      errorCode: result.status?.error_code,
      commandId,
    });
    if (result.status?.status === 'failed') notify('The connected app could not be disconnected.', 'error');
    else notify('Connected app disconnected.', 'success');
  } catch (error) {
    if (!isAbortError(error)) updateCommand(sessionId, {
      phase: 'timeout',
      status: 'pending',
      commandId,
    });
  } finally {
    if (commandControllers.get(sessionId) === controller) commandControllers.delete(sessionId);
  }
}

function updateCommand(sessionId, command) {
  state.commands.set(sessionId, command);
  if (state.bulkCommandSessions.has(sessionId)) updateBulkCommandStatus();
  if (detailSessionId === sessionId) detailController?.setCommandStatus(command);
  else renderBody();
}

function updateBulkCommandStatus() {
  const counts = { acknowledged: 0, failed: 0, pending: 0, unavailable: 0 };
  state.bulkCommandSessions.forEach(sessionId => {
    const command = state.commands.get(sessionId);
    if (command?.phase === 'acknowledged') {
      counts[command.status === 'failed' ? 'failed' : 'acknowledged'] += 1;
    } else if (command?.phase === 'unavailable') {
      counts.unavailable += 1;
    } else {
      counts.pending += 1;
    }
  });
  const parts = [];
  if (counts.acknowledged > 0) parts.push(`${counts.acknowledged} disconnect(s) acknowledged`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.pending > 0) parts.push(`${counts.pending} still pending`);
  if (counts.unavailable > 0) parts.push(`${counts.unavailable} accepted without status tracking`);
  state.bulkStatus = parts.length > 0 ? `${parts.join('; ')}.` : '';
}

function abortCommandPolling() {
  commandControllers.forEach(controller => controller.abort());
  commandControllers.clear();
}

function resumeCommandPolling() {
  state.commands.forEach((command, sessionId) => {
    const pending = command.phase === 'accepted' || command.phase === 'pending';
    if (!pending || !command.commandId || commandControllers.has(sessionId)) return;
    trackTerminationCommand(sessionId, command.commandId).catch(() => null);
  });
}

function sessionCommandMarkup(command) {
  if (!command) return '';
  const labels = {
    accepted: 'accepted',
    pending: 'pending acknowledgement',
    acknowledged: command.status === 'failed' ? 'disconnect failed' : command.status,
    timeout: 'still pending',
    unavailable: 'accepted; status unavailable',
  };
  return `<span class="session-command-inline session-command-inline--${escapeHtml(command.phase)}">${escapeHtml(labels[command.phase] || 'updated')}</span>`;
}

function jumpToLogs(logSessionId) {
  if (viewLogs) viewLogs(logSessionId);
  else notify('Logs are unavailable right now.', 'warn');
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const ACTIVE_WINDOW_MS = 90_000;

function recencyBadge(ts) {
  const rel = relAgo(ts);
  const active = ts && (Date.now() - new Date(ts).getTime()) < ACTIVE_WINDOW_MS;
  return `<span class="session-badge${active ? ' session-badge--active' : ''}">${active ? '&#x25cf; active' : escapeHtml(rel)}</span>`;
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
