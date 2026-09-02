/** Capability-gated operator workspace for deployment health and control. */

import { get } from './api.js';
import { createVisiblePoller, isAbortError } from './polling.js';
import { createOperatorConfigView } from './operations-config.js';
import { createOperationalLogsView, createOperationalMetricsView } from './operations-telemetry.js';
import { createOperationalSessionsView } from './operations-sessions.js';
import { escapeHtml, formatTimestamp, responseDetail } from './operations-ui.js';

const REFRESH_INTERVAL_MS = 10_000;

let host;
let tabVisible = true;
let elevationActive = true;
let activeSection;
let poller;
let oneShotController;
let views = new Map();

export function init(panelEl, ctx = {}) {
  host = panelEl;
  const hasRoute = ctx.hasRoute || (() => false);
  const definitions = sectionDefinitions(hasRoute, ctx);
  views = new Map(definitions.map(definition => [definition.id, definition]));
  host.innerHTML = shell(definitions);
  wireNavigation();
  globalThis.addEventListener('dh:tab-activated', onTabActivated);
  globalThis.addEventListener('dh:elevation-changed', onElevationChanged);
  document.addEventListener('visibilitychange', onDocumentVisibilityChanged);

  if (definitions.length === 0) {
    host.querySelector('#operations-content').innerHTML = '<div class="panel-placeholder">No operator features are available in this deployment.</div>';
    return;
  }
  for (const definition of definitions) {
    const panel = host.querySelector(`[data-operations-panel="${definition.id}"]`);
    definition.view.mount(panel);
  }
  selectSection(definitions[0].id);
}

function sectionDefinitions(hasRoute, ctx) {
  const definitions = [];
  if (hasRoute('GET', '/admin/operate/health')) {
    definitions.push({ id: 'health', label: 'Health', poll: true, view: createHealthView(ctx) });
  }
  if (hasRoute('GET', '/admin/operate/config')) {
    definitions.push({ id: 'config', label: 'Configuration', poll: false, view: createOperatorConfigView(ctx) });
  }
  if (hasRoute('GET', '/admin/operate/logs')) {
    definitions.push({ id: 'logs', label: 'Logs', poll: true, view: createOperationalLogsView(ctx) });
  }
  if (hasRoute('GET', '/admin/operate/metrics') || hasRoute('GET', '/admin/operate/metrics/system')) {
    definitions.push({ id: 'metrics', label: 'Metrics', poll: true, view: createOperationalMetricsView(ctx) });
  }
  if (hasRoute('GET', '/admin/operate/sessions')) {
    definitions.push({ id: 'sessions', label: 'Sessions', poll: true, view: createOperationalSessionsView(ctx) });
  }
  return definitions;
}

function shell(definitions) {
  const navigation = definitions.map(definition =>
    `<button class="operations-nav-button" data-operations-nav="${definition.id}" type="button">${definition.label}</button>`).join('');
  const panels = definitions.map(definition =>
    `<section class="operations-panel" data-operations-panel="${definition.id}" aria-label="${definition.label}" hidden></section>`).join('');
  return `
    <header class="operations-header">
      <div><p class="operations-eyebrow">Elevated operator workspace</p><h2>Operations</h2><p>Allowlisted deployment health, configuration, telemetry, and runtime control.</p></div>
      <button class="btn btn-ghost" id="operations-refresh" type="button">&#x21bb; Refresh</button>
    </header>
    <nav class="operations-nav" aria-label="Operations sections">${navigation}</nav>
    <div id="operations-content">${panels}</div>`;
}

function wireNavigation() {
  host.querySelectorAll('[data-operations-nav]').forEach(button => {
    button.addEventListener('click', () => selectSection(button.dataset.operationsNav));
  });
  host.querySelector('#operations-refresh')?.addEventListener('click', () => refreshActiveSection());
}

function selectSection(sectionId) {
  const definition = views.get(sectionId);
  if (!definition) return;
  activeSection = sectionId;
  host.querySelectorAll('[data-operations-nav]').forEach(button => {
    const selected = button.dataset.operationsNav === sectionId;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  });
  host.querySelectorAll('[data-operations-panel]').forEach(panel => {
    panel.hidden = panel.dataset.operationsPanel !== sectionId;
  });
  syncViewVisibility();
  startActivePolling(true);
}

function startActivePolling(immediate) {
  stopActiveWork();
  const definition = views.get(activeSection);
  if (!definition || !operationsVisible()) return;
  if (!definition.poll) {
    if (immediate) loadOnce(definition);
    return;
  }
  poller = createVisiblePoller(
    signal => definition.view.load(signal),
    { intervalMs: REFRESH_INTERVAL_MS, onError: handleRefreshError },
  );
  poller.start({ immediate });
}

