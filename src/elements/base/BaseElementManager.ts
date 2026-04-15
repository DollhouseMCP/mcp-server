/**
 * BaseElementManager - Abstract base class for all element managers
 *
 * Provides common CRUD operations for all element types using the
 * Template Method Pattern:
 * - Defines the skeleton of operations in base class
 * - Lets subclasses override specific steps without changing structure
 *
 * Subclasses: SkillManager, TemplateManager, AgentManager, MemoryManager
 *
 * SECURITY:
 * 1. CRITICAL: Uses FileLockManager for atomic read/write operations
 * 2. HIGH: Path validation and sanitization to prevent traversal attacks
 * 3. MEDIUM: Security event logging for audit trail
 * 4. MEDIUM: Input validation and sanitization throughout
 */

import { randomUUID } from 'node:crypto';
import { IElementManager } from '../../types/elements/IElementManager.js';
import { IElement, ElementValidationResult } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { logger } from '../../utils/logger.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { SecurityError } from '../../security/errors.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { LRUCache } from '../../cache/LRUCache.js';
import * as path from 'path';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { PathValidator } from '../../security/pathValidator.js';
import { ElementEventDispatcher, ElementEventPayload } from '../../events/ElementEventDispatcher.js';
import { ElementTransactionScope } from './ElementTransactionScope.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import { type ElementValidator } from '../../services/validation/ElementValidator.js';
import { ElementStorageLayer } from '../../storage/ElementStorageLayer.js';
import type { IStorageLayer } from '../../storage/IStorageLayer.js';
import type { ElementIndexEntry } from '../../storage/types.js';
import { getGatekeeperAuthoringErrors } from '../../handlers/mcp-aql/policies/ElementPolicies.js';
import {
  getValidatedScanCooldown,
  getValidatedElementCacheTTL,
  getValidatedPathCacheTTL
} from '../../config/performance-constants.js';
import type { CacheMemoryBudget } from '../../cache/CacheMemoryBudget.js';
import type { BackupService } from '../../services/BackupService.js';

const DEFAULT_ELEMENT_CACHE_TTL_MS = getValidatedElementCacheTTL();
const DEFAULT_PATH_CACHE_TTL_MS = getValidatedPathCacheTTL();

export interface BaseElementManagerOptions {
  elementDirOverride?: string;
  eventDispatcher?: ElementEventDispatcher;
  elementCacheTTL?: number;
  pathCacheTTL?: number;
  enableFileWatcher?: boolean;
  autoReloadOnExternalChange?: boolean;
  fileWatchService?: FileWatchService;
  memoryBudget?: CacheMemoryBudget;
  backupService?: BackupService;
}

/**
 * Record of an element that failed to load (Issue #708).
 * Stored so callers can distinguish "file not found" from "file invalid".
 */
export interface InvalidElementRecord {
  /** Relative file path within the element directory. */
  filePath: string;
  /** Human-readable reason the element was rejected. */
  reason: string;
  /** ISO timestamp of last failed load attempt. */
  failedAt: string;
}

/**
 * Abstract base class implementing common element management operations
 * Subclasses must implement element-specific logic via abstract methods
 */
export abstract class BaseElementManager<T extends IElement> implements IElementManager<T> {
  protected portfolioManager: PortfolioManager;
  protected fileLockManager: FileLockManager;
  protected fileOperations: FileOperationsService;
  protected fileWatchService?: FileWatchService;
  protected elementDir: string;

  /**
   * Specialized validator for this element type
   * Obtained from ValidationRegistry during construction
   */
  protected validator: ElementValidator;

  // Primary cache: ID → Element (with size limits to prevent memory leaks)
  protected elements: LRUCache<T>;

  // Reverse index: Absolute FilePath → Element ID (with size limits)
  private filePathToId: LRUCache<string>;
  private readonly elementGenerations = new Map<string, number>();
  private cacheGenerationCounter = 0;
  private watcherCleanup?: () => void;
  private readonly eventDispatcher: ElementEventDispatcher;
  private readonly autoReloadOnExternalChange: boolean;
  private readonly elementType: ElementType;
  private readonly memoryBudget?: CacheMemoryBudget;
  protected readonly backupService?: BackupService;

  /** Map plural ElementType enum values to singular ContentValidator context.
   *  Partial because not all element types have a content context (e.g., ensembles). */
  private static readonly ELEMENT_TYPE_TO_CONTEXT: Partial<Record<ElementType, 'persona' | 'skill' | 'template' | 'agent' | 'memory'>> = {
    [ElementType.PERSONA]: 'persona',
    [ElementType.SKILL]: 'skill',
    [ElementType.TEMPLATE]: 'template',
    [ElementType.AGENT]: 'agent',
    [ElementType.MEMORY]: 'memory',
  };

  protected readonly storageLayer: IStorageLayer;

  /**
   * Issue #708: Elements that exist on disk but failed validation during load.
   * Keyed by relative file path for deduplication.
   */
  private readonly invalidElements = new Map<string, InvalidElementRecord>();

  /**
   * Tracks file paths whose load failure has already been logged at error level.
   * Repeated failures with the same reason are demoted to debug to avoid log flooding.
   * Cleared when the file changes on disk or loads successfully.
   */
  private readonly suppressedLoadPaths = new Set<string>();

  /**
   * Returns true if the most recent load() failure for this path was suppressed
   * because it was a repeat of an already-logged error.
   * Subclasses can use this to avoid duplicate security event logging.
   *
   * @param filePath - Relative file path within the element directory
   * @returns Whether the error for this path is currently suppressed
   */
  protected isLoadErrorSuppressed(filePath: string): boolean {
    return this.suppressedLoadPaths.has(filePath);
  }

  protected afterLoad?(element: T, filePath: string): Promise<void>;
  protected beforeSave?(element: T, filePath: string): Promise<void>;
  protected afterSave?(element: T, filePath: string): Promise<void>;
  protected findByIdentifier?(identifier: string): Promise<T | undefined>;
  protected canDelete?(element: T): Promise<{ allowed: boolean; reason?: string }>;

