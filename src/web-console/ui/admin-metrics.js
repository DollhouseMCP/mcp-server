/**
 * Admin Metrics tab — the MCP server's in-process operational metrics
 * ("System A": cache, performance, gatekeeper, file-locks, security counters).
 * System-wide aggregates, NOT per-session. Admin-only, behind step-up elevation
 * (console:admin:operate).
 *
 * Source: GET /api/v1/admin/operate/metrics/system (latest snapshot from the
 * MemoryMetricsSink). When metrics collection is disabled server-side the
 * response is an empty result and we say so.
 *
 * Look/feel follows the legacy metrics dashboard on Atelier tokens
 * (card grid + stat tiles + tables); no charting lib (CSP `script-src 'self'`).
 */

import { get } from './api.js';

const REFRESH_MS = 10000;
// A multi-instance source with this many instances renders as a full-width
// matrix (metric rows × instance columns); fewer instances stay normal width.
const WIDE_INSTANCE_THRESHOLD = 7;

let host;
let notify = () => {};
let timer = null;
let tabActive = true;

const state = { snapshot: null, meta: null, loading: true, error: false, disabled: false, autoRefresh: false };

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  host.innerHTML = shell();
  host.querySelector('#am-refresh').addEventListener('click', () => load());
  host.querySelector('#am-auto').addEventListener('change', (e) => { state.autoRefresh = e.target.checked; syncTimer(); });
  await load();
  globalThis.addEventListener('dh:tab-activated', onTabActivated);
  document.addEventListener('visibilitychange', syncTimer);
}

async function load() {
  state.loading = true;
  state.error = false;
  renderBody();
  const res = await get('/admin/operate/metrics/system?latest=true').catch(() => null);
  if (!res || res.status !== 200 || !res.body) {
    state.error = true;
    state.loading = false;
    renderBody();
    return;
  }
  const snapshots = Array.isArray(res.body.snapshots) ? res.body.snapshots : [];
  state.snapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  state.meta = { newest: res.body.newest_available, total: res.body.total };
  state.disabled = snapshots.length === 0; // empty result = collection disabled or nothing captured yet
  state.loading = false;
  state.error = false;
  renderBody();
}

/* ── Markup ─────────────────────────────────────────────────────────────── */

function shell() {
  return `
  <div class="metrics-status-bar">
    <span class="metrics-scope-label">System metrics</span>
    <span class="metrics-checked" id="am-checked"></span>
    <div class="metrics-bar-actions">
      <label class="metrics-auto"><input type="checkbox" id="am-auto"> Auto-refresh</label>
      <button class="btn btn-ghost" id="am-refresh" type="button">&#x21bb; Refresh</button>
    </div>
  </div>
  <div id="am-body"></div>`;
}

function renderBody() {
  const body = host?.querySelector('#am-body');
  if (!body) return;
  const checked = host.querySelector('#am-checked');
  if (checked) checked.textContent = state.snapshot && !state.loading ? `as of ${relAgo(state.snapshot.timestamp)}` : '';

  if (state.loading) { body.innerHTML = '<div class="metrics-loading">Loading system metrics…</div>'; return; }
  if (state.error) { body.innerHTML = '<div class="metrics-loading">Couldn\'t load system metrics. Admin elevation is required.</div>'; return; }
  if (state.disabled || !state.snapshot) {
    body.innerHTML = '<div class="metrics-loading">No metrics captured. Server-side metrics collection may be disabled (DOLLHOUSE_METRICS_ENABLED).</div>';
    return;
  }

  const metrics = Array.isArray(state.snapshot.metrics) ? state.snapshot.metrics : [];
  const errors = Array.isArray(state.snapshot.errors) ? state.snapshot.errors : [];
  const sources = groupBySource(metrics);

  const overview = `<div class="metrics-stat-grid">
        ${stat(formatNumber(metrics.length), 'Metrics')}
        ${stat(formatNumber(sources.length), 'Sources')}
        ${stat(formatNumber(errors.length), 'Collector errors')}
        ${stat(`${round(Number(state.snapshot.duration_ms || 0))}ms`, 'Collection time')}
      </div>${errors.length ? `<div class="metrics-alert metrics-alert--warn">${errors.map(escapeHtml).join('<br>')}</div>` : ''}`;

  body.innerHTML = `
    <div class="metrics-dashboard">
      ${overviewCard(overview)}
      ${sources.map(s => sourceCard(s.source, s.badge, s.matrix ? sourceMatrix(s.metrics) : sourceTable(s.metrics), s.wide)).join('')}
    </div>`;
}

