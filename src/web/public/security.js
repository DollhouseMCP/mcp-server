/**
 * Security tab for the DollhouseMCP management console (#1791).
 *
 * Panels:
 * - Token: current token display (masked), metadata, rotate button
 * - Authenticator: TOTP enrollment status, enroll/disable flows
 * - Recent activity: SecurityMonitor event timeline
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

  var POLL_INTERVAL_MS = 5000;
  var pollTimer = null;
  var initialized = false;
  var lastData = null;

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
    return ''
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

      // Recent activity panel (full width)
      + '<div class="sec-card sec-card--wide" data-collapsed="false">'
      +   '<div class="sec-card-header" role="button" tabindex="0" aria-expanded="true">'
      +     '<h3 class="sec-card-title">Recent Security Events</h3>'
      +     '<span class="sec-card-toggle" aria-hidden="true">&#9662;</span>'
      +   '</div>'
      +   '<div class="sec-card-body">'
      +     '<div id="sec-events-content">Loading...</div>'
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
    var revealed = el.dataset.revealed === 'true';
    var tokenDisplay = revealed
      ? '<code class="sec-token-value">' + esc(t.tokenPreview.replace(/•/g, '')) + '...</code>'
      : '<code class="sec-token-value">' + esc(t.tokenPreview) + '</code>';

    el.innerHTML = ''
      + '<div class="sec-token-row">'
      +   '<span class="sec-label">Token</span>'
      +   tokenDisplay
      +   '<button class="sec-btn sec-btn--sm" id="sec-copy-token" title="Copy full token to clipboard">Copy</button>'
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

    // Copy token
    var copyBtn = document.getElementById('sec-copy-token');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        DollhouseAuth.apiFetch('/api/console/token/info')
          .then(function (r) { return r.json(); })
          .then(function () {
            // Token preview only — full token requires a reveal endpoint
            navigator.clipboard.writeText(t.tokenPreview)
              .then(function () { copyBtn.textContent = 'Copied!'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500); })
              .catch(function () { alert('Failed to copy — check clipboard permissions'); });
          });
      });
    }

    // Copy as curl
    var curlBtn = document.getElementById('sec-copy-curl');
    if (curlBtn) {
      curlBtn.addEventListener('click', function () {
        var curl = 'curl -H "Authorization: Bearer <TOKEN>" http://localhost:' + location.port + '/api/elements';
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

  function renderEventsPanel() {
    var el = document.getElementById('sec-events-content');
    if (!el) return;

    DollhouseAuth.apiFetch('/api/logs?category=security&limit=20')
      .then(function (r) { return r.ok ? r.json() : Promise.reject('not available'); })
      .then(function (data) {
        var entries = data.entries || data || [];
        if (!entries.length) {
          el.innerHTML = '<p class="sec-hint">No recent security events.</p>';
          return;
        }
        el.innerHTML = '<div class="sec-events-list">'
          + entries.map(function (e) {
            var severity = (e.severity || e.level || 'INFO').toUpperCase();
            var badgeClass = severity === 'HIGH' || severity === 'CRITICAL' ? 'sec-badge--red'
              : severity === 'MEDIUM' ? 'sec-badge--amber'
              : 'sec-badge--blue';
            return '<div class="sec-event-row">'
              + '<span class="sec-event-time">' + esc(formatTime(e.timestamp)) + '</span>'
              + '<span class="sec-badge ' + badgeClass + '">' + esc(severity) + '</span>'
              + '<span class="sec-event-type">' + esc(e.type || e.message || '') + '</span>'
              + '<span class="sec-event-detail">' + esc(e.details || e.source || '') + '</span>'
              + '</div>';
          }).join('')
          + '</div>';
      })
      .catch(function () {
        el.innerHTML = '<p class="sec-hint">Could not load security events.</p>';
      });
  }

  function render(data) {
    lastData = data;
    renderTokenPanel(data);
    renderTotpPanel(data);
    renderEventsPanel();
  }

  // ── Actions ───────────────────────────────────────────────────────────

  function handleRotate() {
    var code = prompt('Enter your TOTP code to rotate the token:');
    if (!code) return;
    DollhouseAuth.apiFetch('/api/console/token/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationCode: code.trim() }),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok) {
          DollhouseAuth.refresh(result.body.token);
          alert('Token rotated successfully. The new token is now active.');
          poll();
        } else {
          alert('Rotation failed: ' + (result.body.error || 'Unknown error'));
        }
      })
      .catch(function (err) { alert('Rotation failed: ' + (err.message || 'network error')); });
  }

  function handleEnrollTotp() {
    DollhouseAuth.apiFetch('/api/console/totp/enroll/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) {
          alert('Enrollment failed: ' + (result.body.error || 'Unknown error'));
          return;
        }
        var begin = result.body;
        // Show QR code and secret in a panel
        var totpEl = document.getElementById('sec-totp-content');
        if (!totpEl) return;
        totpEl.innerHTML = ''
          + '<div class="sec-enroll-flow">'
          +   '<h4>Scan this QR code with your authenticator app</h4>'
          +   '<div class="sec-qr-container">'
          +     '<img src="' + esc(begin.qrSvgDataUrl) + '" alt="TOTP QR code" class="sec-qr-img" />'
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

        document.getElementById('sec-cancel-enroll').addEventListener('click', function () { poll(); });
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
                document.getElementById('sec-codes-done').addEventListener('click', function () { poll(); });
              } else {
                alert('Confirmation failed: ' + (confirmResult.body.error || 'Invalid code'));
              }
            })
            .catch(function (err) { alert('Confirmation failed: ' + (err.message || 'network error')); });
        });
      })
      .catch(function (err) { alert('Enrollment failed: ' + (err.message || 'network error')); });
  }

  function handleDisableTotp() {
    var code = prompt('Enter your TOTP code (or backup code) to disable TOTP:');
    if (!code) return;
    DollhouseAuth.apiFetch('/api/console/totp/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok) {
          alert('TOTP disabled. Token rotation now requires re-enrollment.');
          poll();
        } else {
          alert('Disable failed: ' + (result.body.error || 'Unknown error'));
        }
      })
      .catch(function (err) { alert('Disable failed: ' + (err.message || 'network error')); });
  }

  // ── Polling & lifecycle ───────────────────────────────────────────────

  function poll() {
    DollhouseAuth.apiFetch('/api/console/token/info')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) { render(data); })
      .catch(function (err) {
        var root = document.getElementById('security-dashboard-root');
        if (root) root.innerHTML = '<p class="sec-error">Failed to load security data: ' + esc(err.message) + '</p>';
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
