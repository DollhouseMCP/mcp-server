/**
 * Comprehensive Performance Monitoring System
 * Tracks search times, memory usage, cache performance, and system metrics
 */

import { logger } from './logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface PerformanceMetrics {
  searchTimes: number[];
  memoryUsage: MemoryUsage[];
  cacheStats: CachePerformance;
  systemStats: SystemStats;
  timestamp: Date;
}

export interface MemoryUsage {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  timestamp: Date;
}

export interface CachePerformance {
  hitRate: number;
  avgHitTime: number;
  avgMissTime: number;
  totalHits: number;
  totalMisses: number;
  evictions: number;
}

export interface SystemStats {
  cpuUsage: number;
  loadAverage: number[];
  freeMemory: number;
  totalMemory: number;
  uptime: number;
}

export interface SearchMetrics {
  query: string;
  duration: number;
  resultCount: number;
  sources: string[];
  cacheHit: boolean;
  memoryBefore: number;
  memoryAfter: number;
  timestamp: Date;
}

export interface SlowQuery {
  query: string;
  duration: number;
  threshold: number;
  sources: string[];
  resultCount: number;
  memoryUsage: number;
  timestamp: Date;
}

export class PerformanceMonitor {
  private static instance: PerformanceMonitor | null = null;

  private searchMetrics: SearchMetrics[] = [];
  private slowQueries: SlowQuery[] = [];
  private memorySnapshots: MemoryUsage[] = [];
  private cacheMetrics: Map<string, CachePerformance> = new Map();

  // Configuration
  private readonly maxMetricsHistory = 1000;
  private readonly slowQueryThreshold = 100; // ms
  private readonly memorySnapshotInterval = 30000; // 30 seconds
  private readonly maxSlowQueries = 100;

  // Timers and intervals
  private memoryMonitorInterval?: NodeJS.Timeout;
  private isMonitoring = false;

  private constructor() {
    this.startMemoryMonitoring();
  }

  public static getInstance(): PerformanceMonitor {
    if (!this.instance) {
      this.instance = new PerformanceMonitor();
    }
    return this.instance;
  }

  /**
   * Start performance monitoring
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.startMemoryMonitoring();
    
    logger.info('Performance monitoring started', {
      slowQueryThreshold: this.slowQueryThreshold,
      maxMetricsHistory: this.maxMetricsHistory
    });
  }

  /**
   * Stop performance monitoring
   */
  stopMonitoring(): void {
    this.isMonitoring = false;
    
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = undefined;
    }

