import { describe, it, expect, jest } from '@jest/globals';
import * as path from 'node:path';

import { FileTokenStore } from '../../../src/security/tokenStores/FileTokenStore.js';
import { EnvVarMasterKeyProvider } from '../../../src/security/keys/EnvVarMasterKeyProvider.js';

function createMockFileOperationsService() {
  return {
    readFile: jest.fn().mockResolvedValue(''),
    readElementFile: jest.fn().mockResolvedValue(''),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    listDirectory: jest.fn().mockResolvedValue([]),
    listDirectoryWithTypes: jest.fn().mockResolvedValue([]),
    renameFile: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    stat: jest.fn().mockResolvedValue({} as any),
    resolvePath: jest.fn().mockReturnValue(''),
    validatePath: jest.fn().mockReturnValue(true),
    createFileExclusive: jest.fn().mockResolvedValue(true),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    appendFile: jest.fn().mockResolvedValue(undefined),
  };
}

describe('FileTokenStore', () => {
  it('does not capture a path-like string at construction', () => {
    const store = new FileTokenStore(createMockFileOperationsService() as any, {
      getUserAuthDir: (userId?: string) => `/tmp/auth/${userId}`,
    });

    const stringFields = Object.values(store as unknown as Record<string, unknown>)
      .filter((value): value is string => typeof value === 'string');

    expect(stringFields).toEqual([]);
  });

  it('resolves the user auth directory per call for two users', async () => {
    const fileOps = createMockFileOperationsService();
    const store = new FileTokenStore(fileOps as any, {
      getUserAuthDir: (userId?: string) => `/tmp/dollhouse-test/${userId}/auth`,
    });

    await store.storeToken('alice', 'ghp_ALICETOKEN000000000000000000000000000001');
    await store.storeToken('bob', 'ghp_BOBTOKEN00000000000000000000000000000002');

    expect(fileOps.writeFile).toHaveBeenNthCalledWith(
      1,
      path.join('/tmp/dollhouse-test/alice/auth', 'github_token.enc'), // NOSONAR — assertion arg against mocked writeFile; never touches disk
      expect.any(String),
      expect.any(Object),
    );
    expect(fileOps.writeFile).toHaveBeenNthCalledWith(
      2,
      path.join('/tmp/dollhouse-test/bob/auth', 'github_token.enc'), // NOSONAR — assertion arg against mocked writeFile; never touches disk
      expect.any(String),
      expect.any(Object),
    );
  });
});

describe('EnvVarMasterKeyProvider', () => {
  it('accepts a base64 32-byte key and returns a defensive copy', async () => {
    const encoded = Buffer.alloc(32, 7).toString('base64');
    const provider = new EnvVarMasterKeyProvider(encoded, 3);

    const first = await provider.getCurrentKey();
    first.key.fill(0);
    const second = await provider.getKey(3);

    expect(second.version).toBe(3);
    expect(second.key.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('fails loud for missing or invalid keys', () => {
    expect(() => new EnvVarMasterKeyProvider(undefined)).toThrow(/DOLLHOUSE_MASTER_ENCRYPTION_KEY/);
    expect(() => new EnvVarMasterKeyProvider(Buffer.alloc(31).toString('base64'))).toThrow(/32 bytes/);
  });
});

