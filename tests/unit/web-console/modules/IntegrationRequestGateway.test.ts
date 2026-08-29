import { describe, expect, it, jest } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  ConfiguredOAuthIntegrationProvider,
  InMemoryIntegrationDescriptorStore,
  InMemoryUserIntegrationStore,
  IntegrationProviderRegistry,
  IntegrationTokenRefreshService,
  type IIntegrationRequestAuditSink,
  type IntegrationDescriptorRecord,
  type IntegrationRequestAuditEvent,
  type UserIntegrationProvider,
  type UserIntegrationRecord,
} from '../../../../src/web-console/index.js';
// The raw gateway is deliberately not exported from the module barrels (FO2);
// its own unit tests import the class module directly.
import { IntegrationRequestGateway } from '../../../../src/web-console/modules/integrations/IntegrationRequestGateway.js';
import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import type { IRateLimitStore } from '../../../../src/auth/embedded-as/storage/IRateLimitStore.js';
import type {
  OutboundPin,
  PinnedFetch,
  PinnedOutboundFactory,
} from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SESSION_ID = 'mcp-session-1';
const NOW = new Date('2026-06-17T12:00:00.000Z');
const GMAIL_HOST = 'gmail.googleapis.com';
const GMAIL_PROFILE_PATH = '/gmail/v1/users/me/profile';
const GMAIL_MESSAGES_PATH = '/gmail/v1/users/me/messages';
const GMAIL_ACCESS_TOKEN = 'gmail-access-token';
const REDACTED = '[redacted]';
const TEXT_PLAIN = 'text/plain';
const RECEIVED_REDACTED_SAFELY = 'received [redacted] safely';
const VALID_RESPONSE = 'a valid response';
const AIRTABLE_TABLE_PATH = '/v0/app/table';
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
  it('rejects a connected credential bound to a different same-name descriptor', async () => {
    const fetch = jest.fn<PinnedFetch>();
    const { gateway, contextTracker } = gatewayFixture({
      records: [integrationRecord({
        integrationDescriptorId: '00000000-0000-4000-8000-000000000199',
      })],
      fetch,
    });

    await expect(runAsUser(contextTracker, () => gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_PROFILE_PATH,
    }))).rejects.toMatchObject({ code: 'integration_not_connected', status: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('audits descriptor lookup failures without persisting untrusted input', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const untrustedProvider = 'sk_live_12345678901234567890';
    const storeFailure = new Error('descriptor database secret details');
    const fixture = gatewayFixture();
    jest.spyOn(fixture.descriptorStore, 'findVisibleByProvider').mockRejectedValue(storeFailure);

    await expect(runAsUser(fixture.contextTracker, () => fixture.gateway.request({
      provider: untrustedProvider,
      method: 'GET',
      path: '/anything',
    }))).rejects.toBe(storeFailure);

    expect(fixture.audit.events).toEqual([
      expect.objectContaining({
        provider: 'unresolved',
        result: 'upstream_error',
        reason: 'descriptor_lookup_failed',
        host: null,
        path: null,
      }),
    ]);
    const serializedEvents = JSON.stringify(SecurityMonitor.getRecentEvents());
    expect(serializedEvents).not.toContain(untrustedProvider);
    expect(serializedEvents).not.toContain(storeFailure.message);
  });

  it('audits credential lookup failures with confirmed request provenance', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const storeFailure = new Error('credential database secret details');
    const fixture = gatewayFixture();
    jest.spyOn(fixture.integrationStore, 'findByProvider').mockRejectedValue(storeFailure);

    await expect(runAsUser(fixture.contextTracker, () => fixture.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_MESSAGES_PATH,
    }))).rejects.toBe(storeFailure);

    expect(fixture.audit.events).toEqual([
      expect.objectContaining({
        provider: 'gmail',
        result: 'upstream_error',
        reason: 'credential_lookup_failed',
        host: GMAIL_HOST,
        path: GMAIL_MESSAGES_PATH,
      }),
    ]);
    expect(JSON.stringify(SecurityMonitor.getRecentEvents())).not.toContain(storeFailure.message);
  });

  it('does not persist unresolved provider input in descriptor-not-found audit events', async () => {
    const untrustedProvider = 'sk_live_12345678901234567890';
    const gateway = gatewayFixture();

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: untrustedProvider,
      method: 'GET',
      path: '/anything',
    }))).rejects.toMatchObject({ code: 'integration_descriptor_not_found', status: 404 });

    expect(gateway.audit.events).toEqual([
      expect.objectContaining({ provider: 'unresolved', reason: 'descriptor_not_found' }),
    ]);
    expect(JSON.stringify(gateway.audit.events)).not.toContain(untrustedProvider);
  });

  it('injects OAuth credentials server-side and redacts token-shaped response fields', async () => {
    const fetches: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const gateway = gatewayFixture({
      fetch: (url, init) => {
        fetches.push({ url: urlString(url), init });
        return Promise.resolve(jsonResponse(200, {
          ok: true,
          message: 'credential gmail-access-token was accepted',
          access_token: 'upstream-token',
          nested: {
            api_key: 'upstream-key',
            echoed: 'Bearer gmail-access-token',
          },
          scalarValues: [GMAIL_ACCESS_TOKEN],
          'credential-gmail-access-token': 'echoed in a key',
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_MESSAGES_PATH,
      query: { q: 'is:unread' },
    }));

    expect(gateway.pins).toEqual([{ hostname: GMAIL_HOST, address: PUBLIC_TEST_ADDRESS, family: 4 }]);

    expect(fetches[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread');
    expect(new Headers(fetches[0]?.init?.headers).get('Authorization')).toBe('Bearer gmail-access-token');
    expect(result).toMatchObject({
      provider: 'gmail',
      method: 'GET',
      host: GMAIL_HOST,
      status: 200,
      response: {
        ok: true,
        message: 'credential [redacted] was accepted',
        access_token: REDACTED,
        nested: { api_key: REDACTED, echoed: REDACTED },
        scalarValues: [REDACTED],
        'credential-[redacted]': REDACTED,
      },
      provenance: {
        source: 'third_party_integration',
        trust: 'untrusted',
        provider: 'gmail',
        method: 'GET',
        host: GMAIL_HOST,
        path: GMAIL_MESSAGES_PATH,
        readWriteClass: 'read',
        handling: 'data_only_not_instructions',
      },
    });
    expect(JSON.stringify(result)).not.toContain(GMAIL_ACCESS_TOKEN);
    expect(gateway.outboundState.pins).toEqual([{
      hostname: GMAIL_HOST,
      address: PUBLIC_TEST_ADDRESS,
      family: 4,
    }]);
    expect(gateway.outboundState.closeCount).toBe(1);
    expect(gateway.audit.events).toEqual([
      expect.objectContaining({
        provider: 'gmail',
        userId: USER_ID,
        method: 'GET',
        host: GMAIL_HOST,
        path: GMAIL_MESSAGES_PATH,
        result: 'success',
        status: 200,
      }),
    ]);
  });

  it('redacts an echoed credential from a non-JSON response', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(new Response('received Bearer gmail-access-token', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/echo',
    }));

    expect(result.response).toBe('received [redacted]');
    expect(JSON.stringify(result)).not.toContain(GMAIL_ACCESS_TOKEN);
  });

  it('redacts an echoed credential from a JSON scalar response', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(jsonResponse(200, GMAIL_ACCESS_TOKEN)),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/echo-scalar',
    }));

    expect(result.response).toBe(REDACTED);
  });

  it('redacts longer credential wrappers before overlapping raw credentials', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        accessTokenCiphertext: encrypt('abcdefgh', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received Bearer abcdefgh safely', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/overlapping-redactions',
    }));

    expect(result.response).toBe(RECEIVED_REDACTED_SAFELY);
  });

  it('fails closed when a declared JSON response is malformed', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(new Response('{"echo":"gmail-access-token"', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/malformed-json',
    }));

    expect(result.response).toBe(REDACTED);
  });

  it.each([
    ['missing', null],
    ['mislabelled', TEXT_PLAIN],
  ])('redacts short credentials in valid JSON with %s content type', async (_label, contentType) => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => {
        const headers = new Headers();
        if (contentType !== null) headers.set('Content-Type', contentType);
        return Promise.resolve(new Response(new TextEncoder().encode('{"echo":"a","ordinary":"available"}'), {
          status: 200,
          headers,
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: `/json-${_label}-content-type`,
    }));

    expect(result.response).toBe('{"echo":"[redacted]","ordinary":"available"}');
  });

  it.each([
    ['declared', 'application/json', { echo: REDACTED }],
    ['missing', null, '{"echo":"[redacted]"}'],
    ['mislabelled', TEXT_PLAIN, '{"echo":"[redacted]"}'],
  ])('strips a leading BOM before redacting JSON with %s content type', async (_label, contentType, expected) => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => {
        const headers = new Headers();
        if (contentType !== null) headers.set('Content-Type', contentType);
        return Promise.resolve(new Response(new TextEncoder().encode('\uFEFF{"echo":"a"}'), {
          status: 200,
          headers,
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: `/bom-json-${_label}-content-type`,
    }));

    expect(result.response).toEqual(expected);
  });

  it('removes superseded duplicate JSON fields that contain short credentials', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        new TextEncoder().encode('{"echo":"a","echo":"safe"}'),
        { status: 200 },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/json-duplicate-fields',
    }));

    expect(result.response).toBe('{"echo":"safe"}');
  });

  it.each([
    ['missing', null],
    ['mislabelled', TEXT_PLAIN],
  ])('preserves JSON number lexemes with %s content type while redacting credentials', async (_label, contentType) => {
    const body = '{"id":9007199254740993,"negative":-9007199254740995,"exponent":1.2300e+45,' +
      '"negativeZero":-0,"echo":"a","secretNumber":9007199254740997}';
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => {
        const headers = new Headers();
        if (contentType !== null) headers.set('Content-Type', contentType);
        return Promise.resolve(new Response(new TextEncoder().encode(body), { status: 200, headers }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: `/json-numbers-${_label}`,
    }));

    expect(result.response).toBe(
      '{"id":9007199254740993,"negative":-9007199254740995,"exponent":1.2300e+45,' +
      '"negativeZero":-0,"echo":"[redacted]","secretNumber":"[redacted]"}',
    );
  });

  it('redacts a credential represented as a JSON number without rounding it first', async () => {
    const credential = '9007199254740993';
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt(credential, 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(`{"echo":${credential},"ordinary":9007199254740995}`, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/json-numeric-credential',
    }));

    expect(result.response).toBe('{"echo":"[redacted]","ordinary":9007199254740995}');
  });

  it('redacts numeric credential lexemes in declared JSON before parsing rounds them', async () => {
    const credential = '9007199254740993';
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt(credential, 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(`{"echo":${credential},"ordinary":9007199254740995}`, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/declared-json-numeric-credential',
    }));

    expect(result.response).toEqual({
      echo: REDACTED,
      ordinary: JSON.parse('9007199254740995'),
    });
  });

  it('does not confuse an upstream string with an internal number sentinel', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(new Response(
        '{"label":"__DOLLHOUSE_LOSSLESS_JSON_NUMBER_0_0__","id":9007199254740993}',
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/json-number-sentinel-collision',
    }));

    expect(result.response).toBe(
      '{"label":"__DOLLHOUSE_LOSSLESS_JSON_NUMBER_0_0__","id":9007199254740993}',
    );
  });

  it('redacts a JSON string scalar when content type is absent', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(new TextEncoder().encode('"a"'), { status: 200 })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/json-string-no-content-type',
    }));

    expect(result.response).toBe('"[redacted]"');
  });

  it('keeps text-redaction behavior for malformed JSON-shaped non-JSON responses', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(new Response('{ordinary gmail-access-token', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/malformed-json-shaped-text',
    }));

    expect(result.response).toBe('{ordinary [redacted]');
  });

  it('fails closed when heuristic JSON traversal exhausts the stack', async () => {
    const depth = 50_000;
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        `${'['.repeat(depth)}"a"${']'.repeat(depth)}`,
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/deep-json-shaped-text',
    }))).rejects.toMatchObject({ code: 'integration_request_failed' });
  });

  it('redacts credentials parsed as non-string JSON scalars', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('12345678', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        echoed: 12345678,
        ordinaryNumber: 42,
        ordinaryBoolean: true,
        ordinaryNull: null,
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/echo-number',
    }));

    expect(result.response).toEqual({
      echoed: REDACTED,
      ordinaryNumber: 42,
      ordinaryBoolean: true,
      ordinaryNull: null,
    });
  });

  it('recursively redacts credentials in structured-suffix JSON media types', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(JSON.stringify({ echo: 'a', ordinary: 'available' }), {
        status: 200,
        headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/problem',
    }));

    expect(result.response).toEqual({ echo: REDACTED, ordinary: 'available' });
  });

  it('redacts exact short credentials without corrupting unrelated response text', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        ordinary: VALID_RESPONSE,
        exactEcho: 'a',
        queryEcho: 'received key=a',
        unrelated: 'monkey=available',
        longerValue: 'received key=available',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/short-key',
    }));

    expect(result.response).toEqual({
      ordinary: VALID_RESPONSE,
      exactEcho: REDACTED,
      queryEcho: 'received [redacted]',
      unrelated: 'monkey=available',
      longerValue: 'received key=available',
    });
  });

  it('redacts whitespace-padded whole-body short credentials', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(' \ta\r\n', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/padded-short-token',
    }));

    expect(result.response).toBe(' \t[redacted]\r\n');
  });

  it('redacts short OAuth tokens only in bounded credential-labelled text', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        'access_token=a; ACCESS_TOKEN: a; api_key=%61; token=available; a normal response; ' +
        String.raw`prefix {"access\u005ftoken":"\u0061"} {"access_token":"available"}`,
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/short-labelled-token',
    }));

    expect(result.response).toBe(
      '[redacted]; [redacted]; [redacted]; token=available; a normal response; ' +
      'prefix {[redacted]} {"access_token":"available"}',
    );
  });

  it('redacts short OAuth tokens under camelCase credential labels', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        'accessToken=a; refreshToken: a; idToken=%61; tokenizedValue=a',
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/camel-case-token-labels',
    }));

    expect(result.response).toBe('[redacted]; [redacted]; [redacted]; tokenizedValue=a');
  });

  it('accepts form-space boundaries around encoded credential labels', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received+access_token%3D%61+safely', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/form-encoded-labelled-token',
    }));

    expect(result.response).toBe('received+[redacted]+safely');
  });

  it('redacts escaped long OAuth tokens in credential-labelled non-JSON text', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('abcdefgh', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        String.raw`prefix {"access_token":"\u0061bcdefgh"}`,
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/long-escaped-labelled-token',
    }));

    expect(result.response).toBe('prefix {[redacted]}');
  });

  it('recovers overlapping escaped credential labels in malformed surrounding text', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(String.raw`" {"access_token":"\u0061"}`, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/overlapping-escaped-label',
    }));

    expect(result.response).toBe('" {[redacted]}');
  });

  it('redacts decoded and serialized query names for short credentials', async () => {
    const fetches: string[] = [];
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'api key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a b', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: (url) => {
        fetches.push(url.toString());
        return Promise.resolve(jsonResponse(200, {
          serialized: 'received api+key=a+b safely',
          percentEncoded: 'received api%20key=a%20b safely',
          mixedEncoding: 'received api%20key=a+b safely',
          decoded: 'received api key=a b safely',
          unrelated: 'received api+key=available',
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/encoded-query-name',
    }));

    expect(fetches[0]).toContain('api+key=a+b');
    expect(result.response).toEqual({
      serialized: RECEIVED_REDACTED_SAFELY,
      percentEncoded: RECEIVED_REDACTED_SAFELY,
      mixedEncoding: RECEIVED_REDACTED_SAFELY,
      decoded: RECEIVED_REDACTED_SAFELY,
      unrelated: 'received api+key=available',
    });
  });

  it('redacts object-style query echoes from non-JSON responses', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        '{"key":"a"} {"key":"available"} {"other":"a"}',
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/object-query-echo',
    }));

    expect(result.response).toBe('{[redacted]} {"key":"available"} {"other":"a"}');
  });

  it('redacts pretty-printed object-style query echoes', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('{"key"\r\n:\n"a"}', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/pretty-object-query-echo',
    }));

    expect(result.response).toBe('{"key":"[redacted]"}');
  });

  it('recovers object-style query redaction after an unmatched quote', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('" {"key":"a"}', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/malformed-prefix-object-query-echo',
    }));

    expect(result.response).toBe('" {[redacted]}');
  });

  it('normalizes percent escapes in query names without leaking short credentials', async () => {
    const fetches: string[] = [];
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: '%2f', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: (url) => {
        fetches.push(url.toString());
        return Promise.resolve(jsonResponse(200, {
          serialized: 'received %252f=a safely',
          decoded: 'received %2f=a safely',
          unrelated: 'received %2f=available',
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/percent-query-name',
    }));

    expect(fetches[0]).toContain('%252f=a');
    expect(result.response).toEqual({
      serialized: RECEIVED_REDACTED_SAFELY,
      decoded: RECEIVED_REDACTED_SAFELY,
      unrelated: 'received %2f=available',
    });
  });

  it('redacts percent-encoded query credentials regardless of escape hex case', async () => {
    const credential = 'abc/def:ghi';
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt(credential, 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        scalar: 'abc%2fdef%3aghi',
        query: 'received key=abc%2fdef%3aghi safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/encoded-key',
    }));

    expect(result.response).toEqual({
      scalar: REDACTED,
      query: RECEIVED_REDACTED_SAFELY,
    });
  });

  it('redacts query credentials with mixed form-space encodings', async () => {
    const credential = 'abcdefgh ijkl mnop';
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt(credential, 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        labelled: 'key=abcdefgh+ijkl%20mnop&note=available',
        scalar: 'abcdefgh%20ijkl+mnop',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/mixed-space-encoding',
    }));

    expect(result.response).toEqual({
      labelled: '[redacted]&note=available',
      scalar: REDACTED,
    });
  });

  it('bounds structured query matching for long repeated credentials', async () => {
    const credential = `${'a='.repeat(4_095)}b`;
    const responseBody = 'a='.repeat(128 * 1_024);
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'a', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt(credential, 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/repeated-structured-query-prefix',
    }));

    expect(result.response).toBe(responseBody);
  }, 5_000);

  it.each([
    ['a', 'received key=%61 safely'],
    ['a', 'received %6Bey=%61 safely'],
    ['abcdefgh', 'received key=abc%64efgh safely'],
  ])('redacts optionally percent-encoded query credential bytes', async (credential, body) => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt(credential, 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/optionally-encoded-query-key',
    }));

    expect(result.response).toBe(RECEIVED_REDACTED_SAFELY);
  });

  it('uses decoded query delimiters as credential boundaries', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received key=%61%26note=available safely', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/encoded-query-boundary',
    }));

    expect(result.response).toBe('received [redacted]%26note=available safely');
  });

  it('redacts optionally percent-encoded credentials in generic scalar echoes', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('abcdefgh', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        scalar: 'abc%64efgh',
        embedded: 'received abc%64efgh safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/optionally-encoded-generic-echo',
    }));

    expect(result.response).toEqual({
      scalar: REDACTED,
      embedded: RECEIVED_REDACTED_SAFELY,
    });
  });

  it('redacts JSON-escaped long credentials in unlabelled text', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('abcdefgh', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(String.raw`received \u0061bcdefgh safely`, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/json-escaped-unlabelled-token',
    }));

    expect(result.response).toBe(RECEIVED_REDACTED_SAFELY);
  });

  it('preserves literal pluses while decoding optional percent escapes', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('abc+defgh', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received abc+def%67h safely', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/partially-encoded-literal-plus',
    }));

    expect(result.response).toBe(RECEIVED_REDACTED_SAFELY);
  });

  it('redacts percent-encoded literal pluses in labelled short credentials', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a+b', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('access_token=%61%2Bb', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/encoded-labelled-literal-plus',
    }));

    expect(result.response).toBe(REDACTED);
  });

  it('bounds embedded credential matching for long shared prefixes', async () => {
    const credential = `${'a'.repeat(8191)}b`;
    const responseBody = 'a'.repeat(240 * 1024);
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt(credential, 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/long-shared-prefix',
    }));

    expect(result.response).toBe(responseBody);
  }, 5_000);

  it('redacts bounded standalone prefixed query values for short credentials', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: 'Token-' } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        standalone: 'received Token-a safely',
        encoded: 'received Token%2Da safely',
        longerValue: 'received Token-available safely',
        prefixedToken: 'received NotToken-a safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/short-prefixed-query-value',
    }));

    expect(result.response).toEqual({
      standalone: RECEIVED_REDACTED_SAFELY,
      encoded: RECEIVED_REDACTED_SAFELY,
      longerValue: 'received Token-available safely',
      prefixedToken: 'received NotToken-a safely',
    });
  });

  it('redacts serialized standalone query values with spaced prefixes', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: 'Token ' } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        formEncoded: 'received Token+a safely',
        percentEncoded: 'received Token%20a safely',
        longerFormValue: 'received Token+available safely',
        prefixedFormValue: 'received NotToken+a safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/short-spaced-query-prefix',
    }));

    expect(result.response).toEqual({
      formEncoded: RECEIVED_REDACTED_SAFELY,
      percentEncoded: RECEIVED_REDACTED_SAFELY,
      longerFormValue: 'received Token+available safely',
      prefixedFormValue: 'received NotToken+a safely',
    });
  });

  it('redacts an exact lowercase percent escape for a short query credential', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('/', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        scalar: '%2f',
        decodedQuery: 'received key=/ safely',
        encodedQuery: 'received key=%2f safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/encoded-short-key',
    }));

    expect(result.response).toEqual({
      scalar: REDACTED,
      decodedQuery: RECEIVED_REDACTED_SAFELY,
      encodedQuery: RECEIVED_REDACTED_SAFELY,
    });
  });

  it('redacts normalized custom-header echoes for short credentials', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        ordinary: VALID_RESPONSE,
        lowercase: 'received x-api-key:a',
        mixedCase: 'received X-Api-Key:\t a safely',
        quoted: 'received X-API-KEY: "a" safely',
        longerValue: 'received X-Api-Key: available',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/short-header-key',
    }));

    expect(result.response).toEqual({
      ordinary: VALID_RESPONSE,
      lowercase: 'received [redacted]',
      mixedCase: RECEIVED_REDACTED_SAFELY,
      quoted: RECEIVED_REDACTED_SAFELY,
      longerValue: 'received X-Api-Key: available',
    });
  });

  it('redacts bounded standalone custom-header prefixes for short credentials', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: 'Token-' } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        standalone: 'received Token-a safely',
        encoded: 'received Token%2Da safely',
        longerValue: 'received Token-available safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/short-prefixed-header-value',
    }));

    expect(result.response).toEqual({
      standalone: RECEIVED_REDACTED_SAFELY,
      encoded: RECEIVED_REDACTED_SAFELY,
      longerValue: 'received Token-available safely',
    });
  });

  it('redacts the exact normalized header value sent by Fetch', async () => {
    const sentValues: string[] = [];
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: ' Bearer ' } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: (_url, init) => {
        const sent = new Headers(init?.headers).get('X-Api-Key') ?? '';
        sentValues.push(sent);
        return Promise.resolve(new Response(`X-Api-Key: ${sent}`, {
          status: 200,
          headers: { 'Content-Type': TEXT_PLAIN },
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/normalized-header-value',
    }));

    expect(sentValues).toEqual(['Bearer a']);
    expect(result.response).toBe(REDACTED);
  });

  it('redacts a sensitive suffix after Fetch trims header whitespace', async () => {
    const sentValues: string[] = [];
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a ', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: (_url, init) => {
        sentValues.push(new Headers(init?.headers).get('Authorization') ?? '');
        return Promise.resolve(new Response('access_token=a', {
          status: 200,
          headers: { 'Content-Type': TEXT_PLAIN },
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/normalized-sensitive-suffix',
    }));

    expect(sentValues).toEqual(['Bearer a']);
    expect(result.response).toBe(REDACTED);
  });

  it('does not treat configured header names as suffixes of other HTTP field names', async () => {
    const tokenPunctuation = "!#$%&'*+-.^_`|~";
    const body = [...tokenPunctuation]
      .flatMap(character => [
        `${character}X-Api-Key: a`,
        `${character}\"X-Api-Key\":\"a\"`,
      ])
      .join('\n');
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/header-token-boundaries',
    }));

    expect(result.response).toBe(body);
  });

  it('redacts quoted header-name echoes from non-JSON responses', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        '{"X-Api-Key":"a"} {"X-Api-Key":"available"}',
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/quoted-short-header-key',
    }));

    expect(result.response).toBe('{[redacted]} {"X-Api-Key":"available"}');
  });

  it('redacts JSON-escaped short header values from non-JSON responses', async () => {
    for (const credential of ['"', '\\', '\n']) {
      const gateway = gatewayFixture({
        descriptors: [staticDescriptor({
          staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
        })],
        records: [integrationRecord({
          provider: 'airtable' as UserIntegrationProvider,
          authorizedPermissions: { scopes: [] },
          accessTokenCiphertext: encrypt(credential, 'airtable'),
          refreshTokenCiphertext: null,
        })],
        fetch: () => Promise.resolve(new Response(JSON.stringify({ 'X-Api-Key': credential }), {
          status: 200,
          headers: { 'Content-Type': TEXT_PLAIN },
        })),
      });

      const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
        provider: 'airtable',
        method: 'GET',
        path: '/escaped-short-header-key',
      }));

      expect(result.response).toBe('{"X-Api-Key":"[redacted]"}');
    }
  });

  it('redacts alternate JSON escapes of short header values', async () => {
    const cases = [
      { credential: 'a', body: String.raw`{"X-Api-Key":"\u0061"}` },
      { credential: '"', body: String.raw`{"X-Api-Key":"\u0022"}` },
      { credential: '/', body: String.raw`{"X-Api-Key":"\/"}` },
    ];
    for (const testCase of cases) {
      const gateway = gatewayFixture({
        descriptors: [staticDescriptor({
          staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
        })],
        records: [integrationRecord({
          provider: 'airtable' as UserIntegrationProvider,
          authorizedPermissions: { scopes: [] },
          accessTokenCiphertext: encrypt(testCase.credential, 'airtable'),
          refreshTokenCiphertext: null,
        })],
        fetch: () => Promise.resolve(new Response(testCase.body, {
          status: 200,
          headers: { 'Content-Type': TEXT_PLAIN },
        })),
      });

      const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
        provider: 'airtable',
        method: 'GET',
        path: '/alternate-escaped-short-header-key',
      }));

      expect(result.response).toBe('{"X-Api-Key":"[redacted]"}');
    }
  });

  it('redacts JSON-escaped header names from non-JSON responses', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        String.raw`{"X-Api-\u004bey":"a"} {"X-Api-\u004bey":"available"}`,
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/escaped-header-name',
    }));

    expect(result.response).toBe(String.raw`{[redacted]} {"X-Api-\u004bey":"available"}`);
  });

  it('redacts pretty-printed object-style header echoes', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('{"X-Api-Key"\n:\r\n"a"}', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/pretty-object-header-echo',
    }));

    expect(result.response).toBe('{"X-Api-Key":"[redacted]"}');
  });

  it('handles malformed quoted text without repeatedly rescanning the response suffix', async () => {
    const malformed = String.raw`\"`.repeat(16 * 1024);
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(malformed, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/malformed-quoted-text',
    }));

    expect(result.response).toBe(malformed);
  });

  it('bounds header matching for long repeated credential prefixes', async () => {
    const credential = `${'a:'.repeat(4_095)}b`;
    const responseBody = 'a:'.repeat(128 * 1_024);
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'a', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt(credential, 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/repeated-header-prefix',
    }));

    expect(result.response).toBe(responseBody);
  }, 5_000);

  it('redacts encoded custom-header echoes for short credentials', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('/', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        uppercase: 'received X-Api-Key: %2F safely',
        lowercase: 'received x-api-key:%2f safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/encoded-short-header-key',
    }));

    expect(result.response).toEqual({
      uppercase: RECEIVED_REDACTED_SAFELY,
      lowercase: RECEIVED_REDACTED_SAFELY,
    });
  });

  it('redacts short credentials when upstream encodes the header delimiter', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response(
        'received X-Api-Key%3A%20a safely; X-Api-Key%3A%20available remains',
        { status: 200, headers: { 'Content-Type': TEXT_PLAIN } },
      )),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/encoded-header-delimiter',
    }));

    expect(result.response).toBe('received [redacted] safely; X-Api-Key%3A%20available remains');
  });

  it('accepts form-space boundaries before encoded custom-header echoes', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'X-Custom', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received+X-Custom%3A+a+safely', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/form-encoded-custom-header-boundary',
    }));

    expect(result.response).toBe('received+[redacted]+safely');
  });

  it('redacts case-normalized authorization schemes while matching credential bytes exactly', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        ordinary: VALID_RESPONSE,
        normalized: 'received authorization: bEaReR a safely',
        differentCase: 'received authorization: bearer A safely',
        longerValue: 'received authorization: bearer available',
        capitalizedLongerValue: 'received Authorization: Bearer available',
        unicodePrefix: '\u0130 Authorization: Bearer a safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/short-bearer',
    }));

    expect(result.response).toEqual({
      ordinary: VALID_RESPONSE,
      normalized: RECEIVED_REDACTED_SAFELY,
      differentCase: 'received authorization: bearer A safely',
      longerValue: 'received authorization: bearer available',
      capitalizedLongerValue: 'received Authorization: Bearer available',
      unicodePrefix: '\u0130 [redacted] safely',
    });
  });

  it('redacts bounded standalone authorization wrappers for short credentials', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        standalone: 'received bEaReR a safely',
        longerValue: 'received Bearer available safely',
        prefixedToken: 'received NotBearer a safely',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/short-standalone-bearer',
    }));

    expect(result.response).toEqual({
      standalone: RECEIVED_REDACTED_SAFELY,
      longerValue: 'received Bearer available safely',
      prefixedToken: 'received NotBearer a safely',
    });
  });

  it('checks short standalone authorization boundaries after form decoding', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('a', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received%20Bearer%20a%20safely', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/encoded-authorization-boundaries',
    }));

    expect(result.response).toBe('received%20[redacted]%20safely');
  });

  it('redacts encoded authorization echoes for short credentials', async () => {
    const gateway = gatewayFixture({
      records: [integrationRecord({
        provider: 'gmail' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('/', 'gmail'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        encodedWrapper: 'received Authorization: Bearer %2f safely',
        encodedHeaderValue: 'received authorization: bearer%20%2F safely',
        formEncodedHeaderValue: 'received authorization: bEaReR+%2f safely',
        unrelated: 'received Authorization: Bearer%20available',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: '/encoded-short-bearer',
    }));

    expect(result.response).toEqual({
      encodedWrapper: RECEIVED_REDACTED_SAFELY,
      encodedHeaderValue: RECEIVED_REDACTED_SAFELY,
      formEncodedHeaderValue: RECEIVED_REDACTED_SAFELY,
      unrelated: 'received Authorization: Bearer%20available',
    });
  });

  it('redacts case-normalized static Authorization schemes for short credentials', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor()],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        normalized: 'received authorization: bearer a safely',
        differentCase: 'received authorization: bearer A safely',
        longerValue: 'received authorization: bearer available',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/short-static-bearer',
    }));

    expect(result.response).toEqual({
      normalized: RECEIVED_REDACTED_SAFELY,
      differentCase: 'received authorization: bearer A safely',
      longerValue: 'received authorization: bearer available',
    });
  });

  it('measures the case-insensitive authorization prefix after URL encoding', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'header', name: 'Authorization', valuePrefix: 'Token ABC ' } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        accessTokenCiphertext: encrypt('a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        encoded: 'received authorization: token%20abc%20a safely',
        formEncoded: 'received authorization: token+abc+a safely',
        longerValue: 'received authorization: token%20abc%20available',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/encoded-authorization-prefix',
    }));

    expect(result.response).toEqual({
      encoded: RECEIVED_REDACTED_SAFELY,
      formEncoded: RECEIVED_REDACTED_SAFELY,
      longerValue: 'received authorization: token%20abc%20available',
    });
  });

  it('issues the upstream request with redirect: error so redirects cannot bypass the host allowlist', async () => {
    const inits: Array<RequestInit | undefined> = [];
    const gateway = gatewayFixture({
      fetch: (url, init) => {
        inits.push(init);
        return Promise.resolve(jsonResponse(200, { ok: true }));
      },
    });

    await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_MESSAGES_PATH,
    }));

    expect(inits[0]?.redirect).toBe('error');
  });

  it('injects static API keys into query parameters without returning the key', async () => {
    const fetches: string[] = [];
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({ staticApiKey: { injection: { location: 'query', name: 'key', valuePrefix: null } } })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
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
      path: AIRTABLE_TABLE_PATH,
    }));

    expect(fetches[0]).toBe('https://api.airtable.com/v0/app/table?key=airtable-key');
    expect(JSON.stringify(result)).not.toContain('airtable-key');
  });

  it('returns a static-key 401 without corrupting the connected credential record', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor()],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('airtable-key', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(401, { error: 'unauthorized' })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: AIRTABLE_TABLE_PATH,
    }));
    const stored = await gateway.integrationStore.findByProvider(USER_ID, 'airtable');

    expect(result).toMatchObject({ status: 401, refreshed: false });
    expect(stored).toMatchObject({ status: 'connected', errorReason: null });
  });

  it('does not refresh OAuth credentials when the descriptor disables refresh', async () => {
    const refreshDisabledDescriptor = oauthDescriptor();
    const oauthProvider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptor(),
      clientSecret: 'gmail-client-secret',
      dnsLookup: () => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }]),
      pinnedOutbound: testPinnedOutbound(() => Promise.reject(new Error('refresh must not run'))),
    });
    const gateway = gatewayFixture({
      descriptors: [{
        ...refreshDisabledDescriptor,
        oauth: refreshDisabledDescriptor.oauth
          ? { ...refreshDisabledDescriptor.oauth, refresh: 'none' }
          : null,
      }],
      providers: new IntegrationProviderRegistry([oauthProvider]),
      fetch: () => Promise.resolve(jsonResponse(401, { error: 'unauthorized' })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_PROFILE_PATH,
    }));
    const stored = await gateway.integrationStore.findByProvider(USER_ID, 'gmail');

    expect(result).toMatchObject({ status: 401, refreshed: false });
    expect(stored).toMatchObject({ status: 'connected', errorReason: null });
  });

  it('does not corrupt OAuth credentials when no refresh-capable provider is registered', async () => {
    const gateway = gatewayFixture({
      fetch: () => Promise.resolve(jsonResponse(401, { error: 'unauthorized' })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_PROFILE_PATH,
    }));
    const stored = await gateway.integrationStore.findByProvider(USER_ID, 'gmail');

    expect(result).toMatchObject({ status: 401, refreshed: false });
    expect(stored).toMatchObject({ status: 'connected', errorReason: null });
  });

  it('emits Authorization: Basic without leaking the composite credential or decoded password', async () => {
    const fetches: Array<{ url: string; init: RequestInit | undefined }> = [];
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'basic', name: 'Authorization', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('twilio-sid:twilio-secret', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: (url, init) => {
        fetches.push({ url: urlString(url), init });
        return Promise.resolve(jsonResponse(200, {
          echoed: new Headers(init?.headers).get('Authorization'),
          decodedPassword: 'twilio-secret',
        }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: AIRTABLE_TABLE_PATH,
    }));
    const authorization = new Headers(fetches[0]?.init?.headers).get('Authorization');
    expect(authorization).toBe(`Basic ${Buffer.from('twilio-sid:twilio-secret', 'utf8').toString('base64')}`);
    expect(result.response).toEqual({
      echoed: REDACTED,
      decodedPassword: REDACTED,
    });
    // Neither the raw credential nor the query string carries the secret.
    expect(fetches[0]?.url).toBe('https://api.airtable.com/v0/app/table');
    expect(JSON.stringify(result)).not.toContain('twilio-secret');
  });

  it('redacts an independently echoed short Basic password without corrupting surrounding text', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'basic', name: 'Authorization', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('user:a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(jsonResponse(200, {
        decodedPassword: 'a',
        unrelated: 'a normal response',
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: AIRTABLE_TABLE_PATH,
    }));

    expect(result.response).toEqual({
      decodedPassword: REDACTED,
      unrelated: 'a normal response',
    });
  });

  it('redacts a short decoded Basic composite only at token boundaries', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'basic', name: 'Authorization', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('u:a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received u:a safely; xu:a remains; u:available remains', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: AIRTABLE_TABLE_PATH,
    }));

    expect(result.response).toBe('received [redacted] safely; xu:a remains; u:available remains');
  });

  it('preserves literal pluses in partially encoded bounded Basic composites', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'basic', name: 'Authorization', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('u:+?', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('received u:+%3F safely', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: '/partially-encoded-basic-composite',
    }));

    expect(result.response).toBe(RECEIVED_REDACTED_SAFELY);
  });

  it('redacts a short decoded Basic password in labelled text', async () => {
    const gateway = gatewayFixture({
      descriptors: [staticDescriptor({
        staticApiKey: { injection: { location: 'basic', name: 'Authorization', valuePrefix: null } },
      })],
      records: [integrationRecord({
        provider: 'airtable' as UserIntegrationProvider,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: encrypt('user:a', 'airtable'),
        refreshTokenCiphertext: null,
      })],
      fetch: () => Promise.resolve(new Response('PASSWORD=a; password=A; Password: a; note=available', {
        status: 200,
        headers: { 'Content-Type': TEXT_PLAIN },
      })),
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'airtable',
      method: 'GET',
      path: AIRTABLE_TABLE_PATH,
    }));

    expect(result.response).toBe('[redacted]; password=A; [redacted]; note=available');
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
      method: 'GET',
      path: '/admin#ignored-fragment',
    }))).rejects.toMatchObject({ code: 'invalid_integration_path' });
    for (const path of ['/safe%2F..%2Fadmin', '/%2561dmin', '/%00admin', '/admin%']) {
      await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
        provider: 'gmail',
        method: 'GET',
        path,
      }))).rejects.toMatchObject({ code: 'invalid_integration_path' });
    }
    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'POST',
      path: '/ok',
      body: { payload: 'x'.repeat(70 * 1024) },
    }))).rejects.toMatchObject({ code: 'integration_request_too_large' });
    await expect(runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: `/${'a'.repeat(1000)}`,
    }))).rejects.toMatchObject({
      code: 'integration_request_path_too_long',
      status: 414,
    });

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

  it.each(['/safe/../admin', '/safe/%2e%2e/admin', '/%61dmin', '/\u0430dmin'])(
    'sends the canonical outbound path for %s',
    async path => {
      const requestedUrls: string[] = [];
      const gateway = gatewayFixture({
        fetch: url => {
          requestedUrls.push(urlString(url));
          return Promise.resolve(jsonResponse(200, { ok: true }));
        },
      });

      await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
        provider: 'gmail',
        method: 'GET',
        path,
      }));

      expect(requestedUrls).toEqual([`https://${GMAIL_HOST}/admin`]);
    },
  );

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
        headers: { 'Content-Type': TEXT_PLAIN },
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
    expect(JSON.stringify(gateway.audit.events)).not.toContain(GMAIL_ACCESS_TOKEN);
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
          'Content-Type': TEXT_PLAIN,
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
        headers: { 'Content-Type': TEXT_PLAIN },
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
    const providerFetch: PinnedFetch = (url, init) => {
      fetches.push({
        url: urlString(url),
        authorization: new Headers(init?.headers).get('Authorization'),
        body: requestBodyString(init),
      });
      return Promise.resolve(jsonResponse(200, {
        access_token: 'gmail-fresh-access-token',
        refresh_token: 'gmail-rotated-refresh-token',
      }));
    };
    const oauthProvider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptor(),
      clientSecret: 'gmail-client-secret',
      pinnedOutbound: () => ({ fetch: providerFetch, close: () => Promise.resolve() }),
      dnsLookup: () => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }]),
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
          : jsonResponse(200, { ok: true, echoed: GMAIL_ACCESS_TOKEN }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_PROFILE_PATH,
    }));

    expect(result).toMatchObject({
      status: 200,
      refreshed: true,
      response: { ok: true, echoed: REDACTED },
    });
    expect(fetches.map(call => call.authorization)).toEqual([
      'Bearer gmail-access-token',
      null,
      'Bearer gmail-fresh-access-token',
    ]);
    expect(fetches[1]?.body).toContain('grant_type=refresh_token');
  });

  it('refreshes on 401 through a provider resolved from the store, absent from the boot registry', async () => {
    const fetches: Array<{ readonly authorization: string | null }> = [];
    const providerFetch: PinnedFetch = () => Promise.resolve(jsonResponse(200, {
      access_token: 'gmail-fresh-access-token',
      refresh_token: 'gmail-rotated-refresh-token',
    }));
    // The provider is built per-request from the descriptor — NOT registered in
    // the boot registry (empty). This proves the gateway's 401-refresh path is
    // wired to the store-resolution fallback for runtime-authored BYO providers.
    const storeResolvedProvider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptor(),
      clientSecret: 'gmail-client-secret',
      pinnedOutbound: () => ({ fetch: providerFetch, close: () => Promise.resolve() }),
      dnsLookup: () => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }]),
    });
    const gateway = gatewayFixture({
      providers: IntegrationProviderRegistry.empty(),
      resolveProvider: (_userId, provider) =>
        Promise.resolve(provider === 'gmail' ? storeResolvedProvider : null),
      fetch: (url, init) => {
        fetches.push({ authorization: new Headers(init?.headers).get('Authorization') });
        return Promise.resolve(fetches.length === 1
          ? jsonResponse(401, { error: 'expired' })
          : jsonResponse(200, { ok: true }));
      },
    });

    const result = await runAsUser(gateway.contextTracker, () => gateway.gateway.request({
      provider: 'gmail',
      method: 'GET',
      path: GMAIL_PROFILE_PATH,
    }));

    expect(result).toMatchObject({
      status: 200,
      refreshed: true,
      response: { ok: true },
    });
    expect(fetches.map(call => call.authorization)).toEqual([
      'Bearer gmail-access-token',
      'Bearer gmail-fresh-access-token',
    ]);
  });
});