    logger.info('Performance monitoring stopped');
  }

  /**
   * Record search performance metrics
   */
  recordSearch(metrics: SearchMetrics): void {
    if (!this.isMonitoring) {
      return;
    }

    // Normalize query string to prevent Unicode-based attacks
    const validationResult = UnicodeValidator.normalize(metrics.query);
    const normalizedMetrics = {
      ...metrics,
      query: validationResult.normalizedContent
    };

    this.searchMetrics.push(normalizedMetrics);

    // Check if it's a slow query (use normalized metrics)
    if (normalizedMetrics.duration > this.slowQueryThreshold) {
      this.recordSlowQuery({
        query: normalizedMetrics.query,
        duration: normalizedMetrics.duration,
        threshold: this.slowQueryThreshold,
        sources: normalizedMetrics.sources,
        resultCount: normalizedMetrics.resultCount,
        memoryUsage: normalizedMetrics.memoryAfter,
        timestamp: normalizedMetrics.timestamp
      });
    }

    // Trim history if needed
    if (this.searchMetrics.length > this.maxMetricsHistory) {
      this.searchMetrics = this.searchMetrics.slice(-this.maxMetricsHistory);
    }

    // Log significant performance events (use normalized metrics)
    if (normalizedMetrics.duration > this.slowQueryThreshold * 2) {
      logger.warn('Very slow search detected', {
        query: normalizedMetrics.query.substring(0, 50),
        duration: normalizedMetrics.duration,
        resultCount: normalizedMetrics.resultCount,
        sources: normalizedMetrics.sources
      });
    }
  }

  /**
   * Record cache performance metrics
   */
  recordCachePerformance(cacheName: string, stats: CachePerformance): void {
    if (!this.isMonitoring) {
      return;
    }

    // Normalize cache name to prevent Unicode-based attacks
    const validationResult = UnicodeValidator.normalize(cacheName);
    const normalizedCacheName = validationResult.normalizedContent;

    this.cacheMetrics.set(normalizedCacheName, stats);

    // Log cache performance warnings (use normalized cache name)
    if (stats.hitRate < 0.5) {
      logger.warn('Low cache hit rate detected', {
        cache: normalizedCacheName,
        hitRate: stats.hitRate,
        totalOperations: stats.totalHits + stats.totalMisses
      });
    }
  }

  /**
   * Get comprehensive performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return {
      searchTimes: this.searchMetrics.map(m => m.duration),
      memoryUsage: this.memorySnapshots.slice(-100), // Last 100 snapshots
      cacheStats: this.aggregateCacheStats(),
      systemStats: this.getSystemStats(),
      timestamp: new Date()
    };
  }

  /**
   * Get search performance statistics
   */
  getSearchStats(): {
    totalSearches: number;
    averageTime: number;
    medianTime: number;
    p95Time: number;
    p99Time: number;
    slowQueries: number;
    cacheHitRate: number;
  } {
    if (this.searchMetrics.length === 0) {
      return {
        totalSearches: 0,
        averageTime: 0,
        medianTime: 0,
        p95Time: 0,
        p99Time: 0,
        slowQueries: 0,
        cacheHitRate: 0
      };
    }

    const times = this.searchMetrics.map(m => m.duration).sort((a, b) => a - b);
    const cacheHits = this.searchMetrics.filter(m => m.cacheHit).length;

    return {
      totalSearches: this.searchMetrics.length,
      averageTime: times.reduce((sum, time) => sum + time, 0) / times.length,
      medianTime: times[Math.floor(times.length / 2)],
      p95Time: times[Math.floor(times.length * 0.95)],
      p99Time: times[Math.floor(times.length * 0.99)],
      slowQueries: this.slowQueries.length,
      cacheHitRate: cacheHits / this.searchMetrics.length
    };
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats(): {
    currentUsage: MemoryUsage;
    peakUsage: MemoryUsage;
    averageUsage: MemoryUsage;
    growthRate: number; // MB per minute
  } {
    if (this.memorySnapshots.length === 0) {
      const current = this.takeMemorySnapshot();
      return {
        currentUsage: current,
        peakUsage: current,
        averageUsage: current,
        growthRate: 0
      };
    }

    const current = this.memorySnapshots[this.memorySnapshots.length - 1];
    const peak = this.memorySnapshots.reduce((max, snapshot) => 
      snapshot.heapUsed > max.heapUsed ? snapshot : max
    );

    const totalHeap = this.memorySnapshots.reduce((sum, snapshot) => sum + snapshot.heapUsed, 0);
    const totalRss = this.memorySnapshots.reduce((sum, snapshot) => sum + snapshot.rss, 0);
    const average: MemoryUsage = {
      heapUsed: totalHeap / this.memorySnapshots.length,
      heapTotal: this.memorySnapshots.reduce((sum, s) => sum + s.heapTotal, 0) / this.memorySnapshots.length,
      rss: totalRss / this.memorySnapshots.length,
      external: this.memorySnapshots.reduce((sum, s) => sum + s.external, 0) / this.memorySnapshots.length,
      timestamp: new Date()
    };

    // Calculate growth rate (MB per minute)
    let growthRate = 0;
    if (this.memorySnapshots.length > 1) {
      const oldest = this.memorySnapshots[0];
      const timeDiff = (current.timestamp.getTime() - oldest.timestamp.getTime()) / 60000; // minutes
      const memoryDiff = (current.heapUsed - oldest.heapUsed) / (1024 * 1024); // MB
      growthRate = timeDiff > 0 ? memoryDiff / timeDiff : 0;
    }

    return {
      currentUsage: current,
      peakUsage: peak,
      averageUsage: average,
      growthRate
    };
  }

  /**
   * Get slow queries with analysis
   */
  getSlowQueries(limit: number = 10): SlowQuery[] {
    return this.slowQueries
      .sort((a, b) => b.duration - a.duration)
      .slice(0, limit);
  }

  /**
   * Analyze performance trends
   */
  analyzeTrends(): {
    performanceTrend: 'improving' | 'degrading' | 'stable';
    memoryTrend: 'growing' | 'shrinking' | 'stable';
    recommendations: string[];
  } {
    const recommendations: string[] = [];
    
    // Analyze search performance trend
    let performanceTrend: 'improving' | 'degrading' | 'stable' = 'stable';
    if (this.searchMetrics.length > 10) {
      const recent = this.searchMetrics.slice(-10).map(m => m.duration);
      const older = this.searchMetrics.slice(-20, -10).map(m => m.duration);
      
      if (recent.length > 0 && older.length > 0) {
        const recentAvg = recent.reduce((sum, t) => sum + t, 0) / recent.length;
        const olderAvg = older.reduce((sum, t) => sum + t, 0) / older.length;
        
        if (recentAvg > olderAvg * 1.2) {
          performanceTrend = 'degrading';
          recommendations.push('Search performance is degrading. Consider cache optimization or index rebuilding.');
        } else if (recentAvg < olderAvg * 0.8) {
          performanceTrend = 'improving';
        }
      }
    }

    // Analyze memory trend
    const memoryStats = this.getMemoryStats();
    let memoryTrend: 'growing' | 'shrinking' | 'stable' = 'stable';
    
    if (memoryStats.growthRate > 1) { // Growing by more than 1MB/minute
      memoryTrend = 'growing';
      recommendations.push('Memory usage is growing rapidly. Consider cache cleanup or memory limits.');
    } else if (memoryStats.growthRate < -1) {
      memoryTrend = 'shrinking';
    }

    // Cache performance recommendations
    const cacheStats = this.aggregateCacheStats();
    if (cacheStats.hitRate < 0.6) {
      recommendations.push('Cache hit rate is low. Consider adjusting cache size or TTL settings.');
    }

    // Slow query recommendations
    if (this.slowQueries.length > 10) {
      recommendations.push('Multiple slow queries detected. Consider query optimization or increased caching.');
    }

    return {
      performanceTrend,
      memoryTrend,
      recommendations
    };
  }

  /**
   * Reset all performance metrics
   */
  reset(): void {
    this.searchMetrics = [];
    this.slowQueries = [];
    this.memorySnapshots = [];
    this.cacheMetrics.clear();
    
    logger.info('Performance metrics reset');
  }

  /**
   * Export metrics for external analysis
   */
  exportMetrics(): string {
    const data = {
      searchMetrics: this.searchMetrics,
      slowQueries: this.slowQueries,
      memorySnapshots: this.memorySnapshots,
      cacheMetrics: Object.fromEntries(this.cacheMetrics),
      exportTimestamp: new Date().toISOString()
    };

    return JSON.stringify(data, null, 2);
  }

  // Private methods

  private recordSlowQuery(query: SlowQuery): void {
    this.slowQueries.push(query);

    // Trim slow queries history
    if (this.slowQueries.length > this.maxSlowQueries) {
      this.slowQueries = this.slowQueries.slice(-this.maxSlowQueries);
    }
  }

  private startMemoryMonitoring(): void {
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
    }

    this.memoryMonitorInterval = setInterval(() => {
      if (this.isMonitoring) {
        const snapshot = this.takeMemorySnapshot();
        this.memorySnapshots.push(snapshot);

        // Trim memory snapshots (keep last 200)
        if (this.memorySnapshots.length > 200) {
          this.memorySnapshots = this.memorySnapshots.slice(-200);
        }
      }
    }, this.memorySnapshotInterval);
  }

  private takeMemorySnapshot(): MemoryUsage {
    const memUsage = process.memoryUsage();
    return {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
      timestamp: new Date()
    };
  }

  private aggregateCacheStats(): CachePerformance {
    if (this.cacheMetrics.size === 0) {
      return {
        hitRate: 0,
        avgHitTime: 0,
        avgMissTime: 0,
        totalHits: 0,
        totalMisses: 0,
        evictions: 0
      };
    }

    let totalHits = 0;
    let totalMisses = 0;
    let totalEvictions = 0;
    let weightedHitTime = 0;
    let weightedMissTime = 0;

    for (const stats of this.cacheMetrics.values()) {
      totalHits += stats.totalHits;
      totalMisses += stats.totalMisses;
      totalEvictions += stats.evictions;
      weightedHitTime += stats.avgHitTime * stats.totalHits;
      weightedMissTime += stats.avgMissTime * stats.totalMisses;
    }

    return {
      hitRate: totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0,
      avgHitTime: totalHits > 0 ? weightedHitTime / totalHits : 0,
      avgMissTime: totalMisses > 0 ? weightedMissTime / totalMisses : 0,
      totalHits,
      totalMisses,
      evictions: totalEvictions
    };
  }

  private getSystemStats(): SystemStats {
    const os = require('os');
    
    return {
      cpuUsage: process.cpuUsage().user / 1000000, // Convert to seconds
      loadAverage: os.loadavg(),
      freeMemory: os.freemem(),
      totalMemory: os.totalmem(),
      uptime: process.uptime()
    };
  }
}