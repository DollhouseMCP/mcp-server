/**
 * Secure YAML Parser for DollhouseMCP
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
import { SecurityMonitor } from './securityMonitor.js';

export interface SecureParseOptions {
  maxYamlSize?: number;
  maxContentSize?: number;
  allowedKeys?: string[];
  validateContent?: boolean;
}

export interface ParsedContent {
  data: Record<string, any>;
  content: string;
  excerpt?: string;
}

export class SecureYamlParser {
  private static readonly DEFAULT_OPTIONS: SecureParseOptions = {
    maxYamlSize: 64 * 1024,      // 64KB for YAML
    maxContentSize: 1024 * 1024,  // 1MB for content
    validateContent: true
  };

  // Allowed YAML types - using FAILSAFE_SCHEMA as base
  private static readonly SAFE_SCHEMA = yaml.FAILSAFE_SCHEMA;

  // Additional validation for specific persona fields
  private static readonly FIELD_VALIDATORS: Record<string, (value: any) => boolean> = {
    name: (v) => typeof v === 'string' && v.length <= 100,
    description: (v) => typeof v === 'string' && v.length <= 500,
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
        return !isNaN(parsed) && parsed > 0; // Ensure it's a valid positive timestamp
      }
      
      return true;
    },
    triggers: (v) => Array.isArray(v) && v.every(t => typeof t === 'string' && t.length <= 50),
    content_flags: (v) => Array.isArray(v) && v.every(f => typeof f === 'string' && f.length <= 50)
  };

  /**
   * Securely parse content with YAML frontmatter
   */
  static parse(input: string, options: SecureParseOptions = {}): ParsedContent {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };

    // 1. Size validation
    if (input.length > (opts.maxContentSize || this.DEFAULT_OPTIONS.maxContentSize!)) {
      throw new SecurityError('Content exceeds maximum allowed size', 'medium');
    }

    // 2. Extract frontmatter boundaries
    const frontmatterMatch = input.match(/^---\n([\s\S]*?)\n---/);
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
    if (!ContentValidator.validateYamlContent(yamlContent)) {
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'secure_yaml_parser',
        details: 'Malicious YAML pattern detected during parsing'
      });
      throw new SecurityError('Malicious YAML content detected', 'critical');
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
            source: 'secure_yaml_parser',
            details: `YAML warning: ${warning.message}`
          });
        }
      });
    } catch (error) {
      throw new SecurityError(`YAML parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'high');
    }

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
    for (const [key, value] of Object.entries(data)) {
      // Check field-specific validators
      if (this.FIELD_VALIDATORS[key] && !this.FIELD_VALIDATORS[key](value)) {
        throw new SecurityError(`Invalid value for field '${key}'`, 'medium');
      }

      // Validate string fields for injection patterns
      if (typeof value === 'string' && opts.validateContent) {
        const validation = ContentValidator.validateAndSanitize(value);
        if (!validation.isValid && validation.severity === 'critical') {
          throw new SecurityError(`Security threat detected in field '${key}'`, 'critical');
        }
        // Replace with sanitized content
        data[key] = validation.sanitizedContent;
      }
    }

    // 9. Validate markdown content if requested
    let finalContent = markdownContent;
    if (opts.validateContent) {
      const contentValidation = ContentValidator.validateAndSanitize(markdownContent);
      if (!contentValidation.isValid && contentValidation.severity === 'critical') {
        throw new SecurityError('Security threat detected in content', 'critical');
      }
      finalContent = contentValidation.sanitizedContent || markdownContent;
    }

    SecurityMonitor.logSecurityEvent({
      type: 'YAML_PARSE_SUCCESS',
      severity: 'LOW',
      source: 'secure_yaml_parser',
      details: `Successfully parsed YAML with ${Object.keys(data).length} fields`
    });

    return {
      data,
      content: finalContent
    };
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
  static safeMatter(input: string, options?: matter.GrayMatterOption<string, any>): matter.GrayMatterFile<string> {
    // First, use our secure parser
    const secureParsed = this.parse(input);

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
}