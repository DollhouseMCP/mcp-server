/**
 * Server startup utilities including migration
 */

import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';
import { MigrationManager } from '../portfolio/MigrationManager.js';
import { MemoryManager } from '../elements/memories/MemoryManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { logger } from '../utils/logger.js';
import { OperationalTelemetry } from '../telemetry/OperationalTelemetry.js';
import { VERSION } from '../constants/version.js';
import type { AutoLoadMetrics } from '../telemetry/types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

export interface StartupOptions {
  skipMigration?: boolean;
  autoBackup?: boolean;
}

export class ServerStartup {
  private portfolioManager: PortfolioManager;
  private migrationManager: MigrationManager;
  
  constructor() {
    this.portfolioManager = PortfolioManager.getInstance();
    this.migrationManager = new MigrationManager(this.portfolioManager);
  }
  
  /**
   * Initialize server with migration check
   */
  async initialize(options: StartupOptions = {}): Promise<void> {
    logger.info('[ServerStartup] Initializing server...');
    
    // Check if migration is needed
    if (!options.skipMigration) {
      const needsMigration = await this.migrationManager.needsMigration();
      
      if (needsMigration) {
        logger.info('[ServerStartup] Legacy personas detected. Starting migration...');
        
        const result = await this.migrationManager.migrate({ 
          backup: options.autoBackup !== false // Default to true
        });
        
        if (result.success) {
          logger.info(`[ServerStartup] Successfully migrated ${result.migratedCount} personas`);
          if (result.backedUp && result.backupPath) {
            logger.info(`[ServerStartup] Backup created at: ${result.backupPath}`);
          }
        } else {
          logger.error('[ServerStartup] Migration completed with errors:');
          result.errors.forEach(err => logger.error(`[ServerStartup]   - ${err}`));
        }
      }
    }
    
    // Ensure portfolio structure exists
    const portfolioExists = await this.portfolioManager.exists();
    if (!portfolioExists) {
      logger.info('[ServerStartup] Creating portfolio directory structure...');
      await this.portfolioManager.initialize();
    }
    
    // Log portfolio statistics
    const stats = await this.portfolioManager.getStatistics();
    logger.info('[ServerStartup] Portfolio statistics:');
    Object.entries(stats).forEach(([type, count]) => {
      if (count > 0) {
        logger.info(`[ServerStartup]   - ${type}: ${count} elements`);
      }
    });

    // Issue #1430: Load and report auto-load memories
    await this.initializeAutoLoadMemories();
  }

  /**
   * Initialize auto-load memories
   * Issue #1430: Automatically load baseline memories on server startup
   * @private
   */
  private async initializeAutoLoadMemories(): Promise<void> {
    const startTime = Date.now();
    let totalTokens = 0;
    let loadedCount = 0;
    let skippedCount = 0;
    let warningCount = 0;
    const emergencyDisabled = process.env.DOLLHOUSE_DISABLE_AUTOLOAD === 'true';

    try {
      // FIX: DMCP-SEC-006 - Add audit logging for security operations
      // Check for emergency disable
      if (emergencyDisabled) {
        logger.info('[ServerStartup] Auto-load disabled via DOLLHOUSE_DISABLE_AUTOLOAD');
        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_LOADED',
          severity: 'LOW',
          source: 'ServerStartup.initializeAutoLoadMemories',
          details: 'Auto-load memories disabled via emergency environment variable',
          additionalData: { reason: 'DOLLHOUSE_DISABLE_AUTOLOAD=true' }
        });
        return;
      }

      // Check if auto-load is enabled in config
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      const config = configManager.getConfig();

