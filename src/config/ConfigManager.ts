/**
 * ConfigManager - Centralized configuration management for DollhouseMCP
 *
 * Phase 4.5 storage completion: ConfigManager is now a thin façade over
 * `IOperatorConfigStore` (per-host settings) + `IUserConfigStore` (per-user
 * settings, RLS-isolated). The underlying stores are backend-selectable
 * (filesystem / postgres / in-memory) per `DOLLHOUSE_STORAGE_BACKEND`.
 *
 * Hybrid caching: `initialize()` async-loads both stores and merges into
 * the existing `DollhouseConfig` shape, cached per-user in a `Map`. Sync
 * reads (`getConfig`, `getSetting`) hit the cache. Writes route through
 * the appropriate store, then refresh the cache.
 *
 * **userId resolution:** every read/write resolves the effective userId
 * from `ContextTracker.getSessionContext()`. When no session is active
 * (stdio mode, boot context), falls back to `defaultUserId` — passed in
 * at construction. In DB mode this should be the bootstrapped OS-user
 * UUID (from `src/database/bootstrap.ts`); in filesystem mode any stable
 * sentinel UUID works (per-user filesystem files, no FK constraints).
 *
 * **Public API preserved:** all 9 existing public methods keep their
 * signatures so the 100+ existing call sites don't need updates. The
 * single-user-config-file YAML semantics are gone; export/import still
 * use YAML serialization for portability.
 *
 * Features:
 * - Two-store backend (operator + user) selectable filesystem/postgres
 * - Default values with user overrides
 * - Migration from environment variables
 * - Validation and type safety
 * - Atomic updates (one write per affected store)
 * - Privacy-first defaults
 * - OAuth client ID storage for MCP client integration
 */

import * as os from 'os';
import * as path from 'path';
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
import { isKnownConfigPath, validateConfigPath } from './configSchema.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';
import type { IOperatorConfigStore, OperatorConfig } from '../storage/operatorConfig/IOperatorConfigStore.js';
import type { IUserConfigStore, UserConfig as UserConfigPayload } from '../storage/userConfig/IUserConfigStore.js';
import type { ContextTracker } from '../security/encryption/ContextTracker.js';

/**
 * Stable sentinel UUID for "no session active, default user." Used when
 * `ContextTracker.getSessionContext()` returns null and no caller-supplied
 * `defaultUserId` is available. In DB mode this UUID won't satisfy the
 * `user_settings.user_id → users.id` FK on writes — by design, since
 * boot/system contexts shouldn't be writing per-user state.
 */
export const DEFAULT_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Helper for `mergeStorePayloads`: shallow-merge a stored jsonb section
 * onto a defaults section, preserving nested defaults for keys the store
 * payload doesn't override. The store payload is `Record<string, unknown>`
 * (jsonb has no fixed shape); the defaults are typed.
 *
 * Two-level merge so common shapes like `{ individual: {...}, bulk: {...} }`
 * preserve nested defaults. Beyond two levels, the store value wins
 * verbatim — operators wanting deeper merges should write the full
 * sub-section.
 */
