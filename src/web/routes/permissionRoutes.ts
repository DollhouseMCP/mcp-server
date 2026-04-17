/**
 * Permission evaluation HTTP routes and decision tracking.
 *
 * Provides:
 * - POST /evaluate_permission — evaluates tool permissions via MCP-AQL
 * - GET /permissions/status — returns current policies and recent decisions
 * - Decision tracking ring buffer for the live dashboard feed
 */

import express, { Router } from 'express';
import { homedir } from 'node:os';
import { logger } from '../../utils/logger.js';
import type { MCPAQLHandler } from '../../handlers/mcp-aql/MCPAQLHandler.js';
import { formatPermissionResponse } from '../../handlers/mcp-aql/evaluatePermission.js';
import { ensureLatestPortFile } from '../portDiscovery.js';
import { getPermissionHookStatusAsync } from '../../utils/permissionHooks.js';

import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import {
  type PermissionAuthorityHost,
  type PermissionAuthorityMode,
  PERMISSION_AUTHORITY_HOSTS,
  PERMISSION_AUTHORITY_MODES,
  readPermissionAuthorityState,
  setPermissionAuthorityMode,
} from '../../utils/permissionAuthority.js';

// ── Permission Decision Tracking ─────────────────────────────────────────────
// Ring buffer of recent permission decisions for the live dashboard feed.

interface PermissionDecision {
  id: string;
  timestamp: string;
  session_id?: string;
  tool_name: string;
  command?: string;
  decision: string;
  reason?: string;
  platform?: string;
  target?: string;
  targetLabel?: string;
  details?: PermissionDecisionDetail[];
}

interface PermissionDecisionDetail {
  label: string;
  value: string;
  monospace?: boolean;
}

interface KnownPolicySession {
  sessionId: string;
  displayName: string;
  source: 'policy';
}

const PERMISSION_ROUTE_RATE_LIMIT_REQUESTS = 120;
const PERMISSION_ROUTE_RATE_LIMIT_WINDOW_MS = 60_000;
const DECISION_BUFFER_SIZE = 200;

interface PermissionDecisionTracker {
  trackDecision(
    sessionId: string | undefined,
    toolName: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>,
    platform: string,
  ): void;
  getRecentDecisions(): PermissionDecision[];
}

const CLAUDE_COMPATIBLE_HOOK_PLATFORMS = new Set(['claude_code', 'vscode']);
const NORMALIZABLE_PERMISSION_DECISIONS = new Set(['allow', 'deny', 'ask']);
type NormalizablePermissionDecision = 'allow' | 'deny' | 'ask';

/** Extract a string field from a record, trying multiple keys in order */
function extractString(obj: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const val = obj?.[key];
    if (typeof val === 'string') return val;
  }
  return fallback;
}

function extractDecision(result: Record<string, unknown>): string {
  const nested = result.hookSpecificOutput;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedDecision = (nested as Record<string, unknown>).permissionDecision;
    if (typeof nestedDecision === 'string') return nestedDecision;
  }

  if (typeof result.permission === 'string') return result.permission;
  if (typeof result.decision === 'string') return result.decision;
  if (typeof result.behavior === 'string') return result.behavior;
  if (typeof result.allowed === 'boolean') return result.allowed ? 'allow' : 'deny';
  return 'unknown';
}

function extractReason(result: Record<string, unknown>): string {
  const nested = result.hookSpecificOutput;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedReason = (nested as Record<string, unknown>).permissionDecisionReason;
    if (typeof nestedReason === 'string') return nestedReason;
  }

  return extractString(result, ['reason', 'message'], '');
}

function shouldNormalizeClaudeHook(platform: string | undefined): boolean {
  return platform !== undefined && CLAUDE_COMPATIBLE_HOOK_PLATFORMS.has(platform);
}

function normalizePermissionResponseForPlatform(
  platform: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (!shouldNormalizeClaudeHook(platform)) {
    return result;
  }

  const nested = result.hookSpecificOutput;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedDecision = (nested as Record<string, unknown>).permissionDecision;
    if (typeof nestedDecision === 'string') {
      return result;
    }
  }

  const decision = extractDecision(result);
  if (NORMALIZABLE_PERMISSION_DECISIONS.has(decision)) {
    return formatPermissionResponse(
      decision as NormalizablePermissionDecision,
      platform,
      input,
      extractReason(result),
    );
  }

  return formatPermissionResponse('allow', platform, input);
}

