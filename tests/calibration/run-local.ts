#!/usr/bin/env tsx
/**
 * Run calibration benchmarks locally
 *
 * Usage: npm run calibration:local
 */

import * as fs from 'fs';
import * as path from 'path';
import { CalibrationBenchmark } from './CalibrationBenchmark.js';

async function main(): Promise<void> {
  console.log('=== DollhouseMCP Performance Calibration ===');
  console.log('Environment: Local (unconstrained)\n');

  const benchmark = new CalibrationBenchmark();

  try {
    const results = await benchmark.runAll();

    // Save results
    const outputDir = path.join(process.cwd(), 'calibration-results');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, 'local-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

    console.log('\n=== Results ===');
    console.log(`System: ${results.systemInfo.platform} ${results.systemInfo.arch}`);
    console.log(`CPUs: ${results.systemInfo.cpus}`);
    console.log(`Memory: ${results.systemInfo.totalMemoryMB} MB`);
    console.log(`Node: ${results.systemInfo.nodeVersion}\n`);

    for (const bench of results.benchmarks) {
      console.log(`${bench.name}:`);
      console.log(`  Operations/sec: ${bench.operationsPerSecond.toFixed(2)}`);
      console.log(`  Mean time: ${bench.meanTimeMs.toFixed(2)} ms`);
      console.log(`  Min/Max: ${bench.minTimeMs.toFixed(2)} / ${bench.maxTimeMs.toFixed(2)} ms`);
      console.log();
    }

    console.log(`Results saved to: ${outputPath}`);
  } finally {
    benchmark.cleanup();
  }
}

main().catch((error) => {
  console.error('Calibration failed:', error);
  process.exit(1);
});
