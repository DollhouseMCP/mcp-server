import { storageReferenceFromPath } from '../../storage/StorageReference.js';
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

import { ACTIVE_LIMIT_ENV_VARS, getActiveElementLimitConfig, type ActiveLimitElementType } from '../../config/active-element-limits.js';
import { ValidationError } from '../../security/errors.js';
import { normalizeElementFilename } from '../../utils/filesystem.js';
import { ELEMENT_TYPE_TO_CONTEXT } from '../../security/elementContentContext.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { visitSequentially } from '../../utils/visitSequentially.js';
import type { ActivationMetricsTracker } from '../../metrics/ActivationMetricsTracker.js';
import { PendingActivationDeletions, resolvedActivationLocator, type ResolvedActivationTarget, type PendingActivationDeletion } from '../../state/PendingActivationDeletions.js';
import type { PersistedActivation, PersistedActivationIdentity } from '../../state/IActivationStateStore.js';
import { ActivationSet } from '../../state/ActivationSet.js';
import type { IElementManager } from '../../types/elements/IElementManager.js';
import type { IElement, ElementValidationResult } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import type { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { logger } from '../../utils/logger.js';
import type { FileLockManager } from '../../security/fileLockManager.js';
import { assertUnsanitizedReference } from '../../security/InputValidator.js';
import type { LRUCache } from '../../cache/LRUCache.js';
import * as path from 'node:path';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { PathValidator } from '../../security/pathValidator.js';
import type { ElementEventDispatcher, ElementEventPayload } from '../../events/ElementEventDispatcher.js';
import type { FileWatchService } from '../../services/FileWatchService.js';
import type { FileOperationsService } from '../../services/FileOperationsService.js';
import type { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import { type ElementValidator } from '../../services/validation/ElementValidator.js';
import {
  type IStorageLayer,
  type ElementSaveOptions,
  type StorageCacheVersion,
  type StorageCollectionSnapshot,
  type StorageScanOptions,
  isWritableStorageLayer,
  type StorageReference,
} from '../../storage/IStorageLayer.js';
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
import { type CachePublicationLease, ElementCache } from './ElementCache.js';
import { ElementEventCoordinator } from './ElementEventCoordinator.js';
import { ElementLoader } from './ElementLoader.js';
import { ElementPersister } from './ElementPersister.js';
import { ElementListOperations } from './ElementListOperations.js';
import { ElementResolver, type CallerTextKind, type ResolvedDefinition } from './ElementResolver.js';
import { requireCompleteCollection, type CollectionReport } from './CollectionReport.js';
import { acceptsDirectDefinition, callerNamesOf, nameTakenBy, type NameEvidenceSource } from './ElementNameEvidence.js';
import { resolveActiveReferenceReport } from './ActiveReferenceResolver.js';
import { ElementMissingError, ElementReadError, ElementUnreadableError, callerReadFailure, elementReadFailure, isRejectedDefinition } from './ElementReadError.js';
import type { DeletionReport, ElementDeletionTarget } from './ElementDeletion.js';

export const MAX_RETAINED_NOTICE_LINES = 5;

const DEFAULT_ELEMENT_CACHE_TTL_MS = getValidatedElementCacheTTL();
const DEFAULT_PATH_CACHE_TTL_MS = getValidatedPathCacheTTL();

export type BackupServiceProvider = () => BackupService | undefined;

/** A resolved update target; identity is carried unchanged into the save. */
export interface ElementUpdateTarget<T extends IElement> {
  readonly element: T;
  readonly content?: string;
  readonly path: string;
  readonly options: ElementSaveOptions;
}

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
  backupServiceProvider?: BackupServiceProvider;
  /** Issue #1946: ContextTracker for session-scoped activation state resolution */
  contextTracker?: import('../../security/encryption/ContextTracker.js').ContextTracker;
  /** Issue #1946: Registry for per-session activation state */
  activationRegistry?: import('../../state/SessionActivationState.js').SessionActivationRegistry;
  /**
   * Per-call resolver returning the current user's UUID: the element cache namespace outside a
   * session, and the owner filter when a public listing evicts foreign rows from the per-user
   * cache. Resolves from ContextTracker's session context. Undefined in file-only mode.
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

/** How fresh an active-reference read must be: enforcement (invalidate and scan) or advisory. */
export type ActiveReferenceFreshness = 'enforcement' | 'advisory';

export interface ActiveReferenceReportOptions<T> {
  assertCurrent?: () => void;
  scanOptions?: StorageScanOptions;
  freshness?: ActiveReferenceFreshness;
  resolve?: (reference: string) => Promise<T | undefined>;
  afterLookup?: (element: T, reference: string) => Promise<void>;
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
  /** Memory-only policy reference; constructor allocation invokes no policy work. */
  memoryRetentionPolicyService?: { shouldEnforceOnLoad(): boolean; isEnabled(): boolean };
  memoryUpgradeLifecycle?: import('../../lifecycle/MemoryUpgradeLifecycle.js').MemoryUpgradeLifecycle;
  eventDispatcher: ElementEventDispatcher;
  fileWatchService?: FileWatchService;
  memoryBudget?: CacheMemoryBudget;
  backupService?: BackupService;
  backupServiceProvider?: BackupServiceProvider;
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
  /** Original diagnostic reason; may contain private definition or storage details. */
  reason: string;
  /** Client-safe reason captured from the typed read failure at load time. */
  clientSafeReason: string;
  /** ISO timestamp of last failed load attempt. */
  failedAt: string;
  /** True only when this definition’s own content was read and rejected. */
  contentRejected: boolean;
}

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
  /**
   * Phase 4.5 follow-up: `elementDir` used to be a string field
   * captured once at construction from `portfolioManager.getElementDir(type)`.
   * That made HTTP per-user filesystem isolation impossible because the
   * captured value was the SHARED flat path (no session was active at
   * root-container construction time). It's now a dynamic getter that
   * re-queries PortfolioManager on every access — when a session is
   * active PortfolioManager delegates to `PathService.getUserElementDir(type)`
   * which routes through the per-user resolver in per-user layout.
   *
   * Construction captures the initial value into `staticElementDir`
   * as a defensive fallback for the rare paths that construct a
   * manager without a real PortfolioManager (some unit tests).
   */
  private readonly staticElementDir: string;
  protected get elementDir(): string {
    if (this.portfolioManager
        && typeof (this.portfolioManager as { getElementDir?: unknown }).getElementDir === 'function') {
      return (this.portfolioManager as { getElementDir(t: ElementType): string }).getElementDir(this.elementType);
    }
    return this.staticElementDir;
  }

  /** Specialized validator for this element type. */
  protected validator: ElementValidator;

  protected readonly elementType: ElementType;
  protected readonly backupService?: BackupService;
  private readonly backupServiceProvider?: BackupServiceProvider;

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
    options?: { suppressLoadPolicy?: boolean },
  ): Promise<void>;
  protected beforeSave?(element: T, filePath: string): Promise<void>;
  protected captureLoadedContent?(element: T, content: string, filePath: string): void;
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
  protected afterDelete?(filePath: string, displayName?: string): Promise<void>;
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
  private readonly pendingActivationDeletions = new PendingActivationDeletions();
  private readonly localActivationSets = new Map<string, ActivationSet>();

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
    this.backupServiceProvider = options.backupServiceProvider;
    this.contextTracker = options.contextTracker;
    this.activationRegistry = options.activationRegistry;
    this.getCurrentUserId = options.getCurrentUserId;
    this.storageLayerFactory = options.storageLayerFactory;
    this.publicElementDiscovery = options.publicElementDiscovery;

    this.validator = validationRegistry.getValidator(elementType);

    if (options.elementDirOverride) {
      this.staticElementDir = options.elementDirOverride;
    } else if (typeof (this.portfolioManager as { getElementDir?: unknown }).getElementDir === 'function') {
      this.staticElementDir = (this.portfolioManager as { getElementDir(t: ElementType): string }).getElementDir(elementType);
    } else {
      throw new TypeError(
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
      getCacheNamespace: () => this.getCacheNamespace(),
      onClear: () => this.clearCacheBookkeeping(),
    };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this; // NOSONAR — needed for object literal getters where `this` rebinds

    // ── Build ElementCache ────────────────────────────────────────────────
    this._cache = new ElementCache<T>(elementType, cacheHost, {
      elementCacheTTL: options.elementCacheTTL ?? DEFAULT_ELEMENT_CACHE_TTL_MS,
      pathCacheTTL: options.pathCacheTTL ?? DEFAULT_PATH_CACHE_TTL_MS,
      memoryBudget: options.memoryBudget,
    });

    const eventCoordinatorHost = {
      get elementDir() { return self.elementDir; },
      get elementType() { return self.elementType; },
      // The watcher reloads a reference the layer reported, never caller text.
      load: (reference: string) => this.loadStoredReference(reference),
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
      createElement: (m: T['metadata'], c: string, options?: { quietMemory?: boolean }) => this.createElement(m, c, options),
      captureLoadedContent: (el: T, content: string, fp: string) => this.captureLoadedContent?.(el, content, fp),
      afterLoad: (el: T, fp: string, pd?: { data: Record<string, unknown>; content: string }, options?: { suppressLoadPolicy?: boolean }) =>
        this.afterLoad ? this.afterLoad(el, fp, pd, options) : Promise.resolve(),
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
      this.storageLayer,
    );

    const persisterHost = {
      get elementType() { return self.elementType; },
      scanEvicting: () => this._listOps.scanEvicting(),
      serializeElement: (el: T) => this.serializeElement(el),
      validateSerializedContent: (c: string) => this.validateSerializedContent(c),
      beforeSave: (el: T, fp: string) => this.beforeSave ? this.beforeSave(el, fp) : Promise.resolve(),
      afterSave: (el: T, fp: string) => this.afterSave ? this.afterSave(el, fp) : Promise.resolve(),
      afterDelete: (fp: string, displayName?: string) => this.afterDelete ? this.afterDelete(fp, displayName) : Promise.resolve(),
      // Always dispatch dynamically so tests or subclasses can assign canDelete
      // after construction (e.g. via (manager as any).canDelete = jest.fn(...)).
      canDelete: (el: T) => this.canDelete ? this.canDelete(el) : Promise.resolve({ allowed: true }),
      canDeleteRepair: (identity: string, reason: string, storedName?: string) => this.canDeleteRepair(identity, reason, storedName),
      onSaveError: (el: T, fp: string, err: unknown) => this.onSaveError?.(el, fp, err),
      createBackupBeforeSave: (ap: string) => this.createBackupBeforeSave(ap),
      createBackupBeforeDelete: (ap: string, onCommitted?: () => void) => this.createBackupBeforeDelete(ap, onCommitted),
      getElementLabel: () => this.getElementLabel(),
      getElementLabelCapitalized: () => this.getElementLabelCapitalized(),
      getElementFilename: (name: string) => this.getElementFilename(name),
      scanAndEvict: () => this.scanAndEvict(),
      extractNameFromPath: (rp: string) => this.extractNameFromPath(rp),
      normalizeAndValidatePath: (fp: string) => this.normalizeAndValidatePath(fp),
      get constructor() { return self.constructor as { name: string }; },
    };

    // ── Build ElementPersister ────────────────────────────────────────────
    this._persister = new ElementPersister<T>({
      host: persisterHost,
      cache: this._cache,
      events: this._events,
      loader: this._loader,
      fileLockManager: this.fileLockManager,
      fileOperations: this.fileOperations,
      storageLayer: this.storageLayer,
      nameEvidence: this.nameEvidence,
      elementTypeToContext: ELEMENT_TYPE_TO_CONTEXT,
    });

    const listHost = {
      get elementType() { return self.elementType; },
      get elementDir() { return self.elementDir; },
      parseContent: (c: string) => this.parseContent(c),
      migrateMetadataDefaults: (d: Record<string, unknown>, fp: string) => this.migrateMetadataDefaults(d, fp),
      parseMetadata: (d: any) => this.parseMetadata(d),
      createElement: (m: T['metadata'], c: string) => this.createElement(m, c),
      load: (reference: string) => this.loadStoredReference(reference),
      resolveAbsolutePath: (fp: string) => this.resolveAbsolutePath(fp),
      getElementLabelCapitalized: () => this.getElementLabelCapitalized(),
      get constructor() { return self.constructor as { name: string }; },
    };

    // ── Build ElementListOperations ───────────────────────────────────────
    this._listOps = new ElementListOperations<T>(
      listHost,
      this._cache,
      this.storageLayer,
      this.publicElementDiscovery,
      this.getCurrentUserId,
    );

    const resolverHost = {
      loadReference: (reference: string) => this.loadStoredReference(reference),
      fallbackCandidates: (filename: string) => this.fallbackCandidates(filename),
      list: (opts?: { includePublic?: boolean }) => this.list(opts),
      getElementFilename: (n: string) => this.getElementFilename(n),
      getFileExtension: () => this.getFileExtension(),
      validateReference: (reference: string) => this.validateCallerReference(reference),
      classifyCallerText: (text: string) => this.classifyCallerText(text),
      refreshStaleIndex: () => this.scanAndEvict(),
    };

    // ── Build ElementResolver ─────────────────────────────────────────────
    this._resolver = new ElementResolver<T>(
      resolverHost,
      this._cache,
      this.storageLayer,
      this.nameEvidence,
    );
  }

  // ============================================
  // STORAGE LAYER
  // ============================================

  protected createStorageLayer(): IStorageLayer {
    return this.storageLayerFactory.createForElement(this.elementType, {
      elementDir: this.elementDir,
      elementDirResolver: () => this.elementDir,
      fileExtension: this.getFileExtension(),
      scanCooldownMs: getValidatedScanCooldown(),
      retainDirectoryState: dir => this._cache?.hasDirectoryEntries(dir) ?? false,
      onFailedRecordRecovered: reference => {
        this._cache.uncacheByPath(reference);
        this._loader.clearInvalidRecord(reference);
      },
    });
  }

  // ============================================
  // LOAD / SAVE / DELETE / EXISTS / VALIDATE
  // ============================================

  /**
   * Caller entry: load by storage reference or by name, as the caller-text classifier decides.
   */
  async load(filePath: string): Promise<T> {
    if (await this.classifyCallerText(filePath) === 'reference') return this.loadStoredReference(filePath);
    const element = await this.findByName(filePath);
    if (element) return element;
    throw new ElementMissingError(filePath, undefined);
  }

  /**
   * Read one storage reference through the loader, never back through the caller-text entry: a
   * reference that classification or certification already selected is never classified again.
   * Subclasses that observe every definition read (an audit event) override this.
   */
  protected loadStoredReference(reference: string): Promise<T> {
    this.normalizeReference(reference);
    return this._loader.load(reference);
  }

  /**
   * Where a type may store a filename the index does not hold, for the resolver's filename
   * fallback only. Most types keep definitions in one flat directory; memories add sub-folders.
   */
  protected fallbackCandidates(filename: string): Promise<string[]> {
    return Promise.resolve([filename]);
  }

  /**
   * Parse a fresh element definition without post-load hydration or cache
   * mutation. Intended for subclasses that must select an identity before
   * attaching state (for example, AgentManager's recovery reads).
   */
  protected async loadElementDefinition(filePath: string): Promise<T> {
    return this._loader.loadDefinition(filePath);
  }

  /** Complete hydration of exact snapshot bytes; intentionally no read/cache publication. */
  protected hydrateDefinitionFromContent(content: string, relativePath: string, options?: { suppressLoadPolicy?: boolean; quietMemory?: boolean }): Promise<T> {
    return this._loader.hydrateDefinitionFromContent(content, relativePath, options);
  }

  async save(element: T, filePath: string, options?: ElementSaveOptions): Promise<void> {
    return this._persister.save(element, filePath, options);
  }

  /** Resolve once so an update cannot silently insert or retarget a replacement row. */
  async findForUpdate(name: string): Promise<ElementUpdateTarget<T> | undefined> {
    const target = await this._persister.resolveUpdateTarget(name);
    if (!target) return undefined;
    try {
      const element = await this._loader.loadDefinitionFromContent(target.content, target.path);
      // A target read outside the index is accepted by the same rule as a direct load by name.
      return element && acceptsDirectDefinition(name, target.path, element.metadata.name, n => this.getElementFilename(n),
        callerNamesOf(this.storageLayer, name)) ? { element, ...target } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(filePath: string, onCommitted?: () => void): Promise<void> {
    await this.deleteResolved(await this.resolveDeletionTarget(filePath), onCommitted);
  }

  /**
   * Caller entry: the caller-text classifier refuses path syntax first; an exact storage reference
   * then fails on its own syntax here, bare; a name resolves through the index like every name
   * lookup, and its own caller refusal passes unwrapped. Every storage failure is classified.
   */
  async resolveDeletionTarget(identifier: string): Promise<ElementDeletionTarget<T>> {
    await this.classifyCallerText(identifier);
    const reference = await this.classifiedRead(identifier, () => this.storageLayer.resolveReference(identifier));
    if (reference.kind === 'identity') this.normalizeReference(reference.storageIdentity);
    return this.classifiedRead(identifier, () => this.resolveDeletionReference(identifier, reference));
  }

  private async classifiedRead<R>(identifier: string, read: () => Promise<R>): Promise<R> {
    try {
      return await read();
    } catch (cause) {
      throw callerReadFailure(cause, identifier);
    }
  }

  private async resolveDeletionReference(identifier: string, reference: StorageReference): Promise<ElementDeletionTarget<T>> {
    if (reference.kind === 'identity') {
      const { relativePath } = await this.normalizeAndValidatePath(reference.storageIdentity);
      try {
        const element = await this.loadElementDefinition(relativePath);
        return { kind: 'element', storageIdentity: relativePath, element, requestedReference: reference.requested };
      } catch (cause) {
        if (this.storageLayer.isExactStorageReference(identifier, this.getFileExtension()) &&
          isRejectedDefinition(cause)) {
          return { kind: 'repair', storageIdentity: relativePath, reason: cause.message, repair: 'rejected-definition' };
        }
        throw cause;
      }
    }
    const element = await this.findByName(reference.name);
    if (!element) throw new ElementMissingError(identifier, undefined);
    return { kind: 'element', storageIdentity: this.storageReferenceOf(element), element, requestedReference: identifier };
  }

  async deleteResolved(target: ElementDeletionTarget<T>, onCommitted?: () => void): Promise<DeletionReport> {
    // A target carries the caller's text it was resolved from; that text meets the shared classifier here too.
    if (target.kind === 'element' && target.requestedReference !== undefined) await this.classifyCallerText(target.requestedReference);
    await this._persister.deleteResolved(target, onCommitted);
    return { storageIdentity: target.storageIdentity, notices: target.kind === 'repair'
      ? [`Definition could not be read: ${target.reason}. Removed by storage reference '${target.storageIdentity}'.`] : [] };
  }

  protected canDeleteRepair(_storageIdentity: string, _reason: string, _storedName?: string): Promise<{ allowed: boolean; reason?: string }> {
    return Promise.resolve(this.canDelete
      ? { allowed: false, reason: 'This element requires definition-based deletion validation.' }
      : { allowed: true });
  }

  /**
   * The one create availability check, on both backends (ElementNameEvidence.nameTakenBy): the
   * stored name of the definition the requested name selects by any tier ('my skill' beside
   * 'My-Skill'), undefined when free, and indeterminate (refused, typed) when a failed definition
   * could hold it or several definitions tie. An unrelated unreadable sibling never blocks a create.
   * The evidence is fresh: the collection is refreshed through the storage contract first (one id
   * query on the database, the membership check on files), so a name another process stored since
   * the index was built is still refused.
   */
  protected nameTakenBy(name: string): Promise<string | undefined> {
    return this.classifiedRead(name, async () => {
      await this._listOps.refreshCollection();
      return nameTakenBy(this.nameEvidence, name);
    });
  }

  /**
   * The one create refusal for a name another definition holds, for every type: thrown, with the
   * stored name when it differs from the requested text. A type whose create also writes a target
   * file another definition could hold passes whether that target is taken.
   */
  protected async assertNameAvailable(name: string, targetTaken = false): Promise<void> {
    const refusal = await this.duplicateNameRefusal(name, targetTaken);
    if (refusal) throw new Error(refusal);
  }

  /** The duplicate-name refusal message, or undefined when the name is free (assertNameAvailable's rule). */
  protected async duplicateNameRefusal(name: string, targetTaken = false): Promise<string | undefined> {
    const existing = await this.nameTakenBy(name);
    if (existing === undefined && !targetTaken) return undefined;
    const label = this.getElementLabel();
    const article = /^[aeiou]/iu.test(label) ? 'An' : 'A';
    const stored = existing === undefined || existing === name ? '' : ` (stored as "${existing}")`;
    return `${article} ${label} named "${name}" already exists${stored}`;
  }

  /** Caller entry: a storage reference is probed; a name is certified like every name lookup. */
  async exists(filePath: string): Promise<boolean> {
    if (await this.classifyCallerText(filePath) !== 'reference' && !isWritableStorageLayer(this.storageLayer)) {
      return (await this.findByName(filePath)) !== undefined;
    }
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
    return requireCompleteCollection(await this.listReport(options));
  }

  listReport(options?: { includePublic?: boolean }): Promise<CollectionReport<T>> {
    return this.readCollectionReport(options);
  }

  /** Project the same per-type presentation as collection reads onto one resolved definition. */
  async projectForDisplay(element: T): Promise<void> {
    await this.decorateListed([element]);
  }

  /** Per-type presentation shared by complete lists and partial report survivors. */
  protected decorateListed(_items: T[]): Promise<void> {
    return Promise.resolve();
  }

  protected async readCollectionReport(options?: { includePublic?: boolean }, select?: (entry: ElementIndexEntry) => boolean): Promise<CollectionReport<T>> {
    const report = await this._listOps.listReport(options, select);
    await this.decorateListed(report.items);
    return report;
  }

  protected async resolveActiveReferences(options: ActiveReferenceReportOptions<T> = {}): Promise<T[]> {
    return requireCompleteCollection(await this.getActiveReferenceReport(options));
  }

  /**
   * The active references as current definitions. Enforcement (the default) invalidates and scans,
   * evicting every changed definition on files and every known row on the database, so a cached
   * instance is never served past an edit. An advisory read (a display or the coalesced digest)
   * uses the cheaper collection refresh.
   */
  async getActiveReferenceReport(options: ActiveReferenceReportOptions<T> = {}): Promise<CollectionReport<T>> {
    const type = this.activationSetKey;
    if (!type) throw new ElementUnreadableError('Element type does not support activation');
    return resolveActiveReferenceReport({
      ...options,
      references: this.resolveActivationSet(type),
      scan: () => this.refreshForFreshness(options.freshness, options.scanOptions),
      resolve: options.resolve ?? (reference => this.findActiveReference(reference)),
      afterLookup: options.afterLookup ?? (element => this.afterActiveReferenceLookup(element)),
    });
  }

  /**
   * The one refresh a policy or active-reference read takes: enforcement (the default) invalidates
   * and scans, evicting every changed definition; an advisory read takes the cheaper collection
   * refresh, which evicts only what it reports changed.
   */
  refreshForFreshness(freshness: ActiveReferenceFreshness = 'enforcement', scanOptions?: StorageScanOptions): Promise<void> {
    return freshness === 'advisory' ? this._listOps.refreshCollection(scanOptions) : this.scanAndEvict(scanOptions);
  }

  protected findActiveReference(reference: string): Promise<T | undefined> { return this.findByName(reference, { refreshed: true }); }
  protected afterActiveReferenceLookup(_element: T): Promise<void> { return Promise.resolve(); }

  async listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    return this._listOps.listSummaries(options);
  }


  async find(predicate: (element: T) => boolean): Promise<T | undefined> {
    return this._resolver.find(predicate);
  }

  async findMany(predicate: (element: T) => boolean): Promise<T[]> {
    return this._resolver.findMany(predicate);
  }

  /**
   * `refreshed` is for a caller that refreshed this collection in the same call (an active-reference
   * read after its scan, a policy member lookup after its refresh): a miss is answered from that
   * refresh, never from an older observation.
   */
  async findByName(identifier: string, options: { refreshed?: boolean } = {}): Promise<T | undefined> {
    return this._resolver.findByName(identifier, options);
  }

  /** The shared name resolution with its storage reference, for a type that needs its own load (fresh or cached). */
  protected resolveDefinition(identifier: string, load?: (reference: string) => Promise<T>): Promise<ResolvedDefinition<T> | undefined> {
    return this._resolver.resolveDefinition(identifier, load);
  }

  /** Load an exact storage reference by the loader's one cached-instance rule (ElementLoader.loadByReference). */
  protected loadByStorageReference(reference: string): Promise<T> {
    return this._loader.loadByReference(reference, ref => this.loadStoredReference(ref));
  }

  /**
   * Resolve an element by its backend-owned durable key. File-backed managers
   * accept indexed relative paths with the manager's file extension, refusing
   * other strings; database-backed managers refuse non-UUID keys. Unlike
   * findByName(), this never interprets the key as display text.
   */
  async findByStorageIdentity(identity: string): Promise<T | undefined> {
    if (typeof identity !== 'string' || identity.trim() === '') return undefined;
    const normalizedIdentity = identity.trim();
    // The one caller-text classifier decides: only a storage reference is looked up here. A name
    // (path syntax a stored name certifies included) is the caller's name lookup to make; unheld
    // path syntax is refused by the type's path policy.
    if (await this.classifyCallerText(normalizedIdentity) !== 'reference') return undefined;
    // The loader's one rule for a lookup by storage reference (IStorageLayer.cachedInstanceCurrency).
    try {
      return await this.loadByStorageReference(normalizedIdentity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw elementReadFailure(error, normalizedIdentity);
    }
  }

  // ============================================
  // INVALID ELEMENT TRACKING (Issue #708)
  // ============================================

  getInvalidElements(): InvalidElementRecord[] {
    return this._loader.getInvalidElements();
  }

  getInvalidElement(name: string): InvalidElementRecord | undefined {
    return this._loader.getInvalidElement(name);
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

  protected withCachePublication<R>(operation: (lease: CachePublicationLease) => R): R {
    return this._cache.withDirectoryPin(operation);
  }

  protected assertPublicationLease(lease: CachePublicationLease): void {
    this._cache.assertPublicationLease(lease);
  }

  /**
   * The manager's name-evidence source: the index, and the one evicting collection read, so a
   * snapshot read for certification never leaves a changed instance cached.
   */
  protected readonly nameEvidence: NameEvidenceSource = {
    readIndexedPath: (names, options) => this.storageLayer.readIndexedPath(names, options),
    callerNames: text => callerNamesOf(this.storageLayer, text),
    readCollection: options => this._listOps.readCollectionEvicting(options),
  };

  /** The manager's one collection read: what the snapshot saw change is evicted. */
  protected readCollectionEvicting(options?: { includePublic?: boolean }): Promise<StorageCollectionSnapshot> {
    return this._listOps.readCollectionEvicting(options);
  }

  protected cacheElement(element: T, filePath: string, lease: CachePublicationLease, version?: StorageCacheVersion): void {
    this._cache.cacheElement(element, filePath, lease, version);
  }

  protected uncacheByPath(filePath: string): void {
    this._cache.uncacheByPath(filePath);
  }

  protected getCachedElementsForCurrentNamespace(): T[] {
    return this._cache.getScopedValues();
  }

  /**
   * Resolve the cached instance backing a storage identity (relative file path
   * in file mode, row UUID in database mode). Storage identity is the only key
   * that distinguishes elements sharing a display name, so callers that must
   * address a specific live instance use this rather than a name lookup.
   */
  protected getCachedElementByStorageIdentity(identity: string): T | undefined {
    return this._cache.getCachedByPath(identity);
  }


  /**
   * Record an access on a cached element by ID. Exposes ElementCache.touchById
   * so subclasses doing name- or filename-based iteration (which can't go
   * through `get(id)`) can keep the LRU ordering and hit metrics honest.
   */
  protected touchCachedElement(id: string): T | undefined {
    return this._cache.touchById(id);
  }

  protected getCacheStats(): { elementCount: number; pathMappings: number } {
    return this._cache.getCacheStats();
  }

  /** Resolve inside the caller request; outside it the default namespace is system. */
  protected getScopedCacheKey(key: string): string {
    return this._cache.key(key);
  }

  protected getCacheNamespace(): string {
    if (this.contextTracker) {
      const session = this.contextTracker.getSessionContext();
      if (session?.userId) {
        return session.userId;
      }
    }
    if (this.getCurrentUserId) {
      try {
        return this.getCurrentUserId();
      } catch {
        // Fall through to the process-local namespace for startup and tests outside a session.
      }
    }
    return 'system';
  }

  protected clearCacheBookkeeping(): void {
    this._loader.clear();
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
  protected async scanAndEvict(options?: StorageScanOptions): Promise<void> {
    return this._listOps.scanAndEvict(options);
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
    const backupService = this.resolveBackupService();
    if (!backupService) return;
    await backupService.backupBeforeSave(absolutePath, this.elementType);
  }

  /**
   * Create a backup before deleting a file (moves file to backup dir).
   * Returns true if the original file was moved (caller should skip deleteFile).
   * Subclasses can override to no-op (e.g. MemoryManager has its own backup system).
   */
  protected async createBackupBeforeDelete(absolutePath: string, onCommitted?: () => void): Promise<boolean> {
    const backupService = this.resolveBackupService();
    if (!backupService) return false;
    const result = await backupService.backupBeforeDelete(absolutePath, this.elementType, onCommitted);
    return !!result.movedOriginal;
  }

  /**
   * Resolve the BackupService for the active execution context.
   * HTTP sessions provide a per-user BackupService through SessionContainer;
   * stdio/background/test contexts fall back to the constructor-injected root.
   */
  protected resolveBackupService(): BackupService | undefined {
    return this.backupServiceProvider?.() ?? this.backupService;
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
   * manager-owned fallback Set when the registry is not injected.
   */
  protected resolveActivationSet(
    setKey: 'personas' | 'skills' | 'agents' | 'memories' | 'ensembles',
  ): ActivationSet {
    if (!this.activationRegistry) {
      if (!this._activationFallbackWarned && process.env.NODE_ENV !== 'test') {
        this._activationFallbackWarned = true;
        logger.warn(
          `[${this.constructor.name}] SessionActivationRegistry not injected — using local fallback Set. ` +
          `This indicates a DI configuration issue. Activation state will not be session-scoped.`
        );
      }
      let active = this.localActivationSets.get(setKey);
      if (!active) {
        active = new ActivationSet();
        this.localActivationSets.set(setKey, active);
      }
      return active;
    }
    const sessionId = this.contextTracker?.getSessionContext()?.sessionId
      ?? this.activationRegistry.getDefaultSessionId();
    return this.activationRegistry.getOrCreate(sessionId)[setKey];
  }

  /** Failed reads must not prevent explicit deactivation of an exact live reference. */
  protected async findForDeactivation(identifier: string): Promise<{ element?: T; lookupFailed: boolean }> {
    const candidate = identifier.trim();
    if (!this.resolveActivationSet(this.activationSetKey!).has(identifier) &&
        (!candidate || candidate === '.' || identifier.includes('\0') || path.isAbsolute(candidate) ||
        path.win32.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..'))) {
      throw new ValidationError('Invalid deactivation identifier');
    }
    try { return { element: await this.findByName(identifier), lookupFailed: false }; } catch (error) {
      logger.warn('[Activation] Deactivation lookup failed', { error: error instanceof Error ? error.name : typeof error });
      return { lookupFailed: true };
    }
  }

  /** Report pressure before collecting notices, preserving each manager's event source. */
  protected async reportActivationPressure(
    type: ActiveLimitElementType, source: string, collectNotices: () => Promise<string[]>, alreadyScanned = false,
  ): Promise<string[]> {
    const { max, cleanupThreshold } = getActiveElementLimitConfig(type);
    const active = this.resolveActivationSet(type);
    if (active.size < cleanupThreshold) return [];
    if (!alreadyScanned) await this.scanAndEvict();
    const notices: string[] = [];
    if (active.size >= max) {
      const notice = `Active ${type} limit reached (${max}). ` +
        `Consider deactivating unused ${type} or setting ${ACTIVE_LIMIT_ENV_VARS[type]} to a higher value.`;
      notices.push(notice);
      logger.warn(notice);
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED', severity: 'MEDIUM', source,
        details: `Active ${type} limit reached: ${active.size}/${max}`,
      });
    }
    return [...notices, ...await collectNotices()];
  }

  /** Bound response text while tracking every retained reference in the current session. */
  protected async retainedReferenceNotices(
    label: string, exists: (key: string) => Promise<boolean>, tracker: ActivationMetricsTracker, consequence?: string,
  ): Promise<string[]> {
    const setKey = this.activationSetKey;
    if (!setKey) return [];
    const notices: string[] = [];
    let retained = 0;
    const active = this.resolveActivationSet(setKey);
    await visitSequentially(active[Symbol.iterator](), async reference => {
      let lookupFailed = false;
      try {
        if (await exists(reference)) return;
      } catch (error) {
        lookupFailed = true;
        logger.debug('[Activation] Reference lookup failed', { label, error: error instanceof Error ? error.name : typeof error });
      }
      if (!active.has(reference)) return;
      const notice = tracker.retain(label, reference, lookupFailed ? consequence : undefined);
      retained++;
      if (notices.length < MAX_RETAINED_NOTICE_LINES) notices.push(notice);
    });
    if (retained > notices.length) notices.push(`…and ${retained - notices.length} more retained ${label} references`);
    return notices;
  }

  /** Activation-set key for this manager's type; templates are never activated. */
  private get activationSetKey(): Exclude<ElementType, ElementType.TEMPLATE> | undefined {
    const type = this.elementType;
    return type === ElementType.TEMPLATE ? undefined : type;
  }

  /** Release only an exact live key; recovery must never read its definition. */
  releaseActivationReference(key: string): { released: boolean; identity?: PersistedActivationIdentity; message?: string } {
    const setKey = this.activationSetKey;
    return { released: setKey !== undefined && this.resolveActivationSet(setKey).delete(key) };
  }

  beginActivationDeletion(locator: string): PendingActivationDeletion | undefined {
    const setKey = this.activationSetKey;
    if (!setKey) return undefined;
    return this.pendingActivationDeletions.begin(this.resolveActivationSet(setKey), locator);
  }

  hasPendingActivationDeletions(sessionId: string): boolean {
    const setKey = this.activationSetKey;
    if (!setKey) return false;
    const active = this.activationRegistry?.get(sessionId)?.[setKey];
    return active !== undefined && this.pendingActivationDeletions.hasPendingDeletions(active);
  }

  recordPendingActivation(
    target: ResolvedActivationTarget, record?: PersistedActivation,
    scope?: { sessionId?: string; liveKey?: string },
  ): void {
    const setKey = this.activationSetKey;
    if (!setKey) return;
    const locator = resolvedActivationLocator(target);
    const active = scope?.sessionId === undefined
      ? this.resolveActivationSet(setKey)
      : this.activationRegistry?.get(scope.sessionId)?.[setKey];
    if (locator && active) this.pendingActivationDeletions.register(
      active, locator, scope?.liveKey ?? this.deletedActivationKey(locator, target.metadata.name), record,
    );
  }

  protected deletedActivationKey(_locator: string, name: string): string {
    return name;
  }

  /** Capture the caller's live entry at commit; clear only that lifetime. */
  prepareDeletedActivation(locator: string, name: string): (() => boolean) | undefined {
    const setKey = this.activationSetKey;
    if (!setKey) return undefined;
    const active = this.resolveActivationSet(setKey);
    return active.captureDeletion(this.deletedActivationKey(locator, name));
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
   * Normalize and sanitize a reference and validate its syntax without touching storage: the
   * part of the policy a caller can get wrong (empty, absolute, traversal, containment, filename).
   * Public entry points run it on caller input so the validator's own error surfaces directly.
   */
  protected normalizeReference(filePath: string): { relativePath: string; absolutePath: string } {
    // In database mode, the "path" is a UUID — skip filesystem normalization
    // and validation. The UUID is used directly as the key for readContent().
    if (isWritableStorageLayer(this.storageLayer)) {
      return { relativePath: filePath, absolutePath: filePath };
    }

    if (!filePath || filePath.trim().length === 0 || filePath === '.' || filePath === path.sep) {
      throw new ValidationError(`Invalid ${this.getElementLabel()} path: empty path is not allowed`);
    }

    if (path.isAbsolute(filePath)) {
      throw new ValidationError(`Absolute ${this.getElementLabel()} paths are not allowed`);
    }

    try {
      assertUnsanitizedReference(filePath);
    } catch (error) {
      throw this.pathRejection(error);
    }
    const normalizedRelative = path.normalize(filePath);
    const absolutePath = path.join(this.elementDir, normalizedRelative);
    try {
      PathValidator.validateElementReference(absolutePath, this.elementDir);
    } catch (error) {
      throw this.pathRejection(error);
    }
    return { relativePath: storageReferenceFromPath(normalizedRelative), absolutePath };
  }

  /**
   * The full storage policy: reference syntax plus the stored target (a symlink must stay inside
   * the element directory). The loader, the persister and the file scan apply the same policy.
   */
  protected async normalizeAndValidatePath(filePath: string): Promise<{ relativePath: string; absolutePath: string }> {
    const paths = this.normalizeReference(filePath);
    if (isWritableStorageLayer(this.storageLayer)) return paths;
    try {
      await PathValidator.validateElementPathOnly(paths.absolutePath, this.elementDir);
    } catch (error) {
      throw callerReadFailure(this.pathRejection(error), filePath);
    }
    return paths;
  }

  /**
   * The caller-syntax check for a reference that is about to be used as a path: the type's own
   * path policy, refused before any read. Subclasses with their own policy override it.
   */
  protected validateCallerReference(reference: string): Promise<void> {
    this.normalizeReference(reference);
    return Promise.resolve();
  }

  /**
   * The one caller-text classifier, on both backends and at every caller entry (findByName, load,
   * exists, delete). Text in the storage layer's own canonical reference form (a typed relative
   * filename on the file backend, a row id on the database) is a reference; one with a separator
   * still meets the type's path policy. Other path-shaped text (a separator, or path syntax: a '..'
   * segment, an absolute path, a drive letter, percent-encoding, NUL) is a name-only lookup that
   * selects by exact or case-folded name, never by slug, and is never turned into a filename. Path
   * syntax that no stored name holds meets the type's own path policy (its own message) and is
   * otherwise refused. Everything else is a name.
   */
  protected async classifyCallerText(text: string): Promise<CallerTextKind> {
    const extension = this.getFileExtension();
    const shaped = PathValidator.isPathShaped(text);
    if (this.storageLayer.isExactStorageReference(text, extension)) {
      if (shaped) await this.applyPathPolicy(text, extension);
      return 'reference';
    }
    if (PathValidator.isPathSyntax(text, extension)) {
      const held = await this.storedNameHolds(text).catch(error => {
        // Discovery may have found this exact reference while reporting its rejected content.
        if (error instanceof ElementReadError && error.kind !== 'absent'
          && this.storageLayer.isExactStorageReference(text, extension)) return false;
        throw error;
      });
      // The evidence read indexed the layer, so it is asked again: text it holds ('save-50%25.md') is
      // a reference on the first call, whether or not anything had filled the index before. It leaves
      // by the warm branch's own exit, path policy included.
      if (this.storageLayer.isExactStorageReference(text, extension)) {
        if (shaped) await this.applyPathPolicy(text, extension);
        return 'reference';
      }
      if (!held) {
        await this.applyPathPolicy(text, extension);
        throw new ValidationError(`Invalid ${this.getElementLabel()} reference: elements are addressed by name or storage reference, not by path`);
      }
    }
    return shaped ? 'name-only' : 'name';
  }

  /**
   * Whether a stored name certifies this exact or case-folded text. Only a certified absence is
   * "no"; an indeterminate or unreadable index propagates, so a stored name is never refused as a
   * path merely because the evidence was incomplete.
   */
  private async storedNameHolds(text: string): Promise<boolean> {
    return await nameTakenBy(this.nameEvidence, text) !== undefined;
  }

  /** Path-shaped text meets the type's own path policy first, so its refusal carries the type's message. */
  private async applyPathPolicy(text: string, extension: string): Promise<void> {
    try {
      await this.validateCallerReference(text.endsWith(extension) ? text : `${text}${extension}`);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
    }
  }

  protected pathRejection(error: unknown): unknown {
    // Storage state is not a caller syntax refusal. Preserve its original code and cause.
    if (typeof (error as NodeJS.ErrnoException | null)?.code === 'string') return error;
    return new ValidationError(`Invalid ${this.getElementLabel()} path: ${error instanceof Error ? error.message : 'Invalid path'}`);
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
    return normalizeElementFilename(name);
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

  public async dispose(): Promise<void> {
    this._cache.dispose();
    this._events.dispose();
    this.storageLayer.clear();
    await this.storageLayer.dispose?.();
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
  protected abstract createElement(metadata: T['metadata'], content: string, options?: { quietMemory?: boolean }): T;

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

  /**
   * The storage reference the cache attached when this element was resolved: a relative path on
   * the file backend (date folders included), a row id on the database. The one identity
   * extraction for deletion; an element without one cannot be addressed.
   */
  storageReferenceOf(element: T): string {
    // The cache attaches the full relative reference; a basename would mis-address a date-folder memory.
    const reference = (element as T & { filePath?: string }).filePath;
    if (!reference) throw new ElementUnreadableError('Resolved element has no storage identity');
    return reference;
  }
}
