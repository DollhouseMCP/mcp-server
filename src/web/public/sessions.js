/**
 * Session awareness for the unified web console.
 *
 * Shows a labeled "N sessions" box in the header. Clicking opens a
 * dropdown with selectable sessions. Selecting a session filters
 * logs and refreshes any session-aware dashboard tabs.
 *
 * @security-audit-suppress DMCP-SEC-004 Client-side JS — all session data is
 * pre-normalized server-side via UnicodeValidator. Browser String.normalize('NFC')
 * is applied as defense-in-depth.
 *
 * @since v2.1.0 — Issue #1700
 */
(function() {
  'use strict';

  function getConfiguredNumber(key, fallback) {
    var config = globalThis.DollhouseConsoleConfig;
    var value = config && Number(config[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  var SESSION_POLL_INTERVAL = getConfiguredNumber('sessionPollIntervalMs', 5000);
  var SESSION_FILTER_INJECTION_RETRY_INTERVAL = getConfiguredNumber('sessionFilterInjectionRetryIntervalMs', 500);
  var SESSION_FILTER_INJECTION_MAX_RETRIES = getConfiguredNumber('sessionFilterInjectionMaxRetries', 20);
  var sessions = [];
  var filterSessionId = '';
  var dropdownBuilt = false;
  var lastSessionKey = ''; // tracks session list identity to avoid unnecessary rebuilds

  function formatUptime(startedAt) {
    if (!startedAt) return '';
    var ms = Date.now() - new Date(startedAt).getTime();
    if (ms < 0) return '0s';
    var secs = Math.floor(ms / 1000);
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm';
    var hrs = Math.floor(mins / 60);
    var remainMins = mins % 60;
    if (hrs < 24) return hrs + 'h ' + remainMins + 'm';
    var days = Math.floor(hrs / 24);
    var remainHrs = hrs % 24;
    return days + 'd ' + remainHrs + 'h';
  }

  /** NFC-normalize a string safely */
  function nfc(s) { try { return s.normalize('NFC'); } catch(e) { return s; } }

  function displayName(session) {
    if (typeof session === 'object' && session.displayName) return nfc(session.displayName);
    var id = typeof session === 'string' ? nfc(session) : nfc((session && session.sessionId) || '');
    var parts = id.split('-');
    return parts.length >= 2 ? parts[1] : id.slice(0, 8);
  }

  // Build a key from current sessions to detect changes
  function sessionListKey(list) {
    return list.map(function(s) { return s.sessionId + ':' + s.status; }).join(',');
  }

  // Apply session filter and update all UI to reflect it
  function applyFilter(sessionId) {
    filterSessionId = sessionId;

    // Sync log viewer select
    var logSelect = document.getElementById('log-session-filter');
    if (logSelect) logSelect.value = sessionId;

    // Trigger log re-filter with the selected session
    if (window.DollhouseConsole && window.DollhouseConsole.logs && window.DollhouseConsole.logs.refilter) {
      window.DollhouseConsole.logs.refilter(sessionId);
    }
    if (window.DollhouseConsole && window.DollhouseConsole.permissions && window.DollhouseConsole.permissions.refresh) {
      window.DollhouseConsole.permissions.refresh();
    }

    refreshSelectionState();
  }

  function showSessionsError(message) {
    var target = document.getElementById('session-indicator');
    if (!target || !target.parentElement) return;
    var banner = document.getElementById('sessions-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sessions-error-banner';
      banner.className = 'tab-error-banner';
      target.parentElement.insertBefore(banner, target);
    }
    banner.textContent = message;
    banner.hidden = false;
  }

  function clearSessionsError() {
    var banner = document.getElementById('sessions-error-banner');
    if (banner) banner.hidden = true;
  }

  // Update checkmarks and selected styling without rebuilding DOM
  function refreshSelectionState() {
    // Update items
    var items = document.querySelectorAll('.session-dropdown-item[data-session-id]');
    for (var i = 0; i < items.length; i++) {
      var isSelected = items[i].dataset.sessionId === filterSessionId;
      items[i].classList.toggle('session-dropdown-item--selected', isSelected);
      var check = items[i].querySelector('.session-dropdown-check');
      if (check) check.textContent = isSelected ? '\u2713' : '';
    }

    // Update "All" item
    var allItem = document.querySelector('.session-dropdown-item--all');
    if (allItem) {
      var allSelected = !filterSessionId;
      allItem.classList.toggle('session-dropdown-item--selected', allSelected);
      var allCheck = allItem.querySelector('.session-dropdown-check');
      if (allCheck) allCheck.textContent = allSelected ? '\u2713' : '';
    }

    // Tick uptimes
    var uptimes = document.querySelectorAll('.session-dropdown-uptime');
    for (var j = 0; j < uptimes.length; j++) {
      uptimes[j].textContent = formatUptime(uptimes[j].dataset.startedAt);
    }

    // Update box label
    var countEl = document.querySelector('.session-box-count');
    var labelEl = document.querySelector('.session-box-label');
    if (!countEl || !labelEl) return;

    var active = sessions.filter(function(s) { return s.status === 'active'; });

    if (active.length === 1) {
      countEl.textContent = displayName(active[0]);
      if (active[0].color) countEl.style.color = active[0].color;
      labelEl.textContent = formatUptime(active[0].startedAt);
      return;
    }

    // Reset color when showing count
    countEl.style.color = '';

    if (filterSessionId) {
      var filtered = active.find(function(s) { return s.sessionId === filterSessionId; });
      if (filtered) {
        countEl.textContent = displayName(filtered);
        if (filtered.color) countEl.style.color = filtered.color;
        labelEl.textContent = '1/' + active.length;
        return;
      }
    }
    countEl.textContent = String(active.length);
    labelEl.textContent = active.length === 1 ? 'session' : 'sessions';
  }

  // Build or rebuild the session indicator — only when session list actually changes
  function updateSessionIndicator() {
    var active = sessions.filter(function(s) { return s.status === 'active'; });
    var key = sessionListKey(active);

    // If sessions haven't changed, just refresh selection state
    if (key === lastSessionKey && dropdownBuilt) {
      refreshSelectionState();
      return;
    }
    lastSessionKey = key;

    var indicator = document.getElementById('session-indicator');
    if (!indicator) return;

    indicator.innerHTML = '';
    dropdownBuilt = false;

    var count = active.length;

    // Box button
    var box = document.createElement('button');
    box.className = 'session-box';
    box.type = 'button';
    box.setAttribute('aria-expanded', 'false');
    box.setAttribute('aria-haspopup', 'listbox');

    var countEl = document.createElement('span');
    countEl.className = 'session-box-count';
    var labelEl = document.createElement('span');
    labelEl.className = 'session-box-label';
    var arrow = document.createElement('span');
    arrow.className = 'session-box-arrow';
    box.appendChild(countEl);
    box.appendChild(labelEl);
    box.appendChild(arrow);

    // Dropdown
    var dropdown = document.createElement('div');
    dropdown.className = 'session-dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdown.hidden = true;

    // "All Sessions" item
    var allItem = document.createElement('div');
    allItem.className = 'session-dropdown-item session-dropdown-item--all';
    allItem.setAttribute('role', 'option');

    var allCheck = document.createElement('span');
    allCheck.className = 'session-dropdown-check';
    allItem.appendChild(allCheck);

    var allName = document.createElement('span');
    allName.className = 'session-dropdown-name';
    allName.textContent = 'All Sessions';
    allItem.appendChild(allName);

    var allCount = document.createElement('span');
    allCount.className = 'session-dropdown-role';
    allCount.textContent = count + ' total';
    allItem.appendChild(allCount);

    allItem.addEventListener('click', function(e) {
      e.stopPropagation();
      applyFilter('');
    });
    dropdown.appendChild(allItem);

    // Divider
    var divider = document.createElement('div');
    divider.className = 'session-dropdown-divider';
    dropdown.appendChild(divider);

    // Session items — leader first, then followers
    var sorted = active.slice().sort(function(a, b) {
      if (a.isLeader && !b.isLeader) return -1;
      if (!a.isLeader && b.isLeader) return 1;
      return 0;
    });

    for (var i = 0; i < sorted.length; i++) {
      (function(s) {
        var item = document.createElement('div');
        item.className = 'session-dropdown-item';
        item.dataset.sessionId = s.sessionId;
        item.setAttribute('role', 'option');

        var check = document.createElement('span');
        check.className = 'session-dropdown-check';
        item.appendChild(check);

        var dot = document.createElement('span');
        dot.className = 'session-dot';
        if (s.color) dot.style.background = s.color;
        item.appendChild(dot);

        var nameEl = document.createElement('span');
        nameEl.className = 'session-dropdown-name';
        nameEl.textContent = displayName(s);
        if (s.color) nameEl.style.color = s.color;
        item.appendChild(nameEl);

        // Session status badges (#1805) — two independent dimensions:
        // 1. Auth status (filled/empty circle + text)
        // 2. Client attachment (checkmark/X + text)
        // Shape + text + colorblind-safe color (blue/orange) = three
        // independent channels so no single channel carries meaning alone.
        var authBadge = document.createElement('span');
        authBadge.className = 'session-status-badge';
        if (s.authenticated) {
          authBadge.textContent = '\u25CF Auth';
          authBadge.dataset.status = 'positive';
          authBadge.title = 'Authenticated session';
        } else {
          authBadge.textContent = '\u25CB No auth';
          authBadge.dataset.status = 'negative';
          authBadge.title = 'Unauthenticated session';
        }
        item.appendChild(authBadge);

        var clientBadge = document.createElement('span');
        clientBadge.className = 'session-status-badge';
        if (s.kind === 'mcp') {
          clientBadge.textContent = '\u2713 Client';
          clientBadge.dataset.status = 'positive';
          clientBadge.title = 'MCP client attached';
        } else {
          clientBadge.textContent = '\u2717 No client';
          clientBadge.dataset.status = 'negative';
          clientBadge.title = 'No MCP client attached';
        }
        item.appendChild(clientBadge);

        var uptimeEl = document.createElement('span');
        uptimeEl.className = 'session-dropdown-uptime';
        uptimeEl.dataset.startedAt = s.startedAt;
        uptimeEl.textContent = formatUptime(s.startedAt);
        item.appendChild(uptimeEl);

        var killBtn = document.createElement('button');
        killBtn.className = 'session-kill-btn';
        killBtn.type = 'button';
        killBtn.title = 'Stop ' + displayName(s);
        killBtn.textContent = '\u00D7';
        killBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (!confirm('Stop session ' + displayName(s) + '?')) return;
          DollhouseAuth.apiFetch('/api/sessions/' + encodeURIComponent(s.sessionId) + '/kill', { method: 'POST' })
            .then(function(res) {
              if (!res.ok) {
                alert('Failed to stop session ' + displayName(s) + ': server returned ' + res.status);
                fetchSessions();
                return;
              }
              return res.json();
            })
            .then(function(data) {
              if (!data) return;
              if (data.reason === 'pending-kill') {
                alert('Session ' + displayName(s) + ' will be terminated shortly.\nWaiting for the process to identify itself, then it will be killed.');
              }
              fetchSessions();
            })
            .catch(function(err) {
              alert('Failed to stop session ' + displayName(s) + ': ' + (err.message || 'network error'));
            });
        });
        item.appendChild(killBtn);

        item.addEventListener('click', function(e) {
          e.stopPropagation();
          applyFilter(filterSessionId === s.sessionId ? '' : s.sessionId);
        });

        dropdown.appendChild(item);
      })(sorted[i]);
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'session-indicator-wrapper';
    wrapper.appendChild(box);
    wrapper.appendChild(dropdown);
    indicator.appendChild(wrapper);

    dropdownBuilt = true;

    // Apply current selection state
    refreshSelectionState();

    // Toggle dropdown — fetch fresh data on open
    box.addEventListener('click', function(e) {
      e.stopPropagation();
      var open = !dropdown.hidden;
      if (open) {
        dropdown.hidden = true;
        box.setAttribute('aria-expanded', 'false');
      } else {
        // Fetch fresh session data before showing
        fetchSessions();
        dropdown.hidden = false;
        box.setAttribute('aria-expanded', 'true');
      }
    });
    document.addEventListener('click', function() {
      dropdown.hidden = true;
      box.setAttribute('aria-expanded', 'false');
    });
  }

  // Inject session filter into log viewer filter bar
  function injectSessionFilter() {
    var logPanel = document.getElementById('tab-logs');
    if (!logPanel) return;
    if (document.getElementById('log-session-filter')) return;

    var filterBar = logPanel.querySelector('.log-controls');
    if (!filterBar) return;

    var group = document.createElement('div');
    group.className = 'log-filter-group';
    group.innerHTML =
      '<label for="log-session-filter">Session</label>' +
      '<select id="log-session-filter" class="log-filter-select">' +
      '<option value="">All Sessions</option></select>';
    filterBar.appendChild(group);

    group.querySelector('select').addEventListener('change', function() {
      applyFilter(this.value);
    });

    // If sessions loaded before the log controls mounted, populate the
    // newly injected filter immediately instead of waiting for the next poll.
    updateSessionFilterOptions();
  }

  // Update session filter dropdown options
  function updateSessionFilterOptions() {
    var select = document.getElementById('log-session-filter');
    if (!select) return;

    var current = select.value;
    var active = sessions.filter(function(s) { return s.status === 'active'; });

    select.innerHTML = '<option value="">All Sessions</option>';
    for (var i = 0; i < active.length; i++) {
      var opt = document.createElement('option');
      opt.value = active[i].sessionId;
      opt.textContent = displayName(active[i]) + (active[i].isLeader ? ' (leader)' : '');
      if (active[i].sessionId === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  /**
   * Fetch sessions from the API. The server handles federation with the
   * legacy port (3939) server-side to avoid CORS issues (#1805).
   */
  function fetchSessions() {
    DollhouseAuth.apiFetch('/api/sessions').then(function(res) {
      if (!res.ok) {
        showSessionsError('Failed to load sessions.');
        return;
      }
      return res.json();
    }).then(function(data) {
      if (data && data.sessions) {
        sessions = data.sessions;
        updateSessionIndicator();
        updateSessionFilterOptions();
        clearSessionsError();
      }
    }).catch(function(err) {
      console.warn('[Sessions] Fetch failed:', err);
      showSessionsError('Failed to load sessions.');
    });
  }

  // Expose for logs.js integration
  window.DollhouseSessions = {
    getFilterSessionId: function() { return filterSessionId; },
    displayName: displayName,
    getSessions: function() { return sessions; },
  };

  function init() {
    fetchSessions();
    setInterval(fetchSessions, SESSION_POLL_INTERVAL);

    var retries = 0;
    var tryInject = setInterval(function() {
      injectSessionFilter();
      retries++;
      if (document.getElementById('log-session-filter') || retries > SESSION_FILTER_INJECTION_MAX_RETRIES) {
        clearInterval(tryInject);
      }
    }, SESSION_FILTER_INJECTION_RETRY_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
