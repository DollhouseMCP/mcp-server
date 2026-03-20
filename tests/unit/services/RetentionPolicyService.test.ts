/**
 * Tests for RetentionPolicyService
 *
 * Tests for the retention policy system that manages automatic deletion
 * of expired entries across all element types (Issue #51).
 *
 * Coverage:
 * - Default disabled behavior (nothing auto-deleted without consent)
 * - Enabled behavior and enforcement modes
 * - Strategy registration and retrieval
 * - Preview/check functionality (dry-run)
 * - Safety controls (confirmation, dry-run-first)
 * - Element-specific configuration
 * - Retention enforcement
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { RetentionPolicyService } from '../../../src/services/retention/RetentionPolicyService.js';
import { MemoryRetentionStrategy } from '../../../src/services/retention/strategies/MemoryRetentionStrategy.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { ElementType } from '../../../src/portfolio/types.js';
import {
  IRetentionStrategy,
  IRetainableItem,
  ElementRetentionConfig,
  RetentionCheckResult,
} from '../../../src/services/retention/types.js';
import * as fs from 'fs/promises';
import * as os from 'os';

/**
 * Mock retention strategy for testing
 */
class MockRetentionStrategy implements IRetentionStrategy {
  readonly elementType = 'test-element';

  private items: Map<string, IRetainableItem> = new Map();

  constructor(items: IRetainableItem[] = []) {
    items.forEach(item => this.items.set(item.id, item));
  }

  getRetainableItems(_element: unknown): Map<string, IRetainableItem> {
    return this.items;
  }

