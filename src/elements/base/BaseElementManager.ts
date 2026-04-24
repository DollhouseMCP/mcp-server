/**
 * BaseElementManager - Abstract base class for all element managers
 *
 * Provides common CRUD operations for all element types using the
 * Template Method Pattern:
 * - Defines the skeleton of operations in base class
 * - Lets subclasses override specific steps without changing structure
 *
 * Subclasses: PersonaManager, SkillManager, TemplateManager, AgentManager,
 *             MemoryManager, EnsembleManager
 *
 * Orchestrator-only: all method bodies have been extracted into six focused
 * services (ElementCache, ElementEventCoordinator, ElementLoader,
 * ElementPersister, ElementListOperations, ElementResolver). BaseElementManager
 * constructs those services, wires them together via host interfaces, and
 * delegates every public/protected method to the appropriate service.
 *
 * SECURITY:
 * 1. CRITICAL: Uses FileLockManager for atomic read/write operations
 * 2. HIGH: Path validation and sanitization to prevent traversal attacks
 * 3. MEDIUM: Security event logging for audit trail
 * 4. MEDIUM: Input validation and sanitization throughout
 */

import { IElementManager } from '../../types/elements/IElementManager.js';
import { IElement, ElementValidationResult } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { logger } from '../../utils/logger.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { LRUCache } from '../../cache/LRUCache.js';
import * as path from 'path';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { PathValidator } from '../../security/pathValidator.js';
import { ElementEventDispatcher, ElementEventPayload } from '../../events/ElementEventDispatcher.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import { type ElementValidator } from '../../services/validation/ElementValidator.js';
import { type IStorageLayer, isWritableStorageLayer } from '../../storage/IStorageLayer.js';
import type { IStorageLayerFactory } from '../../storage/IStorageLayerFactory.js';
import type { ElementIndexEntry } from '../../storage/types.js';
import {
  getValidatedScanCooldown,
  getValidatedElementCacheTTL,
  getValidatedPathCacheTTL
} from '../../config/performance-constants.js';
import type { CacheMemoryBudget } from '../../cache/CacheMemoryBudget.js';
import type { BackupService } from '../../services/BackupService.js';
import type { SerializationService } from '../../services/SerializationService.js';
import type { MetadataService } from '../../services/MetadataService.js';

// Composed services
import { ElementCache } from './ElementCache.js';
import { ElementEventCoordinator } from './ElementEventCoordinator.js';
import { ElementLoader } from './ElementLoader.js';
import { ElementPersister } from './ElementPersister.js';
import { ElementListOperations } from './ElementListOperations.js';
import { ElementResolver } from './ElementResolver.js';

const DEFAULT_ELEMENT_CACHE_TTL_MS = getValidatedElementCacheTTL();
const DEFAULT_PATH_CACHE_TTL_MS = getValidatedPathCacheTTL();

export interface BaseElementManagerOptions {
  elementDirOverride?: string;
  eventDispatcher: ElementEventDispatcher;
  elementCacheTTL?: number;
  pathCacheTTL?: number;
  enableFileWatcher?: boolean;
  autoReloadOnExternalChange?: boolean;
  fileWatchService?: FileWatchService;
  memoryBudget?: CacheMemoryBudget;
  backupService?: BackupService;
  /** Issue #1946: ContextTracker for session-scoped activation state resolution */
  contextTracker?: import('../../security/encryption/ContextTracker.js').ContextTracker;
  /** Issue #1946: Registry for per-session activation state */
  activationRegistry?: import('../../state/SessionActivationState.js').SessionActivationRegistry;
  /**
   * Phase 4: Per-call resolver returning the current user's UUID. Used
   * by listFromDatabase() for cache hygiene (evicting foreign rows from
   * the per-user cache when includePublic is active). Resolves from
   * ContextTracker's session context. Undefined in file-only mode.
   */
  getCurrentUserId?: import('../../database/UserContext.js').UserIdResolver;
  /**
   * Phase 4: Storage-agnostic factory. Creates the correct storage layer
   * for this element type (file-backed or DB-backed) based on the active
   * deployment mode. Injected by DI; callers never import or reference
   * a specific backend.
   *
   */
  storageLayerFactory: IStorageLayerFactory;
  /** Step 4.6: File-mode shared-pool discovery for include_public. */
  publicElementDiscovery?: import('../../collection/shared-pool/PublicElementDiscovery.js').PublicElementDiscovery;
}