      if (!config.autoLoad.enabled) {
        logger.debug('[ServerStartup] Auto-load memories disabled in configuration');
        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_LOADED',
          severity: 'LOW',
          source: 'ServerStartup.initializeAutoLoadMemories',
          details: 'Auto-load memories disabled in configuration',
          additionalData: { reason: 'config.autoLoad.enabled=false' }
        });
        return;
      }

      const memoryManager = new MemoryManager();

      // Issue #1430: Install seed memories before loading auto-load memories
      // This ensures baseline knowledge is available on first run
      await memoryManager.installSeedMemories();

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      if (autoLoadMemories.length === 0) {
        logger.debug('[ServerStartup] No auto-load memories configured');
        return;
      }

      // Recommended thresholds (soft warnings)
      const LARGE_MEMORY_WARN = 5000;
      const VERY_LARGE_MEMORY_WARN = 10000;

      // User-configured limits (hard enforcement if set)
      // VALIDATION: Ensure maxTokenBudget is always > 0 (minimum 100 tokens)
      const totalBudget = Math.max(100, config.autoLoad.maxTokenBudget || 5000);
      const singleLimit = config.autoLoad.maxSingleMemoryTokens; // undefined = no limit
      const suppressWarnings = config.autoLoad.suppressLargeMemoryWarnings || false;

      for (const memory of autoLoadMemories) {
        // FIX: DMCP-SEC-004 - Normalize Unicode in user input to prevent homograph attacks
        const normalizedName = UnicodeValidator.normalize(memory.metadata.name);
        const memoryName = normalizedName.normalizedContent;

        const estimatedTokens = memoryManager.estimateTokens(memory.content || '');

        // Soft warning for large memories (doesn't block)
        if (!suppressWarnings && estimatedTokens > VERY_LARGE_MEMORY_WARN) {
          logger.warn(
            `[ServerStartup] Memory '${memoryName}' is very large ` +
            `(~${estimatedTokens} tokens, recommended: ${VERY_LARGE_MEMORY_WARN}). ` +
            `This may impact startup time.`
          );
          warningCount++;
        } else if (!suppressWarnings && estimatedTokens > LARGE_MEMORY_WARN) {
          logger.info(
            `[ServerStartup] Memory '${memoryName}' is large ` +
            `(~${estimatedTokens} tokens).`
          );
          warningCount++;
        }

        // Hard enforcement: User-configured single memory limit (if set)
        if (singleLimit !== undefined && estimatedTokens > singleLimit) {
          logger.info(
            `[ServerStartup] Skipping '${memoryName}' - ` +
            `exceeds configured single memory limit (${estimatedTokens} > ${singleLimit} tokens)`
          );
          skippedCount++;
          continue;
        }

        // Hard enforcement: Total budget
        if (totalTokens + estimatedTokens > totalBudget) {
          const remaining = autoLoadMemories.length - loadedCount;
          logger.info(
            `[ServerStartup] Token budget reached (${totalTokens}/${totalBudget} tokens). ` +
            `Loaded ${loadedCount} memories, skipping remaining ${remaining}.`
          );
          skippedCount += remaining;
          break;
        }

        // Load the memory
        totalTokens += estimatedTokens;
        loadedCount++;

        // FIX: DMCP-SEC-006 - Audit log each loaded memory
        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_LOADED',
          severity: 'LOW',
          source: 'ServerStartup.initializeAutoLoadMemories',
          details: `Auto-loaded memory: ${memoryName}`,
          additionalData: {
            memoryName,
            estimatedTokens,
            priority: memory.metadata.priority,
            totalTokensSoFar: totalTokens
          }
        });
      }

      logger.info(
        `[ServerStartup] Auto-load complete: ${loadedCount} memories loaded ` +
        `(~${totalTokens} tokens), ${skippedCount} skipped, ${warningCount} warnings`
      );

      // FIX: DMCP-SEC-006 - Audit log successful completion
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOADED',
        severity: 'LOW',
        source: 'ServerStartup.initializeAutoLoadMemories',
        details: 'Auto-load memories completed successfully',
        additionalData: {
          loadedCount,
          skippedCount,
          warningCount,
          totalTokens,
          loadTimeMs: Date.now() - startTime
        }
      });
    } catch (error) {
      // ENHANCED ERROR HANDLING: Issue #1430
      // Don't fail startup if auto-load fails, but provide detailed diagnostics
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorType = error instanceof Error ? error.constructor.name : 'Unknown';

      logger.warn(
        `[ServerStartup] Failed to load auto-load memories (${errorType}): ${errorMessage}`
      );

      // Provide helpful recovery suggestions based on error type
      if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
        logger.info('[ServerStartup] Tip: Memory files may not exist yet. They will be created on first use.');
      } else if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
        logger.warn('[ServerStartup] Tip: Check file permissions for ~/.dollhouse/portfolio/memories/');
      } else if (errorMessage.includes('YAML') || errorMessage.includes('parse')) {
        logger.warn('[ServerStartup] Tip: Check YAML syntax in memory files. Use dollhouse validate to diagnose.');
      }

      // Record error in telemetry for diagnostics
      loadedCount = 0;
      totalTokens = 0;

      // FIX: DMCP-SEC-006 - Audit log auto-load failure
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOAD_FAILED',
        severity: 'MEDIUM',
        source: 'ServerStartup.initializeAutoLoadMemories',
        details: `Auto-load memories failed: ${errorType} - ${errorMessage}`,
        additionalData: {
          errorType,
          errorMessage,
          loadTimeMs: Date.now() - startTime
        }
      });
    } finally {
      // Record telemetry
      const metrics: AutoLoadMetrics = {
        timestamp: new Date().toISOString(),
        version: VERSION,
        memoryCount: loadedCount,
        totalTokens,
        loadTimeMs: Date.now() - startTime,
        skippedCount,
        warningCount,
        budgetExceeded: skippedCount > 0,
        emergencyDisabled
      };

      await OperationalTelemetry.recordAutoLoadMetrics(metrics);
    }
  }
  
  /**
   * Get migration status without performing migration
   */
  async getMigrationStatus() {
    return await this.migrationManager.getMigrationStatus();
  }
  
  /**
   * Get the personas directory path for legacy compatibility
   */
  getPersonasDir(): string {
    return this.portfolioManager.getElementDir(ElementType.PERSONA);
  }
}