  checkItem(item: IRetainableItem, _config: ElementRetentionConfig): RetentionCheckResult {
    // Simple check: expired if expiresAt is in the past
    if (!item.expiresAt) {
      return { item, shouldRetain: true, reason: 'no_expiry_set' };
    }

    const now = new Date();
    const expired = item.expiresAt < now;

    if (expired) {
      const daysOverdue = Math.ceil((now.getTime() - item.expiresAt.getTime()) / (1000 * 60 * 60 * 24));
      return { item, shouldRetain: false, reason: 'expired', daysUntilExpiry: -daysOverdue };
    }

    const daysUntilExpiry = Math.ceil((item.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const withinWarning = daysUntilExpiry <= 7;

    return {
      item,
      shouldRetain: true,
      reason: withinWarning ? 'within_warning' : 'not_expired',
      daysUntilExpiry,
    };
  }

  removeItem(_element: unknown, itemId: string): void {
    this.items.delete(itemId);
  }

  calculateExpiryDate(config: ElementRetentionConfig): Date | undefined {
    if (config.defaultTtlDays < 0) {
      return undefined;
    }
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + config.defaultTtlDays);
    return expiry;
  }

  isPinned(item: IRetainableItem): boolean {
    return item.metadata?.pinned === true;
  }

  getContentPreview(item: IRetainableItem, maxLength: number = 100): string {
    const content = item.contentPreview || '';
    return content.length <= maxLength ? content : content.substring(0, maxLength) + '...';
  }

  // Helper for tests
  setItems(items: IRetainableItem[]): void {
    this.items.clear();
    items.forEach(item => this.items.set(item.id, item));
  }
}

describe('RetentionPolicyService', () => {
  let service: RetentionPolicyService;
  let configManager: ConfigManager;
  let fileOperations: FileOperationsService;
  let testConfigDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    // Save original NODE_ENV
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    // Create temporary test directory
    testConfigDir = await fs.mkdtemp(os.tmpdir() + '/dollhouse-test-');
    process.env.TEST_CONFIG_DIR = testConfigDir;

    // Create FileOperationsService
    const fileLockManager = new FileLockManager();
    fileOperations = new FileOperationsService(fileLockManager);

    // Initialize config manager with test directory
    configManager = new ConfigManager(fileOperations, os);
    await configManager.initialize();

    // Create service
    service = new RetentionPolicyService(configManager);
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testConfigDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }

    // Restore environment
    delete process.env.TEST_CONFIG_DIR;
    if (originalEnv !== undefined) {
      process.env.NODE_ENV = originalEnv;
    } else {
      delete process.env.NODE_ENV;
    }

    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('Default Disabled Behavior', () => {
    it('should be disabled by default', () => {
      const config = service.getGlobalConfig();

      expect(config.enabled).toBe(false);
      expect(config.enforcement_mode).toBe('disabled');
    });

    it('should return false from isEnabled() when disabled', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('should return false from shouldEnforceOnLoad() when disabled', () => {
      expect(service.shouldEnforceOnLoad()).toBe(false);
      expect(service.shouldEnforceOnLoad(ElementType.MEMORY)).toBe(false);
    });

    it('should have safe defaults for safety controls', () => {
      const config = service.getGlobalConfig();

      expect(config.safety.require_confirmation).toBe(true);
      expect(config.safety.dry_run_first).toBe(true);
      expect(config.safety.warn_on_expiring).toBe(true);
      expect(config.safety.warning_threshold_days).toBe(7);
    });

    it('should have audit defaults configured', () => {
      const config = service.getGlobalConfig();

      expect(config.audit.log_deletions).toBe(true);
      expect(config.audit.backup_before_delete).toBe(true);
      expect(config.audit.backup_retention_days).toBe(30);
    });

    it('should have reasonable TTL defaults', () => {
      const config = service.getGlobalConfig();

      expect(config.defaults.ttl_days).toBe(30);
      expect(config.defaults.max_entries).toBe(1000);
    });
  });

  describe('Enabled Behavior', () => {
    beforeEach(async () => {
      // Enable retention policy
      await configManager.updateSetting('retentionPolicy.enabled', true);
      await configManager.updateSetting('retentionPolicy.enforcement_mode', 'on_load');
    });

    it('should return true from isEnabled() when enabled', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return true from shouldEnforceOnLoad() when enabled and mode is on_load', () => {
      expect(service.shouldEnforceOnLoad()).toBe(true);
      expect(service.shouldEnforceOnLoad(ElementType.MEMORY)).toBe(true);
    });

    it('should return false from shouldEnforceOnLoad() when mode is manual', async () => {
      await configManager.updateSetting('retentionPolicy.enforcement_mode', 'manual');

      expect(service.shouldEnforceOnLoad()).toBe(false);
      expect(service.shouldEnforceOnLoad(ElementType.MEMORY)).toBe(false);
    });

    it('should return false from shouldEnforceOnLoad() when mode is disabled', async () => {
      await configManager.updateSetting('retentionPolicy.enforcement_mode', 'disabled');

      expect(service.shouldEnforceOnLoad()).toBe(false);
    });

    it('should respect element-specific configuration', () => {
      const elementConfig = service.getElementConfig(ElementType.MEMORY);

      expect(elementConfig.enabled).toBe(true);
      expect(elementConfig.enforcementMode).toBe('on_load');
      expect(elementConfig.defaultTtlDays).toBe(30);
      expect(elementConfig.maxItems).toBe(1000);
      expect(elementConfig.allowPinning).toBe(true);
    });
  });

  describe('Strategy Registration', () => {
    it('should allow registering a strategy', () => {
      const strategy = new MockRetentionStrategy();

      service.registerStrategy(strategy);

      expect(service.getRegisteredTypes()).toContain('test-element');
    });

    it('should retrieve registered strategy', () => {
      const strategy = new MockRetentionStrategy();
      service.registerStrategy(strategy);

      const retrieved = service.getStrategy('test-element');

      expect(retrieved).toBe(strategy);
    });

    it('should return undefined for unregistered element type', () => {
      const retrieved = service.getStrategy('nonexistent');

      expect(retrieved).toBeUndefined();
    });

    it('should list all registered types', () => {
      const strategy1 = new MockRetentionStrategy();
      const strategy2 = new MemoryRetentionStrategy();

      service.registerStrategy(strategy1);
      service.registerStrategy(strategy2);

      const types = service.getRegisteredTypes();

      expect(types).toContain('test-element');
      expect(types).toContain('memories');
      expect(types.length).toBe(2);
    });

    it('should normalize element type case', () => {
      const strategy = new MockRetentionStrategy();
      service.registerStrategy(strategy);

      expect(service.getStrategy('test-element')).toBe(strategy);
      expect(service.getStrategy('TEST-ELEMENT')).toBe(strategy);
      expect(service.getStrategy('Test-Element')).toBe(strategy);
    });

    it('should handle ElementType enum values', () => {
      const strategy = new MemoryRetentionStrategy();
      service.registerStrategy(strategy);

      const retrieved = service.getStrategy(ElementType.MEMORY);

      expect(retrieved).toBe(strategy);
    });
  });

  describe('Preview Functionality (Dry Run)', () => {
    let mockStrategy: MockRetentionStrategy;
    let mockElement: unknown;

    beforeEach(() => {
      // Create items for testing
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const items: IRetainableItem[] = [
        {
          id: 'item-1',
          createdAt: yesterday,
          expiresAt: yesterday, // Expired
          contentPreview: 'This item is expired'
        },
        {
          id: 'item-2',
          createdAt: now,
          expiresAt: tomorrow, // Valid
          contentPreview: 'This item is valid'
        },
        {
          id: 'item-3',
          createdAt: now,
          expiresAt: undefined, // No expiry
          contentPreview: 'This item never expires'
        }
      ];

      mockStrategy = new MockRetentionStrategy(items);
      service.registerStrategy(mockStrategy);
      mockElement = {}; // Mock element (not used by mock strategy)
    });

    it('should preview without modifying data', () => {
      const result = service.preview('test-element', mockElement);

      expect(result.dryRun).toBe(true);
      expect(result.success).toBe(true);
      expect(result.itemsChecked).toBe(3);
      expect(result.itemsRemoved).toBe(1); // Only expired item
      expect(result.affectedItems).toHaveLength(1);
      expect(result.affectedItems[0].item.id).toBe('item-1');

      // Verify data wasn't modified
      const items = mockStrategy.getRetainableItems(mockElement);
      expect(items.size).toBe(3); // All items still present
    });

    it('should return empty result when no items would be deleted', () => {
      // Create strategy with only valid items
      const validItems: IRetainableItem[] = [
        {
          id: 'valid-1',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
          contentPreview: 'Valid item'
        }
      ];

      const validStrategy = new MockRetentionStrategy(validItems);
      service.registerStrategy(validStrategy);

      const result = service.preview('test-element', mockElement);

      expect(result.success).toBe(true);
      expect(result.itemsRemoved).toBe(0);
      expect(result.affectedItems).toHaveLength(0);
      expect(result.warnings).toEqual([]);
    });

    it('should return warning when items would be deleted', () => {
      const result = service.preview('test-element', mockElement);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('1 items would be deleted');
    });

    it('should handle unregistered element type', () => {
      const result = service.preview('nonexistent', mockElement);

      expect(result.success).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(result.itemsChecked).toBe(0);
      expect(result.itemsRemoved).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('No retention strategy registered');
    });
  });

  describe('Check Items Functionality', () => {
    let mockStrategy: MockRetentionStrategy;

    beforeEach(() => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const in10Days = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

      const items: IRetainableItem[] = [
        {
          id: 'expired-1',
          createdAt: yesterday,
          expiresAt: yesterday,
          contentPreview: 'Expired item 1'
        },
        {
          id: 'expiring-soon-1',
          createdAt: now,
          expiresAt: in3Days, // Within 7-day warning threshold
          contentPreview: 'Expiring soon 1'
        },
        {
          id: 'valid-1',
          createdAt: now,
          expiresAt: in10Days,
          contentPreview: 'Valid item 1'
        }
      ];

      mockStrategy = new MockRetentionStrategy(items);
      service.registerStrategy(mockStrategy);
    });

    it('should identify expired items', () => {
      const items = mockStrategy.getRetainableItems({});
      const summary = service.checkItems('test-element', items);

      expect(summary.alreadyExpired).toHaveLength(1);
      expect(summary.alreadyExpired[0].itemId).toBe('expired-1');
      expect(summary.alreadyExpired[0].daysOverdue).toBeGreaterThan(0);
    });

    it('should identify items expiring soon', () => {
      const items = mockStrategy.getRetainableItems({});
      const summary = service.checkItems('test-element', items);

      expect(summary.expiringSoon).toHaveLength(1);
      expect(summary.expiringSoon[0].itemId).toBe('expiring-soon-1');
      expect(summary.expiringSoon[0].daysUntilExpiry).toBeLessThanOrEqual(7);
      expect(summary.expiringSoon[0].daysUntilExpiry).toBeGreaterThan(0);
    });

    it('should provide counts by type', () => {
      const items = mockStrategy.getRetainableItems({});
      const summary = service.checkItems('test-element', items);

      expect(summary.countsByType['test-element']).toEqual({
        total: 3,
        expiringSoon: 1,
        expired: 1
      });
    });

    it('should handle empty item map', () => {
      const emptyItems = new Map<string, IRetainableItem>();
      const summary = service.checkItems('test-element', emptyItems);

      expect(summary.alreadyExpired).toHaveLength(0);
      expect(summary.expiringSoon).toHaveLength(0);
      expect(summary.countsByType['test-element']).toEqual({
        total: 0,
        expiringSoon: 0,
        expired: 0
      });
    });

    it('should handle unregistered strategy gracefully', () => {
      const items = new Map<string, IRetainableItem>();
      const summary = service.checkItems('nonexistent', items);

      expect(summary.alreadyExpired).toHaveLength(0);
      expect(summary.expiringSoon).toHaveLength(0);
    });
  });

