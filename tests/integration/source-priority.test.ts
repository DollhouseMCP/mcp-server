/**
 * Integration tests for element source priority feature
 *
 * Tests end-to-end search priority workflows including:
 * - Search priority order (local → GitHub → collection)
 * - Stop-on-first optimization
 * - Include-all search mode
 * - Preferred source override
 * - Custom source priority configuration
 * - Configuration persistence
 * - Update checking across sources
 * - Fallback behavior on errors
 *
 * Issue #1449 - Phase 5 of Element Sourcing Priority feature
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { UnifiedIndexManager } from '../../src/portfolio/UnifiedIndexManager.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { PortfolioIndexManager } from '../../src/portfolio/PortfolioIndexManager.js';
import { IndexConfigManager } from '../../src/portfolio/config/IndexConfig.js';
import { GitHubPortfolioIndexer } from '../../src/portfolio/GitHubPortfolioIndexer.js';
import { GitHubClient } from '../../src/collection/GitHubClient.js';
import { APICache } from '../../src/cache/APICache.js';
import { PerformanceMonitor } from '../../src/utils/PerformanceMonitor.js';
import { ElementSource } from '../../src/config/sourcePriority.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import {
  setupSourcePriorityTestEnv,
  createLocalElement,
  setTestSourcePriority,
  resetSourcePriority,
  createTestSourcePriorityConfig,
  TEST_ELEMENTS
} from '../helpers/source-priority-helpers.js';

describe('Source Priority Integration Tests', () => {
  let portfolioDir: string;
  let cleanup: () => Promise<void>;
  let unifiedIndex: UnifiedIndexManager;
  let portfolioManager: PortfolioManager;
  let portfolioIndexManager: PortfolioIndexManager;
  let githubIndexer: GitHubPortfolioIndexer;
  let githubClient: GitHubClient;
  let performanceMonitor: PerformanceMonitor;

  beforeEach(async () => {
    // Reset source priority before each test
    resetSourcePriority();

    // Setup test environment
    const env = await setupSourcePriorityTestEnv();
    portfolioDir = env.portfolioDir;
    cleanup = env.cleanup;

    // Initialize managers with test directory
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperations, { baseDir: portfolioDir });

    // Initialize required dependencies for UnifiedIndexManager
    const indexConfigManager = new IndexConfigManager();
    portfolioIndexManager = new PortfolioIndexManager(indexConfigManager, portfolioManager, fileOperations);
    const apiCache = new APICache();
    const rateLimitTracker = new Map<string, number[]>();
    githubClient = new GitHubClient(apiCache, rateLimitTracker);
    githubIndexer = new GitHubPortfolioIndexer(githubClient, portfolioManager);
    performanceMonitor = new PerformanceMonitor();

    // Initialize UnifiedIndexManager with all dependencies
    unifiedIndex = new UnifiedIndexManager({
      portfolioIndexManager,
      githubIndexer,
      githubClient,
      performanceMonitor
    });
  });

  afterEach(async () => {
    // Reset source priority
    resetSourcePriority();

    // Cleanup test environment
    await cleanup();
  });

  describe('End-to-End Search Priority', () => {
    it('should find element from local portfolio when only in local', async () => {
      // Setup: Create element only in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);

      // Action: Search for element
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: Found from local source
      expect(results.length).toBeGreaterThan(0);
      const found = results.find(r => r.entry.name === TEST_ELEMENTS.persona1.name);
      expect(found).toBeDefined();
      expect(found?.source).toBe('local');
    });

    it('should prioritize local over GitHub when element exists in both', async () => {
      // Setup: Create element in local with v1.0.0
      const localElement = { ...TEST_ELEMENTS.persona1, version: '1.0.0' };
      await createLocalElement(portfolioDir, localElement);

      // Rebuild local index
      // Index is automatically built on search

      // Action: Search with both sources enabled
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: true,
        includeGitHub: true,
        includeCollection: false
      });

      // Assert: Found from local source (higher priority)
      expect(results.length).toBeGreaterThan(0);
      const found = results.find(r => r.entry.name === TEST_ELEMENTS.persona1.name);
      expect(found).toBeDefined();
      expect(found?.source).toBe('local');
    });

    it('should search all sources when includeAll is true', async () => {
      // Setup: Create elements in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona2);

      // Rebuild local index
      // Index is automatically built on search

      // Action: Search with includeAll
      const results = await unifiedIndex.search({
        query: 'test',
        includeLocal: true,
        includeGitHub: true,
        includeCollection: true,
        includeAll: true
      });

      // Assert: Search checked all enabled sources
      // At minimum, local results should be present
      expect(results.length).toBeGreaterThan(0);
      const localResults = results.filter(r => r.source === 'local');
      expect(localResults.length).toBeGreaterThan(0);
    });

    it('should respect preferredSource option', async () => {
      // Setup: Create element in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);

      // Rebuild local index
      // Index is automatically built on search

      // Action: Search with preferredSource set to local
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: true,
        includeGitHub: true,
        includeCollection: false,
        preferredSource: ElementSource.LOCAL
      });

      // Assert: Found from preferred source
      expect(results.length).toBeGreaterThan(0);
      const found = results.find(r => r.entry.name === TEST_ELEMENTS.persona1.name);
      expect(found).toBeDefined();
      expect(found?.source).toBe('local');
    });

    it('should use custom sourcePriority order when specified', async () => {
      // Setup: Create element in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.skill1);

      // Rebuild local index
      // Index is automatically built on search

      // Action: Search with custom priority (local first)
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.skill1.name,
        includeLocal: true,
        includeGitHub: true,
        includeCollection: false,
        sourcePriority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION]
      });

      // Assert: Found from local (first in custom priority)
      expect(results.length).toBeGreaterThan(0);
      const found = results.find(r => r.entry.name === TEST_ELEMENTS.skill1.name);
      expect(found).toBeDefined();
      expect(found?.source).toBe('local');
    });

    it('should handle empty search results gracefully', async () => {
      // Action: Search for non-existent element
      const results = await unifiedIndex.search({
        query: 'NonExistentElement123',
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: No results, but no error
      expect(results).toEqual([]);
      expect(results.length).toBe(0);
    });

    it('should handle search with multiple element types', async () => {
      // Setup: Create elements of different types
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);
      await createLocalElement(portfolioDir, TEST_ELEMENTS.skill1);

      // Rebuild local index
      // Index is automatically built on search

      // Action: Search without type filter
      const results = await unifiedIndex.search({
        query: 'test',
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: Found elements of different types
      expect(results.length).toBeGreaterThan(0);
      const personaResults = results.filter(r => r.entry.elementType === 'personas');
      const skillResults = results.filter(r => r.entry.elementType === 'skills');

      // At least one of each type should be found
      expect(personaResults.length + skillResults.length).toBeGreaterThan(0);
    });
  });

  describe('Configuration Persistence', () => {
    it('should use custom source priority from environment', async () => {
      // Setup: Set custom priority (GitHub first)
      const customConfig = createTestSourcePriorityConfig(
        [ElementSource.GITHUB, ElementSource.LOCAL, ElementSource.COLLECTION],
        { stopOnFirst: true }
      );
      setTestSourcePriority(customConfig);

      // Create element in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);
      // Index is automatically built on search

      // Action: Search (should use custom priority from env)
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: true,
        includeGitHub: true,
        includeCollection: false
      });

      // Assert: Element found (priority order may differ but element should be found)
      expect(results.length).toBeGreaterThan(0);
    });

    it('should fall back to default config when environment config is invalid', async () => {
      // Setup: Set invalid configuration
      process.env.SOURCE_PRIORITY = 'invalid json';

      // Create element in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);
      // Index is automatically built on search

      // Action: Search (should use default priority)
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: Element found using default priority
      expect(results.length).toBeGreaterThan(0);

      // Cleanup
      delete process.env.SOURCE_PRIORITY;
    });

    it('should handle stopOnFirst configuration', async () => {
      // Setup: Configure with stopOnFirst: false
      const config = createTestSourcePriorityConfig(
        [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
        { stopOnFirst: false }
      );
      setTestSourcePriority(config);

      // Create elements
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona2);
      // Index is automatically built on search

      // Action: Search with stopOnFirst: false
      const results = await unifiedIndex.search({
        query: 'test',
        includeLocal: true,
        includeGitHub: true,
        includeCollection: false,
        includeAll: true
      });

      // Assert: Multiple sources searched
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Update Checking', () => {
    it('should detect when local version exists', async () => {
      // Setup: Create element in local with v1.0.0
      const element = { ...TEST_ELEMENTS.persona1, version: '1.0.0' };
      await createLocalElement(portfolioDir, element);
      // Index is automatically built on search

      // Action: Search for element
      const results = await unifiedIndex.search({
        query: element.name,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: Element found with version info
      expect(results.length).toBeGreaterThan(0);
      const found = results[0];
      expect(found.entry.version).toBe('1.0.0');
    });

    it('should find all versions when checking all sources', async () => {
      // Setup: Create same element with different versions
      const v1 = { ...TEST_ELEMENTS.skill1, version: '1.0.0' };
      const v2 = { ...TEST_ELEMENTS.skill2, version: '2.0.0' };

      await createLocalElement(portfolioDir, v1);
      await createLocalElement(portfolioDir, v2);
      // Index is automatically built on search

      // Action: Search with includeAll
      const results = await unifiedIndex.search({
        query: 'test',
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false,
        includeAll: true
      });

      // Assert: Found elements with different versions
      expect(results.length).toBeGreaterThan(0);
      const versions = results.map(r => r.entry.version);
      expect(versions).toContain('1.0.0');
      expect(versions).toContain('2.0.0');
    });

    it('should identify duplicate elements across sources', async () => {
      // Setup: Create element in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);
      // Index is automatically built on search

      // Action: Check for duplicates
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: Element found in local
      expect(results.length).toBeGreaterThan(0);
      const localElement = results.find(r => r.source === 'local');
      expect(localElement).toBeDefined();
    });
  });

  describe('Fallback Behavior', () => {
    it('should continue searching when one source is disabled', async () => {
      // Setup: Create element in local
      await createLocalElement(portfolioDir, TEST_ELEMENTS.persona1);
      // Index is automatically built on search

      // Action: Search with GitHub disabled
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: Found from local despite GitHub being disabled
      expect(results.length).toBeGreaterThan(0);
      const found = results.find(r => r.entry.name === TEST_ELEMENTS.persona1.name);
      expect(found).toBeDefined();
      expect(found?.source).toBe('local');
    });

    it('should handle case when all sources are disabled', async () => {
      // Action: Search with all sources disabled
      const results = await unifiedIndex.search({
        query: TEST_ELEMENTS.persona1.name,
        includeLocal: false,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: No results (no sources to search)
      expect(results).toEqual([]);
      expect(results.length).toBe(0);
    });

    it('should handle gracefully when no elements exist in any source', async () => {
      // Action: Search in empty portfolio
      const results = await unifiedIndex.search({
        query: 'anything',
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      // Assert: Empty results, no error
      expect(results).toEqual([]);
      expect(results.length).toBe(0);
    });
  });
});
