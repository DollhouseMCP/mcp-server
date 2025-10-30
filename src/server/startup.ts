/**
 * Server startup utilities including migration
 */

import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';
import { MigrationManager } from '../portfolio/MigrationManager.js';
import { MemoryManager } from '../elements/memories/MemoryManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { logger } from '../utils/logger.js';

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
    try {
      // Check if auto-load is enabled in config
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      const config = await configManager.getConfig();

      if (!config.autoLoad.enabled) {
        logger.debug('[ServerStartup] Auto-load memories disabled in configuration');
        return;
      }

      const memoryManager = new MemoryManager();

      // Issue #1430: Install seed memories before loading auto-load memories
      // This ensures baseline knowledge is available on first run
      await memoryManager.installSeedMemories();

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      if (autoLoadMemories.length > 0) {
        logger.info(`[ServerStartup] Auto-load memories: ${autoLoadMemories.length} baseline memories loaded`);
        autoLoadMemories.forEach((memory, index) => {
          const memoryMeta = memory.metadata as any;
          const priority = memoryMeta?.priority ?? 999;
          const name = memoryMeta?.name || 'Unnamed';
          logger.info(`[ServerStartup]   ${index + 1}. ${name} (priority: ${priority})`);
        });
      } else {
        logger.debug('[ServerStartup] No auto-load memories configured');
      }
    } catch (error) {
      // Don't fail startup if auto-load fails
      logger.warn('[ServerStartup] Failed to load auto-load memories:', error);
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