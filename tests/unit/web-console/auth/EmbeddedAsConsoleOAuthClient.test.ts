import { describe, expect, it, jest } from '@jest/globals';
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
} from 'jose';

import {
  EmbeddedAsConsoleOAuthClient,
} from '../../../../src/web-console/auth/EmbeddedAsConsoleOAuthClient.js';
import { EMBEDDED_AS_CONSOLE_CLIENT_ID } from '../../../../src/auth/embedded-as/ConsoleOAuthClientConstants.js';

const PUBLIC_BASE_URL = 'https://console.example.test';
const REDIRECT_URI = `${PUBLIC_BASE_URL}/api/v1/auth/callback`;
const ISSUER = PUBLIC_BASE_URL;
const ADMIN_ACR = 'urn:dollhouse:acr:admin-stepup';

describe('EmbeddedAsConsoleOAuthClient', () => {
  it('builds a PKCE authorization URL for the embedded AS console client', () => {
    const client = new EmbeddedAsConsoleOAuthClient({ publicBaseUrl: PUBLIC_BASE_URL });

    const url = new URL(client.createAuthorizationUrl({
      state: 'state-1',
      codeChallenge: 'challenge-1',
      codeChallengeMethod: 'S256',
      redirectUri: REDIRECT_URI,
      prompt: 'login',
      maxAgeSeconds: 0,
      acrValues: ADMIN_ACR,
    }));

    expect(url.origin).toBe(PUBLIC_BASE_URL);
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('client_id')).toBe(EMBEDDED_AS_CONSOLE_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('acr_values')).toBe(ADMIN_ACR);
  });

  it('exchanges an authorization code and verifies the returned id_token', async () => {
    const { privateKey, publicJwk } = await generateSigningMaterial();
    const idToken = await new SignJWT({
      sub: 'alice-sub',
      name: 'Alice Admin',
      email: 'alice@example.test',
      acr: ADMIN_ACR,
      amr: ['pwd', 'otp'],
      auth_time: 1779883200,
    })
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .setIssuer(ISSUER)
      .setAudience(EMBEDDED_AS_CONSOLE_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id_token: idToken }),
    );
    const client = new EmbeddedAsConsoleOAuthClient({
      publicBaseUrl: PUBLIC_BASE_URL,
      fetch: fetchMock,
      jwks: async () => importJWK(publicJwk, 'ES256'),
    });

    await expect(client.exchangeAuthorizationCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: REDIRECT_URI,
    })).resolves.toEqual({
      sub: 'alice-sub',
      displayName: 'Alice Admin',
      email: 'alice@example.test',
      acr: ADMIN_ACR,
      amr: ['pwd', 'otp'],
      authTime: new Date('2026-05-27T12:00:00.000Z'),
    });
    expect(fetchMock).toHaveBeenCalledWith(new URL('/token', PUBLIC_BASE_URL), expect.objectContaining({
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: expect.any(URLSearchParams),
    }));
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries((body as URLSearchParams).entries())).toEqual({
      grant_type: 'authorization_code',
      client_id: EMBEDDED_AS_CONSOLE_CLIENT_ID,
      code: 'code-1',
      code_verifier: 'verifier-1',
      redirect_uri: REDIRECT_URI,
    });
  });

  it('rejects token responses without a verified id_token', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({ access_token: 'ignored' }));
    const client = new EmbeddedAsConsoleOAuthClient({
      publicBaseUrl: PUBLIC_BASE_URL,
      fetch: fetchMock,
      jwks: () => Promise.reject(new Error('jwks should not be called')),
    });

    await expect(client.exchangeAuthorizationCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: REDIRECT_URI,
    })).rejects.toThrow('id_token');
  });
});

async function generateSigningMaterial(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'console-test-kid';
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
