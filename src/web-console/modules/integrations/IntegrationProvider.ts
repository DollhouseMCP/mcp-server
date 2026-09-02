import { UnicodeValidator } from '../../../security/validators/unicodeValidator.js';
import type { UserIntegrationProvider, UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import type { IntegrationStaticApiKeyDescriptor } from '../../stores/IIntegrationDescriptorStore.js';
import type { GitHubIntegrationStatusDto, IntegrationStatusDto } from './IntegrationDtos.js';
import type {
  GitHubIntegrationContentsPermission,
  IGitHubIntegrationProvider,
} from './GitHubIntegrationProvider.js';

export type IntegrationProviderId = UserIntegrationProvider;
export type IntegrationCredentialStrategy = 'oauth2_authorization_code' | 'static_api_key' | 'coded';

export function normalizeUnicodeDisplayText(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent;
}

export interface IntegrationProviderCatalogDescriptor {
  readonly id: IntegrationProviderId;
  readonly displayName: string;
  readonly category: string;
}

export interface IntegrationAuthorizationRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly redirectUri: string;
  readonly requestedPermissions: Readonly<Record<string, unknown>>;
}

export interface IntegrationTokenExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly providerCallbackParams: Readonly<Record<string, string | undefined>>;
}

export interface IntegrationTokenExchangeResult {
  readonly accountLabel: string | null;
  readonly externalInstallationId: string | null;
  readonly authorizedPermissions: Readonly<Record<string, unknown>>;
  readonly accessToken: string;
  readonly refreshToken?: string | null;
}

export interface IntegrationTokenRefreshRequest {
  readonly refreshToken: string;
  readonly authorizedPermissions: Readonly<Record<string, unknown>>;
}

export interface IntegrationTokenRefreshResult {
  readonly accessToken: string;
  /** Undefined preserves the permissions recorded for the existing grant. */
  readonly authorizedPermissions?: Readonly<Record<string, unknown>>;
  /**
   * Undefined preserves the existing encrypted refresh token. Null clears it.
   * A string replaces it, which supports rotating refresh-token providers.
   */
  readonly refreshToken?: string | null;
}

export interface IntegrationRevocationRequest {
  /**
   * Null means the encrypted local credential could not be decrypted or was
   * absent. Provider implementations must skip the matching remote revocation
   * call rather than sending an empty token value.
   */
  readonly accessToken: string | null;
  /**
   * Null means the encrypted local credential could not be decrypted or was
   * absent. Provider implementations must skip the matching remote revocation
   * call rather than sending an empty token value.
   */
  readonly refreshToken: string | null;
  readonly externalInstallationId: string | null;
  /**
   * True only after a durable cleanup attempt was already recorded. Providers
   * may use this to distinguish an already-removed credential on retry from a
   * missing revocation endpoint on the first attempt.
   */
  readonly isRetry?: boolean;
}

export interface IntegrationProviderStatusProjection {
  readonly body: IntegrationStatusDto;
}

export interface IIntegrationProvider {
  readonly descriptor: IntegrationProviderCatalogDescriptor;
  /** Persisted descriptor that owns credentials created by this provider. */
  readonly integrationDescriptorId?: string | null;
  /** Routing-sensitive digest of the persisted descriptor. */
  readonly integrationDescriptorFingerprint?: string | null;
  readonly authorizationConfigured: boolean;
  readonly credentialStrategy: IntegrationCredentialStrategy;
  /**
   * Injection shape for static_api_key providers, so the connect surface
   * knows whether to capture a single api_key or a Basic username/password
   * pair. Absent for OAuth/coded providers.
   */
  readonly staticApiKeyInjection?: IntegrationStaticApiKeyDescriptor['injection'];
  createAuthorizationUrl(request: IntegrationAuthorizationRequest): string;
  exchangeAuthorizationCode(request: IntegrationTokenExchangeRequest): Promise<IntegrationTokenExchangeResult>;
  refreshCredentials?(request: IntegrationTokenRefreshRequest): Promise<IntegrationTokenRefreshResult>;
  revokeCredentials(request: IntegrationRevocationRequest): Promise<void>;
  projectStatus(record: UserIntegrationRecord | null): IntegrationProviderStatusProjection;
}

export function createGitHubIntegrationProvider(
  provider: IGitHubIntegrationProvider,
  projectStatus: (record: UserIntegrationRecord | null) => GitHubIntegrationStatusDto,
): IIntegrationProvider {
  return {
    descriptor: {
      id: 'github' as UserIntegrationProvider,
      displayName: 'GitHub',
      category: 'Source control',
    },
    authorizationConfigured: true,
    credentialStrategy: 'coded',
    createAuthorizationUrl(request) {
      return provider.createAuthorizationUrl({
        state: request.state,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        redirectUri: request.redirectUri,
        contentsPermission: requestedGitHubContentsPermission(request.requestedPermissions),
      });
    },
    async exchangeAuthorizationCode(request) {
      const exchanged = await provider.exchangeAuthorizationCode({
        code: request.code,
        codeVerifier: request.codeVerifier,
        redirectUri: request.redirectUri,
        installationId: request.providerCallbackParams.installation_id ?? null,
      });
      return {
        accountLabel: exchanged.accountLabel,
        externalInstallationId: exchanged.installationId,
        authorizedPermissions: {
          repository_selection: exchanged.repositorySelection,
          permissions: { contents: exchanged.contentsPermission },
        },
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
      };
    },
    revokeCredentials(request) {
      return provider.revokeCredentials({
        accessToken: request.accessToken,
        refreshToken: request.refreshToken,
        installationId: request.externalInstallationId,
        isRetry: request.isRetry,
      });
    },
    projectStatus(record) {
      return { body: projectStatus(record) };
    },
  };
}

export function createUnavailableGitHubIntegrationProvider(
  projectStatus: (record: UserIntegrationRecord | null) => GitHubIntegrationStatusDto,
): IIntegrationProvider {
  return {
    descriptor: {
      id: 'github' as UserIntegrationProvider,
      displayName: 'GitHub',
      category: 'Source control',
    },
    authorizationConfigured: false,
    credentialStrategy: 'coded',
    createAuthorizationUrl() {
      throw new Error('github_integration_provider_not_configured');
    },
    exchangeAuthorizationCode() {
      return Promise.reject(new Error('github_integration_provider_not_configured'));
    },
    revokeCredentials() {
      return Promise.reject(new Error('github_integration_provider_not_configured'));
    },
    projectStatus(record) {
      return { body: projectStatus(record) };
    },
  };
}

function requestedGitHubContentsPermission(
  permissions: Readonly<Record<string, unknown>>,
): GitHubIntegrationContentsPermission {
  const requested = permissions.contents_permission;
  if (typeof requested !== 'string') return 'read';

  const normalized = UnicodeValidator.normalize(requested).normalizedContent;
  return normalized === requested && normalized === 'write' ? 'write' : 'read';
}
