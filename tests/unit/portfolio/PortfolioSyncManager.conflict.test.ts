import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PortfolioSyncManager } from '../../../src/portfolio/PortfolioSyncManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ContentValidator } from '../../../src/security/contentValidator.js';
import { createMockTokenManager } from '../../helpers/di-mocks.js';

const remoteContent = `---
name: Test Persona
version: 2.0.0
---
Remote body
`;

const localContent = `---
name: Test Persona
version: 1.0.0
---
Local body
`;

describe('PortfolioSyncManager conflict handling', () => {
  const config = {
    sync: {
      enabled: true,
      individual: { require_confirmation: true },
      bulk: {
        download_enabled: true,
        upload_enabled: true,
        require_preview: false
      },
      privacy: {
        scan_for_secrets: false
      }
    }
  };

  const baseDependencies = () => {
    const configManager = {
      getConfig: jest.fn().mockReturnValue(config)
    };

    const portfolioManager = {
      getElementPath: jest.fn().mockReturnValue(path.join(os.tmpdir(), 'test-persona.md'))
    };

    const repoManager = {
      setToken: jest.fn(),
      saveElement: jest.fn()
    };

    const indexer = {
      getIndex: jest.fn().mockResolvedValue({
        totalElements: 1,
        elements: new Map([
          [
            ElementType.PERSONA,
            [
              {
                name: 'Test Persona',
                type: ElementType.PERSONA,
                version: '2.0.0',
                downloadUrl: 'https://example.com/test-persona.md',
                lastModified: '2024-01-02T00:00:00.000Z',
                author: 'remote',
                size: 42
              }
            ]
          ]
        ])
      })
    };

    const fileOperations = {
      readFile: jest.fn(async (filePath: string) => {
        return await fs.readFile(filePath, 'utf-8');
      }),
      writeFile: jest.fn(async (filePath: string, content: string) => {
        await fs.writeFile(filePath, content, 'utf-8');
      }),
      createDirectory: jest.fn(async (dirPath: string) => {
        await fs.mkdir(dirPath, { recursive: true });
      }),
      exists: jest.fn(async (filePath: string) => {
        try {
          await fs.access(filePath);
          return true;
        } catch {
          return false;
        }
      })
    };

    return {
      configManager,
      portfolioManager,
      repoManager,
      indexer,
      fileOperations
    };
  };

  let tempDir: string;
  let localPath: string;
  let mockTokenManager: ReturnType<typeof createMockTokenManager>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-conflict-'));
    localPath = path.join(tempDir, 'Test Persona.md');
    await fs.writeFile(localPath, localContent, 'utf-8');

    mockTokenManager = createMockTokenManager();
    mockTokenManager.getGitHubTokenAsync.mockResolvedValue('token-123');
    jest.spyOn(ContentValidator, 'validateAndSanitize').mockReturnValue({
      isValid: true,
      sanitizedContent: remoteContent
    } as any);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(remoteContent)
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    delete (global as any).fetch;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns conflict metadata when download would overwrite local changes', async () => {
    const deps = baseDependencies();
    deps.portfolioManager.getElementPath.mockReturnValue(localPath);

    const manager = new PortfolioSyncManager({
      configManager: deps.configManager as any,
      portfolioManager: deps.portfolioManager as any,
      portfolioRepoManager: deps.repoManager as any,
      indexer: deps.indexer as any,
      fileOperations: deps.fileOperations as any,
      tokenManager: mockTokenManager as any
    });

    const result = await manager.handleSyncOperation({
      operation: 'download',
      element_name: 'Test Persona',
      element_type: ElementType.PERSONA
    });

    expect(result.success).toBe(false);
    expect(result.data?.requiresConfirmation).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts?.[0]).toMatchObject({
      element: 'Test Persona',
      type: ElementType.PERSONA,
      localVersion: '1.0.0',
      remoteVersion: '2.0.0'
    });
    const resultingContent = await fs.readFile(localPath, 'utf-8');
    expect(resultingContent).toBe(localContent);
  });

  it('bypasses conflict prompt when force flag is provided', async () => {
    const deps = baseDependencies();
    deps.portfolioManager.getElementPath.mockReturnValue(localPath);

    const manager = new PortfolioSyncManager({
      configManager: deps.configManager as any,
      portfolioManager: deps.portfolioManager as any,
      portfolioRepoManager: deps.repoManager as any,
      indexer: deps.indexer as any,
      fileOperations: deps.fileOperations as any,
      tokenManager: mockTokenManager as any
    });

    const result = await manager.handleSyncOperation({
      operation: 'download',
      element_name: 'Test Persona',
      element_type: ElementType.PERSONA,
      force: true
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Successfully downloaded');
    expect(result.conflicts).toBeUndefined();
    const resultingContent = await fs.readFile(localPath, 'utf-8');
    expect(resultingContent).toBe(remoteContent);
  });
});