function buildDecisionDetails(
  toolName: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  platform: string,
): { target?: string; targetLabel?: string; details: PermissionDecisionDetail[] } {
  const details: PermissionDecisionDetail[] = [];

  if (platform) {
    details.push({ label: 'Platform', value: platform, monospace: true });
  }

  if (toolName === 'Bash' && typeof input.command === 'string' && input.command !== '') {
    details.push({ label: 'Command', value: input.command, monospace: true });
  }

  const targetDescriptors: Array<{ key: string; label: string; monospace?: boolean }> = [
    { key: 'file_path', label: 'File', monospace: true },
    { key: 'path', label: 'Path', monospace: true },
    { key: 'url', label: 'URL' },
    { key: 'pattern', label: 'Pattern', monospace: true },
    { key: 'query', label: 'Query' },
    { key: 'element_name', label: 'Element', monospace: true },
    { key: 'request_id', label: 'Request', monospace: true },
  ];

  let target: string | undefined;
  let targetLabel: string | undefined;

  for (const descriptor of targetDescriptors) {
    const value = input[descriptor.key];
    if (typeof value !== 'string' || value === '') {
      continue;
    }

    target = value;
    targetLabel = descriptor.label;
    details.push({ label: descriptor.label, value, monospace: descriptor.monospace });
    break;
  }

  const matchedPattern = extractString(result, ['matched_pattern', 'matchedPattern'], '');
  if (matchedPattern !== '') {
    details.push({ label: 'Matched Pattern', value: matchedPattern, monospace: true });
  }

  const policySource = extractString(result, ['policy_source', 'policySource'], '');
  if (policySource !== '') {
    details.push({ label: 'Policy Source', value: policySource, monospace: true });
  }

  return { target, targetLabel, details };
}

function createPermissionDecisionTracker(bufferSize = DECISION_BUFFER_SIZE): PermissionDecisionTracker {
  const recentDecisions: PermissionDecision[] = [];
  let decisionCounter = 0;

  return {
    trackDecision(
      sessionId: string | undefined,
      toolName: string,
      input: Record<string, unknown>,
      result: Record<string, unknown>,
      platform: string,
    ): void {
      const detailState = buildDecisionDetails(toolName, input, result, platform);
      const entry: PermissionDecision = {
        id: `d-${++decisionCounter}`,
        timestamp: new Date().toISOString(),
        ...(sessionId ? { session_id: sessionId } : {}),
        tool_name: toolName,
        command: toolName === 'Bash' && typeof input?.command === 'string' ? input.command : undefined,
        decision: extractDecision(result),
        reason: extractReason(result),
        platform,
        target: detailState.target,
        targetLabel: detailState.targetLabel,
        details: detailState.details,
      };
      recentDecisions.unshift(entry);
      if (recentDecisions.length > bufferSize) {
        recentDecisions.length = bufferSize;
      }
    },
    getRecentDecisions(): PermissionDecision[] {
      return recentDecisions;
    },
  };
}

function mergeRuleArrays(...sources: unknown[]): string[] {
  const merged = new Set<string>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (typeof entry === 'string' && entry !== '') {
        merged.add(entry);
      }
    }
  }
  return Array.from(merged);
}

function normalizePolicyElements(elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return elements.map((element) => ({
    ...element,
    element_name: resolveElementName(element),
    allowRules: mergeRuleArrays(element.allowPatterns, element.allowOperations),
    confirmRules: mergeRuleArrays(element.confirmPatterns, element.confirmOperations),
    denyRules: mergeRuleArrays(element.denyPatterns, element.denyOperations),
    invalidGatekeeperPolicy: !!element.invalidGatekeeperPolicy,
    invalidGatekeeperMessage: typeof element.invalidGatekeeperMessage === 'string' ? element.invalidGatekeeperMessage : undefined,
  }));
}

function resolveElementName(element: Record<string, unknown>): string {
  if (typeof element.element_name === 'string') return element.element_name;
  if (typeof element.name === 'string') return element.name;
  return '';
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

async function selfHealLatestPermissionPortFile(port: number | undefined): Promise<void> {
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    return;
  }

  try {
    await ensureLatestPortFile(port);
  } catch (err) {
    logger.debug('[WebUI/Gateway] Could not refresh permission-server.port', {
      error: err instanceof Error ? err.message : String(err),
      port,
    });
  }
}

