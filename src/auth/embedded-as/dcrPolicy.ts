/**
 * Dynamic Client Registration policy for hosted MCP.
 *
 * The goal is not to maintain a list of "trusted" MCP clients. We allow
 * unknown clients, but reject callback and metadata shapes that are unsafe or
 * confusing for a public authorization server.
 *
 * Anchored to issue #2220.
 */

import { isIP } from 'node:net';

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_SCOPE_LENGTH = 512;
const MAX_STRING_METADATA_LENGTH = 256;

const SUPPORTED_SCOPES = new Set(['openid', 'offline_access', 'profile', 'email', 'mcp']);
const SUPPORTED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const SUPPORTED_RESPONSE_TYPES = new Set(['code']);
const SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS = new Set(['none']);

const FORBIDDEN_OPEN_DCR_METADATA = new Set([
  'client_id',
  'client_secret',
  'client_secret_expires_at',
  'client_id_issued_at',
  'registration_access_token',
  'registration_client_uri',
  'jwks',
  'jwks_uri',
  'sector_identifier_uri',
  'request_uris',
  'backchannel_logout_uri',
  'backchannel_client_notification_endpoint',
]);

export interface RedirectUriPolicyResult {
  ok: boolean;
  uri: string;
  host?: string;
  isLoopback?: boolean;
  errors: string[];
}

export interface DcrPolicyDecision {
  allowed: boolean;
  errors: string[];
  redirectHosts: string[];
  auditFindings: DcrPolicyAuditFinding[];
}

export interface DcrPolicyAuditFinding {
  type: 'metadata_host_mismatch';
  field: string;
  host: string;
  redirectHosts: string[];
}

export interface RedirectUriPolicyOptions {
  applicationType?: string;
}

export function validateDcrClientMetadata(input: unknown): DcrPolicyDecision {
  const errors: string[] = [];
  const metadata = asRecord(input);
  if (!metadata) {
    return {
      allowed: false,
      errors: ['registration request body must be a JSON object'],
      redirectHosts: [],
      auditFindings: [],
    };
  }

  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_OPEN_DCR_METADATA.has(key) || key.startsWith('tls_client_auth_')) {
      errors.push(`${key} is not accepted for open dynamic client registration`);
    }
  }

  const redirectUris = readStringArray(metadata.redirect_uris, 'redirect_uris', errors, {
    required: true,
    maxItems: MAX_REDIRECT_URIS,
  });
  const applicationType = typeof metadata.application_type === 'string'
    ? metadata.application_type
    : undefined;
  const redirectResults = redirectUris.map((uri) => validateRedirectUriShape(uri, { applicationType }));
  for (const result of redirectResults) {
    errors.push(...result.errors.map((error) => `redirect_uris entry ${result.uri}: ${error}`));
  }

  validateScope(metadata.scope, errors);
  validateStringArraySubset(metadata.grant_types, 'grant_types', SUPPORTED_GRANT_TYPES, errors);
  validateStringArraySubset(metadata.response_types, 'response_types', SUPPORTED_RESPONSE_TYPES, errors);
  validateTokenEndpointAuthMethod(metadata.token_endpoint_auth_method, errors);
  validateApplicationType(metadata.application_type, errors);
  validateStringMetadata(metadata, errors);
  validateHttpsMetadataUri(metadata.client_uri, 'client_uri', errors);
  validateHttpsMetadataUri(metadata.logo_uri, 'logo_uri', errors);
  validateHttpsMetadataUri(metadata.policy_uri, 'policy_uri', errors);
  validateHttpsMetadataUri(metadata.tos_uri, 'tos_uri', errors);
  validateIdTokenAlg(metadata.id_token_signed_response_alg, errors);

  const redirectHosts = Array.from(new Set(
    redirectResults
      .map((result) => result.host)
      .filter((host): host is string => typeof host === 'string' && host.length > 0),
  ));
  const auditFindings = collectMetadataAuditFindings(metadata, redirectHosts);

  return {
    allowed: errors.length === 0,
    errors,
    redirectHosts,
    auditFindings,
  };
}

