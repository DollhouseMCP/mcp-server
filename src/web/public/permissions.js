/**
 * permissions.js — Live Permission Dashboard for DollhouseMCP (auto-dollhouse#5)
 *
 * Shows active gatekeeper policies, live permission decision feed, and system status.
 * Polls /api/permissions/status for policy state and recent decisions.
 * Follows Todd's metrics.js patterns (polling, card layout, lazy init).
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────

  let pollTimer = null;
  const POLL_INTERVAL_MS = 3000;
  let initialized = false;
  let lastDecisionId = null;
  let latestAggregateData = null;
  let latestSelectedData = null;
  let latestPollRequestId = 0;

  async function fetchPermissionStatus(sessionId) {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const res = await DollhouseAuth.apiFetch(`/api/permissions/status${query}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── Public API ─────────────────────────────────────────────

  window.DollhouseConsole = window.DollhouseConsole || {};
  window.DollhouseConsole.permissions = {
    init: initPermissions,
    destroy: destroyPermissions,
    refresh: function () { poll(); },
    onSessionChange: function () { renderFromCache(); },
  };

  // Hook into tab switching — Todd's app.js lazyInitTab only knows logs/metrics,
  // so we self-register by listening for tab clicks on 'permissions'.
  document.addEventListener('DOMContentLoaded', function () {
    const tabs = document.getElementById('console-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        const btn = e.target.closest('.console-tab');
        if (btn && btn.dataset.tab === 'permissions') {
          var dc = window.DollhouseConsole;
          if (dc && dc.permissions) {
            if (!initialized) dc.permissions.init();
            else if (dc.permissions.refresh) dc.permissions.refresh();
          }
        }
      });
    }
  });

  // ── Initialization ─────────────────────────────────────────

  function initPermissions() {
    if (initialized) return;
    initialized = true;

    const root = document.getElementById('permissions-dashboard-root');
    if (!root) return;

    root.innerHTML = buildDashboardHTML();
    attachCardToggles();
    poll(); // immediate first fetch
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function destroyPermissions() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    initialized = false;
  }

  // ── Polling ────────────────────────────────────────────────

  async function poll() {
    const requestId = ++latestPollRequestId;
    try {
      const aggregateData = await fetchPermissionStatus('');
      if (requestId !== latestPollRequestId) {
        return;
      }

      const currentSessionId = window.DollhouseSessions?.getFilterSessionId?.() || '';
      const selectedData = deriveSelectedSessionData(aggregateData, currentSessionId);

      latestAggregateData = aggregateData;
      latestSelectedData = selectedData;
      window.DollhouseSessions?.setPolicySessions?.(aggregateData.knownSessions || []);
      render(aggregateData, selectedData);
    } catch (err) {
      renderError(err.message);
    }
  }

  function renderFromCache() {
    if (!latestAggregateData) {
      poll();
      return;
    }

    const sessionId = window.DollhouseSessions?.getFilterSessionId?.() || '';
    latestSelectedData = deriveSelectedSessionData(latestAggregateData, sessionId);
    renderPolicySources(latestAggregateData, latestSelectedData);
    renderSelectedSessionDetail(latestSelectedData);
  }

  // ── Rendering ──────────────────────────────────────────────

  function render(data, selectedData) {
    renderStatusBar(data);
    renderSummaryStats(data);
    renderPolicySources(data, selectedData);
    renderSelectedSessionDetail(selectedData);
    renderDenyPatterns(data);
    renderAllowPatterns(data);
    renderConfirmPatterns(data);
    renderLiveFeed(data);
  }

  function renderError(message) {
    console.warn('[Permissions Dashboard] API error:', message);
    const dot = document.getElementById('perm-dot-server');
    if (dot) {
      dot.dataset.status = 'error';
      dot.parentElement.querySelector('.perm-status-label').textContent = 'Server unreachable';
    }
  }

  function renderStatusBar(data) {
    const serverDot = document.getElementById('perm-dot-server');
    const ensembleDot = document.getElementById('perm-dot-ensemble');
    const hookDot = document.getElementById('perm-dot-hook');
    const updated = document.getElementById('perm-last-updated');

    if (serverDot) {
      serverDot.dataset.status = 'active';
      serverDot.parentElement.querySelector('.perm-status-label').textContent = 'Server';
    }
    if (ensembleDot) {
      const hasElements = data.activeElementCount > 0;
      ensembleDot.dataset.status = hasElements ? 'active' : 'inactive';
      ensembleDot.parentElement.querySelector('.perm-status-label').textContent =
        hasElements ? `${data.activeElementCount} elements` : 'No ensemble';
    }
    if (hookDot) {
      const hasPatterns = (data.denyPatterns?.length || 0) + (data.allowPatterns?.length || 0) > 0;
      hookDot.dataset.status = hasPatterns ? 'active' : 'inactive';
      hookDot.parentElement.querySelector('.perm-status-label').textContent =
        hasPatterns ? 'Policies active' : 'No policies';
    }
    if (updated) {
      updated.textContent = new Date().toLocaleTimeString();
    }
  }

  function renderSummaryStats(data) {
    setText('perm-stat-deny-count', getAggregatePatterns(data, 'denyPatterns').length);
    setText('perm-stat-allow-count', getAggregatePatterns(data, 'allowPatterns').length);
    setText('perm-stat-confirm-count', getAggregatePatterns(data, 'confirmPatterns').length);
    setText('perm-stat-decisions', data.recentDecisions?.length || 0);

    // Decision breakdown
    const decisions = data.recentDecisions || [];
    const allowed = decisions.filter(d => d.decision === 'allow').length;
    const denied = decisions.filter(d => d.decision === 'deny').length;
    const asked = decisions.filter(d => d.decision === 'ask').length;
    setText('perm-stat-allowed', allowed);
    setText('perm-stat-denied', denied);
    setText('perm-stat-asked', asked);
  }

  function renderPolicySources(data, selectedData) {
    const list = document.getElementById('perm-source-list');
    if (!list) return;

    const elements = data.elements || [];
    const selectedSessionId = selectedData?.sessionId;
    if (elements.length === 0) {
      list.innerHTML = '<li class="perm-pattern-empty">No active elements with policies</li>';
      return;
    }

    list.innerHTML = elements.map(el => `
      <li class="perm-source-item${elementMatchesSelected(el, selectedSessionId) ? ' perm-source-item--selected' : ''}">
        <span class="perm-source-type">${esc(el.type)}</span>
        <span class="perm-source-name">${esc(el.element_name)}</span>
        ${el.description ? `<span style="color:var(--ink-400);font-size:0.75rem;margin-left:auto">${esc(el.description)}</span>` : ''}
      </li>
    `).join('');
  }

  function renderSelectedSessionDetail(selectedData) {
    const card = document.getElementById('perm-selected-card');
    const title = document.getElementById('perm-selected-title');
    const subtitle = document.getElementById('perm-selected-subtitle');
    const badge = document.getElementById('perm-selected-badge');
    const sourceList = document.getElementById('perm-selected-source-list');
    const denyList = document.getElementById('perm-selected-deny-list');
    const allowList = document.getElementById('perm-selected-allow-list');
    const confirmList = document.getElementById('perm-selected-confirm-list');

    if (!card || !title || !subtitle || !badge || !sourceList || !denyList || !allowList || !confirmList) {
      return;
    }

    if (!selectedData?.sessionId) {
      card.hidden = true;
      return;
    }

    card.hidden = false;

    const sessionInfo = window.DollhouseSessions?.getSelectableSessions?.()
      ?.find(session => session.sessionId === selectedData.sessionId);
    const sessionLabel = window.DollhouseSessions?.displayName?.(sessionInfo || selectedData.sessionId)
      || selectedData.sessionId;
    const policyOnly = !!sessionInfo?.isPolicyOnly;

    title.textContent = `Selected Session: ${sessionLabel}`;
    subtitle.textContent = policyOnly
      ? `${selectedData.sessionId} is showing saved policy state from disk. This is not a live attached client.`
      : `${selectedData.sessionId} is the current live policy view for this session. Decision activity is still shown in the All Sessions section below.`;

    badge.hidden = !policyOnly;
    if (policyOnly) {
      badge.textContent = 'Persisted Policy State (Debug Info)';
    }

    const elements = selectedData.elements || [];
    sourceList.innerHTML = elements.length === 0
      ? '<li class="perm-pattern-empty">No policy-bearing elements found for this session</li>'
      : elements.map(el => `
          <li class="perm-source-item perm-source-item--detail">
            <span class="perm-source-type">${esc(el.type)}</span>
            <span class="perm-source-name">${esc(el.element_name)}</span>
            ${el.description ? `<span style="color:var(--ink-400);font-size:0.75rem;margin-left:auto">${esc(el.description)}</span>` : ''}
          </li>
        `).join('');

    renderPatternList('perm-selected-deny-list', selectedData.denyPatterns || [], 'deny');
    renderPatternList('perm-selected-allow-list', selectedData.allowPatterns || [], 'allow');
    renderPatternList('perm-selected-confirm-list', selectedData.confirmPatterns || [], 'confirm');
  }

  function renderDenyPatterns(data) {
    renderPatternList('perm-deny-list', getAggregatePatterns(data, 'denyPatterns'), 'deny');
  }

  function renderAllowPatterns(data) {
    renderPatternList('perm-allow-list', getAggregatePatterns(data, 'allowPatterns'), 'allow');
  }

  function renderConfirmPatterns(data) {
    renderPatternList('perm-confirm-list', getAggregatePatterns(data, 'confirmPatterns'), 'confirm');
  }

  function renderPatternList(elementId, patterns, type) {
    const list = document.getElementById(elementId);
    if (!list) return;

    if (patterns.length === 0) {
      list.innerHTML = `<li class="perm-pattern-empty">No ${type} patterns active</li>`;
      return;
    }

    list.innerHTML = patterns.map(p => `
      <li class="perm-pattern-item">
        <span class="perm-pattern-badge perm-pattern-badge--${type}">${type}</span>
        <span class="perm-pattern-text">${esc(p)}</span>
      </li>
    `).join('');
  }

  function renderLiveFeed(data) {
    const feed = document.getElementById('perm-feed');
    if (!feed) return;

    const decisions = data.recentDecisions || [];
    if (decisions.length === 0) {
      feed.innerHTML = '<div class="perm-feed-empty">No permission decisions yet. Waiting for tool calls...</div>';
      return;
    }

    // Check if new decisions arrived
    const latestId = decisions[0]?.id;
    if (latestId === lastDecisionId) return; // no change
    lastDecisionId = latestId;

    feed.innerHTML = decisions.map(d => {
      const time = new Date(d.timestamp).toLocaleTimeString();
      const toolDisplay = d.tool_name === 'Bash'
        ? `Bash: ${esc(truncate(d.command || '', 60))}`
        : esc(d.tool_name);

      return `
        <div class="perm-feed-row">
          <span class="perm-feed-time">${time}</span>
          <span class="perm-feed-decision perm-feed-decision--${d.decision}">${d.decision.toUpperCase()}</span>
          <span class="perm-feed-tool" title="${esc(d.command || d.tool_name)}">${toolDisplay}</span>
          <span class="perm-feed-reason" title="${esc(d.reason || '')}">${esc(d.reason || '')}</span>
        </div>
      `;
    }).join('');
  }

  function deriveSelectedSessionData(aggregateData, sessionId) {
    if (!sessionId) return null;

    const elements = (aggregateData?.elements || []).filter(function (element) {
      return Array.isArray(element.sessionIds) && element.sessionIds.indexOf(sessionId) !== -1;
    });

    return {
      sessionId: sessionId,
      activeElementCount: elements.length,
      hasAllowlist: elements.some(function (element) {
        return Array.isArray(element.allowPatterns) && element.allowPatterns.length > 0;
      }),
      denyPatterns: flattenElementPatterns(elements, 'denyPatterns'),
      allowPatterns: flattenElementPatterns(elements, 'allowPatterns'),
      confirmPatterns: flattenElementPatterns(elements, 'confirmPatterns'),
      elements: elements.map(function (element) {
        return {
          type: element.type,
          element_name: element.element_name,
          description: element.description,
        };
      }),
      permissionPromptActive: !!aggregateData?.permissionPromptActive,
      recentDecisions: aggregateData?.recentDecisions || [],
    };
  }

  function flattenElementPatterns(elements, key) {
    return elements.flatMap(function (element) {
      return Array.isArray(element[key]) ? element[key] : [];
    });
  }

  function getAggregatePatterns(data, key) {
    const combined = Array.isArray(data && data[key]) ? data[key] : [];
    const perElement = flattenElementPatterns((data && data.elements) || [], key);
    return Array.from(new Set(combined.concat(perElement)));
  }

  // ── Dashboard HTML ─────────────────────────────────────────

  function buildDashboardHTML() {
    return `
      <div class="perm-status-bar">
        <div class="perm-status-indicator">
          <span class="perm-status-dot" id="perm-dot-server" data-status="inactive"></span>
          <span class="perm-status-label">Connecting...</span>
        </div>
        <div class="perm-status-indicator">
          <span class="perm-status-dot" id="perm-dot-ensemble" data-status="inactive"></span>
          <span class="perm-status-label">Ensemble</span>
        </div>
        <div class="perm-status-indicator">
          <span class="perm-status-dot" id="perm-dot-hook" data-status="inactive"></span>
          <span class="perm-status-label">Policies</span>
        </div>
        <span class="perm-status-spacer"></span>
        <span class="perm-status-updated">Updated: <span id="perm-last-updated">--:--:--</span></span>
      </div>

      <div class="perm-dashboard">

        <!-- All Sessions Live Decision Feed -->
        <div class="perm-card perm-card--full" data-collapsed="false" id="perm-all-feed-card">
          <div class="perm-card-header" role="button" tabindex="0" aria-expanded="true">
            <h3 class="perm-card-title">All Sessions Live Decision Feed</h3>
            <span class="perm-card-toggle" aria-hidden="true">&#9662;</span>
          </div>
          <div class="perm-card-body">
            <div class="perm-selected-header perm-selected-header--compact">
              <div>
                <div class="perm-selected-subtitle">Most recent first. This is the aggregate audit stream across all sessions.</div>
              </div>
              <button
                type="button"
                class="perm-panel-action"
                id="perm-feed-expand-btn"
                aria-expanded="false"
                aria-controls="perm-feed"
              >
                Expand Audit View
              </button>
            </div>
            <div class="perm-feed" id="perm-feed" role="log" aria-live="polite" aria-label="Permission decisions across all sessions">
              <div class="perm-feed-empty">No permission decisions yet. Waiting for tool calls...</div>
            </div>
          </div>
        </div>

        <!-- Summary Stats -->
        <div class="perm-card perm-card--full" data-collapsed="false">
          <div class="perm-card-header" role="button" tabindex="0" aria-expanded="true">
            <h3 class="perm-card-title">Autonomy Overview</h3>
            <span class="perm-card-toggle" aria-hidden="true">&#9662;</span>
          </div>
          <div class="perm-card-body">
            <div class="perm-stat-grid">
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--deny" id="perm-stat-deny-count">0</div>
                <div class="perm-stat-label">Deny Patterns</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--allow" id="perm-stat-allow-count">0</div>
                <div class="perm-stat-label">Allow Patterns</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--ask" id="perm-stat-confirm-count">0</div>
                <div class="perm-stat-label">Confirm Patterns</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value" id="perm-stat-decisions">0</div>
                <div class="perm-stat-label">Recent Decisions</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--allow" id="perm-stat-allowed">0</div>
                <div class="perm-stat-label">Allowed</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--deny" id="perm-stat-denied">0</div>
                <div class="perm-stat-label">Denied</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--ask" id="perm-stat-asked">0</div>
                <div class="perm-stat-label">Asked</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Selected Session Detail -->
        <div class="perm-card perm-card--full" data-collapsed="false" id="perm-selected-card" hidden>
          <div class="perm-card-header" role="button" tabindex="0" aria-expanded="true">
            <h3 class="perm-card-title">Selected Session Detail</h3>
            <span class="perm-card-toggle" aria-hidden="true">&#9662;</span>
          </div>
          <div class="perm-card-body">
            <div class="perm-selected-header">
              <div>
                <div class="perm-selected-title" id="perm-selected-title">Selected Session</div>
                <div class="perm-selected-subtitle" id="perm-selected-subtitle"></div>
              </div>
              <span class="perm-selected-badge" id="perm-selected-badge" hidden>Persisted Policy State (Debug Info)</span>
            </div>

            <div class="perm-selected-grid">
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Policy Sources</h4>
                <ul class="perm-source-list" id="perm-selected-source-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Deny Patterns</h4>
                <ul class="perm-pattern-list" id="perm-selected-deny-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Allow Patterns</h4>
                <ul class="perm-pattern-list" id="perm-selected-allow-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Confirm Patterns</h4>
                <ul class="perm-pattern-list" id="perm-selected-confirm-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div class="perm-card perm-card--full" data-collapsed="false">
          <div class="perm-card-header" role="button" tabindex="0" aria-expanded="true">
            <h3 class="perm-card-title">All Sessions Detail</h3>
            <span class="perm-card-toggle" aria-hidden="true">&#9662;</span>
          </div>
          <div class="perm-card-body">
            <div class="perm-selected-header perm-selected-header--compact">
              <div>
                <div class="perm-selected-title">All Sessions</div>
                <div class="perm-selected-subtitle">Aggregate policy state across all live and persisted sessions. The decision feed below is currently aggregate, not selection-scoped.</div>
              </div>
            </div>

            <div class="perm-selected-grid">
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Policy Sources</h4>
                <ul class="perm-source-list" id="perm-source-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Deny Patterns</h4>
                <ul class="perm-pattern-list" id="perm-deny-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Allow Patterns</h4>
                <ul class="perm-pattern-list" id="perm-allow-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Confirm Patterns</h4>
                <ul class="perm-pattern-list" id="perm-confirm-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

      </div>
    `;
  }

  // ── Helpers ────────────────────────────────────────────────

  function attachCardToggles() {
    document.querySelectorAll('.perm-card-header').forEach(header => {
      const toggle = () => {
        const card = header.parentElement;
        const collapsed = card.dataset.collapsed === 'true';
        card.dataset.collapsed = collapsed ? 'false' : 'true';
        header.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });

    const expandBtn = document.getElementById('perm-feed-expand-btn');
    const feedCard = document.getElementById('perm-all-feed-card');
    if (expandBtn && feedCard) {
      expandBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const expanded = feedCard.classList.toggle('perm-card--audit');
        expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        expandBtn.textContent = expanded ? 'Compact Audit View' : 'Expand Audit View';
      });
    }
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  function elementMatchesSelected(element, sessionId) {
    if (!sessionId || !Array.isArray(element?.sessionIds)) return false;
    return element.sessionIds.includes(sessionId);
  }

  // dmcp-sec[DMCP-SEC-004] — Client-side JS: UnicodeValidator unavailable in browser.
  // Using native String.normalize('NFC') which performs the same NFC normalization.
  // All data comes from our own server API, not direct user input.
  function esc(str) {
    const normalized = String(str).normalize('NFC');
    const div = document.createElement('div');
    div.textContent = normalized;
    return div.innerHTML;
  }

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

})();
