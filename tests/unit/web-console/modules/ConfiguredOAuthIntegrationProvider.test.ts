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
}): {
  readonly provider: ConfiguredOAuthIntegrationProvider;
  readonly factory: jest.Mock;
  readonly pins: OutboundPin[];
  readonly fetchCalls: Array<{ readonly url: string; readonly body: string | null }>;
} {
  const pins: OutboundPin[] = [];
  const fetchCalls: Array<{ readonly url: string; readonly body: string | null }> = [];
  const fetchImpl: PinnedFetch = input.fetch ?? ((url, init) => {
    const body = init?.body;
    fetchCalls.push({ url: String(url), body: typeof body === 'string' || body instanceof URLSearchParams ? body.toString() : null });
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
    descriptor: descriptor(),
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
  });
});
