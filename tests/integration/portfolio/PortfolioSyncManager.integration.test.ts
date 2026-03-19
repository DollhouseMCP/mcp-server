import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { PortfolioSyncManager } from '../../../src/portfolio/PortfolioSyncManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import type { PortfolioRepoManager } from '../../../src/portfolio/PortfolioRepoManager.js';
import type { GitHubPortfolioIndexer, GitHubIndexEntry } from '../../../src/portfolio/GitHubPortfolioIndexer.js';
import type { DollhouseConfig } from '../../../src/config/ConfigManager.js';
import { createMockTokenManager, createMockFileOperationsService } from '../../helpers/di-mocks.js';

const defaultConfig: DollhouseConfig = {
  sync: {
    enabled: true,
    individual: {
      require_confirmation: true
    },
    bulk: {
      download_enabled: true,
      upload_enabled: true,
      require_preview: true
    },
    privacy: {
      scan_for_secrets: false
    }
  }
} as unknown as DollhouseConfig;

function createMockConfigManager(overrides?: Partial<DollhouseConfig>) {
  const config = { ...defaultConfig, ...overrides };
  return {
    getConfig: jest.fn().mockReturnValue(config)
  };
}

function createMockPortfolioManager(tempDir: string) {
  const getElementPath = (type: ElementType, filename: string) =>
    `${tempDir}/${type}/${filename}`;

  return {
    getElementPath: jest.fn(getElementPath),
    getElementDir: jest.fn((type: ElementType) => `${tempDir}/${type}`),
    saveElement: jest.fn(),
    initialize: jest.fn()
  } as unknown as PortfolioManager;
}

function createMockRepoManager() {
  return {
    setToken: jest.fn(),
    saveElement: jest.fn().mockResolvedValue('https://github.com/mock/repo')
  } as unknown as PortfolioRepoManager;
}

function createMockIndexer(entries: Map<ElementType, GitHubIndexEntry[]>) {
  return {
    getIndex: jest.fn().mockResolvedValue({
      totalElements: Array.from(entries.values()).reduce((sum, arr) => sum + arr.length, 0),
      elements: entries
    })
  } as unknown as GitHubPortfolioIndexer;
}

