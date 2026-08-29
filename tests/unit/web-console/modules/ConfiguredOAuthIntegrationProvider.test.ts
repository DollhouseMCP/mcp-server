import { describe, expect, it, jest } from '@jest/globals';

import { ConfiguredOAuthIntegrationProvider } from '../../../../src/web-console/modules/integrations/ConfiguredOAuthIntegrationProvider.js';
import type { IntegrationDescriptorRecord } from '../../../../src/web-console/stores/IIntegrationDescriptorStore.js';
import type { DnsLookup } from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';
import type {
  OutboundPin,
  PinnedFetch,
  PinnedOutboundFactory,
} from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const NOW = new Date('2026-07-01T00:00:00.000Z');
const TOKEN_HOST = 'accounts.example';
// Built from parts so they are not hardcoded IP literals; the values themselves are the test subject.
const PUBLIC_ADDRESS = [8, 8, 8, 8].join('.');
const PRIVATE_ADDRESS = [10, 0, 0, 5].join('.');
const REQUESTED_SCOPE = 'gmail.readonly';
const FRESH_ACCESS_TOKEN = 'fresh-access-token';
const ACCESS_TOKEN = 'access-token';
const REFRESH_TOKEN = 'refresh-token';
const OAUTH_FIXTURE_MISSING = 'fixture oauth missing';