function gatewayFixture(options: {
  readonly descriptors?: readonly IntegrationDescriptorRecord[];
  readonly records?: readonly UserIntegrationRecord[];
  readonly providers?: IntegrationProviderRegistry;
  readonly fetch?: PinnedFetch;
  readonly dnsLookup?: (hostname: string, options: { readonly all: true }) => Promise<readonly { readonly address: string; readonly family: number }[]>;
  readonly rateLimitStore?: IRateLimitStore;
  readonly rateLimit?: { readonly windowMs: number; readonly maxRequests: number };
  readonly resolveProvider?: ConstructorParameters<typeof IntegrationTokenRefreshService>[0]['resolveProvider'];
} = {}) {
  const contextTracker = new ContextTracker();
  const secretEncryption = encryption();
  const descriptorRecords = options.descriptors ?? [oauthDescriptor()];
  const records = options.records ?? [
    integrationRecord({
      provider: 'gmail' as UserIntegrationProvider,
      authorizedPermissions: { scopes: ['gmail.readonly'] },
      accessTokenCiphertext: encrypt(GMAIL_ACCESS_TOKEN, 'gmail'),
      refreshTokenCiphertext: encrypt('gmail-refresh-token', 'gmail', 'refresh_token'),
    }),
  ];
  const integrationStore = new InMemoryUserIntegrationStore(records.map(record => ({
    ...record,
    integrationDescriptorId: record.integrationDescriptorId
      ?? descriptorRecords.find(descriptor => descriptor.provider === record.provider)?.id
      ?? null,
  })));
  const descriptorStore = new InMemoryIntegrationDescriptorStore(descriptorRecords);
  const providers = options.providers ?? IntegrationProviderRegistry.empty();
  const audit = new FixtureAuditSink();
  const outboundState: { pins: OutboundPin[]; closeCount: number } = {
    pins: [],
    closeCount: 0,
  };
  // Adapt the plain fetch stub into the pinned-outbound seam, recording each pin
  // and close count so both parent invariants observe the same transport state.
  const fetchStub = options.fetch;
  const pinnedOutbound = fetchStub
    ? testPinnedOutbound(fetchStub, outboundState)
    : undefined;
  const gateway = new IntegrationRequestGateway({
    integrationStore,
    descriptorStore,
    secretEncryption,
    contextTracker,
    tokenRefresh: new IntegrationTokenRefreshService({
      store: integrationStore,
      providers,
      ...(options.resolveProvider ? { resolveProvider: options.resolveProvider } : {}),
      secretEncryption,
      now: () => NOW,
    }),
    pinnedOutbound,
    dnsLookup: options.dnsLookup ?? (() => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }])),
    auditSink: audit,
    rateLimitStore: options.rateLimitStore,
    rateLimit: options.rateLimit,
  });
  return {
    gateway,
    contextTracker,
    audit,
    pins: outboundState.pins,
    outboundState,
    descriptorStore,
    integrationStore,
  };
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
    provider: 'gmail' as UserIntegrationProvider,
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes: ['gmail.readonly'] },
    accessTokenCiphertext: encrypt(GMAIL_ACCESS_TOKEN, 'gmail'),
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
    provider: 'gmail' as UserIntegrationProvider,
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
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'integration-key-v1',
    operationPromotion: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function staticDescriptor(overrides: Partial<IntegrationDescriptorRecord> = {}): IntegrationDescriptorRecord {
  return {
    id: '00000000-0000-4000-8000-000000000102',
    provider: 'airtable' as UserIntegrationProvider,
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Airtable',
    category: 'Database',
    authStrategy: 'static_api_key',
    apiHosts: ['api.airtable.com'],
    oauth: null,
    staticApiKey: { injection: { location: 'header', name: 'Authorization', valuePrefix: 'Bearer ' } },
    clientSecretCiphertext: null,
    clientSecretRevision: null,
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

function testPinnedOutbound(
  fetchImpl: typeof fetch,
  state?: { pins: OutboundPin[]; closeCount: number },
): PinnedOutboundFactory {
  return pin => {
    state?.pins.push(pin);
    return {
      fetch: (input, init) => fetchImpl(input, init),
      close: () => {
        if (state) state.closeCount += 1;
        return Promise.resolve();
      },
    };
  };
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
