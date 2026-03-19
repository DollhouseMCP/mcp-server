/**
 * Performance Configuration Constants
 *
 * Centralized configuration for performance-related magic numbers including
 * lock timeouts, metrics batching, cache memory estimation, and other
 * performance-critical constants.
 *
 * All values can be overridden via environment variables for flexibility.
 *
 * @module performance-constants
 */

/**
 * File locking configuration
 *
 * Lock timeout is based on p95 operation time analysis:
 * - Measured p95 operation time: 2.5 seconds
 * - Safety buffer: 4x multiplier
 * - Default timeout: 10 seconds (2.5s * 4)
 *
 * This provides enough time for operations to complete while preventing
 * deadlocks from hung processes.
 */
export const FILE_LOCK_CONFIG = {
  /**
   * Default timeout for lock acquisition (milliseconds)
   *
   * Based on empirical analysis:
   * - P95 file operation time: 2.5s
   * - Buffer multiplier: 4x for safety
   * - Total: 10,000ms (10 seconds)
   *
   * Environment: DOLLHOUSE_LOCK_TIMEOUT
   */
  DEFAULT_TIMEOUT_MS: Number.parseInt(process.env.DOLLHOUSE_LOCK_TIMEOUT || '10000'),

  /**
   * Minimum allowed lock timeout (1 second)
   * Prevents misconfiguration that could cause spurious timeouts
   */
  MIN_TIMEOUT_MS: 1000,

  /**
   * Maximum allowed lock timeout (60 seconds)
   * Prevents indefinite hangs while allowing for slow operations
   */
  MAX_TIMEOUT_MS: 60000,

  /**
   * Stale lock cleanup threshold (milliseconds)
   * Locks older than this are considered abandoned and can be forcibly released
   *
   * Environment: DOLLHOUSE_LOCK_STALE_THRESHOLD
   */
  STALE_THRESHOLD_MS: Number.parseInt(process.env.DOLLHOUSE_LOCK_STALE_THRESHOLD || '60000'),

  /**
   * Lock retry configuration
   */
  RETRY: {
    /**
     * Maximum number of retry attempts for lock acquisition
     *
     * Environment: DOLLHOUSE_LOCK_MAX_RETRIES
     */
    MAX_ATTEMPTS: Number.parseInt(process.env.DOLLHOUSE_LOCK_MAX_RETRIES || '3'),

    /**
     * Initial delay between retries (milliseconds)
     * Uses exponential backoff from this base
     *
     * Environment: DOLLHOUSE_LOCK_RETRY_DELAY
     */
    INITIAL_DELAY_MS: Number.parseInt(process.env.DOLLHOUSE_LOCK_RETRY_DELAY || '100'),
  }
} as const;

/**
 * Metrics batching configuration
 *
 * Optimizes write performance by batching metrics updates:
 * - Batch size tuned for memory vs. latency trade-off
 * - Small batches = lower latency, higher overhead
 * - Large batches = higher latency, lower overhead
 *
 * Current values provide good balance for typical workloads.
 */
export const METRICS_CONFIG = {
  /**
   * Number of metrics to batch before flushing to disk
   *
   * Trade-offs:
   * - Size 10: ~50ms flush latency, minimal memory (chosen for balance)
   * - Size 100: ~200ms flush latency, 10x more memory
   * - Size 1: No batching, highest overhead
   *
   * Environment: DOLLHOUSE_METRICS_BATCH_SIZE
   */
  BATCH_SIZE: Number.parseInt(process.env.DOLLHOUSE_METRICS_BATCH_SIZE || '10'),

  /**
   * Minimum batch size (no batching)
   */
  MIN_BATCH_SIZE: 1,

  /**
   * Maximum batch size to prevent memory issues
   */
  MAX_BATCH_SIZE: 1000,

  /**
   * Time interval to force flush even if batch not full (milliseconds)
   *
   * Ensures metrics are persisted within reasonable time:
   * - 5 seconds provides good balance between freshness and efficiency
   * - Prevents unbounded delay for low-traffic scenarios
   *
   * Environment: DOLLHOUSE_METRICS_FLUSH_INTERVAL
   */
  FLUSH_INTERVAL_MS: Number.parseInt(process.env.DOLLHOUSE_METRICS_FLUSH_INTERVAL || '5000'),

  /**
   * Minimum flush interval (100ms)
   * Prevents excessive disk I/O
   */
  MIN_FLUSH_INTERVAL_MS: 100,

  /**
   * Maximum flush interval (5 minutes)
   * Ensures timely metric persistence
   */
  MAX_FLUSH_INTERVAL_MS: 300000,
} as const;

