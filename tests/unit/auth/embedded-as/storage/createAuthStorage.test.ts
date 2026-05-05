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

    it('env var picks the backend when no explicit option', async () => {
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-fs-env-'));
      process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = 'filesystem';
      const storage = await createAuthStorage({ rootDir: tmpRoot });
      expect(storage).toBeInstanceOf(FilesystemAuthStorageLayer);
    });

    it('defaults to memory in NODE_ENV=test', async () => {
      // jest sets NODE_ENV=test by default; this is the test-environment default.
      delete process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND;
      const storage = await createAuthStorage();
      expect(storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    });

    it('rejects invalid env values with a clear error', async () => {
      process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND = 'sqlite-but-not-yet';
      await expect(createAuthStorage()).rejects.toThrow(/must be one of memory\|filesystem\|postgres/);
    });

    it('postgres backend without database injection throws actionable error', async () => {
      await expect(createAuthStorage({ backend: 'postgres' })).rejects.toThrow(
        /PostgresAuthStorageLayer requires a Drizzle database instance/,
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

    it('DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true env var bypasses the guard', async () => {
      process.env.DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE = 'true';
      const storage = await createAuthStorage({
        backend: 'memory',
        methods: ['local-password'],
      });
      expect(storage).toBeInstanceOf(InMemoryAuthStorageLayer);
    });
  });

  describe('DURABLE_AUTH_METHODS', () => {
    it('contains exactly the methods whose state must survive restart', () => {
      expect([...DURABLE_AUTH_METHODS].sort()).toEqual(['local-password', 'magic-link']);
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
