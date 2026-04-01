/**
 * Server startup utilities including migration
 *
 * ARCHITECTURE NOTES - Memory Auto-Load Implementation:
 *
 * There are two valid architectural approaches for memory auto-load:
 *
 * 1. MemoryManager.loadAndActivateAutoLoadMemories() (CURRENT IMPLEMENTATION)
 *    - Auto-load logic lives in MemoryManager
 *    - Called directly from Container.preparePortfolio()
 *    - Follows DI pattern: managers own all operations for their element type
 *    - Pros: Better encapsulation, clearer ownership, no duplicated responsibility
 *    - Used by: Container.preparePortfolio() (current production approach)
 *
 * 2. ServerStartup.initializeAutoLoadMemories() (ALTERNATIVE APPROACH)
 *    - Auto-load orchestrated by ServerStartup
 *    - ServerStartup delegates to MemoryManager for actual operations
 *    - Useful for: Complex startup sequences with multiple coordinated steps
 *    - Pros: Centralizes startup concerns, easier to add cross-cutting features
 *    - Used by: This class (kept for future use and alternative workflows)
 *
 * Both approaches are valid and maintained. Choose based on your needs:
 * - Use MemoryManager directly for simple, focused auto-load
 * - Use ServerStartup for complex orchestration with multiple startup phases
 *
 * See docs/architecture/memory-autoload-architectures.md for detailed comparison.
 */

import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';
import { MigrationManager } from '../portfolio/MigrationManager.js';
import { FileLockManager } from '../security/fileLockManager.js';
import { MemoryManager } from '../elements/memories/MemoryManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { OperationalTelemetry } from '../telemetry/OperationalTelemetry.js';
import { PACKAGE_VERSION as VERSION } from '../generated/version.js';
import type { AutoLoadMetrics } from '../telemetry/types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { AutoLoadError } from '../errors/AutoLoadError.js';
import { logger } from '../utils/logger.js';

export interface StartupOptions {
  skipMigration?: boolean;
  autoBackup?: boolean;
}

export class ServerStartup {
  private portfolioManager: PortfolioManager;
  private migrationManager: MigrationManager;
  private fileLockManager: FileLockManager;
  private memoryManager: MemoryManager;
  private configManager: ConfigManager;
  private operationalTelemetry: OperationalTelemetry;

  constructor(
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    configManager: ConfigManager,
    migrationManager: MigrationManager,
    memoryManager: MemoryManager,
    operationalTelemetry: OperationalTelemetry
  ) {
    this.portfolioManager = portfolioManager;
    this.fileLockManager = fileLockManager;
    this.configManager = configManager;
    this.migrationManager = migrationManager;
    this.memoryManager = memoryManager;
    this.operationalTelemetry = operationalTelemetry;
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

    // Initialize auto-load memories
    await this.initializeAutoLoadMemories();
  }