/**
 * Cache size estimation configuration
 *
 * Fast byte-based heuristics for memory estimation based on V8 memory layout analysis.
 * These values are derived from empirical measurements of V8 object representations.
 *
 * Accuracy vs. Speed trade-offs:
 * - Fast mode: 2-5x faster than JSON.stringify, 50-200% accuracy
 * - Balanced mode: Samples first 10 elements, better accuracy
 * - Accurate mode: Uses JSON.stringify, slowest but most precise
 */
export const CACHE_SIZE_ESTIMATION_CONFIG = {
  /**
   * Size of primitive values in V8 (bytes)
   * Covers numbers, booleans, small integers
   *
   * Based on V8 Smi (Small Integer) representation
   */
  PRIMITIVE_SIZE: 8,

  /**
   * Base memory overhead for JavaScript objects (bytes)
   *
   * Includes:
   * - Object header: ~32 bytes
   * - Hidden class pointer: ~8 bytes
   * - Properties backing store: ~24 bytes
   * - Total: ~64 bytes
   */
  OBJECT_BASE_OVERHEAD: 64,

  /**
   * Base memory overhead for JavaScript arrays (bytes)
   *
   * Includes:
   * - Array header: ~16 bytes
   * - Length property: ~8 bytes
   * - Elements backing store pointer: ~8 bytes
   * - Total: ~32 bytes
   */
  ARRAY_BASE_OVERHEAD: 32,

  /**
   * Memory overhead per object field/property (bytes)
   *
   * Includes:
   * - Property name string: ~24 bytes average
   * - Property value pointer: ~8 bytes
   * - Property descriptor: ~16 bytes
   * - Total: ~48 bytes
   */
  FIELD_OVERHEAD: 48,

  /**
   * Average element size estimate for arrays (bytes)
   *
   * Conservative estimate for mixed content:
   * - Small objects: ~32 bytes
   * - Strings: ~64 bytes average
   * - Numbers: ~8 bytes
   * - Average: ~64 bytes
   */
  ELEMENT_ESTIMATE: 64,

  /**
   * Number of elements to sample in balanced mode
   *
   * Sampling first 10 elements provides:
   * - ~85% accuracy for homogeneous arrays
   * - ~70% accuracy for mixed content
   * - 2-3x speedup over full traversal
   */
  BALANCED_SAMPLE_SIZE: Number.parseInt(process.env.DOLLHOUSE_CACHE_SAMPLE_SIZE || '10'),

  /**
   * Minimum sample size for balanced mode
   */
  MIN_SAMPLE_SIZE: 1,

  /**
   * Maximum sample size for balanced mode
   * Prevents excessive sampling overhead
   */
  MAX_SAMPLE_SIZE: 100,
} as const;

/**
 * Memory limits for various cache types
 *
 * These limits prevent unbounded memory growth and provide
 * reasonable defaults for different use cases.
 */
