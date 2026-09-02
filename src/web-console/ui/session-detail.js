/** Owned MCP session detail, HITL decisions, activations, and telemetry snapshots. */

import { get, post, del } from './api.js';
import { createVisiblePoller, isAbortError } from './polling.js';
import { escapeHtml, relAgo } from './ui-utils.js';

const POLL_INTERVAL_MS = 4_000;
const ACTIVATABLE_TYPES = ['personas', 'skills', 'agents', 'memories', 'ensembles'];

export async function createSessionDetail(host, sessionId, ctx) {
  const encodedSessionId = encodeURIComponent(sessionId);
  const basePath = `/me/sessions/${encodedSessionId}`;
  const routes = routeAvailability(ctx.hasRoute);
  const state = createState(routes);
  const actionControllers = new Set();
  let destroyed = false;
  let visible = true;

  host.innerHTML = detailShell(routes);
  host.addEventListener('click', onClick);
  host.addEventListener('submit', onSubmit);

  const poller = createVisiblePoller(refreshLiveSnapshots, {
    intervalMs: POLL_INTERVAL_MS,
    onError: markStale,
  });

  await loadInitial();
  if (!destroyed && visible && !state.expired) poller.start({ immediate: false });

  return Object.freeze({
    destroy,
    setVisible(nextVisible) {
      visible = nextVisible;
      if (!visible || state.expired) poller.stop();
      else poller.start();
    },
    setCommandStatus(command) {
      state.command = command;
      renderHeader();
      if (command?.phase === 'acknowledged' && command.status !== 'failed') markExpired();
    },
  });

  async function loadInitial() {
    renderHeader();
    const activeController = trackController();
    try {
      const sessionResponse = await get(basePath, { signal: activeController.signal });
      if (!acceptSessionResponse(sessionResponse)) return;
      await Promise.all([
        loadActivations(activeController.signal),
        loadApprovals(activeController.signal),
        loadExecutions(activeController.signal),
        loadGatekeeper(activeController.signal),
        loadLogs(activeController.signal),
        loadMetrics(activeController.signal),
      ]);
      markFresh();
    } catch (error) {
      if (!isAbortError(error)) showDetailError();
    } finally {
      releaseController(activeController);
    }
  }

  async function refreshLiveSnapshots(signal) {
    const sessionResponse = await get(basePath, { signal });
    if (!acceptSessionResponse(sessionResponse)) return;
    await Promise.all([
      loadActivations(signal),
      loadApprovals(signal),
      loadExecutions(signal),
      loadGatekeeper(signal),
      loadLogs(signal),
      loadMetrics(signal),
    ]);
    markFresh();
  }

  function acceptSessionResponse(response) {
    if (response.status === 404) {
      markExpired();
      return false;
    }
    if (response.status !== 200 || !response.body) {
      showDetailError();
      return false;
    }
    state.session = response.body;
    state.loading = false;
    state.error = false;
    renderHeader();
    return true;
  }

  async function loadActivations(signal) {
    await loadCollection('activations', `${basePath}/activations`, 'activations', signal);
  }

  async function loadApprovals(signal) {
    await loadCollection('approvals', `${basePath}/approvals`, 'approvals', signal);
  }

  async function loadExecutions(signal) {
    await loadCollection('executions', `${basePath}/executions`, 'executions', signal);
  }

  async function loadGatekeeper(signal) {
    await loadObject('gatekeeper', `${basePath}/gatekeeper`, signal);
  }

  async function loadLogs(signal) {
    await loadCollection('logs', `${basePath}/logs?limit=20`, 'items', signal);
  }

  async function loadMetrics(signal) {
    await loadCollection('metrics', `${basePath}/metrics`, 'metrics', signal);
  }

  async function loadCollection(key, path, bodyKey, signal) {
    const resource = state.resources[key];
    if (!resource.available) return;
    await loadResource(resource, path, signal, body => Array.isArray(body?.[bodyKey]) ? body[bodyKey] : []);
    renderResource(key);
  }

  async function loadObject(key, path, signal) {
    const resource = state.resources[key];
    if (!resource.available) return;
    await loadResource(resource, path, signal, body => body || null);
    renderResource(key);
  }

  async function loadResource(resource, path, signal, project) {
    try {
      const response = await get(path, { signal });
      if (response.status === 404) {
        markExpired();
        return;
      }
      if (response.status !== 200) {
        resource.status = 'error';
        return;
      }
      resource.data = project(response.body);
      resource.status = 'ready';
    } catch (error) {
      if (isAbortError(error)) throw error;
      resource.status = 'error';
    }
  }

  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button || !host.contains(button)) return;
    if (button.matches('[data-session-back]')) {
      ctx.onBack();
      return;
    }
    if (button.matches('[data-detail-refresh]')) {
      poller.refresh();
      return;
    }
    if (button.matches('[data-session-disconnect]')) {
      await ctx.onDisconnect(sessionId);
      return;
    }
    if (button.dataset.approvalId && button.dataset.approvalAction) {
      await decideApproval(button.dataset.approvalId, button.dataset.approvalAction, button.dataset.approvalScope);
      return;
    }
    if (button.dataset.deactivateType && button.dataset.deactivateName) {
      await deactivate(button.dataset.deactivateType, button.dataset.deactivateName);
      return;
    }
    if (button.dataset.executionId) await loadExecutionDetail(button.dataset.executionId);
  }

  async function onSubmit(event) {
    if (!event.target.matches('#session-activation-form')) return;
    event.preventDefault();
    const data = new FormData(event.target);
    const type = data.get('type');
    const name = data.get('name');
    await activate(
      typeof type === 'string' ? type : '',
      typeof name === 'string' ? name : '',
    );
  }

  async function activate(type, name) {
    const trimmedName = name.trim();
    if (!ACTIVATABLE_TYPES.includes(type) || !trimmedName) {
      ctx.toast('Choose an element type and enter its portfolio name.', 'warn');
      return;
    }
    const response = await actionRequest(signal => post(`${basePath}/activations`, {
      body: { type, name: trimmedName },
      signal,
    }));
    if (!response) return;
    if (response.status !== 200) {
      ctx.toast(response.status === 404 ? 'That portfolio element or session is no longer available.' : 'Could not activate that element.', 'error');
      return;
    }
    ctx.toast('Element activated for this session.', 'success');
    host.querySelector('#session-activation-form')?.reset();
    await refreshAfterAction(loadActivations);
  }

  async function deactivate(type, name) {
    const confirmed = await ctx.confirm(`Deactivate ${name} for this session?`, 'Deactivate');
    if (!confirmed) return;
    const response = await actionRequest(signal => del(
      `${basePath}/activations/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
      { signal },
    ));
    if (!response) return;
    if (response.status !== 200 && response.status !== 204) {
      ctx.toast('Could not deactivate that element.', 'error');
      return;
    }
    ctx.toast('Element deactivated.', 'success');
    await refreshAfterAction(loadActivations);
  }

  async function decideApproval(approvalId, action, scope = 'once') {
    if (action === 'deny') {
      const confirmed = await ctx.confirm('Deny this request? The waiting operation will not run.', 'Deny request');
      if (!confirmed) return;
    }
    if (action === 'approve' && scope === 'session') {
      const confirmed = await ctx.confirm('Approve this tool for the rest of this session?', 'Approve for session');
      if (!confirmed) return;
    }
    const verb = action === 'approve' ? 'approve' : 'deny';
    const response = await actionRequest(signal => post(
      `${basePath}/approvals/${encodeURIComponent(approvalId)}/${verb}`,
      { body: action === 'approve' ? { scope } : {}, signal },
    ));
    if (!response) return;
    if (response.status !== 200) {
      ctx.toast('That approval could not be updated.', 'error');
      return;
    }
    ctx.toast(action === 'approve' ? 'Approval recorded.' : 'Denial recorded.', 'success');
    await refreshAfterAction(loadApprovals, loadGatekeeper);
  }

  async function loadExecutionDetail(goalId) {
    if (!routes.executionDetail) return;
    const output = host.querySelector('#session-execution-detail');
    if (output) output.innerHTML = placeholder('Loading execution detail…');
    const response = await actionRequest(signal => get(
      `${basePath}/executions/${encodeURIComponent(goalId)}`,
      { signal },
    ));
    if (!output || !response) return;
    if (response.status !== 200) {
      output.innerHTML = placeholder('Execution detail is no longer available.');
      return;
    }
    output.innerHTML = executionDetailMarkup(response.body);
  }

  async function actionRequest(request) {
    const controller = trackController();
    try {
      return await request(controller.signal);
    } catch (error) {
      if (!isAbortError(error)) ctx.toast('The request could not reach the server.', 'error');
      return null;
    } finally {
      releaseController(controller);
    }
  }

  async function refreshAfterAction(...loaders) {
    const controller = trackController();
    try {
      await Promise.all(loaders.map(loader => loader(controller.signal)));
    } catch (error) {
      if (!isAbortError(error)) ctx.toast('The latest session snapshot could not be loaded.', 'warn');
    } finally {
      releaseController(controller);
    }
  }

  function trackController() {
    const controller = new AbortController();
    actionControllers.add(controller);
    return controller;
  }

  function releaseController(controller) {
    actionControllers.delete(controller);
  }

  function markFresh() {
    state.stale = false;
    state.updatedAt = new Date();
    renderStatus();
  }

  function markStale() {
    if (destroyed || state.expired) return;
    state.stale = true;
    renderStatus();
  }

  function showDetailError() {
    state.loading = false;
    state.error = true;
    renderHeader();
  }

  function markExpired() {
    if (state.expired) return;
    state.expired = true;
    state.loading = false;
    poller.stop();
    renderHeader();
    host.querySelector('#session-detail-panels')?.setAttribute('hidden', '');
  }

  function renderHeader() {
    const header = host.querySelector('#session-detail-header');
    if (!header) return;
    if (state.loading) {
      header.innerHTML = placeholder('Loading session detail…');
      return;
    }
    if (state.expired) {
      header.innerHTML = `<div class="session-detail-state" role="status">
        <h2>Session unavailable</h2>
        <p>This session ended, expired, or is not available to this account.</p>
        ${commandMarkup(state.command)}
        <button class="btn btn-ghost" data-session-back type="button">Back to sessions</button>
      </div>`;
      return;
    }
    if (state.error || !state.session) {
      header.innerHTML = `<div class="session-detail-state" role="alert">
        <h2>Could not load this session</h2>
        <p>The server could not provide a current session snapshot.</p>
        <button class="btn btn-ghost" data-detail-refresh type="button">Retry</button>
      </div>`;
      return;
    }
    const session = state.session;
    const client = clientName(session);
    header.innerHTML = `
      <div class="session-detail-heading">
        <div>
          <p class="session-detail-eyebrow">Connected app</p>
          <h2>${escapeHtml(client)}</h2>
          <p>${escapeHtml(relAgo(session.created_at))} · ${Number(session.request_count || 0).toLocaleString()} requests · ${Number(session.error_count || 0).toLocaleString()} errors</p>
          ${sessionIdCode(session.session_id)}
        </div>
        <div class="session-detail-actions">
          ${routes.disconnect ? '<button class="btn btn-ghost session-danger" data-session-disconnect type="button">Disconnect</button>' : ''}
          <button class="btn btn-ghost" data-detail-refresh type="button">Refresh</button>
        </div>
      </div>
      ${commandMarkup(state.command)}
      <div id="session-detail-status" class="session-detail-refresh" aria-live="polite"></div>`;
    renderStatus();
  }

  function renderStatus() {
    const status = host.querySelector('#session-detail-status');
    if (!status) return;
    if (state.stale) {
      status.textContent = 'Live refresh is temporarily unavailable. Showing the last successful snapshot.';
      status.classList.add('session-detail-refresh--stale');
      return;
    }
    status.classList.remove('session-detail-refresh--stale');
    status.textContent = state.updatedAt ? `Snapshot refreshed ${relAgo(state.updatedAt.toISOString())}.` : 'Loading snapshots…';
  }

  function renderResource(key) {
    const body = host.querySelector(`[data-session-resource="${key}"]`);
    if (!body) return;
    const resource = state.resources[key];
    if (resource.status === 'loading') {
      body.innerHTML = placeholder('Loading…');
      return;
    }
    if (resource.status === 'error') {
      body.innerHTML = placeholder('This snapshot could not be refreshed.');
      return;
    }
    body.innerHTML = resourceMarkup(key, resource.data, routes);
  }

  function destroy() {
    destroyed = true;
    poller.stop();
    actionControllers.forEach(controller => controller.abort());
    actionControllers.clear();
    host.removeEventListener('click', onClick);
    host.removeEventListener('submit', onSubmit);
  }
}

function routeAvailability(hasRoute = () => false) {
  return Object.freeze({
    disconnect: hasRoute('DELETE', '/me/sessions/:session_id'),
    activations: hasRoute('GET', '/me/sessions/:session_id/activations'),
    activate: hasRoute('POST', '/me/sessions/:session_id/activations'),
    deactivate: hasRoute('DELETE', '/me/sessions/:session_id/activations/:type/:name'),
    approvals: hasRoute('GET', '/me/sessions/:session_id/approvals'),
    approve: hasRoute('POST', '/me/sessions/:session_id/approvals/:approval_id/approve'),
    deny: hasRoute('POST', '/me/sessions/:session_id/approvals/:approval_id/deny'),
    executions: hasRoute('GET', '/me/sessions/:session_id/executions'),
    executionDetail: hasRoute('GET', '/me/sessions/:session_id/executions/:goal_id'),
    gatekeeper: hasRoute('GET', '/me/sessions/:session_id/gatekeeper'),
    logs: hasRoute('GET', '/me/sessions/:session_id/logs'),
    metrics: hasRoute('GET', '/me/sessions/:session_id/metrics'),
  });
}

function createResourceState(available) {
  return { available, status: available ? 'loading' : 'unavailable', data: null };
}

function createState(routes) {
  return {
    loading: true,
    error: false,
    expired: false,
    stale: false,
    updatedAt: null,
    session: null,
    command: null,
    resources: {
      activations: createResourceState(routes.activations),
      approvals: createResourceState(routes.approvals),
      executions: createResourceState(routes.executions),
      gatekeeper: createResourceState(routes.gatekeeper),
      logs: createResourceState(routes.logs),
      metrics: createResourceState(routes.metrics),
    },
  };
}

function detailShell(routes) {
  const panels = [
    ['approvals', 'Pending decisions', 'Review human-in-the-loop requests.'],
    ['activations', 'Active elements', 'Elements attached to this MCP session.'],
    ['executions', 'Executions', 'Current execution snapshots.'],
    ['gatekeeper', 'Gatekeeper', 'Permission and confirmation snapshot.'],
    ['logs', 'Session activity', 'Limited event snapshot; this is not a live stream.'],
    ['metrics', 'Session metrics', 'Small counters and gauges from the latest snapshot.'],
  ].filter(([key]) => routes[key]);
  const panelMarkup = panels.map(([key, title, note]) => `
    <section class="session-detail-panel session-detail-panel--${key}">
      <div class="session-detail-panel-heading"><h3>${title}</h3><p>${note}</p></div>
      <div data-session-resource="${key}">${placeholder('Loading…')}</div>
    </section>`).join('');
  return `
    <div class="session-detail-shell">
      <button class="session-detail-back" data-session-back type="button">&#8592; All sessions</button>
      <section id="session-detail-header" class="session-detail-header">${placeholder('Loading session detail…')}</section>
      <div id="session-detail-panels" class="session-detail-grid">
        ${panelMarkup || placeholder('No session detail resources are available in this deployment.')}
      </div>
    </div>`;
}

function resourceMarkup(key, data, routes) {
  if (key === 'activations') return activationsMarkup(data, routes);
  if (key === 'approvals') return approvalsMarkup(data, routes);
  if (key === 'executions') return executionsMarkup(data, routes);
  if (key === 'gatekeeper') return gatekeeperMarkup(data);
  if (key === 'logs') return logsMarkup(data);
  return metricsMarkup(data);
}

function activationsMarkup(activations, routes) {
  const items = Array.isArray(activations) ? activations : [];
  const list = items.map(item => `
    <div class="session-detail-row">
      <div><strong>${escapeHtml(item.display_name || item.name)}</strong><span>${escapeHtml(item.type)} · activated ${escapeHtml(relAgo(item.activated_at))}</span></div>
      ${routes.deactivate ? `<button class="btn btn-ghost session-danger" data-deactivate-type="${escapeHtml(item.type)}" data-deactivate-name="${escapeHtml(item.name)}" type="button">Deactivate</button>` : ''}
    </div>`).join('') || empty('No elements are active for this session.');
  const form = routes.activate ? `
    <form id="session-activation-form" class="session-activation-form">
      <label>Type<select name="type">${ACTIVATABLE_TYPES.map(type => `<option value="${type}">${type}</option>`).join('')}</select></label>
      <label>Portfolio name<input name="name" required autocomplete="off" placeholder="element-name"></label>
      <button class="btn btn-primary" type="submit">Activate</button>
    </form>` : '';
  return list + form;
}

function approvalsMarkup(approvals, routes) {
  const items = Array.isArray(approvals) ? approvals : [];
  if (items.length === 0) return empty('No approval requests for this session.');
  return items.map(approval => {
    const actions = approval.status === 'pending' ? approvalActions(approval, routes) : '';
    return `<article class="session-approval session-approval--${escapeHtml(approval.status)}">
      <div class="session-detail-row">
        <div><strong>${escapeHtml(approval.tool_name)}</strong><span>${escapeHtml(approval.risk_level)} risk · score ${Number(approval.risk_score || 0)} · ${escapeHtml(approval.status)}</span></div>
        ${actions}
      </div>
      <p>${escapeHtml(approval.reason || 'No reason supplied.')}</p>
      <details><summary>Request details</summary><pre>${escapeHtml(prettyJson(approval.tool_input_detail || approval.tool_input_digest))}</pre></details>
    </article>`;
  }).join('');
}

function approvalActions(approval, routes) {
  const id = escapeHtml(approval.approval_id);
  const approve = routes.approve ? `
    <button class="btn btn-primary" data-approval-id="${id}" data-approval-action="approve" data-approval-scope="once" type="button">Approve once</button>
    <button class="btn btn-ghost" data-approval-id="${id}" data-approval-action="approve" data-approval-scope="session" type="button">Approve for session</button>` : '';
  const deny = routes.deny ? `<button class="btn btn-ghost session-danger" data-approval-id="${id}" data-approval-action="deny" type="button">Deny</button>` : '';
  return `<div class="session-detail-row-actions">${approve}${deny}</div>`;
}

function executionsMarkup(executions, routes) {
  const items = Array.isArray(executions) ? executions : [];
  const list = items.map(item => `
    <div class="session-detail-row">
      <div><strong>${escapeHtml(item.agent_name)}</strong><span>${escapeHtml(item.status)}${item.current_step ? ` · ${escapeHtml(item.current_step)}` : ''}</span></div>
      ${routes.executionDetail ? `<button class="btn btn-ghost" data-execution-id="${escapeHtml(item.goal_id)}" type="button">Details</button>` : ''}
    </div>`).join('') || empty('No executions have been recorded for this session.');
  return `${list}<div id="session-execution-detail"></div>`;
}

function executionDetailMarkup(execution) {
  const output = Array.isArray(execution?.output) ? execution.output : [];
  return `<div class="session-execution-output">
    <h4>${escapeHtml(execution?.agent_name || 'Execution detail')}</h4>
    ${output.map(item => `<div><strong>${escapeHtml(item.kind)}</strong><span>${escapeHtml(item.message)} · ${escapeHtml(relAgo(item.occurred_at))}</span></div>`).join('') || empty('No execution output is available.')}
  </div>`;
}

function gatekeeperMarkup(gatekeeper) {
  if (!gatekeeper) return empty('No gatekeeper snapshot is available.');
  const confirmations = Array.isArray(gatekeeper.confirmations) ? gatekeeper.confirmations : [];
  const confirmationRows = confirmations.map(confirmationMarkup).join('');
  return `<div class="session-stat-grid">
      ${stat('Prompt active', gatekeeper.permission_prompt_active ? 'Yes' : 'No')}
      ${stat('Pending', gatekeeper.pending_approval_count)}
      ${stat('Confirmations', gatekeeper.confirmation_count)}
      ${stat('Retained approvals', gatekeeper.retained_approval_count)}
    </div>${confirmationRows}`;
}

function logsMarkup(logs) {
  const items = Array.isArray(logs) ? logs : [];
  if (items.length === 0) return empty('No session activity has been recorded.');
  return `<div class="session-log-list">${items.map(logMarkup).join('')}</div>`;
}

function metricsMarkup(metrics) {
  const items = Array.isArray(metrics) ? metrics : [];
  if (items.length === 0) return empty('No session metrics have been recorded.');
  return `<div class="session-metric-grid">${items.map(metricMarkup).join('')}</div>`;
}

function commandMarkup(command) {
  if (!command) return '';
  const acknowledged = acknowledgedCommandLabel(command);
  const labels = {
    accepted: 'Disconnect accepted by the server.',
    pending: 'Waiting for the owning replica to acknowledge the disconnect.',
    acknowledged,
    timeout: 'Disconnect is still pending; acknowledgement polling timed out.',
    unavailable: 'Disconnect accepted; command-status tracking is unavailable.',
  };
  return `<div class="session-command-status session-command-status--${escapeHtml(command.phase)}" role="status">${labels[command.phase] || 'Disconnect status updated.'}</div>`;
}

function confirmationMarkup(item) {
  return `<div class="session-detail-row"><div><strong>${escapeHtml(item.operation)}</strong><span>${escapeHtml(item.scope)} · used ${Number(item.use_count || 0)} time(s)</span></div></div>`;
}

function logMarkup(item) {
  return `<div class="session-log-row session-log-row--${escapeHtml(item.level)}">
    <time>${escapeHtml(formatTime(item.ts))}</time>
    <strong>${escapeHtml(item.event)}</strong>
    <span>${escapeHtml(item.message || item.subsystem || '')}</span>
  </div>`;
}

function metricMarkup(item) {
  return `<div><span>${escapeHtml(item.name)}</span><strong>${Number(item.value || 0).toLocaleString()} ${escapeHtml(item.unit || '')}</strong></div>`;
}

function acknowledgedCommandLabel(command) {
  if (command.status !== 'failed') return `Disconnect acknowledged: ${escapeHtml(command.status || 'completed')}.`;
  const error = command.errorCode ? ` (${escapeHtml(command.errorCode)})` : '';
  return `Disconnect failed${error}.`;
}

function stat(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? 0))}</strong></div>`;
}

function clientName(session) {
  const name = session.client_info?.name || 'MCP client';
  return session.client_info?.version ? `${name} ${session.client_info.version}` : name;
}

function sessionIdCode(id) {
  return `<code class="session-detail-id">${escapeHtml(id || '')}</code>`;
}

function placeholder(text) {
  return `<div class="panel-placeholder">${escapeHtml(text)}</div>`;
}

function empty(text) {
  return `<p class="session-empty">${escapeHtml(text)}</p>`;
}

function prettyJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return '{}'; }
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleTimeString();
}
