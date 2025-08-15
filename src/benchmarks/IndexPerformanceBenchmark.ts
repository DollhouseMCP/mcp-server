/**
 * Comprehensive Performance Benchmarking Suite for DollhouseMCP Indexing System
 * 
 * Benchmarks:
 * - Search response times under various loads
 * - Memory usage patterns with large datasets
 * - Cache performance and hit rates
 * - Concurrent operation performance
 * - Index building and rebuilding times
 */

import { UnifiedIndexManager, UnifiedSearchOptions } from '../portfolio/UnifiedIndexManager.js';
import { PortfolioIndexManager } from '../portfolio/PortfolioIndexManager.js';
import { CollectionIndexCache } from '../cache/CollectionIndexCache.js';
import { PerformanceMonitor } from '../utils/PerformanceMonitor.js';
import { GitHubClient } from '../collection/GitHubClient.js';
import { APICache } from '../cache/APICache.js';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface BenchmarkResult {
  name: string;
  duration: number;
  memoryUsage: {
    before: number;
    after: number;
    peak: number;
  };
  throughput?: number; // operations per second
  cacheStats?: {
    hitRate: number;
    totalOperations: number;
  };
  metadata?: any;
}

export interface BenchmarkSuite {
  name: string;
  results: BenchmarkResult[];
  summary: {
    totalDuration: number;
    averageMemoryUsage: number;
    peakMemoryUsage: number;
    recommendations: string[];
  };
}

export class IndexPerformanceBenchmark {
  private unifiedIndexManager: UnifiedIndexManager;
  private performanceMonitor: PerformanceMonitor;
  private benchmarkResults: BenchmarkResult[] = [];

  constructor() {
    this.unifiedIndexManager = UnifiedIndexManager.getInstance();
    this.performanceMonitor = PerformanceMonitor.getInstance();
  }

  /**
   * Run comprehensive performance benchmark suite
   */
  async runFullBenchmarkSuite(): Promise<BenchmarkSuite> {
    logger.info('Starting comprehensive performance benchmark suite');
    const suiteStartTime = Date.now();

    // Clear caches and reset state
    await this.resetBenchmarkEnvironment();

    const benchmarks = [
      () => this.benchmarkSearchPerformance(),
      () => this.benchmarkMemoryUsage(),
      () => this.benchmarkCachePerformance(),
      () => this.benchmarkConcurrentOperations(),
      () => this.benchmarkLargeDatasetHandling(),
      () => this.benchmarkIndexBuilding(),
      () => this.benchmarkStreamingSearch(),
      () => this.benchmarkLazyLoading()
    ];

    // Run each benchmark
    for (const benchmark of benchmarks) {
      try {
        const result = await benchmark();
        this.benchmarkResults.push(result);
        
        // Allow garbage collection between benchmarks
        await this.waitForGC();
      } catch (error) {
        logger.error('Benchmark failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const suite: BenchmarkSuite = {
      name: 'DollhouseMCP Index Performance Suite',
      results: this.benchmarkResults,
      summary: this.generateSummary(Date.now() - suiteStartTime)
    };

    logger.info('Benchmark suite completed', {
      totalBenchmarks: suite.results.length,
      totalDuration: suite.summary.totalDuration,
      recommendations: suite.summary.recommendations.length
    });

    return suite;
  }

  /**
   * Benchmark search performance with various query patterns
   */
  private async benchmarkSearchPerformance(): Promise<BenchmarkResult> {
    const testQueries = [
      'creative',
      'professional assistant',
      'development tools',
      'data analysis',
      'machine learning expert',
      'a very long and complex query that might stress the search system with multiple terms and complex patterns',
      'specific_exact_match',
      ''  // Empty query test
    ];

    const memoryBefore = process.memoryUsage().heapUsed;
    let peakMemory = memoryBefore;
    const startTime = Date.now();

    let totalOperations = 0;
    let cacheHits = 0;

    for (const query of testQueries) {
      for (let i = 0; i < 10; i++) { // 10 iterations per query
        const options: UnifiedSearchOptions = {
          query,
          includeLocal: true,
          includeGitHub: true,
          includeCollection: false,
          pageSize: 20
        };

        await this.unifiedIndexManager.search(options);
        totalOperations++;

        // Track peak memory
        const currentMemory = process.memoryUsage().heapUsed;
        if (currentMemory > peakMemory) {
          peakMemory = currentMemory;
        }
      }
    }

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;
    const duration = endTime - startTime;

    const performanceStats = this.unifiedIndexManager.getPerformanceStats();
    const searchStats = performanceStats.searchStats;

    return {
      name: 'Search Performance',
      duration,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: peakMemory / (1024 * 1024)
      },
      throughput: totalOperations / (duration / 1000),
      cacheStats: {
        hitRate: searchStats.cacheHitRate || 0,
        totalOperations
      },
      metadata: {
        avgSearchTime: searchStats.averageTime || 0,
        p95SearchTime: searchStats.p95Time || 0,
        slowQueries: searchStats.slowQueries || 0
      }
    };
  }

  /**
   * Benchmark memory usage with large result sets
   */
  private async benchmarkMemoryUsage(): Promise<BenchmarkResult> {
    const memoryBefore = process.memoryUsage().heapUsed;
    let peakMemory = memoryBefore;
    const startTime = Date.now();

    // Create increasingly large search operations
    const largeBatches = [100, 500, 1000, 2000];
    
    for (const batchSize of largeBatches) {
      const options: UnifiedSearchOptions = {
        query: '',  // Empty query to get all results
        includeLocal: true,
        includeGitHub: true,
        includeCollection: true,
        pageSize: batchSize,
        maxResults: batchSize
      };

      await this.unifiedIndexManager.search(options);

      const currentMemory = process.memoryUsage().heapUsed;
      if (currentMemory > peakMemory) {
        peakMemory = currentMemory;
      }

      // Check for memory leaks
      if (currentMemory > memoryBefore * 2) {
        logger.warn('Potential memory leak detected', {
          beforeMB: memoryBefore / (1024 * 1024),
          currentMB: currentMemory / (1024 * 1024),
          batchSize
        });
      }
    }

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;

    return {
      name: 'Memory Usage',
      duration: endTime - startTime,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: peakMemory / (1024 * 1024)
      },
      metadata: {
        memoryGrowthMB: (memoryAfter - memoryBefore) / (1024 * 1024),
        peakGrowthMB: (peakMemory - memoryBefore) / (1024 * 1024),
        testedBatchSizes: largeBatches
      }
    };
  }

