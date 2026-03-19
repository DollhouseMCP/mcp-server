/**
 * PersonaActivationStrategy - Strategy for persona element activation
 *
 * Handles activation, deactivation, and status tracking for persona elements.
 * Uses the PersonaManager's unique API and PersonaIndicatorService for formatting.
 */

import { PersonaManager } from '../../persona/PersonaManager.js';
import { PersonaIndicatorService } from '../../services/PersonaIndicatorService.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { BaseActivationStrategy } from './BaseActivationStrategy.js';
import { ElementActivationStrategy, MCPResponse } from './ElementActivationStrategy.js';

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
    const instructions = persona.instructions?.trim() || persona.content?.trim() || 'No instructions provided.';
    const referenceContent = persona.instructions?.trim() ? persona.content?.trim() : '';

    let text = `${this.getPersonaIndicator()}Persona Activated: **${persona.metadata.name}**\n\n${persona.metadata.description}\n\n**Instructions:**\n${instructions}`;
    if (referenceContent) {
      text += `\n\n**Reference:**\n${referenceContent}`;
    }

    // Issue #642: Fail-safe warning for CLI restrictions
    const restrictionWarning = this.formatRestrictionWarning(persona.metadata as unknown as Record<string, unknown>);
    if (restrictionWarning) {
      text += restrictionWarning;
    }

    return {
      content: [{
        type: "text",
        text
      }]
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
  async deactivate(name: string): Promise<MCPResponse> {
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
      return {
        content: [{
          type: "text",
          text: `${indicator}❌ ${result.message}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: `${indicator}✅ ${result.message}`
      }]
    };
  }

  /**
   * Get all active personas
   * Issue #281: Updated to show all active personas (supports multiple)
   */
  async getActiveElements(): Promise<MCPResponse> {
    const activePersonas = this.personaManager.getActivePersonas();
    const indicator = this.getPersonaIndicator();

    if (activePersonas.length === 0) {
      return {
        content: [{
          type: "text",
          text: `${indicator}No personas are currently active.`
        }]
      };
    }

    const personaList = activePersonas.map(p =>
      `🔹 **${p.metadata.name}** (${p.unique_id})\n   ${p.metadata.description}\n   📁 ${p.metadata.category || 'general'} | 🎭 ${p.metadata.author || 'Unknown'}`
    ).join('\n\n');

    const header = activePersonas.length === 1
      ? `${indicator}Active Persona:`
      : `${indicator}Active Personas (${activePersonas.length}):`;

    let text = `${header}\n\n${personaList}`;

    // Issue #642: Restriction summary for active personas with externalRestrictions
    const restrictedPersonas = activePersonas.filter(
      p => (p.metadata as unknown as Record<string, unknown>)?.gatekeeper &&
        ((p.metadata as unknown as Record<string, unknown>).gatekeeper as Record<string, unknown>)?.externalRestrictions
    );
    if (restrictedPersonas.length > 0) {
      const summary = restrictedPersonas.map(p => {
        const gk = (p.metadata as unknown as Record<string, unknown>).gatekeeper as Record<string, unknown>;
        const r = gk.externalRestrictions as Record<string, unknown>;
        return `  **${p.metadata.name}**: ${r.description}`;
      }).join('\n');
      text += `\n\n**Active CLI Restrictions:**\n${summary}\n> Use \`get_effective_cli_policies\` for full details.`;
    }

    return {
      content: [{
        type: "text",
        text
      }]
    };
  }

  /**
   * Get detailed information about a persona
   * Extracted from ElementCRUDHandler.ts lines 620-648
   *
   * @throws {ElementNotFoundError} When persona does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async getElementDetails(name: string): Promise<MCPResponse> {
    const persona = this.personaManager.findPersona(name);
    const indicator = this.getPersonaIndicator();

    if (!persona) {
      throw new ElementNotFoundError('Persona', name);
    }

    const triggers = persona.metadata.triggers?.join(', ') || 'None';
    const content = persona.content?.trim() || 'No instructions provided.';

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
