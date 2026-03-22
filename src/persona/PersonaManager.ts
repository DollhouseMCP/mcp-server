/**
 * Core persona management operations
 */

import { randomUUID } from 'node:crypto';
import { Persona, PersonaMetadata } from '../types/persona.js';
import { PersonaElement, PersonaElementMetadata } from './PersonaElement.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { validateFilename, sanitizeInput, validateContentSize } from '../security/InputValidator.js';
import { SECURITY_LIMITS } from '../security/constants.js';
import { ContentValidator } from '../security/contentValidator.js';
import { PathValidator } from '../security/pathValidator.js';
import { FileLockManager } from '../security/fileLockManager.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { IndicatorConfig, formatIndicator } from '../config/indicator-config.js';
import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';
import { toSingularLabel } from '../utils/elementTypeNormalization.js';
import { StateChangeNotifier, type PersonaStateChangeType } from '../services/StateChangeNotifier.js';
import { generateUniqueId } from '../utils/filesystem.js';
import { logger } from '../utils/logger.js';
import { isDefaultPersona } from '../constants/defaultPersonas.js';
import { PersonaImporter, ImportResult } from './export-import/PersonaImporter.js';
import { BaseElementManager, type BaseElementManagerOptions } from '../elements/base/BaseElementManager.js';
import { VALIDATION_CONSTANTS } from '../elements/base/ElementValidation.js';
import { normalizeVersion } from '../elements/BaseElement.js';
import { ValidationRegistry } from '../services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../services/validation/TriggerValidationService.js';
import { ValidationService } from '../services/validation/ValidationService.js';
import { MetadataService } from '../services/MetadataService.js';
import { SerializationService } from '../services/SerializationService.js';
import { FileOperationsService } from '../services/FileOperationsService.js';
import { getActiveElementLimitConfig, getMaxActiveLimit } from '../config/active-element-limits.js';

/**
 * Validated and sanitized persona input data
 */
interface ValidatedPersonaInputs {
  name: string;
  sanitizedName: string;
  description: string;
  instructions: string;
  filename: string;
  triggers: string[];
  uniqueId: string;
  author: string;
}

interface PersonaManagerOptions extends BaseElementManagerOptions {
  personaImporter?: PersonaImporter;
  notifier?: StateChangeNotifier;
}

export class PersonaManager extends BaseElementManager<PersonaElement> {
  /**
   * Track active personas by filename (stable identifier)
   * Issue #281: Changed from single active persona to Set for multiple active
   */
  private activePersonas: Set<string> = new Set();
  private currentUser: string | null = null;
  private indicatorConfig: IndicatorConfig;
  protected override portfolioManager: PortfolioManager;
  protected override fileLockManager: FileLockManager;
  private personaImporter?: PersonaImporter;
  private notifier?: StateChangeNotifier;
  private readonly personasDir: string;
  private pathValidatorInitialized = false;
  private triggerValidationService: TriggerValidationService;
  private validationService: ValidationService;
  private metadataService: MetadataService;
  private readonly serializationService: SerializationService;

