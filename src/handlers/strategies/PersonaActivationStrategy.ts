/**
 * PersonaActivationStrategy - Strategy for persona element activation
 *
 * Handles activation, deactivation, and status tracking for persona elements.
 * Uses the PersonaManager's unique API and PersonaIndicatorService for formatting.
 */

import type { PersonaManager } from '../../persona/PersonaManager.js';
import type { PersonaIndicatorService } from '../../services/PersonaIndicatorService.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { BaseActivationStrategy } from './BaseActivationStrategy.js';
import type { ElementActivationStrategy, MCPResponse } from './ElementActivationStrategy.js';

export class PersonaActivationStrategy extends BaseActivationStrategy implements ElementActivationStrategy {
  constructor(
    private readonly personaManager: PersonaManager,
    private readonly indicatorService: PersonaIndicatorService
  ) {
    super();
  }

  /**
   * Get the persona indicator prefix
   */
  private getPersonaIndicator(): string {
    return this.indicatorService.getPersonaIndicator();
  }

  /**
   * Activate a persona
   * Extracted from ElementCRUDHandler.ts lines 161-182
   */
  async activate(name: string): Promise<MCPResponse> {
    const result = await this.personaManager.activatePersona(name);

    if (!result.success || !result.persona) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ ${result.message}`
        }]
      };
    }

    const persona = result.persona;
    const trimmedInstructions = persona.instructions.trim();
    const trimmedContent = persona.content.trim();
    const instructions = trimmedInstructions || trimmedContent || 'No instructions provided.';
    const referenceContent = trimmedInstructions ? trimmedContent : '';

    let text = `${this.getPersonaIndicator()}Persona Activated: **${persona.metadata.name}**\n\n${persona.metadata.description}\n\n**Instructions:**\n${instructions}`;
    if (referenceContent) {
      text += `\n\n**Reference:**\n${referenceContent}`;
    }

    // Issue #642: Fail-safe warning for CLI restrictions
    const restrictionWarning = this.formatRestrictionWarning(persona.metadata as unknown as Record<string, unknown>);
    if (restrictionWarning) {
      text += restrictionWarning;
    }

    const gatekeeperWarning = this.formatGatekeeperValidityWarning(persona.metadata as unknown as Record<string, unknown>);
    if (gatekeeperWarning) {
      text += gatekeeperWarning;
    }

    return {
      content: [{
        type: "text",
        text
      }],
      activationRecord: {
        name: persona.metadata.name,
        filename: persona.filename,
      },
    };
  }

  /**
   * Deactivate a specific persona
   * Issue #281: Updated to support multiple active personas
   *
   * @throws {ElementNotFoundError} When named persona does not exist
   * @throws {Error} When name parameter is missing
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  deactivate(name: string): Promise<MCPResponse> {
    try {
    // Issue #275: Require name parameter for consistent error handling
    if (!name || name === '') {
      throw new Error('Name parameter is required for deactivate operation');
    }

    // Issue #275: Verify the named persona exists before deactivating
    const persona = this.personaManager.findPersona(name);
    if (!persona) {
      throw new ElementNotFoundError('Persona', name);
    }

    // Issue #281: Pass the name to deactivate the specific persona
    const result = this.personaManager.deactivatePersona(name);
    const indicator = this.getPersonaIndicator();

    if (!result.success) {
      return Promise.resolve({
        content: [{
          type: "text",
          text: `${indicator}❌ ${result.message}`
        }]
      });
    }

    return Promise.resolve({
      content: [{
        type: "text",
        text: `${indicator}✅ ${result.message}`
      }],
      activationRecord: {
        name: persona.metadata.name,
        filename: persona.filename,
      },
    });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Get all active personas
   * Issue #281: Updated to show all active personas (supports multiple)
   */
  getActiveElements(): Promise<MCPResponse> {
    try {
    const activePersonas = this.personaManager.getActivePersonas();
    const indicator = this.getPersonaIndicator();

    if (activePersonas.length === 0) {
      return Promise.resolve({
        content: [{
          type: "text",
          text: `${indicator}No personas are currently active.`
        }]
      });
    }

    const personaList = activePersonas.map(p =>
      `🔹 **${p.metadata.name}** (${p.unique_id})\n   ${p.metadata.description}\n   📁 ${p.metadata.category || 'general'} | 🎭 ${p.metadata.author || 'Unknown'}`
    ).join('\n\n');

    const header = activePersonas.length === 1
      ? `${indicator}Active Persona:`
      : `${indicator}Active Personas (${activePersonas.length}):`;

    let text = `${header}\n\n${personaList}`;

    // Issue #642: Restriction summary for active personas with externalRestrictions
    const restrictionSummaries = activePersonas.flatMap(p => {
      const restrictions = p.metadata.gatekeeper?.externalRestrictions;
      return restrictions ? [`  **${p.metadata.name}**: ${restrictions.description}`] : [];
    });
    if (restrictionSummaries.length > 0) {
      const summary = restrictionSummaries.join('\n');
      text += `\n\n**Loaded CLI Restrictions:**\n${summary}\n> Use \`get_effective_cli_policies\` for full details.`;
    }

    return Promise.resolve({
      content: [{
        type: "text",
        text
      }]
    });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Get detailed information about a persona
   * Extracted from ElementCRUDHandler.ts lines 620-648
   *
   * @throws {ElementNotFoundError} When persona does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async getElementDetails(name: string): Promise<MCPResponse> {
    const persona = await this.personaManager.findPersonaAsync(name);
    const indicator = this.getPersonaIndicator();

    if (!persona) {
      throw new ElementNotFoundError('Persona', name);
    }

    const triggers = persona.metadata.triggers?.join(', ') || 'None';
    const content = persona.content.trim() || 'No instructions provided.';

    return {
      content: [{
        type: "text",
        text: `${indicator}📋 **${persona.metadata.name}** Details\n\n` +
          `**Description:** ${persona.metadata.description}\n` +
          `**File:** ${persona.filename}\n` +
          `**Version:** ${persona.metadata.version || '1.0'}\n` +
          `**Author:** ${persona.metadata.author || 'Unknown'}\n` +
          `**Triggers:** ${triggers}\n\n` +
          `**Full Instructions:**\n\`\`\`\n${content}\n\`\`\``
      }]
    };
  }
}
