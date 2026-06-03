/**
 * Logs tab module — the authenticated user's own server logs, across all their
 * sessions.
 *
 * The look, virtual-scrolling buffer, filters, selection, detail modal and trace
 * banner are lifted from the legacy console log viewer (src/web/public/logs.js).
 * Two things differ from the legacy:
 *   - Data comes from GET /api/v1/me/logs (the backend-agnostic MemoryLogSink
 *     seam), not the old /api/logs endpoints.
 *   - Live updates are *polled* incrementally (`?since=<newestTs>`) rather than
 *     streamed over SSE. The sink is query-only; polling also sidesteps the
 *     legacy SSE backpressure/jumpiness. We poll for entries strictly newer than
 *     the newest one we hold and append them to a capped buffer.
 *
 * Server-side filters (re-fetch the buffer when changed): level, correlationId,
 * sessionId — these scope the query so history isn't limited to whatever the
 * buffer happened to hold. Client-side filters (instant, over the buffer, legacy
 * style): category, source, message.
 */

import { get } from './api.js';

const BUFFER_SIZE = 10000;
const ROW_HEIGHT = 22;
const OVERSCAN = 5;
const SEARCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 2500;
const INITIAL_LIMIT = 500;
const POLL_LIMIT = 200;

// ── State ────────────────────────────────────────────────────────────────
const buffer = [];
let filteredIndices = null;
let paused = false;
let autoScroll = true;
let searchTimer = null;
let newestTs = null;        // newest entry timestamp we hold — the poll cursor
let pollTimer = null;
let pollInFlight = false;
let lastPollFailed = false;
let panelActive = false;

// Selection state
const selectedIds = new Set();
let lastClickedIndex = -1; // for shift-click range select

// Sessions discovered in the user's logs (id → friendly label), accumulated as
// entries arrive so the Session dropdown lists every session we've seen.
const knownSessions = new Map();

// Filter state
let filterCategory = '';
let filterLevel = 'info';  // Default to info — excludes debug noise from view
let filterSource = '';
let filterMessage = '';
let filterCorrelationId = '';
let filterSessionId = '';

let toast = () => {};

// ── DOM references ─────────────────────────────────────────────────────
let host;
let viewport, scrollSpacer, jumpBtn, statusDot, statusText, entryCountEl;
let sessionSelect, categorySelect, levelSelect, sourceInput, searchInput, pauseBtn, clearBtn;
let detailModal, copySelectedBtn, selectCountEl;
const rowPool = [];

// Filters whose change requires a server re-query (vs. instant buffer re-filter).
const SERVER_SIDE_FILTERS = new Set(['level', 'correlationId', 'sessionId']);

// ── Entry point ────────────────────────────────────────────────────────────
export async function init(panelEl, ctx = {}) {
  host = panelEl;
  toast = ctx.toast || toast;

  buildDOM(host);
  bindEvents();
  panelActive = true;

  await reload();
  startPolling();

  // Poll only while the Logs tab is the active one and the page is visible.
  window.addEventListener('dh:tab-activated', (e) => {
    panelActive = e.detail?.name === 'logs';
    if (panelActive) startPolling();
    else stopPolling();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && panelActive) startPolling();
    else stopPolling();
  });
  // Cross-link from the Sessions tab: filter to a specific session's logs.
  window.addEventListener('dh:filter-logs-by-session', (e) => {
    const sid = e.detail?.sessionId;
    if (sid) refilter(sid);
  });

  requestAnimationFrame(() => {
    renderViewport();
    if (autoScroll) scrollToBottom();
  });
}

