/**
 * CalibrationBenchmark - MVP Benchmark Suite
 *
 * Minimal viable benchmark suite with 3 core benchmarks:
 * 1. String operations (sanitization-like)
 * 2. File read operations
 * 3. JSON operations
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BenchmarkResult, CalibrationResults, SystemInfo } from './types.js';

export class CalibrationBenchmark {
  private tempDir: string;

  constructor() {
    try {
      this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-'));
    } catch (error) {
      console.error('Failed to create temporary directory:', error);
      throw new Error(`CalibrationBenchmark initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Run all benchmarks and return results
   */
  async runAll(): Promise<CalibrationResults> {
    const benchmarks: BenchmarkResult[] = [];

    console.log('Running string operations benchmark...');
    benchmarks.push(await this.benchmarkStringOperations());

    console.log('Running file read benchmark...');
    benchmarks.push(await this.benchmarkFileReads());

    console.log('Running JSON operations benchmark...');
    benchmarks.push(await this.benchmarkJsonOperations());

    return {
      environment: process.env.CALIBRATION_ENV || 'local',
      timestamp: new Date().toISOString(),
      systemInfo: this.getSystemInfo(),
      benchmarks,
    };
  }

  /**
   * Benchmark 1: String operations (sanitization-like)
   */
  private async benchmarkStringOperations(): Promise<BenchmarkResult> {
    const iterations = 10000;
    const samples: number[] = [];

    for (let i = 0; i < 5; i++) {
      const start = performance.now();

      for (let j = 0; j < iterations; j++) {
        const testString = `test-string-${j}-with-special-chars-!@#$%^&*()`;
        // Simulate sanitization operations
        testString.toLowerCase();
        testString.replace(/[^a-z0-9-]/g, '');
        testString.trim();
        testString.split('-').join('_');
      }

      const end = performance.now();
      samples.push(end - start);
    }

    return this.calculateBenchmarkResult('String Operations', samples, iterations);
  }

  /**
   * Benchmark 2: File read operations
   */
  private async benchmarkFileReads(): Promise<BenchmarkResult> {
    // Create test files
    const testFiles: string[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const filePath = path.join(this.tempDir, `test-${i}.txt`);
        const content = 'test content '.repeat(1000);
        fs.writeFileSync(filePath, content, 'utf8');
        testFiles.push(filePath);
      }
    } catch (error) {
      console.error('Failed to create test files:', error);
      throw new Error(`File benchmark setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const iterations = 100;
    const samples: number[] = [];

    for (let i = 0; i < 5; i++) {
      const start = performance.now();

      for (let j = 0; j < iterations; j++) {
        for (const filePath of testFiles) {
          fs.readFileSync(filePath, 'utf8');
        }
      }

      const end = performance.now();
      samples.push(end - start);
    }

    // Cleanup
    try {
      testFiles.forEach(f => fs.unlinkSync(f));
    } catch (error) {
      console.warn('Failed to cleanup test files:', error);
    }

    return this.calculateBenchmarkResult('File Read Operations', samples, iterations * testFiles.length);
  }

  /**
   * Benchmark 3: JSON operations
   */
  private async benchmarkJsonOperations(): Promise<BenchmarkResult> {
    const testData = {
      name: 'test-element',
      description: 'Test element description',
      metadata: {
        author: 'test-user',
        version: '1.0.0',
        tags: ['test', 'benchmark', 'performance'],
      },
      content: 'Test content '.repeat(100),
    };

    const iterations = 10000;
    const samples: number[] = [];

    for (let i = 0; i < 5; i++) {
      const start = performance.now();

      for (let j = 0; j < iterations; j++) {
        const serialized = JSON.stringify(testData);
        JSON.parse(serialized);
      }

      const end = performance.now();
      samples.push(end - start);
    }

    return this.calculateBenchmarkResult('JSON Operations', samples, iterations);
  }

  /**
   * Calculate benchmark statistics from samples
   */
  private calculateBenchmarkResult(name: string, samples: number[], operations: number): BenchmarkResult {
    const meanTimeMs = samples.reduce((a, b) => a + b, 0) / samples.length;
    const minTimeMs = Math.min(...samples);
    const maxTimeMs = Math.max(...samples);

    // Calculate standard deviation
    const variance = samples.reduce((sum, sample) => sum + Math.pow(sample - meanTimeMs, 2), 0) / samples.length;
    const stdDevMs = Math.sqrt(variance);

    const operationsPerSecond = (operations / meanTimeMs) * 1000;

    return {
      name,
      operationsPerSecond,
      meanTimeMs,
      minTimeMs,
      maxTimeMs,
      stdDevMs,
      samples: samples.length,
    };
  }

  /**
   * Get system information
   */
  private getSystemInfo(): SystemInfo {
    const cpuCountFromCpus = os.cpus().length;
    const cpuCountFromParallelism =
      typeof (os as unknown as { availableParallelism?: () => number }).availableParallelism === 'function'
        ? (os as unknown as { availableParallelism: () => number }).availableParallelism()
        : cpuCountFromCpus;

    const cpuCount = cpuCountFromCpus > 0 ? cpuCountFromCpus : (cpuCountFromParallelism > 0 ? cpuCountFromParallelism : 1);

    return {
      platform: os.platform(),
      arch: os.arch(),
      cpus: cpuCount,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
      nodeVersion: process.version,
      dockerConstrained: process.env.DOCKER_CONSTRAINED === 'true',
    };
  }

  /**
   * Cleanup temporary files
   */
  cleanup(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true });
      }
    } catch (error) {
      console.warn('Failed to cleanup temporary directory:', error);
    }
  }
}
