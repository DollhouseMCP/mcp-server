#!/usr/bin/env tsx
/**
 * Compare calibration results between local and CI environments
 *
 * Usage: npm run calibration:compare
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CalibrationResults, CalibrationComparison, BenchmarkDifference, ComparisonSummary } from './types.js';

async function main(): Promise<void> {
  console.log('=== DollhouseMCP Calibration Comparison ===\n');

  const resultsDir = path.join(process.cwd(), 'calibration-results');

  // Load results
  const localPath = path.join(resultsDir, 'local-results.json');
  const ciPath = path.join(resultsDir, 'ci-ubuntu-results.json');

  if (!fs.existsSync(localPath)) {
    console.error(`Error: Local results not found at ${localPath}`);
    console.error('Run: npm run calibration:local');
    process.exit(1);
  }

  if (!fs.existsSync(ciPath)) {
    console.error(`Error: CI results not found at ${ciPath}`);
    console.error('Run: npm run calibration:docker');
    process.exit(1);
  }

  const local: CalibrationResults = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const ci: CalibrationResults = JSON.parse(fs.readFileSync(ciPath, 'utf8'));

  // Calculate differences
  const differences: BenchmarkDifference[] = [];

  for (const localBench of local.benchmarks) {
    const ciBench = ci.benchmarks.find(b => b.name === localBench.name);
    if (!ciBench) continue;

    const percentDiff = ((localBench.operationsPerSecond - ciBench.operationsPerSecond) / ciBench.operationsPerSecond) * 100;

    differences.push({
      name: localBench.name,
      localOpsPerSec: localBench.operationsPerSecond,
      ciOpsPerSec: ciBench.operationsPerSecond,
      percentDifference: percentDiff,
      localFaster: percentDiff > 0,
    });
  }

  // Calculate summary
  const percentDiffs = differences.map(d => Math.abs(d.percentDifference));
  const summary: ComparisonSummary = {
    averagePerformanceDifference: percentDiffs.reduce((a, b) => a + b, 0) / percentDiffs.length,
    maxPerformanceDifference: Math.max(...percentDiffs),
    minPerformanceDifference: Math.min(...percentDiffs),
    significantDifferences: differences.filter(d => Math.abs(d.percentDifference) > 10).length,
  };

  const comparison: CalibrationComparison = { local, ci, differences, summary };

  // Display results
  console.log('Environment Comparison:');
  console.log(`  Local:  ${local.systemInfo.cpus} CPUs, ${local.systemInfo.totalMemoryMB} MB RAM`);
  console.log(`  CI:     ${ci.systemInfo.cpus} CPUs, ${ci.systemInfo.totalMemoryMB} MB RAM\n`);

  console.log('Benchmark Comparison:');
  console.log('─'.repeat(80));

  for (const diff of differences) {
    const arrow = diff.localFaster ? '↑' : '↓';
    const color = Math.abs(diff.percentDifference) > 10 ? '⚠️ ' : '  ';

    console.log(`${color}${diff.name}`);
    console.log(`  Local:  ${diff.localOpsPerSec.toFixed(2)} ops/sec`);
    console.log(`  CI:     ${diff.ciOpsPerSec.toFixed(2)} ops/sec`);
    console.log(`  Diff:   ${arrow} ${Math.abs(diff.percentDifference).toFixed(1)}% ${diff.localFaster ? 'faster' : 'slower'}`);
    console.log();
  }

  console.log('─'.repeat(80));
  console.log('\nSummary:');
  console.log(`  Average difference: ${summary.averagePerformanceDifference.toFixed(1)}%`);
  console.log(`  Max difference:     ${summary.maxPerformanceDifference.toFixed(1)}%`);
  console.log(`  Min difference:     ${summary.minPerformanceDifference.toFixed(1)}%`);
  console.log(`  Significant (>10%): ${summary.significantDifferences}/${differences.length}`);

  // Save comparison
  const comparisonPath = path.join(resultsDir, 'comparison.json');
  fs.writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2));
  console.log(`\nComparison saved to: ${comparisonPath}`);
}

main().catch((error) => {
  console.error('Comparison failed:', error);
  process.exit(1);
});
