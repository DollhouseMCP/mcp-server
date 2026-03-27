/**
 * Permission evaluation HTTP routes and decision tracking.
 *
 * Provides:
 * - POST /evaluate_permission — evaluates tool permissions via MCP-AQL
 * - GET /permissions/status — returns current policies and recent decisions
 * - Decision tracking ring buffer for the live dashboard feed
 */

import express, { Router } from 'express';
import { logger } from '../../utils/logger.js';
import type { MCPAQLHandler } from '../../handlers/mcp-aql/MCPAQLHandler.js';

/**
 * Simple sliding-window rate limiter.
 * Tracks timestamps of recent requests and evicts entries older than the window.
 */
class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  tryAcquire(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) return false;
    this.timestamps.push(now);
    return true;
  }
}

// ── Permission Decision Tracking ─────────────────────────────────────────────
// Ring buffer of recent permission decisions for the live dashboard feed.

interface PermissionDecision {
  id: string;
  timestamp: string;
  tool_name: string;
  command?: string;
  decision: string;
  reason?: string;
}

const DECISION_BUFFER_SIZE = 200;
const recentDecisions: PermissionDecision[] = [];
let decisionCounter = 0;

/** Extract a string field from a record, trying multiple keys in order */
function extractString(obj: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    if (typeof obj?.[key] === 'string') return obj[key] as string;
  }
  return fallback;
}

function trackDecision(toolName: string, input: Record<string, unknown>, result: Record<string, unknown>): void {
  const entry: PermissionDecision = {
    id: `d-${++decisionCounter}`,
    timestamp: new Date().toISOString(),
    tool_name: toolName,
    command: toolName === 'Bash' && typeof input?.command === 'string' ? input.command : undefined,
    decision: extractString(result, ['decision', 'behavior'], 'unknown'),
    reason: extractString(result, ['reason', 'message'], ''),
  };
  recentDecisions.unshift(entry);
  if (recentDecisions.length > DECISION_BUFFER_SIZE) {
    recentDecisions.length = DECISION_BUFFER_SIZE;
  }
}

/** Helper to extract single result from MCP-AQL batch response */
function asSingleResult(results: unknown): { success: boolean; data?: unknown; error?: string } {
  if (Array.isArray(results)) return results[0] || { success: false, error: 'Empty result' };
  return results as { success: boolean; data?: unknown; error?: string };
}

/**
 * Register permission-related routes on a gateway router.
 * Must be called with the MCP-AQL handler for policy evaluation.
 */
export function registerPermissionRoutes(router: Router, handler: MCPAQLHandler): void {
  /**
   * POST /api/evaluate_permission
   * Permission evaluation endpoint for PreToolUse hooks.
   * Routes through evaluate_permission MCP-AQL READ operation.
   * Fail-open: returns allow on any error to avoid blocking the user.
   */
  const permissionLimiter = new SlidingWindowRateLimiter(120, 60_000);
  router.post('/evaluate_permission', express.json(), async (req, res) => {
    if (!permissionLimiter.tryAcquire()) {
      res.json({ decision: 'allow' }); // fail open on rate limit
      return;
    }

    const body = req.body as {
      tool_name?: string;
      input?: Record<string, unknown>;
      platform?: string;
    };

    // Unicode normalization (NFC) on string inputs to prevent homograph attacks
    const tool_name = typeof body.tool_name === 'string' ? body.tool_name.normalize('NFC') : undefined;
    const platform = typeof body.platform === 'string' ? body.platform.normalize('NFC') : undefined;
    const input = body.input;

    if (!tool_name) {
      res.json({ decision: 'allow' }); // fail open on bad input
      return;
    }

    try {
      const opResult = asSingleResult(await handler.handleRead({
        operation: 'evaluate_permission',
        params: {
          tool_name,
          input: input || {},
          platform: platform || 'claude_code',
        },
      }));

      if (!opResult.success) {
        logger.warn(`[WebUI/Gateway] evaluate_permission failed: ${opResult.error}`);
        res.json({ decision: 'allow' }); // fail open
        return;
      }

      // Track decision for live dashboard feed
      trackDecision(tool_name, input || {}, opResult.data as Record<string, unknown>);

      res.json(opResult.data);
    } catch (err) {
      logger.error('[WebUI/Gateway] evaluate_permission error:', err);
      res.json({ decision: 'allow' }); // fail open
    }
  });

  /**
   * GET /api/permissions/status
   * Returns current permission policies and recent decisions
   * for the live permissions dashboard.
   */
  router.get('/permissions/status', async (_req, res) => {
    try {
      const opResult = asSingleResult(await handler.handleRead({
        operation: 'get_effective_cli_policies',
      }));

      if (!opResult.success) {
        res.status(500).json({ error: opResult.error || 'Failed to get policies' });
        return;
      }

      const data = opResult.data as Record<string, unknown>;

      // Extract confirm patterns from elements
      const elements = (data.elements || []) as Array<Record<string, unknown>>;
      const confirmPatterns: string[] = [];
      for (const el of elements) {
        const confirm = el.confirmPatterns as string[] | undefined;
        if (confirm?.length) confirmPatterns.push(...confirm);
      }

      res.json({
        activeElementCount: data.activeElementCount,
        hasAllowlist: data.hasAllowlist,
        denyPatterns: data.combinedDenyPatterns,
        allowPatterns: data.combinedAllowPatterns,
        confirmPatterns,
        elements,
        permissionPromptActive: data.permissionPromptActive,
        recentDecisions,
      });
    } catch (err) {
      logger.error('[WebUI/Gateway] permissions/status error:', err);
      res.status(500).json({ error: 'Failed to get permission status' });
    }
  });
}
