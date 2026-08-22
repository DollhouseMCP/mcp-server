import { createHash } from 'node:crypto';

import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import type {
  IUserIntegrationStore,
  UserIntegrationCleanupConnectInput,
  UserIntegrationProvider,
  UserIntegrationRecord,
  UserIntegrationRefreshResult,
} from '../../stores/IUserIntegrationStore.js';
import {
  isMintedIntegrationCredentialsError,
  isTerminalIntegrationRefreshError,
} from './IntegrationProvider.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';
import type { IntegrationProviderResolver } from './CuratedIntegrationProviders.js';
import type { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';
import { isSafelyRedactableCredential } from './IntegrationCredentialRedactor.js';
import { settleIntegrationCleanup } from './IntegrationCleanup.js';

const INTEGRATION_CREDENTIAL_CLEANUP_WAIT_MS = 1_000;
const CLEANUP_PERSISTENCE_RETRY_DELAYS_MS = [0, 25, 75] as const;

interface MintedRefreshCandidate {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly source: UserIntegrationRecord;
}

export interface IntegrationTokenRefreshServiceOptions {
  readonly store: IUserIntegrationStore;
  readonly providers: IntegrationProviderRegistry;
  /**
   * Per-request fallback for providers absent from the boot-time registry
   * (runtime-authored BYO and store-loaded curated descriptors), so their
   * OAuth refresh works without a restart.
   */
  readonly resolveProvider?: IntegrationProviderResolver | null;
  readonly secretEncryption: ISecretEncryptionService;
  readonly now?: () => Date;
}

export interface IntegrationTokenRefreshInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationDescriptorId: string | null;
  readonly staleAccessTokenCiphertext: Buffer;
  readonly staleCredentialGeneration: number;
  readonly staleAuthorizedPermissions: Readonly<Record<string, unknown>>;
}

export class IntegrationTokenRefreshService {
  private readonly inFlight = new Map<string, Promise<UserIntegrationRefreshResult>>();

  constructor(private readonly options: IntegrationTokenRefreshServiceOptions) {}

  async refreshOnDemand(input: IntegrationTokenRefreshInput): Promise<UserIntegrationRefreshResult> {
    const key = refreshFlightKey(input);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.runAuditedRefresh(input).finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async runAuditedRefresh(input: IntegrationTokenRefreshInput): Promise<UserIntegrationRefreshResult> {
    return refreshIntegrationTokenOnDemand(this.options, input);
  }
}

export async function refreshIntegrationTokenOnDemand(
  options: IntegrationTokenRefreshServiceOptions,
  input: IntegrationTokenRefreshInput,
): Promise<UserIntegrationRefreshResult> {
  try {
    const result = await executeIntegrationTokenRefresh(options, input);
    auditRefreshOutcome(input.provider, result.kind);
    return result;
  } catch (error) {
    auditRefreshOutcome(input.provider, 'failed');
    throw error;
  }
}

async function executeIntegrationTokenRefresh(
  options: IntegrationTokenRefreshServiceOptions,
  input: IntegrationTokenRefreshInput,
): Promise<UserIntegrationRefreshResult> {
  const registered = options.providers.get(input.provider);
  const provider = registered?.integrationDescriptorId && options.resolveProvider
    ? await options.resolveProvider(input.userId, input.provider)
    : registered ?? await options.resolveProvider?.(input.userId, input.provider) ?? null;
  if ((provider?.integrationDescriptorId ?? null) !== input.integrationDescriptorId) {
    return { kind: 'missing', record: null };
  }
  const refreshCredentials = provider?.refreshCredentials?.bind(provider);
  if (!refreshCredentials) {
    return options.store.refresh({
      userId: input.userId,
      provider: input.provider,
      integrationDescriptorId: input.integrationDescriptorId,
      staleAccessTokenCiphertext: input.staleAccessTokenCiphertext,
      staleCredentialGeneration: input.staleCredentialGeneration,
      staleAuthorizedPermissions: input.staleAuthorizedPermissions,
      refreshedAt: options.now?.() ?? new Date(),
      refresh: () => Promise.resolve({ kind: 'retryable' as const }),
    });
  }
  const mintedCredentials: { value: MintedRefreshCandidate | null } = { value: null };
  let result: UserIntegrationRefreshResult | null = null;
  try {
    result = await options.store.refresh({
      userId: input.userId,
      provider: input.provider,
      integrationDescriptorId: input.integrationDescriptorId,
      staleAccessTokenCiphertext: input.staleAccessTokenCiphertext,
      staleCredentialGeneration: input.staleCredentialGeneration,
      staleAuthorizedPermissions: input.staleAuthorizedPermissions,
      refreshedAt: options.now?.() ?? new Date(),
      refresh: async record => {
      if (!record.refreshTokenCiphertext) {
        return { kind: 'failed', errorReason: 'token_refresh_failed' };
      }
      let refreshToken: string;
      try {
        refreshToken = options.secretEncryption.decrypt(
          record.refreshTokenCiphertext,
          integrationSecretContext('refresh_token', input.userId, input.provider),
        ).toString('utf8');
      } catch {
        return { kind: 'failed', errorReason: 'token_refresh_failed' };
      }

      try {
        const refreshed = await refreshCredentials({
          refreshToken,
          authorizedPermissions: record.authorizedPermissions,
        });
        mintedCredentials.value = {
          accessToken: refreshed.accessToken,
          refreshToken: typeof refreshed.refreshToken === 'string' && refreshed.refreshToken.length > 0
            ? refreshed.refreshToken
            : null,
          source: record,
        };
        if (!isSafelyRedactableCredential(refreshed.accessToken)) {
          throw new Error('refreshed access token cannot be redacted safely');
        }
        let nextRefreshTokenCiphertext: Buffer | null;
        if (refreshed.refreshToken === undefined) {
          nextRefreshTokenCiphertext = record.refreshTokenCiphertext;
        } else if (refreshed.refreshToken) {
          nextRefreshTokenCiphertext = options.secretEncryption.encrypt(
            Buffer.from(refreshed.refreshToken, 'utf8'),
            integrationSecretContext('refresh_token', input.userId, input.provider),
          );
        } else {
          nextRefreshTokenCiphertext = null;
        }
        return {
          kind: 'refreshed',
          accessTokenCiphertext: options.secretEncryption.encrypt(
            Buffer.from(refreshed.accessToken, 'utf8'),
            integrationSecretContext('access_token', input.userId, input.provider),
          ),
          refreshTokenCiphertext: nextRefreshTokenCiphertext,
          credentialKeyVersion: record.credentialKeyVersion,
          authorizedPermissions: refreshed.authorizedPermissions,
        };
      } catch (error) {
        if (isMintedIntegrationCredentialsError(error)) {
          mintedCredentials.value = {
            accessToken: error.accessToken,
            refreshToken: error.refreshToken,
            source: record,
          };
        }
        return isTerminalIntegrationRefreshError(error)
          ? { kind: 'failed', errorReason: 'token_refresh_failed' }
          : { kind: 'retryable' };
      }
      },
    });
    return result;
  } finally {
    const uncommittedCredentials = mintedCredentials.value;
    if (uncommittedCredentials
        && result?.kind !== 'refreshed'
        && result?.record?.status !== 'cleanup_pending') {
      const queued = await queueRefreshCredentialCleanup(options, input, uncommittedCredentials);
      if (!queued) await revokeUntrackedRefreshCredential(provider, input.provider, uncommittedCredentials);
    }
  }
}

async function queueRefreshCredentialCleanup(
  options: IntegrationTokenRefreshServiceOptions,
  input: IntegrationTokenRefreshInput,
  candidate: MintedRefreshCandidate,
): Promise<boolean> {
  try {
    const connectedAt = options.now?.() ?? new Date();
    const cleanupInput: UserIntegrationCleanupConnectInput = {
      userId: input.userId,
      provider: input.provider,
      integrationDescriptorId: input.integrationDescriptorId,
      externalAccountLabel: candidate.source.externalAccountLabel,
      externalInstallationId: candidate.source.externalInstallationId,
      authorizedPermissions: candidate.source.authorizedPermissions,
      accessTokenCiphertext: options.secretEncryption.encrypt(
        Buffer.from(candidate.accessToken, 'utf8'),
        integrationSecretContext('access_token', input.userId, input.provider),
      ),
      refreshTokenCiphertext: candidate.refreshToken
        ? options.secretEncryption.encrypt(
          Buffer.from(candidate.refreshToken, 'utf8'),
          integrationSecretContext('refresh_token', input.userId, input.provider),
        )
        : null,
      credentialKeyVersion: candidate.source.credentialKeyVersion,
      authorizationStartedAt: candidate.source.authorizationStartedAt
        ?? candidate.source.connectedAt
        ?? connectedAt,
      connectedAt,
      cleanupRequestedAt: connectedAt,
    };
    for (const delayMs of CLEANUP_PERSISTENCE_RETRY_DELAYS_MS) {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        await options.store.queueCredentialCleanup(cleanupInput);
        return true;
      } catch {
        // Retry below; a plaintext credential must never enter logs.
      }
    }
  } catch {
    // Encryption failure leaves no safe durable representation. The caller
    // immediately revokes the plaintext provider credential instead.
  }
  return false;
}

