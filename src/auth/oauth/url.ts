import { env } from '../../config/env.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function normalizeBaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
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
