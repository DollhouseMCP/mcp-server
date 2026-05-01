/**
 * Template element class implementing IElement interface.
 * Represents reusable content structures with variable substitution and dynamic content.
 * 
 * SECURITY FIXES IMPLEMENTED (Following PR #319 patterns):
 * 1. CRITICAL: Template injection prevention - no eval() or Function() constructor
 * 2. CRITICAL: Path traversal prevention for template includes
 * 3. HIGH: Input validation and sanitization for all template variables
 * 4. MEDIUM: Memory limits to prevent resource exhaustion (100KB templates, 100 variables)
 * 5. MEDIUM: Audit logging for all security operations via SecurityMonitor
 * 6. MEDIUM: Unicode normalization to prevent homograph attacks
 */

import { BaseElement, normalizeVersion } from '../BaseElement.js';
import { IElement, IElementMetadata, ElementValidationResult } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { ErrorHandler, ErrorCategory } from '../../utils/ErrorHandler.js';
import { ValidationErrorCodes } from '../../utils/errorCodes.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import * as path from 'path';
import { MetadataService } from '../../services/MetadataService.js';

// Extend IElementMetadata with template-specific fields
export interface TemplateMetadata extends IElementMetadata {
  type?: ElementType.TEMPLATE;             // Template type constraint for type safety
  category?: string;              // Template category (documents, emails, code, etc.)
  output_format?: string;         // Output format (markdown, html, json, yaml, etc.)
  variables?: TemplateVariable[]; // Variable definitions
  includes?: string[];            // Other templates to include
  tags?: string[];               // Searchable tags
  usage_count?: number;          // Track popularity
  last_used?: string;            // ISO date string
  examples?: TemplateExample[];   // Usage examples

  /**
   * Action verbs that trigger this template (e.g., "create", "generate", "draft")
   * Used by Enhanced Capability Index for intelligent template suggestions
   * @since v1.9.10
   */
  triggers?: string[];
}

export interface TemplateVariable {
  name: string;                   // Variable name (e.g., "project_name")
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  description?: string;           // Help text for the variable
  required?: boolean;             // Is this variable required?
  default?: unknown;              // Default value if not provided (type-safe)
  validation?: string;            // Regex pattern for validation (string type only)
  options?: string[];             // For enum-like strings
  format?: string;                // Date format string (date type only)
}

export interface TemplateExample {
  title: string;
  description?: string;
  variables: Record<string, unknown>;
  output?: string;
}

/** Parsed result of a section-format template (issue #705). */
export interface TemplateSections {
  /** True when the content contains at least one bare section tag. */
  isSectionMode: boolean;
  /** Content of the <template> block — the only section that receives variable substitution. */
  templateSection: string;
  /** Raw content of the <style> block — passed through without variable substitution. */
  styleSection: string;
  /** Raw content of the <script> block — passed through without variable substitution. */
  scriptSection: string;
}

export class Template extends BaseElement implements IElement {
  public declare metadata: TemplateMetadata;
  // instructions and content inherited from BaseElement (v2.0 dual-field architecture)
  private compiledTemplate?: CompiledTemplate;
  // Issue #705: Cache parsed sections to avoid re-running regex on every render/validate
  private parsedSections?: TemplateSections;
  
  // SECURITY FIX #4: Memory management constants
  // Prevents unbounded template size and variable count that could exhaust memory
  private readonly MAX_TEMPLATE_SIZE = 100 * 1024; // 100KB max template size
  private static readonly MAX_VARIABLE_COUNT = 100; // Max variables per template
  private readonly MAX_INCLUDE_DEPTH = 5;          // Prevent infinite include loops
  private readonly MAX_STRING_LENGTH = 10000;      // Max length for string variables

  constructor(metadata: Partial<TemplateMetadata>, content: string = '', metadataService: MetadataService) {
    // SECURITY FIX #3 & #6: Validate and sanitize ALL metadata fields
    // Unicode normalization prevents homograph attacks
    // Input sanitization prevents XSS and injection attacks
    const sanitizedMetadata = {
      ...metadata,
      name: metadata.name ? sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100) : undefined,
      description: metadata.description ? sanitizeInput(UnicodeValidator.normalize(metadata.description).normalizedContent, SECURITY_LIMITS.MAX_CONTENT_LENGTH) : undefined,
      category: metadata.category ? sanitizeInput(UnicodeValidator.normalize(metadata.category).normalizedContent, 50) : undefined,
      output_format: metadata.output_format ? sanitizeInput(metadata.output_format, 20) : undefined
    };

