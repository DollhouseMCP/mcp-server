/**
 * ElementCRUDHandler - Handles all generic element CRUD operations
 *
 * Provides create, edit, validate, and delete operations for all element types
 * (personas, skills, templates, agents, memories).
 *
 * Uses dependency injection for all services:
 * - InitializationService for setup tasks
 * - PersonaIndicatorService for persona indicator formatting
 * - Element managers (SkillManager, TemplateManager, AgentManager, MemoryManager)
 * - PersonaManager for persona operations
 * - PortfolioManager for portfolio operations
 *
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This handler delegates all operations to specialized element managers.
 * Audit logging happens in the element managers themselves.
 * @security-audit-suppress DMCP-SEC-006
 */

import { ElementType, PortfolioManager } from '../portfolio/PortfolioManager.js';
import { SkillManager } from '../elements/skills/index.js';
import { TemplateManager } from '../elements/templates/TemplateManager.js';
import { TemplateRenderer } from '../utils/TemplateRenderer.js';
import { AgentManager } from '../elements/agents/AgentManager.js';
import { MemoryManager } from '../elements/memories/MemoryManager.js';
import { EnsembleManager } from '../elements/ensembles/EnsembleManager.js';
import { logger } from '../utils/logger.js';
import { ElementNotFoundError } from '../utils/ErrorHandler.js';
import { createElement as createElementCommand } from './element-crud/createElement.js';
import { deleteElement as deleteElementCommand } from './element-crud/deleteElement.js';
import { editElement as editElementCommand } from './element-crud/editElement.js';
import { upgradeElement as upgradeElementCommand } from './element-crud/upgradeElement.js';
import { listElements as listElementsCommand } from './element-crud/listElements.js';
import { findElementFlexibly, sanitizeMetadata as sanitizeMetadataRecord } from './element-crud/helpers.js';
import { validateElement as validateElementCommand } from './element-crud/validateElement.js';
import { ElementCrudContext } from './element-crud/types.js';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { PersonaManager } from '../persona/PersonaManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { ELEMENT_TYPE_MAP } from '../utils/elementTypeNormalization.js';
import type { IFileOperationsService } from '../services/FileOperationsService.js';
import type { ElementActivationStrategy, MCPResponse } from './strategies/index.js';
import {
  TemplateActivationStrategy,
  SkillActivationStrategy,
  AgentActivationStrategy,
  MemoryActivationStrategy,
  PersonaActivationStrategy,
  EnsembleActivationStrategy
} from './strategies/index.js';
import { ElementQueryService } from '../services/query/ElementQueryService.js';
import { ValidationRegistry } from '../services/validation/ValidationRegistry.js';
import type { IActivationStateStore, PersistedActivation, PersistedActivationStateSnapshot } from '../state/IActivationStateStore.js';
import type { BackupService } from '../services/BackupService.js';
import type { PolicyExportService } from '../services/PolicyExportService.js';
import type { SessionActivationRegistry } from '../state/SessionActivationState.js';
import type { ContextTracker } from '../security/encryption/ContextTracker.js';
import type { BaseElementManager } from '../elements/base/BaseElementManager.js';
import { formatValidationFailedError } from './element-crud/responseFormatter.js';
import { getGatekeeperDiagnostics } from './mcp-aql/policies/ElementPolicies.js';

export class ElementCRUDHandler {
  private readonly strategies: Map<string, ElementActivationStrategy>;

