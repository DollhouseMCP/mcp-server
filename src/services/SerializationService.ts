/**
 * SerializationService - Centralized serialization for all element types
 *
 * Eliminates ~300+ lines of duplicate serialization code across SkillManager,
 * MemoryManager, TemplateManager, AgentManager, and EnsembleManager.
 *
 * Key Features:
 * - Unified YAML parsing and dumping with security validation
 * - Consistent JSON operations across all element types
 * - Comprehensive metadata cleaning utilities
 * - Format auto-detection
 * - Security event logging integration
 *
 * @example
 * ```typescript
 * // Inject via DI container
 * constructor(private serializationService: SerializationService) {}
 *
 * // Parse YAML with frontmatter
 * const result = this.serializationService.parseFrontmatter(data, {
 *   maxYamlSize: 64 * 1024,
 *   validateContent: true,
 *   source: 'SkillManager.importElement'
 * });
 *
 * // Create frontmatter
 * const markdown = this.serializationService.createFrontmatter(metadata, content, {
 *   schema: 'failsafe',
 *   cleanMetadata: true
 * });
 * ```
 */

import * as yaml from 'js-yaml';
import matter from 'gray-matter';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { SecurityMonitor, SecurityEvent } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * YAML schema selection
 */
export type YamlSchema = 'failsafe' | 'default' | 'core' | 'json';

/**
 * Metadata cleaning strategy
 */
export type CleaningStrategy =
  | 'remove-undefined'  // Remove undefined only (SkillManager, TemplateManager)
  | 'remove-null'       // Remove null only
  | 'remove-both'       // Remove both undefined and null (AgentManager)
  | 'none';             // No cleaning (MemoryManager, EnsembleManager)

/**
 * Frontmatter creation method
 */
export type FrontmatterMethod =
  | 'matter'  // Uses matter.stringify() (SkillManager)
  | 'manual'; // Manual YAML dump + concatenation (others)

/**
 * Detected format type
 */
export type DetectedFormat = 'frontmatter' | 'yaml' | 'json' | 'unknown';

/**
 * Options for parsing pure YAML
 */
export interface YamlParseOptions {
  /** YAML schema to use (default: 'failsafe' for security) */
  schema?: YamlSchema;

  /** Maximum YAML size in bytes (default: 64KB) */
  maxSize?: number;

  /** Validate root structure is an object (default: true) */
  validateStructure?: boolean;

  /** Source identifier for security logging */
  source?: string;
}

/**
 * Options for parsing frontmatter + content
 */
export interface FrontmatterParseOptions {
  /** Maximum YAML frontmatter size in bytes (default: 64KB) */
  maxYamlSize?: number;

  /** Maximum content size in bytes (default: 1MB) */
  maxContentSize?: number;

  /** Enable content validation (default: false for local files) */
  validateContent?: boolean;

  /** Source identifier for security logging */
  source?: string;

  /**
   * YAML schema to use for pure YAML parsing (default: 'failsafe')
   * Use 'json' to preserve booleans and numbers when reading files
   * written with 'json' schema (e.g., MemoryManager)
   */
  schema?: YamlSchema;
}

/**
 * Options for auto-parsing (format detection)
 */
export interface AutoParseOptions {
  /** Options to use if format is frontmatter */
  frontmatterOptions?: FrontmatterParseOptions;

  /** Options to use if format is pure YAML */
  yamlOptions?: YamlParseOptions;

  /** Options to use if format is JSON */
  jsonOptions?: JsonParseOptions;

  /** Source identifier for security logging */
  source?: string;
}

/**
 * Options for YAML dump
 */
export interface YamlDumpOptions {
  /** YAML schema to use (default: 'failsafe') */
  schema?: YamlSchema;

  /** Sort keys alphabetically (default: true) */
  sortKeys?: boolean;

  /** Skip invalid values instead of throwing (default: true) */
  skipInvalid?: boolean;

  /** Don't create anchors/aliases (default: true for security) */
  noRefs?: boolean;

  /** Indentation for nested elements (default: 2) */
  indent?: number;

  /** Line width for wrapping (default: 80) */
  lineWidth?: number;

  /** Flow level (-1 for block style, 0+ for flow style at that level) */
  flowLevel?: number;
}

/**
 * Options for frontmatter creation
 */
export interface FrontmatterDumpOptions extends YamlDumpOptions {
  /** Method to use for creating frontmatter (default: 'manual') */
  method?: FrontmatterMethod;

