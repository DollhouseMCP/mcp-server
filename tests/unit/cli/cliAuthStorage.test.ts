/**
 * Round 5 post-triage HIGH-1: cliAuthStorage helper must wire a
 * database connection automatically when DOLLHOUSE_AUTH_STORAGE_BACKEND
 * is `postgres`. The previous shape called `createAuthStorage` directly
 * from the CLIs without a `database` option, which made the documented
 * Postgres bootstrap path return "requires a database connection."
 *
 * Tests cover the three branches:
 *   - filesystem backend → no DB pool opened (close() is a no-op)
 *   - memory backend → no DB pool opened
 *   - postgres backend without DOLLHOUSE_DATABASE_URL → clear error
 *
 * The postgres-with-valid-DB-URL happy path is intentionally NOT unit
 * tested here. Mocking the postgres.js + Drizzle stack at unit level
 * would lock in a specific transitive call shape that the integration
 * suite already exercises against a real Postgres in CI (when
 * DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1 is set, `storage-parity.test.ts`
 * runs the same `createAuthStorage` postgres branch this helper
 * delegates to). A unit-level stub would catch wiring regressions
 * cheaply but at the cost of test fidelity to a real connection
 * lifecycle. Rather than add a synthetic mock, we rely on:
 *   1. Integration coverage via storage-parity (gated, runs in CI).
 *   2. Manual smoke verification at deploy time:
 *      `DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres
 *       DOLLHOUSE_DATABASE_URL=<...>
 *       node dist/cli/admin-bootstrap.js --method github --github-id 1`
 *      which was confirmed end-to-end in cycle 5 review.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { openCliAuthStorage } from '../../../src/cli/cliAuthStorage.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { FilesystemAuthStorageLayer } from '../../../src/auth/embedded-as/storage/FilesystemAuthStorageLayer.js';

describe('openCliAuthStorage', () => {
  const savedBackend = process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND;
  const savedDbUrl = process.env.DOLLHOUSE_DATABASE_URL;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (savedBackend === undefined) delete process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND;
    else process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = savedBackend;
    if (savedDbUrl === undefined) delete process.env.DOLLHOUSE_DATABASE_URL;
    else process.env.DOLLHOUSE_DATABASE_URL = savedDbUrl;
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('memory backend: returns InMemory storage with a no-op close', async () => {
    process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = 'memory';
    delete process.env.DOLLHOUSE_DATABASE_URL;
    const handle = await openCliAuthStorage({
      methods: ['trivial-consent'], // not durable, so memory is allowed
    });
    expect(handle.storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    // close() must succeed for callers that always invoke it.
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('filesystem backend: returns Filesystem storage with a no-op close', async () => {
    process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = 'filesystem';
    delete process.env.DOLLHOUSE_DATABASE_URL;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliAuthStorage-'));
    tmpDirs.push(tmpDir);
    const handle = await openCliAuthStorage({
      methods: ['local-password'],
      rootDir: tmpDir,
    });
    expect(handle.storage).toBeInstanceOf(FilesystemAuthStorageLayer);
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('postgres backend: throws a clear error when DOLLHOUSE_DATABASE_URL is unset', async () => {
    process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = 'postgres';
    delete process.env.DOLLHOUSE_DATABASE_URL;
    await expect(openCliAuthStorage({ methods: ['github'] })).rejects.toThrow(
      /DOLLHOUSE_DATABASE_URL/,
    );
  });

  it('explicit `backend` option overrides env detection', async () => {
    // Operator sets env to postgres but the test passes `backend: 'memory'`
    // explicitly — the explicit option must win and no DB read is attempted.
    process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = 'postgres';
    delete process.env.DOLLHOUSE_DATABASE_URL;
    const handle = await openCliAuthStorage({
      backend: 'memory',
      methods: ['trivial-consent'],
    });
    expect(handle.storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    await handle.close();
  });
});
