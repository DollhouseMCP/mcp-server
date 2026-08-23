import { isIP } from 'node:net';

const MAX_HOST_INPUT_LENGTH = 1024;
const MAX_CANONICAL_HOST_LENGTH = 253;
const FORBIDDEN_HOST_SYNTAX = /[\\/:@?#%\u005B\u005D]/u;
const UNSAFE_HOST_UNICODE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CANONICAL_DNS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class IntegrationApiHostValidationError extends Error {}

export interface IntegrationApiHostCanonicalizationOptions {
  /** Read-only compatibility for old descriptors; never use for new writes or egress. */
  readonly allowLegacyPrivateSuffixes?: boolean;
}

/** Canonicalize a DNS hostname to the lowercase ASCII form used by URL.hostname. */
export function canonicalizeIntegrationApiHost(
  value: string,
  name = 'API host',
  options: IntegrationApiHostCanonicalizationOptions = {},
): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_HOST_INPUT_LENGTH) {
    throw invalidHost(name);
  }
  if (value.trim() !== value || UNSAFE_HOST_UNICODE.test(value) || FORBIDDEN_HOST_SYNTAX.test(value)) {
    throw invalidHost(name);
  }

  const withoutRootDot = value.endsWith('.') ? value.slice(0, -1) : value;
  if (withoutRootDot === '' || withoutRootDot.endsWith('.')) throw invalidHost(name);

  let parsed: URL;
  try {
    parsed = new URL(`https://${withoutRootDot}/`);
  } catch {
    throw invalidHost(name);
  }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw invalidHost(name);
  }

  const canonical = parsed.hostname;
  if (canonical.length === 0 || canonical.length > MAX_CANONICAL_HOST_LENGTH ||
      !CANONICAL_DNS_HOST.test(canonical) || isIP(canonical) !== 0 ||
      isAlwaysPrivateDnsName(canonical) ||
      (!options.allowLegacyPrivateSuffixes && isRestrictedPrivateDnsName(canonical))) {
    throw new IntegrationApiHostValidationError(`${name} must be a public DNS hostname`);
  }
  return canonical;
}

export function canonicalizeIntegrationApiHosts(
  values: readonly string[],
  name = 'apiHosts',
  options: IntegrationApiHostCanonicalizationOptions = {},
): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 25) {
    throw new IntegrationApiHostValidationError(`${name} must contain 1-25 hosts`);
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const host = canonicalizeIntegrationApiHost(value, `${name}[${index}]`, options);
    if (!seen.has(host)) {
      seen.add(host);
      canonical.push(host);
    }
  }
  return canonical;
}

export function isIntegrationApiHostAllowed(
  hostname: string,
  canonicalAllowedHosts: readonly string[],
): boolean {
  try {
    return canonicalAllowedHosts.includes(canonicalizeIntegrationApiHost(hostname));
  } catch (error) {
    if (error instanceof IntegrationApiHostValidationError) return false;
    throw error;
  }
}

function isAlwaysPrivateDnsName(hostname: string): boolean {
  return !hostname.includes('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal');
}

function isRestrictedPrivateDnsName(hostname: string): boolean {
  return hostname === 'home.arpa' ||
    hostname.endsWith('.home.arpa') ||
    hostname.endsWith('.corp') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.lan');
}

function invalidHost(name: string): IntegrationApiHostValidationError {
  return new IntegrationApiHostValidationError(
    `${name} must be a hostname without a scheme, credentials, port, path, query, or fragment`,
  );
}