export function validateRedirectUriShape(
  uri: string,
  options: RedirectUriPolicyOptions = {},
): RedirectUriPolicyResult {
  const errors: string[] = [];
  if (typeof uri !== 'string' || uri.trim() !== uri || uri.length === 0) {
    return { ok: false, uri: String(uri), errors: ['must be a non-empty string without surrounding whitespace'] };
  }
  if (uri.length > MAX_URI_LENGTH) {
    errors.push(`must be ${MAX_URI_LENGTH} characters or fewer`);
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, uri, errors: ['must be an absolute URL'] };
  }

  const host = normalizeUrlHostname(parsed.hostname);
  const loopback = isLoopbackHost(host);

  const validationErrors = [
    ...errors,
    ...validateRedirectUriComponents(parsed, host),
    ...validateRedirectUriProtocol(parsed.protocol, loopback, options.applicationType),
    ...validateRedirectUriIp(host, loopback),
  ];

  return {
    ok: validationErrors.length === 0,
    uri,
    host,
    isLoopback: loopback,
    errors: validationErrors,
  };
}

function validateRedirectUriComponents(parsed: URL, host: string): string[] {
  return [
    ...errorIf(host.length === 0, 'must include a hostname'),
    ...errorIf(host.includes('*'), 'must not contain wildcards'),
    ...errorIf(host.endsWith('.'), 'must not use a trailing-dot hostname'),
    ...errorIf(host.includes('%'), 'must not include IPv6 zone identifiers'),
    ...errorIf(Boolean(parsed.username || parsed.password), 'must not include username or password components'),
    ...errorIf(Boolean(parsed.hash), 'must not include a URL fragment'),
  ];
}

function validateRedirectUriProtocol(
  protocol: string,
  loopback: boolean,
  applicationType: string | undefined,
): string[] {
  if (protocol === 'http:') {
    return [
      ...errorIf(loopback === false, 'http callbacks are allowed only for loopback clients'),
      ...errorIf(loopback && applicationType !== 'native', 'http loopback callbacks require application_type "native"'),
    ];
  }
  return protocol === 'https:' ? [] : ['must use https, or http for loopback clients'];
}

function validateRedirectUriIp(host: string, loopback: boolean): string[] {
  return loopback === false && isPrivateIpLiteral(host)
    ? ['must not use a private, link-local, or unspecified IP literal']
    : [];
}

