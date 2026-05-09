/**
 * OidcProviderAdapter — refresh-token rotation grace window (R3 / spec L926).
 *
 * The grace window is the industry-standard mitigation for the
 * find-then-consume race that's structural in oidc-provider's Adapter
 * API. Within the window after a consume(), find() hides the consumed
 * marker so legitimate concurrent rotations issue rotated tokens
 * normally instead of tripping reuse-detection. After the window
 * elapses, the marker becomes visible and replays trigger family
 * revocation per OAuth 2.1 §6.1.
 *
 * Pinned invariants:
 *   - Within grace, find() on a consumed RefreshToken returns the
 *     payload WITHOUT `consumed`.
 *   - After grace, find() returns the payload WITH `consumed`.
 *   - Grace applies ONLY to RefreshToken — AuthorizationCode,
 *     Session, etc. always show consumed:true immediately.
 *   - Grace = 0 disables (strict consume-then-detect; legitimate
 *     concurrent redeems still revoke).
 *   - Forged JWTs are unaffected (the grace doesn't change WHAT'S
 *     consumed, only when it's reported).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  OidcProviderAdapter,
  DEFAULT_REFRESH_ROTATION_GRACE_MS,
  hashRotationAttribute,
  withRotationRequestContext,
} from '../../../../../src/auth/embedded-as/storage/OidcProviderAdapter.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

describe('OidcProviderAdapter — refresh-token rotation grace window', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  it('exports a 30-second default grace window', () => {
    expect(DEFAULT_REFRESH_ROTATION_GRACE_MS).toBe(30_000);
  });

  it('within grace: find() on a consumed RefreshToken returns payload WITHOUT `consumed`', async () => {
    const adapter = new OidcProviderAdapter('RefreshToken', storage, {
      refreshRotationGraceMs: 30_000,
    });
    await adapter.upsert('rt-1', { grantId: 'g-1', sub: 'alice' });
    await adapter.consume('rt-1');

    const found = await adapter.find('rt-1');
    expect(found).toBeDefined();
    expect(found?.grantId).toBe('g-1');
    expect(found?.sub).toBe('alice');
    // Critical: oidc-provider must NOT see consumed:true within grace.
    expect(found?.consumed).toBeUndefined();
  });

  it('after grace: find() reveals the `consumed` marker so reuse-detection fires', async () => {
    const adapter = new OidcProviderAdapter('RefreshToken', storage, {
      refreshRotationGraceMs: 50, // 50ms for fast test
    });
    await adapter.upsert('rt-2', { grantId: 'g-2', sub: 'alice' });
    await adapter.consume('rt-2');

    // Wait past the grace window.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const found = await adapter.find('rt-2');
    expect(found).toBeDefined();
    expect(typeof found?.consumed).toBe('number');
    // Specifically: oidc-provider's grant handlers will treat consumed:<ts>
    // as a replay signal and call revokeByGrantId.
  });

  it('grace = 0 disables the grace window — consumed marker visible immediately', async () => {
    const adapter = new OidcProviderAdapter('RefreshToken', storage, {
      refreshRotationGraceMs: 0,
    });
    await adapter.upsert('rt-3', { grantId: 'g-3', sub: 'alice' });
    await adapter.consume('rt-3');

    const found = await adapter.find('rt-3');
    expect(typeof found?.consumed).toBe('number');
  });

  it('grace does NOT apply to AuthorizationCode — single-use by spec', async () => {
    // AuthorizationCode replay must always trigger reuse-detection
    // immediately. A grace window here would weaken §4.1.3 single-use.
    const adapter = new OidcProviderAdapter('AuthorizationCode', storage, {
      refreshRotationGraceMs: 30_000,
    });
    await adapter.upsert('code-1', { grantId: 'g-1', sub: 'alice' });
    await adapter.consume('code-1');

    const found = await adapter.find('code-1');
    expect(typeof found?.consumed).toBe('number');
  });

  it('grace does NOT apply to Session — only RefreshToken benefits', async () => {
    const adapter = new OidcProviderAdapter('Session', storage, {
      refreshRotationGraceMs: 30_000,
    });
    await adapter.upsert('sess-1', { grantId: 'g-1', sub: 'alice' });
    await adapter.consume('sess-1');

    const found = await adapter.find('sess-1');
    expect(typeof found?.consumed).toBe('number');
  });

  it('find() on a fresh (un-consumed) RefreshToken returns payload as-is', async () => {
    const adapter = new OidcProviderAdapter('RefreshToken', storage, {
      refreshRotationGraceMs: 30_000,
    });
    await adapter.upsert('rt-4', { grantId: 'g-4', sub: 'alice' });

    const found = await adapter.find('rt-4');
    expect(found).toEqual({ grantId: 'g-4', sub: 'alice' });
  });

  it('find() on a missing record returns undefined', async () => {
    const adapter = new OidcProviderAdapter('RefreshToken', storage);
    const found = await adapter.find('never-existed');
    expect(found).toBeUndefined();
  });

  it('multiple concurrent finds within grace ALL see un-consumed payload', async () => {
    // Pins the actual scenario the grace solves: oidc-provider gets two
    // concurrent token-exchange requests; both call find() on the same
    // refresh token; if both see un-consumed, both can issue rotated
    // tokens. Without grace, the second find() would see consumed and
    // trigger reuse-detection — kicking the user out.
    const adapter = new OidcProviderAdapter('RefreshToken', storage, {
      refreshRotationGraceMs: 30_000,
    });
    await adapter.upsert('rt-race', { grantId: 'g-race', sub: 'alice' });
    await adapter.consume('rt-race');

    const [a, b, c] = await Promise.all([
      adapter.find('rt-race'),
      adapter.find('rt-race'),
      adapter.find('rt-race'),
    ]);
    expect(a?.consumed).toBeUndefined();
    expect(b?.consumed).toBeUndefined();
    expect(c?.consumed).toBeUndefined();
  });

  // ---- Cycle-15 fix: hashRotationAttribute salted branch coverage ----
  //
  // hashRotationAttribute has two production paths: with salt (HMAC-
  // SHA256) and without (plain SHA-256). All other tests in this file
  // use the unsalted form. The cycle-12 IP/UA hashing in production
  // ALWAYS passes a salt (state.cookieKeys[0]). Without a test for the
  // salted branch, a regression that swapped the branches or dropped
  // the HMAC path would not be caught.

  describe('hashRotationAttribute salted branch (Cycle-15)', () => {
    it('produces a different hash from the unsalted form for the same input', () => {
      const value = '203.0.113.42';
      const unsalted = hashRotationAttribute(value);
      const salted = hashRotationAttribute(value, 'deployment-secret-32-bytes-or-more');
      expect(salted).not.toBe(unsalted);
      expect(salted).toMatch(/^[0-9a-f]{64}$/); // 32-byte hex
    });

    it('different salts produce different hashes for the same input', () => {
      const value = '203.0.113.42';
      const a = hashRotationAttribute(value, 'salt-a');
      const b = hashRotationAttribute(value, 'salt-b');
      expect(a).not.toBe(b);
    });

    it('same salt + same input produces stable output (HMAC determinism)', () => {
      const a = hashRotationAttribute('203.0.113.42', 'shared-salt');
      const b = hashRotationAttribute('203.0.113.42', 'shared-salt');
      expect(a).toBe(b);
    });

    it('empty-string salt falls back to unsalted SHA-256', () => {
      // The function checks `salt && salt.length > 0`; empty string
      // takes the unsalted branch.
      const empty = hashRotationAttribute('203.0.113.42', '');
      const unsalted = hashRotationAttribute('203.0.113.42');
      expect(empty).toBe(unsalted);
    });
  });

  // ---- Round 5 / H1: opt-in IP/UA-bound grace window ----

  describe('refreshRotationCheckIpUa: true', () => {
    const ipA = hashRotationAttribute('203.0.113.1');
    const uaA = hashRotationAttribute('agent-A');
    const ipB = hashRotationAttribute('203.0.113.99');
    const uaB = hashRotationAttribute('agent-B');

    it('upsert stamps ipHash + uaHash from the request context onto the payload', async () => {
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        refreshRotationCheckIpUa: true,
      });
      await withRotationRequestContext({ ipHash: ipA, uaHash: uaA }, async () => {
        await adapter.upsert('rt-h1-stamp', { grantId: 'g-1', sub: 'alice' });
      });
      // Read the underlying record to confirm the stamp landed.
      const stored = await storage.genericGet('RefreshToken', 'rt-h1-stamp') as Record<string, unknown>;
      expect(stored.ipHash).toBe(ipA);
      expect(stored.uaHash).toBe(uaA);
    });

    it('grace fires when consume + find share IP/UA', async () => {
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        refreshRotationCheckIpUa: true,
      });
      await withRotationRequestContext({ ipHash: ipA, uaHash: uaA }, async () => {
        await adapter.upsert('rt-h1-same', { grantId: 'g-1', sub: 'alice' });
        await adapter.consume('rt-h1-same');
        const found = await adapter.find('rt-h1-same');
        expect(found?.consumed).toBeUndefined();
      });
    });

    it('grace does NOT fire when find arrives from a different IP', async () => {
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        refreshRotationCheckIpUa: true,
      });
      await withRotationRequestContext({ ipHash: ipA, uaHash: uaA }, async () => {
        await adapter.upsert('rt-h1-diff', { grantId: 'g-1', sub: 'alice' });
        await adapter.consume('rt-h1-diff');
      });
      // Now find from a DIFFERENT IP — simulates a stolen token used
      // from an unrelated network within the grace window.
      const found = await withRotationRequestContext(
        { ipHash: ipB, uaHash: uaA },
        async () => adapter.find('rt-h1-diff'),
      );
      expect(typeof found?.consumed).toBe('number'); // grace skipped → reuse-detection arms
    });

    it('grace does NOT fire when find arrives from a different UA', async () => {
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        refreshRotationCheckIpUa: true,
      });
      await withRotationRequestContext({ ipHash: ipA, uaHash: uaA }, async () => {
        await adapter.upsert('rt-h1-ua', { grantId: 'g-1', sub: 'alice' });
        await adapter.consume('rt-h1-ua');
      });
      const found = await withRotationRequestContext(
        { ipHash: ipA, uaHash: uaB },
        async () => adapter.find('rt-h1-ua'),
      );
      expect(typeof found?.consumed).toBe('number');
    });

    it('legacy records without ipHash get the time-only grace (fail-open)', async () => {
      // Records that pre-date this option must continue to work — the
      // option turning on after deployment shouldn't lock everyone out.
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        refreshRotationCheckIpUa: true,
      });
      // Upsert WITHOUT a context — no ipHash recorded.
      await adapter.upsert('rt-h1-legacy', { grantId: 'g-1', sub: 'alice' });
      await adapter.consume('rt-h1-legacy');
      // Find inside a context with arbitrary hashes — the legacy record
      // has no hashes to compare against, so time-only grace applies.
      const found = await withRotationRequestContext(
        { ipHash: ipA, uaHash: uaA },
        async () => adapter.find('rt-h1-legacy'),
      );
      expect(found?.consumed).toBeUndefined();
    });
  });

  describe('refreshRotationCheckIpUa: true — production shape', () => {
    // The production code wraps the oidc-provider catch-all in a
    // synchronous-callback shape: `withRotationRequestContext(ctx, () =>
    // provider.callback()(req, res))`. provider.callback() returns
    // synchronously and kicks off async work that the caller does NOT
    // await. Round 5 reviewer flagged this as potentially losing the
    // ALS context across the sync→async boundary (the unit tests above
    // all use `async () => await adapter.upsert(...)` which keeps the
    // context held across an explicit await).
    //
    // AsyncLocalStorage.run() is documented to propagate the store to
    // any async work created inside the callback — including microtasks
    // and setImmediate continuations — via async_hooks. This test pins
    // that contract: a fire-and-forget chain rooted inside the
    // synchronous run() callback must still see the same store.
    it('production shape: sync run-callback that fires async upsert without await still sees the context', async () => {
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        refreshRotationCheckIpUa: true,
      });
      const ipProd = hashRotationAttribute('203.0.113.50');
      const uaProd = hashRotationAttribute('production-agent');

      // Mirror the production wrap: synchronous arrow callback that
      // dispatches async work via Promise.resolve().then(...) without
      // awaiting it. Set up a promise we resolve when the upsert lands
      // so the test can await completion outside the run() boundary.
      const upserted = new Promise<void>((resolve) => {
        withRotationRequestContext({ ipHash: ipProd, uaHash: uaProd }, () => {
          // No await, no return of the promise — exactly how
          // EmbeddedAuthorizationServer wraps `provider.callback()(req, res)`.
          void Promise.resolve().then(async () => {
            await adapter.upsert('rt-prod-shape', { grantId: 'g-1', sub: 'alice' });
            resolve();
          });
        });
      });
      await upserted;

      const stored = await storage.genericGet('RefreshToken', 'rt-prod-shape') as Record<string, unknown>;
      expect(stored.ipHash).toBe(ipProd);
      expect(stored.uaHash).toBe(uaProd);
    });

    it('production shape: setImmediate-scheduled find inside the run callback also sees the context', async () => {
      // Stronger variant — work scheduled via setImmediate, not just a
      // microtask. async_hooks must propagate across both task queues.
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        refreshRotationCheckIpUa: true,
      });
      const ipProd = hashRotationAttribute('203.0.113.51');
      const uaProd = hashRotationAttribute('imm-agent');

      // Seed a record from the matching IP/UA + consume it.
      await withRotationRequestContext({ ipHash: ipProd, uaHash: uaProd }, async () => {
        await adapter.upsert('rt-prod-imm', { grantId: 'g-1', sub: 'alice' });
        await adapter.consume('rt-prod-imm');
      });

      const found = await new Promise<Record<string, unknown> | undefined>((resolve) => {
        withRotationRequestContext({ ipHash: ipProd, uaHash: uaProd }, () => {
          setImmediate(() => {
            void adapter.find('rt-prod-imm').then(resolve);
          });
        });
      });
      // Same IP/UA inside grace window — consumed must be hidden.
      expect(found?.consumed).toBeUndefined();
    });
  });

  describe('refreshRotationCheckIpUa: false (default)', () => {
    it('grace fires regardless of IP/UA mismatch', async () => {
      // Default behavior — industry norm. Time-only window. Stored
      // hashes (if any) are ignored. This locks the contract that the
      // option is genuinely opt-in.
      const adapter = new OidcProviderAdapter('RefreshToken', storage, {
        refreshRotationGraceMs: 30_000,
        // refreshRotationCheckIpUa intentionally omitted.
      });
      const ip1 = hashRotationAttribute('1.1.1.1');
      const ip2 = hashRotationAttribute('2.2.2.2');
      const ua = hashRotationAttribute('test-agent');
      await withRotationRequestContext({ ipHash: ip1, uaHash: ua }, async () => {
        await adapter.upsert('rt-default', { grantId: 'g-1', sub: 'alice' });
        await adapter.consume('rt-default');
      });
      const found = await withRotationRequestContext(
        { ipHash: ip2, uaHash: ua }, // different IP
        async () => adapter.find('rt-default'),
      );
      expect(found?.consumed).toBeUndefined(); // grace still fires
    });
  });
});