async function resolveInstalledPermissionAuthorityHosts(
  homeDir: string,
  authorityState: Awaited<ReturnType<typeof readPermissionAuthorityState>>,
): Promise<PermissionAuthorityHost[]> {
  const installedStatuses = await Promise.all(
    PERMISSION_AUTHORITY_HOSTS.map(async (host) => ({
      host,
      status: await getPermissionHookStatusAsync(homeDir, host),
    })),
  );

  const installedHosts = installedStatuses
    .filter(({ status }) => status.installed)
    .map(({ host }) => host);

  const persistedHosts = Object.keys(authorityState.hosts || {}).filter((host): host is PermissionAuthorityHost =>
    (PERMISSION_AUTHORITY_HOSTS as readonly string[]).includes(host),
  );

  return Array.from(new Set(installedHosts.concat(persistedHosts)));
}

/**
 * Register permission-related routes on a gateway router.
 * Must be called with the MCP-AQL handler for policy evaluation.
 */
export interface RegisterPermissionRoutesOptions {
  homeDir?: string;
}

export function registerPermissionRoutes(
  router: Router,
  handler: MCPAQLHandler,
  options: RegisterPermissionRoutesOptions = {},
): void {
  const authorityHomeDir = options.homeDir ?? homedir();
  const decisionTracker = createPermissionDecisionTracker();
  /**
   * POST /api/evaluate_permission
   * Permission evaluation endpoint for PreToolUse hooks.
   * Routes through evaluate_permission MCP-AQL READ operation.
   * Fail-open: returns allow on any error to avoid blocking the user.
   */
  const permissionLimiter = new SlidingWindowRateLimiter(
    PERMISSION_ROUTE_RATE_LIMIT_REQUESTS,
    PERMISSION_ROUTE_RATE_LIMIT_WINDOW_MS,
  );
  router.post('/evaluate_permission', express.json(), async (req, res) => {
    await selfHealLatestPermissionPortFile(req.socket.localPort);

    const body = req.body as {
      tool_name?: string;
      input?: Record<string, unknown>;
      platform?: string;
      session_id?: string;
    };
    const platform = typeof body.platform === 'string' ? body.platform.normalize('NFC') : 'claude_code';

    if (!permissionLimiter.tryAcquire()) {
      res.json(formatPermissionResponse('allow', platform, {})); // fail open on rate limit
      return;
    }

    // Unicode normalization (NFC) on string inputs to prevent homograph attacks
    const tool_name = typeof body.tool_name === 'string' ? body.tool_name.normalize('NFC') : undefined;
    const session_id = typeof body.session_id === 'string' ? body.session_id.normalize('NFC') : undefined;
    const input = body.input;

    if (!tool_name) {
      res.json(formatPermissionResponse('allow', platform, input || {})); // fail open on bad input
      return;
    }

    const startMs = Date.now();
    try {
      const opResult = asSingleResult(await handler.handleRead({
        operation: 'evaluate_permission',
        params: {
          tool_name,
          input: input || {},
          platform,
          ...(session_id ? { session_id } : {}),
        },
      }));
      const elapsedMs = Date.now() - startMs;

      if (!opResult.success) {
        logger.warn(`[WebUI/Gateway] evaluate_permission failed (${elapsedMs}ms): ${opResult.error}`);
        res.json(formatPermissionResponse('allow', platform, input || {})); // fail open
        return;
      }

      const rawResult = opResult.data as Record<string, unknown>;
      const responseData = normalizePermissionResponseForPlatform(
        platform,
        input || {},
        rawResult,
      );
      const trackedResult = { ...rawResult, ...responseData };
      const decision = extractDecision(responseData);
      logger.debug(`[WebUI/Gateway] evaluate_permission: ${tool_name} → ${decision} (${elapsedMs}ms)`);

      // Track decision for live dashboard feed
      decisionTracker.trackDecision(session_id, tool_name, input || {}, trackedResult, platform);

      res.json(responseData);
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      logger.error(`[WebUI/Gateway] evaluate_permission error (${elapsedMs}ms):`, err);
      res.json(formatPermissionResponse('allow', platform, input || {})); // fail open
    }
  });

  /**
   * GET /api/permissions/status
   * Returns current permission policies and recent decisions
   * for the live permissions dashboard.
   */
  router.get('/permissions/status', async (req, res) => {
    try {
      await selfHealLatestPermissionPortFile(req.socket.localPort);

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
      const authorityState = await readPermissionAuthorityState(authorityHomeDir);
      const installedAuthorityHosts = await resolveInstalledPermissionAuthorityHosts(authorityHomeDir, authorityState);
      const elements = normalizePolicyElements((data.elements || []) as Array<Record<string, unknown>>);

      const denyPatterns = (data.combinedDenyPatterns as string[] | undefined) ?? [];
      const allowPatterns = (data.combinedAllowPatterns as string[] | undefined) ?? [];
      const confirmPatterns = (data.combinedConfirmPatterns as string[] | undefined) ?? [];
      const denyOperations = (data.combinedDenyOperations as string[] | undefined) ?? [];
      const allowOperations = (data.combinedAllowOperations as string[] | undefined) ?? [];
      const confirmOperations = (data.combinedConfirmOperations as string[] | undefined) ?? [];

      res.json({
        ...(sessionId ? { sessionId } : {}),
        activeElementCount: data.activeElementCount,
        hasAllowlist: data.hasAllowlist,
        denyPatterns,
        allowPatterns,
        confirmPatterns,
        denyOperations,
        allowOperations,
        confirmOperations,
        denyRules: mergeRuleArrays(denyPatterns, denyOperations),
        allowRules: mergeRuleArrays(allowPatterns, allowOperations),
        confirmRules: mergeRuleArrays(confirmPatterns, confirmOperations),
        elements,
        knownSessions: extractKnownPolicySessions(elements),
        permissionPromptActive: data.permissionPromptActive,
        hookInstalled: data.hookInstalled,
        hookHost: data.hookHost,
        authority: authorityState,
        authoritySupportedHosts: installedAuthorityHosts,
        authoritySupportedModes: [...PERMISSION_AUTHORITY_MODES],
        authorityAiMutable: false,
        enforcementReady: data.enforcementReady,
        invalidPolicyElementCount: data.invalidPolicyElementCount ?? 0,
        advisory: data.advisory,
        recentDecisions: decisionTracker.getRecentDecisions(),
      });
    } catch (err) {
      logger.error('[WebUI/Gateway] permissions/status error:', err);
      res.status(500).json({ error: 'Failed to get permission status' });
    }
  });

  router.get('/permissions/authority', async (_req, res) => {
    try {
      const authorityState = await readPermissionAuthorityState(authorityHomeDir);
      const installedAuthorityHosts = await resolveInstalledPermissionAuthorityHosts(authorityHomeDir, authorityState);
      res.json({
        ...authorityState,
        supportedHosts: installedAuthorityHosts,
        supportedModes: [...PERMISSION_AUTHORITY_MODES],
        aiMutable: false,
      });
    } catch (err) {
      logger.error('[WebUI/Gateway] permissions/authority error:', err);
      res.status(500).json({ error: 'Failed to get permission authority' });
    }
  });

  router.post('/permissions/authority', express.json(), async (req, res) => {
    try {
      const host = normalizeAuthorityHost(req.body?.host);
      const mode = normalizeAuthorityMode(req.body?.mode);
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() !== ''
        ? req.body.reason.trim()
        : undefined;

      if (!host || !mode) {
        res.status(400).json({
          error: 'host and mode are required',
          supportedHosts: [...PERMISSION_AUTHORITY_HOSTS],
          supportedModes: [...PERMISSION_AUTHORITY_MODES],
        });
        return;
      }

      let policies: Record<string, unknown> | undefined;
      if (mode === 'authoritative') {
        const policyResult = asSingleResult(await handler.handleRead({
          operation: 'get_effective_cli_policies',
          params: { reporting_scope: 'dashboard' },
        }));

        if (!policyResult.success) {
          res.status(500).json({ error: policyResult.error || 'Failed to fetch effective policies' });
          return;
        }

        policies = policyResult.data as Record<string, unknown>;
      }

      const authorityState = await setPermissionAuthorityMode({
        host,
        mode,
        reason,
        homeDir: authorityHomeDir,
        policies: mode === 'authoritative'
          ? {
            combinedAllowPatterns: asStringArray(policies?.combinedAllowPatterns),
            combinedConfirmPatterns: asStringArray(policies?.combinedConfirmPatterns),
            combinedDenyPatterns: asStringArray(policies?.combinedDenyPatterns),
          }
          : undefined,
      });

      res.json({ success: true, authority: authorityState });
    } catch (err) {
      logger.error(
        `[WebUI/Gateway] permissions/authority update error (host=${String(req.body?.host ?? '')}, mode=${String(req.body?.mode ?? '')}):`,
        err,
      );
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update permission authority',
      });
    }
  });
}

function normalizeAuthorityHost(value: unknown): PermissionAuthorityHost | null {
  return typeof value === 'string' && PERMISSION_AUTHORITY_HOSTS.includes(value as PermissionAuthorityHost)
    ? value as PermissionAuthorityHost
    : null;
}

function normalizeAuthorityMode(value: unknown): PermissionAuthorityMode | null {
  return typeof value === 'string' && PERMISSION_AUTHORITY_MODES.includes(value as PermissionAuthorityMode)
    ? value as PermissionAuthorityMode
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
