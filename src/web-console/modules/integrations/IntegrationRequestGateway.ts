import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { IRateLimitStore, RateLimitUpdate } from '../../../auth/embedded-as/storage/IRateLimitStore.js';
import type { ContextTracker } from '../../../security/encryption/ContextTracker.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { IIntegrationDescriptorStore, IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import type { IUserIntegrationStore, UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import type { IntegrationTokenRefreshService } from './IntegrationTokenRefreshService.js';

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 60;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REDACTED = '[redacted]';
const RATE_LIMIT_SCOPE = 'web-console:integrations:request-gateway:v1';

type DnsLookup = (hostname: string, options: { readonly all: true }) => Promise<readonly DnsLookupAddress[]>;

interface DnsLookupAddress {
  readonly address: string;
  readonly family: number;
}

interface RateLimitState {
  readonly windowStart: number;
  readonly count: number;
}

interface RateLimitDecision {
  readonly allowed: boolean;
}

export interface IntegrationRequestGatewayOptions {
  readonly integrationStore: IUserIntegrationStore;
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly contextTracker: ContextTracker;
  readonly tokenRefresh?: IntegrationTokenRefreshService | null;
  readonly fetch?: typeof fetch;
  readonly dnsLookup?: DnsLookup;
  readonly auditSink?: IIntegrationRequestAuditSink | null;
  readonly rateLimitStore?: IRateLimitStore | null;
  readonly timeoutMs?: number;
  readonly rateLimit?: {
    readonly windowMs: number;
    readonly maxRequests: number;
  };
}

export interface IntegrationRequestInput {
  readonly provider: string;
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

export interface IntegrationRequestResult {
  readonly provider: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly status: number;
  readonly response: unknown;
  readonly refreshed: boolean;
  readonly provenance: IntegrationRequestProvenance;
}

export interface IntegrationRequestProvenance {
  readonly source: 'third_party_integration';
  readonly trust: 'untrusted';
  readonly provider: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly readWriteClass: 'read' | 'write';
  readonly handling: 'data_only_not_instructions';
}

export interface IntegrationRequestAuditEvent {
  readonly provider: string;
  readonly userId: string;
  readonly sessionId: string | null;
  readonly method: string;
  readonly host: string | null;
  readonly path: string | null;
  readonly result: 'success' | 'denied' | 'upstream_error' | 'credential_error';
  readonly status: number | null;
  readonly reason: string | null;
  readonly refreshed: boolean;
  readonly occurredAt: Date;
}

export interface IIntegrationRequestAuditSink {
  recordIntegrationRequest(event: IntegrationRequestAuditEvent): Promise<void>;
}

export class IntegrationRequestGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly dnsLookupImpl: DnsLookup;
  private readonly limiter: InMemoryIntegrationRateLimiter;

  constructor(private readonly options: IntegrationRequestGatewayOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.dnsLookupImpl = options.dnsLookup ?? dnsLookup;
    this.limiter = new InMemoryIntegrationRateLimiter(
      options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
      options.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX,
    );
  }

