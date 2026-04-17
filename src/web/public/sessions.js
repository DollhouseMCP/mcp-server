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
  var LEADER_RELOAD_DEBOUNCE_MS = getConfiguredNumber('leaderReloadDebounceMs', 150);
  var POLICY_DEBUG_VISIBILITY_KEY = 'dollhouse.policyDebugVisible';
  var sessions = [];
  var policySessions = [];
  var filterSessionId = '';
  var dropdownBuilt = false;
  var lastSessionKey = ''; // tracks session list identity to avoid unnecessary rebuilds
  var lastReloadTargetVersion = '';
  var pendingLeaderReloadTimer = null;
  var showPolicySessions = loadPolicyDebugVisibility();

  function loadPolicyDebugVisibility() {
    try {
      return window.localStorage.getItem(POLICY_DEBUG_VISIBILITY_KEY) === 'true';
    } catch (err) {
      return false;
    }
  }

  function persistPolicyDebugVisibility(nextVisible) {
    try {
      window.localStorage.setItem(POLICY_DEBUG_VISIBILITY_KEY, nextVisible ? 'true' : 'false');
    } catch (err) {
      // best-effort only
    }
  }

  function parseSemver(version) {
    if (typeof version !== 'string') return null;
    var trimmed = version.trim();
    var match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
    if (!match) return null;
    return {
      normalized: trimmed,
      major: parseInt(match[1], 10) || 0,
      minor: parseInt(match[2], 10) || 0,
      patch: parseInt(match[3], 10) || 0,
      prerelease: match[4] ? match[4].split('.') : [],
    };
  }

  function normalizeSemver(version) {
    var parsed = parseSemver(version);
    return parsed ? parsed.normalized : '';
  }

  function comparePrereleaseParts(partsA, partsB) {
    var maxLength = Math.max(partsA.length, partsB.length);
    if (!maxLength) return 0;
    for (var i = 0; i < maxLength; i++) {
      var a = partsA[i];
      var b = partsB[i];
      if (a === undefined) return -1;
      if (b === undefined) return 1;

      var aIsNumeric = /^\d+$/.test(a);
      var bIsNumeric = /^\d+$/.test(b);
      if (aIsNumeric && bIsNumeric) {
        var aNumber = parseInt(a, 10);
        var bNumber = parseInt(b, 10);
        if (aNumber < bNumber) return -1;
        if (aNumber > bNumber) return 1;
        continue;
      }

      if (aIsNumeric) return -1;
      if (bIsNumeric) return 1;

      var lexical = a.localeCompare(b);
      if (lexical !== 0) return lexical;
    }
    return 0;
  }

  function compareSemver(versionA, versionB) {
    var a = parseSemver(versionA);
    var b = parseSemver(versionB);
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    var versionKeys = ['major', 'minor', 'patch'];
    for (var i = 0; i < versionKeys.length; i++) {
      var key = versionKeys[i];
      var aPart = a[key];
      var bPart = b[key];
      if (aPart < bPart) return -1;
      if (aPart > bPart) return 1;
    }

    if (!a.prerelease.length && b.prerelease.length) return 1;
    if (a.prerelease.length && !b.prerelease.length) return -1;
    return comparePrereleaseParts(a.prerelease, b.prerelease);
  }

  function getCurrentConsoleVersion() {
    var dc = window.DollhouseConsole;
    if (dc && typeof dc.currentServerVersion === 'string') {
      return normalizeSemver(dc.currentServerVersion);
    }
    var meta = document.querySelector('meta[name="dollhouse-server-version"]');
    return normalizeSemver(meta ? meta.getAttribute('content') || '' : '');
  }

  /**
   * Schedule a cache-busted reload when the session poller observes that a
   * newer MCP leader is serving the console than the version loaded in this tab.
   * A small debounce lets rapid leadership churn settle so the browser reloads
   * directly into the newest compatible leader rather than bouncing through
   * intermediate versions.
   *
   * @param {Array<Record<string, unknown>>} list
   */
  function maybeForceReloadForNewLeader(list) {
    var dc = window.DollhouseConsole;
    if (!dc || typeof dc.forceReload !== 'function' || !Array.isArray(list)) return;
    var currentVersion = getCurrentConsoleVersion();
    var leader = list.find(function(session) {
      return session && session.status === 'active' && session.isLeader && session.kind === 'mcp';
    });
    if (!leader) return;
    var leaderVersion = normalizeSemver(leader.serverVersion);
    if (!leaderVersion) return;
    if (compareSemver(leaderVersion, currentVersion) <= 0) return;
    if (lastReloadTargetVersion === leaderVersion) return;
    if (pendingLeaderReloadTimer) {
      clearTimeout(pendingLeaderReloadTimer);
    }
    lastReloadTargetVersion = leaderVersion;
    pendingLeaderReloadTimer = setTimeout(function() {
      pendingLeaderReloadTimer = null;
      dc.forceReload('leader-upgraded', leaderVersion);
    }, LEADER_RELOAD_DEBOUNCE_MS);
  }

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

  function isPolicyOnlySession(session) {
    return !!(session && session.isPolicyOnly);
  }

  function displayName(session) {
    if (typeof session === 'object' && session.displayName) return nfc(session.displayName);
    var id = typeof session === 'string' ? nfc(session) : nfc((session && session.sessionId) || '');
    var parts = id.split('-');
    return parts.length >= 2 ? parts[1] : id.slice(0, 8);
  }

  function getLiveSessions() {
    return sessions.filter(function(s) { return s.status === 'active'; });
  }

  function getSelectableSessions() {
    var live = getLiveSessions();
    if (!showPolicySessions) {
      return live;
    }
    var liveIds = new Set(live.map(function(s) { return s.sessionId; }));
    var merged = live.slice();
    for (var i = 0; i < policySessions.length; i++) {
      if (!liveIds.has(policySessions[i].sessionId)) merged.push(policySessions[i]);
    }
    return merged;
  }

  function getActiveTabName() {
    var activeTab = document.querySelector('.console-tab.active');
    return activeTab ? activeTab.dataset.tab || '' : '';
  }

  function normalizePolicySessions(list) {
    if (!Array.isArray(list)) return [];

    var seen = new Set();
    var normalized = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item.sessionId !== 'string') continue;
      var sessionId = nfc(item.sessionId).trim();
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      normalized.push({
        sessionId: sessionId,
        displayName: nfc(typeof item.displayName === 'string' && item.displayName ? item.displayName : sessionId),
        color: '#94a3b8',
        pid: 0,
        startedAt: '',
        lastHeartbeat: '',
        status: 'policy',
        isLeader: false,
        authenticated: false,
        kind: 'policy',
        isPolicyOnly: true,
      });
    }

    normalized.sort(function(a, b) { return a.sessionId.localeCompare(b.sessionId); });
    return normalized;
  }

  function setPolicySessions(nextSessions) {
    policySessions = normalizePolicySessions(nextSessions);
    updateSessionIndicator();
    updateSessionFilterOptions();
  }

  function allSessionsSummary(liveCount, policyCount) {
    if (policyCount <= 0) return liveCount + ' total';
    if (liveCount <= 0) return policyCount + ' saved';
    return liveCount + ' live, ' + policyCount + ' saved';
  }

  // Build a key from current sessions to detect changes
  function sessionListKey(list) {
    return list.map(function(s) {
      return s.sessionId + ':' + s.status + ':' + (isPolicyOnlySession(s) ? 'policy' : 'live');
    }).join(',')
      + '|policyDebug:' + (showPolicySessions ? 'on' : 'off')
      + '|knownPolicy:' + policySessions.map(function(session) { return session.sessionId; }).join(',');
  }

  function setPolicyDebugVisibility(nextVisible, keepDropdownOpen) {
    var normalized = !!nextVisible;
    if (showPolicySessions === normalized) return;
    showPolicySessions = normalized;
    persistPolicyDebugVisibility(showPolicySessions);

    if (!showPolicySessions) {
      var current = getSelectableSessions().find(function(session) {
        return session.sessionId === filterSessionId;
      });
      if (!current && filterSessionId) {
        applyFilter('');
      }
    }

    updateSessionIndicator({ keepOpen: !!keepDropdownOpen });
    updateSessionFilterOptions();
    window.dispatchEvent(new CustomEvent('dollhouse:policy-debug-visibility-changed', {
      detail: { visible: showPolicySessions },
    }));
  }

  // Apply session filter and update all UI to reflect it
  function applyFilter(sessionId) {
    filterSessionId = sessionId;

    // Sync log viewer select
    var logSelect = document.getElementById('log-session-filter');
    if (logSelect) logSelect.value = sessionId;

    if (window.DollhouseConsole && window.DollhouseConsole.permissions) {
      if (window.DollhouseConsole.permissions.onSessionChange) {
        window.DollhouseConsole.permissions.onSessionChange(sessionId);
      } else if (window.DollhouseConsole.permissions.refresh) {
        window.DollhouseConsole.permissions.refresh();
      }
    }

    // Trigger log re-filter only when the Logs tab is active. Refiltering the
    // virtualized log buffer can be expensive, and it should not delay session
    // switching on other tabs like Permissions.
    if (getActiveTabName() === 'logs'
      && window.DollhouseConsole
      && window.DollhouseConsole.logs
      && window.DollhouseConsole.logs.refilter) {
      window.DollhouseConsole.logs.refilter(sessionId);
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
      uptimes[j].textContent = uptimes[j].dataset.startedAt ? formatUptime(uptimes[j].dataset.startedAt) : 'saved';
    }

    // Update box label
    var countEl = document.querySelector('.session-box-count');
    var labelEl = document.querySelector('.session-box-label');
    if (!countEl || !labelEl) return;

    var active = getLiveSessions();
    var selectable = getSelectableSessions();

    if (filterSessionId) {
      var filtered = selectable.find(function(s) { return s.sessionId === filterSessionId; });
      if (filtered) {
        countEl.textContent = displayName(filtered);
        if (filtered.color) countEl.style.color = filtered.color;
        labelEl.textContent = isPolicyOnlySession(filtered) ? 'policy only' : ('1/' + active.length);
        return;
      }
    }

    if (active.length === 1) {
      countEl.textContent = displayName(active[0]);
      if (active[0].color) countEl.style.color = active[0].color;
      labelEl.textContent = formatUptime(active[0].startedAt);
      return;
    }

    // Reset color when showing count
    countEl.style.color = '';
    countEl.textContent = String(active.length);
    labelEl.textContent = active.length === 1 ? 'session' : 'sessions';
  }

  // Build or rebuild the session indicator — only when session list actually changes
  function updateSessionIndicator(options) {
    var keepOpen = !!(options && options.keepOpen);
    var active = getLiveSessions();
    var selectable = getSelectableSessions();
    var visiblePolicyOnly = selectable.filter(function(s) { return isPolicyOnlySession(s); });
    var key = sessionListKey(selectable);

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
    dropdown.hidden = !keepOpen;

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
    allCount.textContent = allSessionsSummary(count, visiblePolicyOnly.length);
    allItem.appendChild(allCount);

    allItem.addEventListener('click', function(e) {
      e.stopPropagation();
      applyFilter('');
    });
    dropdown.appendChild(allItem);

    function appendDivider() {
      var divider = document.createElement('div');
      divider.className = 'session-dropdown-divider';
      dropdown.appendChild(divider);
    }

    function appendHeading(text) {
      var heading = document.createElement('div');
      heading.className = 'session-dropdown-heading';
      heading.textContent = text;
      dropdown.appendChild(heading);
    }

    function appendDebugHeading() {
      var heading = document.createElement('div');
      heading.className = 'session-dropdown-heading session-dropdown-heading--toggle';

      var title = document.createElement('span');
      title.className = 'session-dropdown-heading-label';
      title.textContent = 'Persisted Policy State (Debug Info)';
      heading.appendChild(title);

      var controls = document.createElement('div');
      controls.className = 'session-dropdown-toggle-group';

      var visibleLabel = document.createElement('span');
      visibleLabel.className = 'session-dropdown-toggle-label';
      visibleLabel.textContent = 'Visible';
      controls.appendChild(visibleLabel);

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'session-dropdown-switch';
      toggle.dataset.state = showPolicySessions ? 'on' : 'off';
      toggle.setAttribute('aria-pressed', showPolicySessions ? 'true' : 'false');
      toggle.setAttribute('aria-label', 'Toggle persisted policy state debug visibility');
      toggle.innerHTML = '<span class="session-dropdown-switch-label session-dropdown-switch-label--off">Off</span>'
        + '<span class="session-dropdown-switch-label session-dropdown-switch-label--on">On</span>'
        + '<span class="session-dropdown-switch-thumb" aria-hidden="true"></span>';
      toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        setPolicyDebugVisibility(!showPolicySessions, true);
      });
      controls.appendChild(toggle);

      heading.appendChild(controls);
      dropdown.appendChild(heading);
    }

    // Session items — leader first, then followers
    var sorted = active.slice().sort(function(a, b) {
      if (a.isLeader && !b.isLeader) return -1;
      if (!a.isLeader && b.isLeader) return 1;
      return 0;
    });

    function appendSessionItem(s) {
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

      // Session status badges (#1805) — for persisted policy sessions we
      // switch from "live/authenticated" semantics to "saved/no client".
      var authBadge = document.createElement('span');
      authBadge.className = 'session-status-badge';
      if (isPolicyOnlySession(s)) {
        authBadge.textContent = 'Saved';
        authBadge.dataset.status = 'positive';
        authBadge.title = 'Persisted policy state from a prior session';
      } else if (s.authenticated) {
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
      if (isPolicyOnlySession(s)) {
        clientBadge.textContent = 'No client';
        clientBadge.dataset.status = 'negative';
        clientBadge.title = 'No live MCP client is currently attached';
      } else if (s.kind === 'mcp') {
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
      uptimeEl.textContent = isPolicyOnlySession(s) ? 'saved' : formatUptime(s.startedAt);
      item.appendChild(uptimeEl);

      var killBtn = document.createElement('button');
      killBtn.className = 'session-kill-btn';
      killBtn.type = 'button';
      killBtn.textContent = '\u00D7';
      if (isPolicyOnlySession(s)) {
        killBtn.disabled = true;
        killBtn.style.visibility = 'hidden';
      } else {
        killBtn.title = 'Stop ' + displayName(s);
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
      }
      item.appendChild(killBtn);

      item.addEventListener('click', function(e) {
        e.stopPropagation();
        applyFilter(filterSessionId === s.sessionId ? '' : s.sessionId);
      });

      dropdown.appendChild(item);
    }

    if (sorted.length > 0) {
      appendDivider();
      appendHeading('Live Sessions');
      for (var i = 0; i < sorted.length; i++) {
        appendSessionItem(sorted[i]);
      }
    }

    if (policySessions.length > 0) {
      appendDivider();
      appendDebugHeading();
      for (var j = 0; j < visiblePolicyOnly.length; j++) {
        appendSessionItem(visiblePolicyOnly[j]);
      }
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'session-indicator-wrapper';
    wrapper.appendChild(box);
    wrapper.appendChild(dropdown);
    indicator.appendChild(wrapper);

    dropdownBuilt = true;
    box.setAttribute('aria-expanded', keepOpen ? 'true' : 'false');

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
    var selectable = getSelectableSessions();

    select.innerHTML = '<option value="">All Sessions</option>';
    for (var i = 0; i < selectable.length; i++) {
      var opt = document.createElement('option');
      opt.value = selectable[i].sessionId;
      opt.textContent = displayName(selectable[i])
        + (selectable[i].isLeader ? ' (leader)' : '')
        + (isPolicyOnlySession(selectable[i]) ? ' (policy only)' : '');
      if (selectable[i].sessionId === current) opt.selected = true;
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
        maybeForceReloadForNewLeader(sessions);
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
    getLiveSessions: getLiveSessions,
    getSelectableSessions: getSelectableSessions,
    setPolicySessions: setPolicySessions,
    isPolicyDebugVisible: function() { return showPolicySessions; },
    setPolicyDebugVisibility: setPolicyDebugVisibility,
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