/**
 * Standard dependency injection interface for element managers.
 * Replaces positional constructor parameters with a single typed object.
 * Required and optional deps coexist naturally without parameter ordering issues.
 */
export interface ElementManagerDeps {
  portfolioManager: PortfolioManager;
  fileLockManager: FileLockManager;
  fileOperationsService: FileOperationsService;
  validationRegistry: ValidationRegistry;
  serializationService: SerializationService;
  metadataService: MetadataService;
  eventDispatcher: ElementEventDispatcher;
  fileWatchService?: FileWatchService;
  memoryBudget?: CacheMemoryBudget;
  backupService?: BackupService;
  /** Issue #1946: ContextTracker for session-scoped activation state resolution */
  contextTracker?: import('../../security/encryption/ContextTracker.js').ContextTracker;
  /** Issue #1946: Registry for per-session activation state */
  activationRegistry?: import('../../state/SessionActivationState.js').SessionActivationRegistry;
  /** Phase 4: Per-call user UUID resolver. See BaseElementManagerOptions. */
  getCurrentUserId?: import('../../database/UserContext.js').UserIdResolver;
  /** Phase 4: Storage-agnostic factory. See BaseElementManagerOptions. */
  storageLayerFactory: IStorageLayerFactory;
  /** Step 4.6: File-mode shared-pool discovery for include_public. */
  publicElementDiscovery?: import('../../collection/shared-pool/PublicElementDiscovery.js').PublicElementDiscovery;
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

/** Map plural ElementType enum values to singular ContentValidator context. */
const ELEMENT_TYPE_TO_CONTEXT: Partial<Record<ElementType, 'persona' | 'skill' | 'template' | 'agent' | 'memory'>> = {
  [ElementType.PERSONA]: 'persona',
  [ElementType.SKILL]: 'skill',
  [ElementType.TEMPLATE]: 'template',
  [ElementType.AGENT]: 'agent',
  [ElementType.MEMORY]: 'memory',
};

/**
 * Abstract base class implementing common element management operations.
 * Subclasses must implement element-specific logic via abstract methods.
 *
 * All method bodies are delegated to composed service objects; this class
 * serves as the wiring layer and preserves the public/protected API that
 * subclasses and callers depend on.
 */
export abstract class BaseElementManager<T extends IElement> implements IElementManager<T> {
  protected portfolioManager: PortfolioManager;
  protected fileLockManager: FileLockManager;
  protected fileOperations: FileOperationsService;
  protected fileWatchService?: FileWatchService;
  protected elementDir: string;

  /** Specialized validator for this element type. */
  protected validator: ElementValidator;

  /**
   * Expose the primary element LRU cache so subclasses can read it if needed.
   * Delegates to ElementCache.elements.
   */
  protected get elements(): LRUCache<T> {
    return this._cache.elements;
  }

  protected readonly elementType: ElementType;
  protected readonly backupService?: BackupService;

  /** Issue #1946: ContextTracker for session-scoped activation state */
  protected readonly contextTracker?: import('../../security/encryption/ContextTracker.js').ContextTracker;
  /** Issue #1946: Registry for per-session activation state */
  protected readonly activationRegistry?: import('../../state/SessionActivationState.js').SessionActivationRegistry;
  /** Phase 4: Per-call user UUID resolver. */
  protected readonly getCurrentUserId?: import('../../database/UserContext.js').UserIdResolver;
  /** Phase 4: Storage-agnostic factory for creating the storage layer. */
  protected readonly storageLayerFactory: IStorageLayerFactory;
  /** Step 4.6: File-mode shared-pool discovery for include_public. */
  protected readonly publicElementDiscovery?: import('../../collection/shared-pool/PublicElementDiscovery.js').PublicElementDiscovery;

  protected readonly storageLayer: IStorageLayer;

  // ── Composed services ────────────────────────────────────────────────────
  private readonly _cache: ElementCache<T>;
  private readonly _events: ElementEventCoordinator<T>;
  private readonly _loader: ElementLoader<T>;
  private readonly _persister: ElementPersister<T>;
  private readonly _listOps: ElementListOperations<T>;
  private readonly _resolver: ElementResolver<T>;

