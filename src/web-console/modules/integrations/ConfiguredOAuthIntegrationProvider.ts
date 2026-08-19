import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

import type { IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import type { UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import type {
  IIntegrationProvider,
  IntegrationAuthorizationRequest,
  IntegrationProviderStatusProjection,
  IntegrationRevocationRequest,
  IntegrationTokenExchangeRequest,
  IntegrationTokenExchangeResult,
  IntegrationTokenRefreshRequest,
  IntegrationTokenRefreshResult,
} from './IntegrationProvider.js';
import { serializeConfiguredIntegrationStatus } from './IntegrationDtos.js';
import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
  type DnsLookupAddress,
} from './IntegrationPublicHostGuard.js';
import { createPinnedOutboundFactory, type PinnedOutboundFactory } from './PinnedOutboundFactory.js';
import { logger } from '../../../utils/logger.js';
import {
  canonicalizeIntegrationApiHost,
  IntegrationApiHostValidationError,
} from '../../security/IntegrationApiHosts.js';
import { readBoundedResponseText, ResponseBodyTooLargeError } from './BoundedResponseReader.js';

const DEFAULT_OUTBOUND_TIMEOUT_MS = 10_000;
const MAX_TOKEN_ENDPOINT_RESPONSE_BYTES = 256 * 1024;
const RESERVED_AUTHORIZATION_PARAMS = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
]);

export interface ConfiguredOAuthIntegrationProviderConfig {
  readonly descriptor: IntegrationDescriptorRecord;
  readonly clientSecret: string;
  readonly pinnedOutbound?: PinnedOutboundFactory;
  readonly dnsLookup?: DnsLookup;
  /** Bounds each outbound token-endpoint call so a hung provider cannot hold a refresh row lock open. */
  readonly requestTimeoutMs?: number;
}

/** A token-endpoint response with its body already consumed, so the pinned socket pool can close. */
interface TokenEndpointResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

export class ConfiguredOAuthIntegrationProvider implements IIntegrationProvider {
  readonly descriptor;
  readonly integrationDescriptorId;
  readonly authorizationConfigured = true;
  readonly credentialStrategy = 'oauth2_authorization_code';