// An "instance" is one distinct label-set within a source (e.g. one cache, or
// one severity/type pair). Sources with >1 instance carry the same metric names
// repeated per instance → rendered as a matrix (metric rows × instance columns)
// instead of a long, repetitive flat list.
function instanceKeyOf(m) {
  const labels = m.labels || {};
  const keys = Object.keys(labels).sort();
  return keys.length ? keys.map(k => labels[k]).join(' · ') : '(default)';
}

function groupBySource(metrics) {
  const map = new Map();
  for (const m of metrics) {
    const src = m.source || '(unknown)';
    if (!map.has(src)) map.set(src, []);
    map.get(src).push(m);
  }
  const groups = [...map.entries()].map(([source, items]) => {
    const instanceCount = new Set(items.map(instanceKeyOf)).size;
    const matrix = instanceCount > 1;
    const wide = matrix && instanceCount >= WIDE_INSTANCE_THRESHOLD;
    const sorted = items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const badge = matrix ? `${instanceCount}×${new Set(items.map(m => m.name)).size}` : String(items.length);
    return { source, metrics: sorted, matrix, wide, badge, count: items.length };
  });
  // Non-wide cards first (tile two-up, ordered by size); full-width matrices
  // stack at the bottom so they never leave a short neighbour with empty space.
  return groups.sort((a, b) =>
    (a.wide ? 1 : 0) - (b.wide ? 1 : 0) || a.count - b.count || a.source.localeCompare(b.source));
}

