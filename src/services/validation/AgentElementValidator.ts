/**
 * AgentElementValidator - Specialized validator for Agent elements
 *
 * Extends GenericElementValidator to add Agent-specific validation:
 * - V2.0 fields: goal (template/parameters), activates, tools, systemPrompt, autonomy
 * - V1.x legacy fields with deprecation warnings
 * - Complex validations: goal template/parameter consistency, autonomy conflict detection
 * - Migration suggestions for V1 agents
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */

import { ElementType } from '../../portfolio/types.js';
import { GenericElementValidator } from './GenericElementValidator.js';
import { ValidationResult, ValidatorHelpers, ElementValidationOptions } from './ElementValidator.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';
import {
  DECISION_FRAMEWORKS,
  RISK_TOLERANCE_LEVELS,
  STEP_LIMIT_ACTIONS,
  EXECUTION_FAILURE_ACTIONS,
  BACKOFF_STRATEGIES,
  AGENT_LIMITS,
  isOneOf,
  DecisionFramework,
  RiskTolerance
} from '../../elements/agents/constants.js';
import { findPatternConflicts } from '../../utils/patternMatcher.js';
import { parseElementPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';

/**
 * Valid parameter types for goal templates
 */
const VALID_PARAMETER_TYPES = ['string', 'number', 'boolean'] as const;
type ParameterType = typeof VALID_PARAMETER_TYPES[number];

/**
 * Valid element types for activates configuration
 */
const VALID_ACTIVATES_TYPES = [
  'personas',
  'skills',
  'memories',
  'templates',
  'ensembles'
] as const;

/**
 * System prompt length limits
 */
const SYSTEM_PROMPT_MIN_LENGTH = 1;
const SYSTEM_PROMPT_MAX_LENGTH = 10000;

/**
 * Specialized validator for Agent elements
 */
export class AgentElementValidator extends GenericElementValidator {
  constructor(
    validationService: ValidationService,
    triggerValidationService: TriggerValidationService,
    metadataService: MetadataService
  ) {
    super(ElementType.AGENT, validationService, triggerValidationService, metadataService);
  }

  /**
   * Override validateCreate to add agent-specific validation
   */
  override async validateCreate(
    data: unknown,
    options?: ElementValidationOptions
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

    // V2.0 OPTIONAL FIELD: goal
    // Note: V1 agents don't have goal - they use decisionFramework/specializations
    // V2 agents should define goal, but we don't require it to maintain backward compatibility
    if (record.goal !== undefined) {
      const goalResult = this.validateGoal(record.goal);
      if (!goalResult.isValid) {
        errors.push(...goalResult.errors);
      }
      warnings.push(...goalResult.warnings);
    }

    // V2.0 OPTIONAL FIELDS

    // Validate activates configuration
    if (record.activates !== undefined) {
      const activatesResult = this.validateActivates(record.activates);
      if (!activatesResult.isValid) {
        errors.push(...activatesResult.errors);
      }
      warnings.push(...activatesResult.warnings);
    }

    // Validate tools configuration
    if (record.tools !== undefined) {
      const toolsResult = this.validateTools(record.tools);
      if (!toolsResult.isValid) {
        errors.push(...toolsResult.errors);
      }
      warnings.push(...toolsResult.warnings);
    }

    // Validate system prompt
    if (record.systemPrompt !== undefined) {
      const promptResult = this.validateSystemPrompt(record.systemPrompt);
      if (!promptResult.isValid) {
        errors.push(...promptResult.errors);
      }
      warnings.push(...promptResult.warnings);
    }

    // Validate autonomy configuration
    if (record.autonomy !== undefined) {
      const autonomyResult = this.validateAutonomy(record.autonomy);
      if (!autonomyResult.isValid) {
        errors.push(...autonomyResult.errors);
      }
      warnings.push(...autonomyResult.warnings);
    }

    // Validate resilience configuration (Issue #526)
    if (record.resilience !== undefined) {
      const resilienceResult = this.validateResilience(record.resilience);
      if (!resilienceResult.isValid) {
        errors.push(...resilienceResult.errors);
      }
      warnings.push(...resilienceResult.warnings);
    }

    // Validate gatekeeper policy structure (Issue #449)
    // Uses parseElementPolicy() which validates: object type, allow/confirm/deny
    // are string arrays, and scopeRestrictions structure if present.
    if (record.gatekeeper !== undefined) {
      try {
        const policy = parseElementPolicy({ gatekeeper: record.gatekeeper });
        if (!policy) {
          errors.push('Invalid gatekeeper policy: must be a non-null object with allow, confirm, or deny arrays');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Invalid gatekeeper policy: ${message}`);
      }
    }

    // V1.X LEGACY FIELDS - Validate but emit warnings for deprecation

    // decisionFramework (V1.x)
    if (record.decisionFramework !== undefined) {
      const frameworkResult = this.validateDecisionFramework(record.decisionFramework);
      if (!frameworkResult.isValid) {
        errors.push(...frameworkResult.errors);
      }
      warnings.push(...frameworkResult.warnings);
      warnings.push("Field 'decisionFramework' is deprecated in V2.0. LLM judgment is now used instead.");
    }

    // specializations (V1.x)
    if (record.specializations !== undefined) {
      const specializationsResult = this.validateSpecializations(record.specializations);
      if (!specializationsResult.isValid) {
        warnings.push(...specializationsResult.errors);
      }
    }

    // riskTolerance (V1.x)
    if (record.riskTolerance !== undefined) {
      const riskResult = this.validateRiskTolerance(record.riskTolerance);
      if (!riskResult.isValid) {
        errors.push(...riskResult.errors);
      }
      // Note: riskTolerance is also used in V2.0 autonomy config, so only warn if NOT in autonomy
      if (!record.autonomy || !(record.autonomy as any)?.riskTolerance) {
        warnings.push("Field 'riskTolerance' at root level is deprecated in V2.0. Use 'autonomy.riskTolerance' instead.");
      }
    }

    // learningEnabled (V1.x)
    if (record.learningEnabled !== undefined) {
      if (typeof record.learningEnabled !== 'boolean') {
        warnings.push("Field 'learningEnabled' must be a boolean");
      }
      warnings.push("Field 'learningEnabled' is deprecated in V2.0. LLM handles learning naturally.");
    }

    // maxConcurrentGoals (V1.x)
    if (record.maxConcurrentGoals !== undefined) {
      const concurrentResult = this.validateMaxConcurrentGoals(record.maxConcurrentGoals);
      if (!concurrentResult.isValid) {
        warnings.push(...concurrentResult.errors);
      }
      warnings.push("Field 'maxConcurrentGoals' is deprecated in V2.0.");
    }

    // ruleEngineConfig (V1.x)
    if (record.ruleEngineConfig !== undefined) {
      warnings.push("Field 'ruleEngineConfig' is deprecated in V2.0. Constraints are handled by evaluateConstraints().");
    }

    // SUGGESTIONS

    // Suggest migration for V1 agents
    if (this.isV1Agent(record)) {
      suggestions.push('This appears to be a V1.x agent. Consider migrating to V2.0 format with goal templates.');
    }

    // Suggest optional fields if missing
    if (!record.activates) {
      suggestions.push("Consider adding 'activates' configuration to specify which elements should be activated.");
    }

    if (!record.tools) {
      suggestions.push("Consider adding 'tools' configuration to guide LLM on appropriate tool usage.");
    }

    if (!record.systemPrompt) {
      suggestions.push("Consider adding 'systemPrompt' to provide custom LLM context for this agent.");
    }

    if (!record.autonomy) {
      suggestions.push("Consider adding 'autonomy' configuration to control continue/pause behavior.");
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Validate V2.0 goal configuration (REQUIRED)
   *
   * Must have:
   * - template (string with {parameter} placeholders)
   * - parameters (array of parameter definitions)
   * - successCriteria (optional string[])
   *
   * Also validates template/parameter consistency.
   *
   * Architecture: Input normalization happens at GenericElementValidator boundary.
   * This validator receives pre-normalized data and validates business rules.
   */
  private validateGoal(goal: unknown): ValidationResult {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
      return ValidatorHelpers.fail(['Goal must be an object with template and parameters']);
    }

    const goalObj = goal as Record<string, unknown>;
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate template
    // Note: Input is already normalized by GenericElementValidator
    if (goalObj.template === undefined || goalObj.template === null) {
      errors.push("Goal is missing required 'template' field");
    } else if (typeof goalObj.template !== 'string') {
      errors.push("Goal template must be a string");
    } else {
      // Validate length and content patterns (data is already normalized)
      const contentResult = this.validationService.validateContent(goalObj.template, {
        maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH
      });

      if (!contentResult.isValid) {
        errors.push(...(contentResult.detectedPatterns || ['Goal template failed content validation']));
      } else if (goalObj.template.trim().length === 0) {
        errors.push("Goal template cannot be empty");
      }
    }

    // Validate parameters
    if (!goalObj.parameters) {
      errors.push("Goal is missing required 'parameters' field");
    } else if (!Array.isArray(goalObj.parameters)) {
      errors.push("Goal parameters must be an array");
    } else {
      // Validate each parameter
      const template = String(goalObj.template || '');
      const parametersResult = this.validateGoalParameters(
        goalObj.parameters,
        template
      );
      if (!parametersResult.isValid) {
        errors.push(...parametersResult.errors);
      }
      warnings.push(...parametersResult.warnings);
    }

    // Validate successCriteria (optional)
    if (goalObj.successCriteria !== undefined) {
      if (!Array.isArray(goalObj.successCriteria)) {
        errors.push("Goal successCriteria must be an array of strings");
      } else {
        for (let i = 0; i < goalObj.successCriteria.length; i++) {
          const criterion = goalObj.successCriteria[i];
          if (typeof criterion !== 'string') {
            errors.push(`Success criterion at index ${i} must be a string`);
          } else {
            // Validate length and patterns (data is already normalized)
            const contentResult = this.validationService.validateContent(criterion, {
              maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH
            });
            if (!contentResult.isValid) {
              errors.push(`Success criterion at index ${i} failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`);
            } else if (criterion.trim().length === 0) {
              warnings.push(`Success criterion at index ${i} is empty`);
            }
          }
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate goal parameters and check consistency with template
   */
  private validateGoalParameters(
    parameters: unknown[],
    template: string
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const parameterNames = new Set<string>();
    const templatePlaceholders = this.extractTemplatePlaceholders(template);

    for (let i = 0; i < parameters.length; i++) {
      const param = parameters[i];

      if (!param || typeof param !== 'object') {
        errors.push(`Parameter at index ${i} must be an object`);
        continue;
      }

      const paramObj = param as Record<string, unknown>;

      // Validate name
      if (!paramObj.name) {
        errors.push(`Parameter at index ${i} is missing required 'name' field`);
        continue;
      }

      if (typeof paramObj.name !== 'string') {
        errors.push(`Parameter name at index ${i} must be a string`);
        continue;
      }

      // Validate parameter name (data is already normalized)
      const nameResult = this.validationService.validateContent(paramObj.name, {
        maxLength: AGENT_LIMITS.MAX_AGENT_NAME_LENGTH
      });
      if (!nameResult.isValid) {
        errors.push(`Parameter name at index ${i} failed validation: ${nameResult.detectedPatterns?.join(', ') || 'invalid content'}`);
        continue;
      }
      const paramName = paramObj.name as string;

      // Check for duplicate parameter names
      if (parameterNames.has(paramName)) {
        errors.push(`Duplicate parameter name '${paramName}' at index ${i}`);
      }
      parameterNames.add(paramName);

      // Validate type
      if (!paramObj.type) {
        errors.push(`Parameter '${paramName}' is missing required 'type' field`);
      } else if (typeof paramObj.type !== 'string') {
        errors.push(`Parameter '${paramName}' type must be a string`);
      } else if (!VALID_PARAMETER_TYPES.includes(paramObj.type as ParameterType)) {
        errors.push(
          `Parameter '${paramName}' has invalid type '${paramObj.type}'. Valid types: ${VALID_PARAMETER_TYPES.join(', ')}`
        );
      }

      // Validate required
      if (!('required' in paramObj)) {
        errors.push(`Parameter '${paramName}' is missing required 'required' field`);
      } else if (typeof paramObj.required !== 'boolean') {
        errors.push(`Parameter '${paramName}' required field must be a boolean`);
      }

      // Validate description (optional) - data is already normalized
      if (paramObj.description !== undefined) {
        if (typeof paramObj.description !== 'string') {
          warnings.push(`Parameter '${paramName}' description must be a string`);
        } else {
          const descResult = this.validationService.validateContent(paramObj.description, {
            maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH
          });
          if (!descResult.isValid) {
            warnings.push(`Parameter '${paramName}' description failed validation: ${descResult.detectedPatterns?.join(', ') || 'invalid content'}`);
          }
        }
      }

      // Validate default (optional) - data is already normalized
      if (paramObj.default !== undefined) {
        const defaultType = typeof paramObj.default;
        if (paramObj.type === 'string' && defaultType !== 'string') {
          warnings.push(`Parameter '${paramName}' default value type mismatch (expected string)`);
        } else if (paramObj.type === 'string' && defaultType === 'string') {
          // Validate string default values (already normalized)
          const defaultResult = this.validationService.validateContent(paramObj.default as string, {
            maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH
          });
          if (!defaultResult.isValid) {
            warnings.push(`Parameter '${paramName}' default value failed validation: ${defaultResult.detectedPatterns?.join(', ') || 'invalid content'}`);
          }
        } else if (paramObj.type === 'number' && defaultType !== 'number') {
          warnings.push(`Parameter '${paramName}' default value type mismatch (expected number)`);
        } else if (paramObj.type === 'boolean' && defaultType !== 'boolean') {
          warnings.push(`Parameter '${paramName}' default value type mismatch (expected boolean)`);
        }
      }
    }

    // Check template/parameter consistency
    // Warn if template has placeholders not defined in parameters
    for (const placeholder of templatePlaceholders) {
      if (!parameterNames.has(placeholder)) {
        warnings.push(
          `Template references parameter '{${placeholder}}' which is not defined in parameters array`
        );
      }
    }

    // Warn if parameters are defined but not used in template
    for (const paramName of parameterNames) {
      if (!templatePlaceholders.has(paramName)) {
        warnings.push(
          `Parameter '${paramName}' is defined but not used in template`
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Extract parameter placeholders from template
   * Finds all {parameterName} patterns
   */
  private extractTemplatePlaceholders(template: string): Set<string> {
    const placeholders = new Set<string>();
    const regex = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    let match;

    while ((match = regex.exec(template)) !== null) {
      placeholders.add(match[1]);
    }

    return placeholders;
  }

  /**
   * Validate V2.0 activates configuration (OPTIONAL)
   *
   * Must be an object where each property is a string array.
   * Supports: personas, skills, memories, templates, ensembles
   */
  private validateActivates(activates: unknown): ValidationResult {
    if (!activates || typeof activates !== 'object' || Array.isArray(activates)) {
      return ValidatorHelpers.fail(['Activates must be an object']);
    }

    const activatesObj = activates as Record<string, unknown>;
    const warnings: string[] = [];

    for (const [key, value] of Object.entries(activatesObj)) {
      // Check if key is a known element type (warning only)
      if (!VALID_ACTIVATES_TYPES.includes(key as any)) {
        warnings.push(
          `Unknown element type '${key}' in activates. Known types: ${VALID_ACTIVATES_TYPES.join(', ')}`
        );
      }

      // Validate value is string array
      if (!Array.isArray(value)) {
        return ValidatorHelpers.fail([`Activates.${key} must be an array of strings`]);
      }

      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
          return ValidatorHelpers.fail([`Activates.${key}[${i}] must be a string`]);
        }
        // Validate length and patterns (data is already normalized)
        const contentResult = this.validationService.validateContent(value[i], {
          maxLength: AGENT_LIMITS.MAX_AGENT_NAME_LENGTH
        });
        if (!contentResult.isValid) {
          return ValidatorHelpers.fail([`Activates.${key}[${i}] failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`]);
        }
        if (value[i].trim().length === 0) {
          warnings.push(`Activates.${key}[${i}] is empty`);
        }
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate V2.0 tools configuration (OPTIONAL)
   *
   * Must have:
   * - allowed (string[], required if tools defined)
   * - denied (string[], optional)
   */
  private validateTools(tools: unknown): ValidationResult {
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
      return ValidatorHelpers.fail(['Tools must be an object']);
    }

    const toolsObj = tools as Record<string, unknown>;
    const warnings: string[] = [];

    // Validate allowed (required)
    if (!toolsObj.allowed) {
      return ValidatorHelpers.fail(["Tools configuration must include 'allowed' array"]);
    }

    if (!Array.isArray(toolsObj.allowed)) {
      return ValidatorHelpers.fail(["Tools.allowed must be an array of strings"]);
    }

    const allowedSet = new Set<string>();
    for (let i = 0; i < toolsObj.allowed.length; i++) {
      const tool = toolsObj.allowed[i];
      if (typeof tool !== 'string') {
        return ValidatorHelpers.fail([`Tools.allowed[${i}] must be a string`]);
      }
      // Validate length and patterns (data is already normalized)
      const contentResult = this.validationService.validateContent(tool, {
        maxLength: AGENT_LIMITS.MAX_AGENT_NAME_LENGTH
      });
      if (!contentResult.isValid) {
        return ValidatorHelpers.fail([`Tools.allowed[${i}] failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`]);
      }
      if (tool.trim().length === 0) {
        warnings.push(`Tools.allowed[${i}] is empty`);
      }
      allowedSet.add(tool);
    }

    // Validate denied (optional)
    if (toolsObj.denied !== undefined) {
      if (!Array.isArray(toolsObj.denied)) {
        return ValidatorHelpers.fail(["Tools.denied must be an array of strings"]);
      }

      const deniedSet = new Set<string>();
      for (let i = 0; i < toolsObj.denied.length; i++) {
        const tool = toolsObj.denied[i];
        if (typeof tool !== 'string') {
          return ValidatorHelpers.fail([`Tools.denied[${i}] must be a string`]);
        }
        // Validate length and patterns (data is already normalized)
        const contentResult = this.validationService.validateContent(tool, {
          maxLength: AGENT_LIMITS.MAX_AGENT_NAME_LENGTH
        });
        if (!contentResult.isValid) {
          return ValidatorHelpers.fail([`Tools.denied[${i}] failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`]);
        }
        if (tool.trim().length === 0) {
          warnings.push(`Tools.denied[${i}] is empty`);
        }
        deniedSet.add(tool);
      }

      // Warn if same tool is in both allowed and denied
      for (const tool of deniedSet) {
        if (allowedSet.has(tool)) {
          warnings.push(
            `Tool '${tool}' appears in both allowed and denied lists. Denied takes precedence.`
          );
        }
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate V2.0 system prompt (OPTIONAL)
   *
   * Must be a string, length 1-10000 characters.
   * Uses validationService for content security.
   *
   * Architecture: Input is already normalized by GenericElementValidator.
   * This validator checks business rules (length, patterns) on normalized data.
   */
  private validateSystemPrompt(systemPrompt: unknown): ValidationResult {
    // Type check must happen first
    if (typeof systemPrompt !== 'string') {
      return ValidatorHelpers.fail(['System prompt must be a string']);
    }

    // Validate length and patterns (data is already normalized)
    const contentResult = this.validationService.validateContent(systemPrompt, {
      maxLength: SYSTEM_PROMPT_MAX_LENGTH
    });

    if (!contentResult.isValid) {
      return ValidatorHelpers.fail(
        contentResult.detectedPatterns || ['System prompt failed content validation']
      );
    }

    if (systemPrompt.length < SYSTEM_PROMPT_MIN_LENGTH) {
      return ValidatorHelpers.fail(['System prompt cannot be empty']);
    }

    const warnings: string[] = [];
    if (systemPrompt.length > 5000) {
      warnings.push('System prompt is very long - consider keeping it concise for better LLM performance');
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate V2.0 autonomy configuration (OPTIONAL)
   *
   * Fields:
   * - riskTolerance (enum)
   * - maxAutonomousSteps (positive integer, 0 = unlimited)
   * - requiresApproval (string[] glob patterns)
   * - autoApprove (string[] glob patterns)
   *
   * Also detects conflicts between requiresApproval and autoApprove.
   */
  private validateAutonomy(autonomy: unknown): ValidationResult {
    if (!autonomy || typeof autonomy !== 'object' || Array.isArray(autonomy)) {
      return ValidatorHelpers.fail(['Autonomy must be an object']);
    }

    const autonomyObj = autonomy as Record<string, unknown>;
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate riskTolerance (optional)
    if (autonomyObj.riskTolerance !== undefined) {
      const riskResult = this.validateRiskTolerance(autonomyObj.riskTolerance);
      if (!riskResult.isValid) {
        errors.push(...riskResult.errors);
      }
    }

    // Validate maxAutonomousSteps (optional)
    if (autonomyObj.maxAutonomousSteps !== undefined) {
      if (typeof autonomyObj.maxAutonomousSteps !== 'number') {
        errors.push('Autonomy.maxAutonomousSteps must be a number');
      } else if (autonomyObj.maxAutonomousSteps < 0) {
        errors.push('Autonomy.maxAutonomousSteps must be non-negative (0 = unlimited)');
      } else if (!Number.isInteger(autonomyObj.maxAutonomousSteps)) {
        errors.push('Autonomy.maxAutonomousSteps must be an integer');
      }
    }

    // Validate requiresApproval (optional) - data is already normalized
    const requiresApprovalSet = new Set<string>();
    if (autonomyObj.requiresApproval !== undefined) {
      if (!Array.isArray(autonomyObj.requiresApproval)) {
        errors.push('Autonomy.requiresApproval must be an array of strings');
      } else {
        for (let i = 0; i < autonomyObj.requiresApproval.length; i++) {
          const pattern = autonomyObj.requiresApproval[i];
          if (typeof pattern !== 'string') {
            errors.push(`Autonomy.requiresApproval[${i}] must be a string`);
          } else {
            const contentResult = this.validationService.validateContent(pattern, {
              maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH
            });
            if (!contentResult.isValid) {
              errors.push(`Autonomy.requiresApproval[${i}] failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`);
            } else {
              requiresApprovalSet.add(pattern);
            }
          }
        }
      }
    }

    // Validate autoApprove (optional) - data is already normalized
    const autoApproveSet = new Set<string>();
    if (autonomyObj.autoApprove !== undefined) {
      if (!Array.isArray(autonomyObj.autoApprove)) {
        errors.push('Autonomy.autoApprove must be an array of strings');
      } else {
        for (let i = 0; i < autonomyObj.autoApprove.length; i++) {
          const pattern = autonomyObj.autoApprove[i];
          if (typeof pattern !== 'string') {
            errors.push(`Autonomy.autoApprove[${i}] must be a string`);
          } else {
            const contentResult = this.validationService.validateContent(pattern, {
              maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH
            });
            if (!contentResult.isValid) {
              errors.push(`Autonomy.autoApprove[${i}] failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`);
            } else {
              autoApproveSet.add(pattern);
            }
          }
        }
      }
    }

    // Detect conflicts between requiresApproval and autoApprove (including glob pattern conflicts)
    if (requiresApprovalSet.size > 0 && autoApproveSet.size > 0) {
      const conflictMessages = findPatternConflicts(
        Array.from(requiresApprovalSet),
        Array.from(autoApproveSet)
      );
      for (const conflict of conflictMessages) {
        warnings.push(
          `${conflict}. requiresApproval takes precedence.`
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate V2.1 resilience configuration (OPTIONAL, nested under autonomy)
   *
   * Fields:
   * - onStepLimitReached ('pause' | 'continue' | 'restart')
   * - onExecutionFailure ('pause' | 'retry' | 'restart-fresh')
   * - maxRetries (non-negative integer, default 3)
   * - maxContinuations (non-negative integer, 0 = unlimited, default 10)
   * - retryBackoff ('none' | 'linear' | 'exponential')
   * - preserveState (boolean)
   *
   * @since v2.1.0 - Agent Execution Resilience (Issue #526)
   */
  private validateResilience(resilience: unknown): ValidationResult {
    if (!resilience || typeof resilience !== 'object' || Array.isArray(resilience)) {
      return ValidatorHelpers.fail(['Resilience must be an object']);
    }

    const obj = resilience as Record<string, unknown>;
    const errors: string[] = [];
    const warnings: string[] = [];

    // Issue #730: Use shared constants from constants.ts (single source of truth)
    if (obj.onStepLimitReached !== undefined) {
      if (!isOneOf(obj.onStepLimitReached, STEP_LIMIT_ACTIONS)) {
        errors.push(
          `Resilience.onStepLimitReached must be one of: ${STEP_LIMIT_ACTIONS.join(', ')}`
        );
      }
    }

    if (obj.onExecutionFailure !== undefined) {
      if (!isOneOf(obj.onExecutionFailure, EXECUTION_FAILURE_ACTIONS)) {
        errors.push(
          `Resilience.onExecutionFailure must be one of: ${EXECUTION_FAILURE_ACTIONS.join(', ')}`
        );
      }
    }

    if (obj.maxRetries !== undefined) {
      if (typeof obj.maxRetries !== 'number' || !Number.isInteger(obj.maxRetries) || obj.maxRetries < 0) {
        errors.push('Resilience.maxRetries must be a non-negative integer');
      }
    }

    if (obj.maxContinuations !== undefined) {
      if (typeof obj.maxContinuations !== 'number' || !Number.isInteger(obj.maxContinuations) || obj.maxContinuations < 0) {
        errors.push('Resilience.maxContinuations must be a non-negative integer');
      } else if (obj.maxContinuations === 0) {
        warnings.push('Resilience.maxContinuations=0 means unlimited auto-continuations. Consider setting a safety limit.');
      }
    }

    if (obj.retryBackoff !== undefined) {
      if (!isOneOf(obj.retryBackoff, BACKOFF_STRATEGIES)) {
        errors.push(
          `Resilience.retryBackoff must be one of: ${BACKOFF_STRATEGIES.join(', ')}`
        );
      }
    }

    if (obj.preserveState !== undefined) {
      if (typeof obj.preserveState !== 'boolean') {
        errors.push('Resilience.preserveState must be a boolean');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate V1.x decisionFramework (DEPRECATED)
   * Data is already normalized by GenericElementValidator
   */
  private validateDecisionFramework(framework: unknown): ValidationResult {
    if (typeof framework !== 'string') {
      return ValidatorHelpers.fail(['Decision framework must be a string']);
    }

    // Validate length and patterns (data is already normalized)
    const contentResult = this.validationService.validateContent(framework, {
      maxLength: AGENT_LIMITS.MAX_SPECIALIZATION_LENGTH
    });
    if (!contentResult.isValid) {
      return ValidatorHelpers.fail([
        `Decision framework failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`
      ]);
    }

    if (!DECISION_FRAMEWORKS.includes(framework as DecisionFramework)) {
      return ValidatorHelpers.fail([
        `Invalid decision framework '${framework}'. Valid options: ${DECISION_FRAMEWORKS.join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate V1.x specializations (DEPRECATED)
   * Data is already normalized by GenericElementValidator
   */
  private validateSpecializations(specializations: unknown): ValidationResult {
    if (!Array.isArray(specializations)) {
      return ValidatorHelpers.fail(['Specializations must be an array']);
    }

    for (let i = 0; i < specializations.length; i++) {
      if (typeof specializations[i] !== 'string') {
        return ValidatorHelpers.fail([`Specialization at index ${i} must be a string`]);
      }

      const spec = specializations[i] as string;

      // Validate length and patterns (data is already normalized)
      const contentResult = this.validationService.validateContent(spec, {
        maxLength: AGENT_LIMITS.MAX_SPECIALIZATION_LENGTH
      });

      if (!contentResult.isValid) {
        return ValidatorHelpers.fail([
          `Specialization at index ${i} failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`
        ]);
      }
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate riskTolerance enum
   * Used in both V1.x (deprecated) and V2.0 autonomy config
   * Data is already normalized by GenericElementValidator
   */
  private validateRiskTolerance(riskTolerance: unknown): ValidationResult {
    if (typeof riskTolerance !== 'string') {
      return ValidatorHelpers.fail(['Risk tolerance must be a string']);
    }

    // Validate length and patterns (data is already normalized)
    const contentResult = this.validationService.validateContent(riskTolerance, {
      maxLength: AGENT_LIMITS.MAX_SPECIALIZATION_LENGTH
    });
    if (!contentResult.isValid) {
      return ValidatorHelpers.fail([
        `Risk tolerance failed validation: ${contentResult.detectedPatterns?.join(', ') || 'invalid content'}`
      ]);
    }

    if (!RISK_TOLERANCE_LEVELS.includes(riskTolerance as RiskTolerance)) {
      return ValidatorHelpers.fail([
        `Invalid risk tolerance '${riskTolerance}'. Valid options: ${RISK_TOLERANCE_LEVELS.join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate V1.x maxConcurrentGoals (DEPRECATED)
   */
  private validateMaxConcurrentGoals(maxConcurrentGoals: unknown): ValidationResult {
    if (typeof maxConcurrentGoals !== 'number') {
      return ValidatorHelpers.fail(['Max concurrent goals must be a number']);
    }

    if (!Number.isInteger(maxConcurrentGoals)) {
      return ValidatorHelpers.fail(['Max concurrent goals must be an integer']);
    }

    if (maxConcurrentGoals < 1 || maxConcurrentGoals > 100) {
      return ValidatorHelpers.fail(['Max concurrent goals must be between 1 and 100']);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Check if an agent appears to be V1.x format
   * V1 agents have decisionFramework or specializations but no goal config
   */
  private isV1Agent(record: Record<string, unknown>): boolean {
    const hasV1Fields = (
      record.decisionFramework !== undefined ||
      record.specializations !== undefined ||
      record.ruleEngineConfig !== undefined
    );

    const hasV2Goal = record.goal !== undefined;

    return hasV1Fields && !hasV2Goal;
  }
}
