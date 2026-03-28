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

  // Get display name for a session
  function displayName(session) {
    if (typeof session === 'object' && session.displayName) return session.displayName;
    var id = typeof session === 'string' ? session : (session && session.sessionId) || '';
    var parts = id.split('-');
    return parts.length >= 2 ? parts[1] : id.slice(0, 8);
  }

  // Apply session filter across logs and metrics
  function applyFilter(sessionId) {
    filterSessionId = sessionId;

    // Sync the log viewer filter dropdown if it exists
    var logSelect = document.getElementById('log-session-filter');
    if (logSelect) logSelect.value = sessionId;

    // Trigger log re-filter
    if (window.DollhouseConsole && window.DollhouseConsole.logs && window.DollhouseConsole.logs.refilter) {
      window.DollhouseConsole.logs.refilter();
    }

    // Update dropdown selection state
    var items = document.querySelectorAll('.session-dropdown-item');
    for (var i = 0; i < items.length; i++) {
      var isSelected = items[i].dataset.sessionId === sessionId;
      items[i].classList.toggle('session-dropdown-item--selected', isSelected);
    }

    // Update the "All" item
    var allItem = document.querySelector('.session-dropdown-item--all');
    if (allItem) {
      allItem.classList.toggle('session-dropdown-item--selected', !sessionId);
    }

    // Update the box label to show filtered session name
    updateBoxLabel();
  }

  // Update the box text to reflect current filter
  function updateBoxLabel() {
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

  // Update the header session indicator
  function updateSessionIndicator() {
    var indicator = document.getElementById('session-indicator');
    if (!indicator) return;

    var active = sessions.filter(function(s) { return s.status === 'active'; });
    var count = active.length;

    indicator.innerHTML = '';
    if (count === 0) return;

    // Labeled box button
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

    // "All Sessions" option
    var allItem = document.createElement('div');
    allItem.className = 'session-dropdown-item session-dropdown-item--all';
    if (!filterSessionId) allItem.classList.add('session-dropdown-item--selected');
    allItem.setAttribute('role', 'option');
    allItem.innerHTML =
      '<span class="session-dropdown-check">' + (!filterSessionId ? '\u2713' : '') + '</span>' +
      '<span class="session-dropdown-name">All Sessions</span>' +
      '<span class="session-dropdown-role">' + count + ' total</span>';
    allItem.addEventListener('click', function(e) {
      e.stopPropagation();
      applyFilter('');
    });
    dropdown.appendChild(allItem);

    // Divider
    var divider = document.createElement('div');
    divider.className = 'session-dropdown-divider';
    dropdown.appendChild(divider);

    // Session items
    for (var i = 0; i < active.length; i++) {
      (function(s) {
        var item = document.createElement('div');
        item.className = 'session-dropdown-item';
        item.dataset.sessionId = s.sessionId;
        item.setAttribute('role', 'option');
        if (s.sessionId === filterSessionId) item.classList.add('session-dropdown-item--selected');

        var check = document.createElement('span');
        check.className = 'session-dropdown-check';
        check.textContent = s.sessionId === filterSessionId ? '\u2713' : '';
        item.appendChild(check);

        var dot = document.createElement('span');
        dot.className = 'session-dot' + (s.isLeader ? ' session-dot--leader' : '');
        item.appendChild(dot);

        var nameEl = document.createElement('span');
        nameEl.className = 'session-dropdown-name';
        nameEl.textContent = displayName(s);
        item.appendChild(nameEl);

        var roleEl = document.createElement('span');
        roleEl.className = 'session-dropdown-role';
        roleEl.textContent = s.isLeader ? 'leader' : 'follower';
        item.appendChild(roleEl);

        item.addEventListener('click', function(e) {
          e.stopPropagation();
          // Toggle: click same session again to deselect
          if (filterSessionId === s.sessionId) {
            applyFilter('');
          } else {
            applyFilter(s.sessionId);
          }
        });

        dropdown.appendChild(item);
      })(active[i]);
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'session-indicator-wrapper';
    wrapper.appendChild(box);
    wrapper.appendChild(dropdown);
    indicator.appendChild(wrapper);

    // Set initial label
    updateBoxLabel();

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

    var select = group.querySelector('select');
    select.addEventListener('change', function() {
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

  // Initialize
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
