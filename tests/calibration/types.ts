/**
 * Performance Calibration Types
 *
 * Core TypeScript interfaces for the calibration system.
 */

/**
 * Result from a single benchmark run
 */
export interface BenchmarkResult {
  name: string;
  operationsPerSecond: number;
  meanTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  stdDevMs: number;
  samples: number;
}

/**
 * Results from a complete calibration run
 */
export interface CalibrationResults {
  environment: string;
  timestamp: string;
  systemInfo: SystemInfo;
  benchmarks: BenchmarkResult[];
}

/**
 * System information captured during calibration
 */
export interface SystemInfo {
  platform: string;
  arch: string;
  cpus: number;
  totalMemoryMB: number;
  nodeVersion: string;
  dockerConstrained?: boolean;
}

/**
 * Comparison between two calibration runs
 */
export interface CalibrationComparison {
  local: CalibrationResults;
  ci: CalibrationResults;
  differences: BenchmarkDifference[];
  summary: ComparisonSummary;
}

/**
 * Difference between local and CI benchmark results
 */
export interface BenchmarkDifference {
  name: string;
  localOpsPerSec: number;
  ciOpsPerSec: number;
  percentDifference: number;
  localFaster: boolean;
}

/**
 * Summary of calibration comparison
 */
export interface ComparisonSummary {
  averagePerformanceDifference: number;
  maxPerformanceDifference: number;
  minPerformanceDifference: number;
  significantDifferences: number;
}