  constructor(
    private readonly skillManager: SkillManager,
    private readonly templateManager: TemplateManager,
    private readonly templateRenderer: TemplateRenderer,
    private readonly agentManager: AgentManager,
    private readonly memoryManager: MemoryManager,
    private readonly ensembleManager: EnsembleManager,
    private readonly personaManager: PersonaManager,
    private readonly portfolioManager: PortfolioManager,
    private readonly initService: InitializationService,
    private readonly indicatorService: PersonaIndicatorService,
    private readonly fileOperations: IFileOperationsService,
    private readonly elementQueryService: ElementQueryService,
    private readonly validationRegistry: ValidationRegistry,
    private readonly activationStore?: IActivationStateStore,
    private readonly backupService?: BackupService,
    private readonly policyExportService?: PolicyExportService,
    private readonly activationRegistry?: SessionActivationRegistry,
    private readonly contextTracker?: ContextTracker,
    private readonly forkOnEditStrategy?: import('../collection/shared-pool/ForkOnEditStrategy.js').ForkOnEditStrategy,
  ) {
    // Initialize strategy map with all element type strategies
    this.strategies = new Map<string, ElementActivationStrategy>([
      [ElementType.PERSONA, new PersonaActivationStrategy(personaManager, indicatorService)],
      [ElementType.SKILL, new SkillActivationStrategy(skillManager)],
      [ElementType.TEMPLATE, new TemplateActivationStrategy(templateManager)],
      [ElementType.AGENT, new AgentActivationStrategy(agentManager)],
      [ElementType.MEMORY, new MemoryActivationStrategy(memoryManager)],
      [ElementType.ENSEMBLE, new EnsembleActivationStrategy(
        ensembleManager,
        portfolioManager,
        skillManager,
        templateManager,
        agentManager,
        memoryManager,
        personaManager
      )]
    ]);
  }

  /**
   * Resolve the current session's ActivationStore for persistence.
   * Falls back to the singleton activationStore when no registry is available.
   * Issue #1946: Per-session activation persistence.
   */
  private getSessionActivationStore(): IActivationStateStore | undefined {
    if (this.activationRegistry && this.contextTracker) {
      const sessionId = this.contextTracker.getSessionContext()?.sessionId
        ?? this.activationRegistry.getDefaultSessionId();
      const state = this.activationRegistry.get(sessionId);
      if (state?.activationStore) return state.activationStore;
    }
    // Fallback: singleton store (backward compat for tests, stdio without registry)
    return this.activationStore;
  }

  private async ensureInitialized(): Promise<void> {
    await this.initService.ensureInitialized();
  }

  private getPersonaIndicator(): string {
    return this.indicatorService.getPersonaIndicator();
  }

  private getContext(): ElementCrudContext {
    return {
      ensureInitialized: () => this.ensureInitialized(),
      getPersonaIndicator: () => this.getPersonaIndicator(),
      skillManager: this.skillManager,
      templateManager: this.templateManager,
      templateRenderer: this.templateRenderer,
      agentManager: this.agentManager,
      memoryManager: this.memoryManager,
      ensembleManager: this.ensembleManager,
      portfolioManager: this.portfolioManager,
      personaManager: this.personaManager,
      fileOperations: this.fileOperations,
      elementQueryService: this.elementQueryService,
      validationRegistry: this.validationRegistry,
      backupService: this.backupService,
      forkOnEditStrategy: this.forkOnEditStrategy,
    };
  }

  /**
   * Find an element by name, supporting both exact display name and filename (slug) matching
   * Helper method extracted from index.ts:346-379
   */
  private async findElementFlexibly(name: string, elementList: any[]): Promise<any> {
    return findElementFlexibly(name, elementList);
  }

  /**
   * Sanitize metadata object to prevent prototype pollution
   * Helper method extracted from index.ts:390-410
   */
  private sanitizeMetadata(metadata: Record<string, any>): Record<string, any> {
    return sanitizeMetadataRecord(metadata);
  }

  private normalizeLookupValue(value: unknown): string {
    return typeof value === 'string'
      ? value.normalize('NFC').trim()
      : '';
  }

  private hasGatekeeperPolicy(metadata: Record<string, unknown> | undefined): boolean {
    return Boolean(metadata?.['gatekeeper'] || getGatekeeperDiagnostics(metadata));
  }

  private toPolicyElementType(type: string): string {
    const normalizedType = this.normalizeLookupValue(type).toLowerCase();
    switch (normalizedType) {
      case 'personas':
        return 'persona';
      case 'skills':
        return 'skill';
      case 'agents':
        return 'agent';
      case 'memories':
        return 'memory';
      case 'ensembles':
        return 'ensemble';
      default:
        return normalizedType;
    }
  }

  /**
   * Create a new element
   * Extracted from index.ts:1492-1631 (140 lines - exact copy)
   */
  async createElement(args: {name: string; type: string; description: string; content?: string; instructions?: string; metadata?: Record<string, any>}) {
    return createElementCommand(this.getContext(), args);
  }

