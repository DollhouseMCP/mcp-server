/**
 * Page event feedback bridge for element-driven web pages.
 *
 * Provides:
 * - POST /page-event — receives browser interactions, delegates to PageEventDispatcher
 *
 * The route handler is thin: validation, CSRF, rate limiting.
 * All dispatch logic (classification, debounce, agent wake, memory write)
 * lives in PageEventDispatcher.
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1705
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1714
 */

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import type { MCPAQLHandler } from '../../handlers/mcp-aql/MCPAQLHandler.js';
import type { PageUpdateEvent } from './pageStreamRoutes.js';
import { PageEventDispatcher } from '../PageEventDispatcher.js';

// ── Route Result Interface ──────────────────────────────────────────────────

export interface PageEventRoutesResult {
  router: Router;
  dispatcher: PageEventDispatcher;
}

// ── Route Factory ───────────────────────────────────────────────────────────

export function createPageEventRoutes(
  handler: MCPAQLHandler,
  pageUpdateBroadcast?: (template: string, event: PageUpdateEvent) => void,
): PageEventRoutesResult {
  const dispatcher = new PageEventDispatcher(handler, pageUpdateBroadcast);
  const router = Router();
  const rateLimiter = new SlidingWindowRateLimiter(60, 60_000);

  /**
   * POST /page-event
   * Receives browser interaction events and delegates to the dispatcher.
   *
   * Request body:
   * {
   *   template: string;      // Template name (identifies the page)
   *   event: string;         // Event type (click, submit, chat-message, etc.)
   *   target?: string;       // DOM element identifier
   *   data?: object;         // Arbitrary event payload
   *   agentName?: string;    // Explicit agent binding (optional)
   * }
   */
  router.post('/page-event', express.json({ limit: '50kb' }), async (req: Request, res: Response) => {
    // CSRF protection
    if (req.headers['x-dollhouse-request'] !== 'true') {
      res.status(403).json({ success: false, error: 'Missing X-Dollhouse-Request header' });
      return;
    }

    // Rate limiting
    if (!rateLimiter.tryAcquire()) {
      res.status(429).json({ success: false, error: 'Rate limited — try again shortly' });
      return;
    }

    const body = req.body as {
      template?: string;
      event?: string;
      target?: string;
      data?: Record<string, unknown>;
      agentName?: string;
    };

    // Validate required fields
    const template = typeof body.template === 'string' ? body.template.normalize('NFC') : undefined;
    const event = typeof body.event === 'string' ? body.event.normalize('NFC') : undefined;

    if (!template || !event) {
      res.status(400).json({ success: false, error: 'Missing required fields: template, event' });
      return;
    }

    // Sanitize template name
    if (template.includes('/') || template.includes('..')) {
      res.status(400).json({ success: false, error: 'Invalid template name' });
      return;
    }

    const target = typeof body.target === 'string' ? body.target.normalize('NFC') : undefined;
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
    const explicitAgent = typeof body.agentName === 'string' ? body.agentName.normalize('NFC') : undefined;

    try {
      const result = await dispatcher.dispatch({
        template,
        event,
        target,
        data,
        agentName: explicitAgent,
        timestamp: new Date().toISOString(),
      });

      res.json({
        success: true,
        bound: !!result.agentName,
        agentName: result.agentName,
        disposition: result.disposition,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  });

  return { router, dispatcher };
}