  // Hook declarations — subclasses can declare these to override behaviour.
  // These remain protected. The host adapter objects in the constructor forward
  // calls to them through arrow functions that have access to the protected scope.
  protected afterLoad?(
    element: T,
    filePath: string,
    parsedData?: { data: Record<string, unknown>; content: string },
  ): Promise<void>;
  protected beforeSave?(element: T, filePath: string): Promise<void>;
  protected afterSave?(element: T, filePath: string): Promise<void>;
  /**
   * Post-delete hook. Called AFTER the underlying persistence (disk or DB)
   * has successfully removed the element, but BEFORE the ElementTransactionScope
   * commit callback emits `element:delete:success`.
   *
   * Note: in DB mode the storage layer's own transaction has already committed
   * by the time this hook runs — a throw here CANNOT undo the DB delete, it
   * only triggers the scope's rollback callbacks (which emit an error event).
   * In file mode the unlink is similarly already done. Use this hook for
   * post-persistence work like emitting element-type-specific audit events
   * (e.g. `MEMORY_DELETED`) or clearing sidecar caches — not for anything that
   * assumes the underlying delete can be undone.
   */
  protected afterDelete?(filePath: string): Promise<void>;
  protected findByIdentifier?(identifier: string): Promise<T | undefined>;
  protected canDelete?(element: T): Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Error hooks — called from the base-class load/save/delete catch blocks
   * before the exception is re-thrown. Subclasses override these to emit
   * element-type-specific audit events WITHOUT having to wrap the entire
   * super-call in their own try/catch (which double-emits the base's
   * element:*:error event). The hook itself must not throw.
   */
  protected onLoadError?(filePath: string, error: unknown): void;
  protected onSaveError?(element: T, filePath: string, error: unknown): void;

  private _activationFallbackWarned = false;