function sourceTable(metrics) {
  if (metrics.length === 0) return '<div class="metrics-empty">No metrics.</div>';
  const rows = metrics.map(m => {
    const d = displayValueUnit(m);
    return `
    <tr>
      <td>${escapeHtml(m.name)}${labelTags(m.labels)}</td>
      <td class="metrics-num">${d.value}</td>
      <td class="metrics-unit">${escapeHtml(d.unit)}</td>
    </tr>`;
  }).join('');
  return `<table class="metrics-table"><thead><tr><th>Metric</th><th>Value</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Byte-valued counters/gauges render human-readable (KB/MB/GB), with the unit
// folded into the value so the unit column doesn't redundantly say "bytes".
function displayValueUnit(m) {
  if (m.unit === 'bytes' && typeof m.value === 'number') {
    return { value: escapeHtml(formatBytes(m.value)), unit: '' };
  }
  return { value: formatValue(m), unit: m.unit || '' };
}

// Counters/gauges → a single number. Histograms → a compact avg · p95 (n) summary.
function formatValue(m) {
  if (m.type === 'histogram' && m.value && typeof m.value === 'object') {
    const h = m.value;
    const parts = [];
    if (typeof h.avg === 'number') parts.push(`avg ${formatNumber(round(h.avg))}`);
    if (typeof h.p95 === 'number') parts.push(`p95 ${formatNumber(round(h.p95))}`);
    parts.push(`n=${formatNumber(h.count || 0)}`);
    return `<span title="${escapeHtml(histTitle(h))}">${parts.join(' · ')}</span>`;
  }
  return formatNumber(typeof m.value === 'number' ? m.value : 0);
}

function histTitle(h) {
  return ['count', 'sum', 'min', 'max', 'avg', 'p50', 'p75', 'p90', 'p95', 'p99']
    .filter(k => typeof h[k] === 'number')
    .map(k => `${k}=${round(h[k])}`).join('  ');
}

function labelTags(labels) {
  if (!labels || typeof labels !== 'object') return '';
  const entries = Object.entries(labels).filter(([, v]) => typeof v === 'string');
  if (entries.length === 0) return '';
  return ' ' + entries.map(([k, v]) => `<span class="metrics-label">${escapeHtml(k)}=${escapeHtml(v)}</span>`).join(' ');
}

// Full-width banner across the top of the grid.
function overviewCard(inner) {
  return `<div class="metrics-card metrics-card--overview">
    <div class="metrics-card-header metrics-card-header--static"><span class="metrics-card-title">Overview</span></div>
    <div class="metrics-card-body">${inner}</div>
  </div>`;
}

// One source card. `badge` is a pre-formatted string (metric count, or
// "instances×metrics" for a matrix source).
function sourceCard(title, badge, inner, wide = false) {
  return `<div class="metrics-card${wide ? ' metrics-card--wide' : ''}">
    <div class="metrics-card-header metrics-card-header--static">
      <span class="metrics-card-title">${escapeHtml(title)}</span>
      <span class="metrics-card-meta"><span class="metrics-card-count">${escapeHtml(badge)}</span></span>
    </div>
    <div class="metrics-card-body">${inner}</div>
  </div>`;
}

// Multi-instance source → matrix: rows = unique metric names, columns = the
// distinct instances (label-sets). One row of e.g. hits_total reads across all
// caches, instead of repeating the name once per instance.
function sourceMatrix(metrics) {
  if (metrics.length === 0) return '<div class="metrics-empty">No metrics.</div>';
  const instances = [];
  const seen = new Set();
  for (const m of metrics) { const k = instanceKeyOf(m); if (!seen.has(k)) { seen.add(k); instances.push(k); } }
  const names = [...new Set(metrics.map(m => m.name))].sort((a, b) => a.localeCompare(b));
  const cell = new Map();
  for (const m of metrics) cell.set(`${m.name} ${instanceKeyOf(m)}`, m);

  const head = `<tr><th>Metric</th>${instances.map(i => `<th class="metrics-num">${escapeHtml(i)}</th>`).join('')}</tr>`;
  const rows = names.map(name => {
    const sample = metrics.find(m => m.name === name);
    const unit = sample && sample.unit !== 'bytes' ? sample.unit : '';
    const cells = instances.map(i => {
      const m = cell.get(`${name} ${i}`);
      return m ? `<td class="metrics-num">${matrixCell(m)}</td>` : '<td class="metrics-num metrics-dim">—</td>';
    }).join('');
    return `<tr><td>${escapeHtml(name)}${unit ? ` <span class="metrics-unit">${escapeHtml(unit)}</span>` : ''}</td>${cells}</tr>`;
  }).join('');
  return `<div class="metrics-matrix-wrap"><table class="metrics-table metrics-matrix"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

// Compact scalar for a matrix cell (no per-cell unit; the row carries it).
function matrixCell(m) {
  if (m.type === 'histogram' && m.value && typeof m.value === 'object') {
    const h = m.value;
    return formatNumber(round(typeof h.avg === 'number' ? h.avg : (h.count || 0)));
  }
  if (m.unit === 'bytes' && typeof m.value === 'number') return escapeHtml(formatBytes(m.value));
  return formatNumber(typeof m.value === 'number' ? m.value : 0);
}

function stat(value, label) {
  return `<div class="metrics-stat"><div class="metrics-stat-value">${escapeHtml(value)}</div><div class="metrics-stat-label">${escapeHtml(label)}</div></div>`;
}

/* ── Polling ────────────────────────────────────────────────────────────── */

function syncTimer() {
  const shouldRun = state.autoRefresh && tabActive && !document.hidden;
  if (shouldRun && !timer) timer = setInterval(load, REFRESH_MS);
  else if (!shouldRun && timer) { clearInterval(timer); timer = null; }
}

function onTabActivated(e) {
  tabActive = e.detail?.name === 'admin-metrics';
  if (tabActive) load();
  syncTimer();
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (Math.abs(b) < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = b / 1024;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

function relAgo(ts) {
  if (!ts) return 'unknown';
  const age = Date.now() - new Date(ts).getTime();
  if (age < 0 || age < 10_000) return 'just now';
  const s = Math.floor(age / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
