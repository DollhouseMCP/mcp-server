/**
 * Skill element class implementing IElement interface.
 * Represents a discrete capability for specific tasks.
 */

import { BaseElement } from '../BaseElement.js';
import { IElement, IElementMetadata, ElementValidationResult } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { sanitizeInput, validatePath } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

// Extend IElementMetadata with skill-specific fields
export interface SkillMetadata extends IElementMetadata {
  languages?: string[];           // Programming/spoken languages this skill works with
  complexity?: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  domains?: string[];             // Domain categories (e.g., web-dev, data-science, writing)
  prerequisites?: string[];       // Required knowledge or other skills
  parameters?: SkillParameter[];  // Configurable parameters
  examples?: SkillExample[];      // Usage examples
  certification?: string;         // External certification or validation
  proficiency_level?: number;     // 1-100 proficiency level
}

export interface SkillParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  description: string;
  required?: boolean;
  default?: any;
  options?: string[];  // For enum type
  min?: number;        // For number type
  max?: number;        // For number type
}

export interface SkillExample {
  title: string;
  description: string;
  input?: any;
  output?: any;
  code?: string;
}

export class Skill extends BaseElement implements IElement {
  public declare metadata: SkillMetadata;
  public instructions: string;
  public parameters: Map<string, any> = new Map();
  
  // Constants for memory management
  private readonly MAX_PARAMETER_COUNT = 100;
  private readonly MAX_PARAMETER_SIZE = 10000; // Max size per parameter value

  constructor(metadata: Partial<SkillMetadata>, instructions: string = '') {
    // Validate and sanitize metadata
    const sanitizedMetadata = {
      ...metadata,
      name: metadata.name ? sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100) : undefined,
      description: metadata.description ? sanitizeInput(UnicodeValidator.normalize(metadata.description).normalizedContent, 500) : undefined
    };
    
    super(ElementType.SKILL, sanitizedMetadata);
    this.instructions = instructions ? sanitizeInput(UnicodeValidator.normalize(instructions).normalizedContent, 10000) : '';
    
    // Ensure skill-specific metadata
    this.metadata = {
      ...this.metadata,
      languages: metadata.languages || [],
      complexity: metadata.complexity || 'beginner',
      domains: metadata.domains || [],
      prerequisites: metadata.prerequisites || [],
      parameters: metadata.parameters || [],
      examples: metadata.examples || [],
      proficiency_level: metadata.proficiency_level || 0
    };

    // Validate parameter definitions
    if (this.metadata.parameters) {
      this.metadata.parameters = this.metadata.parameters.map(param => ({
        ...param,
        name: sanitizeInput(UnicodeValidator.normalize(param.name).normalizedContent, 50),
        description: sanitizeInput(UnicodeValidator.normalize(param.description).normalizedContent, 200),
        options: param.options?.map(opt => sanitizeInput(opt, 100))
      }));
    }

