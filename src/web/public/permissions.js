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
    renderAdvisory(data);
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
    const hookLabel = hookDot ? hookDot.parentElement.querySelector('.perm-status-label') : null;
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
    if (hookDot && hookLabel) {
      const hasExternalRules = (data.denyPatterns?.length || 0)
        + (data.allowPatterns?.length || 0)
        + (data.confirmPatterns?.length || 0) > 0;
      const hasAnyRules = (data.denyRules?.length || 0)
        + (data.allowRules?.length || 0)
        + (data.confirmRules?.length || 0) > 0;
      if (!hasAnyRules) {
        hookDot.dataset.status = 'inactive';
        hookLabel.textContent = 'No policies';
      } else if (!hasExternalRules) {
        hookDot.dataset.status = 'active';
        hookLabel.textContent = 'MCP-AQL policies active';
      } else if (data.permissionPromptActive) {
        hookDot.dataset.status = 'active';
        hookLabel.textContent = 'Prompt tool active';
      } else if (data.hookInstalled) {
        hookDot.dataset.status = 'active';
        hookLabel.textContent = data.hookHost ? `Hook installed (${data.hookHost})` : 'Hook installed';
      } else {
        hookDot.dataset.status = 'warning';
        hookLabel.textContent = 'Policies loaded, not enforced';
      }
    }
    if (updated) {
      updated.textContent = new Date().toLocaleTimeString();
    }
  }

  function renderSummaryStats(data) {
    setText('perm-stat-deny-count', getAggregateRules(data, 'denyRules').length);
    setText('perm-stat-allow-count', getAggregateRules(data, 'allowRules').length);
    setText('perm-stat-confirm-count', getAggregateRules(data, 'confirmRules').length);
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

  function renderAdvisory(data) {
    const advisory = document.getElementById('perm-all-sessions-advisory');
    if (!advisory) return;

    if (data && data.advisory) {
      advisory.hidden = false;
      advisory.textContent = ` ${data.advisory}`;
    } else {
      advisory.hidden = true;
      advisory.textContent = '';
    }
  }

  function renderPolicySources(data, selectedData) {
    const list = document.getElementById('perm-source-list');
    if (!list) return;

    const elements = data.elements || [];
    const selectedSessionId = selectedData?.sessionId;
    if (elements.length === 0) {
      list.innerHTML = '<li class="perm-pattern-empty">No active elements with policies</li>';
      renderInvalidPolicySummary('perm-all-invalid-policy-summary', []);
      return;
    }

    renderInvalidPolicySummary('perm-all-invalid-policy-summary', elements);
    list.innerHTML = elements.map(el =>
      renderPolicySourceItem(el, elementMatchesSelected(el, selectedSessionId) ? ' perm-source-item--selected' : '')
    ).join('');
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
    renderInvalidPolicySummary('perm-selected-invalid-policy-summary', elements);
    sourceList.innerHTML = elements.length === 0
      ? '<li class="perm-pattern-empty">No policy-bearing elements found for this session</li>'
      : elements.map(el => renderPolicySourceItem(el, ' perm-source-item--detail')).join('');

    renderPatternList('perm-selected-deny-list', selectedData.denyRules || [], 'deny');
    renderPatternList('perm-selected-allow-list', selectedData.allowRules || [], 'allow');
    renderPatternList('perm-selected-confirm-list', selectedData.confirmRules || [], 'confirm');
  }

  function renderDenyPatterns(data) {
    renderPatternList('perm-deny-list', getAggregateRules(data, 'denyRules'), 'deny');
  }

  function renderAllowPatterns(data) {
    renderPatternList('perm-allow-list', getAggregateRules(data, 'allowRules'), 'allow');
  }

  function renderConfirmPatterns(data) {
    renderPatternList('perm-confirm-list', getAggregateRules(data, 'confirmRules'), 'confirm');
  }

  function renderPatternList(elementId, patterns, type) {
    const list = document.getElementById(elementId);
    if (!list) return;

    if (patterns.length === 0) {
      list.innerHTML = `<li class="perm-pattern-empty">No ${type} rules active</li>`;
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
    const modalFeed = document.getElementById('perm-audit-modal-feed');
    const modalCount = document.getElementById('perm-audit-modal-count');
    if (!feed) return;

    const decisions = data.recentDecisions || [];
    if (decisions.length === 0) {
      const empty = '<div class="perm-feed-empty">No permission decisions yet. Waiting for tool calls...</div>';
      feed.innerHTML = empty;
      if (modalFeed) modalFeed.innerHTML = empty;
      if (modalCount) modalCount.textContent = '0 captured entries';
      return;
    }

    // Check if new decisions arrived
    const latestId = decisions[0]?.id;
    if (latestId === lastDecisionId) return; // no change
    lastDecisionId = latestId;

    const html = decisions.map(renderCompactDecisionRow).join('');

    feed.innerHTML = html;
    if (modalFeed) modalFeed.innerHTML = renderAuditModal(decisions);
    if (modalCount) {
      modalCount.textContent = `${decisions.length} captured ${decisions.length === 1 ? 'entry' : 'entries'}`;
    }
  }

  function renderCompactDecisionRow(decision) {
    const toolDisplay = decision.tool_name === 'Bash'
      ? `Bash: ${esc(truncate(decision.command || '', 60))}`
      : esc(decision.tool_name);

    return `
      <div class="perm-feed-row">
        <span class="perm-feed-time">${esc(formatShortTime(decision.timestamp))}</span>
        <span class="perm-feed-decision perm-feed-decision--${decision.decision}">${esc(getDecisionLabel(decision.decision))}</span>
        <span class="perm-feed-tool" title="${esc(decision.command || decision.tool_name)}">${toolDisplay}</span>
        <span class="perm-feed-reason" title="${esc(decision.reason || '')}">${esc(decision.reason || '')}</span>
      </div>
    `;
  }

  function renderAuditModal(decisions) {
    if (!decisions || decisions.length === 0) {
      return '<div class="perm-feed-empty">No permission decisions yet. Waiting for tool calls...</div>';
    }

    return decisions.map(renderAuditDecisionEntry).join('');
  }

  function renderAuditDecisionEntry(decision) {
    const compactContext = getCompactContext(decision);
    const detailRows = Array.isArray(decision.details) ? decision.details : [];
    const reasonBlock = decision.reason
      ? `
        <div class="perm-audit-reason-block">
          <div class="perm-audit-meta-label">Reason</div>
          <p class="perm-audit-reason-text">${esc(decision.reason)}</p>
        </div>
      `
      : '';
    const detailList = detailRows.length > 0
      ? `
        <dl class="perm-audit-detail-list">
          ${detailRows.map(detail => `
            <div class="perm-audit-detail-row">
              <dt class="perm-audit-meta-label">${esc(detail.label)}</dt>
              <dd class="perm-audit-meta-value${detail.monospace ? ' perm-audit-detail-value--mono' : ''}">${esc(detail.value)}</dd>
            </div>
          `).join('')}
          <div class="perm-audit-detail-row">
            <dt class="perm-audit-meta-label">Exact Time</dt>
            <dd class="perm-audit-meta-value perm-audit-detail-value--mono">${esc(formatExactTimestamp(decision.timestamp))}</dd>
          </div>
        </dl>
      `
      : `
        <dl class="perm-audit-detail-list">
          <div class="perm-audit-detail-row">
            <dt class="perm-audit-meta-label">Exact Time</dt>
            <dd class="perm-audit-meta-value perm-audit-detail-value--mono">${esc(formatExactTimestamp(decision.timestamp))}</dd>
          </div>
        </dl>
      `;

    return `
      <details class="perm-audit-entry">
        <summary class="perm-audit-summary-row">
          <span class="perm-audit-time-group">
            <span class="perm-audit-time">${esc(formatShortTime(decision.timestamp))}</span>
            <span class="perm-audit-date">${esc(formatShortDate(decision.timestamp))}</span>
          </span>
          <span class="perm-feed-decision perm-feed-decision--${decision.decision}">${esc(getDecisionLabel(decision.decision))}</span>
          <span class="perm-audit-tool">${esc(decision.tool_name)}</span>
          <span class="perm-audit-context">${esc(compactContext)}</span>
        </summary>
        <div class="perm-audit-entry-body">
          ${reasonBlock}
          ${detailList}
        </div>
      </details>
    `;
  }

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatShortDate(timestamp) {
    return new Date(timestamp).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    });
  }

  function formatExactTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  }

  function getDecisionLabel(decision) {
    return String(decision || '').toUpperCase();
  }

  function getCompactContext(decision) {
    if (decision.targetLabel && decision.target) {
      return `${decision.targetLabel}: ${truncate(decision.target, 96)}`;
    }
    if (decision.command) {
      return truncate(decision.command, 96);
    }
    return decision.reason || 'No extra context captured';
  }

  function renderPolicySourceItem(el, extraClass = '') {
    const invalidBadge = el.invalidGatekeeperPolicy
      ? `<span class="perm-source-warning" title="${esc(el.invalidGatekeeperMessage || '')}">policy invalid</span>`
      : '';
    const description = el.description
      ? `<span style="color:var(--ink-400);font-size:0.75rem;margin-left:auto">${esc(el.description)}</span>`
      : '';

    return `
      <li class="perm-source-item${extraClass}">
        <span class="perm-source-type">${esc(el.type)}</span>
        <span class="perm-source-name">${esc(el.element_name || el.name || '')}</span>
        ${invalidBadge}
        ${description}
      </li>
    `;
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
        return Array.isArray(element.allowRules) && element.allowRules.length > 0;
      }),
      denyRules: flattenElementPatterns(elements, 'denyRules'),
      allowRules: flattenElementPatterns(elements, 'allowRules'),
      confirmRules: flattenElementPatterns(elements, 'confirmRules'),
      elements: elements.map(function (element) {
        return {
          type: element.type,
          element_name: element.element_name,
          description: element.description,
          invalidGatekeeperPolicy: !!element.invalidGatekeeperPolicy,
          invalidGatekeeperMessage: element.invalidGatekeeperMessage,
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

  function getAggregateRules(data, key) {
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
                <div class="perm-selected-subtitle">Aggregate audit stream across all sessions. Newest decisions appear first.</div>
              </div>
              <button
                type="button"
                class="perm-panel-action"
                id="perm-feed-expand-btn"
                aria-haspopup="dialog"
                aria-controls="perm-audit-modal"
              >
                Open Audit View
              </button>
            </div>
            <div class="perm-feed" id="perm-feed" role="log" aria-live="polite" aria-label="Permission decisions across all sessions">
              <div class="perm-feed-empty">No permission decisions yet. Waiting for tool calls...</div>
            </div>
          </div>
        </div>

        <!-- Summary Stats -->
        <div class="perm-card perm-card--full" data-collapsed="false" id="perm-autonomy-card">
          <div class="perm-card-header" role="button" tabindex="0" aria-expanded="true">
            <h3 class="perm-card-title">Autonomy Overview</h3>
            <span class="perm-card-toggle" aria-hidden="true">&#9662;</span>
          </div>
          <div class="perm-card-body">
            <div class="perm-stat-grid">
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--deny" id="perm-stat-deny-count">0</div>
                <div class="perm-stat-label">Deny Rules</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--allow" id="perm-stat-allow-count">0</div>
                <div class="perm-stat-label">Allow Rules</div>
              </div>
              <div class="perm-stat">
                <div class="perm-stat-value perm-stat-value--ask" id="perm-stat-confirm-count">0</div>
                <div class="perm-stat-label">Confirm Rules</div>
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
                <div class="perm-inline-warning" id="perm-selected-invalid-policy-summary" hidden></div>
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
                <h4 class="perm-selected-panel-title">Deny Rules</h4>
                <ul class="perm-pattern-list" id="perm-selected-deny-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Allow Rules</h4>
                <ul class="perm-pattern-list" id="perm-selected-allow-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Confirm Rules</h4>
                <ul class="perm-pattern-list" id="perm-selected-confirm-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div class="perm-card perm-card--full" data-collapsed="false" id="perm-all-detail-card">
          <div class="perm-card-header" role="button" tabindex="0" aria-expanded="true">
            <h3 class="perm-card-title">All Sessions Detail</h3>
            <span class="perm-card-toggle" aria-hidden="true">&#9662;</span>
          </div>
          <div class="perm-card-body">
            <div class="perm-selected-header perm-selected-header--compact">
              <div>
                <div class="perm-selected-title">All Sessions</div>
                <div class="perm-selected-subtitle">${esc('Aggregate policy state across all live and persisted sessions. Rules shown here include both Dollhouse operation policies and external tool restrictions.')}${dataAdvisoryPlaceholder()}</div>
                <div class="perm-inline-warning" id="perm-all-invalid-policy-summary" hidden></div>
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
                <h4 class="perm-selected-panel-title">Deny Rules</h4>
                <ul class="perm-pattern-list" id="perm-deny-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Allow Rules</h4>
                <ul class="perm-pattern-list" id="perm-allow-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Confirm Rules</h4>
                <ul class="perm-pattern-list" id="perm-confirm-list">
                  <li class="perm-pattern-empty">Loading...</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

      </div>

      <dialog class="modal perm-audit-modal" id="perm-audit-modal" aria-labelledby="perm-audit-modal-title">
        <div class="modal-overlay" data-close-audit-modal></div>
        <div class="modal-dialog perm-audit-modal-dialog" role="document">
          <header class="modal-header">
            <div class="modal-heading">
              <h2 class="modal-title" id="perm-audit-modal-title">All Sessions Audit View</h2>
              <span class="modal-type">Permissions</span>
            </div>
            <div class="modal-meta">
              <span>Aggregate decision log across all sessions</span>
              <span id="perm-audit-modal-count">0 captured entries</span>
            </div>
            <button type="button" class="modal-action-btn" id="perm-audit-copy-btn">Copy Markdown</button>
            <button type="button" class="modal-close" id="perm-audit-modal-close" aria-label="Close audit view">✕</button>
          </header>
          <div class="modal-body">
            <div class="perm-feed perm-feed--modal" id="perm-audit-modal-feed" role="log" aria-live="polite" aria-label="Full permission decision audit feed">
              <div class="perm-feed-empty">No permission decisions yet. Waiting for tool calls...</div>
            </div>
          </div>
        </div>
      </dialog>
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
    const auditModal = document.getElementById('perm-audit-modal');
    const closeBtn = document.getElementById('perm-audit-modal-close');
    const copyBtn = document.getElementById('perm-audit-copy-btn');
    if (expandBtn && auditModal) {
      expandBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openAuditModal();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', closeAuditModal);
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyAuditViewAsMarkdown(copyBtn);
      });
    }

    if (auditModal) {
      auditModal.addEventListener('click', function (e) {
        if (e.target === auditModal || e.target.hasAttribute('data-close-audit-modal')) {
          closeAuditModal();
        }
      });
      auditModal.addEventListener('close', function () {
        document.body.classList.remove('modal-open');
      });
      auditModal.addEventListener('cancel', function () {
        document.body.classList.remove('modal-open');
      });
    }
  }

  function openAuditModal() {
    const auditModal = document.getElementById('perm-audit-modal');
    if (!auditModal) return;
    if (typeof auditModal.showModal === 'function') {
      auditModal.showModal();
    } else {
      auditModal.setAttribute('open', '');
    }
    document.body.classList.add('modal-open');
  }

  function closeAuditModal() {
    const auditModal = document.getElementById('perm-audit-modal');
    if (!auditModal) return;
    if (typeof auditModal.close === 'function') {
      auditModal.close();
    } else {
      auditModal.removeAttribute('open');
    }
    document.body.classList.remove('modal-open');
  }

  async function copyAuditViewAsMarkdown(button) {
    const decisions = latestAggregateData?.recentDecisions ?? [];
    const markdown = buildAuditMarkdown(decisions);
    const originalLabel = button.textContent;

    try {
      await copyTextToClipboard(markdown);
      button.textContent = 'Copied!';
      window.setTimeout(function () {
        button.textContent = originalLabel;
      }, 1500);
    } catch {
      button.textContent = 'Copy failed';
      window.setTimeout(function () {
        button.textContent = originalLabel;
      }, 1500);
    }
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error('Clipboard API unavailable');
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

  function dataAdvisoryPlaceholder() {
    return '<span id="perm-all-sessions-advisory" class="perm-inline-advisory" hidden></span>';
  }

  function buildAuditMarkdown(decisions) {
    const lines = [
      '# DollhouseMCP Permissions Audit',
      '',
      `Generated: ${formatExactTimestamp(new Date().toISOString())}`,
      `Entries: ${decisions.length}`,
      'Scope: Aggregate decision log across all sessions',
      '',
    ];

    if (!decisions.length) {
      lines.push('No permission decisions recorded yet.');
      return lines.join('\n');
    }

    decisions.forEach(function (decision, index) {
      const entryLabel = decision.tool_name === 'Bash' && decision.command
        ? `Bash: ${decision.command}`
        : (decision.tool_name || 'Unknown tool');
      lines.push(`## ${index + 1}. ${entryLabel}`);
      lines.push(`- Decision: ${decision.decision || 'unknown'}`);
      lines.push(`- Timestamp: ${formatExactTimestamp(decision.timestamp)}`);

      const compactContext = getCompactContext(decision);
      if (compactContext) {
        lines.push(`- Context: ${compactContext}`);
      }
      if (decision.reason) {
        lines.push(`- Reason: ${decision.reason}`);
      }

      const detailRows = Array.isArray(decision.details) ? decision.details : [];
      if (detailRows.length) {
        lines.push('- Details:');
        detailRows.forEach(function (detail) {
          lines.push(`  - ${detail.label}: ${detail.value}`);
        });
      }

      lines.push('');
    });

    return lines.join('\n');
  }

  function renderInvalidPolicySummary(elementId, elements) {
    const banner = document.getElementById(elementId);
    if (!banner) return;

    const invalid = (elements || []).filter(function (element) {
      return !!element.invalidGatekeeperPolicy;
    });

    if (invalid.length === 0) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }

    const names = invalid.map(function (element) {
      return element.element_name || element.name || 'unknown';
    });
    banner.hidden = false;
    banner.textContent = `${invalid.length} active element${invalid.length === 1 ? '' : 's'} ha${invalid.length === 1 ? 's' : 've'} malformed gatekeeper policy. These elements remain active, but that policy is not being enforced: ${names.join(', ')}`;
  }

})();
