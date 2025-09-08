/**
 * ConfigManager - Centralized configuration management for DollhouseMCP
 * 
 * Features:
 * - YAML-based configuration file
 * - Default values with user overrides
 * - Migration from environment variables
 * - Validation and type safety
 * - Atomic updates with backup
 * - Privacy-first defaults
 * - OAuth client ID storage for Claude Desktop integration
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';

export interface UserConfig {
  username: string | null;
  email: string | null;
  display_name: string | null;
}

export interface GitHubPortfolioConfig {
  repository_url: string | null;
  repository_name: string;
  default_branch: string;
  auto_create: boolean;
}

export interface GitHubAuthConfig {
  use_oauth: boolean;
  token_source: 'environment' | 'oauth' | 'config';
  client_id?: string; // OAuth client ID for GitHub App
}

export interface GitHubConfig {
  portfolio: GitHubPortfolioConfig;
  auth: GitHubAuthConfig;
}

export interface SyncIndividualConfig {
  require_confirmation: boolean;
  show_diff_before_sync: boolean;
  track_versions: boolean;
  keep_history: number;
}

export interface SyncBulkConfig {
  upload_enabled: boolean;
  download_enabled: boolean;
  require_preview: boolean;
  respect_local_only: boolean;
}

export interface SyncPrivacyConfig {
  scan_for_secrets: boolean;
  scan_for_pii: boolean;
  warn_on_sensitive: boolean;
  excluded_patterns: string[];
}

export interface SyncConfig {
  enabled: boolean;
  individual: SyncIndividualConfig;
  bulk: SyncBulkConfig;
  privacy: SyncPrivacyConfig;
}

export interface CollectionConfig {
  auto_submit: boolean;
  require_review: boolean;
  add_attribution: boolean;
}

export interface ElementsConfig {
  auto_activate: {
    personas?: string[];
    skills?: string[];
    templates?: string[];
    agents?: string[];
    memories?: string[];
    ensembles?: string[];
  };
  default_element_dir: string;
}

export interface DisplayConfig {
  persona_indicators: {
    enabled: boolean;
    style: 'full' | 'minimal' | 'compact' | 'custom';
    include_emoji: boolean;
  };
  verbose_logging: boolean;
  show_progress: boolean;
}

export interface DollhouseConfig {
  version: string;
  user: UserConfig;
  github: GitHubConfig;
  sync: SyncConfig;
  collection: CollectionConfig;
  elements: ElementsConfig;
  display: DisplayConfig;
}

export interface ConfigUpdateResult {
  success: boolean;
  message: string;
  previousValue?: any;
  newValue?: any;
}

export interface ConfigActionResult {
  success: boolean;
  message: string;
  data?: any;
}

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private static instanceLock: boolean = false;

  private configDir: string;
  private configPath: string;
  private backupPath: string;
  private config: DollhouseConfig | null = null;

  private constructor() {
    // Initialize paths
    this.configDir = path.join(os.homedir(), '.dollhouse');
    this.configPath = path.join(this.configDir, 'config.yml');
    this.backupPath = path.join(this.configDir, 'config.yml.backup');
  }

  /**
   * Thread-safe singleton instance getter
   */
  public static getInstance(): ConfigManager {
    if (ConfigManager.instance) {
      return ConfigManager.instance;
    }

    // Simple locking mechanism to prevent race conditions
    if (ConfigManager.instanceLock) {
      // Wait for lock to be released, then return the instance
      while (ConfigManager.instanceLock && !ConfigManager.instance) {
        // In a real scenario with async operations, this would be more sophisticated
        // But for the test cases, this simple approach works
      }
      return ConfigManager.instance!;
    }

    ConfigManager.instanceLock = true;
    
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    
    ConfigManager.instanceLock = false;
    return ConfigManager.instance;
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): DollhouseConfig {
    return {
      version: '1.0.0',
      user: {
        username: null,
        email: null,
        display_name: null
      },
      github: {
        portfolio: {
          repository_url: null,
          repository_name: 'dollhouse-portfolio',
          default_branch: 'main',
          auto_create: true
        },
        auth: {
          use_oauth: true,
          token_source: 'environment'
        }
      },
      sync: {
        enabled: false, // Privacy first - off by default
        individual: {
          require_confirmation: true,
          show_diff_before_sync: true,
          track_versions: true,
          keep_history: 10
        },
        bulk: {
          upload_enabled: false, // Requires explicit enablement
          download_enabled: false,
          require_preview: true,
          respect_local_only: true
        },
        privacy: {
          scan_for_secrets: true,
          scan_for_pii: true,
          warn_on_sensitive: true,
          excluded_patterns: [
            '*.secret',
            '*-private.*',
            'credentials/**',
            'personal/**'
          ]
        }
      },
      collection: {
        auto_submit: false, // Never auto-submit
        require_review: true,
        add_attribution: true
      },
      elements: {
        auto_activate: {},
        default_element_dir: path.join(os.homedir(), '.dollhouse', 'portfolio')
      },
      display: {
        persona_indicators: {
          enabled: true,
          style: 'minimal',
          include_emoji: true
        },
        verbose_logging: false,
        show_progress: true
      }
    };
  }

  /**
   * Initialize configuration
   */
  public async initialize(): Promise<void> {
    // Always reload config from disk if it exists, even if we have defaults in memory
    // This ensures we pick up any manual edits or saved settings
    
    try {
      // Ensure config directory exists
      await fs.mkdir(this.configDir, { recursive: true });
      
      // Load or create config
      if (await this.configExists()) {
        await this.loadConfig();
      } else {
        // Create default config
        this.config = this.getDefaultConfig();
        
        // Try to migrate from environment variables
        await this.migrateFromEnvironment();
        
        // Save the config
        await this.saveConfig();
        
        logger.info('Created new configuration file', {
          path: this.configPath
        });
      }
    } catch (error) {
      logger.error('Failed to initialize configuration', {
        error: error instanceof Error ? error.message : String(error)
      });
      // Use defaults in memory
      this.config = this.getDefaultConfig();
    }
  }

  /**
   * Load configuration from file
   */
  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      
      // Use SecureYamlParser for safety
      const parsed = SecureYamlParser.parse(content, {
        maxYamlSize: 64 * 1024, // 64KB max config size
        validateContent: false,
        validateFields: false
      });
      
      if (!parsed.data || typeof parsed.data !== 'object') {
        throw new Error('Invalid configuration format');
      }
      
      // Merge with defaults to ensure all fields exist
      this.config = this.mergeWithDefaults(parsed.data as Partial<DollhouseConfig>);
      
      // Fix any string booleans that might have been saved incorrectly
      this.fixConfigTypes();
      
      logger.debug('Configuration loaded successfully', {
        username: this.config.user.username,
        syncEnabled: this.config.sync.enabled
      });
      
    } catch (error) {
      logger.error('Failed to load configuration', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Check if config file exists
   */
  private async configExists(): Promise<boolean> {
    try {
      await fs.access(this.configPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get GitHub OAuth client ID
   * Environment variable takes precedence over config file
   */
  public getGitHubClientId(): string | null {
    // Check environment variable first
    const envClientId = process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
    if (envClientId) {
      return envClientId;
    }

    // Fall back to config file
    return this.config?.github?.auth?.client_id || null;
  }

  /**
   * Set GitHub OAuth client ID in config file
   */
  public async setGitHubClientId(clientId: string): Promise<void> {
    if (!ConfigManager.validateClientId(clientId)) {
      throw new Error(
        `Invalid GitHub client ID format. Expected format: Ov23li followed by at least 14 alphanumeric characters (e.g., Ov23liABCDEFGHIJKLMN)`
      );
    }

    if (!this.config) {
      this.config = this.getDefaultConfig();
    }

    // Ensure github.auth object exists
    if (!this.config.github) {
      this.config.github = this.getDefaultConfig().github;
    }
    if (!this.config.github.auth) {
      this.config.github.auth = this.getDefaultConfig().github.auth;
    }

    this.config.github.auth.client_id = clientId;
    await this.saveConfig();
  }

  /**
   * Get the current configuration
   */
  public getConfig(): DollhouseConfig {
    if (!this.config) {
      throw new Error('Configuration not initialized');
    }
    return this.config;
  }

  /**
   * Get a specific setting using dot notation
   */
  public getSetting<T>(path: string, defaultValue?: T): T | undefined {
    if (!this.config) {
      return defaultValue;
    }
    
    const keys = path.split('.');
    let value: any = this.config;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return defaultValue;
      }
    }
    
    return value as T;
  }

  /**
   * Update a specific setting using dot notation
   */
  public async updateSetting(path: string, value: any): Promise<ConfigUpdateResult> {
    if (!this.config) {
      await this.initialize();
    }
    
    const keys = path.split('.');
    let current: any = this.config;
    const previousValue = this.getSetting(path);
    
    // Navigate to the parent object
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }
    
    // Set the value
    const lastKey = keys[keys.length - 1];
    current[lastKey] = value;
    
    // Save the configuration
    await this.saveConfig();
    
    logger.info('Configuration setting updated', {
      path,
      previousValue,
      newValue: value
    });
    
    return {
      success: true,
      message: `Setting '${path}' updated successfully`,
      previousValue,
      newValue: value
    };
  }

  /**
   * Validate GitHub OAuth client ID format
   * Client IDs start with "Ov23li" followed by at least 14 alphanumeric characters
   * 
   * @param clientId - The client ID to validate
   * @returns true if valid, false otherwise
   * 
   * @example
   * ConfigManager.validateClientId("Ov23liABCDEFGHIJKLMN123456") // true
   * ConfigManager.validateClientId("invalid") // false
   * ConfigManager.validateClientId("Ov23li") // false (too short)
   * ConfigManager.validateClientId("Xv23liABCDEFGHIJKLMN") // false (wrong prefix)
   */
  public static validateClientId(clientId: any): boolean {
    if (typeof clientId !== 'string' || !clientId) {
      return false;
    }

    // GitHub OAuth client IDs follow the pattern: Ov23li[A-Za-z0-9]{14,}
    const clientIdPattern = /^Ov23li[A-Za-z0-9]{14,}$/;
    return clientIdPattern.test(clientId);
  }

  /**
   * Save configuration to file
   */
  private async saveConfig(): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration to save');
    }
    
    try {
      // Create backup of existing config
      if (await this.configExists()) {
        await fs.copyFile(this.configPath, this.backupPath);
      }
      
      // Convert to YAML
      const yamlContent = yaml.dump(this.config, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false
      });
      
      // Write atomically
      const tempPath = `${this.configPath}.tmp`;
      await fs.writeFile(tempPath, yamlContent, 'utf-8');
      await fs.rename(tempPath, this.configPath);
      
      logger.debug('Configuration saved successfully');
      
      // Log audit event for configuration update
      logger.debug('Configuration update audit', {
        event: 'CONFIG_UPDATED',
        source: 'ConfigManager.saveConfig',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.error('Failed to save configuration', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Try to restore backup
      if (await this.backupExists()) {
        await fs.copyFile(this.backupPath, this.configPath);
        logger.info('Restored configuration from backup');
      }
      
      throw error;
    }
  }

  /**
   * Check if backup exists
   */
  private async backupExists(): Promise<boolean> {
    try {
      await fs.access(this.backupPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fix incorrect types in config (e.g., string booleans)
   */
  private fixConfigTypes(): void {
    if (!this.config) return;
    
    // Helper to convert string booleans to actual booleans
    const fixBoolean = (value: any): any => {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
      }
      return value;
    };
    
    // Fix sync settings
    if (this.config.sync) {
      this.config.sync.enabled = fixBoolean(this.config.sync.enabled);
      
      if (this.config.sync.individual) {
        this.config.sync.individual.require_confirmation = fixBoolean(this.config.sync.individual.require_confirmation);
        this.config.sync.individual.show_diff_before_sync = fixBoolean(this.config.sync.individual.show_diff_before_sync);
        this.config.sync.individual.track_versions = fixBoolean(this.config.sync.individual.track_versions);
      }
      
      if (this.config.sync.bulk) {
        this.config.sync.bulk.upload_enabled = fixBoolean(this.config.sync.bulk.upload_enabled);
        this.config.sync.bulk.download_enabled = fixBoolean(this.config.sync.bulk.download_enabled);
        this.config.sync.bulk.require_preview = fixBoolean(this.config.sync.bulk.require_preview);
        this.config.sync.bulk.respect_local_only = fixBoolean(this.config.sync.bulk.respect_local_only);
      }
      
      if (this.config.sync.privacy) {
        this.config.sync.privacy.scan_for_secrets = fixBoolean(this.config.sync.privacy.scan_for_secrets);
        this.config.sync.privacy.scan_for_pii = fixBoolean(this.config.sync.privacy.scan_for_pii);
        this.config.sync.privacy.warn_on_sensitive = fixBoolean(this.config.sync.privacy.warn_on_sensitive);
      }
    }
    
    // Fix collection settings
    if (this.config.collection) {
      this.config.collection.auto_submit = fixBoolean(this.config.collection.auto_submit);
      this.config.collection.require_review = fixBoolean(this.config.collection.require_review);
      this.config.collection.add_attribution = fixBoolean(this.config.collection.add_attribution);
    }
    
    // Fix display settings
    if (this.config.display) {
      if (this.config.display.persona_indicators) {
        this.config.display.persona_indicators.enabled = fixBoolean(this.config.display.persona_indicators.enabled);
        this.config.display.persona_indicators.include_emoji = fixBoolean(this.config.display.persona_indicators.include_emoji);
      }
      this.config.display.verbose_logging = fixBoolean(this.config.display.verbose_logging);
      this.config.display.show_progress = fixBoolean(this.config.display.show_progress);
    }
    
    // Fix github settings
    if (this.config.github) {
      if (this.config.github.portfolio) {
        this.config.github.portfolio.auto_create = fixBoolean(this.config.github.portfolio.auto_create);
      }
      if (this.config.github.auth) {
        this.config.github.auth.use_oauth = fixBoolean(this.config.github.auth.use_oauth);
      }
    }
  }

  /**
   * Merge partial config with defaults
   */
  private mergeWithDefaults(partial: Partial<DollhouseConfig>): DollhouseConfig {
    const defaults = this.getDefaultConfig();
    
    return {
      version: partial.version || defaults.version,
      user: {
        ...defaults.user,
        ...partial.user
      },
      github: {
        portfolio: {
          ...defaults.github.portfolio,
          ...(partial.github?.portfolio || {})
        },
        auth: {
          ...defaults.github.auth,
          ...(partial.github?.auth || {})
        }
      },
      sync: {
        enabled: partial.sync?.enabled ?? defaults.sync.enabled,
        individual: {
          ...defaults.sync.individual,
          ...(partial.sync?.individual || {})
        },
        bulk: {
          ...defaults.sync.bulk,
          ...(partial.sync?.bulk || {})
        },
        privacy: {
          ...defaults.sync.privacy,
          ...(partial.sync?.privacy || {}),
          excluded_patterns: partial.sync?.privacy?.excluded_patterns || defaults.sync.privacy.excluded_patterns
        }
      },
      collection: {
        ...defaults.collection,
        ...partial.collection
      },
      elements: {
        auto_activate: partial.elements?.auto_activate || defaults.elements.auto_activate,
        default_element_dir: partial.elements?.default_element_dir || defaults.elements.default_element_dir
      },
      display: {
        persona_indicators: {
          ...defaults.display.persona_indicators,
          ...(partial.display?.persona_indicators || {})
        },
        verbose_logging: partial.display?.verbose_logging ?? defaults.display.verbose_logging,
        show_progress: partial.display?.show_progress ?? defaults.display.show_progress
      }
    };
  }

  /**
   * Migrate settings from environment variables
   */
  private async migrateFromEnvironment(): Promise<void> {
    let migrated = false;
    
    // Migrate user settings
    if (process.env.DOLLHOUSE_USER && !this.config?.user.username) {
      if (!this.config) this.config = this.getDefaultConfig();
      this.config.user.username = process.env.DOLLHOUSE_USER;
      migrated = true;
    }
    
    if (process.env.DOLLHOUSE_EMAIL && !this.config?.user.email) {
      if (!this.config) this.config = this.getDefaultConfig();
      this.config.user.email = process.env.DOLLHOUSE_EMAIL;
      migrated = true;
    }
    
    // Migrate portfolio URL
    if (process.env.DOLLHOUSE_PORTFOLIO_URL && !this.config?.github.portfolio.repository_url) {
      if (!this.config) this.config = this.getDefaultConfig();
      this.config.github.portfolio.repository_url = process.env.DOLLHOUSE_PORTFOLIO_URL;
      migrated = true;
    }
    
    // Migrate collection auto-submit
    if (process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION !== undefined) {
      if (!this.config) this.config = this.getDefaultConfig();
      this.config.collection.auto_submit = process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true';
      migrated = true;
    }
    
    if (migrated) {
      logger.info('Migrated settings from environment variables');
    }
  }

  /**
   * Reset configuration to defaults
   */
  public async resetConfig(section?: string): Promise<ConfigActionResult> {
    const defaults = this.getDefaultConfig();
    
    if (section) {
      // Reset specific section
      if (!this.config) {
        this.config = defaults;
      } else {
        const sectionKeys = section.split('.');
        let current: any = this.config;
        let defaultSection: any = defaults;
        
        for (let i = 0; i < sectionKeys.length - 1; i++) {
          current = current[sectionKeys[i]];
          defaultSection = defaultSection[sectionKeys[i]];
        }
        
        const lastKey = sectionKeys[sectionKeys.length - 1];
        current[lastKey] = defaultSection[lastKey];
      }
      
      await this.saveConfig();
      
      return {
        success: true,
        message: `Section '${section}' reset to defaults`
      };
    } else {
      // Reset entire config
      this.config = defaults;
      await this.saveConfig();
      
      return {
        success: true,
        message: 'Configuration reset to defaults'
      };
    }
  }

  /**
   * Export configuration to file
   */
  public async exportConfig(filePath: string): Promise<ConfigActionResult> {
    if (!this.config) {
      return {
        success: false,
        message: 'No configuration to export'
      };
    }
    
    try {
      const yamlContent = yaml.dump(this.config, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false
      });
      
      await fs.writeFile(filePath, yamlContent, 'utf-8');
      
      return {
        success: true,
        message: `Configuration exported to ${filePath}`
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to export configuration: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Import configuration from file
   */
  public async importConfig(filePath: string): Promise<ConfigActionResult> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Parse and validate
      const parsed = SecureYamlParser.parse(content, {
        maxYamlSize: 64 * 1024,
        validateContent: false,
        validateFields: false
      });
      
      if (!parsed.data || typeof parsed.data !== 'object') {
        return {
          success: false,
          message: 'Invalid configuration format in import file'
        };
      }
      
      // Merge with defaults
      this.config = this.mergeWithDefaults(parsed.data as Partial<DollhouseConfig>);
      
      // Save the imported config
      await this.saveConfig();
      
      return {
        success: true,
        message: `Configuration imported from ${filePath}`
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to import configuration: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Get formatted config for display
   */
  public getFormattedConfig(section?: string): string {
    if (!this.config) {
      return 'Configuration not initialized';
    }
    
    let configToShow: any = this.config;
    
    if (section) {
      configToShow = this.getSetting(section);
      if (!configToShow) {
        return `Section '${section}' not found`;
      }
    }
    
    // Remove sensitive data for display
    const sanitized = JSON.parse(JSON.stringify(configToShow));
    
    // Don't show tokens if they exist
    if (sanitized.github?.auth?.token) {
      sanitized.github.auth.token = '***REDACTED***';
    }
    
    return yaml.dump(sanitized, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false
    });
  }
}