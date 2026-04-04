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
   * Read the console token from the meta tag in the document head.
   * Returns an empty string if the tag is absent or the value is the
   * raw placeholder (which happens if the HTML was served without template
   * substitution — e.g., older server or file served by a dev static server).
   */
  function readTokenFromMeta() {
    const meta = document.querySelector('meta[name="dollhouse-console-token"]');
    if (!meta) return '';
    const value = (meta.getAttribute('content') || '').trim();
    if (!value || value === '{{CONSOLE_TOKEN}}') return '';
    return value;
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

    /** Refresh the cached token from the meta tag — call after a rotation. */
    refresh: function () { consoleToken = readTokenFromMeta(); return consoleToken; },

    apiFetch: apiFetch,
    apiEventSource: apiEventSource,
  };
})();
