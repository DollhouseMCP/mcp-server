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
});
