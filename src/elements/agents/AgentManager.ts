/**
 * AgentManager - Refactored to extend BaseElementManager
 * Manages agent CRUD operations, metadata sanitization, and state persistence.
 */

import { FileOperationsService } from '../../services/FileOperationsService.js';
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
import { BaseElementManager } from '../base/BaseElementManager.js';
import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import { sanitizeInput, validatePath } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { InputNormalizer } from '../../security/InputNormalizer.js';
import { SafeRegex } from '../../security/dosProtection.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { logger } from '../../utils/logger.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../services/validation/TriggerValidationService.js';
import { ValidationService } from '../../services/validation/ValidationService.js';
import { SerializationService } from '../../services/SerializationService.js';
import { MetadataService } from '../../services/MetadataService.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import { ElementMessages } from '../../utils/elementMessages.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { sanitizeGatekeeperPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';

const AGENT_FILE_EXTENSION = '.md';
const STATE_DIRECTORY = '.state';
const STATE_FILE_EXTENSION = '.state.yaml';
const MAX_YAML_SIZE = 64 * 1024;
const MAX_FILE_SIZE = 100 * 1024;

// Issue #83: Centralized active element limits (configurable via env vars)
import { getActiveElementLimitConfig, getMaxActiveLimit } from '../../config/active-element-limits.js';

interface ElementCreationResult {
  success: boolean;
  message: string;
  element?: Agent;
}

interface ParsedAgentFile {
  metadata: AgentMetadata;
  content: string;
}

export class AgentManager extends BaseElementManager<Agent> {
  private readonly stateDir: string;
  private readonly stateCache: Map<string, AgentState> = new Map();
  private triggerValidationService: TriggerValidationService;
  private validationService: ValidationService;
  private serializationService: SerializationService;
  private metadataService: MetadataService;
  // Track active agents by name (stable identifier)
  private activeAgentNames: Set<string> = new Set();

  // Static resolver for element manager lookup (DI pattern)
  // This allows Agent instances to resolve managers without tight coupling
  private static elementManagerResolver?: (managerName: string) => any;

  // Issue #402: Static resolver for DangerZoneEnforcer (DI pattern)
  private static dangerZoneEnforcerResolver?: () => import('./types.js').DangerZoneBlocker;

  // Issue #142: Static resolver for VerificationStore (DI pattern)
  private static verificationStoreResolver?: () => { set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) => void };

  constructor(
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    baseDir: string,
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry,
    serializationService: SerializationService,
    metadataService: MetadataService,
    fileWatchService?: FileWatchService,
    memoryBudget?: import('../../cache/CacheMemoryBudget.js').CacheMemoryBudget,
    backupService?: import('../../services/BackupService.js').BackupService
  ) {
    const elementDirOverride = path.join(baseDir, ElementType.AGENT);
    super(ElementType.AGENT, portfolioManager, fileLockManager, { elementDirOverride, fileWatchService, memoryBudget, backupService }, fileOperationsService, validationRegistry);
    this.stateDir = path.join(this.elementDir, STATE_DIRECTORY);
    this.triggerValidationService = validationRegistry.getTriggerValidationService();
    this.validationService = validationRegistry.getValidationService();
    this.serializationService = serializationService;
    this.metadataService = metadataService;
  }

  protected override getElementLabel(): string {
    return 'agent';
  }

  /**
   * Configure the element manager resolver for element-agnostic activation
   * This is called by the DI container during initialization
   * Follows the same pattern as Memory.configureMemoryManagerResolver
   *
   * @param resolver Function that takes a manager name and returns the manager instance
   */
  public static setElementManagerResolver(resolver: (managerName: string) => any): void {
    AgentManager.elementManagerResolver = resolver;
  }

  /**
   * Issue #402: Set DangerZoneEnforcer resolver for DI injection.
   * Called by the DI container during initialization.
   */
  public static setDangerZoneEnforcerResolver(resolver: () => import('./types.js').DangerZoneBlocker): void {
    AgentManager.dangerZoneEnforcerResolver = resolver;
  }

  /**
   * Issue #142: Set VerificationStore resolver for DI injection.
   * Called by the DI container during initialization.
   */
  public static setVerificationStoreResolver(resolver: () => { set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) => void }): void {
    AgentManager.verificationStoreResolver = resolver;
  }

  /**
   * Get the element manager resolver
   * @private
   */
  private static getElementManagerResolver(): ((managerName: string) => any) | undefined {
    return AgentManager.elementManagerResolver;
  }

  /**
   * Reset static resolvers (for test cleanup)
   * Call this in afterEach hooks to prevent test isolation issues
   */
  public static resetResolvers(): void {
    AgentManager.elementManagerResolver = undefined;
    AgentManager.dangerZoneEnforcerResolver = undefined;
    AgentManager.verificationStoreResolver = undefined;
  }

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
    metadata?: Partial<AgentMetadata> & { content?: string }
  ): Promise<ElementCreationResult> {
    try {
      await this.initialize();

      // Normalize goal input before validation - LLMs may pass string or object
      // Strip 'content' from metadata to prevent it from overwriting the positional
      // content param (which is the agent's instructions text) in the validation call.
      const { content: _referenceContent, ...metadataWithoutContent } = (metadata || {}) as Record<string, unknown>;
      const normalizedMetadata: Partial<AgentMetadataV2> = { ...metadataWithoutContent } as Partial<AgentMetadataV2>;
      if ((metadata as Partial<AgentMetadataV2>)?.goal !== undefined) {
        normalizedMetadata.goal = this.normalizeGoalInput(
          (metadata as Partial<AgentMetadataV2>).goal as string | Partial<AgentGoalConfig>
        );
      }

      // Use specialized validator for input validation
      // Include metadata to validate V2 fields (goal, activates, tools, systemPrompt, autonomy)
      const validationResult = await this.validator.validateCreate({
        name,
        description,
        content,
        ...normalizedMetadata
      });

      if (!validationResult.isValid) {
        return {
          success: false,
          message: `Validation failed: ${validationResult.errors.join(', ')}`
        };
      }

      // Log warnings if any
      if (validationResult.warnings && validationResult.warnings.length > 0) {
        logger.warn(`Agent creation warnings: ${validationResult.warnings.join(', ')}`);
      }

      // Sanitize inputs for element creation
      const sanitizedName = sanitizeInput(UnicodeValidator.normalize(name).normalizedContent, 100);
      const sanitizedDescription = sanitizeInput(UnicodeValidator.normalize(description).normalizedContent, 500);
      // Use ContentValidator for multi-line content to preserve formatting (newlines, tabs)
      // while still detecting prompt injection attacks
      const contentValidation = ContentValidator.validateAndSanitize(content, { maxLength: 50_000, contentContext: 'agent' });
      const sanitizedInstructions = contentValidation.sanitizedContent || '';

      if (!this.validateElementName(sanitizedName)) {
        return {
          success: false,
          message: 'Invalid agent name. Use only letters, numbers, hyphens, and underscores.'
        };
      }

      const filename = this.getFilename(sanitizedName);
      const agent = new Agent({
        ...normalizedMetadata,
        name: sanitizedName,
        description: sanitizedDescription
      }, this.metadataService);

      agent.metadata.author = normalizedMetadata?.author ?? this.getCurrentUserForAttribution();
      agent.extensions = {
        ...agent.extensions,
        specializations: normalizedMetadata?.specializations ?? agent.extensions?.specializations ?? [],
        decisionFramework: normalizedMetadata?.decisionFramework ?? agent.extensions?.decisionFramework,
        riskTolerance: normalizedMetadata?.riskTolerance ?? agent.extensions?.riskTolerance,
        learningEnabled: normalizedMetadata?.learningEnabled ?? agent.extensions?.learningEnabled,
      };
      // Promote instructions to first-class property (no longer in extensions)
      agent.instructions = sanitizedInstructions;
      // Also keep in extensions for backward compat during transition
      agent.extensions.instructions = sanitizedInstructions;

      // Set reference content if provided (v2.0 dual-field architecture)
      const referenceContent = (metadata as { content?: string } | undefined)?.content;
      if (referenceContent) {
        const contentValidationResult = ContentValidator.validateAndSanitize(
          String(referenceContent),
          { maxLength: 50_000, contentContext: 'agent' }
        );
        agent.content = contentValidationResult.sanitizedContent || '';
      }

      // Issue #727: Validate and normalize V2 fields BEFORE assignment.
      // This is the SECOND validation layer — AgentElementValidator (called above via
      // this.validator.validateCreate) is the first. The validator catches camelCase
      // invalid values; this method also normalizes snake_case keys (which the validator
      // doesn't see) and validates them. Both layers are needed. See Issue #730.
      const metadataV2 = normalizedMetadata as Partial<AgentMetadataV2> | undefined;
      if (metadataV2) {
        const v2Errors = this.validateV2FieldsForCreate(metadataV2);
        if (v2Errors.length > 0) {
          return {
            success: false,
            message: `V2 field validation failed: ${v2Errors.join('; ')}`
          };
        }
      }

      // V2 FIELDS: Store V2-specific fields in agent metadata (not just extensions)
      // This enables V2 agent creation via MCP-AQL create_element operation
      if (metadataV2?.goal) {
        (agent.metadata as AgentMetadataV2).goal = metadataV2.goal;
      }
      if (metadataV2?.activates) {
        (agent.metadata as AgentMetadataV2).activates = metadataV2.activates;
      }
      if (metadataV2?.tools) {
        (agent.metadata as AgentMetadataV2).tools = metadataV2.tools;
      }
      if (metadataV2?.systemPrompt) {
        (agent.metadata as AgentMetadataV2).systemPrompt = metadataV2.systemPrompt;
      }
      if (metadataV2?.autonomy) {
        (agent.metadata as AgentMetadataV2).autonomy = metadataV2.autonomy;
      }
      // Issue #449: Persist gatekeeper policy for Gatekeeper enforcement during execution
      if (metadataV2?.gatekeeper) {
        (agent.metadata as AgentMetadataV2).gatekeeper = metadataV2.gatekeeper;
      }
      // Issue #722: Persist resilience policy (was missing from V2 field assignments)
      if (metadataV2?.resilience) {
        (agent.metadata as AgentMetadataV2).resilience = metadataV2.resilience;
      }

      // Issue #613: Check metadata name uniqueness (not just filename)
      const existingAgents = await this.list();
      const duplicate = existingAgents.find(a =>
        a.metadata.name.toLowerCase() === sanitizedName.toLowerCase()
      );
      if (duplicate) {
        return {
          success: false,
          message: `Agent '${sanitizedName}' already exists`
        };
      }

      // Serialize the agent content first
      const serializedContent = await this.serializeElement(agent);
      const absolutePath = this.resolveAbsolutePath(filename);

      // Use atomic file creation to prevent TOCTOU race conditions
      // This replaces the previous check-then-write pattern with a single atomic operation
      const created = await this.fileOperations.createFileExclusive(absolutePath, serializedContent, {
        source: 'AgentManager.create'
      });

      if (!created) {
        return {
          success: false,
          message: `Agent '${sanitizedName}' already exists`
        };
      }

      // Cache the element after successful creation
      this.cacheElement(agent, filename);
      // Note: No reload() here — cacheElement() stores the element correctly.
      // See Issue #491 for why PersonaManager's reload-after-create was removed.

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'AgentManager.create',
        details: `Agent '${sanitizedName}' created`,
        additionalData: { agentId: agent.id }
      });

      return {
        success: true,
        message: `🤖 **${sanitizedName}** by ${agent.metadata.author || 'anonymous'}`,
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

  /**
   * Read an agent by name (without extension).
   *
   * @param name - Agent name (without extension)
   * @returns Agent instance or null if not found
   */
  async read(name: string): Promise<Agent | null> {
    try {
      const sanitizedName = sanitizeInput(name, 100);
      const filename = this.getFilename(sanitizedName);
      return await this.load(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Fallback: flexible matching via list scan (#607)
        return this.readFlexibly(name);
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
      const contentValidation = ContentValidator.validateAndSanitize(content, { maxLength: 50_000, contentContext: 'agent' });
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
   * Load an agent file, enforcing size and format checks.
   */
  override async load(filePath: string): Promise<Agent> {
    const sanitizedInput = sanitizeInput(filePath, 255);
    const relativePath = sanitizedInput.endsWith(AGENT_FILE_EXTENSION)
      ? sanitizedInput
      : this.getFilename(sanitizeInput(sanitizedInput, 100));

    try {
      validatePath(relativePath, this.elementDir);
    } catch (error) {
      logger.error(`Invalid agent path: ${error}`);
      throw new Error(`Invalid agent path: ${error instanceof Error ? error.message : 'Invalid path'}`);
    }

    const fullPath = this.resolveAbsolutePath(relativePath);

    try {
      const content = await this.fileOperations.readFile(fullPath, { encoding: 'utf-8' });

      if (content.length > MAX_FILE_SIZE) {
        throw new Error(`Agent file exceeds maximum size of ${MAX_FILE_SIZE} bytes`);
      }

      const parsed = this.parseAgentFile(content);
      const metadata = await this.parseMetadata(parsed.metadata);
      const agent = this.createElement(metadata, parsed.content);

      this.cacheElement(agent, relativePath);
      await this.hydrateAgentState(agent, this.stripExtension(relativePath));

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_LOADED',
        severity: 'LOW',
        source: `${this.constructor.name}.load`,
        details: `${this.getElementLabelCapitalized()} loaded: ${agent.metadata.name} v${agent.metadata.version || 'unknown'}`,
        additionalData: {
          agentId: agent.id,
          agentName: agent.metadata.name,
          version: agent.metadata.version,
          author: agent.metadata.author,
        }
      });

      return agent;
    } catch (error) {
      logger.error(`Failed to load agent from ${fullPath}:`, error);
      throw error;
    }
  }

  /**
   * Override BaseElementManager.save to persist state when required.
   */
  override async save(agent: Agent, filePath: string): Promise<void> {
    const sanitizedPath = filePath.endsWith(AGENT_FILE_EXTENSION)
      ? sanitizeInput(filePath, 255)
      : this.getFilename(sanitizeInput(filePath, 100));

    await this.ensureStateDirectory();
    await super.save(agent, sanitizedPath);

    if (agent.needsStatePersistence()) {
      const newVersion = await this.saveAgentState(this.stripExtension(sanitizedPath), agent.getState());
      agent[COMMIT_PERSISTED_VERSION](newVersion);  // Sync agent's internal version (Issue #123 fix)
      agent.markStatePersisted();
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

    const newVersion = await this.saveAgentState(name, agent.getState());
    agent[COMMIT_PERSISTED_VERSION](newVersion);
    agent.markStatePersisted();
    return true;
  }

  /**
   * Override delete to remove associated state file.
   *
   * FIX: Uses normalizeFilename() to ensure state file deletion matches
   * the normalized filename used for state file creation/loading.
   */
  override async delete(filePath: string): Promise<void> {
    const sanitizedPath = filePath.endsWith(AGENT_FILE_EXTENSION)
      ? sanitizeInput(filePath, 255)
      : this.getFilename(sanitizeInput(filePath, 100));
    const name = this.stripExtension(sanitizedPath);
    await super.delete(sanitizedPath);

    // FIX: Normalize name for consistent state file deletion
    const normalizedName = this.normalizeFilename(name);
    const statePath = path.join(this.stateDir, `${normalizedName}${STATE_FILE_EXTENSION}`);
    try {
      // Back up the state file before deleting it
      if (this.backupService) {
        const result = await this.backupService.backupBeforeDelete(statePath, ElementType.AGENT);
        if (!result.movedOriginal) {
          await this.fileOperations.deleteFile(statePath, ElementType.AGENT, {
            source: 'AgentManager.delete (state file)'
          });
        }
      } else {
        await this.fileOperations.deleteFile(statePath, ElementType.AGENT, {
          source: 'AgentManager.delete (state file)'
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    // FIX: Use normalized name as cache key for consistent cache cleanup
    this.stateCache.delete(normalizedName);
  }

  override async exists(filePath: string): Promise<boolean> {
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
  override async list(): Promise<Agent[]> {
    const agents = await super.list();

    // Apply active status to agents that are in the active set (by name)
    for (const agent of agents) {
      if (this.activeAgentNames.has(agent.metadata.name)) {
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
    this.activeAgentNames.add(agent.metadata.name);

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
    this.activeAgentNames.delete(agent.metadata.name);

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
    return agents.filter(a => this.activeAgentNames.has(a.metadata.name));
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
    parameters: Record<string, unknown>
  ): Promise<ExecuteAgentResult> {
    try {
      // 1. Load agent by name
      const agent = await this.read(name);
      if (!agent) {
        // FIX: Issue #275 - Throw ElementNotFoundError for consistent error handling
        throw new ElementNotFoundError('Agent', name);
      }

      // Get metadata as v2 (may have goal config)
      let metadata = agent.metadata as AgentMetadataV2;

      // Check if this is a v2.0 agent with goal configuration
      // If not, auto-convert V1 to V2 in place (Issue #587)
      if (!metadata.goal || !metadata.goal.template) {
        if (isV1Agent(metadata)) {
          const instructions = agent.extensions?.instructions || '';
          const conversionResult = convertV1ToV2(metadata, instructions);

          if (conversionResult.converted) {
            // Merge converted metadata onto the existing agent (in-place)
            Object.assign(metadata, conversionResult.metadata);
            Object.assign(agent.metadata, conversionResult.metadata);

            // Log conversion warnings
            if (conversionResult.warnings.length > 0) {
              logger.warn(`Agent '${name}' auto-converted from V1 to V2 in place`, {
                warnings: conversionResult.warnings,
              });
            }

            // Save the upgraded agent back to its original file
            const upgradedFilename = this.getFilename(sanitizeInput(name, 100));
            await this.save(agent, upgradedFilename);
            logger.info(`Agent '${name}' converted from V1 to V2 and saved in place`);
          } else {
            throw new Error(
              `Agent '${name}' cannot be executed: missing goal.template and conversion failed.`
            );
          }
        } else {
          throw new Error(
            `Agent '${name}' is not a v2.0 agent. Missing goal.template configuration.`
          );
        }
      }

      // 2. Clone parameters to prevent mutation of caller's object (Issue #118)
      const clonedParameters = structuredClone(parameters);

      // 2b. Security validation of template parameters (Issue #103)
      this.validateParameterSecurity(clonedParameters);

      // 3. Validate parameters against goal.parameters schema
      this.validateParameters(metadata.goal, clonedParameters);

      // 4. Render goal template by replacing {parameter} placeholders
      const renderedGoal = this.renderGoalTemplate(metadata.goal.template, clonedParameters);

      // 4b. Detect unmatched placeholders after rendering (Issue #126)
      const unmatchedPlaceholders = this.detectUnmatchedPlaceholders(renderedGoal);
      if (unmatchedPlaceholders.length > 0) {
        logger.warn('Unmatched template placeholders detected after rendering', {
          agentName: name,
          unmatched: unmatchedPlaceholders,
        });
      }

      // 5. Create execution context BEFORE activating elements (Issue #109 - circular activation detection)
      const executionContext = createExecutionContext(name);

      // 5b. Static activation cycle detection (Issue #374)
      if (metadata.activates?.agents?.length) {
        const cyclePath = await this.detectActivationCycles(name, metadata.activates.agents);
        if (cyclePath) {
          const cycleStart = cyclePath.indexOf(cyclePath[cyclePath.length - 1]);
          const cycle = cyclePath.slice(cycleStart);
          throw new Error(AgentManager.formatCircularActivationError(cycle));
        }
      }

      // 6. Activate elements (element-agnostic)
      const activeElements: Record<string, Array<{ name: string; content: string }>> = {};
      const activationWarnings: Array<{ elementType: string; elementName: string; error: string }> = [];

      if (metadata.activates) {
        for (const [elementType, elementNames] of Object.entries(metadata.activates)) {
          if (!elementNames || elementNames.length === 0) {
            continue;
          }

          activeElements[elementType] = [];

          for (const elementName of elementNames) {
            try {
              const elementContent = await this.getElementContent(elementType, elementName, executionContext);
              activeElements[elementType].push({
                name: elementName,
                content: elementContent
              });
            } catch (error) {
              // HIGH-1: Re-throw circular activation errors immediately (Issue #109)
              if (error instanceof Error && error.message.includes('Circular agent activation detected')) {
                throw error;
              }
              const errorMessage = error instanceof Error ? error.message : String(error);
              activationWarnings.push({ elementType, elementName, error: errorMessage });
              logger.warn(`Agent '${name}': failed to activate ${elementType} '${elementName}' — ${errorMessage}`);
              // Continue with other elements rather than failing completely
            }
          }
        }
      }

      // 7. Build the result with all context (initialize with default safety tier)
      const result: ExecuteAgentResult = {
        agentName: name,
        goal: renderedGoal,
        activeElements,
        activationWarnings: activationWarnings.length > 0 ? activationWarnings : undefined,
        // Issue #126: Warn about unmatched template placeholders
        templateWarnings: unmatchedPlaceholders.length > 0
          ? unmatchedPlaceholders.map(p => `Unmatched template placeholder: {${p}}`)
          : undefined,
        availableTools: metadata.tools?.allowed || [],
        successCriteria: metadata.goal.successCriteria || [],
        systemPrompt: metadata.systemPrompt,
        safetyTier: 'advisory', // Default, will be updated below
      };

      // 8. Create and persist the goal for LLM tracking
      // This allows record_agent_step to find and update the goal

      // Create the goal using agent.addGoal() which handles validation and sanitization
      const newGoal = agent.addGoal({
        description: renderedGoal,
        priority: 'medium',
        importance: 5,
        urgency: 5,
      });

      // Set goal status to in_progress since execution has started
      newGoal.status = 'in_progress';

      const execSanitizedName = sanitizeInput(name, 100);
      await this.save(agent, this.getFilename(execSanitizedName));

      // Store goalId in result for LLM to use with record_agent_step
      result.goalId = newGoal.id;

      // Fix #445: Include stateVersion so subsequent calls can do version-aware operations
      const postSaveState = agent.getState();
      result.stateVersion = postSaveState.stateVersion || 1;

      // Call validateGoalSecurity and add warnings to result
      const securityValidation = agent.validateGoalSecurity(renderedGoal);
      if (securityValidation.warnings && securityValidation.warnings.length > 0) {
        result.securityWarnings = securityValidation.warnings;
      }

      // Call evaluateConstraints and add to result
      result.constraints = agent.evaluateConstraints(newGoal);

      // Call assessRisk and add to result
      result.riskAssessment = agent.assessRisk('execute', newGoal, {});

      // Call calculatePriorityScore and add to result
      result.priorityScore = agent.calculatePriorityScore(newGoal);

      // 9. Determine safety tier based on risk assessment and security warnings
      // (Note: executionContext already created earlier for circular detection)
      const safetyTierResult = determineSafetyTier(
        result.riskAssessment?.score || 0,
        result.securityWarnings || [],
        renderedGoal,
        DEFAULT_SAFETY_CONFIG,
        executionContext
      );

      // 10. Set safety tier and related fields
      result.safetyTier = safetyTierResult.tier;
      result.safetyTierResult = safetyTierResult;
      result.executionContext = executionContext;

      // 11. Add tier-specific responses
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
          // Also add verification if not blocked
          if (!result.dangerZoneBlocked.blocked) {
            result.verificationRequired = result.dangerZoneBlocked.verificationRequired;
          }
          break;

        case 'advisory':
        default:
          // No additional action needed for advisory tier
          break;
      }

      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_EXECUTED',
        severity: 'LOW',
        source: 'AgentManager.executeAgent',
        details: `Agent executed: ${name} v${agent.metadata.version || 'unknown'} (safety: ${safetyTierResult.tier})`,
        additionalData: {
          agentId: agent.id,
          agentName: name,
          version: agent.metadata.version,
          author: agent.metadata.author,
          safetyTier: safetyTierResult.tier,
          riskScore: safetyTierResult.riskScore,
          parameterKeys: Object.keys(parameters || {}),
          goalCount: (metadata as any).goal?.parameters?.length || 0,
        }
      });

      return result;
    } catch (error) {
      logger.error(`Failed to execute agent '${name}':`, error);
      throw error;
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
    if (normalized.hasCriticalIssues) {
      throw new Error(
        `Template parameter security validation failed: ${normalized.errors.join('; ')}`
      );
    }

    // Apply normalized values back (in-place, since we already cloned)
    const normalizedData = normalized.data as Record<string, unknown>;
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
    parameters: Record<string, unknown>
  ): void {
    const paramDefs = goalConfig.parameters || [];

    // Check all required parameters are present
    for (const paramDef of paramDefs) {
      if (paramDef.required && !(paramDef.name in parameters)) {
        throw new Error(`Missing required parameter: ${paramDef.name}`);
      }
    }

    // Type check provided parameters
    for (const [key, value] of Object.entries(parameters)) {
      const paramDef = paramDefs.find(p => p.name === key);
      if (!paramDef) {
        logger.warn(`Unknown parameter '${key}' provided to agent`);
        continue;
      }

      // Type validation
      const actualType = typeof value;
      if (paramDef.type === 'string' && actualType !== 'string') {
        throw new Error(
          `Parameter '${key}' must be a string, got ${actualType}`
        );
      }
      if (paramDef.type === 'number' && actualType !== 'number') {
        throw new Error(
          `Parameter '${key}' must be a number, got ${actualType}`
        );
      }
      if (paramDef.type === 'boolean' && actualType !== 'boolean') {
        throw new Error(
          `Parameter '${key}' must be a boolean, got ${actualType}`
        );
      }

      // Advisory length warning for string values (defense-in-depth, does not throw)
      if (actualType === 'string' && (value as string).length > AGENT_LIMITS.MAX_GOAL_LENGTH) {
        logger.warn('Parameter string value exceeds MAX_GOAL_LENGTH (advisory)', {
          paramName: key,
          valueLength: (value as string).length,
          maxLength: AGENT_LIMITS.MAX_GOAL_LENGTH,
        });
      }
    }

    // Apply defaults for optional parameters not provided
    for (const paramDef of paramDefs) {
      if (!paramDef.required && !(paramDef.name in parameters) && paramDef.default !== undefined) {
        parameters[paramDef.name] = paramDef.default;
      }
    }
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

    // Helper: load an agent's activates.agents list (cached)
    const getActivatedAgents = async (name: string): Promise<string[]> => {
      const cacheKey = name.toLowerCase();
      if (agentCache.has(cacheKey)) {
        return agentCache.get(cacheKey) || [];
      }
      try {
        const agent = await this.read(name);
        if (!agent) {
          logger.warn(`Agent '${name}' referenced in activates.agents could not be resolved during cycle detection`);
          agentCache.set(cacheKey, null);
          return [];
        }
        const meta = agent.metadata as AgentMetadataV2;
        const agents = meta.activates?.agents || [];
        agentCache.set(cacheKey, agents);
        return agents;
      } catch {
        logger.warn(`Agent '${name}' referenced in activates.agents could not be resolved during cycle detection`);
        agentCache.set(cacheKey, null);
        return [];
      }
    };

    // Tracks nodes whose entire subtree has been explored without finding a cycle.
    // Prevents exponential re-exploration in diamond/convergent graphs.
    const fullyExplored = new Set<string>();
    let nodesVisited = 0;

    // DFS — stack entries: [currentAgent, pathSoFar, pathSetLower]
    // pathSetLower is a Set<string> of lowercased names for O(1) cycle checks
    const stack: Array<[string, string[], Set<string>]> = [];

    const rootLower = rootName.toLowerCase();
    for (const child of activatedAgents) {
      // Self-loop: agent directly activates itself
      if (child.toLowerCase() === rootLower) {
        return [rootName, child];
      }
      const pathSet = new Set<string>([rootLower, child.toLowerCase()]);
      stack.push([child, [rootName, child], pathSet]);
    }

    while (stack.length > 0) {
      const [current, currentPath, pathSet] = stack.pop()!;

      nodesVisited++;
      if (nodesVisited > AgentManager.MAX_NODES_VISITED) {
        logger.warn(
          `Activation cycle detection for '${rootName}' aborted: exceeded ${AgentManager.MAX_NODES_VISITED} nodes visited. ` +
          `The activation graph may be too large.`
        );
        return null;
      }

      if (currentPath.length > AgentManager.MAX_ACTIVATION_DEPTH + 1) {
        logger.warn(
          `Activation cycle detection for '${rootName}' hit depth limit of ${AgentManager.MAX_ACTIVATION_DEPTH}. ` +
          `Skipping deeper branches.`
        );
        continue;
      }

      const currentLower = current.toLowerCase();
      if (fullyExplored.has(currentLower)) {
        continue;
      }

      // Load this agent's activations
      const children = await getActivatedAgents(current);

      let foundCycle = false;
      for (const child of children) {
        const childLower = child.toLowerCase();

        // Check for cycle: does this child appear earlier in the path?
        if (pathSet.has(childLower)) {
          return [...currentPath, child];
        }

        if (!fullyExplored.has(childLower)) {
          const newPathSet = new Set(pathSet);
          newPathSet.add(childLower);
          stack.push([child, [...currentPath, child], newPathSet]);
          foundCycle = true; // has children to explore, not fully explored yet
        }
      }

      // If no unexplored children, this node's subtree is cycle-free
      if (!foundCycle) {
        fullyExplored.add(currentLower);
      }
    }

    return null;
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
    // Get the static resolver
    const resolver = AgentManager.getElementManagerResolver();
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
      const element = elements.find((e: any) => e.metadata.name === elementName);

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
          const entries = element.getEntries();
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
          const instructions = element.extensions?.instructions || '';
          return instructions;
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
    if (this.activeAgentNames.size < cleanupThreshold) {
      return;
    }

    // At or above max — warn before cleanup
    if (this.activeAgentNames.size >= max) {
      logger.warn(
        `Active agents limit reached (${max}). ` +
        `Consider deactivating unused agents or setting DOLLHOUSE_MAX_ACTIVE_AGENTS to a higher value.`
      );

      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_ACTIVATED',
        severity: 'MEDIUM',
        source: 'AgentManager.checkAndCleanupActiveSet',
        details: `Active agents limit reached (${this.activeAgentNames.size}/${max})`,
        additionalData: {
          activeCount: this.activeAgentNames.size,
          maxAllowed: max,
          activeAgentNames: Array.from(this.activeAgentNames),
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
      const startSize = this.activeAgentNames.size;
      const agents = await this.list();
      const existingAgentNames = new Set(agents.map(a => a.metadata.name));

      const staleNames: string[] = [];
      for (const activeName of this.activeAgentNames) {
        if (!existingAgentNames.has(activeName)) {
          this.activeAgentNames.delete(activeName);
          staleNames.push(activeName);
        }
      }

      const endSize = this.activeAgentNames.size;
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
  protected async saveAgentState(name: string, state: AgentState): Promise<number> {
    await this.ensureStateDirectory();

    // FIX: Normalize name for consistent state file naming
    const normalizedName = this.normalizeFilename(name);
    const filePath = path.join(this.stateDir, `${normalizedName}${STATE_FILE_EXTENSION}`);

    // FIX (Issue #107 - CRIT-2): Acquire file lock to prevent TOCTOU race condition
    // The lock covers the entire read-compare-write sequence to ensure atomicity
    await this.fileLockManager.withLock(`agent-state:${normalizedName}`, async () => {
      // FIX: Optimistic locking check (Issue #24)
      // Load existing state to compare versions before overwriting
      const existingState = await this.loadAgentState(name);
      if (existingState && existingState.stateVersion !== undefined && state.stateVersion !== undefined) {
        // Check if our state is based on the current version
        // If versions don't match, it means another process updated the state
        if (existingState.stateVersion > state.stateVersion) {
          logger.warn(`State version conflict detected for agent ${name}`, {
            existingVersion: existingState.stateVersion,
            attemptedVersion: state.stateVersion
          });

          SecurityMonitor.logSecurityEvent({
            type: 'MEMORY_SAVE_FAILED',
            severity: 'MEDIUM',
            source: 'AgentManager.saveAgentState',
            details: `State version conflict: attempted to save stale state`,
            additionalData: {
              agentName: name,
              existingVersion: existingState.stateVersion,
              attemptedVersion: state.stateVersion
            }
          });

          throw new Error(
            `State version conflict: current version is ${existingState.stateVersion}, ` +
            `but attempted to save version ${state.stateVersion}. ` +
            `State may have been modified concurrently.`
          );
        }
      }

      // FIX (Issue #123): Increment version BEFORE serialization, not during operations
      // This ensures version only increments on successful save
      state.stateVersion = (state.stateVersion || 0) + 1;

      const serializedState = this.prepareStateForSerialization(state);

      const yamlContent = this.serializationService.dumpYaml(serializedState, {
        schema: 'failsafe',
        noRefs: true,
        sortKeys: true
      });

      // Validate size
      this.serializationService.validateSize(yamlContent, MAX_YAML_SIZE, 'Agent state');

      await this.fileOperations.writeFile(filePath, yamlContent, { encoding: 'utf-8' });
      // FIX: Use normalized name as cache key for consistent lookups
      this.stateCache.set(normalizedName, state);

      logger.debug(`Agent state saved successfully`, {
        agentName: name,
        normalizedName,
        stateVersion: state.stateVersion,
        goalCount: state.goals?.length ?? 0
      });
    });

    // Return the new version for caller to sync agent's internal state
    // stateVersion is guaranteed to be a number after the increment above
    return state.stateVersion!;
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
    const state = await this.loadAgentState(name);
    if (!state) {
      return;
    }

    const serialized = JSON.parse(agent.serializeToJSON());
    serialized.state = state;
    agent.deserialize(JSON.stringify(serialized));
    agent.markStatePersisted();
  }

  private async loadAgentState(name: string): Promise<AgentState | null> {
    // FIX: Normalize name for consistent state file lookups
    const normalizedName = this.normalizeFilename(name);

    if (this.stateCache.has(normalizedName)) {
      return this.stateCache.get(normalizedName)!;
    }

    const stateFilename = `${normalizedName}${STATE_FILE_EXTENSION}`;
    const statePath = path.join(this.stateDir, stateFilename);

    try {
      const content = await this.fileOperations.readFile(statePath, { encoding: 'utf-8' });

      // Use SerializationService for YAML parsing
      // State files are pure YAML but parseFrontmatter handles both formats
      const result = this.serializationService.parseFrontmatter(content, {
        maxYamlSize: MAX_YAML_SIZE,
        validateContent: true,
        source: 'AgentManager.loadAgentState'
      });

      const state = result.data as AgentState;
      this.normalizeLoadedState(state);
      // FIX: Use normalized name as cache key for consistent lookups
      this.stateCache.set(normalizedName, state);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to load agent state: ${name}`, error);
      return null;
    }
  }

  private async ensureStateDirectory(): Promise<void> {
    await this.fileOperations.createDirectory(this.stateDir);
  }

  protected override async parseMetadata(data: any): Promise<AgentMetadata> {
    const metadata = { ...(data as any) };

    // --- START: Backward Compatibility Fix for Legacy Agent Types ---
    // Legacy agent definition files might use 'agent' (singular) instead of
    // ElementType.AGENT ('agents'). This converts the singular form to the
    // correct plural enum value to ensure backward compatibility.
    if (metadata.type === 'agent') {
      metadata.type = ElementType.AGENT;
    }
    // --- END: Backward Compatibility Fix ---

    // Validate that the type is now ElementType.AGENT (plural)
    if (metadata.type && metadata.type !== ElementType.AGENT) {
      throw new Error(`Invalid element type: expected '${ElementType.AGENT}', got '${metadata.type}'`);
    }

    // REFACTORED: Use ValidationService for name validation
    if (metadata.name) {
      const nameResult = this.validationService.validateAndSanitizeInput(metadata.name, {
        maxLength: 100,
        allowSpaces: true
      });
      if (!nameResult.isValid) {
        throw new Error(`Invalid agent name: ${nameResult.errors?.join(', ')}`);
      }
      metadata.name = nameResult.sanitizedValue;
    }

    // REFACTORED: Use ValidationService for description validation
    // FIX: Must specify fieldType: 'description' to allow punctuation like colons, semicolons, etc.
    if (metadata.description) {
      const descResult = this.validationService.validateAndSanitizeInput(metadata.description, {
        maxLength: 500,
        allowSpaces: true,
        fieldType: 'description'
      });
      if (!descResult.isValid) {
        throw new Error(`Invalid agent description: ${descResult.errors?.join(', ')}`);
      }
      metadata.description = descResult.sanitizedValue;
    }

    // REFACTORED: Use ValidationService for specializations array
    if (Array.isArray(metadata.specializations)) {
      const validatedSpecializations: string[] = [];
      for (const value of metadata.specializations) {
        const result = this.validationService.validateAndSanitizeInput(String(value), {
          maxLength: 50,
          allowSpaces: true
        });
        if (!result.isValid) {
          throw new Error(`Invalid specialization "${value}": ${result.errors?.join(', ')}`);
        }
        validatedSpecializations.push(result.sanitizedValue!);
      }
      metadata.specializations = validatedSpecializations;
    }

    // KEEP: TriggerValidationService (already using service pattern)
    if (metadata.triggers && Array.isArray(metadata.triggers)) {
      const validationResult = this.triggerValidationService.validateTriggers(
        metadata.triggers,
        ElementType.AGENT,
        metadata.name || 'unknown'
      );
      metadata.triggers = validationResult.validTriggers;
    }

    // Issue #676: Sanitize gatekeeper policy on load to prevent prompt-injection attacks
    // Malformed policies are stripped and logged as security events (never reach enforcement)
    if (metadata.gatekeeper) {
      metadata.gatekeeper = sanitizeGatekeeperPolicy(metadata.gatekeeper, metadata.name || 'unknown', 'agent');
    }

    // Issue #722: Validate V2 agent fields on load — structural checks, strip malformed data.
    // Fail-open: corrupted fields are removed and logged, not thrown. This prevents
    // bad data from reaching execution time while keeping the agent loadable.
    const agentName = metadata.name || 'unknown';

    // Issue #697: Normalize `goals` (plural) → `goal` (singular)
    if (metadata.goals !== undefined && metadata.goal === undefined) {
      metadata.goal = metadata.goals;
      delete metadata.goals;
      logger.warn(`[parseMetadata] Agent '${agentName}': migrated 'goals' (plural) to 'goal'`);
    } else if (metadata.goals !== undefined) {
      // `goal` already set — drop the redundant plural form
      delete metadata.goals;
    }

    if (metadata.goal) {
      if (typeof metadata.goal === 'object' && typeof metadata.goal.template === 'string') {
        // Issue #725: Normalize snake_case goal sub-fields
        normalizeGoalKeys(metadata.goal as unknown as Record<string, unknown>);

        // Validate parameters array if present
        if (metadata.goal.parameters && !Array.isArray(metadata.goal.parameters)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': goal.parameters is not an array, stripping`);
          delete metadata.goal.parameters;
        }
        // Validate successCriteria array if present
        if (metadata.goal.successCriteria && !Array.isArray(metadata.goal.successCriteria)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': goal.successCriteria is not an array, stripping`);
          delete metadata.goal.successCriteria;
        }
      } else if (typeof metadata.goal !== 'string') {
        // goal must be a string or an object with template — anything else is invalid
        logger.warn(`[parseMetadata] Agent '${agentName}': goal is malformed (no template), stripping`);
        delete metadata.goal;
      }
    }

    if (metadata.activates) {
      if (typeof metadata.activates !== 'object' || Array.isArray(metadata.activates)) {
        logger.warn(`[parseMetadata] Agent '${agentName}': activates is not an object, stripping`);
        delete metadata.activates;
      } else {
        // Each key should map to a string array
        for (const [key, value] of Object.entries(metadata.activates)) {
          if (value !== undefined && !Array.isArray(value)) {
            logger.warn(`[parseMetadata] Agent '${agentName}': activates.${key} is not an array, stripping`);
            delete metadata.activates[key];
          }
        }
      }
    }

    if (metadata.tools) {
      if (typeof metadata.tools !== 'object' || Array.isArray(metadata.tools)) {
        logger.warn(`[parseMetadata] Agent '${agentName}': tools is not an object, stripping`);
        delete metadata.tools;
      } else if (!Array.isArray(metadata.tools.allowed)) {
        logger.warn(`[parseMetadata] Agent '${agentName}': tools.allowed is not an array, stripping tools`);
        delete metadata.tools;
      } else {
        // Gap 3: Validate tools.denied is an array if present
        if (metadata.tools.denied !== undefined && !Array.isArray(metadata.tools.denied)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': tools.denied is not an array, stripping`);
          delete metadata.tools.denied;
        }
      }
    }

    // Issue #725: Normalize system_prompt → systemPrompt (LLMs commonly use snake_case)
    const anyMeta = metadata as Record<string, unknown>;
    if (anyMeta.system_prompt !== undefined && metadata.systemPrompt === undefined) {
      anyMeta.systemPrompt = anyMeta.system_prompt;
    }
    delete anyMeta.system_prompt;

    if (metadata.systemPrompt !== undefined && typeof metadata.systemPrompt !== 'string') {
      logger.warn(`[parseMetadata] Agent '${agentName}': systemPrompt is not a string, stripping`);
      delete metadata.systemPrompt;
    }

    // Issue #697: Promote root-level V1 autonomy fields into the `autonomy` block.
    // V1 agents stored riskTolerance and maxAutonomousSteps at the metadata root.
    // V2 nests them under `autonomy`. This promotion ensures downstream code only
    // checks one location. The existing autonomy validation below validates values.
    // Precedence: camelCase variants are listed before snake_case/short forms, so
    // e.g. `riskTolerance` wins over `risk_tolerance` if both appear at root.
    {
      const rootAutonomyFields: ReadonlyArray<readonly [string, string]> = [
        ['riskTolerance', 'riskTolerance'],
        ['risk_tolerance', 'riskTolerance'],
        ['maxAutonomousSteps', 'maxAutonomousSteps'],
        ['max_autonomous_steps', 'maxAutonomousSteps'],
        ['maxSteps', 'maxAutonomousSteps'],
      ] as const;
      let promoted = false;
      for (const [rootKey, autonomyKey] of rootAutonomyFields) {
        if (anyMeta[rootKey] !== undefined) {
          if (!metadata.autonomy) {
            metadata.autonomy = {};
          }
          const aBlock = metadata.autonomy as Record<string, unknown>;
          if (aBlock[autonomyKey] === undefined) {
            aBlock[autonomyKey] = anyMeta[rootKey];
            promoted = true;
          }
          delete anyMeta[rootKey];
        }
      }
      if (promoted) {
        logger.warn(`[parseMetadata] Agent '${agentName}': promoted root-level autonomy fields into autonomy block`);
      }
    }

    if (metadata.autonomy) {
      if (typeof metadata.autonomy !== 'object' || Array.isArray(metadata.autonomy)) {
        logger.warn(`[parseMetadata] Agent '${agentName}': autonomy is not an object, stripping`);
        delete metadata.autonomy;
      } else {
        // Issue #730: Shared normalization (was duplicated in parseMetadata + validateV2FieldsForCreate)
        const a = metadata.autonomy as Record<string, unknown>;
        normalizeAutonomyKeys(a);

        // Validate specific fields
        // Gap 4: Validate riskTolerance enum (uses shared constants from Issue #727)
        if (a.riskTolerance !== undefined &&
            !isOneOf(a.riskTolerance, RISK_TOLERANCE_LEVELS)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': autonomy.riskTolerance '${a.riskTolerance}' is invalid, stripping`);
          delete a.riskTolerance;
        }
        if (a.maxAutonomousSteps !== undefined &&
            typeof a.maxAutonomousSteps !== 'number') {
          logger.warn(`[parseMetadata] Agent '${agentName}': autonomy.maxAutonomousSteps is not a number, stripping`);
          delete a.maxAutonomousSteps;
        }
        if (a.requiresApproval !== undefined &&
            !Array.isArray(a.requiresApproval)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': autonomy.requiresApproval is not an array, stripping`);
          delete a.requiresApproval;
        }
        if (a.autoApprove !== undefined &&
            !Array.isArray(a.autoApprove)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': autonomy.autoApprove is not an array, stripping`);
          delete a.autoApprove;
        }
      }
    }

    if (metadata.resilience) {
      if (typeof metadata.resilience !== 'object' || Array.isArray(metadata.resilience)) {
        logger.warn(`[parseMetadata] Agent '${agentName}': resilience is not an object, stripping`);
        delete metadata.resilience;
      } else {
        // Issue #730: Shared normalization (was duplicated in parseMetadata + validateV2FieldsForCreate)
        const r = metadata.resilience as Record<string, unknown>;
        normalizeResilienceKeys(r);

        // Issue #727: Use shared enum constants for resilience validation
        if (r.onStepLimitReached !== undefined &&
            !isOneOf(r.onStepLimitReached, STEP_LIMIT_ACTIONS)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': resilience.onStepLimitReached '${r.onStepLimitReached}' is invalid, stripping`);
          delete r.onStepLimitReached;
        }
        if (r.onExecutionFailure !== undefined &&
            !isOneOf(r.onExecutionFailure, EXECUTION_FAILURE_ACTIONS)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': resilience.onExecutionFailure '${r.onExecutionFailure}' is invalid, stripping`);
          delete r.onExecutionFailure;
        }
        if (r.maxRetries !== undefined &&
            typeof r.maxRetries !== 'number') {
          logger.warn(`[parseMetadata] Agent '${agentName}': resilience.maxRetries is not a number, stripping`);
          delete r.maxRetries;
        }
        if (r.maxContinuations !== undefined &&
            typeof r.maxContinuations !== 'number') {
          logger.warn(`[parseMetadata] Agent '${agentName}': resilience.maxContinuations is not a number, stripping`);
          delete r.maxContinuations;
        }
        // Gap 5: Validate retryBackoff enum and preserveState boolean (shared constants from Issue #727)
        if (r.retryBackoff !== undefined &&
            !isOneOf(r.retryBackoff, BACKOFF_STRATEGIES)) {
          logger.warn(`[parseMetadata] Agent '${agentName}': resilience.retryBackoff '${r.retryBackoff}' is invalid, stripping`);
          delete r.retryBackoff;
        }
        if (r.preserveState !== undefined &&
            typeof r.preserveState !== 'boolean') {
          logger.warn(`[parseMetadata] Agent '${agentName}': resilience.preserveState is not a boolean, stripping`);
          delete r.preserveState;
        }
      }
    }

    // Tags: validate as string array (common field, all element types)
    if (metadata.tags !== undefined) {
      if (!Array.isArray(metadata.tags)) {
        logger.warn(`[parseMetadata] Agent '${agentName}': tags is not an array, stripping`);
        delete metadata.tags;
      } else {
        metadata.tags = metadata.tags.filter((t: unknown) => typeof t === 'string');
      }
    }

    return metadata as AgentMetadata;
  }

  protected override createElement(metadata: AgentMetadata, bodyContent: string): Agent {
    const agent = new Agent(metadata, this.metadataService);
    // Dual-field: detect v2 format (instructions in YAML frontmatter)
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
    // Start with base metadata fields (always present)
    const metadata: Record<string, unknown> = {
      name: agent.metadata.name,
      type: toSingularLabel(ElementType.AGENT),
      unique_id: agent.id,
      version: agent.metadata.version,
      author: agent.metadata.author,
      created: agent.metadata.created ?? new Date().toISOString(),
      modified: agent.metadata.modified ?? new Date().toISOString(),
      description: agent.metadata.description,
    };

    // Cast to check for v2 fields
    const metadataV2 = agent.metadata as AgentMetadataV2;

    // Add v2 fields if present (goal is required in v2, others optional)
    if (metadataV2.goal) {
      metadata.goal = metadataV2.goal;
    }
    if (metadataV2.activates) {
      metadata.activates = metadataV2.activates;
    }
    if (metadataV2.tools) {
      metadata.tools = metadataV2.tools;
    }
    if (metadataV2.systemPrompt) {
      metadata.systemPrompt = metadataV2.systemPrompt;
    }
    if (metadataV2.autonomy) {
      metadata.autonomy = metadataV2.autonomy;
    }
    // Issue #449: Serialize gatekeeper policy to YAML frontmatter
    if (metadataV2.gatekeeper) {
      metadata.gatekeeper = metadataV2.gatekeeper;
    }
    // Issue #526: Serialize resilience policy to YAML frontmatter
    if (metadataV2.resilience) {
      metadata.resilience = metadataV2.resilience;
    }

    // Issue #722: Only serialize v1 fields for agents WITHOUT a goal (legacy v1 agents).
    // V2 agents (with goal) should not carry deprecated v1 baggage like
    // decisionFramework, riskTolerance, learningEnabled, maxConcurrentGoals.
    // The Agent constructor still applies these defaults at runtime for backward
    // compat when reading old files — but we don't write them into new v2 agents.
    const isV2Agent = !!metadataV2.goal;
    if (!isV2Agent) {
      if (metadataV2.decisionFramework) {
        metadata.decisionFramework = metadataV2.decisionFramework;
      }
      if (metadataV2.riskTolerance) {
        metadata.riskTolerance = metadataV2.riskTolerance;
      }
      if (metadataV2.learningEnabled !== undefined) {
        metadata.learningEnabled = metadataV2.learningEnabled;
      }
      if (metadataV2.maxConcurrentGoals !== undefined) {
        metadata.maxConcurrentGoals = metadataV2.maxConcurrentGoals;
      }
    }
    // specializations is not a deprecated v1 field — always serialize
    if (metadataV2.specializations) {
      metadata.specializations = metadataV2.specializations;
    }
    // Issue #722: Serialize tags and triggers to YAML frontmatter
    if (metadataV2.tags && Array.isArray(metadataV2.tags) && metadataV2.tags.length > 0) {
      metadata.tags = metadataV2.tags;
    }
    if (metadataV2.triggers) {
      metadata.triggers = metadataV2.triggers;
    }
    if (metadataV2.ruleEngineConfig !== undefined) {
      metadata.ruleEngineConfig = metadataV2.ruleEngineConfig;
    }

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

    // --- tools ---
    if (metadata.tools !== undefined) {
      if (typeof metadata.tools !== 'object' || Array.isArray(metadata.tools) || metadata.tools === null) {
        errors.push('tools must be an object with allowed/denied arrays');
      } else {
        if (!Array.isArray(metadata.tools.allowed)) {
          errors.push('tools.allowed is required and must be an array of strings');
        }
        if (metadata.tools.denied !== undefined && !Array.isArray(metadata.tools.denied)) {
          errors.push('tools.denied must be an array of strings');
        }
      }
    }

    // --- systemPrompt ---
    if (metadata.systemPrompt !== undefined && typeof metadata.systemPrompt !== 'string') {
      errors.push('systemPrompt must be a string');
    }
    // snake_case variant (Issue #725: normalized at dispatcher level eventually)
    const anyMeta = metadata as Record<string, unknown>;
    if (anyMeta.system_prompt !== undefined && metadata.systemPrompt === undefined) {
      if (typeof anyMeta.system_prompt === 'string') {
        metadata.systemPrompt = anyMeta.system_prompt as string;
      } else {
        errors.push('system_prompt must be a string');
      }
      delete anyMeta.system_prompt;
    }

    // --- autonomy ---
    if (metadata.autonomy !== undefined) {
      if (typeof metadata.autonomy !== 'object' || Array.isArray(metadata.autonomy) || metadata.autonomy === null) {
        errors.push('autonomy must be an object');
      } else {
        // Issue #730: Shared normalization
        const a = metadata.autonomy as Record<string, unknown>;
        normalizeAutonomyKeys(a);

        // Validate after normalization
        if (a.riskTolerance !== undefined &&
            !isOneOf(a.riskTolerance, RISK_TOLERANCE_LEVELS)) {
          errors.push(`autonomy.riskTolerance must be one of: ${RISK_TOLERANCE_LEVELS.join(', ')} (got '${a.riskTolerance}')`);
        }
        if (a.maxAutonomousSteps !== undefined && typeof a.maxAutonomousSteps !== 'number') {
          errors.push('autonomy.maxAutonomousSteps must be a number');
        }
        if (a.requiresApproval !== undefined && !Array.isArray(a.requiresApproval)) {
          errors.push('autonomy.requiresApproval must be an array of strings');
        }
        if (a.autoApprove !== undefined && !Array.isArray(a.autoApprove)) {
          errors.push('autonomy.autoApprove must be an array of strings');
        }
      }
    }

    // --- resilience ---
    if (metadata.resilience !== undefined) {
      if (typeof metadata.resilience !== 'object' || Array.isArray(metadata.resilience) || metadata.resilience === null) {
        errors.push('resilience must be an object');
      } else {
        // Issue #730: Shared normalization
        const r = metadata.resilience as Record<string, unknown>;
        normalizeResilienceKeys(r);

        // Validate after normalization
        if (r.onStepLimitReached !== undefined &&
            !isOneOf(r.onStepLimitReached, STEP_LIMIT_ACTIONS)) {
          errors.push(`resilience.onStepLimitReached must be one of: ${STEP_LIMIT_ACTIONS.join(', ')} (got '${r.onStepLimitReached}')`);
        }
        if (r.onExecutionFailure !== undefined &&
            !isOneOf(r.onExecutionFailure, EXECUTION_FAILURE_ACTIONS)) {
          errors.push(`resilience.onExecutionFailure must be one of: ${EXECUTION_FAILURE_ACTIONS.join(', ')} (got '${r.onExecutionFailure}')`);
        }
        if (r.maxRetries !== undefined && typeof r.maxRetries !== 'number') {
          errors.push('resilience.maxRetries must be a number');
        }
        if (r.maxContinuations !== undefined && typeof r.maxContinuations !== 'number') {
          errors.push('resilience.maxContinuations must be a number');
        }
        if (r.retryBackoff !== undefined &&
            !isOneOf(r.retryBackoff, BACKOFF_STRATEGIES)) {
          errors.push(`resilience.retryBackoff must be one of: ${BACKOFF_STRATEGIES.join(', ')} (got '${r.retryBackoff}')`);
        }
        if (r.preserveState !== undefined && typeof r.preserveState !== 'boolean') {
          errors.push('resilience.preserveState must be a boolean');
        }
      }
    }

    // --- activates ---
    if (metadata.activates !== undefined) {
      if (typeof metadata.activates !== 'object' || Array.isArray(metadata.activates) || metadata.activates === null) {
        errors.push('activates must be an object with skills/personas/memories/templates/ensembles arrays');
      }
    }

    return errors;
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
        const type = validParamTypes.includes(p.type as typeof validParamTypes[number])
          ? p.type as 'string' | 'number' | 'boolean'
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

  private parseAgentFile(content: string): ParsedAgentFile {
    // Use SerializationService for frontmatter parsing
    const result = this.serializationService.parseFrontmatter(content, {
      maxYamlSize: MAX_YAML_SIZE,
      validateContent: false,
      source: 'AgentManager.parseAgentFile'
    });

    // SerializationService ensures frontmatter exists, or throws error
    return {
      metadata: result.data as AgentMetadata,
      content: result.content.trim()
    };
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

  private prepareStateForSerialization(state: AgentState): Record<string, unknown> {
    return {
      ...state,
      lastActive: state.lastActive instanceof Date ? state.lastActive.toISOString() : state.lastActive,
      sessionCount: String(state.sessionCount ?? 0),
      stateVersion: state.stateVersion !== undefined ? String(state.stateVersion) : '1',  // Include version for optimistic locking
      goals: state.goals.map(goal => ({
        ...goal,
        createdAt: goal.createdAt instanceof Date ? goal.createdAt.toISOString() : goal.createdAt,
        updatedAt: goal.updatedAt instanceof Date ? goal.updatedAt.toISOString() : goal.updatedAt,
        completedAt: goal.completedAt instanceof Date ? goal.completedAt.toISOString() : goal.completedAt,
        importance: goal.importance !== undefined ? String(goal.importance) : undefined,
        urgency: goal.urgency !== undefined ? String(goal.urgency) : undefined,
        estimatedEffort: goal.estimatedEffort !== undefined ? String(goal.estimatedEffort) : undefined
      })),
      decisions: state.decisions.map(decision => ({
        ...decision,
        timestamp: decision.timestamp instanceof Date ? decision.timestamp.toISOString() : decision.timestamp,
        confidence: decision.confidence !== undefined ? String(decision.confidence) : undefined
      }))
    };
  }

  private normalizeLoadedState(state: AgentState): void {
    // FIX (Issue #123): Default missing arrays to prevent TypeError
    // If state file is missing goals/decisions/context, default to empty arrays/objects
    if (!state.goals) {
      state.goals = [];
    }
    if (!state.decisions) {
      state.decisions = [];
    }
    if (!state.context) {
      state.context = {};
    }

    if (state.sessionCount !== undefined) {
      state.sessionCount = Number.parseInt(String(state.sessionCount), 10);
    }

    // Parse stateVersion for optimistic locking (Issue #24)
    if (state.stateVersion !== undefined) {
      state.stateVersion = Number.parseInt(String(state.stateVersion), 10);
    } else {
      // Default to version 1 if not present (for backward compatibility)
      state.stateVersion = 1;
    }

    if (state.lastActive) {
      state.lastActive = new Date(state.lastActive);
    }

    if (state.goals) {
      state.goals.forEach(goal => {
        if (goal.importance !== undefined) {
          goal.importance = Number.parseInt(String(goal.importance), 10);
        }
        if (goal.urgency !== undefined) {
          goal.urgency = Number.parseInt(String(goal.urgency), 10);
        }
        if (goal.estimatedEffort !== undefined) {
          goal.estimatedEffort = Number.parseFloat(String(goal.estimatedEffort));
        }
        if (goal.createdAt) {
          goal.createdAt = new Date(goal.createdAt);
        }
        if (goal.updatedAt) {
          goal.updatedAt = new Date(goal.updatedAt);
        }
        if (goal.completedAt) {
          goal.completedAt = new Date(goal.completedAt);
        }
      });
    }

    if (state.decisions) {
      state.decisions.forEach(decision => {
        if (decision.confidence !== undefined) {
          decision.confidence = Number.parseFloat(String(decision.confidence));
        }
        if (decision.timestamp) {
          decision.timestamp = new Date(decision.timestamp);
        }
      });
    }
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
      dangerZoneEnforcer: AgentManager.dangerZoneEnforcerResolver?.(),
      verificationStore: AgentManager.verificationStoreResolver?.(),
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

    // 3. Check if agent has been executed before
    const isResuming = state.sessionCount > 0 || state.decisions.length > 0;

    // 4. Execute agent normally (this activates elements and gets context)
    const executionParams = params.parameters || {};

    const executionResult = await this.executeAgent(
      params.agentName,
      executionParams
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
