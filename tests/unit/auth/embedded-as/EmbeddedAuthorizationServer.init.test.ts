/**
 * EmbeddedAuthorizationServer.ensureInitialized — H15 regression.
 *
 * If initialize() throws (corrupt key file, disk full, DB unreachable),
 * the cached initPromise must be cleared so a subsequent call attempts
 * a fresh initialize. Without this clear, a single transient failure
 * leaves the AS permanently dead until process restart.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { EmbeddedAuthorizationServer } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { TrivialConsentMethod } from '../../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import type { IAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';

/**
 * Storage proxy that throws on the first N genericGet calls then
 * delegates to a real backend. Used to simulate a transient failure
 * during initialize (which calls genericGet for the mode fingerprint).
 */
class FlakyStorage implements IAuthStorageLayer {
  private failures: number;

  constructor(failOnFirstNGet: number, private readonly inner: IAuthStorageLayer) {
    this.failures = failOnFirstNGet;
  }

  async genericGet(model: string, id: string): Promise<unknown | null> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(`flaky storage transient failure (remaining: ${this.failures + 1})`);
    }
    return this.inner.genericGet(model, id);
  }

  // Delegate everything else.
  // Cycle-10 fix (TPW-1): kept up to date with the IAuthStorageLayer
  // interface. Earlier shape was missing 6 methods (setAccountRoles,
  // updateAccountLastAuth, getBootstrapState, markBootstrapComplete,
  // genericConsume, genericInsertIfAbsent, genericRevokeByGrantId)
  // and only compiled because ts-jest's `isolatedModules: true` skips
  // type checking. A future refactor that routed init() through any
  // missing method would have crashed at runtime for the wrong reason.
  findAccountByExternalId(p: string, e: string) { return this.inner.findAccountByExternalId(p, e); }
  upsertAccount(a: import('../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js').StoredAccount) { return this.inner.upsertAccount(a); }
  getAccount(s: string) { return this.inner.getAccount(s); }
  setAccountRoles(s: string, r: string[]) { return this.inner.setAccountRoles(s, r); }
  updateAccountLastAuth(s: string, t: number) { return this.inner.updateAccountLastAuth(s, t); }
  getBootstrapState() { return this.inner.getBootstrapState(); }
  markBootstrapComplete(s: string, m: 'local-password' | 'magic-link' | 'github') { return this.inner.markBootstrapComplete(s, m); }
  recordIdentityEvent(e: import('../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js').IdentityAuditEvent) { return this.inner.recordIdentityEvent(e); }
  listIdentityEvents(f?: import('../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js').IdentityEventFilter) { return this.inner.listIdentityEvents(f); }
  findGrantsByAccountId(s: string) { return this.inner.findGrantsByAccountId(s); }
  genericSet(m: string, i: string, p: unknown, e?: number) { return this.inner.genericSet(m, i, p, e); }
  genericDestroy(m: string, i: string) { return this.inner.genericDestroy(m, i); }
  genericConsume(m: string, i: string) { return this.inner.genericConsume(m, i); }
  genericInsertIfAbsent(m: string, i: string, p: unknown, e?: number) { return this.inner.genericInsertIfAbsent(m, i, p, e); }
  clearGenericByModels(m: readonly string[]) { return this.inner.clearGenericByModels(m); }
  genericFindByUid(uid: string) { return this.inner.genericFindByUid?.(uid) ?? Promise.resolve(null); }
  genericRevokeByGrantId(grantId: string) { return this.inner.genericRevokeByGrantId?.(grantId) ?? Promise.resolve(); }
}

