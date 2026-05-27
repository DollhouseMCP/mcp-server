import { CONSOLE_API_PREFIX } from '../platform/ConsolePlatformTypes.js';

export const CONSOLE_SESSION_COOKIE = 'dh_session';
export const CONSOLE_CSRF_COOKIE = 'dh_csrf';
export const CONSOLE_LOGIN_STATE_COOKIE = 'dh_login_state';
export const CONSOLE_INTEGRATION_STATE_COOKIE = 'dh_integration_state';
const MAX_COOKIE_VALUE_BYTES = 3500;

export type ConsoleCookieName =
  | typeof CONSOLE_SESSION_COOKIE
  | typeof CONSOLE_CSRF_COOKIE
  | typeof CONSOLE_LOGIN_STATE_COOKIE
  | typeof CONSOLE_INTEGRATION_STATE_COOKIE;

export type ConsoleCookieDirective =
  | {
    readonly operation: 'set';
    readonly name: ConsoleCookieName;
    readonly value: string;
    readonly maxAgeSeconds?: number;
  }
  | {
    readonly operation: 'clear';
    readonly name: ConsoleCookieName;
  };

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  let found = false;
  let decodedValue: string | undefined;
  for (const segment of cookieHeader?.split(';') ?? []) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    if (found) return undefined;
    found = true;
    const value = segment.slice(separator + 1).trim();
    if (value.startsWith('"') || value.endsWith('"')) return undefined;
    try {
      decodedValue = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return decodedValue;
}

export function serializeConsoleCookie(directive: ConsoleCookieDirective): string {
  validateCookieDirective(directive);
  const policy = cookiePolicy(directive.name);
  const value = directive.operation === 'set' ? encodeURIComponent(directive.value) : '';
  const maxAgeSeconds = directive.operation === 'set'
    ? directive.maxAgeSeconds ?? policy.defaultMaxAgeSeconds
    : 0;
  return [
    `${directive.name}=${value}`,
    `Path=${policy.path}`,
    maxAgeSeconds === undefined ? null : `Max-Age=${maxAgeSeconds}`,
    'Secure',
    'SameSite=Lax',
    policy.httpOnly ? 'HttpOnly' : null,
  ].filter((part): part is string => part !== null).join('; ');
}

export function validateConsoleCookieDirectives(cookies: readonly ConsoleCookieDirective[] | undefined): void {
  for (const cookie of cookies ?? []) {
    validateCookieDirective(cookie);
  }
}

function cookiePolicy(name: unknown): {
  readonly path: string;
  readonly httpOnly: boolean;
  readonly defaultMaxAgeSeconds?: number;
} {
  switch (name) {
    case CONSOLE_SESSION_COOKIE:
      return { path: '/', httpOnly: true };
    case CONSOLE_CSRF_COOKIE:
      // The SPA must read dh_csrf and echo it in X-CSRF-Token for session-bound double-submit CSRF.
      return { path: '/', httpOnly: false };
    case CONSOLE_LOGIN_STATE_COOKIE:
      return { path: `${CONSOLE_API_PREFIX}/auth`, httpOnly: true, defaultMaxAgeSeconds: 600 };
    case CONSOLE_INTEGRATION_STATE_COOKIE:
      return { path: `${CONSOLE_API_PREFIX}/me/integrations`, httpOnly: true, defaultMaxAgeSeconds: 600 };
    default:
      throw new Error('Unknown console cookie name');
  }
}

function validateCookieDirective(directive: unknown): asserts directive is ConsoleCookieDirective {
  if (!directive || typeof directive !== 'object') {
    throw new Error('Console cookie directive must be an object');
  }
  const candidate = directive as {
    readonly name?: unknown;
    readonly operation?: unknown;
    readonly value?: unknown;
  };
  cookiePolicy(candidate.name);
  if (candidate.operation === 'clear') return;
  if (candidate.operation !== 'set') {
    throw new Error('Console cookie directive operation is invalid');
  }
  if (typeof candidate.value !== 'string') {
    throw new Error('Console cookie value must be a string');
  }
  if (candidate.value.length === 0) {
    throw new Error('Console cookie set directive requires a non-empty value; use clear instead');
  }
  if (Buffer.byteLength(encodeURIComponent(candidate.value), 'utf8') > MAX_COOKIE_VALUE_BYTES) {
    throw new Error('Console cookie value exceeds the maximum supported size');
  }
}
