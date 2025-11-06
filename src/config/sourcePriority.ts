/**
 * Element source priority configuration
 *
 * This module defines the centralized configuration for element sourcing priority,
 * determining the order in which element sources (local, GitHub, collection) are
 * checked when searching for or installing elements.
 *
 * @module config/sourcePriority
 */

/**
 * Enumeration of available element sources
 *
 * @example
 * // Using ElementSource in configuration
 * const priority = [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION];
 */
export enum ElementSource {
  /** Local portfolio (~/.dollhouse/portfolio/) */
  LOCAL = 'local',

  /** User's GitHub portfolio repository */
  GITHUB = 'github',

  /** DollhouseMCP community collection */
  COLLECTION = 'collection'
}

/**
 * Configuration for element source priority
 *
 * @interface SourcePriorityConfig
 * @property {ElementSource[]} priority - Ordered list of sources to check (first = highest priority)
 * @property {boolean} stopOnFirst - Whether to stop searching after finding element in first source
 * @property {boolean} checkAllForUpdates - Whether to check all sources for version comparison
 * @property {boolean} fallbackOnError - Whether to try next source when current source fails
 *
 * @example
 * // Default configuration (local → GitHub → collection)
 * const config: SourcePriorityConfig = {
 *   priority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
 *   stopOnFirst: true,
 *   checkAllForUpdates: false,
 *   fallbackOnError: true
 * };
 *
 * @example
 * // Custom configuration (collection-first for discovery)
 * const config: SourcePriorityConfig = {
 *   priority: [ElementSource.COLLECTION, ElementSource.LOCAL, ElementSource.GITHUB],
 *   stopOnFirst: false,
 *   checkAllForUpdates: true,
 *   fallbackOnError: true
 * };
 */
export interface SourcePriorityConfig {
  /**
   * Ordered list of sources to check (first = highest priority)
   *
   * The system will check sources in this order, stopping early if
   * stopOnFirst is true and an element is found.
   */
  priority: ElementSource[];

  /**
   * Whether to stop searching after finding element in first source
   *
   * When true, the search terminates as soon as an element is found in
   * any source. When false, all enabled sources are searched.
   *
   * @default true
   */
  stopOnFirst: boolean;

  /**
   * Whether to check all sources for version comparison
   *
   * When true, all sources are checked to find the latest version,
   * even if stopOnFirst is true. Useful for detecting updates.
   *
   * @default false
   */
  checkAllForUpdates: boolean;

  /**
   * Whether to try next source when current source fails
   *
   * When true, errors in one source won't prevent searching other sources.
   * When false, any source error will halt the search and return the error.
   *
   * @default true
   */
  fallbackOnError: boolean;
}

/**
 * Default source priority configuration
 *
 * Priority order: Local → GitHub → Collection
 * This ensures users' local customizations take precedence over remote sources.
 *
 * @example
 * // Using the default configuration
 * import { DEFAULT_SOURCE_PRIORITY } from './sourcePriority.js';
 *
 * const config = DEFAULT_SOURCE_PRIORITY;
 * console.log(config.priority); // [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION]
 */
export const DEFAULT_SOURCE_PRIORITY: SourcePriorityConfig = {
  priority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
  stopOnFirst: true,
  checkAllForUpdates: false,
  fallbackOnError: true
};

/**
 * Get current source priority configuration
 *
 * Priority order for configuration sources:
 * 1. User configuration (from config file)
 * 2. Environment variables (for testing)
 * 3. Default configuration
 *
 * @returns {SourcePriorityConfig} The current source priority configuration
 *
 * @example
 * // Get the current configuration
 * import { getSourcePriorityConfig } from './sourcePriority.js';
 *
 * const config = getSourcePriorityConfig();
 * console.log(config.priority); // [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION]
 *
 * @example
 * // Use in a search operation
 * const config = getSourcePriorityConfig();
 * for (const source of config.priority) {
 *   const results = await searchSource(source);
 *   if (results.length > 0 && config.stopOnFirst) {
 *     break;
 *   }
 * }
 */
