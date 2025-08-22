#!/usr/bin/env node

/**
 * QA Metrics Collector for DollhouseMCP
 * 
 * Collects and analyzes performance metrics from QA test runs
 * Implements Issue #680 - Add performance metrics collection to QA tests
 * 
 * Features:
 * - Performance percentiles (P50, P95, P99)
 * - Tool discovery timing
 * - Individual test duration tracking
 * - Memory usage monitoring
 * - Historical metrics comparison
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

export class QAMetricsCollector {
  constructor(testRunId = null) {
    this.testRunId = testRunId || `METRICS_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.startTime = null;
    this.endTime = null;
    this.metrics = {
      timestamp: null,
      test_run_id: this.testRunId,
      pr_number: process.env.PR_NUMBER || null,
      commit_sha: process.env.GITHUB_SHA || null,
      branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null,
      environment: {
        ci: process.env.CI === 'true',
        node_version: process.version,
        platform: process.platform,
        test_personas_dir: process.env.TEST_PERSONAS_DIR || null,
        github_token_available: !!process.env.GITHUB_TEST_TOKEN
      },
      performance: {
        total_duration_ms: 0,
        tool_discovery_ms: 0,
        server_startup_ms: 0,
        tests: {},
        percentiles: {},
        memory_usage: {}
      },
      success_metrics: {
        total_tests: 0,
        successful_tests: 0,
        failed_tests: 0,
        skipped_tests: 0,
        success_rate: 0,
        tools_available: 0
      },
      test_details: []
    };
    
    this.testTimings = [];
    this.toolDiscoveryTiming = null;
    this.serverStartupTiming = null;
    this.memorySnapshots = [];
  }

  /**
   * Start metrics collection for the entire test run
   */
  startCollection() {
    this.startTime = Date.now();
    this.metrics.timestamp = new Date().toISOString();
    this.takeMemorySnapshot('test_start');
    console.log(`📊 Starting metrics collection for test run: ${this.testRunId}`);
  }

  /**
   * End metrics collection and calculate final statistics
   */
  endCollection() {
    this.endTime = Date.now();
    this.metrics.performance.total_duration_ms = this.endTime - this.startTime;
    this.takeMemorySnapshot('test_end');
    this.calculatePercentiles();
    this.calculateMemoryMetrics();
    console.log(`📊 Metrics collection completed (${this.metrics.performance.total_duration_ms}ms)`);
  }

  /**
   * Record tool discovery timing
   */
  recordToolDiscovery(startTime, endTime, toolCount) {
    const duration = endTime - startTime;
    this.toolDiscoveryTiming = duration;
    this.metrics.performance.tool_discovery_ms = duration;
    this.metrics.success_metrics.tools_available = toolCount;
    console.log(`📊 Tool discovery: ${duration}ms (${toolCount} tools)`);
  }

  /**
   * Record server startup timing
   */
  recordServerStartup(startTime, endTime) {
    const duration = endTime - startTime;
    this.serverStartupTiming = duration;
    this.metrics.performance.server_startup_ms = duration;
    console.log(`📊 Server startup: ${duration}ms`);
  }

  /**
   * Record individual test execution
   */
  recordTestExecution(toolName, params, startTime, endTime, success, error = null, skipped = false) {
    const duration = endTime - startTime;
    
    const testRecord = {
      tool: toolName,
      params,
      duration_ms: duration,
      success,
      error,
      skipped,
      timestamp: new Date().toISOString()
    };

    this.testTimings.push(duration);
    this.metrics.test_details.push(testRecord);
    
    // Update test categorization
    if (!this.metrics.performance.tests[toolName]) {
      this.metrics.performance.tests[toolName] = {
        executions: [],
        total_duration_ms: 0,
        avg_duration_ms: 0,
        success_count: 0,
        failure_count: 0,
        skip_count: 0
      };
    }

    const toolMetrics = this.metrics.performance.tests[toolName];
    toolMetrics.executions.push(duration);
    toolMetrics.total_duration_ms += duration;
    toolMetrics.avg_duration_ms = toolMetrics.total_duration_ms / toolMetrics.executions.length;

    if (skipped) {
      toolMetrics.skip_count++;
      this.metrics.success_metrics.skipped_tests++;
    } else if (success) {
      toolMetrics.success_count++;
      this.metrics.success_metrics.successful_tests++;
    } else {
      toolMetrics.failure_count++;
      this.metrics.success_metrics.failed_tests++;
    }

    this.metrics.success_metrics.total_tests++;
    this.metrics.success_metrics.success_rate = this.calculateSuccessRate();

    console.log(`📊 Test recorded: ${toolName} (${duration}ms, ${success ? 'SUCCESS' : skipped ? 'SKIPPED' : 'FAILED'})`);
  }

  /**
   * Take a memory usage snapshot
   */
  takeMemorySnapshot(label) {
    try {
      const memUsage = process.memoryUsage();
      const snapshot = {
        label,
        timestamp: Date.now(),
        rss: memUsage.rss,
        heap_used: memUsage.heapUsed,
        heap_total: memUsage.heapTotal,
        external: memUsage.external,
        array_buffers: memUsage.arrayBuffers || 0
      };
      this.memorySnapshots.push(snapshot);
    } catch (error) {
      console.warn(`⚠️ Failed to take memory snapshot: ${error.message}`);
    }
  }

  /**
   * Calculate performance percentiles
   */
  calculatePercentiles() {
    if (this.testTimings.length === 0) {
      this.metrics.performance.percentiles = {
        p50: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        avg: 0
      };
      return;
    }

    const sorted = [...this.testTimings].sort((a, b) => a - b);
    const len = sorted.length;

    this.metrics.performance.percentiles = {
      p50: this.getPercentile(sorted, 0.5),
      p95: this.getPercentile(sorted, 0.95),
      p99: this.getPercentile(sorted, 0.99),
      min: sorted[0],
      max: sorted[len - 1],
      avg: Math.round(sorted.reduce((sum, val) => sum + val, 0) / len),
      total_samples: len
    };

    console.log(`📊 Performance percentiles: P50=${this.metrics.performance.percentiles.p50}ms, P95=${this.metrics.performance.percentiles.p95}ms, P99=${this.metrics.performance.percentiles.p99}ms`);
  }

  /**
   * Calculate memory usage metrics
   */
  calculateMemoryMetrics() {
    if (this.memorySnapshots.length === 0) {
      return;
    }

    const rssValues = this.memorySnapshots.map(s => s.rss);
    const heapValues = this.memorySnapshots.map(s => s.heap_used);

    this.metrics.performance.memory_usage = {
      peak_rss: Math.max(...rssValues),
      min_rss: Math.min(...rssValues),
      avg_rss: Math.round(rssValues.reduce((sum, val) => sum + val, 0) / rssValues.length),
      peak_heap: Math.max(...heapValues),
      min_heap: Math.min(...heapValues),
      avg_heap: Math.round(heapValues.reduce((sum, val) => sum + val, 0) / heapValues.length),
      snapshots_count: this.memorySnapshots.length,
      detailed_snapshots: this.memorySnapshots
    };

    const peakRssMB = Math.round(this.metrics.performance.memory_usage.peak_rss / 1024 / 1024);
    const peakHeapMB = Math.round(this.metrics.performance.memory_usage.peak_heap / 1024 / 1024);
    
    console.log(`📊 Memory usage: Peak RSS=${peakRssMB}MB, Peak Heap=${peakHeapMB}MB`);
  }

  /**
   * Calculate success rate based on executed tests (excluding skipped)
   */
  calculateSuccessRate() {
    const executed = this.metrics.success_metrics.total_tests - this.metrics.success_metrics.skipped_tests;
    return executed > 0 ? Math.round((this.metrics.success_metrics.successful_tests / executed) * 100) : 0;
  }

  /**
   * Get percentile value from sorted array
   */
  getPercentile(sortedArray, percentile) {
    if (sortedArray.length === 0) return 0;
    
    const index = Math.ceil(sortedArray.length * percentile) - 1;
    return Math.round(sortedArray[Math.max(0, index)]);
  }

  /**
   * Generate comprehensive metrics report
   */
  generateReport() {
    // Ensure metrics directory exists
    const metricsDir = 'docs/QA/metrics';
    mkdirSync(metricsDir, { recursive: true });

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const filename = `qa-metrics-${timestamp}.json`;
    const filepath = resolve(metricsDir, filename);

    // Add performance insights (wrapped in try-catch to ensure metrics save isn't blocked)
    try {
      this.metrics.insights = this.generateInsights();
    } catch (error) {
      console.warn('⚠️  Failed to generate insights:', error.message);
      this.metrics.insights = [];
    }

    try {
      writeFileSync(filepath, JSON.stringify(this.metrics, null, 2));
      
      console.log('\n📊 QA Metrics Summary:');
      console.log(`   Test Run ID: ${this.testRunId}`);
      console.log(`   Total Duration: ${this.metrics.performance.total_duration_ms}ms`);
      console.log(`   Tool Discovery: ${this.metrics.performance.tool_discovery_ms}ms`);
      console.log(`   Server Startup: ${this.metrics.performance.server_startup_ms}ms`);
      console.log(`   Total Tests: ${this.metrics.success_metrics.total_tests}`);
      console.log(`   Success Rate: ${this.metrics.success_metrics.success_rate}%`);
      console.log(`   Tools Available: ${this.metrics.success_metrics.tools_available}`);
      console.log(`   Performance P50: ${this.metrics.performance.percentiles.p50}ms`);
      console.log(`   Performance P95: ${this.metrics.performance.percentiles.p95}ms`);
      console.log(`   Performance P99: ${this.metrics.performance.percentiles.p99}ms`);
      console.log(`   Peak Memory: ${Math.round(this.metrics.performance.memory_usage.peak_rss / 1024 / 1024)}MB`);
      console.log(`   Metrics Report: ${filepath}`);

      return { filepath, metrics: this.metrics };
    } catch (error) {
      console.error(`❌ Failed to write metrics report: ${error.message}`);
      return { filepath: null, metrics: this.metrics };
    }
  }

  /**
   * Generate performance insights based on collected metrics
   */
  generateInsights() {
    const insights = [];

    // Performance insights
    const p95 = this.metrics.performance.percentiles.p95;
    if (p95 > 5000) {
      insights.push({
        type: 'performance',
        severity: 'high',
        message: `P95 response time is ${p95}ms, indicating potential performance issues`,
        recommendation: 'Investigate slow operations and consider performance optimization'
      });
    } else if (p95 > 2000) {
      insights.push({
        type: 'performance',
        severity: 'medium',
        message: `P95 response time is ${p95}ms, slightly above optimal`,
        recommendation: 'Monitor for performance regression trends'
      });
    }

    // Success rate insights
    const successRate = this.metrics.success_metrics.success_rate;
    if (successRate < 80) {
      insights.push({
        type: 'reliability',
        severity: 'high',
        message: `Success rate is ${successRate}%, indicating reliability issues`,
        recommendation: 'Investigate failed tests and improve error handling'
      });
    } else if (successRate < 95) {
      insights.push({
        type: 'reliability',
        severity: 'medium',
        message: `Success rate is ${successRate}%, could be improved`,
        recommendation: 'Review failing tests for potential improvements'
      });
    }

    // Tool availability insights
    const toolsAvailable = this.metrics.success_metrics.tools_available;
    if (toolsAvailable === 0) {
      insights.push({
        type: 'infrastructure',
        severity: 'critical',
        message: 'No tools discovered, indicating server connectivity issues',
        recommendation: 'Check MCP server startup and tool discovery process'
      });
    } else if (toolsAvailable < 40) {
      insights.push({
        type: 'infrastructure',
        severity: 'medium',
        message: `Only ${toolsAvailable} tools discovered, expected ~42`,
        recommendation: 'Verify all tools are properly registered'
      });
    }

    // Memory insights
    if (this.metrics.performance.memory_usage.peak_rss) {
      const peakMemoryMB = Math.round(this.metrics.performance.memory_usage.peak_rss / 1024 / 1024);
      if (peakMemoryMB > 500) {
        insights.push({
          type: 'memory',
          severity: 'medium',
          message: `Peak memory usage is ${peakMemoryMB}MB, higher than expected`,
          recommendation: 'Monitor for memory leaks and consider optimization'
        });
      }
    }

    return insights;
  }

  /**
   * Load historical metrics for comparison
   */
  async loadHistoricalMetrics(count = 10) {
    const metricsDir = 'docs/QA/metrics';
    if (!existsSync(metricsDir)) {
      return [];
    }

    try {
      const fs = await import('fs/promises');
      const files = await fs.readdir(metricsDir);
      const metricsFiles = files
        .filter(f => f.startsWith('qa-metrics-') && f.endsWith('.json'))
        .sort()
        .slice(-count);

      const historical = [];
      for (const file of metricsFiles) {
        try {
          const content = await fs.readFile(resolve(metricsDir, file), 'utf8');
          const metrics = JSON.parse(content);
          historical.push(metrics);
        } catch (error) {
          console.warn(`⚠️ Failed to load historical metrics from ${file}: ${error.message}`);
        }
      }

      return historical;
    } catch (error) {
      console.warn(`⚠️ Failed to load historical metrics: ${error.message}`);
      return [];
    }
  }

  /**
   * Compare current metrics with historical data
   */
  async generateTrendAnalysis() {
    const historical = await this.loadHistoricalMetrics();
    if (historical.length === 0) {
      return { trend: 'no_data', message: 'No historical data available for comparison' };
    }

    const currentP95 = this.metrics.performance.percentiles.p95;
    const currentSuccessRate = this.metrics.success_metrics.success_rate;
    
    const historicalP95s = historical.map(h => h.performance?.percentiles?.p95 || 0).filter(p => p > 0);
    const historicalSuccessRates = historical.map(h => h.success_metrics?.success_rate || 0);

    const avgHistoricalP95 = historicalP95s.length > 0 ? 
      historicalP95s.reduce((sum, val) => sum + val, 0) / historicalP95s.length : 0;
    const avgHistoricalSuccessRate = historicalSuccessRates.length > 0 ? 
      historicalSuccessRates.reduce((sum, val) => sum + val, 0) / historicalSuccessRates.length : 0;

    const analysis = {
      current: {
        p95: currentP95,
        success_rate: currentSuccessRate
      },
      historical_average: {
        p95: Math.round(avgHistoricalP95),
        success_rate: Math.round(avgHistoricalSuccessRate)
      },
      trends: {
        performance: this.calculateTrend(currentP95, avgHistoricalP95, 'lower_is_better'),
        reliability: this.calculateTrend(currentSuccessRate, avgHistoricalSuccessRate, 'higher_is_better')
      },
      samples_count: historical.length
    };

    return analysis;
  }

  /**
   * Calculate trend direction
   */
  calculateTrend(current, historical, direction) {
    if (historical === 0) return 'no_data';
    
    const percentChange = ((current - historical) / historical) * 100;
    const threshold = 5; // 5% change threshold
    
    if (Math.abs(percentChange) < threshold) {
      return 'stable';
    }
    
    if (direction === 'lower_is_better') {
      return percentChange < 0 ? 'improving' : 'degrading';
    } else {
      return percentChange > 0 ? 'improving' : 'degrading';
    }
  }
}

