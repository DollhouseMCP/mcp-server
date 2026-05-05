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
  findAccountByExternalId(p: string, e: string) { return this.inner.findAccountByExternalId(p, e); }
  upsertAccount(a: import('../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js').StoredAccount) { return this.inner.upsertAccount(a); }
  getAccount(s: string) { return this.inner.getAccount(s); }
  recordIdentityEvent(e: import('../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js').IdentityAuditEvent) { return this.inner.recordIdentityEvent(e); }
  listIdentityEvents(f?: import('../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js').IdentityEventFilter) { return this.inner.listIdentityEvents(f); }
  findGrantsByAccountId(s: string) { return this.inner.findGrantsByAccountId(s); }
  genericSet(m: string, i: string, p: unknown, e?: number) { return this.inner.genericSet(m, i, p, e); }
  genericDestroy(m: string, i: string) { return this.inner.genericDestroy(m, i); }
  clearGenericByModels(m: readonly string[]) { return this.inner.clearGenericByModels(m); }
  genericFindByUid(uid: string) { return this.inner.genericFindByUid?.(uid) ?? Promise.resolve(null); }
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
