/**
 * Performance benchmarks for LRU Cache size estimation methods
 *
 * Compares:
 * - Fast mode: O(1) heuristics
 * - Balanced mode: Sampled properties
 * - Accurate mode: JSON.stringify (baseline)
 *
 * Run with: npm run test:performance -- lru-cache-size-estimation.bench
 */

import { LRUCache, SizeEstimationMode } from '../../src/cache/LRUCache.js';

interface BenchmarkResult {
  mode: SizeEstimationMode;
  operations: number;
  durationMs: number;
  opsPerSecond: number;
  avgTimePerOp: number;
  speedupVsAccurate: number;
}

interface AccuracyResult {
  mode: SizeEstimationMode;
  testCase: string;
  estimatedSize: number;
  actualSize: number;
  errorPercent: number;
  withinBounds: boolean;
}

/**
 * Test data generators
 */
function generateSmallObject(): any {
  return {
    id: 'test-123',
    name: 'Test Object',
    active: true,
    count: 42
  };
}

function generateMediumObject(): any {
  return {
    id: 'user-456',
    profile: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      age: 30
    },
    settings: {
      notifications: true,
      theme: 'dark',
      language: 'en'
    },
    metadata: {
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      version: 1
    }
  };
}

function generateLargeObject(): any {
  const tags: string[] = [];
  for (let i = 0; i < 50; i++) {
    tags.push(`tag-${i}`);
  }

  const properties: Record<string, any> = {};
  for (let i = 0; i < 100; i++) {
    properties[`prop_${i}`] = {
      value: Math.random(),
      label: `Property ${i}`,
      enabled: i % 2 === 0
    };
  }

  return {
    id: 'large-789',
    tags,
    properties,
    description: 'A'.repeat(1000),
    timestamp: Date.now()
  };
}

function generateArray(size: number): any[] {
  const arr: any[] = [];
  for (let i = 0; i < size; i++) {
    arr.push({
      id: i,
      value: `item-${i}`,
      data: Math.random()
    });
  }
  return arr;
}

/**
 * Run benchmark for a specific mode
 */
function runBenchmark(
  mode: SizeEstimationMode,
  testData: any[],
  iterations: number
): BenchmarkResult {
  const cache = new LRUCache<any>({
    maxSize: 1000,
    maxMemoryMB: 100,
    sizeEstimationMode: mode
  });

  const startTime = performance.now();

  for (let i = 0; i < iterations; i++) {
    const dataIndex = i % testData.length;
    cache.set(`key-${i}`, testData[dataIndex]);
  }

  const endTime = performance.now();
  const durationMs = endTime - startTime;
  const opsPerSecond = (iterations / durationMs) * 1000;
  const avgTimePerOp = durationMs / iterations;

  return {
    mode,
    operations: iterations,
    durationMs,
    opsPerSecond,
    avgTimePerOp,
    speedupVsAccurate: 0 // Will be calculated later
  };
}

/**
 * Measure actual size using JSON.stringify as baseline
 */
function getActualSize(value: any): number {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;

  const jsonStr = JSON.stringify(value);
  return jsonStr.length * 2 + 64;
}

/**
 * Test accuracy of size estimation
 */
function testAccuracy(
  mode: SizeEstimationMode,
  testCase: string,
  value: any
): AccuracyResult {
  const cache = new LRUCache<any>({
    maxSize: 10,
    sizeEstimationMode: mode
  });

  cache.set('test-key', value);
  const stats = cache.getStats();
  const estimatedSize = stats.memoryUsageMB * 1024 * 1024;

  const actualSize = getActualSize(value);
  const errorPercent = ((estimatedSize - actualSize) / actualSize) * 100;

  // For fast mode, acceptable range is 50-200% of actual (as per requirements)
  const withinBounds = mode === 'fast'
    ? estimatedSize >= actualSize * 0.5 && estimatedSize <= actualSize * 2.0
    : mode === 'balanced'
    ? estimatedSize >= actualSize * 0.7 && estimatedSize <= actualSize * 1.5
    : Math.abs(errorPercent) < 20;

  return {
    mode,
    testCase,
    estimatedSize,
    actualSize,
    errorPercent,
    withinBounds
  };
}

/**
 * Print benchmark results
 */
function printBenchmarkResults(results: BenchmarkResult[]): void {
  console.log('\n=== LRU Cache Size Estimation Performance Benchmark ===\n');

  const accurateResult = results.find(r => r.mode === 'accurate');
  if (!accurateResult) {
    console.error('Accurate mode benchmark not found!');
    return;
  }

  // Calculate speedup vs accurate mode
  results.forEach(result => {
    result.speedupVsAccurate = result.opsPerSecond / accurateResult.opsPerSecond;
  });

  console.log('Mode          | Operations | Duration (ms) | Ops/sec    | Avg (μs) | Speedup');
  console.log('--------------|------------|---------------|------------|----------|--------');

  results.forEach(result => {
    console.log(
      `${result.mode.padEnd(13)} | ` +
      `${result.operations.toLocaleString().padStart(10)} | ` +
      `${result.durationMs.toFixed(2).padStart(13)} | ` +
      `${Math.round(result.opsPerSecond).toLocaleString().padStart(10)} | ` +
      `${(result.avgTimePerOp * 1000).toFixed(2).padStart(8)} | ` +
      `${result.speedupVsAccurate.toFixed(2)}x`
    );
  });

  console.log('\n');
}

