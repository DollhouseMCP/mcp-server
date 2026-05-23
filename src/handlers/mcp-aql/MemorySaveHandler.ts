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

interface SaveFrequencyCounter {
  timestamps: number[];
  warned: boolean;
  critical: boolean;
}

export class MemorySaveHandler {
  private readonly pendingSaves = new Map<string, PendingSave>();
  private readonly debounceMetrics = { coalesced: 0, written: 0 };
  private readonly saveFrequencyCounters = new Map<string, SaveFrequencyCounter>();

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
        return this.clear(memory, manager);
      default:
        throw new Error(`Unknown Memory method: ${method}`);
    }
  }

  cleanupSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const [key, entry] of this.pendingSaves) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        this.pendingSaves.delete(key);
      }
    }
    this.deleteByPrefix(this.saveFrequencyCounters, prefix);
  }

  async dispose(): Promise<void> {
    await this.flushPendingSaves();
  }

  async flushPendingSaves(): Promise<void> {
    const pending = [...this.pendingSaves.entries()];
    this.pendingSaves.clear();
    if (pending.length > 0) {
      logger.info(`[MCPAQLHandler] Flushing ${pending.length} pending memory save(s) on shutdown (total coalesced: ${this.debounceMetrics.coalesced}, total written: ${this.debounceMetrics.written})`);
    }
    for (const [key, { timer, memory, manager }] of pending) {
      clearTimeout(timer);
      try {
        await manager.save(memory);
        this.debounceMetrics.written++;
      } catch (err) {
        const entryCount = typeof memory.getEntries === 'function' ? memory.getEntries().size : 'unknown';
        logger.error(`[MCPAQLHandler] Flush save failed for memory '${key}' (entries: ${entryCount}, pending remaining: ${pending.length}): ${err}`);
      }
    }
  }

  getSaveFrequencyCountersForTesting(): Map<string, SaveFrequencyCounter> {
    return this.saveFrequencyCounters;
  }

  trackSaveFrequencyForTesting(memoryName: string): void {
    this.trackSaveFrequency(memoryName);
  }

  private addEntry(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
    params: Record<string, unknown>
  ): unknown {
    if (params.entry !== undefined && params.content === undefined) {
      params.content = params.entry;
    }
    this.validateContent(memoryName, params);

    const pendingKey = this.sessionKey(memoryName.toLowerCase());
    const targetMemory = this.pendingSaves.get(pendingKey)?.memory ?? memory;
    const entryResult = targetMemory.addEntry(
      params.content as string,
      params.tags as string[] | undefined,
      params.metadata as Record<string, unknown> | undefined,
    );
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

  private async clear(memory: Memory, manager: MemoryManager): Promise<unknown> {
    const clearResult = memory.clearAll(true);
    await manager.save(memory);
    return clearResult;
  }

  private debouncedMemorySave(
    memoryName: string,
    memory: Memory,
    manager: MemoryManager,
  ): void {
    const key = this.sessionKey(memoryName.toLowerCase());
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
      manager.save(memory).catch((err) => {
        logger.error(`[MCPAQLHandler] Debounced save failed for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written}): ${err}`);
      });
    }, STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
    this.pendingSaves.set(key, { timer, memory, manager });
  }

  private trackSaveFrequency(memoryName: string): void {
    const key = this.sessionKey(memoryName.toLowerCase());
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
