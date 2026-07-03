import { STORAGE_LAYER_CONFIG } from '../../config/performance-constants.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import type { MemoryManager } from '../../elements/memories/MemoryManager.js';
import type { Memory } from '../../elements/memories/Memory.js';
import type { HandlerRegistry } from './MCPAQLHandler.js';
import { validateRequiredString } from './shared.js';

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  memory: Memory;
  manager: MemoryManager;
}

/**
 * Issue #2329: record of a memory whose most recent save attempt failed.
 * Holds the failing Memory instance and its manager — the unpersisted entries
 * exist only in that instance, so recovery must retry it (a freshly loaded
 * instance would lack them), and holding the reference keeps it alive across
 * cache eviction.
 *
 * probeToken (Codex P1, PR #2337): the deletion-probe target resolved at
 * record time, while the owning session's path context is still live. Probing
 * via live resolution during dispose/cleanup would fall back to the flat
 * portfolio dir in per-user HTTP mode and misread a live memory as deleted.
 */
interface FailedSave {
  error: Error;
  memory: Memory;
  manager: MemoryManager;
  probeToken: string | null;
}

interface SaveFrequencyCounter {
  timestamps: number[];
  warned: boolean;
  critical: boolean;
}

export class MemorySaveHandler {
  private readonly pendingSaves = new Map<string, PendingSave>();
  private readonly debounceMetrics = { coalesced: 0, written: 0 };
  private readonly saveFrequencyCounters = new Map<string, SaveFrequencyCounter>();
  /**
   * Issue #2329: memories whose most recent save failed. The next addEntry on
   * that memory retries the save synchronously and reports the error to the
   * caller instead of silently accepting more entries; flush/cleanup paths
   * retry these as a last resort.
   */
  private readonly failedMemorySaves = new Map<string, FailedSave>();
  /**
   * Issue #2329: monotonically increasing save-attempt counter per memory key.
   * Guards the failure ledger against reordering: an older in-flight save that
   * resolves after a newer one started must not overwrite the newer attempt's
   * outcome. Pruned on latest-success so the map stays bounded by
   * currently-failing memories.
   */
  private readonly memorySaveAttempts = new Map<string, number>();

  constructor(
    private readonly handlers: HandlerRegistry,
    private readonly sessionKey: (name: string) => string,
  ) {}

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const manager = this.handlers.memoryManager;
    const memoryName = validateRequiredString(
      params,
      'element_name',
      'the name of the memory to operate on'
    );

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

