/** Operator-safe log and metric snapshots. SSE routes are finite exports, so UI refresh uses GET polling. */

import { get } from './api.js';
import { init as initSystemMetrics } from './admin-metrics.js';
import { isAbortError } from './polling.js';
import { createCursorPager, escapeAttr, escapeHtml, formatTimestamp, responseDetail } from './operations-ui.js';

export function createOperationalLogsView() {
  let container;
  let items = [];
  let hasSnapshot = false;
  const pager = createCursorPager();
  let requestController;
  let requestVersion = 0;
  const filters = { level: '', subsystem: '', event: '' };

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.innerHTML = logShell();
      container.querySelector('[data-operational-log-filters]').addEventListener('submit', applyFilters);
      container.addEventListener('click', onClick);
    },
    async load(signal) {
      const version = ++requestVersion;
      const response = await get(logPath(filters, pager.cursor()), { signal });
      if (version !== requestVersion) return;
      if (response.status !== 200 || !response.body) {
        showLogProblem(responseDetail(response, 'Operational logs could not be loaded.'));
        return;
      }
      items = Array.isArray(response.body.items) ? response.body.items : [];
      pager.apply(response.body.page);
      hasSnapshot = true;
      renderLogs();
    },
    showError(message) {
      showLogProblem(message);
    },
    setVisible(visible) {
      if (!visible) abortRequest();
    },
  });

  function applyFilters(event) {
    event.preventDefault();
    const form = event.currentTarget;
    filters.level = form.elements.level.value;
    filters.subsystem = form.elements.subsystem.value.trim();
    filters.event = form.elements.event.value.trim();
    pager.reset();
    loadFromUi();
  }

  function onClick(event) {
    if (event.target.closest('[data-log-next]') && pager.moveNext()) {
      loadFromUi();
    }
    if (event.target.closest('[data-log-previous]') && pager.movePrevious()) {
      loadFromUi();
    }
  }

  async function loadFromUi() {
    abortRequest();
    const controller = new AbortController();
    requestController = controller;
    const version = ++requestVersion;
    if (!hasSnapshot) renderLogState('Loading operational logs…');
    try {
      const response = await get(logPath(filters, pager.cursor()), { signal: controller.signal });
      if (version !== requestVersion) return;
      if (response.status !== 200 || !response.body) {
        showLogProblem(responseDetail(response, 'Operational logs could not be loaded.'));
        return;
      }
      items = Array.isArray(response.body.items) ? response.body.items : [];
      pager.apply(response.body.page);
      hasSnapshot = true;
      renderLogs();
    } catch (error) {
      if (!isAbortError(error)) showLogProblem('Operational logs could not reach the server.');
    } finally {
      if (requestController === controller) requestController = undefined;
    }
  }

  function renderLogs() {
    const body = container.querySelector('[data-operational-log-body]');
    const status = container.querySelector('[data-operational-log-status]');
    status.textContent = `${items.length} allowlisted event${items.length === 1 ? '' : 's'} in this page.`;
    body.innerHTML = items.length === 0
      ? '<div class="operations-state">No operational events match these filters.</div>'
      : `<div class="operations-table-wrap"><table class="operations-table"><thead><tr><th>Time</th><th>Level</th><th>Subsystem</th><th>Event</th><th>Session / account</th><th>Result</th></tr></thead><tbody>${items.map(logRow).join('')}</tbody></table></div>`;
    container.querySelector('[data-log-previous]').disabled = !pager.hasPrevious();
    container.querySelector('[data-log-next]').disabled = !pager.nextCursor();
    container.querySelector('[data-operational-log-warning]')?.remove();
  }

  function renderLogState(message, kind = 'neutral') {
    container.querySelector('[data-operational-log-body]').innerHTML = `<div class="operations-state operations-state--${kind}">${escapeHtml(message)}</div>`;
  }

  function showLogProblem(message) {
    if (!hasSnapshot) {
      renderLogState(message, 'error');
      return;
    }
    container.querySelector('[data-operational-log-warning]')?.remove();
    container.querySelector('[data-operational-log-body]')?.insertAdjacentHTML(
      'beforebegin',
      `<p class="operations-inline-message operations-inline-message--warn" data-operational-log-warning>${escapeHtml(message)} Showing the last successful snapshot.</p>`,
    );
  }

  function abortRequest() {
    requestController?.abort();
    requestController = undefined;
    requestVersion += 1;
  }
}

