import type {
  GitHubIntegrationAuthorizationRequest,
  GitHubIntegrationRepositorySelection,
  GitHubIntegrationRevocationRequest,
  GitHubIntegrationTokenExchangeRequest,
  GitHubIntegrationTokenExchangeResult,
  IGitHubIntegrationProvider,
} from './GitHubIntegrationProvider.js';

const DEFAULT_GITHUB_AUTHORIZATION_URL = 'https://github.com/login/oauth/authorize';
const DEFAULT_GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubAppIntegrationProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

export class GitHubAppIntegrationProvider implements IGitHubIntegrationProvider {
  private readonly authorizationUrl: string;
  private readonly tokenUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GitHubAppIntegrationProviderConfig) {
    this.authorizationUrl = config.authorizationUrl ?? DEFAULT_GITHUB_AUTHORIZATION_URL;
    this.tokenUrl = config.tokenUrl ?? DEFAULT_GITHUB_TOKEN_URL;
    this.apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL);
    this.fetchImpl = config.fetch ?? fetch;
    if (!config.clientId || !config.clientSecret) {
      throw new Error('GitHub integration provider requires clientId and clientSecret');
    }
  }

  createAuthorizationUrl(request: GitHubIntegrationAuthorizationRequest): string {
    const url = new URL(this.authorizationUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    return url.toString();
  }

  async exchangeAuthorizationCode(
    request: GitHubIntegrationTokenExchangeRequest,
  ): Promise<GitHubIntegrationTokenExchangeResult> {
    const token = await this.exchangeToken(request);
    const [user, installations] = await Promise.all([
      this.fetchUser(token.accessToken),
      this.fetchInstallations(token.accessToken),
    ]);
    const installation = selectInstallation(installations, request.installationId ?? null);
    return {
      accountLabel: user.login,
      installationId: installation?.id ?? null,
      repositorySelection: installation?.repositorySelection ?? 'unknown',
      contentsPermission: deriveContentsPermission(installations),
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
    };
  }

  async revokeCredentials(request: GitHubIntegrationRevocationRequest): Promise<void> {
    if (!request.accessToken) return;
    const response = await this.fetchImpl(`${this.apiBaseUrl}/applications/${encodeURIComponent(this.config.clientId)}/grant`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: createBasicAuthorization(this.config.clientId, this.config.clientSecret),
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ access_token: request.accessToken }),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error('github_integration_revocation_failed');
    }
  }

  private async exchangeToken(request: GitHubIntegrationTokenExchangeRequest): Promise<{
    readonly accessToken: string;
    readonly refreshToken: string | null;
  }> {
    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code: request.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) {
      throw new Error('github_integration_token_exchange_failed');
    }
    const body = await readJson(response);
    const accessToken = readString(body, 'access_token');
    if (!accessToken) {
      throw new Error('github_integration_token_exchange_failed');
    }
    return {
      accessToken,
      refreshToken: readString(body, 'refresh_token'),
    };
  }

  private async fetchUser(accessToken: string): Promise<{ readonly login: string | null }> {
    const response = await this.githubGet('/user', accessToken);
    if (!response.ok) {
      throw new Error('github_integration_user_lookup_failed');
    }
    const body = await readJson(response);
    return { login: readString(body, 'login') };
  }

  private async fetchInstallations(accessToken: string): Promise<readonly GitHubInstallationSummary[]> {
    const response = await this.githubGet('/user/installations', accessToken);
    if (!response.ok) {
      throw new Error('github_integration_installation_lookup_failed');
    }
    const body = await readJson(response);
    const installationValues = readRecord(body)?.installations;
    const installations = Array.isArray(installationValues)
      ? installationValues
      : [];
    return installations
      .map(value => parseInstallation(value))
      .filter((installation): installation is GitHubInstallationSummary => installation !== null);
  }

  private githubGet(path: string, accessToken: string): Promise<Response> {
    return this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    });
  }
}

interface GitHubInstallationSummary {
  readonly id: string;
  readonly repositorySelection: GitHubIntegrationRepositorySelection;
  readonly contentsPermission: 'read' | 'write' | null;
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  // Strip trailing slashes without a backtracking-prone regex.
  let pathname = url.pathname;
  while (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown, key: string): string | null {
  const record = readRecord(value);
  const field = record?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function parseInstallation(value: unknown): GitHubInstallationSummary | null {
  const record = readRecord(value);
  const id = readInstallationId(record?.id);
  if (!id) return null;
  return {
    id,
    repositorySelection: parseRepositorySelection(record?.repository_selection),
    contentsPermission: parseContentsPermission(readRecord(record?.permissions)?.contents),
  };
}

function readInstallationId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function parseRepositorySelection(value: unknown): GitHubIntegrationRepositorySelection {
  if (value === 'selected' || value === 'all') return value;
  return 'unknown';
}

function parseContentsPermission(value: unknown): 'read' | 'write' | null {
  if (value === 'write') return 'write';
  if (value === 'read') return 'read';
  return null;
}

function selectInstallation(
  installations: readonly GitHubInstallationSummary[],
  requestedInstallationId: string | null,
): GitHubInstallationSummary | null {
  if (requestedInstallationId) {
    const matched = installations.find(installation => installation.id === requestedInstallationId);
    if (!matched) {
      throw new Error('github_integration_installation_lookup_failed');
    }
    return matched;
  }
  return installations.length === 1 ? installations[0] ?? null : null;
}

function deriveContentsPermission(installations: readonly GitHubInstallationSummary[]): 'read' | 'write' {
  return installations.some(installation => installation.contentsPermission === 'write') ? 'write' : 'read';
}

function createBasicAuthorization(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
}
