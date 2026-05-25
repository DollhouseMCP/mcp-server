/**
 * AgentManager - Refactored to extend BaseElementManager
 * Manages agent CRUD operations, metadata sanitization, and state persistence.
 */

import * as path from 'path';

import { Agent } from './Agent.js';
import {
  COMMIT_PERSISTED_VERSION,
  AGENT_LIMITS,
  RISK_TOLERANCE_LEVELS,
  STEP_LIMIT_ACTIONS,
  EXECUTION_FAILURE_ACTIONS,
  BACKOFF_STRATEGIES,
  isOneOf,
  normalizeAutonomyKeys,
  normalizeResilienceKeys,
  normalizeGoalKeys,
} from './constants.js';
import {
  AgentMetadata,
  AgentState,
  ExecuteAgentResult,
  AgentGoalConfig,
  AgentGoalParameter,
  AgentMetadataV2,
  AgentGoal,
  DEFAULT_SAFETY_CONFIG,
  ExecutionContext,
  AutonomyDirective,
} from './types.js';
import { getGatheredData, type GatheredData } from './gatheredData.js';
import { evaluateAutonomy } from './autonomyEvaluator.js';
import {
  isV1Agent,
  convertV1ToV2,
} from './v1ToV2Converter.js';
import {
  determineSafetyTier,
  createVerificationChallenge,
  createConfirmationRequest,
  createDangerZoneOperation,
  createExecutionContext,
} from './safetyTierService.js';
import { BaseElementManager, ElementManagerDeps } from '../base/BaseElementManager.js';
import { isWritableStorageLayer } from '../../storage/IStorageLayer.js';
import { AGENT_STATE_MAX_YAML_SIZE, FileAgentStateStore } from '../../storage/FileAgentStateStore.js';
import type { IAgentStateStore } from '../../storage/IAgentStateStore.js';

/**
 * Minimal interface for an element manager resolved by name.
 * The resolver returns heterogeneous managers (PersonaManager, SkillManager, etc.)
 * — this captures the common surface needed by getElementContent().
 */
export interface ResolvedElementManager {
  list(): Promise<Array<{
    metadata: { name: string; [key: string]: unknown };
    content?: string;
    instructions?: string;
    getEntries?: () => unknown[];
    elements?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  }>>;
}

export interface AgentManagerDeps extends ElementManagerDeps {
  baseDir: string;
  stateStore?: IAgentStateStore;
  /** Issue #1948: Resolves any element manager by name (for element-agnostic activation). */
  elementManagerResolver?: (managerName: string) => ResolvedElementManager | null;
  /** Issue #1948: DangerZoneEnforcer for autonomy evaluation. */
  dangerZoneEnforcer?: import('./types.js').DangerZoneBlocker;
  /** Issue #1948: VerificationStore/ChallengeStore for danger zone verification codes. */
  verificationStore?: { set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) => void };
}
import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import { sanitizeInput, validatePath } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { InputNormalizer } from '../../security/InputNormalizer.js';
import { SafeRegex } from '../../security/dosProtection.js';
import { logger } from '../../utils/logger.js';
import { TriggerValidationService } from '../../services/validation/TriggerValidationService.js';
import { ValidationService } from '../../services/validation/ValidationService.js';
import { SerializationService } from '../../services/SerializationService.js';
import { MetadataService } from '../../services/MetadataService.js';
import { ElementMessages } from '../../utils/elementMessages.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { sanitizeGatekeeperPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';
import { SECURITY_LIMITS } from '../../security/constants.js';

const AGENT_FILE_EXTENSION = '.md';
const STATE_DIRECTORY = '.state';
const MAX_YAML_SIZE = AGENT_STATE_MAX_YAML_SIZE;
const MAX_FILE_SIZE = 100 * 1024;

// Issue #83: Centralized active element limits (configurable via env vars)
import { getActiveElementLimitConfig, getMaxActiveLimit } from '../../config/active-element-limits.js';

interface ElementCreationResult {
  success: boolean;
  message: string;
  element?: Agent;
}

type AgentCreateMetadata = (Partial<AgentMetadata> & Partial<AgentMetadataV2>) & {
  content?: string;
};

interface PreparedCreateInput {
  referenceContent: unknown;
  normalizedMetadata: Partial<AgentMetadataV2>;
}

interface SanitizedCreateInput {
  name: string;
  description: string;
  instructions: string;
}

interface ActivationResult {
  activeElements: Record<string, Array<{ name: string; content: string }>>;
  activationWarnings: Array<{ elementType: string; elementName: string; error: string }>;
}

export class AgentManager extends BaseElementManager<Agent> {
  private readonly stateCache: Map<string, AgentState> = new Map();
  private readonly stateStore: IAgentStateStore;
  private readonly hydratedAgents = new WeakSet<Agent>();
  private triggerValidationService: TriggerValidationService;
  private validationService: ValidationService;
  private serializationService: SerializationService;
  private metadataService: MetadataService;
  // Fallback for tests/callers that don't inject the registry
  private readonly _localActiveAgentNames: Set<string> = new Set();

