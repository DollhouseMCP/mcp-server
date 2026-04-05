/**
 * DollhouseMCP Log Viewer — High-performance virtual-scrolling log viewer
 *
 * Architecture:
 * - Circular buffer (JS-side, 10,000 entries)
 * - Virtual scrolling: only renders ~50 visible DOM rows
 * - RAF batching: incoming SSE entries accumulate, processed once per frame
 * - Client-side filtering on JS buffer, not DOM
 * - Smart auto-scroll with user scroll detection
 * - Detail modal card for full log entry inspection
 * - Multi-select with shift-click for bulk copy
 */

(() => {
  const BUFFER_SIZE = 10000;
  const ROW_HEIGHT = 22;
  const OVERSCAN = 5;
  const RECONNECT_DELAY_MS = 3000;
  const SEARCH_DEBOUNCE_MS = 300;

  // ── State ────────────────────────────────────────────────────────────────
  const buffer = [];
  let filteredIndices = null;
  let eventSource = null;
  let paused = false;
  let autoScroll = true;
  let searchTimer = null;
  let pendingEntries = [];
  let rafScheduled = false;

  // Selection state
  const selectedIds = new Set();
  let lastClickedIndex = -1; // for shift-click range select

  // Filter state
  let filterCategory = '';
  let filterLevel = 'info';  // Default to info — excludes debug noise from view
  let filterSource = '';
  let filterMessage = '';
  let filterCorrelationId = '';

  // ── DOM references ─────────────────────────────────────────────────────
  let viewport, scrollSpacer, jumpBtn, statusDot, statusText, entryCountEl;
  let categorySelect, levelSelect, sourceInput, searchInput, pauseBtn, clearBtn;
  let detailModal, copySelectedBtn, selectCountEl;
  const rowPool = [];

  // ── Public API ───────────────────────────────────────────────────────────
  globalThis.DollhouseConsole = globalThis.DollhouseConsole || {};
  globalThis.DollhouseConsole.logs = {
    init: initLogViewer,
    destroy: destroyLogViewer,
    refresh: () => {
      requestAnimationFrame(() => {
        renderViewport();
        if (autoScroll) scrollToBottom();
      });
    },
  };

  function initLogViewer(urlParams) {
    const container = document.getElementById('log-viewer-root');
    if (!container || container.dataset.initialized === 'true') return;
    container.dataset.initialized = 'true';

    buildDOM(container);

    // Apply URL params before binding events and connecting SSE
    if (urlParams) applyLogUrlParams(urlParams);

    bindEvents();
    connectSSE();

    requestAnimationFrame(() => {
      renderViewport();
      if (autoScroll) scrollToBottom();
    });
  }

  /**
   * Parse a comma-separated level string and return the minimum valid level.
   * @param {string} levelParam - e.g., "error,warn" or "info"
   * @returns {string|null} The minimum valid level, or null if none valid
   */
  function parseMinLevel(levelParam) {
    const levelOrder = ['debug', 'info', 'warn', 'error'];
    const levels = levelParam.split(',')
      .map(l => l.trim().toLowerCase())
      .filter(l => levelOrder.includes(l));
    if (levels.length === 0) return null;
    return levels.reduce((min, l) =>
      levelOrder.indexOf(l) < levelOrder.indexOf(min) ? l : min
    , levels[0]);
  }

  /**
   * Apply URL parameters to log viewer state.
   * Supports: level, category, source, q (message search), correlationId, tail
   * @param {URLSearchParams} params
   */
  /** Apply a single string URL param to a filter variable and optional DOM element. */
  function applyStringParam(params, key, setter, element) {
    const val = params.get(key);
    if (!val) return;
    setter(val);
    if (element) element.value = val;
  }

  function applyLogUrlParams(params) {
    if (!params || params.toString() === '') return;

    const level = params.get('level');
    if (level) {
      const minLevel = parseMinLevel(level);
      if (minLevel) {
        filterLevel = minLevel;
        if (levelSelect) levelSelect.value = minLevel;
      }
    }

    applyStringParam(params, 'category', v => { filterCategory = v; }, categorySelect);
    applyStringParam(params, 'source', v => { filterSource = v; }, sourceInput);
    applyStringParam(params, 'q', v => { filterMessage = v; }, searchInput);

    const cid = params.get('correlationId');
    if (cid) filterCorrelationId = cid;

    if (params.get('tail') === 'false') autoScroll = false;
  }

  function destroyLogViewer() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  // ── DOM construction ─────────────────────────────────────────────────────
  function buildDOM(container) {
    container.innerHTML = `
      <div class="log-viewer">
        <div class="log-controls">
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

    viewport = document.getElementById('log-viewport');
    scrollSpacer = document.getElementById('log-scroll-spacer');
    jumpBtn = document.getElementById('log-jump-bottom');
    statusDot = document.getElementById('log-status-dot');
    statusText = document.getElementById('log-status-text');
    entryCountEl = document.getElementById('log-entry-count');
    categorySelect = document.getElementById('log-category');
    levelSelect = document.getElementById('log-level');
    if (levelSelect && filterLevel) levelSelect.value = filterLevel;  // Sync dropdown with default
    sourceInput = document.getElementById('log-source');
    searchInput = document.getElementById('log-search');
    pauseBtn = document.getElementById('log-pause-btn');
    clearBtn = document.getElementById('log-clear-btn');
    detailModal = document.getElementById('log-detail-modal');
    copySelectedBtn = document.getElementById('log-copy-selected-btn');
    selectCountEl = document.getElementById('log-select-count');
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
    document.getElementById('log-deselect-btn').addEventListener('click', () => {
      selectedIds.clear();
      updateSelectionUI();
      renderViewport();
    });

    // Detail modal
    document.getElementById('log-detail-close').addEventListener('click', closeDetailModal);
    document.getElementById('log-detail-backdrop').addEventListener('click', closeDetailModal);
    document.getElementById('log-detail-copy-text').addEventListener('click', () => copyDetailAs('text'));
    document.getElementById('log-detail-copy-json').addEventListener('click', () => copyDetailAs('json'));

    // Keyboard: Escape closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !detailModal.hidden) {
        closeDetailModal();
      }
    });

    categorySelect.addEventListener('change', () => { filterCategory = categorySelect.value; applyFilters(); });
    levelSelect.addEventListener('change', () => { filterLevel = levelSelect.value; applyFilters(); });
    sourceInput.addEventListener('input', () => { filterSource = sourceInput.value; applyFiltersDebounced(); });
    searchInput.addEventListener('input', () => { filterMessage = searchInput.value; applyFiltersDebounced(); });
    document.getElementById('log-trace-clear').addEventListener('click', clearTraceFilter);
  }

  function setTraceFilter(correlationId) {
    filterCorrelationId = correlationId;
    const banner = document.getElementById('log-trace-banner');
    const traceIdEl = document.getElementById('log-trace-id');
    const traceCountEl = document.getElementById('log-trace-count');
    traceIdEl.textContent = correlationId;
    banner.style.display = '';
    applyFilters();
    const count = getVisibleCount();
    traceCountEl.textContent = '(' + count + ' entries)';
  }

  function clearTraceFilter() {
    filterCorrelationId = '';
    document.getElementById('log-trace-banner').style.display = 'none';
    applyFilters();
  }

  // ── SSE connection ───────────────────────────────────────────────────────
  function connectSSE() {
    if (eventSource) eventSource.close();
    setStatus('reconnecting');
    // Pass current filters to server for SSE-level filtering (reduces bandwidth)
    const params = new URLSearchParams();
    if (filterCategory) params.set('category', filterCategory);
    if (filterLevel) params.set('level', filterLevel);
    const qs = params.toString();
    eventSource = DollhouseAuth.apiEventSource('/api/logs/stream' + (qs ? '?' + qs : ''));

    eventSource.onopen = () => setStatus('connected');

    eventSource.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        pendingEntries.push(entry);
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(processPending);
        }
      } catch { /* malformed */ }
    };

    eventSource.onerror = () => {
      setStatus('disconnected');
      eventSource.close();
      eventSource = null;
      setTimeout(connectSSE, RECONNECT_DELAY_MS);
    };
  }

  // ── RAF batch processing ─────────────────────────────────────────────────
  function appendToBuffer(entry) {
    if (buffer.length >= BUFFER_SIZE) {
      const removed = buffer.shift();
      if (removed) selectedIds.delete(removed.id);
      if (filteredIndices !== null) {
        filteredIndices = filteredIndices.map(i => i - 1).filter(i => i >= 0);
      }
    }
    buffer.push(entry);
    if (filteredIndices !== null && matchesFilters(entry)) {
      filteredIndices.push(buffer.length - 1);
    }
  }

  function processPending() {
    rafScheduled = false;
    if (pendingEntries.length === 0) return;

    const entries = pendingEntries;
    pendingEntries = [];
    for (const entry of entries) appendToBuffer(entry);

    if (!paused) {
      updateEntryCount();
      renderViewport();
      if (autoScroll) scrollToBottom();
    }
  }

  // ── Filtering ────────────────────────────────────────────────────────────
  const LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

  function matchesFilters(entry) {
    if (filterCorrelationId && entry.correlationId !== filterCorrelationId) return false;
    if (filterCategory && entry.category !== filterCategory) return false;
    if (filterLevel && (LEVEL_PRIORITY[entry.level] || 0) < (LEVEL_PRIORITY[filterLevel] || 0)) return false;
    if (filterSource && !entry.source.toLowerCase().includes(filterSource.toLowerCase())) return false;
    if (filterMessage && !entry.message.toLowerCase().includes(filterMessage.toLowerCase())) return false;
    return true;
  }

  function applyFilters() {
    const hasFilter = filterCategory || filterLevel || filterSource || filterMessage || filterCorrelationId;
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
    const time = formatTime(entry.timestamp);
    const src = escapeHtml(entry.source || '').slice(0, 30);
    const msg = escapeHtml(entry.message || '').slice(0, 300);
    const checkbox = '<span class="log-checkbox' + (isSelected ? ' checked' : '') + '"></span>';
    const corrBadge = entry.correlationId
      ? '<span class="log-corr-badge" title="Click to trace this request" data-correlation-id="' + escapeHtml(entry.correlationId) + '">' + escapeHtml(entry.correlationId.slice(-8)) + '</span>'
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
    const title = document.getElementById('log-detail-title');
    const body = document.getElementById('log-detail-body');

    title.textContent = entry.level.toUpperCase() + ' — ' + (entry.source || 'unknown');

    let html = '';
    html += detailField('Timestamp', entry.timestamp);
    html += detailField('ID', entry.id);
    html += detailField('Category', escapeHtml(entry.category));
    html += detailField('Level', '<span class="log-level ' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</span>');
    html += detailField('Source', escapeHtml(entry.source || ''));
    html += detailField('Message', escapeHtml(entry.message || ''));

    if (entry.correlationId) {
      html += detailField('Correlation ID',
        '<a href="#" class="log-trace-link" data-correlation-id="' + escapeHtml(entry.correlationId) + '">' +
        '&#x1f517; ' + escapeHtml(entry.correlationId) + '</a>');
    }

    if (entry.data && Object.keys(entry.data).length > 0) {
      html += '<div class="log-detail-section">';
      html += '<div class="log-detail-section-title">Data</div>';
      html += '<pre class="log-detail-pre">' + escapeHtml(JSON.stringify(entry.data, null, 2)) + '</pre>';
      html += '</div>';
    }

    if (entry.error) {
      html += '<div class="log-detail-section">';
      html += '<div class="log-detail-section-title">Error</div>';
      html += detailField('Name', escapeHtml(entry.error.name || ''));
      html += detailField('Message', escapeHtml(entry.error.message || ''));
      if (entry.error.stack) {
        html += '<pre class="log-detail-pre">' + escapeHtml(entry.error.stack) + '</pre>';
      }
      html += '</div>';
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
    let text;
    if (format === 'json') {
      text = JSON.stringify(activeDetailEntry, null, 2);
    } else {
      text = formatEntryAsText(activeDetailEntry);
    }
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
      const entry = buffer.find(e => e.id === entryId);
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
    document.getElementById('log-deselect-btn').style.display = count > 0 ? '' : 'none';
    selectCountEl.textContent = String(count);
  }

  function copySelectedEntries() {
    if (selectedIds.size === 0) return;
    const entries = buffer.filter(e => selectedIds.has(e.id));
    // Sort by timestamp
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        updateEntryCount();
        renderViewport();
        if (autoScroll) scrollToBottom();
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function scrollToBottom() {
    viewport.scrollTop = viewport.scrollHeight;
  }

  function setStatus(status) {
    statusDot.className = 'log-status-dot ' + status;
    statusText.textContent = status;
  }

  function updateEntryCount() {
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
    let text = '[' + entry.timestamp + '] ' +
      entry.level.toUpperCase() + ' [' + entry.category + '] ' +
      (entry.source || '') + ': ' +
      (entry.message || '');
    if (entry.correlationId) text += '\n  correlationId: ' + entry.correlationId;
    if (entry.data && Object.keys(entry.data).length > 0) {
      text += '\n  data: ' + JSON.stringify(entry.data, null, 2).split('\n').join('\n  ');
    }
    if (entry.error) {
      text += '\n  error: ' + (entry.error.name || '') + ': ' + (entry.error.message || '');
      if (entry.error.stack) text += '\n  ' + entry.error.stack.split('\n').join('\n  ');
    }
    return text;
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      // Brief visual feedback on status bar
      const prev = statusText.textContent;
      statusText.textContent = 'Copied!';
      setTimeout(() => { statusText.textContent = prev; }, 1500);
    }).catch(() => {
      // Fallback for older browsers
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
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }
})();