/**
 * Utility function to create a metrics collector with timing wrapper
 */
export function createTimedOperation(metricsCollector, toolName, params = {}) {
  return {
    async execute(operation) {
      const startTime = Date.now();
      let result, error = null, success = false, skipped = false;
      
      try {
        result = await operation();
        success = result?.success !== false;
        skipped = result?.skipped === true;
        
        return result;
      } catch (err) {
        error = err.message;
        success = false;
        throw err;
      } finally {
        const endTime = Date.now();
        metricsCollector.recordTestExecution(toolName, params, startTime, endTime, success, error, skipped);
      }
    }
  };
}

/**
 * Convenience function to wrap existing test methods with metrics collection
 */
export function withMetrics(metricsCollector, testRunner) {
  const originalCallTool = testRunner.callTool;
  
  if (originalCallTool) {
    testRunner.callTool = async function(toolName, params = {}) {
      const startTime = Date.now();
      let result, error = null, success = false, skipped = false;
      
      try {
        result = await originalCallTool.call(this, toolName, params);
        success = result?.success !== false;
        skipped = result?.skipped === true;
        
        return result;
      } catch (err) {
        error = err.message;
        success = false;
        throw err;
      } finally {
        const endTime = Date.now();
        metricsCollector.recordTestExecution(toolName, params, startTime, endTime, success, error, skipped);
      }
    };
  }
  
  return testRunner;
}

export default QAMetricsCollector;