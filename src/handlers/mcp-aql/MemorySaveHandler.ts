import { STORAGE_LAYER_CONFIG } from '../../config/performance-constants.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import type { MemoryManager } from '../../elements/memories/MemoryManager.js';
import type { Memory } from '../../elements/memories/Memory.js';
import { MemoryPersistenceConflictError } from '../../storage/DatabaseMemoryStorageLayer.js';
import type { ExecutionContext } from '../../security/encryption/ContextTracker.js';
import type { HandlerRegistry } from './MCPAQLHandler.js';
import { validateRequiredString } from './shared.js';
import {
  MemoryPersistenceCoordinator,
  sharedMemoryPersistenceCoordinator,
  type MemoryPersistenceVersion,
} from './MemoryPersistenceCoordinator.js';

/**
 * Capability used to re-establish a save's originating per-user execution context
 * when persisting outside the original request. The shutdown flush runs with no
 * ambient AsyncLocalStorage context, so without re-establishing it a file-mode
 * per-user save resolves to the shared baseDir. Both methods are optional so
 * callers without a context tracker (stdio, tests) degrade to context-less saves.
 */
export interface SaveContextScope {
  getContext?(): ExecutionContext | undefined;
  runAsync?<T>(context: ExecutionContext, fn: () => Promise<T>): Promise<T>;
}

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  memory: Memory;
  manager: MemoryManager;
  /** Per-user execution context captured when the save was scheduled (#2329). */
  context?: ExecutionContext;
  persistenceVersion: MemoryPersistenceVersion;
}

interface SaveFrequencyCounter {
  timestamps: number[];
  warned: boolean;
  critical: boolean;
}

/**
 * Issue #2329: a memory whose most recent save attempt failed. Holds the
 * failing Memory instance and its manager — the unpersisted entries exist only
 * in that instance, so recovery must retry it (a freshly loaded instance would
 * lack them).
 */
interface FailedSave {
  error: Error;
  memory: Memory;
  manager: MemoryManager;
  /** Deletion-probe target captured while the owning user context is active. */
  probeToken: string | null;
  /** Per-user execution context captured at the time the save failed (#2329). */
  context?: ExecutionContext;
  persistenceVersion: MemoryPersistenceVersion;
  /** File snapshot digest observed before the failed mutation. */
  expectedPersistedToken?: string;
}

export class MemorySaveHandler {
  private readonly pendingSaves = new Map<string, PendingSave>();
  private readonly debounceMetrics = { coalesced: 0, written: 0 };
  private readonly saveFrequencyCounters = new Map<string, SaveFrequencyCounter>();
  /**
   * Issue #2329: memories whose most recent save attempt failed, keyed by the
   * session-scoped save key. Recovery on the next addEntry / flush retries these.
   */
  private readonly failedMemorySaves = new Map<string, FailedSave>();
  /**
   * Issue #2329: per-key save attempt counter. The newest-started save wins —
   * an older in-flight save resolving late cannot erase a newer failure.
   */
  private readonly memorySaveAttempts = new Map<string, number>();
  constructor(
    private readonly handlers: HandlerRegistry,
    private readonly sessionKey: (name: string) => string,
    private readonly contextScope?: SaveContextScope,
    private readonly persistenceCoordinator: MemoryPersistenceCoordinator = sharedMemoryPersistenceCoordinator,
  ) {}

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const manager = this.handlers.memoryManager;
    const memoryName = validateRequiredString(
      params,
      'element_name',
      'the name of the memory to operate on'
    );

