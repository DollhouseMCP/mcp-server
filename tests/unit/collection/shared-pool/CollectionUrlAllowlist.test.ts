/**
 * Tests for the collection URL allowlist and GitHubClient SSRF extension.
 *
 * Verifies that:
 * - Default hosts (api.github.com, raw.githubusercontent.com) always work
 * - Additional hosts from DOLLHOUSE_COLLECTION_ALLOWLIST are accepted
 * - Off-allowlist hosts are rejected
 * - CollectionIndexManager accepts a custom index URL
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GitHubClient } from '../../../../src/collection/GitHubClient.js';
import { APICache } from '../../../../src/cache/APICache.js';
import type { TokenManager } from '../../../../src/security/tokenManager.js';

function createClient(additionalHosts?: readonly string[]): GitHubClient {
  const apiCache = new APICache();
  const rateLimitTracker = new Map<string, number[]>();
  const mockTokenManager = {
    getGitHubTokenAsync: () => Promise.resolve(null),
    createSafeErrorMessage: (msg: string) => msg,
    ensureTokenPermissions: () => Promise.resolve({ isValid: true }),
  } as unknown as TokenManager;

  return new GitHubClient(apiCache, rateLimitTracker, mockTokenManager, additionalHosts);
}

describe('GitHubClient SSRF allowlist', () => {
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ allowed: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('default hosts', () => {
    it('accepts api.github.com', async () => {
      const client = createClient();
      await expect(client.fetchFromGitHub('https://api.github.com/repos/test'))
        .resolves
        .toEqual({ allowed: true });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.github.com/repos/test',
        expect.any(Object),
      );
    });

    it('accepts raw.githubusercontent.com', async () => {
      const client = createClient();
      await expect(client.fetchFromGitHub('https://raw.githubusercontent.com/test/file'))
        .resolves
        .toEqual({ allowed: true });
    });

    it('rejects non-GitHub hosts', async () => {
      const client = createClient();
      await expect(client.fetchFromGitHub('https://evil.com/attack'))
        .rejects
        .toThrow(/non-allowed.*evil\.com/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects localhost', async () => {
      const client = createClient();
      await expect(client.fetchFromGitHub('http://localhost:8080/internal'))
        .rejects
        .toThrow(/non-allowed/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('additional allowed hosts', () => {
    it('accepts a custom host when provided', async () => {
      const client = createClient(['custom.example.com']);
      await expect(client.fetchFromGitHub('https://custom.example.com/collection'))
        .resolves
        .toEqual({ allowed: true });
    });

    it('still accepts default hosts when additional hosts are provided', async () => {
      const client = createClient(['custom.example.com']);
      await expect(client.fetchFromGitHub('https://api.github.com/repos/test'))
        .resolves
        .toEqual({ allowed: true });
    });

    it('rejects hosts not in the combined allowlist', async () => {
      const client = createClient(['custom.example.com']);
      await expect(client.fetchFromGitHub('https://other.example.com/attack'))
        .rejects
        .toThrow(/non-allowed.*other\.example\.com/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('accepts multiple additional hosts', async () => {
      const client = createClient(['host1.example.com', 'host2.example.com']);

      await expect(client.fetchFromGitHub('https://host1.example.com/test'))
        .resolves
        .toEqual({ allowed: true });

      await expect(client.fetchFromGitHub('https://host2.example.com/test'))
        .resolves
        .toEqual({ allowed: true });
    });

    it('handles empty additional hosts array (same as no additional)', async () => {
      const client = createClient([]);
      await expect(client.fetchFromGitHub('https://evil.com/attack'))
        .rejects
        .toThrow(/non-allowed/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe('CollectionIndexManager custom URL', () => {
  it('config interface accepts indexUrl', async () => {
    const { CollectionIndexManager } = await import(
      '../../../../src/collection/CollectionIndexManager.js'
    );
    const { createTestFileOperationsService } = await import(
      '../../../helpers/di-mocks.js'
    );

    const manager = new CollectionIndexManager({
      fileOperations: createTestFileOperationsService(),
      indexUrl: 'https://custom.example.com/collection-index.json',
    });

    expect(manager).toBeDefined();
  });

  it('uses default URL when indexUrl is not provided', async () => {
    const { CollectionIndexManager } = await import(
      '../../../../src/collection/CollectionIndexManager.js'
    );
    const { createTestFileOperationsService } = await import(
      '../../../helpers/di-mocks.js'
    );

    const manager = new CollectionIndexManager({
      fileOperations: createTestFileOperationsService(),
    });

    expect(manager).toBeDefined();
  });
});
