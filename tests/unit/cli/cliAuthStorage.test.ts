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
 *   - postgres URL resolution prefers DOLLHOUSE_DATABASE_ADMIN_URL
 *   - postgres backend without a database URL → clear error
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
 *       DOLLHOUSE_DATABASE_ADMIN_URL=<...>
 *       node dist/cli/admin-bootstrap.js --method github --github-id 1`
 *      which was confirmed end-to-end in cycle 5 review.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import {
  openCliAuthStorage,
  resolveCliAuthStoragePostgresUrl,
} from '../../../src/cli/cliAuthStorage.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { FilesystemAuthStorageLayer } from '../../../src/auth/embedded-as/storage/FilesystemAuthStorageLayer.js';

describe('openCliAuthStorage', () => {
  const savedBackend = process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND;
  const savedAdminDbUrl = process.env.DOLLHOUSE_DATABASE_ADMIN_URL;
  const savedDbUrl = process.env.DOLLHOUSE_DATABASE_URL;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (savedBackend === undefined) delete process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND;
    else process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = savedBackend;
    if (savedAdminDbUrl === undefined) delete process.env.DOLLHOUSE_DATABASE_ADMIN_URL;
    else process.env.DOLLHOUSE_DATABASE_ADMIN_URL = savedAdminDbUrl;
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
    // Cycle 19 / B2: env-var resolution now happens at module load
    // through Zod (env.DOLLHOUSE_AUTH_STORAGE_BACKEND). Runtime
    // process.env mutation no longer reaches the call. Drive through
    // the explicit `backend` option (the test injection point).
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliAuthStorage-'));
    tmpDirs.push(tmpDir);
    const handle = await openCliAuthStorage({
      backend: 'filesystem',
      methods: ['local-password'],
      rootDir: tmpDir,
    });
    expect(handle.storage).toBeInstanceOf(FilesystemAuthStorageLayer);
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('postgres URL resolution: prefers admin URL over app URL', () => {
    expect(resolveCliAuthStoragePostgresUrl({
      DOLLHOUSE_DATABASE_ADMIN_URL: 'postgres://admin@example/db',
      DOLLHOUSE_DATABASE_URL: 'postgres://app@example/db',
    })).toBe('postgres://admin@example/db');
  });

  it('postgres URL resolution: falls back to app URL for simple installs', () => {
    expect(resolveCliAuthStoragePostgresUrl({
      DOLLHOUSE_DATABASE_URL: 'postgres://app@example/db',
    })).toBe('postgres://app@example/db');
  });

  it('postgres URL resolution: treats a blank admin URL as unavailable', () => {
    expect(resolveCliAuthStoragePostgresUrl({
      DOLLHOUSE_DATABASE_ADMIN_URL: '   ',
      DOLLHOUSE_DATABASE_URL: 'postgres://app@example/db',
    })).toBe('postgres://app@example/db');
  });

  it('postgres URL resolution: throws a clear error when no database URL is set', () => {
    expect(() => resolveCliAuthStoragePostgresUrl({})).toThrow(
      /DOLLHOUSE_DATABASE_ADMIN_URL.*DOLLHOUSE_DATABASE_URL/u,
    );
  });

  it('postgres backend: throws a clear error when no database URL is set', async () => {
    // Cycle 19 / B2: same env-routing pattern. Test the explicit
    // backend selection; the env-driven path is covered by integration
    // tests where the env is set in the test runner.
    delete process.env.DOLLHOUSE_DATABASE_URL;
    await expect(openCliAuthStorage({ backend: 'postgres', methods: ['github'] })).rejects.toThrow(
      /DOLLHOUSE_DATABASE_ADMIN_URL.*DOLLHOUSE_DATABASE_URL/u,
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
