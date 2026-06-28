import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type {
  IUserIntegrationStore,
  UserIntegrationProvider,
  UserIntegrationRefreshResult,
} from '../../stores/IUserIntegrationStore.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import type { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';

export interface IntegrationTokenRefreshServiceOptions {
  readonly store: IUserIntegrationStore;
  readonly providers: IntegrationProviderRegistry;
  readonly secretEncryption: ISecretEncryptionService;
  readonly now?: () => Date;
}

export interface IntegrationTokenRefreshInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly staleAccessTokenCiphertext: Buffer;
}

export class IntegrationTokenRefreshService {
  constructor(private readonly options: IntegrationTokenRefreshServiceOptions) {}

  refreshOnDemand(input: IntegrationTokenRefreshInput): Promise<UserIntegrationRefreshResult> {
    const provider = this.options.providers.get(input.provider);
    const refreshCredentials = provider?.refreshCredentials?.bind(provider);
    if (!refreshCredentials) {
      return this.options.store.refresh({
        userId: input.userId,
        provider: input.provider,
        staleAccessTokenCiphertext: input.staleAccessTokenCiphertext,
        refreshedAt: this.now(),
        refresh: () => Promise.resolve({
          kind: 'failed' as const,
          errorReason: 'provider_unavailable' as const,
        }),
      });
    }
    return this.options.store.refresh({
      userId: input.userId,
      provider: input.provider,
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
            credentialKeyVersion: record.credentialKeyVersion,
          };
        } catch {
          return { kind: 'failed', errorReason: 'token_refresh_failed' };
        }
      },
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
