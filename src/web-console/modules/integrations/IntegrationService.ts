import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { SecurityMonitor } from '../../../security/securityMonitor.js';
import {
  CONSOLE_INTEGRATION_STATE_COOKIE,
  readCookie,
} from '../../middleware/ConsoleCookies.js';
import type {
  ConsoleAuthenticatedContext,
  ConsoleHandlerResult,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { logger } from '../../../utils/logger.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { normalizeConsoleReturnPath } from '../../platform/ConsoleReturnPaths.js';
import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { ILoginTransactionStore } from '../../stores/ILoginTransactionStore.js';
import type { IUserIntegrationStore, UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';
import { isWellFormedUnicode } from '../../stores/ConsoleStoreValidation.js';
import {
  serializeIntegrationList,
} from './IntegrationDtos.js';
import type {
  IIntegrationSecurityEventSink,
  IntegrationCallbackRejectedReason,
} from './IntegrationSecurityEvents.js';
import { integrationSecretContext, type IntegrationSecretContext } from './IntegrationSecretContext.js';
import type { IntegrationProviderResolver } from './CuratedIntegrationProviders.js';
import type { IIntegrationProvider } from './IntegrationProvider.js';
import type { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';

const INTEGRATION_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 32;
const PKCE_SECRET_CLASS = 'pkce_verifier';
const INTEGRATION_PATH = '/api/v1/me/integrations';

export class IntegrationService {
  constructor(private readonly options: {
    readonly store: IUserIntegrationStore;
    readonly providers: IntegrationProviderRegistry;
    /**
     * Per-request fallback consulted when the boot-time registry has no
     * provider for the id — how runtime-authored BYO descriptors become
     * connectable without a restart.
     */
    readonly resolveProvider?: IntegrationProviderResolver | null;
    readonly loginTransactions?: ILoginTransactionStore | null;
    readonly opaqueValues?: IConsoleOpaqueValueService | null;
    readonly secretEncryption?: ISecretEncryptionService | null;
    readonly publicBaseUrl?: string | null;
    readonly securityEventSink?: IIntegrationSecurityEventSink | null;
    readonly now?: () => Date;
  }) {
    // Warn once at construction (not per request) if the configured public base URL has a
    // path component: OAuth callback URIs are built from the absolute INTEGRATION_PATH, so any
    // path on the base URL (e.g. https://host/console) is silently dropped from the callback.
    const baseUrl = this.options.publicBaseUrl;
    if (baseUrl) {
      try {
        const { origin, pathname } = new URL(baseUrl);
        if (pathname !== '/' && pathname !== '') {
          logger.warn('Integration public base URL has a path component that is ignored when building OAuth callback URIs', {
            publicBaseUrl: `${origin}${pathname}`,
          });
        }
      } catch {
        // An invalid base URL is surfaced later when providerCallbackUri constructs the URL.
      }
    }
  }

  async list(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const records = await this.options.store.listByUser(auth.userId);
    return {
      status: 200,
      body: serializeIntegrationList(records, this.options.providers.listDescriptors()),
    };
  }

  async getGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.getProvider(req, 'github' as UserIntegrationProvider);
  }

  async getProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const provider = await this.resolveProviderFor(auth.userId, providerId);
    if (!provider) return providerNotFound(providerId);
    const record = await this.options.store.findByProvider(auth.userId, providerId);
    return {
      status: 200,
      body: provider.projectStatus(this.recordOwnedByProvider(provider, record) ? record : null).body,
    };
  }

  async connectGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.connectProvider(req, 'github' as UserIntegrationProvider);
  }

  async connectProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const provider = await this.resolveProviderFor(auth.userId, providerId);
    if (!provider) return providerNotFound(providerId);
    if (provider.credentialStrategy === 'static_api_key') {
      const deps = this.credentialDependencies(provider);
      if (!deps) return serviceUnavailable(`${providerId} integration linking is not configured.`);
      return this.captureStaticApiKey(req, auth, deps);
    }
    const deps = this.writeDependencies(provider);
    if (!deps) return serviceUnavailable(`${providerId} integration linking is not configured.`);
    const now = this.now();
    const transactionId = deps.opaqueValues.createOpaqueValue();
    const state = deps.opaqueValues.createOpaqueValue();
    const pkceVerifier = createPkceVerifier();
    const pkceVerifierEnc = deps.secretEncryption.encrypt(
      Buffer.from(pkceVerifier, 'utf8'),
      pkceContext(transactionId),
    );
    const contentsPermission = requestedContentsPermission(req.body);
    const redirectUri = this.providerCallbackUri(providerId);
    await deps.loginTransactions.create({
      idHash: deps.opaqueValues.hashOpaqueValue(transactionId),
      flowKind: 'integration_link',
      stateHash: deps.opaqueValues.hashOpaqueValue(state),
      pkceVerifierEnc,
      userId: auth.userId,
      consoleSessionIdHash: Buffer.from(auth.sessionIdHash),
      requestedCapability: null,
      integrationDescriptorId: deps.provider.integrationDescriptorId ?? null,
      integrationDescriptorFingerprint: deps.provider.integrationDescriptorFingerprint ?? null,
      returnTo: readBodyReturnTo(req.body),
      createdAt: now,
      expiresAt: new Date(now.getTime() + INTEGRATION_TRANSACTION_TTL_MS),
      consumedAt: null,
    });
    logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'GitHub integration link flow started', {
      userId: auth.userId,
      contentsPermission,
    });
    return {
      // Return the authorization URL in the body (not a 302): the console is an
      // SPA driven by fetch, which can't follow a cross-origin redirect, and CSRF
      // is header-only so a plain form POST can't drive this. The browser does
      // window.location = authorize_url. (Slice B's /:provider/connect matches.)
      status: 200,
      body: {
        authorize_url: deps.provider.createAuthorizationUrl({
          state,
          codeChallenge: createPkceChallenge(pkceVerifier),
          codeChallengeMethod: 'S256',
          redirectUri,
          requestedPermissions: contentsPermission,
        }),
      },
      cookies: [{ operation: 'set', name: CONSOLE_INTEGRATION_STATE_COOKIE, value: transactionId }],
    };
  }

  async completeGitHubCallback(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.completeProviderCallback(req, 'github' as UserIntegrationProvider);
  }

  async completeProviderCallback(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const provider = await this.resolveProviderFor(auth.userId, providerId);
    const deps = this.writeDependencies(provider);
    if (!deps) return failedIntegrationCallback();
    const transactionId = readCookie(req.headers.cookie, CONSOLE_INTEGRATION_STATE_COOKIE);
    const code = singleQueryValue(req.query.code);
    const state = singleQueryValue(req.query.state);
    if (!transactionId || !code || !state) {
      await this.recordCallbackRejected(providerId, auth.userId, 'missing');
      return failedIntegrationCallback();
    }

    const idHash = deps.opaqueValues.hashOpaqueValue(transactionId);
    const now = this.now();
    const transaction = await deps.loginTransactions.consume(
      idHash,
      deps.opaqueValues.hashOpaqueValue(state),
      now,
    );
    if (transaction?.flowKind !== 'integration_link') {
      await this.recordCallbackRejected(
        providerId,
        auth.userId,
        await this.classifyMissingTransaction(deps.loginTransactions, idHash, now),
      );
      return failedIntegrationCallback();
    }
    try {
    if (transaction.userId !== auth.userId) {
      await this.recordCallbackRejected(providerId, auth.userId, 'user_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    if (!transaction.consoleSessionIdHash ||
        !buffersEqual(transaction.consoleSessionIdHash, auth.sessionIdHash)) {
      await this.recordCallbackRejected(providerId, auth.userId, 'session_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    // The provider resolved before consume is sufficient only for the
    // transaction-store dependencies. Re-resolve after the one-time state is
    // consumed so descriptor updates cannot leave this callback comparing and
    // exchanging against the stale provider snapshot loaded at request entry.
    const currentProvider = await this.resolveProviderFor(auth.userId, providerId);
    const currentDeps = this.writeDependencies(currentProvider);
    if (!currentDeps) {
      await this.recordCallbackRejected(providerId, auth.userId, 'descriptor_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    if ((transaction.integrationDescriptorId ?? null) !==
        (currentDeps.provider.integrationDescriptorId ?? null)) {
      await this.recordCallbackRejected(providerId, auth.userId, 'descriptor_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    if ((transaction.integrationDescriptorFingerprint ?? null) !==
        (currentDeps.provider.integrationDescriptorFingerprint ?? null)) {
      await this.recordCallbackRejected(providerId, auth.userId, 'descriptor_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    let pkceVerifier;
    try {
      pkceVerifier = currentDeps.secretEncryption.decrypt(
        transaction.pkceVerifierEnc,
        pkceContext(transactionId),
      ).toString('utf8');
    } catch {
      await this.recordCallbackRejected(providerId, auth.userId, 'consumed');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    let exchanged;
    try {
      exchanged = await currentDeps.provider.exchangeAuthorizationCode({
        code,
        codeVerifier: pkceVerifier,
        redirectUri: this.providerCallbackUri(providerId),
        providerCallbackParams: stringQueryParams(req.query),
      });
    } catch {
      try {
        await this.options.store.recordError({
          userId: auth.userId,
          provider: providerId,
          integrationDescriptorId: transaction.integrationDescriptorId ?? null,
          errorReason: 'token_exchange_failed',
          occurredAt: this.now(),
        });
      } catch {
        await this.recordCallbackRejected(providerId, auth.userId, 'credential_persistence_failed');
      }
      logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'GitHub integration token exchange failed', {
        userId: auth.userId,
      });
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    const connectedAt = this.now();
    try {
      await this.options.store.connect({
        userId: auth.userId,
        provider: providerId,
        integrationDescriptorId: transaction.integrationDescriptorId ?? null,
        externalAccountLabel: exchanged.accountLabel,
        externalInstallationId: exchanged.externalInstallationId,
        authorizedPermissions: exchanged.authorizedPermissions,
        accessTokenCiphertext: currentDeps.secretEncryption.encrypt(
          Buffer.from(exchanged.accessToken, 'utf8'),
          integrationSecretContext('access_token', auth.userId, providerId),
        ),
        refreshTokenCiphertext: exchanged.refreshToken
          ? currentDeps.secretEncryption.encrypt(
            Buffer.from(exchanged.refreshToken, 'utf8'),
            integrationSecretContext('refresh_token', auth.userId, providerId),
          )
          : null,
        connectedAt,
      });
    } catch {
      await this.revokeExchangedCredentials(currentDeps.provider, exchanged);
      await this.recordCallbackRejected(providerId, auth.userId, 'credential_persistence_failed');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'Integration connected', {
      userId: auth.userId,
      provider: providerId,
      authorizedPermissions: exchanged.authorizedPermissions,
    });

    return {
      status: 302,
      redirectTo: transaction.returnTo ?? INTEGRATION_PATH,
      cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
    };
    } finally {
      try {
        await deps.loginTransactions.completeConsumed(idHash);
      } catch (error) {
        // A stale consumed row only delays descriptor mutation until its
        // ten-minute expiry; it must not replace the callback's real result.
        logger.warn('Failed to release completed integration login transaction', {
          provider: providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async disconnectGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.disconnectProvider(req, 'github' as UserIntegrationProvider);
  }

  async disconnectProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const provider = await this.resolveProviderFor(auth.userId, providerId);
    const deps = this.credentialDependencies(provider);
    if (!deps) return serviceUnavailable(`${providerId} integration disconnect is not configured.`);
    const active = await this.options.store.findByProvider(auth.userId, providerId);
    if (active) {
      const revoked = this.recordOwnedByProvider(deps.provider, active)
        ? await this.revokeRemoteCredentials(deps, auth, active)
        : true;
      if (!revoked) {
        const errorRecord = await this.options.store.recordError({
          userId: auth.userId,
          provider: providerId,
          integrationDescriptorId: active.integrationDescriptorId ?? null,
          errorReason: 'revocation_failed',
          occurredAt: this.now(),
        });
        return {
          status: 200,
          body: deps.provider.projectStatus(errorRecord).body,
        };
      }
      await this.options.store.disconnect({
        userId: auth.userId,
        provider: providerId,
        revokedAt: this.now(),
      });
      logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'Integration disconnected', {
        userId: auth.userId,
        provider: providerId,
      });
    }
    return {
      status: 200,
      body: deps.provider.projectStatus(null).body,
    };
  }

  private async revokeRemoteCredentials(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    auth: ConsoleAuthenticatedContext,
    active: NonNullable<Awaited<ReturnType<IUserIntegrationStore['findByProvider']>>>,
  ): Promise<boolean> {
    const accessToken = active.accessTokenCiphertext
      ? decryptNullable(
        deps.secretEncryption,
        active.accessTokenCiphertext,
        integrationSecretContext('access_token', auth.userId, active.provider),
        auth.userId,
        active.provider,
      )
      : null;
    const refreshToken = active.refreshTokenCiphertext
      ? decryptNullable(
        deps.secretEncryption,
        active.refreshTokenCiphertext,
        integrationSecretContext('refresh_token', auth.userId, active.provider),
        auth.userId,
        active.provider,
      )
      : null;
    try {
      await deps.provider.revokeCredentials({
        accessToken,
        refreshToken,
        externalInstallationId: active.externalInstallationId,
      });
      return true;
    } catch {
      // Local credential invalidation still proceeds so no future console path
      // can use the stored credentials. Structured event persistence lands with
      // the self-security/user-event sink.
      return false;
    }
  }

  private recordOwnedByProvider(
    provider: IIntegrationProvider,
    record: Awaited<ReturnType<IUserIntegrationStore['findByProvider']>>,
  ): boolean {
    return (record?.integrationDescriptorId ?? null) ===
      (provider.integrationDescriptorId ?? null);
  }

  /** Boot-time registry first, then the per-request store-backed fallback. */
  private async resolveProviderFor(
    userId: string,
    providerId: UserIntegrationProvider,
  ): Promise<IIntegrationProvider | null> {
    const registered = this.options.providers.get(providerId);
    if (registered) return registered;
    if (!this.options.resolveProvider) return null;
    return this.options.resolveProvider(userId, providerId);
  }

  private writeDependencies(provider: IIntegrationProvider | null): {
    readonly loginTransactions: ILoginTransactionStore;
    readonly opaqueValues: IConsoleOpaqueValueService;
    readonly secretEncryption: ISecretEncryptionService;
    readonly provider: IIntegrationProvider;
  } | null {
    if (!this.options.loginTransactions ||
        !this.options.opaqueValues ||
        !this.options.secretEncryption ||
        !this.options.publicBaseUrl ||
        provider?.credentialStrategy === 'static_api_key' ||
        !provider?.authorizationConfigured) {
      return null;
    }
    return {
      loginTransactions: this.options.loginTransactions,
      opaqueValues: this.options.opaqueValues,
      secretEncryption: this.options.secretEncryption,
      provider,
    };
  }

  private async captureStaticApiKey(
    req: ConsoleRequest,
    auth: ConsoleAuthenticatedContext,
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
  ): Promise<ConsoleHandlerResult> {
    const { provider, secretEncryption } = deps;
    const captured = provider.staticApiKeyInjection?.location === 'basic'
      ? readBasicCredential(req.body)
      : readApiKeyCredential(req.body);
    if ('error' in captured) return captured.error;
    const connectedAt = this.now();
    const record = await this.options.store.connect({
      userId: auth.userId,
      provider: provider.descriptor.id,
      integrationDescriptorId: provider.integrationDescriptorId ?? null,
      externalAccountLabel: readBodyAccountLabel(req.body) ?? captured.defaultAccountLabel,
      externalInstallationId: null,
      authorizedPermissions: { scopes: [] },
      accessTokenCiphertext: secretEncryption.encrypt(
        Buffer.from(captured.credential, 'utf8'),
        integrationSecretContext('access_token', auth.userId, provider.descriptor.id),
      ),
      refreshTokenCiphertext: null,
      connectedAt,
    });
    return {
      status: 200,
      body: provider.projectStatus(record).body,
    };
  }

  private credentialDependencies(provider: IIntegrationProvider | null): {
    readonly secretEncryption: ISecretEncryptionService;
    readonly provider: IIntegrationProvider;
  } | null {
    if (!this.options.secretEncryption || !provider?.authorizationConfigured) {
      return null;
    }
    return {
      secretEncryption: this.options.secretEncryption,
      provider,
    };
  }

  private async revokeExchangedCredentials(
    provider: IIntegrationProvider,
    exchanged: Awaited<ReturnType<IIntegrationProvider['exchangeAuthorizationCode']>>,
  ): Promise<void> {
    try {
      await provider.revokeCredentials({
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken ?? null,
        externalInstallationId: exchanged.externalInstallationId,
      });
    } catch {
      // The local credential write failed closed. Remote revocation is best-effort
      // and must not revive or expose the rejected callback.
    }
  }

  private async classifyMissingTransaction(
    loginTransactions: ILoginTransactionStore,
    idHash: Buffer,
    now: Date,
  ): Promise<IntegrationCallbackRejectedReason> {
    const existing = await loginTransactions.findByIdHash(idHash);
    if (!existing) return 'missing';
    if (existing.consumedAt) return 'consumed';
    return existing.expiresAt <= now ? 'expired' : 'consumed';
  }

  private async recordCallbackRejected(
    provider: UserIntegrationProvider,
    userId: string | null,
    reason: IntegrationCallbackRejectedReason,
  ): Promise<void> {
    logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'GitHub integration callback rejected', {
      userId,
      reason,
    });
    try {
      await this.options.securityEventSink?.recordIntegrationCallbackRejected({
        type: 'console.auth.integration_callback_rejected.v1',
        userId,
        provider,
        reason,
        occurredAt: this.now(),
      });
    } catch {
      // A security-event sink failure cannot make callback rejection observable
      // to the browser or revive a failed OAuth transaction.
    }
  }

  private providerCallbackUri(providerId: UserIntegrationProvider): string {
    if (!this.options.publicBaseUrl) throw new Error('Integration public base URL is not configured');
    return new URL(`${INTEGRATION_PATH}/${providerId}/callback`, normalizeBaseUrl(this.options.publicBaseUrl)).toString();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function createPkceVerifier(): string {
  return randomBytes(PKCE_VERIFIER_BYTES).toString('base64url');
}

function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function pkceContext(transactionId: string): { readonly secretClass: string; readonly ownerId: string } {
  return { secretClass: PKCE_SECRET_CLASS, ownerId: `integration:${transactionId}` };
}

function decryptNullable(
  secretEncryption: ISecretEncryptionService,
  ciphertext: Buffer,
  context: IntegrationSecretContext,
  userId: string,
  provider: UserIntegrationProvider,
): string | null {
  try {
    return secretEncryption.decrypt(ciphertext, context).toString('utf8');
  } catch {
    logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'Integration credential decrypt failed', {
      userId,
      provider,
      secretClass: context.secretClass,
    });
    return null;
  }
}

function requestedContentsPermission(body: unknown): Readonly<Record<string, unknown>> {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { contents_permission: record.contents_permission === 'write' ? 'write' : 'read' };
}

function readBodyReturnTo(body: unknown): string {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return normalizeConsoleReturnPath(record.return_to, INTEGRATION_PATH);
}

function readBodyAccountLabel(body: unknown): string | null {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return typeof record.account_label === 'string' && record.account_label.trim() !== ''
    ? record.account_label.trim().slice(0, 200)
    : null;
}

function readStaticApiKey(body: unknown): string | null {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof record.api_key !== 'string') return null;
  const value = record.api_key.trim();
  if (value.length === 0 || !isWellFormedUnicode(value) || Buffer.byteLength(value, 'utf8') > 8192) {
    return null;
  }
  return value;
}

type CapturedStaticCredential =
  | { readonly credential: string; readonly defaultAccountLabel: string | null }
  | { readonly error: ConsoleHandlerResult };

function readApiKeyCredential(body: unknown): CapturedStaticCredential {
  const apiKey = readStaticApiKey(body);
  if (!apiKey) return { error: badRequest('invalid_static_api_key', 'A valid, non-empty api_key is required.') };
  return { credential: apiKey, defaultAccountLabel: null };
}

/**
 * Basic-injection providers capture the two-part credential and store it as
 * `username:password` (RFC 7617); the gateway base64-encodes at injection
 * time. The username must not contain `:` — it would shift the password
 * boundary the upstream decodes.
 */
function readBasicCredential(body: unknown): CapturedStaticCredential {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const username = typeof record.username === 'string' ? record.username.trim() : '';
  const password = typeof record.password === 'string' ? record.password : '';
  if (username.length === 0 || password.length === 0 ||
      !isWellFormedUnicode(username) || !isWellFormedUnicode(password)) {
    return { error: badRequest('invalid_basic_credential', 'Valid, non-empty username and password are required.') };
  }
  if (username.includes(':')) {
    return { error: badRequest('invalid_basic_credential', 'username must not contain ":".') };
  }
  const credential = `${username}:${password}`;
  if (Buffer.byteLength(credential, 'utf8') > 8192) {
    return { error: badRequest('invalid_basic_credential', 'Credential is too large.') };
  }
  return { credential, defaultAccountLabel: username.slice(0, 200) };
}

function singleQueryValue(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function stringQueryParams(query: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value !== '') params[key] = value;
  }
  return params;
}

function providerNotFound(providerId: string): ConsoleHandlerResult {
  return {
    status: 404,
    body: {
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      code: 'integration_provider_not_found',
      detail: `Integration provider '${providerId}' is not registered.`,
    },
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function failedIntegrationCallback(returnTo = INTEGRATION_PATH): ConsoleHandlerResult {
  return {
    status: 302,
    redirectTo: normalizeConsoleReturnPath(returnTo, INTEGRATION_PATH),
    cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
  };
}

function serviceUnavailable(detail: string): ConsoleHandlerResult {
  return {
    status: 503,
    body: {
      type: 'about:blank',
      title: 'Service unavailable',
      status: 503,
      code: 'service_unavailable',
      detail,
    },
  };
}

function badRequest(code: string, detail: string): ConsoleHandlerResult {
  return {
    status: 400,
    body: {
      type: 'about:blank',
      title: 'Bad request',
      status: 400,
      code,
      detail,
    },
  };
}

function logIntegrationSecurityEvent(
  type: 'OPERATION_COMPLETED' | 'OPERATION_FAILED',
  severity: 'LOW' | 'MEDIUM',
  details: string,
  additionalData?: Record<string, unknown>,
): void {
  SecurityMonitor.logSecurityEvent({
    type,
    severity,
    source: 'IntegrationService',
    details,
    additionalData,
  });
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
