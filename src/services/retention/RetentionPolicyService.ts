/**
 * RetentionPolicyService - Generic retention policy enforcement (Issue #51)
 *
 * This service manages retention policies across ALL element types, ensuring that:
 * 1. Nothing is auto-deleted without explicit user consent
 * 2. Users have full visibility into what would be deleted
 * 3. Each element type can have its own retention strategy
 * 4. Compliance use cases (legal, GDPR, etc.) are supported when enabled
 *
 * IMPORTANT: Retention enforcement is DISABLED by default.
 * Users must explicitly enable it in config.yml if they want automatic cleanup.
 *
 * Architecture:
 * - This service is element-type agnostic
 * - Element-specific logic is delegated to IRetentionStrategy implementations
 * - Strategies are registered per element type
 * - Designed to support 50+ element types
 *
 * @module RetentionPolicyService
 */

import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { ConfigManager, RetentionPolicyConfig } from '../../config/ConfigManager.js';
import { ElementType } from '../../portfolio/types.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import {
  IRetentionStrategy,
  IRetainableItem,
  ElementRetentionConfig,
  RetentionEnforcementResult,
  RetentionSummary,
  RetentionCheckResult,
  EnforcementOptions,
} from './types.js';

/**
 * Generic retention policy service supporting multiple element types
 */
export class RetentionPolicyService {
  private configManager: ConfigManager;
  private strategies: Map<string, IRetentionStrategy> = new Map();

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  /**
   * Register a retention strategy for an element type
   * Call this during DI setup for each element type that supports retention
   */
  public registerStrategy(strategy: IRetentionStrategy): void {
    const typeKey = this.normalizeElementType(strategy.elementType);
    this.strategies.set(typeKey, strategy);
    logger.debug(`[RetentionPolicyService] Registered strategy for ${typeKey}`);
  }

  /**
   * Get the strategy for an element type
   */
  public getStrategy(elementType: ElementType | string): IRetentionStrategy | undefined {
    return this.strategies.get(this.normalizeElementType(elementType));
  }

  /**
   * Get registered element types
   */
  public getRegisteredTypes(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Get the global retention policy configuration
   */
  public getGlobalConfig(): RetentionPolicyConfig {
    return this.configManager.getConfig().retentionPolicy;
  }

  /**
   * Get retention configuration for a specific element type
   * Merges global defaults with any type-specific overrides
   */
  public getElementConfig(elementType: ElementType | string): ElementRetentionConfig {
    const global = this.getGlobalConfig();
    // Note: typeKey will be used for per-element-type config overrides in future
    const _typeKey = this.normalizeElementType(elementType);

    // Base configuration from global settings
    const config: ElementRetentionConfig = {
      enabled: global.enabled,
      defaultTtlDays: global.defaults.ttl_days,
      maxItems: global.defaults.max_entries,
      enforcementMode: global.enforcement_mode as ElementRetentionConfig['enforcementMode'],
      allowPinning: true, // Allow pinning by default
    };

    // Type-specific overrides will be added here
    // e.g., from config.retentionPolicy.elementTypes[_typeKey]

    return config;
  }

  /**
   * Check if retention enforcement is globally enabled
   */
  public isEnabled(): boolean {
    return this.getGlobalConfig().enabled === true;
  }

  /**
   * Check if enforcement should happen on load for a given element type
   */
  public shouldEnforceOnLoad(elementType?: ElementType | string): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    const config = elementType
      ? this.getElementConfig(elementType)
      : { enforcementMode: this.getGlobalConfig().enforcement_mode };

    return config.enforcementMode === 'on_load';
  }

  /**
   * Check if enforcement requires confirmation
   */
  public requiresConfirmation(): boolean {
    return this.getGlobalConfig().safety.require_confirmation;
  }

  /**
   * Check if dry run should be performed first
   */
  public shouldDryRunFirst(): boolean {
    return this.getGlobalConfig().safety.dry_run_first;
  }

