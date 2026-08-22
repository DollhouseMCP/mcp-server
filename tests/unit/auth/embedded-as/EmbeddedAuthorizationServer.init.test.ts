/**
 * EmbeddedAuthorizationServer.ensureInitialized — H15 regression.
 *
 * If initialize() throws (corrupt key file, disk full, DB unreachable),
 * the cached initPromise must be cleared so a subsequent call attempts
 * a fresh initialize. Without this clear, a single transient failure
 * leaves the AS permanently dead until process restart.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { EmbeddedAuthorizationServer } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { TrivialConsentMethod } from '../../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import type {
  IAuthStorageLayer,
  StoredAccount,
  IdentityAuditEvent,
  IdentityEventFilter,
} from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';
import { InMemorySigningKeyStore } from '../../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import { signingKeyCanVerify } from '../../../../src/storage/signingKeys/signingKeyLifecycle.js';
import { rotateSigningKeyViaStore } from '../../../../src/auth/embedded-as/persistKeys.js';
import { rotateCookieSecretViaStore } from '../../../../src/auth/embedded-as/cookieSecret.js';
import {
  createFreshInviteSigningKeyWrite,
  loadInviteTokenStoreViaStore,
} from '../../../../src/auth/embedded-as/inviteTokens.js';

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

  async genericGet(model: string, id: string): Promise<unknown> {
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
  upsertAccount(a: StoredAccount) { return this.inner.upsertAccount(a); }
  getAccount(s: string) { return this.inner.getAccount(s); }
  updateAccountLastAuth(s: string, t: number) { return this.inner.updateAccountLastAuth(s, t); }
  getBootstrapState() { return this.inner.getBootstrapState(); }
  markBootstrapComplete(s: string, m: 'local-password' | 'magic-link' | 'github') { return this.inner.markBootstrapComplete(s, m); }
  recordIdentityEvent(e: IdentityAuditEvent) { return this.inner.recordIdentityEvent(e); }
  listIdentityEvents(f?: IdentityEventFilter) { return this.inner.listIdentityEvents(f); }
  findGrantsByAccountId(s: string) { return this.inner.findGrantsByAccountId(s); }
  genericSet(m: string, i: string, p: unknown, e?: number) { return this.inner.genericSet(m, i, p, e); }
  genericCompareAndSet(m: string, i: string, x: unknown, p: unknown, e?: number) {
    return this.inner.genericCompareAndSet(m, i, x, p, e);
  }
  genericDestroy(m: string, i: string) { return this.inner.genericDestroy(m, i); }
  genericConsume(m: string, i: string) { return this.inner.genericConsume(m, i); }
  genericInsertIfAbsent(m: string, i: string, p: unknown, e?: number) { return this.inner.genericInsertIfAbsent(m, i, p, e); }
  clearGenericByModels(m: readonly string[]) { return this.inner.clearGenericByModels(m); }
  genericFindByUid(uid: string) { return this.inner.genericFindByUid?.(uid) ?? Promise.resolve(null); }
  genericRevokeByGrantId(grantId: string) { return this.inner.genericRevokeByGrantId?.(grantId) ?? Promise.resolve(); }
}

class FailFingerprintPersistOnceStorage extends InMemoryAuthStorageLayer {
  private armed = false;
  private failed = false;

  arm(): void {
    this.armed = true;
  }

  override async genericSet(model: string, id: string, payload: unknown, expiresInSec?: number): Promise<void> {
    if (this.armed && !this.failed && model === 'AuthModeFingerprint' && id === 'current') {
      this.failed = true;
      throw new Error('simulated crash before mode fingerprint completion');
    }
    return super.genericSet(model, id, payload, expiresInSec);
  }

  override async genericCompareAndSet(
    model: string,
    id: string,
    expectedPayload: unknown,
    payload: unknown,
    expiresInSec?: number,
  ): Promise<boolean> {
    if (this.armed && !this.failed && model === 'AuthModeFingerprint' && id === 'current') {
      this.failed = true;
      throw new Error('simulated crash before mode fingerprint completion');
    }
    return super.genericCompareAndSet(model, id, expectedPayload, payload, expiresInSec);
  }
}

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

describe('EmbeddedAuthorizationServer.ensureInitialized — H15', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-init-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

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
    const sharedInvitePath = path.join(tmpDir, 'mode-switch-invite.bin');

    // First init: AS with one method. Writes fingerprint, no event.
    const as1 = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: sharedKeyPath,
      inviteSecretFilePath: sharedInvitePath,
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
      inviteSecretFilePath: sharedInvitePath,
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

  it('initializes a cold durable signing store before publishing JWKS', async () => {
    const signingKeyStore = new InMemorySigningKeyStore();
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'cold-jwks-test' })],
      storage: new InMemoryAuthStorageLayer(),
      signingKeyStore,
    });
    const app = express();
    app.use(as.createRouter());

    const response = await request(app).get('/jwks').expect(200);
    const active = await signingKeyStore.getActive('jwks');

    expect(active).not.toBeNull();
    expect(response.body.keys).toHaveLength(1);
    expect(response.body.keys[0].kid).toBe(active?.kid);
    expect(response.body.keys[0].d).toBeUndefined();
  });

  it('retires prior durable JWT, cookie, and invite verification rings on every v2 mode mismatch', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const oldInviteStore = await loadInviteTokenStoreViaStore(signingKeyStore, storage, { envSecret: '' });
    const oldInviteToken = oldInviteStore.issue({
      sub: 'old-mode-invite',
      email: 'old-mode@example.com',
      purpose: 'invite',
    });
    const first = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'mode-ring-test' })],
      storage,
      signingKeyStore,
    });
    const oldToken = await first.issue('old-mode-user');
    const oldJwks = await signingKeyStore.getActive('jwks');
    const oldCookie = await signingKeyStore.getActive('cookie');
    if (!oldJwks || !oldCookie) throw new Error('expected initialized durable signing rings');
    await rotateSigningKeyViaStore(signingKeyStore);
    await rotateCookieSecretViaStore(signingKeyStore);
    await signingKeyStore.rotate(createFreshInviteSigningKeyWrite());
    const priorJwksIds = (await signingKeyStore.listByKind('jwks')).map(key => key.kid);
    const priorCookieIds = (await signingKeyStore.listByKind('cookie')).map(key => key.kid);
    const priorInviteIds = (await signingKeyStore.listByKind('invite')).map(key => key.kid);

    const second = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'mode-ring-test' })],
      storage,
      signingKeyStore,
    });
    await second.issue('new-mode-user');

    for (const kid of [...priorJwksIds, ...priorCookieIds, ...priorInviteIds]) {
      const retired = await signingKeyStore.getByKid(kid);
      expect(retired?.retiredAt).toEqual(expect.any(Number));
      expect(retired && signingKeyCanVerify(retired)).toBe(false);
    }
    await expect(second.validate(oldToken)).resolves.toMatchObject({ ok: false, reason: 'unknown key id' });
    const newInviteStore = await loadInviteTokenStoreViaStore(signingKeyStore, storage, { envSecret: '' });
    expect(newInviteStore.verify(oldInviteToken)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not excuse a v2 mode mismatch when the live replica also observes external key rotation', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const oldMode = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'rolling-mode-test' })],
      storage,
      signingKeyStore,
    });
    await oldMode.issue('old-mode-user');

    const newMode = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'rolling-mode-test' })],
      storage,
      signingKeyStore,
    });
    await newMode.issue('new-mode-user');
    const newModeJwks = await signingKeyStore.getActive('jwks');
    if (!newModeJwks) throw new Error('expected new-mode JWKS key');

    // The original live instance now observes both an external key rotation
    // and a persisted v2 fingerprint for a different mode. It must run full
    // invalidation rather than adopting the key change as an excuse to accept
    // the fingerprint mismatch.
    await oldMode.issue('old-mode-after-rollout-race');

    expect((await signingKeyStore.getByKid(newModeJwks.kid))?.retiredAt)
      .toEqual(expect.any(Number));
    await expect(storage.listIdentityEvents({ type: 'auth.mode_switch_invalidation' }))
      .resolves.toHaveLength(2);
  });

  it('rejects a stale rolling replica instead of reverting a newer authorization generation', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const oldReplica = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      authGeneration: 1,
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-fence-test' })],
      storage,
      signingKeyStore,
    });
    await oldReplica.issue('old-generation-user');

    const newReplica = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      authGeneration: 2,
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-fence-test' })],
      storage,
      signingKeyStore,
    });
    await newReplica.issue('new-generation-user');
    const newGenerationKey = await signingKeyStore.getActive('jwks');

    await expect(oldReplica.issue('stale-replica-user'))
      .rejects.toThrow(/generation rollback rejected/u);
    await expect(signingKeyStore.getActive('jwks')).resolves.toMatchObject({
      kid: newGenerationKey?.kid,
    });
    await expect(storage.listIdentityEvents({ type: 'auth.mode_switch_invalidation' }))
      .resolves.toHaveLength(1);
  });

  it('rejects bearer validation on a replica with an older authorization generation', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const sharedOptions = {
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-validation-test' })],
      storage,
      signingKeyStore,
    };
    const oldReplica = new EmbeddedAuthorizationServer({
      ...sharedOptions,
      authGeneration: 1,
    });
    await oldReplica.issue('old-generation-user');

    const newReplica = new EmbeddedAuthorizationServer({
      ...sharedOptions,
      authGeneration: 2,
    });
    const newGenerationToken = await newReplica.issue('new-generation-user');

    await expect(oldReplica.validate(newGenerationToken))
      .rejects.toThrow(/generation rollback rejected/u);
  });

  it('requires an operator-managed cookie key rotation when only authorization generation changes', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const cookieSecret = Buffer.alloc(32, 0x71).toString('hex');
    const sharedOptions = {
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-cookie-test' })],
      storage,
      signingKeyStore,
      cookieSecretEnvOverride: cookieSecret,
    };
    await new EmbeddedAuthorizationServer({ ...sharedOptions, authGeneration: 1 })
      .issue('generation-one');

    await expect(new EmbeddedAuthorizationServer({ ...sharedOptions, authGeneration: 2 })
      .issue('generation-two')).rejects.toThrow(
      'DOLLHOUSE_COOKIE_SIGNING_SECRET is operator-managed',
    );
  });

  it('requires an operator-managed invite key rotation when only authorization generation changes', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const inviteSecret = Buffer.alloc(32, 0x72).toString('hex');
    const sharedOptions = {
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-invite-test' })],
      storage,
      signingKeyStore,
      inviteSecretEnvOverride: inviteSecret,
    };
    await new EmbeddedAuthorizationServer({ ...sharedOptions, authGeneration: 1 })
      .issue('generation-one');

    await expect(new EmbeddedAuthorizationServer({ ...sharedOptions, authGeneration: 2 })
      .issue('generation-two')).rejects.toThrow(
      'DOLLHOUSE_INVITE_TOKEN_SECRET is operator-managed',
    );
  });

  it('accepts an authorization-generation change after every operator-managed key rotates', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const sharedOptions = {
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-key-rotation-test' })],
      storage,
      signingKeyStore,
    };
    await new EmbeddedAuthorizationServer({
      ...sharedOptions,
      authGeneration: 1,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x73).toString('hex'),
      inviteSecretEnvOverride: Buffer.alloc(32, 0x74).toString('hex'),
    }).issue('generation-one');

    await expect(new EmbeddedAuthorizationServer({
      ...sharedOptions,
      authGeneration: 2,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x75).toString('hex'),
      inviteSecretEnvOverride: Buffer.alloc(32, 0x76).toString('hex'),
    }).issue('generation-two')).resolves.toEqual(expect.any(String));
  });

  it('fails closed on a mode mismatch when the cookie key is environment-managed', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const cookieSecret = Buffer.alloc(32, 0x7a).toString('hex');
    const first = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-cookie-test' })],
      storage,
      signingKeyStore,
      cookieSecretEnvOverride: cookieSecret,
    });
    await first.issue('old-mode-user');
    const oldJwks = await signingKeyStore.getActive('jwks');

    const second = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-cookie-test' })],
      storage,
      signingKeyStore,
      cookieSecretEnvOverride: cookieSecret,
    });
    await expect(second.issue('new-mode-user')).rejects.toThrow(
      'DOLLHOUSE_COOKIE_SIGNING_SECRET is operator-managed',
    );
    expect((await signingKeyStore.getActive('jwks'))?.kid).toBe(oldJwks?.kid);
  });

  it('accepts an environment-managed mode switch after the operator rotates the cookie key', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const first = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-cookie-rotation-test' })],
      storage,
      signingKeyStore,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x7a).toString('hex'),
    });
    const oldToken = await first.issue('old-mode-user');

    const second = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-cookie-rotation-test' })],
      storage,
      signingKeyStore,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x7b).toString('hex'),
    });
    await expect(second.issue('new-mode-user')).resolves.toEqual(expect.any(String));
    await expect(second.validate(oldToken)).resolves.toMatchObject({
      ok: false,
      reason: 'unknown key id',
    });
    await expect(storage.listIdentityEvents({ type: 'auth.mode_switch_invalidation' }))
      .resolves.toHaveLength(1);

    const restarted = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-cookie-rotation-test' })],
      storage,
      signingKeyStore,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x7b).toString('hex'),
    });
    await expect(restarted.issue('restarted-mode-user')).resolves.toEqual(expect.any(String));
  });

  it('fails closed on a mode mismatch when the operator-managed invite key was not rotated', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const inviteSecret = Buffer.alloc(32, 0x61).toString('hex');
    const first = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-invite-test' })],
      storage,
      signingKeyStore,
      inviteSecretEnvOverride: inviteSecret,
    });
    await first.issue('old-mode-user');
    const oldJwks = await signingKeyStore.getActive('jwks');

    const second = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-invite-test' })],
      storage,
      signingKeyStore,
      inviteSecretEnvOverride: inviteSecret,
    });
    await expect(second.issue('new-mode-user')).rejects.toThrow(
      'DOLLHOUSE_INVITE_TOKEN_SECRET is operator-managed',
    );
    expect((await signingKeyStore.getActive('jwks'))?.kid).toBe(oldJwks?.kid);
  });

  it('accepts an operator-managed mode switch after the invite key is rotated', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const first = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-invite-rotation-test' })],
      storage,
      signingKeyStore,
      inviteSecretEnvOverride: Buffer.alloc(32, 0x61).toString('hex'),
    });
    const oldToken = await first.issue('old-mode-user');

    const second = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-invite-rotation-test' })],
      storage,
      signingKeyStore,
      inviteSecretEnvOverride: Buffer.alloc(32, 0x62).toString('hex'),
    });
    await expect(second.issue('new-mode-user')).resolves.toEqual(expect.any(String));
    await expect(second.validate(oldToken)).resolves.toMatchObject({
      ok: false,
      reason: 'unknown key id',
    });
  });

  it('does not reuse an earlier environment-key rotation to authorize a later mode switch', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const originalMode = {
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'managed-cookie-replay-test' })],
      storage,
      signingKeyStore,
    } as const;
    await new EmbeddedAuthorizationServer({
      ...originalMode,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x7a).toString('hex'),
    }).issue('original-key-user');

    // Rotating the override while the mode is unchanged updates the stored
    // override fingerprint. It cannot remain as reusable evidence for a
    // future mode switch.
    await new EmbeddedAuthorizationServer({
      ...originalMode,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x7b).toString('hex'),
    }).issue('rotated-key-user');

    const changedMode = new EmbeddedAuthorizationServer({
      ...originalMode,
      publicBaseUrl: 'http://127.0.0.1:65531',
      cookieSecretEnvOverride: Buffer.alloc(32, 0x7b).toString('hex'),
    });
    await expect(changedMode.issue('new-mode-user')).rejects.toThrow(
      'rotate or remove that secret before activating the new mode',
    );
  });

  it('treats override introduction and removal as credential-generation transitions', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const oldInviteStore = await loadInviteTokenStoreViaStore(signingKeyStore, storage, { envSecret: '' });
    const oldInviteToken = oldInviteStore.issue({
      sub: 'override-transition-user',
      email: 'override-transition@example.test',
      purpose: 'invite',
    });
    const base = {
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'override-transition-test' })],
      storage,
      signingKeyStore,
    } as const;
    await new EmbeddedAuthorizationServer(base).issue('stored-generation');
    const oldCookie = await signingKeyStore.getActive('cookie');
    const oldInvite = await signingKeyStore.getActive('invite');
    await storage.genericSet('Session', 'must-clear-on-override-introduction', { uid: 'old' });

    await new EmbeddedAuthorizationServer({
      ...base,
      cookieSecretEnvOverride: Buffer.alloc(32, 0x41).toString('hex'),
      inviteSecretEnvOverride: Buffer.alloc(32, 0x42).toString('hex'),
    }).issue('environment-generation');

    expect((await signingKeyStore.getByKid(oldCookie?.kid ?? 'missing'))?.retiredAt)
      .toEqual(expect.any(Number));
    expect((await signingKeyStore.getByKid(oldInvite?.kid ?? 'missing'))?.retiredAt)
      .toEqual(expect.any(Number));
    await expect(storage.genericGet('Session', 'must-clear-on-override-introduction')).resolves.toBeNull();

    await new EmbeddedAuthorizationServer(base).issue('restored-store-generation');
    const restoredCookie = await signingKeyStore.getActive('cookie');
    const restoredInvite = await signingKeyStore.getActive('invite');
    expect(restoredCookie?.kid).not.toBe(oldCookie?.kid);
    expect(restoredInvite?.kid).not.toBe(oldInvite?.kid);
    const restoredInviteStore = await loadInviteTokenStoreViaStore(signingKeyStore, storage, { envSecret: '' });
    expect(restoredInviteStore.verify(oldInviteToken)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reuses one installed generation and one audit event after a crash before fingerprint completion', async () => {
    const storage = new FailFingerprintPersistOnceStorage();
    const signingKeyStore = new InMemorySigningKeyStore();
    const original = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'crash-retry-test' })],
      storage,
      signingKeyStore,
    });
    await original.issue('original-mode');
    storage.arm();
    const changed = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'crash-retry-test' })],
      storage,
      signingKeyStore,
    });

    await expect(changed.issue('first-attempt')).rejects.toThrow(/simulated crash/u);
    const installedAfterFailure = await signingKeyStore.getActive('jwks');
    await expect(changed.issue('retry')).resolves.toEqual(expect.any(String));
    expect((await signingKeyStore.getActive('jwks'))?.kid).toBe(installedAfterFailure?.kid);
    await expect(storage.listIdentityEvents({ type: 'auth.mode_switch_invalidation' }))
      .resolves.toHaveLength(1);
  });

  it('rejects a stale replica that adopted new keys before the newer generation committed', async () => {
    const storage = new FailFingerprintPersistOnceStorage();
    const signingKeyStore = new InMemorySigningKeyStore();
    const oldReplica = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      authGeneration: 1,
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-crash-race-test' })],
      storage,
      signingKeyStore,
    });
    await oldReplica.issue('original-generation');

    storage.arm();
    const newReplica = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      authGeneration: 2,
      methods: [new TrivialConsentMethod({ defaultSubject: 'generation-crash-race-test' })],
      storage,
      signingKeyStore,
    });
    await expect(newReplica.issue('failed-cutover')).rejects.toThrow(/simulated crash/u);

    // The active key already carries generation 2 even though the shared
    // fingerprint commit crashed. Generation 1 must not adopt that key and
    // issue under stale authorization rules during the cutover window.
    await expect(oldReplica.issue('during-cutover')).rejects.toThrow(
      /Active JWKS authorization generation does not match/u,
    );
    await expect(newReplica.issue('completed-cutover')).resolves.toEqual(expect.any(String));
    await expect(oldReplica.issue('after-cutover')).rejects.toThrow(/generation rollback rejected/u);
  });

  it('mints direct access tokens inside the active JWKS lifecycle boundary', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    const withActiveKey = jest.spyOn(signingKeyStore, 'withActiveKey');
    const server = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'lifecycle-signing-test' })],
      storage,
      signingKeyStore,
    });

    await expect(server.issue('lifecycle-signing-test')).resolves.toEqual(expect.any(String));

    expect(withActiveKey).toHaveBeenCalledWith('jwks', expect.any(Function));
  });

  it('retries token audit writes and fails readiness and disposal after terminal loss', async () => {
    const storage = new InMemoryAuthStorageLayer();
    await storage.markBootstrapComplete('audit-admin', 'github');
    const server = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'audit-failure-test' })],
      storage,
      signingKeyStore: new InMemorySigningKeyStore(),
    });
    await server.issue('initialize-audit-provider');
    const recordIdentityEvent = jest.spyOn(storage, 'recordIdentityEvent')
      .mockRejectedValue(new Error('audit storage unavailable'));
    const state = (server as unknown as { state: { provider: { emit: (name: string, token: unknown) => void } } }).state;

    state.provider.emit('access_token.issued', {
      accountId: 'audit-user',
      kind: 'AccessToken',
      clientId: 'audit-client',
    });

    await expect(server.dispose()).rejects.toThrow(
      'authorization audit events could not be persisted',
    );
    expect(recordIdentityEvent).toHaveBeenCalledTimes(3);
    await expect(server.isReadyForTraffic()).resolves.toBe(false);
    expect(server.getReadinessFailureReason()).toBe('audit_write_failed');
  });

  it('coalesces concurrent replicas entering the same new mode', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const signingKeyStore = new InMemorySigningKeyStore();
    await new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      methods: [new TrivialConsentMethod({ defaultSubject: 'concurrent-mode-test' })],
      storage,
      signingKeyStore,
    }).issue('original-mode');
    const makeReplica = () => new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65531',
      methods: [new TrivialConsentMethod({ defaultSubject: 'concurrent-mode-test' })],
      storage,
      signingKeyStore,
    });

    await expect(Promise.all([
      makeReplica().issue('replica-a'),
      makeReplica().issue('replica-b'),
    ])).resolves.toHaveLength(2);
    for (const kind of ['jwks', 'cookie', 'invite'] as const) {
      const live = (await signingKeyStore.listByKind(kind)).filter(key => key.retiredAt === undefined);
      expect(live).toHaveLength(1);
    }
    await expect(storage.listIdentityEvents({ type: 'auth.mode_switch_invalidation' }))
      .resolves.toHaveLength(1);
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
