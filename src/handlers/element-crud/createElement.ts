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
  formatElementResolutionWarnings
} from './helpers.js';
import { resolveElementTypes } from '../../utils/elementTypeResolver.js';
import { ElementCrudContext } from './types.js';
import { logger } from '../../utils/logger.js';
import { getGatekeeperAuthoringErrors } from '../mcp-aql/policies/ElementPolicies.js';
// FIX: Issue #281 - SecurityMonitor import removed, persona logging now in PersonaManager.create()
import {
  formatSimpleErrorResponse,
  formatDuplicateError,
  formatExceptionError
} from './responseFormatter.js';
import type { McpToolResponse } from './responseFormatter.js';
import type { EnsembleElement } from '../../elements/ensembles/types.js';

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

    const validatedName = sanitizeInput(name, SECURITY_LIMITS.MAX_FILENAME_LENGTH);
    const validatedDescription = sanitizeInput(description, SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH);

    if (content) {
      try {
        validateContentSize(content, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `❌ Content too large: ${error.message}. Maximum allowed size is ${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters (${Math.floor(SECURITY_LIMITS.MAX_CONTENT_LENGTH / 1024)}KB).`
          }]
        };
      }
    }

    // Issue #602 resolved: Both 'instructions' and 'content' are first-class fields.
    // instructions = behavioral directives (command voice, "You ARE...", "ALWAYS...")
    // content = reference material (informational, domain knowledge, examples)
    if (instructions) {
      try {
        validateContentSize(instructions, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `❌ Instructions too large: ${error.message}. Maximum allowed size is ${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters.`
          }]
        };
      }
    }

    // Element-specific fields (ensemble elements, agent V2 fields) are merged into
    // metadata by the dispatcher (MCPAQLHandler). createElement just sanitizes and delegates.
    const sanitized = sanitizeMetadata(metadata);

    const topLevelGatekeeperErrors = getGatekeeperAuthoringErrors({ ...args });
    const metadataGatekeeperErrors = getGatekeeperAuthoringErrors(metadata as Record<string, unknown> | undefined);
    const gatekeeperErrors = [
      ...topLevelGatekeeperErrors,
      ...metadataGatekeeperErrors,
    ];
    if (gatekeeperErrors.length > 0) {
      const uniqueErrors = [...new Set(gatekeeperErrors)];
      const gatekeeperValidationMessage = [
        'Gatekeeper policy validation failed:',
        ...uniqueErrors.map(err => `  • ${err}`),
      ].join('\n');
      return formatSimpleErrorResponse(gatekeeperValidationMessage);
    }

    // Issue #621: Validate category format for element types that support it
    // Persona also supports categories (validated internally by PersonaManager) — include here for consistent early error reporting
    const CATEGORY_TYPES = new Set([ElementType.PERSONA, ElementType.SKILL, ElementType.TEMPLATE, ElementType.MEMORY]);
    if (sanitized.category && CATEGORY_TYPES.has(normalizedType)) {
      try {
        validateCategory(sanitized.category as string);
      } catch (categoryError: any) {
        return formatSimpleErrorResponse(
          `Invalid category '${sanitized.category}': ${categoryError.message}`
        );
      }
    }

    // Detect unknown metadata properties and generate warnings for LLM feedback
    const unknownPropertyWarnings = detectUnknownMetadataProperties(
      normalizedType,
      metadata as Record<string, unknown>
    );
    const warningText = formatUnknownPropertyWarnings(unknownPropertyWarnings);

    // Log warnings for debugging with structured data for better observability
    if (unknownPropertyWarnings.length > 0) {
      logger.warn(`[createElement] Unknown metadata properties detected`, {
        elementType: normalizedType,
        elementName: name,
        warningCount: unknownPropertyWarnings.length,
        unknownProperties: unknownPropertyWarnings.map(w => ({
          property: w.property,
          suggestion: w.suggestion
        }))
      });
    }

    switch (normalizedType) {
      case ElementType.PERSONA: {
        try {
          // Issue #602: Both 'instructions' and 'content' are first-class fields.
          const persona = await context.personaManager.create({
            ...sanitized,
            name: validatedName,
            description: validatedDescription,
            instructions: instructions,
            content: content,
          });

          const successMsg = `${warningText}✅ Created persona '${persona.metadata.name}' successfully`;
          return { content: [{ type: "text", text: `${context.getPersonaIndicator()}${successMsg}` }] };
        } catch (personaError) {
          const message = personaError instanceof Error ? personaError.message : String(personaError);
          if (message.includes('instructions are required')) {
            return formatSimpleErrorResponse(message);
          }
          const errorResponse = message.includes('already exists')
            ? formatDuplicateError(ElementType.PERSONA, validatedName)
            : formatExceptionError(personaError, 'create', ElementType.PERSONA, validatedName);
          return addPersonaIndicator(errorResponse, context.getPersonaIndicator());
        }
      }

      case ElementType.SKILL: {
        // FIX: Issue #20 - Catch duplicate errors from SkillManager
        try {
          const skill = await context.skillManager.create({
            name: validatedName,
            description: validatedDescription,
            ...sanitized,
            instructions: instructions,
            content: content || ''
          });
          const successMsg = `${warningText}✅ Created skill '${skill.metadata.name}' successfully`;
          return { content: [{ type: "text", text: `${context.getPersonaIndicator()}${successMsg}` }] };
        } catch (skillError) {
          // Check if it's a duplicate error
          const message = skillError instanceof Error ? skillError.message : String(skillError);
          const errorResponse = message.includes('already exists')
            ? formatDuplicateError(ElementType.SKILL, validatedName)
            : formatExceptionError(skillError, 'create', ElementType.SKILL, validatedName);
          return addPersonaIndicator(errorResponse, context.getPersonaIndicator());
        }
      }

      case ElementType.TEMPLATE: {
        // FIX: Issue #20 - Catch duplicate errors from TemplateManager
        try {
          const template = await context.templateManager.create({
            name: validatedName,
            description: validatedDescription,
            instructions: instructions,
            content: content || '',
            metadata: sanitized,
          });
          const successMsg = `${warningText}✅ Created template '${template.metadata.name}' successfully`;
          return { content: [{ type: "text", text: `${context.getPersonaIndicator()}${successMsg}` }] };
        } catch (templateError) {
          // Check if it's a duplicate error
          const message = templateError instanceof Error ? templateError.message : String(templateError);
          const errorResponse = message.includes('already exists')
            ? formatDuplicateError(ElementType.TEMPLATE, validatedName)
            : formatExceptionError(templateError, 'create', ElementType.TEMPLATE, validatedName);
          return addPersonaIndicator(errorResponse, context.getPersonaIndicator());
        }
      }

      case ElementType.AGENT: {
        // V2 fields are merged into metadata by the dispatcher (MCPAQLHandler).
        // Goal normalization (string→object) is handled by AgentManager.create().
        try {
          // Issue #722: v2 dual-field architecture — each field goes where it belongs.
          // AgentManager.create() 3rd param = behavioral directives (agent.instructions).
          // metadata.content = reference material (markdown body after frontmatter).
          const agentInstructions = instructions || '';
          const agentContent = content || '';
          const agent = await context.agentManager.create(
            validatedName,
            validatedDescription,
            agentInstructions,
            { ...sanitized, content: agentContent }
          );
          if (agent.success) {
            const baseMessage = agent.message && agent.message.toLowerCase().includes('created agent')
              ? agent.message
              : `Created agent '${validatedName}' successfully`;
            const successMsg = `${warningText}✅ ${baseMessage}`;
            return { content: [{ type: "text", text: `${context.getPersonaIndicator()}${successMsg}` }] };
          }
          // FIX: Issue #20 - Include "failed to create" in error message for test compatibility
          const failureReason = agent.message || 'Unknown error';
          return formatSimpleErrorResponse(`Failed to create agent: ${failureReason}`);
        } catch (agentError) {
          const message = agentError instanceof Error ? agentError.message : String(agentError);
          const errorResponse = message.includes('already exists')
            ? formatDuplicateError(ElementType.AGENT, validatedName)
            : formatExceptionError(agentError, 'create', ElementType.AGENT, validatedName);
          return addPersonaIndicator(errorResponse, context.getPersonaIndicator());
        }
      }

      case ElementType.MEMORY: {
        try {
          const memory = await context.memoryManager.create({
            ...sanitized,
            name: validatedName,
            description: validatedDescription,
            content: content,
            instructions: instructions,
          });
          const successMsg = `${warningText}✅ Created memory '${memory.metadata.name}' successfully`;
          return { content: [{ type: "text", text: `${context.getPersonaIndicator()}${successMsg}` }] };
        } catch (memoryError) {
          const message = memoryError instanceof Error ? memoryError.message : String(memoryError);
          const errorResponse = message.includes('already exists')
            ? formatDuplicateError(ElementType.MEMORY, validatedName)
            : formatExceptionError(memoryError, 'create', ElementType.MEMORY, validatedName);
          return addPersonaIndicator(errorResponse, context.getPersonaIndicator());
        }
      }

      case ElementType.ENSEMBLE: {
        try {
          // Issue #466: Resolve missing element_type via portfolio lookup before create
          const resolutionResult = await resolveElementTypes(
            sanitized.elements || [],
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
            ...sanitized,
            name: validatedName,
            description: validatedDescription,
            elements: resolutionResult.resolved,
            instructions: instructions,
            content: content,
          });
          const successMsg = `${warningText}${resolutionWarningText}✅ Created ensemble '${ensemble.metadata.name}' successfully`;
          return { content: [{ type: "text", text: `${context.getPersonaIndicator()}${successMsg}` }] };
        } catch (ensembleError) {
          const message = ensembleError instanceof Error ? ensembleError.message : String(ensembleError);
          const errorResponse = message.includes('already exists')
            ? formatDuplicateError(ElementType.ENSEMBLE, validatedName)
            : formatExceptionError(ensembleError, 'create', ElementType.ENSEMBLE, validatedName);
          return addPersonaIndicator(errorResponse, context.getPersonaIndicator());
        }
      }

      default:
        return {
          content: [{
            type: "text",
            text: `❌ Element type '${type}' is not yet supported for creation`
          }]
        };
    }
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
