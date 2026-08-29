import { lookup as dnsLookup } from 'node:dns/promises';

import type { IRateLimitStore, RateLimitUpdate } from '../../../auth/embedded-as/storage/IRateLimitStore.js';
import type { ContextTracker } from '../../../security/encryption/ContextTracker.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { isIntegrationApiHostAllowed } from '../../security/IntegrationApiHosts.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { IIntegrationDescriptorStore, IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import { type IUserIntegrationStore, type UserIntegrationProvider, type UserIntegrationRecord, isIntegrationConnectedToDescriptor } from '../../stores/IUserIntegrationStore.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';
import type { IntegrationTokenRefreshService } from './IntegrationTokenRefreshService.js';
import {
  canonicalizeIntegrationRequestPath,
  IntegrationRequestPathError,
} from './IntegrationRequestPath.js';
import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
  type DnsLookupAddress,
} from './IntegrationPublicHostGuard.js';
import { createPinnedOutboundFactory, type PinnedOutboundFactory } from './PinnedOutboundFactory.js';
import { readBoundedResponseText as readBoundedText, ResponseBodyTooLargeError } from './BoundedResponseReader.js';
import {
  buildCredentialRedactions,
  type CredentialRedactions,
  type EffectiveCredentialInjection,
  redactIntegrationResponseBody,
} from './IntegrationCredentialRedactor.js';

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 60;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
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
    let descriptor: IntegrationDescriptorRecord | null;
    try {
      descriptor = await this.options.descriptorStore.findVisibleByProvider(session.userId, provider);
    } catch (error) {
      await this.auditLookupFailure({
        provider: 'unresolved',
        userId: session.userId,
        sessionId: session.sessionId,
        method,
        host: null,
        path: null,
        reason: 'descriptor_lookup_failed',
      });
      throw error;
    }
    if (!descriptor) {
      await this.auditDenied('unresolved', session.userId, session.sessionId, method, null, null, 'descriptor_not_found');
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
    let record: UserIntegrationRecord | null;
    try {
      record = await this.options.integrationStore.findByProvider(session.userId, provider);
    } catch (error) {
      await this.auditLookupFailure({
        provider: descriptor.provider,
        userId: session.userId,
        sessionId: session.sessionId,
        method,
        host: url.hostname,
        path: url.pathname,
        reason: 'credential_lookup_failed',
      });
      throw error;
    }
    if (!isIntegrationConnectedToDescriptor(record, descriptor.id)) {
      await this.auditDenied(provider, session.userId, session.sessionId, method, url.hostname, url.pathname, 'credential_not_connected');
      throw new IntegrationRequestError('integration_not_connected', 'Integration is not connected.', 409);
    }
    const staleAccessTokenCiphertext = record.accessTokenCiphertext;
    const firstCredential = await this.decryptAuditedAccessToken(record, session.userId, session.sessionId, method, url, false);
    const body = await this.serializeAuditedRequestBody(provider, session.userId, session.sessionId, method, url, input.body);
    const first = await this.auditedSend(requestContext, descriptor, body, firstCredential, false);
    const tokenRefresh = this.options.tokenRefresh;
    if (first.status !== 401 || !tokenRefresh || !staleAccessTokenCiphertext ||
        !await tokenRefresh.canRefresh(session.userId, descriptor, record)) {
      return this.finish(provider, session.userId, session.sessionId, method, url, first, false);
    }

    const refresh = await this.refreshAudited({
      tokenRefresh,
      userId: session.userId,
      sessionId: session.sessionId,
      provider,
      integrationDescriptorId: descriptor.id,
      method,
      url,
      staleAccessTokenCiphertext,
    });
    if (refresh.kind !== 'refreshed' && refresh.kind !== 'reused') {
      await this.auditCredentialError(provider, session.userId, session.sessionId, method, url, 'refresh_failed');
      throw new IntegrationRequestError('integration_token_refresh_failed', 'Integration token refresh failed.', 502);
    }
    const retryCredential = await this.decryptAuditedAccessToken(refresh.record, session.userId, session.sessionId, method, url, true);
    const retry = await this.auditedSend(
      requestContext,
      descriptor,
      body,
      retryCredential,
      true,
      [firstCredential],
    );
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

  private async refreshAudited(input: {
    readonly tokenRefresh: IntegrationTokenRefreshService;
    readonly userId: string;
    readonly sessionId: string | null;
    readonly provider: UserIntegrationProvider;
    readonly integrationDescriptorId: string;
    readonly method: string;
    readonly url: URL;
    readonly staleAccessTokenCiphertext: Buffer;
  }) {
    try {
      return await input.tokenRefresh.refreshOnDemand({
        userId: input.userId,
        provider: input.provider,
        integrationDescriptorId: input.integrationDescriptorId,
        staleAccessTokenCiphertext: input.staleAccessTokenCiphertext,
      });
    } catch (error) {
      await this.auditCredentialError(
        input.provider,
        input.userId,
        input.sessionId,
        input.method,
        input.url,
        error instanceof IntegrationRequestError ? error.code : 'refresh_failed',
        true,
      );
      throw error;
    }
  }

  private async auditedSend(
    ctx: GatewayRequestContext,
    descriptor: IntegrationDescriptorRecord,
    body: string | null,
    credential: string,
    refreshed: boolean,
    previousCredentials: readonly string[] = [],
  ): Promise<IntegrationHttpResponse> {
    try {
      return await this.send(descriptor, ctx.url, ctx.method, body, credential, previousCredentials);
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
    previousCredentials: readonly string[],
  ): Promise<IntegrationHttpResponse> {
    const headers = new Headers({ Accept: 'application/json' });
    if (body !== null) headers.set('Content-Type', 'application/json');
    const effectiveInjection = injectCredential(descriptor, url, headers, credential);
    const additionalCredentials = previousCredentials.map(previousCredential => {
      const redactionUrl = new URL(url);
      const redactionHeaders = new Headers({ Accept: 'application/json' });
      if (body !== null) redactionHeaders.set('Content-Type', 'application/json');
      return {
        credential: previousCredential,
        injection: injectCredential(descriptor, redactionUrl, redactionHeaders, previousCredential),
      };
    });
    const credentialRedactions = buildCredentialRedactions(
      credential,
      effectiveInjection,
      additionalCredentials,
    );
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

  private async auditLookupFailure(event: {
    readonly provider: string;
    readonly userId: string;
    readonly sessionId: string | null;
    readonly method: string;
    readonly host: string | null;
    readonly path: string | null;
    readonly reason: string;
  }): Promise<void> {
    await this.audit({
      ...event,
      result: 'upstream_error',
      status: null,
      refreshed: false,
      occurredAt: new Date(),
    });
  }

  private async audit(event: IntegrationRequestAuditEvent): Promise<void> {
    const reasonSuffix = event.reason ? ` (${event.reason})` : '';
    SecurityMonitor.logSecurityEvent({
      type: 'INTEGRATION_SECURITY_DECISION',
      severity: event.result === 'success' ? 'LOW' : 'MEDIUM',
      source: 'IntegrationRequestGateway.request',
      details: `Integration request ${event.result}${reasonSuffix} for provider ${safeIntegrationAuditProvider(event.provider)}`,
    });
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
  let canonicalPath;
  try {
    canonicalPath = canonicalizeIntegrationRequestPath(path);
  } catch (error) {
    if (error instanceof IntegrationRequestPathError) {
      throw new IntegrationRequestError(error.code, error.message, error.status);
    }
    throw error;
  }
  const base = `https://${descriptor.apiHosts[0]}`;
  const url = new URL(`${canonicalPath.pathname}${canonicalPath.search}`, base);
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
): EffectiveCredentialInjection {
  if (descriptor.authStrategy === 'oauth2_authorization_code') {
    return injectHeaderCredential(headers, 'Authorization', `Bearer ${credential}`, credential, true);
  }
  if (descriptor.authStrategy === 'static_api_key' && descriptor.staticApiKey) {
    if (descriptor.staticApiKey.injection.location === 'basic') {
      // The stored credential is `username:password` (RFC 7617); encode at
      // injection time so the vault never holds base64-obscured material.
      const encoded = Buffer.from(credential, 'utf8').toString('base64');
      const password = credential.slice(credential.indexOf(':') + 1);
      const injection = injectHeaderCredential(headers, 'Authorization', `Basic ${encoded}`, encoded, true);
      return {
        ...injection,
        additionalSensitiveValues: [password],
        additionalBoundedValues: [credential],
        additionalStructuredValues: [{
          name: 'password',
          value: password,
          caseInsensitiveName: true,
        }],
      };
    }
    const value = `${descriptor.staticApiKey.injection.valuePrefix ?? ''}${credential}`;
    if (descriptor.staticApiKey.injection.location === 'header') {
      const caseInsensitivePrefix = descriptor.staticApiKey.injection.name.toLowerCase() === 'authorization' &&
        Boolean(descriptor.staticApiKey.injection.valuePrefix);
      return injectHeaderCredential(
        headers,
        descriptor.staticApiKey.injection.name,
        value,
        credential,
        caseInsensitivePrefix,
      );
    }
    const name = descriptor.staticApiKey.injection.name;
    url.searchParams.set(name, value);
    return {
      location: 'query',
      name,
      value: url.searchParams.get(name) ?? value,
      sensitiveValue: credential,
    };
  }
  throw new IntegrationRequestError('integration_auth_strategy_not_supported', 'Integration auth strategy is not supported.', 400);
}

function injectHeaderCredential(
  headers: Headers,
  name: string,
  value: string,
  sensitiveValue: string,
  caseInsensitivePrefix: boolean,
): EffectiveCredentialInjection {
  headers.set(name, value);
  const effectiveValue = headers.get(name);
  if (effectiveValue === null) {
    throw new IntegrationRequestError('integration_credential_injection_failed', 'Integration credential could not be injected.', 500);
  }
  const normalizedSensitiveValue = new Headers([[name, sensitiveValue]]).get(name);
  const effectiveSensitiveValue = normalizedSensitiveValue !== null &&
      normalizedSensitiveValue !== '' && effectiveValue.endsWith(normalizedSensitiveValue)
    ? normalizedSensitiveValue
    : effectiveValue;
  const prefixLength = effectiveValue.length - effectiveSensitiveValue.length;
  const configuredPrefixLength = value.length - sensitiveValue.length;
  return {
    location: 'header',
    name,
    value: effectiveValue,
    sensitiveValue: effectiveSensitiveValue,
    caseInsensitivePrefixLength: caseInsensitivePrefix && prefixLength > 0 ? prefixLength : undefined,
    configuredValue: value,
    configuredSensitiveValue: sensitiveValue,
    configuredCaseInsensitivePrefixLength: caseInsensitivePrefix && configuredPrefixLength > 0
      ? configuredPrefixLength
      : undefined,
  };
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
    body: redactIntegrationResponseBody(text, response.headers.get('content-type'), credentialRedactions),
  };
}
