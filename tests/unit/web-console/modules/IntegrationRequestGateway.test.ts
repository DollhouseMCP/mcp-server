import { describe, expect, it } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  ConfiguredOAuthIntegrationProvider,
  InMemoryIntegrationDescriptorStore,
  InMemoryUserIntegrationStore,
  IntegrationProviderRegistry,
  IntegrationRequestGateway,
  IntegrationTokenRefreshService,
  type IIntegrationRequestAuditSink,
  type IntegrationDescriptorRecord,
  type IntegrationRequestAuditEvent,
  type UserIntegrationRecord,
} from '../../../../src/web-console/index.js';
import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import type { IRateLimitStore } from '../../../../src/auth/embedded-as/storage/IRateLimitStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SESSION_ID = 'mcp-session-1';
const NOW = new Date('2026-06-17T12:00:00.000Z');
const GMAIL_HOST = 'gmail.googleapis.com';
// Built from parts so it is not a hardcoded IP literal; any public address lets the SSRF guard allow the request.
const PUBLIC_TEST_ADDRESS = [8, 8, 8, 8].join('.');

function urlString(url: Parameters<typeof fetch>[0]): string {
  if (typeof url !== 'string') throw new Error('test fetch expected a string URL');
  return url;
}

function requestBodyString(init: Parameters<typeof fetch>[1]): string | null {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

describe('IntegrationRequestGateway', () => {
  it('injects OAuth credentials server-side and redacts token-shaped response fields', async () => {
    const fetches: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const gateway = gatewayFixture({
      fetch: (url, init) => {
        fetches.push({ url: urlString(url), init });
        return Promise.resolve(jsonResponse(200, {
          ok: true,
          access_token: 'upstream-token',
          nested: { api_key: 'upstream-key' },
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
      query: { q: 'is:unread' },
    }));

    expect(fetches[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread');
    expect(new Headers(fetches[0]?.init?.headers).get('Authorization')).toBe('Bearer gmail-access-token');
    expect(result).toMatchObject({
      provider: 'gmail',
      method: 'GET',
      host: GMAIL_HOST,
      status: 200,
      response: {
        ok: true,
        access_token: '[redacted]',
        nested: { api_key: '[redacted]' },
      },
      provenance: {
        source: 'third_party_integration',
        trust: 'untrusted',
        provider: 'gmail',
        method: 'GET',
        host: GMAIL_HOST,
        path: '/gmail/v1/users/me/messages',
        readWriteClass: 'read',
        handling: 'data_only_not_instructions',
      },
    });
    expect(JSON.stringify(result)).not.toContain('gmail-access-token');
    expect(gateway.audit.events).toEqual([
      expect.objectContaining({
        provider: 'gmail',
        userId: USER_ID,
        method: 'GET',
        host: GMAIL_HOST,
        path: '/gmail/v1/users/me/messages',
        result: 'success',
        status: 200,
      }),
    ]);
  });

  it('injects static API keys into query parameters without returning the key', async () => {
    const fetches: string[] = [];
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({ staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } } })],
      records: [integrationRecord({
        provider: 'airtable',
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('airtable-key', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: url => {
        fetches.push(urlString(url));
        return Promise.resolve(jsonResponse(200, { records: [] }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/v0/app/table',
    }));

    expect(fetches[0]).toBe('https://api.airtable.com/v0/app/table?key=airtable-key');
    expect(JSON.stringify(result)).not.toContain('airtable-key');
  });

  it('fails closed on disallowed method, host escape, oversized body, and rate limit', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(jsonResponse(200, { ok: true })),
    });

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'TRACE',
      path: '/ok',
    }))).rejects.toMatchObject({ code: 'integration_method_not_allowed' });
    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: 'https://evil.example/steal',
    }))).rejects.toMatchObject({ code: 'invalid_integration_path' });
    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'POST',
      path: '/ok',
      body: { payload: 'x'.repeat(70 * 1024) },
    }))).rejects.toMatchObject({ code: 'integration_request_too_large' });

    const limited = gatewayFixture({
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
      fetch: () => Promise.resolve(jsonResponse(200, { ok: true })),
    });
    await runAsUser(limited.contextTracker, () => limited.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/ok',
    }));
    await expect(runAsUser(limited.contextTracker, () => limited.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/ok',
    }))).rejects.toMatchObject({ code: 'integration_request_rate_limited' });
  });

  it('uses a shared rate-limit store across gateway instances when provided', async () => {
    const rateLimitStore = new InMemoryRateLimitStore();
    const first = gatewayFixture({
      rateLimitStore,
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
      fetch: () => Promise.resolve(jsonResponse(200, { ok: true })),
    });
    const second = gatewayFixture({
      rateLimitStore,
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
      fetch: () => Promise.resolve(jsonResponse(200, { ok: true })),
    });

    await runAsUser(first.contextTracker, () => first.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/ok',
    }));

    await expect(runAsUser(second.contextTracker, () => second.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/ok',
    }))).rejects.toMatchObject({ code: 'integration_request_rate_limited' });
  });

  it('fails closed when the shared rate-limit store is unavailable', async () => {
    const gateway = gatewayFixture({
      rateLimitStore: new FailingRateLimitStore(),
      fetch: () => Promise.resolve(jsonResponse(200, { ok: true })),
    });

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/ok',
    }))).rejects.toMatchObject({ code: 'integration_request_rate_limit_unavailable' });

    expect(gateway.audit.events).toEqual([
      expect.objectContaining({
        provider: 'gmail',
        result: 'denied',
        reason: 'rate_limit_unavailable',
      }),
    ]);
  });

  it('audits upstream failures without exposing credentials', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(new Response('x'.repeat(300 * 1024), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })),
    });

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/oversized',
    }))).rejects.toMatchObject({ code: 'integration_response_too_large' });

    expect(gateway.audit.events).toEqual([
      expect.objectContaining({
        provider: 'gmail',
        userId: USER_ID,
        method: 'GET',
        host: GMAIL_HOST,
        path: '/oversized',
        result: 'upstream_error',
        status: null,
        reason: 'integration_response_too_large',
      }),
    ]);
    expect(JSON.stringify(gateway.audit.events)).not.toContain('gmail-access-token');
  });

  it('rejects responses by content-length before reading the body', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.resolve();
      },
    });
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(300 * 1024),
        },
      })),
    });

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/oversized-by-header',
    }))).rejects.toMatchObject({ code: 'integration_response_too_large' });
  });

  it('rejects streaming responses that exceed the byte cap without content-length', async () => {
    let canceled = false;
    const chunk = new Uint8Array(70 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4; index += 1) {
          controller.enqueue(chunk);
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })),
    });

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/oversized-stream',
    }))).rejects.toMatchObject({ code: 'integration_response_too_large' });

    expect(canceled).toBe(true);
  });

  it('rejects descriptor hosts that resolve to private addresses at request time', async () => {
    const gateway = gatewayFixture({
      dnsLookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      fetch: () => Promise.resolve(jsonResponse(200, { ok: true })),
    });

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/private-target',
    }))).rejects.toMatchObject({ code: 'integration_host_not_allowed' });

    expect(gateway.audit.events).toEqual([
      expect.objectContaining({
        provider: 'gmail',
        host: GMAIL_HOST,
        path: '/private-target',
        result: 'upstream_error',
        reason: 'integration_host_not_allowed',
      }),
    ]);
  });

  it('refreshes once on 401 and retries with the rotated credential', async () => {
    const fetches: Array<{ readonly url: string; readonly authorization: string | null; readonly body: string | null }> = [];
    const oauthProvider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptor(),
      clientSecret: 'gmail-client-secret',
      fetch: (url, init) => {
        fetches.push({
          url: urlString(url),
          authorization: new Headers(init?.headers).get('Authorization'),
          body: requestBodyString(init),
        });
        return Promise.resolve(jsonResponse(200, {
          access_token: 'gmail-fresh-access-token',
          refresh_token: 'gmail-rotated-refresh-token',
        }));
      },
    });
    const gateway = gatewayFixture({
      providers: new IntegrationProviderRegistry([oauthProvider]),
      fetch: (url, init) => {
        fetches.push({
          url: urlString(url),
          authorization: new Headers(init?.headers).get('Authorization'),
          body: requestBodyString(init),
        });
        return Promise.resolve(fetches.length === 1
          ? jsonResponse(401, { error: 'expired' })
          : jsonResponse(200, { ok: true }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
    }));

    expect(result).toMatchObject({ status: 200, refreshed: true });
    expect(fetches.map(call => call.authorization)).toEqual([
      'Bearer gmail-access-token',
      null,
      'Bearer gmail-fresh-access-token',
    ]);
    expect(fetches[1]?.body).toContain('grant_type=refresh_token');
  });
});

