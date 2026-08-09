/**
 * Secure YAML Parser for DollhouseMCP - For Markdown Files with YAML Frontmatter
 * 
 * IMPORTANT: This parser is specifically designed for Markdown files with YAML frontmatter
 * (the format used by personas, skills, templates, and other elements).
 * 
 * USE THIS FOR:
 * - Persona files (e.g., creative-writer.md)
 * - Skill files (e.g., code-review.md)
 * - Template files (e.g., meeting-notes.md)
 * - Any Markdown file with YAML frontmatter between --- markers
 * 
 * For bounded pure-YAML documents, use parseRawYaml() and select the schema
 * required by the data contract. Do not call js-yaml directly at input boundaries.
 * 
 * FILE FORMAT EXPECTED:
 * ```
 * ---
 * name: Element Name
 * description: Element description
 * version: 1.0.0
 * ---
 * 
 * # Markdown content here
 * The actual content/instructions go here...
 * ```
 * 
 * Provides safe YAML parsing that prevents deserialization attacks
 * by using a restricted schema and pre-validation.
 * 
 * Security: SEC-003 - YAML parsing vulnerability protection
 */

import * as yaml from 'js-yaml';
import matter from 'gray-matter';
import { SecurityError } from '../errors/SecurityError.js';
import { ContentValidator } from './contentValidator.js';
import { SECURITY_LIMITS } from './constants.js';
import { SecurityMonitor } from './securityMonitor.js';

export interface SecureParseOptions {
  maxYamlSize?: number;
  maxContentSize?: number;
  allowedKeys?: string[];
  validateContent?: boolean;
  validateFields?: boolean; // Whether to apply field-specific validators (for persona metadata)
  /** Content context for ContentValidator — exempts legitimate patterns (e.g., <script> in templates) */
  contentContext?: 'persona' | 'skill' | 'template' | 'agent' | 'memory';
}

export interface SecureRawYamlParseOptions {
  maxSize?: number;
  schema?: 'core' | 'json' | 'failsafe';
  /** Strict scans scalar text; structure-only leaves element content policy to its owner. */
  contentPolicy?: 'strict' | 'structure-only';
  /** When provided, recursively validates parsed scalar values using the element's content policy. */
  contentContext?: NonNullable<SecureParseOptions['contentContext']>;
}

export interface ParsedContent {
  data: Record<string, any>;
  content: string;
  excerpt?: string;
}

export class SecureYamlParser {
  private static readonly RAW_YAML_MAX_DEPTH = 64;
  private static readonly RAW_YAML_MAX_EXPANDED_NODES = 100_000;
  private static readonly RAW_YAML_MAX_REFERENCE_REUSE = SECURITY_LIMITS.YAML_BOMB_AMPLIFICATION_THRESHOLD;
  private static readonly RAW_YAML_MAX_TEXT_EXPANSION_RATIO =
    SECURITY_LIMITS.YAML_BOMB_AMPLIFICATION_THRESHOLD + 1;

  private static readonly DEFAULT_OPTIONS: SecureParseOptions = {
    maxYamlSize: 64 * 1024,      // 64KB for YAML
    maxContentSize: 1024 * 1024,  // 1MB for content
    validateContent: true,
    validateFields: true         // By default, apply field validators
  };

  // Allowed YAML types - using CORE_SCHEMA (safe subset with basic types like booleans and integers)
  private static readonly SAFE_SCHEMA = yaml.CORE_SCHEMA;

