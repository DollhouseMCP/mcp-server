import type { UserIntegrationProvider, UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import type { GitHubIntegrationStatusDto } from './IntegrationDtos.js';
import type {
  GitHubIntegrationContentsPermission,
  IGitHubIntegrationProvider,
} from './GitHubIntegrationProvider.js';

export type IntegrationProviderId = UserIntegrationProvider;

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
}

export interface IntegrationProviderStatusProjection {
  readonly body: GitHubIntegrationStatusDto;
}

export interface IIntegrationProvider {
  readonly descriptor: IntegrationProviderCatalogDescriptor;
  readonly authorizationConfigured: boolean;
  createAuthorizationUrl(request: IntegrationAuthorizationRequest): string;
  exchangeAuthorizationCode(request: IntegrationTokenExchangeRequest): Promise<IntegrationTokenExchangeResult>;
  revokeCredentials(request: IntegrationRevocationRequest): Promise<void>;
  projectStatus(record: UserIntegrationRecord | null): IntegrationProviderStatusProjection;
}

export function createGitHubIntegrationProvider(
  provider: IGitHubIntegrationProvider,
  projectStatus: (record: UserIntegrationRecord | null) => GitHubIntegrationStatusDto,
): IIntegrationProvider {
  return {
    descriptor: {
      id: 'github',
      displayName: 'GitHub',
      category: 'Source control',
    },
    authorizationConfigured: true,
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
      id: 'github',
      displayName: 'GitHub',
      category: 'Source control',
    },
    authorizationConfigured: false,
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
  return permissions.contents_permission === 'write' ? 'write' : 'read';
}