  /** Clean metadata before dumping (default: false) */
  cleanMetadata?: boolean;

  /** Cleaning strategy if cleanMetadata is true */
  cleaningStrategy?: CleaningStrategy;
}

/**
 * Options for JSON parsing
 */
export interface JsonParseOptions {
  /** Maximum JSON size in bytes (default: 1MB) */
  maxSize?: number;

  /** Validate that root is an object (default: false) */
  validateStructure?: boolean;

  /** Source identifier for security logging */
  source?: string;
}

/**
 * Options for JSON stringification
 */
export interface JsonStringifyOptions {
  /** Pretty print output (default: false) */
  pretty?: boolean;

  /** Indentation spaces (default: 2) */
  indent?: number;

  /** Clean metadata before stringifying (default: false) */
  cleanMetadata?: boolean;

  /** Cleaning strategy if cleanMetadata is true */
  cleaningStrategy?: CleaningStrategy;
}

/**
 * Options for metadata cleaning
 */
export interface MetadataCleanOptions {
  /** Cleaning strategy (default: 'remove-undefined') */
  strategy?: CleaningStrategy;

  /** Remove empty arrays and objects (default: false) */
  removeEmpty?: boolean;
}

/**
 * Result from frontmatter parsing
 */
export interface ParsedFrontmatter {
  /** Parsed frontmatter metadata */
  data: Record<string, any>;

  /** Markdown content after frontmatter */
  content: string;
}

/**
 * Result from auto-parsing
 */
export interface AutoParsedResult {
  /** Detected format */
  format: DetectedFormat;

  /** Parsed data (metadata for frontmatter, object for YAML/JSON) */
  data: any;

  /** Content (only for frontmatter format) */
  content?: string;
}

// ============================================================================
// SERVICE IMPLEMENTATION
// ============================================================================

/**
 * Service for centralized serialization operations
 *
 * This service provides unified serialization functionality to eliminate code
 * duplication across element managers. Supports:
 * - YAML parsing and dumping
 * - JSON parsing and stringification
 * - Frontmatter creation and parsing
 * - Metadata cleaning
 * - Format detection
 * - Security validation
 */
/**
 * Fix #910: Canonical metadata field order for deterministic YAML output.
 * Fields are ordered: identity → format → content → type-specific → infrastructure.
 * Fields not listed appear after all listed fields, sorted alphabetically.
 */
export const METADATA_FIELD_ORDER: readonly string[] = [
  // Identity
  'name', 'type', 'format_version', 'version', 'description',
  // Attribution
  'author', 'created', 'modified', 'category',
  // Content fields
  'instructions',
  // Classification
  'tags', 'triggers',
  // Agent-specific (ordered by importance)
  'goal', 'activates', 'tools', 'systemPrompt', 'autonomy', 'resilience',
  // Ensemble-specific
  'elements', 'activationStrategy', 'conflictResolution', 'contextSharing',
  'resourceLimits', 'allowNested', 'maxNestingDepth',
  // Template-specific
  'variables', 'outputFormat', 'output_format',
  // Memory-specific
  'autoLoad', 'priority', 'retention', 'retentionPolicy',
  // Security
  'gatekeeper',
  // Infrastructure (always last)
  'unique_id',
];

// Pre-created Set for O(1) lookup in orderMetadataFields (avoids allocation per call)
const METADATA_FIELD_ORDER_SET = new Set(METADATA_FIELD_ORDER);

/**
 * Reorder an object's keys according to METADATA_FIELD_ORDER.
 * Keys not in the order list appear after all ordered keys, sorted alphabetically.
 */
export function orderMetadataFields(metadata: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  // First: add fields in canonical order
  for (const key of METADATA_FIELD_ORDER) {
    if (key in metadata) {
      ordered[key] = metadata[key];
    }
  }
  // Then: add remaining fields alphabetically
  const remaining = Object.keys(metadata).filter(k => !METADATA_FIELD_ORDER_SET.has(k)).sort((a, b) => a.localeCompare(b));
  for (const key of remaining) {
    ordered[key] = metadata[key];
  }
  return ordered;
}

export class SerializationService {
  // Default limits
  private static readonly DEFAULT_MAX_YAML_SIZE = 64 * 1024; // 64KB
  private static readonly DEFAULT_MAX_CONTENT_SIZE = 1024 * 1024; // 1MB

  constructor() {
    // No configuration needed - stateless service
  }

