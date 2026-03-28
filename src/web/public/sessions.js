/**
 * Session awareness for the unified web console.
 *
 * Adds session badges to log entries, a session filter dropdown,
 * and a session indicator in the header showing active sessions.
 *
 * Fetches /api/sessions periodically and listens for `event: session`
 * SSE events for real-time updates.
 *
 * @since v2.1.0 — Issue #1700
 */
(function() {
  'use strict';

  const SESSION_COLORS = [
    '#4CAF50', '#2196F3', '#FF9800', '#9C27B0',
    '#F44336', '#00BCD4', '#795548', '#607D8B'
  ];

  const SESSION_POLL_INTERVAL = 10_000;

  let sessions = [];
  let filterSessionId = '';

  // Deterministic color from session ID hash
  function sessionColor(sessionId) {
    if (!sessionId) return '#999';
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
      hash = ((hash << 5) - hash) + sessionId.charCodeAt(i);
    }
    return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length];
  }

  // Truncate session ID for display
  function shortSessionId(sessionId) {
    if (!sessionId) return '';
    // "session-lz5abc-de4f1234" -> "lz5abc"
    const parts = sessionId.split('-');
    return parts.length >= 2 ? parts[1] : sessionId.slice(0, 8);
  }

  // Update the header session indicator
  function updateSessionIndicator() {
    const indicator = document.getElementById('session-indicator');
    if (!indicator) return;

    const active = sessions.filter(s => s.status === 'active');
    const count = active.length;

    if (count <= 1) {
      indicator.textContent = '';
      indicator.title = count === 1 ? `Session: ${shortSessionId(active[0]?.sessionId)}` : 'No active sessions';
      return;
    }

    indicator.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'session-count-badge';
    badge.textContent = count + ' sessions';
    indicator.appendChild(badge);
    indicator.title = active.map(s =>
      `${shortSessionId(s.sessionId)} (pid ${s.pid})${s.isLeader ? ' [leader]' : ''}`
    ).join('\n');
  }

  // Inject session filter into log viewer filter bar
  function injectSessionFilter() {
    // Look for the log filter area — this runs after logs.js has initialized
    const logPanel = document.getElementById('tab-logs');
    if (!logPanel) return;

    // Check if already injected
    if (document.getElementById('log-session-filter')) return;

    // Find the filter bar (created by logs.js)
    const filterBar = logPanel.querySelector('.log-filters');
    if (!filterBar) return;

    const group = document.createElement('div');
    group.className = 'log-filter-group';
    group.innerHTML = `
      <label for="log-session-filter">Session</label>
      <select id="log-session-filter" class="log-filter-select">
        <option value="">All Sessions</option>
      </select>
    `;
    filterBar.appendChild(group);

    const select = group.querySelector('select');
    select.addEventListener('change', function() {
      filterSessionId = this.value;
      // Trigger re-filter in logs.js if it exposes a filter function
      if (window.DollhouseConsole && window.DollhouseConsole.logs && window.DollhouseConsole.logs.refilter) {
        window.DollhouseConsole.logs.refilter();
      }
    });
  }

  // Update the session filter dropdown options
  function updateSessionFilterOptions() {
    const select = document.getElementById('log-session-filter');
    if (!select) return;

    const current = select.value;
    const active = sessions.filter(s => s.status === 'active');

    // Rebuild options
    select.innerHTML = '<option value="">All Sessions</option>';
    for (const s of active) {
      const opt = document.createElement('option');
      opt.value = s.sessionId;
      const label = shortSessionId(s.sessionId);
      opt.textContent = label + (s.isLeader ? ' (leader)' : '');
      opt.style.color = sessionColor(s.sessionId);
      if (s.sessionId === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  // Fetch sessions from the API
  async function fetchSessions() {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        sessions = data.sessions || [];
        updateSessionIndicator();
        updateSessionFilterOptions();
      }
    } catch {
      // API might not be available yet
    }
  }

  // Expose session utilities for logs.js integration
  window.DollhouseSessions = {
    getFilterSessionId: function() { return filterSessionId; },
    sessionColor: sessionColor,
    shortSessionId: shortSessionId,
    getSessions: function() { return sessions; },
  };

  // Initialize after DOM is ready
  function init() {
    fetchSessions();
    setInterval(fetchSessions, SESSION_POLL_INTERVAL);

    // Inject session filter into log viewer (retry until logs.js has built the UI)
    let retries = 0;
    const tryInject = setInterval(function() {
      injectSessionFilter();
      retries++;
      if (document.getElementById('log-session-filter') || retries > 20) {
        clearInterval(tryInject);
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
