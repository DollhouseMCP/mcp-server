/**
 * V1→V2 Agent Converter
 *
 * Provides automatic in-memory conversion from V1 agent format (legacy goals/constraints)
 * to V2 agent format (goal.template with parameters).
 *
 * UPGRADE STRATEGY:
 * - V1 agents are auto-upgraded to V2 in place when executed
 * - The original file is overwritten with the V2 format
 * - Conversion is triggered by executeAgent(), not by read() or edit()
 *
 * @since v2.0.0 - Agent V2 Infrastructure
 */

import type { AgentMetadata, AgentMetadataV2, AgentGoalConfig, AgentGoalParameter } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Result of V1→V2 conversion
 */
export interface ConversionResult {
  /** Whether conversion was successful */
  converted: boolean;
  /** The converted V2 metadata (partial, to be merged with existing) */
  metadata: Partial<AgentMetadataV2>;
  /** Warnings generated during conversion */
  warnings: string[];
}

/**
 * Check if an agent is a V1 agent (legacy format without goal.template)
 *
 * @param metadata - Agent metadata to check
 * @returns true if this is a V1 agent that needs conversion
 */
export function isV1Agent(metadata: AgentMetadata | AgentMetadataV2): boolean {
  const metadataV2 = metadata as AgentMetadataV2;

  // V2 agents have goal.template defined
  if (metadataV2.goal && typeof metadataV2.goal.template === 'string') {
    return false;
  }

  // V1 agents might have goals (array) or decision framework but no goal.template
  return true;
}

/**
 * Convert V1 agent metadata to V2 format
 *
 * Generates a goal.template from the agent's instructions and creates
 * a default parameter for the objective.
 *
 * @param metadata - V1 agent metadata
 * @param instructions - Agent instructions content (from extensions.instructions)
 * @returns Conversion result with V2 metadata
 */
export function convertV1ToV2(
  metadata: AgentMetadata,
  instructions: string
): ConversionResult {
  const warnings: string[] = [];

  // Don't convert if already V2
  if (!isV1Agent(metadata)) {
    return {
      converted: false,
      metadata: {},
      warnings: ['Agent is already V2 format, no conversion needed'],
    };
  }

  // Log deprecation warnings for V1 fields
  if (metadata.decisionFramework) {
    warnings.push(
      `V1 field 'decisionFramework' (${metadata.decisionFramework}) preserved but deprecated. V2 uses LLM-driven decisions.`
    );
  }
  if (metadata.ruleEngineConfig) {
    warnings.push(
      `V1 field 'ruleEngineConfig' preserved but deprecated. V2 constraints are handled by evaluateConstraints().`
    );
  }
  if (metadata.learningEnabled !== undefined) {
    warnings.push(
      `V1 field 'learningEnabled' preserved but deprecated. LLM handles learning naturally in V2.`
    );
  }

  // Generate goal template from instructions
  const goalTemplate = generateGoalTemplate(instructions, metadata.name);

  // Create default parameter for objective
  const defaultParameter: AgentGoalParameter = {
    name: 'objective',
    type: 'string',
    required: true,
    description: 'The specific objective or task to accomplish',
  };

  // Extract success criteria from instructions if present
  const successCriteria = extractSuccessCriteria(instructions, metadata.name);
  if (successCriteria.length === 0) {
    warnings.push(
      'No success criteria found in instructions. Consider adding explicit success criteria for better goal tracking.'
    );
  }

  // Build the goal configuration
  const goalConfig: AgentGoalConfig = {
    template: goalTemplate,
    parameters: [defaultParameter],
    successCriteria: successCriteria.length > 0 ? successCriteria : undefined,
  };

  // Build V2 metadata (preserving V1 fields for backward compatibility)
  const v2Metadata: Partial<AgentMetadataV2> = {
    goal: goalConfig,
    // Preserve V1 fields
    decisionFramework: metadata.decisionFramework,
    specializations: metadata.specializations,
    riskTolerance: metadata.riskTolerance,
    learningEnabled: metadata.learningEnabled,
    maxConcurrentGoals: metadata.maxConcurrentGoals,
    triggers: metadata.triggers,
  };

  logger.info(`V1→V2 conversion completed for agent '${metadata.name}': template="${goalConfig.template}"`, {
    agentName: metadata.name,
    warningCount: warnings.length,
    successCriteriaCount: successCriteria.length,
    goalTemplate: goalConfig.template,
  });

  return {
    converted: true,
    metadata: v2Metadata,
    warnings,
  };
}

