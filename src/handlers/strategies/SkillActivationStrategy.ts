/**
 * SkillActivationStrategy - Strategy for skill element activation
 *
 * Handles activation, deactivation, and status tracking for skill elements.
 */

import { SkillManager } from '../../elements/skills/index.js';
import { BaseActivationStrategy } from './BaseActivationStrategy.js';
import { ElementActivationStrategy, MCPResponse } from './ElementActivationStrategy.js';

export class SkillActivationStrategy extends BaseActivationStrategy implements ElementActivationStrategy {
  constructor(private readonly skillManager: SkillManager) {
    super();
  }

  /**
   * Activate a skill
   * Extracted from ElementCRUDHandler.ts lines 184-206
   */
  async activate(name: string, context?: Record<string, any>): Promise<MCPResponse> {
    // Use the manager's activation method which tracks active skills
    const result = await this.skillManager.activateSkill(name);

    if (!result.success || !result.skill) {
      return this.createNotFoundResponse(name, 'Skill');
    }

    const skill = result.skill;

    // Build activation response with execution strategy information
    const parts = [
      `✅ Skill '${skill.metadata.name}' activated`,
      ''
    ];

    // Check if parameters were provided in activation context
    const hasContextParameters = context?.parameters && Object.keys(context.parameters).length > 0;

    if (hasContextParameters) {
      parts.push('Skill activates with specified parameters');
    } else {
      parts.push('Skill becomes active and ready for execution');
    }

    parts.push('');
    parts.push('**Instructions:**');
    parts.push(skill.instructions);

    if (skill.content?.trim()) {
      parts.push('');
      parts.push('**Reference:**');
      parts.push(skill.content);
    }

    // Issue #642: Fail-safe warning for CLI restrictions
    const restrictionWarning = this.formatRestrictionWarning(skill.metadata as unknown as Record<string, unknown>);
    if (restrictionWarning) {
      parts.push(restrictionWarning);
    }

    const gatekeeperWarning = this.formatGatekeeperValidityWarning(skill.metadata as unknown as Record<string, unknown>);
    if (gatekeeperWarning) {
      parts.push(gatekeeperWarning);
    }

    return {
      content: [{
        type: "text",
        text: parts.join('\n')
      }]
    };
  }

  /**
   * Deactivate a skill
   * Extracted from ElementCRUDHandler.ts lines 521-541
   *
   * @throws {ElementNotFoundError} When skill does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async deactivate(name: string): Promise<MCPResponse> {
    const result = await this.skillManager.deactivateSkill(name);

    if (!result.success) {
      this.throwNotFoundError(name, 'Skill');
    }

    return this.createSuccessResponse(result.message);
  }

  /**
   * Get all active skills
   * Extracted from ElementCRUDHandler.ts lines 392-412
   */
  async getActiveElements(): Promise<MCPResponse> {
    // Use the manager's method to get active skills directly
    const activeSkills = await this.skillManager.getActiveSkills();

    if (activeSkills.length === 0) {
      return {
        content: [{
          type: "text",
          text: "📋 No active skills"
        }]
      };
    }

    const skillList = activeSkills.map(s => `🛠️ ${s.metadata.name}`).join(', ');
    return {
      content: [{
        type: "text",
        text: `Active skills: ${skillList}`
      }]
    };
  }

  /**
   * Get detailed information about a skill
   * Extracted from ElementCRUDHandler.ts lines 650-689
   *
   * @throws {ElementNotFoundError} When skill does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async getElementDetails(name: string): Promise<MCPResponse> {
    // Use flexible finding to support both display name and filename
    const allSkills = await this.skillManager.list();
    const skill = await this.findElementFlexibly(name, allSkills);
    if (!skill) {
      this.throwNotFoundError(name, 'Skill');
    }

    const details = [
      `🛠️ **${skill.metadata.name}**`,
      `${skill.metadata.description}`,
      ``,
      `**Complexity**: ${skill.metadata.complexity || 'beginner'}`,
      `**Domains**: ${skill.metadata.domains?.join(', ') || 'general'}`,
      `**Languages**: ${skill.metadata.languages?.join(', ') || 'any'}`,
      `**Prerequisites**: ${skill.metadata.prerequisites?.join(', ') || 'none'}`,
      ``,
      `**Instructions**:`,
      skill.instructions
    ];

    if (skill.metadata.parameters && skill.metadata.parameters.length > 0) {
      details.push('', '**Parameters**:');
      skill.metadata.parameters.forEach((p: any) => {
        details.push(`- ${p.name} (${p.type}): ${p.description}`);
      });
    }

    return {
      content: [{
        type: "text",
        text: details.join('\n')
      }]
    };
  }
}