  /**
   * Issue #2329: flush a session's pending and failed saves instead of dropping
   * them — cancelling timers without saving silently discarded entries added
   * within the debounce window (the fresh-memory loss case in the incident).
   * Fire-and-forget: cleanup is synchronous, but the process is still alive.
   */
  cleanupSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const [key, entry] of this.pendingSaves) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        this.pendingSaves.delete(key);
        this.saveMemoryTracked(key, entry.memory, entry.manager).catch((err) => {
          logger.error(`[MCPAQLHandler] Session-cleanup save failed for memory '${key}': ${err}`);
        });
      }
    }
    for (const [key, entry] of this.failedMemorySaves) {
      if (key.startsWith(prefix) && !this.pendingSaves.has(key)) {
        this.retryLedgerEntryIfAlive(key, entry, 'Session-cleanup').finally(() => {
          // Session is gone either way — release the retained instance.
          this.failedMemorySaves.delete(key);
          this.memorySaveAttempts.delete(key);
        });
      }
    }
    this.deleteByPrefix(this.saveFrequencyCounters, prefix);
  }

  /**
   * Issue #2329 (Codex review): drop all save bookkeeping for a deleted memory.
   * Without this, the failure ledger keeps the deleted memory's in-RAM instance
   * and the flush/retry paths re-save it, resurrecting the deleted file. A save
   * already in flight when the delete lands can still race the file back — that
   * narrow window is inherent to fire-and-forget writes and unchanged here.
   *
   * Scope: this clears the CURRENT session's bookkeeping only — keys are
   * session-scoped, and in multi-user HTTP mode a same-named memory in another
   * session may belong to a different user's portfolio, so clearing across
   * sessions by name would drop a legitimate recovery record. Cross-session
   * resurrection is prevented at the retry sites instead: every ledger retry
   * first re-checks existence through the entry's own manager
   * (retryLedgerEntryIfAlive), which resolves against the correct portfolio.
   */
  clearMemorySaveBookkeeping(memoryName: string): void {
    const key = this.saveKey(memoryName);
    const pending = this.pendingSaves.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(key);
    }
    this.failedMemorySaves.delete(key);
    this.memorySaveAttempts.delete(key);
    this.saveFrequencyCounters.delete(key);
  }

  /**
   * Issue #2329 (Codex review, PR #2336): retry a failure-ledger entry unless
   * the memory is POSITIVELY confirmed deleted — another session sharing the
   * same portfolio may have deleted it, and re-saving the retained instance
   * would resurrect the deleted memory. The check goes through the entry's OWN
   * manager, so in multi-user mode it resolves against the correct portfolio.
   *
   * Codex P1 (PR #2337): the check must fail closed. isMemoryDeleted() returns
   * true only on a storage-confirmed ENOENT and throws on transient lookup
   * failures; on any ambiguity we RETRY rather than drop — the ledger holds the
   * last in-RAM copy of unpersisted entries, and dropping it on a transient
   * read blip would be exactly the silent loss #2329 eliminated. The worst case
   * of retrying under ambiguity is resurrecting a deleted memory, which is
   * recoverable; dropped entries are not.
   */
  private async retryLedgerEntryIfAlive(
    key: string,
    entry: FailedSave,
    context: string,
  ): Promise<boolean> {
    let confirmedDeleted = false;
    try {
      confirmedDeleted = await entry.manager.isMemoryDeletedAt(entry.probeToken);
    } catch (probeErr) {
      logger.warn(`[MCPAQLHandler] ${context}: could not confirm whether memory '${key}' still exists (${probeErr instanceof Error ? probeErr.message : probeErr}); failing closed and retrying the save`);
    }
    if (confirmedDeleted) {
      logger.info(`[MCPAQLHandler] ${context}: memory '${key}' was deleted; dropping failed-save ledger entry instead of retrying`);
      this.failedMemorySaves.delete(key);
      this.memorySaveAttempts.delete(key);
      return false;
    }
    try {
      await this.saveMemoryTracked(key, entry.memory, entry.manager);
      return true;
    } catch (err) {
      logger.error(`[MCPAQLHandler] ${context} retry failed for memory '${key}' — unpersisted entries will be lost: ${err}`);
      return false;
    }
  }

  async dispose(): Promise<void> {
    await this.flushPendingSaves();
  }

  /**
   * Issue #656: Flush all pending debounced saves immediately.
   * Issue #2329: also retries memories whose earlier deferred save failed and
   * that have no pending timer — their dirty state exists only in RAM and this
   * is the last chance to persist it before shutdown.
   */
  async flushPendingSaves(): Promise<void> {
    const pending = [...this.pendingSaves.entries()];
    this.pendingSaves.clear();
    if (pending.length > 0) {
      logger.info(`[MCPAQLHandler] Flushing ${pending.length} pending memory save(s) on shutdown (total coalesced: ${this.debounceMetrics.coalesced}, total written: ${this.debounceMetrics.written})`);
    }
    const flushedKeys = new Set<string>();
    for (const [key, { timer, memory, manager }] of pending) {
      clearTimeout(timer);
      flushedKeys.add(key);
      try {
        await this.saveMemoryTracked(key, memory, manager);
        this.debounceMetrics.written++;
      } catch (err) {
        const entryCount = typeof memory.getEntries === 'function' ? memory.getEntries().size : 'unknown';
        logger.error(`[MCPAQLHandler] Flush save failed for memory '${key}' (entries: ${entryCount}, pending remaining: ${pending.length}): ${err}`);
      }
    }
    // Direct Map iteration is safe here: retryLedgerEntryIfAlive only deletes
    // the current key, which the iteration protocol tolerates.
    for (const [key, entry] of this.failedMemorySaves) {
      if (flushedKeys.has(key)) continue; // just attempted above
      const recovered = await this.retryLedgerEntryIfAlive(key, entry, 'Final flush');
      if (recovered) {
        this.debounceMetrics.written++;
        logger.info(`[MCPAQLHandler] Recovered previously failed save for memory '${key}' during flush`);
      }
    }
  }

  getSaveFrequencyCountersForTesting(): Map<string, SaveFrequencyCounter> {
    return this.saveFrequencyCounters;
  }

  trackSaveFrequencyForTesting(memoryName: string): void {
    this.trackSaveFrequency(memoryName);
  }

  /**
   * Normalized key shared by pendingSaves, failedMemorySaves, memorySaveAttempts,
   * and saveFrequencyCounters. All memory-save bookkeeping must use this — a
   * mismatched key silently disconnects the failure ledger from recovery (#2329).
   */
  private saveKey(memoryName: string): string {
    return this.sessionKey(memoryName.toLowerCase());
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
      await manager.save(memory);
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
          // Codex P1 (PR #2337): resolve the deletion-probe target NOW, while
          // the owning session's path context is live — dispose-time
          // resolution can point at the wrong portfolio in per-user mode.
          probeToken: manager.getMemoryProbeToken(memory),
        });
      }
      throw err;
    }
  }

  /**
   * addEntry with the #2329 persistence guarantees: recover from a prior failed
   * save, mutate the authoritative instance, verify persistability before
   * reporting success (rolling back on failure), then schedule the debounced save.
   */
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

    // Issue #2329: operate on the authoritative instance. Unpersisted entries
    // live only in the instance held by the failure ledger or a pending
    // debounced save; after cache eviction find() reloads a fresh copy from
    // disk that lacks them, and writing through that copy would clobber the
    // recovered state.
    const pendingKey = this.saveKey(memoryName);
    const priorFailure = this.failedMemorySaves.get(pendingKey);
    const targetMemory = priorFailure?.memory ?? this.pendingSaves.get(pendingKey)?.memory ?? memory;

    // Issue #2329: if a previous save of this memory failed (e.g. disk error),
    // recover before accepting more entries — otherwise they pile up in RAM
    // behind the same failure and are lost on restart.
    if (priorFailure) {
      try {
        await this.saveMemoryTracked(pendingKey, targetMemory, priorFailure.manager);
      } catch (retryErr) {
        throw new Error(
          `Entry NOT saved: memory '${memoryName}' has unpersisted entries from an earlier save failure ` +
          `(${priorFailure.error.message}) and the retry also failed: ` +
          `${retryErr instanceof Error ? retryErr.message : retryErr}`
        );
      }
    }

    const entriesBefore = targetMemory.getEntries().size;
    const entryResult = await targetMemory.addEntry(
      params.content as string,
      params.tags as string[] | undefined,
      params.metadata as Record<string, unknown> | undefined,
    );

    // Issue #2329: verify the memory can still be persisted BEFORE reporting
    // success. The disk write below is deferred (debounced), so a validation
    // failure there can never reach the caller — entries were acknowledged
    // with an id and then silently lost when the memory outgrew save limits.
    try {
      await manager.assertPersistable(targetMemory);
    } catch (validationErr) {
      targetMemory.removeEntry(entryResult.id);
      // addEntry may have evicted old entries (retention/capacity policy)
      // before validation failed. The eviction stands — it would happen on
      // any future successful add — but it must reach disk, or RAM and disk
      // silently diverge with no save scheduled.
      if (targetMemory.getEntries().size !== entriesBefore) {
        this.debouncedMemorySave(memoryName, targetMemory, manager);
      }
      throw new Error(
        `Entry NOT saved to memory '${memoryName}': ` +
        `${validationErr instanceof Error ? validationErr.message : validationErr}`
      );
    }

    this.trackSaveFrequency(memoryName);
    this.debouncedMemorySave(memoryName, targetMemory, manager);
    return entryResult;
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
    // Issue #2329: cancel any pending debounced save first — a stale timer
    // firing after the clear would resurrect the pre-clear entries on disk.
    const clearKey = this.saveKey(memoryName);
    const pendingClear = this.pendingSaves.get(clearKey);
    if (pendingClear) {
      clearTimeout(pendingClear.timer);
      this.pendingSaves.delete(clearKey);
    }
    const clearResult = await memory.clearAll(true);
    // Tracked so a success clears any stale failure record for this memory.
    await this.saveMemoryTracked(clearKey, memory, manager);
    return clearResult;
  }

  private debouncedMemorySave(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
  ): void {
    const key = this.saveKey(memoryName);
    const existing = this.pendingSaves.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.debounceMetrics.coalesced++;
      logger.debug(`[MCPAQLHandler] Coalesced save for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
    }
    const timer = setTimeout(() => {
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
    this.pendingSaves.set(key, { timer, memory, manager });
  }

  private trackSaveFrequency(memoryName: string): void {
    const key = this.saveKey(memoryName);
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