  async request(input: IntegrationRequestInput): Promise<IntegrationRequestResult> {
    const session = this.options.contextTracker.requireSessionContext('IntegrationRequestGateway');
    const provider = normalizeProvider(input.provider);
    const method = normalizeMethod(input.method);
    const descriptor = await this.options.descriptorStore.findVisibleByProvider(session.userId, provider);
    if (!descriptor) {
      await this.auditDenied(provider, session.userId, session.sessionId, method, null, null, 'descriptor_not_found');
      throw new IntegrationRequestError('integration_descriptor_not_found', 'Integration descriptor was not found.', 404);
    }
    const url = await this.buildAuditedUrl(descriptor, provider, session.userId, session.sessionId, method, input.path, input.query);
    const requestContext: GatewayRequestContext = {
      provider,
      userId: session.userId,
      sessionId: session.sessionId,
      method,
      url,
    };
    const rateKey = `${session.userId}:${provider}:${url.hostname}`;
    const rateLimit = await this.consumeAuditedRateLimit(provider, session.userId, session.sessionId, method, url, rateKey);
    if (!rateLimit) {
      await this.auditDenied(provider, session.userId, session.sessionId, method, url.hostname, url.pathname, 'rate_limited');
      throw new IntegrationRequestError('integration_request_rate_limited', 'Integration request rate limit exceeded.', 429);
    }
    const record = await this.options.integrationStore.findByProvider(session.userId, provider);
    if (!isConnected(record)) {
      await this.auditDenied(provider, session.userId, session.sessionId, method, url.hostname, url.pathname, 'credential_not_connected');
      throw new IntegrationRequestError('integration_not_connected', 'Integration is not connected.', 409);
    }
    const firstCredential = await this.decryptAuditedAccessToken(record, session.userId, session.sessionId, method, url, false);
    const body = await this.serializeAuditedRequestBody(provider, session.userId, session.sessionId, method, url, input.body);
    const first = await this.auditedSend(requestContext, descriptor, body, firstCredential, false);
    if (first.status !== 401 || !this.options.tokenRefresh || !record.accessTokenCiphertext) {
      return this.finish(provider, session.userId, session.sessionId, method, url, first, false);
    }

    const refresh = await this.refreshAudited(this.options.tokenRefresh, session.userId, session.sessionId, provider, method, url, record.accessTokenCiphertext);
    if (refresh.kind !== 'refreshed' && refresh.kind !== 'reused') {
      await this.auditCredentialError(provider, session.userId, session.sessionId, method, url, 'refresh_failed');
      throw new IntegrationRequestError('integration_token_refresh_failed', 'Integration token refresh failed.', 502);
    }
    const retryCredential = await this.decryptAuditedAccessToken(refresh.record, session.userId, session.sessionId, method, url, true);
    const retry = await this.auditedSend(requestContext, descriptor, body, retryCredential, true);
    return this.finish(provider, session.userId, session.sessionId, method, url, retry, true);
  }

  private async buildAuditedUrl(
    descriptor: IntegrationDescriptorRecord,
    provider: string,
    userId: string,
    sessionId: string | null,
    method: string,
    path: string,
    query: Readonly<Record<string, unknown>> | undefined,
  ): Promise<URL> {
    try {
      return buildAllowedUrl(descriptor, path, query);
    } catch (error) {
      if (error instanceof IntegrationRequestError) {
        await this.auditDenied(provider, userId, sessionId, method, null, null, error.code);
      }
      throw error;
    }
  }

  private async serializeAuditedRequestBody(
    provider: string,
    userId: string,
    sessionId: string | null,
    method: string,
    url: URL,
    body: unknown,
  ): Promise<string | null> {
    try {
      return serializeRequestBody(method, body);
    } catch (error) {
      if (error instanceof IntegrationRequestError) {
        await this.auditDenied(provider, userId, sessionId, method, url.hostname, url.pathname, error.code);
      }
      throw error;
    }
  }

  private async decryptAuditedAccessToken(
    record: UserIntegrationRecord,
    userId: string,
    sessionId: string | null,
    method: string,
    url: URL,
    refreshed: boolean,
  ): Promise<string> {
    try {
      return this.decryptAccessToken(record, userId);
    } catch (error) {
      if (error instanceof IntegrationRequestError) {
        await this.auditCredentialError(record.provider, userId, sessionId, method, url, error.code, refreshed);
      }
      throw error;
    }
  }

  private async refreshAudited(
    tokenRefresh: IntegrationTokenRefreshService,
    userId: string,
    sessionId: string | null,
    provider: string,
    method: string,
    url: URL,
    staleAccessTokenCiphertext: Buffer,
  ) {
    try {
      return await tokenRefresh.refreshOnDemand({
        userId,
        provider,
        staleAccessTokenCiphertext,
      });
    } catch (error) {
      await this.auditCredentialError(provider, userId, sessionId, method, url, error instanceof IntegrationRequestError ? error.code : 'refresh_failed', true);
      throw error;
    }
  }