  /**
   * Create a backup before overwriting an existing file.
   * Subclasses can override to no-op (e.g. MemoryManager has its own backup system).
   */
  protected async createBackupBeforeSave(absolutePath: string): Promise<void> {
    if (!this.backupService) return;
    await this.backupService.backupBeforeSave(absolutePath, this.elementType);
  }

  /**
   * Create a backup before deleting a file (moves file to backup dir).
   * Returns true if the original file was moved (caller should skip deleteFile).
   * Subclasses can override to no-op (e.g. MemoryManager has its own backup system).
   */
  protected async createBackupBeforeDelete(absolutePath: string): Promise<boolean> {
    if (!this.backupService) return false;
    const result = await this.backupService.backupBeforeDelete(absolutePath, this.elementType);
    return !!result.movedOriginal;
  }

  /**
   * Provides access to the event dispatcher for subclasses that need to emit custom events.
   *
   * BaseElementManager handles standard lifecycle events (load, save, delete) automatically.
   * Subclasses should use this getter only when they need to emit additional domain-specific
   * events that are not part of the standard CRUD lifecycle.
   *
   * @example
   * // PersonaManager emits activation/deactivation events
   * this.dispatcher.emit('element:activate', this.createEventPayload({...}));
   *
   * @returns The ElementEventDispatcher instance used by this manager
   */
  protected get dispatcher(): ElementEventDispatcher {
    return this.eventDispatcher;
  }

  // Cache configuration constants
  private static readonly MAX_ELEMENT_CACHE_SIZE = 1000;
  private static readonly MAX_PATH_CACHE_SIZE = 1000;

  /**
   * Constructor - initializes common dependencies
   * @param elementType - The type of element this manager handles
   * @param portfolioManager - Portfolio manager for directory resolution
   * @param fileLockManager - File lock manager for atomic operations
   * @param options - Configuration options including fileWatchService
   * @param fileOperationsService - Service for file operations
   * @param validationRegistry - Registry for obtaining type-specific validators
   */
  constructor(
    elementType: ElementType,
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    options: BaseElementManagerOptions = {},
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry
  ) {
    this.elementType = elementType;
    this.portfolioManager = portfolioManager;
    this.fileLockManager = fileLockManager;
    this.fileOperations = fileOperationsService;
    this.fileWatchService = options.fileWatchService;
    this.backupService = options.backupService;

    // Get the specialized validator for this element type
    this.validator = validationRegistry.getValidator(elementType);

    const elementCacheTTL = options.elementCacheTTL ?? DEFAULT_ELEMENT_CACHE_TTL_MS;
    const pathCacheTTL = options.pathCacheTTL ?? DEFAULT_PATH_CACHE_TTL_MS;
    this.memoryBudget = options.memoryBudget;

    const onSetCallback = this.memoryBudget
      ? () => this.memoryBudget!.enforce()
      : undefined;

    // Initialize LRU caches with size limits to prevent memory leaks
    this.elements = new LRUCache<T>({
      name: `elements:${elementType}`,
      maxSize: BaseElementManager.MAX_ELEMENT_CACHE_SIZE,
      maxMemoryMB: 50, // Max 50MB for element cache
      ttlMs: elementCacheTTL,
      onSet: onSetCallback,
    });

    this.filePathToId = new LRUCache<string>({
      name: `pathIndex:${elementType}`,
      maxSize: BaseElementManager.MAX_PATH_CACHE_SIZE,
      maxMemoryMB: 10, // Max 10MB for path mappings
      ttlMs: pathCacheTTL,
      onSet: onSetCallback,
    });

    // Register caches with global memory budget
    if (this.memoryBudget) {
      this.memoryBudget.register(this.elements);
      this.memoryBudget.register(this.filePathToId);
    }

    if (options.elementDirOverride) {
      this.elementDir = options.elementDirOverride;
    } else if (typeof (this.portfolioManager as any).getElementDir === 'function') {
      this.elementDir = (this.portfolioManager as any).getElementDir(elementType);
    } else {
      throw new Error(
        `Unable to resolve element directory for ${elementType}. ` +
        'Provide an elementDirOverride when instantiating this manager.'
      );
    }

    this.eventDispatcher = options.eventDispatcher ?? ElementEventDispatcher.getSharedDispatcher();
    this.autoReloadOnExternalChange =
      options.autoReloadOnExternalChange ?? process.env.AUTO_RELOAD_ON_EXTERNAL_CHANGE === 'true';

    const enableWatcher = options.enableFileWatcher ?? process.env.DOLLHOUSE_ENABLE_FILE_WATCHER === 'true';
    if (enableWatcher && this.fileWatchService) {
      this.watcherCleanup = this.fileWatchService.watchDirectory(
        this.elementDir,
        (relativePath) => this.handleExternalChange(relativePath)
      );
    }

    this.storageLayer = this.createStorageLayer(fileOperationsService);
  }

  /**
   * Factory method for creating the storage layer.
   * Default returns ElementStorageLayer for .md elements.
   * Subclasses (e.g. MemoryManager) can override to return a different implementation.
   */
  protected createStorageLayer(fileOperationsService: FileOperationsService): IStorageLayer {
    return new ElementStorageLayer(fileOperationsService, {
      elementDir: this.elementDir,
      fileExtension: this.getFileExtension(),
      scanCooldownMs: getValidatedScanCooldown(),
    });
  }

  /**
   * Returns the singular human-readable label for this element type (e.g., "skill", "persona").
   * Used in filename generation ({name}-{label}.md) and display strings.
   * Must return the singular form — not the plural ElementType value.
   */
  protected abstract getElementLabel(): string;

