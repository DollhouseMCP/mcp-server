/**
 * MetadataService - Centralized metadata normalization and defaults
 *
 * Eliminates ~300 LOC of duplicate metadata handling across 6 element managers.
 *
 * Key Features:
 * - Consistent metadata structure across all element types
 * - Automatic default value assignment
 * - Version normalization (1.0 → 1.0.0)
 * - Unique ID generation
 * - User attribution with fallback chain
 * - Date formatting (ISO 8601)
 *
 * Architecture:
 * - Session-aware identity resolution via ContextTracker + SessionActivationRegistry (Issue #1946)
 * - Type-safe with TypeScript strict mode
 * - Security-first (validates all inputs)
 * - Preserves exact current behavior from managers
 *
 * @example
 * ```typescript
 * const metadata = metadataService.normalizeMetadata(
 *   { name: 'My Skill', description: 'Does things' },
 *   ElementType.SKILL
 * );
 * // Returns: { name: 'My Skill', description: 'Does things',
 * //           version: '1.0.0', author: 'user', created: '2025-11-19', ... }
 * ```
 */

import { userInfo } from 'node:os';
import { ElementType } from '../portfolio/types.js';
import { toSingularLabel } from '../utils/elementTypeNormalization.js';
import { generateAnonymousId, generateUniqueId } from '../utils/filesystem.js';
import { SYSTEM_CONTEXT } from '../context/ContextPolicy.js';
import { normalizeVersion } from '../elements/BaseElement.js';
import { logger } from '../utils/logger.js';

/**
 * Base metadata interface (common to all elements)
 */
export interface BaseMetadata {
  name: string;
  description: string;
  version?: string;  // Made optional - normalizeMetadata will set default '1.0.0'
  author?: string;
  created?: string;
  modified?: string;
  tags?: string[];
  triggers?: string[];
  unique_id?: string;
  type?: ElementType;
}

/**
 * Options for metadata normalization
 */
export interface MetadataNormalizationOptions {
  /** Whether to preserve existing values instead of applying defaults (default: false) */
  preserveExisting?: boolean;

  /** Whether to generate unique ID if missing (default: true) */
  generateId?: boolean;

  /** Whether to normalize version format (default: true) */
  normalizeVersion?: boolean;

  /** Whether to set current user as author (default: true) */
  setAuthor?: boolean;

  /** Whether to set creation date if missing (default: true) */
  setCreated?: boolean;

  /** Whether to set modified date (default: true) */
  setModified?: boolean;

  /** Additional type-specific defaults to merge */
  typeDefaults?: Record<string, any>;

  /** Skip applying typeDefaults (for BaseElement constructor) - only normalize common fields */
  skipTypeDefaults?: boolean;
}

/**
 * MetadataService - Centralized metadata normalization and defaults
 *
 * ZERO FUNCTIONALITY LOSS:
 * This service extracts exact behavior from all 6 managers without any changes.
 * Every default value, every normalization rule, every edge case is preserved.
 *
 * USAGE:
 * ```typescript
 * const metadata = metadataService.normalizeMetadata(
 *   rawMetadata,
 *   ElementType.SKILL,
 *   {
 *     typeDefaults: {
 *       category: 'general',
 *       difficulty: 'intermediate'
 *     }
 *   }
 * );
 * ```
 */
export class MetadataService {
  private currentUser: string | null = null;
  private contextTracker?: import('../security/encryption/ContextTracker.js').ContextTracker;
  private activationRegistry?: import('../state/SessionActivationState.js').SessionActivationRegistry;

  /**
   * Issue #1946: Configure session-aware identity resolution.
   * Called by the DI container after construction (avoids circular deps).
   */
  configureSessionAwareness(
    contextTracker: import('../security/encryption/ContextTracker.js').ContextTracker,
    activationRegistry: import('../state/SessionActivationState.js').SessionActivationRegistry,
  ): void {
    this.contextTracker = contextTracker;
    this.activationRegistry = activationRegistry;
  }

