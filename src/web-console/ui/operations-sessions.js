/** Privacy-reduced, cross-user runtime session control for elevated operators. */

import { del, get } from './api.js';
import { isAbortError, pollUntilTerminal } from './polling.js';
import { createCursorPager, escapeAttr, escapeHtml, formatTimestamp } from './operations-ui.js';

const COMMAND_POLL_INTERVAL_MS = 500;
const COMMAND_POLL_TIMEOUT_MS = 10_000;

export function createOperationalSessionsView(ctx = {}) {
  let container;
  let items = [];
  let hasSnapshot = false;
  const pager = createCursorPager();
  let selectedSession;
  let visible = false;
  const commands = new Map();
  let commandPoll;
  let listController;
  let detailController;
  let listVersion = 0;
  let detailVersion = 0;
  const filters = { userId: '', status: '' };

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.innerHTML = sessionShell();
      container.querySelector('[data-operational-session-filters]').addEventListener('submit', applyFilters);
      container.addEventListener('click', onClick);
    },
    async load(signal) {
      const version = ++listVersion;
      const response = await get(sessionListPath(filters, pager.cursor()), { signal });
      if (version !== listVersion) return;
      if (response.status !== 200 || !response.body) {
        showListProblem('Runtime sessions could not be loaded.');
        return;
      }
      items = Array.isArray(response.body.items) ? response.body.items : [];
      pager.apply(response.body.page);
      hasSnapshot = true;
      renderList();
    },
    showError(message) {
      showListProblem(message);
    },
    setVisible(nextVisible) {
      visible = nextVisible;
      if (!visible) {
        abortListRequest();
        abortDetailRequest();
        stopCommandPolling();
        return;
      }
      resumeSelectedCommand();
    },
  });

  function applyFilters(event) {
    event.preventDefault();
    const form = event.currentTarget;
    filters.userId = form.elements.user_id.value.trim();
    filters.status = form.elements.status.value;
    pager.reset();
    loadFromUi();
  }

  function onClick(event) {
    const inspect = event.target.closest('[data-operational-session-id]');
    if (inspect) {
      loadDetail(inspect.dataset.operationalSessionId);
      return;
    }
    if (event.target.closest('[data-operational-session-close]')) {
      stopCommandPolling();
      selectedSession = undefined;
      renderDetail();
      return;
    }
    if (event.target.closest('[data-operational-session-terminate]')) {
      confirmTermination();
      return;
    }
    if (event.target.closest('[data-session-next]') && pager.moveNext()) {
      loadFromUi();
      return;
    }
    if (event.target.closest('[data-session-previous]') && pager.movePrevious()) {
      loadFromUi();
    }
  }

  async function loadFromUi() {
    abortListRequest();
    const controller = new AbortController();
    listController = controller;
    const version = ++listVersion;
    if (!hasSnapshot) renderListState('Loading runtime sessions…');
    try {
      const response = await get(sessionListPath(filters, pager.cursor()), { signal: controller.signal });
      if (version !== listVersion) return;
      if (response.status !== 200 || !response.body) {
        showListProblem('Runtime sessions could not be loaded.');
        return;
      }
      items = Array.isArray(response.body.items) ? response.body.items : [];
      pager.apply(response.body.page);
      hasSnapshot = true;
      renderList();
    } catch (error) {
      if (!isAbortError(error)) showListProblem('Runtime sessions could not reach the server.');
    } finally {
      if (listController === controller) listController = undefined;
    }
  }

  async function loadDetail(sessionId) {
    abortDetailRequest();
    stopCommandPolling();
    const controller = new AbortController();
    detailController = controller;
    const version = ++detailVersion;
    renderDetailState('Loading runtime session…');
    try {
      const response = await get(`/admin/operate/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      if (version !== detailVersion) return;
      if (response.status !== 200 || !response.body) {
        selectedSession = undefined;
        renderDetailState('This runtime session ended, expired, or is not available to this operator.', 'neutral');
        return;
      }
      selectedSession = response.body;
      renderDetail();
      resumeSelectedCommand();
    } catch (error) {
      if (isAbortError(error)) return;
      selectedSession = undefined;
      renderDetailState('The runtime session could not reach the server.', 'error');
    } finally {
      if (detailController === controller) detailController = undefined;
    }
  }

  async function confirmTermination() {
    if (!selectedSession) return;
    const confirmed = await confirmDialog(
      `Terminate runtime session ${selectedSession.session_id}? The owning client will be disconnected.`,
      'Terminate session',
    );
    if (!confirmed) return;
    await terminateSelectedSession();
  }

  async function terminateSelectedSession() {
    const sessionId = selectedSession?.session_id;
    if (!sessionId) return;
    setDetailBusy(true);
    try {
      const response = await del(`/admin/operate/sessions/${encodeURIComponent(sessionId)}`);
      if (response.status !== 202 || !response.body?.command_id) {
        showCommandMessage('The termination command was not accepted.', 'error');
        return;
      }
      const command = { ...response.body, session_id: sessionId, status: 'pending' };
      commands.set(sessionId, command);
      renderCommandStatus();
      pollCommand(sessionId, command.command_id);
    } catch {
      showCommandMessage('The termination command could not reach the server.', 'error');
    } finally {
      setDetailBusy(false);
    }
  }

  async function pollCommand(sessionId, commandId) {
    if (!visible) return;
    if (commandPoll?.sessionId === sessionId && commandPoll.commandId === commandId) return;
    stopCommandPolling();
    const controller = new AbortController();
    commandPoll = { sessionId, commandId, controller };
    try {
      const result = await pollUntilTerminal(
        signal => readCommand(commandId, signal),
        {
          signal: controller.signal,
          intervalMs: COMMAND_POLL_INTERVAL_MS,
          timeoutMs: COMMAND_POLL_TIMEOUT_MS,
          onUpdate: next => updateCommand(sessionId, commandId, next),
        },
      );
      if (result.timedOut && isSelectedSession(sessionId)) {
        showCommandMessage('The command is still pending. Status checks will resume when this section is reopened.', 'warn');
      }
      if (result.status?.status === 'terminated' || result.status?.status === 'already_absent') {
        items = items.filter(item => item.session_id !== sessionId);
        renderList();
      }
    } catch (error) {
      if (!isAbortError(error) && isSelectedSession(sessionId)) {
        showCommandMessage('The termination acknowledgement could not be read.', 'error');
      }
    } finally {
      if (commandPoll?.controller === controller) commandPoll = undefined;
    }
  }

  function updateCommand(sessionId, commandId, next) {
    if (next?.command_id && next.command_id !== commandId) return;
    commands.set(sessionId, { ...next, command_id: commandId, session_id: sessionId });
    if (isSelectedSession(sessionId)) renderCommandStatus();
  }

  function renderList() {
    const target = container.querySelector('[data-operational-session-list]');
    const count = container.querySelector('[data-operational-session-count]');
    count.textContent = `${items.length} allowlisted session${items.length === 1 ? '' : 's'} in this page.`;
    target.innerHTML = items.length === 0
      ? '<div class="operations-state">No runtime sessions match these filters.</div>'
      : items.map(item => sessionCard(item, canInspect(ctx))).join('');
    container.querySelector('[data-session-previous]').disabled = !pager.hasPrevious();
    container.querySelector('[data-session-next]').disabled = !pager.nextCursor();
    container.querySelector('[data-session-list-warning]')?.remove();
  }

  function renderListState(message, kind = 'neutral') {
    const target = container.querySelector('[data-operational-session-list]');
    target.innerHTML = `<div class="operations-state operations-state--${kind}">${escapeHtml(message)}</div>`;
  }

  function renderDetail() {
    const target = container.querySelector('[data-operational-session-detail]');
    if (!selectedSession) {
      target.innerHTML = '<div class="operations-state">Select a runtime session to inspect its allowlisted metadata.</div>';
      return;
    }
    const command = commands.get(selectedSession.session_id);
    target.innerHTML = detailMarkup(selectedSession, canTerminate(ctx), command?.status === 'pending');
    renderCommandStatus();
  }

  function renderDetailState(message, kind = 'neutral') {
    const target = container.querySelector('[data-operational-session-detail]');
    target.innerHTML = `<div class="operations-state operations-state--${kind}">${escapeHtml(message)}</div>`;
  }

  function renderCommandStatus() {
    const target = container.querySelector('[data-operational-command-status]');
    const command = selectedSession ? commands.get(selectedSession.session_id) : undefined;
    if (!target || !command) return;
    const presentation = commandPresentation(command);
    target.innerHTML = `<p class="operations-inline-message operations-inline-message--${presentation.kind}">${escapeHtml(presentation.message)}</p>`;
  }

  function showCommandMessage(message, kind) {
    const target = container.querySelector('[data-operational-command-status]');
    if (target) target.innerHTML = `<p class="operations-inline-message operations-inline-message--${kind}">${escapeHtml(message)}</p>`;
  }

  function setDetailBusy(busy) {
    const button = container.querySelector('[data-operational-session-terminate]');
    if (button) button.disabled = busy;
  }

  function showListProblem(message) {
    if (!hasSnapshot) {
      renderListState(message, 'error');
      return;
    }
    container.querySelector('[data-session-list-warning]')?.remove();
    container.querySelector('[data-operational-session-list]')?.insertAdjacentHTML(
      'beforebegin',
      `<p class="operations-inline-message operations-inline-message--warn" data-session-list-warning>${escapeHtml(message)} Showing the last successful snapshot.</p>`,
    );
  }

  function resumeSelectedCommand() {
    const sessionId = selectedSession?.session_id;
    const command = sessionId ? commands.get(sessionId) : undefined;
    if (sessionId && command?.status === 'pending') pollCommand(sessionId, command.command_id);
  }

  function isSelectedSession(sessionId) {
    return selectedSession?.session_id === sessionId;
  }

  function stopCommandPolling() {
    commandPoll?.controller.abort();
    commandPoll = undefined;
  }

  function abortListRequest() {
    listController?.abort();
    listController = undefined;
    listVersion += 1;
  }

  function abortDetailRequest() {
    detailController?.abort();
    detailController = undefined;
    detailVersion += 1;
  }
}

async function readCommand(commandId, signal) {
  const response = await get(`/admin/operate/sessions/commands/${encodeURIComponent(commandId)}`, { signal });
  if (response.status !== 200 || !response.body) throw new Error('Command status unavailable.');
  return response.body;
}

function sessionShell() {
  return `<div class="operations-section-heading"><div><h3>Runtime sessions</h3><p>Cross-user operational metadata only. Private account and session content is never displayed.</p></div></div>
    <form class="operations-filter-bar" data-operational-session-filters>
      <label><span>User UUID</span><input name="user_id" maxlength="64" placeholder="Optional exact UUID"></label>
      <label><span>Status</span><select name="status"><option value="">All statuses</option><option value="active">Active</option><option value="closing">Closing</option></select></label>
      <button class="btn btn-primary" type="submit">Apply filters</button>
    </form>
    <p class="operations-checked" data-operational-session-count aria-live="polite"></p>
    <div class="operations-session-layout">
      <div><div class="operations-session-list" data-operational-session-list><div class="operations-state">Loading runtime sessions…</div></div>
        <div class="operations-pagination"><button class="btn btn-ghost" data-session-previous type="button" disabled>Previous</button><button class="btn btn-ghost" data-session-next type="button" disabled>Next</button></div></div>
      <aside class="operations-card operations-session-detail" data-operational-session-detail><div class="operations-state">Select a runtime session to inspect its allowlisted metadata.</div></aside>
    </div>`;
}

function sessionCard(session, inspectAvailable) {
  const client = clientLabel(session.client_info);
  const openingTag = inspectAvailable
    ? `<button class="operations-card operations-session-card" data-operational-session-id="${escapeAttr(session.session_id)}" type="button">`
    : '<article class="operations-card operations-session-card">';
  const closingTag = inspectAvailable ? '</button>' : '</article>';
  return `${openingTag}
    <span><strong>${escapeHtml(client)}</strong><small>${escapeHtml(session.transport)}</small></span>
    <span><code>${escapeHtml(session.account_correlation_id)}</code><small>${escapeHtml(session.replica_id)}</small></span>
    <span class="operations-status">${escapeHtml(session.status)}</span>
    <span><strong>${Number(session.request_count || 0).toLocaleString()}</strong><small>requests · ${Number(session.error_count || 0).toLocaleString()} errors</small></span>
    <span><strong>${escapeHtml(formatTimestamp(session.last_active_at))}</strong><small>last active</small></span>
  ${closingTag}`;
}

function detailMarkup(session, terminateAvailable, commandPending) {
  const disabled = commandPending ? ' disabled' : '';
  const terminate = terminateAvailable
    ? `<button class="btn btn-primary" data-operational-session-terminate type="button"${disabled}>Terminate session</button>`
    : '';
  return `<header><div><p class="operations-eyebrow">Runtime session</p><h3>${escapeHtml(clientLabel(session.client_info))}</h3></div><button class="btn btn-ghost" data-operational-session-close type="button">Close</button></header>
    <dl class="operations-detail-list">
      ${detailRow('Session ID', session.session_id)}
      ${detailRow('Account correlation', session.account_correlation_id)}
      ${detailRow('Replica', session.replica_id)}
      ${detailRow('Status', session.status)}
      ${detailRow('Transport', session.transport)}
      ${detailRow('Created', formatTimestamp(session.created_at))}
      ${detailRow('Last active', formatTimestamp(session.last_active_at))}
      ${detailRow('Lease until', formatTimestamp(session.lease_until))}
      ${detailRow('Requests', Number(session.request_count || 0).toLocaleString())}
      ${detailRow('Errors', Number(session.error_count || 0).toLocaleString())}
    </dl>
    <div data-operational-command-status aria-live="polite"></div>
    <footer>${terminate}</footer>`;
}

function detailRow(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value ?? '—')}</code></dd></div>`;
}

function sessionListPath(filters, cursor) {
  const params = new URLSearchParams({ limit: '50' });
  if (filters.userId) params.set('user_id', filters.userId);
  if (filters.status) params.set('status', filters.status);
  if (cursor) params.set('cursor', cursor);
  return `/admin/operate/sessions?${params.toString()}`;
}

function canTerminate(ctx) {
  return ctx.hasRoute?.('DELETE', '/admin/operate/sessions/:session_id') === true;
}

function canInspect(ctx) {
  return ctx.hasRoute?.('GET', '/admin/operate/sessions/:session_id') === true;
}

function clientLabel(clientInfo) {
  if (!clientInfo) return 'Unknown client';
  return [clientInfo.name, clientInfo.version].filter(Boolean).join(' ') || 'Unknown client';
}

function commandPresentation(command) {
  if (command.status === 'terminated') return { kind: 'success', message: 'The owning replica acknowledged termination.' };
  if (command.status === 'already_absent') return { kind: 'success', message: 'The session was already absent when the command was processed.' };
  if (command.status === 'failed') {
    const code = command.error_code ? ` (${command.error_code})` : '';
    return { kind: 'error', message: `Termination failed${code}.` };
  }
  return { kind: 'warn', message: 'Waiting for the owning replica to acknowledge termination…' };
}

function confirmDialog(message, confirmLabel) {
  return new Promise(resolve => {
    document.getElementById('operations-confirm')?.remove();
    const modal = document.createElement('div');
    modal.id = 'operations-confirm';
    modal.className = 'confirm-modal';
    modal.innerHTML = `<div class="confirm-backdrop"></div><div class="confirm-card" role="dialog" aria-modal="true" aria-label="Confirm operator action"><p class="confirm-msg">${escapeHtml(message)}</p><div class="confirm-actions"><button class="btn btn-ghost" data-confirm="0" type="button">Cancel</button><button class="btn btn-primary" data-confirm="1" type="button">${escapeHtml(confirmLabel)}</button></div></div>`;
    document.body.appendChild(modal);
    const close = confirmed => {
      modal.remove();
      resolve(confirmed);
    };
    modal.querySelector('.confirm-backdrop').addEventListener('click', () => close(false));
    modal.querySelector('[data-confirm="0"]').addEventListener('click', () => close(false));
    modal.querySelector('[data-confirm="1"]').addEventListener('click', () => close(true));
    modal.querySelector('[data-confirm="1"]').focus();
  });
}