  private async auditedSend(
    ctx: GatewayRequestContext,
    descriptor: IntegrationDescriptorRecord,
    body: string | null,
    credential: string,
    refreshed: boolean,
  ): Promise<IntegrationHttpResponse> {
    try {
      return await this.send(descriptor, ctx.url, ctx.method, body, credential);
    } catch (error) {
      if (error instanceof IntegrationRequestError) {
        await this.audit({
          provider: ctx.provider,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          method: ctx.method,
          host: ctx.url.hostname,
          path: ctx.url.pathname,
          result: 'upstream_error',
          status: null,
          reason: error.code,
          refreshed,
          occurredAt: new Date(),
        });
      }
      throw error;
    }
  }

  private async send(
    descriptor: IntegrationDescriptorRecord,
    url: URL,
    method: string,
    body: string | null,
    credential: string,
  ): Promise<IntegrationHttpResponse> {
    const headers = new Headers({ Accept: 'application/json' });
    if (body !== null) headers.set('Content-Type', 'application/json');
    injectCredential(descriptor, url, headers, credential);
    await assertPublicResolvedHost(url.hostname, this.dnsLookupImpl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      return await readBoundedResponse(response, controller);
    } catch (error) {
      if (error instanceof IntegrationRequestError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new IntegrationRequestError('integration_request_timeout', 'Integration request timed out.', 504);
      }
      throw new IntegrationRequestError('integration_request_failed', 'Integration request failed.', 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async consumeRateLimit(rateKey: string, now: number): Promise<boolean> {
    const windowMs = this.options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const maxRequests = this.options.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX;
    if (!this.options.rateLimitStore) {
      return this.limiter.check(rateKey, now);
    }
    const update = await this.options.rateLimitStore.update<RateLimitState, RateLimitDecision>(
      RATE_LIMIT_SCOPE,
      rateKey,
      prev => stepRateLimit(prev, now, windowMs, maxRequests),
      { expiresAt: now + windowMs * 2 },
    );
    return update.result?.allowed ?? false;
  }

  private async consumeAuditedRateLimit(
    provider: string,
    userId: string,
    sessionId: string | null,
    method: string,
    url: URL,
    rateKey: string,
  ): Promise<boolean> {
    try {
      return await this.consumeRateLimit(rateKey, Date.now());
    } catch {
      await this.auditDenied(provider, userId, sessionId, method, url.hostname, url.pathname, 'rate_limit_unavailable');
      throw new IntegrationRequestError(
        'integration_request_rate_limit_unavailable',
        'Integration request rate limit is temporarily unavailable.',
        503,
      );
    }
  }

  private finish(
    provider: string,
    userId: string,
    sessionId: string | null,
    method: string,
    url: URL,
    response: IntegrationHttpResponse,
    refreshed: boolean,
  ): IntegrationRequestResult {
    const result = response.status >= 200 && response.status < 400 ? 'success' : 'upstream_error';
    void this.audit({
      provider,
      userId,
      sessionId,
      method,
      host: url.hostname,
      path: url.pathname,
      result,
      status: response.status,
      reason: result === 'success' ? null : 'upstream_status',
      refreshed,
      occurredAt: new Date(),
    });
    return {
      provider,
      method,
      host: url.hostname,
      path: url.pathname,
      status: response.status,
      response: response.body,
      refreshed,
      provenance: {
        source: 'third_party_integration',
        trust: 'untrusted',
        provider,
        method,
        host: url.hostname,
        path: url.pathname,
        readWriteClass: method === 'GET' ? 'read' : 'write',
        handling: 'data_only_not_instructions',
      },
    };
  }

  private decryptAccessToken(record: UserIntegrationRecord, userId: string): string {
    if (!record.accessTokenCiphertext) {
      throw new IntegrationRequestError('integration_credential_missing', 'Integration credential is missing.', 409);
    }
    try {
      return this.options.secretEncryption.decrypt(
        record.accessTokenCiphertext,
        integrationSecretContext('access_token', userId, record.provider),
      ).toString('utf8');
    } catch {
      throw new IntegrationRequestError('integration_credential_decrypt_failed', 'Integration credential could not be decrypted.', 409);
    }
  }

  private async auditDenied(
    provider: string,
    userId: string,
    sessionId: string | null,
    method: string,
    host: string | null,
    path: string | null,
    reason: string,
  ): Promise<void> {
    await this.audit({ provider, userId, sessionId, method, host, path, result: 'denied', status: null, reason, refreshed: false, occurredAt: new Date() });
  }

  private async auditCredentialError(
    provider: string,
    userId: string,
    sessionId: string | null,
    method: string,
    url: URL,
    reason: string,
    refreshed = true,
  ): Promise<void> {
    await this.audit({
      provider,
      userId,
      sessionId,
      method,
      host: url.hostname,
      path: url.pathname,
      result: 'credential_error',
      status: null,
      reason,
      refreshed,
      occurredAt: new Date(),
    });
  }

  private async audit(event: IntegrationRequestAuditEvent): Promise<void> {
    try {
      await this.options.auditSink?.recordIntegrationRequest(event);
    } catch {
      // Gateway auditing is best-effort until Group 7 expands the approval/audit model.
    }
  }
}

export class IntegrationRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'IntegrationRequestError';
  }
}

interface IntegrationHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

interface GatewayRequestContext {
  readonly provider: string;
  readonly userId: string;
  readonly sessionId: string | null;
  readonly method: string;
  readonly url: URL;
}

class InMemoryIntegrationRateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly windowMs: number, private readonly maxRequests: number) {}

  check(key: string, now: number): boolean {
    const current = this.buckets.get(key);
    if (!current || now - current.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }
}

