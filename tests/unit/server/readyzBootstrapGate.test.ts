/**
 * Round 5 / H3: /readyz consults the embedded AS bootstrap state.
 *
 * When the embedded AS is in multi-user mode and bootstrap is
 * incomplete, every /authorize hits the gate's 503. /readyz must
 * surface that state so Kubernetes / load balancers stop sending
 * traffic to the pod until the operator runs the bootstrap CLI.
 *
 * Stub-based tests: stand up the runtime with a stub oauthProvider
 * exposing isReadyForTraffic, drive that flag via the test, and
 * assert the /readyz response shape. Doesn't need the full container.
 *
 * Real-AS test (Round 6 review fixup): the latch behavior in
 * EmbeddedAuthorizationServer.isReadyForTraffic() — once true, never
 * re-reads storage — was previously only covered by stub-based tests
 * that don't exercise the actual latch field. The new tests at the
 * bottom build a real EmbeddedAuthorizationServer and verify
 * (a) pre-bootstrap multi-user mode → false, (b) post-bootstrap →
 * true, (c) post-bootstrap subsequent calls don't hit storage.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import {
  createStreamableHttpRuntime,
  type StreamableHttpRuntimeHandle,
} from '../../../src/server/StreamableHttpServer.js';
import { setHttpModeActive } from '../../../src/index.js';
import { EmbeddedAuthorizationServer } from '../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { TrivialConsentMethod } from '../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { randomBytes } from 'node:crypto';

describe('/readyz — H3 bootstrap gate consultation', () => {
  beforeAll(() => setHttpModeActive(true));
  afterAll(() => setHttpModeActive(false));

  async function buildRuntime(
    isReadyForTraffic?: () => Promise<boolean>,
  ): Promise<StreamableHttpRuntimeHandle> {
    return createStreamableHttpRuntime(
      // Session factory — never invoked for /readyz; minimal stub.
      async () => ({ dispose: async () => undefined }),
      {
        host: '127.0.0.1',
        port: 0,
        mcpPath: '/mcp',
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        oauthProvider: isReadyForTraffic ? {
          createRouter: () => express.Router(),
          isReadyForTraffic,
        } : undefined,
      },
    );
  }

  it('returns 200 when no oauthProvider is wired (legacy / non-AS deployments)', async () => {
    const runtime = await buildRuntime();
    try {
      const res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('returns 200 when oauthProvider reports ready=true', async () => {
    const runtime = await buildRuntime(async () => true);
    try {
      const res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('returns 503 with reason=bootstrap_required when oauthProvider reports ready=false', async () => {
    const runtime = await buildRuntime(async () => false);
    try {
      const res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        ready: false,
        reason: 'bootstrap_required',
        transport: 'streamable-http',
      });
    } finally {
      await runtime.close();
    }
  });

  it('route shape: /readyz response flips when isReadyForTraffic flips (stub-driven)', async () => {
    // Round 6 review fixup: this test pins the /readyz Express route
    // shape — that the route correctly translates a true/false return
    // from the oauthProvider's isReadyForTraffic into a 200/503
    // response. It does NOT exercise the latch in
    // EmbeddedAuthorizationServer.isReadyForTraffic itself; that's
    // what the second describe block below covers.
    let bootstrapped = false;
    const runtime = await buildRuntime(async () => bootstrapped);
    try {
      let res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(503);
      bootstrapped = true;
      res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });
});

/**
 * Round 6 review fixup: the stub-based tests above only exercise the
 * /readyz route's response shape. They never touch the actual
 * EmbeddedAuthorizationServer.isReadyForTraffic implementation or its
 * bootstrapReadyLatch field. These tests fix that gap by exercising
 * the real method directly.
 */
