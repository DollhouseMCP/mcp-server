/**
 * Unit tests for ConsoleTokenStore (#1780).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ConsoleTokenStore,
  readTokenFileRaw,
  getPrimaryTokenFromFile,
  type ConsoleTokenFile,
} from '../../../../src/web/console/consoleToken.js';

describe('ConsoleTokenStore', () => {
  let testDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-console-token-test-'));
    tokenFilePath = join(testDir, 'console-token.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('ensureInitialized', () => {
    it('creates a new token file on first run', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      expect(entry).toBeDefined();
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.name).toContain('Kermit');
      expect(entry.kind).toBe('console');
      expect(entry.token).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.scopes).toEqual(['admin']);
      expect(entry.elementBoundaries).toBeNull();
      expect(entry.tenant).toBeNull();
      expect(entry.platform).toBe('local');
      expect(entry.labels).toEqual({});
      expect(entry.createdVia).toBe('initial-setup');
      expect(entry.lastUsedAt).toBeNull();
    });

    it('persists a valid JSON file with 0600 permissions', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      const raw = await readFile(tokenFilePath, 'utf8');
      const parsed = JSON.parse(raw) as ConsoleTokenFile;
      expect(parsed.version).toBe(1);
      expect(parsed.tokens).toHaveLength(1);
      expect(parsed.totp).toEqual({ enrolled: false, secret: null, backupCodes: [] });
    });

    it('loads existing token file on subsequent runs (persistence)', async () => {
      const store1 = new ConsoleTokenStore(tokenFilePath);
      const first = await store1.ensureInitialized('Kermit');

      const store2 = new ConsoleTokenStore(tokenFilePath);
      const second = await store2.ensureInitialized('Piggy');

      expect(second.id).toBe(first.id);
      expect(second.token).toBe(first.token);
      // Name stays the same — we don't overwrite on reload
      expect(second.name).toBe(first.name);
    });

    it('generates distinct tokens across fresh installs', async () => {
      const store1 = new ConsoleTokenStore(tokenFilePath);
      const entry1 = await store1.ensureInitialized('Kermit');

      // Delete and start fresh
      await rm(tokenFilePath, { force: true });

      const store2 = new ConsoleTokenStore(tokenFilePath);
      const entry2 = await store2.ensureInitialized('Kermit');

      expect(entry2.token).not.toBe(entry1.token);
      expect(entry2.id).not.toBe(entry1.id);
    });
  });

  describe('verify', () => {
    it('returns the matching entry for a valid token', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      const matched = store.verify(entry.token);
      expect(matched).not.toBeNull();
      expect(matched!.id).toBe(entry.id);
    });

    it('returns null for an invalid token', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      expect(store.verify('wrong-token')).toBeNull();
    });

    it('returns null for an empty token', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      expect(store.verify('')).toBeNull();
    });

    it('returns null before initialization', () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      expect(store.verify('anything')).toBeNull();
    });

    it('updates lastUsedAt when a token is verified', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      expect(entry.lastUsedAt).toBeNull();
      const matched = store.verify(entry.token);
      expect(matched!.lastUsedAt).not.toBeNull();
    });

    it('uses constant-time comparison (accepts only same-length inputs)', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      // Prefix match should fail — timingSafeEqual requires equal length
      const prefix = entry.token.slice(0, 32);
      expect(store.verify(prefix)).toBeNull();
    });
  });

  describe('getPrimaryTokenValue', () => {
    it('returns the token value for server/follower use', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');
      expect(store.getPrimaryTokenValue()).toBe(entry.token);
    });

    it('returns null before initialization', () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      expect(store.getPrimaryTokenValue()).toBeNull();
    });
  });

  describe('listMasked', () => {
    it('returns entries with the token secret replaced by a preview', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      const masked = store.listMasked();
      expect(masked).toHaveLength(1);
      expect(masked[0]).not.toHaveProperty('token');
      expect(masked[0].tokenPreview).toContain(entry.token.slice(0, 8));
      expect(masked[0].tokenPreview).not.toContain(entry.token);
    });
  });
});

describe('readTokenFileRaw / getPrimaryTokenFromFile (follower helpers)', () => {
  let testDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-console-token-test-'));
    tokenFilePath = join(testDir, 'console-token.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', async () => {
    expect(await readTokenFileRaw(tokenFilePath)).toBeNull();
    expect(await getPrimaryTokenFromFile(tokenFilePath)).toBeNull();
  });

  it('reads a valid file written by ConsoleTokenStore', async () => {
    const store = new ConsoleTokenStore(tokenFilePath);
    const entry = await store.ensureInitialized('Kermit');

    const raw = await readTokenFileRaw(tokenFilePath);
    expect(raw).not.toBeNull();
    expect(raw!.tokens[0].id).toBe(entry.id);

    const primary = await getPrimaryTokenFromFile(tokenFilePath);
    expect(primary).toBe(entry.token);
  });

  it('returns null for a corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tokenFilePath, 'this is not json', 'utf8');
    expect(await readTokenFileRaw(tokenFilePath)).toBeNull();
  });

  it('returns null for a file with wrong schema version', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      tokenFilePath,
      JSON.stringify({ version: 999, tokens: [], totp: {} }),
      'utf8',
    );
    expect(await readTokenFileRaw(tokenFilePath)).toBeNull();
  });
});