// ── DOM construction ─────────────────────────────────────────────────────
function buildDOM(container) {
  container.innerHTML = `
    <div class="log-viewer">
      <div class="log-controls">
        <div class="log-filter-group">
          <label for="log-session">Session</label>
          <select id="log-session" class="log-session-select" title="Filter by session">
            <option value="">All sessions</option>
          </select>
        </div>
        <div class="log-filter-group">
          <label for="log-category">Cat</label>
          <select id="log-category">
            <option value="">All</option>
            <option value="application">application</option>
            <option value="security">security</option>
            <option value="performance">performance</option>
            <option value="telemetry">telemetry</option>
          </select>
        </div>
        <div class="log-filter-group">
          <label for="log-level">Level</label>
          <select id="log-level">
            <option value="">All</option>
            <option value="debug">debug</option>
            <option value="info" selected>info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </div>
        <div class="log-filter-group">
          <label for="log-source">Source</label>
          <input type="text" id="log-source" class="log-search" placeholder="source filter...">
        </div>
        <div class="log-filter-group">
          <label for="log-search">Search</label>
          <input type="search" id="log-search" class="log-search" placeholder="message search...">
        </div>
      </div>
      <div class="log-status-bar">
        <span class="log-status-indicator">
          <span class="log-status-dot" id="log-status-dot"></span>
          <span id="log-status-text">connecting...</span>
        </span>
        <button class="log-action-btn" id="log-pause-btn">Pause</button>
        <button class="log-action-btn" id="log-clear-btn">Clear</button>
        <button class="log-action-btn" id="log-copy-selected-btn" style="display:none">Copy Selected (<span id="log-select-count">0</span>)</button>
        <button class="log-action-btn" id="log-deselect-btn" style="display:none">Deselect All</button>
        <span class="log-entry-count" id="log-entry-count">0 entries</span>
      </div>
      <div class="log-trace-banner" id="log-trace-banner" style="display:none">
        <span class="log-trace-banner-icon">&#x1f517;</span>
        <span>Tracing request: <code id="log-trace-id"></code></span>
        <span id="log-trace-count"></span>
        <button class="log-trace-clear" id="log-trace-clear">&#x2715; Clear trace</button>
      </div>
      <div class="log-viewport" id="log-viewport">
        <div class="log-scroll-spacer" id="log-scroll-spacer"></div>
      </div>
      <button class="log-jump-bottom" id="log-jump-bottom">Jump to bottom</button>
    </div>

    <div class="log-detail-modal" id="log-detail-modal" hidden>
      <div class="log-detail-backdrop" id="log-detail-backdrop"></div>
      <div class="log-detail-card">
        <div class="log-detail-card-header">
          <span class="log-detail-card-title" id="log-detail-title">Log Entry</span>
          <div class="log-detail-card-actions">
            <button class="log-action-btn" id="log-detail-copy-text">Copy Text</button>
            <button class="log-action-btn" id="log-detail-copy-json">Copy JSON</button>
            <button class="log-detail-close" id="log-detail-close">&#x2715;</button>
          </div>
        </div>
        <div class="log-detail-card-body" id="log-detail-body"></div>
      </div>
    </div>
  `;

  viewport = container.querySelector('#log-viewport');
  scrollSpacer = container.querySelector('#log-scroll-spacer');
  jumpBtn = container.querySelector('#log-jump-bottom');
  statusDot = container.querySelector('#log-status-dot');
  statusText = container.querySelector('#log-status-text');
  entryCountEl = container.querySelector('#log-entry-count');
  sessionSelect = container.querySelector('#log-session');
  categorySelect = container.querySelector('#log-category');
  levelSelect = container.querySelector('#log-level');
  if (levelSelect && filterLevel) levelSelect.value = filterLevel;  // Sync dropdown with default
  sourceInput = container.querySelector('#log-source');
  searchInput = container.querySelector('#log-search');
  pauseBtn = container.querySelector('#log-pause-btn');
  clearBtn = container.querySelector('#log-clear-btn');
  detailModal = container.querySelector('#log-detail-modal');
  copySelectedBtn = container.querySelector('#log-copy-selected-btn');
  selectCountEl = container.querySelector('#log-select-count');
}

