/**
 * EnsembleActivationStrategy - Strategy for ensemble element activation
 *
 * Handles activation, deactivation, and status tracking for ensemble elements.
 * Ensembles coordinate multiple elements and require all managers for activation.
 */

import { EnsembleManager } from '../../elements/ensembles/EnsembleManager.js';
import { SkillManager } from '../../elements/skills/index.js';
import { TemplateManager } from '../../elements/templates/TemplateManager.js';
import { AgentManager } from '../../elements/agents/AgentManager.js';
import { MemoryManager } from '../../elements/memories/MemoryManager.js';
import { PersonaManager } from '../../persona/PersonaManager.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { BaseActivationStrategy } from './BaseActivationStrategy.js';
import { ElementActivationStrategy, MCPResponse } from './ElementActivationStrategy.js';
import type { Ensemble } from '../../elements/ensembles/Ensemble.js';
import type { ElementManagers, EnsembleElement } from '../../elements/ensembles/types.js';

export class EnsembleActivationStrategy extends BaseActivationStrategy implements ElementActivationStrategy {
  constructor(
    private readonly ensembleManager: EnsembleManager,
    private readonly portfolioManager: PortfolioManager,
    private readonly skillManager: SkillManager,
    private readonly templateManager: TemplateManager,
    private readonly agentManager: AgentManager,
    private readonly memoryManager: MemoryManager,
    private readonly personaManager: PersonaManager
  ) {
    super();
  }