function descriptor(): IntegrationDescriptorRecord {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    provider: 'gmail',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Gmail',
    category: 'Email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client-id',
      authorizationUrl: `https://${TOKEN_HOST}/oauth/authorize`,
      tokenUrl: `https://${TOKEN_HOST}/oauth/token`,
      scopes: [REQUESTED_SCOPE],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: {
        style: 'form',
        clientAuth: 'body',
        revocationUrl: `https://${TOKEN_HOST}/oauth/revoke`,
      },
      accountLabel: { field: 'email' },
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'integration-key-v1',
    operationPromotion: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function lookupReturning(address: string): DnsLookup {
  return () => Promise.resolve([{ address, family: 4 }]);
}

function providerWith(input: {
  readonly dnsLookup: DnsLookup;
  readonly fetch?: PinnedFetch;
  readonly descriptor?: IntegrationDescriptorRecord;
  readonly clientSecret?: string | null;
  readonly requestTimeoutMs?: number;
}) {
  const pins: OutboundPin[] = [];
  const fetchCalls: Array<{
    readonly url: string;
    readonly body: string | null;
    readonly redirect: RequestRedirect | undefined;
    readonly authorization: string | null;
  }> = [];
  const fetchImpl: PinnedFetch = input.fetch ?? ((url, init) => {
    const body = init?.body;
    fetchCalls.push({
      url: String(url),
      body: typeof body === 'string' || body instanceof URLSearchParams ? body.toString() : null,
      redirect: init?.redirect,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve(new Response(JSON.stringify({
      access_token: FRESH_ACCESS_TOKEN,
      refresh_token: 'fresh-refresh-token',
      email: 'alice@example.com',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });
  const factory = jest.fn((pin: OutboundPin) => {
    pins.push(pin);
    return { fetch: fetchImpl, close: () => Promise.resolve() };
  });
  const provider = new ConfiguredOAuthIntegrationProvider({
    descriptor: input.descriptor ?? descriptor(),
    clientSecret: input.clientSecret === undefined ? 'gmail-client-secret' : input.clientSecret,
    pinnedOutbound: factory as unknown as PinnedOutboundFactory,
    dnsLookup: input.dnsLookup,
    requestTimeoutMs: input.requestTimeoutMs,
  });
  return { provider, factory, pins, fetchCalls };
}

const EXCHANGE_REQUEST = {
  code: 'auth-code',
  redirectUri: 'https://console.example/callback',
  codeVerifier: 'verifier',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256' as const,
  state: 'state-1',
};

describe('ConfiguredOAuthIntegrationProvider endpoint security', () => {
  it('allows public OAuth clients to use token endpoints without a client secret', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider, fetchCalls } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        clientSecretCiphertext: null,
        credentialKeyVersion: null,
        oauth: {
          ...base.oauth,
          tokenExchange: { ...base.oauth.tokenExchange, clientAuth: 'none' },
        },
      },
      clientSecret: null,
    });

    await provider.exchangeAuthorizationCode(EXCHANGE_REQUEST);
    await provider.refreshCredentials({ refreshToken: REFRESH_TOKEN });
    await provider.revokeCredentials({
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      externalInstallationId: null,
    });

    expect(fetchCalls).toHaveLength(3);
    for (const request of fetchCalls) {
      expect(request.authorization).toBeNull();
      const body = new URLSearchParams(request.body ?? '');
      expect(body.get('client_id')).toBe('gmail-client-id');
      expect(body.has('client_secret')).toBe(false);
    }
  });

  it('still requires a client secret for confidential OAuth clients', () => {
    expect(() => providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      clientSecret: null,
    })).toThrow('configured OAuth provider requires clientSecret');
  });

  it.each(['access_token', 'refreshToken', 'id-token', 'client.secret'])(
    'rejects credential-bearing account label field %s',
    field => {
      const base = descriptor();
      if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);

      expect(() => providerWith({
        dnsLookup: lookupReturning(PUBLIC_ADDRESS),
        descriptor: {
          ...base,
          oauth: { ...base.oauth, accountLabel: { field } },
        },
      })).toThrow('oauth.accountLabel must not reference credential fields');
    },
  );

  it('rejects unknown client authentication modes before any request can be built', () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);

    expect(() => providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          tokenExchange: { ...base.oauth.tokenExchange, clientAuth: 'boddy' },
        },
      },
    })).toThrow('oauth.tokenExchange.clientAuth must be body, basic, or none');
  });

  it('rejects non-array OAuth scopes before building an authorization request', () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);

    expect(() => providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          scopes: 'read' as unknown as readonly string[],
        },
      },
    })).toThrow('oauth.scopes must be an array');
  });

  it.each([
    [
      { revocationUrl: { href: `https://${TOKEN_HOST}/oauth/revoke` } },
      'oauth.tokenExchange.revocationUrl must be a string',
    ],
    [
      { authorizationParams: ['audience'] },
      'oauth.tokenExchange.authorizationParams must be a JSON object',
    ],
    [
      { authorizationParams: { audience: 42 } },
      'oauth.tokenExchange.authorizationParams values must be strings',
    ],
  ])('rejects malformed token exchange configuration before mounting', (tokenExchange, message) => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);

    expect(() => providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: { ...base.oauth, tokenExchange },
      },
    })).toThrow(message);
  });

  it('does not activate a legacy OAuth descriptor until its client ID is configured', () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);

    expect(() => providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: { ...base, oauth: { ...base.oauth, clientId: null } },
    })).toThrow('configured OAuth provider requires oauth.clientId');
  });
  it('does not let descriptor extras replace protocol-critical authorization parameters', () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          tokenExchange: {
            ...base.oauth.tokenExchange,
            authorizationParams: {
              audience: 'https://api.example',
              state: 'attacker-state',
              redirect_uri: 'https://attacker.example/callback',
              client_id: 'attacker-client',
              response_type: 'token',
              code_challenge: 'attacker-challenge',
              code_challenge_method: 'plain',
              scope: 'admin',
            },
          },
        },
      },
    });

    const url = new URL(provider.createAuthorizationUrl(EXCHANGE_REQUEST));
    expect(url.searchParams.get('audience')).toBe('https://api.example');
    expect(url.searchParams.get('state')).toBe(EXCHANGE_REQUEST.state);
    expect(url.searchParams.get('redirect_uri')).toBe(EXCHANGE_REQUEST.redirectUri);
    expect(url.searchParams.get('client_id')).toBe('gmail-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe(EXCHANGE_REQUEST.codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(REQUESTED_SCOPE);
  });

  it('removes reserved parameters inherited from the authorization URL', () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          authorizationUrl: `https://${TOKEN_HOST}/oauth/authorize?scope=admin&Code_Challenge=stale&code_challenge_method=plain&audience=mail`,
          scopes: [],
          pkce: 'unsupported',
        },
      },
    });

    const url = new URL(provider.createAuthorizationUrl(EXCHANGE_REQUEST));
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('Code_Challenge')).toBe(false);
    expect(url.searchParams.has('code_challenge_method')).toBe(false);
    expect(url.searchParams.get('audience')).toBe('mail');
  });

  it('removes every duplicate reserved parameter inherited from the authorization URL', () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          authorizationUrl: `https://${TOKEN_HOST}/oauth/authorize?scope=admin&scope=read&audience=mail&audience=calendar`,
          scopes: [],
        },
      },
    });

    const url = new URL(provider.createAuthorizationUrl(EXCHANGE_REQUEST));
    expect(url.searchParams.getAll('scope')).toEqual([]);
    expect(url.searchParams.getAll('audience')).toEqual(['mail', 'calendar']);
  });

  it.each([
    ['authorizationUrl', 'https://auth.company.corp/oauth/authorize'],
    ['tokenUrl', 'https://auth.company.corp/oauth/token'],
  ] as const)('rejects a private-suffix %s at construction', (field, value) => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    expect(() => providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: { ...base, oauth: { ...base.oauth, [field]: value } },
    })).toThrow(`oauth.${field} must be a public DNS hostname`);
  });

  it('fails closed before egress when the token host resolves privately', async () => {
    const { provider, factory } = providerWith({ dnsLookup: lookupReturning(PRIVATE_ADDRESS) });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_not_allowed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed on refresh when tokenUrl resolves to a private address, before any secret is sent', async () => {
    const { provider, factory } = providerWith({ dnsLookup: lookupReturning(PRIVATE_ADDRESS) });
    await expect(provider.refreshCredentials({ refreshToken: REFRESH_TOKEN }))
      .rejects.toThrow('configured_oauth_endpoint_not_allowed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed on revocation when revocationUrl resolves to a private address, before any secret is sent', async () => {
    const { provider, factory } = providerWith({ dnsLookup: lookupReturning(PRIVATE_ADDRESS) });
    await expect(provider.revokeCredentials({ accessToken: ACCESS_TOKEN }))
      .rejects.toThrow('configured_oauth_endpoint_not_allowed');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([404, 410])(
    'treats a %i revocation retry as success after the provider already removed the credential',
    async missingStatus => {
      const responses = [204, missingStatus];
      const { provider } = providerWith({
        dnsLookup: lookupReturning(PUBLIC_ADDRESS),
        fetch: () => Promise.resolve(new Response(null, { status: responses.shift() ?? 500 })),
      });
      const request = {
        accessToken: ACCESS_TOKEN,
        refreshToken: null,
        externalInstallationId: null,
      };

      await expect(provider.revokeCredentials(request)).resolves.toBeUndefined();
      await expect(provider.revokeCredentials(request)).resolves.toBeUndefined();
      expect(responses).toEqual([]);
    },
  );

  it('fails closed when the token host cannot be resolved', async () => {
    const { provider, factory } = providerWith({
      dnsLookup: () => Promise.reject(new Error('ENOTFOUND')),
    });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_resolution_failed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('applies the outbound deadline while DNS resolution is pending', async () => {
    const { provider, factory } = providerWith({
      dnsLookup: () => new Promise(() => {
        // Deliberately remain pending so the provider deadline owns cancellation.
      }),
      requestTimeoutMs: 10,
    });

    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_timeout');
    expect(factory).not.toHaveBeenCalled();
  });

  it('pins the vetted address and refuses redirects for exchange, refresh, and revocation', async () => {
    const { provider, pins, fetchCalls } = providerWith({ dnsLookup: lookupReturning(PUBLIC_ADDRESS) });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST)).resolves.toMatchObject({
      accessToken: FRESH_ACCESS_TOKEN,
    });
    await expect(provider.refreshCredentials({ refreshToken: REFRESH_TOKEN })).resolves.toMatchObject({
      accessToken: FRESH_ACCESS_TOKEN,
    });
    await expect(provider.revokeCredentials({
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      externalInstallationId: null,
    })).resolves.toBeUndefined();

    expect(pins).toEqual(Array.from({ length: 3 }, () => ({
      hostname: TOKEN_HOST,
      address: PUBLIC_ADDRESS,
      family: 4,
    })));
    expect(fetchCalls.map(call => call.redirect)).toEqual(['error', 'error', 'error']);
  });

  it('returns narrowed scopes supplied by the provider during refresh', async () => {
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        access_token: FRESH_ACCESS_TOKEN,
        scope: 'gmail.metadata',
      }), { status: 200 })),
    });

    await expect(provider.refreshCredentials({
      refreshToken: REFRESH_TOKEN,
      authorizedPermissions: { scopes: [REQUESTED_SCOPE] },
    })).resolves.toMatchObject({
      accessToken: FRESH_ACCESS_TOKEN,
      authorizedPermissions: { scopes: ['gmail.metadata'] },
    });
  });

  it('preserves recorded permissions when a refresh response omits scope', async () => {
    const { provider } = providerWith({ dnsLookup: lookupReturning(PUBLIC_ADDRESS) });

    const refreshed = await provider.refreshCredentials({
      refreshToken: REFRESH_TOKEN,
      authorizedPermissions: { scopes: [REQUESTED_SCOPE] },
    });

    expect(refreshed).not.toHaveProperty('authorizedPermissions');
  });

  it('uses HTTP Basic client auth without duplicating credentials in the form body', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider, fetchCalls } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          tokenExchange: { ...base.oauth.tokenExchange, clientAuth: 'basic' },
        },
      },
    });

    await provider.exchangeAuthorizationCode(EXCHANGE_REQUEST);
    expect(fetchCalls[0].authorization).toBe(
      `Basic ${Buffer.from('gmail-client-id:gmail-client-secret', 'utf8').toString('base64')}`,
    );
    expect(fetchCalls[0].body).not.toContain('client_id=');
    expect(fetchCalls[0].body).not.toContain('client_secret=');
  });

  it('form-encodes reserved characters in HTTP Basic client credentials', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider, fetchCalls } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      clientSecret: 'secret% value',
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          clientId: 'client:id',
          tokenExchange: { ...base.oauth.tokenExchange, clientAuth: 'basic' },
        },
      },
    });

    await provider.exchangeAuthorizationCode(EXCHANGE_REQUEST);

    expect(fetchCalls[0].authorization).toBe(
      `Basic ${Buffer.from('client%3Aid:secret%25+value', 'utf8').toString('base64')}`,
    );
  });

  it('honors HTTP Basic client auth during revocation', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider, fetchCalls } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: {
        ...base,
        oauth: {
          ...base.oauth,
          tokenExchange: { ...base.oauth.tokenExchange, clientAuth: 'basic' },
        },
      },
    });

    await provider.revokeCredentials({
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      externalInstallationId: null,
    });

    expect(fetchCalls[0].authorization).toBe(
      `Basic ${Buffer.from('gmail-client-id:gmail-client-secret', 'utf8').toString('base64')}`,
    );
    expect(fetchCalls[0].body).toBe('token=access-token&token_type_hint=access_token');
  });

  it('revokes refresh credentials before access credentials', async () => {
    const { provider, fetchCalls } = providerWith({ dnsLookup: lookupReturning(PUBLIC_ADDRESS) });

    await provider.revokeCredentials({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      externalInstallationId: null,
    });

    expect(fetchCalls.map(call => call.body)).toEqual([
      'token=refresh-token&token_type_hint=refresh_token&client_id=gmail-client-id&client_secret=gmail-client-secret',
      'token=access-token&token_type_hint=access_token&client_id=gmail-client-id&client_secret=gmail-client-secret',
    ]);
  });

  it('treats a provider revocation server error as failure', async () => {
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response('{}', { status: 500 })),
    });

    await expect(provider.revokeCredentials({
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      externalInstallationId: null,
    })).rejects.toThrow('configured_oauth_revocation_failed');
  });

  it('records scopes returned by the provider instead of overstating the grant', async () => {
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        access_token: FRESH_ACCESS_TOKEN,
        scope: 'gmail.metadata gmail.readonly gmail.metadata',
      }), { status: 200 })),
    });

    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST)).resolves.toMatchObject({
      authorizedPermissions: { scopes: ['gmail.metadata', REQUESTED_SCOPE] },
    });
  });

  it.each([
    [{ access_token: FRESH_ACCESS_TOKEN, email: 'x'.repeat(201) }],
    [{
      access_token: FRESH_ACCESS_TOKEN,
      scope: Array.from({ length: 101 }, (_, index) => `scope-${index}`).join(' '),
    }],
  ])('rejects token-response metadata that cannot be stored safely', async responseBody => {
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 })),
    });

    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_token_exchange_failed');
  });

  it('fails closed when refresh is unsupported', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error(OAUTH_FIXTURE_MISSING);
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: { ...base, oauth: { ...base.oauth, refresh: 'none' } },
    });

    await expect(provider.refreshCredentials({ refreshToken: REFRESH_TOKEN }))
      .rejects.toThrow('configured_oauth_refresh_not_supported');
  });

  it('rejects a streaming token response that exceeds the byte cap', async () => {
    let canceled = false;
    const chunk = new Uint8Array(70 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4; index += 1) controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });

    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_response_too_large');
    expect(canceled).toBe(true);
  });

  it('accepts bounded BOM-prefixed JSON for token exchange and refresh', async () => {
    const responseBody = `\uFEFF${JSON.stringify({
      access_token: 'bom-access-token',
      refresh_token: 'bom-refresh-token',
      email: 'bom@example.com',
    })}`;
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST)).resolves.toMatchObject({
      accessToken: 'bom-access-token',
      refreshToken: 'bom-refresh-token',
      accountLabel: 'bom@example.com',
    });
    await expect(provider.refreshCredentials({ refreshToken: 'old-refresh-token' })).resolves.toEqual({
      accessToken: 'bom-access-token',
      refreshToken: 'bom-refresh-token',
    });
  });

  it('rejects an oversized token response from its content-length before reading', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.resolve();
      },
      cancel() {
        canceled = true;
      },
    });
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(300 * 1024),
        },
      })),
    });

    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_response_too_large');
    expect(canceled).toBe(true);
  });
});