function bindEvents() {
  viewport.addEventListener('scroll', onScroll);
  jumpBtn.addEventListener('click', () => {
    autoScroll = true;
    scrollToBottom();
    jumpBtn.classList.remove('visible');
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('active', paused);
    setStatus(paused ? 'paused' : 'live');
    if (!paused) scheduleRender();
  });

  clearBtn.addEventListener('click', () => {
    buffer.length = 0;
    filteredIndices = null;
    selectedIds.clear();
    updateSelectionUI();
    applyFilters();
    renderViewport();
  });

  // Copy selected
  copySelectedBtn.addEventListener('click', copySelectedEntries);
  host.querySelector('#log-deselect-btn').addEventListener('click', () => {
    selectedIds.clear();
    updateSelectionUI();
    renderViewport();
  });

  // Detail modal
  host.querySelector('#log-detail-close').addEventListener('click', closeDetailModal);
  host.querySelector('#log-detail-backdrop').addEventListener('click', closeDetailModal);
  host.querySelector('#log-detail-copy-text').addEventListener('click', () => copyDetailAs('text'));
  host.querySelector('#log-detail-copy-json').addEventListener('click', () => copyDetailAs('json'));

  // Keyboard: Escape closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailModal && !detailModal.hidden) {
      closeDetailModal();
    }
  });

  // category/source/message are client-side (instant); session/level/trace re-query.
  sessionSelect.addEventListener('change', () => { filterSessionId = sessionSelect.value; reload(); });
  // Refresh the "active / Xm ago" recency right before the menu opens.
  sessionSelect.addEventListener('mousedown', () => rebuildSessionOptions());
  sessionSelect.addEventListener('focus', () => rebuildSessionOptions());
  categorySelect.addEventListener('change', () => { filterCategory = categorySelect.value; applyFilters(); });
  levelSelect.addEventListener('change', () => { filterLevel = levelSelect.value; reload(); });
  sourceInput.addEventListener('input', () => { filterSource = sourceInput.value; applyFiltersDebounced(); });
  searchInput.addEventListener('input', () => { filterMessage = searchInput.value; applyFiltersDebounced(); });
  host.querySelector('#log-trace-clear').addEventListener('click', clearTraceFilter);
}

/* ── Public hooks ─────────────────────────────────────────────────────────── */

// Scope the view to one session. Also exposed for the Sessions tab to drive
// (when wired); the in-tab Session dropdown calls reload() directly.
export function refilter(sessionId) {
  filterSessionId = sessionId || '';
  reload();
}

function setTraceFilter(correlationId) {
  filterCorrelationId = correlationId;
  const banner = host.querySelector('#log-trace-banner');
  host.querySelector('#log-trace-id').textContent = correlationId;
  banner.style.display = '';
  reload().then(() => {
    host.querySelector('#log-trace-count').textContent = '(' + getVisibleCount() + ' entries)';
  });
}

function clearTraceFilter() {
  filterCorrelationId = '';
  host.querySelector('#log-trace-banner').style.display = 'none';
  reload();
}

// ── Session discovery ──────────────────────────────────────────────────────
// Session IDs are long and opaque (e.g. "web-console:Idhv…tTaEE"); show a short
// friendly label while keeping the full id as the option value.
function sessionLabel(id) {
  const colon = id.indexOf(':');
  if (colon !== -1) {
    const prefix = id.slice(0, colon);
    const rest = id.slice(colon + 1);
    return `${prefix} · …${rest.slice(-6)}`;
  }
  return '…' + id.slice(-8);
}

// A session is "active" if it has produced a log within this window; older than
// that, we show how long ago it was last seen so stale sessions are obvious.
const SESSION_ACTIVE_WINDOW_MS = 90_000;

