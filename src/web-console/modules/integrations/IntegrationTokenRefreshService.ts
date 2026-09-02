import { SecurityMonitor } from '../../../security/securityMonitor.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import type {
  IUserIntegrationStore,
  UserIntegrationProvider,
  UserIntegrationRecord,
  UserIntegrationRefreshResult,
} from '../../stores/IUserIntegrationStore.js';
import {
  IntegrationProviderTemporarilyUnavailableError,
  type IntegrationProviderResolver,
} from './CuratedIntegrationProviders.js';
import type { IIntegrationProvider } from './IntegrationProvider.js';
import type { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';

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
}

export class IntegrationTokenRefreshService {
  constructor(private readonly options: IntegrationTokenRefreshServiceOptions) {}

  async canRefresh(
    userId: string,
    descriptor: IntegrationDescriptorRecord,
    record: UserIntegrationRecord,
  ): Promise<boolean> {
    if (descriptor.provider !== record.provider ||
        descriptor.id !== record.integrationDescriptorId ||
        descriptor.authStrategy !== 'oauth2_authorization_code' ||
        descriptor.oauth === null ||
        descriptor.oauth.refresh === 'none' ||
        record.accessTokenCiphertext === null ||
        record.refreshTokenCiphertext === null) {
      return false;
    }
    const provider = await this.resolveProvider(userId, record.provider);
    return (provider?.integrationDescriptorId ?? null) === descriptor.id &&
      typeof provider?.refreshCredentials === 'function';
  }

  async refreshOnDemand(input: IntegrationTokenRefreshInput): Promise<UserIntegrationRefreshResult> {
    try {
      return await this.executeRefreshOnDemand(input);
    } catch (error) {
      this.auditOutcome(input.provider, 'failed');
      throw error;
    }
  }

  private async executeRefreshOnDemand(input: IntegrationTokenRefreshInput): Promise<UserIntegrationRefreshResult> {
    const provider = await this.resolveProvider(input.userId, input.provider);
    if ((provider?.integrationDescriptorId ?? null) !== input.integrationDescriptorId) {
      return this.auditResult(input.provider, { kind: 'missing', record: null });
    }
    const refreshCredentials = provider?.refreshCredentials?.bind(provider);
    if (!refreshCredentials) {
      const result = await this.options.store.refresh({
        userId: input.userId,
        provider: input.provider,
        integrationDescriptorId: input.integrationDescriptorId,
        staleAccessTokenCiphertext: input.staleAccessTokenCiphertext,
        refreshedAt: this.now(),
        refresh: () => Promise.resolve({
          kind: 'failed' as const,
          errorReason: 'provider_unavailable' as const,
        }),
      });
      return this.auditResult(input.provider, result);
    }
    const result = await this.options.store.refresh({
      userId: input.userId,
      provider: input.provider,
      integrationDescriptorId: input.integrationDescriptorId,
      staleAccessTokenCiphertext: input.staleAccessTokenCiphertext,
      refreshedAt: this.now(),
      refresh: async record => {
        if (!record.refreshTokenCiphertext) {
          return { kind: 'failed', errorReason: 'token_refresh_failed' };
        }
        try {
          const refreshToken = this.options.secretEncryption.decrypt(
            record.refreshTokenCiphertext,
            integrationSecretContext('refresh_token', input.userId, input.provider),
          ).toString('utf8');
          const refreshed = await refreshCredentials({
            refreshToken,
            authorizedPermissions: record.authorizedPermissions,
          });
          let nextRefreshTokenCiphertext: Buffer | null;
          if (refreshed.refreshToken === undefined) {
            nextRefreshTokenCiphertext = record.refreshTokenCiphertext;
          } else if (refreshed.refreshToken) {
            nextRefreshTokenCiphertext = this.options.secretEncryption.encrypt(
              Buffer.from(refreshed.refreshToken, 'utf8'),
              integrationSecretContext('refresh_token', input.userId, input.provider),
            );
          } else {
            nextRefreshTokenCiphertext = null;
          }
          return {
            kind: 'refreshed',
            accessTokenCiphertext: this.options.secretEncryption.encrypt(
              Buffer.from(refreshed.accessToken, 'utf8'),
              integrationSecretContext('access_token', input.userId, input.provider),
            ),
            refreshTokenCiphertext: nextRefreshTokenCiphertext,
            authorizedPermissions: refreshed.authorizedPermissions,
            credentialKeyVersion: record.credentialKeyVersion,
          };
        } catch {
          return { kind: 'failed', errorReason: 'token_refresh_failed' };
        }
      },
    });
    return this.auditResult(input.provider, result);
  }

  private async resolveProvider(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<IIntegrationProvider | null> {
    const registered = this.options.providers.get(provider);
    if (registered) return registered;
    try {
      return await this.options.resolveProvider?.(userId, provider) ?? null;
    } catch (error) {
      if (error instanceof IntegrationProviderTemporarilyUnavailableError) return null;
      throw error;
    }
  }

  private auditResult(
    provider: UserIntegrationProvider,
    result: UserIntegrationRefreshResult,
  ): UserIntegrationRefreshResult {
    this.auditOutcome(provider, result.kind);
    return result;
  }

  private auditOutcome(
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

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