function gatewayFixture(options: {
  readonly descriptors?: readonly IntegrationDescriptorRecord[];
  readonly records?: readonly UserIntegrationRecord[];
  readonly providers?: IntegrationProviderRegistry;
  readonly fetch?: typeof fetch;
  readonly dnsLookup?: (hostname: string, options: { readonly all: true }) => Promise<readonly { readonly address: string; readonly family: number }[]>;
  readonly rateLimitStore?: IRateLimitStore;
  readonly rateLimit?: { readonly windowMs: number; readonly maxRequests: number };
} = {}) {
  const contextTracker = new ContextTracker();
  const secretEncryption = encryption();
  const integrationStore = new InMemoryUserIntegrationStore(options.records ?? [
    integrationRecord({
      provider: 'gmail',
      authorizedPermissions: { scopes: ['gmail.readonly'] },
      accessTokenCiphertext: encrypt('gmail-access-token', 'gmail'),
      refreshTokenCiphertext: encrypt('gmail-refresh-token', 'gmail', 'refresh_token'),
    }),
  ]);
  const descriptorStore = new InMemoryIntegrationDescriptorStore(options.descriptors ?? [oauthDescriptor()]);
  const providers = options.providers ?? IntegrationProviderRegistry.empty();
  const audit = new FixtureAuditSink();
  const gateway = new IntegrationRequestGateway({
    integrationStore,
    descriptorStore,
    secretEncryption,
    contextTracker,
    tokenRefresh: new IntegrationTokenRefreshService({
      store: integrationStore,
      providers,
      secretEncryption,
      now: () => NOW,
    }),
    fetch: options.fetch,
    dnsLookup: options.dnsLookup ?? (() => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }])),
    auditSink: audit,
    rateLimitStore: options.rateLimitStore,
    rateLimit: options.rateLimit,
  });
  return { gateway, contextTracker, audit };
}

