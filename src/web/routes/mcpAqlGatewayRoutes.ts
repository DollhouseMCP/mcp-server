/**
 * MCP-AQL HTTP Gateway routes for element-driven web pages.
 *
 * Provides:
 * - POST /mcp-aql — generic gateway for browser JS to call allowed MCP-AQL operations
 *
 * Conservative allowlist: only safe read operations plus targeted write operations
 * (record_execution_step, addEntry) that the page feedback loop needs.
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1703
 */

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import { getRoute, type CRUDEndpoint } from '../../handlers/mcp-aql/OperationRouter.js';
import { logger } from '../../utils/logger.js';
import type { MCPAQLHandler } from '../../handlers/mcp-aql/MCPAQLHandler.js';
import type { PageUpdateEvent } from './pageStreamRoutes.js';
import type { PageEventDispatcher } from '../PageEventDispatcher.js';

// ── Operation Allowlist ─────────────────────────────────────────────────────
// Only these operations can be called from browser JS via the HTTP gateway.
// Everything else is rejected with 403. This is the primary security boundary.

const ALLOWED_OPERATIONS = new Set<string>([
  // READ — safe, read-only queries
  'render',
  'get_element',
  'get_element_details',
  'list_elements',
  'search_elements',
  'query_elements',
  'get_active_elements',
  'get_execution_state',
  'get_gathered_data',
  'search_portfolio',
  'search_all',
  'portfolio_status',
  'get_build_info',

  // CREATE — targeted write operations for the feedback loop
  'record_execution_step',
  'addEntry',

  // EXECUTE — agent continuation (but NOT execute_agent or abort_execution)
  'continue_execution',
  'complete_execution',

  // PAGE — element-driven web page operations (Issue #1714)
  'wait_for_page_events',
  'send_page_event',
]);

// ── Route Result Interface ──────────────────────────────────────────────────

export interface McpAqlGatewayRoutesResult {
  router: Router;
}

// ── Helper ──────────────────────────────────────────────────────────────────

function asSingleResult(results: unknown): { success: boolean; data?: unknown; error?: string } {
  if (Array.isArray(results)) return results[0] || { success: false, error: 'Empty result' };
  return results as { success: boolean; data?: unknown; error?: string };
}

// ── Endpoint → Handler Method Map ───────────────────────────────────────────

const ENDPOINT_HANDLER_MAP: Record<CRUDEndpoint, 'handleRead' | 'handleCreate' | 'handleUpdate' | 'handleDelete' | 'handleExecute'> = {
  READ: 'handleRead',
  CREATE: 'handleCreate',
  UPDATE: 'handleUpdate',
  DELETE: 'handleDelete',
  EXECUTE: 'handleExecute',
};

// ── Route Factory ───────────────────────────────────────────────────────────