describe('PortfolioSyncManager Integration', () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portfolio-sync-test-'));
    for (const type of Object.values(ElementType)) {
      await fs.mkdir(path.join(tempDir, type), { recursive: true }).catch(() => {});
    }
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as Partial<typeof globalThis>).fetch;
    }
  });

  function createManager(options: {
    configOverride?: Partial<DollhouseConfig>;
    entries?: Map<ElementType, GitHubIndexEntry[]>;
  }) {
    const configManager = createMockConfigManager(options.configOverride);
    const portfolioManager = createMockPortfolioManager(tempDir);
    const repoManager = createMockRepoManager();
    const indexer = createMockIndexer(
      options.entries ??
        new Map([
          [
            ElementType.PERSONA,
            [
              {
                name: 'Test Persona',
                type: ElementType.PERSONA,
                version: '1.0.0',
                downloadUrl: 'https://example.com/test-persona.md',
                lastModified: new Date().toISOString(),
                author: 'tester',
                size: 10
              } as GitHubIndexEntry
            ]
          ]
        ])
    );

    // Mock fetch for remote content
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn().mockResolvedValue('---\nname: Test Persona\n---\nContent')
    });

    // Create mock dependencies
    const fileOperations = createMockFileOperationsService({
      readFile: jest.fn().mockImplementation(async (filePath: string) => {
        return fs.readFile(filePath, 'utf-8');
      }),
      writeFile: jest.fn().mockImplementation(async (filePath: string, content: string) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
      }),
      exists: jest.fn().mockImplementation(async (filePath: string) => {
        try {
          await fs.access(filePath);
          return true;
        } catch {
          return false;
        }
      }),
      deleteFile: jest.fn().mockResolvedValue(undefined)
    });

    const tokenManager = createMockTokenManager({
      getGitHubTokenAsync: jest.fn().mockResolvedValue('test-token')
    });

    return {
      manager: new PortfolioSyncManager({
        configManager: configManager as any,
        portfolioManager,
        portfolioRepoManager: repoManager,
        indexer,
        fileOperations: fileOperations as any,
        tokenManager: tokenManager as any
      }),
      portfolioManager,
      repoManager,
      configManager,
      indexer,
      fileOperations,
      tokenManager
    };
  }

  describe('handleSyncOperation - guard rails', () => {
    it('blocks operations when sync disabled', async () => {
      const { manager } = createManager({
        configOverride: { sync: { ...defaultConfig.sync, enabled: false } }
      });

      const result = await manager.handleSyncOperation({
        operation: 'download',
        element_name: 'Test Persona',
        element_type: ElementType.PERSONA
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Sync is disabled');
    });

    it('enforces bulk permission flags', async () => {
      const { manager } = createManager({
        configOverride: {
          sync: {
            ...defaultConfig.sync,
            bulk: { ...defaultConfig.sync.bulk, download_enabled: false }
          }
        }
      });

      const result = await manager.handleSyncOperation({
        operation: 'download',
        bulk: true
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Bulk download is disabled');
    });
  });

  describe('download workflow', () => {
    it('requires confirmation when local version differs and force not set', async () => {
      const { manager, portfolioManager } = createManager({});
      const localPath = portfolioManager.getElementPath(ElementType.PERSONA, 'Test Persona.md');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '---\nname: Test Persona\n---\nOld Content');

      const result = await manager.handleSyncOperation({
        operation: 'download',
        element_name: 'Test Persona',
        element_type: ElementType.PERSONA
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Local version exists');
      expect(result.data?.requiresConfirmation).toBe(true);
    });

    it('downloads and overwrites when force flag set', async () => {
      const { manager, portfolioManager } = createManager({});
      const localPath = portfolioManager.getElementPath(ElementType.PERSONA, 'Test Persona.md');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '---\nname: Test Persona\n---\nOld Content');

      const result = await manager.handleSyncOperation({
        operation: 'download',
        element_name: 'Test Persona',
        element_type: ElementType.PERSONA,
        force: true
      });

      expect(result.success).toBe(true);
      const newContent = await fs.readFile(localPath, 'utf-8');
      expect(newContent).toContain('Content');
    });
  });

  describe('upload workflow', () => {
    it('rejects local-only elements', async () => {
      const { manager, portfolioManager } = createManager({});
      const localPath = portfolioManager.getElementPath(ElementType.PERSONA, 'Private Persona.md');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(
        localPath,
        '---\nname: Private Persona\nprivacy:\n  local_only: true\n---\nContent'
      );

      const result = await manager.handleSyncOperation({
        operation: 'upload',
        element_name: 'Private Persona',
        element_type: ElementType.PERSONA,
        confirm: true
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('local-only');
    });

    it('uploads when confirmed and passes validation', async () => {
      const { manager, portfolioManager, repoManager } = createManager({});
      const localPath = portfolioManager.getElementPath(ElementType.PERSONA, 'Public Persona.md');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '---\nname: Public Persona\n---\nReady');

      const result = await manager.handleSyncOperation({
        operation: 'upload',
        element_name: 'Public Persona',
        element_type: ElementType.PERSONA,
        confirm: true
      });

      expect(result.success).toBe(true);
      expect(repoManager.saveElement).toHaveBeenCalled();
    });
  });

  describe('bulk operations', () => {
    it('requires confirmation when preview is enabled', async () => {
      const { manager } = createManager({});

      const result = await manager.handleSyncOperation({
        operation: 'download',
        bulk: true
      });

      expect(result.success).toBe(false);
      expect(result.data?.requiresConfirmation).toBe(true);
      expect(result.elements?.length).toBeGreaterThan(0);
    });

    it('performs bulk download when confirmed', async () => {
      const { manager } = createManager({});

      const result = await manager.handleSyncOperation({
        operation: 'download',
        bulk: true,
        confirm: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.downloaded.length).toBeGreaterThan(0);
    });
  });
});