function deepMergeSection<T extends object>(
  defaults: T,
  stored: Record<string, unknown>,
): T {
  // Internal Record<string, unknown> view so we can spread + index the
  // generic T without forcing every caller to repeat the `as unknown as
  // Record<string, unknown>` widening + `as unknown as T` re-narrowing
  // dance. The runtime shape is unchanged.
  const defaultsAsRecord = defaults as Record<string, unknown>;
  const out: Record<string, unknown> = { ...defaultsAsRecord };
  for (const [key, value] of Object.entries(stored)) {
    const defaultValue = defaultsAsRecord[key];
    if (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && defaultValue !== null
      && typeof defaultValue === 'object'
      && !Array.isArray(defaultValue)
    ) {
      out[key] = { ...defaultValue, ...value };
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

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

// Type-coercion helpers for legacy on-disk configs where booleans and nulls
// may have been written as strings. Module-scoped so the per-section fixers
// can reuse them without each method declaring its own copy.
function fixNull(value: any): any {
  if (value === 'null' || value === 'NULL') return null;
  return value;
}

function fixBoolean(value: any): any {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return value;
}

export class ConfigManager {
  private readonly fileOperations: IFileOperationsService;
  private readonly os: typeof os;
  private readonly operatorStore: IOperatorConfigStore;
  private readonly userStore: IUserConfigStore;
  private readonly contextTracker: ContextTracker | null;
  private readonly defaultUserId: string;

  /**
   * Per-user merged DollhouseConfig cache. Populated by `initialize()`
   * (and lazily by writes). Keyed by effective userId. Holding the merged
   * shape (rather than separate operator+user objects) keeps `getConfig`
   * and `getSetting` zero-allocation for the hot path.
   */
  private readonly mergedCache = new Map<string, DollhouseConfig>();

  /**
   * Extract console.port from raw YAML config content without full
   * ConfigManager initialization. Uses FAILSAFE_SCHEMA for security
   * (no code execution). Returns undefined if not found or invalid.
   *
   * Used by the legacy YAML-config startup path — kept for filesystem
   * deployments that still have a `~/.dollhouse/config.yml` to read
   * the port from before stores are constructed.
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

  /**
   * Pre-DI peek of `elements.enhanced_index.resources.advertise_resources`
   * directly from `~/.dollhouse/config.yml`. Used by the MCP server
   * constructor (a synchronous context that runs before the DI container
   * and the storage layers exist) to decide whether to advertise the
   * MCP resources capability.
   *
   * Returns `false` on any error (missing file, parse error, missing key)
   * — the safe default (don't advertise).
   *
   * In DB-backend mode there's no config.yml; this returns false, and
   * operators wanting resources advertised must configure it via the
   * post-startup `dollhouse_config` flow. Acceptable trade-off — the
   * advertise flag is an operator-set capability, not session-bound.
   */
  static peekResourcesAdvertiseFlag(): boolean {
    try {
      // Lazy require so import-time costs only apply to the rare advertise=true path
      const fs = require('node:fs');
      const configDir = process.env.TEST_CONFIG_DIR
        ?? path.join(os.homedir(), '.dollhouse');
      const configPath = path.join(configDir, 'config.yml');
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA }) as Record<string, any> | null;
      return parsed?.elements?.enhanced_index?.resources?.advertise_resources === true;
    } catch {
      return false;
    }
  }

  /**
   * Construct a ConfigManager backed by env-default stores (filesystem or
   * postgres per `DOLLHOUSE_STORAGE_BACKEND`). Used by legacy non-DI
   * callers that need ConfigManager outside the Container bootstrap flow.
   *
   * Production code should resolve `ConfigManager` from the DI container
   * (where ContextTracker + defaultUserId are wired correctly). This
   * static is a pragmatic alternative for one-shot scripts and pre-DI
   * helpers.
   */
  static async createStandalone(
    fileOperations: IFileOperationsService,
    osModule: typeof os,
  ): Promise<ConfigManager> {
    const { createOperatorConfigStore } = await import('../storage/operatorConfig/createOperatorConfigStore.js');
    const { createUserConfigStore } = await import('../storage/userConfig/createUserConfigStore.js');
    const [operatorStore, userStore] = await Promise.all([
      createOperatorConfigStore({}),
      createUserConfigStore({}),
    ]);
    // No ContextTracker in standalone mode — uses DEFAULT_SYSTEM_USER_ID
    // for the fallback userId. Per-user writes in this mode all land on
    // the same sentinel row (filesystem) or fail FK (postgres) — by
    // design, since standalone callers are typically operator-context.
    return new ConfigManager(fileOperations, osModule, operatorStore, userStore, null);
  }

  constructor(
    fileOperations: IFileOperationsService,
    osModule: typeof os,
    operatorStore: IOperatorConfigStore,
    userStore: IUserConfigStore,
    contextTracker: ContextTracker | null,
    defaultUserId: string = DEFAULT_SYSTEM_USER_ID,
  ) {
    this.fileOperations = fileOperations;
    this.os = osModule;
    this.operatorStore = operatorStore;
    this.userStore = userStore;
    this.contextTracker = contextTracker;
    this.defaultUserId = defaultUserId;
  }

  /**
   * Resolve the effective userId for the current async context. Returns
   * the `SessionContext.userId` when a session is active, otherwise the
   * configured `defaultUserId` (typically the bootstrapped OS-user UUID
   * in DB mode, or the sentinel in filesystem mode).
   */
  private resolveUserId(): string {
    if (this.contextTracker) {
      const session = this.contextTracker.getSessionContext();
      if (session?.userId) return session.userId;
    }
    return this.defaultUserId;
  }

  /**
   * Get the cached merged config for the current effective userId, or
   * null if `initialize()` hasn't been called for that user yet.
   * Internal getter — use `getConfig()` for the public throwing variant.
   */
  private getCachedConfig(): DollhouseConfig | null {
    return this.mergedCache.get(this.resolveUserId()) ?? null;
  }

  /**
   * Backwards-compat alias used by internal helpers (fixConfigTypes,
   * setGitHubClientId, etc.) that expect a `this.config` field. Returns
   * the cached config for the current effective userId or null.
   */
  private get config(): DollhouseConfig | null {
    return this.getCachedConfig();
  }

  /**
   * Set the cached config for the current effective userId. Internal —
   * used by initialize/updateSetting/etc. when the merged config changes.
   */
  private set config(next: DollhouseConfig | null) {
    const userId = this.resolveUserId();
    if (next === null) {
      this.mergedCache.delete(userId);
    } else {
      this.mergedCache.set(userId, next);
    }
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
    // Always reload from stores — picks up out-of-band changes (other
    // replicas, direct DB edits, file edits). Same semantics as the old
    // file-based "always reload from disk" behavior.
    const userId = this.resolveUserId();

    try {
      const [operatorPayload, userPayload] = await Promise.all([
        this.operatorStore.load(),
        this.userStore.load(userId),
      ]);

      let merged = this.mergeStorePayloads(operatorPayload, userPayload);

      // First-start migration from environment variables — only when both
      // stores look like fresh defaults (no operator config saved + no
      // per-user config saved). Skips on re-init of an existing deployment
      // so env vars can't silently overwrite operator-configured values.
      const isFreshStart =
        operatorPayload.updatedAt === 0 && userPayload.updatedAt === 0;
      if (isFreshStart) {
        // Stage merged into this.config so migrateFromEnvironment can
        // mutate it through `this.config` (preserves the existing
        // implementation pattern).
        this.config = merged;
        await this.migrateFromEnvironment();
        merged = this.config!;
        // Persist any env-derived changes back to the stores.
        await this.persistMerged(userId, merged);
      } else {
        this.config = merged;
      }

      // Fix any string booleans that might have been saved incorrectly
      // (legacy YAML data shape recovery — mostly a no-op for fresh
      // store-backed state, but cheap and defensive against bad data).
      this.fixConfigTypes();

      logger.debug('Configuration loaded successfully', {
        userId,
        username: this.config?.user.username,
        syncEnabled: this.config?.sync.enabled,
      });
    } catch (error) {
      logger.error('Failed to initialize configuration', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Use defaults in memory so consumers don't crash on null config
      this.config = this.getDefaultConfig();
    }
  }

  /**
   * Load + cache the merged config for a specific userId. Used by HTTP
   * handlers to preload a session's config before performing reads in
   * sync downstream code paths. Idempotent — safe to call repeatedly.
   */
  public async ensureUserConfigLoaded(userId: string): Promise<void> {
    if (this.mergedCache.has(userId)) return;
    const [operatorPayload, userPayload] = await Promise.all([
      this.operatorStore.load(),
      this.userStore.load(userId),
    ]);
    const merged = this.mergeStorePayloads(operatorPayload, userPayload);
    this.mergedCache.set(userId, merged);
  }

  /**
   * Merge OperatorConfig + UserConfig payloads into the unified
   * `DollhouseConfig` shape consumers expect. Section assignments mirror
   * the per-user / per-host classification documented in the Phase 4.5
   * plan: per-user → user payload sections; per-host → operator payload
   * sections. Defaults fill gaps for any missing keys.
   */
  private mergeStorePayloads(
    operator: OperatorConfig,
    user: UserConfigPayload,
  ): DollhouseConfig {
    const defaults = this.getDefaultConfig();
    const userIdentity = user.userIdentityConfig as Partial<UserConfig>;
    const merged: DollhouseConfig = {
      version: (operator.defaultsConfig.version as string)
        ?? defaults.version,
      user: {
        username: userIdentity.username ?? defaults.user.username,
        email: userIdentity.email ?? defaults.user.email,
        display_name: userIdentity.display_name ?? defaults.user.display_name,
      },
      github: deepMergeSection(defaults.github, user.githubConfig),
      sync: deepMergeSection(defaults.sync, user.syncConfig),
      collection: { ...defaults.collection, ...user.collectionConfig },
      autoLoad: { ...defaults.autoLoad, ...user.autoloadConfig },
      elements: {
        auto_activate: { ...defaults.elements.auto_activate, ...user.autoActivateConfig },
        default_element_dir: (operator.defaultsConfig.default_element_dir as string)
          ?? defaults.elements.default_element_dir,
        enhanced_index: deepMergeSection(
          defaults.elements.enhanced_index ?? ({} as EnhancedIndexConfig),
          operator.enhancedIndexConfig,
        ),
      },
      display: deepMergeSection(defaults.display, user.displayConfig),
      wizard: { ...defaults.wizard, ...user.wizardConfig },
      retentionPolicy: deepMergeSection(defaults.retentionPolicy, user.retentionConfig),
      license: { ...defaults.license, ...operator.licenseConfig },
      console: { ...defaults.console, ...operator.consoleConfig },
      source_priority: Object.keys(user.sourcePriorityConfig).length > 0
        ? user.sourcePriorityConfig as unknown as SourcePriorityConfigData
        : undefined,
    };
    return merged;
  }

  /**
   * Inverse of `mergeStorePayloads`: split a merged DollhouseConfig back
   * into operator + user payloads for store writes. Used by `updateSetting`,
   * `resetConfig`, `importConfig`, `setGitHubClientId`, etc. — anywhere
   * the in-memory config changes and needs to be persisted.
   */
  private splitForStores(merged: DollhouseConfig): {
    operator: Omit<OperatorConfig, 'updatedAt'>;
    user: Omit<UserConfigPayload, 'updatedAt'>;
  } {
    return {
      operator: {
        enhancedIndexConfig: merged.elements.enhanced_index as unknown as Record<string, unknown>,
        consoleConfig: merged.console as unknown as Record<string, unknown>,
        licenseConfig: merged.license as unknown as Record<string, unknown>,
        defaultsConfig: {
          version: merged.version,
          default_element_dir: merged.elements.default_element_dir,
        },
        configVersion: 1,
      },
      user: {
        githubConfig: merged.github as unknown as Record<string, unknown>,
        syncConfig: merged.sync as unknown as Record<string, unknown>,
        autoloadConfig: merged.autoLoad as unknown as Record<string, unknown>,
        retentionConfig: merged.retentionPolicy as unknown as Record<string, unknown>,
        wizardConfig: merged.wizard as unknown as Record<string, unknown>,
        displayConfig: merged.display as unknown as Record<string, unknown>,
        collectionConfig: merged.collection as unknown as Record<string, unknown>,
        autoActivateConfig: merged.elements.auto_activate as unknown as Record<string, unknown>,
        sourcePriorityConfig: (merged.source_priority ?? {}) as unknown as Record<string, unknown>,
        userIdentityConfig: merged.user as unknown as Record<string, unknown>,
        configVersion: 1,
      },
    };
  }

  /**
   * Persist the merged config back to both stores in parallel. Always
   * writes both stores — simpler than tracking which sections changed,
   * and the cost is bounded (one INSERT/UPDATE per store).
   */
  private async persistMerged(userId: string, merged: DollhouseConfig): Promise<void> {
    const split = this.splitForStores(merged);
    await Promise.all([
      this.operatorStore.save(split.operator),
      this.userStore.save(userId, split.user),
    ]);
  }

  /**
   * Classify a setting path as per-host (operator_settings) vs per-user
   * (user_settings). Single source of truth — used by `updateSetting`'s
   * admin gate; must mirror the section split in `splitForStores` /
   * `mergeStorePayloads`.
   *
   * Per-host paths (require 'admin' role to mutate):
   *   - `version`
   *   - `console.*`
   *   - `license.*`
   *   - `elements.enhanced_index.*`
   *   - `elements.default_element_dir`
   *
   * Everything else under top-level sections (`user.*`, `github.*`,
   * `sync.*`, `autoLoad.*`, `retentionPolicy.*`, `wizard.*`, `display.*`,
   * `collection.*`, `elements.auto_activate.*`, `source_priority.*`) is
   * per-user and RLS-scoped — those don't require admin.
   */
  public static isPerHostPath(path: string): boolean {
    if (path === 'version') return true;
    if (path === 'console' || path.startsWith('console.')) return true;
    if (path === 'license' || path.startsWith('license.')) return true;
    if (path === 'elements.default_element_dir') return true;
    if (path === 'elements.enhanced_index' || path.startsWith('elements.enhanced_index.')) {
      return true;
    }
    return false;
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

    const userId = this.resolveUserId();
    if (!this.config) {
      await this.initialize();
    }

    // Ensure github.auth object exists
    if (!this.config!.github) {
      this.config = { ...this.config!, github: this.getDefaultConfig().github };
    }
    if (!this.config!.github.auth) {
      this.config!.github.auth = this.getDefaultConfig().github.auth;
    }

    this.config!.github.auth.client_id = clientId;
    await this.persistMerged(userId, this.config!);
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
    const userId = this.resolveUserId();
    if (!this.config) {
      await this.initialize();
    }

    // SECURITY: Validate path to prevent prototype pollution
    validatePropertyPath(path, 'path');

    // SECURITY: Admin-gate per-host (operator_settings) writes. Per-user
    // settings stay unguarded — those land in RLS-scoped user_settings
    // keyed to the caller's sub, so RLS enforces isolation. Per-host
    // settings affect the entire deployment (console.port, license tier,
    // enhanced_index limits, default_element_dir) and must require the
    // 'admin' role.
    //
    // Enforcement policy:
    //   - ContextTracker NULL → standalone mode (createStandalone factory,
    //     pre-DI bootstrap, tests). No session identity is available, so
    //     the caller is trusted by virtue of being in-process — no gate.
    //   - ContextTracker present but no active session → reject (the
    //     caller is wired into context-aware code but forgot to scope
    //     itself; this is the "background task forgot runAsync" case
    //     and defaulting to allow would be a privilege escalation).
    //   - ContextTracker present + session has 'admin' role → allow.
    //   - Stdio sessions implicitly carry 'admin' (operator is machine
    //     owner in single-user local mode — see StdioSession.ts).
    //   - HTTP sessions carry whatever the JWT `roles` claim grants —
    //     typically empty unless the operator was pre-claimed via the
    //     `dollhousemcp admin bootstrap` CLI.
    if (ConfigManager.isPerHostPath(path) && this.contextTracker) {
      const callerRoles = this.contextTracker.getSessionContext()?.roles ?? [];
      if (!callerRoles.includes('admin')) {
        const reason = `Configuration path '${path}' is server-wide and requires the 'admin' role.`;
        logger.warn('[ConfigManager] Rejected non-admin operator-config write', {
          path,
          callerUserId: userId,
          hasRoles: callerRoles.length > 0,
        });
        return {
          success: false,
          message: `${reason} Your session has roles: [${callerRoles.join(', ')}]. ` +
            `Per-host settings can only be changed by an admin operator. ` +
            `To grant admin role, run \`dollhousemcp admin bootstrap\` (CLI) or have ` +
            `an existing admin add your sub to the bootstrap state.`,
        };
      }
    }

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

    // Schema validation: reject unknown paths and type mismatches so typos
    // and renamed-key drift surface as errors instead of silently writing
    // phantom keys into the JSONB blob. Strict-by-default; operators can
    // set DOLLHOUSE_CONFIG_STRICT_PATHS=false to opt back to "anything goes"
    // for back-compat with workflows that still rely on old/unenumerated paths.
    const validation = validateConfigPath(path, value, { strict: env.DOLLHOUSE_CONFIG_STRICT_PATHS });
    if (!validation.ok) {
      logger.warn('[ConfigManager] Rejected config write (schema violation)', {
        path,
        error: validation.error,
      });
      return { success: false, message: validation.error };
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

    // Persist to both stores (split + parallel save).
    await this.persistMerged(userId, this.config!);

    logger.info('Configuration setting updated', {
      path,
      previousValue,
      newValue: value,
    });

    return {
      success: true,
      message: `Setting '${path}' updated successfully`,
      previousValue,
      newValue: value,
    };
  }

  /**
   * Remove a setting from the config so the consumer sees the schema
   * default. Useful for cleaning up phantom keys (typos from before
   * schema validation existed, or paths from renamed/removed features).
   *
   * Returns success=false when:
   *   - the path is server-wide (per-host) and the caller lacks 'admin'
   *   - the path doesn't currently have a stored value (nothing to delete)
   *
   * Prototype-pollution guards mirror `updateSetting`.
   */
  public async deleteSetting(path: string): Promise<ConfigUpdateResult> {
    const userId = this.resolveUserId();
    if (!this.config) {
      await this.initialize();
    }

    validatePropertyPath(path, 'path');

    // Same admin gate as updateSetting — per-host paths require 'admin'.
    if (ConfigManager.isPerHostPath(path) && this.contextTracker) {
      const callerRoles = this.contextTracker.getSessionContext()?.roles ?? [];
      if (!callerRoles.includes('admin')) {
        const reason = `Configuration path '${path}' is server-wide and requires the 'admin' role.`;
        logger.warn('[ConfigManager] Rejected non-admin operator-config delete', {
          path,
          callerUserId: userId,
        });
        return {
          success: false,
          message: `${reason} Per-host settings can only be changed by an admin operator.`,
        };
      }
    }

    const previousValue = this.getSetting(path);
    if (previousValue === undefined) {
      return {
        success: false,
        message: `Configuration path '${path}' has no stored value to delete.`,
      };
    }
    if (!isKnownConfigPath(path) && isPlainObject(previousValue)) {
      return {
        success: false,
        message: `Configuration path '${path}' is a section, not a leaf setting. Delete a specific setting path instead.`,
      };
    }

    const keys = path.split('.');
    let current: any = this.config;
    // Navigate to the parent
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!safeHasOwnProperty(current, key)) {
        // Parent missing — nothing to delete; return idempotently
        return { success: true, message: `Setting '${path}' was already unset`, previousValue };
      }
      current = current[key];
    }
    const lastKey = keys[keys.length - 1];
    if (safeHasOwnProperty(current, lastKey)) {
      delete current[lastKey];
    }

    await this.persistMerged(userId, this.config!);

    logger.info('Configuration setting deleted', { path, previousValue });

    return {
      success: true,
      message: `Setting '${path}' deleted (consumer will now see schema default)`,
      previousValue,
      newValue: undefined,
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

  // Removed in Phase 4.5: saveConfig() and backupExists() — file persistence
  // is now handled by the injected IOperatorConfigStore + IUserConfigStore
  // (see persistMerged()). The previous file-write+temp-file+backup pattern
  // moved into the FilesystemImpl of each store, where atomic writes and
  // backup behavior are unified across all storage domains.

  /**
   * Fix incorrect types in config (e.g., string booleans, string "null")
   */
  private fixConfigTypes(): void {
    if (!this.config) return;
    this.fixUserTypes(this.config.user);
    this.fixSyncTypes(this.config.sync);
    this.fixCollectionTypes(this.config.collection);
    this.fixDisplayTypes(this.config.display);
    this.fixGithubTypes(this.config.github);
    this.fixWizardTypes(this.config.wizard);
    this.fixRetentionPolicyTypes(this.config.retentionPolicy);
  }

  private fixUserTypes(user: DollhouseConfig['user'] | undefined): void {
    if (!user) return;
    user.username = fixNull(user.username);
    user.email = fixNull(user.email);
    user.display_name = fixNull(user.display_name);
  }

  private fixSyncTypes(sync: DollhouseConfig['sync'] | undefined): void {
    if (!sync) return;
    sync.enabled = fixBoolean(sync.enabled);
    if (sync.individual) {
      sync.individual.require_confirmation = fixBoolean(sync.individual.require_confirmation);
      sync.individual.show_diff_before_sync = fixBoolean(sync.individual.show_diff_before_sync);
      sync.individual.track_versions = fixBoolean(sync.individual.track_versions);
    }
    if (sync.bulk) {
      sync.bulk.upload_enabled = fixBoolean(sync.bulk.upload_enabled);
      sync.bulk.download_enabled = fixBoolean(sync.bulk.download_enabled);
      sync.bulk.require_preview = fixBoolean(sync.bulk.require_preview);
      sync.bulk.respect_local_only = fixBoolean(sync.bulk.respect_local_only);
    }
    if (sync.privacy) {
      sync.privacy.scan_for_secrets = fixBoolean(sync.privacy.scan_for_secrets);
      sync.privacy.scan_for_pii = fixBoolean(sync.privacy.scan_for_pii);
      sync.privacy.warn_on_sensitive = fixBoolean(sync.privacy.warn_on_sensitive);
    }
  }

  private fixCollectionTypes(collection: DollhouseConfig['collection'] | undefined): void {
    if (!collection) return;
    collection.auto_submit = fixBoolean(collection.auto_submit);
    collection.require_review = fixBoolean(collection.require_review);
    collection.add_attribution = fixBoolean(collection.add_attribution);
  }

  private fixDisplayTypes(display: DollhouseConfig['display'] | undefined): void {
    if (!display) return;
    if (display.persona_indicators) {
      display.persona_indicators.enabled = fixBoolean(display.persona_indicators.enabled);
      display.persona_indicators.include_emoji = fixBoolean(display.persona_indicators.include_emoji);
    }
    display.verbose_logging = fixBoolean(display.verbose_logging);
    display.show_progress = fixBoolean(display.show_progress);
  }

  private fixGithubTypes(github: DollhouseConfig['github'] | undefined): void {
    if (!github) return;
    if (github.portfolio) {
      github.portfolio.repository_url = fixNull(github.portfolio.repository_url);
      github.portfolio.auto_create = fixBoolean(github.portfolio.auto_create);
    }
    if (github.auth) {
      github.auth.use_oauth = fixBoolean(github.auth.use_oauth);
      if (github.auth.client_id) {
        github.auth.client_id = fixNull(github.auth.client_id) || undefined;
      }
    }
  }

  private fixWizardTypes(wizard: DollhouseConfig['wizard'] | undefined): void {
    if (!wizard) return;
    wizard.completed = fixBoolean(wizard.completed);
    wizard.dismissed = fixBoolean(wizard.dismissed);
  }

  private fixRetentionPolicyTypes(retention: DollhouseConfig['retentionPolicy'] | undefined): void {
    if (!retention) return;
    retention.enabled = fixBoolean(retention.enabled);
    if (retention.safety) {
      retention.safety.require_confirmation = fixBoolean(retention.safety.require_confirmation);
      retention.safety.dry_run_first = fixBoolean(retention.safety.dry_run_first);
      retention.safety.warn_on_expiring = fixBoolean(retention.safety.warn_on_expiring);
    }
    if (retention.audit) {
      retention.audit.log_deletions = fixBoolean(retention.audit.log_deletions);
      retention.audit.backup_before_delete = fixBoolean(retention.audit.backup_before_delete);
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
    // NOTE: These are optional custom env vars not in centralized config.
    // They're used for backwards compatibility migration only.
    const ensureConfig = (): DollhouseConfig => (this.config ??= this.getDefaultConfig());
    let migrated = false;

    if (process.env.DOLLHOUSE_USER && !this.config?.user.username) {
      ensureConfig().user.username = process.env.DOLLHOUSE_USER;
      migrated = true;
    }

    if (process.env.DOLLHOUSE_EMAIL && !this.config?.user.email) {
      ensureConfig().user.email = process.env.DOLLHOUSE_EMAIL;
      migrated = true;
    }

    if (process.env.DOLLHOUSE_PORTFOLIO_URL && !this.config?.github.portfolio.repository_url) {
      ensureConfig().github.portfolio.repository_url = process.env.DOLLHOUSE_PORTFOLIO_URL;
      migrated = true;
    }

    if (env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION !== false) {
      ensureConfig().collection.auto_submit = env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;
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
    const userId = this.resolveUserId();
    const defaults = this.getDefaultConfig();

    if (section) {
      // Reset specific section
      if (this.config) {
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
      } else {
        this.config = defaults;
      }

      await this.persistMerged(userId, this.config);

      return {
        success: true,
        message: `Section '${section}' reset to defaults`,
      };
    } else {
      // Reset entire config
      this.config = defaults;
      await this.persistMerged(userId, defaults);

      return {
        success: true,
        message: 'Configuration reset to defaults',
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

      // Persist split across both stores
      await this.persistMerged(this.resolveUserId(), this.config);

      return {
        success: true,
        message: `Configuration imported from ${filePath}`,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
