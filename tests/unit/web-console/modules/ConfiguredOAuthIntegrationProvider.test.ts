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
const PUBLIC_ADDRESS = '8.8.8.8';
const PRIVATE_ADDRESS = '10.0.0.5';

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
      tokenExchange: {
        style: 'form',
        clientAuth: 'body',
        revocationUrl: `https://${TOKEN_HOST}/oauth/revoke`,
      },
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

describe('ConfiguredOAuthIntegrationProvider endpoint security', () => {
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
    ['authorizationUrl', 'https://auth.company.corp/oauth/authorize'],
    ['tokenUrl', 'https://auth.company.corp/oauth/token'],
  ] as const)('rejects a private-suffix %s at construction', (field, value) => {
    const base = descriptor();
    if (!base.oauth) throw new Error('fixture oauth missing');
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

  it('fails closed when the token host cannot be resolved', async () => {
    const { provider, factory } = providerWith({
      dnsLookup: () => Promise.reject(new Error('ENOTFOUND')),
    });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST))
      .rejects.toThrow('configured_oauth_endpoint_resolution_failed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('pins the vetted address and refuses redirects for exchange, refresh, and revocation', async () => {
    const { provider, pins, fetchCalls } = providerWith({ dnsLookup: lookupReturning(PUBLIC_ADDRESS) });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST)).resolves.toMatchObject({
      accessToken: 'fresh-access-token',
    });
    await expect(provider.refreshCredentials({ refreshToken: 'refresh-token' })).resolves.toMatchObject({
      accessToken: 'fresh-access-token',
    });
    await expect(provider.revokeCredentials({ accessToken: 'access-token' })).resolves.toBeUndefined();

    expect(pins).toEqual(Array.from({ length: 3 }, () => ({
      hostname: TOKEN_HOST,
      address: PUBLIC_ADDRESS,
      family: 4,
    })));
    expect(fetchCalls.map(call => call.redirect)).toEqual(['error', 'error', 'error']);
  });

  it('uses HTTP Basic client auth without duplicating credentials in the form body', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error('fixture oauth missing');
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

  it('honors HTTP Basic client auth during revocation', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error('fixture oauth missing');
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

    await provider.revokeCredentials({ accessToken: 'access-token' });

    expect(fetchCalls[0].authorization).toBe(
      `Basic ${Buffer.from('gmail-client-id:gmail-client-secret', 'utf8').toString('base64')}`,
    );
    expect(fetchCalls[0].body).toBe('token=access-token');
  });

  it('records scopes returned by the provider instead of overstating the grant', async () => {
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        access_token: 'fresh-access-token',
        scope: 'gmail.metadata gmail.readonly gmail.metadata',
      }), { status: 200 })),
    });

    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST)).resolves.toMatchObject({
      authorizedPermissions: { scopes: ['gmail.metadata', 'gmail.readonly'] },
    });
  });

  it('fails closed when refresh is unsupported', async () => {
    const base = descriptor();
    if (!base.oauth) throw new Error('fixture oauth missing');
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      descriptor: { ...base, oauth: { ...base.oauth, refresh: 'none' } },
    });

    await expect(provider.refreshCredentials({ refreshToken: 'refresh-token' }))
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

  it('accepts bounded BOM-prefixed JSON', async () => {
    const responseBody = `\uFEFF${JSON.stringify({ access_token: 'bom-access-token' })}`;
    const { provider } = providerWith({
      dnsLookup: lookupReturning(PUBLIC_ADDRESS),
      fetch: () => Promise.resolve(new Response(responseBody, { status: 200 })),
    });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE_REQUEST)).resolves.toMatchObject({
      accessToken: 'bom-access-token',
    });
  });
});