  /**
   * Check items for retention status without modifying anything
   * Works with any element type that has a registered strategy
   */
  public checkItems<T extends IRetainableItem>(
    elementType: ElementType | string,
    items: Map<string, T>
  ): RetentionSummary {
    const config = this.getElementConfig(elementType);
    const typeKey = this.normalizeElementType(elementType);
    const strategy = this.strategies.get(typeKey);

    const summary: RetentionSummary = {
      expiringSoon: [],
      alreadyExpired: [],
      countsByType: {
        [typeKey]: { total: items.size, expiringSoon: 0, expired: 0 }
      }
    };

    if (!strategy) {
      logger.warn(`[RetentionPolicyService] No strategy registered for ${typeKey}`);
      return summary;
    }

    // Note: warning_threshold_days is used by strategies in their checkItem implementation
    for (const [id, item] of items) {
      const result = strategy.checkItem(item, config);

      if (!result.shouldRetain && result.reason === 'expired') {
        summary.alreadyExpired.push({
          elementType: typeKey,
          itemId: id,
          contentPreview: strategy.getContentPreview(item),
          expiresAt: item.expiresAt!,
          daysOverdue: Math.abs(result.daysUntilExpiry || 0)
        });
        summary.countsByType[typeKey].expired++;
      } else if (result.reason === 'within_warning' && result.daysUntilExpiry !== undefined) {
        summary.expiringSoon.push({
          elementType: typeKey,
          itemId: id,
          contentPreview: strategy.getContentPreview(item),
          expiresAt: item.expiresAt!,
          daysUntilExpiry: result.daysUntilExpiry
        });
        summary.countsByType[typeKey].expiringSoon++;
      }
    }

    return summary;
  }

  /**
   * Preview what would be deleted (dry run)
   * Works with any element type
   */
  public preview(
    elementType: ElementType | string,
    element: unknown
  ): RetentionEnforcementResult {
    const typeKey = this.normalizeElementType(elementType);
    const strategy = this.strategies.get(typeKey);

    if (!strategy) {
      return {
        elementType: typeKey,
        success: false,
        itemsChecked: 0,
        itemsRemoved: 0,
        affectedItems: [],
        dryRun: true,
        warnings: [`No retention strategy registered for ${typeKey}`],
        timestamp: new Date()
      };
    }

    const config = this.getElementConfig(elementType);
    const items = strategy.getRetainableItems(element);
    const affectedItems: RetentionCheckResult[] = [];

    for (const [, item] of items) {
      const result = strategy.checkItem(item, config);
      if (!result.shouldRetain) {
        affectedItems.push(result);
      }
    }

    return {
      elementType: typeKey,
      success: true,
      itemsChecked: items.size,
      itemsRemoved: affectedItems.length,
      affectedItems,
      dryRun: true,
      warnings: affectedItems.length > 0
        ? [`${affectedItems.length} items would be deleted`]
        : [],
      timestamp: new Date()
    };
  }