  /**
   * Returns a capitalized version of the element label.
   */
  protected getElementLabelCapitalized(): string {
    const label = this.getElementLabel();
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  /**
   * Load an element from file
   * TEMPLATE METHOD: Defines the algorithm, subclasses customize steps
   *
   * SECURITY FIXES (inherited from original managers):
   * - this.fileLockManager.atomicReadFile() prevents race conditions
   * - Path validation prevents traversal attacks
   * - Security event logging for audit trail
   */
  async load(filePath: string): Promise<T> {
    const { relativePath, absolutePath } = await this.normalizeAndValidatePath(filePath);
    const correlationId = randomUUID();

    this.eventDispatcher.emit(
      'element:load:start',
      this.createEventPayload({ correlationId, filePath: relativePath })
    );

    try {
      const content = await this.fileOperations.readElementFile(absolutePath, this.elementType, {
        source: `${this.constructor.name}.load`
      });
      // Issue #810: Pass element type as contentContext so SecureYamlParser exempts
      // legitimate patterns (e.g., <script> section tags in templates)
      const contentContext = BaseElementManager.ELEMENT_TYPE_TO_CONTEXT[this.elementType];
      if (!contentContext) {
        logger.debug(`[${this.constructor.name}] No contentContext mapping for elementType '${this.elementType}' — parsing without context exemptions. Available: ${Object.keys(BaseElementManager.ELEMENT_TYPE_TO_CONTEXT).join(', ')}`);
      }
      const parsed = SecureYamlParser.safeMatter(content, undefined, { contentContext });

      // Issue #695: Fill in missing metadata fields with sensible defaults
      // before parseMetadata() so older elements with sparse frontmatter
      // don't get rejected.
      this.migrateMetadataDefaults(parsed.data, relativePath);

      const metadata = await this.parseMetadata(parsed.data);
      const element = this.createElement(metadata, parsed.content);

      if (this.afterLoad) {
        await this.afterLoad(element, relativePath);
      }

      this.cacheElement(element, relativePath);

      // Issue #708: Clear any previous invalid record on successful load
      this.invalidElements.delete(relativePath);
      this.suppressedLoadPaths.delete(relativePath);

      logger.info(`${this.getElementLabelCapitalized()} loaded: ${element.metadata.name}`);

      this.eventDispatcher.emitAsync(
        'element:load:success',
        this.createEventPayload({ correlationId, filePath: relativePath, element })
      );

      return element;
    } catch (error) {
      // Issue #708: Record the failure so callers can distinguish
      // "file not found" from "file exists but failed validation".
      // Only track parse/validation errors — ENOENT means the file is genuinely
      // missing, not invalid, so we must not pollute the invalid map with it.
      const isFileNotFound = (error as NodeJS.ErrnoException).code === 'ENOENT';
      let isRepeatError = false;

      if (!isFileNotFound) {
        const reason = error instanceof Error ? error.message : String(error);
        const existing = this.invalidElements.get(relativePath);
        isRepeatError = existing?.reason === reason;

        this.invalidElements.set(relativePath, {
          filePath: relativePath,
          reason,
          failedAt: isRepeatError ? existing!.failedAt : new Date().toISOString(),
        });
      }

      if (isRepeatError) {
        this.suppressedLoadPaths.add(relativePath);
        logger.debug(`Suppressed repeated load error for ${this.getElementLabel()} ${relativePath}`);
      } else {
        this.suppressedLoadPaths.delete(relativePath);
        this.eventDispatcher.emitAsync(
          'element:load:error',
          this.createEventPayload({ correlationId, filePath: relativePath, error })
        );
        logger.error(`Failed to load ${this.getElementLabel()} from ${absolutePath}:`, error);
      }
      throw error;
    }
  }

  /**
   * Issue #695: Pre-fill missing metadata fields with sensible defaults
   * before parseMetadata() runs. This implements the "tolerant reader" pattern
   * — strict on output, lenient on input for older/sparse frontmatter.
   *
   * Mutates `data` in place. Logs a warning for each defaulted field so
   * operators know which files need updating.
   */
  private migrateMetadataDefaults(data: Record<string, unknown>, filePath: string): void {
    const migrated: string[] = [];

    // Infer type from this manager's element type
    if (!data.type) {
      // ElementType is plural ('personas', 'skills', etc.)
      // Some managers expect singular ('persona', 'agent'), some plural.
      // Set the plural form — parseMetadata() handles normalization.
      data.type = this.elementType;
      migrated.push('type');
    }

    // Infer name from filename (strip extension, un-slugify)
    if (!data.name) {
      const basename = path.basename(filePath, this.getFileExtension());
      data.name = basename;
      migrated.push('name');
    }

    // Default version
    if (!data.version) {
      data.version = '1.0.0';
      migrated.push('version');
    }

    // Default author
    if (!data.author) {
      data.author = 'unknown';
      migrated.push('author');
    }

    if (migrated.length > 0) {
      logger.warn(
        `[TolerantReader] ${this.getElementLabelCapitalized()} "${filePath}": ` +
        `defaulted missing fields: ${migrated.join(', ')}`
      );
    }
  }

  /**
   * Issue #708: Returns elements that exist on disk but failed validation during load.
   * Callers can use this to report invalid elements instead of silently hiding them.
   */
  getInvalidElements(): InvalidElementRecord[] {
    return [...this.invalidElements.values()];
  }

  /**
   * Issue #708: Check if a specific file failed validation during load.
   * Used by get_element to distinguish "not found" from "invalid".
   */
  getInvalidElement(name: string): InvalidElementRecord | undefined {
    // Check by exact path match and by name-based match
    for (const [filePath, record] of this.invalidElements) {
      if (filePath === name) return record;
      const basename = path.basename(filePath, this.getFileExtension());
      if (basename === name || this.normalizeFilename(basename) === this.normalizeFilename(name)) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * Save an element to file
   * TEMPLATE METHOD: Common save logic with hooks for customization
   *
   * SECURITY FIXES:
   * - this.fileLockManager.atomicWriteFile() for atomic operations
   * - Path validation to prevent traversal attacks
   * - Security event logging
   */
  async save(element: T, filePath: string): Promise<void> {
    const { relativePath, absolutePath } = await this.normalizeAndValidatePath(filePath);
    const correlationId = randomUUID();
    const transaction = new ElementTransactionScope(this.getElementLabel(), correlationId);

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_EDITED',
      severity: 'LOW',
      source: `${this.constructor.name}.save`,
      details: `Saving ${this.getElementLabel()}: ${element.metadata.name} v${element.metadata.version || 'unknown'}`,
      additionalData: {
        elementId: element.id,
        elementType: this.getElementLabel(),
        author: element.metadata.author,
        version: element.metadata.version,
      }
    });

    this.eventDispatcher.emit(
      'element:save:start',
      this.createEventPayload({ correlationId, filePath: relativePath, element })
    );

    transaction.addCommit(async () => {
      this.cacheElement(element, relativePath);
      await this.storageLayer.notifySaved(relativePath, absolutePath);
      this.eventDispatcher.emitAsync(
        'element:save:success',
        this.createEventPayload({ correlationId, filePath: relativePath, element })
      );
    });

    transaction.addRollback(async (error) => {
      this.eventDispatcher.emitAsync(
        'element:save:error',
        this.createEventPayload({ correlationId, filePath: relativePath, element, error })
      );
    });

    await transaction.run(async () => {
      if (this.beforeSave) {
        await this.beforeSave(element, relativePath);
      }

      await this.fileOperations.createDirectory(path.dirname(absolutePath));
      await this.createBackupBeforeSave(absolutePath);

      const content = await this.serializeElement(element);

      // Fix #908: Validate serialized content before writing (symmetric with read path).
      // Read path validates via SecureYamlParser.parse() → ContentValidator; write path
      // must apply the same checks to prevent saving content that would fail to load.
      this.validateSerializedContent(content);

      await this.fileOperations.writeFile(absolutePath, content, { encoding: 'utf-8' });

      if (this.afterSave) {
        await this.afterSave(element, relativePath);
      }
    });

    logger.info(`${this.getElementLabelCapitalized()} saved: ${element.metadata.name}`);
  }

  /**
   * Validate serialized element content before writing to disk.
   * Fix #908: Mirrors the read-path validation from SecureYamlParser.parse()
   * to ensure write → read symmetry. Content that fails this check would also
   * fail to load, so rejecting it on write prevents permanently broken elements.
   */
  private validateSerializedContent(content: string): void {
    const validateGatekeeperMetadata = (record: Record<string, unknown> | undefined, sourceLabel: string) => {
      const errors = getGatekeeperAuthoringErrors(record);
      if (errors.length > 0) {
        throw new Error(
          `Invalid gatekeeper policy in serialized ${this.getElementLabel()} ${sourceLabel}: ${[...new Set(errors)].join('; ')}`
        );
      }
    };

    // Extract frontmatter if present (SonarCloud S6594: use RegExp.exec)
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
    const frontmatterMatch = frontmatterRegex.exec(content);

    if (frontmatterMatch) {
      const yamlContent = frontmatterMatch[1];
      const bodyContent = content.substring(frontmatterMatch[0].length);

      // YAML bomb detection (mirrors SecureYamlParser.parse() step 4).
      // Only run when YAML is under MAX_YAML_LENGTH (64KB) — the same limit
      // used by the read path in SecureYamlParser.parse(). validateYamlContent()
      // includes its own size check internally, and we intentionally skip size
      // enforcement on the write path because the serializer may produce large
      // frontmatter for elements with long instructions. The read path will
      // reject oversized YAML on the next load if needed.
      if (yamlContent.length <= SECURITY_LIMITS.MAX_YAML_LENGTH) {
        if (!ContentValidator.validateYamlContent(yamlContent)) {
          SecurityMonitor.logSecurityEvent({
            type: 'YAML_INJECTION_ATTEMPT',
            severity: 'CRITICAL',
            source: `${this.constructor.name}.validateSerializedContent`,
            details: `Malicious YAML pattern detected in serialized output for ${this.getElementLabel()}`,
            metadata: { yamlLength: yamlContent.length }
          });
          throw new SecurityError(
            `Serialized ${this.getElementLabel()} contains malicious YAML patterns — write blocked. ` +
            `Review the element's metadata and instructions for suspicious anchor/alias patterns.`,
            'critical'
          );
        }
      }

      const frontmatterData = SecureYamlParser.parseRawYaml(yamlContent, SECURITY_LIMITS.MAX_YAML_LENGTH);
      validateGatekeeperMetadata(frontmatterData, 'frontmatter');

      // Body content validation with element type context
      const contentContext = BaseElementManager.ELEMENT_TYPE_TO_CONTEXT[this.elementType];
      const bodyValidation = ContentValidator.validateAndSanitize(bodyContent, {
        contentContext,
      });
      if (!bodyValidation.isValid && bodyValidation.severity === 'critical') {
        throw new SecurityError(
          `Critical security threat detected in serialized body content: ${bodyValidation.detectedPatterns?.join(', ')}`,
          'critical'
        );
      }
    } else if (this.elementType === ElementType.MEMORY) {
      const rawYaml = SecureYamlParser.parseRawYaml(content, SECURITY_LIMITS.MAX_YAML_LENGTH);
      validateGatekeeperMetadata(rawYaml, 'YAML root');
      if (rawYaml.metadata && typeof rawYaml.metadata === 'object' && !Array.isArray(rawYaml.metadata)) {
        validateGatekeeperMetadata(rawYaml.metadata as Record<string, unknown>, 'metadata');
      }
    }
  }

  /**
   * List all available elements
   * SECURITY: Uses PortfolioManager.listElements() which filters test elements
   */
  async list(): Promise<T[]> {
    try {
      // Ensure directory exists
      await this.fileOperations.createDirectory(this.elementDir);

      // Scan for changes — populates index for listSummaries()/findByName()
      // Non-fatal: scan failure must never prevent list() from returning results
      // Evict stale cache entries so the cache check below never returns outdated data
      try {
        const diff = await this.storageLayer.scan();
        for (const relPath of [...diff.modified, ...diff.removed]) {
          const absPath = path.join(this.elementDir, relPath);
          const existingId = this.filePathToId.get(absPath);
          if (existingId) {
            this.elements.delete(existingId);
            this.filePathToId.delete(absPath);
          }
        }
      } catch { /* index unavailable, list() continues without cache optimization */ }

      // Use PortfolioManager for authoritative file list + security filtering
      const files = await this.portfolioManager.listElements(this.elementType);

      // Load all elements in parallel, checking cache before disk
      const elements = await Promise.all(
        files.map(async (file) => {
          try {
            // Check cache first (avoids disk read if element is already loaded)
            const absolutePath = this.resolveAbsolutePath(file);
            const cached = this.getCachedElementByAbsolutePath(absolutePath);
            if (cached) return cached;
            // Cache miss — read from disk (populates cache for next time)
            return await this.load(file);
          } catch {
            // load() handles error logging with deduplication
            return null;
          }
        })
      );

      // Filter out failed loads and return
      return elements.filter((e): e is Awaited<T> => e !== null) as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const label = this.getElementLabelCapitalized();
        logger.debug(`${label}s directory does not exist yet, returning empty array`);
        return [];
      }
      logger.error(`Failed to list ${this.elementType}s:`, error);
      return [];
    }
  }