export function createMcpAqlGatewayRoutes(
  handler: MCPAQLHandler,
  pageUpdateBroadcast?: (template: string, event: PageUpdateEvent) => void,
  pageEventDispatcher?: PageEventDispatcher,
): McpAqlGatewayRoutesResult {
  const router = Router();
  const rateLimiter = new SlidingWindowRateLimiter(120, 60_000);

  /**
   * POST /mcp-aql
   * Generic MCP-AQL gateway for browser JavaScript.
   *
   * Request body: { operation: string, params?: Record<string, unknown> }
   * Response: { success: true, data: ... } or { success: false, error: ... }
   */
  router.post('/mcp-aql', express.json({ limit: '100kb' }), async (req: Request, res: Response) => {
    // CSRF protection — custom header required
    if (req.headers['x-dollhouse-request'] !== 'true') {
      res.status(403).json({ success: false, error: 'Missing X-Dollhouse-Request header' });
      return;
    }

    // Rate limiting
    if (!rateLimiter.tryAcquire()) {
      res.status(429).json({ success: false, error: 'Rate limited — try again shortly' });
      return;
    }

    const body = req.body as { operation?: string; params?: Record<string, unknown> };

    // Validate operation
    const operation = typeof body.operation === 'string' ? body.operation.normalize('NFC') : undefined;
    if (!operation) {
      res.status(400).json({ success: false, error: 'Missing required field: operation' });
      return;
    }

    if (!ALLOWED_OPERATIONS.has(operation)) {
      res.status(403).json({
        success: false,
        error: `Operation "${operation}" is not allowed via the HTTP gateway`,
        code: 'OPERATION_NOT_ALLOWED',
      });
      return;
    }

    // Look up the CRUDE endpoint for this operation
    const route = getRoute(operation);
    if (!route) {
      res.status(400).json({ success: false, error: `Unknown operation: ${operation}` });
      return;
    }

    const handlerMethod = ENDPOINT_HANDLER_MAP[route.endpoint];
    if (!handlerMethod) {
      res.status(400).json({ success: false, error: `Unsupported endpoint: ${route.endpoint}` });
      return;
    }

    // Validate params
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? body.params
      : {};

    try {
      const rawResult = await handler[handlerMethod]({ operation, params });
      const result = asSingleResult(rawResult);

      // If this was a render operation, broadcast to SSE clients
      if (operation === 'render' && result.success && pageUpdateBroadcast) {
        const templateName = typeof params.element_name === 'string'
          ? params.element_name
          : typeof params.name === 'string'
            ? params.name
            : undefined;
        if (templateName) {
          pageUpdateBroadcast(templateName, {
            type: 'page-render',
            template: templateName,
            data: result.data,
            timestamp: new Date().toISOString(),
          });
        }
      }

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[MCP-AQL Gateway] ${operation} error:`, err);
      res.status(500).json({ success: false, error: message });
    }
  });

  /**
   * POST /wait-for-page-events
   * Long-polling endpoint for the LLM to block until browser events arrive.
   *
   * The LLM calls this once, and it blocks until the PageEventDispatcher
   * has wake events to deliver (or timeout). Zero polling cost — one call,
   * one response when there's work to do.
   *
   * Request body: { agentName: string, timeoutMs?: number }
   * Response: { success: true, events: PageEvent[] }
   *
   * @see https://github.com/DollhouseMCP/mcp-server/issues/1714
   */
  /**
   * POST /send-page-event
   * Send a response/event to the browser via SSE. This is the LLM's
   * outbound channel — replaces curl/bash hacks with a proper MCP-callable route.
   *
   * Request body: { template: string, event: string, data?: object }
   */
  if (pageUpdateBroadcast) {
    router.post('/send-page-event', express.json({ limit: '50kb' }), async (req: Request, res: Response) => {
      if (req.headers['x-dollhouse-request'] !== 'true') {
        res.status(403).json({ success: false, error: 'Missing X-Dollhouse-Request header' });
        return;
      }

      const body = req.body as { template?: string; event?: string; data?: Record<string, unknown> };
      const template = typeof body.template === 'string' ? body.template.normalize('NFC') : undefined;
      const event = typeof body.event === 'string' ? body.event.normalize('NFC') : 'agent-response';

      if (!template) {
        res.status(400).json({ success: false, error: 'Missing required field: template' });
        return;
      }

      const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};

      pageUpdateBroadcast(template, {
        type: 'agent-notification',
        template,
        data: { event, eventData: data, type: data.type || event, message: data.message || '' },
        timestamp: new Date().toISOString(),
      });

      res.json({ success: true, delivered: true });
    });
  }

  if (pageEventDispatcher) {
    router.post('/wait-for-page-events', express.json({ limit: '10kb' }), async (req: Request, res: Response) => {
      // CSRF protection
      if (req.headers['x-dollhouse-request'] !== 'true') {
        res.status(403).json({ success: false, error: 'Missing X-Dollhouse-Request header' });
        return;
      }

      const body = req.body as { agentName?: string; timeoutMs?: number };
      const agentName = typeof body.agentName === 'string' ? body.agentName.normalize('NFC') : undefined;

      if (!agentName) {
        res.status(400).json({ success: false, error: 'Missing required field: agentName' });
        return;
      }

      const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0
        ? Math.min(body.timeoutMs, 120_000) // Cap at 2 minutes
        : 60_000; // Default 60s

      try {
        logger.info(`[MCP-AQL Gateway] wait_for_page_events: LLM waiting for events (agent: ${agentName}, timeout: ${timeoutMs}ms)`);
        const events = await pageEventDispatcher.waitForEvents(agentName, timeoutMs);

        res.json({
          success: true,
          eventCount: events.length,
          events: events.map(e => ({
            event: e.event,
            target: e.target,
            data: e.data,
            template: e.template,
            timestamp: e.timestamp,
          })),
          timedOut: events.length === 0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[MCP-AQL Gateway] wait_for_page_events error:', err);
        res.status(500).json({ success: false, error: message });
      }
    });
  }

  return { router };
}