  /**
   * Activate an ensemble with all its constituent elements
   * Extracted from ElementCRUDHandler.ts lines 281-345
   */
  async activate(name: string): Promise<MCPResponse> {
    // Activate via manager (which handles name tracking)
    const activationResult = await this.ensembleManager.activateEnsemble(name);

    if (!activationResult.success) {
      return this.createNotFoundResponse(name, 'Ensemble');
    }

    const ensemble = activationResult.ensemble!;

    // Activate the ensemble with all managers (orchestration)
    try {
      const result = await ensemble.activateEnsemble(this.portfolioManager, this.getManagers());

      const statusEmoji = result.success ? '✅' : '⚠️';
      const details = [
        `${statusEmoji} Ensemble '${ensemble.metadata.name}' activated`,
        ``,
        `**Strategy**: ${ensemble.metadata.activationStrategy}`,
        `**Activated**: ${result.activatedElements.length} elements`,
        `**Failed**: ${result.failedElements.length} elements`,
        `**Duration**: ${result.totalDuration}ms`,
      ];

      if (result.activatedElements.length > 0) {
        details.push(``, `**Active Elements**:`);
        result.activatedElements.forEach((elem: string) => {
          details.push(`  - ${elem}`);
        });
      }

      if (result.failedElements.length > 0) {
        details.push(``, `**Failed Elements**:`);
        result.failedElements.forEach((elem: string) => {
          const elementResult = result.elementResults.find((r: any) => r.elementName === elem && !r.success);
          const errorMsg = elementResult?.error?.message || 'Unknown error';
          details.push(`  - ${elem}: ${errorMsg}`);
        });
      }

      // Issue #642: Fail-safe warning for CLI restrictions
      const restrictionWarning = this.formatRestrictionWarning(ensemble.metadata as unknown as Record<string, unknown>);
      if (restrictionWarning) {
        details.push(restrictionWarning);
      }

      const gatekeeperWarning = this.formatGatekeeperValidityWarning(ensemble.metadata as unknown as Record<string, unknown>);
      if (gatekeeperWarning) {
        details.push(gatekeeperWarning);
      }

      return {
        content: [{
          type: "text",
          text: details.join('\n')
        }]
      };
    } catch (activationError) {
      return {
        content: [{
          type: "text",
          text: `❌ Failed to activate ensemble: ${activationError instanceof Error ? activationError.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Deactivate an ensemble
   * NOTE: This was missing in the original implementation - adding it now
   *
   * @throws {ElementNotFoundError} When ensemble does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async deactivate(name: string): Promise<MCPResponse> {
    // Deactivate via manager (which handles name tracking)
    const deactivationResult = await this.ensembleManager.deactivateEnsemble(name);

    if (!deactivationResult.success) {
      this.throwNotFoundError(name, 'Ensemble');
    }

    if (deactivationResult.ensemble) {
      await this.deactivateMembers(deactivationResult.ensemble);
    }

    return this.createSuccessResponse(`✅ Ensemble '${name}' deactivated`);
  }

  private getManagers(): ElementManagers {
    return {
      skillManager: this.skillManager,
      templateManager: this.templateManager,
      agentManager: this.agentManager,
      memoryManager: this.memoryManager,
      personaManager: this.personaManager,
      ensembleManager: this.ensembleManager
    };
  }

  private async deactivateMembers(ensemble: Ensemble): Promise<void> {
    const deactivationPromises = (ensemble.metadata.elements || []).map((element) =>
      this.deactivateMember(element)
    );
    await Promise.all(deactivationPromises);
  }

  private async deactivateMember(element: EnsembleElement): Promise<void> {
    const normalizedType = element.element_type.toLowerCase();

    switch (normalizedType) {
      case 'skill':
      case 'skills':
        await this.skillManager.deactivateSkill(element.element_name);
        return;
      case 'persona':
      case 'personas':
        await Promise.resolve(this.personaManager.deactivatePersona(element.element_name));
        return;
      case 'agent':
      case 'agents':
        await this.agentManager.deactivateAgent(element.element_name);
        return;
      case 'memory':
      case 'memories':
        await this.memoryManager.deactivateMemory(element.element_name);
        return;
      case 'ensemble':
      case 'ensembles':
        await this.ensembleManager.deactivateEnsemble(element.element_name);
        return;
      case 'template':
      case 'templates':
      default:
        return;
    }
  }

  /**
   * Get all active ensembles
   * NOTE: This was missing in the original implementation - adding basic version
   */
  async getActiveElements(): Promise<MCPResponse> {
    const activeEnsembles = await this.ensembleManager.getActiveEnsembles();

    if (activeEnsembles.length === 0) {
      return {
        content: [{
          type: "text",
          text: "🎭 No active ensembles"
        }]
      };
    }

    const ensembleList = activeEnsembles.map(e => {
      const elementCount = e.metadata.elements?.length || 0;
      return `🎭 ${e.metadata.name} (${elementCount} elements)`;
    }).join('\n');

    return {
      content: [{
        type: "text",
        text: `Active ensembles:\n${ensembleList}`
      }]
    };
  }

  /**
   * Get detailed information about an ensemble
   * Extracted from ElementCRUDHandler.ts lines 807-846
   */
  async getElementDetails(name: string): Promise<MCPResponse> {
    // Use flexible finding to support both display name and filename
    const allEnsembles = await this.ensembleManager.list();
    const ensemble = await this.findElementFlexibly(name, allEnsembles);
    if (!ensemble) {
      this.throwNotFoundError(name, 'Ensemble');
    }

    const elementsList = ensemble.metadata.elements?.map((elem: any) =>
      `- ${elem.element_name} (${elem.element_type}) - ${elem.role}, priority: ${elem.priority}, activation: ${elem.activation}`
    ).join('\n') || 'No elements configured';

    const details = [
      `🎭 **${ensemble.metadata.name}**`,
      `${ensemble.metadata.description}`,
      ``,
      `**Status**: ${ensemble.getStatus()}`,
      `**Version**: ${ensemble.metadata.version || '1.0.0'}`,
      `**Activation Strategy**: ${(ensemble.metadata as any).activationStrategy || 'sequential'}`,
      `**Conflict Resolution**: ${(ensemble.metadata as any).conflictResolution || 'last-write'}`,
      `**Context Sharing**: ${(ensemble.metadata as any).contextSharing || 'selective'}`,
      `**Allows Nesting**: ${(ensemble.metadata as any).allowNested ? 'Yes' : 'No'}`,
      `**Max Nesting Depth**: ${(ensemble.metadata as any).maxNestingDepth || 5}`,
      ``,
      `**Elements** (${ensemble.metadata.elements?.length || 0}):`,
      elementsList
    ];

    return {
      content: [{
        type: "text",
        text: details.join('\n')
      }]
    };
  }
}
