/**
 * SkillManager - Refactored to extend BaseElementManager for shared CRUD logic.
 * Maintains skill-specific behaviors such as trigger validation, import/export,
 * and creation workflows while eliminating duplicated file handling code.
 */

import { BaseElementManager } from '../base/BaseElementManager.js';
import type { ElementEventDispatcher } from '../../events/ElementEventDispatcher.js';
import { Skill, SkillMetadata } from './Skill.js';
import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { logger } from '../../utils/logger.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../services/validation/TriggerValidationService.js';
import { ValidationService } from '../../services/validation/ValidationService.js';
import { SerializationService } from '../../services/SerializationService.js';
import { MetadataService } from '../../services/MetadataService.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import { ElementMessages } from '../../utils/elementMessages.js';
import { sanitizeGatekeeperPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';
import { SECURITY_LIMITS } from '../../security/constants.js';

// Validation constants for skill triggers
const MAX_TRIGGER_LENGTH = 50;
// Allows alphanumeric, hyphens, underscores, @ (mentions/emails), . (domains)
const TRIGGER_VALIDATION_REGEX = /^[a-zA-Z0-9\-_@.]+$/;

// Issue #83: Centralized active element limits (configurable via env vars)
import { getActiveElementLimitConfig, getMaxActiveLimit } from '../../config/active-element-limits.js';

export class SkillManager extends BaseElementManager<Skill> {
  private triggerValidationService: TriggerValidationService;
  private validationService: ValidationService;
  private serializationService: SerializationService;
  // Track active skills by name (stable identifier)
  private activeSkillNames: Set<string> = new Set();

  constructor(
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry,
    serializationService: SerializationService,
    private metadataService: MetadataService,
    fileWatchService?: FileWatchService,
    memoryBudget?: import('../../cache/CacheMemoryBudget.js').CacheMemoryBudget,
    backupService?: import('../../services/BackupService.js').BackupService,
    eventDispatcher?: ElementEventDispatcher
  ) {
    super(ElementType.SKILL, portfolioManager, fileLockManager, { fileWatchService, memoryBudget, backupService, eventDispatcher }, fileOperationsService, validationRegistry);
    this.triggerValidationService = validationRegistry.getTriggerValidationService();
    this.validationService = validationRegistry.getValidationService();
    this.serializationService = serializationService;
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
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Skill creation warnings: ${validationResult.warnings.join(', ')}`);
    }

    // Get sanitized values for file operations (validator already validated, we just need sanitized values)
    const nameInput = data.name || 'new-skill';
    const nameResult = this.validationService.validateAndSanitizeInput(nameInput, {
      maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH,
      allowSpaces: true
    });
    const sanitizedName = nameResult.sanitizedValue!;

    // Use inherited getElementFilename() for consistent filename normalization
    const filename = this.getElementFilename(sanitizedName);

    // FIX: Issue #20 - Check for duplicate before creating
    const existingSkills = await this.list();
    const duplicate = existingSkills.find(s =>
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
   * Import a skill from YAML or JSON input formats.
   */
  async importElement(data: string, format: 'yaml' | 'json' = 'yaml'): Promise<Skill> {
    try {
      let metadata: any;
      let instructions: string;

      if (format === 'yaml') {
        // Use SerializationService for YAML parsing
        const result = this.serializationService.parseFrontmatter(data, {
          maxYamlSize: 64 * 1024,
          validateContent: true,
          source: 'SkillManager.importElement'
        });

        // Extract metadata and instructions
        if (result.data.metadata) {
          metadata = result.data.metadata;
          instructions = result.data.instructions || result.content || '';
        } else {
          metadata = result.data;
          instructions = result.data.instructions || result.content || '';
          delete metadata.instructions;
        }
      } else {
        // Use SerializationService for JSON parsing
        const parsed = this.serializationService.parseJson(data, {
          source: 'SkillManager.importElement'
        });

        if (parsed.metadata) {
          metadata = parsed.metadata;
          instructions = parsed.instructions || '';
        } else {
          metadata = parsed;
          instructions = parsed.instructions || '';
          delete metadata.instructions;
        }
      }

      return new Skill(metadata, instructions, this.metadataService);
    } catch (error) {
      logger.error('Failed to import skill:', error);
      throw error;
    }
  }

  /**
   * Export a skill to YAML or JSON.
   */
  async exportElement(element: Skill, format: 'yaml' | 'json' = 'yaml'): Promise<string> {
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
  protected async parseMetadata(data: any): Promise<SkillMetadata> {
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
      metadata.gatekeeper = sanitizeGatekeeperPolicy(metadata.gatekeeper, metadata.name || 'unknown', 'skill');
    }

    return metadata;
  }

  /**
   * Create skill instance from metadata/content.
   * Dual-field: detects v2 format (instructions in YAML frontmatter) vs v1 (body = instructions).
   */
  protected createElement(metadata: SkillMetadata, bodyContent: string): Skill {
    // Fix #912: Prefer explicit format_version marker, fall back to instructions-presence check
    const isV2 = (metadata as any).format_version === 'v2' || !!metadata.instructions;
    delete (metadata as any).format_version;  // Strip marker from runtime metadata
    const metadataInstructions = metadata.instructions;
    let instructions: string;
    let content: string;

    if (isV2 && metadataInstructions) {
      // v2 format: instructions from YAML, body is reference content
      instructions = metadataInstructions;
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
  protected async serializeElement(element: Skill): Promise<string> {
    // Prepare metadata with version and instructions
    const metadata: Record<string, any> = { ...element.metadata };
    // Issue #755: Serialize type as singular and persist unique_id
    metadata.type = toSingularLabel(ElementType.SKILL);
    metadata.unique_id = element.id;
    if (element.version) {
      metadata.version = element.version;
    }
    // Fix #912: Explicit format marker replaces fragile instructions-presence detection
    metadata.format_version = 'v2';
    // Write instructions to YAML frontmatter (v2.0 dual-field format)
    if (element.instructions) {
      metadata.instructions = element.instructions;
    }

    // Body is the reference content
    const body = element.content || this.buildDefaultBody(element);

    return this.serializationService.createFrontmatter(metadata, body, {
      method: 'matter',
      cleanMetadata: true,
      cleaningStrategy: 'remove-both',  // Fix #913: standardize across all managers
      schema: 'json'  // Fix #914: failsafe corrupts booleans/numbers to strings
    });
  }

  private buildDefaultBody(skill: Skill): string {
    const name = (skill.metadata.name ?? '').trim();
    const description = (skill.metadata.description ?? '').trim();
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
   * Override list() to apply active status to skills
   */
  override async list(): Promise<Skill[]> {
    const skills = await super.list();

    // Apply active status to skills that are in the active set (by name)
    for (const skill of skills) {
      if (this.activeSkillNames.has(skill.metadata.name)) {
        // Access the protected _status field and set to ACTIVE (value 2)
        await skill.activate();
      }
    }

    return skills;
  }

  /**
   * Activate a skill by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   * Issue #24 (LOW PRIORITY): Cleanup trigger for memory leak prevention
   */
  async activateSkill(identifier: string): Promise<{ success: boolean; message: string; skill?: Skill }> {
    // PERFORMANCE FIX: Use findByName() instead of list() to avoid loading all skills
    // This provides O(1) or O(log n) lookup instead of O(n) for large portfolios
    const skill = await this.findByName(identifier);

    if (!skill) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.SKILL, identifier)
      };
    }

    // MEMORY LEAK FIX: Check if cleanup is needed before adding
    this.checkAndCleanupActiveSet();

    // Add to active set (by name, which is stable across reloads)
    this.activeSkillNames.add(skill.metadata.name);

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
      message: ElementMessages.activated(ElementType.SKILL, skill.metadata.name),
      skill
    };
  }

  /**
   * Deactivate a skill by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   */
  async deactivateSkill(identifier: string): Promise<{ success: boolean; message: string }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const skill = await this.findByName(identifier);

    if (!skill) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.SKILL, identifier)
      };
    }

    // Remove from active set
    this.activeSkillNames.delete(skill.metadata.name);

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
    for (const name of this.activeSkillNames) {
      const skill = await this.findByName(name);
      if (skill) results.push(skill);
    }
    return results;
  }

  /**
   * Check if active set cleanup is needed and perform cleanup if necessary
   *
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   *
   * CLEANUP STRATEGY:
   * - Triggers when set reaches 90% of maximum capacity
   * - Validates that all active skills still exist in portfolio
   * - Removes stale references (skills that were deleted)
   * - Logs cleanup operations for monitoring
   *
   * PERFORMANCE NOTES:
   * - Only runs when threshold is reached (not on every activation)
   * - Uses efficient Set operations
   * - Minimal impact on activation performance
   *
   * @private
   */
  private checkAndCleanupActiveSet(): void {
    const { max, cleanupThreshold } = getActiveElementLimitConfig('skills');

    // Below threshold — no action needed
    if (this.activeSkillNames.size < cleanupThreshold) {
      return;
    }

    // At or above max — warn before cleanup
    if (this.activeSkillNames.size >= max) {
      logger.warn(
        `Active skills limit reached (${max}). ` +
        `Consider deactivating unused skills or setting DOLLHOUSE_MAX_ACTIVE_SKILLS to a higher value.`
      );

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'MEDIUM',
        source: 'SkillManager.checkAndCleanupActiveSet',
        details: `Active skills limit reached: ${this.activeSkillNames.size}/${max}`
      });
    }

    // At or above threshold — proactively clean stale entries
    void this.cleanupStaleActiveSkills();
  }

  /**
   * Clean up stale entries from active skills set
   *
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   *
   * Validates that all active skills still exist and removes orphaned references.
   * This prevents memory leaks from deleted skills that weren't properly deactivated.
   *
   * @private
   */
  private async cleanupStaleActiveSkills(): Promise<void> {
    try {
      const startSize = this.activeSkillNames.size;
      const skills = await this.list();
      const existingSkillNames = new Set(skills.map(s => s.metadata.name));

      // Remove any active skill names that no longer exist in portfolio
      const staleNames: string[] = [];
      for (const activeName of this.activeSkillNames) {
        if (!existingSkillNames.has(activeName)) {
          this.activeSkillNames.delete(activeName);
          staleNames.push(activeName);
        }
      }

      const endSize = this.activeSkillNames.size;
      const removed = startSize - endSize;

      if (removed > 0) {
        logger.info(
          `Cleaned up ${removed} stale active skill reference(s). ` +
          `Active skills: ${endSize}/${getMaxActiveLimit('skills')}`
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_DELETED',
          severity: 'LOW',
          source: 'SkillManager.cleanupStaleActiveSkills',
          details: `Removed ${removed} stale active skill references`,
          additionalData: {
            removedCount: removed,
            activeCount: endSize,
            staleNames: staleNames.join(', ')
          }
        });
      }
    } catch (error) {
      // Log error but don't throw - cleanup failures shouldn't break activation
      logger.error('Failed to cleanup stale active skills:', error);

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'LOW',
        source: 'SkillManager.cleanupStaleActiveSkills',
        details: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
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