  /**
   * List lightweight metadata summaries without loading full elements.
   * Useful when only names/descriptions/tags are needed.
   */
  async listSummaries(): Promise<ElementIndexEntry[]> {
    await this.fileOperations.createDirectory(this.elementDir);
    return this.storageLayer.listSummaries();
  }

  /**
   * Find an element by predicate
   */
  async find(predicate: (element: T) => boolean): Promise<T | undefined> {
    const elements = await this.list();
    return elements.find(predicate);
  }

  /**
   * Find multiple elements by predicate
   */
  async findMany(predicate: (element: T) => boolean): Promise<T[]> {
    const elements = await this.list();
    return elements.filter(predicate);
  }

  /**
   * Find an element by name or ID without loading all elements
   *
   * Issue #24 (LOW PRIORITY): Performance optimization for activation flow
   *
   * This method provides an optimized lookup that tries cache first, then
   * attempts direct file access before falling back to full list() scan.
   * This is significantly faster than list() for large portfolios.
   *
   * PERFORMANCE IMPROVEMENTS:
   * 1. Cache lookup - O(1) if element was previously loaded
   * 2. Direct file access - O(1) for name-based lookups
   * 3. Full scan fallback - O(n) only if above methods fail
   *
   * @param identifier - Element name or ID to search for
   * @returns Element if found, undefined otherwise
   */
  async findByName(identifier: string): Promise<T | undefined> {
    // First, try finding in cache by iterating cached elements
    // This is fast (O(cache size)) and works for recently accessed elements
    const cachedElement = await this.findInCache(identifier);
    if (cachedElement) {
      return cachedElement;
    }

    // Second, try storage layer index (O(1) name lookup)
    const indexedPath = this.storageLayer.getPathByName(identifier);
    if (indexedPath) {
      try { return await this.load(indexedPath); } catch { /* fall through */ }
    }

    // Third, try direct file access using standard naming convention
    // Element files are typically named: lowercase-name-with-hyphens.{ext}
    // This is O(1) file system lookup
    const directLoadAttempt = await this.tryDirectLoad(identifier);
    if (directLoadAttempt) {
      return directLoadAttempt;
    }

    // If storage layer has completed at least one scan, the index is
    // authoritative — a miss means the element does not exist. Skip the
    // expensive list() fallback to avoid O(n) rescans on every cache miss.
    if (this.storageLayer.hasCompletedScan()) {
      return undefined;
    }

    // Fallback: Full list() scan (O(n) - loads all elements)
    // Only used on first access before any scan has completed.
    // This ensures we find elements even with non-standard file naming.
    const elements = await this.list();
    const normalizedIdentifier = this.normalizeFilename(identifier);
    return elements.find(e =>
      this.normalizeFilename(e.metadata.name) === normalizedIdentifier ||
      e.metadata.name.toLowerCase() === identifier.toLowerCase() ||
      e.id === identifier
    );
  }