describe('EmbeddedAuthorizationServer.isReadyForTraffic — Round 6 latch coverage', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readyz-real-'));
    process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.1';
  });
  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('non-multi-user (trivial-consent only) → always ready, never reads storage', async () => {
    // Wrap the storage's getBootstrapState to count calls.
    const storage = new InMemoryAuthStorageLayer();
    let getBootstrapCallCount = 0;
    const originalGet = storage.getBootstrapState.bind(storage);
    storage.getBootstrapState = async () => {
      getBootstrapCallCount += 1;
      return originalGet();
    };
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: path.join(tmpDir, 'key-1.json'),
      methods: [new TrivialConsentMethod({ defaultSubject: 'readyz-test' })],
      storage,
    });
    expect(await as.isReadyForTraffic()).toBe(true);
    expect(await as.isReadyForTraffic()).toBe(true);
    expect(getBootstrapCallCount).toBe(0); // never read storage
  });

  it('multi-user pre-bootstrap → false; multi-user post-bootstrap → true', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const rateLimiter = new LocalLoginRateLimiter({ storage });
    const method = new LocalAccountMethod({ storage, invites, rateLimiter });
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: path.join(tmpDir, 'key-2.json'),
      methods: [method],
      storage,
    });
    expect(await as.isReadyForTraffic()).toBe(false);
    await storage.markBootstrapComplete('local_admin', 'local-password');
    expect(await as.isReadyForTraffic()).toBe(true);
  });

  it('latch: once bootstrap is observed complete, subsequent calls skip the storage read', async () => {
    const storage = new InMemoryAuthStorageLayer();
    let getBootstrapCallCount = 0;
    const originalGet = storage.getBootstrapState.bind(storage);
    storage.getBootstrapState = async () => {
      getBootstrapCallCount += 1;
      return originalGet();
    };
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const rateLimiter = new LocalLoginRateLimiter({ storage });
    const method = new LocalAccountMethod({ storage, invites, rateLimiter });
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: path.join(tmpDir, 'key-3.json'),
      methods: [method],
      storage,
    });
    // First call: pre-bootstrap, hits storage.
    expect(await as.isReadyForTraffic()).toBe(false);
    expect(getBootstrapCallCount).toBe(1);
    // Bootstrap, then call again. Storage hit (latch flips on this call).
    await storage.markBootstrapComplete('local_admin', 'local-password');
    expect(await as.isReadyForTraffic()).toBe(true);
    const callsAfterFirstReady = getBootstrapCallCount;
    expect(callsAfterFirstReady).toBeGreaterThan(1); // at least the bootstrap-complete call
    // Subsequent calls — latch is on, MUST NOT increment the storage-call counter.
    expect(await as.isReadyForTraffic()).toBe(true);
    expect(await as.isReadyForTraffic()).toBe(true);
    expect(await as.isReadyForTraffic()).toBe(true);
    expect(getBootstrapCallCount).toBe(callsAfterFirstReady);
  });

  it('Round 7: warns at init when refreshRotationCheckIpUa=true and DOLLHOUSE_COOKIE_SIGNING_SECRET is unset', async () => {
    // The cookie key doubles as the HMAC salt for the IP/UA hashes
    // stamped onto refresh tokens. In multi-replica HA with file-based
    // cookie keys, replicas HMAC the same IP+UA differently and
    // legitimate refreshes get revoked. The fix: warn at AS init when
    // the operator opted into IP/UA grace but didn't set the env var
    // that pins the key across replicas.
    //
    // The warning fires inside initialize(); validate() triggers
    // ensureInitialized() so we use that to drive init.
    const savedEnv = process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
    delete process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
    const warnings: string[] = [];
    const { logger } = await import('../../../src/utils/logger.js');
    const originalWarn = logger.warn.bind(logger);
    logger.warn = ((msg: string, ...rest: unknown[]) => {
      warnings.push(String(msg));
      return originalWarn(msg, ...rest as []);
    }) as typeof logger.warn;
    try {
      const storage = new InMemoryAuthStorageLayer();
      const invites = new InviteTokenStore(randomBytes(32), storage);
      const rateLimiter = new LocalLoginRateLimiter({ storage });
      const method = new LocalAccountMethod({ storage, invites, rateLimiter });
      const as = new EmbeddedAuthorizationServer({
        publicBaseUrl: 'http://127.0.0.1:65530',
        keyFilePath: path.join(tmpDir, 'key-warn.json'),
        methods: [method],
        storage,
        refreshRotationCheckIpUa: true,
      });
      // Force initialize() so the warn fires. validate() triggers it.
      await as.validate('not-a-real-token');
      const matched = warnings.find((w) =>
        /refreshRotationCheckIpUa is enabled but DOLLHOUSE_COOKIE_SIGNING_SECRET is unset/.test(w),
      );
      expect(matched).toBeDefined();
    } finally {
      logger.warn = originalWarn;
      if (savedEnv === undefined) delete process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
      else process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET = savedEnv;
    }
  });

  it('Round 7: does NOT warn when DOLLHOUSE_COOKIE_SIGNING_SECRET is set', async () => {
    const savedEnv = process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
    // Hex string ≥32 bytes so loadOrGenerateCookieSigningKeys accepts it.
    process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET = randomBytes(32).toString('hex');
    const warnings: string[] = [];
    const { logger } = await import('../../../src/utils/logger.js');
    const originalWarn = logger.warn.bind(logger);
    logger.warn = ((msg: string, ...rest: unknown[]) => {
      warnings.push(String(msg));
      return originalWarn(msg, ...rest as []);
    }) as typeof logger.warn;
    try {
      const storage = new InMemoryAuthStorageLayer();
      const invites = new InviteTokenStore(randomBytes(32), storage);
      const rateLimiter = new LocalLoginRateLimiter({ storage });
      const method = new LocalAccountMethod({ storage, invites, rateLimiter });
      const as = new EmbeddedAuthorizationServer({
        publicBaseUrl: 'http://127.0.0.1:65530',
        keyFilePath: path.join(tmpDir, 'key-nowarn.json'),
        methods: [method],
        storage,
        refreshRotationCheckIpUa: true,
      });
      await as.validate('not-a-real-token');
      const matched = warnings.find((w) =>
        /refreshRotationCheckIpUa is enabled but DOLLHOUSE_COOKIE_SIGNING_SECRET is unset/.test(w),
      );
      expect(matched).toBeUndefined();
    } finally {
      logger.warn = originalWarn;
      if (savedEnv === undefined) delete process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
      else process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET = savedEnv;
    }
  });

  it('storage read failure pre-bootstrap → false (fail closed)', async () => {
    const storage = new InMemoryAuthStorageLayer();
    storage.getBootstrapState = async () => {
      throw new Error('simulated storage outage');
    };
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const rateLimiter = new LocalLoginRateLimiter({ storage });
    const method = new LocalAccountMethod({ storage, invites, rateLimiter });
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: path.join(tmpDir, 'key-4.json'),
      methods: [method],
      storage,
    });
    // Storage outage must NOT cause /readyz to return 200 (fail-closed
    // is the documented behavior — a pod that can't read storage is
    // not safely serving auth).
    expect(await as.isReadyForTraffic()).toBe(false);
  });
});
