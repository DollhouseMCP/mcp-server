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
      mockRepoManagerInstance.checkPortfolioExists.mockResolvedValue(false);
      mockRepoManagerInstance.createPortfolio.mockResolvedValue(undefined);

      const result = await handler.initPortfolio({});

      expect(mockRepoManagerInstance.createPortfolio).toHaveBeenCalledWith('tester', true);
      expect(result.content[0].text).toContain('Portfolio Created Successfully');
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
});
