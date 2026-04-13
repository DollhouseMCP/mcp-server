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

import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';

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

interface KnownPolicySession {
  sessionId: string;
  displayName: string;
  source: 'policy';
}

const DECISION_BUFFER_SIZE = 200;
const recentDecisions: PermissionDecision[] = [];
let decisionCounter = 0;

/** Extract a string field from a record, trying multiple keys in order */
function extractString(obj: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const val = obj?.[key];
    if (typeof val === 'string') return val;
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

function extractKnownPolicySessions(elements: Array<Record<string, unknown>>): KnownPolicySession[] {
  const seen = new Set<string>();
  const knownSessions: KnownPolicySession[] = [];

  for (const element of elements) {
    const sessionIds = Array.isArray(element.sessionIds) ? element.sessionIds : [];
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '' || seen.has(sessionId)) {
        continue;
      }

      seen.add(sessionId);
      knownSessions.push({
        sessionId,
        displayName: sessionId,
        source: 'policy',
      });
    }
  }

  return knownSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
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

    const startMs = Date.now();
    try {
      const opResult = asSingleResult(await handler.handleRead({
        operation: 'evaluate_permission',
        params: {
          tool_name,
          input: input || {},
          platform: platform || 'claude_code',
        },
      }));
      const elapsedMs = Date.now() - startMs;

      if (!opResult.success) {
        logger.warn(`[WebUI/Gateway] evaluate_permission failed (${elapsedMs}ms): ${opResult.error}`);
        res.json({ decision: 'allow' }); // fail open
        return;
      }

      const decision = ((opResult.data as { decision?: string })?.decision ?? 'unknown');
      logger.debug(`[WebUI/Gateway] evaluate_permission: ${tool_name} → ${decision} (${elapsedMs}ms)`);

      // Track decision for live dashboard feed
      trackDecision(tool_name, input || {}, opResult.data as Record<string, unknown>);

      res.json(opResult.data);
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      logger.error(`[WebUI/Gateway] evaluate_permission error (${elapsedMs}ms):`, err);
      res.json({ decision: 'allow' }); // fail open
    }
  });

  /**
   * GET /api/permissions/status
   * Returns current permission policies and recent decisions
   * for the live permissions dashboard.
   */
  router.get('/permissions/status', async (req, res) => {
    try {
      const sessionId = typeof req.query['sessionId'] === 'string' && req.query['sessionId']
        ? req.query['sessionId']
        : undefined;

      const opResult = asSingleResult(await handler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {
          reporting_scope: 'dashboard',
          ...(sessionId ? { session_id: sessionId } : {}),
        },
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
        ...(sessionId ? { sessionId } : {}),
        activeElementCount: data.activeElementCount,
        hasAllowlist: data.hasAllowlist,
        denyPatterns: data.combinedDenyPatterns,
        allowPatterns: data.combinedAllowPatterns,
        confirmPatterns: confirmPatterns.length > 0
          ? confirmPatterns
          : ((data.combinedConfirmPatterns as string[] | undefined) ?? []),
        elements,
        knownSessions: extractKnownPolicySessions(elements),
        permissionPromptActive: data.permissionPromptActive,
        recentDecisions,
      });
    } catch (err) {
      logger.error('[WebUI/Gateway] permissions/status error:', err);
      res.status(500).json({ error: 'Failed to get permission status' });
    }
  });
}
