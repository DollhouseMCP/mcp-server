/**
 * Page update SSE routes for element-driven web pages.
 *
 * Provides:
 * - GET /pages/:template/stream — SSE endpoint for real-time page updates
 *
 * Follows the exact pattern of logRoutes.ts / metricsRoutes.ts.
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1706
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';

// ── Event Types ─────────────────────────────────────────────────────────────

export type PageUpdateEventType =
  | 'page-render'
  | 'variable-update'
  | 'agent-notification'
  | 'page-error';

export interface PageUpdateEvent {
  type: PageUpdateEventType;
  template: string;
  data: unknown;
  timestamp: string;
}

// ── SSE Client Tracking ─────────────────────────────────────────────────────

interface PageSSEClient {
  res: Response;
  template: string;
}

// ── Route Result Interface ──────────────────────────────────────────────────

export interface PageStreamRoutesResult {
  router: Router;
  /** Push a page update event to all SSE clients subscribed to a template */
  broadcastPageUpdate: (template: string, event: PageUpdateEvent) => void;
  /** Get total count of connected SSE clients across all templates */
  clientCount: () => number;
}

// ── Route Factory ───────────────────────────────────────────────────────────

/**
 * Performance characteristics:
 * - JSON.stringify in the broadcast hot path: ~0.01ms for typical event payloads (<1KB).
 *   Becomes measurable (>1ms) at payloads >100KB. For inject-html with large HTML blocks,
 *   consider pre-serializing before broadcast.
 * - Linear client iteration: O(n) per broadcast where n = connected clients for that template.
 *   At MAX_CLIENTS=50 this is negligible. For 500+ clients, switch to Map<template, Set<client>>.
 * - Connection limit is configurable via the maxClients parameter.
 */
export function createPageStreamRoutes(maxClients: number = 50): PageStreamRoutesResult {
  const router = Router();
  const clients = new Set<PageSSEClient>();

  /**
   * GET /pages/:template/stream — SSE endpoint for page updates.
   *
   * Clients connect per-template and receive events only for that template.
   * Heartbeat every 30s to prevent proxy timeouts.
   */
  router.get('/pages/:template/stream', (req: Request, res: Response) => {
    const rawTemplate = req.params.template;
    const template = typeof rawTemplate === 'string' ? UnicodeValidator.normalize(rawTemplate).normalizedContent : '';
    if (!template || template.includes('/') || template.includes('..')) {
      res.status(400).json({ error: 'Invalid template name' });
      return;
    }

    // Enforce connection limit to prevent resource exhaustion
    if (clients.size >= maxClients) {
      res.status(503).json({ error: `Connection limit reached (${maxClients}). Try again later.` });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':connected\n\n');

    const client: PageSSEClient = { res, template };
    clients.add(client);

    // Keep-alive heartbeat — prevents proxies from closing idle connections
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  });

  /**
   * Broadcast a page update event to all SSE clients subscribed to a template.
   */
  function broadcastPageUpdate(template: string, event: PageUpdateEvent): void {
    const normalized = UnicodeValidator.normalize(template).normalizedContent;
    for (const client of clients) {
      if (client.template === normalized) {
        try {
          client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch (err) {
          // Client disconnected but close event hasn't fired yet — clean up
          const msg = err instanceof Error ? err.message : String(err);
          logger.debug(`[PageStream] SSE client disconnected for ${client.template}: ${msg}`);
          clients.delete(client);
        }
      }
    }
  }

  function clientCount(): number {
    return clients.size;
  }

  return { router, broadcastPageUpdate, clientCount };
}
