/**
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This file delegates element creation to specialized managers.
 * Audit logging happens in the managers themselves (PersonaManager, SkillManager, etc.).
 * @security-audit-suppress DMCP-SEC-006
 */

import { ElementType } from '../../portfolio/PortfolioManager.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { sanitizeInput, validateContentSize, validateCategory } from '../../security/InputValidator.js';
import {
  sanitizeMetadata,
  normalizeElementTypeInput,
  formatValidElementTypesList,
  detectUnknownMetadataProperties,
  formatUnknownPropertyWarnings,
  formatElementResolutionWarnings,
  collectGatekeeperAuthoringErrors,
  findOversizedDescriptionFields,
  formatGatekeeperValidationMessage,
} from './helpers.js';
import { resolveElementTypes } from '../../utils/elementTypeResolver.js';
import type { ElementCrudContext } from './types.js';
import { logger } from '../../utils/logger.js';
// FIX: Issue #281 - SecurityMonitor import removed, persona logging now in PersonaManager.create()
import {
  formatSimpleErrorResponse,
  formatDuplicateError,
  formatExceptionError
} from './responseFormatter.js';
import type { McpToolResponse } from './responseFormatter.js';
import type { EnsembleElement } from '../../elements/ensembles/types.js';

const DUPLICATE_ELEMENT_ERROR_FRAGMENT = 'already exists';
const CATEGORY_TYPES = new Set([
  ElementType.PERSONA,
  ElementType.SKILL,
  ElementType.TEMPLATE,
  ElementType.MEMORY,
]);

/**
 * Arguments for creating a new element.
 *
 * @example
 * // Create a persona
 * { name: 'helper', type: 'persona', description: 'A helpful assistant', instructions: 'Be helpful' }
 *
 * @example
 * // Create an ensemble with elements
 * {
 *   name: 'my-ensemble',
 *   type: 'ensemble',
 *   description: 'A coordinated group',
 *   elements: [{ name: 'skill1', type: 'skill', role: 'primary', priority: 100, activation: 'always' }]
 * }
 *
 * @example
 * // Create a V2 agent with goal configuration
 * {
 *   name: 'task-runner',
 *   type: 'agent',
 *   description: 'Executes tasks autonomously',
 *   goal: {
 *     template: 'Complete the following task: {objective}',
 *     parameters: [{ name: 'objective', type: 'string', required: true }],
 *     successCriteria: ['Task completed successfully', 'Results documented']
 *   },
 *   activates: { skills: ['code-review'], personas: ['developer'] }
 * }
 */
export interface CreateElementArgs {
  name: string;
  type: string;
  description: string;
  /** Reference material, knowledge, context (informational). For templates: template body. */
  content?: string;
  /** Behavioral directives (command voice). For personas: behavioral profile. For skills: how to apply. For agents: agent behavioral protocol. */
  instructions?: string;
  metadata?: Record<string, unknown>;
  /**
   * For ensembles - array of element references.
   * Issue #278: LLMs often pass elements at top level, not inside metadata.
   */
  elements?: EnsembleElement[];

  // V2 Agent fields (can also be passed in metadata)
  /**
   * For V2 agents - goal configuration with template and parameters.
   * Can be passed as a simple string (will be converted to V2 format)
   * or as a full V2 config object.
   *
   * @since v2.0.0 - Agent V2 Infrastructure
   *
   * @example
   * // Simple string goal (auto-converted to V2 format)
   * goal: 'Complete the analysis task'
   *
   * @example
   * // Full V2 config with parameters
   * goal: {
   *   template: 'Analyze {target} for {purpose}',
   *   parameters: [
   *     { name: 'target', type: 'string', required: true },
   *     { name: 'purpose', type: 'string', required: true }
   *   ],
   *   successCriteria: ['Analysis complete', 'Report generated']
   * }
   */
  goal?: string | {
    template: string;
    parameters?: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean';
      required: boolean;
      description?: string;
      default?: string | number | boolean;
    }>;
    successCriteria?: string[];
  };
  /**
   * For V2 agents - elements to activate when agent executes.
   * @since v2.0.0 - Agent V2 Infrastructure
   */
  activates?: {
    personas?: string[];
    skills?: string[];
    memories?: string[];
    templates?: string[];
    ensembles?: string[];
    [key: string]: string[] | undefined;
  };
  /**
   * For V2 agents - tool configuration (informational).
   * @since v2.0.0 - Agent V2 Infrastructure
   */
  tools?: {
    allowed: string[];
    denied?: string[];
  };
  /**
   * For V2 agents - custom system prompt for LLM context.
   * @since v2.0.0 - Agent V2 Infrastructure
   */
  systemPrompt?: string;
}