  constructor(
    elementType: ElementType,
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    options: BaseElementManagerOptions,
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry
  ) {
    this.elementType = elementType;
    this.portfolioManager = portfolioManager;
    this.fileLockManager = fileLockManager;
    this.fileOperations = fileOperationsService;
    this.fileWatchService = options.fileWatchService;
    this.backupService = options.backupService;
    this.contextTracker = options.contextTracker;
    this.activationRegistry = options.activationRegistry;
    this.getCurrentUserId = options.getCurrentUserId;
    this.storageLayerFactory = options.storageLayerFactory;
    this.publicElementDiscovery = options.publicElementDiscovery;

    this.validator = validationRegistry.getValidator(elementType);

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

    this.storageLayer = this.createStorageLayer();

    // ── Host adapter objects ──────────────────────────────────────────────
    // Each service receives a plain object that forwards calls back into `this`.
    // Using adapters instead of passing `this` directly lets the services access
    // protected/abstract methods without requiring those methods to be public on
    // the base class (which would force subclass overrides to widen visibility too).
    //
    // Arrow functions capture `this` at construction time; late binding of abstract
    // methods (parseContent, parseMetadata, createElement, etc.) is preserved because
    // `this` always refers to the concrete subclass instance.

    const cacheHost = {
      resolveAbsolutePath: (fp: string) => this.resolveAbsolutePath(fp),
      get elementDir() { return self.elementDir; },
    };
    // `self` alias needed for the getter closure — `this` in class body is fine here:
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // ── Build ElementCache ────────────────────────────────────────────────
    this._cache = new ElementCache<T>(elementType, cacheHost, {
      elementCacheTTL: options.elementCacheTTL ?? DEFAULT_ELEMENT_CACHE_TTL_MS,
      pathCacheTTL: options.pathCacheTTL ?? DEFAULT_PATH_CACHE_TTL_MS,
      memoryBudget: options.memoryBudget,
    });

    const eventCoordinatorHost = {
      get elementDir() { return self.elementDir; },
      get elementType() { return self.elementType; },
      load: (fp: string) => this.load(fp),
      getElementLabel: () => this.getElementLabel(),
    };

    // ── Build ElementEventCoordinator ────────────────────────────────────
    const enableWatcher = options.enableFileWatcher ?? process.env.DOLLHOUSE_ENABLE_FILE_WATCHER === 'true';
    this._events = new ElementEventCoordinator<T>(
      options.eventDispatcher,
      options.autoReloadOnExternalChange ?? process.env.AUTO_RELOAD_ON_EXTERNAL_CHANGE === 'true',
      eventCoordinatorHost,
      this._cache,
      this.storageLayer,
      enableWatcher ? this.fileWatchService : undefined,
      this.elementDir,
    );

    const loaderHost = {
      get elementType() { return self.elementType; },
      get elementDir() { return self.elementDir; },
      parseContent: (c: string) => this.parseContent(c),
      migrateMetadataDefaults: (d: Record<string, unknown>, fp: string) => this.migrateMetadataDefaults(d, fp),
      parseMetadata: (d: any) => this.parseMetadata(d),
      createElement: (m: T['metadata'], c: string) => this.createElement(m, c),
      afterLoad: (el: T, fp: string, pd?: { data: Record<string, unknown>; content: string }) =>
        this.afterLoad ? this.afterLoad(el, fp, pd) : Promise.resolve(),
      onLoadError: (fp: string, err: unknown) => this.onLoadError?.(fp, err),
      getElementLabel: () => this.getElementLabel(),
      getElementLabelCapitalized: () => this.getElementLabelCapitalized(),
      normalizeAndValidatePath: (fp: string) => this.normalizeAndValidatePath(fp),
      get constructor() { return self.constructor as { name: string }; },
    };

    // ── Build ElementLoader ───────────────────────────────────────────────
    this._loader = new ElementLoader<T>(
      loaderHost,
      this._cache,
      this._events,
      this.fileOperations,
      this.storageLayer,
      ELEMENT_TYPE_TO_CONTEXT,
    );

    const persisterHost = {
      get elementType() { return self.elementType; },
      serializeElement: (el: T) => this.serializeElement(el),
      validateSerializedContent: (c: string) => this.validateSerializedContent(c),
      beforeSave: (el: T, fp: string) => this.beforeSave ? this.beforeSave(el, fp) : Promise.resolve(),
      afterSave: (el: T, fp: string) => this.afterSave ? this.afterSave(el, fp) : Promise.resolve(),
      afterDelete: (fp: string) => this.afterDelete ? this.afterDelete(fp) : Promise.resolve(),
      // Always dispatch dynamically so tests or subclasses can assign canDelete
      // after construction (e.g. via (manager as any).canDelete = jest.fn(...)).
      canDelete: (el: T) => this.canDelete ? this.canDelete(el) : Promise.resolve({ allowed: true }),
      onSaveError: (el: T, fp: string, err: unknown) => this.onSaveError?.(el, fp, err),
      createBackupBeforeSave: (ap: string) => this.createBackupBeforeSave(ap),
      createBackupBeforeDelete: (ap: string) => this.createBackupBeforeDelete(ap),
      getElementLabel: () => this.getElementLabel(),
      getElementLabelCapitalized: () => this.getElementLabelCapitalized(),
      extractNameFromPath: (rp: string) => this.extractNameFromPath(rp),
      normalizeAndValidatePath: (fp: string) => this.normalizeAndValidatePath(fp),
      get constructor() { return self.constructor as { name: string }; },
    };

    // ── Build ElementPersister ────────────────────────────────────────────
    this._persister = new ElementPersister<T>(
      persisterHost,
      this._cache,
      this._events,
      this._loader,
      this.fileLockManager,
      this.fileOperations,
      this.storageLayer,
      ELEMENT_TYPE_TO_CONTEXT,
    );

    const listHost = {
      get elementType() { return self.elementType; },
      get elementDir() { return self.elementDir; },
      parseContent: (c: string) => this.parseContent(c),
      migrateMetadataDefaults: (d: Record<string, unknown>, fp: string) => this.migrateMetadataDefaults(d, fp),
      parseMetadata: (d: any) => this.parseMetadata(d),
      createElement: (m: T['metadata'], c: string) => this.createElement(m, c),
      load: (fp: string) => this.load(fp),
      resolveAbsolutePath: (fp: string) => this.resolveAbsolutePath(fp),
      getElementLabelCapitalized: () => this.getElementLabelCapitalized(),
      get constructor() { return self.constructor as { name: string }; },
    };

    // ── Build ElementListOperations ───────────────────────────────────────
    this._listOps = new ElementListOperations<T>(
      listHost,
      this._cache,
      this.portfolioManager,
      this.fileOperations,
      this.storageLayer,
      this.publicElementDiscovery,
      this.getCurrentUserId,
    );

    const resolverHost = {
      load: (fp: string) => this.load(fp),
      list: (opts?: { includePublic?: boolean }) => this.list(opts),
      normalizeFilename: (n: string) => this.normalizeFilename(n),
      getElementFilename: (n: string) => this.getElementFilename(n),
      getFileExtension: () => this.getFileExtension(),
      resolveAbsolutePath: (fp: string) => this.resolveAbsolutePath(fp),
    };

    // ── Build ElementResolver ─────────────────────────────────────────────
    this._resolver = new ElementResolver<T>(
      resolverHost,
      this._cache,
      this.storageLayer,
    );
  }