  describe('Safety Controls', () => {
    it('should respect require_confirmation setting', () => {
      expect(service.requiresConfirmation()).toBe(true);
    });

    it('should return false when confirmation not required', async () => {
      await configManager.updateSetting('retentionPolicy.safety.require_confirmation', false);

      expect(service.requiresConfirmation()).toBe(false);
    });

    it('should respect dry_run_first setting', () => {
      expect(service.shouldDryRunFirst()).toBe(true);
    });

    it('should return false when dry run not required', async () => {
      await configManager.updateSetting('retentionPolicy.safety.dry_run_first', false);

      expect(service.shouldDryRunFirst()).toBe(false);
    });
  });

  describe('Enforcement', () => {
    let mockStrategy: MockRetentionStrategy;
    let mockElement: unknown;

    beforeEach(async () => {
      // Enable retention for these tests
      await configManager.updateSetting('retentionPolicy.enabled', true);
      await configManager.updateSetting('retentionPolicy.enforcement_mode', 'manual');

      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const items: IRetainableItem[] = [
        {
          id: 'expired-1',
          createdAt: yesterday,
          expiresAt: yesterday,
          contentPreview: 'Expired item'
        },
        {
          id: 'valid-1',
          createdAt: now,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          contentPreview: 'Valid item'
        }
      ];

      mockStrategy = new MockRetentionStrategy(items);
      service.registerStrategy(mockStrategy);
      mockElement = {};
    });

    it('should not enforce when retention is disabled', async () => {
      await configManager.updateSetting('retentionPolicy.enabled', false);

      const result = await service.enforce('test-element', mockElement);

      expect(result.success).toBe(true);
      expect(result.itemsRemoved).toBe(0);
      expect(result.warnings).toContain('Retention enforcement is disabled globally. Enable in config to allow cleanup.');
    });

    it('should not enforce when mode is disabled', async () => {
      await configManager.updateSetting('retentionPolicy.enforcement_mode', 'disabled');

      const result = await service.enforce('test-element', mockElement);

      expect(result.success).toBe(true);
      expect(result.itemsRemoved).toBe(0);
      expect(result.warnings).toContain('Enforcement mode is "disabled". Use explicit enforcement command or change mode.');
    });

    it('should return dry run when dry_run_first is enabled', async () => {
      await configManager.updateSetting('retentionPolicy.safety.dry_run_first', true);

      const result = await service.enforce('test-element', mockElement);

      expect(result.dryRun).toBe(true);
      expect(result.itemsRemoved).toBe(1); // Would remove 1
      expect(result.warnings[0]).toContain('DRY RUN');

      // Verify nothing was actually deleted
      const items = mockStrategy.getRetainableItems(mockElement);
      expect(items.size).toBe(2);
    });

    it('should enforce when force is true', async () => {
      await configManager.updateSetting('retentionPolicy.safety.dry_run_first', true);

      const result = await service.enforce('test-element', mockElement, { force: true });

      expect(result.dryRun).toBe(false);
      expect(result.itemsRemoved).toBe(1);
      expect(result.affectedItems).toHaveLength(1);
      expect(result.affectedItems[0].item.id).toBe('expired-1');

      // Verify item was deleted
      const items = mockStrategy.getRetainableItems(mockElement);
      expect(items.size).toBe(1);
      expect(items.has('valid-1')).toBe(true);
      expect(items.has('expired-1')).toBe(false);
    });

    it('should handle unregistered element type', async () => {
      const result = await service.enforce('nonexistent', mockElement);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No retention strategy registered');
    });

    it('should call onProgress callback', async () => {
      await configManager.updateSetting('retentionPolicy.safety.dry_run_first', false);

      const progressCalls: Array<{ processed: number; total: number }> = [];
      const onProgress = (processed: number, total: number) => {
        progressCalls.push({ processed, total });
      };

      await service.enforce('test-element', mockElement, { onProgress });

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0]).toEqual({ processed: 1, total: 1 });
    });
  });

  describe('Status Message', () => {
    it('should return disabled message when disabled', () => {
      const message = service.getStatusMessage();

      expect(message).toContain('Retention enforcement is DISABLED globally');
      expect(message).toContain('No items will be automatically deleted');
    });

    it('should return enabled message with details when enabled', async () => {
      await configManager.updateSetting('retentionPolicy.enabled', true);
      await configManager.updateSetting('retentionPolicy.enforcement_mode', 'on_load');

      const message = service.getStatusMessage();

      expect(message).toContain('Retention enforcement is ENABLED');
      expect(message).toContain('mode: on_load');
      expect(message).toContain('Default TTL: 30 days');
      expect(message).toContain('Max items: 1000');
      expect(message).toContain('Warning threshold: 7 days before expiry');
    });

    it('should include element-specific config when provided', async () => {
      await configManager.updateSetting('retentionPolicy.enabled', true);

      const message = service.getStatusMessage(ElementType.MEMORY);

      expect(message).toContain('Configuration for memories:');
      expect(message).toContain('Enabled: true');
      expect(message).toContain('TTL: 30 days');
      expect(message).toContain('Max items: 1000');
    });

    it('should list registered element types', async () => {
      await configManager.updateSetting('retentionPolicy.enabled', true);

      const strategy = new MockRetentionStrategy();
      service.registerStrategy(strategy);

      const message = service.getStatusMessage();

      expect(message).toContain('Registered element types: test-element');
    });
  });

  describe('Element Configuration', () => {
    it('should merge global config with element defaults', () => {
      const config = service.getElementConfig(ElementType.MEMORY);

      expect(config.enabled).toBe(false); // Global default
      expect(config.defaultTtlDays).toBe(30);
      expect(config.maxItems).toBe(1000);
      expect(config.enforcementMode).toBe('disabled');
      expect(config.allowPinning).toBe(true);
    });

    it('should reflect global enabled state', async () => {
      await configManager.updateSetting('retentionPolicy.enabled', true);

      const config = service.getElementConfig(ElementType.MEMORY);

      expect(config.enabled).toBe(true);
    });

    it('should reflect global enforcement mode', async () => {
      await configManager.updateSetting('retentionPolicy.enforcement_mode', 'on_load');

      const config = service.getElementConfig(ElementType.MEMORY);

      expect(config.enforcementMode).toBe('on_load');
    });

    it('should normalize element type to lowercase', () => {
      const config1 = service.getElementConfig('MEMORIES');
      const config2 = service.getElementConfig('memories');

      expect(config1).toEqual(config2);
    });
  });
});