export const MEMORY_LIMITS = {
  /**
   * Cache limits for persona data
   */
  PERSONA_CACHE: {
    /**
     * Maximum number of cached persona entries
     * Environment: DOLLHOUSE_MAX_PERSONA_CACHE_SIZE
     */
    MAX_SIZE: Number.parseInt(process.env.DOLLHOUSE_MAX_PERSONA_CACHE_SIZE || '50'),

    /**
     * Maximum memory for persona cache (MB)
     * Environment: DOLLHOUSE_MAX_PERSONA_CACHE_MEMORY
     */
    MAX_MEMORY_MB: Number.parseInt(process.env.DOLLHOUSE_MAX_PERSONA_CACHE_MEMORY || '25'),
  },

  /**
   * Cache limits for metrics data
   */
  METRICS_CACHE: {
    /**
     * Maximum number of cached metrics entries
     * Environment: DOLLHOUSE_MAX_METRICS_CACHE_SIZE
     */
    MAX_SIZE: Number.parseInt(process.env.DOLLHOUSE_MAX_METRICS_CACHE_SIZE || '100'),

    /**
     * Maximum memory for metrics cache (MB)
     * Environment: DOLLHOUSE_MAX_METRICS_CACHE_MEMORY
     */
    MAX_MEMORY_MB: Number.parseInt(process.env.DOLLHOUSE_MAX_METRICS_CACHE_MEMORY || '1'),
  },

  /**
   * Cache limits for search results
   */
  SEARCH_CACHE: {
    /**
     * Maximum number of cached search results
     * Environment: DOLLHOUSE_MAX_SEARCH_CACHE_SIZE
     */
    MAX_SIZE: Number.parseInt(process.env.DOLLHOUSE_MAX_SEARCH_CACHE_SIZE || '100'),

    /**
     * Maximum memory for search cache (MB)
     * Environment: DOLLHOUSE_MAX_SEARCH_CACHE_MEMORY
     */
    MAX_MEMORY_MB: Number.parseInt(process.env.DOLLHOUSE_MAX_SEARCH_CACHE_MEMORY || '10'),
  },

  /**
   * Cache limits for index data
   */
  INDEX_CACHE: {
    /**
     * Maximum number of cached index entries
     * Environment: DOLLHOUSE_MAX_INDEX_CACHE_SIZE
     */
    MAX_SIZE: Number.parseInt(process.env.DOLLHOUSE_MAX_INDEX_CACHE_SIZE || '50'),

    /**
     * Maximum memory for index cache (MB)
     * Environment: DOLLHOUSE_MAX_INDEX_CACHE_MEMORY
     */
    MAX_MEMORY_MB: Number.parseInt(process.env.DOLLHOUSE_MAX_INDEX_CACHE_MEMORY || '25'),
  },

  /**
   * Cache limits for API responses
   */
  API_CACHE: {
    /**
     * Maximum number of cached API responses
     * Environment: DOLLHOUSE_MAX_API_CACHE_SIZE
     */
    MAX_SIZE: Number.parseInt(process.env.DOLLHOUSE_MAX_API_CACHE_SIZE || '200'),

    /**
     * Maximum memory for API cache (MB)
     * Environment: DOLLHOUSE_MAX_API_CACHE_MEMORY
     */
    MAX_MEMORY_MB: Number.parseInt(process.env.DOLLHOUSE_MAX_API_CACHE_MEMORY || '5'),
  },
} as const;

/**
 * Storage layer configuration
 *
 * Centralizes TTL, cooldown, and debounce values used by ElementStorageLayer,
 * MemoryStorageLayer, and tool discovery caching. Each constant supports a
 * DOLLHOUSE_* env var with a legacy fallback for backward compatibility.
 */