  // ============================================
  // STORAGE LAYER
  // ============================================

  protected createStorageLayer(): IStorageLayer {
    return this.storageLayerFactory.createForElement(this.elementType, {
      elementDir: this.elementDir,
      fileExtension: this.getFileExtension(),
      scanCooldownMs: getValidatedScanCooldown(),
    });
  }

  // ============================================
  // LOAD / SAVE / DELETE / EXISTS / VALIDATE
  // ============================================

  async load(filePath: string): Promise<T> {
    return this._loader.load(filePath);
  }

  async save(element: T, filePath: string, options?: { exclusive?: boolean }): Promise<void> {
    return this._persister.save(element, filePath, options);
  }

  async delete(filePath: string): Promise<void> {
    return this._persister.delete(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    return this._persister.exists(filePath);
  }

  validatePath(filePath: string): boolean {
    return this._persister.validatePath(filePath);
  }

  validate(element: T): ElementValidationResult {
    return element.validate();
  }

  // ============================================
  // LIST / FIND
  // ============================================

  async list(options?: { includePublic?: boolean }): Promise<T[]> {
    return this._listOps.list(options);
  }

  async listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    return this._listOps.listSummaries(options);
  }

  async find(predicate: (element: T) => boolean): Promise<T | undefined> {
    return this._resolver.find(predicate);
  }

  async findMany(predicate: (element: T) => boolean): Promise<T[]> {
    return this._resolver.findMany(predicate);
  }

  async findByName(identifier: string): Promise<T | undefined> {
    return this._resolver.findByName(identifier);
  }

  // ============================================
  // INVALID ELEMENT TRACKING (Issue #708)
  // ============================================

  getInvalidElements(): InvalidElementRecord[] {
    return this._loader.getInvalidElements();
  }

  getInvalidElement(name: string): InvalidElementRecord | undefined {
    return this._loader.getInvalidElement(
      name,
      () => this.getFileExtension(),
      (n) => this.normalizeFilename(n),
    );
  }

  // ============================================
  // ELEMENT TYPE
  // ============================================

  getElementType(): ElementType {
    return this.elementType;
  }

  // ============================================
  // EVENT PAYLOAD / DISPATCHER (protected surface for subclasses)
  // ============================================

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
    return this._events.eventDispatcher;
  }

  /**
   * Creates a standardized event payload for element lifecycle events.
   *
   * Available to subclasses for consistent event payload structure when emitting
   * custom events via the dispatcher getter.
   */
  protected createEventPayload(params: {
    correlationId: string;
    filePath?: string;
    element?: T;
    error?: unknown;
  }): ElementEventPayload {
    return this._events.createEventPayload(params);
  }

  // ============================================
  // CACHE HELPERS (protected surface for subclasses)
  // ============================================

  protected cacheElement(element: T, filePath: string): void {
    this._cache.cacheElement(element, filePath);
  }

  protected uncacheByPath(filePath: string): void {
    this._cache.uncacheByPath(filePath);
  }

  /**
   * Protected cache lookup by absolute path.
   * Allows subclasses with custom load() overrides (e.g. MemoryManager)
   * to check the LRU cache before re-reading from disk.
   */
  protected getCachedByAbsolutePath(absolutePath: string): T | undefined {
    return this._cache.getCachedByAbsolutePath(absolutePath);
  }

  protected getCacheStats(): { elementCount: number; pathMappings: number } {
    return this._cache.getCacheStats();
  }

  clearCache(): void {
    this._cache.clear();
    this.storageLayer.clear();
  }

  public getMetricsCaches(): Array<{ name: string; instance: LRUCache<unknown> }> {
    return this._cache.getMetricsCaches();
  }