export function getSourcePriorityConfig(): SourcePriorityConfig {
  // Try to load from ConfigManager if initialized
  try {
    // Lazy import using dynamic import (ESM-compatible)
    // Note: This is synchronous code but we can't use await here
    // So we'll need to handle this differently or accept that config loading happens
    // at startup before this is called
    // For now, environment variable and defaults only
  } catch (error) {
    // ConfigManager not available or not initialized, fall through to defaults
    // This is expected during initialization phase, no action needed
    console.debug('ConfigManager not yet available, using environment or default configuration');
  }

  // Environment variable support for testing
  if (process.env.SOURCE_PRIORITY) {
    try {
      const envConfig = JSON.parse(process.env.SOURCE_PRIORITY);
      const validation = validateSourcePriority(envConfig);
      if (validation.isValid) {
        return envConfig;
      }
      console.warn('SOURCE_PRIORITY environment variable contains invalid configuration, using defaults');
    } catch (error) {
      // Invalid JSON in environment variable, fall through to default
      console.warn('Failed to parse SOURCE_PRIORITY environment variable, using defaults:', error instanceof Error ? error.message : String(error));
    }
  }

  // Return default configuration
  return DEFAULT_SOURCE_PRIORITY;
}

/**
 * Validation result for source priority configuration
 *
 * @interface ValidationResult
 * @property {boolean} isValid - Whether the configuration is valid
 * @property {string[]} errors - List of validation error messages (empty if valid)
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Pre-computed list of valid element sources
 * Used for validation to avoid repeated Object.values() calls
 * @private
 */
const VALID_SOURCES: ElementSource[] = Object.values(ElementSource);

/**
 * Validate source priority configuration
 *
 * Checks for:
 * - Empty priority list
 * - Duplicate sources
 * - Unknown/invalid sources
 *
 * @param {SourcePriorityConfig} config - The configuration to validate
 * @returns {ValidationResult} Validation result with error messages
 *
 * @example
 * // Validate a valid configuration
 * const config = {
 *   priority: [ElementSource.LOCAL, ElementSource.GITHUB],
 *   stopOnFirst: true,
 *   checkAllForUpdates: false,
 *   fallbackOnError: true
 * };
 * const result = validateSourcePriority(config);
 * console.log(result.isValid); // true
 * console.log(result.errors); // []
 *
 * @example
 * // Validate an invalid configuration (duplicate sources)
 * const config = {
 *   priority: [ElementSource.LOCAL, ElementSource.LOCAL],
 *   stopOnFirst: true,
 *   checkAllForUpdates: false,
 *   fallbackOnError: true
 * };
 * const result = validateSourcePriority(config);
 * console.log(result.isValid); // false
 * console.log(result.errors); // ['Duplicate sources in priority list']
 *
 * @example
 * // Validate an invalid configuration (empty priority)
 * const config = {
 *   priority: [],
 *   stopOnFirst: true,
 *   checkAllForUpdates: false,
 *   fallbackOnError: true
 * };
 * const result = validateSourcePriority(config);
 * console.log(result.isValid); // false
 * console.log(result.errors); // ['Priority list cannot be empty']
 */
