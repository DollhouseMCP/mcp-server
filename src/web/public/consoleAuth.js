/**
 * Console authentication helper (#1780).
 *
 * Reads the session token from the <meta name="dollhouse-console-token"> tag
 * injected by the server at page-load time, and provides small wrapper
 * functions that attach the token to API fetches and EventSource streams.
 *
 * When the token is empty (auth feature flag off, or server older than #1780)
 * the helpers fall back to plain fetch / EventSource with no auth header —
 * backwards-compatible with any Phase 0 setup.
 *
 * Usage (replace existing calls in other JS files):
 *   fetch('/api/elements')               →  DollhouseAuth.apiFetch('/api/elements')
 *   new EventSource('/api/logs/stream')  →  DollhouseAuth.apiEventSource('/api/logs/stream')
 *
 * External URLs (github.com, cdn.jsdelivr.net, etc.) should continue to use
 * plain fetch — never send the console token to non-local hosts.
 *
 * @since v2.1.0 — Issue #1780
 */

(function () {
  'use strict';

  /**
   * Strict format for console tokens — 64 lowercase hex characters.
   * We refuse to attach anything that doesn't match this pattern, so
   * malformed meta values or Unicode-obfuscated content never reach the
   * server or leak into request URLs. DMCP-SEC-004 mitigation.
   */
  var TOKEN_FORMAT = /^[0-9a-f]{64}$/;

  /**
   * Read the console token from the meta tag in the document head.
   * Normalizes the value to NFC and validates against the strict hex format.
   * Returns an empty string if the tag is absent, empty, still the raw
   * template placeholder, or fails validation.
   */
  function readTokenFromMeta() {
    var meta = document.querySelector('meta[name="dollhouse-console-token"]');
    if (!meta) return '';
    var raw = (meta.getAttribute('content') || '').trim();
    if (!raw || raw === '{{CONSOLE_TOKEN}}') return '';
    // Normalize to NFC — strips any zero-width / combining mark weirdness
    // before the format check. For legitimate hex tokens this is a no-op.
    var normalized = raw.normalize('NFC');
    if (!TOKEN_FORMAT.test(normalized)) return '';
    return normalized;
  }

  var consoleToken = readTokenFromMeta();

  /**
   * Fetch wrapper that attaches Authorization: Bearer to API requests.
   * Accepts the same arguments as native fetch().
   *
   * @param {RequestInfo} input - URL or Request object
   * @param {RequestInit} [init] - Fetch options (body, method, headers, etc.)
   * @returns {Promise<Response>}
   */
  function apiFetch(input, init) {
    if (!consoleToken) {
      return fetch(input, init);
    }
    const opts = init ? Object.assign({}, init) : {};
    const headers = new Headers(opts.headers || {});
    if (!headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer ' + consoleToken);
    }
    opts.headers = headers;
    return fetch(input, opts);
  }

  /**
   * EventSource wrapper that appends ?token=<token> to the URL.
   * EventSource cannot set custom headers, so the token is carried as a
   * query parameter. The middleware on the server accepts both the header
   * and this fallback.
   *
   * @param {string} url - Relative or absolute URL
   * @param {EventSourceInit} [init] - EventSource options (withCredentials, etc.)
   * @returns {EventSource}
   */
  function apiEventSource(url, init) {
    if (!consoleToken) {
      return new EventSource(url, init);
    }
    var separator = url.indexOf('?') >= 0 ? '&' : '?';
    var urlWithToken = url + separator + 'token=' + encodeURIComponent(consoleToken);
    return new EventSource(urlWithToken, init);
  }

  /** Expose the helpers on the global namespace. */
  window.DollhouseAuth = {
    /** Current console token value (empty string if auth is off). */
    get token() { return consoleToken; },

    /**
     * Update the cached token. If an explicit token string is provided and
     * passes the strict hex format check, the in-memory cache is updated
     * directly — this is the path used after a rotation response so the
     * active tab picks up the new token without a page reload. Without an
     * argument, falls back to re-reading the meta tag (legacy behavior).
     *
     * @param {string} [explicitToken] - New token value from a rotation response.
     * @returns {string} The token now in use (may be empty if auth is off).
     */
    refresh: function (explicitToken) {
      if (typeof explicitToken === 'string') {
        var normalized = explicitToken.normalize('NFC');
        if (TOKEN_FORMAT.test(normalized)) {
          consoleToken = normalized;
          return consoleToken;
        }
      }
      consoleToken = readTokenFromMeta();
      return consoleToken;
    },

    apiFetch: apiFetch,
    apiEventSource: apiEventSource,
  };
})();