  /**
   * Edit an existing element using GraphQL-aligned nested input objects.
   *
   * @example
   * await handler.editElement({
   *   name: 'my-skill',
   *   type: 'skills',
   *   input: {
   *     description: 'Updated',
   *     metadata: { triggers: ['code'] }
   *   }
   * });
   */
  async editElement(args: {name: string; type: string; input: Record<string, unknown>}) {
    return editElementCommand(this.getContext(), args);
  }

  /**
   * Upgrade element from v1 single-body to v2 dual-field format (instructions + content)
   */
  async upgradeElement(args: {name: string; type: string; dry_run?: boolean; instructions_override?: string; content_override?: string}) {
    return upgradeElementCommand(this.getContext(), args);
  }

  /**
   * Validate an element
   * Extracted from index.ts:1941-2054 (114 lines - exact copy)
   */
  async validateElement(args: {name: string; type: string; strict?: boolean}) {
    return validateElementCommand(this.getContext(), args);
  }

  /**
   * Delete an element
   * Extracted from index.ts:2056-2310 (255 lines - exact copy, split for readability)
   */
  async deleteElement(args: {name: string; type: string; deleteData?: boolean}) {
    return deleteElementCommand(this.getContext(), args);
  }

  public normalizeElementType(type: string | undefined | null): string {
    // Issue #501: Guard against null/undefined to match shared utility pattern
    if (type == null || typeof type !== 'string' || type.trim() === '') {
      return '';
    }

    // If it's already a valid ElementType value, return as-is
    if (Object.values(ElementType).includes(type as ElementType)) {
      return type;
    }

    // Use shared normalization map (Issue #433)
    const normalized = ELEMENT_TYPE_MAP[type.trim().toLowerCase()];
    if (normalized) {
      return normalized;
    }

    // Unknown type - return as-is and let validation handle it
    return type;
  }

  async listElements(type: string, options?: import('../services/query/types.js').QueryOptions) {
    return listElementsCommand(this.getContext(), type, options);
  }

  /**
   * Get raw elements array for a given type.
   * Unlike listElements which returns MCPResponse format, this returns raw element objects.
   *
   * @param type - Element type (persona, skill, template, agent, memory, ensemble)
   * @returns Array of raw element objects
   */
  async getElements(type: string): Promise<unknown[]> {
    await this.ensureInitialized();
    const normalizedType = this.normalizeElementType(type);

    switch (normalizedType) {
      case ElementType.PERSONA:
        return this.personaManager.list();
      case ElementType.SKILL:
        return this.skillManager.list();
      case ElementType.TEMPLATE:
        return this.templateManager.list();
      case ElementType.AGENT:
        return this.agentManager.list();
      case ElementType.MEMORY:
        return this.memoryManager.list();
      case ElementType.ENSEMBLE:
        return this.ensembleManager.list();
      default:
        return [];
    }
  }

  async activateElement(name: string, type: string, context?: Record<string, any>) {
    try {
      // FIX: DMCP-SEC-006 - Add security audit logging for element activation
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_ACTIVATED',
        severity: 'LOW',
        source: 'ElementCRUDHandler.activateElement',
        details: `Element activation requested: ${type}/${name}`,
        additionalData: { elementType: type, elementName: name, contextProvided: !!context }
      });

      const normalizedType = this.normalizeElementType(type);
      const strategy = this.strategies.get(normalizedType);

      if (!strategy) {
        return {
          content: [{
            type: "text",
            text: `❌ Unknown element type '${type}'`
          }]
        };
      }

      const result = await strategy.activate(name, context);

      // Issue #598, #1946: Persist activation state for session restore (per-session)
      const sessionStore = this.getSessionActivationStore();
      if (sessionStore) {
        const filename = normalizedType === ElementType.PERSONA
          ? this.personaManager.findPersona(name)?.filename
          : undefined;
        sessionStore.recordActivation(normalizedType, name, filename);
      }

      // Issue #762: Export policies to bridge after activation
      this.policyExportService?.exportPolicies().catch(() => {});