    // Initialize parameter values with defaults
    this.initializeParameters();
  }

  /**
   * Initialize parameters with default values
   */
  private initializeParameters(): void {
    if (this.metadata.parameters) {
      this.metadata.parameters.forEach(param => {
        if (param.default !== undefined) {
          this.parameters.set(param.name, param.default);
        }
      });
    }
  }

  /**
   * Set a parameter value
   */
  setParameter(name: string, value: any): void {
    // Sanitize parameter name
    const sanitizedName = sanitizeInput(name, 50);
    
    const param = this.metadata.parameters?.find(p => p.name === sanitizedName);
    if (!param) {
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_PARSING_WARNING',
        severity: 'MEDIUM',
        source: 'Skill.setParameter',
        details: `Attempt to set unknown parameter: ${sanitizedName} for skill: ${this.metadata.name}`
      });
      throw new Error(`Parameter '${sanitizedName}' not found in skill definition`);
    }

    // Sanitize and validate the value based on type
    let sanitizedValue = value;
    
    if (param.type === 'string') {
      // Normalize Unicode and sanitize string values
      const normalized = UnicodeValidator.normalize(String(value));
      sanitizedValue = sanitizeInput(normalized.normalizedContent, param.max || 1000);
      
      // Additional validation for potential injection attacks
      if (sanitizedValue.includes('<script') || sanitizedValue.includes('javascript:')) {
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH',
          source: 'Skill.setParameter',
          details: `Potential XSS attempt in skill parameter: ${sanitizedName} for skill: ${this.metadata.name}`
        });
        throw new Error('Invalid characters in parameter value');
      }
    }

    // Type validation
    if (!this.validateParameterValue(param, sanitizedValue)) {
      throw new Error(`Invalid value for parameter '${sanitizedName}': expected ${param.type}`);
    }

    // Memory management - check parameter count
    if (this.parameters.size >= this.MAX_PARAMETER_COUNT && !this.parameters.has(sanitizedName)) {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        source: 'Skill.setParameter',
        details: `Parameter limit exceeded for skill: ${this.metadata.name}. Max: ${this.MAX_PARAMETER_COUNT}`
      });
      throw new Error(`Parameter limit exceeded. Maximum ${this.MAX_PARAMETER_COUNT} parameters allowed`);
    }
    
    // Check parameter value size for strings
    if (param.type === 'string' && sanitizedValue.length > this.MAX_PARAMETER_SIZE) {
      throw new Error(`Parameter value too large. Maximum ${this.MAX_PARAMETER_SIZE} characters allowed`);
    }

    this.parameters.set(sanitizedName, sanitizedValue);
    logger.debug(`Set parameter ${sanitizedName} = ${sanitizedValue} for skill ${this.metadata.name}`);
  }

  /**
   * Get a parameter value
   */
  getParameter(name: string): any {
    return this.parameters.get(name);
  }

  /**
   * Get all parameters as object
   */
  getAllParameters(): Record<string, any> {
    return Object.fromEntries(this.parameters);
  }

  /**
   * Validate parameter value against its definition
   */
  private validateParameterValue(param: SkillParameter, value: any): boolean {
    switch (param.type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        const num = Number(value);
        if (isNaN(num)) return false;
        if (param.min !== undefined && num < param.min) return false;
        if (param.max !== undefined && num > param.max) return false;
        return true;
      case 'boolean':
        return typeof value === 'boolean';
      case 'enum':
        return param.options?.includes(String(value)) || false;
      default:
        return true;
    }
  }

  /**
   * Execute the skill with current parameters
   */
  async execute(input?: any): Promise<any> {
    logger.info(`Executing skill: ${this.metadata.name}`);
    
    // Validate required parameters
    const missingRequired = this.metadata.parameters
      ?.filter(p => p.required && !this.parameters.has(p.name))
      .map(p => p.name) || [];
    
    if (missingRequired.length > 0) {
      throw new Error(`Missing required parameters: ${missingRequired.join(', ')}`);
    }

    // Skills don't have built-in execution logic - this would be implemented
    // by specific skill types or through a plugin system
    logger.debug(`Skill ${this.metadata.name} executed with parameters:`, this.getAllParameters());
    
    return {
      skill: this.metadata.name,
      parameters: this.getAllParameters(),
      input,
      executed_at: new Date().toISOString()
    };
  }

  /**
   * Skill-specific validation
   */
  public override validate(): ElementValidationResult {
    const result = super.validate();
    
    // Initialize arrays if not present
    if (!result.errors) result.errors = [];
    if (!result.warnings) result.warnings = [];
    
    // Instructions should not be empty
    if (!this.instructions || this.instructions.trim().length === 0) {
      result.errors.push({
        field: 'instructions',
        message: 'Skill instructions cannot be empty',
        code: 'EMPTY_INSTRUCTIONS'
      });
    }

    // Validate complexity level
    const validComplexity = ['beginner', 'intermediate', 'advanced', 'expert'];
    if (this.metadata.complexity && !validComplexity.includes(this.metadata.complexity)) {
      result.errors.push({
        field: 'complexity',
        message: `Complexity must be one of: ${validComplexity.join(', ')}`,
        code: 'INVALID_COMPLEXITY'
      });
    }

    // Validate proficiency level
    if (this.metadata.proficiency_level !== undefined) {
      if (this.metadata.proficiency_level < 0 || this.metadata.proficiency_level > 100) {
        result.errors.push({
          field: 'proficiency_level',
          message: 'Proficiency level must be between 0 and 100',
          code: 'INVALID_PROFICIENCY'
        });
      }
    }

    // Validate parameters
    if (this.metadata.parameters) {
      this.metadata.parameters.forEach((param, index) => {
        if (!param.name || param.name.trim() === '') {
          result.errors!.push({
            field: `parameters[${index}].name`,
            message: 'Parameter name is required',
            code: 'MISSING_PARAMETER_NAME'
          });
        }
        
        if (param.type === 'enum' && (!param.options || param.options.length === 0)) {
          result.errors!.push({
            field: `parameters[${index}].options`,
            message: 'Enum parameter must have options defined',
            code: 'MISSING_ENUM_OPTIONS'
          });
        }
      });
    }

    // Warnings for best practices
    if (!this.metadata.domains || this.metadata.domains.length === 0) {
      result.warnings.push({
        field: 'domains',
        message: 'Consider adding domain categories for better organization',
        severity: 'low'
      });
    }

    if (!this.metadata.examples || this.metadata.examples.length === 0) {
      result.warnings.push({
        field: 'examples',
        message: 'Adding usage examples improves skill usability',
        severity: 'medium'
      });
    }

    // Update the valid flag based on final errors
    result.valid = (result.errors?.length || 0) === 0;

    return result;
  }

  /**
   * Serialize skill to JSON format
   */
  public override serialize(): string {
    const data = {
      id: this.id,
      type: this.type,
      version: this.version,
      metadata: this.metadata,
      instructions: this.instructions,
      parameters: this.getAllParameters(),
      references: this.references,
      extensions: this.extensions,
      ratings: this.ratings
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * Deserialize skill from JSON format
   */
  public override deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data);
      
      // Update metadata
      this.metadata = { ...this.metadata, ...parsed.metadata };
      
      // Update other properties
      this.instructions = parsed.instructions || '';
      this.references = parsed.references || [];
      this.extensions = parsed.extensions || {};
      this.ratings = parsed.ratings || this.ratings;
      
      // Update ID and version if provided
      if (parsed.id) this.id = parsed.id;
      if (parsed.version) this.version = parsed.version;
      
      // Restore parameters
      if (parsed.parameters) {
        this.parameters.clear();
        Object.entries(parsed.parameters).forEach(([key, value]) => {
          this.parameters.set(key, value);
        });
      }
      
      this._isDirty = true;
      logger.debug(`Deserialized skill: ${this.metadata.name}`);
      
    } catch (error) {
      logger.error(`Failed to deserialize skill: ${error}`);
      throw new Error(`Deserialization failed: ${error}`);
    }
  }

  /**
   * Skill activation lifecycle
   */
  public override async activate(): Promise<void> {
    logger.info(`Activating skill: ${this.metadata.name} (${this.id})`);
    
    // Validate that all required parameters are set
    const validation = this.validate();
    if (!validation.valid) {
      throw new Error(`Cannot activate skill with validation errors: ${validation.errors?.map(e => e.message).join(', ')}`);
    }
    
    await super.activate?.();
  }

  /**
   * Clone the skill with different parameters
   */
  clone(newParameters?: Record<string, any>): Skill {
    const cloned = new Skill(this.metadata, this.instructions);
    
    // Copy current parameters
    this.parameters.forEach((value, key) => {
      cloned.parameters.set(key, value);
    });
    
    // Override with new parameters if provided
    if (newParameters) {
      Object.entries(newParameters).forEach(([key, value]) => {
        cloned.setParameter(key, value);
      });
    }
    
    return cloned;
  }
  
  /**
   * Skill deactivation lifecycle
   */
  public override async deactivate(): Promise<void> {
    logger.info(`Deactivating skill: ${this.metadata.name} (${this.id})`);
    
    // Clear parameters to free memory
    this.clearParameters();
    
    await super.deactivate?.();
  }
  
  /**
   * Clear all parameters (for memory management)
   */
  clearParameters(): void {
    this.parameters.clear();
    logger.debug(`Cleared all parameters for skill: ${this.metadata.name}`);
  }
}