function errorIf(condition: boolean, message: string): string[] {
  return condition ? [message] : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readStringArray(
  value: unknown,
  field: string,
  errors: string[],
  options: { required: boolean; maxItems: number },
): string[] {
  if (value === undefined) {
    if (options.required) errors.push(`${field} is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  if (value.length === 0) errors.push(`${field} must contain at least one entry`);
  if (value.length > options.maxItems) errors.push(`${field} must contain at most ${options.maxItems} entries`);
  const strings: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push(`${field}[${index}] must be a string`);
      return;
    }
    strings.push(entry);
  });
  return strings;
}

function validateStringArraySubset(
  value: unknown,
  field: string,
  supported: ReadonlySet<string>,
  errors: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  if (value.length === 0) {
    errors.push(`${field} must contain at least one entry`);
    return;
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !supported.has(entry)) {
      errors.push(`${field} contains unsupported value ${JSON.stringify(entry)}`);
    }
  }
}

function validateScope(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push('scope must be a string');
    return;
  }
  if (value.length > MAX_SCOPE_LENGTH) {
    errors.push(`scope must be ${MAX_SCOPE_LENGTH} characters or fewer`);
  }
  for (const scope of value.split(/\s+/).filter(Boolean)) {
    if (!SUPPORTED_SCOPES.has(scope)) {
      errors.push(`scope contains unsupported value ${JSON.stringify(scope)}`);
    }
  }
}

function validateTokenEndpointAuthMethod(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.has(value)) {
    errors.push(`token_endpoint_auth_method contains unsupported value ${JSON.stringify(value)}`);
  }
}

function validateApplicationType(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (value !== 'web' && value !== 'native') {
    errors.push('application_type must be "web" or "native"');
  }
}

function validateStringMetadata(metadata: Record<string, unknown>, errors: string[]): void {
  for (const key of ['client_name', 'software_id', 'software_version']) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${key} must be a non-empty string`);
      continue;
    }
    if (value.length > MAX_STRING_METADATA_LENGTH) {
      errors.push(`${key} must be ${MAX_STRING_METADATA_LENGTH} characters or fewer`);
    }
    if (containsControlCharacter(value)) {
      errors.push(`${key} must not contain control characters`);
    }
  }
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function validateHttpsMetadataUri(value: unknown, field: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return;
  }
  if (value.length > MAX_URI_LENGTH) {
    errors.push(`${field} must be ${MAX_URI_LENGTH} characters or fewer`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${field} must be an absolute URL`);
    return;
  }
  const host = normalizeUrlHostname(parsed.hostname);
  if (parsed.protocol !== 'https:') errors.push(`${field} must use https`);
  if (!host || host.includes('*') || host.endsWith('.')) errors.push(`${field} must use a concrete hostname`);
  if (parsed.username || parsed.password) errors.push(`${field} must not include username or password components`);
  if (parsed.hash) errors.push(`${field} must not include a URL fragment`);
  if (isPrivateIpLiteral(host)) errors.push(`${field} must not use a private, link-local, or unspecified IP literal`);
}

function validateIdTokenAlg(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (value !== 'ES256') {
    errors.push('id_token_signed_response_alg must be ES256 when provided');
  }
}

function collectMetadataAuditFindings(
  metadata: Record<string, unknown>,
  redirectHosts: string[],
): DcrPolicyAuditFinding[] {
  if (redirectHosts.length === 0) return [];
  const findings: DcrPolicyAuditFinding[] = [];
  const redirectHostSet = new Set(redirectHosts);
  for (const field of ['client_uri', 'logo_uri', 'policy_uri', 'tos_uri']) {
    const value = metadata[field];
    if (typeof value !== 'string') continue;
    const host = safeHttpsMetadataHost(value);
    if (!host || redirectHostSet.has(host)) continue;
    findings.push({
      type: 'metadata_host_mismatch',
      field,
      host,
      redirectHosts,
    });
  }
  return findings;
}

function safeHttpsMetadataHost(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    const host = normalizeUrlHostname(parsed.hostname);
    return host || null;
  } catch {
    return null;
  }
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const mappedIpv4 = parseIpv4MappedIpv6(host);
  if (mappedIpv4) return mappedIpv4[0] === 127;
  if (isIP(host) === 4) {
    const octets = parseIpv4(host);
    return octets ? octets[0] === 127 : false;
  }
  return false;
}

function isPrivateIpLiteral(host: string): boolean {
  const mappedIpv4 = parseIpv4MappedIpv6(host);
  if (mappedIpv4) return isPrivateIpv4Octets(mappedIpv4);
  const version = isIP(host);
  if (version === 4) {
    const octets = parseIpv4(host);
    if (!octets) return false;
    return isPrivateIpv4Octets(octets);
  }
  if (version === 6) {
    return host === '::'
      || host === '::1'
      || isIpv6UniqueLocal(host)
      || isIpv6LinkLocal(host);
  }
  return false;
}

function isIpv6UniqueLocal(host: string): boolean {
  const firstHextet = parseFirstIpv6Hextet(host);
  return firstHextet !== null && firstHextet >= 0xfc00 && firstHextet <= 0xfdff;
}

function isIpv6LinkLocal(host: string): boolean {
  const firstHextet = parseFirstIpv6Hextet(host);
  return firstHextet !== null && firstHextet >= 0xfe80 && firstHextet <= 0xfebf;
}

function parseFirstIpv6Hextet(host: string): number | null {
  const [first] = host.split(':', 1);
  if (!first || !/^[0-9a-f]{1,4}$/i.test(first)) return null;
  return Number.parseInt(first, 16);
}

function isPrivateIpv4Octets(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function parseIpv4MappedIpv6(host: string): [number, number, number, number] | null {
  const mappedPrefix = '::ffff:';
  if (!host.startsWith(mappedPrefix)) return null;

  const embedded = host.slice(mappedPrefix.length);
  const dotted = parseIpv4(embedded);
  if (dotted) return dotted;

  const groups = embedded.split(':');
  if (groups.length !== 2) return null;

  const high = parseIpv4MappedHexGroup(groups[0]);
  const low = parseIpv4MappedHexGroup(groups[1]);
  if (high === null || low === null) return null;

  return [
    high >>> 8,
    high & 0xff,
    low >>> 8,
    low & 0xff,
  ];
}

function parseIpv4MappedHexGroup(group: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
  const value = Number.parseInt(group, 16);
  return Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : null;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}
