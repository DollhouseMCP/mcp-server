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
 * - OAuth client ID storage for MCP client integration
 */

import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import {
  validatePropertyPath,
  safeSetProperty,
  createSafeObject,
  safeHasOwnProperty
} from '../utils/securityUtils.js';
import { env } from './env.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';

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

export interface AutoLoadConfig {
  enabled: boolean;
  maxTokenBudget: number;
  maxSingleMemoryTokens?: number;
  suppressLargeMemoryWarnings?: boolean;
  memories: string[];
}

/**
 * Retention Policy Configuration (Issue #51)
 *
 * Controls automatic deletion of expired memory entries.
 * IMPORTANT: Disabled by default - nothing is auto-deleted without explicit consent.
 *
 * Use cases:
 * - Legal/compliance: Law firms, accountants (7-year retention)
 * - Privacy-focused: Signal-like auto-expiring messages
 * - Storage management: Cleanup of old logs
 * - GDPR: Right-to-be-forgotten implementations
 */
export interface RetentionPolicyConfig {
  /**
   * Master switch for retention enforcement.
   * If false, no automatic retention enforcement happens anywhere.
   * Default: false (nothing auto-deleted)
   */
  enabled: boolean;

  /**
   * When retention enforcement happens:
   * - 'disabled': Never enforce automatically (only via explicit command)
   * - 'manual': Only when user explicitly requests enforcement
   * - 'on_load': Enforce when memory is loaded (CURRENT BEHAVIOR - not recommended)
   * - 'scheduled': Run on a schedule (future implementation)
   */
  enforcement_mode: 'disabled' | 'manual' | 'on_load' | 'scheduled';

  /**
   * Safety controls to prevent accidental data loss
   */
  safety: {
    /** Require explicit confirmation before any deletion */
    require_confirmation: boolean;
    /** Always preview what would be deleted before doing it */
    dry_run_first: boolean;
    /** Show warning when entries are approaching expiration */
    warn_on_expiring: boolean;
    /** Days before expiration to start warning */
    warning_threshold_days: number;
  };

  /**
   * Audit and logging
   */
  audit: {
    /** Log all retention deletions for audit trail */
    log_deletions: boolean;
    /** Keep deleted entries in a backup before permanent removal */
    backup_before_delete: boolean;
    /** Days to keep backups of deleted entries */
    backup_retention_days: number;
  };

  /**
   * Default TTL settings when creating new memories
   * Note: These are defaults only - individual memories can override
   */
  defaults: {
    /** Default TTL in days for new memory entries */
    ttl_days: number;
    /** Maximum entries before capacity enforcement */
    max_entries: number;
  };
}

export interface CapabilityIndexResourcesConfig {
  advertise_resources: boolean;
  variants: {
    summary: boolean;
    full: boolean;
    stats: boolean;
  };
}

