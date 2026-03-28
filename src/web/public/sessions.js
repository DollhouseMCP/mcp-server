/**
 * Session awareness for the unified web console.
 *
 * Shows a labeled "N sessions" box in the header. Clicking opens a
 * dropdown listing each session by its puppet name and role.
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

  // Update the header session indicator
  function updateSessionIndicator() {
    var indicator = document.getElementById('session-indicator');
    if (!indicator) return;

    var active = sessions.filter(function(s) { return s.status === 'active'; });
    var count = active.length;

    indicator.innerHTML = '';

    if (count === 0) return;

    // Labeled box
    var box = document.createElement('button');
    box.className = 'session-box';
    box.type = 'button';
    box.setAttribute('aria-expanded', 'false');
    box.setAttribute('aria-haspopup', 'true');

    var label = document.createElement('span');
    label.className = 'session-box-count';
    label.textContent = String(count);

    var text = document.createElement('span');
    text.className = 'session-box-label';
    text.textContent = count === 1 ? 'session' : 'sessions';

    box.appendChild(label);
    box.appendChild(text);

    // Dropdown
    var dropdown = document.createElement('div');
    dropdown.className = 'session-dropdown';
    dropdown.hidden = true;

    var heading = document.createElement('div');
    heading.className = 'session-dropdown-heading';
    heading.textContent = 'Active Sessions';
    dropdown.appendChild(heading);

    for (var i = 0; i < active.length; i++) {
      var item = document.createElement('div');
      item.className = 'session-dropdown-item';

      var dot = document.createElement('span');
      dot.className = 'session-dot' + (active[i].isLeader ? ' session-dot--leader' : '');
      item.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.className = 'session-dropdown-name';
      nameEl.textContent = displayName(active[i]);
      item.appendChild(nameEl);

      var roleEl = document.createElement('span');
      roleEl.className = 'session-dropdown-role';
      roleEl.textContent = active[i].isLeader ? 'leader' : 'follower';
      item.appendChild(roleEl);

      dropdown.appendChild(item);
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'session-indicator-wrapper';
    wrapper.appendChild(box);
    wrapper.appendChild(dropdown);
    indicator.appendChild(wrapper);

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
      filterSessionId = this.value;
      if (window.DollhouseConsole && window.DollhouseConsole.logs && window.DollhouseConsole.logs.refilter) {
        window.DollhouseConsole.logs.refilter();
      }
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
