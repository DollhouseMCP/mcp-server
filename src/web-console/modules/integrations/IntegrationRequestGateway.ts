import { lookup as dnsLookup } from 'node:dns/promises';

import type { IRateLimitStore, RateLimitUpdate } from '../../../auth/embedded-as/storage/IRateLimitStore.js';
import type { ContextTracker } from '../../../security/encryption/ContextTracker.js';
import { isIntegrationApiHostAllowed } from '../../security/IntegrationApiHosts.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { IIntegrationDescriptorStore, IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import { type IUserIntegrationStore, type UserIntegrationProvider, type UserIntegrationRecord, isIntegrationConnected } from '../../stores/IUserIntegrationStore.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import type { IntegrationTokenRefreshService } from './IntegrationTokenRefreshService.js';
import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
  type DnsLookupAddress,
} from './IntegrationPublicHostGuard.js';
import { createPinnedOutboundFactory, type PinnedOutboundFactory } from './PinnedOutboundFactory.js';
import { readBoundedResponseText as readBoundedText, ResponseBodyTooLargeError } from './BoundedResponseReader.js';

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 60;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REDACTED = '[redacted]';
const MIN_EMBEDDED_CREDENTIAL_LENGTH = 8;
const RATE_LIMIT_SCOPE = 'web-console:integrations:request-gateway:v1';

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
  readonly pinnedOutbound?: PinnedOutboundFactory;
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
  private readonly pinnedOutboundFactory: PinnedOutboundFactory;
  private readonly dnsLookupImpl: DnsLookup;
  private readonly limiter: InMemoryIntegrationRateLimiter;

  constructor(private readonly options: IntegrationRequestGatewayOptions) {
    this.pinnedOutboundFactory = options.pinnedOutbound ?? createPinnedOutboundFactory();
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
    if (!isIntegrationConnected(record)) {
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
    provider: UserIntegrationProvider,
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
    const credentialRedactions = buildCredentialRedactions(descriptor, credential);
    const vetted = await assertIntegrationPublicHost(url.hostname, this.dnsLookupImpl);
    // Pin the connection to the vetted address so a second connect-time DNS
    // resolution cannot retarget the request (DNS-rebinding TOCTOU).
    const outbound = this.pinnedOutboundFactory({
      hostname: url.hostname,
      address: vetted.address,
      family: vetted.family,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await outbound.fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
        // Fail closed on redirects: the host allowlist + SSRF guard only validated the
        // initial URL, so a 3xx to an internal or non-allowlisted host must not be followed.
        redirect: 'error',
      });
      return await readBoundedResponse(response, controller, credentialRedactions);
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
      await outbound.close();
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

interface CredentialRedactions {
  readonly exact: ReadonlySet<string>;
  readonly embedded: readonly string[];
  readonly headers: readonly CredentialHeaderRedaction[];
}

interface CredentialHeaderRedaction {
  readonly name: string;
  readonly value: string;
}

// Single-replica/dev fallback used only when no IRateLimitStore is injected (production
// passes the auto-expiring store). Bounded by a time-amortized sweep that drops expired
// buckets at most once per window — so the Map size tracks active keys in the current
// window, not lifetime traffic, without an O(n) scan on the request hot path.
class InMemoryIntegrationRateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();
  private lastSweepAt = 0;

  constructor(private readonly windowMs: number, private readonly maxRequests: number) {}

  check(key: string, now: number): boolean {
    this.maybeSweep(now);
    const current = this.buckets.get(key);
    if (!current || now - current.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [bucketKey, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(bucketKey);
    }
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

function normalizeProvider(provider: string): UserIntegrationProvider {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(provider)) {
    throw new IntegrationRequestError('invalid_integration_provider', 'Integration provider must be a lowercase id of 2-64 chars (a-z, 0-9, _, -).', 400);
  }
  return provider as UserIntegrationProvider;
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
  if (url.protocol !== 'https:' || !isIntegrationApiHostAllowed(url.hostname, descriptor.apiHosts)) {
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
    if (descriptor.staticApiKey.injection.location === 'basic') {
      // The stored credential is `username:password` (RFC 7617); encode at
      // injection time so the vault never holds base64-obscured material.
      headers.set('Authorization', `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`);
      return;
    }
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

async function assertIntegrationPublicHost(hostname: string, lookup: DnsLookup): Promise<DnsLookupAddress> {
  try {
    return await assertPublicResolvedHost(hostname, lookup);
  } catch (error) {
    if (error instanceof PublicHostGuardError) {
      if (error.reason === 'resolution_failed') {
        throw new IntegrationRequestError('integration_host_resolution_failed', 'Integration request host could not be resolved.', 502);
      }
      throw new IntegrationRequestError('integration_host_not_allowed', 'Integration request host is not allowed.', 403);
    }
    throw error;
  }
}

async function readBoundedResponse(
  response: Response,
  controller: AbortController,
  credentialRedactions: CredentialRedactions,
): Promise<IntegrationHttpResponse> {
  let text: string;
  try {
    text = await readBoundedText(response, MAX_RESPONSE_BODY_BYTES);
  } catch (error) {
    if (!(error instanceof ResponseBodyTooLargeError)) throw error;
    controller.abort();
    throw new IntegrationRequestError('integration_response_too_large', 'Integration response body is too large.', 502);
  }
  return {
    status: response.status,
    body: parseResponseBody(text, response.headers.get('content-type'), credentialRedactions),
  };
}

function parseResponseBody(
  text: string,
  contentType: string | null,
  credentialRedactions: CredentialRedactions,
): unknown {
  if (text === '') return null;
  if (contentType?.toLowerCase().includes('application/json')) {
    try {
      return redactResponseCredentials(JSON.parse(text) as unknown, credentialRedactions);
    } catch {
      return REDACTED;
    }
  }
  return redactCredentialText(text, credentialRedactions);
}

function redactResponseCredentials(value: unknown, credentialRedactions: CredentialRedactions): unknown {
  if (typeof value === 'string') return redactCredentialText(value, credentialRedactions);
  if (Array.isArray(value)) return value.map(item => redactResponseCredentials(item, credentialRedactions));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const redactedKey = redactCredentialText(key, credentialRedactions);
    const redactedField = isCredentialKey(key)
      ? REDACTED
      : redactResponseCredentials(field, credentialRedactions);
    Object.defineProperty(output, redactedKey, {
      value: redactedField,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function redactCredentialText(value: string, credentialRedactions: CredentialRedactions): string {
  if (credentialRedactions.exact.has(value)) return REDACTED;
  let redacted = redactCredentialHeaderEchoes(value, credentialRedactions.headers);
  for (const secret of credentialRedactions.embedded) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted;
}

function redactCredentialHeaderEchoes(
  value: string,
  headers: readonly CredentialHeaderRedaction[],
): string {
  let redacted = value;
  for (const header of headers) {
    redacted = redactCredentialHeaderEcho(redacted, header);
  }
  return redacted;
}

function redactCredentialHeaderEcho(value: string, header: CredentialHeaderRedaction): string {
  const normalizedValue = value.toLowerCase();
  const normalizedName = header.name.toLowerCase();
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const index = normalizedValue.indexOf(normalizedName, searchFrom);
    if (index < 0) break;
    const before = index === 0 ? '' : value[index - 1];
    let cursor = index + header.name.length;
    while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
    if ((before === '' || !/[A-Za-z0-9-]/.test(before)) && value[cursor] === ':') {
      cursor += 1;
      while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
      if (value.startsWith(header.value, cursor)) {
        parts.push(value.slice(copyFrom, index), REDACTED);
        copyFrom = cursor + header.value.length;
        searchFrom = copyFrom;
        continue;
      }
    }
    searchFrom = index + header.name.length;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function buildCredentialRedactions(
  descriptor: IntegrationDescriptorRecord,
  credential: string,
): CredentialRedactions {
  const exact = new Set<string>();
  const embedded = new Set<string>();
  const headers: CredentialHeaderRedaction[] = [];
  const variants = (value: string): readonly string[] => [
    value,
    encodeURIComponent(value),
    new URLSearchParams({ value }).toString().slice('value='.length),
  ];
  const addExact = (value: string): void => {
    if (!value) return;
    for (const variant of variants(value)) exact.add(variant);
  };
  const addEmbedded = (value: string): void => {
    addExact(value);
    for (const variant of variants(value)) embedded.add(variant);
  };
  const addCredential = (value: string): void => {
    addExact(value);
    if (value.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH) addEmbedded(value);
  };

  addCredential(credential);
  if (descriptor.authStrategy === 'oauth2_authorization_code') {
    const authorization = `Bearer ${credential}`;
    addEmbedded(authorization);
    headers.push({ name: 'Authorization', value: authorization });
  } else if (descriptor.authStrategy === 'static_api_key' && descriptor.staticApiKey) {
    if (descriptor.staticApiKey.injection.location === 'basic') {
      const encoded = Buffer.from(credential, 'utf8').toString('base64');
      addCredential(encoded);
      const authorization = `Basic ${encoded}`;
      addEmbedded(authorization);
      headers.push({ name: 'Authorization', value: authorization });
    } else {
      const injectedValue = `${descriptor.staticApiKey.injection.valuePrefix ?? ''}${credential}`;
      addCredential(injectedValue);
      if (descriptor.staticApiKey.injection.location === 'query') {
        const encodedValue = new URLSearchParams({ value: injectedValue }).toString().slice('value='.length);
        addEmbedded(`${descriptor.staticApiKey.injection.name}=${encodedValue}`);
      } else {
        headers.push({ name: descriptor.staticApiKey.injection.name, value: injectedValue });
      }
    }
  }

  return {
    exact,
    embedded: [...embedded].sort((left, right) => right.length - left.length),
    headers,
  };
}

// Credential-shaped field-name fragments matched anywhere in the key (case-insensitive).
// Each `key`/`secret` separator variant is listed explicitly so the check stays a plain
// substring scan rather than a high-complexity regex.
const CREDENTIAL_KEY_SUBSTRINGS = [
  'authorization', 'bearer', 'jwt', 'secret', 'credential', 'password', 'passwd', 'ciphertext',
  'apikey', 'api_key', 'api-key', 'privatekey', 'private_key', 'private-key',
];

function isCredentialKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (CREDENTIAL_KEY_SUBSTRINGS.some(fragment => lower.includes(fragment))) return true;
  // token / access_token / refresh_token / id_token, bounded so e.g. 'tokenizer' is not redacted.
  return /(^|_)(access|refresh|id)?_?token($|_)/i.test(key);
}