  // Issue #1948: Instance-injected dependencies (replaces static resolvers)
  private _elementManagerResolver?: (managerName: string) => ResolvedElementManager | null;
  private _dangerZoneEnforcer?: import('./types.js').DangerZoneBlocker;
  private _verificationStore?: { set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) => void };
  private static warnedDbModeOrphanedStateFiles = false;

  constructor(deps: AgentManagerDeps) {
    const elementDirOverride = path.join(deps.baseDir, ElementType.AGENT);
    super(
      ElementType.AGENT,
      deps.portfolioManager,
      deps.fileLockManager,
      {
        elementDirOverride,
        eventDispatcher: deps.eventDispatcher,
        fileWatchService: deps.fileWatchService,
        memoryBudget: deps.memoryBudget,
        backupService: deps.backupService,
        backupServiceProvider: deps.backupServiceProvider,
        contextTracker: deps.contextTracker,
        activationRegistry: deps.activationRegistry,
        storageLayerFactory: deps.storageLayerFactory,
        getCurrentUserId: deps.getCurrentUserId,
        publicElementDiscovery: deps.publicElementDiscovery,
      },
      deps.fileOperationsService,
      deps.validationRegistry,
    );
    this.triggerValidationService = deps.validationRegistry.getTriggerValidationService();
    this.validationService = deps.validationRegistry.getValidationService();
    this.serializationService = deps.serializationService;
    this.metadataService = deps.metadataService;
    this.stateStore = deps.stateStore || this.createDefaultStateStore(deps);
    // Issue #1948: Instance-injected dependencies (replaces static resolvers)
    this._elementManagerResolver = deps.elementManagerResolver;
    this._dangerZoneEnforcer = deps.dangerZoneEnforcer;
    this._verificationStore = deps.verificationStore;
  }

  /**
   * State sidecars live under the active element directory. This must resolve
   * dynamically because HTTP sessions route elementDir to a per-user subtree.
   */
  private get stateDir(): string {
    return path.join(this.elementDir, STATE_DIRECTORY);
  }

  private createDefaultStateStore(deps: AgentManagerDeps): IAgentStateStore {
    return new FileAgentStateStore({
      stateDir: () => this.stateDir,
      fileLockManager: deps.fileLockManager,
      fileOperations: deps.fileOperationsService,
      serializationService: deps.serializationService,
      stateCache: this.stateCache,
      maxYamlSize: MAX_YAML_SIZE,
    });
  }

  /** Issue #1946: Per-session activation state via base class helper. */
  private getActivationSet(): Set<string> {
    return this.resolveActivationSet('agents', this._localActiveAgentNames);
  }

  protected override getElementLabel(): string {
    return 'agent';
  }

  /**
   * Issue #1948: Set element manager resolver on this instance.
   * Primarily for tests that need to configure after construction.
   */
  setElementManagerResolver(resolver: (managerName: string) => ResolvedElementManager | null): void {
    this._elementManagerResolver = resolver;
  }

  /** Issue #1948: Set DangerZoneEnforcer on this instance. */
  setDangerZoneEnforcerInstance(enforcer: import('./types.js').DangerZoneBlocker): void {
    this._dangerZoneEnforcer = enforcer;
  }

  /** Issue #1948: Set VerificationStore on this instance. */
  setVerificationStoreInstance(store: { set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) => void }): void {
    this._verificationStore = store;
  }

  /** @deprecated Issue #1948: Static resolvers removed. Use constructor injection. */
  public static resetResolvers(): void { /* no-op */ }

  /**
   * Prepare directory structure for agents and state files.
   */
  async initialize(): Promise<void> {
    await this.fileOperations.createDirectory(this.elementDir);
    await this.fileOperations.createDirectory(this.stateDir);
    logger.info('AgentManager initialized', { path: this.elementDir });
  }

  /**
   * Create a new agent on disk.
   */
  async create(
    name: string,
    description: string,
    content: string,
    metadata?: AgentCreateMetadata
  ): Promise<ElementCreationResult> {
    try {
      await this.initialize();
      const preparedInput = this.prepareCreateInput(metadata);
      const validationFailure = await this.validateAgentCreateInput(
        name,
        description,
        content,
        preparedInput
      );
      if (validationFailure) {
        return validationFailure;
      }

      const sanitizedInput = this.sanitizeAgentCreateInput(name, description, content);
      if (!this.validateElementName(sanitizedInput.name)) {
        return AgentManager.createFailure(
          'Invalid agent name. Use only letters, numbers, hyphens, and underscores.'
        );
      }

      const agent = this.buildAgentFromCreateInput(sanitizedInput, preparedInput.normalizedMetadata);
      const referenceFailure = this.assignReferenceContent(agent, preparedInput.referenceContent);
      if (referenceFailure) {
        return referenceFailure;
      }

      // Issue #727: Validate and normalize V2 fields BEFORE assignment.
      // This is the SECOND validation layer — AgentElementValidator (called above via
      // this.validator.validateCreate) is the first. The validator catches camelCase
      // invalid values; this method also normalizes snake_case keys (which the validator
      // doesn't see) and validates them. Both layers are needed. See Issue #730.
      const metadataV2 = preparedInput.normalizedMetadata;
      const v2Errors = this.validateV2FieldsForCreate(metadataV2);
      if (v2Errors.length > 0) {
        return AgentManager.createFailure(`V2 field validation failed: ${v2Errors.join('; ')}`);
      }

      // V2 FIELDS: Store V2-specific fields in agent metadata (not just extensions)
      // This enables V2 agent creation via MCP-AQL create_element operation
      this.assignV2MetadataFields(agent, metadataV2);

      // Issue #613: Check metadata name uniqueness (not just filename)
      const existingAgents = await this.list();
      const duplicate = existingAgents.find(a =>
        a.metadata.name.toLowerCase() === sanitizedInput.name.toLowerCase()
      );
      if (duplicate) {
        return {
          success: false,
          message: `Agent '${sanitizedInput.name}' already exists`
        };
      }

      // Save through the standard pipeline with exclusive flag for atomic create-or-fail.
      // In file mode, this uses createFileExclusive (wx flag) to prevent TOCTOU races.
      // In DB mode, the storage layer does a plain INSERT and converts the 23505 unique-
      // constraint violation into an "already exists" error. The duplicate check above via
      // list() catches the common case; exclusive handles concurrent-create races.
      await this.save(agent, this.getFilename(sanitizedInput.name), { exclusive: true });

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'AgentManager.create',
        details: `Agent '${sanitizedInput.name}' created`,
        additionalData: { agentId: agent.id }
      });

      return {
        success: true,
        message: `🤖 **${sanitizedInput.name}** by ${agent.metadata.author || 'anonymous'}`,
        element: agent
      };
    } catch (error) {
      logger.error('Failed to create agent', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create agent'
      };
    }
  }

  private static createFailure(message: string): ElementCreationResult {
    return { success: false, message };
  }

  private prepareCreateInput(metadata?: AgentCreateMetadata): PreparedCreateInput {
    // Strip 'content' from metadata to prevent it from overwriting the positional
    // content param, which is the agent's behavioral instructions text.
    const { content: referenceContent, ...metadataWithoutContent } = metadata ?? {};
    const normalizedMetadata: Partial<AgentMetadataV2> = {
      ...metadataWithoutContent
    };
    if (metadata?.goal !== undefined) {
      normalizedMetadata.goal = this.normalizeGoalInput(
        metadata.goal as string | Partial<AgentGoalConfig>
      );
    }
    return { referenceContent, normalizedMetadata };
  }

  private async validateAgentCreateInput(
    name: string,
    description: string,
    content: string,
    preparedInput: PreparedCreateInput
  ): Promise<ElementCreationResult | null> {
    const validationInput: Record<string, unknown> = {
      name,
      description,
      ...preparedInput.normalizedMetadata,
      content: this.getPrimaryValidationText(content, preparedInput.referenceContent) ?? '',
    };
    const validationResult = await this.validator.validateCreate(validationInput);

    if (!validationResult.isValid) {
      return AgentManager.createFailure(`Validation failed: ${validationResult.errors.join(', ')}`);
    }
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Agent creation warnings: ${validationResult.warnings.join(', ')}`);
    }
    return null;
  }

  private sanitizeAgentCreateInput(
    name: string,
    description: string,
    content: string
  ): SanitizedCreateInput {
    const contentValidation = ContentValidator.validateAndSanitize(
      content,
      { maxLength: SECURITY_LIMITS.MAX_CONTENT_LENGTH, contentContext: 'agent' }
    );
    return {
      name: sanitizeInput(UnicodeValidator.normalize(name).normalizedContent, 100),
      description: sanitizeInput(UnicodeValidator.normalize(description).normalizedContent, 500),
      instructions: contentValidation.sanitizedContent || '',
    };
  }

  private buildAgentFromCreateInput(
    sanitizedInput: SanitizedCreateInput,
    normalizedMetadata: Partial<AgentMetadataV2>
  ): Agent {
    const agent = new Agent({
      ...normalizedMetadata,
      name: sanitizedInput.name,
      description: sanitizedInput.description
    }, this.metadataService);

    agent.metadata.author = normalizedMetadata.author ?? this.getCurrentUserForAttribution();
    agent.extensions = {
      ...agent.extensions,
      specializations: normalizedMetadata.specializations ?? agent.extensions?.specializations ?? [],
      decisionFramework: normalizedMetadata.decisionFramework ?? agent.extensions?.decisionFramework,
      riskTolerance: normalizedMetadata.riskTolerance ?? agent.extensions?.riskTolerance,
      learningEnabled: normalizedMetadata.learningEnabled ?? agent.extensions?.learningEnabled,
    };
    agent.instructions = sanitizedInput.instructions;
    agent.extensions.instructions = sanitizedInput.instructions;
    return agent;
  }

  private assignReferenceContent(agent: Agent, referenceContent: unknown): ElementCreationResult | null {
    if (typeof referenceContent !== 'string' || referenceContent.trim().length === 0) {
      return null;
    }

    const contentValidationResult = ContentValidator.validateAndSanitize(
      referenceContent,
      { maxLength: SECURITY_LIMITS.MAX_CONTENT_LENGTH, contentContext: 'agent' }
    );
    if (!contentValidationResult.isValid) {
      return AgentManager.createFailure(
        `Validation failed: ${(contentValidationResult.detectedPatterns || ['Content validation failed']).join(', ')}`
      );
    }
    agent.content = contentValidationResult.sanitizedContent || '';
    return null;
  }

  private assignV2MetadataFields(agent: Agent, metadataV2: Partial<AgentMetadataV2>): void {
    const target = agent.metadata as AgentMetadataV2;
    if (metadataV2.goal) target.goal = metadataV2.goal;
    if (metadataV2.activates) target.activates = metadataV2.activates;
    if (metadataV2.tools) target.tools = metadataV2.tools;
    if (metadataV2.systemPrompt) target.systemPrompt = metadataV2.systemPrompt;
    if (metadataV2.autonomy) target.autonomy = metadataV2.autonomy;
    if (metadataV2.gatekeeper) target.gatekeeper = metadataV2.gatekeeper;
    if (metadataV2.resilience) target.resilience = metadataV2.resilience;
  }

  /**
   * Read an agent by name (without extension).
   *
   * @param name - Agent name (without extension)
   * @returns Agent instance or null if not found
   */
  async read(name: string): Promise<Agent | null> {
    try {
      const sanitizedName = sanitizeInput(name, 100);
      // Use findByName — consults the storage-layer index (name → UUID in DB
      // mode, name → filename in file mode) instead of assuming a filename
      // shape. Passing a filename straight to load() breaks in DB mode where
      // load expects the element UUID, not a ".md" path.
      const found = await this.findByName(sanitizedName);
      if (found) {
        await this.ensureStateHydrated(found);
        return found;
      }
      // Fallback: flexible matching via list scan (#607) — for legacy files
      // whose on-disk name diverges from their metadata name.
      const flexible = await this.readFlexibly(name);
      if (flexible) {
        await this.ensureStateHydrated(flexible);
      }
      return flexible;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const flexible = await this.readFlexibly(name);
        if (flexible) {
          await this.ensureStateHydrated(flexible);
        }
        return flexible;
      }
      throw error;
    }
  }

  /**
   * Fallback for read() when direct file lookup fails.
   * Searches loaded agents by metadata name using case-insensitive and slug matching.
   * Logs a warning when a match is found (indicates filename/name mismatch needing cleanup).
   *
   * @example
   * // File on disk: "legacy-poster-agent.md"
   * // Metadata name: "legacy-poster"
   * // Direct lookup for "legacy-poster.md" fails (ENOENT)
   * // Flexible fallback matches via metadata name:
   * const agent = await read("legacy-poster"); // resolves via fallback
   */
  private async readFlexibly(name: string): Promise<Agent | null> {
    try {
      const agents = await this.list();
      if (agents.length === 0) return null;

      const searchLower = name.toLowerCase();
      const searchSlug = this.normalizeFilename(name);

      // Pass 1: exact case-insensitive match on metadata name
      let match = agents.find(
        (a) => a.metadata.name.toLowerCase() === searchLower
      );

      // Pass 2: slug match (handles dashes, underscores, casing differences)
      if (!match) {
        match = agents.find((a) => {
          const slug = this.normalizeFilename(a.metadata.name);
          return slug === searchSlug || slug === searchLower;
        });
      }

      if (match) {
        logger.warn(
          `Agent "${name}" resolved via flexible matching to file with metadata name "${match.metadata.name}". ` +
          `Consider renaming the file to match the expected convention (#607).`
        );
      }

      return match ?? null;
    } catch (listError) {
      logger.debug(`Flexible agent lookup failed for "${name}": ${listError}`);
      return null;
    }
  }

  /**
   * Update metadata/content for an existing agent.
   */
  async update(
    name: string,
    updates: Partial<AgentMetadata>,
    content?: string
  ): Promise<boolean> {
    const sanitizedName = sanitizeInput(name, 100);
    const agent = await this.read(sanitizedName);
    if (!agent) {
      logger.warn(`Agent not found for update: ${name}`);
      return false;
    }

    // Use specialized validator for edit validation
    const validationResult = await this.validator.validateEdit(agent, {
      ...updates,
      content
    });

    if (!validationResult.isValid) {
      logger.error(`Agent update validation failed: ${validationResult.errors.join(', ')}`);
      return false;
    }

    // Log warnings if any
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Agent update warnings: ${validationResult.warnings.join(', ')}`);
    }

    if (updates.description !== undefined) {
      agent.metadata.description = sanitizeInput(
        UnicodeValidator.normalize(updates.description).normalizedContent,
        500
      );
    }

    if (updates.specializations !== undefined) {
      agent.extensions = {
        ...agent.extensions,
        specializations: updates.specializations.map(item => sanitizeInput(item, 50))
      };
    }

    if (updates.decisionFramework !== undefined) {
      agent.extensions = {
        ...agent.extensions,
        decisionFramework: updates.decisionFramework
      };
    }

    if (updates.riskTolerance !== undefined) {
      agent.extensions = {
        ...agent.extensions,
        riskTolerance: updates.riskTolerance
      };
    }

    if (updates.learningEnabled !== undefined) {
      agent.extensions = {
        ...agent.extensions,
        learningEnabled: updates.learningEnabled
      };
    }

    if (updates.maxConcurrentGoals !== undefined) {
      agent.metadata.maxConcurrentGoals = updates.maxConcurrentGoals;
    }

    agent.metadata.modified = new Date().toISOString();

    if (content !== undefined) {
      // Use ContentValidator for multi-line content to preserve formatting (newlines, tabs)
      // while still detecting prompt injection attacks
      const contentValidation = ContentValidator.validateAndSanitize(content, { maxLength: SECURITY_LIMITS.MAX_CONTENT_LENGTH, contentContext: 'agent' });
      agent.extensions = {
        ...agent.extensions,
        instructions: contentValidation.sanitizedContent || ''
      };
    }

    await this.save(agent, this.getFilename(sanitizedName));
    logger.info(`Agent updated: ${sanitizedName}`);
    return true;
  }

  /**
   * Validate a provided agent name.
   */
  validateName(name: string): { valid: boolean; error?: string } {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'Name cannot be empty' };
    }

    if (name.length > 100) {
      return { valid: false, error: 'Name cannot exceed 100 characters' };
    }

    if (!this.validateElementName(name)) {
      return {
        valid: false,
        error: 'Name can only contain letters, numbers, hyphens, and underscores'
      };
    }

    return { valid: true };
  }

  /**
   * Import an agent from serialized content.
   */
  async importElement(data: string, format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<Agent> {
    if (format === 'json') {
      const parsed = this.serializationService.parseJson(data, {
        source: 'AgentManager.importElement'
      });
      const agent = new Agent(parsed.metadata, this.metadataService);
      if (parsed.state) {
        agent.deserialize(JSON.stringify(parsed));
      }
      agent.extensions = {
        ...agent.extensions,
        instructions: parsed.instructions || ''
      };
      return agent;
    }

    // Use SerializationService for frontmatter parsing
    const result = this.serializationService.parseFrontmatter(data, {
      maxYamlSize: MAX_YAML_SIZE,
      validateContent: false,
      source: 'AgentManager.importElement'
    });

    const agent = new Agent(result.data as AgentMetadata, this.metadataService);
    agent.extensions = {
      ...agent.extensions,
      instructions: result.content.trim()
    };
    return agent;
  }

  /**
   * Export an agent to JSON or markdown (default).
   */
  async exportElement(agent: Agent, format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<string> {
    if (format === 'json') {
      return agent.serializeToJSON();
    }

    return this.serializeElement(agent);
  }

  /**
   * Load an agent, then hydrate its runtime state from the .state.yaml sidecar.
   *
   * Delegates the read/parse/cache pipeline to super.load() so we inherit the
   * base class's DB/file branching, invalidElements tracking (Issue #708),
   * load-error event emission, and suppressed-repeat-error dedup. Agent-specific
   * work (path normalization, size guard, state hydration) runs around it.
   */
  override async load(filePath: string): Promise<Agent> {
    const sanitizedInput = sanitizeInput(filePath, 255);

    // DB mode: the storage layer indexes by UUID, not filesystem path. Pass the
    // input through unchanged — appending `.md` or running file-system path
    // validation would yield `UUID.md` that the DB storage layer can't match.
    if (isWritableStorageLayer(this.storageLayer)) {
      return super.load(sanitizedInput);
    }

    const relativePath = sanitizedInput.endsWith(AGENT_FILE_EXTENSION)
      ? sanitizedInput
      : this.getFilename(sanitizeInput(sanitizedInput, 100));

    // Agent-specific path validation (defense-in-depth on top of base normalization).
    try {
      validatePath(relativePath, this.elementDir);
    } catch (error) {
      logger.error(`Invalid agent path: ${error}`);
      throw new Error(`Invalid agent path: ${error instanceof Error ? error.message : 'Invalid path'}`);
    }

    return super.load(relativePath);
  }

  /**
   * Agent-specific content parser.
   *
   * Uses SerializationService.parseFrontmatter (strict) rather than the base
   * class's SecureYamlParser.safeMatter (lenient). Agents require the file to
   * contain a YAML object at the frontmatter position; SerializationService
   * throws "YAML must contain an object" when the content is malformed — a
   * diagnostic we want to preserve for operators and callers.
   */
  protected override parseContent(content: string): { data: Record<string, unknown>; content: string } {
    if (content.length > MAX_FILE_SIZE) {
      throw new Error(`Agent file exceeds maximum size of ${MAX_FILE_SIZE} bytes`);
    }
    const result = this.serializationService.parseFrontmatter(content, {
      maxYamlSize: MAX_YAML_SIZE,
      validateContent: false,
      source: 'AgentManager.parseContent',
    });
    return {
      data: result.data as Record<string, unknown>,
      content: result.content.trim(),
    };
  }

  /**
   * Post-load hook: hydrate runtime state from the .state.yaml sidecar
   * (DB-mode state persistence lands in a later Phase 4 step). Size is
   * enforced in parseContent, which runs before this hook.
   */
  protected override async afterLoad(
    agent: Agent,
    filePath: string,
  ): Promise<void> {
    if (isWritableStorageLayer(this.storageLayer)) {
      await this.warnOnceForDbModeOrphanedStateFiles();
    } else {
      await this.hydrateAgentState(agent, this.stripExtension(filePath));
    }

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_LOADED',
      severity: 'LOW',
      source: `${this.constructor.name}.afterLoad`,
      details: `${this.getElementLabelCapitalized()} loaded: ${agent.metadata.name} v${agent.metadata.version || 'unknown'}`,
      additionalData: {
        agentId: agent.id,
        agentName: agent.metadata.name,
        version: agent.metadata.version,
        author: agent.metadata.author,
      }
    });
  }

  /**
   * Override BaseElementManager.save to persist state when required.
   */
  override async save(agent: Agent, filePath: string, options?: { exclusive?: boolean }): Promise<void> {
    // In DB mode, filePath is a UUID — pass it through unchanged. Appending
    // `.md` would break storage-layer lookups which index by UUID, not path.
    // In file mode, normalize to a `<name>.md` filename for on-disk storage.
    const isDb = isWritableStorageLayer(this.storageLayer);
    const sanitizedPath = isDb
      ? sanitizeInput(filePath, 255)
      : this.normalizeAgentFilePath(filePath);

    await super.save(agent, sanitizedPath, options);

    // State persistence uses the agent's logical name (not path/UUID) so that
    // .state.yaml sidecar files stay stable across file/DB mode.
    if (agent.needsStatePersistence()) {
      const stateName = isDb
        ? agent.metadata.name
        : this.stripExtension(sanitizedPath);
      const newVersion = await this.saveAgentState(agent, stateName, agent.getState());
      agent[COMMIT_PERSISTED_VERSION](newVersion);  // Sync agent's internal version (Issue #123 fix)
      agent.markStatePersisted();
      this.hydratedAgents.add(agent);
    }
  }

  /**
   * Persist agent state to disk (public API for external callers).
   *
   * This method is the proper way for external code (strategies, handlers) to
   * trigger state persistence. It implements the Option C pattern from Issue #123:
   * stateVersion is only incremented on successful save.
   *
   * @param name - Agent name
   * @returns Promise<boolean> - True if state was persisted, false if not needed
   * @throws Error if agent not found or save fails
   */
  async persistState(name: string): Promise<boolean> {
    const agent = await this.read(name);
    if (!agent) {
      throw new Error(`Agent not found: ${name}`);
    }

    if (!agent.needsStatePersistence()) {
      return false;
    }

    const newVersion = await this.saveAgentState(agent, name, agent.getState());
    agent[COMMIT_PERSISTED_VERSION](newVersion);
    agent.markStatePersisted();
    this.hydratedAgents.add(agent);
    return true;
  }

  /**
   * Override delete to remove associated state file.
   *
   * FIX: Uses normalizeFilename() to ensure state file deletion matches
   * the normalized filename used for state file creation/loading.
   */
  override async delete(filePath: string): Promise<void> {
    // DB mode: filePath is a UUID, don't force `.md` extension.
    const isDb = isWritableStorageLayer(this.storageLayer);
    const sanitizedPath = isDb
      ? sanitizeInput(filePath, 255)
      : this.normalizeAgentFilePath(filePath);
    // State-file name derives from the agent's logical name in DB mode, or
    // from the stripped filename in file mode.
    const existing = await this.load(sanitizedPath).catch(() => null);
    const name = isDb
      ? existing?.metadata.name ?? sanitizedPath
      : this.stripExtension(sanitizedPath);
    const agentElementId = isDb ? sanitizedPath : existing?.id ?? sanitizedPath;
    await super.delete(sanitizedPath);

    await this.stateStore.delete({ name, agentElementId });
  }

  private normalizeAgentFilePath(filePath: string): string {
    return filePath.endsWith(AGENT_FILE_EXTENSION)
      ? sanitizeInput(filePath, 255)
      : this.getFilename(sanitizeInput(filePath, 100));
  }

  override async exists(filePath: string): Promise<boolean> {
    // DB mode: the storage layer looks up by UUID or name via its index, not by
    // filename. Pass through unchanged.
    if (isWritableStorageLayer(this.storageLayer)) {
      return super.exists(sanitizeInput(filePath, 255));
    }
    const sanitizedPath = filePath.endsWith(AGENT_FILE_EXTENSION)
      ? sanitizeInput(filePath, 255)
      : this.getFilename(sanitizeInput(filePath, 100));
    return super.exists(sanitizedPath);
  }

  override validatePath(targetPath: string): boolean {
    if (targetPath.includes('..') || targetPath.includes('~')) {
      return false;
    }
    if (targetPath.startsWith('/') || /^[A-Za-z]:/.test(targetPath)) {
      return false;
    }
    return true;
  }

  getFileExtension(): string {
    return AGENT_FILE_EXTENSION;
  }

  /**
   * Override list to apply active status based on activeAgentNames set
   */
  override async list(options?: { includePublic?: boolean }): Promise<Agent[]> {
    const agents = await super.list(options);

    // Apply active status to agents that are in the active set (by name)
    for (const agent of agents) {
      if (this.getActivationSet().has(agent.metadata.name)) {
        // Activate the agent to set status to ACTIVE
        await agent.activate();
      }
    }

    return agents;
  }

  /**
   * Activate an agent by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   * Issue #24 (LOW PRIORITY): Cleanup trigger for memory leak prevention
   */
  async activateAgent(identifier: string): Promise<{ success: boolean; message: string; agent?: Agent }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const agent = await this.findByName(identifier);

    if (!agent) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.AGENT, identifier)
      };
    }

    // MEMORY LEAK FIX: Check if cleanup is needed before adding
    this.checkAndCleanupActiveSet();

    // Add to active set (by name, which is stable across reloads)
    this.getActivationSet().add(agent.metadata.name);

    // Update agent status in memory
    await agent.activate();

    SecurityMonitor.logSecurityEvent({
      type: 'AGENT_ACTIVATED',
      severity: 'LOW',
      source: 'AgentManager.activateAgent',
      details: `Agent activated: ${agent.metadata.name} v${agent.metadata.version || 'unknown'}`,
      additionalData: {
        agentId: agent.id,
        agentName: agent.metadata.name,
        version: agent.metadata.version,
        author: agent.metadata.author,
        goalCount: (agent.metadata as any).goal?.parameters?.length || 0,
        specializations: agent.metadata.specializations,
      }
    });

    logger.info(`Agent activated: ${agent.metadata.name}`);

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.activated(ElementType.AGENT, agent.metadata.name),
      agent
    };
  }

  /**
   * Deactivate an agent by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   */
  async deactivateAgent(identifier: string): Promise<{ success: boolean; message: string }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const agent = await this.findByName(identifier);

    if (!agent) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.AGENT, identifier)
      };
    }

    // Remove from active set
    this.getActivationSet().delete(agent.metadata.name);

    // Update agent status in memory
    await agent.deactivate();

    SecurityMonitor.logSecurityEvent({
      type: 'AGENT_DEACTIVATED',
      severity: 'LOW',
      source: 'AgentManager.deactivateAgent',
      details: `Agent deactivated: ${agent.metadata.name} v${agent.metadata.version || 'unknown'}`,
      additionalData: {
        agentId: agent.id,
        agentName: agent.metadata.name,
        version: agent.metadata.version,
        author: agent.metadata.author,
      }
    });

    logger.info(`Agent deactivated: ${agent.metadata.name}`);

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.deactivated(ElementType.AGENT, agent.metadata.name)
    };
  }

  /**
   * Get all active agents
   */
  async getActiveAgents(): Promise<Agent[]> {
    const agents = await this.list();
    return agents.filter(a => this.getActivationSet().has(a.metadata.name));
  }

  /**
   * Execute an agent with goal parameters
   *
   * Returns context for LLM to drive the agentic loop.
   * This method:
   * 1. Loads the agent configuration
   * 2. Validates and renders the goal template with parameters
   * 3. Activates configured elements (element-agnostic)
   * 4. Evaluates programmatic constraints and risk
   * 5. Returns structured context for LLM
   *
   * The LLM then drives the agentic loop using this context.
   *
   * @since v2.0.0 - Agentic Loop Redesign
   */
  async executeAgent(
    name: string,
    parameters: Record<string, unknown>,
    // Thread the triggering MCP lifecycle op through validation so error messages
    // can distinguish a fresh execute_agent call from a misused continue_execution.
    context: {
      operationName?: 'execute_agent' | 'continue_execution';
    } = {}
  ): Promise<ExecuteAgentResult> {
    try {
      const agent = await this.loadExecutableAgent(name);
      const metadata = agent.metadata as AgentMetadataV2;

      // 2. Clone parameters to prevent mutation of caller's object (Issue #118)
      const clonedParameters = structuredClone(parameters);
      this.validateExecutionParameters(metadata.goal, clonedParameters, {
        agentName: name,
        operationName: context.operationName ?? 'execute_agent',
      });
      const renderedGoal = this.renderGoalTemplate(metadata.goal.template, clonedParameters);
      const unmatchedPlaceholders = this.detectUnmatchedPlaceholders(renderedGoal);
      this.logUnmatchedPlaceholders(name, unmatchedPlaceholders);
      const executionContext = createExecutionContext(name);
      await this.assertNoStaticActivationCycle(name, metadata);

      const activationResult = await this.activateAgentElements(name, metadata, executionContext);
      const result = this.createExecuteAgentResult(
        name,
        renderedGoal,
        metadata,
        unmatchedPlaceholders,
        activationResult
      );
      const newGoal = await this.persistExecutionGoal(agent, name, renderedGoal, result);
      this.populateExecutionAnalysis(agent, newGoal, renderedGoal, result);
      this.applySafetyTier(renderedGoal, executionContext, result);
      const safetyTierResult = result.safetyTierResult;

      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_EXECUTED',
        severity: 'LOW',
        source: 'AgentManager.executeAgent',
        details: `Agent executed: ${name} v${agent.metadata.version || 'unknown'} (safety: ${result.safetyTier})`,
        additionalData: {
          agentId: agent.id,
          agentName: name,
          version: agent.metadata.version,
          author: agent.metadata.author,
          safetyTier: result.safetyTier,
          riskScore: safetyTierResult?.riskScore,
          parameterKeys: Object.keys(parameters || {}),
          goalCount: metadata.goal?.parameters?.length || 0,
        }
      });

      return result;
    } catch (error) {
      logger.error(`Failed to execute agent '${name}':`, error);
      throw error;
    }
  }

  private async loadExecutableAgent(name: string): Promise<Agent> {
    const agent = await this.read(name);
    if (!agent) {
      throw new ElementNotFoundError('Agent', name);
    }

    const metadata = agent.metadata as AgentMetadataV2;
    if (metadata.goal?.template) {
      return agent;
    }
    await this.convertLegacyAgentForExecution(agent, name, metadata);
    return agent;
  }

  private async convertLegacyAgentForExecution(
    agent: Agent,
    name: string,
    metadata: AgentMetadataV2
  ): Promise<void> {
    if (!isV1Agent(metadata)) {
      throw new Error(
        `Agent '${name}' is not a v2.0 agent. Missing goal.template configuration.`
      );
    }

    const conversionResult = convertV1ToV2(metadata, agent.extensions?.instructions || '');
    if (!conversionResult.converted) {
      throw new Error(
        `Agent '${name}' cannot be executed: missing goal.template and conversion failed.`
      );
    }

    Object.assign(metadata, conversionResult.metadata);
    Object.assign(agent.metadata, conversionResult.metadata);
    if (conversionResult.warnings.length > 0) {
      logger.warn(`Agent '${name}' auto-converted from V1 to V2 in place`, {
        warnings: conversionResult.warnings,
      });
    }
    await this.save(agent, this.getFilename(sanitizeInput(name, 100)));
    logger.info(`Agent '${name}' converted from V1 to V2 and saved in place`);
  }

  private validateExecutionParameters(
    goal: AgentGoalConfig,
    parameters: Record<string, unknown>,
    context: {
      agentName?: string;
      operationName?: 'execute_agent' | 'continue_execution';
    }
  ): void {
    this.validateParameterSecurity(parameters);
    this.validateParameters(goal, parameters, context);
  }

  private logUnmatchedPlaceholders(name: string, unmatchedPlaceholders: string[]): void {
    if (unmatchedPlaceholders.length === 0) {
      return;
    }
    logger.warn('Unmatched template placeholders detected after rendering', {
      agentName: name,
      unmatched: unmatchedPlaceholders,
    });
  }

  private async assertNoStaticActivationCycle(
    name: string,
    metadata: AgentMetadataV2
  ): Promise<void> {
    if (!metadata.activates?.agents?.length) {
      return;
    }
    const cyclePath = await this.detectActivationCycles(name, metadata.activates.agents);
    if (!cyclePath) {
      return;
    }
    const cycleStart = cyclePath.indexOf(cyclePath[cyclePath.length - 1]);
    const cycle = cyclePath.slice(cycleStart);
    throw new Error(AgentManager.formatCircularActivationError(cycle));
  }

  private async activateAgentElements(
    agentName: string,
    metadata: AgentMetadataV2,
    executionContext: ExecutionContext
  ): Promise<ActivationResult> {
    const result: ActivationResult = { activeElements: {}, activationWarnings: [] };
    if (!metadata.activates) {
      return result;
    }

    for (const [elementType, elementNames] of Object.entries(metadata.activates)) {
      await this.activateElementGroup(agentName, elementType, elementNames, executionContext, result);
    }
    return result;
  }

  private async activateElementGroup(
    agentName: string,
    elementType: string,
    elementNames: string[] | undefined,
    executionContext: ExecutionContext,
    result: ActivationResult
  ): Promise<void> {
    if (!elementNames || elementNames.length === 0) {
      return;
    }

    result.activeElements[elementType] = [];
    for (const elementName of elementNames) {
      await this.activateSingleElement(agentName, elementType, elementName, executionContext, result);
    }
  }

  private async activateSingleElement(
    agentName: string,
    elementType: string,
    elementName: string,
    executionContext: ExecutionContext,
    result: ActivationResult
  ): Promise<void> {
    try {
      const elementContent = await this.getElementContent(elementType, elementName, executionContext);
      result.activeElements[elementType].push({ name: elementName, content: elementContent });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Circular agent activation detected')) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.activationWarnings.push({ elementType, elementName, error: errorMessage });
      logger.warn(`Agent '${agentName}': failed to activate ${elementType} '${elementName}' — ${errorMessage}`);
    }
  }

  private createExecuteAgentResult(
    name: string,
    renderedGoal: string,
    metadata: AgentMetadataV2,
    unmatchedPlaceholders: string[],
    activationResult: ActivationResult
  ): ExecuteAgentResult {
    return {
      agentName: name,
      goal: renderedGoal,
      activeElements: activationResult.activeElements,
      activationWarnings: activationResult.activationWarnings.length > 0
        ? activationResult.activationWarnings
        : undefined,
      templateWarnings: unmatchedPlaceholders.length > 0
        ? unmatchedPlaceholders.map(p => `Unmatched template placeholder: {${p}}`)
        : undefined,
      availableTools: metadata.tools?.allowed || [],
      successCriteria: metadata.goal.successCriteria || [],
      systemPrompt: metadata.systemPrompt,
      safetyTier: 'advisory',
    };
  }

  private async persistExecutionGoal(
    agent: Agent,
    name: string,
    renderedGoal: string,
    result: ExecuteAgentResult
  ): Promise<AgentGoal> {
    const newGoal = agent.addGoal({
      description: renderedGoal,
      priority: 'medium',
      importance: 5,
      urgency: 5,
    });
    newGoal.status = 'in_progress';
    await this.save(agent, this.getFilename(sanitizeInput(name, 100)));

    result.goalId = newGoal.id;
    result.stateVersion = agent.getState().stateVersion || 1;
    return newGoal;
  }

  private populateExecutionAnalysis(
    agent: Agent,
    newGoal: AgentGoal,
    renderedGoal: string,
    result: ExecuteAgentResult
  ): void {
    const securityValidation = agent.validateGoalSecurity(renderedGoal);
    if (securityValidation.warnings && securityValidation.warnings.length > 0) {
      result.securityWarnings = securityValidation.warnings;
    }
    result.constraints = agent.evaluateConstraints(newGoal);
    result.riskAssessment = agent.assessRisk('execute', newGoal, {});
    result.priorityScore = agent.calculatePriorityScore(newGoal);
  }

  private applySafetyTier(
    renderedGoal: string,
    executionContext: ExecutionContext,
    result: ExecuteAgentResult
  ): void {
    const safetyTierResult = determineSafetyTier(
      result.riskAssessment?.score || 0,
      result.securityWarnings || [],
      renderedGoal,
      DEFAULT_SAFETY_CONFIG,
      executionContext
    );

    result.safetyTier = safetyTierResult.tier;
    result.safetyTierResult = safetyTierResult;
    result.executionContext = executionContext;
    this.applySafetyTierResponse(safetyTierResult, result);
  }

  private applySafetyTierResponse(
    safetyTierResult: ReturnType<typeof determineSafetyTier>,
    result: ExecuteAgentResult
  ): void {
    switch (safetyTierResult.tier) {
      case 'confirm':
        result.confirmationRequired = createConfirmationRequest(
          'Operation requires confirmation',
          safetyTierResult.factors
        );
        break;
      case 'verify':
        result.verificationRequired = createVerificationChallenge(
          safetyTierResult.factors.join('; '),
          'display_code'
        );
        break;
      case 'danger_zone':
        result.dangerZoneBlocked = createDangerZoneOperation(
          'agent_execution',
          safetyTierResult.factors.join('; '),
          DEFAULT_SAFETY_CONFIG.dangerZone.enabled
        );
        if (!result.dangerZoneBlocked.blocked) {
          result.verificationRequired = result.dangerZoneBlocked.verificationRequired;
        }
        break;
      case 'advisory':
      default:
        break;
    }
  }

  /**
   * Security validation for template parameters (Issue #103).
   * Checks for prototype pollution, Unicode injection, and oversized payloads.
   * Must be called BEFORE template rendering.
   * @private
   */
  private validateParameterSecurity(parameters: Record<string, unknown>): void {
    // 1. Prototype pollution check — reject dangerous keys
    const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
    for (const key of Object.keys(parameters)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_VALIDATION_FAILURE',
          severity: 'HIGH',
          source: 'AgentManager.validateParameterSecurity',
          details: `Prototype pollution attempt via parameter key: '${key}'`,
        });
        throw new Error(`Forbidden parameter key: '${key}' (potential prototype pollution)`);
      }
    }

    // 2. Limit parameter count to prevent resource exhaustion
    const MAX_PARAMETERS = 50;
    if (Object.keys(parameters).length > MAX_PARAMETERS) {
      throw new Error(`Too many parameters: ${Object.keys(parameters).length} exceeds maximum of ${MAX_PARAMETERS}`);
    }

    // 3. Unicode normalization via InputNormalizer
    const normalized = InputNormalizer.normalize(parameters, '$.parameters');
    if (normalized.hasHighOrCriticalIssues) {
      throw new Error(
        `Template parameter security validation failed: ${normalized.errors.join('; ')}`
      );
    }

    // Apply normalized values back (in-place, since we already cloned)
    const normalizedData = normalized.data;
    for (const [key, value] of Object.entries(normalizedData)) {
      parameters[key] = value;
    }

    if (normalized.warnings.length > 0) {
      logger.warn('Template parameter normalization warnings', {
        warnings: normalized.warnings,
      });
    }
  }

  /**
   * Validate parameters against goal parameter schema
   * @private
   */
  private validateParameters(
    goalConfig: AgentGoalConfig,
    parameters: Record<string, unknown>,
    context: {
      agentName?: string;
      operationName?: 'execute_agent' | 'continue_execution';
    } = {}
  ): void {
    const paramDefs = goalConfig.parameters || [];
    this.assertRequiredParametersPresent(paramDefs, parameters, context);
    for (const [key, value] of Object.entries(parameters)) {
      this.validateProvidedParameter(key, value, paramDefs);
    }
    this.applyParameterDefaults(paramDefs, parameters);
  }

  private assertRequiredParametersPresent(
    paramDefs: AgentGoalParameter[],
    parameters: Record<string, unknown>,
    context: {
      agentName?: string;
      operationName?: 'execute_agent' | 'continue_execution';
    }
  ): void {
    const requiredParamNames = paramDefs
      .filter(paramDef => paramDef.required)
      .map(paramDef => paramDef.name);
    const missingRequired = requiredParamNames.filter(paramName => !(paramName in parameters));
    if (missingRequired.length === 0) {
      return;
    }
    throw new Error(
      this.formatMissingRequiredParametersError(
        missingRequired,
        requiredParamNames,
        context
      )
    );
  }

  private validateProvidedParameter(
    key: string,
    value: unknown,
    paramDefs: AgentGoalParameter[]
  ): void {
    const paramDef = paramDefs.find(p => p.name === key);
    if (!paramDef) {
      logger.warn(`Unknown parameter '${key}' provided to agent`);
      return;
    }

    const actualType = typeof value;
    if (
      (paramDef.type === 'string' || paramDef.type === 'number' || paramDef.type === 'boolean') &&
      paramDef.type !== actualType
    ) {
      throw new Error(`Parameter '${key}' must be a ${paramDef.type}, got ${actualType}`);
    }
    this.warnForOversizedStringParameter(key, value, actualType);
  }

  private warnForOversizedStringParameter(key: string, value: unknown, actualType: string): void {
    if (actualType !== 'string' || (value as string).length <= AGENT_LIMITS.MAX_GOAL_LENGTH) {
      return;
    }
    logger.warn('Parameter string value exceeds MAX_GOAL_LENGTH (advisory)', {
      paramName: key,
      valueLength: (value as string).length,
      maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH,
    });
  }

  private applyParameterDefaults(
    paramDefs: AgentGoalParameter[],
    parameters: Record<string, unknown>
  ): void {
    for (const paramDef of paramDefs) {
      if (!paramDef.required && !(paramDef.name in parameters) && paramDef.default !== undefined) {
        parameters[paramDef.name] = paramDef.default;
      }
    }
  }

  /**
   * Build an actionable missing-parameter error for execute/continue calls.
   * @private
   */
  private formatMissingRequiredParametersError(
    missingRequired: string[],
    requiredParamNames: string[],
    context: {
      agentName?: string;
      operationName?: 'execute_agent' | 'continue_execution';
    }
  ): string {
    const agentSuffix = context.agentName ? ` for agent '${context.agentName}'` : '';
    let message =
      `Missing required parameters${agentSuffix}: ${missingRequired.join(', ')}.`;

    if (requiredParamNames.length > 0) {
      message += ` Required goal parameters: ${requiredParamNames.join(', ')}.`;
    }

    message += ' Discover the full execution contract via mcp_aql_read introspect: ' +
      '{ operation: "introspect", params: { query: "operations", name: "execute_agent" } }.';

    if (context.operationName === 'continue_execution') {
      message += ' If you are reporting progress after execute_agent, use ' +
        'mcp_aql_create record_execution_step instead. continue_execution is only ' +
        'for resuming a previously paused execution and still requires the same ' +
        'goal parameters as execute_agent.';
    }

    return message;
  }

  /**
   * Render goal template by replacing {parameter} placeholders
   * @private
   */
  private renderGoalTemplate(
    template: string,
    parameters: Record<string, unknown>
  ): string {
    let rendered = template;
    for (const [key, value] of Object.entries(parameters)) {
      // Escape key to prevent regex metacharacters from causing ReDoS (Issue #103)
      const escapedKey = SafeRegex.escape(key);
      rendered = rendered.replace(new RegExp(`\\{${escapedKey}\\}`, 'g'), String(value));
    }

    // Cap rendered goal length to prevent oversized payloads
    if (rendered.length > AGENT_LIMITS.MAX_RENDERED_GOAL_LENGTH) {
      logger.warn('Rendered goal exceeds MAX_RENDERED_GOAL_LENGTH, truncating', {
        renderedLength: rendered.length,
        maxLength: AGENT_LIMITS.MAX_RENDERED_GOAL_LENGTH,
      });
      rendered = rendered.substring(0, AGENT_LIMITS.MAX_RENDERED_GOAL_LENGTH);
    }

    return rendered;
  }

  /**
   * Detect unmatched {placeholder} patterns remaining after template rendering.
   * Returns array of placeholder names found in the rendered string.
   * Issue #126: Warn when template parameters are missing.
   * @private
   */
  private detectUnmatchedPlaceholders(rendered: string): string[] {
    const placeholderPattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    const unmatched: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = placeholderPattern.exec(rendered)) !== null) {
      unmatched.push(match[1]);
    }
    return unmatched;
  }

  /**
   * Formats a consistent error message for circular activation detection.
   * Used by both the static pre-flight check and the runtime chain check.
   */
  private static formatCircularActivationError(cyclePath: string[]): string {
    const agentName = cyclePath[cyclePath.length - 1];
    return (
      `Circular agent activation detected (cycle of ${cyclePath.length - 1}): ` +
      `${cyclePath.join(' → ')}. ` +
      `Agent '${agentName}' cannot activate itself directly or indirectly.`
    );
  }

  /** Safety limits for activation graph traversal */
  private static readonly MAX_ACTIVATION_DEPTH = 10;
  private static readonly MAX_NODES_VISITED = 100;

  /**
   * Static activation cycle detection — Layer 1 of dual-detection strategy (Issue #374)
   *
   * Performs async DFS on the activation graph to detect cycles BEFORE execution begins.
   * This is a pre-flight check that prevents circular activation chains from being attempted.
   *
   * Layer 1 (this method): Static graph analysis — walks the activation graph from the root
   * agent, loading each agent's `activates.agents` metadata. Catches all cycles reachable
   * from the root without executing any agents. Bounded by MAX_ACTIVATION_DEPTH and
   * MAX_NODES_VISITED to prevent resource exhaustion from large acyclic graphs.
   *
   * Layer 2 (getElementContent runtime check): Defense-in-depth — guards against edge cases
   * like dynamically-constructed activation chains or agents modified between the static
   * check and actual execution. See getElementContent for details.
   *
   * @param rootName - The root agent name initiating the activation chain
   * @param activatedAgents - The immediate agents activated by the root
   * @returns The cycle path array if a cycle exists, null otherwise
   * @private
   */
  private async detectActivationCycles(
    rootName: string,
    activatedAgents: string[]
  ): Promise<string[] | null> {
    // Cache loaded agents to avoid redundant I/O during DFS
    const agentCache = new Map<string, string[] | null>();
    const fullyExplored = new Set<string>();
    let nodesVisited = 0;
    const initial = AgentManager.createActivationCycleStack(rootName, activatedAgents);
    if (initial.selfLoop) {
      return initial.selfLoop;
    }

    while (initial.stack.length > 0) {
      const entry = initial.stack.pop();
      if (!entry) {
        continue;
      }
      nodesVisited++;
      const decision = AgentManager.getCycleDetectionDecision(rootName, entry.path, nodesVisited);
      if (decision === 'abort') {
        return null;
      }
      if (decision === 'skip') {
        continue;
      }
      const cycle = await this.expandActivationCycleEntry(entry, fullyExplored, agentCache, initial.stack);
      if (cycle) {
        return cycle;
      }
    }

    return null;
  }

  private static createActivationCycleStack(
    rootName: string,
    activatedAgents: string[]
  ): {
    stack: Array<{ current: string; path: string[]; pathSet: Set<string> }>;
    selfLoop: string[] | null;
  } {
    const stack: Array<{ current: string; path: string[]; pathSet: Set<string> }> = [];
    const rootLower = rootName.toLowerCase();
    for (const child of activatedAgents) {
      if (child.toLowerCase() === rootLower) {
        return { stack, selfLoop: [rootName, child] };
      }
      stack.push({
        current: child,
        path: [rootName, child],
        pathSet: new Set<string>([rootLower, child.toLowerCase()]),
      });
    }
    return { stack, selfLoop: null };
  }

  private static getCycleDetectionDecision(
    rootName: string,
    currentPath: string[],
    nodesVisited: number
  ): 'continue' | 'skip' | 'abort' {
    if (nodesVisited > AgentManager.MAX_NODES_VISITED) {
      logger.warn(
        `Activation cycle detection for '${rootName}' aborted: exceeded ${AgentManager.MAX_NODES_VISITED} nodes visited. ` +
        `The activation graph may be too large.`
      );
      return 'abort';
    }

    if (currentPath.length > AgentManager.MAX_ACTIVATION_DEPTH + 1) {
      logger.warn(
        `Activation cycle detection for '${rootName}' hit depth limit of ${AgentManager.MAX_ACTIVATION_DEPTH}. ` +
        `Skipping deeper branches.`
      );
      return 'skip';
    }
    return 'continue';
  }

  private async expandActivationCycleEntry(
    entry: { current: string; path: string[]; pathSet: Set<string> },
    fullyExplored: Set<string>,
    agentCache: Map<string, string[] | null>,
    stack: Array<{ current: string; path: string[]; pathSet: Set<string> }>
  ): Promise<string[] | null> {
    const currentLower = entry.current.toLowerCase();
    if (fullyExplored.has(currentLower)) {
      return null;
    }

    const children = await this.getCachedActivatedAgents(entry.current, agentCache);
    const expansion = AgentManager.enqueueActivationChildren(entry, children, fullyExplored, stack);
    if (!expansion.foundUnexplored) {
      fullyExplored.add(currentLower);
    }
    return expansion.cyclePath;
  }

  private async getCachedActivatedAgents(
    name: string,
    agentCache: Map<string, string[] | null>
  ): Promise<string[]> {
    const cacheKey = name.toLowerCase();
    if (agentCache.has(cacheKey)) {
      return agentCache.get(cacheKey) || [];
    }
    try {
      const agent = await this.read(name);
      const agents = agent ? (agent.metadata as AgentMetadataV2).activates?.agents || [] : null;
      if (!agents) {
        logger.warn(`Agent '${name}' referenced in activates.agents could not be resolved during cycle detection`);
      }
      agentCache.set(cacheKey, agents);
      return agents || [];
    } catch {
      logger.warn(`Agent '${name}' referenced in activates.agents could not be resolved during cycle detection`);
      agentCache.set(cacheKey, null);
      return [];
    }
  }

  private static enqueueActivationChildren(
    entry: { current: string; path: string[]; pathSet: Set<string> },
    children: string[],
    fullyExplored: Set<string>,
    stack: Array<{ current: string; path: string[]; pathSet: Set<string> }>
  ): { cyclePath: string[] | null; foundUnexplored: boolean } {
    let foundUnexplored = false;
    for (const child of children) {
      const childLower = child.toLowerCase();
      if (entry.pathSet.has(childLower)) {
        return { cyclePath: [...entry.path, child], foundUnexplored: true };
      }
      if (!fullyExplored.has(childLower)) {
        const newPathSet = new Set(entry.pathSet);
        newPathSet.add(childLower);
        stack.push({ current: child, path: [...entry.path, child], pathSet: newPathSet });
        foundUnexplored = true;
      }
    }
    return { cyclePath: null, foundUnexplored };
  }

  /**
   * Get content from an element (element-agnostic)
   * @private
   */
  private async getElementContent(
    elementType: string,
    elementName: string,
    executionContext?: ExecutionContext
  ): Promise<string> {
    // Issue #1948: Use instance-injected resolver instead of static
    const resolver = this._elementManagerResolver;
    if (!resolver) {
      logger.warn(`Element manager resolver not configured - cannot activate ${elementType}/${elementName}`);
      return `[Element manager resolver not configured for ${elementType}/${elementName}]`;
    }

    // Layer 2 (defense-in-depth): Runtime circular activation detection (Issue #109)
    // The static pre-flight check (detectActivationCycles, layer 1) catches most cycles
    // before execution begins. This runtime check guards against edge cases such as
    // dynamically-constructed activation chains or agents modified between the static
    // check and actual execution. Uses executionContext.agentChain which tracks the
    // current execution path — effective for direct and multi-hop chains within a
    // single execution context.
    if (elementType === 'agents' && executionContext?.agentChain) {
      const chainSet = new Set(executionContext.agentChain.map(name => name.toLowerCase()));
      const normalizedName = elementName.toLowerCase();

      if (chainSet.has(normalizedName)) {
        const cyclePath = [...executionContext.agentChain, elementName];
        throw new Error(AgentManager.formatCircularActivationError(cyclePath));
      }
    }

    try {
      // Map plural element types to manager names
      const managerNameMap: Record<string, string> = {
        personas: 'PersonaManager',
        skills: 'SkillManager',
        memories: 'MemoryManager',
        templates: 'TemplateManager',
        ensembles: 'EnsembleManager',
        agents: 'AgentManager'
      };

      const managerName = managerNameMap[elementType];
      if (!managerName) {
        logger.warn(`Unknown element type: ${elementType}`);
        return `[Unknown element type: ${elementType}]`;
      }

      const manager = resolver(managerName);
      if (!manager) {
        logger.warn(`Manager not found for element type: ${elementType}`);
        return `[Manager not found: ${managerName}]`;
      }

      // Get all elements of this type
      const elements = await manager.list();
      const element = elements.find(e => e.metadata.name === elementName);

      if (!element) {
        throw new Error(`${elementType} '${elementName}' not found`);
      }

      // Return appropriate content based on element type
      switch (elementType) {
        case 'personas':
          return element.content || '';

        case 'skills':
          return element.instructions || '';

        case 'memories': {
          const entries = element.getEntries?.() ?? [];
          return `Memory '${elementName}' with ${entries.length} entries`;
        }

        case 'templates':
          return element.content || '';

        case 'ensembles': {
          const elementList = Object.entries(element.elements || {})
            .map(([type, names]) => `${type}: ${Array.isArray(names) ? names.join(', ') : String(names)}`)
            .join('; ');
          return `Ensemble '${elementName}' activates: ${elementList}`;
        }

        case 'agents': {
          const raw = element.extensions?.instructions;
          return typeof raw === 'string' ? raw : '';
        }

        default:
          return `[Content not available for ${elementType}]`;
      }
    } catch (error) {
      logger.error(`Error getting content for ${elementType} '${elementName}':`, error);
      throw error;
    }
  }

  /**
   * Check if active set cleanup is needed and perform cleanup if necessary
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private checkAndCleanupActiveSet(): void {
    const { max, cleanupThreshold } = getActiveElementLimitConfig('agents');

    // Below threshold — no action needed
    if (this.getActivationSet().size < cleanupThreshold) {
      return;
    }

    // At or above max — warn before cleanup
    if (this.getActivationSet().size >= max) {
      logger.warn(
        `Active agents limit reached (${max}). ` +
        `Consider deactivating unused agents or setting DOLLHOUSE_MAX_ACTIVE_AGENTS to a higher value.`
      );

      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_ACTIVATED',
        severity: 'MEDIUM',
        source: 'AgentManager.checkAndCleanupActiveSet',
        details: `Active agents limit reached (${this.getActivationSet().size}/${max})`,
        additionalData: {
          activeCount: this.getActivationSet().size,
          maxAllowed: max,
          activeAgentNames: Array.from(this.getActivationSet()),
        }
      });
    }

    // At or above threshold — proactively clean stale entries
    void this.cleanupStaleActiveAgents();
  }

  /**
   * Clean up stale entries from active agents set
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private async cleanupStaleActiveAgents(): Promise<void> {
    try {
      const startSize = this.getActivationSet().size;
      const agents = await this.list();
      const existingAgentNames = new Set(agents.map(a => a.metadata.name));

      const staleNames: string[] = [];
      for (const activeName of this.getActivationSet()) {
        if (!existingAgentNames.has(activeName)) {
          this.getActivationSet().delete(activeName);
          staleNames.push(activeName);
        }
      }

      const endSize = this.getActivationSet().size;
      const removed = startSize - endSize;

      if (removed > 0) {
        logger.info(
          `Cleaned up ${removed} stale active agent reference(s). ` +
          `Active agents: ${endSize}/${getMaxActiveLimit('agents')}`
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_DELETED',
          severity: 'LOW',
          source: 'AgentManager.cleanupStaleActiveAgents',
          details: `Removed ${removed} stale active agent references`,
          additionalData: {
            removedCount: removed,
            activeCount: endSize,
            staleNames: staleNames.join(', ')
          }
        });
      }
    } catch (error) {
      logger.error('Failed to cleanup stale active agents:', error);

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'LOW',
        source: 'AgentManager.cleanupStaleActiveAgents',
        details: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  /**
   * Persist an agent state file (YAML).
   *
   * IMPROVEMENT: Optimistic locking with version checking (Issue #24)
   * Prevents state corruption from concurrent updates by comparing versions
   *
   * FIX: Uses normalizeFilename() for consistent state file naming
   * This ensures state files use kebab-case (e.g., "crudv-agent-delta.state.yaml")
   * regardless of input name format (e.g., "CRUDV-Agent-Delta")
   *
   * FIX (Issue #107 - CRIT-2): Wrap read-compare-write sequence in file lock
   * to prevent TOCTOU race condition from concurrent agent executions
   *
   * FIX (Issue #123): Version increments on successful save, not during operations
   *
   * @returns The new state version after successful save
   * @protected Only accessible by subclasses (e.g., TestableAgentManager for testing)
   */
  protected async saveAgentState(name: string, state: AgentState): Promise<number>;
  protected async saveAgentState(agent: Agent, name: string, state: AgentState): Promise<number>;
  protected async saveAgentState(
    agentOrName: Agent | string,
    nameOrState: string | AgentState,
    maybeState?: AgentState,
  ): Promise<number> {
    const agent = typeof agentOrName === 'string' ? null : agentOrName;
    const name = typeof agentOrName === 'string' ? agentOrName : nameOrState as string;
    const state = typeof agentOrName === 'string' ? nameOrState as AgentState : maybeState!;
    return this.stateStore.save(
      { name, agentElementId: agent ? this.getAgentElementId(agent, name) : name },
      state,
      state.stateVersion ?? 0,
    );
  }

  /**
   * Utility: ensure `.md` extension on requested path.
   */
  private stripExtension(filePath: string): string {
    return filePath.endsWith(AGENT_FILE_EXTENSION)
      ? filePath.slice(0, -AGENT_FILE_EXTENSION.length)
      : filePath;
  }

  private async hydrateAgentState(agent: Agent, name: string): Promise<void> {
    const state = await this.stateStore.load({
      name,
      agentElementId: this.getAgentElementId(agent, name),
    });
    if (!state) {
      if (isWritableStorageLayer(this.storageLayer)) {
        agent[COMMIT_PERSISTED_VERSION](0);
      }
      this.hydratedAgents.add(agent);
      return;
    }

    const serialized = JSON.parse(agent.serializeToJSON());
    serialized.state = state;
    agent.deserialize(JSON.stringify(serialized));
    agent.markStatePersisted();
    this.hydratedAgents.add(agent);
  }

  private getAgentElementId(agent: Agent, name: string): string {
    if (!isWritableStorageLayer(this.storageLayer)) {
      return agent.id;
    }
    return this.storageLayer.getPathByName(agent.metadata.name)
      ?? this.storageLayer.getPathByName(name)
      ?? agent.id;
  }

  async ensureStateHydrated(agent: Agent): Promise<void> {
    if (!isWritableStorageLayer(this.storageLayer) || this.hydratedAgents.has(agent)) {
      return;
    }
    await this.hydrateAgentState(agent, agent.metadata.name);
  }

  private async warnOnceForDbModeOrphanedStateFiles(): Promise<void> {
    if (AgentManager.warnedDbModeOrphanedStateFiles) {
      return;
    }
    AgentManager.warnedDbModeOrphanedStateFiles = true;
    const defaultFileStore = new FileAgentStateStore({
      stateDir: () => this.stateDir,
      fileLockManager: this.fileLockManager,
      fileOperations: this.fileOperations,
      serializationService: this.serializationService,
      stateCache: this.stateCache,
      maxYamlSize: MAX_YAML_SIZE,
    });
    await defaultFileStore.warnIfOrphanedStateFiles();
  }

  protected override async parseMetadata(data: any): Promise<AgentMetadata> {
    const metadata = { ...data };
    this.normalizeAndValidateMetadataHeader(metadata);
    this.validateMetadataTextFields(metadata);
    this.validateMetadataSpecializations(metadata);
    this.validateMetadataTriggersAndPolicy(metadata);
    const agentName = metadata.name || 'unknown';
    this.normalizeAndValidateGoal(metadata, agentName);
    this.validateActivatesMetadata(metadata, agentName);
    this.validateToolsMetadata(metadata, agentName);
    this.normalizeAndValidateSystemPrompt(metadata, agentName);
    this.promoteRootAutonomyFields(metadata, agentName);
    this.validateAutonomyMetadata(metadata, agentName);
    this.validateResilienceMetadata(metadata, agentName);
    this.validateTagsMetadata(metadata, agentName);

    return metadata as AgentMetadata;
  }

  private normalizeAndValidateMetadataHeader(metadata: Record<string, any>): void {
    if (metadata.type === 'agent') {
      metadata.type = ElementType.AGENT;
    }
    if (metadata.type && metadata.type !== ElementType.AGENT) {
      throw new Error(`Invalid element type: expected '${ElementType.AGENT}', got '${metadata.type}'`);
    }
  }

  private validateMetadataTextFields(metadata: Record<string, any>): void {
    if (metadata.name) {
      const nameResult = this.validationService.validateAndSanitizeInput(metadata.name, {
        maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH,
        allowSpaces: true
      });
      if (!nameResult.isValid) {
        throw new Error(`Invalid agent name: ${nameResult.errors?.join(', ')}`);
      }
      metadata.name = nameResult.sanitizedValue;
    }

    if (metadata.description) {
      const descResult = this.validationService.validateAndSanitizeInput(metadata.description, {
        maxLength: SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH,
        allowSpaces: true,
        fieldType: 'description'
      });
      if (!descResult.isValid) {
        throw new Error(`Invalid agent description: ${descResult.errors?.join(', ')}`);
      }
      metadata.description = descResult.sanitizedValue;
    }
  }

  private validateMetadataSpecializations(metadata: Record<string, any>): void {
    if (!Array.isArray(metadata.specializations)) {
      return;
    }

    const validatedSpecializations: string[] = [];
    for (const value of metadata.specializations) {
      const result = this.validationService.validateAndSanitizeInput(String(value), {
        maxLength: SECURITY_LIMITS.MAX_TAG_LENGTH,
        allowSpaces: true
      });
      if (!result.isValid) {
        throw new Error(`Invalid specialization "${value}": ${result.errors?.join(', ')}`);
      }
      validatedSpecializations.push(result.sanitizedValue!);
    }
    metadata.specializations = validatedSpecializations;
  }

  private validateMetadataTriggersAndPolicy(metadata: Record<string, any>): void {
    if (metadata.triggers && Array.isArray(metadata.triggers)) {
      const validationResult = this.triggerValidationService.validateTriggers(
        metadata.triggers,
        ElementType.AGENT,
        metadata.name || 'unknown'
      );
      metadata.triggers = validationResult.validTriggers;
    }
    if (metadata.gatekeeper) {
      metadata.gatekeeper = sanitizeGatekeeperPolicy(
        metadata.gatekeeper,
        metadata.name || 'unknown',
        'agent',
        metadata as Record<string, unknown>
      );
    }
  }

  private normalizeAndValidateGoal(metadata: Record<string, any>, agentName: string): void {
    if (metadata.goals !== undefined && metadata.goal === undefined) {
      metadata.goal = metadata.goals;
      delete metadata.goals;
      logger.warn(`[parseMetadata] Agent '${agentName}': migrated 'goals' (plural) to 'goal'`);
    } else if (metadata.goals !== undefined) {
      delete metadata.goals;
    }

    if (!metadata.goal) {
      return;
    }
    if (typeof metadata.goal === 'object' && typeof metadata.goal.template === 'string') {
      normalizeGoalKeys(metadata.goal as unknown as Record<string, unknown>);
      this.stripMalformedGoalArrays(metadata.goal, agentName);
      return;
    }
    if (typeof metadata.goal !== 'string') {
      logger.warn(`[parseMetadata] Agent '${agentName}': goal is malformed (no template), stripping`);
      delete metadata.goal;
    }
  }

  private stripMalformedGoalArrays(goal: Record<string, any>, agentName: string): void {
    if (goal.parameters && !Array.isArray(goal.parameters)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': goal.parameters is not an array, stripping`);
      delete goal.parameters;
    }
    if (goal.successCriteria && !Array.isArray(goal.successCriteria)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': goal.successCriteria is not an array, stripping`);
      delete goal.successCriteria;
    }
  }

  private validateActivatesMetadata(metadata: Record<string, any>, agentName: string): void {
    if (!metadata.activates) {
      return;
    }
    if (typeof metadata.activates !== 'object' || Array.isArray(metadata.activates)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': activates is not an object, stripping`);
      delete metadata.activates;
      return;
    }
    for (const [key, value] of Object.entries(metadata.activates)) {
      if (value !== undefined && !Array.isArray(value)) {
        logger.warn(`[parseMetadata] Agent '${agentName}': activates.${key} is not an array, stripping`);
        delete metadata.activates[key];
      }
    }
  }

  private validateToolsMetadata(metadata: Record<string, any>, agentName: string): void {
    if (!metadata.tools) {
      return;
    }
    if (typeof metadata.tools !== 'object' || Array.isArray(metadata.tools)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': tools is not an object, stripping`);
      delete metadata.tools;
      return;
    }
    if (!Array.isArray(metadata.tools.allowed)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': tools.allowed is not an array, stripping tools`);
      delete metadata.tools;
      return;
    }
    if (metadata.tools.denied !== undefined && !Array.isArray(metadata.tools.denied)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': tools.denied is not an array, stripping`);
      delete metadata.tools.denied;
    }
  }

  private normalizeAndValidateSystemPrompt(metadata: Record<string, any>, agentName: string): void {
    if (metadata.system_prompt !== undefined && metadata.systemPrompt === undefined) {
      metadata.systemPrompt = metadata.system_prompt;
    }
    delete metadata.system_prompt;

    if (metadata.systemPrompt !== undefined && typeof metadata.systemPrompt !== 'string') {
      logger.warn(`[parseMetadata] Agent '${agentName}': systemPrompt is not a string, stripping`);
      delete metadata.systemPrompt;
    }
  }

  private promoteRootAutonomyFields(metadata: Record<string, any>, agentName: string): void {
    const rootAutonomyFields: ReadonlyArray<readonly [string, string]> = [
      ['riskTolerance', 'riskTolerance'],
      ['risk_tolerance', 'riskTolerance'],
      ['maxAutonomousSteps', 'maxAutonomousSteps'],
      ['max_autonomous_steps', 'maxAutonomousSteps'],
      ['maxSteps', 'maxAutonomousSteps'],
    ] as const;
    let promoted = false;
    for (const [rootKey, autonomyKey] of rootAutonomyFields) {
      if (metadata[rootKey] !== undefined) {
        metadata.autonomy ??= {};
        const aBlock = metadata.autonomy as Record<string, unknown>;
        if (aBlock[autonomyKey] === undefined) {
          aBlock[autonomyKey] = metadata[rootKey];
          promoted = true;
        }
        delete metadata[rootKey];
      }
    }
    if (promoted) {
      logger.warn(`[parseMetadata] Agent '${agentName}': promoted root-level autonomy fields into autonomy block`);
    }
  }

  private validateAutonomyMetadata(metadata: Record<string, any>, agentName: string): void {
    if (!metadata.autonomy) {
      return;
    }
    if (typeof metadata.autonomy !== 'object' || Array.isArray(metadata.autonomy)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': autonomy is not an object, stripping`);
      delete metadata.autonomy;
      return;
    }

    const a = metadata.autonomy as Record<string, unknown>;
    normalizeAutonomyKeys(a);
    this.stripInvalidEnumField(a, 'riskTolerance', RISK_TOLERANCE_LEVELS, `autonomy.riskTolerance`, agentName);
    this.stripInvalidTypedField(a, 'maxAutonomousSteps', 'number', `autonomy.maxAutonomousSteps`, agentName);
    this.stripInvalidArrayField(a, 'requiresApproval', `autonomy.requiresApproval`, agentName);
    this.stripInvalidArrayField(a, 'autoApprove', `autonomy.autoApprove`, agentName);
  }

  private validateResilienceMetadata(metadata: Record<string, any>, agentName: string): void {
    if (!metadata.resilience) {
      return;
    }
    if (typeof metadata.resilience !== 'object' || Array.isArray(metadata.resilience)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': resilience is not an object, stripping`);
      delete metadata.resilience;
      return;
    }

    const r = metadata.resilience as Record<string, unknown>;
    normalizeResilienceKeys(r);
    this.stripInvalidEnumField(r, 'onStepLimitReached', STEP_LIMIT_ACTIONS, `resilience.onStepLimitReached`, agentName);
    this.stripInvalidEnumField(r, 'onExecutionFailure', EXECUTION_FAILURE_ACTIONS, `resilience.onExecutionFailure`, agentName);
    this.stripInvalidTypedField(r, 'maxRetries', 'number', `resilience.maxRetries`, agentName);
    this.stripInvalidTypedField(r, 'maxContinuations', 'number', `resilience.maxContinuations`, agentName);
    this.stripInvalidEnumField(r, 'retryBackoff', BACKOFF_STRATEGIES, `resilience.retryBackoff`, agentName);
    this.stripInvalidTypedField(r, 'preserveState', 'boolean', `resilience.preserveState`, agentName);
  }

  private stripInvalidEnumField(
    record: Record<string, unknown>,
    key: string,
    allowedValues: readonly string[],
    label: string,
    agentName: string
  ): void {
    if (record[key] !== undefined && !isOneOf(record[key], allowedValues)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': ${label} '${record[key]}' is invalid, stripping`);
      delete record[key];
    }
  }

  private stripInvalidTypedField(
    record: Record<string, unknown>,
    key: string,
    expectedType: 'number' | 'boolean',
    label: string,
    agentName: string
  ): void {
    if (record[key] !== undefined && typeof record[key] !== expectedType) {
      logger.warn(`[parseMetadata] Agent '${agentName}': ${label} is not a ${expectedType}, stripping`);
      delete record[key];
    }
  }

  private stripInvalidArrayField(
    record: Record<string, unknown>,
    key: string,
    label: string,
    agentName: string
  ): void {
    if (record[key] !== undefined && !Array.isArray(record[key])) {
      logger.warn(`[parseMetadata] Agent '${agentName}': ${label} is not an array, stripping`);
      delete record[key];
    }
  }

  private validateTagsMetadata(metadata: Record<string, any>, agentName: string): void {
    if (metadata.tags === undefined) {
      return;
    }
    if (!Array.isArray(metadata.tags)) {
      logger.warn(`[parseMetadata] Agent '${agentName}': tags is not an array, stripping`);
      delete metadata.tags;
      return;
    }
    metadata.tags = metadata.tags.filter((t: unknown) => typeof t === 'string');
  }

  protected override createElement(metadata: AgentMetadata, bodyContent: string): Agent {
    const agent = new Agent(metadata, this.metadataService);
    // Fix #912: Prefer explicit format_version marker, fall back to instructions-presence check
    delete (metadata as any).format_version;  // Strip marker from runtime metadata
    const metadataInstructions = metadata.instructions;
    if (metadataInstructions) {
      // v2 format: instructions from YAML, body is content (reference material)
      agent.instructions = metadataInstructions;
      agent.content = bodyContent.trim();
      delete metadata.instructions;
    } else {
      // v1 format: body text maps to instructions
      agent.instructions = bodyContent.trim();
      agent.content = '';
    }
    // Keep extensions.instructions for backward compat
    agent.extensions = {
      ...agent.extensions,
      instructions: agent.instructions
    };
    return agent;
  }

  protected override async serializeElement(agent: Agent): Promise<string> {
    const metadata = this.buildBaseSerializedMetadata(agent);
    const metadataV2 = agent.metadata as AgentMetadataV2;
    this.addSerializedV2Metadata(metadata, metadataV2);
    this.addSerializedLegacyMetadata(metadata, metadataV2);
    this.addSerializedCommonMetadata(metadata, metadataV2);

    // v2.0 format: instructions in YAML frontmatter, content as body
    const instructions = agent.instructions ||
      (agent.extensions?.instructions as string | undefined) ||
      this.buildDefaultInstructions(agent);
    if (instructions) {
      metadata.instructions = instructions;
    }
    const body = agent.content || this.buildDefaultBody(agent);

    return this.serializationService.createFrontmatter(metadata, body, {
      method: 'manual',
      schema: 'json',  // Use JSON schema to preserve booleans/numbers in v2 metadata
      cleanMetadata: true,
      cleaningStrategy: 'remove-both',  // Remove both null and undefined
      sortKeys: true
    });
  }

  private buildBaseSerializedMetadata(agent: Agent): Record<string, unknown> {
    return {
      name: agent.metadata.name,
      type: toSingularLabel(ElementType.AGENT),
      unique_id: agent.id,
      version: agent.metadata.version,
      author: agent.metadata.author,
      created: agent.metadata.created ?? new Date().toISOString(),
      modified: agent.metadata.modified ?? new Date().toISOString(),
      description: agent.metadata.description,
      format_version: 'v2',
    };
  }

  private addSerializedV2Metadata(
    metadata: Record<string, unknown>,
    metadataV2: AgentMetadataV2
  ): void {
    if (metadataV2.goal) metadata.goal = metadataV2.goal;
    if (metadataV2.activates) metadata.activates = metadataV2.activates;
    if (metadataV2.tools) metadata.tools = metadataV2.tools;
    if (metadataV2.systemPrompt) metadata.systemPrompt = metadataV2.systemPrompt;
    if (metadataV2.autonomy) metadata.autonomy = metadataV2.autonomy;
    if (metadataV2.gatekeeper) metadata.gatekeeper = metadataV2.gatekeeper;
    if (metadataV2.resilience) metadata.resilience = metadataV2.resilience;
  }

  private addSerializedLegacyMetadata(
    metadata: Record<string, unknown>,
    metadataV2: AgentMetadataV2
  ): void {
    if (metadataV2.goal) {
      return;
    }
    if (metadataV2.decisionFramework) metadata.decisionFramework = metadataV2.decisionFramework;
    if (metadataV2.riskTolerance) metadata.riskTolerance = metadataV2.riskTolerance;
    if (metadataV2.learningEnabled !== undefined) metadata.learningEnabled = metadataV2.learningEnabled;
    if (metadataV2.maxConcurrentGoals !== undefined) metadata.maxConcurrentGoals = metadataV2.maxConcurrentGoals;
  }

  private addSerializedCommonMetadata(
    metadata: Record<string, unknown>,
    metadataV2: AgentMetadataV2
  ): void {
    if (metadataV2.specializations) metadata.specializations = metadataV2.specializations;
    if (metadataV2.tags && Array.isArray(metadataV2.tags) && metadataV2.tags.length > 0) {
      metadata.tags = metadataV2.tags;
    }
    if (metadataV2.triggers) metadata.triggers = metadataV2.triggers;
    if (metadataV2.ruleEngineConfig !== undefined) metadata.ruleEngineConfig = metadataV2.ruleEngineConfig;
  }

  private buildDefaultInstructions(agent: Agent): string {
    const nameHeader = agent.metadata.name ? `# ${agent.metadata.name}\n\n` : '';
    const description = agent.metadata.description ?? '';
    return `${nameHeader}${description}`.trim();
  }

  private buildDefaultBody(agent: Agent): string {
    const name = (agent.metadata.name ?? '').trim();
    const description = (agent.metadata.description ?? '').trim();
    const lines: string[] = [];
    if (name) {
      lines.push(`# ${name}`);
      lines.push('');
    }
    if (description) {
      lines.push(description);
    }
    return lines.join('\n');
  }

  /**
   * Select the text that should satisfy create-time content validation.
   * Behavioral instructions remain the primary source, while reference content
   * acts as the fallback for content-only agent creation.
   */
  private getPrimaryValidationText(content: string, referenceContent: unknown): string | undefined {
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }
    if (typeof referenceContent === 'string' && referenceContent.trim().length > 0) {
      return referenceContent;
    }
    return undefined;
  }

  /**
   * Issue #727: Validate V2 agent fields at write time.
   *
   * Normalizes snake_case → camelCase (same as parseMetadata) and then validates
   * structural constraints. Unlike parseMetadata (which silently strips for
   * backward compat), this returns errors so the caller can reject the create.
   *
   * Mutates the metadata in place (normalization), returns validation errors.
   */
  private validateV2FieldsForCreate(metadata: Partial<AgentMetadataV2>): string[] {
    const errors: string[] = [];
    this.validateCreateTools(metadata, errors);
    this.validateCreateSystemPrompt(metadata, errors);
    this.validateCreateAutonomy(metadata, errors);
    this.validateCreateResilience(metadata, errors);
    this.validateCreateActivates(metadata, errors);
    return errors;
  }

  private validateCreateTools(metadata: Partial<AgentMetadataV2>, errors: string[]): void {
    if (metadata.tools === undefined) {
      return;
    }
    if (typeof metadata.tools !== 'object' || Array.isArray(metadata.tools) || metadata.tools === null) {
      errors.push('tools must be an object with allowed/denied arrays');
      return;
    }
    if (!Array.isArray(metadata.tools.allowed)) {
      errors.push('tools.allowed is required and must be an array of strings');
    }
    if (metadata.tools.denied !== undefined && !Array.isArray(metadata.tools.denied)) {
      errors.push('tools.denied must be an array of strings');
    }
  }

  private validateCreateSystemPrompt(metadata: Partial<AgentMetadataV2>, errors: string[]): void {
    if (metadata.systemPrompt !== undefined && typeof metadata.systemPrompt !== 'string') {
      errors.push('systemPrompt must be a string');
    }

    const anyMeta: Record<string, unknown> = metadata;
    if (anyMeta.system_prompt !== undefined && metadata.systemPrompt === undefined) {
      if (typeof anyMeta.system_prompt === 'string') {
        metadata.systemPrompt = anyMeta.system_prompt;
      } else {
        errors.push('system_prompt must be a string');
      }
      delete anyMeta.system_prompt;
    }
  }

  private validateCreateAutonomy(metadata: Partial<AgentMetadataV2>, errors: string[]): void {
    if (metadata.autonomy === undefined) {
      return;
    }
    if (typeof metadata.autonomy !== 'object' || Array.isArray(metadata.autonomy) || metadata.autonomy === null) {
      errors.push('autonomy must be an object');
      return;
    }

    const a = metadata.autonomy as Record<string, unknown>;
    normalizeAutonomyKeys(a);
    this.addEnumValidationError(a, 'riskTolerance', RISK_TOLERANCE_LEVELS, 'autonomy.riskTolerance', errors);
    this.addTypeValidationError(a, 'maxAutonomousSteps', 'number', 'autonomy.maxAutonomousSteps', errors);
    this.addArrayValidationError(a, 'requiresApproval', 'autonomy.requiresApproval', errors);
    this.addArrayValidationError(a, 'autoApprove', 'autonomy.autoApprove', errors);
  }

  private validateCreateResilience(metadata: Partial<AgentMetadataV2>, errors: string[]): void {
    if (metadata.resilience === undefined) {
      return;
    }
    if (typeof metadata.resilience !== 'object' || Array.isArray(metadata.resilience) || metadata.resilience === null) {
      errors.push('resilience must be an object');
      return;
    }

    const r = metadata.resilience as Record<string, unknown>;
    normalizeResilienceKeys(r);
    this.addEnumValidationError(r, 'onStepLimitReached', STEP_LIMIT_ACTIONS, 'resilience.onStepLimitReached', errors);
    this.addEnumValidationError(r, 'onExecutionFailure', EXECUTION_FAILURE_ACTIONS, 'resilience.onExecutionFailure', errors);
    this.addTypeValidationError(r, 'maxRetries', 'number', 'resilience.maxRetries', errors);
    this.addTypeValidationError(r, 'maxContinuations', 'number', 'resilience.maxContinuations', errors);
    this.addEnumValidationError(r, 'retryBackoff', BACKOFF_STRATEGIES, 'resilience.retryBackoff', errors);
    this.addTypeValidationError(r, 'preserveState', 'boolean', 'resilience.preserveState', errors);
  }

  private validateCreateActivates(metadata: Partial<AgentMetadataV2>, errors: string[]): void {
    if (
      metadata.activates !== undefined &&
      (typeof metadata.activates !== 'object' || Array.isArray(metadata.activates) || metadata.activates === null)
    ) {
      errors.push('activates must be an object with skills/personas/memories/templates/ensembles arrays');
    }
  }

  private addEnumValidationError(
    record: Record<string, unknown>,
    key: string,
    allowedValues: readonly string[],
    label: string,
    errors: string[]
  ): void {
    if (record[key] !== undefined && !isOneOf(record[key], allowedValues)) {
      errors.push(`${label} must be one of: ${allowedValues.join(', ')} (got '${record[key]}')`);
    }
  }

  private addTypeValidationError(
    record: Record<string, unknown>,
    key: string,
    expectedType: 'number' | 'boolean',
    label: string,
    errors: string[]
  ): void {
    if (record[key] !== undefined && typeof record[key] !== expectedType) {
      errors.push(`${label} must be a ${expectedType}`);
    }
  }

  private addArrayValidationError(
    record: Record<string, unknown>,
    key: string,
    label: string,
    errors: string[]
  ): void {
    if (record[key] !== undefined && !Array.isArray(record[key])) {
      errors.push(`${label} must be an array of strings`);
    }
  }

  /**
   * Normalize goal input to V2 format.
   * LLMs may pass goal as a simple string or as a V2 config object.
   * This ensures we always have a proper V2 structure before validation.
   *
   * @param goal - Either a string goal or a V2 goal config object
   * @returns Normalized V2 goal config, or undefined if no goal provided
   */
  private normalizeGoalInput(goal: string | Partial<AgentGoalConfig> | undefined): AgentGoalConfig | undefined {
    if (!goal) {
      return undefined;
    }

    // If it's a string, convert to V2 format
    if (typeof goal === 'string') {
      logger.debug('Converting string goal to V2 format', { goal });
      return {
        template: goal,
        parameters: []
      };
    }

    // If it's already an object with template, normalize parameters
    if (typeof goal === 'object' && 'template' in goal && typeof goal.template === 'string') {
      // Issue #725: Normalize snake_case goal sub-fields before accessing
      normalizeGoalKeys(goal as unknown as Record<string, unknown>);

      const validParamTypes = ['string', 'number', 'boolean'] as const;
      const validatedParams: AgentGoalParameter[] = (goal.parameters || []).map((p, index) => {
        const name = typeof p.name === 'string' ? p.name : `param_${index}`;
        const type = validParamTypes.includes(p.type)
          ? p.type
          : 'string';
        const required = typeof p.required === 'boolean' ? p.required : false;

        const validated: AgentGoalParameter = { name, type, required };
        if (typeof p.description === 'string' && p.description.length > 0) {
          validated.description = sanitizeInput(p.description, 500);
        }
        if (p.default !== undefined) {
          // Sanitize string defaults to prevent injection when used in goal rendering
          if (typeof p.default === 'string') {
            validated.default = sanitizeInput(p.default, 500);
          } else {
            validated.default = p.default;
          }
        }
        return validated;
      });

      return {
        template: goal.template,
        parameters: validatedParams,
        successCriteria: goal.successCriteria
      };
    }

    // Object without template - cannot convert
    logger.warn('Goal object missing template field, cannot convert to V2', { goal });
    return undefined;
  }


  /**
   * Get the filename for an agent element.
   *
   * Uses inherited normalizeFilename() from BaseElementManager for consistent
   * filename formatting across all element managers.
   *
   * Examples:
   *   "Creative Writer" -> "creative-writer.md"
   *   "CRUDV-Agent-Delta" -> "crudv-agent-delta.md"
   *   "Multi_Goal_Agent" -> "multi-goal-agent.md"
   *   "CamelCaseName" -> "camel-case-name.md"
   */
  private getFilename(name: string): string {
    // Use inherited normalizeFilename() for unified normalization
    return this.getElementFilename(name);
  }

  private validateElementName(name: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(name);
  }

  /**
   * Get current user for attribution
   * REFACTORED: Delegates to MetadataService for consistent user attribution across all managers
   */
  private getCurrentUserForAttribution(): string {
    return this.metadataService.getCurrentUser();
  }

  /**
   * Record a step in agent execution
   * Wraps Agent.recordDecision() for the MCP tool interface
   *
   * @since v2.0.0 - Agentic Loop Redesign
   */
  async recordAgentStep(params: {
    agentName: string;
    stepDescription: string;
    outcome: "success" | "failure" | "partial";
    /** Optional findings or results from this step */
    findings?: string;
    confidence?: number;
    /** Optional hint about what the LLM plans to do next (for proactive risk evaluation) */
    nextActionHint?: string;
    /** Optional risk score for the current step (0-100) */
    riskScore?: number;
    /** Runtime override for maxAutonomousSteps (Issue #447) */
    maxStepsOverride?: number;
  }): Promise<{
    success: boolean;
    message: string;
    decision: {
      id: string;
      goalId: string;
      timestamp: string;
      decision: string;
      reasoning: string;
      framework: string;
      confidence: number;
      outcome: "success" | "failure" | "partial";
    };
    state: {
      goalCount: number;
      decisionCount: number;
      lastActive: string;
      stateVersion: number;
    };
    /** Autonomy directive indicating whether to continue or pause */
    autonomy: AutonomyDirective;
  }> {
    // 1. Load agent by name
    const agent = await this.read(params.agentName);
    if (!agent) {
      // FIX: Issue #275 - Throw ElementNotFoundError for consistent error handling
      throw new ElementNotFoundError('Agent', params.agentName);
    }

    // 2. Get agent state to find active goals
    const state = agent.getState();
    const activeGoal = state.goals.find(g => g.status === 'in_progress');

    if (!activeGoal) {
      const goalStatuses = state.goals.map(g => `${g.id}: ${g.status}`).join(', ');
      throw new Error(
        `No active goal found for agent '${params.agentName}'. ` +
        `Available goals: ${goalStatuses || 'none'}. ` +
        `Use execute_agent to start a new goal first.`
      );
    }

    // 3. Call Agent.recordDecision() to persist the step
    const decision = agent.recordDecision({
      goalId: activeGoal.id,
      decision: params.stepDescription,
      reasoning: params.findings ?? '',
      confidence: params.confidence ?? 0.8,
      outcome: params.outcome
    });

    // 4. Save agent state
    const sanitizedName = sanitizeInput(params.agentName, 100);
    await this.save(agent, this.getFilename(sanitizedName));

    // 5. Get updated state for step count and autonomy evaluation
    const updatedState = agent.getState();

    // 6. Calculate step count for this goal
    // stepCount = number of steps completed (including the one just recorded)
    // The evaluator uses this to check if we've hit maxAutonomousSteps
    // and to compute stepsRemaining for the autonomy directive.
    const goalDecisions = updatedState.decisions.filter(d => d.goalId === activeGoal.id);
    const stepCount = goalDecisions.length;

    // 7. Get agent metadata for autonomy config
    const agentMetadata = agent.metadata as AgentMetadataV2;

    // 8. Evaluate autonomy - should we continue or pause?
    // Issue #402: Pass DI-injected DangerZoneEnforcer via context
    // Issue #447: Apply runtime maxAutonomousSteps override if provided
    const autonomyConfig = params.maxStepsOverride !== undefined
      ? { ...agentMetadata.autonomy, maxAutonomousSteps: params.maxStepsOverride }
      : agentMetadata.autonomy;

    const autonomyDirective = evaluateAutonomy({
      agentName: params.agentName,
      autonomyConfig,
      stepCount,
      currentStepDescription: params.stepDescription,
      currentStepOutcome: params.outcome,
      nextActionHint: params.nextActionHint,
      riskScore: params.riskScore,
      dangerZoneEnforcer: this._dangerZoneEnforcer,
      verificationStore: this._verificationStore,
      sessionId: this.contextTracker?.getSessionContext()?.sessionId,
      goalDescription: activeGoal.description,
      goalId: activeGoal.id,
    });

    // 9. Return decision, state summary, and autonomy directive
    return {
      success: true,
      message: `Step recorded for agent '${params.agentName}'`,
      decision: {
        id: decision.id,
        goalId: decision.goalId,
        timestamp: decision.timestamp.toISOString(),
        decision: decision.decision,
        reasoning: decision.reasoning,
        framework: decision.framework,
        confidence: decision.confidence,
        outcome: params.outcome
      },
      state: {
        goalCount: updatedState.goals.length,
        decisionCount: updatedState.decisions.length,
        lastActive: updatedState.lastActive.toISOString(),
        stateVersion: updatedState.stateVersion || 1
      },
      autonomy: autonomyDirective
    };
  }

  /**
   * Complete an agent goal
   * Wraps Agent.completeGoal() for the MCP tool interface
   *
   * @since v2.0.0 - Agentic Loop Redesign
   */
  async completeAgentGoal(params: {
    agentName: string;
    goalId?: string;
    outcome: "success" | "failure" | "partial";
    summary: string;
  }): Promise<{
    success: boolean;
    message: string;
    goal: {
      id: string;
      description: string;
      status: "completed" | "failed";
      createdAt: string;
      completedAt: string;
      estimatedEffort?: number;
      actualEffort?: number;
    };
    metrics: {
      successRate: number;
      goalsCompleted: number;
      goalsInProgress: number;
      decisionAccuracy: number;
      averageCompletionTime: number;
    };
    state: {
      goalCount: number;
      decisionCount: number;
      lastActive: string;
      stateVersion: number;
    };
  }> {
    // 1. Load agent by name
    const agent = await this.read(params.agentName);
    if (!agent) {
      // FIX: Issue #275 - Throw ElementNotFoundError for consistent error handling
      throw new ElementNotFoundError('Agent', params.agentName);
    }

    // 2. Find goal to complete
    const state = agent.getState();
    let goal: AgentGoal | undefined;

    if (params.goalId) {
      goal = state.goals.find(g => g.id === params.goalId);
    } else {
      // Find most recent in-progress goal
      goal = state.goals
        .filter(g => g.status === 'in_progress')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    }

    if (!goal) {
      throw new Error(
        params.goalId
          ? `Goal '${params.goalId}' not found`
          : `No in-progress goal found for agent '${params.agentName}'`
      );
    }

    // 3. Record final decision with summary
    agent.recordDecision({
      goalId: goal.id,
      decision: 'goal_complete',
      reasoning: params.summary,
      confidence: 1.0,
      outcome: params.outcome
    });

    // 4. Call Agent.completeGoal()
    agent.completeGoal(goal.id, params.outcome);

    // 5. Get performance metrics
    const metrics = agent.getPerformanceMetrics();

    // 6. Save agent state
    const completeSanitizedName = sanitizeInput(params.agentName, 100);
    await this.save(agent, this.getFilename(completeSanitizedName));

    // 7. Return goal, metrics, and state
    const updatedState = agent.getState();
    const completedGoal = updatedState.goals.find(g => g.id === goal.id)!;

    return {
      success: true,
      message: `Goal completed for agent '${params.agentName}' with outcome: ${params.outcome}`,
      goal: {
        id: completedGoal.id,
        description: completedGoal.description,
        status: completedGoal.status as "completed" | "failed",
        createdAt: completedGoal.createdAt.toISOString(),
        completedAt: completedGoal.completedAt!.toISOString(),
        estimatedEffort: completedGoal.estimatedEffort,
        actualEffort: completedGoal.actualEffort
      },
      metrics: {
        successRate: metrics.successRate,
        goalsCompleted: metrics.goalsCompleted,
        goalsInProgress: metrics.goalsInProgress,
        decisionAccuracy: metrics.decisionAccuracy,
        averageCompletionTime: metrics.averageCompletionTime
      },
      state: {
        goalCount: updatedState.goals.length,
        decisionCount: updatedState.decisions.length,
        lastActive: updatedState.lastActive.toISOString(),
        stateVersion: updatedState.stateVersion || 1
      }
    };
  }

  /**
   * Get agent state
   * Wraps Agent.getState() for the MCP tool interface
   *
   * @since v2.0.0 - Agentic Loop Redesign
   */
  async getAgentState(params: {
    agentName: string;
    includeDecisionHistory?: boolean;
    includeContext?: boolean;
  }): Promise<{
    success: boolean;
    agentName: string;
    state: {
      goals: Array<{
        id: string;
        description: string;
        priority: string;
        status: string;
        importance: number;
        urgency: number;
        eisenhowerQuadrant?: string;
        createdAt: string;
        updatedAt: string;
        completedAt?: string;
        dependencies?: string[];
        riskLevel?: string;
        estimatedEffort?: number;
        actualEffort?: number;
        notes?: string;
      }>;
      decisions: Array<{
        id: string;
        goalId: string;
        timestamp: string;
        decision: string;
        reasoning: string;
        framework: string;
        confidence: number;
        outcome?: string;
      }>;
      context?: Record<string, any>;
      contextSummary: {
        keys: string[];
        size: number;
      };
      lastActive: string;
      sessionCount: number;
      stateVersion: number;
    };
    metrics: {
      successRate: number;
      goalsCompleted: number;
      goalsInProgress: number;
      decisionAccuracy: number;
      averageCompletionTime: number;
    };
  }> {
    // 1. Load agent by name
    const agent = await this.read(params.agentName);
    if (!agent) {
      // FIX: Issue #275 - Throw ElementNotFoundError for consistent error handling
      throw new ElementNotFoundError('Agent', params.agentName);
    }

    // 2. Get agent state
    const state = agent.getState();

    // 3. Get performance metrics
    const metrics = agent.getPerformanceMetrics();

    // 4. Filter decisions based on includeDecisionHistory
    const decisions = params.includeDecisionHistory
      ? state.decisions
      : state.decisions.slice(-10); // Last 10 decisions

    // 5. Build context summary
    const contextKeys = Object.keys(state.context);
    const contextSize = JSON.stringify(state.context).length;

    // 6. Return state and metrics
    return {
      success: true,
      agentName: params.agentName,
      state: {
        goals: state.goals.map(g => ({
          id: g.id,
          description: g.description,
          priority: g.priority,
          status: g.status,
          importance: g.importance,
          urgency: g.urgency,
          eisenhowerQuadrant: g.eisenhowerQuadrant,
          createdAt: g.createdAt.toISOString(),
          updatedAt: g.updatedAt.toISOString(),
          completedAt: g.completedAt?.toISOString(),
          dependencies: g.dependencies,
          riskLevel: g.riskLevel,
          estimatedEffort: g.estimatedEffort,
          actualEffort: g.actualEffort,
          notes: g.notes
        })),
        decisions: decisions.map(d => ({
          id: d.id,
          goalId: d.goalId,
          timestamp: d.timestamp.toISOString(),
          decision: d.decision,
          reasoning: d.reasoning,
          framework: d.framework,
          confidence: d.confidence,
          outcome: d.outcome
        })),
        context: params.includeContext ? state.context : undefined,
        contextSummary: {
          keys: contextKeys,
          size: contextSize
        },
        lastActive: state.lastActive.toISOString(),
        sessionCount: state.sessionCount,
        stateVersion: state.stateVersion || 1
      },
      metrics: {
        successRate: metrics.successRate,
        goalsCompleted: metrics.goalsCompleted,
        goalsInProgress: metrics.goalsInProgress,
        decisionAccuracy: metrics.decisionAccuracy,
        averageCompletionTime: metrics.averageCompletionTime
      }
    };
  }

  /**
   * Get gathered data for a specific goal execution.
   *
   * Aggregates decision history, goal state, and summary statistics
   * into a structured GatheredData object. This is a read-side view
   * over existing agent state data.
   *
   * Issue #68: GatheredDataEntry for state recording
   * @since v2.0.0 - Agentic Loop Completion (Epic #380)
   */
  async getGatheredData(params: {
    agentName: string;
    goalId: string;
  }): Promise<GatheredData> {
    const agent = await this.read(params.agentName);
    if (!agent) {
      throw new ElementNotFoundError('Agent', params.agentName);
    }

    const state = agent.getState();
    const gathered = getGatheredData(params.agentName, params.goalId, state);

    if (!gathered) {
      throw new Error(
        `Goal '${params.goalId}' not found for agent '${params.agentName}'. ` +
        `Available goals: ${state.goals.map(g => g.id).join(', ') || 'none'}`
      );
    }

    return gathered;
  }

  /**
   * Continue agent execution from previous state
   * Combines executeAgent with state context
   *
   * @since v2.0.0 - Agentic Loop Redesign
   */
  async continueAgentExecution(params: {
    agentName: string;
    parameters?: Record<string, unknown>;
    previousStepResult?: string;
  }): Promise<ExecuteAgentResult & {
    previousState: {
      goals: Array<{
        id: string;
        description: string;
        status: string;
        progress?: number;
      }>;
      recentDecisions: Array<{
        decision: string;
        reasoning: string;
        outcome?: string;
        timestamp: string;
      }>;
      sessionCount: number;
      lastActive: string;
      stateVersion: number;
    };
    continuation: {
      isResuming: boolean;
      previousStepResult?: string;
      suggestedNextSteps?: string[];
    };
  }> {
    // 1. Load agent by name
    const agent = await this.read(params.agentName);
    if (!agent) {
      // FIX: Issue #275 - Throw ElementNotFoundError for consistent error handling
      throw new ElementNotFoundError('Agent', params.agentName);
    }

    // 2. Get current state
    const state = agent.getState();
    const activeGoal = state.goals.find(goal => goal.status === 'in_progress');

    if (!activeGoal) {
      throw new Error(
        `continue_execution requires an in-progress goal for agent '${params.agentName}'. ` +
        `Use execute_agent to start a new goal. If you are reporting progress for ` +
        `the current goal, use mcp_aql_create record_execution_step.`
      );
    }

    const activeGoalDecisions = state.decisions.filter(decision => decision.goalId === activeGoal.id);
    if (activeGoalDecisions.length === 0) {
      throw new Error(
        `continue_execution is only for resuming a paused execution after at least ` +
        `one recorded step for agent '${params.agentName}'. After execute_agent, the ` +
        `next lifecycle call is mcp_aql_create record_execution_step.`
      );
    }

    // 3. Check if agent has been executed before
    const isResuming = state.sessionCount > 0 || state.decisions.length > 0;

    // 4. Execute agent normally (this activates elements and gets context)
    const executionParams = params.parameters || {};

    const executionResult = await this.executeAgent(
      params.agentName,
      executionParams,
      { operationName: 'continue_execution' }
    );

    // 5. Build previous state summary
    const recentDecisions = state.decisions.slice(-5).map(d => ({
      decision: d.decision,
      reasoning: d.reasoning,
      outcome: d.outcome,
      timestamp: d.timestamp.toISOString()
    }));

    const goalSummary = state.goals.map(g => ({
      id: g.id,
      description: g.description,
      status: g.status,
      progress: undefined // Could add progress tracking in future
    }));

    // 6. Generate suggested next steps based on state
    const suggestedNextSteps = this.generateNextSteps(state);

    // 7. Merge execution result with continuation context
    return {
      // Include all fields from execute_agent result
      ...executionResult,

      // Add previous state information
      previousState: {
        goals: goalSummary,
        recentDecisions,
        sessionCount: state.sessionCount,
        lastActive: state.lastActive.toISOString(),
        stateVersion: state.stateVersion || 1
      },

      // Add continuation context
      continuation: {
        isResuming,
        previousStepResult: params.previousStepResult,
        suggestedNextSteps
      }
    };
  }

  /**
   * Generate suggested next steps based on current state
   * @private
   */
  private generateNextSteps(state: AgentState): string[] {
    const suggestions: string[] = [];

    // Check for pending goals
    const pendingGoals = state.goals.filter(g => g.status === 'pending');
    if (pendingGoals.length > 0) {
      suggestions.push(`Start work on ${pendingGoals.length} pending goal(s)`);
    }

    // Check for in-progress goals
    const inProgressGoals = state.goals.filter(g => g.status === 'in_progress');
    if (inProgressGoals.length > 0) {
      suggestions.push(`Continue ${inProgressGoals.length} in-progress goal(s)`);
    }

    // Check for blocked goals (dependencies)
    const blockedGoals = state.goals.filter(g =>
      g.dependencies && g.dependencies.length > 0 && g.status === 'pending'
    );
    if (blockedGoals.length > 0) {
      suggestions.push(`Resolve dependencies for ${blockedGoals.length} blocked goal(s)`);
    }

    // Check decision history for failures
    const recentFailures = state.decisions
      .slice(-10)
      .filter(d => d.outcome === 'failure');
    if (recentFailures.length > 0) {
      suggestions.push(`Review and address ${recentFailures.length} recent failure(s)`);
    }

    return suggestions;
  }
}