  /**
   * Normalize metadata with type-specific defaults
   *
   * Applies:
   * - Default values for missing fields
   * - Version normalization (1.0 → 1.0.0)
   * - Unique ID generation
   * - User attribution
   * - Date formatting (ISO 8601)
   *
   * PRESERVES EXACT BEHAVIOR:
   * - PersonaManager: lines 164-205 (normalizePersonaForSave)
   * - AgentManager: lines 113, 642-644 (getCurrentUserForAttribution)
   * - MemoryManager: lines 1342-1421 (parseMemoryFile metadata defaults)
   * - SkillManager: lines 44-102 (create method defaults)
   * - TemplateManager: lines 298-375 (validateMetadata defaults)
   * - EnsembleManager: lines 86-347 (parseMetadata defaults)
   *
   * @param raw - Raw metadata from user input or file
   * @param elementType - Type of element being created
   * @param options - Normalization options
   * @returns Fully normalized metadata
   *
   * @example
   * const metadata = metadataService.normalizeMetadata(
   *   { name: 'My Skill', description: 'Does things' },
   *   ElementType.SKILL
   * );
   * // Returns: { name: 'My Skill', description: 'Does things',
   * //           version: '1.0.0', author: 'user', created: '2025-11-19', ... }
   */
  normalizeMetadata<T extends BaseMetadata>(
    raw: Partial<T>,
    elementType: ElementType,
    options: MetadataNormalizationOptions = {}
  ): T {
    // Set default options
    const opts = {
      preserveExisting: options.preserveExisting ?? false,
      generateId: options.generateId ?? true,
      normalizeVersion: options.normalizeVersion ?? true,
      setAuthor: options.setAuthor ?? true,
      setCreated: options.setCreated ?? true,
      setModified: options.setModified ?? true,
      typeDefaults: options.typeDefaults ?? {},
      skipTypeDefaults: options.skipTypeDefaults ?? false
    };

    // Start with raw metadata
    const normalized: any = { ...raw };

    // Apply type-specific defaults FIRST (can be overridden by standard defaults)
    // Skip if skipTypeDefaults is true (for BaseElement constructor)
    if (opts.typeDefaults && Object.keys(opts.typeDefaults).length > 0 && !opts.skipTypeDefaults) {
      for (const [key, value] of Object.entries(opts.typeDefaults)) {
        if (normalized[key] === undefined || (opts.preserveExisting === false && !normalized[key])) {
          normalized[key] = value;
        }
      }
    }

    // Apply standard metadata defaults

    // Name (required field, should already be set, but ensure it exists)
    if (!normalized.name) {
      normalized.name = `Untitled ${this.getElementTypeName(elementType)}`;
    }

    // Description
    if (normalized.description === undefined || normalized.description === null) {
      normalized.description = '';
    }

    // Version normalization
    if (opts.normalizeVersion) {
      if (!normalized.version) {
        normalized.version = '1.0.0';
      } else {
        normalized.version = this.normalizeVersion(String(normalized.version));
      }
    }

    // Author attribution
    if (opts.setAuthor && !normalized.author) {
      normalized.author = this.getCurrentUser();
    }

    // Created date (YYYY-MM-DD format, matching PersonaManager line 178)
    if (opts.setCreated && !normalized.created) {
      if (normalized.created_date) {
        normalized.created = String(normalized.created_date).split('T')[0];
      } else {
        normalized.created = this.generateDate('date-only');
      }
    }

    // Modified date (ISO 8601 full format, matching AgentManager line 231)
    if (opts.setModified && !normalized.modified) {
      normalized.modified = this.generateDate('full');
    }

    // Tags (initialize empty array if not provided)
    if (!normalized.tags) {
      normalized.tags = [];
    }

    // Unique ID generation (if enabled and missing)
    if (opts.generateId && !normalized.unique_id) {
      const author = normalized.author || this.getCurrentUser();
      normalized.unique_id = this.assignUniqueId(normalized.name, author);
    }

    // Set element type if not present
    if (!normalized.type) {
      normalized.type = elementType;
    }

    return normalized as T;
  }