export interface EnhancedIndexConfig {
  enabled: boolean;
  limits: {
    maxTriggersPerElement: number;
    maxTriggerLength: number;
    maxKeywordsToCheck: number;
  };
  telemetry: {
    enabled: boolean;
    sampleRate: number;
    metricsInterval: number;
  };
  verbPatterns?: {
    customPrefixes?: string[];
    customSuffixes?: string[];
    excludedNouns?: string[];
  };
  backgroundAnalysis?: {
    enabled: boolean;
    scanInterval: number;
    maxConcurrentScans: number;
  };
  resources?: CapabilityIndexResourcesConfig;
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
  enhanced_index?: EnhancedIndexConfig;
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

export interface WizardConfig {
  completed: boolean;      // Wizard was successfully completed
  dismissed: boolean;      // User chose "Don't show again"
  completedAt?: string;    // ISO timestamp when completed
  version?: string;        // Wizard version for future updates (deprecated - use lastSeenVersion)
  lastSeenVersion?: string; // Last version where user saw the wizard
  skippedSections?: string[]; // Track which sections were skipped
}

export type LicenseTier = 'agpl' | 'free-commercial' | 'paid-commercial';

export interface LicenseConfig {
  tier: LicenseTier;
  email?: string;            // Required for commercial tiers
  attestedAt?: string;       // ISO timestamp of attestation
  telemetryRequired?: boolean; // true for commercial tiers (license condition)
  revenueScale?: string;     // Paid commercial: "$1M–$5M", "$5M–$25M", etc.
  companyName?: string;      // Paid commercial: required
  useCase?: string;          // Paid commercial: required
}

/** Branded type for validated port numbers (1024–65535). */
export type PortNumber = number & { readonly __brand: 'PortNumber' };

/** Validate and brand a port number. Returns undefined if invalid. */
export function validatePort(value: unknown): PortNumber | undefined {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return undefined;
  const port = Math.floor(num);
  if (port < 1024 || port > 65535) return undefined;
  return port as PortNumber;
}

export interface ConsoleConfig {
  /**
   * Web console port (1024–65535). Resolution hierarchy:
   *   1. --port CLI flag (standalone --web mode only)
   *   2. This config value (~/.dollhouse/config.yml → console.port)
   *   3. DOLLHOUSE_WEB_CONSOLE_PORT env var
   *   4. Default: 41715
   */
  port: number;
}

export interface SourcePriorityConfigData {
  order: string[];  // Array of 'local' | 'github' | 'collection'
  stop_on_first: boolean;
  check_all_for_updates: boolean;
  fallback_on_error: boolean;
}

export interface DollhouseConfig {
  version: string;
  user: UserConfig;
  github: GitHubConfig;
  sync: SyncConfig;
  collection: CollectionConfig;
  elements: ElementsConfig;
  display: DisplayConfig;
  wizard: WizardConfig;
  autoLoad: AutoLoadConfig;
  retentionPolicy: RetentionPolicyConfig;
  license: LicenseConfig;
  console: ConsoleConfig;
  source_priority?: SourcePriorityConfigData;
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
  private configDir: string;
  private configPath: string;
  private backupPath: string;
  private config: DollhouseConfig | null = null;
  private readonly fileOperations: IFileOperationsService;
  private os: typeof os;

  /**
   * Extract console.port from raw YAML config content without full
   * ConfigManager initialization. Uses FAILSAFE_SCHEMA for security
   * (no code execution). Returns undefined if not found or invalid.
   */
  static readPortFromYaml(yamlContent: string): number | undefined {
    try {
      const parsed = yaml.load(yamlContent, { schema: yaml.FAILSAFE_SCHEMA }) as Record<string, any> | null;
      const raw = parsed?.console?.port;
      if (raw === undefined || raw === null) return undefined;
      const port = Number(raw);
      return Number.isFinite(port) ? port : undefined;
    } catch {
      return undefined;
    }
  }

