/**
 * Tests for Unified Index Manager
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { UnifiedIndexManager, UnifiedIndexEntry, UnifiedSearchResult } from '../../../../src/portfolio/UnifiedIndexManager.js';
import { PortfolioIndexManager, IndexEntry, SearchResult } from '../../../../src/portfolio/PortfolioIndexManager.js';
import { GitHubPortfolioIndexer, GitHubIndexEntry, GitHubPortfolioIndex } from '../../../../src/portfolio/GitHubPortfolioIndexer.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { CollectionIndexCache } from '../../../../src/cache/CollectionIndexCache.js';
import { ElementSource } from '../../../../src/config/sourcePriority.js';

describe('UnifiedIndexManager', () => {
  let unifiedManager: UnifiedIndexManager;
  let mockLocalIndexManager: jest.Mocked<PortfolioIndexManager>;
  let mockGitHubIndexer: jest.Mocked<GitHubPortfolioIndexer>;
  let mockCollectionIndexCache: jest.Mocked<CollectionIndexCache>;

  beforeEach(() => {
    // Reset singleton
    (UnifiedIndexManager as any).instance = null;
    
    // Create mocks
    mockLocalIndexManager = {
      search: jest.fn(),
      findByName: jest.fn(),
      getElementsByType: jest.fn(),
      getStats: jest.fn(),
      rebuildIndex: jest.fn()
    } as any;

    mockGitHubIndexer = {
      getIndex: jest.fn(),
      invalidateAfterAction: jest.fn(),
      clearCache: jest.fn(),
      getCacheStats: jest.fn()
    } as any;

    mockCollectionIndexCache = {
      getIndex: jest.fn(),
      getCacheStats: jest.fn(),
      clearCache: jest.fn()
    } as any;

    // Spy on getInstance methods
    jest.spyOn(PortfolioIndexManager, 'getInstance').mockReturnValue(mockLocalIndexManager);
    jest.spyOn(GitHubPortfolioIndexer, 'getInstance').mockReturnValue(mockGitHubIndexer);
    
    // Mock CollectionIndexCache constructor
    jest.spyOn(CollectionIndexCache.prototype, 'getIndex').mockImplementation(mockCollectionIndexCache.getIndex);
    jest.spyOn(CollectionIndexCache.prototype, 'getCacheStats').mockImplementation(mockCollectionIndexCache.getCacheStats);
    jest.spyOn(CollectionIndexCache.prototype, 'clearCache').mockImplementation(mockCollectionIndexCache.clearCache);

    // Set up default collection mocks
    const defaultCollectionIndex = {
      version: '1.0.0',
      generated: new Date().toISOString(),
      total_elements: 0,
      index: {},
      metadata: {
        build_time_ms: 0,
        file_count: 0,
        skipped_files: 0,
        categories: 0,
        nodejs_version: process.version,
        builder_version: '1.0.0'
      }
    };

    const defaultCollectionCacheStats = {
      isValid: true,
      age: 0,
      hasCache: true,
      elements: 0,
      memoryCache: {},
      performanceMetrics: {
        averageResponseTime: 0,
        cacheHitRate: 0
      }
    };

    mockCollectionIndexCache.getIndex.mockResolvedValue(defaultCollectionIndex);
    mockCollectionIndexCache.getCacheStats.mockReturnValue(defaultCollectionCacheStats);
    mockCollectionIndexCache.clearCache.mockResolvedValue();
    
    // Ensure rebuildIndex returns a Promise
    mockLocalIndexManager.rebuildIndex.mockResolvedValue(undefined);

    // Create unified manager
    unifiedManager = UnifiedIndexManager.getInstance();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = UnifiedIndexManager.getInstance();
      const instance2 = UnifiedIndexManager.getInstance();
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('Unified Search', () => {
    it('should combine results from local and GitHub searches when includeAll is true', async () => {
      const localResults: SearchResult[] = [{
        entry: {
          filePath: '/local/personas/sample.md',
          elementType: ElementType.PERSONA,
          metadata: { name: 'Local Test Persona', description: 'Local persona' },
          lastModified: new Date(),
          filename: 'sample'
        },
        matchType: 'name',
        score: 3
      }];

      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, [{
          path: 'personas/github-sample.md',
          name: 'GitHub Test Persona',
          description: 'GitHub persona',
          elementType: ElementType.PERSONA,
          sha: 'abc123',
          htmlUrl: 'https://github.com/test/repo/blob/main/personas/github-sample.md',
          downloadUrl: 'https://raw.githubusercontent.com/test/repo/main/personas/github-sample.md',
          lastModified: new Date(),
          size: 1024
        }]]]),
        totalElements: 1,
        sha: 'abc123'
      };

      mockLocalIndexManager.search.mockResolvedValue(localResults);
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

      // Use includeAll to search all sources (Issue #1446)
      const results = await unifiedManager.search({
        query: 'test persona',
        includeAll: true
      });

      expect(results.length).toBeGreaterThanOrEqual(2);

      // Check that both results are present, regardless of order
      const sources = results.map(r => r.source);
      const names = results.map(r => r.entry.name);

      expect(sources).toContain('local');
      expect(sources).toContain('github');
      expect(names).toContain('Local Test Persona');
      expect(names).toContain('GitHub Test Persona');
    });

    it('should handle local search failures gracefully', async () => {
      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, [{
          path: 'personas/github-sample.md',
          name: 'GitHub Test Persona',
          elementType: ElementType.PERSONA,
          sha: 'abc123',
          htmlUrl: 'https://github.com/test/repo',
          downloadUrl: 'https://raw.githubusercontent.com/test/repo',
          lastModified: new Date(),
          size: 1024
        }]]]),
        totalElements: 1,
        sha: 'abc123'
      };

      mockLocalIndexManager.search.mockRejectedValue(new Error('Local search failed'));
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

      const results = await unifiedManager.search({ query: 'test persona' });

      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('github');
    });

    it('should handle GitHub search failures gracefully', async () => {
      const localResults: SearchResult[] = [{
        entry: {
          filePath: '/local/personas/sample.md',
          elementType: ElementType.PERSONA,
          metadata: { name: 'Local Test Persona' },
          lastModified: new Date(),
          filename: 'sample'
        },
        matchType: 'name',
        score: 3
      }];

      mockLocalIndexManager.search.mockResolvedValue(localResults);
      mockGitHubIndexer.getIndex.mockRejectedValue(new Error('GitHub search failed'));

      const results = await unifiedManager.search({ query: 'test persona' });

      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('local');
    });

    it('should deduplicate results by name and type when includeAll is true', async () => {
      const localResults: SearchResult[] = [{
        entry: {
          filePath: '/local/personas/sample.md',
          elementType: ElementType.PERSONA,
          metadata: { name: 'Test Persona' },
          lastModified: new Date(),
          filename: 'sample'
        },
        matchType: 'name',
        score: 3
      }];

      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, [{
          path: 'personas/sample.md',
          name: 'Test Persona', // Same name as local
          elementType: ElementType.PERSONA,
          sha: 'abc123',
          htmlUrl: 'https://github.com/test/repo',
          downloadUrl: 'https://raw.githubusercontent.com/test/repo',
          lastModified: new Date(),
          size: 1024
        }]]]),
        totalElements: 1,
        sha: 'abc123'
      };

      mockLocalIndexManager.search.mockResolvedValue(localResults);
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

      // Use includeAll to get both sources (Issue #1446)
      const results = await unifiedManager.search({
        query: 'test persona',
        includeAll: true
      });

      expect(results).toHaveLength(2); // Both results are kept but marked as duplicates

      // Both should be marked as duplicates
      expect(results[0].isDuplicate).toBe(true);
      expect(results[1].isDuplicate).toBe(true);

      // Both sources should be present
      const sources = results.map(r => r.source);
      expect(sources).toContain('local');
      expect(sources).toContain('github');
    });

    it('should sort results by score when includeAll is true', async () => {
      const localResults: SearchResult[] = [{
        entry: {
          filePath: '/local/personas/low-score.md',
          elementType: ElementType.PERSONA,
          metadata: { name: 'Low Score Persona' },
          lastModified: new Date(),
          filename: 'low-score'
        },
        matchType: 'description',
        score: 1
      }];

      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, [{
          path: 'personas/high-score.md',
          name: 'High Score Persona',
          elementType: ElementType.PERSONA,
          sha: 'abc123',
          htmlUrl: 'https://github.com/test/repo',
          downloadUrl: 'https://raw.githubusercontent.com/test/repo',
          lastModified: new Date(),
          size: 1024
        }]]]),
        totalElements: 1,
        sha: 'abc123'
      };

      mockLocalIndexManager.search.mockResolvedValue(localResults);
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

      // Use includeAll to get all sources (Issue #1446)
      const results = await unifiedManager.search({
        query: 'persona',
        includeAll: true
      });

      expect(results).toHaveLength(2);
      // First result should have higher score
      expect(results[0].entry.name).toBe('High Score Persona');
      expect(results[1].entry.name).toBe('Low Score Persona');
    });
  });

  describe('Find by Name', () => {
    it('should find element in local portfolio first', async () => {
      const localResults: SearchResult[] = [{
        entry: {
          filePath: '/local/personas/sample.md',
          elementType: ElementType.PERSONA,
          metadata: { name: 'Test Persona' },
          lastModified: new Date(),
          filename: 'sample'
        },
        matchType: 'name',
        score: 10
      }];

      // Mock search to return the local result
      mockLocalIndexManager.search.mockResolvedValue(localResults);
      mockGitHubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map(),
        totalElements: 0,
        sha: ''
      });

      const result = await unifiedManager.findByName('Test Persona');

      expect(result).toBeTruthy();
      expect(result!.source).toBe('local');
      expect(result!.name).toBe('Test Persona');
      expect(mockLocalIndexManager.search).toHaveBeenCalledWith('Test Persona', expect.any(Object));
    });

    it('should search GitHub when not found locally', async () => {
      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, [{
          path: 'personas/sample.md',
          name: 'Test Persona',
          elementType: ElementType.PERSONA,
          sha: 'abc123',
          htmlUrl: 'https://github.com/test/repo',
          downloadUrl: 'https://raw.githubusercontent.com/test/repo',
          lastModified: new Date(),
          size: 1024
        }]]]),
        totalElements: 1,
        sha: 'abc123'
      };

      mockLocalIndexManager.findByName.mockResolvedValue(null);
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

      const result = await unifiedManager.findByName('Test Persona');

      expect(result).toBeTruthy();
      expect(result!.source).toBe('github');
      expect(result!.name).toBe('Test Persona');
    });

    it('should return null when not found anywhere', async () => {
      const emptyGithubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, []]]),
        totalElements: 0,
        sha: 'abc123'
      };

      mockLocalIndexManager.findByName.mockResolvedValue(null);
      mockGitHubIndexer.getIndex.mockResolvedValue(emptyGithubIndex);

      const result = await unifiedManager.findByName('Nonexistent Persona');

      expect(result).toBe(null);
    });
  });

  describe('Get Elements by Type', () => {
    it('should combine elements from both sources', async () => {
      const localEntries: IndexEntry[] = [{
        filePath: '/local/personas/local.md',
        elementType: ElementType.PERSONA,
        metadata: { name: 'Local Persona' },
        lastModified: new Date(),
        filename: 'local'
      }];

      const githubEntries: GitHubIndexEntry[] = [{
        path: 'personas/github.md',
        name: 'GitHub Persona',
        elementType: ElementType.PERSONA,
        sha: 'abc123',
        htmlUrl: 'https://github.com/test/repo',
        downloadUrl: 'https://raw.githubusercontent.com/test/repo',
        lastModified: new Date(),
        size: 1024
      }];

      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, githubEntries]]),
        totalElements: 1,
        sha: 'abc123'
      };

      mockLocalIndexManager.getElementsByType.mockResolvedValue(localEntries);
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

      const result = await unifiedManager.getElementsByType(ElementType.PERSONA);

      expect(result).toHaveLength(2);
      expect(result[0].source).toBe('local');
      expect(result[1].source).toBe('github');
    });

    it('should deduplicate elements by name and type', async () => {
      const localEntries: IndexEntry[] = [{
        filePath: '/local/personas/sample.md',
        elementType: ElementType.PERSONA,
        metadata: { name: 'Test Persona' },
        lastModified: new Date(),
        filename: 'sample'
      }];

      const githubEntries: GitHubIndexEntry[] = [{
        path: 'personas/sample.md',
        name: 'Test Persona', // Same name
        elementType: ElementType.PERSONA,
        sha: 'abc123',
        htmlUrl: 'https://github.com/test/repo',
        downloadUrl: 'https://raw.githubusercontent.com/test/repo',
        lastModified: new Date(),
        size: 1024
      }];

      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, githubEntries]]),
        totalElements: 1,
        sha: 'abc123'
      };

      mockLocalIndexManager.getElementsByType.mockResolvedValue(localEntries);
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

      const result = await unifiedManager.getElementsByType(ElementType.PERSONA);

      expect(result).toHaveLength(1); // Deduplicated
      expect(result[0].source).toBe('local'); // Local has priority
    });
  });

  describe('Statistics', () => {
    it('should provide comprehensive statistics', async () => {
      const localStats = {
        totalElements: 5,
        elementsByType: { [ElementType.PERSONA]: 3, [ElementType.SKILL]: 2 } as Record<ElementType, number>,
        lastBuilt: new Date(),
        isStale: false
      };

      const githubCacheStats = {
        hasCachedData: true,
        lastFetch: new Date(),
        isStale: false,
        recentUserAction: false,
        totalElements: 3
      };

      const githubIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([
          [ElementType.PERSONA, [{ elementType: ElementType.PERSONA } as GitHubIndexEntry]],
          [ElementType.SKILL, [
            { elementType: ElementType.SKILL } as GitHubIndexEntry,
            { elementType: ElementType.SKILL } as GitHubIndexEntry
          ]]
        ]),
        totalElements: 3,
        sha: 'abc123'
      };

      const mockCollectionIndex = {
        version: '1.0.0',
        generated: new Date().toISOString(),
        total_elements: 0,
        index: {},
        metadata: {
          build_time_ms: 0,
          file_count: 0,
          skipped_files: 0,
          categories: 0,
          nodejs_version: process.version,
          builder_version: '1.0.0'
        }
      };

      const mockCollectionCacheStats = {
        isValid: true,
        age: 0,
        hasCache: true,
        elements: 0,
        memoryCache: {},
        performanceMetrics: {
          averageResponseTime: 0,
          cacheHitRate: 0
        }
      };

      mockLocalIndexManager.getStats.mockResolvedValue(localStats);
      mockGitHubIndexer.getCacheStats.mockReturnValue(githubCacheStats);
      mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);
      mockCollectionIndexCache.getIndex.mockResolvedValue(mockCollectionIndex);
      mockCollectionIndexCache.getCacheStats.mockReturnValue(mockCollectionCacheStats);

      const stats = await unifiedManager.getStats();

      expect(stats.local.totalElements).toBe(5);
      expect(stats.github.totalElements).toBe(3);
      expect(stats.combined.totalElements).toBe(8); // 5 + 3 + 0 (collection)
      expect(stats.github.username).toBe('testuser');
    });

    it('should handle errors in statistics gathering', async () => {
      const mockCollectionIndex = {
        version: '1.0.0',
        generated: new Date().toISOString(),
        total_elements: 0,
        index: {},
        metadata: {
          build_time_ms: 0,
          file_count: 0,
          skipped_files: 0,
          categories: 0,
          nodejs_version: process.version,
          builder_version: '1.0.0'
        }
      };

      const mockCollectionCacheStats = {
        isValid: true,
        age: 0,
        hasCache: true,
        elements: 0,
        memoryCache: {},
        performanceMetrics: {
          averageResponseTime: 0,
          cacheHitRate: 0
        }
      };

      mockLocalIndexManager.getStats.mockRejectedValue(new Error('Local stats failed'));
      mockGitHubIndexer.getCacheStats.mockReturnValue({
        hasCachedData: false,
        lastFetch: null,
        isStale: true,
        recentUserAction: false,
        totalElements: 0
      });
      mockGitHubIndexer.getIndex.mockRejectedValue(new Error('GitHub stats failed'));
      mockCollectionIndexCache.getIndex.mockResolvedValue(mockCollectionIndex);
      mockCollectionIndexCache.getCacheStats.mockReturnValue(mockCollectionCacheStats);

      const stats = await unifiedManager.getStats();

      expect(stats.local.totalElements).toBe(0);
      expect(stats.github.totalElements).toBe(0);
      expect(stats.combined.totalElements).toBe(0); // 0 + 0 + 0 (collection)
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate both local and GitHub caches', () => {
      unifiedManager.invalidateAfterAction('submit_content');

      expect(mockLocalIndexManager.rebuildIndex).toHaveBeenCalled();
      expect(mockGitHubIndexer.invalidateAfterAction).toHaveBeenCalledWith('submit_content');
    });

    it('should rebuild all indexes', async () => {
      mockLocalIndexManager.rebuildIndex.mockResolvedValue();
    mockCollectionIndexCache.clearCache.mockResolvedValue();
      mockGitHubIndexer.clearCache.mockImplementation(() => {});

      await unifiedManager.rebuildAll();

      expect(mockLocalIndexManager.rebuildIndex).toHaveBeenCalled();
      expect(mockGitHubIndexer.clearCache).toHaveBeenCalled();
    });
  });

  describe('Entry Conversion', () => {
    it('should convert local entries correctly', () => {
      const localEntry: IndexEntry = {
        filePath: '/local/personas/sample.md',
        elementType: ElementType.PERSONA,
        metadata: {
          name: 'Test Persona',
          description: 'A test persona',
          version: '1.0.0',
          author: 'Test Author',
          tags: ['test', 'example'],
          keywords: ['testing'],
          triggers: ['test trigger']
        },
        lastModified: new Date('2023-01-01'),
        filename: 'sample'
      };

      const converted = (unifiedManager as any).convertLocalEntry(localEntry);

      expect(converted.source).toBe('local');
      expect(converted.name).toBe('Test Persona');
      expect(converted.localFilePath).toBe('/local/personas/sample.md');
      expect(converted.tags).toEqual(['test', 'example']);
      expect(converted.githubPath).toBeUndefined();
    });

    it('should convert GitHub entries correctly', () => {
      const githubEntry: GitHubIndexEntry = {
        path: 'personas/sample.md',
        name: 'Test Persona',
        description: 'A test persona',
        version: '1.0.0',
        author: 'Test Author',
        elementType: ElementType.PERSONA,
        sha: 'abc123',
        htmlUrl: 'https://github.com/test/repo/blob/main/personas/sample.md',
        downloadUrl: 'https://raw.githubusercontent.com/test/repo/main/personas/sample.md',
        lastModified: new Date('2023-01-01'),
        size: 1024
      };

      const converted = (unifiedManager as any).convertGitHubEntry(githubEntry);

      expect(converted.source).toBe('github');
      expect(converted.name).toBe('Test Persona');
      expect(converted.githubPath).toBe('personas/sample.md');
      expect(converted.githubSha).toBe('abc123');
      expect(converted.localFilePath).toBeUndefined();
    });
  });

  describe('Source Priority (Issue #1446)', () => {
    describe('Priority-based Search', () => {
      it('should search sources in default priority order (local → github → collection)', async () => {
        const localResults: SearchResult[] = [{
          entry: {
            filePath: '/local/personas/local.md',
            elementType: ElementType.PERSONA,
            metadata: { name: 'Local Persona' },
            lastModified: new Date(),
            filename: 'local'
          },
          matchType: 'name',
          score: 3
        }];

        mockLocalIndexManager.search.mockResolvedValue(localResults);
        mockGitHubIndexer.getIndex.mockResolvedValue({
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map(),
          totalElements: 0,
          sha: ''
        });

        const results = await unifiedManager.search({ query: 'persona' });

        // Should find local result and stop (stopOnFirst = true by default)
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('local');
        expect(mockLocalIndexManager.search).toHaveBeenCalled();
      });

      it('should stop on first source with results when stopOnFirst is enabled', async () => {
        const localResults: SearchResult[] = [{
          entry: {
            filePath: '/local/personas/local.md',
            elementType: ElementType.PERSONA,
            metadata: { name: 'Local Persona' },
            lastModified: new Date(),
            filename: 'local'
          },
          matchType: 'name',
          score: 3
        }];

        const githubIndex: GitHubPortfolioIndex = {
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map([[ElementType.PERSONA, [{
            path: 'personas/github.md',
            name: 'GitHub Persona',
            elementType: ElementType.PERSONA,
            sha: 'abc123',
            htmlUrl: 'https://github.com/test/repo',
            downloadUrl: 'https://raw.githubusercontent.com/test/repo',
            lastModified: new Date(),
            size: 1024
          }]]]),
          totalElements: 1,
          sha: 'abc123'
        };

        mockLocalIndexManager.search.mockResolvedValue(localResults);
        mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

        const results = await unifiedManager.search({ query: 'persona' });

        // Should stop after finding local results
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('local');
        expect(results[0].entry.name).toBe('Local Persona');
      });

      it('should search all sources when includeAll is true', async () => {
        const localResults: SearchResult[] = [{
          entry: {
            filePath: '/local/personas/local.md',
            elementType: ElementType.PERSONA,
            metadata: { name: 'Local Persona' },
            lastModified: new Date(),
            filename: 'local'
          },
          matchType: 'name',
          score: 3
        }];

        const githubIndex: GitHubPortfolioIndex = {
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map([[ElementType.PERSONA, [{
            path: 'personas/github.md',
            name: 'GitHub Persona',
            elementType: ElementType.PERSONA,
            sha: 'abc123',
            htmlUrl: 'https://github.com/test/repo',
            downloadUrl: 'https://raw.githubusercontent.com/test/repo',
            lastModified: new Date(),
            size: 1024
          }]]]),
          totalElements: 1,
          sha: 'abc123'
        };

        mockLocalIndexManager.search.mockResolvedValue(localResults);
        mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

        const results = await unifiedManager.search({
          query: 'persona',
          includeAll: true
        });

        // Should search all sources even though local had results
        expect(results.length).toBeGreaterThanOrEqual(2);
        const sources = results.map(r => r.source);
        expect(sources).toContain('local');
        expect(sources).toContain('github');
      });

      it('should fallback to next source when current source fails', async () => {
        const githubIndex: GitHubPortfolioIndex = {
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map([[ElementType.PERSONA, [{
            path: 'personas/github.md',
            name: 'GitHub Persona',
            elementType: ElementType.PERSONA,
            sha: 'abc123',
            htmlUrl: 'https://github.com/test/repo',
            downloadUrl: 'https://raw.githubusercontent.com/test/repo',
            lastModified: new Date(),
            size: 1024
          }]]]),
          totalElements: 1,
          sha: 'abc123'
        };

        // Local search fails
        mockLocalIndexManager.search.mockRejectedValue(new Error('Local search failed'));
        mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

        const results = await unifiedManager.search({ query: 'persona' });

        // Should fallback to GitHub and find results
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('github');
        expect(results[0].entry.name).toBe('GitHub Persona');
      });
    });

    describe('Source Priority Overrides', () => {
      it('should use preferredSource option', async () => {
        const localResults: SearchResult[] = [];
        const githubIndex: GitHubPortfolioIndex = {
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map([[ElementType.PERSONA, [{
            path: 'personas/github.md',
            name: 'GitHub Persona',
            elementType: ElementType.PERSONA,
            sha: 'abc123',
            htmlUrl: 'https://github.com/test/repo',
            downloadUrl: 'https://raw.githubusercontent.com/test/repo',
            lastModified: new Date(),
            size: 1024
          }]]]),
          totalElements: 1,
          sha: 'abc123'
        };

        mockLocalIndexManager.search.mockResolvedValue(localResults);
        mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

        const results = await unifiedManager.search({
          query: 'persona',
          preferredSource: ElementSource.GITHUB
        });

        // Should try GitHub first
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('github');
      });

      it('should use custom sourcePriority order', async () => {
        const collectionIndex = {
          version: '1.0.0',
          generated: new Date().toISOString(),
          total_elements: 1,
          index: {
            personas: [{
              name: 'Collection Persona',
              description: 'Collection persona',
              path: 'library/personas/collection.md',
              sha: 'abc123',
              author: 'test',
              version: '1.0.0',
              tags: [],
              category: 'test',
              created: new Date().toISOString(),
              license: 'MIT'
            }]
          },
          metadata: {
            build_time_ms: 0,
            file_count: 1,
            skipped_files: 0,
            categories: 1,
            nodejs_version: process.version,
            builder_version: '1.0.0'
          }
        };

        mockLocalIndexManager.search.mockResolvedValue([]);
        mockGitHubIndexer.getIndex.mockResolvedValue({
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map(),
          totalElements: 0,
          sha: ''
        });
        mockCollectionIndexCache.getIndex.mockResolvedValue(collectionIndex);

        const results = await unifiedManager.search({
          query: 'persona',
          sourcePriority: [ElementSource.COLLECTION, ElementSource.LOCAL, ElementSource.GITHUB],
          includeCollection: true
        });

        // Should try collection first
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('collection');
      });
    });

    describe('checkForUpdates()', () => {
      it('should check all sources for version information', async () => {
        // Mock the search to return results from both sources
        // The search method will be called multiple times during checkDuplicates
        const localResults: SearchResult[] = [{
          entry: {
            filePath: '/local/personas/test.md',
            elementType: ElementType.PERSONA,
            metadata: { name: 'Test Persona', version: '1.0.0' },
            lastModified: new Date('2023-01-01'),
            filename: 'test'
          },
          matchType: 'name',
          score: 3
        }];

        const githubIndex: GitHubPortfolioIndex = {
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map([[ElementType.PERSONA, [{
            path: 'personas/test.md',
            name: 'Test Persona',
            version: '2.0.0', // Newer version
            elementType: ElementType.PERSONA,
            sha: 'abc123',
            htmlUrl: 'https://github.com/test/repo',
            downloadUrl: 'https://raw.githubusercontent.com/test/repo',
            lastModified: new Date('2023-06-01'),
            size: 1024
          }]]]),
          totalElements: 1,
          sha: 'abc123'
        };

        // The internal search will use includeAll=true
        mockLocalIndexManager.search.mockResolvedValue(localResults);
        mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

        const versionInfo = await unifiedManager.checkForUpdates('Test Persona');

        expect(versionInfo).toBeTruthy();
        if (versionInfo) {
          expect(versionInfo.name).toBe('Test Persona');
          expect(versionInfo.versions.local?.version).toBe('1.0.0');
          expect(versionInfo.versions.github?.version).toBe('2.0.0');
          expect(versionInfo.updateAvailable).toBe(true);
          expect(versionInfo.updateFrom).toBe('github');
        }
      });

      it('should return null when element not found', async () => {
        mockLocalIndexManager.search.mockResolvedValue([]);
        mockGitHubIndexer.getIndex.mockResolvedValue({
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map(),
          totalElements: 0,
          sha: ''
        });

        const versionInfo = await unifiedManager.checkForUpdates('Nonexistent Element');

        expect(versionInfo).toBeNull();
      });
    });

    describe('Edge Cases', () => {
      it('should handle empty priority list gracefully', async () => {
        const results = await unifiedManager.search({
          query: 'test',
          includeLocal: false,
          includeGitHub: false,
          includeCollection: false
        });

        expect(results).toHaveLength(0);
      });

      it('should handle invalid source in preferredSource', async () => {
        const localResults: SearchResult[] = [{
          entry: {
            filePath: '/local/personas/test.md',
            elementType: ElementType.PERSONA,
            metadata: { name: 'Test' },
            lastModified: new Date(),
            filename: 'test'
          },
          matchType: 'name',
          score: 3
        }];

        mockLocalIndexManager.search.mockResolvedValue(localResults);
        mockGitHubIndexer.getIndex.mockResolvedValue({
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map(),
          totalElements: 0,
          sha: ''
        });

        // Use any invalid source - TypeScript will prevent this but test runtime behavior
        const results = await unifiedManager.search({
          query: 'test',
          preferredSource: 'invalid' as any
        });

        // Should still work, falling back to default behavior
        expect(results).toHaveLength(1);
      });

      it('should handle all sources disabled', async () => {
        const results = await unifiedManager.search({
          query: 'test',
          includeLocal: false,
          includeGitHub: false,
          includeCollection: false
        });

        expect(results).toHaveLength(0);
      });
    });

    describe('Performance', () => {
      it('should use early termination for performance', async () => {
        const localResults: SearchResult[] = [{
          entry: {
            filePath: '/local/personas/test.md',
            elementType: ElementType.PERSONA,
            metadata: { name: 'Test' },
            lastModified: new Date(),
            filename: 'test'
          },
          matchType: 'name',
          score: 3
        }];

        mockLocalIndexManager.search.mockResolvedValue(localResults);

        const results = await unifiedManager.search({ query: 'test' });

        // Should use early termination and only return local results
        expect(mockLocalIndexManager.search).toHaveBeenCalled();
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('local');
      });

      it('should continue searching when no results in first source', async () => {
        const localResults: SearchResult[] = [];
        const githubIndex: GitHubPortfolioIndex = {
          username: 'testuser',
          repository: 'dollhouse-portfolio',
          lastUpdated: new Date(),
          elements: new Map([[ElementType.PERSONA, [{
            path: 'personas/test.md',
            name: 'Test',
            elementType: ElementType.PERSONA,
            sha: 'abc123',
            htmlUrl: 'https://github.com/test/repo',
            downloadUrl: 'https://raw.githubusercontent.com/test/repo',
            lastModified: new Date(),
            size: 1024
          }]]]),
          totalElements: 1,
          sha: 'abc123'
        };

        mockLocalIndexManager.search.mockResolvedValue(localResults);
        mockGitHubIndexer.getIndex.mockResolvedValue(githubIndex);

        const results = await unifiedManager.search({ query: 'test' });

        // Should continue to GitHub when local is empty
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('github');
        expect(mockLocalIndexManager.search).toHaveBeenCalled();
        expect(mockGitHubIndexer.getIndex).toHaveBeenCalled();
      });
    });
  });
});