  /**
   * Helper: Search cache for element by name or ID
   * @private
   */
  private async findInCache(identifier: string): Promise<T | undefined> {
    // LRUCache doesn't provide iteration, but we can check if we have
    // a cached path for this identifier by trying common naming patterns.
    // IMPORTANT: filePathToId stores absolute paths (set by cacheElement via
    // resolveAbsolutePath), so we must resolve to absolute before lookup.
    const possibleFilenames = [
      identifier,
      `${identifier}${this.getFileExtension()}`,
      // Use unified normalizeFilename for consistent cache lookups
      this.getElementFilename(identifier)
    ];

    for (const filename of possibleFilenames) {
      const absolutePath = this.resolveAbsolutePath(filename);
      const cachedId = this.filePathToId.get(absolutePath);
      if (cachedId) {
        const element = this.elements.get(cachedId);
        if (element) {
          return element;
        }
      }
    }

    return undefined;
  }

  /**
   * Helper: Try loading element directly by constructing expected filename
   * @private
   */
  private async tryDirectLoad(identifier: string): Promise<T | undefined> {
    // Try loading using common naming patterns
    // Use unified normalizeFilename for consistent filename construction
    const possiblePaths = [
      // Primary: Use unified normalization (handles CamelCase, spaces, underscores, etc.)
      this.getElementFilename(identifier),
      // Fallback: Identifier as-is with extension
      `${identifier}${this.getFileExtension()}`,
      // Fallback: Identifier already includes extension
      identifier
    ];

    for (const filePath of possiblePaths) {
      try {
        const element = await this.load(filePath);
        // Verify the loaded element matches the identifier
        // Normalize both sides so "Code Review" (spaces) matches "code-review" (hyphens)
        const normalizedMetaName = this.normalizeFilename(element.metadata.name);
        const normalizedIdentifier = this.normalizeFilename(identifier);
        if (normalizedMetaName === normalizedIdentifier ||
            element.metadata.name.toLowerCase() === identifier.toLowerCase() ||
            element.id === identifier) {
          return element;
        }
      } catch (_error) {
        // File doesn't exist or failed to load - try next path
        continue;
      }
    }

    return undefined;
  }