function stepRateLimit(
  prev: RateLimitState | null,
  now: number,
  windowMs: number,
  maxRequests: number,
): RateLimitUpdate<RateLimitState, RateLimitDecision> {
  const state = prev && now - prev.windowStart < windowMs
    ? { windowStart: prev.windowStart, count: prev.count + 1 }
    : { windowStart: now, count: 1 };
  return {
    state,
    result: {
      allowed: state.count <= maxRequests,
    },
  };
}

function normalizeProvider(provider: string): string {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(provider)) {
    throw new IntegrationRequestError('invalid_integration_provider', 'Invalid integration provider.', 400);
  }
  return provider;
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  if (!ALLOWED_METHODS.has(normalized)) {
    throw new IntegrationRequestError('integration_method_not_allowed', 'Integration request method is not allowed.', 400);
  }
  return normalized;
}

function buildAllowedUrl(
  descriptor: IntegrationDescriptorRecord,
  path: string,
  query: Readonly<Record<string, unknown>> | undefined,
): URL {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new IntegrationRequestError('invalid_integration_path', 'Integration request path must be an absolute path.', 400);
  }
  const base = `https://${descriptor.apiHosts[0]}`;
  const url = new URL(path, base);
  if (url.protocol !== 'https:' || !descriptor.apiHosts.includes(url.hostname)) {
    throw new IntegrationRequestError('integration_host_not_allowed', 'Integration request host is not allowed.', 403);
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  addQuery(url, query);
  return url;
}

function addQuery(url: URL, query: Readonly<Record<string, unknown>> | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z0-9_.~-]{1,120}$/.test(key)) {
      throw new IntegrationRequestError('invalid_integration_query', 'Integration request query contains an invalid key.', 400);
    }
    appendQueryValue(url, key, value);
  }
}

function appendQueryValue(url: URL, key: string, value: unknown): void {
  if (isQueryPrimitive(value)) {
    url.searchParams.append(key, String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isQueryPrimitive(item)) {
        throw new IntegrationRequestError('invalid_integration_query', 'Integration request query contains an invalid value.', 400);
      }
      url.searchParams.append(key, String(item));
    }
    return;
  }
  if (value !== null && value !== undefined) {
    throw new IntegrationRequestError('invalid_integration_query', 'Integration request query contains an invalid value.', 400);
  }
}

function isQueryPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function serializeRequestBody(method: string, body: unknown): string | null {
  if (method === 'GET' || method === 'DELETE') {
    if (body !== undefined && body !== null) {
      throw new IntegrationRequestError('integration_body_not_allowed', 'Integration request body is not allowed for this method.', 400);
    }
    return null;
  }
  if (body === undefined || body === null) return null;
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new IntegrationRequestError('integration_request_too_large', 'Integration request body is too large.', 413);
  }
  return serialized;
}

function injectCredential(
  descriptor: IntegrationDescriptorRecord,
  url: URL,
  headers: Headers,
  credential: string,
): void {
  if (descriptor.authStrategy === 'oauth2_authorization_code') {
    headers.set('Authorization', `Bearer ${credential}`);
    return;
  }
  if (descriptor.authStrategy === 'static_api_key' && descriptor.staticApiKey) {
    const value = `${descriptor.staticApiKey.injection.valuePrefix ?? ''}${credential}`;
    if (descriptor.staticApiKey.injection.location === 'header') {
      headers.set(descriptor.staticApiKey.injection.name, value);
      return;
    }
    url.searchParams.set(descriptor.staticApiKey.injection.name, value);
    return;
  }
  throw new IntegrationRequestError('integration_auth_strategy_not_supported', 'Integration auth strategy is not supported.', 400);
}

async function assertPublicResolvedHost(hostname: string, lookup: DnsLookup): Promise<void> {
  let addresses: readonly DnsLookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new IntegrationRequestError('integration_host_resolution_failed', 'Integration request host could not be resolved.', 502);
  }
  if (addresses.length === 0 || addresses.some(entry => !isPublicIpAddress(entry.address))) {
    throw new IntegrationRequestError('integration_host_not_allowed', 'Integration request host is not allowed.', 403);
  }
}

async function readBoundedResponse(response: Response, controller: AbortController): Promise<IntegrationHttpResponse> {
  const text = await readBoundedResponseText(response, controller);
  return {
    status: response.status,
    body: parseResponseBody(text, response.headers.get('content-type')),
  };
}

async function readBoundedResponseText(response: Response, controller: AbortController): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BODY_BYTES) {
    controller.abort();
    throw new IntegrationRequestError('integration_response_too_large', 'Integration response body is too large.', 502);
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BODY_BYTES) {
      controller.abort();
      throw new IntegrationRequestError('integration_response_too_large', 'Integration response body is too large.', 502);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        controller.abort();
        await reader.cancel();
        throw new IntegrationRequestError('integration_response_too_large', 'Integration response body is too large.', 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function parseResponseBody(text: string, contentType: string | null): unknown {
  if (text === '') return null;
  if (contentType?.toLowerCase().includes('application/json')) {
    try {
      return redactCredentialFields(JSON.parse(text) as unknown);
    } catch {
      return REDACTED;
    }
  }
  return text;
}

function redactCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialFields);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    output[key] = isCredentialKey(key) ? REDACTED : redactCredentialFields(field);
  }
  return output;
}

function isCredentialKey(key: string): boolean {
  return /(^|_)(access|refresh)?_?token($|_)|authorization|api[_-]?key|secret|ciphertext/i.test(key);
}

function isConnected(record: UserIntegrationRecord | null): record is UserIntegrationRecord {
  return record?.status === 'connected' && record.revokedAt === null;
}

function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeIpv4MappedAddress(address);
  const version = isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version === 6) return isPublicIpv6(normalized);
  return false;
}

function normalizeIpv4MappedAddress(address: string): string {
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped?.[1] ?? address;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return false;
  const firstGroup = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (Number.isNaN(firstGroup)) return false;
  if ((firstGroup & 0xfe00) === 0xfc00) return false;
  if ((firstGroup & 0xffc0) === 0xfe80) return false;
  if ((firstGroup & 0xff00) === 0xff00) return false;
  return true;
}