export const STORAGE_LAYER_CONFIG = {
  /**
   * Minimum interval between full directory scans (milliseconds)
   * Prevents excessive I/O on rapid list() calls.
   *
   * Environment: DOLLHOUSE_SCAN_COOLDOWN_MS (legacy: ELEMENT_SCAN_COOLDOWN_MS)
   */
  SCAN_COOLDOWN_MS: Number.parseInt(
    process.env.DOLLHOUSE_SCAN_COOLDOWN_MS ?? process.env.ELEMENT_SCAN_COOLDOWN_MS ?? '1000'
  ),
  MIN_SCAN_COOLDOWN_MS: 100,
  MAX_SCAN_COOLDOWN_MS: 60000,

  /**
   * Debounce interval for persisting _index.json in MemoryStorageLayer (milliseconds)
   *
   * Environment: DOLLHOUSE_INDEX_DEBOUNCE_MS (legacy: MEMORY_INDEX_DEBOUNCE_MS)
   */
  INDEX_DEBOUNCE_MS: Number.parseInt(
    process.env.DOLLHOUSE_INDEX_DEBOUNCE_MS ?? process.env.MEMORY_INDEX_DEBOUNCE_MS ?? '2000'
  ),
  MIN_INDEX_DEBOUNCE_MS: 100,
  MAX_INDEX_DEBOUNCE_MS: 30000,

  /**
   * TTL for element LRU caches in BaseElementManager (milliseconds)
   * Default: 1 hour. This is a safety net only — the storage layer's mtime-based
   * scanning handles real freshness detection. Set to 0 to disable TTL entirely.
   *
   * Environment: DOLLHOUSE_ELEMENT_CACHE_TTL_MS (legacy: ELEMENT_CACHE_TTL_MS)
   */
  ELEMENT_CACHE_TTL_MS: Number.parseInt(
    process.env.DOLLHOUSE_ELEMENT_CACHE_TTL_MS ?? process.env.ELEMENT_CACHE_TTL_MS ?? '3600000'
  ),
  MIN_ELEMENT_CACHE_TTL_MS: 0,
  MAX_ELEMENT_CACHE_TTL_MS: 3600000,

  /**
   * TTL for file-path-to-ID reverse index caches (milliseconds)
   * Default: 1 hour. Set to 0 to disable TTL (rely on storage layer mtime scanning).
   *
   * Environment: DOLLHOUSE_PATH_CACHE_TTL_MS (legacy: ELEMENT_PATH_CACHE_TTL_MS)
   */
  PATH_CACHE_TTL_MS: Number.parseInt(
    process.env.DOLLHOUSE_PATH_CACHE_TTL_MS ?? process.env.ELEMENT_PATH_CACHE_TTL_MS ?? '3600000'
  ),
  MIN_PATH_CACHE_TTL_MS: 0,
  MAX_PATH_CACHE_TTL_MS: 3600000,

  /**
   * TTL for tool discovery cache in ServerSetup (milliseconds)
   *
   * Environment: DOLLHOUSE_TOOL_CACHE_TTL_MS
   */
  TOOL_CACHE_TTL_MS: Number.parseInt(
    process.env.DOLLHOUSE_TOOL_CACHE_TTL_MS ?? '60000'
  ),
  MIN_TOOL_CACHE_TTL_MS: 5000,
  MAX_TOOL_CACHE_TTL_MS: 600000,

  /**
   * Global memory budget for all registered LRU caches (bytes)
   * Provides a cross-cache ceiling that triggers eviction from the least-active
   * cache when the aggregate memory usage exceeds this limit.
   *
   * Environment: DOLLHOUSE_GLOBAL_CACHE_MEMORY_MB (default: 150 MB)
   */
  GLOBAL_CACHE_MEMORY_BYTES: Number.parseInt(
    process.env.DOLLHOUSE_GLOBAL_CACHE_MEMORY_MB ?? '150'
  ) * 1024 * 1024,
  MIN_GLOBAL_CACHE_MEMORY_MB: 20,
  MAX_GLOBAL_CACHE_MEMORY_MB: 1000,

  /**
   * Maximum backup files to keep per memory name per date folder.
   * When a new backup is created and the count exceeds this limit,
   * the oldest backups for that memory are deleted.
   *
   * Environment: DOLLHOUSE_MAX_BACKUPS_PER_MEMORY (default: 3)
   */
  MAX_BACKUPS_PER_MEMORY: Number.parseInt(
    process.env.DOLLHOUSE_MAX_BACKUPS_PER_MEMORY ?? '3'
  ),
  MIN_BACKUPS_PER_MEMORY: 1,
  MAX_BACKUPS_PER_MEMORY_LIMIT: 50,

  /**
   * Maximum backup files to keep per element per date folder (all non-memory types).
   * When a new backup is created and the count exceeds this limit,
   * the oldest backups for that element are deleted.
   *
   * Environment: DOLLHOUSE_MAX_BACKUPS_PER_ELEMENT (default: 3)
   */
  MAX_BACKUPS_PER_ELEMENT: Number.parseInt(
    process.env.DOLLHOUSE_MAX_BACKUPS_PER_ELEMENT ?? '3'
  ),
  MIN_BACKUPS_PER_ELEMENT: 1,
  MAX_BACKUPS_PER_ELEMENT_LIMIT: 50,

  /**
   * Whether element backups are enabled.
   * Set to 'false' to disable automatic pre-save and pre-delete backups.
   *
   * Environment: DOLLHOUSE_BACKUPS_ENABLED (default: true)
   */
  BACKUPS_ENABLED: process.env.DOLLHOUSE_BACKUPS_ENABLED !== 'false',

  /**
   * Maximum age in days for backup date folders.
   * Date folders older than this are eligible for automatic cleanup.
   * Set to 0 to disable age-based cleanup.
   *
   * Environment: DOLLHOUSE_BACKUP_RETENTION_DAYS (default: 7)
   */
  BACKUP_RETENTION_DAYS: Number.parseInt(
    process.env.DOLLHOUSE_BACKUP_RETENTION_DAYS ?? '7'
  ),
  MIN_BACKUP_RETENTION_DAYS: 1,
  MAX_BACKUP_RETENTION_DAYS: 365,

  /**
   * Debounce window for memory saves (milliseconds).
   * When addEntry is called rapidly, saves are coalesced — only the latest
   * state is written to disk after this delay. Prevents FD exhaustion from
   * high-frequency memory updates (Issue #656).
   *
   * Environment: DOLLHOUSE_MEMORY_SAVE_DEBOUNCE_MS (default: 2000)
   */
  MEMORY_SAVE_DEBOUNCE_MS: Number.parseInt(
    process.env.DOLLHOUSE_MEMORY_SAVE_DEBOUNCE_MS ?? '2000'
  ),
  MIN_MEMORY_SAVE_DEBOUNCE_MS: 500,
  MAX_MEMORY_SAVE_DEBOUNCE_MS: 30000,

  /**
   * Save frequency monitoring window (milliseconds).
   * Tracks addEntry calls per memory within this window.
   * When a memory exceeds MEMORY_SAVE_FREQUENCY_WARN_THRESHOLD
   * calls in this window, a warning is logged.
   *
   * Issue #657: Detect runaway save loops before they exhaust resources.
   *
   * Environment: DOLLHOUSE_MEMORY_SAVE_MONITOR_WINDOW_MS (default: 60000 = 1 minute)
   */
  MEMORY_SAVE_MONITOR_WINDOW_MS: Math.max(5000, Math.min(300000,
    Number.parseInt(process.env.DOLLHOUSE_MEMORY_SAVE_MONITOR_WINDOW_MS ?? '60000')
  )),

  /**
   * Warn threshold: number of addEntry calls per memory per monitor window.
   * If exceeded, log a warning. Default: 50 calls/minute. Range: 5–10000.
   *
   * Environment: DOLLHOUSE_MEMORY_SAVE_FREQUENCY_WARN (default: 50)
   */
  MEMORY_SAVE_FREQUENCY_WARN_THRESHOLD: Math.max(5, Math.min(10000,
    Number.parseInt(process.env.DOLLHOUSE_MEMORY_SAVE_FREQUENCY_WARN ?? '50')
  )),

  /**
   * Critical threshold: number of addEntry calls per memory per monitor window.
   * If exceeded, log an error-level alert. Default: 200 calls/minute. Range: 10–50000.
   *
   * Environment: DOLLHOUSE_MEMORY_SAVE_FREQUENCY_CRITICAL (default: 200)
   */
  MEMORY_SAVE_FREQUENCY_CRITICAL_THRESHOLD: Math.max(10, Math.min(50000,
    Number.parseInt(process.env.DOLLHOUSE_MEMORY_SAVE_FREQUENCY_CRITICAL ?? '200')
  )),
} as const;