      return result;
    } catch (error) {
      logger.error(`Failed to activate element:`, { type, name, error });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to activate ${type} '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  async getActiveElements(type?: string) {
    try {
      // Issue #501: When type is omitted, aggregate active elements across all types
      if (!type || type.trim() === '') {
        return this.aggregateActiveElements();
      }

      const normalizedType = this.normalizeElementType(type);
      const strategy = this.strategies.get(normalizedType);

      if (!strategy) {
        return {
          content: [{
            type: "text",
            text: `❌ Unknown element type '${type}'`
          }]
        };
      }

      return await strategy.getActiveElements();
    } catch (error) {
      logger.error(`Failed to get active elements:`, { type, error });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get active ${type || 'all'}: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Get raw active elements for Gatekeeper policy evaluation.
   * Returns active personas, skills, and ensembles with their metadata
   * mapped to the shape expected by the Gatekeeper's ActiveElement interface.
   *
   * Issue #452: Provides active element context for enforce() policy checks.
   */
  async getActiveElementsForPolicy(): Promise<Array<{ type: string; name: string; metadata: Record<string, unknown> }>> {
    const result: Array<{ type: string; name: string; metadata: Record<string, unknown> }> = [];
    const seen = new Set<string>();

    try {
      // Active personas (sync)
      const personas = this.personaManager.getActivePersonas();
      for (const p of personas) {
        const key = `persona:${p.metadata.name}`;
        seen.add(key);
        result.push({
          type: 'persona',
          name: p.metadata.name,
          metadata: p.metadata as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active personas for policy evaluation', { error });
    }

    try {
      // Active skills (async)
      const skills = await this.skillManager.getActiveSkills();
      for (const s of skills) {
        const key = `skill:${s.metadata.name}`;
        seen.add(key);
        result.push({
          type: 'skill',
          name: s.metadata.name,
          metadata: s.metadata as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active skills for policy evaluation', { error });
    }

    try {
      // Active agents (async)
      const agents = await this.agentManager.getActiveAgents();
      for (const agent of agents) {
        const key = `agent:${agent.metadata.name}`;
        seen.add(key);
        result.push({
          type: 'agent',
          name: agent.metadata.name,
          metadata: agent.metadata as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active agents for policy evaluation', { error });
    }

    try {
      // Active ensembles (async)
      const ensembles = await this.ensembleManager.getActiveEnsembles();
      for (const e of ensembles) {
        const ensembleKey = `ensemble:${e.metadata.name}`;
        seen.add(ensembleKey);
        result.push({
          type: 'ensemble',
          name: e.metadata.name,
          metadata: e.metadata as unknown as Record<string, unknown>,
        });

        // Issue #625 Phase 4: Resolve ensemble member gatekeeper policies
        const members = (e.metadata as unknown as Record<string, unknown>)?.elements as
          Array<{ element_name: string; element_type: string }> | undefined;
        if (Array.isArray(members)) {
          for (const member of members) {
            const memberKey = `${member.element_type}:${member.element_name}`;
            if (seen.has(memberKey)) continue; // Already active individually
            try {
              const memberElements = await this.getElements(member.element_type);
              const found = (memberElements as Array<{ metadata: Record<string, unknown> }>).find(
                el => (el?.metadata as Record<string, unknown>)?.name === member.element_name
              );
              if (found?.metadata && (found.metadata as Record<string, unknown>)?.gatekeeper) {
                seen.add(memberKey);
                result.push({
                  type: member.element_type,
                  name: member.element_name,
                  metadata: found.metadata as Record<string, unknown>,
                });
              }
            } catch {
              // Non-fatal: skip member if element type lookup fails
            }
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to gather active ensembles for policy evaluation', { error });
    }

    return result;
  }

  async getPolicyElementsForReport(sessionId?: string): Promise<Array<{
    type: string;
    name: string;
    metadata: Record<string, unknown>;
    sessionIds?: string[];
  }>> {
    const merged = new Map<string, {
      type: string;
      name: string;
      metadata: Record<string, unknown>;
      sessionIds: Set<string>;
    }>();

    const addElement = (
      element: { type: string; name: string; metadata: Record<string, unknown> },
      sessionIds: string[] = [],
    ): void => {
      if (!this.hasGatekeeperPolicy(element.metadata)) {
        return;
      }

      const key = `${element.type}:${element.name}`;
      const existing = merged.get(key);
      if (existing) {
        sessionIds.forEach(id => existing.sessionIds.add(id));
        return;
      }

      merged.set(key, {
        type: element.type,
        name: element.name,
        metadata: element.metadata,
        sessionIds: new Set(sessionIds),
      });
    };

    const currentSessionId = this.activationStore?.getSessionId();
    const includeCurrentSession = !sessionId || !currentSessionId || currentSessionId === sessionId;

    if (includeCurrentSession) {
      for (const activeElement of await this.getActiveElementsForPolicy()) {
        addElement(activeElement, currentSessionId ? [currentSessionId] : []);
      }
    }

    if (this.activationStore?.isEnabled()) {
      const persistedStates = await this.activationStore.listPersistedActivationStates(sessionId);
      const catalogs = new Map<string, Array<{ metadata?: Record<string, unknown>; filename?: string }>>();

      const getCatalog = async (type: string) => {
        const normalizedType = this.normalizeElementType(type);
        if (!catalogs.has(normalizedType)) {
          catalogs.set(
            normalizedType,
            (await this.getElements(normalizedType)) as Array<{ metadata?: Record<string, unknown>; filename?: string }>,
          );
        }
        return catalogs.get(normalizedType) ?? [];
      };

      const findPersistedElement = async (
        type: string,
        activation: PersistedActivation,
      ): Promise<{ type: string; name: string; metadata: Record<string, unknown> } | null> => {
        const catalog = await getCatalog(type);
        const normalizedName = this.normalizeLookupValue(activation.name);
        const normalizedFilename = this.normalizeLookupValue(activation.filename);

        const found = catalog.find((element) => {
          const metadata = element.metadata ?? {};
          const elementName = this.normalizeLookupValue(metadata['name']);
          const elementFilename = this.normalizeLookupValue(
            element.filename ?? metadata['filename'] ?? metadata['sourceFile'],
          );

          return elementName === normalizedName || (normalizedFilename !== '' && elementFilename === normalizedFilename);
        });

        if (!found?.metadata || !this.hasGatekeeperPolicy(found.metadata)) {
          return null;
        }

        return {
          type: this.toPolicyElementType(type),
          name: (found.metadata['name'] as string) ?? activation.name,
          metadata: found.metadata,
        };
      };

      for (const state of persistedStates) {
        await this.mergePersistedPolicyState(state, addElement, findPersistedElement);
      }
    }

    return Array.from(merged.values()).map((entry) => ({
      type: entry.type,
      name: entry.name,
      metadata: entry.metadata,
      ...(entry.sessionIds.size > 0
        ? { sessionIds: Array.from(entry.sessionIds).sort((a, b) => a.localeCompare(b)) }
        : {}),
    }));
  }

  private async mergePersistedPolicyState(
    state: PersistedActivationStateSnapshot,
    addElement: (element: { type: string; name: string; metadata: Record<string, unknown> }, sessionIds?: string[]) => void,
    findPersistedElement: (type: string, activation: PersistedActivation) => Promise<{ type: string; name: string; metadata: Record<string, unknown> } | null>,
  ): Promise<void> {
    const pending: Promise<void>[] = [];

    for (const [type, activations] of Object.entries(state.activations)) {
      for (const activation of activations ?? []) {
        pending.push((async () => {
          const found = await findPersistedElement(type, activation);
          if (found) {
            addElement(found, [state.sessionId]);
          }
        })());
      }
    }

    if (pending.length === 0) {
      return;
    }

    await Promise.allSettled(pending);
  }

  async deactivateElement(name: string, type: string) {
    try {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DEACTIVATED',
        severity: 'LOW',
        source: 'ElementCRUDHandler.deactivateElement',
        details: `Element deactivation requested: ${type}/${name}`,
        additionalData: { elementType: type, elementName: name }
      });

      const normalizedType = this.normalizeElementType(type);
      const strategy = this.strategies.get(normalizedType);

      if (!strategy) {
        return {
          content: [{
            type: "text",
            text: `❌ Unknown element type '${type}'`
          }]
        };
      }

      const result = await strategy.deactivate(name);

      // Issue #598, #1946: Persist deactivation state for session restore (per-session)
      const sessionStore = this.getSessionActivationStore();
      if (sessionStore) {
        sessionStore.recordDeactivation(normalizedType, name);
      }

      // Issue #762: Export policies to bridge after deactivation
      this.policyExportService?.exportPolicies().catch(() => {});

      return result;
    } catch (error) {
      // Re-throw ElementNotFoundError to propagate to MCP-AQL layer
      // This ensures operations return success=false instead of success=true with error text
      // Issue #275: Handlers return success=true for missing elements
      if (error instanceof ElementNotFoundError) {
        throw error;
      }

      // Also re-throw validation errors (e.g., missing required parameters)
      // so they result in success=false instead of success=true with error content
      if (error instanceof Error && error.message.includes('parameter is required')) {
        throw error;
      }

      logger.error(`Failed to deactivate element:`, { type, name, error });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to deactivate ${type} '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Issue #708: Get the element manager for a normalized type.
   * Used to check invalid element records when an element is "not found".
   */
  private getManagerForType(normalizedType: string): BaseElementManager<any> | undefined {
    switch (normalizedType) {
      case ElementType.PERSONA: return this.personaManager as unknown as BaseElementManager<any>;
      case ElementType.SKILL: return this.skillManager;
      case ElementType.TEMPLATE: return this.templateManager;
      case ElementType.AGENT: return this.agentManager;
      case ElementType.MEMORY: return this.memoryManager;
      case ElementType.ENSEMBLE: return this.ensembleManager;
      default: return undefined;
    }
  }

  async getElementDetails(name: string, type: string) {
    try {
      const normalizedType = this.normalizeElementType(type);
      const strategy = this.strategies.get(normalizedType);

      if (!strategy) {
        return {
          content: [{
            type: "text",
            text: `❌ Unknown element type '${type}'`
          }]
        };
      }

      return await strategy.getElementDetails(name);
    } catch (error) {
      // Issue #708: When element is "not found", check if it actually exists
      // on disk but failed validation. Return a distinct error in that case.
      if (error instanceof ElementNotFoundError) {
        const normalizedType = this.normalizeElementType(type);
        const manager = this.getManagerForType(normalizedType);
        if (manager && typeof manager.getInvalidElement === 'function') {
          const invalidRecord = manager.getInvalidElement(name);
          if (invalidRecord) {
            return formatValidationFailedError(
              normalizedType as ElementType,
              name,
              invalidRecord.reason,
              invalidRecord.filePath
            );
          }
        }
        throw error;
      }

      logger.error(`Failed to get element details:`, { type, name, error });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get ${type} details for '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Reload elements of a specific type from the filesystem
   * Extracted from index.ts:609-679 (exact copy, adapted for handler pattern)
   */
  async reloadElements(type: string) {
    try {
      // Normalize the type to handle both plural and singular forms
      const normalizedType = this.normalizeElementType(type);

      switch (normalizedType) {
        case ElementType.PERSONA:
          return this.personaManager.reloadPersonas();

        case ElementType.SKILL: {
          this.skillManager.clearCache();
          const skills = await this.skillManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${skills.length} skills from portfolio`
            }]
          };
        }

        case ElementType.TEMPLATE: {
          // Template manager doesn't have clearCache, just list
          const templates = await this.templateManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${templates.length} templates from portfolio`
            }]
          };
        }

        case ElementType.AGENT: {
          // Agent manager doesn't have clearCache, just list
          const agents = await this.agentManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${agents.length} agents from portfolio`
            }]
          };
        }

        case ElementType.MEMORY: {
          // Memory manager doesn't have clearCache, just list
          const memories = await this.memoryManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${memories.length} memories from portfolio`
            }]
          };
        }

        case ElementType.ENSEMBLE: {
          // Ensemble manager doesn't have clearCache, just list
          const ensembles = await this.ensembleManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${ensembles.length} ensembles from portfolio`
            }]
          };
        }

        default:
          return {
            content: [{
              type: "text",
              text: `❌ Unknown element type '${type}'`
            }]
          };
      }
    } catch (error) {
      logger.error(`Failed to reload ${type}:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to reload ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Render a template with variables
   * Extracted from index.ts:682-701 (exact copy)
   *
   * @throws {ElementNotFoundError} When template does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async renderTemplate(name: string, variables: Record<string, any>) {
    // Use the new TemplateRenderer utility for cleaner code and better validation
    const result = await this.templateRenderer.render(name, variables);

    if (result.success && result.content) {
      return {
        content: [{
          type: "text",
          text: `📄 Rendered template '${name}':\n\n${result.content}`
        }]
      };
    } else {
      // Issue #275: Throw error for missing templates instead of returning content
      if (result.error?.includes('not found')) {
        throw new ElementNotFoundError('Template', name);
      }
      return {
        content: [{
          type: "text",
          text: `❌ ${result.error || 'Failed to render template'}`
        }]
      };
    }
  }

  /**
   * Execute an agent with goal parameters
   * Returns context for LLM to drive the agentic loop
   */
  async executeAgent(name: string, parameters: Record<string, any>) {
    try {
      const result = await this.agentManager.executeAgent(name, parameters);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      // FIX: Issue #275 - Re-throw ElementNotFoundError for consistent error handling
      if (error instanceof ElementNotFoundError) {
        throw error;
      }
      logger.error(`Failed to execute agent '${name}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to execute agent: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Record a step in agent execution
   */
  async recordAgentStep(args: {
    agentName: string;
    stepDescription: string;
    outcome: "success" | "failure" | "partial";
    findings?: string;
    confidence?: number;
    nextActionHint?: string;
    riskScore?: number;
  }) {
    try {
      const result = await this.agentManager.recordAgentStep(args);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      // FIX: Issue #275 - Re-throw ElementNotFoundError for consistent error handling
      if (error instanceof ElementNotFoundError) {
        throw error;
      }
      logger.error(`Failed to record agent step for '${args.agentName}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to record step: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Complete an agent goal
   */
  async completeAgentGoal(args: {
    agentName: string;
    goalId?: string;
    outcome: "success" | "failure" | "partial";
    summary: string;
  }) {
    try {
      const result = await this.agentManager.completeAgentGoal(args);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      // FIX: Issue #275 - Re-throw ElementNotFoundError for consistent error handling
      if (error instanceof ElementNotFoundError) {
        throw error;
      }
      logger.error(`Failed to complete agent goal for '${args.agentName}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to complete goal: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Get agent state
   */
  async getAgentState(args: {
    agentName: string;
    includeDecisionHistory?: boolean;
    includeContext?: boolean;
  }) {
    try {
      const result = await this.agentManager.getAgentState(args);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      // FIX: Issue #275 - Re-throw ElementNotFoundError for consistent error handling
      if (error instanceof ElementNotFoundError) {
        throw error;
      }
      logger.error(`Failed to get agent state for '${args.agentName}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get state: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Continue agent execution from previous state
   */
  async continueAgentExecution(args: {
    agentName: string;
    parameters?: Record<string, any>;
    previousStepResult?: string;
  }) {
    try {
      const result = await this.agentManager.continueAgentExecution(args);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      // FIX: Issue #275 - Re-throw ElementNotFoundError for consistent error handling
      if (error instanceof ElementNotFoundError) {
        throw error;
      }
      logger.error(`Failed to continue agent execution for '${args.agentName}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to continue execution: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  /**
   * Aggregate active elements across all registered element types.
   * Issue #501: Called when get_active_elements is invoked without element_type.
   */
  private async aggregateActiveElements(): Promise<MCPResponse> {
    const sections: string[] = [];

    for (const [elementType, strategy] of this.strategies) {
      try {
        const result = await strategy.getActiveElements();
        const text = result.content[0]?.text;
        if (text) {
          sections.push(`[${elementType}]\n${text}`);
        }
      } catch (err) {
        logger.debug(`Failed to get active ${elementType} elements`, { error: err });
      }
    }

    return {
      content: [{
        type: "text",
        text: sections.length > 0
          ? sections.join('\n\n')
          : 'No active elements found.'
      }]
    };
  }

}
