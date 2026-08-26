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
import os from 'node:os';
import path from 'node:path';
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
import type { ActivationStore, PersistedActivation, PersistedActivationStateSnapshot } from '../services/ActivationStore.js';
import type { BackupService } from '../services/BackupService.js';
import type { PolicyExportService } from '../services/PolicyExportService.js';
import type { BaseElementManager } from '../elements/base/BaseElementManager.js';
import { formatValidationFailedError } from './element-crud/responseFormatter.js';
import {
  findConfirmAdvisoryElements,
  findConfirmDenyingElement,
  getGatekeeperDiagnostics,
} from './mcp-aql/policies/ElementPolicies.js';

type PolicyElement = {
  type: string;
  name: string;
  metadata: Record<string, unknown>;
  /** Stable storage identity used only to avoid unsafe display-name deduplication. */
  identity?: string;
};

type PolicyMemberElement = {
  metadata?: Record<string, unknown>;
};

type PolicyIndexOptions = { freshAfterInFlight?: boolean };
type IndexedPolicyManagers = Map<string, Promise<BaseElementManager<any> | undefined>>;
type PolicyMemberCandidate = { type: string; name: string; key: string };

type DeadlockReliefElement = {
  type: string;
  name: string;
  deactivationIdentifier?: string;
};

const ACTIVE_POLICY_MEMBER_LOOKUP_CONCURRENCY = 8;

export class ElementCRUDHandler {
  private readonly strategies: Map<string, ElementActivationStrategy>;
  private activePolicySnapshotGeneration = 0;
  private activePolicySnapshotInFlight?: {
    generation: number;
    promise: Promise<PolicyElement[]>;
  };

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
    private readonly activationStore?: ActivationStore,
    private readonly backupService?: BackupService,
    private readonly policyExportService?: PolicyExportService
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
      case 'templates':
        return 'template';
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

  private policyElementKey(type: string, name: string): string {
    return `${this.toPolicyElementType(this.normalizeElementType(type))}:${this.normalizeLookupValue(name)}`;
  }

