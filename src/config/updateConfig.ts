import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger.js';

/**
 * Configuration for update system
 * Supports environment variables and XDG directories
 */
export interface UpdateConfig {
  paths: {
    backupDir: string;
    npmBackupDir: string;
    tempDir: string;
  };
  limits: {
    maxSearchDepth: number;
    maxBackupCount: number;
    maxBackupSizeMB: number;
  };
  timeouts: {
    gitCloneMs: number;
    npmInstallMs: number;
    npmUpdateMs: number;
    buildMs: number;
  };
}

export class UpdateConfigManager {
  private static instance: UpdateConfigManager | null = null;
  private config: UpdateConfig;
  
  private constructor() {
    this.config = this.loadConfiguration();
  }
  
  /**
   * Get singleton instance
   */
  static getInstance(): UpdateConfigManager {
    if (!UpdateConfigManager.instance) {
      UpdateConfigManager.instance = new UpdateConfigManager();
    }
    return UpdateConfigManager.instance;
  }
  
  /**
   * Get configuration
   */
  getConfig(): UpdateConfig {
    return this.config;
  }
  
  /**
   * Load configuration from environment and defaults
   */
  private loadConfiguration(): UpdateConfig {
    // Determine base directory (respects XDG on Linux)
    const baseDir = this.getBaseDirectory();
    
    // Load from environment or use defaults
    const config: UpdateConfig = {
      paths: {
        backupDir: process.env.DOLLHOUSE_BACKUP_DIR || 
                   path.join(baseDir, 'backups'),
        npmBackupDir: process.env.DOLLHOUSE_NPM_BACKUP_DIR || 
                      path.join(baseDir, 'backups', 'npm'),
        tempDir: process.env.DOLLHOUSE_TEMP_DIR || 
                 path.join(os.tmpdir(), 'dollhouse-update')
      },
      limits: {
        maxSearchDepth: this.parseIntEnv('DOLLHOUSE_MAX_SEARCH_DEPTH', 10),
        maxBackupCount: this.parseIntEnv('DOLLHOUSE_MAX_BACKUP_COUNT', 5),
        maxBackupSizeMB: this.parseIntEnv('DOLLHOUSE_MAX_BACKUP_SIZE_MB', 500)
      },
      timeouts: {
        gitCloneMs: this.parseIntEnv('DOLLHOUSE_GIT_CLONE_TIMEOUT_MS', 300000), // 5 minutes
        npmInstallMs: this.parseIntEnv('DOLLHOUSE_NPM_INSTALL_TIMEOUT_MS', 300000), // 5 minutes
        npmUpdateMs: this.parseIntEnv('DOLLHOUSE_NPM_UPDATE_TIMEOUT_MS', 300000), // 5 minutes
        buildMs: this.parseIntEnv('DOLLHOUSE_BUILD_TIMEOUT_MS', 120000) // 2 minutes
      }
    };
    
    logger.info('[UpdateConfig] Configuration loaded:', {
      baseDir,
      backupDir: config.paths.backupDir,
      maxSearchDepth: config.limits.maxSearchDepth
    });
    
    return config;
  }
  
  /**
   * Get base directory respecting XDG standards on Linux
   */
  private getBaseDirectory(): string {
    // Check for explicit override
    if (process.env.DOLLHOUSE_BASE_DIR) {
      return process.env.DOLLHOUSE_BASE_DIR;
    }
    
    // On Linux, respect XDG standards
    if (process.platform === 'linux') {
      const xdgDataHome = process.env.XDG_DATA_HOME;
      if (xdgDataHome) {
        return path.join(xdgDataHome, 'dollhouse');
      }
    }
    
    // Default to home directory
    return path.join(os.homedir(), '.dollhouse');
  }
  
  /**
   * Parse integer environment variable with default
   */
  private parseIntEnv(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (!value) {
      return defaultValue;
    }
    
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      logger.warn(`[UpdateConfig] Invalid integer value for ${key}: ${value}, using default: ${defaultValue}`);
      return defaultValue;
    }
    
    return parsed;
  }
  
  /**
   * Get backup directory path
   */
  getBackupDir(): string {
    return this.config.paths.backupDir;
  }
  
  /**
   * Get npm backup directory path
   */
  getNpmBackupDir(): string {
    return this.config.paths.npmBackupDir;
  }
  
  /**
   * Get temporary directory path
   */
  getTempDir(): string {
    return this.config.paths.tempDir;
  }
  
  /**
   * Get max search depth for installation detection
   */
  getMaxSearchDepth(): number {
    return this.config.limits.maxSearchDepth;
  }
  
  /**
   * Get max number of backups to keep
   */
  getMaxBackupCount(): number {
    return this.config.limits.maxBackupCount;
  }
  
  /**
   * Get timeout for git clone operations
   */
  getGitCloneTimeout(): number {
    return this.config.timeouts.gitCloneMs;
  }
  
  /**
   * Get timeout for npm install operations
   */
  getNpmInstallTimeout(): number {
    return this.config.timeouts.npmInstallMs;
  }
  
  /**
   * Get timeout for npm update operations
   */
  getNpmUpdateTimeout(): number {
    return this.config.timeouts.npmUpdateMs;
  }
  
  /**
   * Get timeout for build operations
   */
  getBuildTimeout(): number {
    return this.config.timeouts.buildMs;
  }
}