  // Additional validation for specific persona fields
  private static readonly FIELD_VALIDATORS: Record<string, (value: any) => boolean> = {
    name: (v) => typeof v === 'string' && v.length <= 100,
    description: (v) => typeof v === 'string',
    author: (v) => typeof v === 'string' && v.length <= 100,
    version: (v) => typeof v === 'string' && /^\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.-]+)?$/.test(v),
    category: (v) => typeof v === 'string' && v.length <= 50,
    age_rating: (v) => ['all', '13+', '18+'].includes(v),
    price: (v) => typeof v === 'string' && (v === 'free' || /^\$\d+\.\d{2}$/.test(v)),
    ai_generated: (v) => typeof v === 'boolean' || v === 'true' || v === 'false',
    generation_method: (v) => ['human', 'ChatGPT', 'Claude', 'hybrid'].includes(v),
    created_date: (v) => {
      if (typeof v !== 'string') return false;
      
      // More flexible date validation - accept common formats
      // ISO8601, US format, European format, simple dates
      const datePatterns = [
        /^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO8601 with time
        /^\d{1,2}\/\d{1,2}\/\d{4}$/, // MM/DD/YYYY or M/D/YYYY
        /^\d{1,2}-\d{1,2}-\d{4}$/, // MM-DD-YYYY or M-D-YYYY
        /^\d{1,2}\.\d{1,2}\.\d{4}$/, // DD.MM.YYYY (European)
        /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}$/i // Month DD, YYYY
      ];
      
      // Check if it matches common patterns first
      const matchesPattern = datePatterns.some(pattern => pattern.test(v.trim()));
      if (!matchesPattern) {
        // Fall back to Date.parse for other formats, but be more lenient
        const parsed = Date.parse(v);
        return !Number.isNaN(parsed) && parsed > 0; // Ensure it's a valid positive timestamp
      }
      
      return true;
    },
    triggers: (v) => Array.isArray(v) && v.every(t => typeof t === 'string' && t.length <= 50),
    content_flags: (v) => Array.isArray(v) && v.every(f => typeof f === 'string' && f.length <= 50)
  };

  /**
   * Parse a Markdown file with YAML frontmatter (Securely)
   * 
   * @param input - The full content of a Markdown file with YAML frontmatter
   * @param options - Parsing options for security and validation
   * @returns ParsedContent with separated YAML data and Markdown content
   * 
   * @example
   * ```typescript
   * // For a persona file:
   * const personaFile = `---
   * name: Creative Writer
   * description: A creative writing assistant
   * ---
   * You are a creative writer...`;
   * 
   * const result = SecureYamlParser.parse(personaFile);
   * // result.data = { name: 'Creative Writer', description: '...' }
   * // result.content = 'You are a creative writer...'
   * ```
   */
  static parse(input: string, options: SecureParseOptions = {}): ParsedContent {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };

    // 1. Size validation
    if (input.length > (opts.maxContentSize || this.DEFAULT_OPTIONS.maxContentSize!)) {
      throw new SecurityError('Content exceeds maximum allowed size', 'medium');
    }

    // 2. Extract frontmatter boundaries
    // FIX: Support both Unix (\n) and Windows (\r\n) line endings
    const frontmatterMatch = input.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
      // No frontmatter, return empty data
      return {
        data: {},
        content: input
      };
    }

    const yamlContent = frontmatterMatch[1];
    const markdownContent = input.substring(frontmatterMatch[0].length);

    // 3. Validate YAML size
    if (yamlContent.length > (opts.maxYamlSize || this.DEFAULT_OPTIONS.maxYamlSize!)) {
      throw new SecurityError('YAML frontmatter exceeds maximum allowed size', 'medium');
    }

    // 4. Pre-parse security validation
    // FIX (Issue #1211): Only validate content if validateContent option is true
    if (opts.validateContent) {
      const structureOnly = opts.contentContext === 'skill'
        || opts.contentContext === 'template'
        || opts.contentContext === 'agent';
      const yamlIsValid = structureOnly
        ? ContentValidator.validateYamlStructure(yamlContent, opts.maxYamlSize)
        : ContentValidator.validateYamlContent(yamlContent, opts.maxYamlSize);
      if (!yamlIsValid) {
        SecurityMonitor.logSecurityEvent({
          type: 'YAML_INJECTION_ATTEMPT',
          severity: 'CRITICAL',
          source: 'SecureYamlParser',
          details: 'Malicious YAML pattern detected during parsing'
        });
        throw new SecurityError('Malicious YAML content detected', 'critical');
      }
    }

    // 5. Parse with safe schema
    let data: any;
    try {
      data = yaml.load(yamlContent, {
        schema: this.SAFE_SCHEMA,
        json: false,  // Don't allow JSON-specific types
        onWarning: (warning) => {
          SecurityMonitor.logSecurityEvent({
            type: 'YAML_PARSING_WARNING',
            severity: 'LOW',
            source: 'SecureYamlParser',
            details: `YAML warning: ${warning.message}`
          });
        }
      });
    } catch (error) {
      throw new SecurityError(`YAML parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'high');
    }

    this.assertBoundedRawYamlStructure(data, yamlContent.length);

    // 6. Ensure data is an object
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new SecurityError('YAML must contain an object at root level', 'medium');
    }

    // 7. Validate allowed keys if specified
    if (opts.allowedKeys) {
      const invalidKeys = Object.keys(data).filter(key => !opts.allowedKeys!.includes(key));
      if (invalidKeys.length > 0) {
        throw new SecurityError(`Invalid YAML keys detected: ${invalidKeys.join(', ')}`, 'medium');
      }
    }

    // 8. Validate field types and content
    const visitedValues = new WeakSet<object>();
    for (const [key, value] of Object.entries(data)) {
      const hasFieldValidator = Object.prototype.hasOwnProperty.call(this.FIELD_VALIDATORS, key);
      const fieldValidator = hasFieldValidator ? this.FIELD_VALIDATORS[key] : undefined;

      // Check field-specific validators only if field validation is enabled
      if (opts.validateFields && typeof fieldValidator === 'function' && !fieldValidator(value)) {
        throw new SecurityError(`Invalid value for field '${key}'`, 'medium');
      }

      if (opts.validateContent) {
        data[key] = this.validateAndSanitizeParsedValue(
          value,
          key,
          opts.contentContext,
          visitedValues,
        );
      }
    }

    // 9. Validate markdown content if requested
    let finalContent = markdownContent;
    if (opts.validateContent) {
      const contentValidation = ContentValidator.validateAndSanitize(markdownContent, {
        contentContext: opts.contentContext,
      });
      if (!contentValidation.isValid && contentValidation.severity === 'critical') {
        throw new SecurityError('Security threat detected in content', 'critical');
      }
      finalContent = contentValidation.sanitizedContent || markdownContent;
    }

    return {
      data,
      content: finalContent
    };
  }

  private static validateAndSanitizeParsedValue(
    value: unknown,
    path: string,
    contentContext: SecureParseOptions['contentContext'],
    visited: WeakSet<object>,
  ): unknown {
    if (typeof value === 'string') {
      const validation = ContentValidator.validateAndSanitize(value, { contentContext });
      if (!validation.isValid && validation.severity === 'critical') {
        throw new SecurityError(`Security threat detected in field '${path}'`, 'critical');
      }
      return validation.sanitizedContent ?? value;
    }

    if (typeof value !== 'object' || value === null || visited.has(value)) {
      return value;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = this.validateAndSanitizeParsedValue(
          value[index],
          `${path}[${index}]`,
          contentContext,
          visited,
        );
      }
      return value;
    }

    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      record[key] = this.validateAndSanitizeParsedValue(
        child,
        `${path}.${key}`,
        contentContext,
        visited,
      );
    }
    return record;
  }

  /**
   * Create a secure gray-matter compatible parser
   */
  static createSecureMatterParser() {
    return {
      parse: (input: string) => {
        const result = this.parse(input);
        return {
          data: result.data,
          content: result.content,
          excerpt: result.excerpt,
          orig: input
        };
      },
      stringify: (content: string, data: any) => {
        // Validate data before stringifying
        const validation = ContentValidator.validateMetadata(data);
        if (!validation.isValid) {
          throw new SecurityError('Cannot stringify content with security threats', 'high');
        }

        // Use safe YAML dump
        const yamlStr = yaml.dump(data, {
          schema: this.SAFE_SCHEMA,
          skipInvalid: true,
          noRefs: true,
          noCompatMode: true
        });

        return `---\n${yamlStr}---\n${content}`;
      }
    };
  }

  /**
   * Safe wrapper for gray-matter with security validations
   */
  static safeMatter(input: string, options?: matter.GrayMatterOption<string, any>, secureOptions?: SecureParseOptions): matter.GrayMatterFile<string> {
    // First, use our secure parser (for validation)
    this.parse(input, secureOptions);

    // Then use gray-matter with custom engines
    return matter(input, {
      ...options,
      engines: {
        yaml: {
          parse: (str: string) => {
            // Use our secure YAML parsing
            const parsed = yaml.load(str, {
              schema: this.SAFE_SCHEMA,
              json: false
            });
            // Ensure it's an object
            if (typeof parsed !== 'object' || parsed === null) {
              return {};
            }
            return parsed as object;
          },
          stringify: (obj: any) => {
            return yaml.dump(obj, {
              schema: this.SAFE_SCHEMA,
              skipInvalid: true,
              noRefs: true
            });
          }
        }
      }
    });
  }

  /**
   * Parse raw YAML content safely (not frontmatter, just plain YAML)
   *
   * USE THIS FOR:
   * - Export package data fields
   * - Configuration snippets
   * - Any pure YAML string that needs parsing
   *
   * This uses CORE_SCHEMA which only allows safe basic types:
   * - strings, numbers, booleans, null
   * - arrays and objects
   * - NO custom types, functions, or code execution
   *
   * @param yamlContent - Raw YAML string to parse
   * @param maxSize - Maximum allowed size (default 64KB)
   * @returns Parsed object
   * @throws SecurityError if content is too large or contains threats
   */
  static parseRawYaml(
    yamlContent: string,
    maxSizeOrOptions: number | SecureRawYamlParseOptions = 64 * 1024,
  ): Record<string, unknown> {
    const options = typeof maxSizeOrOptions === 'number'
      ? { maxSize: maxSizeOrOptions, schema: 'core' as const, contentPolicy: 'strict' as const }
      : {
          maxSize: 64 * 1024,
          schema: 'core' as const,
          contentPolicy: 'strict' as const,
          ...maxSizeOrOptions,
        };

    // Size validation
    if (yamlContent.length > options.maxSize) {
      throw new SecurityError('YAML content exceeds maximum allowed size', 'medium');
    }

    // Fix #908: YAML bomb detection — previously skipped, allowing bomb payloads
    // through MCP-AQL create dispatcher and web routes that use parseRawYaml().
    // Issue #2329: pass maxSize through — validateYamlContent's own default cap is
    // 64KB (frontmatter-sized), which rejected larger pure-YAML documents even
    // when the caller allowed them.
    const isValid = options.contentPolicy === 'structure-only'
      ? ContentValidator.validateYamlStructure(yamlContent, options.maxSize)
      : ContentValidator.validateYamlContent(yamlContent, options.maxSize);
    if (!isValid) {
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'SecureYamlParser.parseRawYaml',
        details: 'Malicious YAML pattern detected in raw YAML content'
      });
      throw new SecurityError('Malicious YAML content detected', 'critical');
    }

    // Parse with safe schema
    const parsed = yaml.load(yamlContent, {
      schema: this.rawYamlSchema(options.schema),
      json: false
    });

    // Ensure result is an object
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SecurityError('YAML content must parse to an object', 'medium');
    }
    this.assertBoundedRawYamlStructure(parsed, yamlContent.length);
    if (options.contentContext) {
      this.validateAndSanitizeParsedValue(
        parsed,
        'frontmatter',
        options.contentContext,
        new WeakSet<object>(),
      );
    }

    return parsed as Record<string, unknown>;
  }

  private static assertBoundedRawYamlStructure(root: unknown, sourceLength: number): void {
    const referenceVisits = new WeakMap<object, number>();
    const visiting = new WeakSet<object>();
    const maxExpandedTextCharacters = Math.max(sourceLength, 1) * this.RAW_YAML_MAX_TEXT_EXPANSION_RATIO;
    let nodes = 0;
    let expandedTextCharacters = 0;

    const visit = (value: unknown, depth: number): void => {
      nodes += 1;
      if (nodes > this.RAW_YAML_MAX_EXPANDED_NODES || depth > this.RAW_YAML_MAX_DEPTH) {
        throw new SecurityError('YAML structure exceeds safe complexity limits', 'high');
      }
      if (typeof value === 'string') {
        expandedTextCharacters += value.length;
        if (expandedTextCharacters > maxExpandedTextCharacters) {
          throw new SecurityError('YAML content expansion exceeds safe limits', 'high');
        }
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const referenceVisitCount = (referenceVisits.get(value) ?? 0) + 1;
      referenceVisits.set(value, referenceVisitCount);
      if (referenceVisitCount - 1 > this.RAW_YAML_MAX_REFERENCE_REUSE) {
        throw new SecurityError('YAML aliases exceed safe reuse limits', 'high');
      }
      if (visiting.has(value)) {
        throw new SecurityError('YAML aliases may not create cyclic data', 'high');
      }
      visiting.add(value);
      for (const [key, child] of Object.entries(value)) {
        expandedTextCharacters += key.length;
        if (expandedTextCharacters > maxExpandedTextCharacters) {
          throw new SecurityError('YAML content expansion exceeds safe limits', 'high');
        }
        visit(child, depth + 1);
      }
      visiting.delete(value);
    };

    visit(root, 0);
  }

  private static rawYamlSchema(schema: SecureRawYamlParseOptions['schema']): yaml.Schema {
    switch (schema) {
      case 'failsafe':
        return yaml.FAILSAFE_SCHEMA;
      case 'json':
        return yaml.JSON_SCHEMA;
      case 'core':
      default:
        return this.SAFE_SCHEMA;
    }
  }
}
