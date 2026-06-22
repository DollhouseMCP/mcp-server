/**
 * Tests for ElementInstaller shared-pool integration.
 *
 * Verifies that installContent() routes through SharedPoolInstaller
 * when one is injected, and falls back to the existing per-user
 * write path when not.
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import { ElementInstaller } from '../../../../src/collection/ElementInstaller.js';
import type { ISharedPoolInstaller } from '../../../../src/collection/shared-pool/ISharedPoolInstaller.js';
import type { SharedPoolInstallRequest, ProvenanceRecord } from '../../../../src/collection/shared-pool/types.js';
import type { GitHubClient } from '../../../../src/collection/GitHubClient.js';
import type { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import type { UnifiedIndexManager } from '../../../../src/portfolio/UnifiedIndexManager.js';
import type { IFileOperationsService } from '../../../../src/services/FileOperationsService.js';

function makeProvenance(overrides?: Partial<ProvenanceRecord>): ProvenanceRecord {
  return {
    elementId: 'test-id',
    origin: 'collection',
    sourceUrl: 'github://DollhouseMCP/collection/library/personas/test.md',
    sourceVersion: 'v1.0.0',
    contentHash: 'a'.repeat(64),
    forkedFrom: null,
    installedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockGitHubClient(): GitHubClient {
  return {
    fetchFromGitHub: jest.fn<GitHubClient['fetchFromGitHub']>().mockResolvedValue({
      type: 'file',
      size: 100,
      content: Buffer.from(
        '---\nname: test-persona\ndescription: A test persona\nversion: 1.0.0\n---\nYou are a test persona.'
      ).toString('base64'),
    }),
    validateCollectionPermissions: jest.fn(),
  } as unknown as GitHubClient;
}

function createMockPortfolioManager(): PortfolioManager {
  return {
    getElementDir: jest.fn().mockReturnValue(path.join(os.tmpdir(), 'test-portfolio', 'personas')),
    listElements: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(true),
    initialize: jest.fn().mockResolvedValue(undefined),
  } as unknown as PortfolioManager;
}

function createMockUnifiedIndexManager(): UnifiedIndexManager {
  return {} as unknown as UnifiedIndexManager;
}

function createMockFileOps(): IFileOperationsService {
  return {
    writeFile: jest.fn().mockResolvedValue(undefined),
    renameFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue(''),
    exists: jest.fn().mockResolvedValue(false),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    createFileExclusive: jest.fn().mockResolvedValue(true),
  } as unknown as IFileOperationsService;
}

describe('ElementInstaller shared-pool integration', () => {
  describe('when sharedPoolInstaller is provided', () => {
    it('routes installContent through shared pool installer', async () => {
      const mockInstaller: ISharedPoolInstaller = {
        install: jest.fn<ISharedPoolInstaller['install']>().mockResolvedValue({
          action: 'installed',
          elementId: 'new-shared-id',
          provenance: makeProvenance(),
        }),
      };

      const installer = new ElementInstaller(createMockGitHubClient(), {
        portfolioManager: createMockPortfolioManager(),
        unifiedIndexManager: createMockUnifiedIndexManager(),
        fileOperations: createMockFileOps(),
        sharedPoolInstaller: mockInstaller,
      });

      const result = await installer.installContent('library/personas/guides/test-persona.md');

      expect(result.success).toBe(true);
      expect(result.message).toContain('shared pool');
      expect(mockInstaller.install).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'collection',
          name: 'test-persona',
          elementType: 'personas',
          sourceUrl: expect.stringContaining('library/personas/guides/test-persona.md'),
        }),
      );
    });

    it('returns alreadyExists when installer skips', async () => {
      const mockInstaller: ISharedPoolInstaller = {
        install: jest.fn<ISharedPoolInstaller['install']>().mockResolvedValue({
          action: 'skipped',
          elementId: 'existing-id',
          provenance: makeProvenance(),
          reason: 'Identical content already exists in the shared pool',
        }),
      };

      const installer = new ElementInstaller(createMockGitHubClient(), {
        portfolioManager: createMockPortfolioManager(),
        unifiedIndexManager: createMockUnifiedIndexManager(),
        fileOperations: createMockFileOps(),
        sharedPoolInstaller: mockInstaller,
      });

      const result = await installer.installContent('library/personas/guides/test-persona.md');

      expect(result.success).toBe(true);
      expect(result.alreadyExists).toBe(true);
    });

    it('returns failure when installer rejects', async () => {
      const mockInstaller: ISharedPoolInstaller = {
        install: jest.fn<ISharedPoolInstaller['install']>().mockResolvedValue({
          action: 'rejected',
          elementId: 'existing-id',
          provenance: makeProvenance(),
          reason: 'Content hash mismatch',
        }),
      };

      const installer = new ElementInstaller(createMockGitHubClient(), {
        portfolioManager: createMockPortfolioManager(),
        unifiedIndexManager: createMockUnifiedIndexManager(),
        fileOperations: createMockFileOps(),
        sharedPoolInstaller: mockInstaller,
      });

      const result = await installer.installContent('library/personas/guides/test-persona.md');

      expect(result.success).toBe(false);
      expect(result.message).toContain('hash mismatch');
    });

    it('passes sanitized content to the shared pool installer', async () => {
      let capturedRequest: SharedPoolInstallRequest | undefined;
      const mockInstaller: ISharedPoolInstaller = {
        install: jest.fn<ISharedPoolInstaller['install']>().mockImplementation(async (req) => {
          capturedRequest = req;
          return {
            action: 'installed',
            elementId: 'new-id',
            provenance: makeProvenance(),
          };
        }),
      };

      const installer = new ElementInstaller(createMockGitHubClient(), {
        portfolioManager: createMockPortfolioManager(),
        unifiedIndexManager: createMockUnifiedIndexManager(),
        fileOperations: createMockFileOps(),
        sharedPoolInstaller: mockInstaller,
      });

      await installer.installContent('library/personas/guides/test-persona.md');

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest!.content).toContain('name: test-persona');
      expect(capturedRequest!.content).toContain('You are a test persona');
    });

    it('includes version from metadata in sourceVersion', async () => {
      let capturedRequest: SharedPoolInstallRequest | undefined;
      const mockInstaller: ISharedPoolInstaller = {
        install: jest.fn<ISharedPoolInstaller['install']>().mockImplementation(async (req) => {
          capturedRequest = req;
          return {
            action: 'installed',
            elementId: 'new-id',
            provenance: makeProvenance(),
          };
        }),
      };

      const installer = new ElementInstaller(createMockGitHubClient(), {
        portfolioManager: createMockPortfolioManager(),
        unifiedIndexManager: createMockUnifiedIndexManager(),
        fileOperations: createMockFileOps(),
        sharedPoolInstaller: mockInstaller,
      });

      await installer.installContent('library/personas/guides/test-persona.md');

      expect(capturedRequest!.sourceVersion).toBe('1.0.0');
    });
  });

  describe('when sharedPoolInstaller is NOT provided', () => {
    it('falls back to existing per-user install path', async () => {
      const mockFileOps = createMockFileOps();

      const installer = new ElementInstaller(createMockGitHubClient(), {
        portfolioManager: createMockPortfolioManager(),
        unifiedIndexManager: createMockUnifiedIndexManager(),
        fileOperations: mockFileOps,
      });

      const result = await installer.installContent('library/personas/guides/test-persona.md');

      expect(result.success).toBe(true);
      expect(mockFileOps.writeFile).toHaveBeenCalled();
    });
  });
});
