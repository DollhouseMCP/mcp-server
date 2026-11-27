import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import type { PortfolioHandler as PortfolioHandlerType } from '../../../src/handlers/PortfolioHandler.js';

const MockPortfolioRepoManager = jest.fn();

jest.unstable_mockModule('../../../src/portfolio/PortfolioRepoManager.js', () => ({
  PortfolioRepoManager: MockPortfolioRepoManager
}));

const mockTokenManagerInstance = {
  getGitHubTokenAsync: jest.fn(),
  validateTokenScopes: jest.fn().mockResolvedValue({ isValid: true, scopes: ['public_repo'] })
};

jest.unstable_mockModule('../../../src/security/tokenManager.js', () => ({
  TokenManager: jest.fn().mockImplementation(() => mockTokenManagerInstance)
}));

const { PortfolioHandler } = await import('../../../src/handlers/PortfolioHandler.js');

describe('PortfolioHandler', () => {
  let handler: PortfolioHandlerType;
  let authManager: any;
  let portfolioManager: any;
  let portfolioPullHandler: any;
  let portfolioIndexManager: any;
  let unifiedIndexManager: any;
  let initService: any;
  let indicatorService: any;
  let configManager: any;
  let mockRepoManagerInstance: any;
  let fileOperationsService: any;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portfolio-handler-'));

    authManager = {
      getAuthStatus: jest.fn()
    };

    const dirMap: Record<ElementType, string> = {
      [ElementType.PERSONA]: 'personas',
      [ElementType.SKILL]: 'skills',
      [ElementType.TEMPLATE]: 'templates',
      [ElementType.AGENT]: 'agents',
      [ElementType.MEMORY]: 'memories',
      [ElementType.ENSEMBLE]: 'ensembles'
    };
    portfolioManager = {
      getElementDir: jest.fn((type: ElementType) => path.join(tempDir, dirMap[type] || 'other'))
    };

    portfolioPullHandler = {};
    portfolioIndexManager = {};
    unifiedIndexManager = {};
    initService = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined)
    };
    indicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('>>')
    };
    configManager = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getGitHubClientId: jest.fn(),
      setGitHubClientId: jest.fn()
    };

    mockRepoManagerInstance = {
      checkPortfolioExists: jest.fn(),
      getRepositoryName: jest.fn().mockReturnValue('dollhouse-portfolio'),
      createPortfolio: jest.fn(),
      ensurePortfolio: jest.fn(),
      setToken: jest.fn(),
      saveElement: jest.fn()
    };
    MockPortfolioRepoManager.mockImplementation(() => mockRepoManagerInstance);

    // Create FileOperationsService mock that uses real fs
    fileOperationsService = {
      exists: jest.fn(async (p: string) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
      listDirectory: jest.fn(async (p: string) => {
        return await fs.readdir(p);
      }),
      readFile: jest.fn(async (p: string) => {
        return await fs.readFile(p, 'utf-8');
      }),
      stat: jest.fn(async (p: string) => {
        return await fs.stat(p);
      })
    };

    handler = new PortfolioHandler(
      authManager,
      portfolioManager,
      portfolioPullHandler,
      portfolioIndexManager,
      unifiedIndexManager,
      initService,
      indicatorService,
      configManager,
      fileOperationsService,
      mockTokenManagerInstance,
      mockRepoManagerInstance
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('refuses an unreadable sync count without recording an empty type', async () => {
    const failure = new Error('Collection unavailable');
    const progress = { elementCounts: {}, totalElements: 0 };
    const host = { getElementsList: async () => { throw failure; }, assertMemoryOperation: () => {} };
    await expect(PortfolioHandler.prototype['countSyncType'].call(host as any, progress as any, 'skills')).rejects.toBe(failure);
    expect(progress.elementCounts).not.toHaveProperty('skills');
  });

  it('refuses to report zero elements when directory enumeration fails', async () => {
    fileOperationsService.exists.mockResolvedValue(true);
    fileOperationsService.listDirectory.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect((handler as any).countElementsInDir(path.join(tempDir, 'skills')))
      .rejects.toMatchObject({ name: 'ElementUnreadableError' });
  });

  describe('portfolioStatus', () => {
    it('requires authentication when username missing', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false });

      const result = await handler.portfolioStatus();

      expect(result.content[0].text).toContain('GitHub Authentication Required');
    });

    it('describes repository when present', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: true, username: 'tester' });
      mockRepoManagerInstance.checkPortfolioExists.mockResolvedValue(true);

      const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
      await fs.mkdir(personasDir, { recursive: true });
      await fs.writeFile(path.join(personasDir, 'writer.md'), '---\nname: Writer\n---\nContent');

      const result = await handler.portfolioStatus();

      expect(mockRepoManagerInstance.checkPortfolioExists).toHaveBeenCalledWith('tester');
      expect(result.content[0].text).toContain('Local Elements');
      expect(result.content[0].text).toContain('Personas: 1');
    });

    it('suggests init when repository missing', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: true, username: 'tester' });
      mockRepoManagerInstance.checkPortfolioExists.mockResolvedValue(false);

      const result = await handler.portfolioStatus();

      expect(result.content[0].text).toContain('Use init_portfolio');
    });
  });

  describe('initPortfolio', () => {
    it('requires authentication', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false });

      const result = await handler.initPortfolio({});

      expect(result.content[0].text).toContain('GitHub Authentication Required');
    });

    it('returns success when portfolio created', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: true, username: 'tester' });
      const url = 'https://github.com/tester/dollhouse-portfolio';
      mockRepoManagerInstance.ensurePortfolio.mockResolvedValue({ url, created: true });

      const result = await handler.initPortfolio({});

      expect(mockRepoManagerInstance.ensurePortfolio).toHaveBeenCalledWith('tester', true, {});
      expect(result.content[0].text).toContain('Portfolio Created Successfully');
      expect(result.content[0].text).toContain(url);
    });

    it('forwards all creation options and reports the selected existing repository', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: true, username: 'tester' });
      const url = 'https://github.com/tester/private-portfolio';
      mockRepoManagerInstance.ensurePortfolio.mockResolvedValue({ url, created: false });
      const options = { repositoryName: 'private-portfolio', private: true, description: 'My notes' };

      const result = await handler.initPortfolio(options);

      expect(mockRepoManagerInstance.ensurePortfolio).toHaveBeenCalledWith('tester', true, options);
      expect(result.content[0].text).toContain(`Portfolio already exists at ${url}`);
    });
  });

  describe('portfolioConfig', () => {
    it('echoes configuration values', async () => {
      const result = await handler.portfolioConfig({
        autoSync: true,
        defaultVisibility: 'private',
        autoSubmit: true,
        repositoryName: 'custom-portfolio'
      });

      const text = result.content[0].text;
      expect(text).toContain('Auto-sync: Enabled');
      expect(text).toContain('Default visibility: private');
      expect(text).toContain('Auto-submit to collection: Enabled');
      expect(text).toContain('Repository name: custom-portfolio');
    });
  });

  describe('searchPortfolio report notice', () => {
    it('adds the listing notice only when the report is incomplete', async () => {
      const report = { items: [], failures: [] as any[], complete: true };
      portfolioIndexManager.searchReport = jest.fn(async () => report);
      const complete = await handler.searchPortfolio({ query: 'anything' });
      expect(complete.content).toHaveLength(1);
      expect(complete.content.every(block => block.text.length > 0)).toBe(true);
      report.complete = false;
      report.failures = [{ reference: 'broken.md', error: new Error('Element read failed') }];
      const incomplete = await handler.searchPortfolio({ query: 'anything' });
      expect(incomplete.content).toHaveLength(2);
      expect(incomplete.content[1].text).toContain('Listing incomplete');
    });
  });

});