    super(ElementType.TEMPLATE, sanitizedMetadata, metadataService);
    
    // SECURITY FIX #4: Enforce template size limit
    if (content.length > this.MAX_TEMPLATE_SIZE) {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_SIZE_EXCEEDED',
        severity: 'HIGH',
        source: 'Template.constructor',
        details: `Template size ${content.length} exceeds maximum ${this.MAX_TEMPLATE_SIZE}`
      });
      throw ErrorHandler.createError(`Template content exceeds maximum size of ${this.MAX_TEMPLATE_SIZE} bytes`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.TEMPLATE_TOO_LARGE);
    }
    
    // SECURITY FIX #3: Sanitize template content
    // ContentValidator with contentContext: 'template' allows code patterns (eval, exec, etc.)
    // while still catching prompt injection, credentials, and path traversal.
    const contentValidation = ContentValidator.validateAndSanitize(content, {
      maxLength: this.MAX_TEMPLATE_SIZE,
      contentContext: 'template',
    });
    this.content = contentValidation.sanitizedContent || UnicodeValidator.normalize(content).normalizedContent;
    
    // Ensure template-specific metadata
    this.metadata = {
      ...this.metadata,
      category: sanitizedMetadata.category || 'general',
      output_format: sanitizedMetadata.output_format || 'markdown',
      variables: metadata.variables || [],
      includes: metadata.includes || [],
      tags: metadata.tags || [],
      usage_count: metadata.usage_count || 0,
      examples: metadata.examples || []
    };

    // SECURITY FIX #3 & #4: Validate variables
    if (this.metadata.variables) {
      if (this.metadata.variables.length > Template.MAX_VARIABLE_COUNT) {
        throw ErrorHandler.createError(`Variable count ${this.metadata.variables.length} exceeds maximum ${Template.MAX_VARIABLE_COUNT}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.TOO_MANY_VARIABLES);
      }
      
      this.metadata.variables = this.metadata.variables.map(variable => ({
        ...variable,
        name: sanitizeInput(UnicodeValidator.normalize(variable.name).normalizedContent, 50),
        description: variable.description ? sanitizeInput(UnicodeValidator.normalize(variable.description).normalizedContent, SECURITY_LIMITS.MAX_CONTENT_LENGTH) : undefined,
        validation: variable.validation ? sanitizeInput(variable.validation, 200) : undefined
      }));
    }

    // SECURITY FIX #2: Validate include paths
    if (this.metadata.includes) {
      this.metadata.includes = this.metadata.includes.map(includePath => {
        const sanitizedPath = sanitizeInput(includePath, 200);
        // Prevent path traversal attacks
        if (!this.isValidIncludePath(sanitizedPath)) {
          SecurityMonitor.logSecurityEvent({
            type: 'PATH_TRAVERSAL_ATTEMPT',
            severity: 'CRITICAL',
            source: 'Template.constructor',
            details: `Invalid include path: ${sanitizedPath}`
          });
          throw ErrorHandler.createError(`Invalid include path: ${sanitizedPath}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_INCLUDE_PATH);
        }
        return sanitizedPath;
      });
    }
  }

  /**
   * Validate include paths to prevent directory traversal
   * SECURITY FIX #2: Prevents accessing files outside template directory
   */
  private isValidIncludePath(includePath: string): boolean {
    // Normalize the path
    const normalized = path.normalize(includePath);
    
    // Check for path traversal patterns
    if (normalized.includes('..') || normalized.includes('~') || path.isAbsolute(normalized)) {
      return false;
    }
    
    // Only allow alphanumeric, dash, underscore, forward slash, backslash (for Windows), and .md extension
    // Note: We test against the original path to preserve cross-platform compatibility
    // FIX: Remove unnecessary escape for / (SonarCloud S6535)
    const validPathPattern = /^[a-zA-Z0-9\-_/\\]+\.md$/;
    return validPathPattern.test(includePath);
  }

  /**
   * Compile the template for efficient rendering
   * SECURITY FIX #1: Safe template compilation without eval() or Function()
   * Uses regex-based token replacement instead of dynamic code execution
   */
  /**
   * Parse section-mode content into named sections.
   *
   * Section mode is active when the content contains any <template>, <style>, or
   * <script> block. In section mode only the <template> section is processed by the
   * variable substitution engine; <style> and <script> are raw passthrough so that
   * CSS/JS `}}` characters never trigger unmatched-token errors.
   *
   * @see Issue #705 — structured section support for page templates
   */
  static parseSections(content: string): TemplateSections {
    // Matches bare section tags: <template>, <style>, <script> (no attributes).
    // Tags with attributes (e.g. <template id="x">) are treated as plain HTML,
    // not section markers — this is intentional for forward compatibility.
    const pattern = /<(template|style|script)>([\s\S]*?)<\/\1>/gi;
    const sections: Record<string, string> = {};
    let found = false;
    let match;

    while ((match = pattern.exec(content)) !== null) {
      found = true;
      sections[match[1].toLowerCase()] = match[2];
    }

    // Issue #705 forward-compat: warn when a bare <template> tag appears inside
    // the <template> section — nested section markers aren't supported yet and
    // the lazy regex would silently produce incorrect results.
    const templateSection = sections['template'] ?? '';
    if (found && templateSection && /<template>/i.test(templateSection)) {
      logger.warn(
        'Template section contains a nested bare <template> tag. ' +
        'Nested section markers are not supported — only the outermost ' +
        '<template>...</template> block is rendered. ' +
        'Use <template id="..."> (with an attribute) for inner HTML template elements.'
      );
    }

    return {
      isSectionMode: found,
      templateSection,
      styleSection: sections['style'] ?? '',
      scriptSection: sections['script'] ?? '',
    };
  }

  /**
   * Return the parsed sections for this template's content.
   * Result is cached per-instance and cleared whenever content changes.
   * Used by TemplateRenderer to serve section-specific render results.
   */
  getSections(): TemplateSections {
    if (!this.parsedSections) {
      this.parsedSections = Template.parseSections(this.content);
    }
    return this.parsedSections;
  }

  /**
   * Scan `content` for `{{placeholder}}` patterns and return a merged variable
   * list. Existing entries are preserved unchanged (user-set descriptions,
   * types, required flags, etc.); new placeholders are added with defaults:
   * `type: 'string'`, `required: false`. (#1896)
   *
   * Respects section mode — only the `<template>` section is scanned,
   * matching the substitution engine's scope.
   *
   * **Performance:** Single-pass regex scan — O(n) in content length.
   * Called by `TemplateManager.save()` on every create/edit, so content
   * is already validated and size-bounded (≤ 100 KB) before reaching here.
   *
   * @param content - Raw template content (may include section tags)
   * @param existingVariables - Already-declared variables; never overwritten
   * @returns Merged variable list: existing entries first, new entries appended
   *
   * @example
   * // New template — empty schema gets fully populated
   * deriveVariablesFromContent('Hello {{name}}, score: {{score}}')
   * // → [{ name: 'name', type: 'string', required: false },
   * //    { name: 'score', type: 'string', required: false }]
   *
   * @example
   * // Existing entry preserved; only the missing placeholder is added
   * deriveVariablesFromContent('{{name}} earns {{points}}', [
   *   { name: 'name', type: 'string', required: true, description: 'Display name' }
   * ])
   * // → [{ name: 'name', type: 'string', required: true, description: 'Display name' },
   * //    { name: 'points', type: 'string', required: false }]
   */
  static deriveVariablesFromContent(
    content: string,
    existingVariables: TemplateVariable[] = []
  ): TemplateVariable[] {
    const { isSectionMode, templateSection } = Template.parseSections(content);
    const scanContent = isSectionMode ? templateSection : content;

    const pattern = /\{\{\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\}\}/g;
    const seen = new Set<string>();
    let match;
    while ((match = pattern.exec(scanContent)) !== null) {
      seen.add(match[1]);
    }

    const existingNames = new Set(existingVariables.map(v => v.name));
    const result: TemplateVariable[] = [...existingVariables];

    for (const name of seen) {
      if (!existingNames.has(name)) {
        result.push({ name, type: 'string', required: false });
      }
    }

    // Enforce the same MAX_VARIABLE_COUNT limit as the constructor.
    // When auto-derive would exceed the cap, truncate and surface a structured
    // error so the calling LLM knows to split the content across templates.
    if (result.length > Template.MAX_VARIABLE_COUNT) {
      const overflow = result.splice(Template.MAX_VARIABLE_COUNT);
      const overflowNames = overflow.map(v => v.name).join(', ');
      throw ErrorHandler.createError(
        `Auto-derive reached the ${Template.MAX_VARIABLE_COUNT}-variable limit. ` +
        `${overflow.length} placeholder(s) were not registered: ${overflowNames}. ` +
        `Split this content across multiple templates and combine them in an ensemble.`,
        ErrorCategory.VALIDATION_ERROR,
        ValidationErrorCodes.TOO_MANY_VARIABLES
      );
    }

    return result;
  }

  private compile(): CompiledTemplate {
    if (this.compiledTemplate) {
      return this.compiledTemplate;
    }

    // Issue #705: In section mode, only compile the <template> section.
    // Tokens in <style> and <script> are never substituted.
    // getSections() returns the cached result — no repeated regex execution.
    const { isSectionMode, templateSection } = this.getSections();
    const compileContent = isSectionMode ? templateSection : this.content;

    // Extract all variable tokens from the template
    // FIX: Use \w shorthand instead of [a-zA-Z0-9_] (SonarCloud S6353)
    const variablePattern = /\{\{\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\}\}/g;
    const tokens: TemplateToken[] = [];
    let match;

    while ((match = variablePattern.exec(compileContent)) !== null) {
      tokens.push({
        token: match[0],
        variable: match[1],
        position: match.index
      });
    }

    this.compiledTemplate = {
      content: compileContent,
      tokens,
      variables: this.metadata.variables || []
    };

    return this.compiledTemplate;
  }

  /**
   * Render the template with provided variables
   * SECURITY FIX #1: Safe rendering without code execution
   * SECURITY FIX #3: All variables are validated and sanitized
   * TYPE SAFETY: Strong typing for variables with runtime validation
   */
  async render<T extends Record<string, unknown>>(
    variables: T = {} as T, 
    includeDepth: number = 0
  ): Promise<string> {
    // SECURITY FIX #4: Prevent infinite include loops
    if (includeDepth > this.MAX_INCLUDE_DEPTH) {
      SecurityMonitor.logSecurityEvent({
        type: 'INCLUDE_DEPTH_EXCEEDED',
        severity: 'HIGH',
        source: 'Template.render',
        details: `Include depth ${includeDepth} exceeds maximum ${this.MAX_INCLUDE_DEPTH}`
      });
      throw ErrorHandler.createError('Maximum template include depth exceeded', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.MAX_INCLUDE_DEPTH);
    }

    // Compile the template
    const compiled = this.compile();
    
    // Validate and sanitize all provided variables
    const sanitizedVariables = await this.validateAndSanitizeVariables(variables);
    
    // Start with the template content
    let rendered = compiled.content;
    
    // Replace tokens in reverse order to maintain positions
    const sortedTokens = [...compiled.tokens].sort((a, b) => b.position - a.position);
    
    for (const token of sortedTokens) {
      const value = this.resolveVariable(token.variable, sanitizedVariables);
      const stringValue = this.formatValue(value);
      
      // Replace the token with the sanitized value
      rendered = rendered.substring(0, token.position) + 
                 stringValue + 
                 rendered.substring(token.position + token.token.length);
    }
    
    // Process includes if any
    if (this.metadata.includes && this.metadata.includes.length > 0) {
      rendered = await this.processIncludes(rendered, sanitizedVariables, includeDepth);
    }
    
    // Update usage statistics
    // NOTE: These updates are not atomic and may have race conditions under concurrent access
    // This is acceptable for usage statistics which don't require perfect accuracy
    // For production systems requiring atomic counters, consider using a database or atomic operations
    this.metadata.usage_count = (this.metadata.usage_count || 0) + 1;
    this.metadata.last_used = new Date().toISOString();
    
    // SECURITY FIX #5: Log template usage for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'TEMPLATE_RENDERED',
      severity: 'LOW',
      source: 'Template.render',
      details: `Template ${this.metadata.name} rendered with ${Object.keys(sanitizedVariables).length} variables`
    });
    
    return rendered;
  }

  /**
   * Validate and sanitize variables according to their definitions
   * SECURITY FIX #3: Comprehensive validation of all input variables
   * TYPE SAFETY: Improved type safety for variable validation
   */
  private async validateAndSanitizeVariables(
    variables: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const sanitized: Record<string, unknown> = {};
    
    // Check required variables
    for (const varDef of this.metadata.variables || []) {
      if (varDef.required && !(varDef.name in variables)) {
        if (varDef.default !== undefined) {
          sanitized[varDef.name] = varDef.default;
        } else {
          throw ErrorHandler.createError(`Required variable '${varDef.name}' not provided`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.REQUIRED_VARIABLE);
        }
      }
    }
    
    // Validate and sanitize provided variables
    for (const [name, value] of Object.entries(variables)) {
      const varDef = this.metadata.variables?.find(v => v.name === name);
      
      if (!varDef) {
        // Skip unknown variables (they won't be used anyway)
        logger.warn(`Unknown variable '${name}' provided to template`);
        continue;
      }
      
      // Type validation and sanitization
      const sanitizedValue = await this.sanitizeVariableValue(value, varDef);
      sanitized[name] = sanitizedValue;
    }
    
    // Apply defaults for missing optional variables
    for (const varDef of this.metadata.variables || []) {
      if (!varDef.required && !(varDef.name in sanitized) && varDef.default !== undefined) {
        sanitized[varDef.name] = varDef.default;
      }
    }
    
    return sanitized;
  }

  /**
   * Sanitize a single variable value according to its definition
   * SECURITY FIX #3 & #6: Type-specific validation and Unicode normalization
   */
  private async sanitizeVariableValue(value: any, varDef: TemplateVariable): Promise<any> {
    switch (varDef.type) {
      case 'string': {
        // SECURITY FIX #6: Unicode normalization
        const normalized = UnicodeValidator.normalize(String(value));
        let stringValue = sanitizeInput(normalized.normalizedContent, this.MAX_STRING_LENGTH);
        
        // Apply regex validation if specified
        if (varDef.validation) {
          // SECURITY FIX: Validate regex complexity to prevent ReDoS attacks
          // Previously: User-provided regex executed without limits
          // Now: Check for dangerous patterns and limit execution time
          try {
            // Check for dangerous regex patterns
            if (this.isDangerousRegex(varDef.validation)) {
              throw ErrorHandler.createError(`Variable '${varDef.name}' has potentially dangerous validation pattern`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.DANGEROUS_PATTERN);
            }
            
            const regex = new RegExp(varDef.validation);
            // Use a simple timeout mechanism - in production, consider using a worker thread
            const startTime = Date.now();
            const result = regex.test(stringValue);
            const duration = Date.now() - startTime;
            
            // If regex takes too long, it might be malicious
            if (duration > 100) { // 100ms threshold
              SecurityMonitor.logSecurityEvent({
                type: 'CONTENT_INJECTION_ATTEMPT',
                severity: 'HIGH',
                source: 'Template.sanitizeVariableValue',
                details: `Regex validation took ${duration}ms for variable '${varDef.name}', possible ReDoS`
              });
              throw ErrorHandler.createError(`Variable '${varDef.name}' validation pattern is too complex`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.PATTERN_TOO_COMPLEX);
            }
            
            if (!result) {
              throw ErrorHandler.createError(`Variable '${varDef.name}' does not match validation pattern`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.PATTERN_MISMATCH);
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              throw ErrorHandler.createError(`Variable '${varDef.name}' has invalid validation pattern`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PATTERN);
            }
            throw e;
          }
        }
        
        // Check enum options if specified
        if (varDef.options && !varDef.options.includes(stringValue)) {
          throw ErrorHandler.createError(`Variable '${varDef.name}' must be one of: ${varDef.options.join(', ')}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_OPTIONS);
        }
        
        return stringValue;
      }

      case 'number': {
        const num = Number(value);
        if (Number.isNaN(num)) {
          throw ErrorHandler.createError(`Variable '${varDef.name}' must be a number`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_NUMBER);
        }
        return num;
      }

      case 'boolean':
        return Boolean(value);

      case 'date': {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          throw ErrorHandler.createError(`Variable '${varDef.name}' must be a valid date`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_DATE);
        }
        return date;
      }

      case 'array': {
        if (!Array.isArray(value)) {
          throw ErrorHandler.createError(`Variable '${varDef.name}' must be an array`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_ARRAY);
        }
        // SECURITY FIX: Limit array size to prevent memory exhaustion attacks
        // Previously: No limit on array size could lead to DoS
        // Now: Enforces reasonable size limit with logging
        const MAX_ARRAY_SIZE = 1000;
        if (value.length > MAX_ARRAY_SIZE) {
          SecurityMonitor.logSecurityEvent({
            type: 'CONTENT_SIZE_EXCEEDED',
            severity: 'MEDIUM',
            source: 'Template.sanitizeVariableValue',
            details: `Array variable '${varDef.name}' has ${value.length} items, limiting to ${MAX_ARRAY_SIZE}`
          });
          value = value.slice(0, MAX_ARRAY_SIZE);
        }
        // Sanitize string elements in arrays
        return value.map((item: any) =>
          typeof item === 'string' ? sanitizeInput(item, 1000) : item
        );
      }

      case 'object':
        if (typeof value !== 'object' || value === null) {
          throw ErrorHandler.createError(`Variable '${varDef.name}' must be an object`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_OBJECT);
        }
        // Deep sanitize string values in objects
        return this.sanitizeObject(value);
        
      default:
        return value;
    }
  }

  /**
   * Recursively sanitize string values in objects
   * SECURITY FIX: Truncate deep nesting instead of throwing to prevent DoS
   */
  private sanitizeObject(obj: any, depth: number = 0): any {
    // SECURITY FIX: Return safe default instead of throwing to prevent DoS attacks
    // Previously: Threw error on deep nesting which could be exploited
    // Now: Returns string representation for excessively nested objects
    if (depth > 10) {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_SIZE_EXCEEDED',
        severity: 'MEDIUM',
        source: 'Template.sanitizeObject',
        details: 'Object nesting depth exceeded, truncating to string representation'
      });
      return '[Object too deeply nested]';
    }
    
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      // SECURITY FIX: Limit array size to prevent memory exhaustion
      const MAX_ARRAY_SIZE = 1000;
      if (obj.length > MAX_ARRAY_SIZE) {
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_SIZE_EXCEEDED',
          severity: 'MEDIUM',
          source: 'Template.sanitizeObject',
          details: `Array size ${obj.length} exceeds maximum ${MAX_ARRAY_SIZE}, truncating`
        });
        obj = obj.slice(0, MAX_ARRAY_SIZE);
      }
      return obj.map((item: any) => this.sanitizeObject(item, depth + 1));
    }
    
    const sanitized: Record<string, any> = {};
    // SECURITY FIX: Limit number of object properties to prevent memory exhaustion
    const MAX_OBJECT_KEYS = 100;
    const entries = Object.entries(obj);
    if (entries.length > MAX_OBJECT_KEYS) {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_SIZE_EXCEEDED',
        severity: 'MEDIUM',
        source: 'Template.sanitizeObject',
        details: `Object has ${entries.length} keys, limiting to ${MAX_OBJECT_KEYS}`
      });
    }
    
    for (let i = 0; i < Math.min(entries.length, MAX_OBJECT_KEYS); i++) {
      const [key, value] = entries[i];
      const sanitizedKey = sanitizeInput(key, 50);
      if (typeof value === 'string') {
        sanitized[sanitizedKey] = sanitizeInput(value, 1000);
      } else if (typeof value === 'object') {
        sanitized[sanitizedKey] = this.sanitizeObject(value, depth + 1);
      } else {
        sanitized[sanitizedKey] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * Resolve nested variable paths (e.g., "user.name")
   * TYPE SAFETY: Improved type safety for variable resolution
   */
  private resolveVariable(path: string, variables: Record<string, unknown>): unknown {
    const parts = path.split('.');
    let value: unknown = variables;
    
    for (const part of parts) {
      if (value && typeof value === 'object' && value !== null && part in value) {
        // Type assertion with runtime check - safe because we verified the property exists
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    
    return value;
  }

  /**
   * Check if a regex pattern is potentially dangerous (ReDoS)
   * SECURITY FIX: Detect patterns that could cause exponential backtracking
   */
  private isDangerousRegex(pattern: string): boolean {
    // Check for nested quantifiers which can cause exponential backtracking
    // SECURITY FIX: Use safe, specific patterns to detect dangerous regex constructs
    // Previously: Used [^)]* patterns that could cause ReDoS in detection itself
    // Now: Use safer, bounded character classes and specific string checks
    // FIX: Use character class and remove unnecessary escape (SonarCloud S6035, S6535)
    const dangerousPatterns = [
      /[+*]{2,}/,                      // Multiple consecutive quantifiers
      /\(.{0,50}\+\)[+*]/,             // Quantified groups with quantifiers inside (bounded)
      /\[[^\]]{0,20}\+\][+*]/,         // Quantified character classes with quantifiers (bounded)
      /(\\[dws])\1{2,}/,               // Repeated character classes
      /\(\?<[!=][^)]{0,30}\)/,         // Complex lookbehinds (bounded)
    ];

    // String-based checks for common catastrophic patterns (safer than regex)
    const dangerousStringPatterns = [
      '(.+)+',    // (.+)+ catastrophic backtracking
      '(.*)++',   // (.*)++
      '(.*)*',    // (.*)* catastrophic backtracking
      '(.+)*',    // (.+)*
      '(a+)+',    // (a+)+ type patterns
      '(a*)*',    // (a*)* type patterns
      '(a|a)*',   // Overlapping alternation
      '(a|b)*+',  // Possessive quantifiers with alternation
    ];
    
    // Check regex-based dangerous patterns
    for (const dangerous of dangerousPatterns) {
      if (dangerous.test(pattern)) {
        return true;
      }
    }

    // Check string-based dangerous patterns (safer than complex regex)
    for (const dangerousString of dangerousStringPatterns) {
      if (pattern.includes(dangerousString)) {
        return true;
      }
    }

    // Check for excessive backtracking potential
    // Count groups and quantifiers (using safe, simple regex)
    const groups = (pattern.match(/\(/g) || []).length;
    const quantifiers = (pattern.match(/[+*?{]/g) || []).length;

    // If there are many groups and quantifiers, it's potentially dangerous
    if (groups > 5 && quantifiers > 5) {
      return true;
    }
    
    return false;
  }

  /**
   * Format a value for template output
   */
  private formatValue(value: any): string {
    if (value === undefined || value === null) {
      return '';
    }
    
    if (value instanceof Date) {
      return value.toISOString();
    }
    
    if (Array.isArray(value)) {
      return value.join(', ');
    }
    
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    
    return String(value);
  }

  /**
   * Process template includes
   * SECURITY FIX #2: Safe include processing with path validation
   * 
   * TODO: Implement actual include processing functionality
   * This is currently a placeholder that validates the security model
   * but does not actually load and render included templates.
   * 
   * Future implementation should:
   * 1. Load templates from validated paths
   * 2. Render them with current variables
   * 3. Replace include markers in content
   * 4. Respect includeDepth limit
   */
  private async processIncludes(
    content: string, 
    variables: Record<string, unknown>, 
    includeDepth: number
  ): Promise<string> {
    // TODO: Implement actual template include processing
    // Current implementation only validates the security model
    
    if (!this.metadata.includes || this.metadata.includes.length === 0) {
      return content;
    }
    
    // Log security event for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'TEMPLATE_INCLUDE',
      severity: 'LOW',
      source: 'Template.processIncludes',
      details: `Processing ${this.metadata.includes.length} includes at depth ${includeDepth}`
    });
    
    // TODO: Future implementation would:
    // for (const includePath of this.metadata.includes) {
    //   const template = await this.loadIncludedTemplate(includePath);
    //   const rendered = await template.render(variables, includeDepth + 1);
    //   content = content.replace(`{{include:${includePath}}}`, rendered);
    // }
    
    return content;
  }

  /**
   * Template-specific validation
   */
  public override validate(): ElementValidationResult {
    const result = super.validate();

    // Capture arrays as locals so TypeScript knows they're always defined
    // and call sites never need ! or inline ??= expressions (S1121, S6606).
    const errors = result.errors ??= [];
    const warnings = result.warnings ??= [];

    // Content validation
    if (!this.content || this.content.trim().length === 0) {
      errors.push({
        field: 'content',
        message: 'Template content cannot be empty',
        code: 'EMPTY_CONTENT'
      });
    }

    // Check for unmatched tokens.
    // Issue #705: In section mode, only count tokens within the <template> section —
    // <style> and <script> sections are raw passthrough where }} is intentional.
    // getSections() returns the cached result — no repeated regex execution.
    const { isSectionMode, templateSection } = this.getSections();
    const tokenCheckContent = isSectionMode ? templateSection : this.content;
    const openTokens = (tokenCheckContent.match(/\{\{/g) || []).length;
    const closeTokens = (tokenCheckContent.match(/\}\}/g) || []).length;
    if (openTokens !== closeTokens) {
      errors.push({
        field: 'content',
        message: 'Template has unmatched variable tokens',
        code: 'UNMATCHED_TOKENS'
      });
    }

    // Validate output format
    const validFormats = ['markdown', 'html', 'json', 'yaml', 'text', 'xml'];
    if (this.metadata.output_format && !validFormats.includes(this.metadata.output_format)) {
      warnings.push({
        field: 'output_format',
        message: `Unknown output format '${this.metadata.output_format}'. Common formats: ${validFormats.join(', ')}`,
        severity: 'low'
      });
    }

    // Validate variables
    if (this.metadata.variables) {
      const variableNames = new Set<string>();

      this.metadata.variables.forEach((variable, index) => {
        // Check for duplicate names
        if (variableNames.has(variable.name)) {
          errors.push({
            field: `variables[${index}].name`,
            message: `Duplicate variable name '${variable.name}'`,
            code: 'DUPLICATE_VARIABLE'
          });
        }
        variableNames.add(variable.name);

        // Validate regex patterns
        if (variable.validation) {
          try {
            new RegExp(variable.validation);
          } catch (e) {
            errors.push({
              field: `variables[${index}].validation`,
              message: `Invalid regex pattern: ${e}`,
              code: 'INVALID_REGEX'
            });
          }
        }
      });
    }

    // Check if all tokens have corresponding variable definitions
    const compiled = this.compile();
    const definedVars = new Set(this.metadata.variables?.map(v => v.name) || []);
    const usedVars = new Set(compiled.tokens.map(t => t.variable));

    usedVars.forEach(varName => {
      if (!definedVars.has(varName)) {
        warnings.push({
          field: 'variables',
          message: `Template uses undefined variable '${varName}'`,
          severity: 'medium'
        });
      }
    });
    
    // Warnings for best practices
    // FIX: Remove unnecessary non-null assertion (SonarCloud S4325)
    if (!this.metadata.tags || this.metadata.tags.length === 0) {
      result.warnings.push({
        field: 'tags',
        message: 'Consider adding tags for better searchability',
        severity: 'low'
      });
    }

    if (!this.metadata.examples || this.metadata.examples.length === 0) {
      result.warnings.push({
        field: 'examples',
        message: 'Adding examples improves template usability',
        severity: 'medium'
      });
    }
    
    // Update the valid flag based on final errors
    result.valid = (result.errors?.length || 0) === 0;
    
    return result;
  }

  /**
   * Serialize to JSON format for internal use and testing
   */
  public override serializeToJSON(): string {
    const data = {
      id: this.id,
      type: this.type,
      version: this.version,
      metadata: this.metadata,
      content: this.content,
      references: this.references,
      extensions: this.extensions,
      ratings: this.ratings
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Get content for serialization
   */
  protected override getContent(): string {
    return this.content;
  }

  /**
   * Serialize template to markdown format with YAML frontmatter
   * FIX: Changed from JSON to markdown for GitHub portfolio compatibility
   */
  public override serialize(): string {
    // Template content is already the main content
    // Just use base class serialize which outputs markdown
    return super.serialize();
  }

  /**
   * Deserialize template from JSON format
   */
  public override deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data);
      
      // Update metadata
      this.metadata = { ...this.metadata, ...parsed.metadata };
      
      // Update content
      this.content = parsed.content || '';
      
      // Update other properties
      this.references = parsed.references || [];
      this.extensions = parsed.extensions || {};
      this.ratings = parsed.ratings || this.ratings;
      
      // Update ID and version if provided
      if (parsed.id) this.id = parsed.id;
      if (parsed.version != null) this.version = normalizeVersion(String(parsed.version));
      
      // Clear compiled template and section caches (content changed)
      this.compiledTemplate = undefined;
      this.parsedSections = undefined;

      this._isDirty = true;
      logger.debug(`Deserialized template: ${this.metadata.name}`);
      
    } catch (error) {
      logger.error(`Failed to deserialize template: ${error}`);
      throw ErrorHandler.wrapError(error, 'Template deserialization failed', ErrorCategory.SYSTEM_ERROR);
    }
  }

  /**
   * Get a preview of the template with sample data
   */
  async preview(): Promise<string> {
    const sampleVars: Record<string, any> = {};
    
    // Generate sample data for each variable
    for (const varDef of this.metadata.variables || []) {
      switch (varDef.type) {
        case 'string':
          sampleVars[varDef.name] = varDef.default || `[${varDef.name}]`;
          break;
        case 'number':
          sampleVars[varDef.name] = varDef.default || 42;
          break;
        case 'boolean':
          sampleVars[varDef.name] = varDef.default || true;
          break;
        case 'date':
          sampleVars[varDef.name] = varDef.default || new Date();
          break;
        case 'array':
          sampleVars[varDef.name] = varDef.default || ['item1', 'item2'];
          break;
        case 'object':
          sampleVars[varDef.name] = varDef.default || { key: 'value' };
          break;
      }
    }
    
    return this.render(sampleVars);
  }

  /**
   * Template activation lifecycle
   */
  public override async activate(): Promise<void> {
    logger.info(`Activating template: ${this.metadata.name} (${this.id})`);
    
    // Compile the template to check for errors
    this.compile();
    
    await super.activate?.();
  }

  /**
   * Template deactivation lifecycle
   */
  public override async deactivate(): Promise<void> {
    logger.info(`Deactivating template: ${this.metadata.name} (${this.id})`);
    
    // Clear compiled template and section caches
    this.compiledTemplate = undefined;
    this.parsedSections = undefined;

    await super.deactivate?.();
  }
}

// Internal types for template compilation
interface CompiledTemplate {
  content: string;
  tokens: TemplateToken[];
  variables: TemplateVariable[];
}

interface TemplateToken {
  token: string;      // The full token including braces (e.g., "{{ name }}")
  variable: string;   // The variable path (e.g., "user.name")
  position: number;   // Position in the template string
}
