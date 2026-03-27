/**
 * DollhouseMCP Metrics Dashboard
 *
 * Displays system health, cache efficiency, security, and more.
 * Fetches data via polling (GET /api/metrics).
 * Uses uPlot for time-series charts when available.
 */

(() => {
  const POLL_INTERVAL_MS = 15000;
  const TIME_RANGES = {
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h':  60 * 60 * 1000,
  };

  // ── State ────────────────────────────────────────────────────────────────
  let pollTimer = null;
  let activeRange = '15m';
  let lastSnapshot = null;
  let historySnapshots = []; // for time-series charts
  let charts = {};           // uPlot instances by section
  let uPlotAvailable = false;

  // ── Public API ───────────────────────────────────────────────────────────
  globalThis.DollhouseConsole = globalThis.DollhouseConsole || {};
  globalThis.DollhouseConsole.metrics = {
    init: initMetrics,
    destroy: destroyMetrics,
    refresh: () => {
      if (lastSnapshot) {
        requestAnimationFrame(() => renderAll(lastSnapshot.metrics));
      }
    },
  };

  function initMetrics() {
    const container = document.getElementById('metrics-dashboard-root');
    if (!container || container.dataset.initialized === 'true') return;
    container.dataset.initialized = 'true';

    uPlotAvailable = typeof globalThis.uPlot !== 'undefined';
    buildDOM(container);
    bindEvents();
    fetchLatest();
    pollTimer = setInterval(fetchLatest, POLL_INTERVAL_MS);
  }

  function destroyMetrics() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const chart of Object.values(charts)) {
      if (chart?.destroy) chart.destroy();
    }
    charts = {};
  }

  // ── DOM construction ─────────────────────────────────────────────────────
  function buildDOM(container) {
    container.innerHTML = `
      <div class="metrics-status-bar">
        <span id="metrics-last-update">No data yet</span>
        <span id="metrics-collection-info"></span>
        <div class="metrics-time-range">
          <button class="metrics-time-btn active" data-range="15m">15m</button>
          <button class="metrics-time-btn" data-range="30m">30m</button>
          <button class="metrics-time-btn" data-range="1h">1h</button>
        </div>
      </div>
      <div class="metrics-dashboard" id="metrics-grid">
        ${buildCard('system', 'System Health')}
        ${buildCard('search', 'Search Performance')}
        ${buildCard('operations', 'MCP-AQL Operations')}
        ${buildCard('cache', 'Cache Efficiency')}
        ${buildCard('security', 'Security')}
        ${buildCard('gatekeeper', 'Gatekeeper Policy')}
        ${buildCard('locks', 'Locks & I/O')}
        ${buildCard('meta', 'Metrics System')}
      </div>
    `;
  }

  function buildCard(id, title) {
    return `
      <div class="metrics-card" id="metrics-card-${id}">
        <div class="metrics-card-header" data-card="${id}">
          <span class="metrics-card-title">${title}</span>
          <span class="metrics-card-toggle">&#9660;</span>
        </div>
        <div class="metrics-card-body" id="metrics-body-${id}">
          <div class="metrics-loading">Waiting for data...</div>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    document.getElementById('metrics-grid').addEventListener('click', (e) => {
      const header = e.target.closest('.metrics-card-header');
      if (!header) return;
      header.parentElement.classList.toggle('collapsed');
    });

    document.querySelector('.metrics-time-range').addEventListener('click', (e) => {
      const btn = e.target.closest('.metrics-time-btn');
      if (!btn) return;
      document.querySelectorAll('.metrics-time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRange = btn.dataset.range;
      fetchHistory();
    });
  }

  // ── Data fetching ────────────────────────────────────────────────────────
  async function fetchLatest() {
    try {
      const res = await fetch('/api/metrics?latest=true');
      if (!res.ok) return;
      const data = await res.json();
      if (data.snapshots?.length > 0) {
        lastSnapshot = data.snapshots[0];
        // Deduplicate by snapshot id
        if (!historySnapshots.some(s => s.id === lastSnapshot.id)) {
          historySnapshots.push(lastSnapshot);
        }
        // Trim history
        const cutoff = Date.now() - TIME_RANGES['1h'];
        historySnapshots = historySnapshots.filter(s => new Date(s.timestamp).getTime() > cutoff);
        renderAll(lastSnapshot.metrics);
      }
    } catch { /* network error, will retry */ }
  }

  async function fetchHistory() {
    try {
      const since = new Date(Date.now() - TIME_RANGES[activeRange]).toISOString();
      const res = await fetch(`/api/metrics?latest=false&since=${since}&limit=100`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.snapshots) {
        historySnapshots = data.snapshots.reverse(); // oldest first
        if (lastSnapshot) renderAll(lastSnapshot.metrics);
      }
    } catch { /* network error */ }
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function renderAll(metrics) {
    if (!metrics) return;

    updateStatus();
    renderSystemHealth(metrics);
    renderSearchPerf(metrics);
    renderOperations(metrics);
    renderCacheEfficiency(metrics);
    renderSecurity(metrics);
    renderGatekeeper(metrics);
    renderLocks(metrics);
    renderMetaSystem(metrics);
  }

  function updateStatus() {
    const el = document.getElementById('metrics-last-update');
    const infoEl = document.getElementById('metrics-collection-info');
    if (el && lastSnapshot) {
      const d = new Date(lastSnapshot.timestamp);
      el.textContent = 'Last update: ' + d.toLocaleTimeString();
    }
    if (infoEl && lastSnapshot) {
      infoEl.textContent = lastSnapshot.metrics.length + ' metrics | ' + lastSnapshot.durationMs + 'ms collection';
    }
  }

  // ── Section renderers ────────────────────────────────────────────────────

  // Cache last-known-good system values so intermittent collector failures don't blank the card
  let lastSystemVals = {};

  function renderSystemHealth(metrics) {
    const body = document.getElementById('metrics-body-system');
    if (!body) return;

    const heapUsed = findVal(metrics, 'system.memory.heap_used_bytes');
    const rss = findVal(metrics, 'system.memory.rss_bytes');
    const growthRate = findVal(metrics, 'system.memory.growth_rate');
    const cpu = findVal(metrics, 'system.cpu.usage_seconds');
    const uptime = findVal(metrics, 'system.uptime_seconds');

    // Update cache with any non-null values
    if (heapUsed != null) lastSystemVals.heapUsed = heapUsed;
    if (rss != null) lastSystemVals.rss = rss;
    if (growthRate != null) lastSystemVals.growthRate = growthRate;
    if (cpu != null) lastSystemVals.cpu = cpu;
    if (uptime != null) lastSystemVals.uptime = uptime;

    const v = lastSystemVals;
    const statsHtml = '<div class="metrics-stat-grid" id="system-stats">' +
      statBox('Heap Used', formatBytes(v.heapUsed)) +
      statBox('RSS', formatBytes(v.rss)) +
      statBox('Growth', v.growthRate == null ? '-' : formatNumber(v.growthRate, 2) + ' MB/s') +
      statBox('CPU', v.cpu == null ? '-' : formatNumber(v.cpu, 2) + ' s') +
      statBox('Uptime', formatDuration(v.uptime)) +
      '</div>';

    const statsEl = body.querySelector('#system-stats');
    if (statsEl) {
      statsEl.outerHTML = statsHtml;
    } else {
      let html = statsHtml;
      if (uPlotAvailable) {
        html += '<div class="metrics-chart-container" id="chart-system"></div>';
      }
      body.innerHTML = html;
    }

    if (uPlotAvailable && historySnapshots.length >= 3 && v.heapUsed != null) {
      updateChart('chart-system', 'system',
        ['system.memory.heap_used_bytes', 'system.memory.rss_bytes'],
        ['Heap', 'RSS'], formatBytes);
    }
  }

  function renderSearchPerf(metrics) {
    const body = document.getElementById('metrics-body-search');
    if (!body) return;

    const duration = findEntry(metrics, 'performance.search.duration');
    const hitRate = findVal(metrics, 'performance.search.cache_hit_rate');
    const slowCount = findVal(metrics, 'performance.search.slow_query_count');

    const hasSearchMetrics = duration != null || hitRate != null || slowCount != null;

    if (!hasSearchMetrics) {
      body.innerHTML = '<div class="metrics-loading">No search metrics available — PerformanceMonitor collector may not be active</div>';
      return;
    }

    let html = '<div class="metrics-stat-grid">';
    if (duration?.type === 'histogram') {
      const v = duration.value;
      html += statBox('Avg', fmtMs(v.avg));
      html += statBox('P50', fmtMs(v.p50));
      html += statBox('P95', fmtMs(v.p95));
      html += statBox('P99', fmtMs(v.p99));
      html += statBox('Count', formatNumber(v.count || 0));
    }
    html += statBox('Cache Hit', hitRate == null ? '-' : formatPercent(hitRate));
    html += statBox('Slow Queries', slowCount == null ? '-' : formatNumber(slowCount));
    html += '</div>';

    body.innerHTML = html;
  }

  function buildLabeledTable(entries, labelKey, headerLabel) {
    let html = '<table class="metrics-table"><thead><tr><th>' + escapeHtml(headerLabel) + '</th><th>Count</th></tr></thead><tbody>';
    for (const m of entries) {
      const label = m.labels?.[labelKey] || '?';
      html += '<tr><td>' + escapeHtml(label) + '</td><td>' + formatNumber(m.value) + '</td></tr>';
    }
    return html + '</tbody></table>';
  }

  function renderOperations(metrics) {
    const body = document.getElementById('metrics-body-operations');
    if (!body) return;

    const totalOps = findVal(metrics, 'mcpaql.operations_total');
    const failedOps = findVal(metrics, 'mcpaql.operations_failed_total');
    const duration = findEntry(metrics, 'mcpaql.duration');

    if (totalOps == null && duration == null) {
      body.innerHTML = '<div class="metrics-loading">No operation metrics yet</div>';
      return;
    }

    const errorRate = totalOps > 0 ? (failedOps || 0) / totalOps : 0;

    let html = '<div class="metrics-stat-grid">';
    html += statBox('Total Ops', formatNumber(totalOps || 0));
    html += statBox('Error Rate', formatPercent(errorRate));
    if (duration?.type === 'histogram') {
      html += statBox('Avg', fmtMs(duration.value.avg));
      html += statBox('P95', fmtMs(duration.value.p95));
    }
    html += '</div>';

    const endpointMetrics = metrics.filter(m => m.name === 'mcpaql.by_endpoint');
    if (endpointMetrics.length > 0) html += buildLabeledTable(endpointMetrics, 'endpoint', 'Endpoint');

    const opMetrics = metrics.filter(m => m.name === 'mcpaql.by_operation');
    if (opMetrics.length > 0) {
      const sorted = opMetrics.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
      html += buildLabeledTable(sorted, 'operation', 'Operation');
    }

    body.innerHTML = html;
  }

  function renderCacheEfficiency(metrics) {
    const body = document.getElementById('metrics-body-cache');
    if (!body) return;

    const cacheMetrics = metrics.filter(m => m.name.startsWith('cache.lru.'));
    if (cacheMetrics.length === 0) {
      body.innerHTML = '<div class="metrics-loading">No cache metrics available</div>';
      return;
    }

    // Group by labels.cache_name
    const caches = new Map();
    for (const m of cacheMetrics) {
      const name = m.labels?.cache_name || m.labels?.cache || 'unknown';
      if (!caches.has(name)) caches.set(name, {});
      caches.get(name)[m.name.replace('cache.lru.', '')] = m.value;
    }

    let totalMemMB = 0;
    let html = '<table class="metrics-table"><thead><tr>' +
      '<th>Cache</th><th>Hit Rate</th><th>Hits</th><th>Misses</th><th>Size</th><th>Evictions</th><th>Memory</th>' +
      '</tr></thead><tbody>';

    for (const [name, vals] of caches) {
      const memMB = vals.memory_used_megabytes || 0;
      totalMemMB += memMB;
      html += '<tr>' +
        '<td>' + escapeHtml(name) + '</td>' +
        '<td>' + (vals.hit_rate == null ? '-' : formatPercent(vals.hit_rate)) + '</td>' +
        '<td>' + formatNumber(vals.hits_total || 0) + '</td>' +
        '<td>' + formatNumber(vals.misses_total || 0) + '</td>' +
        '<td>' + formatNumber(vals.size_current || 0) + '</td>' +
        '<td>' + formatNumber(vals.evictions_total || 0) + '</td>' +
        '<td>' + formatMB(memMB) + '</td>' +
        '</tr>';
    }

    html += '</tbody><tfoot><tr class="metrics-table-total">' +
      '<td colspan="6" style="text-align:right;font-weight:700">Total Cache Memory</td>' +
      '<td style="font-weight:700">' + formatMB(totalMemMB) + '</td>' +
      '</tr></tfoot></table>';
    body.innerHTML = html;
  }

  // Security card: cache for recent events fetch
  let securityEventsCache = null;
  let securityEventsCacheTime = 0;
  const SECURITY_CACHE_TTL = 30000;

  function renderSecurity(metrics) {
    const body = document.getElementById('metrics-body-security');
    if (!body) return;

    const blocked24h = findVal(metrics, 'security.telemetry.blocked_24h');
    const attacksPerHour = findVal(metrics, 'security.telemetry.attacks_per_hour');

    let html = '<div class="metrics-stat-grid">';
    html += statBox('Blocked (24h)', blocked24h == null ? '0' : formatNumber(blocked24h));
    html += statBox('Attacks/hour', attacksPerHour == null ? '0' : formatNumber(attacksPerHour, 1));
    html += '</div>';

    html += '<div id="security-recent-events"><div class="metrics-loading">Loading recent events...</div></div>';

    body.innerHTML = html;

    // Fetch recent security events (cached for 30s)
    const now = Date.now();
    if (securityEventsCache && (now - securityEventsCacheTime) < SECURITY_CACHE_TTL) {
      renderSecurityEvents(securityEventsCache);
    } else {
      fetch('/api/logs?category=security&level=warn&limit=5')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.entries) {
            securityEventsCache = data.entries;
            securityEventsCacheTime = Date.now();
            renderSecurityEvents(data.entries);
          }
        })
        .catch(() => {
          const el = document.getElementById('security-recent-events');
          if (el) el.innerHTML = '';
        });
    }
  }

  function renderSecurityEvents(entries) {
    const el = document.getElementById('security-recent-events');
    if (!el) return;

    if (!entries || entries.length === 0) {
      el.innerHTML = '<div class="metrics-loading">No recent security events</div>';
      return;
    }

    let html = '<table class="metrics-table"><thead><tr><th>Time</th><th>Source</th><th>Message</th></tr></thead><tbody>';
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const ago = formatTimeAgo(entry.timestamp);
      const source = escapeHtml(entry.source || '');
      const fullMsg = escapeHtml(entry.message || '');
      const truncated = fullMsg.length > 80 ? fullMsg.substring(0, 80) + '...' : fullMsg;
      const needsExpand = fullMsg.length > 80;
      html += '<tr><td>' + ago + '</td><td>' + source + '</td><td>';
      if (needsExpand) {
        html += '<span class="sec-msg-short" id="sec-msg-short-' + i + '" style="cursor:pointer" title="Click to expand">' + truncated + '</span>';
        html += '<span class="sec-msg-full" id="sec-msg-full-' + i + '" style="display:none;white-space:pre-wrap;word-break:break-word;cursor:pointer" title="Click to collapse">' + fullMsg + '</span>';
      } else {
        html += truncated;
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;

    // Bind click handlers for expandable messages
    for (let i = 0; i < entries.length; i++) {
      const short = document.getElementById('sec-msg-short-' + i);
      const full = document.getElementById('sec-msg-full-' + i);
      if (short && full) {
        short.addEventListener('click', () => { short.style.display = 'none'; full.style.display = 'inline'; });
        full.addEventListener('click', () => { full.style.display = 'none'; short.style.display = 'inline'; });
      }
    }
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return '-';
    const diff = Date.now() - new Date(timestamp).getTime();
    if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function buildShareTable(entries, labelKey, headerLabel, total) {
    let html = '<table class="metrics-table"><thead><tr><th>' + escapeHtml(headerLabel) + '</th><th>Count</th><th>Share</th></tr></thead><tbody>';
    for (const m of entries) {
      const label = m.labels?.[labelKey] || '?';
      const share = total > 0 ? formatPercent(m.value / total) : '-';
      html += '<tr><td>' + escapeHtml(label) + '</td><td>' + formatNumber(m.value) + '</td><td>' + share + '</td></tr>';
    }
    return html + '</tbody></table>';
  }

  function renderGatekeeperStats(metrics, total, allowed, denied, confirmations) {
    const allowRate = total > 0 ? allowed / total : 0;
    let html = '<div class="metrics-stat-grid">';
    html += statBox('Decisions', formatNumber(total));
    html += statBox('Allowed', formatNumber(allowed || 0));
    html += statBox('Denied', formatNumber(denied || 0));
    html += statBox('Allow Rate', formatPercent(allowRate));
    if (confirmations > 0) html += statBox('Confirmations', formatNumber(confirmations));
    html += '</div>';

    const sourceMetrics = metrics.filter(m => m.name === 'gatekeeper.by_policy_source');
    if (sourceMetrics.length > 0) html += buildShareTable(sourceMetrics, 'policy_source', 'Policy Source', total);

    const levelMetrics = metrics.filter(m => m.name === 'gatekeeper.by_permission_level');
    if (levelMetrics.length > 0) html += buildLabeledTable(levelMetrics, 'permission_level', 'Permission Level');

    return html;
  }

  function renderGatekeeper(metrics) {
    const body = document.getElementById('metrics-body-gatekeeper');
    if (!body) return;

    const total = findVal(metrics, 'gatekeeper.decisions_total');
    const allowed = findVal(metrics, 'gatekeeper.allowed_total');
    const denied = findVal(metrics, 'gatekeeper.denied_total');
    const confirmations = findVal(metrics, 'gatekeeper.confirmations_requested_total');

    if (total == null || total === 0) {
      body.innerHTML = '<div class="metrics-loading">No Gatekeeper decisions yet</div>';
      return;
    }

    body.innerHTML = renderGatekeeperStats(metrics, total, allowed, denied, confirmations);
  }

  function renderLocks(metrics) {
    const body = document.getElementById('metrics-body-locks');
    if (!body) return;

    const requests = findVal(metrics, 'lock.file.requests_total');
    const active = findVal(metrics, 'lock.file.active_current');
    const timeouts = findVal(metrics, 'lock.file.timeouts_total');
    const waits = findVal(metrics, 'lock.file.concurrent_waits_total');

    let html = '<div class="metrics-stat-grid">';
    html += statBox('Requests', formatNumber(requests || 0));
    html += statBox('Active', formatNumber(active || 0));
    html += statBox('Timeouts', formatNumber(timeouts || 0));
    html += statBox('Waits', formatNumber(waits || 0));
    html += '</div>';

    body.innerHTML = html;
  }

  function renderMetaSystem(metrics) {
    const body = document.getElementById('metrics-body-meta');
    if (!body) return;

    const registered = findVal(metrics, 'metrics.manager.collectors_registered');
    const disabled = findVal(metrics, 'metrics.manager.disabled_collectors');
    const errors = findVal(metrics, 'metrics.manager.collector_errors_total');
    const duration = findVal(metrics, 'metrics.manager.last_collection_duration_ms');

    let html = '<div class="metrics-stat-grid">';
    html += statBox('Collectors', formatNumber(registered || 0));
    html += statBox('Disabled', formatNumber(disabled || 0));
    html += statBox('Errors', formatNumber(errors || 0));
    html += statBox('Duration', duration == null ? '-' : formatNumber(duration, 1) + ' ms');
    html += '</div>';

    if (disabled > 0) {
      html += '<div class="metrics-alert warn">' + disabled + ' collector(s) disabled due to repeated failures</div>';
    }

    body.innerHTML = html;
  }

  // ── Chart rendering (uPlot) ──────────────────────────────────────────────
  function extractSeriesValues(name) {
    return historySnapshots.map(s => {
      const m = s.metrics.find(entry => entry.name === name);
      if (!m) return null;
      return typeof m.value === 'number' ? m.value : null;
    });
  }

  function updateChart(containerId, chartKey, metricNames, labels, formatter) {
    const container = document.getElementById(containerId);
    if (!container || !uPlotAvailable) return;

    // Defer if container hasn't been laid out yet (hidden tab)
    const width = container.clientWidth;
    if (width < 100) {
      requestAnimationFrame(() => updateChart(containerId, chartKey, metricNames, labels, formatter));
      return;
    }

    // Build data arrays
    const times = historySnapshots.map(s => Math.floor(new Date(s.timestamp).getTime() / 1000));
    const seriesData = metricNames.map(name => extractSeriesValues(name));

    // If we already have a chart, update its data instead of recreating
    if (charts[chartKey]) {
      try {
        charts[chartKey].setData([times, ...seriesData]);
        return;
      } catch {
        // If setData fails, fall through to recreate
        charts[chartKey].destroy();
        delete charts[chartKey];
      }
    }

    const isDark = document.documentElement.dataset.theme === 'dark';
    const colors = ['#3b82f6', '#f59e0b', '#22c55e', '#ef4444'];

    const opts = {
      width: width,
      height: 200,
      cursor: { show: true },
      legend: { show: true },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          stroke: isDark ? '#7b93a7' : '#677893',
          grid: { stroke: isDark ? '#2b3445' : '#e0e0e0', width: 1 },
          font: '10px sans-serif',
          size: 40,
        },
        {
          stroke: isDark ? '#7b93a7' : '#677893',
          grid: { stroke: isDark ? '#2b3445' : '#e0e0e0', width: 1 },
          font: '10px sans-serif',
          size: 70,
          values: (u, vals) => vals.map(v => {
            if (v == null) return '';
            return formatter ? formatter(v) : String(v);
          }),
        },
      ],
      series: [
        {},
        ...labels.map((label, i) => ({
          label: label,
          stroke: colors[i % colors.length],
          width: 2,
          fill: colors[i % colors.length] + '18',
          points: { show: true, size: 5, fill: colors[i % colors.length] },
          spanGaps: true,
        })),
      ],
    };

    try {
      container.innerHTML = '';
      charts[chartKey] = new uPlot(opts, [times, ...seriesData], container);
    } catch {
      container.innerHTML = '<div class="metrics-loading">Chart unavailable</div>';
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────


  function findVal(metrics, name) {
    const m = metrics.find(m => m.name === name);
    if (!m) return null;
    return typeof m.value === 'number' ? m.value : null;
  }

  function findEntry(metrics, name) {
    return metrics.find(m => m.name === name) || null;
  }

  function statBox(label, value) {
    return '<div class="metrics-stat">' +
      '<div class="metrics-stat-value">' + escapeHtml(String(value)) + '</div>' +
      '<div class="metrics-stat-label">' + escapeHtml(String(label)) + '</div>' +
      '</div>';
  }

  function formatMB(mb) {
    if (mb == null) return '-';
    if (mb < 0.01) return '< 0.01 MB';
    if (mb < 1) return (mb * 1024).toFixed(0) + ' KB';
    return mb.toFixed(2) + ' MB';
  }

  function formatBytes(bytes) {
    if (bytes == null) return '-';
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatNumber(n, decimals) {
    if (n == null) return '-';
    if (decimals !== undefined) return Number(n).toFixed(decimals);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n * 100) / 100);
  }

  function formatPercent(v) {
    if (v == null) return '-';
    return (v * 100).toFixed(1) + '%';
  }

  function fmtMs(v) {
    if (v == null) return '-';
    return Number(v).toFixed(1) + ' ms';
  }

  function formatDuration(seconds) {
    if (seconds == null) return '-';
    seconds = Math.floor(seconds);
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
})();