export function createOperationalMetricsView(ctx = {}) {
  let container;
  let systemMetrics;
  let lastBody;

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.innerHTML = `<div class="operations-section-heading"><div><h3>Metrics</h3><p>Allowlisted activity aggregates and in-process server snapshots.</p></div></div>
        <section class="operations-card operations-operational-metrics"><header><h3>Operational activity</h3></header><div data-operational-metrics-body><div class="operations-state">Loading operational metrics…</div></div></section>
        <section class="operations-system-metrics" data-system-metrics></section>`;
      const systemHost = container.querySelector('[data-system-metrics]');
      if (ctx.hasRoute?.('GET', '/admin/operate/metrics/system')) {
        systemMetrics = initSystemMetrics(systemHost);
      } else {
        systemHost.hidden = true;
      }
    },
    async load(signal) {
      if (!ctx.hasRoute?.('GET', '/admin/operate/metrics')) return;
      const response = await get('/admin/operate/metrics', { signal });
      if (response.status !== 200 || !response.body) {
        showMetricProblem(responseDetail(response, 'Operational metrics could not be loaded.'));
        return;
      }
      lastBody = response.body;
      renderMetrics(response.body);
    },
    showError(message) {
      showMetricProblem(message);
    },
    setVisible(visible) {
      systemMetrics?.setVisible(visible);
    },
    async refresh(signal) {
      await Promise.all([
        this.load(signal),
        systemMetrics?.refresh(signal),
      ]);
    },
  });

  function renderMetrics(body) {
    const metrics = Array.isArray(body.metrics) ? body.metrics : [];
    const target = container.querySelector('[data-operational-metrics-body]');
    container.querySelector('[data-operational-metrics-warning]')?.remove();
    if (metrics.length === 0) {
      target.innerHTML = '<div class="operations-state">No operational activity metrics are available.</div>';
      return;
    }
    target.innerHTML = `<div class="operations-table-wrap"><table class="operations-table"><thead><tr><th>Metric</th><th>Kind</th><th>Value</th><th>Dimensions</th></tr></thead><tbody>${metrics.map(metricRow).join('')}</tbody></table></div><p class="operations-checked">Checked ${escapeHtml(formatTimestamp(body.checked_at))}</p>`;
  }

  function renderMetricState(message, kind) {
    const target = container?.querySelector('[data-operational-metrics-body]');
    if (target) target.innerHTML = `<div class="operations-state operations-state--${kind}">${escapeHtml(message)}</div>`;
  }

  function showMetricProblem(message) {
    if (!lastBody) {
      renderMetricState(message, 'error');
      return;
    }
    container.querySelector('[data-operational-metrics-warning]')?.remove();
    container.querySelector('[data-operational-metrics-body]')?.insertAdjacentHTML(
      'beforebegin',
      `<p class="operations-inline-message operations-inline-message--warn" data-operational-metrics-warning>${escapeHtml(message)} Showing the last successful snapshot.</p>`,
    );
  }
}

function logShell() {
  return `<div class="operations-section-heading"><div><h3>Operational logs</h3><p>Allowlisted event metadata only; prompt and portfolio content are never included.</p></div></div>
    <form class="operations-filter-bar" data-operational-log-filters>
      <label><span>Level</span><select name="level"><option value="">All levels</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option></select></label>
      <label><span>Subsystem</span><input name="subsystem" maxlength="64" placeholder="runtime"></label>
      <label><span>Event</span><input name="event" maxlength="128" placeholder="session.started"></label>
      <button class="btn btn-primary" type="submit">Apply filters</button>
    </form>
    <p class="operations-checked" data-operational-log-status aria-live="polite"></p>
    <div data-operational-log-body><div class="operations-state">Loading operational logs…</div></div>
    <div class="operations-pagination"><button class="btn btn-ghost" data-log-previous type="button" disabled>Previous</button><button class="btn btn-ghost" data-log-next type="button" disabled>Next</button></div>`;
}

function logPath(filters, cursor) {
  const params = new URLSearchParams({ limit: '50' });
  if (filters.level) params.set('level', filters.level);
  if (filters.subsystem) params.set('subsystem', filters.subsystem);
  if (filters.event) params.set('event', filters.event);
  if (cursor) params.set('cursor', cursor);
  return `/admin/operate/logs?${params.toString()}`;
}

function logRow(item) {
  const correlation = item.session_id || item.account_correlation_id || '—';
  const result = item.error_code || (item.status_code ? `HTTP ${item.status_code}` : '—');
  return `<tr><td>${escapeHtml(formatTimestamp(item.ts))}</td><td><span class="operations-log-level operations-log-level--${escapeAttr(item.level)}">${escapeHtml(item.level)}</span></td><td><code>${escapeHtml(item.subsystem)}</code></td><td><code>${escapeHtml(item.event)}</code></td><td><code>${escapeHtml(correlation)}</code></td><td><code>${escapeHtml(result)}</code></td></tr>`;
}

function metricRow(metric) {
  const dimensions = metric.dimensions && typeof metric.dimensions === 'object'
    ? Object.entries(metric.dimensions).map(([key, value]) => `${key}=${value}`).join(' · ')
    : '';
  return `<tr><td><code>${escapeHtml(metric.name)}</code><br><small>${escapeHtml(metric.unit)}</small></td><td>${escapeHtml(metric.kind)}</td><td class="operations-number">${Number(metric.value || 0).toLocaleString()}</td><td>${escapeHtml(dimensions || '—')}</td></tr>`;
}