  /**
   * Validate an element
   * Delegates to element's own validate method
   *
   * @returns Validation result with both 'valid' and 'isValid' properties.
   *          'isValid' is deprecated - use 'valid' for new code.
   */
  validate(element: T): ElementValidationResult {
    const result = element.validate();
    return result;
  }

  /**
   * Delete an element
   * SECURITY: Path validation to prevent deletion outside directory
   * CACHE FIX: Uses filepath-based cache removal to prevent stale entries
   */
  async delete(filePath: string): Promise<void> {
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_DELETED',
      severity: 'MEDIUM',
      source: `${this.constructor.name}.delete`,
      details: `Attempting to delete ${this.getElementLabel()}: ${filePath}`
    });

    const { relativePath, absolutePath } = await this.normalizeAndValidatePath(filePath);
    const correlationId = randomUUID();
    const transaction = new ElementTransactionScope(this.getElementLabel(), correlationId);

    this.eventDispatcher.emit(
      'element:delete:start',
      this.createEventPayload({ correlationId, filePath: relativePath })
    );

    transaction.addCommit(async () => {
      this.uncacheByPath(relativePath);
      this.storageLayer.notifyDeleted(relativePath);
      this.eventDispatcher.emitAsync(
        'element:delete:success',
        this.createEventPayload({ correlationId, filePath: relativePath })
      );
    });

    transaction.addRollback(async (error) => {
      this.eventDispatcher.emitAsync(
        'element:delete:error',
        this.createEventPayload({ correlationId, filePath: relativePath, error })
      );
    });

    await transaction.run(async () => {
      if (this.canDelete) {
        const elementForValidation = await this.loadElementSnapshot(absolutePath, relativePath);
        const decision = await this.canDelete(elementForValidation);
        if (!decision.allowed) {
          throw new Error(decision.reason ?? `Deletion not permitted for ${this.getElementLabel()}`);
        }
      }

      const movedToBackup = await this.createBackupBeforeDelete(absolutePath);
      if (!movedToBackup) {
        await this.fileOperations.deleteFile(absolutePath, this.elementType, {
          source: `${this.constructor.name}.delete`
        });
      }
    });

    logger.info(`${this.getElementLabelCapitalized()} deleted: ${filePath}`);
  }

  /**
   * Check if an element exists
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      const { absolutePath } = await this.normalizeAndValidatePath(filePath);
      return await this.fileOperations.exists(absolutePath);
    } catch {
      return false;
    }
  }

  /**
   * Validate a file path
   */
  validatePath(filePath: string): boolean {
    try {
      const sanitized = sanitizeInput(filePath, 255);

      if (!sanitized || path.isAbsolute(sanitized)) {
        return false;
      }

      if (sanitized.includes('..')) {
        return false;
      }

      const ext = path.extname(sanitized).toLowerCase();
      const allowedExtensions = ['.md', '.markdown', '.txt', '.yml', '.yaml'];

      return ext === '' || allowedExtensions.includes(ext);
    } catch {
      return false;
    }
  }

  /**
   * Get the element type
   */
  getElementType(): ElementType {
    return this.elementType;
  }

  /**
   * Resolves a file path to its absolute form for cache consistency
   * Ensures consistent path handling across relative/absolute paths
   */
  protected resolveAbsolutePath(filePath: string): string {
    return path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.normalize(path.join(this.elementDir, filePath));
  }

  private async normalizeAndValidatePath(filePath: string): Promise<{ relativePath: string; absolutePath: string }> {
    const sanitizedPath = sanitizeInput(filePath, 255);

    if (!sanitizedPath || sanitizedPath.trim().length === 0 || sanitizedPath === '.' || sanitizedPath === path.sep) {
      throw new Error(`Invalid ${this.getElementLabel()} path: empty path is not allowed`);
    }

    if (path.isAbsolute(sanitizedPath)) {
      throw new Error(`Absolute ${this.getElementLabel()} paths are not allowed`);
    }

    // Normalize the path (remove redundant separators, resolve . and ..)
    const normalizedRelative = path.normalize(sanitizedPath);

    // Build absolute path
    const absolutePath = path.join(this.elementDir, normalizedRelative);

    try {
      // Validate WITHOUT resolving symlinks - just check security constraints
      await PathValidator.validateElementPathOnly(absolutePath, this.elementDir);

      // Return the input as relativePath (it's already relative) and computed absolutePath
      return { relativePath: normalizedRelative, absolutePath };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid path';
      throw new Error(`Invalid ${this.getElementLabel()} path: ${reason}`);
    }
  }

  private getCachedElementByAbsolutePath(absolutePath: string): T | undefined {
    const elementId = this.filePathToId.get(this.resolveAbsolutePath(absolutePath));
    if (!elementId) {
      return undefined;
    }
    return this.elements.get(elementId);
  }

  /**
   * Protected cache lookup by absolute path.
   * Allows subclasses with custom load() overrides (e.g. MemoryManager)
   * to check the LRU cache before re-reading from disk.
   */
  protected getCachedByAbsolutePath(absolutePath: string): T | undefined {
    return this.getCachedElementByAbsolutePath(absolutePath);
  }

  private async loadElementSnapshot(absolutePath: string, relativePath: string): Promise<T> {
    const cached = this.getCachedElementByAbsolutePath(absolutePath);
    if (cached) {
      return cached;
    }

    const raw = await this.fileOperations.readElementFile(absolutePath, this.elementType, {
      source: `${this.constructor.name}.loadElementSnapshot`
    });
    const parsed = SecureYamlParser.safeMatter(raw, undefined, {
      contentContext: BaseElementManager.ELEMENT_TYPE_TO_CONTEXT[this.elementType],
    });
    const metadata = await this.parseMetadata(parsed.data);
    const element = this.createElement(metadata, parsed.content);
    this.cacheElement(element, relativePath);
    return element;
  }

  /**
   * Creates a standardized event payload for element lifecycle events.
   *
   * This helper is available to subclasses to ensure consistent event payload
   * structure when emitting custom events via the dispatcher getter.
   *
   * @param params - Event parameters including correlation ID, element, file path, and optional error
   * @returns Fully-formed ElementEventPayload ready for emission
   */
  protected createEventPayload(params: {
    correlationId: string;
    filePath?: string;
    element?: T;
    error?: unknown;
  }): ElementEventPayload {
    const elementId = params.element?.id;
    const generation = elementId !== undefined ? this.elementGenerations.get(elementId) : undefined;
    return {
      correlationId: params.correlationId,
      elementType: this.elementType,
      elementId,
      filePath: params.filePath,
      metadata: ElementEventDispatcher.snapshotMetadata(params.element),
      generation,
      error: params.error
    };
  }

  private handleExternalChange(relativePath: string): void {
    this.uncacheByPath(relativePath);
    this.storageLayer.invalidate();
    // Clear error suppression so a changed file gets fresh logging
    this.invalidElements.delete(relativePath);
    this.suppressedLoadPaths.delete(relativePath);
    const correlationId = randomUUID();
    this.eventDispatcher.emitAsync(
      'element:external-change',
      this.createEventPayload({ correlationId, filePath: relativePath })
    );

    if (this.autoReloadOnExternalChange) {
      void this.load(relativePath).catch((error) => {
        logger.warn('Auto reload after external change failed', {
          elementType: this.elementType,
          filePath: relativePath,
          error: error instanceof Error ? error.message : error
        });
      });
    }
  }


  /**
   * Adds an element to both caches (bidirectional mapping)
   * @param element - Element to cache
   * @param filePath - File path (relative or absolute)
   */
  protected cacheElement(element: T, filePath: string): void {
    const absolutePath = this.resolveAbsolutePath(filePath);

    // Clear any stale cache entries for this filepath before adding the new one.
    // This is necessary because generateId() in BaseElement.ts includes a Date.now()
    // timestamp, causing each load from disk to generate a different ID. Without this
    // cleanup, old IDs remain in the cache as stale data, leading to inconsistent
    // results in methods like findPersona() or list().
    const existingId = this.filePathToId.get(absolutePath);
    if (existingId && existingId !== element.id) {
      // Clear stale cache entry when element ID has changed
      this.elements.delete(existingId);
      this.elementGenerations.delete(existingId);
    }

    this.elements.set(element.id, element);
    this.filePathToId.set(absolutePath, element.id);
    const generation = ++this.cacheGenerationCounter;
    this.elementGenerations.set(element.id, generation);

    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.elementDir, filePath)
      : filePath;

    try {
      Object.defineProperty(element, 'filename', {
        value: path.basename(relativePath),
        writable: true,
        enumerable: true,
        configurable: true
      });

      Object.defineProperty(element, 'filePath', {
        value: relativePath,
        writable: true,
        enumerable: true,
        configurable: true
      });
    } catch (error) {
      logger.debug('Failed to attach filename metadata to element', {
        error: error instanceof Error ? error.message : String(error),
        elementId: element.id,
        filePath: relativePath
      });
    }
  }

  /**
   * Force a fresh disk scan and evict any modified/removed entries from the
   * in-memory LRU cache. Call before findByName() when freshness is critical
   * (e.g. on ensemble activation) to pick up external file changes that
   * occurred since the last scan, even if the scan cooldown is still active.
   *
   * Unlike list(), this does not load all elements — it only evicts stale ones.
   * Fixes #1895 (ensemble activation serving stale cached element list).
   */
  protected async scanAndEvict(): Promise<void> {
    this.storageLayer.invalidate(); // bypass cooldown so the next scan hits disk
    try {
      const diff = await this.storageLayer.scan();
      for (const relPath of [...diff.modified, ...diff.removed]) {
        const absPath = path.join(this.elementDir, relPath);
        const existingId = this.filePathToId.get(absPath);
        if (existingId) {
          this.elements.delete(existingId);
          this.filePathToId.delete(absPath);
          this.elementGenerations.delete(existingId);
        }
      }
    } catch { /* non-fatal — cache may be slightly stale, but activation proceeds */ }
  }

  /**
   * Removes an element from both caches by file path
   * This is the preferred method for deletion to avoid stale cache entries
   * @param filePath - File path (relative or absolute)
   */
  protected uncacheByPath(filePath: string): void {
    const absolutePath = this.resolveAbsolutePath(filePath);
    const elementId = this.filePathToId.get(absolutePath);

    if (elementId !== undefined) {
      this.elements.delete(elementId);
      this.filePathToId.delete(absolutePath);
      this.elementGenerations.delete(elementId);
      logger.debug(`Uncached element ${elementId} from ${absolutePath}`);
    }
  }

  /**
   * Clear all cached elements
   */
  clearCache(): void {
    this.elements.clear();
    this.filePathToId.clear();
    this.elementGenerations.clear();
    this.storageLayer.clear();
    this.suppressedLoadPaths.clear();
  }

  /**
   * Get cache statistics for debugging
   * @returns Object with cache size metrics
   */
  protected getCacheStats(): { elementCount: number; pathMappings: number } {
    const elementsStats = this.elements.getStats();
    const pathStats = this.filePathToId.getStats();

    return {
      elementCount: elementsStats.size,
      pathMappings: pathStats.size
    };
  }

  /**
   * Expose internal LRU cache instances for metrics collection.
   */
  public getMetricsCaches(): Array<{ name: string; instance: LRUCache<unknown> }> {
    return [
      { name: `elements:${this.elementType}`, instance: this.elements as LRUCache<unknown> },
      { name: `pathIndex:${this.elementType}`, instance: this.filePathToId as LRUCache<unknown> },
    ];
  }

  /**
   * Dispose of resources and cleanup
   * Subclasses should override to add their own cleanup logic
   */
  public dispose(): void {
    if (this.memoryBudget) {
      this.memoryBudget.unregister(this.elements);
      this.memoryBudget.unregister(this.filePathToId);
    }
    this.elements.clear();
    this.filePathToId.clear();
    this.elementGenerations.clear();
    this.storageLayer.clear();
    this.watcherCleanup?.();
    this.watcherCleanup = undefined;
    logger.debug(`${this.getElementLabelCapitalized()}Manager disposed and caches cleared`);
  }

  // ============================================
  // FILENAME NORMALIZATION METHODS
  // ============================================

  /**
   * Normalize a name to kebab-case for consistent filename formatting.
   *
   * This method provides unified filename normalization across all element managers,
   * ensuring consistent naming regardless of the input format (CamelCase, spaces,
   * underscores, mixed case, etc.).
   *
   * Transformations applied (in order):
   * 1. Insert hyphens between camelCase boundaries (MyName -> My-Name)
   * 2. Replace spaces and underscores with hyphens
   * 3. Convert to lowercase
   * 4. Strip invalid characters (keep only a-z, 0-9, -)
   * 5. Collapse multiple consecutive hyphens
   * 6. Trim leading/trailing hyphens
   *
   * @example
   * normalizeFilename("CRUDV-Agent-Delta") // "crudv-agent-delta"
   * normalizeFilename("Creative Writer")   // "creative-writer"
   * normalizeFilename("CamelCaseName")     // "camel-case-name"
   * normalizeFilename("my_skill_name")     // "my-skill-name"
   * normalizeFilename("Special@Chars!")    // "special-chars"
   * normalizeFilename("--leading-and-trailing--") // "leading-and-trailing"
   *
   * @param name - The element name to normalize
   * @returns Normalized kebab-case filename (without extension)
   */
  protected normalizeFilename(name: string): string {
    if (!name || name.trim().length === 0) {
      return 'unnamed';
    }

    return name
      // Step 1: Insert hyphens between camelCase boundaries (lowercase followed by uppercase)
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      // Step 2: Replace spaces and underscores with hyphens
      .replace(/[\s_]+/g, '-')
      // Step 3: Convert to lowercase
      .toLowerCase()
      // Step 4: Strip invalid characters (keep only alphanumeric and hyphens)
      .replace(/[^a-z0-9-]/g, '-')
      // Step 5: Collapse multiple consecutive hyphens
      .replace(/-+/g, '-')
      // Step 6: Trim leading and trailing hyphens
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Get the standardized filename for an element.
   *
   * Normalizes the element name (handling CamelCase, spaces, underscores, etc.)
   * and appends the file extension. The directory structure (personas/, skills/, etc.)
   * already provides type context, so the type is NOT included in the filename.
   *
   * @param name - The element name to convert to a filename
   * @returns The standardized filename (e.g., "code-review.md")
   *
   * @example
   * getElementFilename("Code Review")         // → "code-review.md"
   * getElementFilename("Debug Detective")     // → "debug-detective.md"
   * getElementFilename("BugReport")           // → "bug-report.md" (CamelCase split)
   * getElementFilename("fix-persona-helper")  // → "fix-persona-helper.md" (no mangling)
   */
  protected getElementFilename(name: string): string {
    const normalizedName = this.normalizeFilename(name) || 'unnamed';
    const extension = this.getFileExtension();
    return `${normalizedName}${extension}`;
  }


  // ============================================
  // ABSTRACT METHODS - Subclasses must implement
  // ============================================

  /**
   * Parse and validate metadata from frontmatter
   * Subclasses implement element-specific validation logic
   *
   * @param data - Raw metadata from YAML frontmatter
   * @returns Validated and typed metadata
   */
  protected abstract parseMetadata(data: any): Promise<T['metadata']>;

  /**
   * @deprecated Use ElementValidator via ValidationRegistry instead.
   * Will be removed in next major version.
   */
  async validateMetadata(metadata: any, _strict?: boolean): Promise<import('../../utils/validation/FieldValidator.js').ValidationError[]> {
    const result = await this.validator.validateMetadata(metadata);
    return result.errors.map(e => ({ field: 'general', message: e }));
  }

  /**
   * Create an element instance from metadata and content
   * Subclasses implement element-specific construction
   *
   * @param metadata - Validated metadata
   * @param content - Element content (instructions, template, etc.)
   * @returns New element instance
   */
  protected abstract createElement(metadata: T['metadata'], content: string): T;

  /**
   * Serialize an element to file content
   * Subclasses can customize serialization format
   *
   * @param element - Element to serialize
   * @returns File content (usually markdown with frontmatter)
   */
  protected abstract serializeElement(element: T): Promise<string>;

  /**
   * Get the file extension for this element type
   * Most elements use .md, but subclasses can override
   */
  abstract getFileExtension(): string;

  /**
   * Import an element from external format
   * Subclasses implement format-specific import logic
   */
  abstract importElement(data: string, format?: 'json' | 'yaml' | 'markdown'): Promise<T>;

  /**
   * Export an element to external format
   * Subclasses implement format-specific export logic
   */
  abstract exportElement(element: T, format?: 'json' | 'yaml' | 'markdown'): Promise<string>;
}