/**
 * Get validated scan cooldown within acceptable bounds
 */
export function getValidatedScanCooldown(): number {
  const value = STORAGE_LAYER_CONFIG.SCAN_COOLDOWN_MS;
  if (value < STORAGE_LAYER_CONFIG.MIN_SCAN_COOLDOWN_MS) return STORAGE_LAYER_CONFIG.MIN_SCAN_COOLDOWN_MS;
  if (value > STORAGE_LAYER_CONFIG.MAX_SCAN_COOLDOWN_MS) return STORAGE_LAYER_CONFIG.MAX_SCAN_COOLDOWN_MS;
  return value;
}

/**
 * Get validated index debounce within acceptable bounds
 */
export function getValidatedIndexDebounce(): number {
  const value = STORAGE_LAYER_CONFIG.INDEX_DEBOUNCE_MS;
  if (value < STORAGE_LAYER_CONFIG.MIN_INDEX_DEBOUNCE_MS) return STORAGE_LAYER_CONFIG.MIN_INDEX_DEBOUNCE_MS;
  if (value > STORAGE_LAYER_CONFIG.MAX_INDEX_DEBOUNCE_MS) return STORAGE_LAYER_CONFIG.MAX_INDEX_DEBOUNCE_MS;
  return value;
}

/**
 * Get validated element cache TTL within acceptable bounds
 */