  /**
   * Process a single auto-load memory
   * FIX (SonarCloud): Extracted to reduce cognitive complexity
   * FIX (SonarCloud): Reduced parameter count by using options object
   * @private
   */
  private async processAutoLoadMemory(
    memory: any,
    memoryManager: any,
    options: {
      totalTokens: number;
      singleLimit: number | undefined;
      totalBudget: number;
      suppressWarnings: boolean;
      totalMemories: number;
      loadedCount: number;
    }
  ): Promise<{
    skip: boolean;
    breakLoop: boolean;
    skippedCount: number;
    estimatedTokens: number;
    warnings: number;
  }> {
    try {
      // FIX: DMCP-SEC-004 - Normalize Unicode in user input to prevent homograph attacks
      const normalizedName = UnicodeValidator.normalize(memory.metadata.name);
      const memoryName = normalizedName.normalizedContent;

      // PR #1436: Validate memory before loading
      const validation = memory.validate();
      if (!validation.valid) {
        throw AutoLoadError.validationFailed(
          memoryName,
          validation.errors?.map((e: { message: string }) => e.message).join(', ') || 'Unknown validation error'
        );
      }

      const estimatedTokens = memoryManager.estimateTokens(memory.content || '');

      // Check for size warnings
      const warnings = this.checkMemorySizeWarnings(memoryName, estimatedTokens, options.suppressWarnings);

      // Check if memory should be skipped
      const skipCheck = this.shouldSkipMemory(memoryName, estimatedTokens, options.totalTokens, options.singleLimit, options.totalBudget);
      if (skipCheck.skip) {
        if (skipCheck.reason === 'budget_exceeded') {
          const remaining = options.totalMemories - options.loadedCount;
          logger.info(
            `[ServerStartup] Token budget reached (${options.totalTokens}/${options.totalBudget} tokens). ` +
            `Loaded ${options.loadedCount} memories, skipping remaining ${remaining}.`
          );
          return { skip: false, breakLoop: true, skippedCount: remaining, estimatedTokens: 0, warnings: 0 };
        }
        return { skip: true, breakLoop: false, skippedCount: 0, estimatedTokens: 0, warnings: 0 };
      }

      // FIX #1430: Activate the memory so it's available for use
      logger.info(`[ServerStartup] 🔄 Activating memory: ${memoryName}...`);
      await memory.activate();
      logger.info(`[ServerStartup] ✅ Memory activated: ${memoryName}`);

      // DMCP-SEC-006: Per-memory audit downgraded from security event to debug.
      // Was generating O(n) security events per startup where n = auto-load count,
      // causing 25x security buffer turnover. Completion summary kept as security event.
      logger.debug(`[ServerStartup] Auto-loaded: ${memoryName} (~${estimatedTokens} tokens, priority: ${memory.metadata.priority})`);

      return { skip: false, breakLoop: false, skippedCount: 0, estimatedTokens, warnings };
    } catch (error) {
      // PR #1436: Structured error handling with AutoLoadError
      this.handleAutoLoadMemoryError(error, memory);
      return { skip: true, breakLoop: false, skippedCount: 0, estimatedTokens: 0, warnings: 0 };
    }
  }

  /**
   * Handle errors during auto-load memory processing
   * FIX (SonarCloud): Extracted to reduce cognitive complexity
   * @private
   */
  private handleAutoLoadMemoryError(error: unknown, memory: any): void {
    if (error instanceof AutoLoadError) {
      logger.info(
        `[ServerStartup] Skipping '${error.memoryName}' - ` +
        `${error.phase} phase failed: ${error.message}`
      );
    } else {
      const memoryName = memory.metadata.name || 'unknown';
      logger.warn(`[ServerStartup] Unexpected error loading '${memoryName}': ${error}`);
    }
  }

  /**
   * Check and log size warnings for a memory
   * @private
   */
  private checkMemorySizeWarnings(
    memoryName: string,
    estimatedTokens: number,
    suppressWarnings: boolean
  ): number {
    const LARGE_MEMORY_WARN = 5000;
    const VERY_LARGE_MEMORY_WARN = 10000;

    if (suppressWarnings) {
      return 0;
    }

    if (estimatedTokens > VERY_LARGE_MEMORY_WARN) {
      logger.warn(
        `[ServerStartup] Memory '${memoryName}' is very large ` +
        `(~${estimatedTokens} tokens, recommended: ${VERY_LARGE_MEMORY_WARN}). ` +
        `This may impact startup time.`
      );
      return 1;
    }

    if (estimatedTokens > LARGE_MEMORY_WARN) {
      logger.info(`[ServerStartup] Memory '${memoryName}' is large (~${estimatedTokens} tokens).`);
      return 1;
    }

    return 0;
  }

  /**
   * Check if memory should be skipped due to budget limits
   * @private
   */
  private shouldSkipMemory(
    memoryName: string,
    estimatedTokens: number,
    totalTokens: number,
    singleLimit: number | undefined,
    totalBudget: number
  ): { skip: boolean; reason?: string } {
    // Check single memory limit
    if (singleLimit !== undefined && estimatedTokens > singleLimit) {
      logger.info(
        `[ServerStartup] Skipping '${memoryName}' - ` +
        `exceeds configured single memory limit (${estimatedTokens} > ${singleLimit} tokens)`
      );
      return { skip: true, reason: 'single_limit' };
    }

    // Check total budget
    if (totalTokens + estimatedTokens > totalBudget) {
      return { skip: true, reason: 'budget_exceeded' };
    }

    return { skip: false };
  }

