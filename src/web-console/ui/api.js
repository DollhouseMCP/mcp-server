/**
 * DollhouseMCP web console — /api/v1 browser client.
 *
 * The console is a strict BFF. This module centralizes the protocol so feature
 * code never has to think about it:
 *   - Auth is cookie-based. `dh_session` is HttpOnly (the browser sends it
 *     automatically); `dh_csrf` is readable so we can echo it for double-submit.
 *   - Mutations carry the CSRF token (X-CSRF-Token = dh_csrf cookie),
 *     X-Console-Request, and a fresh Idempotency-Key.
 *   - ETag-guarded writes pass If-Match.
 *   - A 401 `step_up_required` is surfaced as a `dh:step-up-required` event so
 *     the shell can drive the elevation flow, then returned to the caller.
 *
 * Responses are normalized to { status, body, etag, problemCode, headers }.
 */

const API_PREFIX = '/api/v1';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Read a non-HttpOnly cookie (used for the dh_csrf double-submit token). */
function readCookie(name) {
  const prefix = `${name}=`;
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
  }
  return undefined;
}

function buildHeaders(method, options) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.ifMatch) headers['if-match'] = options.ifMatch;
  if (MUTATING.has(method)) {
    const csrf = readCookie('dh_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    headers['x-console-request'] = '1';
    // null disables the auto key (for negative tests / non-idempotent probes).
    if (options.idempotencyKey !== null) {
      headers['idempotency-key'] = options.idempotencyKey ?? crypto.randomUUID();
    }
  }
  return headers;
}

function parseProblemCode(body) {
  return body && typeof body === 'object' && typeof body.code === 'string' ? body.code : undefined;
}

/**
 * Core request. Returns a normalized response; never throws on HTTP status.
 * On 401 step_up_required, dispatches `dh:step-up-required` (detail carries the
 * required capability + step_up_url) before returning so the shell can react.
 */
export async function request(method, path, options = {}) {
  const res = await fetch(API_PREFIX + path, {
    method,
    credentials: 'same-origin',
    redirect: 'manual',
    headers: buildHeaders(method, options),
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const text = await res.text();
  let body;
  if (text) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  const problemCode = parseProblemCode(body);

  if (res.status === 401 && problemCode === 'step_up_required') {
    const ext = (body && body.extensions) || {};
    globalThis.dispatchEvent(new CustomEvent('dh:step-up-required', {
      detail: {
        capability: ext.required_capability,
        stepUpUrl: ext.step_up_url,
        maxAuthAgeSeconds: ext.max_auth_age_seconds,
      },
    }));
  }

  return {
    status: res.status,
    body,
    text,
    etag: res.headers.get('etag') ?? undefined,
    problemCode,
    headers: res.headers,
  };
}

export const get = (path, options) => request('GET', path, options);
export const post = (path, options) => request('POST', path, options);
export const put = (path, options) => request('PUT', path, options);
export const patch = (path, options) => request('PATCH', path, options);
export const del = (path, options) => request('DELETE', path, options);

/**
 * Open an SSE stream via fetch (not EventSource) so we keep full header control
 * and same-origin cookies. Calls onEvent per parsed frame; returns a stop()
 * handle. Mirrors the e2e harness reader.
 */
export function openStream(path, { onEvent, onError, signal } = {}) {
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  (async () => {
    try {
      const res = await fetch(API_PREFIX + path, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (res.status !== 200 || !res.body) {
        onError?.(new Error(`stream open failed: ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = parseSseFrame(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
          if (frame) onEvent?.(frame);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err);
    }
  })();

  return { stop: () => controller.abort() };
}

function parseSseFrame(raw) {
  let event;
  let id;
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0 && event === undefined && id === undefined) return undefined;
  return { event, id, data: data.join('\n') };
}

/** Current principal, or null if unauthenticated (drives the auth gate). */
export async function whoami() {
  const res = await get('/auth/me');
  return res.status === 200 ? res.body : null;
}

/** Navigate the browser into the embedded-AS login (returns to the console after). */
export function login(returnTo = '/ui') {
  globalThis.location.href = `${API_PREFIX}/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

export async function logout() {
  await post('/auth/logout');
  globalThis.location.reload();
}

/**
 * Begin an admin step-up. Navigates to the embedded-AS elevation flow (OTP),
 * which returns the browser to `returnTo` (a relative app path) once elevated.
 * One step-up grants the session its full role-entitled admin capabilities.
 */
export function stepUp(capability, returnTo = '/ui') {
  const params = new URLSearchParams({ capability, return_to: returnTo });
  globalThis.location.href = `${API_PREFIX}/auth/step-up?${params.toString()}`;
}

/** Drop admin elevation immediately (back to standard access). 204 on success. */
export async function stepDown() {
  return post('/auth/step-down');
}
