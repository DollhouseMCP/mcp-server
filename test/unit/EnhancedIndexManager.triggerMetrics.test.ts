/**
 * Tests for trigger usage metrics functionality in EnhancedIndexManager
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EnhancedIndexManager } from '../../src/portfolio/EnhancedIndexManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('EnhancedIndexManager - Trigger Metrics', () => {
  let tempDir: string;
  let indexPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enhanced-index-test-'));
    indexPath = path.join(tempDir, '.dollhouse', 'portfolio', 'capability-index.yaml');

    // Mock environment
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    // Reset singleton instance
    (EnhancedIndexManager as any).instance = null;
  });

  afterEach(async () => {
    // Restore environment
    process.env.HOME = originalHome;

    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Reset singleton
    (EnhancedIndexManager as any).instance = null;
  });

  describe('trackTriggerUsage', () => {
    it('should track trigger usage when getElementsByAction is called', async () => {
      const manager = EnhancedIndexManager.getInstance();

      // Build initial index
      await manager.rebuild();

      // Call getElementsByAction multiple times
      await manager.getElementsByAction('debug');
      await manager.getElementsByAction('debug');
      await manager.getElementsByAction('test');

      // Get metrics
      const metrics = await manager.getTriggerMetrics();

      // Find the debug metric
      const debugMetric = metrics.find(m => m.trigger === 'debug');
      const testMetric = metrics.find(m => m.trigger === 'test');

      expect(debugMetric).toBeDefined();
      expect(debugMetric?.usage_count).toBe(2);
      expect(testMetric).toBeDefined();
      expect(testMetric?.usage_count).toBe(1);
    });

    it('should persist trigger metrics across instance reloads', async () => {
      let manager = EnhancedIndexManager.getInstance();

      // Build initial index and track usage
      await manager.rebuild();
      await manager.getElementsByAction('analyze');
      await manager.getElementsByAction('analyze');
      await manager.getElementsByAction('analyze');

      // Reset instance to force reload from disk
      (EnhancedIndexManager as any).instance = null;
      manager = EnhancedIndexManager.getInstance();

      // Get metrics from new instance
      const metrics = await manager.getTriggerMetrics();
      const analyzeMetric = metrics.find(m => m.trigger === 'analyze');

      expect(analyzeMetric).toBeDefined();
      expect(analyzeMetric?.usage_count).toBe(3);
    });

    it('should track daily usage patterns', async () => {
      const manager = EnhancedIndexManager.getInstance();
      await manager.rebuild();

      // Track usage
      await manager.getElementsByAction('create');

      // Get metrics
      const metrics = await manager.getTriggerMetrics();
      const createMetric = metrics.find(m => m.trigger === 'create');

      expect(createMetric).toBeDefined();
      expect(createMetric?.daily_average).toBeGreaterThan(0);
      expect(createMetric?.first_used).toBeDefined();
      expect(createMetric?.last_used).toBeDefined();
    });

    it('should calculate usage trends', async () => {
      const manager = EnhancedIndexManager.getInstance();
      await manager.rebuild();

      // Track usage multiple times
      for (let i = 0; i < 5; i++) {
        await manager.getElementsByAction('optimize');
      }

      // Get metrics
      const metrics = await manager.getTriggerMetrics();
      const optimizeMetric = metrics.find(m => m.trigger === 'optimize');

      expect(optimizeMetric).toBeDefined();
      expect(optimizeMetric?.trend).toBeDefined();
      expect(['increasing', 'stable', 'decreasing']).toContain(optimizeMetric?.trend);
    });

    it('should sort triggers by usage frequency', async () => {
      const manager = EnhancedIndexManager.getInstance();
      await manager.rebuild();

      // Create usage pattern
      await manager.getElementsByAction('common');
      await manager.getElementsByAction('common');
      await manager.getElementsByAction('common');
      await manager.getElementsByAction('medium');
      await manager.getElementsByAction('medium');
      await manager.getElementsByAction('rare');

      // Get metrics
      const metrics = await manager.getTriggerMetrics();

      // Verify sorting
      const indices = {
        common: metrics.findIndex(m => m.trigger === 'common'),
        medium: metrics.findIndex(m => m.trigger === 'medium'),
        rare: metrics.findIndex(m => m.trigger === 'rare')
      };

      // Common should come before medium, medium before rare
      if (indices.common !== -1 && indices.medium !== -1) {
        expect(indices.common).toBeLessThan(indices.medium);
      }
      if (indices.medium !== -1 && indices.rare !== -1) {
        expect(indices.medium).toBeLessThan(indices.rare);
      }
    });

    it('should handle metrics when no usage data exists', async () => {
      const manager = EnhancedIndexManager.getInstance();
      await manager.rebuild();

      // Get metrics without any usage
      const metrics = await manager.getTriggerMetrics();

      // Should return empty array or array with 0 counts
      expect(metrics).toBeDefined();
      expect(Array.isArray(metrics)).toBe(true);
    });

    it('should clean up old daily usage data (>30 days)', async () => {
      const manager = EnhancedIndexManager.getInstance();
      await manager.rebuild();

      // Manually inject old usage data (this would normally require mocking date)
      const index = await (manager as any).getIndex();

      if (!index.metadata.trigger_metrics) {
        index.metadata.trigger_metrics = {
          usage_count: {},
          last_used: {},
          first_used: {},
          daily_usage: {}
        };
      }

      // Add old date entry
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 35);
      const oldDateStr = oldDate.toISOString().split('T')[0];
      index.metadata.trigger_metrics.daily_usage[oldDateStr] = { test: 5 };

      // Add recent date entry
      const recentDate = new Date();
      const recentDateStr = recentDate.toISOString().split('T')[0];
      index.metadata.trigger_metrics.daily_usage[recentDateStr] = { test: 3 };

      // Save index
      await (manager as any).writeToFile(index);

      // Trigger cleanup by tracking new usage
      await manager.getElementsByAction('test');

      // Reload and check
      const updatedIndex = await (manager as any).getIndex();
      const dailyUsage = updatedIndex.metadata.trigger_metrics.daily_usage;

      // Old date should be removed
      expect(dailyUsage[oldDateStr]).toBeUndefined();
      // Recent date should remain
      expect(dailyUsage[recentDateStr]).toBeDefined();
    });
  });

  describe('getTriggerMetrics', () => {
    it('should return empty array when no metrics exist', async () => {
      const manager = EnhancedIndexManager.getInstance();
      await manager.rebuild();

      const metrics = await manager.getTriggerMetrics();
      expect(metrics).toEqual([]);
    });

    it('should include all required fields in metrics', async () => {
      const manager = EnhancedIndexManager.getInstance();
      await manager.rebuild();

      await manager.getElementsByAction('validate');

      const metrics = await manager.getTriggerMetrics();
      const validateMetric = metrics.find(m => m.trigger === 'validate');

      expect(validateMetric).toBeDefined();
      expect(validateMetric).toHaveProperty('trigger');
      expect(validateMetric).toHaveProperty('usage_count');
      expect(validateMetric).toHaveProperty('last_used');
      expect(validateMetric).toHaveProperty('first_used');
      expect(validateMetric).toHaveProperty('daily_average');
      expect(validateMetric).toHaveProperty('trend');
    });
  });
});