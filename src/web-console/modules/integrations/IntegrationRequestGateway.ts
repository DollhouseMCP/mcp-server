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
  readonly percentExact: ReadonlySet<string>;
  readonly embedded: readonly string[];
  readonly percentEmbedded: readonly string[];
  readonly headers: readonly CredentialHeaderRedaction[];
  readonly queries: readonly CredentialQueryRedaction[];
}

interface CredentialHeaderRedaction {
  readonly name: string;
  readonly value: string;
  readonly caseInsensitivePrefixLength?: number;
  readonly requireValueBoundary: boolean;
}

interface CredentialHeaderEchoMatch {
  readonly start: number;
  readonly end: number;
}

interface ParsedJsonString {
  readonly value: string;
  readonly end: number;
}

interface CredentialQueryRedaction {
  readonly name: string;
  readonly value: string;
}

interface CredentialRedactionCollector {
  readonly addExact: (value: string) => void;
  readonly addEmbedded: (value: string) => void;
  readonly addCredential: (value: string, allowEmbedded?: boolean) => void;
  readonly addHeader: (
    name: string,
    value: string,
    sensitiveValue: string,
    caseInsensitivePrefixLength?: number,
  ) => void;
  readonly queries: CredentialQueryRedaction[];
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
  if (isJsonMediaType(contentType)) {
    try {
      return redactResponseCredentials(JSON.parse(text) as unknown, credentialRedactions);
    } catch {
      return REDACTED;
    }
  }
  return redactCredentialText(text, credentialRedactions);
}

function isJsonMediaType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function redactResponseCredentials(value: unknown, credentialRedactions: CredentialRedactions): unknown {
  if (typeof value === 'string') return redactCredentialText(value, credentialRedactions);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    const serialized = String(value);
    return redactCredentialText(serialized, credentialRedactions) === serialized ? value : REDACTED;
  }
  if (Array.isArray(value)) return value.map(item => redactResponseCredentials(item, credentialRedactions));
  if (typeof value !== 'object') return value;
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
  if (credentialRedactions.exact.has(value) ||
      credentialRedactions.percentExact.has(normalizePercentEscapes(value))) {
    return REDACTED;
  }
  let redacted = redactCredentialHeaderEchoes(value, credentialRedactions.headers);
  redacted = redactCredentialQueryEchoes(redacted, credentialRedactions.queries);
  for (const secret of credentialRedactions.embedded) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  redacted = redactPercentEncodedCredentials(redacted, credentialRedactions.percentEmbedded);
  return redacted;
}

function redactCredentialQueryEchoes(
  value: string,
  queries: readonly CredentialQueryRedaction[],
): string {
  let redacted = value;
  for (const query of queries) redacted = redactCredentialQueryEcho(redacted, query);
  return redacted;
}

function redactCredentialQueryEcho(value: string, query: CredentialQueryRedaction): string {
  const normalizedValue = normalizePercentEscapes(value);
  const normalizedQueryValue = normalizePercentEscapes(query.value);
  const marker = normalizePercentEscapes(`${query.name}=`);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const index = normalizedValue.indexOf(marker, searchFrom);
    if (index < 0) break;
    const before = index === 0 ? '' : value[index - 1];
    const valueStart = index + marker.length;
    const valueEnd = valueStart + query.value.length;
    const after = value[valueEnd] ?? '';
    const nameBoundary = before === '' || !/[A-Za-z0-9_.~-]/.test(before);
    const valueBoundary = isCredentialValueBoundary(after);
    if (nameBoundary && valueBoundary &&
        normalizedValue.startsWith(normalizedQueryValue, valueStart)) {
      parts.push(value.slice(copyFrom, index), REDACTED);
      copyFrom = valueEnd;
      searchFrom = valueEnd;
      continue;
    }
    searchFrom = index + marker.length;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function redactPercentEncodedCredentials(value: string, patterns: readonly string[]): string {
  let redacted = value;
  for (const pattern of patterns) {
    const normalizedValue = normalizePercentEscapes(redacted);
    const parts: string[] = [];
    let copyFrom = 0;
    let searchFrom = 0;
    for (;;) {
      const index = normalizedValue.indexOf(pattern, searchFrom);
      if (index < 0) break;
      parts.push(redacted.slice(copyFrom, index), REDACTED);
      copyFrom = index + pattern.length;
      searchFrom = copyFrom;
    }
    if (parts.length > 0) {
      parts.push(redacted.slice(copyFrom));
      redacted = parts.join('');
    }
  }
  return redacted;
}

function normalizePercentEscapes(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase());
}