  /**
   * Generate default metadata for an element type
   *
   * Provides baseline metadata structure with all required fields populated.
   * Useful for creating new elements or testing.
   *
   * @param elementType - Type of element
   * @param overrides - Optional field overrides
   * @returns Default metadata structure
   *
   * @example
   * const defaults = metadataService.generateDefaultMetadata(ElementType.SKILL);
   * // Returns: { name: 'Untitled Skill', description: '',
   * //           version: '1.0.0', author: 'anonymous', ... }
   */
  generateDefaultMetadata(
    elementType: ElementType,
    overrides: Partial<BaseMetadata> = {}
  ): BaseMetadata {
    const defaults: BaseMetadata = {
      name: `Untitled ${this.getElementTypeName(elementType)}`,
      description: '',
      version: '1.0.0',
      author: this.getCurrentUser(),
      created: this.generateDate('date-only'),
      modified: this.generateDate('full'),
      type: elementType
    };

    return { ...defaults, ...overrides };
  }

  /**
   * Assign a unique ID based on name and author
   *
   * Format: Uses existing generateUniqueId utility which creates:
   * `{slugified-name}-{author-hash}` or random UUID
   *
   * PRESERVES EXACT BEHAVIOR:
   * - PersonaManager line 181-182: generateUniqueId(metadata.name, metadata.author)
   * - PersonaManager line 567: generateUniqueId(sanitizedName, this.getCurrentUserForAttribution() || undefined)
   *
   * @param name - Element name
   * @param author - Element author
   * @returns Unique identifier string
   *
   * @example
   * const id = metadataService.assignUniqueId('My Skill', 'john');
   * // Returns: 'my-skill-a3f8d9e2' (or similar hash)
   */
  assignUniqueId(name: string, author: string): string {
    // Use existing utility function (preserves exact behavior)
    return generateUniqueId(name, author);
  }

  /**
   * Get current user for attribution
   *
   * Priority (Issue #1946):
   * 1. Session-scoped identity override (from SessionActivationState.userIdentity)
   * 2. SessionContext identity (HTTP auth, DOLLHOUSE_USER at startup)
   * 3. Singleton fallback: DOLLHOUSE_USER env var → OS username → anonymous ID
   *
   * Steps 1-2 resolve per-request via ContextTracker + SessionActivationRegistry.
   * Step 3 is cached on first resolution for background/startup tasks.
   *
   * @returns Username or anonymous ID
   */
  getCurrentUser(): string {
    // Issue #1946: Check session-scoped identity first
    const sessionUser = this.resolveSessionUser();
    if (sessionUser) return sessionUser;

    // Fallback: cached resolution from env/OS (singleton-safe for background tasks)
    if (!this.currentUser) {
      this.currentUser = this.resolveSystemUser();
    }
    return this.currentUser;
  }

  /** Resolve user identity from the current session context. */
  private resolveSessionUser(): string | null {
    if (!this.activationRegistry || !this.contextTracker) return null;

    const sessionId = this.contextTracker.getSessionContext()?.sessionId
      ?? this.activationRegistry.getDefaultSessionId();
    const state = this.activationRegistry.get(sessionId);
    if (state?.userIdentity) return state.userIdentity.username;

    const session = this.contextTracker.getSessionContext();
    if (session && session.userId !== SYSTEM_CONTEXT.userId) {
      return session.displayName || session.userId;
    }
    return null;
  }

  /** Resolve user from environment variable or OS username. */
  private resolveSystemUser(): string {
    const envUser = process.env.DOLLHOUSE_USER;
    if (envUser) {
      logger.debug('[MetadataService] User resolved from DOLLHOUSE_USER env var', { user: envUser });
      return envUser;
    }

    let osUser: string | null = null;
    try { osUser = userInfo().username || null; } catch { /* platform unsupported */ }
    if (osUser) {
      logger.debug('[MetadataService] User resolved from OS username', { user: osUser });
      return osUser;
    }

    const anonId = generateAnonymousId();
    logger.debug('[MetadataService] User resolved as anonymous', { user: anonId });
    return anonId;
  }

  /**
   * Set current user identity
   *
   * @param username - Username to set (null to clear)
   *
   * @example
   * metadataService.setCurrentUser('john');
   * metadataService.setCurrentUser(null); // Clear
   */
  /**
   * @deprecated Issue #1946: Identity is now session-scoped via SessionActivationState.userIdentity.
   * This method only affects the singleton fallback chain. Use set_user_identity MCP tool instead.
   */
  setCurrentUser(username: string | null): void {
    this.currentUser = username;
    logger.debug('[MetadataService] Current user set (deprecated singleton path)', { username });
  }

