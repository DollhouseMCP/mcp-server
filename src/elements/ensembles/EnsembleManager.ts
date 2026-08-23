/**
 * EnsembleManager - Implementation of IElementManager for Ensemble elements
 *
 * Handles CRUD operations and lifecycle management for ensembles implementing IElement
 *
 * ARCHITECTURE:
 * - Extends BaseElementManager for unified element management
 * - Follows template method pattern (parseMetadata, createElement hooks)
 * - Pure manager layer - delegates business logic to Ensemble class
 * - Uses DI for dependencies (PortfolioManager, FileLockManager)
 *
 * SECURITY:
 * - Uses FileLockManager for atomic file operations
 * - Path validation prevents directory traversal attacks
 * - Input sanitization for all user data
 * - Security event logging for audit trails
 * - SecureYamlParser for safe YAML parsing
 */

import type { EnsembleMetadata, EnsembleElement } from './Ensemble.js';
import { Ensemble } from './Ensemble.js';
import type { ElementValidationResult } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import type { ElementManagerDeps } from '../base/BaseElementManager.js';
import { BaseElementManager } from '../base/BaseElementManager.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import {
  ENSEMBLE_DEFAULTS,
  ENSEMBLE_LIMITS,
  ENSEMBLE_SECURITY_EVENTS,
  ENSEMBLE_ERRORS,
  ACTIVATION_STRATEGIES,
  CONFLICT_STRATEGIES,
  ELEMENT_ROLES,
  ACTIVATION_MODES
} from './constants.js';
import type { ActivationStrategy, ConflictResolutionStrategy, ElementRole, ActivationMode } from './types.js';
import type { ValidationService } from '../../services/validation/ValidationService.js';
import type { SerializationService } from '../../services/SerializationService.js';
import type { MetadataService } from '../../services/MetadataService.js';
import { ElementMessages } from '../../utils/elementMessages.js';
import { VALIDATION_PATTERNS, SECURITY_LIMITS } from '../../security/constants.js';
import { sanitizeGatekeeperPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';

// Issue #83: Centralized active element limits (configurable via env vars)
import { getActiveElementLimitConfig, getMaxActiveLimit } from '../../config/active-element-limits.js';

// Issue #466: Shared element type resolver — re-exported for backward compatibility
export { resolveElementTypes, type ElementManagersForResolution } from '../../utils/elementTypeResolver.js';

/** @deprecated Use resolveElementTypes from '../../utils/elementTypeResolver.js' */
export { resolveElementTypes as resolveEnsembleElementTypes } from '../../utils/elementTypeResolver.js';

const LEGACY_ELEMENT_FIELD_REPLACEMENTS = {
  name: 'element_name',
  type: 'element_type',
} as const;

type LegacyElementField = keyof typeof LEGACY_ELEMENT_FIELD_REPLACEMENTS;

/**
 * EnsembleManager - Manages ensemble element lifecycle
 *
 * Extends BaseElementManager to provide ensemble-specific operations:
 * - YAML parsing with both snake_case and camelCase support
 * - Ensemble creation and validation
 * - Element reference management
 * - Import/export in multiple formats
 */
export class EnsembleManager extends BaseElementManager<Ensemble> {
  private readonly ensemblesDir: string;
  private readonly validationService: ValidationService;
  private readonly serializationService: SerializationService;
  private readonly metadataService: MetadataService;
  private readonly _localActiveEnsembleNames: Set<string> = new Set();
  private readonly legacyElementFieldWarnings: Set<string> = new Set();

  constructor(deps: ElementManagerDeps) {
    super(
      ElementType.ENSEMBLE,
      deps.portfolioManager,
      deps.fileLockManager,
      {
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
    this.ensemblesDir = this.elementDir;
    this.metadataService = deps.metadataService;
    this.validationService = deps.validationRegistry.getValidationService();
    this.serializationService = deps.serializationService;
  }

  /** Issue #1946: Per-session activation state via base class helper. */
  private getActivationSet(): Set<string> {
    return this.resolveActivationSet('ensembles', this._localActiveEnsembleNames);
  }

  protected override getElementLabel(): string {
    return 'ensemble';
  }

  /**
   * Clear in-memory warn-once state for legacy ensemble element fields.
   *
   * Useful for long-lived processes or tests that intentionally want to
   * observe the warning path again after a maintenance boundary.
   */
  public clearLegacyElementWarningHistory(): void {
    this.legacyElementFieldWarnings.clear();
  }

  override dispose(): void {
    super.dispose();
    this.clearLegacyElementWarningHistory();
  }

  /**
   * Warn once per ensemble/index/field combination when a legacy nested field
   * is encountered while loading or parsing an ensemble.
   *
   * Fingerprinting keeps the warning visible for each distinct legacy field
   * without re-emitting the same deprecation notice on every re-parse.
   *
   * @param ensembleName - Name of the ensemble containing the legacy field
   * @param index - Zero-based index of the element within the ensemble
   * @param field - Legacy nested field name that should be migrated
   */
  private warnOnceForLegacyElementField(
    ensembleName: string,
    index: number,
    field: LegacyElementField,
  ): void {
    const replacement = LEGACY_ELEMENT_FIELD_REPLACEMENTS[field];
    const fingerprint = `${ensembleName}:${index}:${field}`;
    if (this.legacyElementFieldWarnings.has(fingerprint)) {
      return;
    }

    this.legacyElementFieldWarnings.add(fingerprint);
    logger.warn(
      `Ensemble '${ensembleName}' element at index ${index} uses deprecated '${field}' field. Use '${replacement}' instead.`,
    );
  }

  private hasLegacyElementFields(elementsRaw: unknown): boolean {
    if (!Array.isArray(elementsRaw)) {
      return false;
    }

    return elementsRaw.some((elem) =>
      elem
      && typeof elem === 'object'
      && (
        ('name' in (elem as Record<string, unknown>) && !('element_name' in (elem as Record<string, unknown>)))
        || ('type' in (elem as Record<string, unknown>) && !('element_type' in (elem as Record<string, unknown>)))
      )
    );
  }

  /**
   * Rewrite legacy ensemble element field names (`name`/`type`) to the
   * canonical `element_name`/`element_type` form by loading and resaving
   * affected ensembles.
   */
  async repairLegacyElementFields(): Promise<{
    scanned: number;
    repaired: number;
    errors: number;
    repairedEnsembles: Array<{ name: string; path: string }>;
  }> {
    const result = {
      scanned: 0,
      repaired: 0,
      errors: 0,
      repairedEnsembles: [] as Array<{ name: string; path: string }>,
    };

    const elementType = this.getElementType();
    const files = await this.portfolioManager.listElements(elementType);
    for (const file of files) {
      result.scanned++;
      try {
        const absolutePath = this.resolveAbsolutePath(file);
        const raw = await this.fileOperations.readElementFile(absolutePath, elementType, {
          source: `${this.constructor.name}.repairLegacyElementFields`,
        });
        const parsed = SecureYamlParser.safeMatter(raw);

        if (!this.hasLegacyElementFields(parsed.data.elements)) {
          continue;
        }

        const ensemble = await this.load(file);
        await this.save(ensemble, file);

        result.repaired++;
        result.repairedEnsembles.push({
          name: ensemble.metadata.name,
          path: file,
        });
      } catch (error) {
        result.errors++;
        logger.error(`[EnsembleManager] Failed to repair legacy element fields in '${file}':`, error);
      }
    }

    return result;
  }

  /**
   * Parse metadata from YAML frontmatter
   *
   * NAMING CONVENTION SUPPORT:
   * - TypeScript interfaces use camelCase (activationStrategy, conflictResolution)
   * - YAML files can use snake_case (activation_strategy, conflict_resolution)
   * - This method maps snake_case → camelCase for user convenience
   *
   * @param data - Raw YAML data from frontmatter
   * @returns Validated EnsembleMetadata
   */
  protected override parseMetadata(data: any): Promise<EnsembleMetadata> {
    const name = this.parseName(data);
    const activationStrategy = this.parseActivationStrategy(data);
    const conflictResolution = this.parseConflictResolution(data);
    const contextSharing = this.parseContextSharing(data);
    const elements = this.parseElements(data, name);
    if (elements.length > ENSEMBLE_LIMITS.MAX_ELEMENTS) {
      throw new Error(ENSEMBLE_ERRORS.TOO_MANY_ELEMENTS);
    }

    return Promise.resolve({
      name,
      description: this.parseDescription(data),
      version: data.version || '1.0.0',
      author: data.author,
      created: data.created,
      modified: data.modified || new Date().toISOString(),
      tags: this.parseTags(data),
      instructions: typeof data.instructions === 'string' ? data.instructions : undefined,
      activationStrategy,
      conflictResolution,
      contextSharing,
      resourceLimits: this.parseResourceLimits(data),
      allowNested: this.parseAllowNested(data),
      maxNestingDepth: data.max_nesting_depth || data.maxNestingDepth || ENSEMBLE_DEFAULTS.MAX_NESTING_DEPTH,
      elements,
      gatekeeper: sanitizeGatekeeperPolicy(data.gatekeeper, name, 'ensemble', data as Record<string, unknown>),
    });
  }

  private parseName(data: any): string {
    const nameResult = this.validationService.validateMetadataField('name', data.name, {
      required: true,
      maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH
    });
    const name = this.requireSanitizedValue(nameResult, 'Validation failed');
    if (!name) {
      throw new Error('Ensemble metadata must include a name');
    }
    return name;
  }

  private parseDescription(data: any): string {
    if (!data.description) {
      return '';
    }
    const result = this.validationService.validateMetadataField('description', data.description, {
      required: false,
      maxLength: SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH,
      pattern: VALIDATION_PATTERNS.SAFE_DESCRIPTION
    });
    return this.requireSanitizedValue(result, 'Validation failed');
  }

  private parseActivationStrategy(data: any): ActivationStrategy {
    const raw = data.activation_strategy || data.activationStrategy || ENSEMBLE_DEFAULTS.ACTIVATION_STRATEGY;
    const activationStrategy = this.sanitizeEnumValue(raw, 'activation strategy');
    if (!ACTIVATION_STRATEGIES.includes(activationStrategy as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_STRATEGY}: ${activationStrategy}`);
    }
    return activationStrategy as ActivationStrategy;
  }

  private parseConflictResolution(data: any): ConflictResolutionStrategy {
    const raw = data.conflict_resolution || data.conflictResolution || ENSEMBLE_DEFAULTS.CONFLICT_RESOLUTION;
    const conflictResolution = this.sanitizeEnumValue(raw, 'conflict resolution strategy');
    if (!CONFLICT_STRATEGIES.includes(conflictResolution as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_CONFLICT_RESOLUTION}: ${conflictResolution}`);
    }
    return conflictResolution as ConflictResolutionStrategy;
  }

  private parseContextSharing(data: any): 'none' | 'selective' | 'full' {
    const raw = data.context_sharing || data.contextSharing || ENSEMBLE_DEFAULTS.CONTEXT_SHARING;
    let contextSharingValue = String(raw);
    if (typeof raw === 'boolean') {
      contextSharingValue = raw ? 'full' : 'none';
    }
    const contextSharing = this.sanitizeEnumValue(contextSharingValue, 'context sharing mode');
    if (!['none', 'selective', 'full'].includes(contextSharing)) {
      throw new Error(`Invalid context sharing mode: ${contextSharing}`);
    }
    return contextSharing as 'none' | 'selective' | 'full';
  }

  private sanitizeEnumValue(raw: unknown, label: string): string {
    const result = this.validationService.validateAndSanitizeInput(String(raw), {
      maxLength: SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH,
      allowSpaces: false
    });
    return this.requireSanitizedValue(result, `Invalid ${label}`);
  }

  private parseResourceLimits(data: any): EnsembleMetadata['resourceLimits'] {
    const resourceLimitsRaw = data.resource_limits || data.resourceLimits;
    if (!resourceLimitsRaw) {
      return undefined;
    }
    return {
      maxActiveElements: resourceLimitsRaw.max_active_elements || resourceLimitsRaw.maxActiveElements || ENSEMBLE_LIMITS.MAX_ELEMENTS,
      maxMemoryMb: resourceLimitsRaw.max_memory_mb || resourceLimitsRaw.maxMemoryMb,
      maxExecutionTimeMs: resourceLimitsRaw.max_execution_time_ms || resourceLimitsRaw.maxExecutionTimeMs || ENSEMBLE_LIMITS.MAX_ACTIVATION_TIME
    };
  }

  private parseElements(data: any, ensembleName: string): EnsembleElement[] {
    const elementsRaw = data.elements || [];
    if (!Array.isArray(elementsRaw)) {
      throw new TypeError('Ensemble elements must be an array');
    }
    return elementsRaw.map((element: any, index: number) =>
      this.parseElement(element, index, ensembleName));
  }

  private parseElement(element: any, index: number, ensembleName: string): EnsembleElement {
    const role = this.parseElementRole(element, index);
    const activation = this.parseElementActivation(element, index);
    return {
      element_name: this.parseElementName(element, index, ensembleName),
      element_type: this.parseElementType(element, index, ensembleName),
      role,
      priority: this.parseElementPriority(element),
      activation,
      condition: this.parseElementCondition(element, index, activation),
      dependencies: this.parseElementDependencies(element, index),
      purpose: this.parseElementPurpose(element, index)
    };
  }

  private parseElementName(element: any, index: number, ensembleName: string): string {
    const rawName = element.element_name || element.name;
    if (!rawName) {
      throw new Error(`Element at index ${index} must have element_name (or name for backwards compatibility)`);
    }
    if (element.name && !element.element_name) {
      this.warnOnceForLegacyElementField(ensembleName, index, 'name');
    }
    return this.sanitizeText(rawName, SECURITY_LIMITS.MAX_NAME_LENGTH, true, `Invalid element name at index ${index}`);
  }

  private parseElementType(element: any, index: number, ensembleName: string): string {
    const rawType = element.element_type || element.type || 'skill';
    if (element.type && !element.element_type) {
      this.warnOnceForLegacyElementField(ensembleName, index, 'type');
    }
    return this.sanitizeText(rawType, SECURITY_LIMITS.MAX_TAG_LENGTH, false, `Invalid element type at index ${index}`);
  }

  private parseElementRole(element: any, index: number): ElementRole {
    const role = this.sanitizeText(
      element.role || ENSEMBLE_DEFAULTS.ELEMENT_ROLE,
      SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH,
      false,
      `Invalid element role at index ${index}`,
    );
    if (!ELEMENT_ROLES.includes(role as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_ELEMENT_ROLE}: ${role}`);
    }
    return role as ElementRole;
  }

  private parseElementActivation(element: any, index: number): ActivationMode {
    const activation = this.sanitizeText(
      element.activation || 'always',
      SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH,
      false,
      `Invalid element activation at index ${index}`,
    );
    if (!ACTIVATION_MODES.includes(activation as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_ACTIVATION_MODE}: ${activation}`);
    }
    return activation as ActivationMode;
  }

  private parseElementPriority(element: any): number {
    const rawPriority = element.priority ?? ENSEMBLE_DEFAULTS.PRIORITY;
    const priority = typeof rawPriority === 'string' ? Number.parseInt(rawPriority, 10) : rawPriority;
    return Math.max(0, Math.min(100, priority));
  }

  private parseElementCondition(element: any, index: number, activation: ActivationMode): string | undefined {
    if (activation !== 'conditional' || !element.condition) {
      return undefined;
    }
    const result = this.validationService.validateAndSanitizeInput(String(element.condition), {
      maxLength: ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH,
      allowSpaces: true,
      customPattern: /^[a-zA-Z0-9\s\-_.=!&|<>()]+$/
    });
    return this.requireSanitizedValue(result, `Invalid condition at index ${index}`);
  }

  private parseElementDependencies(element: any, index: number): string[] | undefined {
    if (!Array.isArray(element.dependencies)) {
      return undefined;
    }
    return element.dependencies
      .slice(0, ENSEMBLE_LIMITS.MAX_DEPENDENCIES)
      .map((dependency: unknown) => this.sanitizeText(
        dependency,
        SECURITY_LIMITS.MAX_NAME_LENGTH,
        true,
        `Invalid dependency "${String(dependency)}" at index ${index}`,
      ));
  }

  private parseElementPurpose(element: any, index: number): string | undefined {
    if (!element.purpose) {
      return undefined;
    }
    const result = this.validationService.validateAndSanitizeInput(String(element.purpose), {
      maxLength: SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH,
      allowSpaces: true,
      fieldType: 'description'
    });
    return this.requireSanitizedValue(result, `Invalid purpose at index ${index}`);
  }

  private sanitizeText(raw: unknown, maxLength: number, allowSpaces: boolean, errorMessage: string): string {
    const result = this.validationService.validateAndSanitizeInput(String(raw), { maxLength, allowSpaces });
    return this.requireSanitizedValue(result, errorMessage);
  }

  private requireSanitizedValue(
    result: { isValid: boolean; sanitizedValue?: string; errors?: string[] },
    errorMessage: string,
  ): string {
    if (!result.isValid || typeof result.sanitizedValue !== 'string') {
      throw new Error(`${errorMessage}: ${result.errors?.join(', ')}`);
    }
    return result.sanitizedValue;
  }

  private parseAllowNested(data: any): boolean {
    if (data.allow_nested !== undefined) {
      return Boolean(data.allow_nested);
    }
    if (data.allowNested !== undefined) {
      return Boolean(data.allowNested);
    }
    return ENSEMBLE_DEFAULTS.ALLOW_NESTED;
  }

  private parseTags(data: any): string[] {
    if (!Array.isArray(data.tags)) {
      return [];
    }
    return data.tags.map((tag: unknown) =>
      this.sanitizeText(tag, SECURITY_LIMITS.MAX_TAG_LENGTH, true, `Invalid tag "${String(tag)}"`));
  }

  /**
   * Create an Ensemble instance from parsed metadata
   *
   * @param metadata - Validated ensemble metadata
   * @param content - Markdown content (ensemble instructions/documentation)
   * @returns New Ensemble instance
   */
  protected override createElement(metadata: EnsembleMetadata, content: string): Ensemble {
    delete (metadata as any).format_version;  // Fix #912: Strip marker from runtime metadata
    const instructions = metadata.instructions;
    delete metadata.instructions;
    const ensemble = new Ensemble(metadata, metadata.elements, this.metadataService);
    // Extract instructions from metadata if present (v2 dual-field)
    if (instructions) {
      ensemble.instructions = instructions;
    }
    ensemble.content = content;
    return ensemble;
  }

  /**
   * Serialize an ensemble to file content
   *
   * Format: Markdown with YAML frontmatter
   * - Frontmatter: Ensemble metadata + element references
   * - Content: Instructions/documentation for the ensemble
   *
   * @param element - Ensemble to serialize
   * @returns File content (markdown with frontmatter)
   */
  protected override serializeElement(element: Ensemble): Promise<string> {
    const metadata = element.metadata;

    // Build frontmatter data (using camelCase)
    const frontmatter: any = {
      name: metadata.name,
      type: toSingularLabel(ElementType.ENSEMBLE),
      format_version: 'v2',  // Fix #912: Explicit format marker
      unique_id: element.id,
      description: metadata.description,
      version: metadata.version,
      author: metadata.author,
      created: metadata.created,
      modified: new Date().toISOString(),
      tags: metadata.tags || [],
      activationStrategy: metadata.activationStrategy,
      conflictResolution: metadata.conflictResolution,
      contextSharing: metadata.contextSharing,
      allowNested: metadata.allowNested,
      maxNestingDepth: metadata.maxNestingDepth
    };

    // v2.0 dual-field: write instructions to YAML frontmatter if present
    if (element.instructions) {
      frontmatter.instructions = element.instructions;
    }

    // Include resource limits if specified
    if (metadata.resourceLimits) {
      frontmatter.resourceLimits = metadata.resourceLimits;
    }

    // Issue #524 — Gatekeeper policy (all element types)
    if (metadata.gatekeeper) {
      frontmatter.gatekeeper = metadata.gatekeeper;
    }

    // Include elements array (using element_name/element_type for API consistency)
    frontmatter.elements = metadata.elements.map(elem => {
      const elemData: any = {
        element_name: elem.element_name,
        element_type: elem.element_type,
        role: elem.role,
        priority: elem.priority,
        activation: elem.activation
      };

      if (elem.condition) {
        elemData.condition = elem.condition;
      }

      if (elem.dependencies && elem.dependencies.length > 0) {
        elemData.dependencies = elem.dependencies;
      }

      if (elem.purpose) {
        elemData.purpose = elem.purpose;
      }

      return elemData;
    });

    // Use SerializationService for frontmatter creation
    // Use CORE_SCHEMA to support numbers (priority) and booleans (allowNested)
    const body = element.content || this.buildDefaultBody(element);
    return Promise.resolve(this.serializationService.createFrontmatter(frontmatter, body, {
      method: 'manual',
      schema: 'json',  // Fix #914: standardize on JSON schema across all managers
      cleanMetadata: true,  // Fix #913: standardize across all managers
      cleaningStrategy: 'remove-both',
      sortKeys: true,
      lineWidth: 100,
      skipInvalid: false  // Don't skip invalid - we want to catch errors
    }));
  }

  private buildDefaultBody(element: Ensemble): string {
    const name = element.metadata.name.trim();
    const description = element.metadata.description.trim();
    const lines: string[] = [];
    if (name) {
      lines.push(`# ${name}`, '');
    }
    if (description) {
      lines.push(description);
    }
    return lines.join('\n');
  }

  /**
   * Get file extension for ensemble files
   */
  override getFileExtension(): string {
    return '.md';
  }

  /**
   * Import an ensemble from external format
   *
   * Supports:
   * - YAML: Frontmatter-style metadata with optional markdown content
   * - JSON: Direct ensemble structure
   * - Markdown: YAML frontmatter + markdown content
   *
   * @param data - String containing ensemble data
   * @param format - Format of the data (json, yaml, markdown)
   * @returns Promise resolving to imported Ensemble
   */
  override async importElement(
    data: string,
    format: 'json' | 'yaml' | 'markdown' = 'markdown'
  ): Promise<Ensemble> {
    try {
      let parsed: any;
      let content = '';

      if (format === 'json') {
        parsed = this.serializationService.parseJson(data, {
          source: 'EnsembleManager.importElement'
        });
        content = typeof parsed.content === 'string' ? parsed.content : '';
      } else {
        // Parse YAML/Markdown using SerializationService
        const result = this.serializationService.parseFrontmatter(data, {
          maxYamlSize: 50000, // 50KB limit for ensemble files
          validateContent: true,
          source: 'EnsembleManager.importElement'
        });

        parsed = result.data;
        content = result.content;
      }

      // Parse metadata
      const metadata = await this.parseMetadata(parsed);

      // Create ensemble
      const ensemble = this.createElement(metadata, content);

      // Log successful import
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.IMPORTED,
        severity: 'LOW',
        source: 'EnsembleManager.importElement',
        details: `Imported ensemble: ${metadata.name} with ${metadata.elements.length} elements`
      });

      return ensemble;

    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.IMPORTED,
        severity: 'MEDIUM',
        source: 'EnsembleManager.importElement',
        details: `Failed to import ensemble: ${error}`
      });
      throw new Error(`Failed to import ensemble: ${error}`);
    }
  }

  /**
   * Export an ensemble to external format
   *
   * @param element - Ensemble to export
   * @param format - Output format (json, yaml, markdown)
   * @returns Promise resolving to serialized string
   */
  override async exportElement(
    element: Ensemble,
    format: 'json' | 'yaml' | 'markdown' = 'markdown'
  ): Promise<string> {
    if (format === 'json') {
      return element.serializeToJSON();
    }

    // For YAML and Markdown, use the same format (frontmatter + content)
    return this.serializeElement(element);
  }

  /**
   * Create a new ensemble with metadata
   *
   * @param metadata - Partial metadata for the ensemble
   * @returns Promise resolving to new Ensemble instance
   */
  async create(metadata: Partial<EnsembleMetadata> & { instructions?: string; content?: string }): Promise<Ensemble> {
    // Use specialized validator for input validation
    // Note: element_type resolution is handled by the handler layer before calling create().
    // Elements should already have element_type set when they arrive here.
    const validationResult = await this.validator.validateCreate({
      name: metadata.name,
      description: metadata.description,
      elements: metadata.elements || [],
      allowNested: metadata.allowNested,
      maxNestingDepth: metadata.maxNestingDepth
    });

    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Log warnings if any
    if (validationResult.warnings.length > 0) {
      logger.warn(`Ensemble creation warnings: ${validationResult.warnings.join(', ')}`);
    }

    // Ensure required fields
    if (!metadata.name) {
      throw new Error('Ensemble must have a name');
    }
    const ensembleName = metadata.name;

    let rawElements = metadata.elements || [];

    // Migrate legacy element fields (name -> element_name, type -> element_type)
    // This ensures backwards compatibility with API calls using old field names
    const migratedElements: EnsembleElement[] = rawElements.map((elem: any, index: number) => {
      // Support both element_name (new standard) and name (legacy)
      const elementName = elem.element_name || elem.name;
      if (!elementName) {
        throw new Error(`Element at index ${index} must have element_name (or name for backwards compatibility)`);
      }
      // Log deprecation warning if using legacy 'name' field
      if (elem.name && !elem.element_name) {
        this.warnOnceForLegacyElementField(ensembleName, index, 'name');
      }

      // Support both element_type (new standard) and type (legacy)
      // Issue #466: No longer defaults to 'skill' — callers must provide type
      // or pass managers for portfolio resolution
      const elementType = elem.element_type || elem.type;
      if (!elementType) {
        throw new Error(
          `Element '${elementName}' at index ${index} has no element_type. ` +
          `Provide element_type explicitly or ensure the element exists in the portfolio.`
        );
      }
      // Log deprecation warning if using legacy 'type' field
      if (elem.type && !elem.element_type) {
        this.warnOnceForLegacyElementField(ensembleName, index, 'type');
      }

      return {
        element_name: elementName,
        element_type: elementType,
        role: elem.role || ENSEMBLE_DEFAULTS.ELEMENT_ROLE,
        priority: elem.priority ?? ENSEMBLE_DEFAULTS.PRIORITY,
        activation: elem.activation || 'always',
        condition: elem.condition,
        dependencies: elem.dependencies,
        purpose: elem.purpose
      } as EnsembleElement;
    });

    // Set defaults for optional fields
    const fullMetadata: EnsembleMetadata = {
      name: metadata.name,
      description: metadata.description || '',
      version: metadata.version || '1.0.0',
      author: metadata.author,
      created: metadata.created || new Date().toISOString(),
      modified: metadata.modified || new Date().toISOString(),
      tags: metadata.tags || [],
      activationStrategy: metadata.activationStrategy || (metadata as any).activation_strategy || ENSEMBLE_DEFAULTS.ACTIVATION_STRATEGY,
      conflictResolution: metadata.conflictResolution || (metadata as any).conflict_resolution || ENSEMBLE_DEFAULTS.CONFLICT_RESOLUTION,
      contextSharing: metadata.contextSharing || ENSEMBLE_DEFAULTS.CONTEXT_SHARING,
      resourceLimits: metadata.resourceLimits,
      allowNested: metadata.allowNested ?? ENSEMBLE_DEFAULTS.ALLOW_NESTED,
      maxNestingDepth: metadata.maxNestingDepth || ENSEMBLE_DEFAULTS.MAX_NESTING_DEPTH,
      elements: migratedElements,
      // Issue #524 — Gatekeeper policy (symmetric with buildMetadata deserialization)
      gatekeeper: sanitizeGatekeeperPolicy((metadata as any).gatekeeper, metadata.name, 'ensemble', metadata as unknown as Record<string, unknown>),
    };

    // Use inherited getElementFilename() for consistent filename normalization
    const filename = this.getElementFilename(fullMetadata.name);

    // Issue #613: Check metadata name uniqueness (not just filename)
    const existingEnsembles = await this.list();
    const duplicate = existingEnsembles.some(e =>
      e.metadata.name.toLowerCase() === fullMetadata.name.toLowerCase()
    );
    if (duplicate) {
      throw new Error(`An ensemble named "${fullMetadata.name}" already exists`);
    }

    // Create ensemble
    const ensemble = new Ensemble(fullMetadata, fullMetadata.elements, this.metadataService);

    // Set instructions and content if provided (v2.0 dual-field architecture)
    if (metadata.instructions) {
      ensemble.instructions = metadata.instructions;
    }
    if (metadata.content) {
      ensemble.content = metadata.content;
    }

    // Save to disk
    await this.save(ensemble, filename);
    // Note: No reload() here — save() caches the element correctly.
    // See Issue #491 for why PersonaManager's reload-after-create was removed.

    // Log creation
    SecurityMonitor.logSecurityEvent({
      type: ENSEMBLE_SECURITY_EVENTS.SAVED,
      severity: 'LOW',
      source: 'EnsembleManager.create',
      details: `Created ensemble: ${fullMetadata.name}`
    });

    return ensemble;
  }

  /**
   * Validate an ensemble
   * Delegates to ensemble's own validate method
   *
   * @param element - Ensemble to validate
   * @returns Validation result
   */
  override validate(element: Ensemble): ElementValidationResult {
    return element.validate();
  }

  /**
   * Override save to validate before persisting
   */
  override async save(element: Ensemble, filePath: string): Promise<void> {
    // Validate ensemble before saving
    const validationResult = this.validate(element);
    if (!validationResult.valid) {
      const errors = validationResult.errors?.map(e => e.message).join(', ') || 'Unknown validation error';
      throw new Error(`Cannot save invalid ensemble: ${errors}`);
    }

    // Call base implementation
    await super.save(element, filePath);
  }

  /**
   * Override delete to add ensemble-specific logging
   */
  override async delete(filePath: string): Promise<void> {
    SecurityMonitor.logSecurityEvent({
      type: ENSEMBLE_SECURITY_EVENTS.DELETED,
      severity: 'MEDIUM',
      source: 'EnsembleManager.delete',
      details: `Deleting ensemble: ${filePath}`
    });

    await super.delete(filePath);

    SecurityMonitor.logSecurityEvent({
      type: ENSEMBLE_SECURITY_EVENTS.DELETED,
      severity: 'LOW',
      source: 'EnsembleManager.delete',
      details: `Successfully deleted ensemble: ${filePath}`
    });
  }

  /**
   * Override list to apply active status based on the per-session activation set
   */
  override async list(options?: { includePublic?: boolean }): Promise<Ensemble[]> {
    const ensembles = await super.list(options);

    // Apply ACTIVE status to ensembles in the per-session activation set
    for (const ensemble of ensembles) {
      if (this.getActivationSet().has(ensemble.metadata.name)) {
        // Call activate() to set status to ACTIVE
        await ensemble.activate();
      }
    }

    return ensembles;
  }

  /**
   * Activate an ensemble by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   * Issue #24 (LOW PRIORITY): Cleanup trigger for memory leak prevention
   *
   * @param identifier - Ensemble name or identifier
   * @returns Activation result with success status and message
   */
  async activateEnsemble(identifier: string): Promise<{ success: boolean; message: string; ensemble?: Ensemble }> {
    // Evict stale cache before lookup so external file edits are picked up (#1895).
    // findByName() hits the LRU cache first and never calls list(), so without this
    // the scan cooldown prevents mtime-based eviction from running.
    await this.scanAndEvict();

    // PERFORMANCE FIX: Use findByName() instead of list()
    const ensemble = await this.findByName(identifier);

    if (!ensemble) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.ENSEMBLE, identifier)
      };
    }

    // MEMORY LEAK FIX: Check if cleanup is needed before adding
    this.checkAndCleanupActiveSet();

    this.getActivationSet().add(ensemble.metadata.name);

    // Set ensemble status to active
    await ensemble.activate();

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'EnsembleManager.activateEnsemble',
      details: `Ensemble activated: ${ensemble.metadata.name}`
    });

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.activated(ElementType.ENSEMBLE, ensemble.metadata.name),
      ensemble
    };
  }

  /**
   * Deactivate an ensemble by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   *
   * @param identifier - Ensemble name or identifier
   * @returns Deactivation result with success status and message
   */
  async deactivateEnsemble(identifier: string): Promise<{ success: boolean; message: string; ensemble?: Ensemble }> {
    // No scanAndEvict() here — intentional. Deactivation only needs the ensemble's
    // name (to remove from the per-session activation set) and calls deactivate() which sets
    // a status flag. It does not consume the elements list, so stale cached element
    // data has no effect on correctness. Compare with activateEnsemble(), which
    // ingests the full element list to orchestrate sub-element loading and must
    // therefore see the latest on-disk definition. (#1895)

    // PERFORMANCE FIX: Use findByName() instead of list()
    const ensemble = await this.findByName(identifier);

    if (!ensemble) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.ENSEMBLE, identifier)
      };
    }

    this.getActivationSet().delete(ensemble.metadata.name);

    // Set ensemble status to inactive
    await ensemble.deactivate();

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'EnsembleManager.deactivateEnsemble',
      details: `Ensemble deactivated: ${ensemble.metadata.name}`
    });

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.deactivated(ElementType.ENSEMBLE, ensemble.metadata.name),
      ensemble
    };
  }

  /**
   * Get all active ensembles
   *
   * @returns List of active ensembles
   */
  async getActiveEnsembles(): Promise<Ensemble[]> {
    const results: Ensemble[] = [];
    for (const name of this.getActivationSet()) {
      const ensemble = await this.findByName(name);
      if (ensemble) results.push(ensemble);
    }
    return results;
  }

  /**
   * Check if active set cleanup is needed and perform cleanup if necessary
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private checkAndCleanupActiveSet(): void {
    const { max, cleanupThreshold } = getActiveElementLimitConfig('ensembles');

    // Below threshold — no action needed
    if (this.getActivationSet().size < cleanupThreshold) {
      return;
    }

    // At or above max — warn before cleanup
    if (this.getActivationSet().size >= max) {
      logger.warn(
        `Active ensembles limit reached (${max}). ` +
        `Consider deactivating unused ensembles or setting DOLLHOUSE_MAX_ACTIVE_ENSEMBLES to a higher value.`
      );

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'MEDIUM',
        source: 'EnsembleManager.checkAndCleanupActiveSet',
        details: `Active ensembles limit reached: ${this.getActivationSet().size}/${max}`
      });
    }

    // At or above threshold — proactively clean stale entries
    void this.cleanupStaleActiveEnsembles();
  }

  /**
   * Clean up stale entries from active ensembles set
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private async cleanupStaleActiveEnsembles(): Promise<void> {
    try {
      const startSize = this.getActivationSet().size;
      const ensembles = await this.list();
      const existingEnsembleNames = new Set(ensembles.map(e => e.metadata.name));

      const staleNames: string[] = [];
      for (const activeName of this.getActivationSet()) {
        if (!existingEnsembleNames.has(activeName)) {
          this.getActivationSet().delete(activeName);
          staleNames.push(activeName);
        }
      }

      const endSize = this.getActivationSet().size;
      const removed = startSize - endSize;

      if (removed > 0) {
        logger.info(
          `Cleaned up ${removed} stale active ensemble reference(s). ` +
          `Active ensembles: ${endSize}/${getMaxActiveLimit('ensembles')}`
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_DELETED',
          severity: 'LOW',
          source: 'EnsembleManager.cleanupStaleActiveEnsembles',
          details: `Removed ${removed} stale active ensemble references`,
          additionalData: {
            removedCount: removed,
            activeCount: endSize,
            staleNames: staleNames.join(', ')
          }
        });
      }
    } catch (error) {
      logger.error('Failed to cleanup stale active ensembles:', error);

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'LOW',
        source: 'EnsembleManager.cleanupStaleActiveEnsembles',
        details: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}
