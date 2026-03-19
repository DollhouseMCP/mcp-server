/**
 * TemplateElementValidator - Specialized validator for Template elements
 *
 * Extends GenericElementValidator to add Template-specific validation:
 * - Output format validation
 * - Variable placeholder validation
 * - Template syntax validation
 */

import { ElementType } from '../../portfolio/types.js';
import { GenericElementValidator } from './GenericElementValidator.js';
import { ValidationResult, ValidatorHelpers } from './ElementValidator.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';

const VALID_OUTPUT_FORMATS = ['text', 'markdown', 'json', 'yaml', 'html', 'xml'];
const VARIABLE_PLACEHOLDER_REGEX = /\{\{[^}]+\}\}/g;
// Issue #705: Module-level constants so regex objects are compiled once, not per validation call
const SECTION_DETECTION_REGEX = /<(?:template|style|script)>[\s\S]*?<\/(?:template|style|script)>/i;
const TEMPLATE_SECTION_EXTRACT_REGEX = /<template>([\s\S]*?)<\/template>/i;

export class TemplateElementValidator extends GenericElementValidator {
  constructor(
    validationService: ValidationService,
    triggerValidationService: TriggerValidationService,
    metadataService: MetadataService
  ) {
    super(ElementType.TEMPLATE, validationService, triggerValidationService, metadataService);
  }

  /**
   * Override validateCreate to add template-specific validation
   */
  override async validateCreate(
    data: unknown,
    options?: any
  ): Promise<ValidationResult> {
    // First run generic validation
    const baseResult = await super.validateCreate(data, options);
    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];
    const suggestions = [...(baseResult.suggestions || [])];

    if (!data || typeof data !== 'object') {
      return baseResult;
    }

    const record = data as Record<string, unknown>;

    // Validate output format if present
    if (record.output_format !== undefined) {
      const formatResult = this.validateOutputFormat(record.output_format);
      if (!formatResult.isValid) {
        errors.push(...formatResult.errors);
      }
      warnings.push(...formatResult.warnings);
    }

    // Validate template syntax in content
    if (record.content && typeof record.content === 'string') {
      const syntaxResult = this.validateTemplateSyntax(record.content);
      if (!syntaxResult.isValid) {
        errors.push(...syntaxResult.errors);
      }
      warnings.push(...syntaxResult.warnings);
    }

    // Validate variables if present
    if (record.variables !== undefined) {
      const varsResult = this.validateVariables(record.variables);
      if (!varsResult.isValid) {
        errors.push(...varsResult.errors);
      }
      warnings.push(...varsResult.warnings);
    }