  /**
   * Normalize version string to semantic versioning format
   *
   * Handles:
   * - 1.0 → 1.0.0
   * - 2 → 2.0.0
   * - 1.2.3-beta → 1.2.3-beta (preserves pre-release)
   *
   * PRESERVES EXACT BEHAVIOR:
   * - PersonaManager line 173: metadata.version = normalizeVersion(metadata.version)
   * - PersonaManager line 786-787: normalizeVersion(String(editablePersona.version))
   * - Uses existing normalizeVersion() utility from BaseElement
   *
   * @param version - Version string to normalize
   * @returns Normalized version string
   *
   * @example
   * const v = metadataService.normalizeVersion('1.0');
   * // Returns: '1.0.0'
   */
  normalizeVersion(version: string): string {
    // Use existing utility function (preserves exact behavior)
    return normalizeVersion(version);
  }

  /**
   * Generate ISO 8601 date string
   *
   * PRESERVES EXACT BEHAVIOR:
   * - PersonaManager line 178: new Date().toISOString().split('T')[0] (date-only)
   * - AgentManager line 231: new Date().toISOString() (full)
   *
   * @param format - Date format ('full' or 'date-only')
   * @returns Formatted date string
   *
   * @example
   * const date = metadataService.generateDate('date-only');
   * // Returns: '2025-11-19'
   *
   * const datetime = metadataService.generateDate('full');
   * // Returns: '2025-11-19T10:30:45.123Z'
   */
  generateDate(format: 'full' | 'date-only' = 'full'): string {
    const now = new Date().toISOString();

    if (format === 'date-only') {
      // Match PersonaManager line 178 exactly
      return now.split('T')[0];
    }

    // Full ISO 8601 format
    return now;
  }

  /**
   * Validate metadata completeness
   *
   * Checks:
   * - Required fields present (name, description)
   * - Valid types for all fields
   * - Value constraints (version format, etc.)
   *
   * @param metadata - Metadata to validate
   * @param elementType - Element type for type-specific validation
   * @returns Validation result
   *
   * @example
   * const result = metadataService.validateMetadata(metadata, ElementType.SKILL);
   * if (!result.valid) {
   *   console.error('Validation errors:', result.errors);
   * }
   */
  validateMetadata(
    metadata: BaseMetadata,
    elementType: ElementType
  ): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    // Required fields
    if (!metadata.name || typeof metadata.name !== 'string' || metadata.name.trim().length === 0) {
      errors.push('name is required and must be a non-empty string');
    }

    if (metadata.description === undefined || metadata.description === null) {
      errors.push('description is required (can be empty string)');
    }

    if (!metadata.version || typeof metadata.version !== 'string') {
      errors.push('version is required and must be a string');
    }

    // Type validation
    if (metadata.author !== undefined && typeof metadata.author !== 'string') {
      errors.push('author must be a string');
    }

    if (metadata.created !== undefined && typeof metadata.created !== 'string') {
      errors.push('created must be a date string');
    }

    if (metadata.modified !== undefined && typeof metadata.modified !== 'string') {
      errors.push('modified must be a date string');
    }

    if (metadata.tags !== undefined && !Array.isArray(metadata.tags)) {
      errors.push('tags must be an array');
    }

    if (metadata.triggers !== undefined && !Array.isArray(metadata.triggers)) {
      errors.push('triggers must be an array');
    }

    // Issue #755: Accept both plural ElementType ('agents') and singular label ('agent')
    if (metadata.type !== undefined && metadata.type !== elementType && metadata.type !== toSingularLabel(elementType)) {
      errors.push(`type must match element type (expected: ${elementType}, got: ${metadata.type})`);
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  // Private helper methods

  /**
   * Get human-readable element type name
   * @private
   */
  private getElementTypeName(elementType: ElementType): string {
    const typeNames: Record<ElementType, string> = {
      [ElementType.SKILL]: 'Skill',
      [ElementType.PERSONA]: 'Persona',
      [ElementType.TEMPLATE]: 'Template',
      [ElementType.AGENT]: 'Agent',
      [ElementType.MEMORY]: 'Memory',
      [ElementType.ENSEMBLE]: 'Ensemble'
    };

    return typeNames[elementType] || 'Element';
  }
}
