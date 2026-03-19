import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PortfolioSyncManager } from '../../../src/portfolio/PortfolioSyncManager.js';
import { ElementType } from '../../../src/portfolio/types.js';

const baseConfig = {
  sync: {
    enabled: true,
    individual: {
      require_confirmation: true
    },
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

const createDependencies = () => {
  const configManager = {
    getConfig: jest.fn().mockReturnValue(baseConfig)
  };

  const portfolioManager = {
    getElementPath: jest.fn(),
    getElementDir: jest.fn()
  };

  const repoManager = {
    setToken: jest.fn()
  };

  const indexer = {
    getIndex: jest.fn()
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
    }),
    listDirectory: jest.fn(async (dirPath: string) => {
      return await fs.readdir(dirPath);
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

describe('PortfolioSyncManager bulk operations', () => {
  let deps: ReturnType<typeof createDependencies>;

  beforeEach(() => {
    deps = createDependencies();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bulkDownload reports downloaded/skipped/failed elements when mixed outcomes occur', async () => {
    const manager = new PortfolioSyncManager({
      configManager: deps.configManager as any,
      portfolioManager: deps.portfolioManager as any,
      portfolioRepoManager: deps.repoManager as any,
      indexer: deps.indexer as any,
      fileOperations: deps.fileOperations as any
    });

    jest.spyOn(manager as any, 'listRemoteElements').mockResolvedValue({
      success: true,
      elements: [
        { name: 'Alpha', type: ElementType.PERSONA },
        { name: 'Beta', type: ElementType.PERSONA },
        { name: 'Gamma', type: ElementType.PERSONA }
      ]
    });

    jest
      .spyOn(manager as any, 'downloadElement')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, message: 'Element is already up to date' })
      .mockRejectedValueOnce(new Error('Network boom'));

    const result = await (manager as any).bulkDownload(ElementType.PERSONA, true);

    expect(result.success).toBe(false);
    expect(result.data).toBeDefined();
    expect(result.data.downloaded).toEqual(['Alpha']);
    expect(result.data.skipped).toEqual(['Beta']);
    expect(result.data.failed).toEqual([{ name: 'Gamma', error: 'Network boom' }]);
    expect(result.message).toContain('Downloaded: 1');
    expect(result.message).toContain('Failed: 1');
  });

  it('bulkUpload tracks uploaded, skipped, and failed elements during partial failure', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portfolio-bulk-upload-'));
    const filenames = ['Alpha.md', 'Beta.md', 'Gamma.md'];
    await Promise.all(
      filenames.map(file =>
        fs.writeFile(path.join(tempDir, file), `---\nname: ${file}\n---\ncontent`)
      )
    );

    deps.portfolioManager.getElementDir = jest.fn().mockReturnValue(tempDir);
    const manager = new PortfolioSyncManager({
      configManager: deps.configManager as any,
      portfolioManager: deps.portfolioManager as any,
      portfolioRepoManager: deps.repoManager as any,
      indexer: deps.indexer as any,
      fileOperations: deps.fileOperations as any
    });

    jest
      .spyOn(manager as any, 'uploadElement')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: false,
        message: `Element 'Beta' is marked as local-only and cannot be uploaded`
      })
      .mockRejectedValueOnce(new Error('Repository missing'));

    try {
      const result = await (manager as any).bulkUpload(ElementType.PERSONA, true);

      expect(result.success).toBe(false);
      expect(result.data.uploaded).toEqual(['Alpha']);
      expect(result.data.skipped).toEqual(['Beta']);
      expect(result.data.failed).toEqual([{ name: 'Gamma', error: 'Repository missing' }]);
      expect(result.message).toContain('Uploaded: 1');
      expect(result.message).toContain('Failed: 1');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