  /**
   * Enforce retention policy on an element
   * Works with any element type that has a registered strategy
   *
   * @param elementType - The type of element (e.g., 'memory', 'agent')
   * @param element - The element instance to enforce retention on
   * @param options - Enforcement options including force, failFast, and callbacks
   * @returns Result including items checked/removed, affected items, and any warnings
   *
   * ## Partial Failure Behavior
   *
   * By default, the method continues processing after individual item removal failures:
   * - Failed items are logged and added to `result.warnings[]`
   * - Successfully removed items are counted in `result.itemsRemoved`
   * - `result.success` remains true unless all items fail
   *
   * This allows maximum cleanup even when some items cannot be removed (e.g., file locks).
   *
   * ### Atomic Mode (failFast: true)
   *
   * For scenarios requiring all-or-nothing behavior, use `options.failFast: true`:
   * - Stops immediately on first removal error
   * - Sets `result.success = false` and `result.error` with details
   * - No further items are processed after the failure
   *
   * **WARNING**: With failFast, any items removed before the failure will NOT be rolled back.
   * True transactional semantics are not supported.
   *
   * @example
   * // Default: continue on errors
   * const result = await service.enforce('memory', myMemory, { force: true });
   * if (result.warnings.length > 0) console.log('Some items failed:', result.warnings);
   *
   * @example
   * // Fail fast: stop on first error
   * const result = await service.enforce('memory', myMemory, { force: true, failFast: true });
   * if (!result.success) console.log('Failed:', result.error);
   */
  public async enforce(
    elementType: ElementType | string,
    element: unknown,
    options: EnforcementOptions = {}
  ): Promise<RetentionEnforcementResult> {
    const typeKey = this.normalizeElementType(elementType);
    const strategy = this.strategies.get(typeKey);
    const global = this.getGlobalConfig();
    const config = this.getElementConfig(elementType);

    // SECURITY: Normalize elementName user input
    const sanitizedElementName = options.elementName
      ? UnicodeValidator.normalize(options.elementName).normalizedContent
      : undefined;

    // Base result structure
    const result: RetentionEnforcementResult = {
      elementType: typeKey,
      success: true,
      itemsChecked: 0,
      itemsRemoved: 0,
      affectedItems: [],
      dryRun: false,
      warnings: [],
      timestamp: new Date()
    };

    // Check for registered strategy
    if (!strategy) {
      result.success = false;
      result.error = `No retention strategy registered for ${typeKey}`;
      return result;
    }

    // Check if retention is enabled
    if (!this.isEnabled()) {
      result.warnings.push('Retention enforcement is disabled globally. Enable in config to allow cleanup.');
      return result;
    }

    // Check enforcement mode
    if (config.enforcementMode === 'disabled') {
      result.warnings.push('Enforcement mode is "disabled". Use explicit enforcement command or change mode.');
      return result;
    }

    // Get items to check
    const items = strategy.getRetainableItems(element);
    result.itemsChecked = items.size;

    // Check each item
    const toRemove: RetentionCheckResult[] = [];
    for (const [, item] of items) {
      const checkResult = strategy.checkItem(item, config);
      if (!checkResult.shouldRetain) {
        toRemove.push(checkResult);
      }
    }

    // If dry_run_first is enabled and force is not set, return preview only
    if (global.safety.dry_run_first && !options.force) {
      result.dryRun = true;
      result.itemsRemoved = toRemove.length;
      result.affectedItems = toRemove;
      if (toRemove.length > 0) {
        result.warnings.push(
          `DRY RUN: ${toRemove.length} items would be deleted. Use force=true to actually delete.`
        );
      }
      return result;
    }

    // Perform actual removal
    for (const checkResult of toRemove) {
      try {
        // Log before deletion if auditing is enabled
        if (global.audit.log_deletions) {
          logger.info('[RetentionPolicyService] Removing expired item', {
            elementType: typeKey,
            elementName: sanitizedElementName,
            itemId: checkResult.item.id,
            reason: checkResult.reason,
            daysOverdue: checkResult.daysUntilExpiry ? Math.abs(checkResult.daysUntilExpiry) : undefined
          });
        }

        strategy.removeItem(element, checkResult.item.id);
        result.itemsRemoved++;
        result.affectedItems.push(checkResult);

        // Progress callback
        if (options.onProgress) {
          options.onProgress(result.itemsRemoved, toRemove.length);
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('[RetentionPolicyService] Failed to remove item', {
          itemId: checkResult.item.id,
          error: errorMsg
        });
        result.warnings.push(`Failed to remove item ${checkResult.item.id}: ${errorMsg}`);

        // If failFast is enabled, throw immediately on first error
        if (options.failFast) {
          result.success = false;
          result.error = `Failed to remove item ${checkResult.item.id}: ${errorMsg}`;
          throw new Error(result.error);
        }
      }
    }

    // Log security event
    if (result.itemsRemoved > 0) {
      SecurityMonitor.logSecurityEvent({
        type: 'RETENTION_POLICY_ENFORCED',
        severity: 'LOW',
        source: 'RetentionPolicyService.enforce',
        details: `Removed ${result.itemsRemoved} expired items from ${typeKey}`,
        additionalData: {
          elementType: typeKey,
          elementName: sanitizedElementName,
          itemsRemoved: result.itemsRemoved,
          enforcementMode: config.enforcementMode
        }
      });
    }

    return result;
  }

  /**
   * Get a human-readable status message about retention
   */
  public getStatusMessage(elementType?: ElementType | string): string {
    const global = this.getGlobalConfig();

    if (!global.enabled) {
      return 'Retention enforcement is DISABLED globally. No items will be automatically deleted.';
    }

    let message = `Retention enforcement is ENABLED (mode: ${global.enforcement_mode}).\n`;
    message += `\nGlobal defaults:\n`;
    message += `  - Default TTL: ${global.defaults.ttl_days} days\n`;
    message += `  - Max items: ${global.defaults.max_entries}\n`;
    message += `  - Warning threshold: ${global.safety.warning_threshold_days} days before expiry\n`;

    if (global.safety.require_confirmation) {
      message += '  - Confirmation required before deletion\n';
    }
    if (global.safety.dry_run_first) {
      message += '  - Dry run preview required before actual deletion\n';
    }
    if (global.audit.backup_before_delete) {
      message += `  - Backups kept for ${global.audit.backup_retention_days} days\n`;
    }

    const registeredTypes = this.getRegisteredTypes();
    if (registeredTypes.length > 0) {
      message += `\nRegistered element types: ${registeredTypes.join(', ')}`;
    }

    if (elementType) {
      const config = this.getElementConfig(elementType);
      message += `\n\nConfiguration for ${elementType}:\n`;
      message += `  - Enabled: ${config.enabled}\n`;
      message += `  - TTL: ${config.defaultTtlDays} days\n`;
      message += `  - Max items: ${config.maxItems}\n`;
      message += `  - Enforcement: ${config.enforcementMode}\n`;
    }

    return message;
  }

  /**
   * Normalize element type to consistent string key
   * SECURITY: Applies Unicode normalization to prevent bypass attacks
   */
  private normalizeElementType(elementType: ElementType | string): string {
    const typeStr = String(elementType);
    const normalized = UnicodeValidator.normalize(typeStr).normalizedContent;
    return normalized.toLowerCase();
  }
}
