/**
 * Session awareness for the unified web console.
 *
 * Shows a labeled "N sessions" box in the header. Clicking opens a
 * dropdown with selectable sessions. Selecting a session filters
 * logs and metrics to that session only.
 *
 * @since v2.1.0 — Issue #1700
 */
(function() {
  'use strict';

  var SESSION_POLL_INTERVAL = 10000;
  var sessions = [];
  var filterSessionId = '';
  var dropdownBuilt = false;
  var lastSessionKey = ''; // tracks session list identity to avoid unnecessary rebuilds

  function displayName(session) {
    if (typeof session === 'object' && session.displayName) return session.displayName;
    var id = typeof session === 'string' ? session : (session && session.sessionId) || '';
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

    // Trigger log re-filter
    if (window.DollhouseConsole && window.DollhouseConsole.logs && window.DollhouseConsole.logs.refilter) {
      window.DollhouseConsole.logs.refilter();
    }

    refreshSelectionState();
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

    // Update box label
    var countEl = document.querySelector('.session-box-count');
    var labelEl = document.querySelector('.session-box-label');
    if (!countEl || !labelEl) return;

    var active = sessions.filter(function(s) { return s.status === 'active'; });

    if (filterSessionId) {
      var filtered = active.find(function(s) { return s.sessionId === filterSessionId; });
      if (filtered) {
        countEl.textContent = displayName(filtered);
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
    if (count === 0) return;

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
    box.appendChild(countEl);
    box.appendChild(labelEl);

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
        item.appendChild(dot);

        var nameEl = document.createElement('span');
        nameEl.className = 'session-dropdown-name';
        nameEl.textContent = displayName(s);
        item.appendChild(nameEl);

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

    // Toggle dropdown
    box.addEventListener('click', function(e) {
      e.stopPropagation();
      var open = !dropdown.hidden;
      dropdown.hidden = open;
      box.setAttribute('aria-expanded', String(!open));
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

    var filterBar = logPanel.querySelector('.log-filters');
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

  // Fetch sessions from the API
  function fetchSessions() {
    fetch('/api/sessions').then(function(res) {
      if (!res.ok) return;
      return res.json();
    }).then(function(data) {
      if (data && data.sessions) {
        sessions = data.sessions;
        updateSessionIndicator();
        updateSessionFilterOptions();
      }
    }).catch(function() {});
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