export function getValidatedElementCacheTTL(): number {
  const value = STORAGE_LAYER_CONFIG.ELEMENT_CACHE_TTL_MS;
  if (value < STORAGE_LAYER_CONFIG.MIN_ELEMENT_CACHE_TTL_MS) return STORAGE_LAYER_CONFIG.MIN_ELEMENT_CACHE_TTL_MS;
  if (value > STORAGE_LAYER_CONFIG.MAX_ELEMENT_CACHE_TTL_MS) return STORAGE_LAYER_CONFIG.MAX_ELEMENT_CACHE_TTL_MS;
  return value;
}

/**
 * Get validated path cache TTL within acceptable bounds
 */
export function getValidatedPathCacheTTL(): number {
  const value = STORAGE_LAYER_CONFIG.PATH_CACHE_TTL_MS;
  if (value < STORAGE_LAYER_CONFIG.MIN_PATH_CACHE_TTL_MS) return STORAGE_LAYER_CONFIG.MIN_PATH_CACHE_TTL_MS;
  if (value > STORAGE_LAYER_CONFIG.MAX_PATH_CACHE_TTL_MS) return STORAGE_LAYER_CONFIG.MAX_PATH_CACHE_TTL_MS;
  return value;
}

/**
 * Get validated tool cache TTL within acceptable bounds
 */
export function getValidatedToolCacheTTL(): number {
  const value = STORAGE_LAYER_CONFIG.TOOL_CACHE_TTL_MS;
  if (value < STORAGE_LAYER_CONFIG.MIN_TOOL_CACHE_TTL_MS) return STORAGE_LAYER_CONFIG.MIN_TOOL_CACHE_TTL_MS;
  if (value > STORAGE_LAYER_CONFIG.MAX_TOOL_CACHE_TTL_MS) return STORAGE_LAYER_CONFIG.MAX_TOOL_CACHE_TTL_MS;
  return value;
}

/**
 * Get validated max backups per element within acceptable bounds
 */
export function getValidatedMaxBackupsPerElement(): number {
  const value = STORAGE_LAYER_CONFIG.MAX_BACKUPS_PER_ELEMENT;
  if (value < STORAGE_LAYER_CONFIG.MIN_BACKUPS_PER_ELEMENT) return STORAGE_LAYER_CONFIG.MIN_BACKUPS_PER_ELEMENT;
  if (value > STORAGE_LAYER_CONFIG.MAX_BACKUPS_PER_ELEMENT_LIMIT) return STORAGE_LAYER_CONFIG.MAX_BACKUPS_PER_ELEMENT_LIMIT;
  return value;
}

/**
 * Get validated global cache memory budget in bytes
 */