  /**
   * Log error recovery suggestions based on error type
   * @private
   */
  private logAutoLoadErrorSuggestions(errorMessage: string): void {
    if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
      logger.info('[ServerStartup] Tip: Memory files may not exist yet. They will be created on first use.');
    } else if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
      logger.warn('[ServerStartup] Tip: Check file permissions for ~/.dollhouse/portfolio/memories/');
    } else if (errorMessage.includes('YAML') || errorMessage.includes('parse')) {
      logger.warn('[ServerStartup] Tip: Check YAML syntax in memory files. Use dollhouse validate to diagnose.');
    }
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

      // Check if auto-load is enabled in config (DI: use this.configManager)
      await this.configManager.initialize();
      const config = this.configManager.getConfig();

      if (!config.autoLoad.enabled) {
        logger.debug('[ServerStartup] Auto-load memories disabled in configuration');
        return;
      }

      // DI: use this.memoryManager instead of new MemoryManager()
      const memoryManager = this.memoryManager;

      // Issue #1430: Install seed memories before loading auto-load memories
      // This ensures baseline knowledge is available on first run
      logger.info('[ServerStartup] 🌱 Installing seed memories...');
      await memoryManager.installSeedMemories();
      logger.info('[ServerStartup] ✅ Seed installation complete');

      logger.info('[ServerStartup] 🔍 Fetching auto-load memories...');
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      logger.info(`[ServerStartup] 📋 Auto-load memories found: ${autoLoadMemories.length}`);

      if (autoLoadMemories.length === 0) {
        logger.warn('[ServerStartup] ⚠️  No auto-load memories configured - baseline knowledge may not be available');
        return;
      }

      // User-configured limits (hard enforcement if set)
      // PR #1436: Validate maxTokenBudget with bounds and user warning
      // Minimum: 100 tokens (enough for minimal baseline knowledge)
      // Maximum: 50,000 tokens (prevents excessive startup time and memory usage)
      // Default: 5,000 tokens (balanced for typical use cases)
      const configuredBudget = config.autoLoad.maxTokenBudget || 5000;
      const totalBudget = Math.max(100, Math.min(50000, configuredBudget));

      // PR #1436: Warn if configured budget was clamped to valid range
      if (configuredBudget !== totalBudget) {
        logger.warn(
          `[ServerStartup] Configured maxTokenBudget (${configuredBudget}) ` +
          `was adjusted to ${totalBudget} (valid range: 100-50,000)`
        );
      }

      const singleLimit = config.autoLoad.maxSingleMemoryTokens; // undefined = no limit
      const suppressWarnings = config.autoLoad.suppressLargeMemoryWarnings || false;

      for (const memory of autoLoadMemories) {
        const result = await this.processAutoLoadMemory(
          memory,
          memoryManager,
          {
            totalTokens,
            singleLimit,
            totalBudget,
            suppressWarnings,
            totalMemories: autoLoadMemories.length,
            loadedCount
          }
        );

        if (result.breakLoop) {
          skippedCount += result.skippedCount;
          break;
        }

        if (result.skip) {
          skippedCount++;
          continue;
        }

        totalTokens += result.estimatedTokens;
        loadedCount++;
        warningCount += result.warnings;
      }

      logger.info(
        `[ServerStartup] Auto-load complete: ${loadedCount} memories loaded ` +
        `(~${totalTokens} tokens), ${skippedCount} skipped, ${warningCount} warnings`
      );

      // Summary event — fires once per startup, keep as security event
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOADED',
        severity: 'LOW',
        source: 'ServerStartup.initializeAutoLoadMemories',
        details: `Auto-load complete: ${loadedCount} loaded, ${skippedCount} skipped`,
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
      this.logAutoLoadErrorSuggestions(errorMessage);

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

      await this.operationalTelemetry.recordAutoLoadMetrics(metrics);
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

  /**
   * Dispose of resources and cleanup
   * Cleans up managers and telemetry to prevent open handles
   */
  async dispose(): Promise<void> {
    // Dispose MemoryManager (cleans up file watchers)
    this.memoryManager.dispose();

    // Shutdown telemetry (flushes PostHog events)
    await this.operationalTelemetry.shutdown();

    logger.debug('[ServerStartup] Disposed and cleaned up resources');
  }
}
