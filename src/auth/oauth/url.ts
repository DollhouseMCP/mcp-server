import { env } from '../../config/env.js';

/**
 * Canonical loopback-host predicate.
 *
 * Matches:
 *   - `localhost` and any `*.localhost` (RFC 6761 §6.3 reserved TLD)
 *   - `127.0.0.0/8` — every IPv4 starting `127.` is loopback per RFC 1122 §3.2.1.3
 *   - `::1` — the IPv6 loopback address
 *   - `0.0.0.0` and `::` are NOT loopback — those are wildcard-bind addresses,
 *     which are reachable from outside the host
 *
 * The single definition lives here; `createHttpOrHttpsServer` and any
 * other caller should import this rather than re-implementing.
 */
const LOOPBACK_NAMED_HOSTS = new Set(['localhost', '::1']);
const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function normalizeBaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function isLoopbackHost(hostname: string): boolean {
  // WHATWG URL.hostname returns IPv6 wrapped in brackets ("[::1]"). Strip
  // them for the named-host comparison so callers don't have to special-
  // case bracket form.
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (LOOPBACK_NAMED_HOSTS.has(stripped)) return true;
  if (stripped.endsWith('.localhost')) return true;
  if (IPV4_LOOPBACK_RE.test(stripped)) return true;
  return false;
}

export function assertSafePublicBaseUrl(rawUrl: string): string {
  const normalized = normalizeBaseUrl(rawUrl);
  const parsed = new URL(normalized);

  if (parsed.protocol === 'https:') {
    return normalized;
  }

  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) {
    return normalized;
  }

  throw new Error(
    'DOLLHOUSE_PUBLIC_BASE_URL must be HTTPS for public connectors. HTTP is only allowed for loopback hosts.',
  );
}

export function resolvePublicBaseUrl(options: {
  host?: string;
  port?: number;
  publicBaseUrl?: string;
} = {}): string {
  if (options.publicBaseUrl) {
    return assertSafePublicBaseUrl(options.publicBaseUrl);
  }

  if (env.DOLLHOUSE_PUBLIC_BASE_URL) {
    return assertSafePublicBaseUrl(env.DOLLHOUSE_PUBLIC_BASE_URL);
  }

  const host = options.host ?? env.DOLLHOUSE_HTTP_HOST;
  const port = options.port ?? env.DOLLHOUSE_HTTP_PORT;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return assertSafePublicBaseUrl(`http://${displayHost}:${port}`);
}

export function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}
