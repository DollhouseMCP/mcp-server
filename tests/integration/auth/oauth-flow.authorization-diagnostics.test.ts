import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { TrivialConsentMethod } from '../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { PerformanceMonitor } from '../../../src/utils/PerformanceMonitor.js';
import { logger } from '../../../src/utils/logger.js';
import {
  absoluteUrl,
  approveClientConsentPage,
  CookieJar,
  newPkceVerifier,
  pkceS256,
  startASHarness,
  type ASHarness,
} from './oauth-flow-helpers.js';

describe('OAuth authorization diagnostics', () => {
  let harness: ASHarness | null = null;
  let monitor: PerformanceMonitor | null = null;

  afterEach(async () => {
    jest.restoreAllMocks();
    monitor?.dispose();
    monitor = null;
    await harness?.close();
    harness = null;
  });

  it('records the real provider no-scope failure without exposing its payload', async () => {
    monitor = new PerformanceMonitor();
    monitor.startMonitoring();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    harness = await startASHarness({
      methods: [new TrivialConsentMethod({ defaultSubject: 'diagnostic-user' })],
      storage: new InMemoryAuthStorageLayer(),
      openDCR: true,
      performanceMonitor: monitor,
    });
    const redirectUri = 'http://localhost:35419/oauth/callback';
    const registration = await fetch(`${harness.baseUrl}/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        scope: 'mcp',
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    });
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const metadata = await (await fetch(
      `${harness.baseUrl}/.well-known/oauth-authorization-server`,
    )).json() as { authorization_endpoint: string };
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkceS256(newPkceVerifier()),
      code_challenge_method: 'S256',
      resource: `${harness.publicBaseUrl}/mcp`,
      state: 'diagnostic-state-must-not-be-logged',
    });
    const first = await fetch(`${metadata.authorization_endpoint}?${params}`, { redirect: 'manual' });
    const jar = new CookieJar();
    jar.ingest(first.headers);
    const interactionUrl = absoluteUrl(harness.baseUrl, first.headers.get('location'));
    const page = await fetch(interactionUrl, {
      redirect: 'manual',
      headers: { Cookie: jar.header() },
    });
    jar.ingest(page.headers);
    const csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await page.text())?.[1];
    expect(csrf).toBeDefined();
    const login = await fetch(interactionUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
      body: new URLSearchParams({ csrf_token: csrf!, action: 'approve' }),
    });
    const consent = await approveClientConsentPage({ baseUrl: harness.baseUrl, response: login, jar });
    jar.ingest(consent.headers);

    let next = absoluteUrl(harness.baseUrl, consent.headers.get('location'));
    let callback: URL | null = null;
    for (let hop = 0; hop < 10; hop += 1) {
      if (next.startsWith(redirectUri)) {
        callback = new URL(next);
        break;
      }
      const response = await fetch(next, { redirect: 'manual', headers: { Cookie: jar.header() } });
      jar.ingest(response.headers);
      next = absoluteUrl(harness.baseUrl, response.headers.get('location'));
    }

    expect(callback?.searchParams.get('error')).toBe('access_denied');
    expect(callback?.searchParams.get('error_description')).toBeNull();
    expect(monitor.getAuthAuthorizationFailureStats()).toMatchObject({
      failureCount: 1,
      failuresByReason: { no_scope_granted: 1 },
    });
    const diagnosticCall = warn.mock.calls.find(([message]) =>
      message === '[EmbeddedAuthorizationServer] OAuth authorization failed');
    expect(diagnosticCall?.[1]).toEqual({
      providerEvent: 'authorization.error',
      errorCode: 'access_denied',
      reason: 'no_scope_granted',
      hasRequestedScope: false,
    });
    expect(JSON.stringify(diagnosticCall)).not.toContain(clientId);
    expect(JSON.stringify(diagnosticCall)).not.toContain('diagnostic-state-must-not-be-logged');
  });
});