  constructor(fileOperations: IFileOperationsService, osModule: typeof os, configDir?: string) {
    this.fileOperations = fileOperations;
    this.os = osModule;

    // Priority: explicit param (from DI/PathService) > test env > default
    if (configDir) {
      this.configDir = configDir;
    } else if (env.NODE_ENV === 'test' && process.env.TEST_CONFIG_DIR) {
      this.configDir = process.env.TEST_CONFIG_DIR;
    } else {
      this.configDir = path.join(this.os.homedir(), '.dollhouse');
    }
    this.configPath = path.join(this.configDir, 'config.yml');
    this.backupPath = path.join(this.configDir, 'config.yml.backup');
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
          repository_name: env.GITHUB_REPOSITORY || 'dollhouse-portfolio',
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
      autoLoad: {
        enabled: true, // Auto-load baseline memories by default
        maxTokenBudget: 5000,
        maxSingleMemoryTokens: undefined,
        suppressLargeMemoryWarnings: false,
        memories: [] // Configured via memory files with autoLoad flag
      },
      elements: {
        auto_activate: {},
        default_element_dir: path.join(os.homedir(), '.dollhouse', 'portfolio'),
        enhanced_index: {
          enabled: true,
          limits: {
            maxTriggersPerElement: 50,
            maxTriggerLength: 50,
            maxKeywordsToCheck: 100
          },
          telemetry: {
            enabled: false,  // Opt-in only
            sampleRate: 0.1,
            metricsInterval: 60000
          },
          resources: {
            advertise_resources: false, // Default: safe, disabled
            variants: {
              summary: false,  // ~1,254 tokens - Opt-in required
              full: false,     // ~48,306 tokens - Opt-in required
              stats: true      // ~50 tokens - Safe by default
            }
          }
        }
      },
      display: {
        persona_indicators: {
          enabled: true,
          style: 'minimal',
          include_emoji: true
        },
        verbose_logging: false,
        show_progress: true
      },
      wizard: {
        completed: false,
        dismissed: false
      },
      license: {
        tier: 'agpl'
      },
      console: {
        port: 41715
      },
      /**
       * Retention Policy Configuration (Issue #51)
       * IMPORTANT: Disabled by default - nothing is auto-deleted without explicit consent.
       * Users must explicitly enable retention enforcement if they want automatic cleanup.
       */
      retentionPolicy: {
        enabled: false,                    // DISABLED by default - no auto-deletion
        enforcement_mode: 'disabled',       // Only manual enforcement allowed
        safety: {
          require_confirmation: true,       // Always require confirmation
          dry_run_first: true,              // Always preview before deleting
          warn_on_expiring: true,           // Warn when entries approaching expiration
          warning_threshold_days: 7         // Warn 7 days before expiration
        },
        audit: {
          log_deletions: true,              // Log all deletions
          backup_before_delete: true,       // Backup deleted entries
          backup_retention_days: 30         // Keep backups for 30 days
        },
        defaults: {
          ttl_days: 30,                     // Default 30-day TTL (if enabled)
          max_entries: 1000                 // Default max entries per memory
        }
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
      // Ensure config directory exists with proper permissions (0o700 = owner only)
      await this.fileOperations.createDirectory(this.configDir);
      // Set permissions on the directory
      await this.fileOperations.chmod(this.configDir, 0o700, {
        source: 'ConfigManager.initialize'
      });
      
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
      const content = await this.fileOperations.readFile(this.configPath, {
        source: 'ConfigManager.loadConfig'
      });
      
      /**
       * IMPORTANT: Parser Selection for Different File Types
       * 
       * We use DIFFERENT parsers for different file types:
       * 
       * 1. js-yaml (used here) - For PURE YAML files:
       *    - Configuration files (config.yml)
       *    - Data files without markdown content
       *    - Any .yml or .yaml file that's just YAML
       *    Example format:
       *    ```yaml
       *    version: 1.0.0
       *    user:
       *      username: johndoe
       *      email: john@example.com
       *    ```
       * 
       * 2. SecureYamlParser - For MARKDOWN files with YAML frontmatter:
       *    - Persona files (*.md in personas/)
       *    - Skill files (*.md in skills/)
       *    - Template files (*.md in templates/)
       *    - Any .md file with frontmatter between --- markers
       *    Example format:
       *    ```markdown
       *    ---
       *    name: Creative Writer
       *    description: A creative assistant
       *    ---
       *    # Instructions
       *    You are a creative writer...
       *    ```
       * 
       * The config file is PURE YAML, so we use js-yaml directly with FAILSAFE_SCHEMA
       * for security (prevents code execution via YAML tags).
       * SECURITY: This is NOT a vulnerability - FAILSAFE_SCHEMA prevents code execution
       */
      let loadedData: any;
      try {
        // Using yaml with FAILSAFE_SCHEMA is secure - prevents code execution
        loadedData = yaml.load(content, {
          schema: yaml.FAILSAFE_SCHEMA // Safe schema prevents code execution
        });
      } catch (yamlError) {
        throw new Error(`Invalid YAML in configuration file: ${yamlError instanceof Error ? yamlError.message : String(yamlError)}`);
      }
      
      if (!loadedData || typeof loadedData !== 'object') {
        throw new Error('Invalid configuration format');
      }
      logger.debug('Loaded config from file', {
        username: loadedData.user?.username,
        email: loadedData.user?.email,
        syncEnabled: loadedData.sync?.enabled
      });
      
      this.config = this.mergeWithDefaults(loadedData);
      
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
    return this.fileOperations.exists(this.configPath);
  }

  /**
   * Get GitHub OAuth client ID
   * Environment variable takes precedence over config file
   */
  public getGitHubClientId(): string | null {
    // NOTE: DOLLHOUSE_GITHUB_CLIENT_ID is not in centralized env config
    // as it's an optional feature flag, so we still use process.env here
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
   * SECURITY FIX (PR #895): Added prototype pollution protection
   * Previously: Direct property assignment allowed __proto__ injection
   * Now: Validates keys against forbidden properties before assignment
   */
  public async updateSetting(path: string, value: any): Promise<ConfigUpdateResult> {
    if (!this.config) {
      await this.initialize();
    }
    
    // SECURITY: Validate path to prevent prototype pollution
    validatePropertyPath(path, 'path');

    // Runtime validation for known typed settings (#1840)
    if (path === 'console.port') {
      const validated = validatePort(value);
      if (!validated) {
        return {
          success: false,
          message: `Invalid port: ${value}. Must be an integer between 1024 and 65535.`,
        };
      }
      value = validated;
    }

    const keys = path.split('.');
    let current: any = this.config;
    const previousValue = this.getSetting(path);

    // Navigate to the parent object using security utilities
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      // SECURITY: Use safe property check and create prototype-less objects
      if (!safeHasOwnProperty(current, key)) {
        current[key] = createSafeObject();
      }
      current = current[key];
    }

    // Set the value using secure property setter
    const lastKey = keys[keys.length - 1];
    safeSetProperty(current, lastKey, value);
    
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
        await this.fileOperations.copyFile(this.configPath, this.backupPath, {
          source: 'ConfigManager.saveConfig'
        });
      }

      // Convert to YAML
      // Note: We use js-yaml's dump() for pure YAML output (no frontmatter markers)
      // This creates a standard YAML file, not a markdown file with frontmatter
      const yamlContent = yaml.dump(this.config, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false
        // Using default schema (not FAILSAFE) for dump to preserve types like booleans
      });

      // Write atomically with proper permissions (0o600 = owner read/write only)
      const tempPath = `${this.configPath}.tmp`;
      await this.fileOperations.writeFile(tempPath, yamlContent, {
        source: 'ConfigManager.saveConfig'
      });
      await this.fileOperations.chmod(tempPath, 0o600, {
        source: 'ConfigManager.saveConfig'
      });
      await this.fileOperations.renameFile(tempPath, this.configPath);
      
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
        await this.fileOperations.copyFile(this.backupPath, this.configPath, {
          source: 'ConfigManager.saveConfig'
        });
        logger.info('Restored configuration from backup');
      }
      