async function revokeUntrackedRefreshCredential(
  provider: ReturnType<IntegrationProviderRegistry['get']>,
  providerId: UserIntegrationProvider,
  candidate: MintedRefreshCandidate,
): Promise<void> {
  const cleanup = await settleIntegrationCleanup(
    () => provider?.revokeCredentials({
      accessToken: candidate.accessToken,
      refreshToken: candidate.refreshToken,
      externalInstallationId: candidate.source.externalInstallationId,
    }) ?? Promise.resolve(),
    INTEGRATION_CREDENTIAL_CLEANUP_WAIT_MS,
  );
  if (cleanup === 'completed') return;
  auditRefreshOutcome(providerId, 'failed');
  SecurityMonitor.logSecurityEvent({
    type: 'OPERATION_FAILED',
    severity: 'HIGH',
    source: 'IntegrationTokenRefreshService.cleanup',
    details: `Integration credential cleanup requires manual provider-side revocation for ${safeIntegrationAuditProvider(providerId)}`,
    additionalData: {
      provider: safeIntegrationAuditProvider(providerId),
      cleanup,
      requiredAction: 'revoke_oauth_grant_in_provider_console',
    },
  });
}

function auditRefreshOutcome(
  provider: UserIntegrationProvider,
  outcome: UserIntegrationRefreshResult['kind'],
): void {
  SecurityMonitor.logSecurityEvent({
    type: 'INTEGRATION_SECURITY_DECISION',
    severity: outcome === 'refreshed' || outcome === 'reused' ? 'LOW' : 'MEDIUM',
    source: 'IntegrationTokenRefreshService.refreshOnDemand',
    details: `Integration token refresh ${outcome} for provider ${safeIntegrationAuditProvider(provider)}`,
  });
}

function refreshFlightKey(input: IntegrationTokenRefreshInput): string {
  const staleDigest = createHash('sha256').update(input.staleAccessTokenCiphertext).digest('hex');
  return `${input.userId}\0${input.provider}\0${input.integrationDescriptorId ?? ''}\0${staleDigest}`;
}