export function getValidatedGlobalCacheMemoryBytes(): number {
  const valueMB = Number.parseInt(process.env.DOLLHOUSE_GLOBAL_CACHE_MEMORY_MB ?? '150');
  if (valueMB < STORAGE_LAYER_CONFIG.MIN_GLOBAL_CACHE_MEMORY_MB) {
    return STORAGE_LAYER_CONFIG.MIN_GLOBAL_CACHE_MEMORY_MB * 1024 * 1024;
  }
  if (valueMB > STORAGE_LAYER_CONFIG.MAX_GLOBAL_CACHE_MEMORY_MB) {
    return STORAGE_LAYER_CONFIG.MAX_GLOBAL_CACHE_MEMORY_MB * 1024 * 1024;
  }
  return valueMB * 1024 * 1024;
}

/**
 * Environment variable names for documentation and tooling
 */
export const ENV_VARS = {
  // File lock configuration
  LOCK_TIMEOUT: 'DOLLHOUSE_LOCK_TIMEOUT',
  LOCK_STALE_THRESHOLD: 'DOLLHOUSE_LOCK_STALE_THRESHOLD',
  LOCK_MAX_RETRIES: 'DOLLHOUSE_LOCK_MAX_RETRIES',
  LOCK_RETRY_DELAY: 'DOLLHOUSE_LOCK_RETRY_DELAY',

  // Metrics configuration
  METRICS_BATCH_SIZE: 'DOLLHOUSE_METRICS_BATCH_SIZE',
  METRICS_FLUSH_INTERVAL: 'DOLLHOUSE_METRICS_FLUSH_INTERVAL',

  // Cache configuration
  CACHE_SAMPLE_SIZE: 'DOLLHOUSE_CACHE_SAMPLE_SIZE',

  // Storage layer configuration
  SCAN_COOLDOWN: 'DOLLHOUSE_SCAN_COOLDOWN_MS',
  INDEX_DEBOUNCE: 'DOLLHOUSE_INDEX_DEBOUNCE_MS',
  ELEMENT_CACHE_TTL: 'DOLLHOUSE_ELEMENT_CACHE_TTL_MS',
  PATH_CACHE_TTL: 'DOLLHOUSE_PATH_CACHE_TTL_MS',
  TOOL_CACHE_TTL: 'DOLLHOUSE_TOOL_CACHE_TTL_MS',
  GLOBAL_CACHE_MEMORY: 'DOLLHOUSE_GLOBAL_CACHE_MEMORY_MB',

  // Backup configuration
  MAX_BACKUPS_PER_ELEMENT: 'DOLLHOUSE_MAX_BACKUPS_PER_ELEMENT',
  BACKUPS_ENABLED: 'DOLLHOUSE_BACKUPS_ENABLED',

  // Memory limits
  MAX_PERSONA_CACHE_SIZE: 'DOLLHOUSE_MAX_PERSONA_CACHE_SIZE',
  MAX_PERSONA_CACHE_MEMORY: 'DOLLHOUSE_MAX_PERSONA_CACHE_MEMORY',
  MAX_METRICS_CACHE_SIZE: 'DOLLHOUSE_MAX_METRICS_CACHE_SIZE',
  MAX_METRICS_CACHE_MEMORY: 'DOLLHOUSE_MAX_METRICS_CACHE_MEMORY',
  MAX_SEARCH_CACHE_SIZE: 'DOLLHOUSE_MAX_SEARCH_CACHE_SIZE',
  MAX_SEARCH_CACHE_MEMORY: 'DOLLHOUSE_MAX_SEARCH_CACHE_MEMORY',
  MAX_INDEX_CACHE_SIZE: 'DOLLHOUSE_MAX_INDEX_CACHE_SIZE',
  MAX_INDEX_CACHE_MEMORY: 'DOLLHOUSE_MAX_INDEX_CACHE_MEMORY',
  MAX_API_CACHE_SIZE: 'DOLLHOUSE_MAX_API_CACHE_SIZE',
  MAX_API_CACHE_MEMORY: 'DOLLHOUSE_MAX_API_CACHE_MEMORY',
} as const;

/**
 * Validation Helpers
 */