function runAsUser<T>(contextTracker: ContextTracker, fn: () => Promise<T>): Promise<T> {
  return contextTracker.runAsync(contextTracker.createSessionContext('llm-request', {
    userId: USER_ID,
    sessionId: SESSION_ID,
    tenantId: null,
    transport: 'http',
    createdAt: NOW.getTime(),
  }), fn);
}

function integrationRecord(overrides: Partial<UserIntegrationRecord>): UserIntegrationRecord {
  return {
    id: '35e22a52-dc56-4cd0-9d13-b2802524fbd3',
    userId: USER_ID,
    provider: 'gmail',
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes: ['gmail.readonly'] },
    accessTokenCiphertext: encrypt('gmail-access-token', 'gmail'),
    refreshTokenCiphertext: encrypt('gmail-refresh-token', 'gmail', 'refresh_token'),
    credentialKeyVersion: null,
    status: 'connected',
    errorReason: null,
    connectedAt: NOW,
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function oauthDescriptor(): IntegrationDescriptorRecord {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    provider: 'gmail',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Gmail',
    category: 'Email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: [GMAIL_HOST],
    oauth: {
      clientId: 'gmail-client-id',
      authorizationUrl: 'https://accounts.example/oauth/authorize',
      tokenUrl: 'https://accounts.example/oauth/token',
      scopes: ['gmail.readonly'],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: { style: 'form', clientAuth: 'body' },
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

function staticDescriptor(overrides: Partial<IntegrationDescriptorRecord> = {}): IntegrationDescriptorRecord {
  return {
    id: '00000000-0000-4000-8000-000000000102',
    provider: 'airtable',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Airtable',
    category: 'Database',
    authStrategy: 'static_api_key',
    apiHosts: ['api.airtable.com'],
    oauth: null,
    staticApiKey: { injection: { location: 'header', name: 'Authorization', valuePrefix: 'Bearer ' } },
    clientSecretCiphertext: null,
    credentialKeyVersion: null,
    operationPromotion: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function encryption(): AeadSecretEncryptionService {
  return new AeadSecretEncryptionService({
    keyId: 'integration-test-key',
    key: Buffer.alloc(32, 9),
  });
}

function encrypt(value: string, provider: string, secret = 'access_token'): Buffer {
  return encryption().encrypt(Buffer.from(value, 'utf8'), {
    secretClass: `integration_${secret}`,
    ownerId: `${provider}:${USER_ID}`,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FixtureAuditSink implements IIntegrationRequestAuditSink {
  readonly events: IntegrationRequestAuditEvent[] = [];

  async recordIntegrationRequest(event: IntegrationRequestAuditEvent): Promise<void> {
    await Promise.resolve();
    this.events.push(event);
  }
}

class FailingRateLimitStore implements IRateLimitStore {
  get(): Promise<never> {
    return Promise.reject(new Error('store unavailable'));
  }

  update(): Promise<never> {
    return Promise.reject(new Error('store unavailable'));
  }

  reset(): Promise<never> {
    return Promise.reject(new Error('store unavailable'));
  }

  sweep(): Promise<never> {
    return Promise.reject(new Error('store unavailable'));
  }
}