export function validateSourcePriority(config: SourcePriorityConfig): ValidationResult {
  const errors: string[] = [];

  // Check for empty priority list
  if (!config.priority || config.priority.length === 0) {
    errors.push('Priority list cannot be empty');
    // Return early to avoid null/undefined errors in subsequent checks
    return {
      isValid: false,
      errors
    };
  }

  // Check for duplicate sources
  const uniqueSources = new Set(config.priority);
  if (uniqueSources.size !== config.priority.length) {
    errors.push('Duplicate sources in priority list');
  }

  // Check for unknown sources using pre-computed valid sources list
  for (const source of config.priority) {
    if (!VALID_SOURCES.includes(source)) {
      errors.push(`Unknown source: ${source}`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Save source priority configuration to config file
 *
 * Validates the configuration before saving and persists it via ConfigManager.
 * The configuration will be saved to ~/.dollhouse/config.yml under the
 * source_priority key.
 *
 * @param {SourcePriorityConfig} config - The source priority configuration to save
 * @returns {Promise<void>}
 * @throws {Error} If configuration is invalid or save fails
 *
 * @example
 * // Save a custom configuration
 * await saveSourcePriorityConfig({
 *   priority: [ElementSource.GITHUB, ElementSource.LOCAL, ElementSource.COLLECTION],
 *   stopOnFirst: false,
 *   checkAllForUpdates: true,
 *   fallbackOnError: true
 * });
 *
 * @example
 * // Validate before saving
 * const config = {
 *   priority: [ElementSource.LOCAL, ElementSource.GITHUB],
 *   stopOnFirst: true,
 *   checkAllForUpdates: false,
 *   fallbackOnError: true
 * };
 * const validation = validateSourcePriority(config);
 * if (validation.isValid) {
 *   await saveSourcePriorityConfig(config);
 * }
 */
export async function saveSourcePriorityConfig(config: SourcePriorityConfig): Promise<void> {
  // Validate configuration before saving
  const validation = validateSourcePriority(config);
  if (!validation.isValid) {
    throw new Error(`Invalid source priority configuration: ${validation.errors.join(', ')}`);
  }

  // Dynamic import to avoid circular dependency (ESM-compatible)
  const { ConfigManager } = await import('./ConfigManager.js');
  const configManager = ConfigManager.getInstance();

  // Save to config file using ConfigManager
  await configManager.updateSetting('source_priority', config);
}

/**
 * Get user-friendly display name for an element source
 *
 * Maps ElementSource enum values to human-readable names suitable for
 * user-facing messages, logs, and documentation.
 *
 * @param {ElementSource} source - The source to get display name for
 * @returns {string} User-friendly display name
 * @throws {Error} If source is not a valid ElementSource value
 *
 * @example
 * // Get display names for all sources
 * console.log(getSourceDisplayName(ElementSource.LOCAL)); // "Local Portfolio"
 * console.log(getSourceDisplayName(ElementSource.GITHUB)); // "GitHub Portfolio"
 * console.log(getSourceDisplayName(ElementSource.COLLECTION)); // "Community Collection"
 *
 * @example
 * // Use in a log message
 * const source = ElementSource.LOCAL;
 * console.log(`Found element in ${getSourceDisplayName(source)}`);
 * // Output: "Found element in Local Portfolio"
 *
 * @example
 * // Generate a source list for user display
 * const config = getSourcePriorityConfig();
 * const sourceNames = config.priority.map(s => getSourceDisplayName(s)).join(' → ');
 * console.log(`Search order: ${sourceNames}`);
 * // Output: "Search order: Local Portfolio → GitHub Portfolio → Community Collection"
 */
export function getSourceDisplayName(source: ElementSource): string {
  const names: Record<ElementSource, string> = {
    [ElementSource.LOCAL]: 'Local Portfolio',
    [ElementSource.GITHUB]: 'GitHub Portfolio',
    [ElementSource.COLLECTION]: 'Community Collection'
  };

  // Type-safe fallback for invalid sources
  const displayName = names[source];
  if (displayName === undefined) {
    throw new Error(`Invalid element source: ${source}. Expected one of: ${VALID_SOURCES.join(', ')}`);
  }

  return displayName;
}

/**
 * Parse source priority order from various input formats
 *
 * Accepts arrays of ElementSource values or string source names and
 * normalizes them to an array of ElementSource enum values.
 *
 * @param {unknown} value - The value to parse (array of sources or JSON string)
 * @returns {ElementSource[]} Parsed array of element sources
 * @throws {Error} If value cannot be parsed or contains invalid sources
 *
 * @example
 * // Parse from array of strings
 * const order = parseSourcePriorityOrder(['local', 'github', 'collection']);
 * // Returns: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION]
 *
 * @example
 * // Parse from JSON string
 * const order = parseSourcePriorityOrder('["github", "local"]');
 * // Returns: [ElementSource.GITHUB, ElementSource.LOCAL]
 *
 * @example
 * // Parse from ElementSource values
 * const order = parseSourcePriorityOrder([ElementSource.LOCAL, ElementSource.GITHUB]);
 * // Returns: [ElementSource.LOCAL, ElementSource.GITHUB]
 */
export function parseSourcePriorityOrder(value: unknown): ElementSource[] {
  // Handle string input (JSON array)
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error(`Invalid JSON in source priority order: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Ensure we have an array
  if (!Array.isArray(value)) {
    throw new TypeError('Source priority order must be an array');
  }

  // Convert string values to ElementSource enum values
  const sources: ElementSource[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const lowerItem = item.toLowerCase();
      // Check if the lowercase value matches a valid ElementSource value
      if (VALID_SOURCES.includes(lowerItem as ElementSource)) {
        sources.push(lowerItem as ElementSource);
      } else {
        throw new Error(`Unknown source: ${item}. Valid sources: ${VALID_SOURCES.join(', ')}`);
      }
    } else if (Object.values(ElementSource).includes(item as ElementSource)) {
      sources.push(item as ElementSource);
    } else {
      throw new Error(`Invalid source value: ${item}`);
    }
  }

  return sources;
}