  constructor(
    portfolioManager: PortfolioManager,
    indicatorConfig: IndicatorConfig,
    fileLockManager: FileLockManager,
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry,
    metadataService: MetadataService,
    personaImporter?: PersonaImporter,
    notifier?: StateChangeNotifier,
    baseOptions: PersonaManagerOptions = {}
  ) {
    super(ElementType.PERSONA, portfolioManager, fileLockManager, baseOptions, fileOperationsService, validationRegistry);
    this.portfolioManager = portfolioManager;
    this.fileLockManager = fileLockManager;

    this.indicatorConfig = indicatorConfig;
    this.personaImporter = baseOptions.personaImporter ?? personaImporter;
    this.notifier = baseOptions.notifier ?? notifier;
    this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);
    this.triggerValidationService = validationRegistry.getTriggerValidationService();
    this.validationService = validationRegistry.getValidationService();
    this.metadataService = metadataService;
    this.serializationService = new SerializationService();
    this.initializePathValidator();
  }

  /**
   * Override to return singular form for element type labeling.
   */
  protected override getElementLabel(): string {
    return 'persona';
  }

  /**
   * Initialize and load all personas
   */
  async initialize(): Promise<void> {
    this.initializePathValidator();
    // Base class handles element loading
  }

  /**
   * Reload personas using BaseElementManager caches
   */
  async reload(): Promise<void> {
    this.initializePathValidator();

    // Clear BaseElementManager caches and reload
    this.clearCache();
    const personas = await super.list();

    // Check if active personas still exist after reload
    // Issue #281: Support multiple active personas
    for (const activeFilename of [...this.activePersonas]) {
      const stillExists = personas.some(p => this.deriveFilename(p) === activeFilename);
      if (!stillExists) {
        this.activePersonas.delete(activeFilename);
        this.notifyPersonaChange('persona-deactivated', activeFilename, null);
      }
    }
  }

  private deriveFilename(persona: PersonaElement): string {
    if (persona.filename) {
      return persona.filename;
    }

    const base =
      persona.metadata?.unique_id ||
      this.normalizeFilename(persona.metadata?.name || 'persona');

    return base.endsWith('.md') ? base : `${base}.md`;
  }


  private clonePersona(basePersona: PersonaElement, options: { writableCopy?: boolean } = {}): PersonaElement {
    const metadata: PersonaMetadata = {
      ...basePersona.metadata,
      triggers: basePersona.metadata.triggers ? [...basePersona.metadata.triggers] : undefined,
      content_flags: basePersona.metadata.content_flags ? [...basePersona.metadata.content_flags] : undefined
    };

    let uniqueId = basePersona.id;
    let filename = basePersona.filename;

    if (options.writableCopy) {
      const author = this.getCurrentUserForAttribution();
      uniqueId = generateUniqueId(metadata.name, author);
      filename = `${uniqueId}.md`;

      metadata.unique_id = uniqueId;
      if (author) {
        metadata.author = author;
      }
    }

    // Create new PersonaElement instance (v2.0 dual-field: pass both instructions and content)
    const cloned = new PersonaElement(
      {
        ...metadata,
        type: ElementType.PERSONA,
        unique_id: uniqueId
      } as Partial<PersonaElementMetadata>,
      basePersona.instructions,
      filename,
      this.metadataService,
      basePersona.content
    );

    // Set the ID
    cloned.id = uniqueId;

    return cloned;
  }

  private normalizePersonaForSave(persona: PersonaElement): void {
    const metadata: PersonaMetadata = { ...(persona.metadata ?? {}) };

    // Sanitize name first (before MetadataService)
    const sanitizedName =
      sanitizeInput(metadata.name || persona.filename || `persona-${Date.now()}`, 100) || 'Persona';
    metadata.name = sanitizedName;

    // Use MetadataService for common fields + persona-specific defaults
    const normalized = this.metadataService.normalizeMetadata<PersonaMetadata>(
      metadata,
      ElementType.PERSONA,
      {
        typeDefaults: {
          category: 'general',
          content_flags: ['user-created'],
          age_rating: 'all',
          created_date: new Date().toISOString().split('T')[0]  // Persona uses date-only format
        }
      }
    );

    // Handle unique_id (persona-specific)
    if (!normalized.unique_id) {
      normalized.unique_id = generateUniqueId(normalized.name, normalized.author);
    }

    // Handle triggers (element-specific validation)
    if (normalized.triggers && normalized.triggers.length > 0) {
      const validationResult = this.triggerValidationService.validateTriggers(
        normalized.triggers,
        ElementType.PERSONA,
        normalized.name
      );
      // CRITICAL: Preserve undefined behavior when no valid triggers
      normalized.triggers = validationResult.validTriggers.length > 0
        ? validationResult.validTriggers
        : undefined;
    } else {
      normalized.triggers = undefined;
    }

    const filename = persona.filename || this.getElementFilename(normalized.name);
    persona.filename = validateFilename(filename);

    persona.metadata = normalized as PersonaElementMetadata;
    persona.unique_id = normalized.unique_id;
    persona.id = normalized.unique_id;
  }


  /**
   * Get all loaded personas as a Map (used by import operations)
   */
  async getAllPersonas(): Promise<Map<string, Persona>> {
    const personas = await this.list();
    const map = new Map<string, Persona>();
    for (const persona of personas) {
      map.set(persona.filename, persona);
    }
    return map;
  }

  /**
   * Get personas from cache as a Map (synchronous, for DI consumers)
   */
  getPersonas(): Map<string, Persona> {
    const map = new Map<string, Persona>();
    for (const persona of this.elements.values()) {
      map.set(persona.filename, persona);
    }
    return map;
  }

  /**
   * List all personas as an array
   * Ensures all personas have filenames set
   */
  override async list(): Promise<PersonaElement[]> {
    const personas = await super.list();
    // Ensure filenames are set using deriveFilename logic
    for (const persona of personas) {
      if (!persona.filename) {
        persona.filename = this.deriveFilename(persona);
      }
    }
    return personas;
  }

  /**
   * Reload personas and return MCP-formatted response
   */
  async reloadPersonas() {
    await this.reload();
    const personas = await this.list();
    return {
      content: [{
        type: "text",
        text: `🔄 Reloaded ${personas.length} personas`
      }]
    };
  }

  /**
   * Find a persona by identifier (filename, name, or unique_id)
   * Uses cached elements from BaseElementManager for synchronous access
   * Multi-strategy search: filename (with/without .md), name (case-insensitive), unique_id
   */
  /** Cache miss metrics for monitoring persona lookup health (Issue #843) */
  private cacheMissMetrics = {
    cacheHits: 0,
    cacheMisses: 0,
    diskRecoveries: 0,
    diskFailures: 0,
    notFound: 0,
    deduplicatedLookups: 0,
  };

  /** Get cache miss metrics for monitoring and diagnostics */
  getCacheMissMetrics(): Readonly<typeof this.cacheMissMetrics> {
    return { ...this.cacheMissMetrics };
  }

  /**
   * Check if a persona matches an identifier by filename, name, or ID.
   * Shared matching logic used by both findPersona() and findPersonaAsync().
   */
  private matchesIdentifier(persona: PersonaElement, identifier: string): boolean {
    const trimmed = identifier.trim();
    const lower = trimmed.toLowerCase();
    const filenameWithExt = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    const filename = this.deriveFilename(persona);

    // Strategy 1: Exact filename match (with or without .md)
    if (filename === trimmed || filename === filenameWithExt) return true;
    // Strategy 2: Name match (case-insensitive)
    if (persona.metadata.name?.toLowerCase() === lower) return true;
    // Strategy 3: Unique ID match
    if (persona.id === trimmed || persona.metadata.unique_id === trimmed) return true;

    return false;
  }

  findPersona(identifier: string): PersonaElement | undefined {
    if (!identifier) {
      return undefined;
    }

    return this.elements.values().find(p => this.matchesIdentifier(p, identifier));
  }

  /** In-flight disk lookups to prevent duplicate reads for the same identifier */
  private pendingLookups = new Map<string, Promise<PersonaElement | undefined>>();

  /**
   * Find a persona with disk fallback when cache misses.
   *
   * Issue #843: findPersona() is synchronous and cache-only. After LRU eviction
   * or direct filesystem edits followed by scan(), personas become invisible even
   * though the file exists on disk. This async method tries the fast cache path
   * first, then falls back to BaseElementManager.findByName() which has the full
   * cache → storage index → direct file load → list scan fallback chain.
   *
   * Includes request deduplication: concurrent lookups for the same identifier
   * share a single disk read to avoid redundant I/O in bridge/swarm scenarios.
   */
  async findPersonaAsync(identifier: string): Promise<PersonaElement | undefined> {
    // Fast path: check LRU cache (synchronous, O(cache size))
    const cached = this.findPersona(identifier);
    if (cached) {
      this.cacheMissMetrics.cacheHits++;
      return cached;
    }

    this.cacheMissMetrics.cacheMisses++;

    // Deduplicate concurrent disk lookups for the same identifier
    const lookupKey = identifier.trim().toLowerCase();
    const pending = this.pendingLookups.get(lookupKey);
    if (pending) {
      this.cacheMissMetrics.deduplicatedLookups++;
      logger.debug(`[PersonaManager] findPersonaAsync: deduplicating concurrent lookup for "${identifier}"`);
      return pending;
    }

    const lookup = this.performDiskLookup(identifier);
    this.pendingLookups.set(lookupKey, lookup);

    try {
      return await lookup;
    } finally {
      this.pendingLookups.delete(lookupKey);
    }
  }

  /**
   * Perform the actual disk lookup for findPersonaAsync.
   * Separated to support request deduplication.
   */
  private async performDiskLookup(identifier: string): Promise<PersonaElement | undefined> {
    try {
      const fromDisk = await this.findByName(identifier);
      if (fromDisk && this.matchesIdentifier(fromDisk, identifier)) {
        this.cacheMissMetrics.diskRecoveries++;
        logger.info(`[PersonaManager] Cache miss recovered from disk: "${identifier}" (total recoveries: ${this.cacheMissMetrics.diskRecoveries}, miss rate: ${this.cacheMissMetrics.cacheMisses}/${this.cacheMissMetrics.cacheHits + this.cacheMissMetrics.cacheMisses})`);
        return fromDisk;
      }
      this.cacheMissMetrics.notFound++;
      logger.debug(`[PersonaManager] findPersonaAsync: "${identifier}" not found in cache or on disk`);
      return undefined;
    } catch {
      this.cacheMissMetrics.diskFailures++;
      logger.debug(`[PersonaManager] findPersonaAsync: disk lookup failed for "${identifier}" (parse/validation error)`);
      return undefined;
    }
  }

  /**
   * Activate a persona
   * Issue #281: Now supports multiple active personas (adds to set instead of replacing)
   * Issue #843: Now async — uses findPersonaAsync() to recover from cache eviction
   */
  async activatePersona(identifier: string): Promise<{ success: boolean; message: string; persona?: Persona }> {
    const persona = await this.findPersonaAsync(identifier);

    if (!persona) {
      return {
        success: false,
        message: `Persona not found: "${identifier}"`
      };
    }

    // Issue #281: Add to set instead of replacing
    const wasAlreadyActive = this.activePersonas.has(persona.filename);
    if (wasAlreadyActive) {
      return {
        success: true,
        message: `Persona '${persona.metadata.name}' is already active`,
        persona
      };
    }

    // Issue #83: Check if cleanup is needed before adding
    this.checkAndCleanupActiveSet();

    this.activePersonas.add(persona.filename);
    this.notifyPersonaChange('persona-activated', null, persona.filename);

    // SECURITY: Phase 4.4 - Log persona activation event
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'PersonaManager.activatePersona',
      details: `Persona activated: ${persona.metadata.name}`,
      additionalData: {
        activeCount: this.activePersonas.size,
        filename: persona.filename
      }
    });

    // Emit activation event for subscribers
    this.dispatcher.emit(
      'element:activate',
      this.createEventPayload({
        correlationId: randomUUID(),
        element: persona,
        filePath: persona.filename
      })
    );

    return {
      success: true,
      message: `Activated persona: ${persona.metadata.name}`,
      persona
    };
  }
  
  /**
   * Deactivate a specific persona by name
   * Issue #281: Now requires a name parameter to deactivate specific persona from the set
   */
  deactivatePersona(identifier?: string): { success: boolean; message: string } {
    // If no identifier provided, return error (breaking change from single-active)
    if (!identifier) {
      if (this.activePersonas.size === 0) {
        return {
          success: false,
          message: "No persona is currently active"
        };
      }
      return {
        success: false,
        message: "Persona name is required for deactivation. Use 'deactivate_element' with a specific persona name."
      };
    }

    const persona = this.findPersona(identifier);
    if (!persona) {
      return {
        success: false,
        message: `Persona not found: "${identifier}"`
      };
    }

    // Issue #281: Return success=true for idempotent behavior (persona already inactive)
    if (!this.activePersonas.has(persona.filename)) {
      return {
        success: true,
        message: `Persona '${persona.metadata.name}' is already inactive`
      };
    }

    const deleted = this.activePersonas.delete(persona.filename);
    logger.debug(`[PersonaManager.deactivatePersona] deleted: ${deleted}, new size: ${this.activePersonas.size}`);
    this.notifyPersonaChange('persona-deactivated', persona.filename, null);

    // Emit deactivation event for subscribers
    this.dispatcher.emit(
      'element:deactivate',
      this.createEventPayload({
        correlationId: randomUUID(),
        element: persona,
        filePath: persona.filename
      })
    );

    return {
      success: true,
      message: `Deactivated persona: ${persona.metadata.name}`
    };
  }

  /**
   * Get the first active persona (for backward compatibility)
   * Issue #281: With multiple active personas, returns the first one
   */
  getActivePersona(): PersonaElement | null {
    if (this.activePersonas.size === 0) return null;
    const firstActive = this.activePersonas.values().next().value;
    return firstActive ? this.findPersona(firstActive) || null : null;
  }

  /**
   * Get all active personas
   * Issue #281: New method to get all active personas
   */
  getActivePersonas(): PersonaElement[] {
    const personas: PersonaElement[] = [];
    for (const filename of this.activePersonas) {
      const persona = this.findPersona(filename);
      if (persona) {
        personas.push(persona);
      }
    }
    return personas;
  }

  /**
   * Get identifier for the first active persona (filename).
   * Issue #281: For backward compatibility, returns first active persona ID
   */
  getActivePersonaId(): string | null {
    if (this.activePersonas.size === 0) return null;
    return this.activePersonas.values().next().value ?? null;
  }

  /**
   * Get all active persona IDs (filenames)
   * Issue #281: New method to get all active persona IDs
   */
  getActivePersonaIds(): string[] {
    return [...this.activePersonas];
  }

  /**
   * Check if a specific persona is active
   * Issue #281: New method to check if a persona is active
   */
  isPersonaActive(identifier: string): boolean {
    const persona = this.findPersona(identifier);
    if (!persona) return false;
    return this.activePersonas.has(persona.filename);
  }
  
  /**
   * Get persona indicator for responses
   * Issue #281: Now supports multiple active personas - concatenates all indicators
   */
  getPersonaIndicator(): string {
    if (this.activePersonas.size === 0) return "";

    const indicators: string[] = [];
    for (const filename of this.activePersonas) {
      const persona = this.findPersona(filename);
      if (persona) {
        const indicator = formatIndicator(this.indicatorConfig, {
          name: persona.metadata.name,
          version: persona.metadata.version,
          author: persona.metadata.author,
          category: persona.metadata.category
        });
        if (indicator) {
          indicators.push(indicator);
        }
      }
    }

    return indicators.join('');
  }
  


  /**
   * Build persona metadata with default values and optional overrides
   *
   * @param validatedInputs - Validated input data
   * @param metadataOverrides - Optional metadata overrides from user
   * @returns Complete PersonaMetadata object
   */
  private buildPersonaMetadata(
    validatedInputs: ValidatedPersonaInputs,
    metadataOverrides?: Partial<PersonaMetadata>
  ): PersonaElementMetadata {
    // SECURITY: Validate metadata keys BEFORE object construction to prevent prototype pollution
    if (metadataOverrides) {
      this.validateMetadataKeys(metadataOverrides);
    }

    const metadata: PersonaMetadata = {
      ...(metadataOverrides || {}),
      name: validatedInputs.sanitizedName,
      description: validatedInputs.description,
      unique_id: validatedInputs.uniqueId,
      author: validatedInputs.author,
      triggers: validatedInputs.triggers || metadataOverrides?.triggers,
      version: metadataOverrides?.version || "1.0.0",
      age_rating: metadataOverrides?.age_rating || "all",
      content_flags: metadataOverrides?.content_flags || ["user-created"],
      ai_generated: metadataOverrides?.ai_generated ?? true,
      generation_method: metadataOverrides?.generation_method || "Claude",
      price: metadataOverrides?.price || "free",
      revenue_split: metadataOverrides?.revenue_split || "80/20",
      license: metadataOverrides?.license || "CC-BY-SA-4.0",
      created_date: metadataOverrides?.created_date || new Date().toISOString().slice(0, 10),
      category: metadataOverrides?.category || 'general'
    };

    if (metadataOverrides) {
      if (typeof metadataOverrides.category === 'string') {
        // SECURITY FIX: Use ValidationService to validate BEFORE sanitization
        const categoryResult = this.validationService.validateCategory(metadataOverrides.category);
        if (categoryResult.isValid && categoryResult.sanitizedValue) {
          metadata.category = categoryResult.sanitizedValue.toLowerCase();
        }
      }

      if (Array.isArray(metadataOverrides.triggers) && metadataOverrides.triggers.length > 0) {
        // Use TriggerValidationService to apply proper validation
        const validationResult = this.triggerValidationService.validateTriggers(
          metadataOverrides.triggers,
          ElementType.PERSONA,
          metadata.name
        );
        // CRITICAL: Preserve undefined behavior
        metadata.triggers = validationResult.validTriggers.length > 0
          ? validationResult.validTriggers
          : undefined;
      }

      if (typeof metadataOverrides.age_rating === 'string') {
        const sanitizedAgeRating = sanitizeInput(metadataOverrides.age_rating, 10);
        if (sanitizedAgeRating) {
          metadata.age_rating = sanitizedAgeRating.toLowerCase();
        }
      }
    }

    // Convert legacy PersonaMetadata to PersonaElementMetadata before returning
    return this.toPersonaElementMetadata(metadata);
  }

  /**
   * Validate and sanitize all persona creation inputs
   * SECURITY: Phase 4.3 - Added Unicode validation to all text inputs
   * SECURITY: Phase 4.1 - Block ALL invalid content, not just critical
   * SECURITY: Phase 4.7 - Accept normalized content even if Unicode issues were detected and fixed
   *
   * @param name - Raw persona name
   * @param description - Raw persona description
   * @param instructions - Raw persona instructions
   * @param triggers - Optional comma-separated trigger words
   * @returns Validated and sanitized inputs ready for metadata construction
   * @throws Error if validation fails
   */
  private async validatePersonaInputs(
    name: string,
    description: string,
    instructions: string,
    triggers?: string
  ): Promise<ValidatedPersonaInputs> {
    // Validate required fields
    if (!name || !description || !instructions) {
      throw new Error('Missing required fields: name, description, instructions');
    }

    // SECURITY: Phase 4.3 - Apply Unicode normalization BEFORE validation
    // SECURITY: Phase 4.7 - Only reject CRITICAL Unicode issues; accept normalized content for lower severities
    const nameUnicode = UnicodeValidator.normalize(name);
    const descUnicode = UnicodeValidator.normalize(description);
    const instructionsUnicode = UnicodeValidator.normalize(instructions);

    // Reject content with critical Unicode issues ONLY
    // Lower severity issues (confusable chars, etc.) are normalized and accepted
    if (!nameUnicode.isValid && nameUnicode.severity === 'critical') {
      throw new Error(`Name contains dangerous Unicode patterns: ${nameUnicode.detectedIssues?.join(', ')}`);
    }
    if (!descUnicode.isValid && descUnicode.severity === 'critical') {
      throw new Error(`Description contains dangerous Unicode patterns: ${descUnicode.detectedIssues?.join(', ')}`);
    }
    if (!instructionsUnicode.isValid && instructionsUnicode.severity === 'critical') {
      throw new Error(`Instructions contain dangerous Unicode patterns: ${instructionsUnicode.detectedIssues?.join(', ')}`);
    }

    // SECURITY: Phase 4.7 - CRITICAL FIX: Validate BEFORE sanitization
    // If we sanitize first, malicious patterns get removed before detection!
    // Detection order: Unicode normalize → Threat detect → Sanitize → Accept
    const nameValidation = ContentValidator.validateAndSanitize(nameUnicode.normalizedContent);
    if (!nameValidation.isValid) {
      throw new Error(`Name contains prohibited content: ${nameValidation.detectedPatterns?.join(', ')}`);
    }

    const descValidation = ContentValidator.validateAndSanitize(descUnicode.normalizedContent);
    if (!descValidation.isValid) {
      throw new Error(`Description contains prohibited content: ${descValidation.detectedPatterns?.join(', ')}`);
    }

    const instructionsValidation = ContentValidator.validateAndSanitize(instructionsUnicode.normalizedContent);
    if (!instructionsValidation.isValid) {
      // SECURITY: Phase 4.4 - Log validation failures
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: instructionsValidation.severity?.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' || 'MEDIUM',
        source: 'PersonaManager.validatePersonaInputs',
        details: `Content validation failed: ${instructionsValidation.detectedPatterns?.join(', ')}`,
        additionalData: {
          field: 'instructions',
          severity: instructionsValidation.severity
        }
      });
      throw new Error(`Instructions contain security threats: ${instructionsValidation.detectedPatterns?.join(', ')}`);
    }

    // Now sanitize the VALIDATED content (ContentValidator already returns sanitizedContent)
    // SECURITY: Use nullish coalescing (??) instead of logical OR (||) to properly handle empty strings
    // Empty string '' is a valid sanitization result that should be checked for minimum length
    // SECURITY: Trim whitespace from name to prevent whitespace-only names from passing validation
    const sanitizedName = (nameValidation.sanitizedContent ?? nameUnicode.normalizedContent).trim();
    const sanitizedDescription = descValidation.sanitizedContent ?? descUnicode.normalizedContent;
    const sanitizedInstructions = instructionsValidation.sanitizedContent ?? instructionsUnicode.normalizedContent;

    if (sanitizedName.length < 2) {
      throw new Error('Persona name must be at least 2 characters long');
    }

    validateContentSize(sanitizedInstructions, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
    validateContentSize(sanitizedDescription, 2000);

    const author = this.getCurrentUserForAttribution();
    const uniqueId = generateUniqueId(sanitizedName, this.getCurrentUserForAttribution() || undefined);
    const filename = validateFilename(this.getElementFilename(sanitizedName));

    // Path validation handled by BaseElementManager.save()

    // SECURITY: Validate BEFORE sanitization to reject invalid characters
    // This prevents 'bad!trigger' from becoming 'badtrigger' and passing
    const triggerList = triggers ?
      triggers.split(',')
        .map(t => t.trim())
        .filter(t => t && VALIDATION_CONSTANTS.TRIGGER_VALIDATION_REGEX.test(t)) // Validate format FIRST
        .map(t => sanitizeInput(t, 50)) // Then sanitize for length
        .filter(t => t.length > 0) :
      [];

    return {
      name: sanitizedName,
      sanitizedName,
      description: sanitizedDescription,
      instructions: sanitizedInstructions,
      filename,
      triggers: triggerList,
      uniqueId,
      author
    };
  }

  /**
   * Validates metadata keys to prevent prototype pollution
   * @throws Error if dangerous keys are detected
   * @private
   */
  private validateMetadataKeys(metadata: any): void {
    if (!metadata || typeof metadata !== 'object') {
      return;
    }

    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
    const foundDangerousKeys = Object.keys(metadata).filter(
      key => dangerousKeys.includes(key)
    );

    if (foundDangerousKeys.length > 0) {
      logger.error('Prototype pollution attempt detected', {
        dangerousKeys: foundDangerousKeys,
        source: 'PersonaManager.validateMetadataKeys'
      });
      throw new Error(
        `Rejected dangerous metadata keys: ${foundDangerousKeys.join(', ')}`
      );
    }
  }


  /**
   * Create a new persona following the unified element manager pattern.
   *
   * This is the primary API for persona creation, replacing the deprecated
   * `createPersona()` and `createNewPersona()` methods (v2 breaking change).
   *
   * @param data - Persona creation options
   * @param data.name - Display name for the persona (required)
   * @param data.description - Short description of the persona's purpose
   * @param data.instructions - Behavioral instructions (alias: content)
   * @param data.category - Optional category for organization
   * @param data.triggers - Optional keywords that activate this persona
   * @returns The created PersonaElement
   * @throws {Error} If validation fails or persona already exists
   *
   * @example
   * // Basic persona creation
   * const persona = await personaManager.create({
   *   name: 'Code Reviewer',
   *   description: 'Expert at reviewing code for quality',
   *   instructions: 'You are a meticulous code reviewer...'
   * });
   *
   * @example
   * // With category and triggers
   * const persona = await personaManager.create({
   *   name: 'Technical Writer',
   *   description: 'Specializes in clear documentation',
   *   instructions: 'You write clear, concise documentation...',
   *   category: 'professional',
   *   triggers: ['docs', 'documentation', 'readme']
   * });
   *
   * @example
   * // Minimal creation (defaults applied)
   * const persona = await personaManager.create({
   *   name: 'Quick Helper'
   * });
   *
   * @since v2.0.0 - Replaces createPersona() and createNewPersona()
   */
  async create(data: Partial<PersonaElementMetadata> & { content?: string; instructions?: string }): Promise<PersonaElement> {
    this.initializePathValidator();

    // Extract name and description with defaults
    const name = data.name || 'new-persona';
    const description = data.description || '';
    // Dual-field: instructions = behavioral directives, content = reference material
    // Both are first-class fields. Instructions is the primary field for personas.
    const instructions = data.instructions ?? '';
    const content = data.content ?? '';

    // If neither provided, error
    if ((!instructions || instructions.trim().length === 0) && (!content || content.trim().length === 0)) {
      throw new Error(`Persona instructions are required to create '${name}'.`);
    }

    // If only content provided (no instructions), treat content as instructions for backward compat
    const effectiveInstructions = instructions.trim() ? instructions : content;
    const effectiveContent = instructions.trim() ? content : '';

    // Use specialized validator for initial validation
    const validationResult = await this.validator.validateCreate({
      name,
      description,
      content: effectiveInstructions
    });

    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Log warnings if any
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Persona creation warnings: ${validationResult.warnings.join(', ')}`);
    }

    // Parse triggers from data
    let triggersString: string | undefined;
    if (data.triggers) {
      if (Array.isArray(data.triggers)) {
        triggersString = data.triggers.join(', ');
      } else if (typeof data.triggers === 'string') {
        triggersString = data.triggers;
      }
    }

    // Validate and sanitize all inputs - throws on validation failure
    const validatedInputs = await this.validatePersonaInputs(name, description, effectiveInstructions, triggersString);

    // Check for duplicate - throw instead of returning result object
    await super.list();
    const existingPersona = this.findPersona(validatedInputs.filename);
    if (existingPersona) {
      throw new Error(`A persona named "${validatedInputs.sanitizedName}" already exists`);
    }

    // Build metadata overrides from remaining data fields
    const { name: _n, description: _d, content: _c, instructions: _i, triggers: _t, ...metadataOverrides } = data;

    // Build metadata with defaults and optional overrides
    const metadata = this.buildPersonaMetadata(validatedInputs, metadataOverrides as Partial<PersonaMetadata>);

    // Create persona element with dual fields
    const persona = this.createElement(metadata, validatedInputs.instructions);
    persona.content = effectiveContent;
    persona.filename = validatedInputs.filename;
    persona.unique_id = metadata.unique_id ?? validatedInputs.uniqueId;
    persona.id = persona.unique_id;

    await super.save(persona, persona.filename);
    // Note: reload() intentionally NOT called here (Issue #491).
    // save() already caches the element correctly. reload() would clear the
    // cache and rebuild with different IDs, making the persona invisible.
    // reload() is only needed after edit/delete where files may be renamed/removed.

    // SECURITY: Log persona creation event
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'PersonaManager.create',
      details: `Persona created: ${metadata.name}`,
      additionalData: {
        filename: persona.filename,
        author: metadata.author,
        category: metadata.category,
        triggerCount: metadata.triggers?.length || 0
      }
    });

    return persona;
  }

  // REMOVED: createPersona() and createNewPersona() - use create() instead (v2 breaking change)

  /**
   * Edit an existing persona
   */
  async editPersona(personaIdentifier: string, field: string, value: string) {
    if (!personaIdentifier || !field || !value) {
      throw new Error('Missing parameters. Usage: editPersona "persona_name" "field" "new_value"');
    }

    // Issue #843: Use async fallback to recover from cache eviction
    const persona = await this.findPersonaAsync(personaIdentifier);

    if (!persona) {
      // SECURITY: Sanitize user input before including in error messages
      const sanitizedId = sanitizeInput(personaIdentifier, 100);
      throw new Error(`Persona not found: "${sanitizedId}"`);
    }

    this.initializePathValidator();

    // Use specialized validator for edit validation
    const validationResult = await this.validator.validateEdit(persona, { [field]: value });

    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Log warnings if any
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Persona edit warnings: ${validationResult.warnings.join(', ')}`);
    }

    const fieldAliasMap: Record<string, string> = {
      content: 'instructions'
    };
    const normalizedInputField = field.toLowerCase();
    const normalizedField = fieldAliasMap[normalizedInputField] ?? normalizedInputField;

    const validFields = ['name', 'description', 'instructions', 'triggers', 'version', 'category'];
    if (!validFields.includes(normalizedField)) {
      const fieldList = [...validFields, ...Object.keys(fieldAliasMap)].join(', ');
      // SECURITY: Sanitize user input before including in error messages
      const sanitizedField = sanitizeInput(field, 50);
      throw new Error(`Invalid field: "${sanitizedField}" is not editable. Valid fields: ${fieldList}`);
    }

    const isDefault = isDefaultPersona(persona.filename);
    let editablePersona = this.clonePersona(persona, { writableCopy: isDefault });

    try {
      // SECURITY: Phase 4.3 - Apply Unicode validation to edit values
      const unicodeResult = UnicodeValidator.normalize(value);
      if (!unicodeResult.isValid && unicodeResult.severity === 'critical') {
        throw new Error(`Value contains dangerous Unicode patterns: ${unicodeResult.detectedIssues?.join(', ')}`);
      }

      const valueValidation = ContentValidator.validateAndSanitize(unicodeResult.normalizedContent);
      // SECURITY: Phase 4.1 - Block ALL invalid content, not just critical
      if (!valueValidation.isValid) {
        // SECURITY: Phase 4.4 - Log validation failures
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'MEDIUM',
          source: 'PersonaManager.editPersona',
          details: `Edit value validation failed: ${valueValidation.detectedPatterns?.join(', ')}`,
          additionalData: {
            field: normalizedField,
            severity: valueValidation.severity
          }
        });
        throw new Error(`Security Validation Failed: The new value contains prohibited content: ${valueValidation.detectedPatterns?.join(', ')}`);
      }

      let sanitizedValue = valueValidation.sanitizedContent || unicodeResult.normalizedContent;
      
      if (normalizedField === 'instructions') {
        editablePersona.instructions = sanitizedValue;
      } else if (normalizedField === 'triggers') {
        editablePersona.metadata.triggers = sanitizedValue
          .split(',')
          .map(t => sanitizeInput(t.trim(), 50))
          .filter(t => t.length > 0);
      } else if (normalizedField === 'name') {
        editablePersona.metadata.name = sanitizeInput(sanitizedValue, 100);
      } else if (normalizedField === 'category') {
        editablePersona.metadata.category =
          sanitizeInput(sanitizedValue, 50)?.toLowerCase() || 'general';
      } else if (normalizedField === 'description') {
        editablePersona.metadata.description = sanitizedValue;
      } else if (normalizedField === 'version') {
        editablePersona.metadata.version = sanitizedValue;
        editablePersona.version = sanitizedValue;
      }

      // Auto-increment version if not explicitly setting version field
      if (normalizedField !== 'version') {
        if (editablePersona.version) {
          // Normalize to 3-part format first (handles legacy "1.0" format)
          const normalized = normalizeVersion(String(editablePersona.version));
          const versionMatch = normalized.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);

          if (versionMatch) {
            const [, major, minor, patch, preRelease] = versionMatch;

            if (preRelease) {
              // Increment pre-release version
              const preReleaseMatch = preRelease.match(/^-([a-zA-Z]+)\.?(\d+)?$/);
              if (preReleaseMatch) {
                const [, preReleaseType, preReleaseNum] = preReleaseMatch;
                const nextNum = Number.parseInt(preReleaseNum || '0') + 1;
                editablePersona.version = `${major}.${minor}.${patch}-${preReleaseType}.${nextNum}`;
              } else {
                editablePersona.version = `${major}.${minor}.${Number.parseInt(patch) + 1}`;
              }
            } else {
              // Standard version, bump patch
              editablePersona.version = `${major}.${minor}.${Number.parseInt(patch) + 1}`;
            }
          } else {
            editablePersona.version = '1.0.1';
          }
        } else {
          editablePersona.version = '1.0.0';
        }
        // Sync to metadata
        editablePersona.metadata.version = editablePersona.version;
      }

      editablePersona.metadata.unique_id = editablePersona.unique_id;

      // Path validation handled by BaseElementManager.save()
      await super.save(editablePersona, editablePersona.filename);
      await this.reload();

      const fieldDisplay = fieldAliasMap[normalizedInputField]
        ? `${normalizedField} (alias: ${field})`
        : normalizedField;

      // SECURITY: Phase 4.4 - Log persona edit event
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'PersonaManager.editPersona',
        details: `Persona edited: ${editablePersona.metadata.name} (field: ${normalizedField})`,
        additionalData: {
          field: normalizedField,
          isDefaultPersonaCopy: isDefault,
          oldValue: persona.content?.substring(0, 50),
          newValue: editablePersona.content?.substring(0, 50)
        }
      });

      return {
        success: true,
        message: `Persona Updated Successfully. Field Updated: ${fieldDisplay}`,
        isDefault,
        newName: editablePersona.metadata.name || persona.metadata.name,
        version: editablePersona.metadata.version,
        newId: isDefault ? editablePersona.unique_id : undefined
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      throw new Error(`Error Updating Persona: ${sanitized.message}`);
    }
  }

  /**
   * Edit existing persona and return the updated persona (for PersonaHandler compatibility)
   */
  async editExistingPersona(persona: PersonaElement, field: string, value: string): Promise<PersonaElement> {
    const result = await this.editPersona(persona.filename, field, value);
    // Note: editPersona already calls reload(), no need to reload again

    // For copy-on-write, we need to find by the new ID if one was created
    const identifierToFind = result.isDefault && result.newId ? result.newId : persona.filename;

    // Find the updated persona
    const updatedPersona = this.findPersona(identifierToFind);
    if (!updatedPersona) {
      // SECURITY: Don't include unsanitized user input in error messages
      throw new Error('Failed to retrieve updated persona');
    }

    return updatedPersona;
  }


  /**
   * Validate a persona and return a formatted report
   */
  validatePersona(personaIdentifier: string) {
    if (!personaIdentifier) {
      throw new Error('Missing Persona Identifier. Usage: validate_persona "persona_name"');
    }

    const persona = this.findPersona(personaIdentifier);

    if (!persona) {
      // SECURITY: Sanitize user input before including in error messages
      const sanitizedId = sanitizeInput(personaIdentifier, 100);
      throw new Error(`Persona not found: "${sanitizedId}"`);
    }

    const validationResult = persona.validate();
    const statusLine = validationResult.valid ? '✅ Status: Valid' : '❌ Status: Invalid';

    // Build formatted report from validation result
    const reportParts: string[] = [statusLine];

    if (validationResult.errors && validationResult.errors.length > 0) {
      reportParts.push('\n\nErrors:');
      validationResult.errors.forEach((error, i) => {
        reportParts.push(`  ${i + 1}. [${error.field}] ${error.message}`);
      });
    }

    if (validationResult.warnings && validationResult.warnings.length > 0) {
      reportParts.push('\n\nWarnings:');
      validationResult.warnings.forEach((warning, i) => {
        reportParts.push(`  ${i + 1}. [${warning.field}] ${warning.message}`);
      });
    }

    if (validationResult.suggestions && validationResult.suggestions.length > 0) {
      reportParts.push('\n\nSuggestions:');
      validationResult.suggestions.forEach((suggestion, i) => {
        reportParts.push(`  ${i + 1}. ${suggestion}`);
      });
    }

    const formattedReport = reportParts.join('\n');

    logger.debug('[PersonaManager] Validation report preview', {
      name: persona.metadata.name,
      valid: validationResult.valid
    });

    return {
      success: validationResult.valid,
      message: formattedReport,
      report: validationResult
    };
  }
  
  /**
   * Set current user identity
   * SECURITY: Phase 4.6 - Added username and email validation
   */
  setUserIdentity(username: string | null, email?: string): void {
    if (username) {
      // SECURITY: Phase 4.3 - Apply Unicode normalization FIRST
      const usernameUnicode = UnicodeValidator.normalize(username);
      if (!usernameUnicode.isValid && usernameUnicode.severity === 'critical') {
        throw new Error(`Username contains dangerous Unicode patterns: ${usernameUnicode.detectedIssues?.join(', ')}`);
      }

      // SECURITY: Phase 4.6 - Validate username format AFTER normalization (alphanumeric, hyphens, underscores)
      const usernameRegex = /^[a-zA-Z0-9\-_]{3,50}$/;
      if (!usernameRegex.test(usernameUnicode.normalizedContent)) {
        throw new Error(
          'Invalid username format. Must be 3-50 characters, alphanumeric with hyphens/underscores only'
        );
      }

      // Sanitize username
      const validUsername = sanitizeInput(usernameUnicode.normalizedContent, 50);

      if (email) {
        // SECURITY: Phase 4.3 - Apply Unicode normalization FIRST
        const emailUnicode = UnicodeValidator.normalize(email);
        if (!emailUnicode.isValid && emailUnicode.severity === 'critical') {
          throw new Error(`Email contains dangerous Unicode patterns: ${emailUnicode.detectedIssues?.join(', ')}`);
        }

        // SECURITY: Phase 4.6 - Validate email format AFTER normalization
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(emailUnicode.normalizedContent)) {
          throw new Error('Invalid email format');
        }

        // Sanitize email
        const validEmail = sanitizeInput(emailUnicode.normalizedContent, 100);
        process.env.DOLLHOUSE_EMAIL = validEmail;
      }

      const previous = this.currentUser;
      this.currentUser = validUsername;
      process.env.DOLLHOUSE_USER = validUsername;
      this.metadataService.setCurrentUser(validUsername);  // Sync with MetadataService

      logger.info('User identity set', { username: validUsername });
      this.notifyPersonaChange('user-changed', previous, this.currentUser);
    } else {
      const previous = this.currentUser;
      this.currentUser = null;
      delete process.env.DOLLHOUSE_USER;
      delete process.env.DOLLHOUSE_EMAIL;
      this.metadataService.setCurrentUser(null);  // Sync with MetadataService

      logger.info('User identity cleared');
      this.notifyPersonaChange('user-changed', previous, this.currentUser);
    }
  }
  
  /**
   * Get current user identity
   */
  getUserIdentity(): { username: string | null; email: string | null } {
    return {
      username: process.env.DOLLHOUSE_USER || null,
      email: process.env.DOLLHOUSE_EMAIL || null
    };
  }
  
  /**
   * Clear user identity
   */
  clearUserIdentity(): void {
    this.setUserIdentity(null);
  }
  
  /**
   * Update indicator configuration
   */
  updateIndicatorConfig(config: IndicatorConfig): void {
    this.indicatorConfig = config;
  }
  
  /**
   * Get current indicator configuration
   */
  getIndicatorConfig(): IndicatorConfig {
    return this.indicatorConfig;
  }
  
  /**
   * Helper to get current user for attribution
   * REFACTORED: Now delegates to MetadataService for consistent user attribution
   */
  public getCurrentUserForAttribution(): string {
    // Only sync if PersonaManager has an explicitly-set user;
    // otherwise let MetadataService resolve via its own fallback chain.
    if (this.currentUser) {
      this.metadataService.setCurrentUser(this.currentUser);
    }
    return this.metadataService.getCurrentUser();
  }
  

  /**
   * Reset internal state; aligns PersonaManager with DI lifecycle hooks.
   * CRITICAL: Must call super.dispose() to clean up file watchers and prevent open handles
   */
  override dispose(): void {
    // Issue #281: Clear the active personas set
    this.activePersonas.clear();
    this.currentUser = null;

    // CRITICAL: Clean up base class resources (file watchers, caches)
    super.dispose();
  }

  /**
   * Check if active set cleanup is needed and perform cleanup if necessary
   * Issue #83: Active element limit enforcement for personas
   * @private
   */
  private checkAndCleanupActiveSet(): void {
    const { max, cleanupThreshold } = getActiveElementLimitConfig('personas');

    // Below threshold — no action needed
    if (this.activePersonas.size < cleanupThreshold) {
      return;
    }

    // At or above max — warn before cleanup
    if (this.activePersonas.size >= max) {
      logger.warn(
        `Active personas limit reached (${max}). ` +
        `Consider deactivating unused personas or setting DOLLHOUSE_MAX_ACTIVE_PERSONAS to a higher value.`
      );

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'MEDIUM',
        source: 'PersonaManager.checkAndCleanupActiveSet',
        details: `Active personas limit reached: ${this.activePersonas.size}/${max}`
      });
    }

    // At or above threshold — proactively clean stale entries
    this.cleanupStaleActivePersonas();
  }

  /**
   * Clean up stale entries from active personas set
   * Issue #83: Validates that all active personas still exist and removes orphaned references
   * @private
   */
  private cleanupStaleActivePersonas(): void {
    try {
      const startSize = this.activePersonas.size;
      const staleFilenames: string[] = [];

      for (const activeFilename of this.activePersonas) {
        if (!this.findPersona(activeFilename)) {
          this.activePersonas.delete(activeFilename);
          staleFilenames.push(activeFilename);
        }
      }

      const endSize = this.activePersonas.size;
      const removed = startSize - endSize;

      if (removed > 0) {
        logger.info(
          `Cleaned up ${removed} stale active persona reference(s). ` +
          `Active personas: ${endSize}/${getMaxActiveLimit('personas')}`
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_DELETED',
          severity: 'LOW',
          source: 'PersonaManager.cleanupStaleActivePersonas',
          details: `Removed ${removed} stale active persona references`,
          additionalData: {
            removedCount: removed,
            activeCount: endSize,
            staleFilenames: staleFilenames.join(', ')
          }
        });
      }
    } catch (error) {
      logger.error('Failed to cleanup stale active personas:', error);

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'LOW',
        source: 'PersonaManager.cleanupStaleActivePersonas',
        details: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private notifyPersonaChange(
    type: PersonaStateChangeType,
    previousValue: string | null,
    newValue: string | null
  ): void {
    if (!this.notifier) {
      return;
    }

    this.notifier.notifyPersonaChange({
      type,
      previousValue,
      newValue,
      timestamp: new Date()
    });
  }

  private initializePathValidator(): void {
    if (this.pathValidatorInitialized) {
      return;
    }

    try {
      PathValidator.initialize(this.personasDir);
      this.pathValidatorInitialized = true;
    } catch (error) {
      logger.warn('[PersonaManager] Failed to initialize PathValidator', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Override delete to handle auto-deactivation before deletion.
   * FIX: Issue #281 - Unified delete pattern for standard element-crud flow
   *
   * @param filePath - The filename of the persona to delete
   */
  override async delete(filePath: string): Promise<void> {
    // Issue #281: Auto-deactivate before deletion
    // This allows deleting active personas without requiring explicit deactivation
    const wasActive = this.activePersonas.has(filePath);
    if (wasActive) {
      this.activePersonas.delete(filePath);
    }

    await super.delete(filePath);
    await this.reload();

    // SECURITY: Log persona deletion event (BaseElementManager also logs, but with different details)
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_DELETED',
      severity: 'LOW',
      source: 'PersonaManager.delete',
      details: `Persona deleted: ${filePath}`,
      additionalData: {
        filename: filePath,
        wasActive
      }
    });
  }

  /**
   * Delete persona by name or identifier (legacy API)
   * @deprecated Use delete(filename) via standard element-crud flow
   */
  async deletePersona(personaIdentifier: string): Promise<{ success: boolean; message: string }> {
    // Issue #843: Use async fallback to recover from cache eviction
    const persona = await this.findPersonaAsync(personaIdentifier);
    if (!persona) {
      return { success: false, message: `Persona '${personaIdentifier}' not found` };
    }

    try {
      await this.delete(persona.filename);
      return { success: true, message: `Successfully deleted persona '${personaIdentifier}'` };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      throw new Error(`Failed to delete persona: ${sanitized.message}`);
    }
  }

  async importPersona(source: string, overwrite = false): Promise<ImportResult> {
    if (!this.personaImporter) {
      return {
        success: false,
        message: "Persona import is not available. PersonaImporter service not configured."
      };
    }
    this.initializePathValidator();

    const personasMap = await this.getAllPersonas();
    const result = await this.personaImporter.importPersona(source, personasMap, overwrite);
    if (result.success && result.persona) {
      // Convert legacy PersonaMetadata to PersonaElementMetadata
      const elementMetadata = this.toPersonaElementMetadata(result.persona.metadata);

      // Fix #906: For v1 format imports (no instructions in frontmatter), the markdown
      // body must stay as the document body below '---', not be stuffed into the YAML
      // instructions field. Setting instructions to the description triggers the v2 path
      // in createElement(), keeping bodyText as content (document body).
      if (!elementMetadata.instructions && result.persona.content) {
        // Prefer description (concise behavioral summary) over name (just a label).
        // name is guaranteed to exist (validated by PersonaImporter.validateAndEnrichMetadata).
        elementMetadata.instructions = elementMetadata.description || elementMetadata.name;
      }

      const personaToSave = this.createElement(elementMetadata, result.persona.content);
      personaToSave.filename = result.persona.filename ?? personaToSave.filename;
      personaToSave.unique_id = result.persona.unique_id;
      personaToSave.id = personaToSave.unique_id;

      await super.save(personaToSave, personaToSave.filename);
      // Note: reload() intentionally NOT called here (Issue #491).
      // Import only adds files — no active persona cleanup needed.

      return {
        ...result,
        persona: personaToSave,
        filename: personaToSave.filename
      };
    }
    return result;
  }

  // Type Adapters ----------------------------------------------------------------

  /**
   * Convert PersonaMetadata (legacy) to PersonaElementMetadata (new standard)
   * Ensures strict typing for age_rating and generation_method
   * NOTE: Filename is infrastructure data, not business metadata - it's excluded here
   */
  private toPersonaElementMetadata(metadata: PersonaMetadata): PersonaElementMetadata {
    const { filename, ...metadataWithoutFilename } = metadata; // Strip filename from legacy data

    return {
      ...metadataWithoutFilename,
      type: ElementType.PERSONA,
      name: metadata.name ?? 'Untitled Persona',
      description: metadata.description ?? '',
      age_rating: (metadata.age_rating as 'all' | '13+' | '18+') ?? 'all',
      generation_method: (metadata.generation_method as 'human' | 'ChatGPT' | 'Claude' | 'hybrid') ?? 'human'
    };
  }

  /**
   * Type guard to check if metadata is PersonaElementMetadata
   */
  private isPersonaElementMetadata(metadata: any): metadata is PersonaElementMetadata {
    return metadata && typeof metadata === 'object' && metadata.type === ElementType.PERSONA;
  }

  // BaseElementManager overrides ------------------------------------------------

  protected override async parseMetadata(data: any): Promise<PersonaElementMetadata> {
    const personaData = data as PersonaMetadata;
    const metadata = this.toPersonaElementMetadata(personaData);

    if (!metadata.unique_id) {
      metadata.unique_id = generateUniqueId(metadata.name, metadata.author);
    }

    return metadata;
  }

  protected createElement(metadata: PersonaElementMetadata, bodyText: string): PersonaElement {
    const uniqueId = metadata.unique_id ?? generateUniqueId(metadata.name, metadata.author);
    // Filename is derived from name - use inherited getElementFilename() for consistent normalization
    const filename = this.getElementFilename(metadata.name);

    // Fix #912: Prefer explicit format_version marker, fall back to instructions-presence check
    delete (metadata as any).format_version;  // Strip marker from runtime metadata
    const metadataInstructions = metadata.instructions;
    let instructions: string;
    let content: string;
    if (metadataInstructions) {
      // v2 format: instructions from metadata, bodyText is content (reference material)
      instructions = metadataInstructions;
      content = bodyText;
    } else {
      // v1 format or direct creation: bodyText maps to instructions
      instructions = bodyText;
      content = '';
    }

    // Strip instructions from metadata to prevent duplicate YAML keys during serialization
    const { instructions: _stripInstr, ...cleanMetadata } = metadata as any;

    // Create PersonaElement instance - metadata is already PersonaElementMetadata with correct types
    const personaElement = new PersonaElement(
      {
        ...cleanMetadata,
        unique_id: uniqueId
      },
      instructions,
      filename,
      this.metadataService,
      content
    );

    // Set the ID to match unique_id for consistency
    personaElement.id = uniqueId;

    return personaElement;
  }

  protected async serializeElement(element: PersonaElement): Promise<string> {
    // Fix #909: Use spread copy to avoid mutating live element metadata in-place
    const metadata: Record<string, any> = { ...element.metadata };

    // Issue #755: Serialize type as singular and persist unique_id
    metadata.type = toSingularLabel(ElementType.PERSONA);
    metadata.format_version = 'v2';  // Fix #912: Explicit format marker
    metadata.unique_id = element.id;

    // v2.0 dual-field format: instructions in YAML frontmatter
    if (element.instructions) {
      metadata.instructions = element.instructions;
    }

    // Build body: content (reference material) below '---', with name heading
    const name = element.metadata.name;
    const bodyContent = element.content || '';
    const description = (element.metadata.description ?? '').trim();

    let body: string;
    if (bodyContent.trim()) {
      body = `# ${name}\n\n${bodyContent}`;
    } else if (description) {
      body = `# ${name}\n\n${description}`;
    } else {
      body = `# ${name}`;
    }

    // Fix #909: Use SerializationService instead of manual YAML construction.
    // JSON schema preserves booleans and numbers; remove-both cleans null/undefined.
    const personaContent = this.serializationService.createFrontmatter(metadata, body, {
      method: 'manual',
      schema: 'json',
      cleanMetadata: true,
      cleaningStrategy: 'remove-both',
      sortKeys: true
    });

    validateContentSize(personaContent, SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES);

    return personaContent;
  }

  getFileExtension(): string {
    return '.md';
  }

  async importElement(data: string, format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<PersonaElement> {
    let metadata: PersonaMetadata;
    let instructions: string;
    let content: string;

    if (format === 'json' || format === 'yaml') {
      const parsed = JSON.parse(data) as Persona;
      metadata = parsed.metadata;
      instructions = parsed.instructions || '';
      content = parsed.content || '';
    } else {
      // SECURITY: Phase 4.5 - Validate YAML content before parsing
      // SECURITY: Phase 4.7 - Throw descriptive error message for test expectations
      if (data.includes('---')) {
        const yamlPart = data.split('---')[1];
        if (yamlPart) {
          const yamlValidation = ContentValidator.validateYamlContent(yamlPart);
          if (!yamlValidation) {
            SecurityMonitor.logSecurityEvent({
              type: 'YAML_INJECTION_ATTEMPT',
              severity: 'HIGH',
              source: 'PersonaManager.importElement',
              details: 'Malicious YAML content detected'
            });
            throw new Error('Failed to parse markdown: Malicious YAML content detected');
          }
        }
      }

      const parsed = SecureYamlParser.safeMatter(data);

      // SECURITY: Validate metadata keys to prevent prototype pollution
      this.validateMetadataKeys(parsed.data);

      metadata = parsed.data as PersonaMetadata;
      const bodyText = parsed.content;

      // Dual-field loading: detect v2 format (instructions in YAML frontmatter)
      if (metadata.instructions) {
        // v2 format: instructions from YAML, body text is content (reference material)
        instructions = metadata.instructions;
        content = bodyText;
      } else {
        // v1 format: body text maps to instructions (it IS behavioral directives)
        instructions = bodyText;
        content = '';
      }
    }

    // Convert legacy PersonaMetadata to PersonaElementMetadata before creating element
    const elementMetadata = this.toPersonaElementMetadata(metadata);
    const element = this.createElement(elementMetadata, instructions);
    element.content = content;
    return element;
  }

  async exportElement(persona: PersonaElement, _format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<string> {
    // Use base element serialization for secure YAML generation
    // Pass instructions (behavioral directives) as the primary text
    const element = this.createElement(persona.metadata, persona.instructions);
    element.content = persona.content;  // Preserve reference material
    return await this.serializeElement(element);
  }

  protected override async canDelete(element: PersonaElement): Promise<{ allowed: boolean; reason?: string }> {
    if (isDefaultPersona(element.filename)) {
      return {
        allowed: false,
        reason: 'Cannot delete a default persona. Edit it to create a personal copy instead.'
      };
    }

    // Issue #281: Check if persona is in the active set
    if (this.activePersonas.has(element.filename)) {
      return {
        allowed: false,
        reason: 'Cannot delete an active persona. Deactivate it first.'
      };
    }

    return { allowed: true };
  }

  protected override async beforeSave(persona: PersonaElement): Promise<void> {
    this.initializePathValidator();
    this.normalizePersonaForSave(persona);
    // Path validation handled by BaseElementManager.save() before this hook is called
  }
}