  private invalidateActivePolicySnapshot(): void {
    this.activePolicySnapshotGeneration += 1;
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
      this.invalidateActivePolicySnapshot();

      // Issue #598: Persist activation state for session restore
      if (this.activationStore) {
        const filename = await this.getStableActivationFilename(normalizedType, name);
        this.activationStore.recordActivation(normalizedType, name, filename);
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
  async getActiveElementsForPolicy(options: { allowCoalescing?: boolean } = {}): Promise<PolicyElement[]> {
    // Security enforcement must not join a snapshot that may have started
    // before an external policy-file edit. Dashboard/reporting callers may
    // coalesce overlapping reads to bound polling work.
    if (options.allowCoalescing === false) {
      return this.collectActiveElementsForPolicy({ freshAfterInFlight: true });
    }

    const generation = this.activePolicySnapshotGeneration;
    if (this.activePolicySnapshotInFlight?.generation === generation) {
      return this.activePolicySnapshotInFlight.promise;
    }

    const snapshot = this.collectActiveElementsForPolicy();
    const inFlight = { generation, promise: snapshot };
    this.activePolicySnapshotInFlight = inFlight;

    try {
      return await snapshot;
    } finally {
      if (this.activePolicySnapshotInFlight === inFlight) {
        this.activePolicySnapshotInFlight = undefined;
      }
    }
  }

  private async collectActiveElementsForPolicy(
    indexOptions: PolicyIndexOptions = {},
  ): Promise<PolicyElement[]> {
    await this.ensureInitialized();

    const result: PolicyElement[] = [];
    const seen = new Set<string>();

    this.appendActivePersonas(result, seen);
    await this.appendActiveSkills(result, seen);
    await this.appendActiveAgents(result, seen, indexOptions);
    await this.appendActiveEnsembles(result, seen, indexOptions);

    return result;
  }

  private appendActivePersonas(result: PolicyElement[], seen: Set<string>): void {
    try {
      for (const persona of this.personaManager.getActivePersonas()) {
        seen.add(this.policyElementKey('persona', persona.metadata.name));
        result.push({
          type: 'persona',
          name: persona.metadata.name,
          metadata: persona.metadata as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active personas for policy evaluation', { error });
    }
  }

  private async appendActiveSkills(result: PolicyElement[], seen: Set<string>): Promise<void> {
    try {
      for (const skill of await this.skillManager.getActiveSkills()) {
        seen.add(this.policyElementKey('skill', skill.metadata.name));
        result.push({
          type: 'skill',
          name: skill.metadata.name,
          metadata: skill.metadata as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active skills for policy evaluation', { error });
    }
  }

  private async appendActiveAgents(
    result: PolicyElement[],
    seen: Set<string>,
    indexOptions: PolicyIndexOptions,
  ): Promise<void> {
    try {
      for (const agent of await this.agentManager.getActiveAgents(indexOptions)) {
        seen.add(this.policyElementKey('agent', agent.metadata.name));
        const filename = (agent as typeof agent & { filename?: unknown }).filename;
        result.push({
          type: 'agent',
          name: agent.metadata.name,
          metadata: agent.metadata as unknown as Record<string, unknown>,
          ...(typeof filename === 'string' && filename.trim() !== ''
            ? { identity: filename }
            : {}),
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active agents for policy evaluation', { error });
    }
  }

  private async appendActiveEnsembles(
    result: PolicyElement[],
    seen: Set<string>,
    indexOptions: PolicyIndexOptions,
  ): Promise<void> {
    try {
      const ensembles = await this.ensembleManager.getActiveEnsembles();
      const candidates = this.appendEnsemblesAndCollectMembers(ensembles, result, seen);
      const resolvedMembers = await this.resolvePolicyMembers(candidates, indexOptions);
      this.appendResolvedPolicyMembers(resolvedMembers, result, seen);
    } catch (error) {
      logger.warn('Failed to gather active ensembles for policy evaluation', { error });
    }
  }

  private appendEnsemblesAndCollectMembers(
    ensembles: Awaited<ReturnType<EnsembleManager['getActiveEnsembles']>>,
    result: PolicyElement[],
    seen: Set<string>,
  ): PolicyMemberCandidate[] {
    const candidates: PolicyMemberCandidate[] = [];
    const queuedMemberKeys = new Set<string>();

    for (const ensemble of ensembles) {
      seen.add(this.policyElementKey('ensemble', ensemble.metadata.name));
      result.push({
        type: 'ensemble',
        name: ensemble.metadata.name,
        metadata: ensemble.metadata as unknown as Record<string, unknown>,
      });

      const members = (ensemble.metadata as unknown as Record<string, unknown>)?.elements as
        Array<{ element_name: string; element_type: string }> | undefined;
      if (!Array.isArray(members)) continue;

      for (const member of members) {
        const normalizedType = this.normalizeElementType(member.element_type);
        const normalizedName = this.normalizeLookupValue(member.element_name);
        if (normalizedType === '' || normalizedName === '') continue;

        const key = this.policyElementKey(normalizedType, normalizedName);
        if (seen.has(key) || queuedMemberKeys.has(key)) continue;
        queuedMemberKeys.add(key);
        candidates.push({ type: normalizedType, name: normalizedName, key });
      }
    }

    return candidates;
  }

  private async resolvePolicyMembers(
    candidates: PolicyMemberCandidate[],
    indexOptions: PolicyIndexOptions,
  ): Promise<Array<PolicyElement | undefined>> {
    const resolvedMembers = new Array<PolicyElement | undefined>(candidates.length);
    const indexedManagers: IndexedPolicyManagers = new Map();
    const memberLookups = new Map<string, Promise<PolicyMemberElement | undefined>>();
    let nextCandidateIndex = 0;

    const resolveNextMember = async (): Promise<void> => {
      // The increment is synchronous before the first await, so each worker
      // claims a unique candidate while preserving deterministic result slots.
      while (nextCandidateIndex < candidates.length) {
        const candidateIndex = nextCandidateIndex++;
        const candidate = candidates[candidateIndex];
        try {
          const found = await this.findPolicyMember(
            candidate,
            indexedManagers,
            memberLookups,
            indexOptions,
          );
          if (found?.metadata?.['gatekeeper']) {
            resolvedMembers[candidateIndex] = {
              type: this.toPolicyElementType(candidate.type),
              name: candidate.name,
              metadata: found.metadata,
            };
          }
        } catch {
          // Non-fatal: skip member if element type lookup fails.
        }
      }
    };

    const workerCount = Math.min(ACTIVE_POLICY_MEMBER_LOOKUP_CONCURRENCY, candidates.length);
    await Promise.all(Array.from({ length: workerCount }, () => resolveNextMember()));
    return resolvedMembers;
  }

  private appendResolvedPolicyMembers(
    resolvedMembers: Array<PolicyElement | undefined>,
    result: PolicyElement[],
    seen: Set<string>,
  ): void {
    for (const resolved of resolvedMembers) {
      if (!resolved) continue;
      const key = this.policyElementKey(resolved.type, resolved.name);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(resolved);
    }
  }

  private findPolicyMember(
    candidate: PolicyMemberCandidate,
    indexedManagers: IndexedPolicyManagers,
    memberLookups: Map<string, Promise<PolicyMemberElement | undefined>>,
    indexOptions: PolicyIndexOptions,
  ): Promise<PolicyMemberElement | undefined> {
    const existing = memberLookups.get(candidate.key);
    if (existing) return existing;

    const lookup = this.getIndexedPolicyManager(
      candidate.type,
      indexedManagers,
      indexOptions,
    ).then(async (manager) => manager
      ? manager.findByName(candidate.name) as Promise<PolicyMemberElement | undefined>
      : undefined);
    memberLookups.set(candidate.key, lookup);
    return lookup;
  }

  private getIndexedPolicyManager(
    type: string,
    indexedManagers: IndexedPolicyManagers,
    indexOptions: PolicyIndexOptions,
  ): Promise<BaseElementManager<any> | undefined> {
    const normalizedType = this.normalizeElementType(type);
    const existing = indexedManagers.get(normalizedType);
    if (existing) return existing;

    const manager = this.getManagerForType(normalizedType);
    const indexed = manager
      ? manager.refreshIndex(indexOptions).then(() => manager)
      : Promise.resolve(undefined);
    indexedManagers.set(normalizedType, indexed);
    return indexed;
  }

  async getPolicyElementsForReport(
    sessionId?: string,
    options: { allowCoalescing?: boolean } = {},
  ): Promise<Array<{
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
      element: PolicyElement,
      sessionIds: string[] = [],
    ): void => {
      if (!this.hasGatekeeperPolicy(element.metadata)) {
        return;
      }

      const key = `${element.type}:${element.identity ?? element.name}`;
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
    const indexOptions = options.allowCoalescing === false
      ? { freshAfterInFlight: true }
      : {};

    if (includeCurrentSession) {
      for (const activeElement of await this.getActiveElementsForPolicy(options)) {
        addElement(activeElement, currentSessionId ? [currentSessionId] : []);
      }
    }

    if (this.activationStore?.isEnabled()) {
      const persistedStates = await this.activationStore.listPersistedActivationStates(sessionId);
      const indexedManagers: IndexedPolicyManagers = new Map();
      const persistedLookups = new Map<string, Promise<PolicyElement | null>>();

      const findPersistedElement = (
        type: string,
        activation: PersistedActivation,
      ): Promise<PolicyElement | null> => {
        const normalizedType = this.normalizeElementType(type);
        const normalizedName = this.normalizeLookupValue(activation.name);
        const normalizedFilename = this.normalizeLookupValue(activation.filename);
        const lookupKey = `${normalizedType}:${normalizedName}:${normalizedFilename}`;
        const existing = persistedLookups.get(lookupKey);
        if (existing) {
          return existing;
        }

        const lookup = this.getIndexedPolicyManager(
          normalizedType,
          indexedManagers,
          indexOptions,
        ).then(async (manager) => {
          if (!manager) return null;
          let found = normalizedFilename !== ''
            ? await manager.findByFilename(normalizedFilename) as PolicyMemberElement | undefined
            : undefined;
          if (!found && normalizedName !== '') {
            found = await manager.findByName(normalizedName) as PolicyMemberElement | undefined;
          }

          if (!found?.metadata || !this.hasGatekeeperPolicy(found.metadata)) {
            return null;
          }

          return {
            type: this.toPolicyElementType(normalizedType),
            name: (found.metadata['name'] as string) ?? activation.name,
            metadata: found.metadata,
            ...(normalizedFilename !== '' ? { identity: normalizedFilename } : {}),
          };
        });
        persistedLookups.set(lookupKey, lookup);
        return lookup;
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

  async releaseDeadlock(): Promise<{
    sessionId?: string;
    activeBeforeReset: Array<{ type: string; name: string }>;
    deactivated: Array<{ type: string; name: string }>;
    failed: Array<{ type: string; name: string; error: string }>;
    persistedStateCleared: boolean;
    likelyDeadlockCause: {
      sandboxingElement?: { type: string; name: string };
      advisoryElements: Array<{ type: string; name: string }>;
    };
    snapshotFile?: string;
  }> {
    const activeElements = await this.collectActiveElementsForDeadlockRelief();
    const activeBeforeReset = activeElements.map(({ type, name }) => ({ type, name }));
    const activePolicyElements = await this.getActiveElementsForPolicy();
    const sandboxingElement = findConfirmDenyingElement(activePolicyElements);
    const advisoryElements = findConfirmAdvisoryElements(activePolicyElements);
    const deactivated: Array<{ type: string; name: string }> = [];
    const failed: Array<{ type: string; name: string; error: string }> = [];

    for (const element of activeElements) {
      const strategy = this.strategies.get(element.type);
      if (!strategy) {
        failed.push({
          type: element.type,
          name: element.name,
          error: `No activation strategy registered for type '${element.type}'`,
        });
        continue;
      }

      try {
        await strategy.deactivate(element.deactivationIdentifier ?? element.name);
        deactivated.push({ type: element.type, name: element.name });
      } catch (error) {
        failed.push({
          type: element.type,
          name: element.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const persistedStateCleared = Boolean(this.activationStore?.isEnabled());
    const snapshotFile = await this.writeDeadlockReliefSnapshot({
      sessionId: this.activationStore?.getSessionId(),
      activeBeforeReset,
      deactivated,
      failed,
      likelyDeadlockCause: {
        ...(sandboxingElement ? { sandboxingElement } : {}),
        advisoryElements,
      },
      persistedStateCleared,
    });

    this.activationStore?.clearAll();
    this.invalidateActivePolicySnapshot();
    this.policyExportService?.exportPolicies().catch(() => {});

    const failureSummary = failed.length > 0 ? ` with ${failed.length} failure(s)` : '';

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_DEACTIVATED',
      severity: failed.length > 0 ? 'MEDIUM' : 'LOW',
      source: 'ElementCRUDHandler.releaseDeadlock',
      details: `Deadlock relief deactivated ${deactivated.length} element(s)${failureSummary}`,
      additionalData: {
        sessionId: this.activationStore?.getSessionId(),
        activeBeforeReset,
        deactivated,
        failed,
        persistedStateCleared,
        likelyDeadlockCause: {
          ...(sandboxingElement ? { sandboxingElement } : {}),
          advisoryElements,
        },
        snapshotFile,
      },
    });

    return {
      ...(this.activationStore?.getSessionId()
        ? { sessionId: this.activationStore.getSessionId() }
        : {}),
      activeBeforeReset,
      deactivated,
      failed,
      persistedStateCleared,
      likelyDeadlockCause: {
        ...(sandboxingElement ? { sandboxingElement } : {}),
        advisoryElements,
      },
      ...(snapshotFile ? { snapshotFile } : {}),
    };
  }

  private async collectActiveElementsForDeadlockRelief(): Promise<DeadlockReliefElement[]> {
    const activeElements: DeadlockReliefElement[] = [];

    const activePersonas = this.personaManager.getActivePersonas();
    activeElements.push(...activePersonas.map((persona) => ({
      type: ElementType.PERSONA,
      name: persona.metadata.name,
    })));

    const activeSkills = await this.skillManager.getActiveSkills();
    activeElements.push(...activeSkills.map((skill) => ({
      type: ElementType.SKILL,
      name: skill.metadata.name,
    })));

    const activeAgents = await this.agentManager.getActiveAgents();
    activeElements.push(...activeAgents.map((agent) => {
      const filename = (agent as typeof agent & { filename?: unknown }).filename;
      return {
        type: ElementType.AGENT,
        name: agent.metadata.name,
        ...(typeof filename === 'string' && filename.trim() !== ''
          ? { deactivationIdentifier: filename }
          : {}),
      };
    }));

    const activeMemories = await this.memoryManager.getActiveMemories();
    activeElements.push(...activeMemories.map((memory) => ({
      type: ElementType.MEMORY,
      name: memory.metadata.name,
    })));

    const activeEnsembles = await this.ensembleManager.getActiveEnsembles();
    activeElements.push(...activeEnsembles.map((ensemble) => ({
      type: ElementType.ENSEMBLE,
      name: ensemble.metadata.name,
    })));

    const seen = new Set<string>();
    return activeElements.filter((element) => {
      const key = `${element.type}:${element.deactivationIdentifier ?? element.name}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private async writeDeadlockReliefSnapshot(snapshot: {
    sessionId?: string;
    activeBeforeReset: Array<{ type: string; name: string }>;
    deactivated: Array<{ type: string; name: string }>;
    failed: Array<{ type: string; name: string; error: string }>;
    likelyDeadlockCause: {
      sandboxingElement?: { type: string; name: string };
      advisoryElements: Array<{ type: string; name: string }>;
    };
    persistedStateCleared: boolean;
  }): Promise<string | undefined> {
    const snapshotDir = path.join(os.homedir(), '.dollhouse', 'state', 'deadlock-relief');
    const safeSessionId = (snapshot.sessionId ?? 'session')
      .replaceAll(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 64);
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const snapshotFile = path.join(snapshotDir, `deadlock-relief-${safeSessionId}-${timestamp}.json`);

    try {
      await this.fileOperations.createDirectory(snapshotDir);
      await this.fileOperations.writeFile(
        snapshotFile,
        JSON.stringify({
          createdAt: new Date().toISOString(),
          ...snapshot,
        }, null, 2),
        { source: 'ElementCRUDHandler.releaseDeadlock' },
      );
      return snapshotFile;
    } catch (error) {
      logger.warn('Failed to write deadlock relief snapshot', {
        snapshotFile,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async mergePersistedPolicyState(
    state: PersistedActivationStateSnapshot,
    addElement: (element: PolicyElement, sessionIds?: string[]) => void,
    findPersistedElement: (type: string, activation: PersistedActivation) => Promise<PolicyElement | null>,
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

  private async getStableActivationFilename(type: string, name: string): Promise<string | undefined> {
    if (type === ElementType.PERSONA) {
      return this.personaManager.findPersona(name)?.filename;
    }
    if (type === ElementType.AGENT) {
      return this.agentManager.getStableActivationFilename(name);
    }
    return undefined;
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
      this.invalidateActivePolicySnapshot();

      // Issue #598: Persist deactivation state for session restore
      if (this.activationStore) {
        // Agent deactivation returns the exact stable identity selected by its
        // freshness scan. Other element types resolve from their live cache.
        const filename = result.stableIdentity
          ?? await this.getStableActivationFilename(normalizedType, name);
        this.activationStore.recordDeactivation(normalizedType, name, filename);
      }

      // Issue #762: Export policies to bridge after deactivation
      this.policyExportService?.exportPolicies().catch(() => {});

      return { content: result.content };
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