    // Capture before the first await. A delete that completes while find() is
    // loading must invalidate this operation rather than letting the stale
    // loaded object schedule a save under the post-delete generation.
    const persistenceVersion = this.persistenceCoordinator.capture(
      this.memoryPersistenceKey(memoryName),
    );
    const saveKey = this.memorySaveKey(memoryName);
    try {
      const memory = await manager.find(m => m.metadata.name === memoryName);
      if (!memory) {
        throw new Error(`Memory '${memoryName}' not found. Use list_elements to see available memories.`);
      }

      switch (method) {
        case 'addEntry':
          return await this.addEntry(memoryName, memory, manager, params, persistenceVersion);
        case 'clear':
          return await this.clear(memoryName, memory, manager, persistenceVersion);
        default:
          throw new Error(`Unknown Memory method: ${method}`);
      }
    } finally {
      const pendingVersion = this.pendingSaves.get(saveKey)?.persistenceVersion;
      const failedVersion = this.failedMemorySaves.get(saveKey)?.persistenceVersion;
      if (pendingVersion !== persistenceVersion && failedVersion !== persistenceVersion) {
        this.persistenceCoordinator.release(persistenceVersion);
      }
    }
  }

  /**
   * Clean up bookkeeping for a disconnecting HTTP session WITHOUT writing.
   *
   * Issue #2329 (multi-user correctness): this runs during session disposal,
   * OUTSIDE the session's AsyncLocalStorage context. A save issued from here
   * would resolve the per-user element directory to the flat shared baseDir
   * (file mode) — or throw (database mode) — so it must never write. Each pending
   * save's debounce timer was scheduled INSIDE the request context, which
   * AsyncLocalStorage propagates across setTimeout, so leaving the timer to fire
   * persists the entry to the CORRECT per-user location. Per runbook §6: "retain
   * the pending save until its timer completes and remove only non-durability
   * bookkeeping."
   *
   * Failed saves are retried only after re-establishing their captured context
   * and checking the probe token captured in that same context.
   */
  cleanupSession(sessionId: string): void {
    const prefix = `${sessionId}:`;

    for (const [key, entry] of this.failedMemorySaves) {
      if (!key.startsWith(prefix)) continue;
      void this.runInSaveContext(entry.context, () =>
        this.retryLedgerEntryIfAlive(key, entry, 'Session cleanup')
      ).catch((error) => {
        // The retry helper handles storage failures itself, but retain the ledger
        // if context restoration fails before the retry can run.
        logger.error(`[MCPAQLHandler] Session cleanup could not retry memory '${key}': ${error}`);
      });
    }

    // Non-durability bookkeeping only. Pending saves and their timers are left
    // intact so they fire — and persist — in their propagated per-user context.
    this.deleteByPrefix(this.saveFrequencyCounters, prefix);
  }

  async dispose(): Promise<void> {
    await this.flushPendingSaves();
  }

  /**
   * Issue #2329: on shutdown, flush every pending debounced save, then retry any
   * memory still in the failure ledger. saveMemoryTracked clears a key on
   * success, so the second loop only re-attempts genuinely unwritten memories.
   * Unrecoverable losses are reported loudly. Unlike session cleanup, shutdown
   * is a last-ditch best-effort flush across all sessions.
   *
   * Multi-user handling: this runs at process shutdown, outside the per-session
   * debounce timers' propagated AsyncLocalStorage context. Each pending and failed
   * save captures its owning session's context when it is scheduled, and the flush
   * re-establishes that context (runInSaveContext) before writing, so in file mode
   * with a per-user layout each save resolves to the owning user's dir rather than
   * the shared baseDir. When no context was captured (stdio/single-user) the write
   * proceeds context-less as before.
   */
  async flushPendingSaves(): Promise<void> {
    const pending = [...this.pendingSaves.entries()];
    this.pendingSaves.clear();
    if (pending.length > 0) {
      logger.info(`[MCPAQLHandler] Flushing ${pending.length} pending memory save(s) on shutdown (total coalesced: ${this.debounceMetrics.coalesced}, total written: ${this.debounceMetrics.written})`);
    }
    const flushedKeys = new Set<string>();
    for (const [key, { timer, memory, manager, context, persistenceVersion }] of pending) {
      clearTimeout(timer);
      flushedKeys.add(key);
      await this.flushOne(key, memory, manager, 'shutdown', context, persistenceVersion);
    }
    // Retry any failure-ledger entry not already attempted above. Direct Map
    // iteration is safe: saveMemoryTracked only deletes the current key on
    // success, which the iteration protocol tolerates.
    for (const [key, entry] of this.failedMemorySaves) {
      if (flushedKeys.has(key)) continue;
      const recovered = await this.runInSaveContext(entry.context, () =>
        this.retryLedgerEntryIfAlive(key, entry, 'Shutdown retry')
      );
      if (recovered) {
        this.debounceMetrics.written++;
      }
    }
  }

  /** Write one tracked save during shutdown flush, reporting unrecoverable loss. */
  private async flushOne(
    key: string,
    memory: Memory,
    manager: MemoryManager,
    reason: string,
    context: ExecutionContext | undefined,
    persistenceVersion: MemoryPersistenceVersion,
  ): Promise<void> {
    try {
      // Re-establish the save's originating per-user context. Shutdown runs with
      // no ambient AsyncLocalStorage context, so without this a file-mode
      // per-user save would resolve to the shared baseDir instead of the owner's.
      const persisted = await this.runInSaveContext(
        context,
        () => this.saveMemoryTracked(key, memory, manager, persistenceVersion),
      );
      if (persisted) this.debounceMetrics.written++;
    } catch (err) {
      const entryCount = typeof memory.getEntries === 'function' ? memory.getEntries().size : 'unknown';
      logger.error(`[MCPAQLHandler] Flush save failed for memory '${key}' on ${reason} (entries: ${entryCount}) — unpersisted entries will be lost if the process exits: ${err}`);
    }
  }

  /** Run a save within a previously-captured per-user context when one is
   *  available (and the tracker supports it); otherwise run directly. */
  private runInSaveContext<T>(context: ExecutionContext | undefined, fn: () => Promise<T>): Promise<T> {
    if (context && this.contextScope?.runAsync) {
      return this.contextScope.runAsync(context, fn);
    }
    return fn();
  }

  /**
   * Retry an in-memory failed save unless its original storage target is
   * positively confirmed deleted. Ambiguous probe failures retain the data and
   * retry, because dropping the only in-memory copy would be irreversible.
   */
  private async retryLedgerEntryIfAlive(
    key: string,
    entry: FailedSave,
    context: string,
  ): Promise<boolean> {
    let confirmedDeleted = false;
    try {
      confirmedDeleted = await entry.manager.isMemoryDeletedAt(entry.probeToken);
    } catch (probeError) {
      logger.warn(
        `[MCPAQLHandler] ${context}: could not confirm whether memory '${key}' still exists ` +
        `(${probeError instanceof Error ? probeError.message : probeError}); retrying the save`
      );
    }
    if (confirmedDeleted) {
      logger.info(
        `[MCPAQLHandler] ${context}: memory '${key}' was deleted; dropping failed-save bookkeeping`
      );
      this.persistenceCoordinator.release(entry.persistenceVersion);
      this.failedMemorySaves.delete(key);
      this.memorySaveAttempts.delete(key);
      return false;
    }
    try {
      const persisted = await this.retryFailedSave(key, entry);
      return persisted;
    } catch (error) {
      logger.error(
        `[MCPAQLHandler] ${context} retry failed for memory '${key}': ${error}`
      );
      return false;
    }
  }

  getSaveFrequencyCountersForTesting(): Map<string, SaveFrequencyCounter> {
    return this.saveFrequencyCounters;
  }

  trackSaveFrequencyForTesting(memoryName: string): void {
    this.trackSaveFrequency(memoryName);
  }

  /**
   * Issue #2329: drop all save bookkeeping for a deleted memory. Called by
   * MCPAQLHandler after a successful delete_element so a retained failure-ledger
   * instance or a pending debounce timer can't re-save the in-RAM state and
   * resurrect the deleted file. The shared persistence coordinator also orders
   * saves already in flight against deletion and rejects saves whose generation
   * was captured before the delete.
   */
  cleanupDeletedMemory(memoryName: string): void {
    const key = this.memorySaveKey(memoryName);
    const pending = this.pendingSaves.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(key);
      this.persistenceCoordinator.release(pending.persistenceVersion);
    }
    this.failedMemorySaves.delete(key);
    this.memorySaveAttempts.delete(key);
    this.saveFrequencyCounters.delete(key);
  }

  async runDeleteExclusive<T>(memoryName: string, operation: () => Promise<T>): Promise<T> {
    const bookkeepingKey = this.memorySaveKey(memoryName);
    const persistenceKey = this.memoryPersistenceKey(memoryName);
    return this.persistenceCoordinator.runDelete(persistenceKey, async () => {
      const result = await this.handlers.memoryManager.runFileDeleteExclusive(
        memoryName,
        operation,
      );
      // Deletion is the commit point. Until storage confirms success, retain an
      // acknowledged pending save so shutdown flushing can still make it durable.
      // The coordinator invalidates the captured save generation before releasing
      // this delete lock, so clearing here cannot let an already-queued save revive
      // a successfully deleted memory.
      const pending = this.pendingSaves.get(bookkeepingKey);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSaves.delete(bookkeepingKey);
        this.persistenceCoordinator.release(pending.persistenceVersion);
      }
      this.failedMemorySaves.delete(bookkeepingKey);
      this.memorySaveAttempts.delete(bookkeepingKey);
      this.saveFrequencyCounters.delete(bookkeepingKey);
      return result;
    });
  }

  private async addEntry(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
    params: Record<string, unknown>,
    persistenceVersion: MemoryPersistenceVersion,
  ): Promise<unknown> {
    if (params.entry !== undefined && params.content === undefined) {
      params.content = params.entry;
    }
    this.validateContent(memoryName, params);
    const content = params.content as string;
    const tags = params.tags as string[] | undefined;
    const metadata = params.metadata as Record<string, unknown> | undefined;

    // Issue #2329: operate on the authoritative instance. Unpersisted entries
    // live only in the instance held by the failure ledger or a pending
    // debounced save; after cache eviction find() reloads a fresh copy from
    // disk that lacks them, and writing through that copy would clobber the
    // recovered state.
    const saveKey = this.memorySaveKey(memoryName);
    const priorFailure = this.failedMemorySaves.get(saveKey);
    const targetMemory = priorFailure?.memory ?? this.pendingSaves.get(saveKey)?.memory ?? memory;

    // Issue #2329: if a previous save of this memory failed (e.g. disk error),
    // recover before accepting more entries — otherwise they pile up in RAM
    // behind the same failure and are lost on restart.
    if (priorFailure) {
      try {
        const recovered = await this.retryFailedSave(saveKey, priorFailure);
        if (!recovered) {
          throw new Error(`Memory '${memoryName}' was deleted while its prior save was pending`);
        }
      } catch (retryErr) {
        throw new Error(
          `Entry NOT saved: memory '${memoryName}' has unpersisted entries from an earlier save failure ` +
          `(${priorFailure.error.message}) and the retry also failed: ` +
          `${retryErr instanceof Error ? retryErr.message : retryErr}`
        );
      }
    }

    const persistEntry = async (currentMemory: Memory, coordinatorLockHeld = false) => {
      const expectedPersistedToken = manager.isDatabaseBacked?.() === true
        ? undefined
        : await manager.getMemoryStateToken(currentMemory);
      const entriesBefore = currentMemory.getEntries().size;
      const entryResult = await currentMemory.addEntry(content, tags, metadata);

      // Validate the complete serialized memory before touching durable state.
      try {
        await manager.assertPersistable(currentMemory);
      } catch (validationErr) {
        currentMemory.removeEntry(entryResult.id);
        // Retention may have evicted old entries before validation failed. Make
        // that policy result durable rather than leaving RAM and storage split.
        if (currentMemory.getEntries().size !== entriesBefore) {
          await manager.save(currentMemory, undefined, { durable: true });
        }
        throw new Error(
          `Entry NOT saved to memory '${memoryName}': ` +
          `${validationErr instanceof Error ? validationErr.message : validationErr}`
        );
      }

      this.trackSaveFrequency(memoryName);
      try {
        // Both backends persist before acknowledgement. File mode additionally
        // requests fsync-backed publication while holding its interprocess guard.
        const saveOptions = manager.isDatabaseBacked?.() === true ? undefined : { durable: true };
        const persisted = coordinatorLockHeld
          ? await this.saveMemoryTrackedUnlocked(
              saveKey,
              currentMemory,
              manager,
              persistenceVersion,
              false,
              saveOptions,
              expectedPersistedToken,
            ).then(() => true)
          : await this.saveMemoryTracked(
              saveKey,
              currentMemory,
              manager,
              persistenceVersion,
              false,
              saveOptions,
              expectedPersistedToken,
            );
        if (!persisted) {
          throw new MemoryPersistenceConflictError(memoryName);
        }
      } catch (saveError) {
        currentMemory.removeEntry(entryResult.id);
        this.failedMemorySaves.delete(saveKey);
        this.memorySaveAttempts.delete(saveKey);
        manager.recoverMemoryPersistenceConflict?.(currentMemory);
        throw new Error(
          `Entry NOT saved to memory '${memoryName}': ` +
          `${saveError instanceof Error ? saveError.message : saveError}`,
        );
      }
      // Entry prose begins as untrusted. Return only server-generated receipt
      // fields so the mutation response cannot bypass later rendering controls.
      return {
        id: entryResult.id,
        timestamp: entryResult.timestamp.toISOString(),
        trustLevel: entryResult.trustLevel,
      };
    };

    const outcome = await this.persistenceCoordinator.runMutation(
      persistenceVersion,
      () => manager.isDatabaseBacked?.() === true
        ? persistEntry(targetMemory, true)
        : manager.runFileMutationExclusive(targetMemory, current => persistEntry(current, true)),
    );
    if (!outcome.accepted) {
      this.failedMemorySaves.delete(saveKey);
      this.memorySaveAttempts.delete(saveKey);
      manager.recoverMemoryPersistenceConflict?.(targetMemory);
      throw new MemoryPersistenceConflictError(memoryName);
    }
    return outcome.value;
  }

  private validateContent(memoryName: string, params: Record<string, unknown>): void {
    if (typeof params.content === 'string' && params.content.trim() !== '') {
      return;
    }
    const hint = params.entry === undefined
      ? `The 'content' parameter is the text portion of the memory entry.`
      : `You passed 'entry', but an entry is the full object (content + tags + metadata + timestamp). ` +
        `Use 'content' to provide the text portion of the entry.`;
    throw new Error(
      `Missing required parameter 'content'. ${hint} ` +
      `Example: { operation: "addEntry", params: { element_name: "${memoryName}", content: "your text here", tags: ["optional"] } }`
    );
  }

  private async clear(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
    persistenceVersion: MemoryPersistenceVersion,
  ): Promise<unknown> {
    // Issue #2329: cancel any pending debounced save first — a stale timer
    // firing after the clear would resurrect the pre-clear entries on disk.
    const clearKey = this.memorySaveKey(memoryName);
    const pendingClear = this.pendingSaves.get(clearKey);
    if (pendingClear) {
      clearTimeout(pendingClear.timer);
      this.pendingSaves.delete(clearKey);
      this.persistenceCoordinator.release(pendingClear.persistenceVersion);
    }
    const clearAndPersist = async (currentMemory: Memory, coordinatorLockHeld = false): Promise<unknown> => {
      const expectedPersistedToken = manager.isDatabaseBacked?.() === true
        ? undefined
        : await manager.getMemoryStateToken(currentMemory);
      const clearResult = await currentMemory.clearAll(true);
      // Fix #438: persist so cleared state survives restart. Tracked so a success
      // clears any stale failure record for this memory.
      const saveOptions = manager.isDatabaseBacked?.() === true ? undefined : { durable: true };
      const persisted = coordinatorLockHeld
        ? await this.saveMemoryTrackedUnlocked(
            clearKey,
            currentMemory,
            manager,
            persistenceVersion,
            false,
            saveOptions,
            expectedPersistedToken,
          ).then(() => true)
        : await this.saveMemoryTracked(
            clearKey,
            currentMemory,
            manager,
            persistenceVersion,
            false,
            saveOptions,
            expectedPersistedToken,
          );
      if (!persisted) {
        throw new MemoryPersistenceConflictError(memoryName);
      }
      return clearResult;
    };

    let outcome;
    try {
      outcome = await this.persistenceCoordinator.runMutation(
        persistenceVersion,
        () => manager.isDatabaseBacked?.() === true
          ? clearAndPersist(memory, true)
          : manager.runFileMutationExclusive(memory, current => clearAndPersist(current, true)),
      );
    } catch (error) {
      this.failedMemorySaves.delete(clearKey);
      this.memorySaveAttempts.delete(clearKey);
      // clearAll mutates the loaded object before persistence. Retire that
      // snapshot after any failed save so a later write must reload durable
      // entries instead of committing the already-cleared cache.
      manager.recoverMemoryPersistenceConflict?.(memory);
      throw error;
    }
    if (!outcome.accepted) {
      this.failedMemorySaves.delete(clearKey);
      this.memorySaveAttempts.delete(clearKey);
      manager.recoverMemoryPersistenceConflict?.(memory);
      throw new MemoryPersistenceConflictError(memoryName);
    }
    return outcome.value;
  }

  private debouncedMemorySave(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
    persistenceVersion = this.persistenceCoordinator.capture(
      this.memoryPersistenceKey(memoryName),
    ),
  ): void {
    const key = this.memorySaveKey(memoryName);
    // Capture the originating per-user context now, while a request context is
    // active, so a shutdown flush (which runs with none) can re-establish it.
    const context = this.contextScope?.getContext?.();
    const existing = this.pendingSaves.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.persistenceCoordinator.release(existing.persistenceVersion);
      this.debounceMetrics.coalesced++;
      logger.debug(`[MCPAQLHandler] Coalesced save for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
    }
    const timer = setTimeout(() => {
      this.pendingSaves.delete(key);
      logger.debug(`[MCPAQLHandler] Flushing debounced save for memory '${memoryName}' (coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
      this.saveMemoryTracked(key, memory, manager, persistenceVersion).then((persisted) => {
        if (persisted) this.debounceMetrics.written++;
      }).catch((err) => {
        logger.error(`[MCPAQLHandler] Debounced save failed for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written}): ${err}`);
      });
    }, STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
    this.pendingSaves.set(key, { timer, memory, manager, context, persistenceVersion });
  }

  /**
   * Issue #2329: save a memory with failure-ledger bookkeeping. On failure the
   * ledger records the error AND the failing instance (its unpersisted entries
   * exist nowhere else); on success the record clears. The attempt counter makes
   * the newest-started save win: an older in-flight save resolving late cannot
   * erase a newer failure. Rethrows the save error.
   */
  private async saveMemoryTracked(
    key: string,
    memory: Memory,
    manager: MemoryManager,
    persistenceVersion = this.persistenceCoordinator.capture(
      this.memoryPersistenceKey(memory.metadata.name),
    ),
    retainFailure = true,
    saveOptions?: { durable?: boolean },
    expectedPersistedToken?: string,
  ): Promise<boolean> {
    const persisted = await this.persistenceCoordinator.runSave(
      persistenceVersion,
      () => this.saveMemoryTrackedUnlocked(
        key,
        memory,
        manager,
        persistenceVersion,
        retainFailure,
        saveOptions,
        expectedPersistedToken,
      ),
    );
    if (!persisted) {
      // The memory was deleted after this save was scheduled. Retire the stale
      // session-local ledger entry instead of retrying it on cleanup/shutdown.
      this.failedMemorySaves.delete(key);
      this.memorySaveAttempts.delete(key);
      manager.recoverMemoryPersistenceConflict?.(memory);
    }
    return persisted;
  }

  private async saveMemoryTrackedUnlocked(
    key: string,
    memory: Memory,
    manager: MemoryManager,
    persistenceVersion: MemoryPersistenceVersion,
    retainFailure: boolean,
    saveOptions?: { durable?: boolean },
    expectedPersistedToken?: string,
  ): Promise<void> {
    const attempt = (this.memorySaveAttempts.get(key) ?? 0) + 1;
    this.memorySaveAttempts.set(key, attempt);
    try {
      await manager.save(memory, undefined, saveOptions);
      if (retainFailure && this.memorySaveAttempts.get(key) === attempt) {
        const previousFailure = this.failedMemorySaves.get(key);
        if (previousFailure?.persistenceVersion !== persistenceVersion) {
          if (previousFailure) this.persistenceCoordinator.release(previousFailure.persistenceVersion);
        }
        this.failedMemorySaves.delete(key);
        // Prune the counter on latest-success so the map stays bounded by
        // currently-failing memories. A stale in-flight save then sees
        // undefined !== its attempt and correctly skips ledger updates.
        this.memorySaveAttempts.delete(key);
      } else if (!retainFailure && this.memorySaveAttempts.get(key) === attempt) {
        this.failedMemorySaves.delete(key);
        this.memorySaveAttempts.delete(key);
      }
    } catch (err) {
      if (err instanceof MemoryPersistenceConflictError) {
        this.failedMemorySaves.delete(key);
        this.memorySaveAttempts.delete(key);
        manager.recoverMemoryPersistenceConflict?.(memory);
        throw err;
      }
      if (retainFailure && this.memorySaveAttempts.get(key) === attempt) {
        const previousFailure = this.failedMemorySaves.get(key);
        if (previousFailure?.persistenceVersion !== persistenceVersion) {
          if (previousFailure) this.persistenceCoordinator.release(previousFailure.persistenceVersion);
        }
        this.failedMemorySaves.set(key, {
          error: err instanceof Error ? err : new Error(String(err)),
          memory,
          manager,
          probeToken: manager.getMemoryProbeToken(memory),
          // getContext() here returns the ambient context on the normal debounced
          // path, and the re-established context when retried from the shutdown
          // flush (flushOne runs saveMemoryTracked inside runInSaveContext).
          context: this.contextScope?.getContext?.(),
          persistenceVersion,
          expectedPersistedToken,
        });
      } else if (!retainFailure && this.memorySaveAttempts.get(key) === attempt) {
        this.failedMemorySaves.delete(key);
        this.memorySaveAttempts.delete(key);
      }
      throw err;
    }
  }

  private async retryFailedSave(key: string, entry: FailedSave): Promise<boolean> {
    const retry = async (current?: Memory): Promise<void> => {
      if (entry.expectedPersistedToken !== undefined) {
        if (!current) throw new MemoryPersistenceConflictError(entry.memory.metadata.name);
        const currentToken = await entry.manager.getMemoryStateToken(current);
        if (currentToken !== entry.expectedPersistedToken) {
          throw new MemoryPersistenceConflictError(entry.memory.metadata.name);
        }
      }
      await this.saveMemoryTrackedUnlocked(
        key,
        entry.memory,
        entry.manager,
        entry.persistenceVersion,
        true,
        entry.manager.isDatabaseBacked?.() === true ? undefined : { durable: true },
        entry.expectedPersistedToken,
      );
    };
    const outcome = await this.persistenceCoordinator.runMutation(
      entry.persistenceVersion,
      () => entry.manager.isDatabaseBacked?.() === true
        ? retry()
        : entry.manager.runFileMutationExclusive(entry.memory, retry),
    );
    if (!outcome.accepted) {
      this.failedMemorySaves.delete(key);
      this.memorySaveAttempts.delete(key);
      entry.manager.recoverMemoryPersistenceConflict?.(entry.memory);
    }
    return outcome.accepted;
  }

  /**
   * Normalized, session-scoped key shared by pendingSaves, failedMemorySaves,
   * memorySaveAttempts, and saveFrequencyCounters. All memory-save bookkeeping
   * must use this — a mismatched key silently disconnects the failure ledger
   * from recovery (#2329), and the session prefix keeps one HTTP user's saves
   * from touching another's (integration multi-user isolation).
   */
  private memorySaveKey(memoryName: string): string {
    return this.sessionKey(memoryName.toLowerCase());
  }

  private memoryPersistenceKey(
    memoryName: string,
    context = this.contextScope?.getContext?.(),
  ): string {
    const userId = context?.session?.userId ?? 'local';
    return `${userId}:${memoryName.normalize('NFC').trim().toLowerCase()}`;
  }

  private trackSaveFrequency(memoryName: string): void {
    const key = this.memorySaveKey(memoryName);
    const now = Date.now();
    const windowMs = STORAGE_LAYER_CONFIG.MEMORY_SAVE_MONITOR_WINDOW_MS;
    const warnThreshold = STORAGE_LAYER_CONFIG.MEMORY_SAVE_FREQUENCY_WARN_THRESHOLD;
    const criticalThreshold = STORAGE_LAYER_CONFIG.MEMORY_SAVE_FREQUENCY_CRITICAL_THRESHOLD;

    const counter = this.getFrequencyCounter(key);
    counter.timestamps = counter.timestamps.filter(t => t > now - windowMs);
    counter.timestamps.push(now);

    this.reportFrequencyThresholds(memoryName, counter, windowMs, warnThreshold, criticalThreshold);
    if (counter.timestamps.length < warnThreshold) {
      counter.warned = false;
      counter.critical = false;
    }
  }

  private getFrequencyCounter(key: string): SaveFrequencyCounter {
    let counter = this.saveFrequencyCounters.get(key);
    if (counter) {
      return counter;
    }
    if (this.saveFrequencyCounters.size >= 500) {
      const oldestKey = this.saveFrequencyCounters.keys().next().value;
      if (oldestKey) this.saveFrequencyCounters.delete(oldestKey);
    }
    counter = { timestamps: [], warned: false, critical: false };
    this.saveFrequencyCounters.set(key, counter);
    return counter;
  }

  private reportFrequencyThresholds(
    memoryName: string,
    counter: SaveFrequencyCounter,
    windowMs: number,
    warnThreshold: number,
    criticalThreshold: number,
  ): void {
    const count = counter.timestamps.length;
    if (count >= criticalThreshold && !counter.critical) {
      counter.critical = true;
      logger.error('[MCPAQLHandler] Save frequency critical threshold exceeded', {
        memoryName,
        count,
        threshold: criticalThreshold,
        windowSeconds: windowMs / 1000,
        trackedMemories: this.saveFrequencyCounters.size,
      });
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'HIGH',
        source: 'MCPAQLHandler.trackSaveFrequency',
        details: `Memory '${memoryName}' exceeds critical save frequency: ${count} calls in ${windowMs / 1000}s`,
        additionalData: { memoryName, count, threshold: criticalThreshold, windowMs },
      });
    } else if (count >= warnThreshold && !counter.warned) {
      counter.warned = true;
      logger.warn('[MCPAQLHandler] Save frequency warn threshold exceeded', {
        memoryName,
        count,
        threshold: warnThreshold,
        windowSeconds: windowMs / 1000,
      });
    }
  }

  private deleteByPrefix(collection: Map<string, unknown>, prefix: string): void {
    for (const key of collection.keys()) {
      if (key.startsWith(prefix)) {
        collection.delete(key);
      }
    }
  }
}
