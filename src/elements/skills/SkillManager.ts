/**
 * SkillManager - Refactored to extend BaseElementManager for shared CRUD logic.
 * Maintains skill-specific behaviors such as trigger validation, import/export,
 * and creation workflows while eliminating duplicated file handling code.
 */

import type { ActivationMetricsTracker } from '../../metrics/ActivationMetricsTracker.js';
import { visitSequentially } from '../../utils/visitSequentially.js';
import { BaseElementManager } from '../base/BaseElementManager.js';
import type { ElementManagerDeps } from '../base/BaseElementManager.js';
import { Skill } from './Skill.js';
import type { SkillMetadata } from './Skill.js';
import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { logger } from '../../utils/logger.js';
import type { TriggerValidationService } from '../../services/validation/TriggerValidationService.js';
import type { ValidationService } from '../../services/validation/ValidationService.js';
import type { SerializationService } from '../../services/SerializationService.js';
import type { MetadataService } from '../../services/MetadataService.js';
import { ElementMessages } from '../../utils/elementMessages.js';
import { sanitizeGatekeeperPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';
import { SECURITY_LIMITS } from '../../security/constants.js';

// Validation constants for skill triggers
const MAX_TRIGGER_LENGTH = 50;
// Allows alphanumeric, hyphens, underscores, @ (mentions/emails), . (domains)
const TRIGGER_VALIDATION_REGEX = /^[a-zA-Z0-9\-_@.]+$/;

export interface SkillManagerDeps extends ElementManagerDeps {
  activationMetricsTracker: ActivationMetricsTracker;
}

export class SkillManager extends BaseElementManager<Skill> {
  private readonly triggerValidationService: TriggerValidationService;
  private readonly validationService: ValidationService;
  private readonly serializationService: SerializationService;
  private readonly metadataService: MetadataService;
  private readonly activationMetricsTracker: ActivationMetricsTracker;

  constructor(deps: SkillManagerDeps) {
    super(
      ElementType.SKILL,
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
    this.activationMetricsTracker = deps.activationMetricsTracker;
    this.metadataService = deps.metadataService;
    this.triggerValidationService = deps.validationRegistry.getTriggerValidationService();
    this.validationService = deps.validationRegistry.getValidationService();
    this.serializationService = deps.serializationService;
  }

  /** Issue #1946: Per-session activation state via base class helper. */
  private getActivationSet(): Set<string> {
    return this.resolveActivationSet('skills');
  }

  protected override getElementLabel(): string {
    return 'skill';
  }

  /**
   * Create a new skill element and persist it to disk.
   * FIX: Issue #20 - Add duplicate name checking
   */
  async create(data: Partial<SkillMetadata> & { content?: string; instructions?: string }): Promise<Skill> {
    // Use specialized validator for input validation
    const validationResult = await this.validator.validateCreate(data);

    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Log warnings if any
    if (validationResult.warnings.length > 0) {
      logger.warn(`Skill creation warnings: ${validationResult.warnings.join(', ')}`);
    }

    // Get sanitized values for file operations (validator already validated, we just need sanitized values)
    const nameInput = data.name || 'new-skill';
    const nameResult = this.validationService.validateAndSanitizeInput(nameInput, {
      maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH,
      allowSpaces: true
    });
    const sanitizedName = nameResult.sanitizedValue;
    if (!sanitizedName) {
      throw new Error('Skill name validation did not return a sanitized value');
    }

    // Use inherited getElementFilename() for consistent filename normalization
    const filename = this.getElementFilename(sanitizedName);

    // FIX: Issue #20 - Check for duplicate before creating
    const existingSkills = await this.list();
    const duplicate = existingSkills.some(s =>
      s.metadata.name.toLowerCase() === sanitizedName.toLowerCase()
    );

    if (duplicate) {
      throw new Error(`A skill named "${sanitizedName}" already exists`);
    }

    const { content, instructions, ...metadata } = data;
    // Dual-field: instructions = behavioral directives, content = reference material
    // For skills, instructions is the primary field (how to apply the skill)
    const effectiveInstructions = instructions || content || '';
    const effectiveContent = instructions ? (content || '') : '';
    const skill = new Skill(
      {
        ...metadata,
        name: sanitizedName,
        description: data.description || ''
      },
      effectiveInstructions,
      this.metadataService,
      effectiveContent
    );

    await this.save(skill, filename);
    // Note: No reload() here — save() caches the element correctly.
    // See Issue #491 for why PersonaManager's reload-after-create was removed.

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'SkillManager.create',
      details: `Skill created: ${skill.metadata.name}`
    });

    return skill;
  }

  /**
   * Import a skill from Markdown/YAML frontmatter or JSON input formats.
   */
  async importElement(data: string, format: 'yaml' | 'json' | 'markdown' = 'yaml'): Promise<Skill> {
    await Promise.resolve();
    try {
      let metadata: any;
      let instructions: string;
      let content = '';

      if (format === 'yaml' || format === 'markdown') {
        // Use SerializationService for YAML frontmatter parsing
        const result = this.serializationService.parseFrontmatter(data, {
          maxYamlSize: 64 * 1024,
          validateContent: true,
          source: 'SkillManager.importElement'
        });

        metadata = result.data.metadata ?? result.data;
        const explicitInstructions = result.data.instructions ?? metadata.instructions;
        const isV2 = typeof explicitInstructions === 'string';
        instructions = isV2 ? (explicitInstructions ?? '') : (result.content || '');
        content = isV2 ? result.content : '';
        delete metadata.instructions;
      } else {
        // Use SerializationService for JSON parsing
        const parsed = this.serializationService.parseJson(data, {
          source: 'SkillManager.importElement'
        });

        if (typeof parsed.content === 'string') content = parsed.content;
        if (parsed.metadata) {
          metadata = parsed.metadata;
          instructions = parsed.instructions || '';
        } else {
          metadata = parsed;
          instructions = parsed.instructions || '';
          delete metadata.instructions;
        }
      }

      return new Skill(metadata, instructions, this.metadataService, content);
    } catch (error) {
      logger.error('Failed to import skill:', error);
      throw error;
    }
  }

  /**
   * Export a skill to Markdown/YAML frontmatter, YAML, or JSON.
   */
  async exportElement(element: Skill, format: 'yaml' | 'json' | 'markdown' = 'yaml'): Promise<string> {
    if (format === 'markdown') {
      return this.serializeElement(element);
    }

    if (format === 'yaml') {
      const data = {
        metadata: element.metadata,
        instructions: element.instructions,
        parameters: Object.fromEntries(element.parameters)
      };

      return this.serializationService.dumpYaml(data, {
        schema: 'json',  // Fix #914: failsafe corrupts booleans/numbers to strings
        noRefs: true,
        skipInvalid: true
      });
    }

    // For JSON, spread metadata properties directly (maintain backward compatibility)
    const data = {
      ...element.metadata,
      instructions: element.instructions,
      parameters: Object.fromEntries(element.parameters)
    };

    return this.serializationService.stringifyJson(data, {
      pretty: true,
      indent: 2
    });
  }

  getFileExtension(): string {
    return '.md';
  }

  /**
   * Validate and normalize metadata parsed from frontmatter.
   */
  protected parseMetadata(data: any): Promise<SkillMetadata> {
    const metadata = { ...(data as SkillMetadata) };

    if (Array.isArray(data?.triggers)) {
      const validationResult = this.triggerValidationService.validateTriggers(
        data.triggers,
        ElementType.SKILL,
        metadata.name || 'unknown'
      );
      metadata.triggers = validationResult.validTriggers;
    }

    // Issue #676: Sanitize gatekeeper policy on load to prevent prompt-injection attacks
    // Malformed policies are stripped and logged as security events (never reach enforcement)
    if (metadata.gatekeeper) {
      metadata.gatekeeper = sanitizeGatekeeperPolicy(metadata.gatekeeper, metadata.name || 'unknown', 'skill', metadata);
    }

    return Promise.resolve(metadata);
  }

  /**
   * Create skill instance from metadata/content.
   * Dual-field: detects v2 format (instructions in YAML frontmatter) vs v1 (body = instructions).
   */
  protected createElement(metadata: SkillMetadata, bodyContent: string): Skill {
    // An explicit instructions field (including empty) separates reference content.
    // Legacy v2 files without that field still use their body as instructions.
    const isV2 = typeof metadata.instructions === 'string';
    delete (metadata as any).format_version;  // Strip marker from runtime metadata
    const metadataInstructions = metadata.instructions;
    let instructions: string;
    let content: string;

    if (isV2) {
      // v2 format: instructions from YAML, body is reference content
      instructions = metadataInstructions ?? '';
      content = bodyContent;
      delete metadata.instructions;
    } else {
      // v1 format: body text is instructions
      instructions = bodyContent;
      content = '';
    }

    return new Skill(metadata, instructions, this.metadataService, content);
  }

  /**
   * Serialize a skill to markdown with frontmatter.
   * v2.0 format: instructions in YAML frontmatter, content as body.
   */
  protected serializeElement(element: Skill): Promise<string> {
    // Prepare metadata with version and instructions
    const metadata: Record<string, any> = { ...element.metadata };
    // Issue #755: Serialize type as singular and persist unique_id
    metadata.type = toSingularLabel(ElementType.SKILL);
    metadata.unique_id = element.id;
    if (element.version) {
      metadata.version = element.version;
    }
    // Mark the dual-field serialization format.
    metadata.format_version = 'v2';
    // Write instructions to YAML frontmatter (v2.0 dual-field format)
    metadata.instructions = element.instructions;

    // Body is the reference content
    const body = element.content || this.buildDefaultBody(element);

    return Promise.resolve(this.serializationService.createFrontmatter(metadata, body, {
      method: 'matter',
      cleanMetadata: true,
      cleaningStrategy: 'remove-both',  // Fix #913: standardize across all managers
      schema: 'json'  // Fix #914: failsafe corrupts booleans/numbers to strings
    }));
  }

  private buildDefaultBody(skill: Skill): string {
    const metadata = skill.metadata as Partial<SkillMetadata>;
    const name = (metadata.name ?? '').trim();
    const description = (metadata.description ?? '').trim();
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
   * Override list() to apply active status to skills
   */
  override async list(options?: { includePublic?: boolean }): Promise<Skill[]> {
    const skills = await super.list(options);

    // Apply active status to skills that are in the active set (by name)
    await visitSequentially(skills[Symbol.iterator](), async (skill) => {
      if (this.getActivationSet().has(skill.metadata.name)) {
        // Access the protected _status field and set to ACTIVE (value 2)
        await skill.activate();
      }
    });

    return skills;
  }

  /**
   * Activate a skill by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   * Issue #24 (LOW PRIORITY): Report pressure and retained references at the activation threshold
   */
  async activateSkill(identifier: string): Promise<{ success: boolean; message: string; skill?: Skill; notices?: string[] }> {
    // PERFORMANCE FIX: Use findByName() instead of list() to avoid loading all skills
    // This provides O(1) or O(log n) lookup instead of O(n) for large portfolios
    const notices = await this.reportActiveSetPressure();
    const skill = await this.findByName(identifier);

    if (!skill) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.SKILL, identifier)
      };
    }

    // Add to active set (by name, which is stable across reloads)
    this.getActivationSet().add(skill.metadata.name);
    this.recordPendingActivation(skill);

    // Update skill status in memory
    await skill.activate();

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'SkillManager.activateSkill',
      details: `Skill activated: ${skill.metadata.name}`
    });

    logger.info(`Skill activated: ${skill.metadata.name}`);

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: [ElementMessages.activated(ElementType.SKILL, skill.metadata.name), ...notices].join("\n"),
      notices,
      skill
    };
  }

  /**
   * Deactivate a skill by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   */
  async deactivateSkill(identifier: string): Promise<{ success: boolean; message: string; lookupFailed?: boolean }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const { element: skill, lookupFailed } = await this.findForDeactivation(identifier);

    if (!skill) {
      if (this.getActivationSet().delete(identifier)) {
        this.activationMetricsTracker.forget('skill', identifier);
        return { success: true, message: ElementMessages.deactivated(ElementType.SKILL, identifier) };
      }
      return {
        success: false, lookupFailed,
        // CONSISTENCY FIX: Use standardized error message format
        message: lookupFailed ? `${JSON.stringify(identifier)} could not be loaded (storage or definition error)`
          : ElementMessages.notFound(ElementType.SKILL, identifier)
      };
    }

    // Remove from active set
    if (this.getActivationSet().delete(skill.metadata.name)) {
      this.activationMetricsTracker.forget('skill', skill.metadata.name);
      if (identifier !== skill.metadata.name) this.activationMetricsTracker.forget('skill', identifier);
    }

    // Update skill status in memory
    await skill.deactivate();

    logger.info(`Skill deactivated: ${skill.metadata.name}`);

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.deactivated(ElementType.SKILL, skill.metadata.name)
    };
  }

  /**
   * Get all active skills
   */
  async getActiveSkills(): Promise<Skill[]> {
    const results: Skill[] = [];
    await visitSequentially(this.getActivationSet()[Symbol.iterator](), async (name) => {
      const skill = await this.findByName(name);
      if (skill) results.push(skill);
    });
    return results;
  }

  /** Report pressure and await retained-reference notices only at the cleanup threshold. */
  private reportActiveSetPressure(): Promise<string[]> {
    return this.reportActivationPressure('skills', 'SkillManager.reportActiveSetPressure', () => this.collectRetainedReferenceNotices());
  }

  /** A failed or empty lookup is uncertainty, never authority to deactivate a reference. */
  private collectRetainedReferenceNotices(): Promise<string[]> {
    return this.retainedReferenceNotices('skill', async key => !!await this.findByName(key), this.activationMetricsTracker,
      'While it fails to load, no active skill policies are applied.');
  }

  /**
   * Normalize and validate skill triggers.
   */
  private validateAndProcessTriggers(triggers: any[], skillName: string): string[] {
    const validTriggers: string[] = [];
    const rejectedTriggers: string[] = [];
    const rawTriggers = triggers.slice(0, 20);

    // SECURITY: Validate BEFORE sanitization to reject invalid characters
    // This prevents 'bad!trigger' from becoming 'badtrigger' and passing
    for (const raw of rawTriggers) {
      const rawTrigger = String(raw).trim();

      // Check if empty
      if (!rawTrigger) {
        rejectedTriggers.push(`"${raw}" (empty)`);
        continue;
      }

      // SECURITY: Validate format BEFORE sanitization
      if (!TRIGGER_VALIDATION_REGEX.test(rawTrigger)) {
        rejectedTriggers.push(
          `"${raw}" (invalid format - allowed: letters, numbers, hyphens, underscores, @ and .)`
        );
        continue;
      }

      // Only sanitize AFTER validation passes (for length limits)
      const sanitized = sanitizeInput(rawTrigger, MAX_TRIGGER_LENGTH);
      if (sanitized) {
        validTriggers.push(sanitized);
      }
    }

    if (rejectedTriggers.length > 0) {
      logger.warn(`Skill "${skillName}": Rejected ${rejectedTriggers.length} invalid trigger(s)`, {
        skillName,
        rejectedTriggers,
        acceptedCount: validTriggers.length
      });
    }

    if (triggers.length > 20) {
      logger.warn(`Skill "${skillName}": Trigger limit exceeded`, {
        skillName,
        providedCount: triggers.length,
        limit: 20,
        truncated: triggers.length - 20
      });
    }

    return validTriggers;
  }
}