// Record sessions seen in these entries and track each one's most-recent log
// timestamp (its activity recency). Returns true if a NEW session appeared.
function noteSessions(entries) {
  let grew = false;
  for (const entry of entries) {
    const sid = entry.session_id;
    if (!sid) continue;
    const existing = knownSessions.get(sid);
    if (!existing) {
      knownSessions.set(sid, { label: sessionLabel(sid), lastTs: entry.ts || null });
      grew = true;
    } else if (entry.ts && (!existing.lastTs || entry.ts > existing.lastTs)) {
      existing.lastTs = entry.ts;
    }
  }
  return grew;
}

// Human "last active" suffix for a session, from its newest log timestamp.
function sessionRecency(lastTs) {
  if (!lastTs) return '';
  const age = Date.now() - new Date(lastTs).getTime();
  if (age < 0 || age < SESSION_ACTIVE_WINDOW_MS) return 'active';
  const m = Math.floor(age / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Rebuild the Session dropdown from every session we've seen, preserving the
// current selection (and keeping it selectable even if it has no entries yet).
// Each option is annotated with activity recency ("active" / "12m ago") so
// stale sessions are distinguishable — recomputed each time the menu opens.
function rebuildSessionOptions() {
  if (!sessionSelect) return;
  const ids = [...knownSessions.keys()].sort((a, b) =>
    knownSessions.get(a).label.localeCompare(knownSessions.get(b).label));
  if (filterSessionId && !knownSessions.has(filterSessionId)) ids.unshift(filterSessionId);
  let html = '<option value="">All sessions</option>';
  for (const id of ids) {
    const meta = knownSessions.get(id);
    const label = meta?.label || sessionLabel(id);
    const recency = sessionRecency(meta?.lastTs);
    const text = recency ? `${label} — ${recency}` : label;
    html += `<option value="${escapeHtml(id)}">${escapeHtml(text)}</option>`;
  }
  sessionSelect.innerHTML = html;
  sessionSelect.value = filterSessionId;
}

// ── Fetching & polling ─────────────────────────────────────────────────────
function buildQuery(extra = {}) {
  const params = new URLSearchParams();
  // Server-side filters scope the query so history isn't capped to the buffer.
  if (filterLevel) params.set('level', filterLevel);
  if (filterCorrelationId) params.set('correlation_id', filterCorrelationId);
  if (filterSessionId) params.set('session_id', filterSessionId);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return '/me/logs' + (qs ? '?' + qs : '');
}

// Full reload after a server-side filter change. Replaces the buffer.
async function reload() {
  setStatus('reconnecting');
  const res = await get(buildQuery({ limit: INITIAL_LIMIT })).catch(() => null);
  if (!res || res.status !== 200 || !res.body) {
    lastPollFailed = true;
    setStatus('disconnected');
    updateEntryCount();
    return;
  }
  lastPollFailed = false;
  buffer.length = 0;
  selectedIds.clear();
  updateSelectionUI();
  // The endpoint returns newest-first; the buffer is oldest→newest (newest at
  // the bottom, like the legacy stream).
  const entries = (res.body.entries || []).slice().reverse();
  for (const entry of entries) buffer.push(entry);
  newestTs = entries.length ? entries[entries.length - 1].ts : newestTs;
  noteSessions(entries);
  rebuildSessionOptions();
  applyFilters();
  setStatus(paused ? 'paused' : 'live');
  requestAnimationFrame(() => {
    renderViewport();
    if (autoScroll) scrollToBottom();
  });
}

function startPolling() {
  if (pollTimer || !panelActive) return;
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Incremental tail: fetch only entries strictly newer than newestTs, append.
async function poll() {
  if (pollInFlight || document.visibilityState !== 'visible') return;
  pollInFlight = true;
  try {
    const res = await get(buildQuery({ since: newestTs ?? undefined, limit: POLL_LIMIT }));
    if (res.status !== 200 || !res.body) {
      if (!lastPollFailed) setStatus('disconnected');
      lastPollFailed = true;
      return;
    }
    if (lastPollFailed) setStatus(paused ? 'paused' : 'live');
    lastPollFailed = false;
    const fresh = (res.body.entries || []).slice().reverse(); // oldest→newest
    let added = false;
    for (const entry of fresh) {
      if (appendToBuffer(entry)) added = true;
    }
    if (noteSessions(fresh)) rebuildSessionOptions();
    if (added && !paused) {
      updateEntryCount();
      renderViewport();
      if (autoScroll) scrollToBottom();
    }
  } catch {
    if (!lastPollFailed) setStatus('disconnected');
    lastPollFailed = true;
  } finally {
    pollInFlight = false;
  }
}

// ── Buffer management ─────────────────────────────────────────────────────
function appendToBuffer(entry) {
  // The poll window can overlap; never double-insert.
  if (entry.id && buffer.some(e => e.id === entry.id)) return false;

  if (buffer.length >= BUFFER_SIZE) {
    const removed = buffer.shift();
    if (removed) selectedIds.delete(removed.id);
    if (filteredIndices !== null) {
      filteredIndices = filteredIndices.map(i => i - 1).filter(i => i >= 0);
    }
  }
  buffer.push(entry);
  if (entry.ts && (!newestTs || entry.ts > newestTs)) newestTs = entry.ts;
  if (filteredIndices !== null && matchesFilters(entry)) {
    filteredIndices.push(buffer.length - 1);
  }
  return true;
}

// ── Filtering ────────────────────────────────────────────────────────────
const LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

function matchesFilters(entry) {
  if (filterSessionId && entry.session_id !== filterSessionId) return false;
  if (filterCorrelationId && entry.correlation_id !== filterCorrelationId) return false;
  if (filterCategory && entry.category !== filterCategory) return false;
  if (filterLevel && (LEVEL_PRIORITY[entry.level] || 0) < (LEVEL_PRIORITY[filterLevel] || 0)) return false;
  if (filterSource && !(entry.source || '').toLowerCase().includes(filterSource.toLowerCase())) return false;
  if (filterMessage && !(entry.message || '').toLowerCase().includes(filterMessage.toLowerCase())) return false;
  return true;
}

function applyFilters() {
  const hasFilter = filterCategory || filterLevel || filterSource || filterMessage || filterCorrelationId || filterSessionId;
  if (hasFilter) {
    filteredIndices = [];
    for (let i = 0; i < buffer.length; i++) {
      if (matchesFilters(buffer[i])) filteredIndices.push(i);
    }
  } else {
    filteredIndices = null;
  }
  updateEntryCount();
  renderViewport();
}

function applyFiltersDebounced() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, SEARCH_DEBOUNCE_MS);
}

// ── Virtual scroll rendering ─────────────────────────────────────────────
function getVisibleCount() {
  return filteredIndices === null ? buffer.length : filteredIndices.length;
}

function getEntry(visibleIndex) {
  const bufferIndex = filteredIndices === null ? visibleIndex : filteredIndices[visibleIndex];
  return buffer[bufferIndex];
}

function renderViewport() {
  if (!viewport) return;
  const totalItems = getVisibleCount();
  scrollSpacer.style.height = (totalItems * ROW_HEIGHT) + 'px';

  const scrollTop = viewport.scrollTop;
  let viewHeight = viewport.clientHeight;
  if (viewHeight === 0) viewHeight = 600;

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(totalItems, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);
  const needed = endIdx - startIdx;

  while (rowPool.length < needed) {
    const row = document.createElement('div');
    row.className = 'log-entry';
    row.addEventListener('click', onRowClick);
    scrollSpacer.appendChild(row);
    rowPool.push(row);
  }

  for (let i = 0; i < rowPool.length; i++) {
    const row = rowPool[i];
    if (i < needed) {
      const visIdx = startIdx + i;
      const entry = getEntry(visIdx);
      if (entry) {
        updateRow(row, entry, visIdx);
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    } else {
      row.style.display = 'none';
    }
  }
}

function updateRow(row, entry, visibleIndex) {
  const isSelected = selectedIds.has(entry.id);
  row.style.top = (visibleIndex * ROW_HEIGHT) + 'px';
  row.style.height = ROW_HEIGHT + 'px';
  row.dataset.entryId = entry.id;
  row.dataset.visibleIndex = visibleIndex;
  row.className = 'log-entry level-' + escapeHtml(entry.level) + (isSelected ? ' selected' : '');
  row.innerHTML = renderCompactEntry(entry, isSelected);
}

function renderCompactEntry(entry, isSelected) {
  const time = formatTime(entry.ts);
  const src = escapeHtml(entry.source || '').slice(0, 30);
  const msg = escapeHtml(entry.message || '').slice(0, 300);
  const checkbox = '<span class="log-checkbox' + (isSelected ? ' checked' : '') + '"></span>';
  const corrBadge = entry.correlation_id
    ? '<span class="log-corr-badge" title="Click to trace this request" data-correlation-id="' + escapeHtml(entry.correlation_id) + '">' + escapeHtml(entry.correlation_id.slice(-8)) + '</span>'
    : '<span class="log-corr-badge empty"></span>';
  return checkbox +
    '<span class="log-time">' + time + '</span>' +
    '<span class="log-level ' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</span>' +
    '<span class="log-category">' + escapeHtml(entry.category) + '</span>' +
    corrBadge +
    '<span class="log-source">' + src + '</span>' +
    '<span class="log-message">' + msg + '</span>';
}

// ── Detail modal ─────────────────────────────────────────────────────────
let activeDetailEntry = null;

function openDetailModal(entry) {
  activeDetailEntry = entry;
  const title = host.querySelector('#log-detail-title');
  const body = host.querySelector('#log-detail-body');

  title.textContent = (entry.level || '').toUpperCase() + ' — ' + (entry.source || 'unknown');

  let html = '';
  html += detailField('Timestamp', escapeHtml(entry.ts));
  html += detailField('ID', escapeHtml(entry.id));
  html += detailField('Category', escapeHtml(entry.category));
  html += detailField('Level', '<span class="log-level ' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</span>');
  html += detailField('Source', escapeHtml(entry.source || ''));
  html += detailField('Message', escapeHtml(entry.message || ''));

  if (entry.session_id) {
    html += detailField('Session ID', escapeHtml(entry.session_id));
  }
  if (entry.correlation_id) {
    html += detailField('Correlation ID',
      '<a href="#" class="log-trace-link" data-correlation-id="' + escapeHtml(entry.correlation_id) + '">' +
      '&#x1f517; ' + escapeHtml(entry.correlation_id) + '</a>');
  }

  body.innerHTML = html;
  detailModal.hidden = false;

  // Bind trace link click in modal
  const traceLink = body.querySelector('.log-trace-link');
  if (traceLink) {
    traceLink.addEventListener('click', (e) => {
      e.preventDefault();
      const corrId = traceLink.dataset.correlationId;
      if (corrId) {
        closeDetailModal();
        setTraceFilter(corrId);
      }
    });
  }
}

function closeDetailModal() {
  detailModal.hidden = true;
  activeDetailEntry = null;
}

function detailField(label, value) {
  return '<div class="log-detail-field">' +
    '<span class="log-detail-field-label">' + label + '</span>' +
    '<span class="log-detail-field-value">' + value + '</span>' +
    '</div>';
}

function copyDetailAs(format) {
  if (!activeDetailEntry) return;
  const text = format === 'json'
    ? JSON.stringify(activeDetailEntry, null, 2)
    : formatEntryAsText(activeDetailEntry);
  copyToClipboard(text);
}

// ── Selection & copy ─────────────────────────────────────────────────────
function handleTraceClick(e) {
  const clickedTrace = e.target.closest('.log-corr-badge');
  if (!clickedTrace) return false;
  e.stopPropagation();
  const corrId = clickedTrace.dataset.correlationId;
  if (corrId) {
    if (filterCorrelationId === corrId) clearTraceFilter();
    else setTraceFilter(corrId);
  }
  return true;
}

function handleSelectionClick(e, entryId, visIdx) {
  const clickedCheckbox = e.target.closest('.log-checkbox');

  if (e.shiftKey && lastClickedIndex >= 0) {
    const start = Math.min(lastClickedIndex, visIdx);
    const end = Math.max(lastClickedIndex, visIdx);
    for (let i = start; i <= end; i++) {
      const entry = getEntry(i);
      if (entry) selectedIds.add(entry.id);
    }
  } else if (clickedCheckbox || e.ctrlKey || e.metaKey) {
    if (selectedIds.has(entryId)) selectedIds.delete(entryId);
    else selectedIds.add(entryId);
  } else {
    const entry = buffer.find(en => en.id === entryId);
    if (entry) openDetailModal(entry);
    return;
  }
  lastClickedIndex = visIdx;
  updateSelectionUI();
  renderViewport();
}

function onRowClick(e) {
  const row = e.currentTarget;
  const entryId = row.dataset.entryId;
  const visIdx = Number.parseInt(row.dataset.visibleIndex, 10);
  if (!entryId) return;
  if (handleTraceClick(e)) return;
  handleSelectionClick(e, entryId, visIdx);
}

function updateSelectionUI() {
  const count = selectedIds.size;
  copySelectedBtn.style.display = count > 0 ? '' : 'none';
  host.querySelector('#log-deselect-btn').style.display = count > 0 ? '' : 'none';
  selectCountEl.textContent = String(count);
}

function copySelectedEntries() {
  if (selectedIds.size === 0) return;
  const entries = buffer.filter(e => selectedIds.has(e.id));
  entries.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const text = entries.map(formatEntryAsText).join('\n\n');
  copyToClipboard(text);
}

// ── Scroll & status ──────────────────────────────────────────────────────
function onScroll() {
  const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - ROW_HEIGHT * 2;
  autoScroll = atBottom;
  jumpBtn.classList.toggle('visible', !atBottom && getVisibleCount() > 0);
  renderViewport();
}

function scheduleRender() {
  requestAnimationFrame(() => {
    updateEntryCount();
    renderViewport();
    if (autoScroll) scrollToBottom();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────
function scrollToBottom() {
  viewport.scrollTop = viewport.scrollHeight;
}

// The status dot doubles as the poll health indicator: live (green),
// reconnecting (amber, in-flight), disconnected (red), paused (idle).
function setStatus(status) {
  if (!statusDot) return;
  const dotClass = status === 'live' ? 'connected'
    : status === 'disconnected' ? 'disconnected'
    : status === 'reconnecting' ? 'reconnecting'
    : '';
  statusDot.className = 'log-status-dot ' + dotClass;
  statusText.textContent = status;
}

function updateEntryCount() {
  if (!entryCountEl) return;
  const total = buffer.length;
  const visible = getVisibleCount();
  entryCountEl.textContent = filteredIndices === null
    ? total + ' entries'
    : visible + ' / ' + total + ' entries';
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatEntryAsText(entry) {
  let text = '[' + entry.ts + '] ' +
    (entry.level || '').toUpperCase() + ' [' + entry.category + '] ' +
    (entry.source || '') + ': ' +
    (entry.message || '');
  if (entry.session_id) text += '\n  sessionId: ' + entry.session_id;
  if (entry.correlation_id) text += '\n  correlationId: ' + entry.correlation_id;
  return text;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    const prev = statusText.textContent;
    statusText.textContent = 'Copied!';
    setTimeout(() => { statusText.textContent = prev; }, 1500);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy'); // NOSONAR — intentional fallback for browsers without navigator.clipboard support
    ta.remove();
  });
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
