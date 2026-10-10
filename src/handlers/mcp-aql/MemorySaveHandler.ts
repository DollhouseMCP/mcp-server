import { MEMORY_SECURITY_EVENTS } from '../../elements/memories/constants.js';
import { STORAGE_LAYER_CONFIG } from '../../config/performance-constants.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import type { MemoryManager } from '../../elements/memories/MemoryManager.js';
import type { Memory } from '../../elements/memories/Memory.js';
import type { ExecutionContext } from '../../security/encryption/ContextTracker.js';
import type { HandlerRegistry } from './MCPAQLHandler.js';
import { validateRequiredString } from './shared.js';

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
}

export interface GuardedMutationPending {
  readonly status: 'preparing' | 'refused' | 'unknown' | 'known-committed';
  readonly candidate?: Memory;
  readonly manager: MemoryManager;
  readonly cause?: unknown;
}

export class MemorySaveHandler {
  /** Serialize append validation and clear for the same in-process Memory object. */
  private static readonly mutationTails = new WeakMap<Memory, Promise<void>>();
  private readonly guardedMutations = new Map<string, GuardedMutationPending>();
  private deferredSavesRefused = false;
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
  ) {}

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const manager = this.handlers.memoryManager;
    const memoryName = validateRequiredString(
      params,
      'element_name',
      'the name of the memory to operate on'
    );

    if (manager.isGuardedHeadUpdateEnabled?.()) {
      this.observeDeferredRefusal(manager);
      if (this.pendingSaves.size || this.failedMemorySaves.size) throw this.deferredRefusal();
      return this.dispatchGuarded(method, memoryName, manager, params);
    }
    this.requireLegacyDeferred(manager);

    const memory = await manager.find(m => m.metadata.name === memoryName);
    if (!memory) {
      throw new Error(`Memory '${memoryName}' not found. Use list_elements to see available memories.`);
    }

    switch (method) {
      case 'addEntry':
        return this.addEntry(memoryName, memory, manager, params);
      case 'clear':
        return this.clear(memoryName, memory, manager);
      default:
        throw new Error(`Unknown Memory method: ${method}`);
    }
  }

  /** Conservative whole-handler latch; never an inference of another process's durable mode. */
  private observeDeferredRefusal(manager: MemoryManager = this.handlers.memoryManager): boolean {
    if (manager.isGuardedHeadUpdateEnabled?.() || this.handlers.memoryManager.isGuardedHeadUpdateEnabled?.()) {
      this.deferredSavesRefused = true;
    }
    if (this.deferredSavesRefused) {
      // Cancelling execution preserves the only queued candidate and its context.
      for (const pending of this.pendingSaves.values()) clearTimeout(pending.timer);
    }
    return this.deferredSavesRefused;
  }

  private deferredRefusal(): Error {
    return Object.assign(new Error('Deferred memory work is refused and retained; explicit recovery is required'),
      { code: 'EDEFERREDMEMORY' });
  }

  private requireLegacyDeferred(manager: MemoryManager): void {
    if (this.observeDeferredRefusal(manager)) throw this.deferredRefusal();
  }

  private guardedContext(memoryName: string, manager: MemoryManager): { key: string; userId: string; check: () => void } {
    const session = this.contextScope?.getContext?.()?.session;
    if (!session || typeof session.userId !== 'string' || !session.userId || typeof session.sessionId !== 'string' || !session.sessionId || (session.tenantId !== null && typeof session.tenantId !== 'string')) throw new Error('Guarded mutation requires authenticated session context');
    const { userId, sessionId, tenantId } = session;
    const effectiveUserId = manager.captureGuardedTenant();
    const key = JSON.stringify([userId, sessionId, tenantId, memoryName.normalize('NFC').toLowerCase(), effectiveUserId]);
    return { key, userId: effectiveUserId, check: () => {
      const current = this.contextScope?.getContext?.()?.session;
      if (current?.userId !== userId || current.sessionId !== sessionId || current.tenantId !== tenantId || manager.captureGuardedTenant() !== effectiveUserId) {
        throw Object.assign(new Error('Memory mutation session changed'), { code: 'EHEADCONFLICT' });
      }
    } };
  }

  /** Retained request evidence only; never authorizes retry or token refresh. */
  getPendingGuardedMutation(memoryName: string): GuardedMutationPending | undefined {
    return this.guardedMutations.get(this.guardedContext(memoryName, this.handlers.memoryManager).key);
  }

  private async dispatchGuarded(method: string, memoryName: string, manager: MemoryManager, params: Record<string, unknown>): Promise<unknown> {
    const context = this.guardedContext(memoryName, manager);
    if (this.guardedMutations.has(context.key)) throw Object.assign(new Error('Memory mutation is pending; retain changes and resolve before another request'), { code: 'EHEADCONFLICT' });
    this.guardedMutations.set(context.key, Object.freeze({ status: 'preparing', manager }));
    let candidate: Memory | undefined;
    let accepted = false;
    let committed = false;
    try {
      if (method !== 'addEntry' && method !== 'clear') throw new Error(`Unknown Memory method: ${method}`);
      if (method === 'addEntry') {
        if (params.entry !== undefined && params.content === undefined) params.content = params.entry;
        this.validateContent(memoryName, params);
      }
      const source = await manager.loadGuardedMemoryByName(memoryName, context.userId);
      context.check();
      candidate = manager.deriveGuardedMutation(source);
      const removedBefore = candidate.getPolicyRemovedCount();
      const clearCount = candidate.getEntries().size;
      const { response, audit, removedCount } = await this.prepareGuardedMutation(method, memoryName, candidate, params, removedBefore, clearCount);
      await manager.assertPersistable(candidate);
      context.check();
      accepted = true;
      await manager.save(candidate);
      committed = true;
      context.check();
      SecurityMonitor.logSecurityEvent(audit);
      if (removedCount > 0) SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED, severity: 'MEDIUM',
        source: 'MemorySaveHandler.guardedMutation', details: `Durably removed ${removedCount} entries by retention or onFull policy`,
      });
      this.guardedMutations.delete(context.key);
      return response;
    } catch (cause) {
      const pending = candidate && manager.getPendingHeadUpdate(candidate);
      if (accepted || pending) {
        const status = this.classifyGuardedOutcome(committed, pending);
        this.guardedMutations.set(context.key, Object.freeze({ status, candidate, manager, cause }));
      } else this.guardedMutations.delete(context.key);
      throw cause;
    }
  }

  /** Known durable commit takes precedence over pending unknown/refusal evidence. */
  private classifyGuardedOutcome(committed: boolean, pending: ReturnType<MemoryManager['getPendingHeadUpdate']>): GuardedMutationPending['status'] {
    if (committed || pending?.status === 'committed-publication-failed') return 'known-committed';
    if (pending?.status === 'unknown') return 'unknown';
    return 'refused';
  }

  /** Prepare candidate state and plain response fields before any backend attempt. */
  private async prepareGuardedMutation(method: string, memoryName: string, candidate: Memory, params: Record<string, unknown>, removedBefore: number, clearCount: number) {
    let response: unknown;
    let removedCount = 0;
    let audit: Parameters<typeof SecurityMonitor.logSecurityEvent>[0];
    if (method === 'addEntry') {
      await candidate.enforceCandidateLoadRetention();
      const entry = await candidate.addEntry(params.content as string, params.tags as string[] | undefined, params.metadata as Record<string, unknown> | undefined);
      removedCount = candidate.getPolicyRemovedCount() - removedBefore;
      response = { id: entry.id, timestamp: entry.timestamp.toISOString(), trustLevel: entry.trustLevel,
        ...this.removalWarningFields(memoryName, removedCount) };
      audit = { type: MEMORY_SECURITY_EVENTS.MEMORY_ADDED, severity: 'LOW', source: 'MemorySaveHandler.guardedMutation', details: `Durably added memory entry ${entry.id}` };
    } else {
      await candidate.clearAll(true);
      response = undefined;
      audit = { type: MEMORY_SECURITY_EVENTS.MEMORY_CLEARED, severity: 'HIGH', source: 'MemorySaveHandler.guardedMutation', details: `Durably cleared all ${clearCount} memory entries` };
    }
    return { response, audit, removedCount };
  }

  private reportGuardedPending(sessionId?: string): void {
    const counts = { preparing: 0, refused: 0, unknown: 0, 'known-committed': 0 };
    for (const [key, operation] of this.guardedMutations) {
      if (sessionId !== undefined && (JSON.parse(key) as string[])[1] !== sessionId) continue;
      counts[operation.status]++;
    }
    if (Object.values(counts).some(count => count > 0)) {
      logger.warn(`[MCPAQLHandler] Guarded mutation outcomes retained without replay: preparing=${counts.preparing}, refused=${counts.refused}, unknown=${counts.unknown}, known-committed=${counts['known-committed']}`);
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
    this.reportGuardedPending(sessionId);
    const prefix = `${sessionId}:`;
    if (this.observeDeferredRefusal()) return;

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
    this.reportGuardedPending();
    if (this.observeDeferredRefusal() && (this.pendingSaves.size || this.failedMemorySaves.size)) throw this.deferredRefusal();
    const pending = [...this.pendingSaves.entries()];
    for (const [, entry] of pending) clearTimeout(entry.timer);
    if (pending.length > 0) {
      logger.info(`[MCPAQLHandler] Flushing ${pending.length} pending memory save(s) on shutdown (total coalesced: ${this.debounceMetrics.coalesced}, total written: ${this.debounceMetrics.written})`);
    }
    const flushedKeys = new Set<string>();
    for (const [key, entry] of pending) {
      const { memory, manager, context } = entry;
      flushedKeys.add(key);
      const saved = await this.flushOne(key, memory, manager, 'shutdown', context);
      // A closed boundary/context failure must not drop this or later queued
      // candidates. Preserve newer coalesced work under the same key too.
      if (this.pendingSaves.get(key) === entry &&
        (saved || this.failedMemorySaves.get(key)?.memory === memory)) this.pendingSaves.delete(key);
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
  private async flushOne(key: string, memory: Memory, manager: MemoryManager, reason: string, context?: ExecutionContext): Promise<boolean> {
    try {
      // Re-establish the save's originating per-user context. Shutdown runs with
      // no ambient AsyncLocalStorage context, so without this a file-mode
      // per-user save would resolve to the shared baseDir instead of the owner's.
      await this.runInSaveContext(context, () => this.saveMemoryTracked(key, memory, manager));
      this.debounceMetrics.written++;
      return true;
    } catch (err) {
      if (this.observeDeferredRefusal(manager)) throw err;
      const entryCount = typeof memory.getEntries === 'function' ? memory.getEntries().size : 'unknown';
      logger.error(`[MCPAQLHandler] Flush save failed for memory '${key}' on ${reason} (entries: ${entryCount}) — unpersisted entries will be lost if the process exits: ${err}`);
      return false;
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
    this.requireLegacyDeferred(entry.manager);
    let confirmedDeleted = false;
    try {
      confirmedDeleted = await entry.manager.isMemoryDeletedAt(entry.probeToken);
    } catch (probeError) {
      logger.warn(
        `[MCPAQLHandler] ${context}: could not confirm whether memory '${key}' still exists ` +
        `(${probeError instanceof Error ? probeError.message : probeError}); retrying the save`
      );
    }
    this.requireLegacyDeferred(entry.manager);
    if (confirmedDeleted) {
      logger.info(
        `[MCPAQLHandler] ${context}: memory '${key}' was deleted; dropping failed-save bookkeeping`
      );
      this.failedMemorySaves.delete(key);
      this.memorySaveAttempts.delete(key);
      return false;
    }
    try {
      await this.saveMemoryTracked(key, entry.memory, entry.manager);
      return true;
    } catch (error) {
      if (this.observeDeferredRefusal(entry.manager)) throw error;
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
   * resurrect the deleted file. A save already in flight when the delete lands
   * can still race the file back — that narrow window is inherent to
   * fire-and-forget writes and unchanged here.
   */
  cleanupDeletedMemory(memoryName: string): void {
    this.requireLegacyDeferred(this.handlers.memoryManager);
    const key = this.memorySaveKey(memoryName);
    const pending = this.pendingSaves.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(key);
    }
    this.failedMemorySaves.delete(key);
    this.memorySaveAttempts.delete(key);
    this.saveFrequencyCounters.delete(key);
  }

  private async addEntry(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
    params: Record<string, unknown>
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

    return MemorySaveHandler.withMemoryMutation(targetMemory, () =>
      this.appendValidated(memoryName, targetMemory, manager, saveKey, priorFailure, content, tags, metadata)
    );
  }

  private static async withMemoryMutation<T>(memory: Memory, mutate: () => Promise<T>): Promise<T> {
    const prior = MemorySaveHandler.mutationTails.get(memory) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => gate);
    MemorySaveHandler.mutationTails.set(memory, tail);
    await prior;
    try {
      return await mutate();
    } finally {
      release();
      if (MemorySaveHandler.mutationTails.get(memory) === tail) {
        MemorySaveHandler.mutationTails.delete(memory);
      }
    }
  }

  private async appendValidated(
    memoryName: string,
    targetMemory: Memory,
    manager: MemoryManager,
    saveKey: string,
    priorFailure: FailedSave | undefined,
    content: string,
    tags: string[] | undefined,
    metadata: Record<string, unknown> | undefined,
  ): Promise<unknown> {

    // Issue #2329: if a previous save of this memory failed (e.g. disk error),
    // recover before accepting more entries — otherwise they pile up in RAM
    // behind the same failure and are lost on restart.
    this.requireLegacyDeferred(manager);
    if (priorFailure) {
      try {
        await this.saveMemoryTracked(saveKey, targetMemory, priorFailure.manager);
      } catch (retryErr) {
        throw new Error(
          `Entry NOT saved: memory '${memoryName}' has unpersisted entries from an earlier save failure ` +
          `(${priorFailure.error.message}) and the retry also failed: ` +
          `${retryErr instanceof Error ? retryErr.message : retryErr}`
        );
      }
    }

    const before = targetMemory.captureAppendState();
    const policyRemovedBefore = targetMemory.getPolicyRemovedCount();
    const candidate = targetMemory.createAppendCandidate();
    let entryResult: Awaited<ReturnType<Memory['addEntry']>>;

    // Issue #2329: verify the memory can still be persisted BEFORE reporting
    // success. The disk write below is deferred (debounced), so a validation
    // failure there can never reach the caller — entries were acknowledged with
    // an id and then silently lost when the memory outgrew save limits.
    try {
      entryResult = await candidate.addEntry(content, tags, metadata);
      await manager.assertPersistable(candidate);
    } catch (validationErr) {
      throw new Error(
        `Entry NOT saved to memory '${memoryName}': ` +
        `${validationErr instanceof Error ? validationErr.message : validationErr}`
      );
    }

    this.requireLegacyDeferred(manager);
    if (!targetMemory.commitAppendCandidate(before, candidate, entryResult)) {
      throw new Error(
        `Entry NOT saved to memory '${memoryName}': memory changed during validation, so the append was not applied. ` +
        `Check the current memory and retry.`
      );
    }

    this.trackSaveFrequency(memoryName);
    this.debouncedMemorySave(memoryName, targetMemory, manager);
    // Issue #2859: removals are never silent. Expired entries and, for memories
    // with onFull 'evict_oldest', the oldest entries can be removed by this add.
    const removedCount = targetMemory.getPolicyRemovedCount() - policyRemovedBefore;
    // Entry prose begins as untrusted. Return only server-generated receipt
    // fields so the mutation response cannot bypass later rendering controls.
    return {
      id: entryResult.id,
      timestamp: entryResult.timestamp.toISOString(),
      trustLevel: entryResult.trustLevel,
      ...this.removalWarningFields(memoryName, removedCount),
    };
  }

  private removalWarningFields(memoryName: string, removedCount: number): { warning?: string } {
    if (removedCount <= 0) {
      return {};
    }
    const noun = removedCount === 1 ? 'entry was' : 'entries were';
    return {
      warning: `${removedCount} existing ${noun} removed from memory ` +
        `'${memoryName}' by its retention policy (expired entries, or the oldest entries when onFull is 'evict_oldest').`,
    };
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

  private async clear(memoryName: string, memory: Memory, manager: MemoryManager): Promise<unknown> {
    const clearKey = this.memorySaveKey(memoryName);
    const targetMemory = this.failedMemorySaves.get(clearKey)?.memory
      ?? this.pendingSaves.get(clearKey)?.memory
      ?? memory;
    return MemorySaveHandler.withMemoryMutation(targetMemory, async () => {
      this.requireLegacyDeferred(manager);
      // Issue #2329: cancel any pending debounced save first — a stale timer
      // firing after the clear would resurrect the pre-clear entries on disk.
      const pendingClear = this.pendingSaves.get(clearKey);
      if (pendingClear) {
        clearTimeout(pendingClear.timer);
        this.pendingSaves.delete(clearKey);
      }
      const clearResult = await targetMemory.clearAll(true);
      // Fix #438: persist so cleared state survives restart. Tracked so a success
      // clears any stale failure record for this memory.
      await this.saveMemoryTracked(clearKey, targetMemory, manager);
      return clearResult;
    });
  }

  private debouncedMemorySave(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
  ): void {
    this.requireLegacyDeferred(manager);
    const key = this.memorySaveKey(memoryName);
    // Capture the originating per-user context now, while a request context is
    // active, so a shutdown flush (which runs with none) can re-establish it.
    const context = this.contextScope?.getContext?.();
    const existing = this.pendingSaves.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.debounceMetrics.coalesced++;
      logger.debug(`[MCPAQLHandler] Coalesced save for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
    }
    const timer = setTimeout(() => {
      if (this.observeDeferredRefusal(manager)) return;
      this.pendingSaves.delete(key);
      this.debounceMetrics.written++;
      logger.debug(`[MCPAQLHandler] Flushing debounced save for memory '${memoryName}' (coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
      this.saveMemoryTracked(key, memory, manager).catch((err) => {
        logger.error(`[MCPAQLHandler] Debounced save failed for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written}): ${err}`);
      });
    }, STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
    this.pendingSaves.set(key, { timer, memory, manager, context });
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
  ): Promise<void> {
    const attempt = (this.memorySaveAttempts.get(key) ?? 0) + 1;
    this.memorySaveAttempts.set(key, attempt);
    try {
      this.requireLegacyDeferred(manager);
      await manager.save(memory);
      // A save already in flight cannot be cancelled. Keep its evidence if the
      // boundary closes before bookkeeping; never claim that it rolled back.
      this.requireLegacyDeferred(manager);
      if (this.memorySaveAttempts.get(key) === attempt) {
        this.failedMemorySaves.delete(key);
        // Prune the counter on latest-success so the map stays bounded by
        // currently-failing memories. A stale in-flight save then sees
        // undefined !== its attempt and correctly skips ledger updates.
        this.memorySaveAttempts.delete(key);
      }
    } catch (err) {
      if (this.memorySaveAttempts.get(key) === attempt) {
        this.failedMemorySaves.set(key, {
          error: err instanceof Error ? err : new Error(String(err)),
          memory,
          manager,
          probeToken: this.deferredSavesRefused ? null : manager.getMemoryProbeToken(memory),
          // getContext() here returns the ambient context on the normal debounced
          // path, and the re-established context when retried from the shutdown
          // flush (flushOne runs saveMemoryTracked inside runInSaveContext).
          context: this.contextScope?.getContext?.(),
        });
      }
      throw err;
    }
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
