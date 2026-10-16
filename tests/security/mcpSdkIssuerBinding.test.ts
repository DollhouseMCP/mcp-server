import { describe, expect, it } from '@jest/globals';
import { auth, fetchToken, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const RESOURCE = 'https://mcp.example.test/mcp';
const TRUSTED = 'https://trusted.example.test';
const OTHER = 'https://other.example.test';
const CLIENT_SECRET = 'synthetic-client-secret';
const REFRESH_TOKEN = 'synthetic-refresh-token';

// All SDK discovery/token traffic stays in this injected fetch. No DNS, listeners or grants.
function fixture() {
  let advertisedIssuer = TRUSTED;
  let client: OAuthClientInformationMixed = {
    client_id: 'synthetic-client', client_secret: CLIENT_SECRET, issuer: TRUSTED,
  };
  let tokens: OAuthTokens = {
    access_token: 'synthetic-access', token_type: 'Bearer', refresh_token: REFRESH_TOKEN, issuer: TRUSTED,
  };
  let redirected: URL | undefined;
  const requests: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    const url = new URL(request.url);
    requests.push({ url: url.href, method: request.method, headers: request.headers, body: await request.clone().text() });
    if (url.origin === 'https://mcp.example.test' && url.pathname.startsWith('/.well-known/')) {
      return Response.json({ resource: RESOURCE, authorization_servers: [advertisedIssuer] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return Response.json(metadata(url.origin));
    }
    if (url.pathname === '/register') {
      return Response.json({ client_id: 'new-public-client', redirect_uris: ['https://client.example.test/callback'] }, { status: 201 });
    }
    if (url.pathname === '/token') {
      return Response.json({ access_token: 'renewed-access', token_type: 'Bearer', refresh_token: 'renewed-refresh' });
    }
    throw new Error(`Unexpected synthetic OAuth request: ${url.href}`);
  };
  const provider: OAuthClientProvider = {
    redirectUrl: 'https://client.example.test/callback',
    clientMetadata: { redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'client_secret_basic' },
    clientInformation: () => client,
    tokens: () => tokens,
    saveTokens: value => { tokens = OAuthTokensSchema.parse(JSON.parse(JSON.stringify(value))); },
    redirectToAuthorization: value => { redirected = value; },
    saveCodeVerifier: () => undefined,
    codeVerifier: () => 'synthetic-code-verifier',
  };
  return {
    provider, fetchFn, requests,
    advertise: (issuer: string) => { advertisedIssuer = issuer; },
    client: () => client,
    tokens: () => tokens,
    redirected: () => redirected,
    allowRegistration: () => {
      provider.saveClientInformation = value => { client = OAuthClientInformationSchema.parse(JSON.parse(JSON.stringify(value))); };
    },
  };
}

function metadata(issuer: string) {
  return {
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`, response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
  };
}

function expectNoStoredCredentials(requests: ReturnType<typeof fixture>['requests']) {
  for (const request of requests) {
    const bytes = `${request.url}\n${request.body}\n${JSON.stringify([...request.headers])}`;
    expect(bytes).not.toContain(CLIENT_SECRET);
    expect(bytes).not.toContain(REFRESH_TOKEN);
    expect(request.headers.get('Authorization')).toBeNull();
  }
}

describe('installed MCP SDK OAuth issuer binding', () => {
  it('observes Request-carried credentials and native init precedence without consuming the input', async () => {
    const f = fixture();
    const request = new Request(`${OTHER}/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLIENT_SECRET}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: REFRESH_TOKEN }),
    });
    await f.fetchFn(request);
    expect(f.requests[0]).toMatchObject({ url: `${OTHER}/token`, method: 'POST', body: `refresh_token=${REFRESH_TOKEN}` });
    expect(f.requests[0].headers.get('Authorization')).toBe(`Bearer ${CLIENT_SECRET}`);
    expect(request.bodyUsed).toBe(false);

    await f.fetchFn(request, {
      method: 'PUT', headers: { Authorization: 'Bearer replacement-token' }, body: 'replacement-body',
    });
    expect(f.requests[1]).toMatchObject({ url: `${OTHER}/token`, method: 'PUT', body: 'replacement-body' });
    expect(f.requests[1].headers.get('Authorization')).toBe('Bearer replacement-token');
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe(`refresh_token=${REFRESH_TOKEN}`);
  });

  it('retains issuer through both published credential schemas and JSON storage', () => {
    const f = fixture();
    expect(OAuthClientInformationSchema.parse(JSON.parse(JSON.stringify(f.client()))).issuer).toBe(TRUSTED);
    expect(OAuthTokensSchema.parse(JSON.parse(JSON.stringify(f.tokens()))).issuer).toBe(TRUSTED);
  });

  it('refuses stored client credentials when resource discovery selects another issuer', async () => {
    const f = fixture();
    f.advertise(OTHER);
    await expect(auth(f.provider, { serverUrl: RESOURCE, fetchFn: f.fetchFn })).rejects.toThrow('is not presented to');
    expect(f.requests.some(request => new URL(request.url).origin === OTHER)).toBe(true);
    expect(f.requests.every(request => request.method === 'GET')).toBe(true);
    expectNoStoredCredentials(f.requests);
    expect(f.tokens().refresh_token).toBe(REFRESH_TOKEN);
  });

  it('registers anew without replaying the old secret or refresh token at a changed issuer', async () => {
    const f = fixture();
    f.allowRegistration();
    f.advertise(OTHER);
    await expect(auth(f.provider, { serverUrl: RESOURCE, fetchFn: f.fetchFn })).resolves.toBe('REDIRECT');
    expect(f.requests.filter(request => request.method === 'POST').map(request => request.url)).toEqual([`${OTHER}/register`]);
    expect(f.client().issuer).toBe(OTHER);
    expect(f.redirected()?.origin).toBe(OTHER);
    expectNoStoredCredentials(f.requests);
  });

  it('refreshes at the original issuer and preserves its binding through schema-backed storage', async () => {
    const f = fixture();
    await expect(auth(f.provider, { serverUrl: RESOURCE, fetchFn: f.fetchFn })).resolves.toBe('AUTHORIZED');
    const posts = f.requests.filter(request => request.method === 'POST');
    expect(posts.map(request => request.url)).toEqual([`${TRUSTED}/token`]);
    expect(new URLSearchParams(posts[0].body).get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(posts[0].headers.get('Authorization')).toBe(`Basic ${Buffer.from(`synthetic-client:${CLIENT_SECRET}`).toString('base64')}`);
    expect(f.tokens()).toMatchObject({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', issuer: TRUSTED });
  });

  it('binds the bundled provider and direct token exchange to its configured expected issuer', async () => {
    const f = fixture();
    const provider = new ClientCredentialsProvider({ clientId: 'synthetic-client', clientSecret: CLIENT_SECRET, expectedIssuer: TRUSTED });
    await expect(fetchToken(provider, TRUSTED, { metadata: metadata(TRUSTED), fetchFn: f.fetchFn })).resolves.toMatchObject({ access_token: 'renewed-access' });
    f.requests.length = 0;
    await expect(fetchToken(provider, OTHER, { metadata: metadata(OTHER), fetchFn: f.fetchFn })).rejects.toThrow('is not presented to');
    expect(f.requests).toEqual([]);
  });
});
