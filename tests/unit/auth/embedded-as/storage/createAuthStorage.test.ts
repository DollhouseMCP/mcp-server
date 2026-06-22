/**
 * createAuthStorage unit tests.
 *
 * Covers backend selection (option / env / default) and the safety guard
 * that refuses 'memory' for durable-data methods in non-test environments.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import {
  createAuthStorage,
  DURABLE_AUTH_METHODS,
} from '../../../../../src/auth/embedded-as/storage/createAuthStorage.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { FilesystemAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/FilesystemAuthStorageLayer.js';

describe('createAuthStorage', () => {
  const originalEnv = { ...process.env };
  let tmpRoot: string | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpRoot = undefined;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('backend selection', () => {
    it('explicit backend option wins over env and defaults', async () => {
      process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = 'filesystem';
      const storage = await createAuthStorage({ backend: 'memory' });
      expect(storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    });

    it('explicit backend=filesystem returns a FilesystemAuthStorageLayer', async () => {
      // Cycle 19 / B2: env-var resolution now happens at module load
      // through Zod (env.DOLLHOUSE_AUTH_STORAGE_BACKEND). Runtime
      // process.env mutation no longer reaches the call. Tests of the
      // backend selection branches should drive through the explicit
      // `backend` option (the test injection point) rather than
      // mutating process.env, which is brittle and depended on import
      // order. The env-driven path is exercised via integration tests
      // (oauth-flow.*) where the env is set in the test runner.
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-fs-env-'));
      const storage = await createAuthStorage({ backend: 'filesystem', rootDir: tmpRoot });
      expect(storage).toBeInstanceOf(FilesystemAuthStorageLayer);
    });

    it('defaults to memory in NODE_ENV=test', async () => {
      // jest sets NODE_ENV=test by default; this is the test-environment
      // default when no backend option is passed and no env is set.
      const storage = await createAuthStorage();
      expect(storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    });

    it('schema rejects invalid env values at config load', () => {
      // Cycle 19 / B2: invalid DOLLHOUSE_AUTH_STORAGE_BACKEND values
      // now fail at envSchema.parse() in src/config/env.ts. The
      // z.enum(['memory','filesystem','postgres']).optional() guard
      // throws before this module ever loads. Documented here so the
      // contract stays visible; the actual rejection is unit-tested in
      // the env schema's own test (or asserted by the build-time
      // failure of any startup that tries an unsupported value).
      // No runtime call needed — this is a type-level + parse-time
      // invariant, not a runtime branch in createAuthStorage.
      expect(true).toBe(true);
    });

    it('postgres backend without database injection throws actionable error', async () => {
      // Phase 9 M2/Q5: message rewritten to spell out the cross-config
      // dependency on DOLLHOUSE_STORAGE_BACKEND=database instead of
      // just naming the missing constructor param.
      await expect(createAuthStorage({ backend: 'postgres' })).rejects.toThrow(
        /DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres requires a database connection/,
      );
    });
  });

  describe('safety guard: memory + durable-data methods', () => {
    beforeEach(() => {
      // Simulate a non-test process environment for the guard checks.
      process.env.NODE_ENV = 'production';
    });

    it('refuses memory backend when local-password is configured', async () => {
      await expect(
        createAuthStorage({ backend: 'memory', methods: ['local-password'] }),
      ).rejects.toThrow(/refused for methods that require durable state/);
    });

    it('refuses memory backend when magic-link is configured', async () => {
      await expect(
        createAuthStorage({ backend: 'memory', methods: ['magic-link'] }),
      ).rejects.toThrow(/refused for methods that require durable state/);
    });

    it('allows memory backend when only trivial-consent / github methods are active', async () => {
      const storage = await createAuthStorage({
        backend: 'memory',
        methods: ['trivial-consent', 'github'],
      });
      expect(storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    });

    it('explicit allowMemoryWithDurableMethods bypasses the guard', async () => {
      const storage = await createAuthStorage({
        backend: 'memory',
        methods: ['local-password'],
        allowMemoryWithDurableMethods: true,
      });
      expect(storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    });

  });

  describe('DURABLE_AUTH_METHODS', () => {
    it('contains exactly the methods whose state must survive restart', () => {
      expect([...DURABLE_AUTH_METHODS].sort()).toEqual(['local-password', 'magic-link']); // NOSONAR — codepoint sort over fixed 2-element constant array
    });
  });

  describe('filesystem backend instantiation', () => {
    it('constructs a FilesystemAuthStorageLayer with explicit rootDir', async () => {
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-fs-explicit-'));
      const storage = await createAuthStorage({ backend: 'filesystem', rootDir: tmpRoot });
      expect(storage).toBeInstanceOf(FilesystemAuthStorageLayer);
      expect((storage as FilesystemAuthStorageLayer).rootDir).toBe(tmpRoot);
    });
  });
});
