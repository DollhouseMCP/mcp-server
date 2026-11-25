/**
 * Server setup and initialization
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
type ProtocolServer = McpServer['server'];
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from '../handlers/ToolRegistry.js';
// import { getUserTools } from './tools/UserTools.js'; // DEPRECATED - replaced by dollhouse_config
// import { getConfigTools } from './tools/ConfigTools.js'; // DEPRECATED - replaced by dollhouse_config
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import { BestEffortDelivery } from '../logging/BestEffortDelivery.js';
import { LRUCache } from '../cache/LRUCache.js';
import { getValidatedToolCacheTTL } from '../config/performance-constants.js';
import { generatePrescriptiveDigest } from './PrescriptiveDigest.js';
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ContextTracker } from '../security/encryption/ContextTracker.js';
import type { ElementCRUDHandler } from '../handlers/ElementCRUDHandler.js';
import type { SessionResolver } from '../context/SessionContext.js';
import type { MemoryUpgradeLifecycle } from '../lifecycle/MemoryUpgradeLifecycle.js';
// ConfigWizardCheck import removed - auto-trigger disabled for v1.8.0

export class ServerSetup {
  private static readonly TOOL_CACHE_KEY = 'tool_discovery_list';
  /** Issue #706: Max ms to wait for deferred setup before proceeding anyway. */
  private static readonly DEFERRED_SETUP_TIMEOUT_MS = 10_000;
  private readonly toolCache: LRUCache<Tool[]>;
  private readonly contextTracker: ContextTracker;
  private readonly sessionResolver?: SessionResolver;
  private elementCrudHandler: ElementCRUDHandler | null = null;
  /** Issue #706 Phase 4: Promise that resolves when deferred setup completes. */
  private deferredSetupPromise: Promise<void> | null = null;

  constructor(contextTracker: ContextTracker, sessionResolver?: SessionResolver, private readonly memoryUpgrade?: MemoryUpgradeLifecycle) {
    this.contextTracker = contextTracker;
    this.sessionResolver = sessionResolver;
    this.toolCache = new LRUCache<Tool[]>({
      name: 'tool-discovery',
      maxSize: 1,
      maxMemoryMB: 5,
      ttlMs: getValidatedToolCacheTTL(),
    });
  }

  /**
   * Issue #706 Phase 4: Set the deferred setup promise for request buffering.
   * First request after connect holds briefly until deferred setup completes
   * (or the timeout fires). Subsequent requests proceed immediately.
   */
  setDeferredSetupPromise(promise: Promise<void>): void {
    this.deferredSetupPromise = promise;
    // Auto-clear when resolved so subsequent requests skip the check
    promise.then(() => { this.deferredSetupPromise = null; })
      .catch(() => { this.deferredSetupPromise = null; });
  }

  /**
   * Issue #706 Phase 4: Wait for deferred setup with a hard timeout.
   * No-op if already resolved or never set.
   */
  private async awaitDeferredSetup(): Promise<void> {
    if (!this.deferredSetupPromise) return;
    const timeout = new Promise<void>(resolve =>
      setTimeout(resolve, ServerSetup.DEFERRED_SETUP_TIMEOUT_MS)
    );
    await Promise.race([this.deferredSetupPromise, timeout]);
    this.deferredSetupPromise = null;
  }

  /**
   * Initialize the server with all tools and handlers
   */
  setupServer(server: ProtocolServer, toolRegistry: ToolRegistry, elementCrudHandler?: ElementCRUDHandler): void {
    this.elementCrudHandler = elementCrudHandler ?? null;

    // Setup request handlers
    this.setupListToolsHandler(server, toolRegistry);
    this.setupCallToolHandler(server, toolRegistry);
    this.setupToolRegistryChangeHandler(server, toolRegistry);
  }

  private setupToolRegistryChangeHandler(server: ProtocolServer, toolRegistry: ToolRegistry): void {
    toolRegistry.onChange((event) => {
      this.invalidateToolCache('ToolRegistry change');
      if (event.toolNames.length === 0) return;
      // Best-effort client notification: a notification failure (sync or async)
      // must never crash tool registration.
      const delivery = new BestEffortDelivery('ToolDiscoveryCache', (_source, _suppressed, errorType) => {
        logger.debug('ToolDiscoveryCache: Tool list changed notification was not delivered', {
          error: errorType, reason: event.reason, toolNames: event.toolNames,
        });
      });
      delivery.run(() => server.sendToolListChanged());
    });
  }
  
  /**
   * Setup the ListToolsRequest handler with caching
   */
  private setupListToolsHandler(server: ProtocolServer, toolRegistry: ToolRegistry): void {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const session = this.sessionResolver?.(request);
      const context = session
        ? this.contextTracker.createSessionContext('llm-request', session, { toolName: 'list_tools' })
        : this.contextTracker.createContext('llm-request', { toolName: 'list_tools' });

      return this.contextTracker.runAsync(context, () => {
        const startTime = Date.now();

        // Try to get cached tools first
        let tools = this.toolCache.get(ServerSetup.TOOL_CACHE_KEY);

        if (tools) {
          const duration = Date.now() - startTime;
          logger.debug('ToolDiscoveryCache: Cache hit - returned cached tools', {
            toolCount: tools.length,
            duration: `${duration}ms`,
            source: 'cache'
          });
        } else {
          // Cache miss - fetch tools from registry
          tools = toolRegistry.getAllTools();

          // Cache the results for future requests
          this.toolCache.set(ServerSetup.TOOL_CACHE_KEY, tools);

          const duration = Date.now() - startTime;
          logger.info('ToolDiscoveryCache: Cache miss - fetched and cached tools', {
            toolCount: tools.length,
            duration: `${duration}ms`,
            source: 'registry'
          });
        }

        return Promise.resolve({ tools });
      });
    });
  }
  
  /**
   * Issue #492: Prescriptive digest for active element context recovery.
   * After context compaction, the LLM loses active element instructions;
   * this digest tells it how to recover them. Best-effort — never fails a response.
   */
  private async appendPrescriptiveDigest(response: any, toolName: string): Promise<void> {
    if (!this.elementCrudHandler || toolName === 'get_active_elements') return;
    try {
      // Advisory: the digest may share an overlapping report; enforcement reads its own, fresh.
      const report = await this.elementCrudHandler.getActiveElementsForPolicyReport({ allowCoalescing: true });
      if (report.items.length === 0 && report.complete) return;
      const digest = generatePrescriptiveDigest(report.items);
      const failures = report.failures.map(failure => `${failure.type}: ${failure.reference ?? 'collection'}: ${failure.reason}`);
      if (response?.content?.[0]?.type === 'text') {
        response.content[0].text += '\n\n' + digest;
        if (!report.complete) response.content[0].text += '\nPolicy context incomplete:\n' + failures.join('\n');
      }
    } catch (cause) {
      if (response?.content?.[0]?.type === 'text') {
        response.content[0].text += '\nPolicy context unavailable: ' + (cause instanceof Error ? cause.message : String(cause));
      }
    }
  }

  /** Setup the CallToolRequest handler */
  private setupCallToolHandler(server: ProtocolServer, toolRegistry: ToolRegistry): void {
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const execute = async () => {
      // Issue #706 Phase 4: Hold first request(s) until deferred setup completes
      await this.awaitDeferredSetup();

      const session = this.sessionResolver?.(request);
      const context = session
        ? this.contextTracker.createSessionContext('llm-request', session, { toolName: request.params.name })
        : this.contextTracker.createContext('llm-request', { toolName: request.params.name });
      return this.contextTracker.runAsync(context, async () => {
        const { name, arguments: args } = request.params;

        try {
          const handler = toolRegistry.getHandler(name);

          if (!handler) {
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
          }

          // Normalize Unicode in all string arguments to prevent security bypasses
          const normalizedArgs = this.normalizeArgumentsUnicode(args, name);

          const response = await handler(normalizedArgs);

          await this.appendPrescriptiveDigest(response, name);

          return response;
        } catch (error) {
          if (error instanceof McpError) {
            throw error;
          }

          throw new McpError(
            ErrorCode.InternalError,
            `Error executing tool ${name}: ${error}`
          );
        }
      });
      };
      return this.memoryUpgrade ? this.memoryUpgrade.runRequest(execute) : execute();
    });
  }
  
  /**
   * Recursively normalize Unicode in all string values within arguments
   */
  private normalizeArgumentsUnicode(args: any, toolName: string): any {
    if (args === null || args === undefined) {
      return args;
    }
    
    if (typeof args === 'string') {
      const result = UnicodeValidator.normalize(args);
      if (result.detectedIssues && result.detectedIssues.length > 0) {
        logger.warn(`Unicode security issues detected in tool ${toolName}:`, {
          issues: result.detectedIssues,
          severity: result.severity
        });
      }
      return result.normalizedContent;
    }
    
    if (Array.isArray(args)) {
      return args.map(item => this.normalizeArgumentsUnicode(item, toolName));
    }
    
    if (typeof args === 'object') {
      const normalized: any = {};
      for (const [key, value] of Object.entries(args)) {
        // Normalize both keys and values to prevent Unicode attacks in property names
        const normalizedKey = typeof key === 'string' ? 
          UnicodeValidator.normalize(key).normalizedContent : key;
        normalized[normalizedKey] = this.normalizeArgumentsUnicode(value, toolName);
      }
      return normalized;
    }
    
    // For non-string primitive types, return as-is
    return args;
  }
  
  /**
   * Get the tool discovery cache
   */
  getToolCache(): LRUCache<Tool[]> {
    return this.toolCache;
  }

  /**
   * Invalidate the tool discovery cache (useful for external tool changes)
   */
  invalidateToolCache(reason = 'manual invalidation'): void {
    this.toolCache.delete(ServerSetup.TOOL_CACHE_KEY);
    logger.info('ToolDiscoveryCache: Cache invalidated', { reason });

    // Log security event for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'TOOL_CACHE_INVALIDATED',
      severity: 'LOW',
      source: 'ServerSetup.invalidateToolCache',
      details: `Tool discovery cache invalidated: ${reason}`
    });
  }

  /**
   * Log current cache performance metrics
   */
  logCachePerformance(): void {
    const stats = this.toolCache.getStats();
    logger.info('ToolDiscoveryCache: Performance metrics', {
      hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
      hits: stats.hitCount,
      misses: stats.missCount,
      cacheSize: stats.size,
      efficiency: stats.hitCount > 0 ? 'GOOD' : 'NEEDS_WARMUP'
    });
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStatistics() {
    return {
      toolCache: this.toolCache.getStats()
    };
  }
}