function isCredentialValueBoundary(value: string): boolean {
  return value === '' || /[&\s"'#,.;:!?)}\]>]/.test(value);
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
  const jsonRedacted = redactJsonCredentialHeaderEchoes(value, header);
  const normalizedValue = asciiLowercase(jsonRedacted);
  const normalizedName = asciiLowercase(header.name);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const index = normalizedValue.indexOf(normalizedName, searchFrom);
    if (index < 0) break;
    searchFrom = index + header.name.length;
    const match = credentialHeaderEchoMatch(jsonRedacted, index, header);
    if (match === null) continue;
    parts.push(jsonRedacted.slice(copyFrom, match.start), REDACTED);
    copyFrom = match.end;
    searchFrom = copyFrom;
  }
  if (parts.length === 0) return jsonRedacted;
  parts.push(jsonRedacted.slice(copyFrom));
  return parts.join('');
}

function redactJsonCredentialHeaderEchoes(
  value: string,
  header: CredentialHeaderRedaction,
): string {
  const normalizedName = asciiLowercase(header.name);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const start = value.indexOf('"', searchFrom);
    if (start < 0) break;
    const parsedName = parseJsonStringAt(value, start);
    if (parsedName === null) {
      searchFrom = start + 1;
      continue;
    }
    searchFrom = parsedName.end;
    if (asciiLowercase(parsedName.value) !== normalizedName) continue;
    const before = start === 0 ? '' : value[start - 1];
    if (before !== '' && /[A-Za-z0-9-]/.test(before)) continue;
    const valueEnd = credentialHeaderValueEchoEnd(value, parsedName.end, header);
    if (valueEnd === null) continue;
    parts.push(value.slice(copyFrom, start), REDACTED);
    copyFrom = valueEnd;
    searchFrom = valueEnd;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function credentialHeaderEchoMatch(
  value: string,
  headerStart: number,
  header: CredentialHeaderRedaction,
): CredentialHeaderEchoMatch | null {
  const before = headerStart === 0 ? '' : value[headerStart - 1];
  const nameQuote = before === '"' || before === "'" ? before : null;
  const matchStart = nameQuote === null ? headerStart : headerStart - 1;
  const boundaryBefore = matchStart === 0 ? '' : value[matchStart - 1];
  if (boundaryBefore !== '' && /[A-Za-z0-9-]/.test(boundaryBefore)) return null;

  let cursor = headerStart + header.name.length;
  if (nameQuote !== null) {
    if (value[cursor] !== nameQuote) return null;
    cursor += 1;
  }
  const valueEnd = credentialHeaderValueEchoEnd(value, cursor, header);
  return valueEnd === null ? null : { start: matchStart, end: valueEnd };
}

function credentialHeaderValueEchoEnd(
  value: string,
  cursorAfterName: number,
  header: CredentialHeaderRedaction,
): number | null {
  let cursor = skipHorizontalWhitespace(value, cursorAfterName);
  if (value[cursor] !== ':') return null;
  cursor = skipHorizontalWhitespace(value, cursor + 1);

  const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : null;
  if (quote === '"') {
    const parsed = parseJsonStringAt(value, cursor);
    if (parsed !== null) {
      return parsed.value.length === header.value.length &&
        credentialHeaderValueMatches(parsed.value, 0, header)
        ? parsed.end
        : null;
    }
  }
  const valueStart = quote ? cursor + 1 : cursor;
  if (!credentialHeaderValueMatches(value, valueStart, header)) return null;

  const valueEnd = valueStart + header.value.length;
  if (quote !== null && value[valueEnd] === quote) return valueEnd + 1;
  if (header.requireValueBoundary && !isCredentialValueBoundary(value[valueEnd] ?? '')) return null;
  return valueEnd;
}

function parseJsonStringAt(value: string, start: number): ParsedJsonString | null {
  let escaped = false;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      const parsed = JSON.parse(value.slice(start, cursor + 1)) as unknown;
      return typeof parsed === 'string' ? { value: parsed, end: cursor + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function skipHorizontalWhitespace(value: string, start: number): number {
  let cursor = start;
  while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
  return cursor;
}

function credentialHeaderValueMatches(
  value: string,
  valueStart: number,
  header: CredentialHeaderRedaction,
): boolean {
  const prefixLength = header.caseInsensitivePrefixLength ?? 0;
  if (prefixLength === 0) {
    const actualValue = value.slice(valueStart, valueStart + header.value.length);
    return normalizePercentEscapes(actualValue) === normalizePercentEscapes(header.value);
  }
  const actualPrefix = asciiLowercase(value.slice(valueStart, valueStart + prefixLength));
  const expectedPrefix = asciiLowercase(header.value.slice(0, prefixLength));
  const actualSuffix = normalizePercentEscapes(
    value.slice(valueStart + prefixLength, valueStart + header.value.length),
  );
  const expectedSuffix = normalizePercentEscapes(header.value.slice(prefixLength));
  return actualPrefix === expectedPrefix &&
    actualSuffix === expectedSuffix;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

function buildCredentialRedactions(
  descriptor: IntegrationDescriptorRecord,
  credential: string,
): CredentialRedactions {
  const exact = new Set<string>();
  const percentExact = new Set<string>();
  const embedded = new Set<string>();
  const percentEmbedded = new Set<string>();
  const headers: CredentialHeaderRedaction[] = [];
  const queries: CredentialQueryRedaction[] = [];
  const encodedVariants = (value: string): readonly string[] => [
    encodeURIComponent(value),
    new URLSearchParams({ value }).toString().slice('value='.length),
  ];
  const addExact = (value: string): void => {
    if (!value) return;
    exact.add(value);
    for (const variant of encodedVariants(value)) {
      exact.add(variant);
      if (variant.includes('%')) percentExact.add(normalizePercentEscapes(variant));
    }
  };
  const addEmbedded = (value: string): void => {
    addExact(value);
    embedded.add(value);
    for (const variant of encodedVariants(value)) {
      embedded.add(variant);
      if (variant.includes('%')) percentEmbedded.add(normalizePercentEscapes(variant));
    }
  };
  const addCredential = (
    value: string,
    allowEmbedded = value.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH,
  ): void => {
    addExact(value);
    if (allowEmbedded) addEmbedded(value);
  };
  const addHeader = (
    name: string,
    value: string,
    sensitiveValue: string,
    caseInsensitivePrefixLength = 0,
  ): void => {
    const requireValueBoundary = sensitiveValue.length < MIN_EMBEDDED_CREDENTIAL_LENGTH;
    const prefix = value.slice(0, value.length - sensitiveValue.length);
    const candidates = new Map<string, number>([[value, caseInsensitivePrefixLength]]);
    const escapedPrefix = jsonStringContent(prefix);
    candidates.set(
      jsonStringContent(value),
      caseInsensitivePrefixLength > 0 ? escapedPrefix.length : 0,
    );
    for (const encodedValue of encodedVariants(value)) {
      candidates.set(encodedValue, caseInsensitivePrefixLength > 0 ? prefix.trimEnd().length : 0);
    }
    if (prefix) {
      for (const encodedSensitiveValue of encodedVariants(sensitiveValue)) {
        candidates.set(`${prefix}${encodedSensitiveValue}`, caseInsensitivePrefixLength);
      }
      candidates.set(
        `${escapedPrefix}${jsonStringContent(sensitiveValue)}`,
        caseInsensitivePrefixLength > 0 ? escapedPrefix.length : 0,
      );
    }
    for (const [candidate, prefixLength] of candidates) {
      headers.push({
        name,
        value: candidate,
        caseInsensitivePrefixLength: prefixLength || undefined,
        requireValueBoundary,
      });
    }
  };

  collectCredentialStrategyRedactions(descriptor, credential, {
    addExact,
    addEmbedded,
    addCredential,
    addHeader,
    queries,
  });

  return {
    exact,
    percentExact,
    embedded: [...embedded].sort((left, right) => right.length - left.length),
    percentEmbedded: [...percentEmbedded].sort((left, right) => right.length - left.length),
    headers,
    queries,
  };
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function collectCredentialStrategyRedactions(
  descriptor: IntegrationDescriptorRecord,
  credential: string,
  collector: CredentialRedactionCollector,
): void {
  collector.addCredential(credential);
  if (descriptor.authStrategy === 'oauth2_authorization_code') {
    const authorization = `Bearer ${credential}`;
    addAuthorizationRedactions(collector, authorization, credential, 'Bearer '.length);
    return;
  }
  if (descriptor.authStrategy === 'static_api_key' && descriptor.staticApiKey) {
    collectStaticApiKeyRedactions(descriptor.staticApiKey, credential, collector);
  }
}

function collectStaticApiKeyRedactions(
  staticApiKey: NonNullable<IntegrationDescriptorRecord['staticApiKey']>,
  credential: string,
  collector: CredentialRedactionCollector,
): void {
  if (staticApiKey.injection.location === 'basic') {
    const encoded = Buffer.from(credential, 'utf8').toString('base64');
    collector.addCredential(encoded);
    addAuthorizationRedactions(collector, `Basic ${encoded}`, encoded, 'Basic '.length);
    return;
  }

  const injectedValue = `${staticApiKey.injection.valuePrefix ?? ''}${credential}`;
  collector.addCredential(injectedValue, credential.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH);
  if (staticApiKey.injection.location === 'query') {
    addQueryCredentialRedactions(collector.queries, staticApiKey.injection.name, injectedValue);
    return;
  }
  const valuePrefix = staticApiKey.injection.valuePrefix ?? '';
  if (asciiLowercase(staticApiKey.injection.name) === 'authorization' && valuePrefix) {
    addAuthorizationRedactions(collector, injectedValue, credential, valuePrefix.length);
    return;
  }
  collector.addHeader(staticApiKey.injection.name, injectedValue, credential);
}

function addAuthorizationRedactions(
  collector: CredentialRedactionCollector,
  authorization: string,
  sensitiveValue: string,
  prefixLength: number,
): void {
  if (sensitiveValue.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH) collector.addEmbedded(authorization);
  else collector.addExact(authorization);
  collector.addHeader('Authorization', authorization, sensitiveValue, prefixLength);
}

function addQueryCredentialRedactions(
  queries: CredentialQueryRedaction[],
  queryName: string,
  injectedValue: string,
): void {
  const encodedName = new URLSearchParams([[queryName, '']]).toString().slice(0, -1);
  const encodedValue = new URLSearchParams({ value: injectedValue }).toString().slice('value='.length);
  const queryNames = new Set([queryName, encodedName, encodeURIComponent(queryName)]);
  const queryValues = new Set([injectedValue, encodedValue, encodeURIComponent(injectedValue)]);
  for (const name of queryNames) {
    for (const value of queryValues) queries.push({ name, value });
  }
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