/**
 * Generate a goal template from V1 instructions
 *
 * The template uses {objective} as the primary parameter placeholder.
 *
 * @param instructions - V1 agent instructions
 * @returns Goal template string
 */
function generateGoalTemplate(instructions: string, agentName: string): string {
  // If instructions are empty, use a generic template
  if (!instructions || instructions.trim().length === 0) {
    logger.debug(`V1→V2 goal template [${agentName}]: empty instructions, using generic "Execute: {objective}" template`);
    return 'Execute: {objective}';
  }

  // Check if instructions already contain a goal-like structure
  const goalMatch = instructions.match(/^#?\s*goal:?\s*(.+)$/im);
  if (goalMatch) {
    // Extract the goal line and make it parameterized
    const goalLine = goalMatch[1].trim();
    logger.debug(`V1→V2 goal template [${agentName}]: extracted goal header from instructions`, { goalLine });
    // Replace generic terms with parameter placeholder
    if (!goalLine.includes('{objective}')) {
      return `${goalLine}: {objective}`;
    }
    return goalLine;
  }

  // Check for a clear action statement in the first line
  const firstLine = instructions.split('\n')[0].trim();
  if (firstLine.length > 0 && firstLine.length <= 200) {
    logger.debug(`V1→V2 goal template [${agentName}]: using first line of instructions as goal context`, { firstLine: firstLine.slice(0, 80) });
    // Use first line as context, add objective parameter
    return `${firstLine} - Objective: {objective}`;
  }

  // Default: generic template
  logger.debug(`V1→V2 goal template [${agentName}]: no extractable goal pattern found (first line too long or empty), using generic template`, { instructionLength: instructions.length, preview: instructions.slice(0, 100) });
  return 'Execute the following objective: {objective}';
}

/**
 * Extract success criteria from V1 instructions
 *
 * Looks for common patterns:
 * - "Success criteria:" followed by list
 * - "Completed when:" statements
 * - "Goals:" with list items
 *
 * @param instructions - V1 agent instructions
 * @returns Array of success criteria strings
 */
function extractSuccessCriteria(instructions: string, agentName: string): string[] {
  const criteria: string[] = [];

  // Look for "Success criteria:" section
  const successMatch = instructions.match(/success\s+criteria:?\s*\n((?:[-*]\s*.+\n?)+)/im);
  if (successMatch) {
    const items = successMatch[1].match(/[-*]\s*(.+)/g);
    if (items) {
      for (const item of items) {
        const text = item.replace(/^[-*]\s*/, '').trim();
        if (text.length > 0) {
          criteria.push(text);
        }
      }
    }
  }

  // Look for "Completed when:" statements
  const completedMatch = instructions.match(/completed?\s+when:?\s*(.+)/gi);
  if (completedMatch) {
    for (const match of completedMatch) {
      const text = match.replace(/completed?\s+when:?\s*/i, '').trim();
      if (text.length > 0 && !criteria.includes(text)) {
        criteria.push(text);
      }
    }
  }

  // Look for numbered goals
  const numberedGoals = instructions.match(/^\d+\.\s+(.+)$/gm);
  if (numberedGoals && criteria.length === 0) {
    // Only use numbered items if we haven't found other criteria
    for (const goal of numberedGoals.slice(0, 5)) {
      // Limit to first 5
      const text = goal.replace(/^\d+\.\s+/, '').trim();
      if (text.length > 0) {
        criteria.push(text);
      }
    }
  }

  if (criteria.length === 0) {
    logger.debug(`V1→V2 success criteria [${agentName}]: no patterns found (checked: 'Success criteria:' section, 'Completed when:' statements, numbered items)`, { instructionLength: instructions.length });
  } else {
    logger.debug(`V1→V2 success criteria [${agentName}]: extracted ${criteria.length} criteria from instructions`, { criteria });
  }

  return criteria;
}