/**
 * Print accuracy results
 */
function printAccuracyResults(results: AccuracyResult[]): void {
  console.log('\n=== Size Estimation Accuracy Analysis ===\n');

  const groupedByMode: Record<SizeEstimationMode, AccuracyResult[]> = {
    fast: [],
    balanced: [],
    accurate: []
  };

  results.forEach(result => {
    groupedByMode[result.mode].push(result);
  });

  Object.entries(groupedByMode).forEach(([mode, modeResults]) => {
    if (modeResults.length === 0) return;

    console.log(`\n${mode.toUpperCase()} MODE:`);
    console.log('Test Case        | Estimated (B) | Actual (B) | Error %  | Within Bounds');
    console.log('-----------------|---------------|------------|----------|-------------');

    modeResults.forEach(result => {
      const bounds = result.withinBounds ? '✓' : '✗';
      console.log(
        `${result.testCase.padEnd(16)} | ` +
        `${Math.round(result.estimatedSize).toLocaleString().padStart(13)} | ` +
        `${Math.round(result.actualSize).toLocaleString().padStart(10)} | ` +
        `${result.errorPercent.toFixed(1).padStart(7)}% | ` +
        `${bounds.padStart(13)}`
      );
    });

    const avgError = modeResults.reduce((sum, r) => sum + Math.abs(r.errorPercent), 0) / modeResults.length;
    const passRate = (modeResults.filter(r => r.withinBounds).length / modeResults.length) * 100;

    console.log(`\nAverage Error: ${avgError.toFixed(1)}%`);
    console.log(`Pass Rate: ${passRate.toFixed(0)}%`);
  });

  console.log('\n');
}

/**
 * Main benchmark execution
 */
async function main(): Promise<void> {
  console.log('Starting LRU Cache size estimation benchmarks...\n');

  // Prepare test data
  const testData = [
    ...Array(100).fill(null).map(() => generateSmallObject()),
    ...Array(50).fill(null).map(() => generateMediumObject()),
    ...Array(20).fill(null).map(() => generateLargeObject()),
    ...Array(30).fill(null).map(() => generateArray(10)),
    ...Array(10).fill(null).map(() => generateArray(100))
  ];

  const iterations = 10000;
  const modes: SizeEstimationMode[] = ['fast', 'balanced', 'accurate'];

  // Run performance benchmarks
  const perfResults: BenchmarkResult[] = [];
  for (const mode of modes) {
    console.log(`Running ${mode} mode benchmark...`);
    const result = runBenchmark(mode, testData, iterations);
    perfResults.push(result);
  }

  printBenchmarkResults(perfResults);

  // Run accuracy tests
  const accuracyResults: AccuracyResult[] = [];
  const testCases = [
    { name: 'Null', value: null },
    { name: 'Number', value: 42 },
    { name: 'String (short)', value: 'hello' },
    { name: 'String (long)', value: 'A'.repeat(1000) },
    { name: 'Boolean', value: true },
    { name: 'Small Object', value: generateSmallObject() },
    { name: 'Medium Object', value: generateMediumObject() },
    { name: 'Large Object', value: generateLargeObject() },
    { name: 'Array (10)', value: generateArray(10) },
    { name: 'Array (100)', value: generateArray(100) }
  ];

  for (const mode of modes) {
    for (const testCase of testCases) {
      const result = testAccuracy(mode, testCase.name, testCase.value);
      accuracyResults.push(result);
    }
  }

  printAccuracyResults(accuracyResults);

  // Summary
  const fastResult = perfResults.find(r => r.mode === 'fast')!;
  const _accurateResult = perfResults.find(r => r.mode === 'accurate')!;

  console.log('=== SUMMARY ===');
  console.log(`\nFast mode achieved ${fastResult.speedupVsAccurate.toFixed(2)}x speedup over accurate mode`);
  console.log(`Performance improvement: ${((fastResult.speedupVsAccurate - 1) * 100).toFixed(0)}%`);

  const fastAccuracy = accuracyResults.filter(r => r.mode === 'fast');
  const passRate = (fastAccuracy.filter(r => r.withinBounds).length / fastAccuracy.length) * 100;
  console.log(`Accuracy pass rate: ${passRate.toFixed(0)}% (within 50-200% bounds)`);

  console.log('\nRecommendation:');
  if (fastResult.speedupVsAccurate >= 2.0 && passRate >= 80) {
    console.log('✓ Fast mode meets performance targets (2-5x speedup) and accuracy requirements');
    console.log('✓ Recommended for production use as default mode');
  } else if (fastResult.speedupVsAccurate >= 1.5) {
    console.log('⚠ Fast mode shows improvement but may need tuning');
  } else {
    console.log('✗ Fast mode does not meet performance targets');
  }

  console.log('\n');
}

// Run benchmarks if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { main as runBenchmark };
