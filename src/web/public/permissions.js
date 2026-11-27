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
  const AUTHORITY_MODE_REQUEST_STATES = {
    idle: 'idle',
    saving: 'saving',
  };
  const AUTHORITY_AUTHORITATIVE_HOSTS = new Set(['claude-code']);
  // Authority modes are intentionally phrased in human terms in the UI:
  // - off => host-controlled permissions
  // - shared => both Dollhouse and the host participate
  // - authoritative => Dollhouse is the source of truth
  const authorityUiState = {
    selectedHost: 'claude-code',
    selectedMode: 'shared',
    draftReason: '',
    dirty: false,
    requestState: AUTHORITY_MODE_REQUEST_STATES.idle,
    feedback: '',
    feedbackKind: 'info',
  };
  const AUTHORITY_HOST_META = {
    'claude-code': { label: 'Claude Code', shortLabel: 'CC', tone: 'claude' },
    'codex': { label: 'Codex', shortLabel: 'CX', tone: 'codex' },
    'cursor': { label: 'Cursor', shortLabel: 'CU', tone: 'cursor' },
    'vscode': { label: 'VS Code', shortLabel: 'VS', tone: 'vscode' },
    'windsurf': { label: 'Windsurf', shortLabel: 'WS', tone: 'windsurf' },
    'gemini': { label: 'Gemini CLI', shortLabel: 'GM', tone: 'gemini' },
    'cline': { label: 'Cline', shortLabel: 'CL', tone: 'cline' },
    'lmstudio': { label: 'LM Studio', shortLabel: 'LM', tone: 'lmstudio' },
  };

  async function fetchPermissionStatus(sessionId) {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const res = await DollhouseAuth.apiFetch(`/api/permissions/status${query}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function updatePermissionAuthority(payload) {
    const res = await DollhouseAuth.apiFetch('/api/permissions/authority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
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
        if (!btn || btn.dataset.tab !== 'permissions') {
          return;
        }

        const dc = window.DollhouseConsole;
        if (!dc || !dc.permissions) {
          return;
        }

        if (!initialized) {
          dc.permissions.init();
          return;
        }

        if (dc.permissions.refresh) {
          dc.permissions.refresh();
        }
      });
    }

    window.addEventListener('dollhouse:policy-debug-visibility-changed', function () {
      if (initialized) {
        renderFromCache();
      }
    });
  });

  // ── Initialization ─────────────────────────────────────────

  function initPermissions() {
    if (initialized) return;
    initialized = true;

    const root = document.getElementById('permissions-dashboard-root');
    if (!root) return;

    root.innerHTML = buildDashboardHTML();
    attachCardToggles();
    attachAuthorityControls();
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

      const visibleAggregateData = getVisibleAggregateData(aggregateData);
      const currentSessionId = window.DollhouseSessions?.getFilterSessionId?.() || '';
      const selectedData = deriveSelectedSessionData(visibleAggregateData, currentSessionId);

      latestAggregateData = aggregateData;
      latestSelectedData = selectedData;
      window.DollhouseSessions?.setPolicySessions?.(aggregateData.knownSessions || []);
      render(visibleAggregateData, selectedData);
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
    const visibleAggregateData = getVisibleAggregateData(latestAggregateData);
    latestSelectedData = deriveSelectedSessionData(visibleAggregateData, sessionId);
    render(visibleAggregateData, latestSelectedData);
  }

  // ── Rendering ──────────────────────────────────────────────

  function render(data, selectedData) {
    renderStatusBar(data);
    renderAuthorityMode(data);
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
      } else if (data.hookNeedsRepair) {
        hookDot.dataset.status = 'warning';
        hookLabel.textContent = data.hookHost
          ? `Hook needs repair (${data.hookHost})`
          : 'Hook needs repair';
      } else if (data.hookAutoRepaired) {
        hookDot.dataset.status = 'active';
        hookLabel.textContent = data.hookHost
          ? `Hook refreshed (${data.hookHost})`
          : 'Hook refreshed';
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

  function renderAuthorityMode(data) {
    const card = document.getElementById('perm-authority-card');
    const saveButton = document.getElementById('perm-authority-save-btn');
    const message = document.getElementById('perm-authority-message');
    const currentHostList = document.getElementById('perm-authority-current-host-list');
    const selectedHostHeading = document.getElementById('perm-authority-selected-host');
    const reasonInput = document.getElementById('perm-authority-reason');
    const note = document.getElementById('perm-authority-note');
    const authoritativeNote = document.getElementById('perm-authority-authoritative-note');
    const dirtyState = document.getElementById('perm-authority-dirty-state');
    const saveCopy = document.getElementById('perm-authority-save-copy');
    const saveShell = document.getElementById('perm-authority-save-shell');

    if (!card || !saveButton || !message || !currentHostList || !selectedHostHeading || !reasonInput || !note || !authoritativeNote || !dirtyState || !saveCopy || !saveShell) {
      return;
    }

    const supportedHosts = Array.isArray(data?.authoritySupportedHosts)
      ? data.authoritySupportedHosts
      : ['claude-code'];
    const authority = data?.authority || { defaultMode: 'shared', hosts: {} };

    if (supportedHosts.length === 0) {
      currentHostList.innerHTML = '<div class="perm-pattern-empty">No installed permission hosts detected yet.</div>';
      selectedHostHeading.textContent = 'No installed hosts';
      note.textContent = 'Install Dollhouse permission hooks for a host before changing permission authority mode here.';
      authoritativeNote.hidden = true;
      authoritativeNote.textContent = '';
      dirtyState.hidden = true;
      dirtyState.textContent = '';
      message.hidden = true;
      message.textContent = '';
      message.dataset.kind = 'info';
      saveCopy.textContent = 'Once a host is installed and configured, it will appear on the left for editing.';
      saveShell.dataset.dirty = 'false';
      saveShell.dataset.busy = 'false';
      card.dataset.authorityDirty = 'false';
      card.setAttribute('aria-busy', 'false');
      reasonInput.value = authorityUiState.draftReason;
      setAuthorityRadioState('perm-authority-mode-off', false, true);
      setAuthorityRadioState('perm-authority-mode-shared', false, true);
      setAuthorityRadioState('perm-authority-mode-authoritative', false, true);
      saveButton.disabled = true;
      saveButton.textContent = 'No Installed Hosts Yet';
      saveButton.setAttribute('aria-busy', 'false');
      card.hidden = false;
      return;
    }

    if (!supportedHosts.includes(authorityUiState.selectedHost)) {
      authorityUiState.selectedHost = supportedHosts[0];
      authorityUiState.dirty = false;
    }

    const serverMode = getAuthorityModeForHost(authority, authorityUiState.selectedHost);
    if (!authorityUiState.dirty) {
      authorityUiState.selectedMode = serverMode;
    }

    reasonInput.value = authorityUiState.draftReason;

    const authoritativeSupported = AUTHORITY_AUTHORITATIVE_HOSTS.has(authorityUiState.selectedHost);
    const desiredMode = authoritativeSupported ? authorityUiState.selectedMode : fallbackAuthorityMode(authorityUiState.selectedMode);
    const dirty = desiredMode !== serverMode;

    setAuthorityRadioState('perm-authority-mode-off', desiredMode === 'off', false);
    setAuthorityRadioState('perm-authority-mode-shared', desiredMode === 'shared', false);
    setAuthorityRadioState('perm-authority-mode-authoritative', desiredMode === 'authoritative', !authoritativeSupported);

    currentHostList.innerHTML = renderAuthorityCurrentHostList(authority, supportedHosts, authorityUiState.selectedHost);
    selectedHostHeading.textContent = formatAuthorityHost(authorityUiState.selectedHost);
    note.textContent = 'Human-only control. AI can read authority mode but cannot change it through MCP.';
    authoritativeNote.hidden = authoritativeSupported;
    authoritativeNote.textContent = authoritativeSupported
      ? ''
      : 'Claude Code only for now. Other hosts can use Host-Controlled or Shared Permissioning mode.';
    dirtyState.hidden = !dirty;
    dirtyState.textContent = dirty
      ? `Unsaved change: ${formatAuthorityHost(authorityUiState.selectedHost)} will move from ${formatAuthorityMode(serverMode)} to ${formatAuthorityMode(desiredMode)} after you save.`
      : '';
    saveCopy.textContent = buildAuthoritySaveCopy({
      host: authorityUiState.selectedHost,
      currentMode: serverMode,
      desiredMode,
      dirty,
      saving: authorityUiState.requestState === AUTHORITY_MODE_REQUEST_STATES.saving,
    });
    saveShell.dataset.dirty = dirty ? 'true' : 'false';
    saveShell.dataset.busy = authorityUiState.requestState === AUTHORITY_MODE_REQUEST_STATES.saving ? 'true' : 'false';
    card.dataset.authorityDirty = dirty ? 'true' : 'false';
    card.setAttribute('aria-busy', authorityUiState.requestState === AUTHORITY_MODE_REQUEST_STATES.saving ? 'true' : 'false');

    if (authorityUiState.feedback) {
      message.hidden = false;
      message.textContent = authorityUiState.feedback;
      message.dataset.kind = authorityUiState.feedbackKind;
    } else {
      message.hidden = true;
      message.textContent = '';
      message.dataset.kind = 'info';
    }

    saveButton.disabled = authorityUiState.requestState === AUTHORITY_MODE_REQUEST_STATES.saving || !dirty;
    saveButton.textContent = authorityUiState.requestState === AUTHORITY_MODE_REQUEST_STATES.saving
      ? `Saving ${formatAuthorityMode(desiredMode)}...`
      : dirty
        ? `Save ${formatAuthorityMode(desiredMode)} Mode for ${formatAuthorityHost(authorityUiState.selectedHost)}`
        : `Saved for ${formatAuthorityHost(authorityUiState.selectedHost)}`;
    saveButton.dataset.dirty = dirty ? 'true' : 'false';
    saveButton.setAttribute('aria-busy', authorityUiState.requestState === AUTHORITY_MODE_REQUEST_STATES.saving ? 'true' : 'false');
    card.hidden = false;
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

  /**
   * Persisted policy state rows are primarily a debugging aid, so the
   * dashboard treats them as opt-in and mirrors the explicit sessions UI flag.
   */
  function shouldShowPersistedPolicyDebug() {
    return window.DollhouseSessions?.isPolicyDebugVisible?.() === true;
  }

  function getVisibleAggregateData(data) {
    if (!data || shouldShowPersistedPolicyDebug()) {
      return data;
    }

    const hiddenPolicySessions = Array.isArray(data.knownSessions) ? data.knownSessions : [];
    if (hiddenPolicySessions.length === 0) {
      return data;
    }

    const hiddenPolicySessionIds = new Set(
      hiddenPolicySessions
        .map(function (session) { return session && typeof session.sessionId === 'string' ? session.sessionId : ''; })
        .filter(Boolean),
    );

    const filteredElements = ((data.elements || []).filter(function (element) {
      const sessionIds = Array.isArray(element?.sessionIds) ? element.sessionIds.filter(function (sessionId) {
        return typeof sessionId === 'string' && sessionId !== '';
      }) : [];
      if (sessionIds.length === 0) {
        return true;
      }
      return sessionIds.some(function (sessionId) {
        return !hiddenPolicySessionIds.has(sessionId);
      });
    }));

    return {
      ...data,
      activeElementCount: filteredElements.length,
      hasAllowlist: filteredElements.some(function (element) {
        return (Array.isArray(element.allowRules) && element.allowRules.length > 0)
          || (Array.isArray(element.allowPatterns) && element.allowPatterns.length > 0);
      }),
      elements: filteredElements,
      knownSessions: [],
      denyPatterns: flattenElementPatterns(filteredElements, 'denyPatterns'),
      allowPatterns: flattenElementPatterns(filteredElements, 'allowPatterns'),
      confirmPatterns: flattenElementPatterns(filteredElements, 'confirmPatterns'),
      denyRules: flattenElementPatterns(filteredElements, 'denyRules'),
      allowRules: flattenElementPatterns(filteredElements, 'allowRules'),
      confirmRules: flattenElementPatterns(filteredElements, 'confirmRules'),
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

        <div class="perm-card perm-card--full" data-collapsed="false" id="perm-authority-card">
          <div class="perm-card-header" role="button" tabindex="0" aria-expanded="true">
            <h3 class="perm-card-title">Permission Authority Mode</h3>
            <span class="perm-card-toggle" aria-hidden="true">&#9662;</span>
          </div>
          <div class="perm-card-body">
            <div class="perm-selected-header perm-selected-header--compact">
              <div>
                <div class="perm-selected-title">Human-Only Permission Authority</div>
                <div class="perm-selected-subtitle">Choose whether the host's native permission system or DollhouseMCP is the final authority for tool approvals.</div>
              </div>
            </div>

            <div class="perm-selected-grid">
              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Current Permission State</h4>
                <div class="perm-authority-current-list" id="perm-authority-current-host-list"></div>
              </div>

              <div class="perm-selected-panel">
                <h4 class="perm-selected-panel-title">Change Permission Mode</h4>
                <div class="perm-authority-selected-host" id="perm-authority-selected-host">Claude Code</div>
                <div class="perm-selected-subtitle">Choose how this host should handle permission decisions.</div>

                <div class="perm-authority-options" role="radiogroup" aria-label="Authority mode">
                  <label class="perm-authority-option" id="perm-authority-option-off">
                    <span class="perm-authority-option-main">
                      <input type="radio" name="perm-authority-mode" id="perm-authority-mode-off" value="off">
                      <span class="perm-authority-option-copy">
                        <span class="perm-authority-option-title">Host-Controlled Permissions</span>
                        <span class="perm-authority-option-description">Dollhouse steps out of the way. The host's own permission system handles approvals by itself.</span>
                      </span>
                    </span>
                  </label>
                  <label class="perm-authority-option" id="perm-authority-option-shared">
                    <span class="perm-authority-option-main">
                      <input type="radio" name="perm-authority-mode" id="perm-authority-mode-shared" value="shared">
                      <span class="perm-authority-option-copy">
                        <span class="perm-authority-option-title">Shared Permissioning</span>
                        <span class="perm-authority-option-description">Dollhouse stays active, but the host permission system can still be more restrictive.</span>
                      </span>
                    </span>
                  </label>
                  <label class="perm-authority-option perm-authority-option--authoritative" id="perm-authority-option-authoritative">
                    <span class="perm-authority-option-main">
                      <input type="radio" name="perm-authority-mode" id="perm-authority-mode-authoritative" value="authoritative">
                      <span class="perm-authority-option-copy">
                        <span class="perm-authority-option-title-row">
                          <span class="perm-authority-option-title">Dollhouse-Controlled Permissions</span>
                          <span class="perm-authority-inline-note" id="perm-authority-authoritative-note" hidden></span>
                        </span>
                        <span class="perm-authority-option-description">Dollhouse becomes the permission authority. It syncs Dollhouse allow, ask, and deny rules into the host so Dollhouse decides conflicts instead of the host's own approval flow.</span>
                      </span>
                    </span>
                  </label>
                </div>

                <label class="perm-selected-subtitle perm-authority-field-label" for="perm-authority-reason">Reason (optional)</label>
                <input id="perm-authority-reason" class="perm-authority-reason-input" type="text" maxlength="200" placeholder="Why are you changing the permission authority mode?">

                <p class="perm-selected-subtitle perm-authority-human-note" id="perm-authority-note"></p>
                <div class="perm-authority-save-shell" id="perm-authority-save-shell" data-dirty="false">
                  <div class="perm-authority-dirty-state" id="perm-authority-dirty-state" hidden></div>
                  <div class="perm-inline-warning" id="perm-authority-message" hidden></div>
                  <div class="perm-authority-actions">
                    <div class="perm-authority-save-copy" id="perm-authority-save-copy"></div>
                    <button type="button" class="perm-panel-action perm-authority-save-btn" id="perm-authority-save-btn">Save Authority Mode</button>
                  </div>
                </div>
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
            <div class="modal-header-actions">
              <button type="button" class="modal-action-btn" id="perm-audit-copy-btn">Copy Markdown</button>
              <button type="button" class="modal-close" id="perm-audit-modal-close" aria-label="Close audit view">✕</button>
            </div>
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

  function attachAuthorityControls() {
    const currentHostList = document.getElementById('perm-authority-current-host-list');
    const reasonInput = document.getElementById('perm-authority-reason');
    const saveButton = document.getElementById('perm-authority-save-btn');

    if (currentHostList) {
      currentHostList.addEventListener('click', function (event) {
        const row = event.target.closest('.perm-authority-current-host[data-host]');
        if (!row) {
          return;
        }
        const host = row.getAttribute('data-host');
        if (!host || host === authorityUiState.selectedHost) {
          return;
        }
        authorityUiState.selectedHost = host;
        authorityUiState.feedback = '';
        authorityUiState.feedbackKind = 'info';
        authorityUiState.dirty = false;
        renderAuthorityMode(latestAggregateData);
      });
    }

    document.querySelectorAll('input[name="perm-authority-mode"]').forEach(function (input) {
      input.addEventListener('change', function (event) {
        authorityUiState.selectedMode = event.target.value;
        authorityUiState.feedback = '';
        authorityUiState.feedbackKind = 'info';
        authorityUiState.dirty = true;
        renderAuthorityMode(latestAggregateData);
      });
    });

    if (reasonInput) {
      reasonInput.addEventListener('input', function (event) {
        authorityUiState.draftReason = event.target.value;
      });
    }

    if (saveButton) {
      saveButton.addEventListener('click', function () {
        saveAuthorityMode();
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
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to the user-gesture fallback below. Some embedded browsers
        // expose the clipboard API but still reject writes in modal contexts.
      }
    }

    copyTextWithSelectionFallback(text);
  }

  function copyTextWithSelectionFallback(text) {
    const textarea = document.createElement('textarea');
    let handled = false;

    function handleCopy(event) {
      if (!event.clipboardData) {
        return;
      }
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      handled = true;
    }

    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    document.addEventListener('copy', handleCopy, true);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    try {
      if (!document.execCommand || !document.execCommand('copy') || !handled) {
        throw new Error('Clipboard copy command unavailable');
      }
    } finally {
      document.removeEventListener('copy', handleCopy, true);
      textarea.remove();
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

  function getAuthorityModeForHost(authority, host) {
    return authority?.hosts?.[host]?.mode || authority?.defaultMode || 'shared';
  }

  function formatAuthorityHost(host) {
    const meta = AUTHORITY_HOST_META[String(host || '')];
    if (meta?.label) {
      return meta.label;
    }
    return String(host || '')
      .split('-')
      .map(function (part) { return part ? part.charAt(0).toUpperCase() + part.slice(1) : part; })
      .join(' ');
  }

  function formatAuthorityMode(mode) {
    return mode === 'off'
      ? 'Host-Controlled Permissions'
      : mode === 'authoritative'
        ? 'Dollhouse-Controlled Permissions'
        : 'Shared Permissioning';
  }

  function buildAuthorityExplanation(mode, authoritativeSupported) {
    if (mode === 'off') {
      return 'Dollhouse is not participating in approvals here. The host handles permissions on its own.';
    }
    if (mode === 'authoritative') {
      return 'Dollhouse is the source of truth for permissions here. The host follows Dollhouse-synced allow, ask, and deny rules, while user-authored entries outside Dollhouse-managed settings are still preserved.';
    }
    return authoritativeSupported
      ? 'Dollhouse participates in permission checks, but the host can still be more restrictive.'
      : 'This host currently supports shared/advisory mode while authoritative settings sync is still being added.';
  }

  function fallbackAuthorityMode(mode) {
    return mode === 'authoritative' ? 'shared' : mode;
  }

  function setAuthorityRadioState(id, checked, disabled) {
    const radio = document.getElementById(id);
    if (!radio) return;
    radio.checked = checked;
    radio.disabled = disabled;
    const option = radio.closest('.perm-authority-option');
    if (option) {
      option.dataset.checked = checked ? 'true' : 'false';
      option.dataset.disabled = disabled ? 'true' : 'false';
    }
  }

  function buildAuthoritySaveCopy(state) {
    if (state.saving) {
      return `Applying ${formatAuthorityMode(state.desiredMode)} mode for ${formatAuthorityHost(state.host)}...`;
    }
    if (state.dirty) {
      return `Review the change and save to apply ${formatAuthorityMode(state.desiredMode)} mode for ${formatAuthorityHost(state.host)}.`;
    }
    return `${formatAuthorityHost(state.host)} is currently saved in ${formatAuthorityMode(state.currentMode)} mode.`;
  }

  function renderAuthorityCurrentHostList(authority, supportedHosts, selectedHost) {
    const explicitHosts = Object.keys(authority?.hosts || {});
    const hostIds = Array.from(new Set(explicitHosts.concat(supportedHosts || [])));
    const orderedHosts = hostIds.sort(function (left, right) {
      return formatAuthorityHost(left).localeCompare(formatAuthorityHost(right));
    });

    if (orderedHosts.length === 0) {
      return '<div class="perm-pattern-empty">No host authority settings saved yet.</div>';
    }

    return orderedHosts.map(function (host) {
      const mode = getAuthorityModeForHost(authority, host);
      const meta = AUTHORITY_HOST_META[host] || { shortLabel: formatAuthorityHost(host).slice(0, 2).toUpperCase(), tone: 'generic' };
      const selectedAttr = host === selectedHost ? 'true' : 'false';
      return `
        <button type="button" class="perm-authority-current-host" data-selected="${selectedAttr}" data-host="${esc(host)}" aria-pressed="${selectedAttr}">
          <span class="perm-authority-host-mark perm-authority-host-mark--${esc(meta.tone || 'generic')}" aria-hidden="true">${esc(meta.shortLabel || 'DH')}</span>
          <span class="perm-authority-current-host-copy">
            <span class="perm-authority-current-host-name">${esc(formatAuthorityHost(host))}</span>
            <span class="perm-authority-current-host-mode">${esc(formatAuthorityMode(mode))}</span>
          </span>
        </button>
      `;
    }).join('');
  }

  async function saveAuthorityMode() {
    if (!latestAggregateData || authorityUiState.requestState === AUTHORITY_MODE_REQUEST_STATES.saving) {
      return;
    }

    const authority = latestAggregateData.authority || { defaultMode: 'shared', hosts: {} };
    const currentMode = getAuthorityModeForHost(authority, authorityUiState.selectedHost);
    const requestedMode = AUTHORITY_AUTHORITATIVE_HOSTS.has(authorityUiState.selectedHost)
      ? authorityUiState.selectedMode
      : fallbackAuthorityMode(authorityUiState.selectedMode);

    if (requestedMode === currentMode) {
      authorityUiState.feedback = 'No authority-mode change to save.';
      authorityUiState.feedbackKind = 'info';
      renderAuthorityMode(latestAggregateData);
      return;
    }

    const confirmMessage = [
      `Change ${formatAuthorityHost(authorityUiState.selectedHost)} from ${formatAuthorityMode(currentMode)} to ${formatAuthorityMode(requestedMode)}?`,
      '',
      requestedMode === 'authoritative'
        ? 'Dollhouse will take a backup and write managed host permission settings.'
        : requestedMode === 'off'
          ? 'Dollhouse hooks will no-op and the host permission system will become the only gate.'
          : 'Dollhouse will stay active, but the host will remain authoritative on conflicts.',
    ].join('\n');

    if (!window.confirm(confirmMessage)) {
      return;
    }

    authorityUiState.requestState = AUTHORITY_MODE_REQUEST_STATES.saving;
    authorityUiState.feedback = '';
    renderAuthorityMode(latestAggregateData);

    try {
      const response = await updatePermissionAuthority({
        host: authorityUiState.selectedHost,
        mode: requestedMode,
        reason: authorityUiState.draftReason.trim() || undefined,
      });

      latestAggregateData = {
        ...latestAggregateData,
        authority: response.authority,
      };
      authorityUiState.selectedMode = requestedMode;
      authorityUiState.dirty = false;
      authorityUiState.feedback = `Saved ${formatAuthorityMode(requestedMode)} mode for ${formatAuthorityHost(authorityUiState.selectedHost)}.`;
      authorityUiState.feedbackKind = 'success';
    } catch (error) {
      authorityUiState.feedback = error instanceof Error ? error.message : 'Failed to update permission authority.';
      authorityUiState.feedbackKind = 'error';
    } finally {
      authorityUiState.requestState = AUTHORITY_MODE_REQUEST_STATES.idle;
      renderAuthorityMode(latestAggregateData);
    }
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