  private readonly pinnedOutboundFactory: PinnedOutboundFactory;
  private readonly dnsLookupImpl: DnsLookup;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfiguredOAuthIntegrationProviderConfig) {
    if (config.descriptor.authStrategy !== 'oauth2_authorization_code' || !config.descriptor.oauth) {
      throw new Error('configured OAuth provider requires an OAuth descriptor');
    }
    if (!config.clientSecret) throw new Error('configured OAuth provider requires clientSecret');
    const revocationUrl = readString(config.descriptor.oauth.tokenExchange, 'revocationUrl');
    if (revocationUrl) validatePublicHttpsUrl(revocationUrl, 'oauth.tokenExchange.revocationUrl');
    this.descriptor = {
      id: config.descriptor.provider,
      displayName: config.descriptor.displayName,
      category: config.descriptor.category,
    };
    this.integrationDescriptorId = config.descriptor.id;
    this.pinnedOutboundFactory = config.pinnedOutbound ?? createPinnedOutboundFactory();
    this.dnsLookupImpl = config.dnsLookup ?? dnsLookup;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  }

  createAuthorizationUrl(request: IntegrationAuthorizationRequest): string {
    const oauth = this.oauthDescriptor();
    const url = new URL(oauth.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oauth.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    if (oauth.scopes.length > 0) url.searchParams.set('scope', oauth.scopes.join(' '));
    if (oauth.pkce !== 'unsupported') {
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    }
    for (const [key, value] of Object.entries(stringRecord(readRecord(oauth.tokenExchange.authorizationParams)))) {
      if (RESERVED_AUTHORIZATION_PARAMS.has(key.toLowerCase())) continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async exchangeAuthorizationCode(
    request: IntegrationTokenExchangeRequest,
  ): Promise<IntegrationTokenExchangeResult> {
    const oauth = this.oauthDescriptor();
    const response = await this.guardedTokenEndpointFetch('token', oauth.tokenUrl, {
      ...tokenRequestInit({
        clientId: oauth.clientId,
        clientSecret: this.config.clientSecret,
        code: request.code,
        redirectUri: request.redirectUri,
        codeVerifier: oauth.pkce === 'unsupported' ? null : request.codeVerifier,
        tokenExchange: oauth.tokenExchange,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      // Fail closed on redirects: client_secret/PKCE are sent to the token URL,
      // so a 3xx must never replay them to a redirect target.
      redirect: 'error',
    });
    if (!response.ok) {
      logger.warn('Configured OAuth token exchange failed', {
        provider: this.descriptor.id,
        status: response.status,
      });
      throw new Error('configured_oauth_token_exchange_failed');
    }
    const body = response.body;
    const accessToken = readString(body, 'access_token');
    if (!accessToken) throw new Error('configured_oauth_token_exchange_failed');
    return {
      accountLabel: accountLabelFromTokenResponse(body, oauth.accountLabel),
      externalInstallationId: null,
      authorizedPermissions: { scopes: oauth.scopes },
      accessToken,
      refreshToken: readString(body, 'refresh_token'),
    };
  }

  async refreshCredentials(request: IntegrationTokenRefreshRequest): Promise<IntegrationTokenRefreshResult> {
    const oauth = this.oauthDescriptor();
    if (oauth.refresh === 'none') throw new Error('configured_oauth_refresh_not_supported');
    const response = await this.guardedTokenEndpointFetch('token', oauth.tokenUrl, {
      ...refreshTokenRequestInit({
        clientId: oauth.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken: request.refreshToken,
        tokenExchange: oauth.tokenExchange,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      // Fail closed on redirects: client_secret/refresh_token are sent to the
      // token URL, so a 3xx must never replay them to a redirect target.
      redirect: 'error',
    });
    if (!response.ok) {
      logger.warn('Configured OAuth token refresh failed', {
        provider: this.descriptor.id,
        status: response.status,
      });
      throw new Error('configured_oauth_token_refresh_failed');
    }
    const body = response.body;
    const accessToken = readString(body, 'access_token');
    if (!accessToken) throw new Error('configured_oauth_token_refresh_failed');
    return {
      accessToken,
      refreshToken: readString(body, 'refresh_token') ?? undefined,
    };
  }

  async revokeCredentials(request: IntegrationRevocationRequest): Promise<void> {
    if (!request.accessToken) {
      logger.warn('Configured OAuth revocation skipped: no access token to present', {
        provider: this.descriptor.id,
      });
      return;
    }
    const oauth = this.oauthDescriptor();
    const revocationUrl = readString(oauth.tokenExchange, 'revocationUrl');
    if (!revocationUrl) return;
    const response = await this.guardedTokenEndpointFetch('revocation', revocationUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: this.config.clientSecret,
        token: request.accessToken,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      // Fail closed on redirects: client_secret + token are sent to the
      // revocation URL, so a 3xx must never replay them to a redirect target.
      redirect: 'error',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error('configured_oauth_revocation_failed');
    }
  }

  projectStatus(record: UserIntegrationRecord | null): IntegrationProviderStatusProjection {
    return { body: serializeConfiguredIntegrationStatus(this.descriptor, record) };
  }

  private oauthDescriptor() {
    const oauth = this.config.descriptor.oauth;
    if (!oauth) throw new Error('configured OAuth provider requires an OAuth descriptor');
    return oauth;
  }

  /**
   * POST to a descriptor-controlled token endpoint through the same
   * resolve-once-and-pin guard as the data path. The host must resolve to
   * public addresses BEFORE any secret leaves the process, and the connection
   * is pinned to the vetted address so a connect-time re-resolution cannot
   * retarget it. Fails closed on resolution failure or a non-public address.
   */
  private async guardedTokenEndpointFetch(
    endpoint: 'token' | 'revocation',
    urlValue: string,
    init: RequestInit,
  ): Promise<TokenEndpointResponse> {
    const url = new URL(urlValue);
    let canonicalHostname: string;
    let vetted: DnsLookupAddress;
    try {
      canonicalHostname = canonicalizeIntegrationApiHost(url.hostname, `oauth.${endpoint} endpoint host`);
      vetted = await assertPublicResolvedHost(canonicalHostname, this.dnsLookupImpl);
    } catch (error) {
      if (error instanceof IntegrationApiHostValidationError) {
        logger.warn('Configured OAuth endpoint host rejected by canonical host policy', {
          provider: this.descriptor.id,
          endpoint,
        });
        throw new Error('configured_oauth_endpoint_not_allowed');
      }
      if (error instanceof PublicHostGuardError) {
        logger.warn('Configured OAuth endpoint host rejected by public-host guard', {
          provider: this.descriptor.id,
          endpoint,
          reason: error.reason,
        });
        throw new Error(error.reason === 'resolution_failed'
          ? 'configured_oauth_endpoint_resolution_failed'
          : 'configured_oauth_endpoint_not_allowed');
      }
      throw error;
    }
    const outbound = this.pinnedOutboundFactory({
      hostname: canonicalHostname,
      address: vetted.address,
      family: vetted.family,
    });
    try {
      const response = await outbound.fetch(urlValue, init);
      return { ok: response.ok, status: response.status, body: await readBoundedJson(response) };
    } finally {
      await outbound.close();
    }
  }
}

function tokenRequestInit(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string | null;
  readonly tokenExchange: Readonly<Record<string, unknown>>;
}): RequestInit {
  const clientAuth = readString(input.tokenExchange, 'clientAuth') ?? 'body';
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
  };
  if (input.codeVerifier) fields.code_verifier = input.codeVerifier;
  if (clientAuth !== 'basic' && clientAuth !== 'none') {
    fields.client_id = input.clientId;
    fields.client_secret = input.clientSecret;
  } else if (clientAuth === 'none') {
    fields.client_id = input.clientId;
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (clientAuth === 'basic') {
    const basicAuth = Buffer.from(`${input.clientId}:${input.clientSecret}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${basicAuth}`;
  }
  return {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields),
  };
}

function refreshTokenRequestInit(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly tokenExchange: Readonly<Record<string, unknown>>;
}): RequestInit {
  const clientAuth = readString(input.tokenExchange, 'clientAuth') ?? 'body';
  const fields: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  };
  if (clientAuth !== 'basic' && clientAuth !== 'none') {
    fields.client_id = input.clientId;
    fields.client_secret = input.clientSecret;
  } else if (clientAuth === 'none') {
    fields.client_id = input.clientId;
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (clientAuth === 'basic') {
    const basicAuth = Buffer.from(`${input.clientId}:${input.clientSecret}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${basicAuth}`;
  }
  return {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields),
  };
}

function accountLabelFromTokenResponse(
  body: unknown,
  accountLabel: Readonly<Record<string, unknown>>,
): string | null {
  const field = readString(accountLabel, 'field') ?? readString(accountLabel, 'tokenResponseField');
  return field ? readString(body, field) : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await readBoundedResponseText(response, MAX_TOKEN_ENDPOINT_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new Error('configured_oauth_endpoint_response_too_large');
    }
    throw error;
  }

  try {
    const jsonText = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
    return JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown, key: string): string | null {
  const field = readRecord(value)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function stringRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string' && field.length > 0) output[key] = field;
  }
  return output;
}

function validatePublicHttpsUrl(value: string, name: string): void {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be HTTPS without credentials or fragments`);
  }
  validatePublicDnsHost(url.hostname, name);
}

function validatePublicDnsHost(host: string, name: string): void {
  const normalized = host.toLowerCase();
  if (host !== normalized ||
      !normalized.includes('.') ||
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized.endsWith('.local') ||
      normalized.endsWith('.internal') ||
      isIP(normalized) !== 0 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new Error(`${name} must be a public DNS hostname`);
  }
}
