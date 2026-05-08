/**
 * H8 — /.well-known/oauth-authorization-server route must NOT hang
 *      when ensureInitialized() rejects.
 *
 * The bare `void this.handleAuthorizationServerMetadata(req, res)` swallowed
 * the rejection, so a transient init failure (corrupt key file, disk full,
 * DB unreachable) left the request open until the client timed out — no
 * Express error handler ever fired. The fix wraps the call in the same
 * try/catch/next pattern the /interaction handler already uses below it.
 *
 * This regression locks the behavior: an init-rejecting server must respond
 * to the well-known route within the test timeout (5s), not hang.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { EmbeddedAuthorizationServer } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { TrivialConsentMethod } from '../../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import type { IAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';

/**
 * Storage proxy that always throws on genericGet — so ensureInitialized()
 * (which calls genericGet to read the mode fingerprint) keeps rejecting.
 * Other methods delegate so the server can construct cleanly.
 */
class AlwaysFailGetStorage implements IAuthStorageLayer {
  constructor(private readonly inner: IAuthStorageLayer) {}

  async genericGet(_model: string, _id: string): Promise<unknown | null> {
    throw new Error('storage unreachable (simulated init failure)');
  }

  // Cycle-10 fix (TPW-1): kept up to date with IAuthStorageLayer.
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

describe('EmbeddedAuthorizationServer — H8 well-known route init-failure', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-h8-'));
    process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.1';
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /.well-known/oauth-authorization-server completes (does not hang) when init keeps failing', async () => {
    const inner = new InMemoryAuthStorageLayer();
    const failing = new AlwaysFailGetStorage(inner);
    const as = new EmbeddedAuthorizationServer({
      publicBaseUrl: 'http://127.0.0.1:65530',
      keyFilePath: path.join(tmpDir, 'key.json'),
      methods: [new TrivialConsentMethod({ defaultSubject: 'h8-test' })],
      storage: failing,
    });

    const app = express();
    app.use(as.createRouter());
    // Default Express error handler responds 500 when next(err) fires.

    // Without H8 the request hangs — supertest's default timeout would
    // fail this assertion. With H8 the next(err) call hands control to
    // the Express error handler and the response completes (500).
    const res = await request(app)
      .get('/.well-known/oauth-authorization-server')
      .timeout({ deadline: 5_000, response: 5_000 });

    // The exact status is whatever the Express default error handler
    // returns (500). What we're locking in is that a response IS sent
    // — the response must complete rather than hang the connection.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
  });
});
