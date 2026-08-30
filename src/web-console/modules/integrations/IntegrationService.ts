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
import {
  hasIntegrationCredentials,
  IntegrationCredentialCleanupPendingError,
  IntegrationCredentialReplacementRequiresCleanupError,
  type IUserIntegrationStore,
  type UserIntegrationConnectInput,
  type UserIntegrationProvider,
  type UserIntegrationRecord,
} from '../../stores/IUserIntegrationStore.js';
import {
  assertDisplayString,
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
import {
  IntegrationProviderTemporarilyUnavailableError,
  type IntegrationProviderResolver,
} from './CuratedIntegrationProviders.js';
import type { IIntegrationProvider } from './IntegrationProvider.js';
import type { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';

const INTEGRATION_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 32;
const PKCE_SECRET_CLASS = 'pkce_verifier';
const INTEGRATION_PATH = '/api/v1/me/integrations';
const CREDENTIAL_CLEANUP_LEASE_MS = 5 * 60 * 1000;
const CREDENTIAL_CLEANUP_INITIAL_RETRY_MS = 1_000;
const CREDENTIAL_CLEANUP_MAX_RETRY_MS = 60_000;
const CREDENTIAL_CLEANUP_MAX_STEPS_PER_REQUEST = 2;

type CredentialRevocationOutcome = 'revoked' | 'retry' | 'terminal';
type CredentialCleanupAttemptResult = 'completed' | 'pending' | 'stopped';
type CredentialCleanupDependencies =
  | { readonly kind: 'ready'; readonly secretEncryption: ISecretEncryptionService; readonly provider: IIntegrationProvider }
  | { readonly kind: 'retry' }
  | { readonly kind: 'terminal' };

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
    const descriptors = this.options.providers.listDescriptors();
    const records = await this.options.store.listByUser(
      auth.userId,
      descriptors.map(descriptor => descriptor.id),
    );
    return {
      status: 200,
      body: serializeIntegrationList(records, descriptors),
    };
  }

  async getGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.getProvider(req, 'github' as UserIntegrationProvider);
  }

  async getProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const provider = await this.resolveProviderFor(auth.userId, providerId);
    if (!provider) return providerNotFound(providerId);
    const record = await this.options.store.findByProvider(auth.userId, providerId)
      ?? await this.options.store.findCredentialCleanupPending(auth.userId, providerId)
      ?? await this.options.store.findCredentialCleanupFailed(auth.userId, providerId);
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
    if (await this.options.store.findCredentialCleanupPending(auth.userId, providerId)) {
      return credentialCleanupPendingConflict();
    }
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
    try {
      await deps.loginTransactions.create({
        idHash: deps.opaqueValues.hashOpaqueValue(transactionId),
        flowKind: 'integration_link',
        stateHash: hashProviderState(deps.opaqueValues, providerId, state),
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
    logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'Integration link flow started', {
      userId: auth.userId,
      provider: providerId,
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
      hashProviderState(deps.opaqueValues, providerId, state),
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
    } catch {
      try {
        await this.options.store.recordError({
          userId: auth.userId,
          provider: providerId,
          expectedActiveRecordId: null,
          integrationDescriptorId: transaction.integrationDescriptorId ?? null,
          errorReason: 'token_exchange_failed',
          occurredAt: this.now(),
        });
      } catch {
        await this.recordCallbackRejected(providerId, auth.userId, 'credential_persistence_failed');
      }
      logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'Integration token exchange failed', {
        userId: auth.userId,
        provider: providerId,
      });
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    const connectedAt = this.now();
    const connection = {
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
    };
    try {
      const connected = transaction.integrationDescriptorId
          && transaction.integrationDescriptorFingerprint
        ? await this.options.store.connectDescriptorCallback({
            transactionIdHash: idHash,
            descriptorId: transaction.integrationDescriptorId,
            descriptorFingerprint: transaction.integrationDescriptorFingerprint,
            connection,
          })
        : await this.options.store.connect(connection);
      if (!connected) {
        await this.revokeExchangedCredentials(currentDeps.provider, exchanged, connection);
        await this.recordCallbackRejected(providerId, auth.userId, 'descriptor_mismatch');
        return failedIntegrationCallback(transaction.returnTo ?? undefined);
      }
    } catch {
      await this.revokeExchangedCredentials(currentDeps.provider, exchanged, connection);
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
    // Enter cleanup before consulting live provider configuration. A retired
    // or temporarily unavailable provider must not strand a connected row in
    // a state that blocks both disconnect and account deletion forever.
    let pending = await this.ensureCredentialCleanupPending(auth.userId, providerId);
    const { provider, cleanupDeps } = await this.resolveProviderForCleanup(auth.userId, providerId);
    for (let step = 0; pending && step < CREDENTIAL_CLEANUP_MAX_STEPS_PER_REQUEST; step += 1) {
      const result = await this.attemptCredentialCleanup(cleanupDeps, auth, pending);
      if (result !== 'completed') break;
      pending = await this.ensureCredentialCleanupPending(auth.userId, providerId);
    }
    const deps = this.credentialDependencies(provider);
    if (!deps) return serviceUnavailable(`${providerId} integration disconnect is not configured.`);
    const current = await this.options.store.findCredentialCleanupPending(auth.userId, providerId)
      ?? await this.options.store.findByProvider(auth.userId, providerId)
      ?? await this.options.store.findCredentialCleanupFailed(auth.userId, providerId);
    return {
      status: 200,
      body: deps.provider.projectStatus(current).body,
    };
  }

  private async ensureCredentialCleanupPending(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<UserIntegrationRecord | null> {
    const active = await this.options.store.findByProvider(userId, provider);
    if (active) {
      const revokedAt = this.now();
      if (hasIntegrationCredentials(active)) {
        return this.options.store.beginCredentialCleanup({
          userId,
          provider,
          expectedActiveRecordId: active.id,
          revokedAt,
        });
      }
      await this.options.store.disconnect({
        userId,
        provider,
        expectedActiveRecordId: active.id,
        revokedAt,
      });
    }
    return this.options.store.findCredentialCleanupPending(userId, provider);
  }

  private async attemptCredentialCleanup(
    deps: CredentialCleanupDependencies,
    auth: ConsoleAuthenticatedContext,
    pending: UserIntegrationRecord,
  ): Promise<CredentialCleanupAttemptResult> {
    const attemptedAt = this.now();
    const leaseId = randomUUID();
    const claimed = await this.options.store.claimCredentialCleanup({
      userId: auth.userId,
      provider: pending.provider,
      cleanupRecordId: pending.id,
      leaseId,
      attemptedAt,
      leaseExpiresAt: new Date(attemptedAt.getTime() + CREDENTIAL_CLEANUP_LEASE_MS),
    });
    if (!claimed) return 'pending';
    let outcome: CredentialRevocationOutcome;
    if (deps.kind === 'retry') {
      logIntegrationSecurityEvent(
        'OPERATION_FAILED',
        'MEDIUM',
        'Integration credential cleanup dependencies temporarily unavailable',
        { userId: auth.userId, provider: pending.provider },
      );
      outcome = 'retry';
    } else if (deps.kind === 'terminal') {
      logIntegrationSecurityEvent(
        'OPERATION_FAILED',
        'MEDIUM',
        'Integration credential cleanup provider permanently unavailable',
        { userId: auth.userId, provider: pending.provider },
      );
      outcome = 'terminal';
    } else if (!this.recordOwnedByProvider(deps.provider, claimed)) {
      logIntegrationSecurityEvent(
        'OPERATION_FAILED',
        'MEDIUM',
        'Integration credential cleanup descriptor ownership mismatch',
        { userId: auth.userId, provider: pending.provider },
      );
      // A parked credential may have been issued immediately before its
      // descriptor changed. Retain it for an exact routing revision to return
      // or for the explicit audited operator-abandon path; never revoke it
      // through the new descriptor and never auto-terminalize the handle.
      outcome = 'retry';
    } else {
      outcome = await this.revokeRemoteCredentials(deps, auth, claimed);
    }
    const mayStopBlocking = this.mayCredentialCleanupStopBlocking(claimed, outcome);
    if (outcome === 'terminal' && mayStopBlocking) {
      await this.options.store.failCredentialCleanup({
        userId: auth.userId,
        provider: pending.provider,
        cleanupRecordId: claimed.id,
        leaseId,
      });
      return 'stopped';
    }
    if (!mayStopBlocking) {
      await this.options.store.releaseCredentialCleanup({
        userId: auth.userId,
        provider: pending.provider,
        cleanupRecordId: claimed.id,
        leaseId,
        retryAt: new Date(attemptedAt.getTime() + cleanupRetryDelayMs(claimed.cleanupAttemptCount)),
      });
      return 'pending';
    }
    const completed = await this.options.store.completeCredentialCleanup({
      userId: auth.userId,
      provider: pending.provider,
      cleanupRecordId: claimed.id,
      leaseId,
      completedAt: this.now(),
    });
    if (completed) {
      logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'Integration disconnected', {
        userId: auth.userId,
        provider: pending.provider,
      });
      return 'completed';
    }
    return 'pending';
  }

  /**
   * The only automatic exits from blocking cleanup are confirmed remote
   * revocation and legacy terminal cleanup without a pinned issuance route.
   * A parked credential with a routing fingerprint represents a known remote
   * revocation debt; descriptor loss, decrypt failure, or routing mismatch
   * must retain it until revocation succeeds or an operator explicitly uses
   * the audited abandon path.
   */
  private mayCredentialCleanupStopBlocking(
    record: UserIntegrationRecord,
    outcome: CredentialRevocationOutcome,
  ): boolean {
    if (outcome === 'revoked') return true;
    if (outcome === 'retry') return false;
    return (record.cleanupDescriptorFingerprint ?? null) === null;
  }

  private async revokeRemoteCredentials(
    deps: NonNullable<ReturnType<IntegrationService['credentialDependencies']>>,
    auth: ConsoleAuthenticatedContext,
    active: NonNullable<Awaited<ReturnType<IUserIntegrationStore['findByProvider']>>>,
  ): Promise<CredentialRevocationOutcome> {
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
    if ((active.accessTokenCiphertext && accessToken === null) ||
        (active.refreshTokenCiphertext && refreshToken === null)) {
      return 'terminal';
    }
    try {
      await deps.provider.revokeCredentials({
        accessToken,
        refreshToken,
        externalInstallationId: active.externalInstallationId,
        isRetry: active.cleanupAttemptCount > 1,
      });
      return 'revoked';
    } catch {
      // Local credential invalidation still proceeds so no future console path
      // can use the stored credentials. Structured event persistence lands with
      // the self-security/user-event sink.
      return 'retry';
    }
  }

  private recordOwnedByProvider(
    provider: IIntegrationProvider,
    record: Awaited<ReturnType<IUserIntegrationStore['findByProvider']>>,
  ): boolean {
    if ((record?.integrationDescriptorId ?? null) !== (provider.integrationDescriptorId ?? null)) {
      return false;
    }
    const cleanupFingerprint = record?.cleanupDescriptorFingerprint ?? null;
    return cleanupFingerprint === null ||
      cleanupFingerprint === (provider.integrationDescriptorFingerprint ?? null);
  }

  /** Boot-time registry first, then the per-request store-backed fallback. */
  private async resolveProviderFor(
    userId: string,
    providerId: UserIntegrationProvider,
  ): Promise<IIntegrationProvider | null> {
    const registered = this.options.providers.get(providerId);
    if (registered) return registered;
    if (!this.options.resolveProvider) return null;
    try {
      return await this.options.resolveProvider(userId, providerId);
    } catch (error) {
      if (error instanceof IntegrationProviderTemporarilyUnavailableError) return null;
      throw error;
    }
  }

  private async resolveProviderForCleanup(
    userId: string,
    providerId: UserIntegrationProvider,
  ): Promise<{
    readonly provider: IIntegrationProvider | null;
    readonly cleanupDeps: CredentialCleanupDependencies;
  }> {
    const registered = this.options.providers.get(providerId);
    if (registered) {
      return { provider: registered, cleanupDeps: this.cleanupDependencies(registered) };
    }
    if (!this.options.resolveProvider) {
      return { provider: null, cleanupDeps: { kind: 'terminal' } };
    }
    try {
      const provider = await this.options.resolveProvider(userId, providerId);
      return { provider, cleanupDeps: this.cleanupDependencies(provider) };
    } catch (error) {
      if (error instanceof IntegrationProviderTemporarilyUnavailableError) {
        return { provider: null, cleanupDeps: { kind: 'retry' } };
      }
      throw error;
    }
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
    const accountLabel = readBodyAccountLabel(req.body);
    if (accountLabel === undefined) {
      return badRequest('invalid_account_label', 'account_label must be a printable string up to 200 characters.');
    }
    const connectedAt = this.now();
    const connection = {
      userId: auth.userId,
      provider: provider.descriptor.id,
      integrationDescriptorId: provider.integrationDescriptorId ?? null,
      externalAccountLabel: accountLabel ?? captured.defaultAccountLabel,
      externalInstallationId: null,
      authorizedPermissions: { scopes: [] },
      accessTokenCiphertext: secretEncryption.encrypt(
        Buffer.from(captured.credential, 'utf8'),
        integrationSecretContext('access_token', auth.userId, provider.descriptor.id),
      ),
      refreshTokenCiphertext: null,
      connectedAt,
    };
    let record;
    try {
      record = provider.integrationDescriptorId
          && provider.integrationDescriptorFingerprint
        ? await this.options.store.connectDescriptorCredential({
            descriptorId: provider.integrationDescriptorId,
            descriptorFingerprint: provider.integrationDescriptorFingerprint,
            connection,
          })
        : await this.options.store.connect(connection);
    } catch (error) {
      if (error instanceof IntegrationCredentialCleanupPendingError
          || error instanceof IntegrationCredentialReplacementRequiresCleanupError) {
        return credentialCleanupPendingConflict();
      }
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

  private cleanupDependencies(provider: IIntegrationProvider | null): CredentialCleanupDependencies {
    if (!provider) return { kind: 'terminal' };
    if (!this.options.secretEncryption || !provider.authorizationConfigured) {
      return { kind: 'retry' };
    }
    return {
      kind: 'ready',
      secretEncryption: this.options.secretEncryption,
      provider,
    };
  }

  private async revokeExchangedCredentials(
    provider: IIntegrationProvider,
    exchanged: Awaited<ReturnType<IIntegrationProvider['exchangeAuthorizationCode']>>,
    connection: UserIntegrationConnectInput,
  ): Promise<void> {
    try {
      await provider.revokeCredentials({
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken ?? null,
        externalInstallationId: exchanged.externalInstallationId,
        isRetry: false,
      });
    } catch (error) {
      let parked = false;
      try {
        await this.options.store.parkCredentialCleanup({
          ...connection,
          descriptorFingerprint: provider.integrationDescriptorFingerprint ?? null,
          requestedAt: this.now(),
        });
        parked = true;
      } catch (parkError) {
        logger.error('Failed to retain rejected integration credential for cleanup', {
          userId: connection.userId,
          provider: provider.descriptor.id,
          error: parkError instanceof Error ? parkError.message : 'unknown persistence error',
        });
      }
      logger.error('Compensating integration credential revocation failed', {
        userId: connection.userId,
        provider: provider.descriptor.id,
        error: error instanceof Error ? error.message : 'unknown revocation error',
        cleanupCredentialParked: parked,
      });
      await this.recordCallbackRejected(
        provider.descriptor.id,
        connection.userId,
        'compensating_revocation_failed',
      );
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
    logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'Integration callback rejected', {
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

function readBodyAccountLabel(body: unknown): string | null | undefined {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (record.account_label === undefined || record.account_label === null) return null;
  if (typeof record.account_label !== 'string') return undefined;
  const label = record.account_label.trim();
  if (label === '') return null;
  try {
    assertDisplayString(label, 'account_label', 200);
    return label;
  } catch {
    return undefined;
  }
}

function readStaticApiKey(body: unknown): string | null {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof record.api_key !== 'string') return null;
  const value = record.api_key;
  if (value.trim().length === 0 || !isWellFormedUnicode(value) || Buffer.byteLength(value, 'utf8') > 8192) {
    return null;
  }
  return value;
}

function hashProviderState(
  opaqueValues: IConsoleOpaqueValueService,
  providerId: UserIntegrationProvider,
  state: string,
): Buffer {
  return opaqueValues.hashOpaqueValue(`${providerId.length}:${providerId}:${state}`);
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
  const username = typeof record.username === 'string' ? record.username : '';
  const password = typeof record.password === 'string' ? record.password : '';
  if (username.trim().length === 0 || password.length === 0 ||
      !isWellFormedUnicode(username) || !isWellFormedUnicode(password) ||
      hasBasicCredentialControlCharacter(username) || hasBasicCredentialControlCharacter(password)) {
    return { error: badRequest('invalid_basic_credential', 'Valid, non-empty username and password are required.') };
  }
  if (username.includes(':')) {
    return { error: badRequest('invalid_basic_credential', 'username must not contain ":".') };
  }
  const credential = `${username}:${password}`;
  if (Buffer.byteLength(credential, 'utf8') > 8192) {
    return { error: badRequest('invalid_basic_credential', 'Credential is too large.') };
  }
  return { credential, defaultAccountLabel: username.trim().slice(0, 200) };
}

function hasBasicCredentialControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) {
      return true;
    }
  }
  return false;
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

function credentialCleanupPendingConflict(): ConsoleHandlerResult {
  return {
    status: 409,
    body: {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'integration_credential_cleanup_pending',
      detail: 'The previous credential is still awaiting provider revocation. Retry disconnect before reconnecting.',
    },
  };
}

function cleanupRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 6);
  return Math.min(CREDENTIAL_CLEANUP_INITIAL_RETRY_MS * (2 ** exponent), CREDENTIAL_CLEANUP_MAX_RETRY_MS);
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

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