function refreshActiveSection() {
  const definition = views.get(activeSection);
  if (!definition || !operationsVisible()) return;
  if (definition.view.refresh) {
    loadOnce(definition, definition.view.refresh);
  } else if (definition.poll) {
    poller?.refresh();
  } else {
    loadOnce(definition);
  }
}

function onTabActivated(event) {
  tabVisible = event.detail?.name === 'operations';
  syncLifecycle();
}

function onElevationChanged(event) {
  elevationActive = event.detail?.active === true;
  syncLifecycle();
}

function onDocumentVisibilityChanged() {
  syncLifecycle();
}

function syncLifecycle() {
  syncViewVisibility();
  if (operationsVisible()) startActivePolling(true);
  else stopActiveWork();
}

function syncViewVisibility() {
  const visible = operationsVisible();
  views.forEach(item => item.view.setVisible?.(item.id === activeSection && visible));
}

function operationsVisible() {
  return tabVisible && elevationActive && !document.hidden;
}

function stopActiveWork() {
  poller?.stop();
  poller = undefined;
  oneShotController?.abort();
  oneShotController = undefined;
}

function loadOnce(definition, task = definition.view.load) {
  oneShotController?.abort();
  const controller = new AbortController();
  oneShotController = controller;
  Promise.resolve(task.call(definition.view, controller.signal))
    .catch(handleRefreshError)
    .finally(() => {
      if (oneShotController === controller) oneShotController = undefined;
    });
}

function handleRefreshError(error) {
  if (isAbortError(error)) return;
  const definition = views.get(activeSection);
  definition?.view.showError?.('The current operator snapshot could not be refreshed.');
}

function createHealthView(ctx) {
  let container;
  let lastBody;
  return Object.freeze({
    mount(panel) {
      container = panel;
      container.innerHTML = '<div class="operations-state">Loading deployment health…</div>';
    },
    async load(signal) {
      const response = await get('/admin/operate/health', { signal });
      if ((response.status !== 200 && response.status !== 503) || !response.body) {
        showState(container, responseDetail(response, 'Deployment health could not be loaded.'), 'error');
        return;
      }
      lastBody = response.body;
      renderHealth(container, lastBody);
    },
    showError(message) {
      if (lastBody) renderHealth(container, lastBody, message);
      else showState(container, message, 'error');
      ctx.toast?.(message, 'warn');
    },
  });
}

function renderHealth(container, health, staleMessage = '') {
  const components = Array.isArray(health.components) ? health.components : [];
  const checked = formatTimestamp(health.checked_at);
  const stale = staleMessage ? `<p class="operations-inline-message operations-inline-message--warn">${escapeHtml(staleMessage)}</p>` : '';
  container.innerHTML = `${stale}
    <div class="operations-summary-card operations-summary-card--${statusClass(health.status)}">
      <div><p class="operations-eyebrow">Deployment status</p><h3>${escapeHtml(statusLabel(health.status))}</h3></div>
      <span>Checked ${escapeHtml(checked)}</span>
    </div>
    <div class="operations-health-grid">${components.map(healthComponent).join('')}</div>`;
}

function healthComponent(component) {
  const codes = Array.isArray(component.failure_codes) ? component.failure_codes : [];
  const codeItems = codes.map(code => `<li><code>${escapeHtml(code)}</code></li>`).join('');
  const failures = codes.length > 0
    ? `<ul>${codeItems}</ul>`
    : '<p>No reported failures.</p>';
  return `<article class="operations-card operations-health-card operations-health-card--${statusClass(component.status)}">
    <header><h3>${escapeHtml(componentLabel(component.component))}</h3><span class="operations-status">${escapeHtml(statusLabel(component.status))}</span></header>
    ${failures}
  </article>`;
}

function componentLabel(value) {
  return String(value || 'component').replaceAll('_', ' ').replaceAll(/\b\w/g, character => character.toUpperCase());
}

function statusLabel(value) {
  if (value === 'ok') return 'Healthy';
  if (value === 'degraded') return 'Degraded';
  if (value === 'not_ready') return 'Not ready';
  return 'Unavailable';
}

function statusClass(value) {
  return value === 'ok' || value === 'degraded' || value === 'not_ready' ? value.replace('_', '-') : 'unavailable';
}

function showState(container, message, kind = 'neutral') {
  container.innerHTML = `<div class="operations-state operations-state--${kind}">${escapeHtml(message)}</div>`;
}