  // ============================================
  // SCAN / EVICT (protected for subclasses like EnsembleManager)
  // ============================================

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
    return this._listOps.scanAndEvict();
  }

  // ============================================
  // LOAD ERROR SUPPRESSION
  // ============================================

  /**
   * Returns true if the most recent load() failure for this path was suppressed
   * because it was a repeat of an already-logged error.
   * Subclasses can use this to avoid duplicate security event logging.
   */
  protected isLoadErrorSuppressed(filePath: string): boolean {
    return this._loader.isLoadErrorSuppressed(filePath);
  }

  // ============================================
  // BACKUP HOOKS (overridable by subclasses)
  // ============================================

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

  // ============================================
  // SERIALIZED CONTENT VALIDATION
  // ============================================

  /**
   * Validate serialized element content before writing to disk.
   * Fix #908: Mirrors the read-path validation from SecureYamlParser.parse()
   * to ensure write → read symmetry. Content that fails this check would also
   * fail to load, so rejecting it on write prevents permanently broken elements.
   *
   * Dispatched via ElementPersisterHost so MemoryManager's override is honored.
   */
  protected validateSerializedContent(content: string): void {
    this._persister.defaultValidateSerializedContent(content);
  }

  // ============================================
  // SESSION ACTIVATION STATE (Issue #1946)
  // ============================================

  /**
   * Resolve the current session's activation Set for the given element type key.
   * Returns the Set from SessionActivationRegistry if available, or the provided
   * fallback Set when the registry is not injected (tests, backward compat).
   */
  protected resolveActivationSet(
    setKey: 'personas' | 'skills' | 'agents' | 'memories' | 'ensembles',
    fallback: Set<string>,
  ): Set<string> {
    if (!this.activationRegistry) {
      if (!this._activationFallbackWarned && process.env.NODE_ENV !== 'test') {
        this._activationFallbackWarned = true;
        logger.warn(
          `[${this.constructor.name}] SessionActivationRegistry not injected — using local fallback Set. ` +
          `This indicates a DI configuration issue. Activation state will not be session-scoped.`
        );
      }
      return fallback;
    }
    const sessionId = this.contextTracker?.getSessionContext()?.sessionId
      ?? this.activationRegistry.getDefaultSessionId();
    return this.activationRegistry.getOrCreate(sessionId)[setKey];
  }

  // ============================================
  // PATH UTILITIES (stay on base class — consumed by host interfaces)
  // ============================================

  /**
   * Resolves a file path to its absolute form for cache consistency.
   * Ensures consistent path handling across relative/absolute paths.
   */
  protected resolveAbsolutePath(filePath: string): string {
    return path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.normalize(path.join(this.elementDir, filePath));
  }

  /**
   * Normalize, sanitize, and security-validate a file path.
   * Returns both the normalized relative path and its absolute counterpart.
   */
  protected async normalizeAndValidatePath(filePath: string): Promise<{ relativePath: string; absolutePath: string }> {
    // In database mode, the "path" is a UUID — skip filesystem normalization
    // and validation. The UUID is used directly as the key for readContent().
    if (isWritableStorageLayer(this.storageLayer)) {
      return { relativePath: filePath, absolutePath: filePath };
    }

    const sanitizedPath = sanitizeInput(filePath, 255);

    if (!sanitizedPath || sanitizedPath.trim().length === 0 || sanitizedPath === '.' || sanitizedPath === path.sep) {
      throw new Error(`Invalid ${this.getElementLabel()} path: empty path is not allowed`);
    }

    if (path.isAbsolute(sanitizedPath)) {
      throw new Error(`Absolute ${this.getElementLabel()} paths are not allowed`);
    }

    const normalizedRelative = path.normalize(sanitizedPath);
    const absolutePath = path.join(this.elementDir, normalizedRelative);

    try {
      await PathValidator.validateElementPathOnly(absolutePath, this.elementDir);
      return { relativePath: normalizedRelative, absolutePath };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid path';
      throw new Error(`Invalid ${this.getElementLabel()} path: ${reason}`);
    }
  }

  /**
   * Extract the element name from a relative file path.
   * Strips directory prefix and file extension (e.g., "my-skill.md" → "my-skill").
   * In database mode, the relativePath may already be a UUID — returned as-is.
   */
  protected extractNameFromPath(relativePath: string): string {
    return path.basename(relativePath, this.getFileExtension());
  }

  // ============================================
  // FILENAME NORMALIZATION METHODS
  // ============================================

  /**
   * Normalize a name to kebab-case for consistent filename formatting.
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
   */
  protected normalizeFilename(name: string): string {
    if (!name || name.trim().length === 0) {
      return 'unnamed';
    }

    return name
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Get the standardized filename for an element.
   *
   * Normalizes the element name and appends the file extension.
   *
   * @example
   * getElementFilename("Code Review")         // → "code-review.md"
   * getElementFilename("Debug Detective")     // → "debug-detective.md"
   * getElementFilename("BugReport")           // → "bug-report.md"
   */
  protected getElementFilename(name: string): string {
    const normalizedName = this.normalizeFilename(name) || 'unnamed';
    const extension = this.getFileExtension();
    return `${normalizedName}${extension}`;
  }

  // ============================================
  // METADATA MIGRATION / CONTENT PARSING
  // ============================================

  /**
   * Parse raw file content into structured data + body content.
   *
   * Default: SecureYamlParser.safeMatter() for markdown with YAML frontmatter.
   * Subclasses override for different formats (e.g., MemoryManager for pure YAML).
   */
  protected parseContent(content: string): { data: Record<string, unknown>; content: string } {
    const contentContext = ELEMENT_TYPE_TO_CONTEXT[this.elementType];
    const parsed = SecureYamlParser.safeMatter(content, undefined, { contentContext });
    return { data: parsed.data as Record<string, unknown>, content: parsed.content };
  }

  /**
   * Issue #695: Pre-fill missing metadata fields with sensible defaults
   * before parseMetadata() runs. Mutates `data` in place.
   */
  protected migrateMetadataDefaults(data: Record<string, unknown>, filePath: string): void {
    const migrated: string[] = [];

    if (!data.type) {
      data.type = this.elementType;
      migrated.push('type');
    }

    if (!data.name) {
      const basename = path.basename(filePath, this.getFileExtension());
      data.name = basename;
      migrated.push('name');
    }

    if (!data.version) {
      data.version = '1.0.0';
      migrated.push('version');
    }

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

  // ============================================
  // ELEMENT LABEL HELPERS
  // ============================================

  /**
   * Returns the singular human-readable label for this element type (e.g., "skill", "persona").
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

  // ============================================
  // DISPOSE
  // ============================================

  public dispose(): void {
    this._cache.dispose();
    this._events.dispose();
    this.storageLayer.clear();
    logger.debug(`${this.getElementLabelCapitalized()}Manager disposed and caches cleared`);
  }

  // ============================================
  // DEPRECATED HELPERS
  // ============================================

  /**
   * @deprecated Use ElementValidator via ValidationRegistry instead.
   * Will be removed in next major version.
   */
  async validateMetadata(metadata: any, _strict?: boolean): Promise<import('../../utils/validation/FieldValidator.js').ValidationError[]> {
    const result = await this.validator.validateMetadata(metadata);
    return result.errors.map(e => ({ field: 'general', message: e }));
  }

  // ============================================
  // ABSTRACT METHODS - Subclasses must implement
  // ============================================

  /**
   * Parse and validate metadata from frontmatter.
   * Subclasses implement element-specific validation logic.
   */
  protected abstract parseMetadata(data: any): Promise<T['metadata']>;

  /**
   * Create an element instance from metadata and content.
   * Subclasses implement element-specific construction.
   */
  protected abstract createElement(metadata: T['metadata'], content: string): T;

  /**
   * Serialize an element to file content.
   * Subclasses can customize serialization format.
   */
  protected abstract serializeElement(element: T): Promise<string>;

  /**
   * Get the file extension for this element type.
   * Most elements use .md, but subclasses can override.
   */
  abstract getFileExtension(): string;

  /**
   * Import an element from external format.
   * Subclasses implement format-specific import logic.
   */
  abstract importElement(data: string, format?: 'json' | 'yaml' | 'markdown'): Promise<T>;

  /**
   * Export an element to external format.
   * Subclasses implement format-specific export logic.
   */
  abstract exportElement(element: T, format?: 'json' | 'yaml' | 'markdown'): Promise<string>;
}
