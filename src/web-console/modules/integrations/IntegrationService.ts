import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

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
import type {
  ConsoleLoginTransaction,
  ILoginTransactionStore,
} from '../../stores/ILoginTransactionStore.js';
import type {
  IUserIntegrationStore,
  UserIntegrationConnectInput,
  UserIntegrationProvider,
  UserIntegrationRecord,
} from '../../stores/IUserIntegrationStore.js';
import {
  hasIntegrationCredentials,
  IntegrationAlreadyConnectedError,
  IntegrationCredentialCleanupPendingError,
} from '../../stores/IUserIntegrationStore.js';
import {
  IntegrationDescriptorChangedError,
  isWellFormedUnicode,
} from '../../stores/ConsoleStoreValidation.js';
import {
  serializeIntegrationList,
} from './IntegrationDtos.js';
import type {
  IIntegrationSecurityEventSink,
  IntegrationCallbackRejectedReason,
} from './IntegrationSecurityEvents.js';
import { integrationSecretContext, type IntegrationSecretContext } from './IntegrationSecretContext.js';
import type {
  IntegrationCleanupProviderResolver,
  IntegrationProviderResolver,
} from './CuratedIntegrationProviders.js';
import type { IIntegrationProvider } from './IntegrationProvider.js';
import { isMintedIntegrationCredentialsError } from './IntegrationProvider.js';
import type { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';
import { isSafelyRedactableCredential } from './IntegrationCredentialRedactor.js';
import { beginIntegrationCleanup, settleIntegrationCleanup } from './IntegrationCleanup.js';

const INTEGRATION_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 32;
const PKCE_SECRET_CLASS = 'pkce_verifier';
const INTEGRATION_PATH = '/api/v1/me/integrations';
const INTEGRATION_CREDENTIAL_CLEANUP_WAIT_MS = 1_000;
// Configured OAuth providers may revoke access and refresh credentials
// sequentially. The lease must exceed both bounded network/transport-close
// budgets so a second worker cannot reclaim cleanup while the first is live.
const INTEGRATION_CREDENTIAL_CLEANUP_LEASE_MS = 60_000;
const INTEGRATION_CREDENTIAL_CLEANUP_RENEW_MS = 20_000;
const CLEANUP_PERSISTENCE_RETRY_DELAYS_MS = [0, 25, 75] as const;

interface ConsumedProviderCallbackContext {
  readonly req: ConsoleRequest;
  readonly auth: ConsoleAuthenticatedContext;
  readonly providerId: UserIntegrationProvider;
  readonly transactionId: string;
  readonly idHash: Buffer;
  readonly transaction: ConsoleLoginTransaction;
}

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
    readonly resolveCleanupProvider?: IntegrationCleanupProviderResolver | null;
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
    const operationStartedAt = await this.options.store.captureCredentialOperationStartedAt(this.now());
    const provider = await this.resolveProviderFor(auth.userId, providerId);
    if (!provider) return providerNotFound(providerId);
    if (await this.options.store.hasCredentialCleanupPending(auth.userId, providerId)) {
      return cleanupMustFinishConflict();
    }
    const existing = await this.options.store.findByProvider(auth.userId, providerId);
    if (existing) {
      if (hasIntegrationCredentials(existing)) return integrationAlreadyConnectedConflict();
      await this.options.store.disconnect({
        userId: auth.userId,
        provider: providerId,
        integrationId: existing.id,
        credentialGeneration: existing.credentialGeneration,
        revokedAt: this.now(),
      });
    }
    if (provider.credentialStrategy === 'static_api_key') {
      const deps = this.credentialDependencies(provider);
      if (!deps) return serviceUnavailable(`${providerId} integration linking is not configured.`);
      return this.captureStaticApiKey(req, auth, deps, operationStartedAt);
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
    try {
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
    } catch (error) {
      if (error instanceof IntegrationDescriptorChangedError) {
        return descriptorChangedConflict();
      }
      throw error;
    }
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
      return await this.completeConsumedProviderCallback({
        req,
        auth,
        providerId,
        transactionId,
        idHash,
        transaction,
      }, code);
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

  private async completeConsumedProviderCallback(
    context: ConsumedProviderCallbackContext,
    code: string,
  ): Promise<ConsoleHandlerResult> {
    const { req, auth, providerId, transactionId, idHash, transaction } = context;
    const invalidTransaction = await this.validateConsumedIntegrationTransaction(
      transaction,
      auth,
      providerId,
    );
    if (invalidTransaction) return invalidTransaction;
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
    if (!this.descriptorBindingMatches(transaction, currentDeps.provider)) {
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
    } catch (error) {
      if (isMintedIntegrationCredentialsError(error)) {
        await this.preserveAndCleanMintedCredentials(
          currentDeps,
          auth.userId,
          transaction,
          error.accessToken,
          error.refreshToken,
        );
      }
      // A consumed callback can finish after a newer authorization succeeds.
      // Exchange failure is therefore audit-only; it must not revoke an active
      // connection whose generation this transaction does not own.
      await this.recordCallbackRejected(providerId, auth.userId, 'token_exchange_failed');
      logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'GitHub integration token exchange failed', {
        userId: auth.userId,
      });
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    if (!isSafelyRedactableCredential(exchanged.accessToken)) {
      await this.preserveAndCleanExchangedCredentials(
        currentDeps,
        auth.userId,
        transaction,
        exchanged,
      );
      await this.recordCallbackRejected(providerId, auth.userId, 'token_exchange_failed');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    const connectedAt = this.now();
    let connection: UserIntegrationConnectInput;
    try {
      connection = this.encryptProviderCredentialConnection(
        currentDeps,
        auth.userId,
        transaction,
        exchanged.accountLabel,
        exchanged.externalInstallationId,
        exchanged.authorizedPermissions,
        exchanged.accessToken,
        exchanged.refreshToken ?? null,
        connectedAt,
      );
    } catch {
      await this.revokeUntrackedCredential(
        currentDeps,
        exchanged.accessToken,
        exchanged.refreshToken ?? null,
        exchanged.externalInstallationId,
        'encryption_failed',
      );
      await this.recordCallbackRejected(providerId, auth.userId, 'credential_persistence_failed');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    try {
      const connected = await this.options.store.connectDescriptorCallback({
        transactionIdHash: idHash,
        descriptorId: transaction.integrationDescriptorId ?? null,
        descriptorFingerprint: transaction.integrationDescriptorFingerprint ?? null,
        authorizationStartedAt: transaction.createdAt,
        connection,
      });
      if (!connected) {
        await this.preserveAndCleanCredential(
          currentDeps,
          connection,
          exchanged.accessToken,
          exchanged.refreshToken ?? null,
        );
        await this.recordCallbackRejected(providerId, auth.userId, 'descriptor_mismatch');
        return failedIntegrationCallback(transaction.returnTo ?? undefined);
      }
    } catch {
      await this.preserveAndCleanCredential(
        currentDeps,
        connection,
        exchanged.accessToken,
        exchanged.refreshToken ?? null,
      );
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
  }

  async disconnectGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.disconnectProvider(req, 'github' as UserIntegrationProvider);
  }

  async disconnectProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const disconnectedAt = this.now();
    // One store transaction persists intent and removes the current credential
    // from execution before any mutable provider lookup can fail.
    const disconnected = await this.options.store.beginAuthorizationDisconnect(
      auth.userId,
      providerId,
      disconnectedAt,
    );
    const existingCleanup = await this.options.store.listCredentialCleanup(auth.userId, providerId);
    const descriptorId = disconnected?.integrationDescriptorId
      ?? existingCleanup[0]?.integrationDescriptorId
      ?? null;
    const provider = await this.resolveProviderFor(auth.userId, providerId)
      ?? (descriptorId
        ? await this.resolveProviderForCleanup(auth.userId, providerId, descriptorId)
        : null);
    const deps = this.credentialDependencies(provider);
    if (!deps) return serviceUnavailable(`${providerId} integration disconnect is not configured.`);
    if (disconnected && hasIntegrationCredentials(disconnected)) {
      if (!this.recordOwnedByProvider(deps.provider, disconnected)) {
        return cleanupPendingResponse();
      }
      if (!await this.cleanPendingCredential(deps, disconnected)) return cleanupPendingResponse();
    }
    if (disconnected) {
      logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'Integration disconnected', {
        userId: auth.userId,
        provider: providerId,
      });
    }
    if (!await this.cleanPendingCredentials(deps, auth.userId, providerId)) {
      return cleanupPendingResponse();
    }
    return {
      status: 200,
      body: deps.provider.projectStatus(null).body,
    };
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
    // Descriptor-backed providers are mutable deployment state. Re-resolve
    // them on every request so an already-running replica cannot bypass a
    // durable global disable through its boot-time registry snapshot.
    if (registered?.integrationDescriptorId && this.options.resolveProvider) {
      return this.options.resolveProvider(userId, providerId);
    }
    if (registered) return registered;
    return this.options.resolveProvider?.(userId, providerId) ?? null;
  }

  private async resolveProviderForCleanup(
    userId: string,
    providerId: UserIntegrationProvider,
    integrationDescriptorId: string,
  ): Promise<IIntegrationProvider | null> {
    const registered = this.options.providers.get(providerId);
    if (registered?.integrationDescriptorId === integrationDescriptorId) return registered;
    return this.options.resolveCleanupProvider?.(userId, providerId, integrationDescriptorId) ?? null;
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
    operationStartedAt: Date,
  ): Promise<ConsoleHandlerResult> {
    const { provider, secretEncryption } = deps;
    const captured = provider.staticApiKeyInjection?.location === 'basic'
      ? readBasicCredential(req.body)
      : readApiKeyCredential(req.body);
    if ('error' in captured) return captured.error;
    const connectedAt = this.now();
    const connection = {
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
      authorizationStartedAt: operationStartedAt,
      connectedAt,
    };
    let record: UserIntegrationRecord | null;
    try {
      if (provider.integrationDescriptorId && provider.integrationDescriptorFingerprint) {
        const connectDescriptorCredential = this.options.store.connectDescriptorCredential;
        record = connectDescriptorCredential
          ? await connectDescriptorCredential.call(this.options.store, {
            descriptorId: provider.integrationDescriptorId,
            descriptorFingerprint: provider.integrationDescriptorFingerprint,
            operationStartedAt,
            connection,
          })
          : null;
      } else {
        record = await this.options.store.connect(connection);
      }
    } catch (error) {
      if (error instanceof IntegrationCredentialCleanupPendingError) return cleanupMustFinishConflict();
      if (error instanceof IntegrationAlreadyConnectedError) return integrationAlreadyConnectedConflict();
      throw error;
    }
    if (!record) return descriptorChangedConflict();
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

  private async preserveAndCleanExchangedCredentials(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    userId: string,
    transaction: ConsoleLoginTransaction,
    exchanged: Awaited<ReturnType<IIntegrationProvider['exchangeAuthorizationCode']>>,
  ): Promise<void> {
    const connectedAt = this.now();
    try {
      await this.preserveAndCleanCredential(deps, this.encryptProviderCredentialConnection(
        deps,
        userId,
        transaction,
        exchanged.accountLabel,
        exchanged.externalInstallationId,
        exchanged.authorizedPermissions,
        exchanged.accessToken,
        exchanged.refreshToken ?? null,
        connectedAt,
      ), exchanged.accessToken, exchanged.refreshToken ?? null);
    } catch {
      await this.revokeUntrackedCredential(
        deps,
        exchanged.accessToken,
        exchanged.refreshToken ?? null,
        exchanged.externalInstallationId,
        'encryption_failed',
      );
    }
  }

  private async preserveAndCleanMintedCredentials(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    userId: string,
    transaction: ConsoleLoginTransaction,
    accessToken: string,
    refreshToken: string | null,
  ): Promise<void> {
    const providerId = deps.provider.descriptor.id;
    try {
      await this.preserveAndCleanCredential(deps, this.encryptProviderCredentialConnection(
        deps,
        userId,
        transaction,
        null,
        null,
        defaultAuthorizedPermissions(providerId),
        accessToken,
        refreshToken,
        this.now(),
      ), accessToken, refreshToken);
    } catch {
      await this.revokeUntrackedCredential(deps, accessToken, refreshToken, null, 'encryption_failed');
    }
  }

  private encryptProviderCredentialConnection(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    userId: string,
    transaction: ConsoleLoginTransaction,
    externalAccountLabel: string | null,
    externalInstallationId: string | null,
    authorizedPermissions: Readonly<Record<string, unknown>>,
    accessToken: string,
    refreshToken: string | null,
    connectedAt: Date,
  ): UserIntegrationConnectInput {
    const providerId = deps.provider.descriptor.id;
    return {
      userId,
      provider: providerId,
      integrationDescriptorId: transaction.integrationDescriptorId ?? null,
      externalAccountLabel,
      externalInstallationId,
      authorizedPermissions,
      accessTokenCiphertext: deps.secretEncryption.encrypt(
        Buffer.from(accessToken, 'utf8'),
        integrationSecretContext('access_token', userId, providerId),
      ),
      refreshTokenCiphertext: refreshToken
        ? deps.secretEncryption.encrypt(
          Buffer.from(refreshToken, 'utf8'),
          integrationSecretContext('refresh_token', userId, providerId),
        )
        : null,
      authorizationStartedAt: transaction.createdAt,
      connectedAt,
    };
  }

  private async revokeUntrackedCredential(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    accessToken: string,
    refreshToken: string | null,
    externalInstallationId: string | null,
    reason: string,
  ): Promise<void> {
    const cleanup = await settleIntegrationCleanup(
      () => deps.provider.revokeCredentials({ accessToken, refreshToken, externalInstallationId }),
      INTEGRATION_CREDENTIAL_CLEANUP_WAIT_MS,
    );
    if (cleanup !== 'completed') this.auditCredentialCleanupFailure(deps.provider, `${reason}:${cleanup}`);
  }

  private async preserveAndCleanCredential(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    connection: UserIntegrationConnectInput,
    accessToken: string,
    refreshToken: string | null,
  ): Promise<void> {
    let pending: UserIntegrationRecord;
    try {
      pending = await this.queueCredentialCleanupWithRetry({
        ...connection,
        cleanupRequestedAt: this.now(),
      });
    } catch (error) {
      this.auditCredentialCleanupFailure(deps.provider, 'persistence_failed', error);
      // Once the provider has minted a credential, failure to persist its
      // cleanup handle must fall back to immediate revocation. Leaving a valid,
      // untracked credential is worse than requiring the current grant to
      // reconnect when a provider revokes grant-wide.
      const cleanup = await settleIntegrationCleanup(
        () => deps.provider.revokeCredentials({
          accessToken,
          refreshToken,
          externalInstallationId: connection.externalInstallationId,
        }),
        INTEGRATION_CREDENTIAL_CLEANUP_WAIT_MS,
      );
      this.auditCredentialCleanupFailure(deps.provider, cleanup);
      return;
    }
    const active = await this.options.store.findByProvider(connection.userId, connection.provider);
    if (active) return;
    await this.cleanPendingCredential(deps, pending);
  }

  private async queueCredentialCleanupWithRetry(
    input: Parameters<IUserIntegrationStore['queueCredentialCleanup']>[0],
  ): Promise<UserIntegrationRecord> {
    let lastError: unknown;
    for (const delayMs of CLEANUP_PERSISTENCE_RETRY_DELAYS_MS) {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        return await this.options.store.queueCredentialCleanup(input);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('integration_cleanup_persistence_failed');
  }

  private async cleanPendingCredentials(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    userId: string,
    providerId: UserIntegrationProvider,
  ): Promise<boolean> {
    if (await this.options.store.findByProvider(userId, providerId)) return false;
    const pending = await this.options.store.listCredentialCleanup(userId, providerId);
    let complete = true;
    for (const record of pending) {
      if (!await this.cleanPendingCredential(deps, record)) complete = false;
    }
    return complete;
  }

  private async cleanPendingCredential(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    pending: UserIntegrationRecord,
  ): Promise<boolean> {
    if (!this.recordOwnedByProvider(deps.provider, pending)) {
      this.auditCredentialCleanupFailure(deps.provider, 'descriptor_mismatch');
      return false;
    }
    const cleanupLeaseId = randomUUID();
    const claimed = await this.options.store.claimCredentialCleanup({
      userId: pending.userId,
      provider: pending.provider,
      integrationId: pending.id,
      credentialGeneration: pending.credentialGeneration,
      cleanupLeaseId,
      leaseDurationMs: INTEGRATION_CREDENTIAL_CLEANUP_LEASE_MS,
    });
    if (!claimed) {
      const stillPending = await this.options.store.listCredentialCleanup(pending.userId, pending.provider);
      return !stillPending.some(record => record.id === pending.id);
    }
    pending = claimed;
    const accessToken = pending.accessTokenCiphertext
      ? decryptNullable(
        deps.secretEncryption,
        pending.accessTokenCiphertext,
        integrationSecretContext('access_token', pending.userId, pending.provider),
        pending.userId,
        pending.provider,
      )
      : null;
    const refreshToken = pending.refreshTokenCiphertext
      ? decryptNullable(
        deps.secretEncryption,
        pending.refreshTokenCiphertext,
        integrationSecretContext('refresh_token', pending.userId, pending.provider),
        pending.userId,
        pending.provider,
      )
      : null;
    if ((pending.accessTokenCiphertext && !accessToken)
        || (pending.refreshTokenCiphertext && !refreshToken)
        || (!accessToken && !refreshToken)) {
      this.auditCredentialCleanupFailure(deps.provider, 'decrypt_failed');
      await this.releaseCredentialCleanupClaim(pending, cleanupLeaseId);
      return false;
    }
    const cleanupAttempt = beginIntegrationCleanup(
      () => deps.provider.revokeCredentials({
        accessToken,
        refreshToken,
        externalInstallationId: pending.externalInstallationId,
      }),
      INTEGRATION_CREDENTIAL_CLEANUP_WAIT_MS,
    );
    const stopLeaseRenewal = this.maintainCredentialCleanupLease(deps.provider, pending, cleanupLeaseId);
    void cleanupAttempt.settlement.then(() => stopLeaseRenewal());
    const cleanup = await cleanupAttempt.result;
    if (cleanup !== 'completed') {
      this.auditCredentialCleanupFailure(deps.provider, cleanup);
      if (cleanup === 'failed') {
        await this.releaseCredentialCleanupClaim(pending, cleanupLeaseId);
      } else {
        void cleanupAttempt.settlement.then(async lateResult => {
          try {
            if (lateResult === 'completed') {
              await this.completeClaimedCredentialCleanup(pending, cleanupLeaseId);
            } else {
              await this.releaseCredentialCleanupClaim(pending, cleanupLeaseId);
            }
          } catch {
            this.auditCredentialCleanupFailure(deps.provider, 'failed');
          }
        });
      }
      return false;
    }
    return this.completeClaimedCredentialCleanup(pending, cleanupLeaseId);
  }

  private maintainCredentialCleanupLease(
    provider: IIntegrationProvider,
    pending: UserIntegrationRecord,
    cleanupLeaseId: string,
  ): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (stopped) return;
      timer = setTimeout(() => {
        void this.options.store.renewCredentialCleanupClaim({
          userId: pending.userId,
          provider: pending.provider,
          integrationId: pending.id,
          credentialGeneration: pending.credentialGeneration,
          cleanupLeaseId,
          leaseDurationMs: INTEGRATION_CREDENTIAL_CLEANUP_LEASE_MS,
        }).then(renewed => {
          if (!renewed) {
            stopped = true;
            this.auditCredentialCleanupFailure(provider, 'cleanup_lease_lost');
            return;
          }
          schedule();
        }).catch(() => {
          stopped = true;
          this.auditCredentialCleanupFailure(provider, 'cleanup_lease_renewal_failed');
        });
      }, INTEGRATION_CREDENTIAL_CLEANUP_RENEW_MS);
      timer.unref?.();
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private async completeClaimedCredentialCleanup(
    pending: UserIntegrationRecord,
    cleanupLeaseId: string,
  ): Promise<boolean> {
    const completed = await this.options.store.completeCredentialCleanup({
      userId: pending.userId,
      provider: pending.provider,
      integrationId: pending.id,
      credentialGeneration: pending.credentialGeneration,
      cleanupLeaseId,
      completedAt: this.now(),
    });
    if (completed !== null) return true;
    const stillPending = await this.options.store.listCredentialCleanup(pending.userId, pending.provider);
    if (!stillPending.some(record => record.id === pending.id)) return true;
    await this.releaseCredentialCleanupClaim(pending, cleanupLeaseId);
    return false;
  }

  private async releaseCredentialCleanupClaim(
    pending: UserIntegrationRecord,
    cleanupLeaseId: string,
  ): Promise<void> {
    await this.options.store.releaseCredentialCleanupClaim({
      userId: pending.userId,
      provider: pending.provider,
      integrationId: pending.id,
      cleanupLeaseId,
    });
  }

  private auditCredentialCleanupFailure(
    provider: IIntegrationProvider,
    cleanup: string,
    error?: unknown,
  ): void {
    if (cleanup === 'completed') return;
    logIntegrationSecurityEvent('OPERATION_FAILED', 'HIGH',
      'Integration credential cleanup requires operator attention', {
        provider: provider.descriptor.id,
        cleanup,
        error: error instanceof Error ? error.name : undefined,
        requiredAction: 'retry_disconnect_or_revoke_oauth_grant_in_provider_console',
      });
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

  private async validateConsumedIntegrationTransaction(
    transaction: ConsoleLoginTransaction,
    auth: ConsoleAuthenticatedContext,
    providerId: UserIntegrationProvider,
  ): Promise<ConsoleHandlerResult | null> {
    if (transaction.userId !== auth.userId) {
      await this.recordCallbackRejected(providerId, auth.userId, 'user_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    if (!transaction.consoleSessionIdHash
        || !buffersEqual(transaction.consoleSessionIdHash, auth.sessionIdHash)) {
      await this.recordCallbackRejected(providerId, auth.userId, 'session_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    return null;
  }

  private descriptorBindingMatches(
    transaction: ConsoleLoginTransaction,
    provider: IIntegrationProvider,
  ): boolean {
    return (transaction.integrationDescriptorId ?? null)
        === (provider.integrationDescriptorId ?? null)
      && (transaction.integrationDescriptorFingerprint ?? null)
        === (provider.integrationDescriptorFingerprint ?? null);
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
  if (!isSafelyRedactableCredential(value) || !isWellFormedUnicode(value) || Buffer.byteLength(value, 'utf8') > 8192) {
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
  if (username.length === 0 || !isSafelyRedactableCredential(password) ||
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

function cleanupPendingResponse(): ConsoleHandlerResult {
  return {
    status: 502,
    body: {
      type: 'about:blank',
      title: 'Provider credential cleanup pending',
      status: 502,
      code: 'integration_credential_cleanup_pending',
      detail: 'The integration is disabled locally, but provider-side credential revocation must be retried.',
    },
  };
}

function cleanupMustFinishConflict(): ConsoleHandlerResult {
  return {
    status: 409,
    body: {
      type: 'about:blank',
      title: 'Credential cleanup pending',
      status: 409,
      code: 'integration_credential_cleanup_pending',
      detail: 'Finish provider credential cleanup before connecting this integration again.',
    },
  };
}

function integrationAlreadyConnectedConflict(): ConsoleHandlerResult {
  return {
    status: 409,
    body: {
      type: 'about:blank',
      title: 'Integration already connected',
      status: 409,
      code: 'integration_already_connected',
      detail: 'Disconnect the current integration before starting a new authorization.',
    },
  };
}

function defaultAuthorizedPermissions(provider: UserIntegrationProvider): Readonly<Record<string, unknown>> {
  return provider === 'github'
    ? { repository_selection: 'unknown', permissions: { contents: 'none' } }
    : { scopes: [] };
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

function descriptorChangedConflict(): ConsoleHandlerResult {
  return {
    status: 409,
    body: {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'integration_descriptor_changed',
      detail: 'Integration configuration changed while the credential was being saved. Try again.',
    },
  };
}

function logIntegrationSecurityEvent(
  type: 'OPERATION_COMPLETED' | 'OPERATION_FAILED',
  severity: 'LOW' | 'MEDIUM' | 'HIGH',
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
