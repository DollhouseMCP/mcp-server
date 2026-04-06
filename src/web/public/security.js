/**
 * Authentication tab for the DollhouseMCP management console (#1791).
 *
 * Panels:
 * - Token: current token display (masked), metadata, rotate button
 * - Authenticator: TOTP enrollment status, enroll/disable flows
 *
 * All API calls use DollhouseAuth.apiFetch() for automatic token injection.
 *
 * @security-audit-suppress DMCP-SEC-004 Client-side JS — all data is
 * pre-normalized server-side. Browser-side NFC normalization applied as
 * defense-in-depth via the esc() helper.
 *
 * @since v2.1.0 — Issue #1791
 */
(function () {
  'use strict';

  /** How often to refresh token/TOTP data from the server. */
  var POLL_INTERVAL_MS = 5000;
  /** Handle for the polling interval so we can clear on destroy. */
  var pollTimer = null;
  /** Whether initSecurity() has been called (prevents double-init). */
  var initialized = false;
  /** Last fetched data — stashed during enrollment so we can re-render after. */
  var lastData = null;
  /** When true, poll() skips rendering to avoid overwriting an in-progress
   *  enrollment flow (QR code, confirm input, backup codes display). */
  var enrollmentInProgress = false;
  /** Debounce flag — prevents rapid double-clicks on action buttons. */
  var actionInProgress = false;

  /** NFC-normalize and HTML-escape a string for safe display. */
  function esc(str) {
    var normalized = String(str).normalize('NFC');
    var div = document.createElement('div');
    div.textContent = normalized;
    return div.innerHTML;
  }

  /** Format an ISO timestamp for display. */
  function formatTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    } catch { return iso; }
  }

  // ── HTML template ─────────────────────────────────────────────────────

  function buildDashboardHTML() {
    var dismissed = false;
    try { dismissed = localStorage.getItem('sec-intro-dismissed') === '1'; } catch { /* no storage */ }

    var intro = dismissed ? '' : ''
      + '<div class="sec-intro" id="sec-intro">'
      +   '<div class="sec-intro-content">'
      +     '<h2 class="sec-intro-title">What is console authentication?</h2>'
      +     '<p>DollhouseMCP\'s management console controls your AI sessions \u2014 it can install MCP configs, '
      +       'approve tool permissions, kill sessions, and read all logs on this machine. '
      +       'Authentication ensures only <strong>you</strong> can do these things.</p>'
      +     '<ul class="sec-intro-list">'
      +       '<li><strong>Console Token</strong> \u2014 a secret key that every API request must carry. '
      +         'Without it, other processes on your machine can\u2019t access the console.</li>'
      +       '<li><strong>Authenticator (TOTP)</strong> \u2014 a second factor from your phone. '
      +         'Even if the token leaks, sensitive operations like rotation still require a 6-digit code '
      +         'from your authenticator app.</li>'
      +     '</ul>'
      +     '<p class="sec-intro-who"><strong>Who needs this?</strong> Shared workstations, multi-user Linux, '
      +       'containers with port mapping, or anyone who wants defense-in-depth beyond localhost binding.</p>'
      +     '<div class="sec-intro-actions">'
      +       '<a class="sec-intro-link" href="https://github.com/DollhouseMCP/mcp-server/blob/main/docs/guides/console-auth.md" '
      +         'target="_blank" rel="noopener">Learn more</a>'
      +       '<button class="sec-btn sec-btn--sm" id="sec-intro-dismiss">Got it, don\u2019t show again</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    return ''
      + intro
      + '<div class="sec-dashboard">'

      // Token panel
      + '<div class="sec-card" data-collapsed="false">'
      +   '<div class="sec-card-header" role="button" tabindex="0" aria-expanded="true">'
      +     '<h3 class="sec-card-title">Console Token</h3>'
      +     '<span class="sec-card-toggle" aria-hidden="true">&#9662;</span>'
      +   '</div>'
      +   '<div class="sec-card-body">'
      +     '<div id="sec-token-content">Loading...</div>'
      +   '</div>'
      + '</div>'

      // Authenticator panel
      + '<div class="sec-card" data-collapsed="false">'
      +   '<div class="sec-card-header" role="button" tabindex="0" aria-expanded="true">'
      +     '<h3 class="sec-card-title">Authenticator (TOTP)</h3>'
      +     '<span class="sec-card-toggle" aria-hidden="true">&#9662;</span>'
      +   '</div>'
      +   '<div class="sec-card-body">'
      +     '<div id="sec-totp-content">Loading...</div>'
      +   '</div>'
      + '</div>'

      + '</div>';
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  function renderTokenPanel(data) {
    var el = document.getElementById('sec-token-content');
    if (!el || !data.tokens || !data.tokens.length) {
      if (el) el.textContent = 'No token data available.';
      return;
    }
    var t = data.tokens[0];
    var tokenDisplay = '<code class="sec-token-value">' + esc(t.tokenPreview) + '</code>';

    el.innerHTML = ''
      + '<div class="sec-token-row">'
      +   '<span class="sec-label">Token</span>'
      +   tokenDisplay
      +   '<button class="sec-btn sec-btn--sm" id="sec-copy-token" title="Copy token to clipboard">Copy</button>'
      +   '<button class="sec-btn sec-btn--sm" id="sec-copy-curl" title="Copy as curl command">Copy curl</button>'
      + '</div>'
      + '<div class="sec-meta-grid">'
      +   '<div class="sec-meta"><span class="sec-label">Name</span> ' + esc(t.name) + '</div>'
      +   '<div class="sec-meta"><span class="sec-label">ID</span> <code>' + esc(t.id) + '</code></div>'
      +   '<div class="sec-meta"><span class="sec-label">Kind</span> ' + esc(t.kind) + '</div>'
      +   '<div class="sec-meta"><span class="sec-label">Created</span> ' + esc(formatTime(t.createdAt)) + '</div>'
      +   '<div class="sec-meta"><span class="sec-label">Last used</span> ' + esc(formatTime(t.lastUsedAt)) + '</div>'
      +   '<div class="sec-meta"><span class="sec-label">Created via</span> ' + esc(t.createdVia) + '</div>'
      +   '<div class="sec-meta"><span class="sec-label">File</span> <code>' + esc(data.filePath) + '</code></div>'
      + '</div>'
      + '<div class="sec-actions">'
      +   '<button class="sec-btn sec-btn--danger" id="sec-rotate-btn"'
      +     (data.totp.enrolled ? '' : ' disabled title="Enroll TOTP first"')
      +   '>Rotate Token</button>'
      + '</div>';

    // Copy token — uses the live token from DollhouseAuth (already in browser memory)
    var copyBtn = document.getElementById('sec-copy-token');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var liveToken = DollhouseAuth.token;
        if (!liveToken) {
          alert('No token available — authentication may be disabled.');
          return;
        }
        navigator.clipboard.writeText(liveToken)
          .then(function () { copyBtn.textContent = 'Copied!'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500); })
          .catch(function () { alert('Failed to copy — check clipboard permissions'); });
      });
    }

    // Copy as curl — includes live token for a runnable command
    var curlBtn = document.getElementById('sec-copy-curl');
    if (curlBtn) {
      curlBtn.addEventListener('click', function () {
        var liveToken = DollhouseAuth.token || '<TOKEN>';
        var port = location.port || '5907';
        var curl = 'curl -H "Authorization: Bearer ' + liveToken + '" http://localhost:' + port + '/api/elements';
        navigator.clipboard.writeText(curl)
          .then(function () { curlBtn.textContent = 'Copied!'; setTimeout(function () { curlBtn.textContent = 'Copy curl'; }, 1500); })
          .catch(function () { alert('Failed to copy — check clipboard permissions'); });
      });
    }

    // Rotate button
    var rotateBtn = document.getElementById('sec-rotate-btn');
    if (rotateBtn && !rotateBtn.disabled) {
      rotateBtn.addEventListener('click', handleRotate);
    }
  }

  function renderTotpPanel(data) {
    var el = document.getElementById('sec-totp-content');
    if (!el) return;
    var totp = data.totp;

    if (totp.enrolled) {
      el.innerHTML = ''
        + '<div class="sec-totp-status sec-totp-status--enrolled">'
        +   '<span class="sec-status-dot sec-status-dot--green"></span>'
        +   '<strong>Enrolled</strong>'
        +   '<span class="sec-meta-inline">since ' + esc(formatTime(totp.enrolledAt)) + '</span>'
        + '</div>'
        + '<div class="sec-meta">'
        +   '<span class="sec-label">Backup codes remaining</span> '
        +   '<strong>' + esc(String(totp.backupCodesRemaining)) + '</strong> of 10'
        + '</div>'
        + '<div class="sec-actions">'
        +   '<button class="sec-btn sec-btn--danger" id="sec-totp-disable">Disable TOTP</button>'
        + '</div>';

      var disableBtn = document.getElementById('sec-totp-disable');
      if (disableBtn) disableBtn.addEventListener('click', handleDisableTotp);
    } else {
      el.innerHTML = ''
        + '<div class="sec-totp-status sec-totp-status--not-enrolled">'
        +   '<span class="sec-status-dot sec-status-dot--amber"></span>'
        +   '<strong>Not enrolled</strong>'
        + '</div>'
        + '<p class="sec-hint">Enroll an authenticator app to enable token rotation and other privileged operations.</p>'
        + '<div class="sec-actions">'
        +   '<button class="sec-btn sec-btn--primary" id="sec-totp-enroll">Enroll Authenticator</button>'
        + '</div>';

      var enrollBtn = document.getElementById('sec-totp-enroll');
      if (enrollBtn) enrollBtn.addEventListener('click', handleEnrollTotp);
    }
  }

  function render(data) {
    lastData = data;
    renderTokenPanel(data);
    renderTotpPanel(data);
  }

  // ── Actions ───────────────────────────────────────────────────────────

  /** Prompt for TOTP code and rotate the primary token. */
  function handleRotate() {
    if (actionInProgress) return;
    var code = prompt('Enter your TOTP code to rotate the token:');
    if (!code) return;
    actionInProgress = true;
    DollhouseAuth.apiFetch('/api/console/token/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationCode: code.trim() }),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        actionInProgress = false;
        if (result.ok) {
          DollhouseAuth.refresh(result.body.token);
          alert('Token rotated successfully. The new token is now active.');
          poll();
        } else {
          alert('Rotation failed: ' + (result.body.error || 'Unknown error'));
        }
      })
      .catch(function (err) { actionInProgress = false; alert('Rotation failed: ' + (err.message || 'network error')); });
  }

  /** Start the TOTP enrollment flow — show QR code, confirm, display backup codes. */
  function handleEnrollTotp() {
    if (actionInProgress) return;
    actionInProgress = true;
    DollhouseAuth.apiFetch('/api/console/totp/enroll/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        actionInProgress = false;
        if (!result.ok) {
          alert('Enrollment failed: ' + (result.body.error || 'Unknown error'));
          return;
        }
        enrollmentInProgress = true;
        var begin = result.body;
        // Show QR code and secret in a panel
        var totpEl = document.getElementById('sec-totp-content');
        if (!totpEl) return;
        totpEl.innerHTML = ''
          + '<div class="sec-enroll-flow">'
          +   '<h4>Scan this QR code with your authenticator app</h4>'
          +   '<div class="sec-qr-container">'
          +     '<img src="' + begin.qrSvgDataUrl + '" alt="TOTP QR code" class="sec-qr-img" />'
          +   '</div>'
          +   '<p class="sec-hint">Or enter this secret manually: <code>' + esc(begin.secret) + '</code></p>'
          +   '<div class="sec-confirm-form">'
          +     '<label for="sec-confirm-code">Enter the 6-digit code from your app:</label>'
          +     '<input type="text" id="sec-confirm-code" maxlength="6" pattern="[0-9]{6}" '
          +       'placeholder="000000" autocomplete="one-time-code" class="sec-input" />'
          +     '<button class="sec-btn sec-btn--primary" id="sec-confirm-enroll">Confirm</button>'
          +     '<button class="sec-btn" id="sec-cancel-enroll">Cancel</button>'
          +   '</div>'
          + '</div>';

        document.getElementById('sec-cancel-enroll').addEventListener('click', function () { enrollmentInProgress = false; poll(); });
        document.getElementById('sec-confirm-enroll').addEventListener('click', function () {
          var code = document.getElementById('sec-confirm-code').value.trim();
          if (!code) return;
          DollhouseAuth.apiFetch('/api/console/totp/enroll/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingId: begin.pendingId, code: code }),
          })
            .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
            .then(function (confirmResult) {
              if (confirmResult.ok) {
                // Show backup codes
                totpEl.innerHTML = ''
                  + '<div class="sec-backup-codes">'
                  +   '<h4>Backup Codes</h4>'
                  +   '<p class="sec-hint sec-hint--warn">Save these codes — you will never see them again.</p>'
                  +   '<div class="sec-codes-grid">'
                  +     confirmResult.body.backupCodes.map(function (c) {
                          return '<code class="sec-code">' + esc(c) + '</code>';
                        }).join('')
                  +   '</div>'
                  +   '<button class="sec-btn sec-btn--primary" id="sec-codes-done">I\'ve saved my codes</button>'
                  + '</div>';
                document.getElementById('sec-codes-done').addEventListener('click', function () { enrollmentInProgress = false; poll(); });
              } else {
                alert('Confirmation failed: ' + (confirmResult.body.error || 'Invalid code'));
                // Keep enrollmentInProgress true — user can retry the code
              }
            })
            .catch(function (err) { alert('Confirmation failed: ' + (err.message || 'network error')); });
        });
      })
      .catch(function (err) { actionInProgress = false; alert('Enrollment failed: ' + (err.message || 'network error')); });
  }

  /** Disable TOTP enrollment after code confirmation. */
  function handleDisableTotp() {
    if (actionInProgress) return;
    var code = prompt('Enter your TOTP code (or backup code) to disable TOTP:');
    if (!code) return;
    actionInProgress = true;
    DollhouseAuth.apiFetch('/api/console/totp/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        actionInProgress = false;
        if (result.ok) {
          alert('TOTP disabled. Token rotation now requires re-enrollment.');
          poll();
        } else {
          alert('Disable failed: ' + (result.body.error || 'Unknown error'));
        }
      })
      .catch(function (err) { actionInProgress = false; alert('Disable failed: ' + (err.message || 'network error')); });
  }

  // ── Polling & lifecycle ───────────────────────────────────────────────

  /** Fetch token info and re-render panels (skipped during enrollment flow). */
  function poll() {
    DollhouseAuth.apiFetch('/api/console/token/info')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!enrollmentInProgress) render(data);
        else lastData = data; // stash for when enrollment completes
      })
      .catch(function (err) {
        // Clear stale panel content so the user doesn't see outdated data
        // alongside the error message.
        var tokenEl = document.getElementById('sec-token-content');
        var totpEl = document.getElementById('sec-totp-content');
        if (tokenEl) tokenEl.innerHTML = '';
        if (totpEl) totpEl.innerHTML = '';
        var root = document.getElementById('security-dashboard-root');
        if (root && !document.querySelector('.sec-card')) {
          // Dashboard not yet built — show error in root
          root.innerHTML = '<p class="sec-error">Failed to load authentication data: ' + esc(err.message) + '</p>';
        }
      });
  }

  function attachCardToggles() {
    document.querySelectorAll('.sec-card-header').forEach(function (header) {
      var toggle = function () {
        var card = header.parentElement;
        var collapsed = card.dataset.collapsed === 'true';
        card.dataset.collapsed = collapsed ? 'false' : 'true';
        header.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  function initSecurity() {
    if (initialized) return;
    initialized = true;
    var root = document.getElementById('security-dashboard-root');
    if (!root) return;
    root.innerHTML = buildDashboardHTML();
    attachCardToggles();
    // Intro dismiss button
    var dismissBtn = document.getElementById('sec-intro-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        var intro = document.getElementById('sec-intro');
        if (intro) intro.remove();
        try { localStorage.setItem('sec-intro-dismissed', '1'); } catch { /* no storage */ }
      });
    }
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function destroySecurity() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    initialized = false;
  }

  // ── Public API ────────────────────────────────────────────────────────

  window.DollhouseConsole = window.DollhouseConsole || {};
  window.DollhouseConsole.security = {
    init: initSecurity,
    destroy: destroySecurity,
    refresh: function () { poll(); },
  };
})();