/**
 * Helper to add persona indicator prefix to response
 */
function addPersonaIndicator(response: McpToolResponse, indicator: string) {
  return {
    ...response,
    content: response.content.map(c => ({
      ...c,
      text: `${indicator}${c.text}`
    }))
  };
}

interface ValidatedCreateInput {
  validatedName: string;
  validatedDescription: string;
  content?: string;
  instructions?: string;
  sanitized: Record<string, any>;
  warningText: string;
}

function formatCreatedResponse(
  context: ElementCrudContext,
  warningText: string,
  successMessage: string
): McpToolResponse {
  return {
    content: [{
      type: 'text',
      text: `${context.getPersonaIndicator()}${warningText}✅ ${successMessage}`,
    }],
  };
}

function formatCreateError(
  context: ElementCrudContext,
  error: unknown,
  elementType: ElementType,
  name: string
): McpToolResponse {
  const message = error instanceof Error ? error.message : String(error);
  const errorResponse = message.includes(DUPLICATE_ELEMENT_ERROR_FRAGMENT)
    ? formatDuplicateError(elementType, name)
    : formatExceptionError(error, 'create', elementType, name);
  return addPersonaIndicator(errorResponse, context.getPersonaIndicator());
}

function validateCreateTextSize(
  value: string | undefined,
  label: 'Content' | 'Instructions'
): McpToolResponse | undefined {
  if (!value) {
    return undefined;
  }
  try {
    validateContentSize(value, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const maximum = label === 'Content'
      ? `${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters (${Math.floor(SECURITY_LIMITS.MAX_CONTENT_LENGTH / 1024)}KB)`
      : `${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters`;
    return {
      content: [{
        type: 'text',
        text: `❌ ${label} too large: ${message}. Maximum allowed size is ${maximum}.`,
      }],
    };
  }
}

function validateCreateTextFields(
  content: string | undefined,
  instructions: string | undefined
): McpToolResponse | undefined {
  return validateCreateTextSize(content, 'Content')
    ?? validateCreateTextSize(instructions, 'Instructions');
}

function validateCreateCategory(
  category: unknown,
  normalizedType: ElementType
): McpToolResponse | undefined {
  if (!category || !CATEGORY_TYPES.has(normalizedType)) {
    return undefined;
  }
  try {
    validateCategory(category as string);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatSimpleErrorResponse(`Invalid category '${formatCategoryValue(category)}': ${message}`);
  }
}

function formatCategoryValue(category: unknown): string {
  if (typeof category === 'string') {
    return category;
  }
  if (category === null) {
    return 'null';
  }
  if (typeof category === 'number' || typeof category === 'boolean' || typeof category === 'bigint') {
    return category.toString();
  }
  if (category === undefined || typeof category === 'function') {
    return typeof category;
  }
  if (typeof category === 'symbol') {
    return category.description ? `Symbol(${category.description})` : 'Symbol';
  }
  try {
    return JSON.stringify(category) || 'object';
  } catch {
    return 'object';
  }
}

function logUnknownCreateMetadata(
  normalizedType: ElementType,
  name: string,
  unknownPropertyWarnings: ReturnType<typeof detectUnknownMetadataProperties>
): void {
  if (unknownPropertyWarnings.length === 0) {
    return;
  }
  logger.warn('[createElement] Unknown metadata properties detected', {
    elementType: normalizedType,
    elementName: name,
    warningCount: unknownPropertyWarnings.length,
    unknownProperties: unknownPropertyWarnings.map(warning => ({
      property: warning.property,
      suggestion: warning.suggestion,
    })),
  });
}

async function createPersona(
  context: ElementCrudContext,
  input: ValidatedCreateInput
): Promise<McpToolResponse> {
  try {
    const persona = await context.personaManager.create({
      ...input.sanitized,
      name: input.validatedName,
      description: input.validatedDescription,
      instructions: input.instructions,
      content: input.content,
    });
    return formatCreatedResponse(
      context,
      input.warningText,
      `Created persona '${persona.metadata.name}' successfully`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('instructions are required')) {
      return formatSimpleErrorResponse(message);
    }
    return formatCreateError(context, error, ElementType.PERSONA, input.validatedName);
  }
}

async function createSkill(
  context: ElementCrudContext,
  input: ValidatedCreateInput
): Promise<McpToolResponse> {
  try {
    const skill = await context.skillManager.create({
      name: input.validatedName,
      description: input.validatedDescription,
      ...input.sanitized,
      instructions: input.instructions,
      content: input.content || '',
    });
    return formatCreatedResponse(
      context,
      input.warningText,
      `Created skill '${skill.metadata.name}' successfully`
    );
  } catch (error) {
    return formatCreateError(context, error, ElementType.SKILL, input.validatedName);
  }
}

async function createTemplate(
  context: ElementCrudContext,
  input: ValidatedCreateInput
): Promise<McpToolResponse> {
  try {
    const template = await context.templateManager.create({
      name: input.validatedName,
      description: input.validatedDescription,
      instructions: input.instructions,
      content: input.content || '',
      metadata: input.sanitized,
    });
    return formatCreatedResponse(
      context,
      input.warningText,
      `Created template '${template.metadata.name}' successfully`
    );
  } catch (error) {
    return formatCreateError(context, error, ElementType.TEMPLATE, input.validatedName);
  }
}

async function createAgent(
  context: ElementCrudContext,
  input: ValidatedCreateInput
): Promise<McpToolResponse> {
  try {
    const agent = await context.agentManager.create(
      input.validatedName,
      input.validatedDescription,
      input.instructions || '',
      { ...input.sanitized, content: input.content || '' }
    );
    if (!agent.success) {
      const failureReason = agent.message || 'Unknown error';
      return formatSimpleErrorResponse(`Failed to create agent: ${failureReason}`);
    }
    const baseMessage = agent.message.toLowerCase().includes('created agent')
      ? agent.message
      : `Created agent '${input.validatedName}' successfully`;
    return formatCreatedResponse(context, input.warningText, baseMessage);
  } catch (error) {
    return formatCreateError(context, error, ElementType.AGENT, input.validatedName);
  }
}

async function createMemory(
  context: ElementCrudContext,
  input: ValidatedCreateInput
): Promise<McpToolResponse> {
  try {
    const memory = await context.memoryManager.create({
      ...input.sanitized,
      name: input.validatedName,
      description: input.validatedDescription,
      content: input.content,
      instructions: input.instructions,
    });
    return formatCreatedResponse(
      context,
      input.warningText,
      `Created memory '${memory.metadata.name}' successfully`
    );
  } catch (error) {
    return formatCreateError(context, error, ElementType.MEMORY, input.validatedName);
  }
}

async function createEnsemble(
  context: ElementCrudContext,
  input: ValidatedCreateInput
): Promise<McpToolResponse> {
  try {
    const resolutionResult = await resolveElementTypes(
      input.sanitized.elements || [],
      {
        skillManager: context.skillManager,
        templateManager: context.templateManager,
        agentManager: context.agentManager,
        memoryManager: context.memoryManager,
        personaManager: context.personaManager,
        ensembleManager: context.ensembleManager,
      }
    );
    const resolutionWarningText = formatElementResolutionWarnings(resolutionResult);
    const ensemble = await context.ensembleManager.create({
      ...input.sanitized,
      name: input.validatedName,
      description: input.validatedDescription,
      elements: resolutionResult.resolved,
      instructions: input.instructions,
      content: input.content,
    });
    return formatCreatedResponse(
      context,
      `${input.warningText}${resolutionWarningText}`,
      `Created ensemble '${ensemble.metadata.name}' successfully`
    );
  } catch (error) {
    return formatCreateError(context, error, ElementType.ENSEMBLE, input.validatedName);
  }
}

function createNormalizedElement(
  context: ElementCrudContext,
  normalizedType: ElementType,
  input: ValidatedCreateInput,
  originalType: string
): Promise<McpToolResponse> | McpToolResponse {
  switch (normalizedType) {
    case ElementType.PERSONA:
      return createPersona(context, input);
    case ElementType.SKILL:
      return createSkill(context, input);
    case ElementType.TEMPLATE:
      return createTemplate(context, input);
    case ElementType.AGENT:
      return createAgent(context, input);
    case ElementType.MEMORY:
      return createMemory(context, input);
    case ElementType.ENSEMBLE:
      return createEnsemble(context, input);
    default:
      return {
        content: [{
          type: 'text',
          text: `❌ Element type '${originalType}' is not yet supported for creation`,
        }],
      };
  }
}

export async function createElement(context: ElementCrudContext, args: CreateElementArgs) {
  await context.ensureInitialized();

  try {
    const { name, type, description, content, instructions, metadata } = args;

    const { type: normalizedType } = normalizeElementTypeInput(type);

    if (!normalizedType) {
      return {
        content: [{
          type: "text",
          text: `❌ Invalid element type '${type}'. Valid types: ${formatValidElementTypesList()}`
        }]
      };
    }

    const descriptionLengthErrors = findOversizedDescriptionFields({ description, metadata });
    if (descriptionLengthErrors.length > 0) {
      const formattedErrors = descriptionLengthErrors.map(error => `  • ${error}`).join('\n');
      return {
        content: [{
          type: "text",
          text: `❌ Description too large:\n${formattedErrors}`
        }]
      };
    }

    const validatedName = sanitizeInput(name, SECURITY_LIMITS.MAX_FILENAME_LENGTH);
    const validatedDescription = sanitizeInput(description, SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH);

    const textSizeError = validateCreateTextFields(content, instructions);
    if (textSizeError) {
      return textSizeError;
    }

    // Element-specific fields (ensemble elements, agent V2 fields) are merged into
    // metadata by the dispatcher (MCPAQLHandler). createElement just sanitizes and delegates.
    const sanitized = sanitizeMetadata(metadata);

    const gatekeeperErrors = collectGatekeeperAuthoringErrors({ ...args }, sanitized);
    if (gatekeeperErrors.length > 0) {
      return formatSimpleErrorResponse(formatGatekeeperValidationMessage(gatekeeperErrors));
    }

    const categoryError = validateCreateCategory(sanitized.category, normalizedType);
    if (categoryError) {
      return categoryError;
    }

    // Detect unknown metadata properties and generate warnings for LLM feedback
    const unknownPropertyWarnings = detectUnknownMetadataProperties(
      normalizedType,
      metadata as Record<string, unknown>
    );
    const warningText = formatUnknownPropertyWarnings(unknownPropertyWarnings);

    logUnknownCreateMetadata(normalizedType, name, unknownPropertyWarnings);
    return await createNormalizedElement(context, normalizedType, {
      validatedName,
      validatedDescription,
      content,
      instructions,
      sanitized,
      warningText,
    }, type);
  } catch (error) {
    logger.error('ElementCRUDHandler.createElement', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const indicator = context.getPersonaIndicator();
    return {
      content: [{
        type: "text",
        text: `${indicator}❌ Failed to create element: ${message}`
      }]
    };
  }
}
