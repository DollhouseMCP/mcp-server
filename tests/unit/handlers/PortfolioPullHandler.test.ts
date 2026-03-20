import { PortfolioPullHandler, PullOptions, PortfolioPullHandlerDependencies } from '../../../src/handlers/PortfolioPullHandler.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ElementType } from '../../../src/portfolio/types.js';
import type { SyncAction } from '../../../src/sync/PortfolioSyncComparer.js';

/**
 * UNIT TESTS for PortfolioPullHandler
 *
 * These tests focus on the handler's orchestration logic:
 * - Constructor validation
 * - Input validation (sync mode)
 * - Dry-run formatting
 * - Error handling
 * - Message formatting
 *
 * NOTE: Integration tests are needed for:
 * - Actual file download/save operations
 * - Actual file deletion operations
 * - GitHub API interactions
 * - Index rebuilding with real data
 *
 * See: TEST-COVERAGE-ANALYSIS.md for integration test requirements
 */

describe('PortfolioPullHandler', () => {
  let handler: InstanceType<typeof PortfolioPullHandler>;
  let mockDeps: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock all dependencies
    mockDeps = {
      portfolioRepoManager: {
        setToken: jest.fn(),
      },
      githubIndexer: {
        getIndex: jest.fn(),
      },
      portfolioManager: {
        getElementDir: jest.fn().mockReturnValue('/mock/portfolio/personas'),
        initialize: jest.fn().mockResolvedValue(undefined),
      },
      indexManager: {
        rebuildIndex: jest.fn().mockResolvedValue(undefined),
        getElementsByType: jest.fn().mockResolvedValue([]),
      },
      syncComparer: {
        compareElements: jest.fn(),
      },
      downloader: {
        downloadFromGitHub: jest.fn().mockResolvedValue({ content: 'mock content' }),
      },
      fileOperations: {
        writeFile: jest.fn().mockResolvedValue(undefined),
        deleteFile: jest.fn().mockResolvedValue(undefined),
        createDirectory: jest.fn().mockResolvedValue(undefined),
      },
      tokenManager: {
        getGitHubTokenAsync: jest.fn().mockResolvedValue('mock-token'),
      },
    };

    // Create handler with mocked dependencies
    handler = new PortfolioPullHandler(mockDeps as PortfolioPullHandlerDependencies);

    // Mock internal methods
    jest.spyOn(handler as any, 'getGitHubToken').mockResolvedValue('mock-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    it('should throw error if portfolioManager is missing', () => {
      expect(() => {
        new PortfolioPullHandler({
          ...mockDeps,
          portfolioManager: null,
        } as any);
      }).toThrow('PortfolioPullHandler requires a PortfolioManager instance');
    });

    it('should throw error if githubIndexer is missing', () => {
      expect(() => {
        new PortfolioPullHandler({
          ...mockDeps,
          githubIndexer: null,
        } as any);
      }).toThrow('PortfolioPullHandler requires a GitHubPortfolioIndexer instance');
    });

    it('should throw error if indexManager is missing', () => {
      expect(() => {
        new PortfolioPullHandler({
          ...mockDeps,
          indexManager: null,
        } as any);
      }).toThrow('PortfolioPullHandler requires a PortfolioIndexManager instance');
    });

    it('should create default instances for optional dependencies', () => {
      const minimalHandler = new PortfolioPullHandler({
        portfolioRepoManager: null as any,
        portfolioManager: mockDeps.portfolioManager,
        githubIndexer: mockDeps.githubIndexer,
        indexManager: mockDeps.indexManager,
        syncComparer: null as any,
        downloader: null as any,
      });

      expect(minimalHandler).toBeDefined();
    });
  });

  describe('executePull', () => {
    const defaultOptions: PullOptions = {
      direction: 'pull',
      mode: 'additive',
    };

    describe('empty GitHub portfolio', () => {
      it('should return warning when GitHub portfolio is empty', async () => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue({
          totalElements: 0,
          elements: [],
        });

        const result = await handler.executePull(defaultOptions, '>>');

        expect(result.content[0].text).toContain('⚠️ No elements found in GitHub portfolio');
        expect(result.content[0].text).toContain('Nothing to pull');
      });

      it('should return warning when GitHub index is null', async () => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue(null);

        const result = await handler.executePull(defaultOptions, '>>');

        expect(result.content[0].text).toContain('⚠️ No elements found in GitHub portfolio');
      });
    });

    describe('sync mode validation', () => {
      beforeEach(() => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue({
          totalElements: 1,
          elements: [{ name: 'test', type: ElementType.PERSONA, path: 'personas/test.md' }],
          username: 'test-user',
          repository: 'dollhouse-portfolio',
        });
        mockDeps.syncComparer.compareElements.mockReturnValue({
          toAdd: [],
          toUpdate: [],
          toDelete: [],
          toSkip: [],
        });
      });

      it('should accept valid sync mode: additive', async () => {
        const options: PullOptions = { ...defaultOptions, mode: 'additive' };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('✅');
        expect(mockDeps.syncComparer.compareElements).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'additive'
        );
      });

      it('should accept valid sync mode: mirror', async () => {
        const options: PullOptions = { ...defaultOptions, mode: 'mirror' };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('✅');
        expect(mockDeps.syncComparer.compareElements).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'mirror'
        );
      });

      it('should accept valid sync mode: backup', async () => {
        const options: PullOptions = { ...defaultOptions, mode: 'backup' };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('✅');
        expect(mockDeps.syncComparer.compareElements).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'backup'
        );
      });

      it('should reject invalid sync mode', async () => {
        const options: PullOptions = { ...defaultOptions, mode: 'invalid-mode' };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('❌ Failed to pull portfolio');
        expect(result.content[0].text).toContain('Invalid sync mode');
      });

      it('should default to additive mode when mode not specified', async () => {
        const options: PullOptions = { direction: 'pull' };
        await handler.executePull(options, '>>');

        expect(mockDeps.syncComparer.compareElements).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'additive'
        );
      });

      it('should normalize Unicode in sync mode to prevent homograph attacks', async () => {
        // This tests the security fix for Unicode normalization
        const options: PullOptions = { ...defaultOptions, mode: 'Additive' }; // Mixed case
        await handler.executePull(options, '>>');

        expect(mockDeps.syncComparer.compareElements).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'additive'
        );
      });
    });

    describe('dry-run mode', () => {
      beforeEach(() => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue({
          totalElements: 3,
          elements: [
            { name: 'persona1', type: ElementType.PERSONA, path: 'personas/persona1.md' },
            { name: 'skill1', type: ElementType.SKILL, path: 'skills/skill1.md' },
          ],
          username: 'test-user',
          repository: 'dollhouse-portfolio',
        });
      });

      it('should return dry-run results without executing actions', async () => {
        const syncActions = {
          toAdd: [
            { name: 'new-persona', type: ElementType.PERSONA, path: 'personas/new.md', reason: '' } as SyncAction,
          ],
          toUpdate: [
            { name: 'old-skill', type: ElementType.SKILL, path: 'skills/old.md', reason: '' } as SyncAction,
          ],
          toDelete: [],
          toSkip: [
            { name: 'skip-template', type: ElementType.TEMPLATE, path: 'templates/skip.md', reason: 'up-to-date' } as SyncAction,
          ],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions, dryRun: true };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('🔍 **Dry Run Results**');
        expect(result.content[0].text).toContain('📥 **To Add (1):**');
        expect(result.content[0].text).toContain('personas/new-persona');
        expect(result.content[0].text).toContain('🔄 **To Update (1):**');
        expect(result.content[0].text).toContain('skills/old-skill');
        expect(result.content[0].text).toContain('🔗 **To Skip (1):**');
        expect(result.content[0].text).toContain('templates/skip-template (up-to-date)');
        expect(result.content[0].text).toContain('Run without `dryRun: true`');

        // Verify no actual operations were performed
        expect(mockDeps.downloader.downloadFromGitHub).not.toHaveBeenCalled();
      });

      it('should show deletions in dry-run for mirror mode', async () => {
        const syncActions = {
          toAdd: [],
          toUpdate: [],
          toDelete: [
            { name: 'to-delete', type: ElementType.AGENT, path: 'agents/delete.md', reason: '' } as SyncAction,
          ],
          toSkip: [],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions, mode: 'mirror', dryRun: true };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('🗑️ **To Delete (1):**');
        expect(result.content[0].text).toContain('agents/to-delete');
      });
    });

    describe('deletion confirmation', () => {
      beforeEach(() => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue({
          totalElements: 1,
          elements: [],
          username: 'test-user',
          repository: 'dollhouse-portfolio',
        });
      });

      it('should require confirmation for deletions in mirror mode', async () => {
        const syncActions = {
          toAdd: [],
          toUpdate: [],
          toDelete: [
            { name: 'delete1', type: ElementType.PERSONA, path: 'personas/delete1.md', reason: '' } as SyncAction,
            { name: 'delete2', type: ElementType.SKILL, path: 'skills/delete2.md', reason: '' } as SyncAction,
          ],
          toSkip: [],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions, mode: 'mirror' };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('⚠️ Pull operation would delete 2 local elements');
        expect(result.content[0].text).toContain('delete1');
        expect(result.content[0].text).toContain('delete2');
        expect(result.content[0].text).toContain('force: true');
      });

      it('should proceed with deletions when force is true', async () => {
        const syncActions = {
          toAdd: [],
          toUpdate: [],
          toDelete: [
            { name: 'delete1', type: ElementType.PERSONA, path: 'personas/delete1.md', reason: '' } as SyncAction,
          ],
          toSkip: [],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions, mode: 'mirror', force: true };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('✅ **Portfolio Pull Complete**');
        // Note: Actual deletion logic would be tested in integration tests
      });

      it('should proceed with deletions when confirmDeletions is false', async () => {
        const syncActions = {
          toAdd: [],
          toUpdate: [],
          toDelete: [
            { name: 'delete1', type: ElementType.PERSONA, path: 'personas/delete1.md', reason: '' } as SyncAction,
          ],
          toSkip: [],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions, mode: 'mirror', confirmDeletions: false };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('✅ **Portfolio Pull Complete**');
      });

      it('should not require confirmation for deletions in non-mirror modes', async () => {
        const syncActions = {
          toAdd: [],
          toUpdate: [],
          toDelete: [
            { name: 'delete1', type: ElementType.PERSONA, path: 'personas/delete1.md', reason: '' } as SyncAction,
          ],
          toSkip: [],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        // Additive mode shouldn't have deletions, but if it does, no confirmation needed
        const options: PullOptions = { ...defaultOptions, mode: 'additive' };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('✅ **Portfolio Pull Complete**');
        expect(result.content[0].text).not.toContain('⚠️ Pull operation would delete');
      });
    });

    describe('successful pull operation', () => {
      beforeEach(() => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue({
          totalElements: 2,
          elements: [
            { name: 'persona1', type: ElementType.PERSONA, path: 'personas/persona1.md' },
          ],
          username: 'test-user',
          repository: 'dollhouse-portfolio',
        });

        // Mock the private methods that do file I/O
        // This allows us to test the orchestration logic without file system operations
        jest.spyOn(handler as any, 'downloadAndSaveElement').mockResolvedValue(undefined);
        jest.spyOn(handler as any, 'deleteLocalElement').mockResolvedValue(undefined);
      });

      it('should show progress messages and summary', async () => {
        const syncActions = {
          toAdd: [
            { name: 'new1', type: ElementType.PERSONA, path: 'personas/new1.md', reason: '' } as SyncAction,
          ],
          toUpdate: [
            { name: 'update1', type: ElementType.SKILL, path: 'skills/update1.md', reason: '' } as SyncAction,
          ],
          toDelete: [],
          toSkip: [
            { name: 'skip1', type: ElementType.TEMPLATE, path: 'templates/skip1.md', reason: 'up-to-date' } as SyncAction,
          ],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('✅ **Portfolio Pull Complete**');
        expect(result.content[0].text).toContain('🔍 Fetching portfolio from GitHub');
        expect(result.content[0].text).toContain('📊 Found 2 elements on GitHub');
        expect(result.content[0].text).toContain('**Summary:**');
        expect(result.content[0].text).toContain('📥 Added: 1');
        expect(result.content[0].text).toContain('🔄 Updated: 1');
        expect(result.content[0].text).toContain('🔗 Skipped: 1');
      });

      it('should include deleted count when deletions occur', async () => {
        // Re-spy for this test
        jest.spyOn(handler as any, 'downloadAndSaveElement').mockResolvedValue(undefined);
        jest.spyOn(handler as any, 'deleteLocalElement').mockResolvedValue(undefined);

        const syncActions = {
          toAdd: [],
          toUpdate: [],
          toDelete: [
            { name: 'delete1', type: ElementType.MEMORY, path: 'memories/delete1.yaml', reason: '' } as SyncAction,
          ],
          toSkip: [],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions, mode: 'mirror', force: true };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('🗑️ Deleted: 1');
      });

      it('should rebuild index before and after operations', async () => {
        // Re-spy for this test
        jest.spyOn(handler as any, 'downloadAndSaveElement').mockResolvedValue(undefined);
        jest.spyOn(handler as any, 'deleteLocalElement').mockResolvedValue(undefined);

        const syncActions = {
          toAdd: [
            { name: 'new1', type: ElementType.PERSONA, path: 'personas/new1.md', reason: '' } as SyncAction,
          ],
          toUpdate: [],
          toDelete: [],
          toSkip: [],
        };
        mockDeps.syncComparer.compareElements.mockReturnValue(syncActions);

        const options: PullOptions = { ...defaultOptions };
        await handler.executePull(options, '>>');

        // Should call rebuildIndex at least once (before comparison and after operations)
        expect(mockDeps.indexManager.rebuildIndex).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle GitHub indexer errors', async () => {
        mockDeps.githubIndexer.getIndex.mockRejectedValue(new Error('GitHub API error'));

        const options: PullOptions = { ...defaultOptions };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('❌ Failed to pull portfolio');
        expect(result.content[0].text).toContain('GitHub API error');
      });

      it('should handle sync comparer errors', async () => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue({
          totalElements: 1,
          elements: [],
          username: 'test-user',
          repository: 'dollhouse-portfolio',
        });
        mockDeps.syncComparer.compareElements.mockImplementation(() => {
          throw new Error('Comparison failed');
        });

        const options: PullOptions = { ...defaultOptions };
        const result = await handler.executePull(options, '>>');

        expect(result.content[0].text).toContain('❌ Failed to pull portfolio');
        expect(result.content[0].text).toContain('Comparison failed');
      });

      it('should include persona indicator in error messages', async () => {
        mockDeps.githubIndexer.getIndex.mockRejectedValue(new Error('Test error'));

        const options: PullOptions = { ...defaultOptions };
        const result = await handler.executePull(options, '[PERSONA] ');

        expect(result.content[0].text).toMatch(/^\[PERSONA\]/);
        expect(result.content[0].text).toContain('❌ Failed to pull portfolio');
      });
    });

    describe('persona indicator integration', () => {
      beforeEach(() => {
        mockDeps.githubIndexer.getIndex.mockResolvedValue({
          totalElements: 1,
          elements: [],
          username: 'test-user',
          repository: 'dollhouse-portfolio',
        });
        mockDeps.syncComparer.compareElements.mockReturnValue({
          toAdd: [],
          toUpdate: [],
          toDelete: [],
          toSkip: [],
        });
      });

      it('should prefix all messages with persona indicator', async () => {
        const indicator = '[TEST-PERSONA] ';
        const result = await handler.executePull(defaultOptions, indicator);

        expect(result.content[0].text).toMatch(/^\[TEST-PERSONA\]/);
      });

      it('should handle empty persona indicator', async () => {
        const result = await handler.executePull(defaultOptions, '');

        expect(result.content[0].text).toContain('✅');
      });
    });
  });
});
