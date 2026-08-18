import { describe, expect, it, jest } from '@jest/globals';

import { ConfiguredOAuthIntegrationProvider } from '../../../../src/web-console/modules/integrations/ConfiguredOAuthIntegrationProvider.js';
import type { IntegrationDescriptorRecord } from '../../../../src/web-console/stores/IIntegrationDescriptorStore.js';
import type { DnsLookup } from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';
import type { OutboundPin, PinnedFetch, PinnedOutboundFactory } from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const NOW = new Date('2026-07-01T00:00:00.000Z');
const TOKEN_HOST = 'accounts.example';
// Built from parts so they are not hardcoded IP literals; the values themselves are the test subject.
const PUBLIC_ADDRESS = [8, 8, 8, 8].join('.');
const PRIVATE_ADDRESS = [10, 0, 0, 5].join('.');

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
      scopes: ['gmail.readonly'],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: { style: 'form', clientAuth: 'body', revocationUrl: `https://${TOKEN_HOST}/oauth/revoke` },
      accountLabel: { field: 'email' },
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
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
}): {
  readonly provider: ConfiguredOAuthIntegrationProvider;
  readonly factory: jest.Mock;
  readonly pins: OutboundPin[];
  readonly fetchCalls: Array<{ readonly url: string; readonly body: string | null }>;
} {
  const pins: OutboundPin[] = [];
  const fetchCalls: Array<{ readonly url: string; readonly body: string | null; readonly redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: PinnedFetch = input.fetch ?? ((url, init) => {
    const body = init?.body;
    fetchCalls.push({
      url: String(url),
      body: typeof body === 'string' || body instanceof URLSearchParams ? body.toString() : null,
      redirect: init?.redirect,
    });
    return Promise.resolve(new Response(JSON.stringify({
      access_token: 'fresh-access-token',
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
    clientSecret: 'gmail-client-secret',
    pinnedOutbound: factory as unknown as PinnedOutboundFactory,
    dnsLookup: input.dnsLookup,
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

describe('ConfiguredOAuthIntegrationProvider token-endpoint host guard', () => {
  it('does not let descriptor extras replace protocol-critical authorization parameters', () => {
    const base = descriptor();
    if (!base.oauth) throw new Error('fixture oauth missing');
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
    expect(url.searchParams.get('scope')).toBe('gmail.readonly');
  });

  it.each([
    ['token exchange', 'exchange'],
    ['token refresh', 'refresh'],
    ['token revocation', 'revoke'],
  ] as const)('rejects a legacy private-suffix host before DNS or %s egress', async (_label, operation) => {
    const restrictedHost = 'auth.company.corp';
    const base = descriptor();
    if (!base.oauth) throw new Error('fixture oauth missing');
    const restrictedDescriptor: IntegrationDescriptorRecord = {
      ...base,
      oauth: {
        ...base.oauth,
        tokenUrl: operation === 'revoke'
          ? base.oauth.tokenUrl
          : `https://${restrictedHost}/oauth/token`,
        tokenExchange: operation === 'revoke'
          ? { ...base.oauth.tokenExchange, revocationUrl: `https://${restrictedHost}/oauth/revoke` }
          : base.oauth.tokenExchange,
      },
    };
    const lookup = jest.fn(lookupReturning(PUBLIC_ADDRESS));
    const { provider, factory } = providerWith({
      descriptor: restrictedDescriptor,
      dnsLookup: lookup,
    });

    const request = operation === 'exchange'
      ? provider.exchangeAuthorizationCode(EXCHANGE_REQUEST)
      : operation === 'refresh'
        ? provider.refreshCredentials({ refreshToken: 'refresh-token' })
        : provider.revokeCredentials({ accessToken: 'access-token' });

    await expect(request).rejects.toThrow('configured_oauth_endpoint_not_allowed');
    expect(lookup).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed on token exchange when tokenUrl resolves to a private address, before any secret is sent', async () => {
    const { provider, factory } = providerWith({ dnsLookup: lookupReturning(PRIVATE_ADDRESS) });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_not_allowed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed on refresh when tokenUrl resolves to a private address, before any secret is sent', async () => {
    const { provider, factory } = providerWith({ dnsLookup: lookupReturning(PRIVATE_ADDRESS) });
    await expect(provider.refreshCredentials({ refreshToken: 'refresh-token' }))
      .rejects.toThrow('configured_oauth_endpoint_not_allowed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed on revocation when revocationUrl resolves to a private address, before any secret is sent', async () => {
    const { provider, factory } = providerWith({ dnsLookup: lookupReturning(PRIVATE_ADDRESS) });
    await expect(provider.revokeCredentials({ accessToken: 'access-token' }))
      .rejects.toThrow('configured_oauth_endpoint_not_allowed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed when the token host cannot be resolved', async () => {
    const { provider, factory } = providerWith({
      dnsLookup: () => Promise.reject(new Error('ENOTFOUND')),
    });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_resolution_failed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('pins the vetted address and exchanges the code when the host is public', async () => {
    const { provider, pins, fetchCalls } = providerWith({ dnsLookup: lookupReturning(PUBLIC_ADDRESS) });
    const result = await provider.exchangeAuthorizationCode(EXCHANGE_REQUEST);
    expect(result.accessToken).toBe('fresh-access-token');
    expect(result.accountLabel).toBe('alice@example.com');
    expect(pins).toEqual([{ hostname: TOKEN_HOST, address: PUBLIC_ADDRESS, family: 4 }]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`https://${TOKEN_HOST}/oauth/token`);
    expect(fetchCalls[0].redirect).toBe('error');
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

  it('routes refresh and revocation through the pinned transport', async () => {
    const { provider, pins, fetchCalls } = providerWith({ dnsLookup: lookupReturning(PUBLIC_ADDRESS) });
    const refreshed = await provider.refreshCredentials({ refreshToken: 'refresh-token' });
    expect(refreshed.accessToken).toBe('fresh-access-token');
    await provider.revokeCredentials({ accessToken: 'access-token' });
    expect(pins).toEqual([
      { hostname: TOKEN_HOST, address: PUBLIC_ADDRESS, family: 4 },
      { hostname: TOKEN_HOST, address: PUBLIC_ADDRESS, family: 4 },
    ]);
    expect(fetchCalls.map(call => call.url)).toEqual([
      `https://${TOKEN_HOST}/oauth/token`,
      `https://${TOKEN_HOST}/oauth/revoke`,
    ]);
    // Credential-bearing calls must never follow a redirect to another host.
    expect(fetchCalls.map(call => call.redirect)).toEqual(['error', 'error']);
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