      throw error;
    }
  }

  /**
   * Check if backup exists
   */
  private async backupExists(): Promise<boolean> {
    return this.fileOperations.exists(this.backupPath);
  }

  /**
   * Fix incorrect types in config (e.g., string booleans, string "null")
   */
  private fixConfigTypes(): void {
    if (!this.config) return;
    
    // Helper to convert string "null" to actual null
    const fixNull = (value: any): any => {
      if (value === 'null' || value === 'NULL') return null;
      return value;
    };
    
    // Helper to convert string booleans to actual booleans
    const fixBoolean = (value: any): any => {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
      }
      return value;
    };
    
    // Fix user fields - handle string "null" values
    if (this.config.user) {
      this.config.user.username = fixNull(this.config.user.username);
      this.config.user.email = fixNull(this.config.user.email);
      this.config.user.display_name = fixNull(this.config.user.display_name);
    }
    
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
        this.config.github.portfolio.repository_url = fixNull(this.config.github.portfolio.repository_url);
        this.config.github.portfolio.auto_create = fixBoolean(this.config.github.portfolio.auto_create);
      }
      if (this.config.github.auth) {
        this.config.github.auth.use_oauth = fixBoolean(this.config.github.auth.use_oauth);
        // Fix client_id if it's a string "null"
        if (this.config.github.auth.client_id) {
          this.config.github.auth.client_id = fixNull(this.config.github.auth.client_id) || undefined;
        }
      }
    }
    
    // Fix wizard settings
    if (this.config.wizard) {
      this.config.wizard.completed = fixBoolean(this.config.wizard.completed);
      this.config.wizard.dismissed = fixBoolean(this.config.wizard.dismissed);
    }

    // Fix retention policy settings (Issue #51)
    if (this.config.retentionPolicy) {
      this.config.retentionPolicy.enabled = fixBoolean(this.config.retentionPolicy.enabled);
      if (this.config.retentionPolicy.safety) {
        this.config.retentionPolicy.safety.require_confirmation = fixBoolean(this.config.retentionPolicy.safety.require_confirmation);
        this.config.retentionPolicy.safety.dry_run_first = fixBoolean(this.config.retentionPolicy.safety.dry_run_first);
        this.config.retentionPolicy.safety.warn_on_expiring = fixBoolean(this.config.retentionPolicy.safety.warn_on_expiring);
      }
      if (this.config.retentionPolicy.audit) {
        this.config.retentionPolicy.audit.log_deletions = fixBoolean(this.config.retentionPolicy.audit.log_deletions);
        this.config.retentionPolicy.audit.backup_before_delete = fixBoolean(this.config.retentionPolicy.audit.backup_before_delete);
      }
    }
  }

  /**
   * Merge partial config with defaults
   * 
   * IMPORTANT: This function preserves unknown fields for forward compatibility.
   * If a future version adds new config fields, older versions won't lose them.
   */
  private mergeWithDefaults(partial: Partial<DollhouseConfig>): DollhouseConfig {
    const defaults = this.getDefaultConfig();
    
    // Start with a deep clone of partial to preserve all unknown fields
    const result: any = JSON.parse(JSON.stringify(partial));
    
    // Ensure all required fields exist with defaults
    result.version = result.version || defaults.version;
    
    // User section - preserve unknown fields while ensuring required fields
    result.user = {
      ...result.user,
      username: result.user?.username ?? defaults.user.username,
      email: result.user?.email ?? defaults.user.email,
      display_name: result.user?.display_name ?? defaults.user.display_name
    };
    
    // GitHub section - deep merge preserving unknown fields
    if (!result.github) result.github = {};
    result.github.portfolio = {
      ...defaults.github.portfolio,
      ...result.github.portfolio
    };
    result.github.auth = {
      ...defaults.github.auth,
      ...result.github.auth
    };
    
    // Sync section - preserve unknown fields at all levels
    if (!result.sync) result.sync = {};
    result.sync.enabled = result.sync.enabled ?? defaults.sync.enabled;
    result.sync.individual = {
      ...defaults.sync.individual,
      ...result.sync.individual
    };
    result.sync.bulk = {
      ...defaults.sync.bulk,
      ...result.sync.bulk
    };
    result.sync.privacy = {
      ...defaults.sync.privacy,
      ...result.sync.privacy,
      // Special handling for arrays - use provided or default
      excluded_patterns: result.sync.privacy?.excluded_patterns || defaults.sync.privacy.excluded_patterns
    };
    
    // Collection section
    result.collection = {
      ...defaults.collection,
      ...result.collection
    };
    
    // Elements section
    if (!result.elements) result.elements = {};
    result.elements = {
      ...result.elements,
      auto_activate: result.elements.auto_activate || defaults.elements.auto_activate,
      default_element_dir: result.elements.default_element_dir || defaults.elements.default_element_dir
    };
    
    // Display section
    if (!result.display) result.display = {};
    result.display.persona_indicators = {
      ...defaults.display.persona_indicators,
      ...result.display.persona_indicators
    };
    result.display.verbose_logging = result.display.verbose_logging ?? defaults.display.verbose_logging;
    result.display.show_progress = result.display.show_progress ?? defaults.display.show_progress;
    
    // Wizard section
    result.wizard = {
      ...defaults.wizard,
      ...result.wizard
    };

    // AutoLoad section (Issue: regression from current-server)
    // This was missing in mcp-server refactor, causing auto-load to fail for existing configs
    result.autoLoad = {
      ...defaults.autoLoad,
      ...result.autoLoad
    };

    // Retention Policy section (Issue #51)
    // IMPORTANT: Defaults are disabled - nothing auto-deleted without explicit consent
    if (!result.retentionPolicy) result.retentionPolicy = {};
    result.retentionPolicy = {
      enabled: result.retentionPolicy.enabled ?? defaults.retentionPolicy.enabled,
      enforcement_mode: result.retentionPolicy.enforcement_mode ?? defaults.retentionPolicy.enforcement_mode,
      safety: {
        ...defaults.retentionPolicy.safety,
        ...result.retentionPolicy.safety
      },
      audit: {
        ...defaults.retentionPolicy.audit,
        ...result.retentionPolicy.audit
      },
      defaults: {
        ...defaults.retentionPolicy.defaults,
        ...result.retentionPolicy.defaults
      }
    };

    return result as DollhouseConfig;
  }

  /**
   * Migrate settings from environment variables
   */
  private async migrateFromEnvironment(): Promise<void> {
    let migrated = false;

    // NOTE: These are optional custom env vars not in centralized config
    // They're used for backwards compatibility migration only

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

    // Migrate collection auto-submit - use centralized env config
    if (env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION !== false) {
      if (!this.config) this.config = this.getDefaultConfig();
      this.config.collection.auto_submit = env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;
      migrated = true;
    }

    if (migrated) {
      logger.info('Migrated settings from environment variables');
    }
  }

  /**
   * Reset configuration to defaults
   * SECURITY FIX (PR #895): Added prototype pollution protection
   * Previously: Direct property assignment allowed __proto__ injection
   * Now: Validates keys against forbidden properties before assignment
   */
  public async resetConfig(section?: string): Promise<ConfigActionResult> {
    const defaults = this.getDefaultConfig();
    
    if (section) {
      // Reset specific section
      if (!this.config) {
        this.config = defaults;
      } else {
        // SECURITY: Validate section path to prevent prototype pollution
        validatePropertyPath(section, 'section');

        const sectionKeys = section.split('.');
        let current: any = this.config;
        let defaultSection: any = defaults;

        for (let i = 0; i < sectionKeys.length - 1; i++) {
          current = current[sectionKeys[i]];
          defaultSection = defaultSection[sectionKeys[i]];
        }

        const lastKey = sectionKeys[sectionKeys.length - 1];
        // SECURITY: Use secure property setter to avoid prototype chain pollution
        safeSetProperty(current, lastKey, defaultSection[lastKey]);
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

      await this.fileOperations.writeFile(filePath, yamlContent, {
        source: 'ConfigManager.exportConfig'
      });
      await this.fileOperations.chmod(filePath, 0o600, {
        source: 'ConfigManager.exportConfig'
      });

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
      const content = await this.fileOperations.readFile(filePath, {
        source: 'ConfigManager.importConfig'
      });
      
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