  /**
   * Benchmark cache performance and hit rates
   */
  private async benchmarkCachePerformance(): Promise<BenchmarkResult> {
    const memoryBefore = process.memoryUsage().heapUsed;
    const startTime = Date.now();

    // Test cache warming and hit rate optimization
    const rawQueries = ['test', 'performance', 'benchmark', 'cache'];
    // DMCP-SEC-004 FIX: Normalize Unicode in all user input
    const testQueries = rawQueries.map(q => {
      const normalized = UnicodeValidator.normalize(q);
      return normalized.isValid ? normalized.normalizedContent : q;
    });
    let totalOperations = 0;
    let cacheHitsBefore = 0;

    // First pass - cache misses expected
    for (const query of testQueries) {
      for (let i = 0; i < 5; i++) {
        await this.unifiedIndexManager.search({ query, pageSize: 10 });
        totalOperations++;
      }
    }

    const statsAfterFirstPass = this.unifiedIndexManager.getPerformanceStats();
    cacheHitsBefore = statsAfterFirstPass.cacheStats.searchResults.hitCount;

    // Second pass - cache hits expected
    for (const query of testQueries) {
      for (let i = 0; i < 5; i++) {
        await this.unifiedIndexManager.search({ query, pageSize: 10 });
        totalOperations++;
      }
    }

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;

    const finalStats = this.unifiedIndexManager.getPerformanceStats();
    const cacheStats = finalStats.cacheStats.searchResults;

    return {
      name: 'Cache Performance',
      duration: endTime - startTime,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: memoryAfter / (1024 * 1024)
      },
      cacheStats: {
        hitRate: cacheStats.hitRate,
        totalOperations
      },
      metadata: {
        cacheSize: cacheStats.size,
        evictions: cacheStats.evictionCount,
        hitRateImprovement: cacheStats.hitRate
      }
    };
  }

  /**
   * Benchmark concurrent search operations
   */
  private async benchmarkConcurrentOperations(): Promise<BenchmarkResult> {
    const memoryBefore = process.memoryUsage().heapUsed;
    let peakMemory = memoryBefore;
    const startTime = Date.now();

    const concurrencyLevels = [5, 10, 20, 50];
    let totalOperations = 0;

    for (const concurrency of concurrencyLevels) {
      const promises = [];

      for (let i = 0; i < concurrency; i++) {
        const searchPromise = this.unifiedIndexManager.search({
          query: `concurrent_test_${i}`,
          pageSize: 20
        });
        promises.push(searchPromise);
        totalOperations++;
      }

      await Promise.all(promises);

      const currentMemory = process.memoryUsage().heapUsed;
      if (currentMemory > peakMemory) {
        peakMemory = currentMemory;
      }
    }

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;
    const duration = endTime - startTime;

    return {
      name: 'Concurrent Operations',
      duration,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: peakMemory / (1024 * 1024)
      },
      throughput: totalOperations / (duration / 1000),
      metadata: {
        testedConcurrencyLevels: concurrencyLevels,
        totalConcurrentOps: totalOperations
      }
    };
  }

  /**
   * Benchmark large dataset handling (simulated)
   */
  private async benchmarkLargeDatasetHandling(): Promise<BenchmarkResult> {
    const memoryBefore = process.memoryUsage().heapUsed;
    let peakMemory = memoryBefore;
    const startTime = Date.now();

    // Simulate searches that would stress a large dataset
    const stressTestQueries = [
      { query: '', pageSize: 1000 }, // Get all results
      { query: 'common_term', pageSize: 500 }, // High result count
      { query: 'very_specific_unique_term', pageSize: 100 }, // Low result count
      { query: 'partial_match_test', pageSize: 200 } // Medium result count
    ];

    let totalResults = 0;

    for (const testCase of stressTestQueries) {
      const results = await this.unifiedIndexManager.search({
        query: testCase.query,
        pageSize: testCase.pageSize,
        includeLocal: true,
        includeGitHub: true,
        includeCollection: true
      });

      totalResults += results.length;

      const currentMemory = process.memoryUsage().heapUsed;
      if (currentMemory > peakMemory) {
        peakMemory = currentMemory;
      }
    }

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;

    return {
      name: 'Large Dataset Handling',
      duration: endTime - startTime,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: peakMemory / (1024 * 1024)
      },
      metadata: {
        totalResultsProcessed: totalResults,
        averageResultsPerQuery: totalResults / stressTestQueries.length,
        memoryPerResult: (peakMemory - memoryBefore) / totalResults
      }
    };
  }

  /**
   * Benchmark index building performance
   */
  private async benchmarkIndexBuilding(): Promise<BenchmarkResult> {
    const memoryBefore = process.memoryUsage().heapUsed;
    const startTime = Date.now();

    // Force rebuild of all indexes
    await this.unifiedIndexManager.rebuildAll();

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;

    const localStats = await PortfolioIndexManager.getInstance().getStats();

    return {
      name: 'Index Building',
      duration: endTime - startTime,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: memoryAfter / (1024 * 1024)
      },
      metadata: {
        totalElementsIndexed: localStats.totalElements,
        indexingRate: localStats.totalElements / ((endTime - startTime) / 1000),
        isStale: localStats.isStale
      }
    };
  }

  /**
   * Benchmark streaming search performance
   */
  private async benchmarkStreamingSearch(): Promise<BenchmarkResult> {
    const memoryBefore = process.memoryUsage().heapUsed;
    let peakMemory = memoryBefore;
    const startTime = Date.now();

    const streamingQueries = [
      { query: 'test', maxResults: 100 },
      { query: 'assistant', maxResults: 200 },
      { query: 'creative', maxResults: 150 }
    ];

    let totalResults = 0;

    for (const testCase of streamingQueries) {
      const results = await this.unifiedIndexManager.search({
        query: testCase.query,
        streamResults: true,
        maxResults: testCase.maxResults,
        includeLocal: true,
        includeGitHub: true
      });

      totalResults += results.length;

      const currentMemory = process.memoryUsage().heapUsed;
      if (currentMemory > peakMemory) {
        peakMemory = currentMemory;
      }
    }

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;

    return {
      name: 'Streaming Search',
      duration: endTime - startTime,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: peakMemory / (1024 * 1024)
      },
      throughput: totalResults / ((endTime - startTime) / 1000),
      metadata: {
        totalStreamedResults: totalResults,
        averageMemoryPerResult: (peakMemory - memoryBefore) / totalResults
      }
    };
  }

  /**
   * Benchmark lazy loading performance
   */
  private async benchmarkLazyLoading(): Promise<BenchmarkResult> {
    const memoryBefore = process.memoryUsage().heapUsed;
    const startTime = Date.now();

    // Test lazy loading with different configurations
    const lazyLoadTests = [
      { query: 'lazy_test_1', lazyLoad: true, includeLocal: true, includeGitHub: false, includeCollection: false },
      { query: 'lazy_test_2', lazyLoad: true, includeLocal: false, includeGitHub: true, includeCollection: false },
      { query: 'lazy_test_3', lazyLoad: true, includeLocal: true, includeGitHub: true, includeCollection: true },
      { query: 'lazy_test_4', lazyLoad: false, includeLocal: true, includeGitHub: true, includeCollection: true }
    ];

    let totalOperations = 0;

    for (const testCase of lazyLoadTests) {
      await this.unifiedIndexManager.search(testCase);
      totalOperations++;
    }

    const endTime = Date.now();
    const memoryAfter = process.memoryUsage().heapUsed;

    return {
      name: 'Lazy Loading',
      duration: endTime - startTime,
      memoryUsage: {
        before: memoryBefore / (1024 * 1024),
        after: memoryAfter / (1024 * 1024),
        peak: memoryAfter / (1024 * 1024)
      },
      throughput: totalOperations / ((endTime - startTime) / 1000),
      metadata: {
        totalLazyOperations: totalOperations,
        averageOperationTime: (endTime - startTime) / totalOperations
      }
    };
  }

  /**
   * Reset benchmark environment
   */
  private async resetBenchmarkEnvironment(): Promise<void> {
    await this.unifiedIndexManager.rebuildAll();
    this.performanceMonitor.reset();
    this.benchmarkResults = [];

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    await this.waitForGC();
  }

  /**
   * Wait for garbage collection to complete
   */
  private async waitForGC(): Promise<void> {
    return new Promise(resolve => {
      setImmediate(() => {
        if (global.gc) {
          global.gc();
        }
        setTimeout(resolve, 100); // Wait 100ms for GC to complete
      });
    });
  }

  /**
   * Generate benchmark summary and recommendations
   */
  private generateSummary(totalDuration: number): BenchmarkSuite['summary'] {
    const recommendations: string[] = [];
    let totalMemoryUsage = 0;
    let peakMemoryUsage = 0;

    // Analyze results and generate recommendations
    for (const result of this.benchmarkResults) {
      totalMemoryUsage += result.memoryUsage.after - result.memoryUsage.before;
      peakMemoryUsage = Math.max(peakMemoryUsage, result.memoryUsage.peak);

      // Check for performance issues
      if (result.name === 'Search Performance' && result.metadata?.avgSearchTime > 100) {
        recommendations.push('Average search time exceeds 100ms. Consider query optimization or increased caching.');
      }

      if (result.memoryUsage.peak > 200) {
        recommendations.push(`High memory usage detected in ${result.name} (${result.memoryUsage.peak.toFixed(1)}MB). Consider memory optimization.`);
      }

      if (result.cacheStats?.hitRate && result.cacheStats.hitRate < 0.5) {
        recommendations.push(`Low cache hit rate in ${result.name} (${result.cacheStats.hitRate.toFixed(2)}). Consider cache size increase or TTL adjustment.`);
      }

      if (result.throughput && result.throughput < 10) {
        recommendations.push(`Low throughput in ${result.name} (${result.throughput.toFixed(1)} ops/sec). Consider performance optimization.`);
      }
    }

    // General recommendations
    if (peakMemoryUsage > 50) {
      recommendations.push('Peak memory usage exceeds 50MB. Consider implementing more aggressive memory cleanup.');
    }

    if (totalDuration > 30000) {
      recommendations.push('Total benchmark duration exceeds 30 seconds. Consider performance optimizations.');
    }

    return {
      totalDuration,
      averageMemoryUsage: totalMemoryUsage / this.benchmarkResults.length,
      peakMemoryUsage,
      recommendations
    };
  }

  /**
   * Export benchmark results to JSON
   */
  exportResults(suite: BenchmarkSuite): string {
    return JSON.stringify(suite, null, 2);
  }

  /**
   * Generate benchmark report
   */
  generateReport(suite: BenchmarkSuite): string {
    let report = `# DollhouseMCP Index Performance Benchmark Report\n\n`;
    report += `**Generated:** ${new Date().toISOString()}\n`;
    report += `**Total Duration:** ${suite.summary.totalDuration}ms\n`;
    report += `**Peak Memory Usage:** ${suite.summary.peakMemoryUsage.toFixed(1)}MB\n\n`;

    report += `## Benchmark Results\n\n`;

    for (const result of suite.results) {
      report += `### ${result.name}\n`;
      report += `- **Duration:** ${result.duration}ms\n`;
      report += `- **Memory Usage:** ${result.memoryUsage.before.toFixed(1)}MB → ${result.memoryUsage.after.toFixed(1)}MB (Peak: ${result.memoryUsage.peak.toFixed(1)}MB)\n`;
      
      if (result.throughput) {
        report += `- **Throughput:** ${result.throughput.toFixed(1)} ops/sec\n`;
      }
      
      if (result.cacheStats) {
        report += `- **Cache Hit Rate:** ${result.cacheStats.hitRate.toFixed(2)}\n`;
      }
      
      report += `\n`;
    }

    report += `## Recommendations\n\n`;
    
    if (suite.summary.recommendations.length === 0) {
      report += `No performance issues detected. System is performing within acceptable parameters.\n`;
    } else {
      for (const recommendation of suite.summary.recommendations) {
        report += `- ${recommendation}\n`;
      }
    }

    return report;
  }
}