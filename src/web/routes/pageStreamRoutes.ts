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

export function createPageStreamRoutes(): PageStreamRoutesResult {
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
        } catch {
          // Client disconnected but close event hasn't fired yet
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
