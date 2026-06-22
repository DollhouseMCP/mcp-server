import { describe, expect, it, jest } from '@jest/globals';

import { GitHubAppIntegrationProvider } from '../../../../src/web-console/index.js';

const CONFIG = {
  clientId: 'Iv1.test-client',
  clientSecret: 'github-client-secret',
  authorizationUrl: 'https://github.example/login/oauth/authorize',
  tokenUrl: 'https://github.example/login/oauth/access_token',
  apiBaseUrl: 'https://api.github.example',
};

describe('GitHubAppIntegrationProvider', () => {
  it('creates a PKCE GitHub App authorization URL without OAuth scopes', () => {
    const provider = new GitHubAppIntegrationProvider({
      ...CONFIG,
      fetch: jest.fn<typeof fetch>(),
    });

    const url = new URL(provider.createAuthorizationUrl({
      state: 'opaque-state',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      redirectUri: 'https://console.example/api/v1/me/integrations/github/callback',
      contentsPermission: 'write',
    }));

    expect(url.origin + url.pathname).toBe('https://github.example/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.example/api/v1/me/integrations/github/callback');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('exchanges an authorization code and summarizes user installation permissions', async () => {
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'github-access-token',
        refresh_token: 'github-refresh-token',
      }))
      .mockResolvedValueOnce(jsonResponse({ login: 'alice' }))
      .mockResolvedValueOnce(jsonResponse({
        installations: [{
          id: 12345,
          repository_selection: 'selected',
          permissions: { contents: 'write' },
        }],
      }));
    const provider = new GitHubAppIntegrationProvider({ ...CONFIG, fetch: fetchMock });

    const result = await provider.exchangeAuthorizationCode({
      code: 'provider-code',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'https://console.example/callback',
      installationId: '12345',
    });

    expect(result).toEqual({
      accountLabel: 'alice',
      installationId: '12345',
      repositorySelection: 'selected',
      contentsPermission: 'write',
      accessToken: 'github-access-token',
      refreshToken: 'github-refresh-token',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      CONFIG.tokenUrl,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.example/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer github-access-token' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.github.example/user/installations',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer github-access-token' }),
      }),
    );
  });

  it('uses stable failure errors without provider response text', async () => {
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error_description: 'secret provider text' }, 400));
    const provider = new GitHubAppIntegrationProvider({ ...CONFIG, fetch: fetchMock });

    const promise = provider.exchangeAuthorizationCode({
      code: 'bad-code',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'https://console.example/callback',
    });

    await expect(promise).rejects.toThrow('github_integration_token_exchange_failed');
    await promise.catch(error => {
      expect(String(error)).not.toContain('secret provider text');
    });
  });

  it('revokes an access-token grant with GitHub application credentials', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 }));
    const provider = new GitHubAppIntegrationProvider({ ...CONFIG, fetch: fetchMock });

    await provider.revokeCredentials({
      accessToken: 'github-access-token',
      refreshToken: 'github-refresh-token',
      installationId: '12345',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.example/applications/Iv1.test-client/grant',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: basicAuthorization(CONFIG.clientId, CONFIG.clientSecret),
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ access_token: 'github-access-token' }),
      }),
    );
  });

  it('skips remote revocation when no decrypted access token is available', async () => {
    const fetchMock = jest.fn<typeof fetch>();
    const provider = new GitHubAppIntegrationProvider({ ...CONFIG, fetch: fetchMock });

    await provider.revokeCredentials({
      accessToken: null,
      refreshToken: 'github-refresh-token',
      installationId: '12345',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
}
