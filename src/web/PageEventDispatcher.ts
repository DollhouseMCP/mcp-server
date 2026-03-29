/**
 * Server-side page event dispatcher for element-driven web pages.
 *
 * Sits between the page-event HTTP route and the MCP-AQL handler.
 * Classifies incoming browser events as "wake" (trigger the LLM) or
 * "background" (log to memory only). Wake events are debounced and
 * batched, then delivered to the owning agent via continue_execution.
 *
 * Zero token cost for background events. The LLM only wakes when
 * there is meaningful work to do.
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1714
 */

import { logger } from '../utils/logger.js';
import type { MCPAQLHandler } from '../handlers/mcp-aql/MCPAQLHandler.js';
import type { PageUpdateEvent } from './routes/pageStreamRoutes.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DispatchConfig {
  /** Event types that should wake the agent. Empty set = ALL events wake. */
  wakeEvents: Set<string>;
  /** Event types treated as background (log only, no LLM invocation). */
  backgroundEvents: Set<string>;
  /** Debounce window in ms before flushing wake events to the agent. */
  debounceMs: number;
}

export interface PageEvent {
  template: string;
  event: string;
  target?: string;
  data?: Record<string, unknown>;
  agentName?: string;
  timestamp: string;
}

export interface DispatchResult {
  accepted: boolean;
  /** 'wake' = will trigger LLM, 'queued' = debouncing, 'background' = memory only */
  disposition: 'wake' | 'queued' | 'background';
  agentName?: string;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 500;

/** Events that always wake the agent by default (high semantic value). */
const DEFAULT_WAKE_EVENTS = new Set([
  'chat-message',
  'form-submit',
  'search',
  'command',
]);

/** Events that are background by default (low semantic value). */
const DEFAULT_BACKGROUND_EVENTS = new Set([
  'scroll',
  'hover',
  'focus',
  'blur',
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function asSingleResult(results: unknown): { success: boolean; data?: unknown; error?: string } {
  if (Array.isArray(results)) return results[0] || { success: false, error: 'Empty result' };
  return results as { success: boolean; data?: unknown; error?: string };
}

// ── PageEventDispatcher ─────────────────────────────────────────────────────

export class PageEventDispatcher {
  private readonly pendingWakeEvents = new Map<string, PageEvent[]>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly agentCache = new Map<string, { agentName: string | undefined; cachedAt: number }>();

  /**
   * Long-poll waiters. When an LLM calls wait_for_page_events, a promise
   * is created and stored here. When the dispatcher flushes wake events,
   * it resolves the matching waiter — delivering events to the LLM with
   * zero polling cost.
   */
  private readonly waiters = new Map<string, {
    resolve: (events: PageEvent[]) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private static readonly AGENT_CACHE_TTL = 30_000; // 30s
  private static readonly DEFAULT_WAIT_TIMEOUT = 60_000; // 60s long-poll max

  constructor(
    private readonly handler: MCPAQLHandler,
    private readonly broadcast?: (template: string, event: PageUpdateEvent) => void,
    private readonly configOverrides?: Partial<DispatchConfig>,
  ) {}

  /**
   * Main entry point. Called by the route handler after validation.
   */
  async dispatch(event: PageEvent): Promise<DispatchResult> {
    // Resolve the owning agent
    const agentName = await this.resolveAgent(event.template, event.agentName);

    // Broadcast via SSE regardless of classification
    if (this.broadcast) {
      this.broadcast(event.template, {
        type: 'agent-notification',
        template: event.template,
        data: {
          event: event.event,
          target: event.target,
          message: `Event "${event.event}" received`,
          eventData: event.data,
        },
        timestamp: event.timestamp,
      });
    }

    // No agent bound — log to memory only
    if (!agentName) {
      await this.logToMemory(event);
      return { accepted: true, disposition: 'background', agentName: undefined };
    }

    // Classify: wake or background?
    const config = this.resolveConfig();
    const classification = this.classify(event, config);

    if (classification === 'background') {
      await this.logToMemory(event);
      return { accepted: true, disposition: 'background', agentName };
    }

    // Wake event — queue with debounce
    this.queueWakeEvent(agentName, event, config);

    // Check if this is the first event in the batch (immediate) or a queued addition
    const queueSize = this.pendingWakeEvents.get(agentName)?.length ?? 0;
    return {
      accepted: true,
      disposition: queueSize === 1 ? 'queued' : 'queued',
      agentName,
    };
  }

  /**
   * Classify an event as wake or background.
   */
  private classify(event: PageEvent, config: DispatchConfig): 'wake' | 'background' {
    // Explicit background events are always background
    if (config.backgroundEvents.has(event.event)) {
      return 'background';
    }

    // If wake events are specified, only those events wake
    if (config.wakeEvents.size > 0) {
      return config.wakeEvents.has(event.event) ? 'wake' : 'background';
    }

    // Default: everything that isn't explicitly background is a wake event
    return 'wake';
  }

  /**
   * Queue a wake event and start/reset the debounce timer.
   */
  private queueWakeEvent(agentName: string, event: PageEvent, config: DispatchConfig): void {
    // Add to queue
    const queue = this.pendingWakeEvents.get(agentName) || [];
    queue.push(event);
    this.pendingWakeEvents.set(agentName, queue);

    // Reset debounce timer
    const existing = this.debounceTimers.get(agentName);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.flushWakeEvents(agentName).catch(err => {
        logger.error(`[PageDispatcher] Failed to flush events for ${agentName}:`, err);
      });
    }, config.debounceMs);

    this.debounceTimers.set(agentName, timer);
  }

  /**
   * Long-poll: block until wake events arrive for a given agent/template.
   *
   * Called by the wait_for_page_events MCP-AQL operation. The LLM calls
   * this once and blocks. When browser events arrive and the debounce
   * flushes, this resolves with the batched events. Zero polling cost.
   *
   * Times out after timeoutMs (default 60s) with an empty array.
   */
  waitForEvents(agentName: string, timeoutMs?: number): Promise<PageEvent[]> {
    const timeout = timeoutMs ?? PageEventDispatcher.DEFAULT_WAIT_TIMEOUT;

    // If there are already queued events, return them immediately
    const existing = this.pendingWakeEvents.get(agentName);
    if (existing && existing.length > 0) {
      this.pendingWakeEvents.delete(agentName);
      const existingTimer = this.debounceTimers.get(agentName);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.debounceTimers.delete(agentName);
      }
      return Promise.resolve(existing);
    }

    // Cancel any existing waiter for this agent
    const existingWaiter = this.waiters.get(agentName);
    if (existingWaiter) {
      clearTimeout(existingWaiter.timer);
      existingWaiter.resolve([]); // resolve old waiter with empty
    }

    return new Promise<PageEvent[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(agentName);
        resolve([]); // timeout — no events
      }, timeout);

      this.waiters.set(agentName, { resolve, timer });
    });
  }

  /**
   * Flush queued wake events.
   *
   * If an LLM is waiting via waitForEvents, deliver events directly to it.
   * Otherwise, call continue_execution on the agent (fire-and-forget fallback).
   */
  private async flushWakeEvents(agentName: string): Promise<void> {
    // Atomically grab the queued events
    const events = this.pendingWakeEvents.get(agentName) || [];
    this.pendingWakeEvents.delete(agentName);
    this.debounceTimers.delete(agentName);

    if (events.length === 0) return;

    const summary = events.map(e => `${e.event}${e.target ? ` on ${e.target}` : ''}`).join(', ');
    logger.info(`[PageDispatcher] Flushing ${events.length} event(s) for "${agentName}": ${summary}`);

    // Priority 1: deliver to a waiting LLM (long-poll)
    const waiter = this.waiters.get(agentName);
    if (waiter) {
      this.waiters.delete(agentName);
      clearTimeout(waiter.timer);
      waiter.resolve(events);
      logger.info(`[PageDispatcher] Delivered ${events.length} event(s) to waiting LLM for "${agentName}"`);
      return;
    }

    // Priority 2: call continue_execution (fire-and-forget)
    try {
      const result = asSingleResult(
        await this.handler.handleExecute({
          operation: 'continue_execution',
          params: {
            element_name: agentName,
            previousStepResult: `Page dispatcher: ${events.length} browser event(s) received — ${summary}`,
            parameters: {
              source: 'page-event-dispatcher',
              template: events[0].template,
              eventCount: events.length,
              events: events.map(e => ({
                event: e.event,
                target: e.target,
                data: e.data,
                timestamp: e.timestamp,
              })),
            },
          },
        }),
      );

      if (!result.success) {
        logger.warn(`[PageDispatcher] continue_execution failed for ${agentName}: ${result.error}`);
        for (const event of events) {
          await this.logToMemory(event);
        }
      }
    } catch (err) {
      logger.error(`[PageDispatcher] continue_execution threw for ${agentName}:`, err);
      for (const event of events) {
        await this.logToMemory(event);
      }
    }
  }

  /**
   * Log a background event to memory.
   */
  private async logToMemory(event: PageEvent): Promise<void> {
    try {
      await this.handler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'page-events',
          content: JSON.stringify({
            template: event.template,
            event: event.event,
            target: event.target,
            data: event.data,
            timestamp: event.timestamp,
          }),
          tags: ['page-event', `template:${event.template}`, `event:${event.event}`],
        },
      });
    } catch {
      // Memory write is best-effort — don't fail the request
    }
  }

  /**
   * Resolve which agent owns a template.
   * Checks explicit binding first, then searches active ensembles.
   * Results cached for 30s to avoid repeated lookups.
   */
  private async resolveAgent(templateName: string, explicitAgent?: string): Promise<string | undefined> {
    if (explicitAgent) return explicitAgent;

    // Check cache
    const cached = this.agentCache.get(templateName);
    if (cached && Date.now() - cached.cachedAt < PageEventDispatcher.AGENT_CACHE_TTL) {
      return cached.agentName;
    }

    const agentName = await this.findBoundAgent(templateName);
    this.agentCache.set(templateName, { agentName, cachedAt: Date.now() });
    return agentName;
  }

  /**
   * Search active ensembles for an agent that owns the given template.
   */
  private async findBoundAgent(templateName: string): Promise<string | undefined> {
    try {
      const activeResult = asSingleResult(
        await this.handler.handleRead({
          operation: 'get_active_elements',
          params: { element_type: 'ensemble' },
        }),
      );
      if (!activeResult.success || !activeResult.data) return undefined;

      const text = typeof activeResult.data === 'string'
        ? activeResult.data
        : Array.isArray((activeResult.data as any).content)
          ? ((activeResult.data as any).content as any[]).map((c: any) => c.text || '').join('\n')
          : '';

      const ensembleNames: string[] = [];
      for (const line of text.split('\n')) {
        const match = line.match(/[🎭🎼]\s+(\S+)/);
        if (match) ensembleNames.push(match[1]);
      }

      for (const ensembleName of ensembleNames) {
        try {
          const ensResult = asSingleResult(
            await this.handler.handleRead({
              operation: 'get_element',
              params: { element_type: 'ensemble', element_name: ensembleName },
            }),
          );
          if (!ensResult.success || !ensResult.data) continue;

          const ensText = typeof ensResult.data === 'string'
            ? ensResult.data
            : Array.isArray((ensResult.data as any).content)
              ? ((ensResult.data as any).content as any[]).map((c: any) => c.text || '').join('\n')
              : '';

          if (!ensText.toLowerCase().includes(templateName.toLowerCase())) continue;

          const agentMatch = ensText.match(/(\S+)\s+\(agents?\)/i);
          if (agentMatch) return agentMatch[1];
        } catch {
          // Skip ensembles that fail to load
        }
      }
    } catch (err) {
      logger.debug('[PageDispatcher] Agent resolution failed:', err);
    }
    return undefined;
  }

  /**
   * Resolve dispatch config. V1: returns defaults.
   * Future: reads from ensemble extensions.
   */
  private resolveConfig(): DispatchConfig {
    return {
      wakeEvents: this.configOverrides?.wakeEvents ?? DEFAULT_WAKE_EVENTS,
      backgroundEvents: this.configOverrides?.backgroundEvents ?? DEFAULT_BACKGROUND_EVENTS,
      debounceMs: this.configOverrides?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    };
  }

  /**
   * Cleanup: clear all pending timers.
   */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.debounceTimers.clear();
    this.pendingWakeEvents.clear();
    this.agentCache.clear();
    this.waiters.clear();
  }
}
