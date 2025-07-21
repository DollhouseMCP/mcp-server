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

import { BaseElement } from '../BaseElement.js';
import { IElement, IElementMetadata, ElementValidationResult } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { sanitizeInput, validatePath } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import * as path from 'path';

// Extend IElementMetadata with template-specific fields
export interface TemplateMetadata extends IElementMetadata {
  category?: string;              // Template category (documents, emails, code, etc.)
  output_format?: string;         // Output format (markdown, html, json, yaml, etc.)
  variables?: TemplateVariable[]; // Variable definitions
  includes?: string[];            // Other templates to include
  tags?: string[];               // Searchable tags
  usage_count?: number;          // Track popularity
  last_used?: string;            // ISO date string
  examples?: TemplateExample[];   // Usage examples
}

export interface TemplateVariable {
  name: string;                   // Variable name (e.g., "project_name")
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  description?: string;           // Help text for the variable
  required?: boolean;             // Is this variable required?
  default?: any;                  // Default value if not provided
  validation?: string;            // Regex pattern for validation (string type only)
  options?: string[];             // For enum-like strings
  format?: string;                // Date format string (date type only)
}

export interface TemplateExample {
  title: string;
  description?: string;
  variables: Record<string, any>;
  output?: string;
}

export class Template extends BaseElement implements IElement {
  public declare metadata: TemplateMetadata;
  public content: string;
  private compiledTemplate?: CompiledTemplate;
  
  // SECURITY FIX #4: Memory management constants
  // Prevents unbounded template size and variable count that could exhaust memory
  private readonly MAX_TEMPLATE_SIZE = 100 * 1024; // 100KB max template size
  private readonly MAX_VARIABLE_COUNT = 100;       // Max variables per template
  private readonly MAX_INCLUDE_DEPTH = 5;          // Prevent infinite include loops
  private readonly MAX_STRING_LENGTH = 10000;      // Max length for string variables

  constructor(metadata: Partial<TemplateMetadata>, content: string = '') {
    // SECURITY FIX #3 & #6: Validate and sanitize ALL metadata fields
    // Unicode normalization prevents homograph attacks
    // Input sanitization prevents XSS and injection attacks
    const sanitizedMetadata = {
      ...metadata,
      name: metadata.name ? sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100) : undefined,
      description: metadata.description ? sanitizeInput(UnicodeValidator.normalize(metadata.description).normalizedContent, 500) : undefined,
      category: metadata.category ? sanitizeInput(UnicodeValidator.normalize(metadata.category).normalizedContent, 50) : undefined,
      output_format: metadata.output_format ? sanitizeInput(metadata.output_format, 20) : undefined
    };
    
    super(ElementType.TEMPLATE, sanitizedMetadata);
    