/**
 * Get validated lock timeout within acceptable bounds
 *
 * @returns Validated timeout in milliseconds (1s - 60s)
 *
 * @example
 * ```typescript
 * const timeout = getValidatedLockTimeout();
 * // Returns value between 1000 and 60000
 * ```
 */
export function getValidatedLockTimeout(): number {
  const timeout = FILE_LOCK_CONFIG.DEFAULT_TIMEOUT_MS;

  if (timeout < FILE_LOCK_CONFIG.MIN_TIMEOUT_MS) {
    return FILE_LOCK_CONFIG.MIN_TIMEOUT_MS;
  }

  if (timeout > FILE_LOCK_CONFIG.MAX_TIMEOUT_MS) {
    return FILE_LOCK_CONFIG.MAX_TIMEOUT_MS;
  }

  return timeout;
}

/**
 * Get validated metrics batch size within acceptable bounds
 *
 * @returns Validated batch size (1 - 1000)
 *
 * @example
 * ```typescript
 * const batchSize = getValidatedBatchSize();
 * // Returns value between 1 and 1000
 * ```
 */
export function getValidatedBatchSize(): number {
  const batchSize = METRICS_CONFIG.BATCH_SIZE;

  if (batchSize < METRICS_CONFIG.MIN_BATCH_SIZE) {
    return METRICS_CONFIG.MIN_BATCH_SIZE;
  }

  if (batchSize > METRICS_CONFIG.MAX_BATCH_SIZE) {
    return METRICS_CONFIG.MAX_BATCH_SIZE;
  }

  return batchSize;
}

/**
 * Get validated metrics flush interval within acceptable bounds
 *
 * @returns Validated flush interval in milliseconds (100ms - 5min)
 *
 * @example
 * ```typescript
 * const interval = getValidatedFlushInterval();
 * // Returns value between 100 and 300000
 * ```
 */
export function getValidatedFlushInterval(): number {
  const interval = METRICS_CONFIG.FLUSH_INTERVAL_MS;

  if (interval < METRICS_CONFIG.MIN_FLUSH_INTERVAL_MS) {
    return METRICS_CONFIG.MIN_FLUSH_INTERVAL_MS;
  }

  if (interval > METRICS_CONFIG.MAX_FLUSH_INTERVAL_MS) {
    return METRICS_CONFIG.MAX_FLUSH_INTERVAL_MS;
  }

  return interval;
}

/**
 * Get validated cache sample size for balanced estimation mode
 *
 * @returns Validated sample size (1 - 100)
 *
 * @example
 * ```typescript
 * const sampleSize = getValidatedSampleSize();
 * // Returns value between 1 and 100
 * ```
 */
export function getValidatedSampleSize(): number {
  const sampleSize = CACHE_SIZE_ESTIMATION_CONFIG.BALANCED_SAMPLE_SIZE;

  if (sampleSize < CACHE_SIZE_ESTIMATION_CONFIG.MIN_SAMPLE_SIZE) {
    return CACHE_SIZE_ESTIMATION_CONFIG.MIN_SAMPLE_SIZE;
  }

  if (sampleSize > CACHE_SIZE_ESTIMATION_CONFIG.MAX_SAMPLE_SIZE) {
    return CACHE_SIZE_ESTIMATION_CONFIG.MAX_SAMPLE_SIZE;
  }

  return sampleSize;
}

/**
 * Calculate retry delay using exponential backoff
 *
 * @param attempt - Current retry attempt number (1-based)
 * @returns Delay in milliseconds for this attempt
 *
 * @example
 * ```typescript
 * const delay = calculateLockRetryDelay(3);
 * // Returns 400ms (100 * 2^2)
 * ```
 */
export function calculateLockRetryDelay(attempt: number): number {
  const backoffMultiplier = 2;
  const delay = FILE_LOCK_CONFIG.RETRY.INITIAL_DELAY_MS * Math.pow(backoffMultiplier, attempt - 1);

  // Cap at max timeout to prevent excessive delays
  return Math.min(delay, FILE_LOCK_CONFIG.MAX_TIMEOUT_MS);
}
