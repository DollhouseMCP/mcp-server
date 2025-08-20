/**
 * Tests for EarlyTerminationSearch utility with performance optimizations
 * Tests smart search termination and parallel search handling
 * 
 * Extension of Task #13: Integration tests for search functionality
 * - Test early termination when exact matches are found
 * - Test parallel search coordination
 * - Test performance gains from early termination
 * - Test failure handling and recovery
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock logger
const mockLogDebug = jest.fn();
const mockLogInfo = jest.fn();

jest.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Import the class under test
const { EarlyTerminationSearch } = await import('../../../../src/utils/EarlyTerminationSearch.js');

describe('EarlyTerminationSearch - Performance Optimizations', () => {
  let originalSetTimeout: typeof setTimeout;
  let mockSetTimeout: jest.MockedFunction<typeof setTimeout>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock setTimeout for controlled timing in tests
    originalSetTimeout = global.setTimeout;
    mockSetTimeout = jest.fn().mockImplementation((fn: Function, delay: number) => {
      // Execute immediately for most tests unless specifically testing timing
      if (delay > 0) {
        fn();
      }
      return 1 as any;
    });
    global.setTimeout = mockSetTimeout as any;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    jest.clearAllMocks();
  });

  describe('Basic Search Functionality', () => {
    it('should execute empty search array without errors', async () => {
      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        [], // Empty search array
        () => true,
        { operationName: 'empty-test' }
      );

      expect(result.matches).toEqual([]);
      expect(result.totalSearches).toBe(0);
      expect(result.completedSearches).toBe(0);
      expect(result.earlyTerminationTriggered).toBe(false);
      expect(mockLogDebug).toHaveBeenCalledWith('empty-test: No searches to execute');
    });

    it('should execute single search successfully', async () => {
      const mockSearchResult = { id: 'test-result', name: 'Test Item' };
      const searchFunction = jest.fn().mockResolvedValue(mockSearchResult);
      
      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        [searchFunction],
        (item) => item.name === 'Test Item',
        { operationName: 'single-search' }
      );

      expect(result.matches).toEqual([mockSearchResult]);
      expect(result.exactMatch).toEqual(mockSearchResult);
      expect(result.totalSearches).toBe(1);
      expect(result.completedSearches).toBe(1);
      expect(result.earlyTerminationTriggered).toBe(false);
      expect(searchFunction).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple searches without exact match', async () => {
      const searchResults = [
        { id: 1, name: 'Item 1', exact: false },
        { id: 2, name: 'Item 2', exact: false },
        { id: 3, name: 'Item 3', exact: false }
      ];

      const searchFunctions = searchResults.map(result => 
        jest.fn().mockResolvedValue(result)
      );

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        (item) => item.exact === true, // None will match
        { operationName: 'no-exact-match' }
      );

      expect(result.matches).toHaveLength(3);
      expect(result.exactMatch).toBeUndefined();
      expect(result.totalSearches).toBe(3);
      expect(result.completedSearches).toBe(3);
      expect(result.earlyTerminationTriggered).toBe(false);
    });
  });

  describe('Early Termination Logic', () => {
    it('should trigger early termination on exact match', async () => {
      const exactMatch = { id: 'exact', name: 'Exact Match', exact: true };
      const otherResults = [
        { id: 1, name: 'Item 1', exact: false },
        { id: 2, name: 'Item 2', exact: false }
      ];

      // First search returns exact match
      const searchFunctions = [
        jest.fn().mockResolvedValue(exactMatch),
        ...otherResults.map(result => jest.fn().mockResolvedValue(result))
      ];

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        (item) => item.exact === true,
        { 
          operationName: 'early-termination-test',
          timeoutAfterExactMatch: 500,
          maxParallelSearches: 1 // Process one at a time to test termination
        }
      );

      expect(result.exactMatch).toEqual(exactMatch);
      expect(result.matches[0]).toEqual(exactMatch); // Exact match should be first
      expect(result.earlyTerminationTriggered).toBe(true);
      expect(result.performanceGain).toContain('saving');
      
      // Verify exact match was logged
      expect(mockLogDebug).toHaveBeenCalledWith('early-termination-test: Exact match found at index 0',
        expect.objectContaining({
          operationName: 'early-termination-test',
          exactMatchIndex: 0,
          timeToExactMatch: expect.any(Number)
        })
      );
    });

    it('should handle early termination with timeout', async () => {
      const exactMatch = { id: 'exact', name: 'Exact Match', exact: true };
      const slowSearches = Array.from({ length: 10 }, (_, i) => 
        jest.fn().mockImplementation(() => new Promise(resolve => {
          // Slow searches that should be terminated
          setTimeout(() => resolve({ id: i, name: `Item ${i}`, exact: false }), 1000);
        }))
      );

      // Add exact match at the beginning
      const allSearches = [
        jest.fn().mockResolvedValue(exactMatch),
        ...slowSearches
      ];

      // Mock setTimeout to properly handle timeout scenario
      mockSetTimeout.mockImplementation((fn: Function, delay: number) => {
        if (delay === 500) { // Timeout delay
          setTimeout(fn, 10); // Execute timeout quickly
        }
        return 1 as any;
      });

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        allSearches,
        (item) => item.exact === true,
        { 
          operationName: 'timeout-test',
          timeoutAfterExactMatch: 500,
          maxParallelSearches: 2
        }
      );

      expect(result.exactMatch).toEqual(exactMatch);
      expect(result.earlyTerminationTriggered).toBe(true);
      expect(result.completedSearches).toBeLessThan(result.totalSearches);
      
      // Verify early termination was logged
      expect(mockLogInfo).toHaveBeenCalledWith('timeout-test: Early termination triggered',
        expect.objectContaining({
          operationName: 'timeout-test',
          exactMatch: 'found'
        })
      );
    });

    it('should handle exact match found in later batches', async () => {
      const searches = Array.from({ length: 15 }, (_, i) => {
        if (i === 12) {
          // Exact match in 13th position (second batch if maxParallel = 10)
          return jest.fn().mockResolvedValue({ id: i, name: `Item ${i}`, exact: true });
        }
        return jest.fn().mockResolvedValue({ id: i, name: `Item ${i}`, exact: false });
      });

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searches,
        (item) => item.exact === true,
        { 
          operationName: 'late-exact-match',
          maxParallelSearches: 10,
          timeoutAfterExactMatch: 100
        }
      );

      expect(result.exactMatch?.id).toBe(12);
      expect(result.matches[0].id).toBe(12); // Exact match should be first in results
      expect(result.totalSearches).toBe(15);
    });
  });

  describe('Batch Processing and Parallelization', () => {
    it('should respect maxParallelSearches limit', async () => {
      const searchFunctions = Array.from({ length: 25 }, (_, i) =>
        jest.fn().mockResolvedValue({ id: i, name: `Item ${i}` })
      );

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        () => false, // No exact matches
        { 
          operationName: 'batch-test',
          maxParallelSearches: 5
        }
      );

      expect(result.totalSearches).toBe(25);
      expect(result.completedSearches).toBe(25);
      expect(result.matches).toHaveLength(25);
      
      // Verify all searches were executed
      searchFunctions.forEach(fn => {
        expect(fn).toHaveBeenCalledTimes(1);
      });
    });

    it('should handle mixed success and failure in batches', async () => {
      const searchFunctions = Array.from({ length: 10 }, (_, i) => {
        if (i % 3 === 0) {
          return jest.fn().mockRejectedValue(new Error(`Error ${i}`));
        }
        return jest.fn().mockResolvedValue({ id: i, name: `Item ${i}` });
      });

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        () => false,
        { operationName: 'mixed-results' }
      );

      expect(result.totalSearches).toBe(10);
      expect(result.completedSearches).toBe(10);
      expect(result.failures.length).toBe(4); // Indices 0, 3, 6, 9
      expect(result.matches.length).toBe(6); // Successful searches
      
      // Verify failures contain proper error information
      result.failures.forEach(failure => {
        expect(failure.index).toBeGreaterThanOrEqual(0);
        expect(failure.error).toContain('Error');
      });
    });

    it('should handle promise rejection in batch processing', async () => {
      const searchFunctions = [
        jest.fn().mockResolvedValue({ id: 1, name: 'Success' }),
        jest.fn().mockImplementation(() => {
          throw new Error('Synchronous error');
        }),
        jest.fn().mockRejectedValue(new Error('Async error'))
      ];

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        () => false,
        { operationName: 'promise-rejection-test' }
      );

      expect(result.matches).toHaveLength(1);
      expect(result.failures).toHaveLength(2);
      expect(result.completedSearches).toBe(3);
    });
  });

  describe('Performance Metrics and Logging', () => {
    it('should provide accurate performance metrics', async () => {
      const startTime = Date.now();
      const searchFunctions = Array.from({ length: 5 }, (_, i) =>
        jest.fn().mockResolvedValue({ id: i, name: `Item ${i}` })
      );

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        () => false,
        { operationName: 'performance-test' }
      );

      const endTime = Date.now();
      
      expect(result.totalSearches).toBe(5);
      expect(result.completedSearches).toBe(5);
      
      // Verify performance logging
      expect(mockLogDebug).toHaveBeenCalledWith('performance-test: Search operation completed',
        expect.objectContaining({
          operationName: 'performance-test',
          totalTime: expect.stringMatching(/\d+ms/),
          totalSearches: 5,
          completedSearches: 5,
          matches: 5,
          failures: 0,
          exactMatchFound: false,
          earlyTerminationTriggered: false
        })
      );
    });

    it('should calculate performance gains correctly', async () => {
      const exactMatch = { id: 'exact', exact: true };
      const searchFunctions = [
        jest.fn().mockResolvedValue(exactMatch),
        ...Array.from({ length: 100 }, (_, i) => 
          jest.fn().mockResolvedValue({ id: i, exact: false })
        )
      ];

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        (item) => item.exact === true,
        { 
          operationName: 'performance-gain-test',
          timeoutAfterExactMatch: 1,
          maxParallelSearches: 1
        }
      );

      expect(result.earlyTerminationTriggered).toBe(true);
      expect(result.performanceGain).toContain('saving');
      expect(result.performanceGain).toContain('searches');
      
      const savedSearches = result.totalSearches - result.completedSearches;
      expect(savedSearches).toBeGreaterThan(0);
    });

    it('should log appropriate debug information', async () => {
      const searchFunctions = [
        jest.fn().mockResolvedValue({ id: 1, name: 'Item 1' })
      ];

      await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        () => false,
        { operationName: 'debug-logging-test' }
      );

      // Verify operation completion was logged
      expect(mockLogDebug).toHaveBeenCalledWith('debug-logging-test: Search operation completed',
        expect.objectContaining({
          operationName: 'debug-logging-test',
          totalTime: expect.any(String),
          exactMatchFound: false,
          earlyTerminationTriggered: false
        })
      );
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle all searches failing', async () => {
      const searchFunctions = Array.from({ length: 3 }, (_, i) =>
        jest.fn().mockRejectedValue(new Error(`Search ${i} failed`))
      );

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        () => true,
        { operationName: 'all-failures' }
      );

      expect(result.matches).toHaveLength(0);
      expect(result.failures).toHaveLength(3);
      expect(result.completedSearches).toBe(3);
      expect(result.exactMatch).toBeUndefined();
    });

    it('should handle null/undefined search results', async () => {
      const searchFunctions = [
        jest.fn().mockResolvedValue(null),
        jest.fn().mockResolvedValue(undefined),
        jest.fn().mockResolvedValue({ id: 1, name: 'Valid' })
      ];

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        (item) => item?.id === 1,
        { operationName: 'null-undefined-test' }
      );

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].id).toBe(1);
      expect(result.exactMatch?.id).toBe(1);
    });

    it('should handle malformed isExactMatch function', async () => {
      const searchFunctions = [
        jest.fn().mockResolvedValue({ id: 1, name: 'Test' })
      ];

      const malformedExactMatch = jest.fn().mockImplementation(() => {
        throw new Error('ExactMatch function error');
      });

      // Should not crash the entire operation
      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        malformedExactMatch,
        { operationName: 'malformed-exact-match' }
      );

      expect(result.totalSearches).toBe(1);
      expect(result.completedSearches).toBe(1);
    });

    it('should handle extremely large search arrays', async () => {
      const largeSearchArray = Array.from({ length: 1000 }, (_, i) =>
        jest.fn().mockResolvedValue({ id: i, name: `Item ${i}`, exact: i === 500 })
      );

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        largeSearchArray,
        (item) => item.exact === true,
        { 
          operationName: 'large-array-test',
          maxParallelSearches: 50,
          timeoutAfterExactMatch: 100
        }
      );

      expect(result.totalSearches).toBe(1000);
      expect(result.exactMatch?.id).toBe(500);
      
      // Should have terminated early, saving significant searches
      expect(result.completedSearches).toBeLessThan(1000);
    });
  });

  describe('Real-World Integration Scenarios', () => {
    it('should handle portfolio search scenario', async () => {
      // Simulate searching through different element types
      const elementTypeSearches = [
        // Personas
        jest.fn().mockResolvedValue([
          { name: 'AI Assistant', type: 'persona', exact: false },
          { name: 'Data Analyst', type: 'persona', exact: false }
        ]),
        // Skills  
        jest.fn().mockResolvedValue([
          { name: 'Code Review', type: 'skill', exact: true }, // Exact match found
          { name: 'Testing', type: 'skill', exact: false }
        ]),
        // Templates (should be terminated early)
        jest.fn().mockResolvedValue([
          { name: 'Email Template', type: 'template', exact: false }
        ])
      ];

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        elementTypeSearches,
        (results) => Array.isArray(results) && results.some(r => r.exact),
        { 
          operationName: 'portfolio-search',
          timeoutAfterExactMatch: 200,
          maxParallelSearches: 2
        }
      );

      expect(result.exactMatch).toBeDefined();
      expect(result.exactMatch.some((r: any) => r.exact)).toBe(true);
      
      // Should find the skills array with exact match
      const skillsResult = result.exactMatch.find((r: any) => r.name === 'Code Review');
      expect(skillsResult).toBeDefined();
    });

    it('should handle GitHub repository search scenario', async () => {
      // Simulate searching multiple repositories
      const repoSearches = Array.from({ length: 20 }, (_, i) => {
        return jest.fn().mockResolvedValue({
          repo: `repo-${i}`,
          hasMatch: i === 5, // Exact match at index 5
          files: [`file-${i}-1.md`, `file-${i}-2.md`]
        });
      });

      const result = await EarlyTerminationSearch.executeWithEarlyTermination(
        repoSearches,
        (repoResult) => repoResult.hasMatch === true,
        { 
          operationName: 'github-repo-search',
          maxParallelSearches: 5,
          timeoutAfterExactMatch: 300
        }
      );

      expect(result.exactMatch?.repo).toBe('repo-5');
      expect(result.earlyTerminationTriggered).toBe(true);
      
      // Should have saved searching the remaining 14 repos
      const savedSearches = result.totalSearches - result.completedSearches;
      expect(savedSearches).toBeGreaterThan(10);
    });
  });
});