    // SECURITY FIX #4: Enforce template size limit
    if (content.length > this.MAX_TEMPLATE_SIZE) {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_SIZE_EXCEEDED',
        severity: 'HIGH',
        source: 'Template.constructor',
        details: `Template size ${content.length} exceeds maximum ${this.MAX_TEMPLATE_SIZE}`
      });
      throw new Error(`Template content exceeds maximum size of ${this.MAX_TEMPLATE_SIZE} bytes`);
    }
    
    // SECURITY FIX #3: Sanitize template content
    // Note: We preserve the template syntax but normalize Unicode
    this.content = UnicodeValidator.normalize(content).normalizedContent;
    
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
      if (this.metadata.variables.length > this.MAX_VARIABLE_COUNT) {
        throw new Error(`Variable count ${this.metadata.variables.length} exceeds maximum ${this.MAX_VARIABLE_COUNT}`);
      }
      
      this.metadata.variables = this.metadata.variables.map(variable => ({
        ...variable,
        name: sanitizeInput(UnicodeValidator.normalize(variable.name).normalizedContent, 50),
        description: variable.description ? sanitizeInput(UnicodeValidator.normalize(variable.description).normalizedContent, 200) : undefined,
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
          throw new Error(`Invalid include path: ${sanitizedPath}`);
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
    
    // Only allow alphanumeric, dash, underscore, forward slash, and .md extension
    const validPathPattern = /^[a-zA-Z0-9\-_\/]+\.md$/;
    return validPathPattern.test(normalized);
  }

  /**
   * Compile the template for efficient rendering
   * SECURITY FIX #1: Safe template compilation without eval() or Function()
   * Uses regex-based token replacement instead of dynamic code execution
   */
  private compile(): CompiledTemplate {
    if (this.compiledTemplate) {
      return this.compiledTemplate;
    }

    // Extract all variable tokens from the template
    const variablePattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g;
    const tokens: TemplateToken[] = [];
    let match;
    
    while ((match = variablePattern.exec(this.content)) !== null) {
      tokens.push({
        token: match[0],
        variable: match[1],
        position: match.index
      });
    }

    this.compiledTemplate = {
      content: this.content,
      tokens,
      variables: this.metadata.variables || []
    };

    return this.compiledTemplate;
  }

  /**
   * Render the template with provided variables
   * SECURITY FIX #1: Safe rendering without code execution
   * SECURITY FIX #3: All variables are validated and sanitized
   */
  async render(variables: Record<string, any> = {}, includeDepth: number = 0): Promise<string> {
    // SECURITY FIX #4: Prevent infinite include loops
    if (includeDepth > this.MAX_INCLUDE_DEPTH) {
      SecurityMonitor.logSecurityEvent({
        type: 'INCLUDE_DEPTH_EXCEEDED',
        severity: 'HIGH',
        source: 'Template.render',
        details: `Include depth ${includeDepth} exceeds maximum ${this.MAX_INCLUDE_DEPTH}`
      });
      throw new Error('Maximum template include depth exceeded');
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
   */
  private async validateAndSanitizeVariables(variables: Record<string, any>): Promise<Record<string, any>> {
    const sanitized: Record<string, any> = {};
    
    // Check required variables
    for (const varDef of this.metadata.variables || []) {
      if (varDef.required && !(varDef.name in variables)) {
        if (varDef.default !== undefined) {
          sanitized[varDef.name] = varDef.default;
        } else {
          throw new Error(`Required variable '${varDef.name}' not provided`);
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
      case 'string':
        // SECURITY FIX #6: Unicode normalization
        const normalized = UnicodeValidator.normalize(String(value));
        let stringValue = sanitizeInput(normalized.normalizedContent, this.MAX_STRING_LENGTH);
        
        // Apply regex validation if specified
        if (varDef.validation) {
          const regex = new RegExp(varDef.validation);
          if (!regex.test(stringValue)) {
            throw new Error(`Variable '${varDef.name}' does not match validation pattern`);
          }
        }
        
        // Check enum options if specified
        if (varDef.options && !varDef.options.includes(stringValue)) {
          throw new Error(`Variable '${varDef.name}' must be one of: ${varDef.options.join(', ')}`);
        }
        
        return stringValue;
        
      case 'number':
        const num = Number(value);
        if (isNaN(num)) {
          throw new Error(`Variable '${varDef.name}' must be a number`);
        }
        return num;
        
      case 'boolean':
        return Boolean(value);
        
      case 'date':
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          throw new Error(`Variable '${varDef.name}' must be a valid date`);
        }
        return date;
        
      case 'array':
        if (!Array.isArray(value)) {
          throw new Error(`Variable '${varDef.name}' must be an array`);
        }
        // Sanitize string elements in arrays
        return value.map(item => 
          typeof item === 'string' ? sanitizeInput(item, 1000) : item
        );
        
      case 'object':
        if (typeof value !== 'object' || value === null) {
          throw new Error(`Variable '${varDef.name}' must be an object`);
        }
        // Deep sanitize string values in objects
        return this.sanitizeObject(value);
        
      default:
        return value;
    }
  }

  /**
   * Recursively sanitize string values in objects
   */
  private sanitizeObject(obj: any, depth: number = 0): any {
    if (depth > 10) {
      throw new Error('Object nesting too deep');
    }
    
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item, depth + 1));
    }
    
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
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
   */
  private resolveVariable(path: string, variables: Record<string, any>): any {
    const parts = path.split('.');
    let value: any = variables;
    
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }
    
    return value;
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
   */
  private async processIncludes(
    content: string, 
    variables: Record<string, any>, 
    includeDepth: number
  ): Promise<string> {
    // This is a placeholder - actual implementation would load and render included templates
    // For now, we just log the security event
    SecurityMonitor.logSecurityEvent({
      type: 'TEMPLATE_INCLUDE',
      severity: 'LOW',
      source: 'Template.processIncludes',
      details: `Processing ${this.metadata.includes?.length || 0} includes at depth ${includeDepth}`
    });
    
    return content;
  }

  /**
   * Template-specific validation
   */
  public override validate(): ElementValidationResult {
    const result = super.validate();
    
    // Initialize arrays if not present
    if (!result.errors) result.errors = [];
    if (!result.warnings) result.warnings = [];
    
    // Content validation
    if (!this.content || this.content.trim().length === 0) {
      result.errors.push({
        field: 'content',
        message: 'Template content cannot be empty',
        code: 'EMPTY_CONTENT'
      });
    }
    
    // Check for unmatched tokens
    const openTokens = (this.content.match(/\{\{/g) || []).length;
    const closeTokens = (this.content.match(/\}\}/g) || []).length;
    if (openTokens !== closeTokens) {
      result.errors.push({
        field: 'content',
        message: 'Template has unmatched variable tokens',
        code: 'UNMATCHED_TOKENS'
      });
    }
    
    // Validate output format
    const validFormats = ['markdown', 'html', 'json', 'yaml', 'text', 'xml'];
    if (this.metadata.output_format && !validFormats.includes(this.metadata.output_format)) {
      result.warnings.push({
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
          result.errors!.push({
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
            result.errors!.push({
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
    const usedVars = new Set(compiled.tokens.map(t => t.variable.split('.')[0]));
    
    usedVars.forEach(varName => {
      if (!definedVars.has(varName)) {
        result.warnings!.push({
          field: 'variables',
          message: `Template uses undefined variable '${varName}'`,
          severity: 'medium'
        });
      }
    });
    
    // Warnings for best practices
    if (!this.metadata.tags || this.metadata.tags.length === 0) {
      result.warnings!.push({
        field: 'tags',
        message: 'Consider adding tags for better searchability',
        severity: 'low'
      });
    }
    
    if (!this.metadata.examples || this.metadata.examples.length === 0) {
      result.warnings!.push({
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
   * Serialize template to JSON format
   */
  public override serialize(): string {
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
      if (parsed.version) this.version = parsed.version;
      
      // Clear compiled template cache
      this.compiledTemplate = undefined;
      
      this._isDirty = true;
      logger.debug(`Deserialized template: ${this.metadata.name}`);
      
    } catch (error) {
      logger.error(`Failed to deserialize template: ${error}`);
      throw new Error(`Deserialization failed: ${error}`);
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
    
    // Clear compiled template cache
    this.compiledTemplate = undefined;
    
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