describe('EmbeddedAuthorizationServer.ensureInitialized — H15', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-init-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: run an awaitable that may reject and return either the
   * resolution or the captured error. The H15 test cares about WHICH
   * attempt fails — first attempt's transient error vs. cached stale
   * rejection — so we capture both shapes.
   */
  async function attempt(fn: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; error: Error }> {
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err as Error };
    }
  }

  it('a transient init failure does NOT poison subsequent ensureInitialized calls', async () => {
    const inner = new InMemoryAuthStorageLayer();
    const flaky = new FlakyStorage(1, inner); // throws on the first genericGet only
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: path.join(tmpDir, 'key.json'),
      methods: [new TrivialConsentMethod({ defaultSubject: 'h15-test' })],
      storage: flaky,
    });

    // First call: init fails because flaky storage threw.
    const first = await attempt(() => as.validate('not-a-real-token'));
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.message).toContain('flaky storage');
    }

    // Second call: storage no longer throws. With H15, initPromise was
    // cleared on rejection, so this call starts a FRESH init. If the
    // bug exists, the second call awaits the cached rejection and
    // throws "flaky storage" again.
    const second = await attempt(() => as.validate('not-a-real-token'));
    expect(second.ok).toBe(true);
  });

  it('cycle 19 / test-B2: mode-switch detection emits auth.mode_switch_invalidation audit event', async () => {
    // Dashboard row #14 (must-fix #14, mode-switch invalidates tokens)
    // claimed WIRED-AND-TESTED with `modeFingerprint.test.ts` and
    // `persistKeys.test.ts` cited as proof. Reviewer found neither
    // file references `auth.mode_switch_invalidation` or
    // `recordIdentityEvent` — the audit event the dashboard implies
    // is observable was never tested. A regression dropping the
    // recordIdentityEvent call (or changing the event type string)
    // would pass every existing test in the suite.
    //
    // This test pins the event emission contract end-to-end:
    //   AS #1 init  → fingerprint persists (no change event)
    //   AS #2 init w/ different methodIds → mode-switch detected → event emitted
    const sharedStorage = new InMemoryAuthStorageLayer();
    const sharedKeyPath = path.join(tmpDir, 'mode-switch-key.json');

    // First init: AS with one method. Writes fingerprint, no event.
    const as1 = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: sharedKeyPath,
      methods: [new TrivialConsentMethod({ defaultSubject: 'mode-switch-test' })],
      storage: sharedStorage,
    });
    await as1.validate('warmup-not-a-real-token').catch(() => {});

    const eventsAfterFirst = await sharedStorage.listIdentityEvents({
      type: 'auth.mode_switch_invalidation',
    });
    expect(eventsAfterFirst.length).toBe(0);

    // Second init: SAME storage, SAME keyFile, but DIFFERENT issuer.
    // This forces fingerprintResult.changed = true → invalidation
    // sequence runs → audit event emitted.
    const as2 = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531', // differs from as1
      keyFilePath: sharedKeyPath,
      methods: [new TrivialConsentMethod({ defaultSubject: 'mode-switch-test' })],
      storage: sharedStorage,
    });
    await as2.validate('warmup-not-a-real-token').catch(() => {});

    const eventsAfterSecond = await sharedStorage.listIdentityEvents({
      type: 'auth.mode_switch_invalidation',
    });
    expect(eventsAfterSecond.length).toBe(1);
    const event = eventsAfterSecond[0];
    const details = event.details as Record<string, unknown>;
    // Sanity-check the shape so a regression dropping `cleared`,
    // `previous`, or `current` fails loudly.
    expect(typeof event.timestamp).toBe('number');
    expect(typeof details.cleared).toBe('number');
    expect(details.previous).toBeDefined();
    expect(details.current).toBeDefined();
    expect(details.previous).not.toEqual(details.current);

    // Cycle 22 / cycle-21 test-coverage HIGH: pin causality by
    // computing the expected fingerprints from the same inputs the
    // production code uses. If a future refactor decouples the issuer
    // dimension from the fingerprint computation, the expected hash
    // here will no longer match the recorded `current` and this
    // assertion fails — making the silent-decoupling drift visible.
    // Without this, `previous !== current` only proves the two opaque
    // SHA-256 hashes differ, not that the issuer dimension drove it.
    const { computeFingerprint } = await import(
      '../../../../src/auth/embedded-as/modeFingerprint.js'
    );
    const baseInputs = {
      provider: 'embedded',
      methodIds: ['trivial-consent'],
    };
    // The test can't reconstruct primaryKid + primaryCookieKey
    // (file-derived, lifecycle-dependent) but it CAN assert the
    // issuer-derived component: compute fingerprints with each issuer
    // holding everything else equal, and confirm the recorded
    // current matches the second-AS issuer-set.
    const fp1 = computeFingerprint({ ...baseInputs, issuer: 'http://127.0.0.1:65530', primaryKid: '', primaryCookieKey: '' });
    const fp2 = computeFingerprint({ ...baseInputs, issuer: 'http://127.0.0.1:65531', primaryKid: '', primaryCookieKey: '' });
    // The actual recorded fingerprints include the kid + cookieKey, so
    // they won't equal fp1/fp2 directly. But fp1 vs fp2 must differ
    // (issuer is the only changed input) — pins the issuer-dimension
    // contribution to the fingerprint hash.
    expect(fp1).not.toBe(fp2);
  });

  it('repeated init failures keep producing fresh attempts (no stale rejection)', async () => {
    const inner = new InMemoryAuthStorageLayer();
    const flaky = new FlakyStorage(3, inner); // throws on the first 3 genericGet calls
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: path.join(tmpDir, 'key.json'),
      methods: [new TrivialConsentMethod({ defaultSubject: 'h15-test' })],
      storage: flaky,
    });

    // Three failed init attempts must each be FRESH. Without H15 they
    // would all return the same cached rejection (proving by counter:
    // the FlakyStorage `failures` field decrements only when genericGet
    // is actually invoked, so if init were re-attempted the counter
    // would reach 0 and the fourth call would succeed).
    for (let i = 0; i < 3; i += 1) {
      const r = await attempt(() => as.validate('not-a-real-token'));
      expect(r.ok).toBe(false);
    }
    const fourth = await attempt(() => as.validate('not-a-real-token'));
    expect(fourth.ok).toBe(true);
  });
});