    // Additional template-specific suggestions
    if (!record.output_format) {
      suggestions.push('Consider specifying an output_format (text, markdown, json, etc.)');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Validate output format
   */
  private validateOutputFormat(format: unknown): ValidationResult {
    if (typeof format !== 'string') {
      return ValidatorHelpers.fail(['Output format must be a string']);
    }

    const sanitized = this.validationService.validateAndSanitizeInput(format, {
      maxLength: 20,
      allowSpaces: false
    });

    if (!sanitized.isValid) {
      return ValidatorHelpers.fail(sanitized.errors || ['Invalid output format']);
    }

    const normalizedFormat = sanitized.sanitizedValue!.toLowerCase();
    if (!VALID_OUTPUT_FORMATS.includes(normalizedFormat)) {
      return {
        isValid: true,
        errors: [],
        warnings: [`Unknown output format '${normalizedFormat}'. Valid formats: ${VALID_OUTPUT_FORMATS.join(', ')}`]
      };
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate template syntax for variable placeholders
   */
  private validateTemplateSyntax(content: string): ValidationResult {
    const warnings: string[] = [];

    // Issue #705: In section mode, only validate {{ }} balance within the <template> section.
    // <style> and <script> sections are raw passthrough — }} is intentional there.
    // Uses module-level constants so regex objects are compiled once, not per validation call.
    const hasSections = SECTION_DETECTION_REGEX.test(content);
    const templateMatch = hasSections ? TEMPLATE_SECTION_EXTRACT_REGEX.exec(content) : null;
    const checkContent = hasSections ? (templateMatch ? templateMatch[1] : '') : content;

    // Find all variable placeholders
    const placeholders = checkContent.match(VARIABLE_PLACEHOLDER_REGEX) || [];
    const uniquePlaceholders = new Set(placeholders);

    if (uniquePlaceholders.size > 0) {
      // Check for unbalanced braces
      const openCount = (checkContent.match(/\{\{/g) || []).length;
      const closeCount = (checkContent.match(/\}\}/g) || []).length;

      if (openCount !== closeCount) {
        return ValidatorHelpers.fail(['Template has unbalanced variable placeholders (mismatched {{ and }})']);
      }

      // Warn about many variables
      if (uniquePlaceholders.size > 10) {
        warnings.push(`Template has ${uniquePlaceholders.size} unique variables - consider simplifying`);
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate template variables definition.
   *
   * Accepts two formats:
   * - Array format (frontmatter declarations): [{ name, type, required?, description? }]
   * - Object format (render-time values): { variableName: "value" }
   */
  private validateVariables(variables: unknown): ValidationResult {
    if (!variables) {
      return ValidatorHelpers.pass();
    }

    if (typeof variables !== 'object') {
      return ValidatorHelpers.fail([
        'Variables must be either a declaration array (e.g. [{ name: "title", type: "string" }]) or a key-value object (e.g. { title: "My Page" }), not a primitive'
      ]);
    }

    // Array format: frontmatter variable declarations [{ name, type, required?, description? }]
    if (Array.isArray(variables)) {
      return this.validateVariableDeclarations(variables);
    }

    // Object format: render-time key-value pairs { variableName: "value" }
    return this.validateVariableValues(variables as Record<string, unknown>);
  }

  /**
   * Validate array-format variable declarations (frontmatter style).
   */
  private validateVariableDeclarations(variables: unknown[]): ValidationResult {
    const warnings: string[] = [];

    if (variables.length === 0) {
      warnings.push('Variables array is empty');
    } else if (variables.length > 50) {
      warnings.push(`Template has ${variables.length} variables declared - consider reducing complexity`);
    }

    for (const entry of variables) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return ValidatorHelpers.fail([
          'Each variable declaration must be an object with at least { name, type } (e.g. { name: "title", type: "string", required: true })'
        ]);
      }

      const decl = entry as Record<string, unknown>;

      if (!decl.name || typeof decl.name !== 'string') {
        return ValidatorHelpers.fail([
          'Each variable declaration must have a "name" string field'
        ]);
      }

      if (!decl.type || typeof decl.type !== 'string') {
        return ValidatorHelpers.fail([
          `Variable declaration "${decl.name}" must have a "type" string field`
        ]);
      }

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(decl.name)) {
        return ValidatorHelpers.fail([`Invalid variable name '${decl.name}' - must be alphanumeric with underscores`]);
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate object-format render-time variable values.
   */
  private validateVariableValues(vars: Record<string, unknown>): ValidationResult {
    const warnings: string[] = [];
    const varCount = Object.keys(vars).length;

    if (varCount === 0) {
      warnings.push('Variables object is empty — provide key-value pairs matching the template\'s {{variable}} placeholders');
    } else if (varCount > 20) {
      warnings.push(`Template has ${varCount} variables defined - consider reducing complexity`);
    }

    // Validate each variable name
    for (const [key, value] of Object.entries(vars)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        return ValidatorHelpers.fail([`Invalid variable name '${key}' - must be alphanumeric with underscores`]);
      }

      if (key.length > 50) {
        warnings.push(`Variable name '${key}' is very long`);
      }

      // Check variable type
      if (value !== undefined && value !== null) {
        const valueType = typeof value;
        if (!['string', 'number', 'boolean', 'object'].includes(valueType)) {
          warnings.push(`Variable '${key}' has unusual type: ${valueType}`);
        }
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }
}