  // ========================================================================
  // YAML PARSING
  // ========================================================================

  /**
   * Parse pure YAML with security validation
   *
   * Handles:
   * - Size validation
   * - Schema selection
   * - Structure validation
   * - Security event logging
   *
   * @param data - YAML string to parse
   * @param options - Parsing options
   * @returns Parsed object
   * @throws Error if size exceeds limit or structure is invalid
   *
   * @example
   * ```typescript
   * const parsed = service.parsePureYaml(yamlString, {
   *   schema: 'failsafe',
   *   maxSize: 64 * 1024,
   *   validateStructure: true,
   *   source: 'SkillManager.importElement'
   * });
   * ```
   */
  parsePureYaml(data: string, options: YamlParseOptions = {}): any {
    const {
      schema = 'failsafe',
      maxSize = SerializationService.DEFAULT_MAX_YAML_SIZE,
      validateStructure = true,
      source = 'SerializationService.parsePureYaml'
    } = options;

    // Size validation
    if (data.length > maxSize) {
      throw new Error(`YAML content exceeds allowed size of ${maxSize} bytes`);
    }

    // Select YAML schema
    const yamlSchema = this.getYamlSchema(schema);

    // Parse YAML
    let parsed: any;
    try {
      parsed = yaml.load(data, {
        schema: yamlSchema,
        json: false,
        onWarning: (warning: any) => {
          SecurityMonitor.logSecurityEvent({
            type: 'YAML_PARSING_WARNING',
            severity: 'LOW',
            source,
            details: `YAML warning: ${warning.message}`
          });
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`YAML parsing failed in ${source}: ${errorMessage}`);
      throw new Error(`Failed to parse YAML: ${errorMessage}`);
    }

    // Structure validation
    if (validateStructure) {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('YAML must contain an object at root level');
      }

      // Check for malicious keys
      const keys = Object.keys(parsed);
      for (const key of keys) {
        if (key.includes('[object Object]') || key.includes('function')) {
          throw new Error('Invalid YAML structure detected');
        }
      }
    }

    // Log success
    SecurityMonitor.logSecurityEvent({
      type: 'YAML_PARSE_SUCCESS',
      severity: 'LOW',
      source,
      details: 'YAML content safely parsed'
    });

    return parsed;
  }

  /**
   * Parse frontmatter + content (Markdown with YAML)
   *
   * Auto-detects:
   * - Pure YAML (wraps with --- markers for parsing)
   * - Markdown with frontmatter (parses as-is)
   *
   * Uses SecureYamlParser for security validation.
   *
   * @param data - Markdown string with frontmatter
   * @param options - Parsing options
   * @returns Parsed frontmatter and content
   *
   * @example
   * ```typescript
   * const result = service.parseFrontmatter(markdownString, {
   *   maxYamlSize: 64 * 1024,
   *   validateContent: true,
   *   source: 'TemplateManager.importElement'
   * });
   * // result.data = { name: '...', description: '...' }
   * // result.content = 'Markdown content...'
   * ```
   */
  parseFrontmatter(
    data: string,
    options: FrontmatterParseOptions = {}
  ): ParsedFrontmatter {
    const {
      maxYamlSize = SerializationService.DEFAULT_MAX_YAML_SIZE,
      maxContentSize = SerializationService.DEFAULT_MAX_CONTENT_SIZE,
      validateContent = false,
      source = 'SerializationService.parseFrontmatter',
      schema = 'failsafe'
    } = options;

    // Check if data has frontmatter markers
    if (this.hasFrontmatter(data)) {
      // Use SecureYamlParser for frontmatter format
      const parsed = SecureYamlParser.parse(data, {
        maxYamlSize,
        maxContentSize,
        validateContent
      });

      return {
        data: parsed.data,
        content: parsed.content.trim() // Trim leading/trailing whitespace
      };
    } else {
      // Pure YAML without frontmatter markers (MemoryManager pattern)
      // Parse the entire content as YAML
      // Use caller-specified schema to preserve types when needed (e.g., 'json' for booleans/numbers)
      const parsed = this.parsePureYaml(data, {
        schema,
        maxSize: maxYamlSize,
        validateStructure: true,
        source
      });

      return {
        data: parsed,
        content: '' // No markdown content for pure YAML
      };
    }
  }

  /**
   * Auto-detect format and parse
   *
   * Detects:
   * - Frontmatter (starts with ---)
   * - Pure YAML (valid YAML object)
   * - JSON (starts with { or [)
   *
   * @param data - String to parse
   * @param options - Parsing options for each format
   * @returns Parsed result with detected format
   *
   * @example
   * ```typescript
   * const result = service.parseAuto(data, {
   *   source: 'SkillManager.importElement'
   * });
   * if (result.format === 'frontmatter') {
   *   console.log(result.data, result.content);
   * } else if (result.format === 'yaml') {
   *   console.log(result.data);
   * }
   * ```
   */
  parseAuto(
    data: string,
    options: AutoParseOptions = {}
  ): AutoParsedResult {
    const format = this.detectFormat(data);

    switch (format) {
      case 'frontmatter': {
        const parsed = this.parseFrontmatter(data, options.frontmatterOptions);
        return {
          format,
          data: parsed.data,
          content: parsed.content
        };
      }

      case 'yaml': {
        const parsed = this.parsePureYaml(data, options.yamlOptions);
        return {
          format,
          data: parsed
        };
      }

      case 'json': {
        const parsed = this.parseJson(data, options.jsonOptions);
        return {
          format,
          data: parsed
        };
      }

      default:
        throw new Error('Unable to detect valid format (frontmatter, YAML, or JSON)');
    }
  }

  // ========================================================================
  // YAML DUMPING
  // ========================================================================

  /**
   * Dump object to YAML string
   *
   * Supports:
   * - FAILSAFE_SCHEMA (default - strings only, most secure)
   * - DEFAULT_SCHEMA (for TemplateManager compatibility)
   * - CORE_SCHEMA (for special cases)
   *
   * @param data - Object to serialize
   * @param options - Dump options
   * @returns YAML string
   *
   * @example
   * ```typescript
   * const yamlString = service.dumpYaml(data, {
   *   schema: 'failsafe',
   *   sortKeys: true,
   *   skipInvalid: true,
   *   noRefs: true
   * });
   * ```
   */
  dumpYaml(data: any, options: YamlDumpOptions = {}): string {
    const {
      schema = 'failsafe',
      sortKeys = true,
      skipInvalid = true,
      noRefs = true,
      indent = 2,
      lineWidth = 80,
      flowLevel = -1
    } = options;

    const yamlSchema = this.getYamlSchema(schema);

    return yaml.dump(data, {
      schema: yamlSchema,
      sortKeys,
      skipInvalid,
      noRefs,
      indent,
      lineWidth,
      flowLevel
    });
  }

  /**
   * Create frontmatter + content (Markdown with YAML)
   *
   * Methods:
   * - 'matter' - Uses matter.stringify() (SkillManager pattern)
   * - 'manual' - Manual YAML dump + concatenation (other managers)
   *
   * @param metadata - Frontmatter metadata
   * @param content - Markdown content
   * @param options - Dump options
   * @returns Markdown string with frontmatter
   *
   * @example
   * ```typescript
   * const markdown = service.createFrontmatter(metadata, content, {
   *   schema: 'failsafe',
   *   method: 'matter',
   *   cleanMetadata: true,
   *   cleaningStrategy: 'remove-undefined'
   * });
   * // Returns: ---\nmetadata...\n---\n\nContent...
   * ```
   */
  createFrontmatter(
    metadata: any,
    content: string,
    options: FrontmatterDumpOptions = {}
  ): string {
    const {
      method = 'manual',
      cleanMetadata = false,
      cleaningStrategy = 'remove-undefined',
      schema = 'failsafe',
      sortKeys: _sortKeys = true,
      skipInvalid = true,
      noRefs = true
    } = options;

    // Clean metadata if requested
    let processedMetadata = cleanMetadata
      ? this.cleanMetadata(metadata, { strategy: cleaningStrategy })
      : metadata;

    // Fix #910: Apply canonical field ordering instead of alphabetical sort
    processedMetadata = orderMetadataFields(processedMetadata);

    if (method === 'matter') {
      // Use matter.stringify() (SkillManager pattern)
      return matter.stringify(content, processedMetadata);
    } else {
      // Manual construction (other managers)
      const yamlString = this.dumpYaml(processedMetadata, {
        schema,
        sortKeys: false,  // Fix #910: field order is now canonical, not alphabetical
        skipInvalid,
        noRefs
      });

      // Construct frontmatter manually
      if (content) {
        return `---\n${yamlString}---\n\n${content}`;
      } else {
        return `---\n${yamlString}---\n`;
      }
    }
  }

  // ========================================================================
  // JSON OPERATIONS
  // ========================================================================

  /**
   * Parse JSON with error handling and security logging
   *
   * @param data - JSON string
   * @param options - Parse options
   * @returns Parsed object
   * @throws Error if parsing fails
   *
   * @example
   * ```typescript
   * const parsed = service.parseJson(jsonString, {
   *   source: 'TemplateManager.importElement'
   * });
   * ```
   */
  parseJson<T = any>(
    data: string,
    options: JsonParseOptions = {}
  ): T {
    const {
      maxSize = SerializationService.DEFAULT_MAX_CONTENT_SIZE,
      validateStructure = false,
      source = 'SerializationService.parseJson'
    } = options;

    // Size validation
    this.validateSize(data, maxSize, 'JSON content');

    try {
      const parsed = JSON.parse(data);

      // Structure validation
      if (validateStructure) {
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('JSON must contain an object at root level');
        }
      }

      return parsed;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`JSON parsing failed in ${source}: ${errorMessage}`);
      throw new Error(`Failed to parse JSON: ${errorMessage}`);
    }
  }

  /**
   * Stringify object to JSON
   *
   * @param data - Object to serialize
   * @param options - Stringify options
   * @returns JSON string
   *
   * @example
   * ```typescript
   * const jsonString = service.stringifyJson(data, {
   *   indent: 2,
   *   cleanMetadata: true,
   *   cleaningStrategy: 'remove-undefined'
   * });
   * ```
   */
  stringifyJson(
    data: any,
    options: JsonStringifyOptions = {}
  ): string {
    const {
      pretty = false,
      indent = 2,
      cleanMetadata = false,
      cleaningStrategy = 'remove-undefined'
    } = options;

    // Clean metadata if requested
    const processedData = cleanMetadata
      ? this.cleanMetadata(data, { strategy: cleaningStrategy })
      : data;

    // Use indent if pretty is true, otherwise no formatting
    const indentValue = pretty ? indent : 0;
    return JSON.stringify(processedData, null, indentValue);
  }

  // ========================================================================
  // METADATA UTILITIES
  // ========================================================================

  /**
   * Clean metadata by removing undefined/null values
   *
   * Strategies:
   * - 'remove-undefined' - Remove undefined only (SkillManager, TemplateManager)
   * - 'remove-null' - Remove null only
   * - 'remove-both' - Remove both undefined and null (AgentManager)
   * - 'none' - No cleaning (MemoryManager, EnsembleManager)
   *
   * @param metadata - Metadata object to clean
   * @param options - Cleaning options
   * @returns Cleaned metadata (new object, original not modified)
   *
   * @example
   * ```typescript
   * const cleaned = service.cleanMetadata(metadata, {
   *   strategy: 'remove-undefined'
   * });
   * ```
   */
  cleanMetadata(
    metadata: any,
    options: MetadataCleanOptions = {}
  ): any {
    const { strategy = 'remove-undefined', removeEmpty = false } = options;

    if (strategy === 'none' && !removeEmpty) {
      return metadata;
    }

    // Handle non-object cases
    if (typeof metadata !== 'object' || metadata === null) {
      return metadata;
    }

    // Handle arrays
    if (Array.isArray(metadata)) {
      // Filter out null/undefined based on strategy
      let cleaned = metadata.map(item => this.cleanMetadata(item, options));

      if (strategy === 'remove-undefined') {
        cleaned = cleaned.filter(item => item !== undefined);
      } else if (strategy === 'remove-null') {
        cleaned = cleaned.filter(item => item !== null);
      } else if (strategy === 'remove-both') {
        cleaned = cleaned.filter(item => item !== undefined && item !== null);
      }

      return cleaned;
    }

    // Clean object based on strategy
    const cleaned: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      const shouldRemove =
        (strategy === 'remove-undefined' && value === undefined) ||
        (strategy === 'remove-null' && value === null) ||
        (strategy === 'remove-both' && (value === undefined || value === null));

      if (!shouldRemove) {
        // Recursively clean nested objects/arrays
        if (typeof value === 'object' && value !== null) {
          const cleanedValue = this.cleanMetadata(value, options);

          // Check if we should remove empty arrays/objects
          if (removeEmpty) {
            const isEmpty = Array.isArray(cleanedValue)
              ? cleanedValue.length === 0
              : Object.keys(cleanedValue).length === 0;

            if (!isEmpty) {
              cleaned[key] = cleanedValue;
            }
          } else {
            cleaned[key] = cleanedValue;
          }
        } else {
          cleaned[key] = value;
        }
      }
    }

    return cleaned;
  }

  // ========================================================================
  // FORMAT DETECTION
  // ========================================================================

  /**
   * Detect format of input data
   *
   * Detection logic:
   * 1. Check for frontmatter (starts with --- after optional whitespace)
   * 2. Check for JSON (starts with { or [)
   * 3. Try to parse as YAML
   * 4. Return 'unknown' if none match
   *
   * @param data - String to analyze
   * @returns Detected format
   *
   * @example
   * ```typescript
   * const format = service.detectFormat(data);
   * // Returns: 'frontmatter' | 'yaml' | 'json' | 'unknown'
   * ```
   */
  detectFormat(data: string): DetectedFormat {
    const trimmed = data.trim();

    // Check for frontmatter
    if (this.hasFrontmatter(trimmed)) {
      return 'frontmatter';
    }

    // Check for JSON
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed);
        return 'json';
      } catch {
        // Not valid JSON, continue checking
      }
    }

    // Try parsing as YAML
    try {
      const parsed = yaml.load(trimmed, {
        schema: yaml.FAILSAFE_SCHEMA,
        json: false
      });

      // Valid YAML that parses to an object
      if (typeof parsed === 'object' && parsed !== null) {
        return 'yaml';
      }
    } catch {
      // Not valid YAML
    }

    return 'unknown';
  }

  /**
   * Check if data has frontmatter markers
   *
   * Checks for '---' at the start after optional whitespace
   *
   * @param data - String to check
   * @returns True if has frontmatter
   *
   * @example
   * ```typescript
   * if (service.hasFrontmatter(data)) {
   *   const result = service.parseFrontmatter(data);
   * }
   * ```
   */
  hasFrontmatter(data: string): boolean {
    const trimmed = data.trim();
    return trimmed.startsWith('---');
  }

  // ========================================================================
  // SECURITY UTILITIES
  // ========================================================================

  /**
   * Log security event (wrapper for SecurityMonitor)
   *
   * Provides consistent security event logging across serialization operations
   *
   * @param type - Event type
   * @param severity - Event severity
   * @param source - Event source
   * @param details - Event details
   *
   * @example
   * ```typescript
   * service.logSecurityEvent(
   *   'YAML_PARSE_SUCCESS',
   *   'LOW',
   *   'SkillManager.importElement',
   *   'Successfully parsed YAML content'
   * );
   * ```
   */
  logSecurityEvent(
    type: SecurityEvent['type'],
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    source: string,
    details: string
  ): void {
    SecurityMonitor.logSecurityEvent({
      type,
      severity,
      source,
      details
    });
  }

  /**
   * Validate size limits
   *
   * Throws error if data exceeds the specified maximum size
   *
   * @param data - Data to check
   * @param maxSize - Maximum size in bytes
   * @param context - Context for error messages
   * @throws Error if size exceeds limit
   *
   * @example
   * ```typescript
   * service.validateSize(data, 64 * 1024, 'YAML frontmatter');
   * // Throws if data > 64KB
   * ```
   */
  validateSize(data: string, maxSize: number, context: string): void {
    if (data.length > maxSize) {
      throw new Error(
        `${context} exceeds allowed size of ${maxSize} bytes (actual: ${data.length} bytes)`
      );
    }
  }

  // ========================================================================
  // PRIVATE HELPERS
  // ========================================================================

  /**
   * Get YAML schema object from string identifier
   *
   * @param schema - Schema identifier
   * @returns YAML schema object
   */
  private getYamlSchema(schema: YamlSchema): yaml.Schema {
    switch (schema) {
      case 'failsafe':
        return yaml.FAILSAFE_SCHEMA;
      case 'default':
        return yaml.DEFAULT_SCHEMA;
      case 'core':
        return yaml.CORE_SCHEMA;
      case 'json':
        // JSON_SCHEMA = FAILSAFE + bool/int/float/null (safer than DEFAULT which adds timestamps)
        // Use this for memories to preserve booleans (autoLoad) and numbers (priority)
        return yaml.JSON_SCHEMA;
      default:
        logger.warn(`Unknown YAML schema '${schema}', using FAILSAFE_SCHEMA`);
        return yaml.FAILSAFE_SCHEMA;
    }
  }
}

