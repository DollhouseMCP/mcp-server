export type GitHubIntegrationContentsPermission = 'read' | 'write';
export type GitHubIntegrationRepositorySelection = 'selected' | 'all' | 'unknown';

export interface GitHubIntegrationAuthorizationRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly redirectUri: string;
  readonly contentsPermission: GitHubIntegrationContentsPermission;
}

export interface GitHubIntegrationTokenExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly installationId?: string | null;
}

export interface GitHubIntegrationTokenExchangeResult {
  readonly accountLabel: string | null;
  readonly installationId: string | null;
  readonly repositorySelection: GitHubIntegrationRepositorySelection;
  readonly contentsPermission: GitHubIntegrationContentsPermission;
  readonly accessToken: string;
  readonly refreshToken?: string | null;
}

export interface GitHubIntegrationRevocationRequest {
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
  readonly installationId: string | null;
}

export interface IGitHubIntegrationProvider {
  createAuthorizationUrl(request: GitHubIntegrationAuthorizationRequest): string;
  exchangeAuthorizationCode(request: GitHubIntegrationTokenExchangeRequest): Promise<GitHubIntegrationTokenExchangeResult>;
  revokeCredentials(request: GitHubIntegrationRevocationRequest): Promise<void>;
}
