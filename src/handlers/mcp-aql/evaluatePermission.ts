/**
 * Permission evaluation for PreToolUse hooks across all AI platforms.
 *
 * Provides the `evaluate_permission` MCP-AQL READ operation, enabling
 * Claude Code, Cursor, Gemini CLI, Windsurf, and Codex to use
 * DollhouseMCP as their permission evaluation backend via hooks.
 *
 * Three-stage evaluation pipeline:
 * 1. Rate limiting — prevents abuse
 * 2. Static tool classification — built-in allow/deny rules
 * 3. Element policy evaluation — active element gatekeeper policies
 *
 * Returns platform-specific response formats so each platform's hook
 * script receives the JSON shape it expects.
 */

import type { RateLimiter } from '../../utils/RateLimiter.js';
import type { ToolClassificationResult, CliToolPolicyResult } from './policies/ToolClassification.js';
import type { ActiveElement } from './policies/ElementPolicies.js';

/** Error thrown when permission evaluation fails at a specific stage */
export class PermissionEvaluationError extends Error {
  public readonly stage: 'rate_limit' | 'classification' | 'policy' | 'element_fetch';
  public readonly toolName: string;

  constructor(
    message: string,
    stage: 'rate_limit' | 'classification' | 'policy' | 'element_fetch',
    toolName: string,
    cause?: unknown,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PermissionEvaluationError';
    this.stage = stage;
    this.toolName = toolName;
  }
}

/** Dependencies injected from MCPAQLHandler */
export interface EvaluatePermissionDeps {
  permissionPromptLimiter: RateLimiter;
  classifyTool: (toolName: string, toolInput: Record<string, unknown>) => ToolClassificationResult;
  evaluateCliToolPolicy: (toolName: string, toolInput: Record<string, unknown>, elements: ActiveElement[]) => CliToolPolicyResult;
  getActiveElements: () => Promise<ActiveElement[]>;
}

/** Optional reason field, only included when reason is provided */
function withReason(obj: Record<string, unknown>, reason?: string, key = 'reason'): Record<string, unknown> {
  return reason ? { ...obj, [key]: reason } : obj;
}

/** Gemini: maps 'ask' to 'deny' (no interactive support) */
function formatGemini(decision: string, reason?: string): Record<string, unknown> {
  return withReason({ decision: decision === 'ask' ? 'deny' : decision }, reason);
}

/** Cursor: uses 'permission' field instead of 'decision' */
function formatCursor(decision: string, reason?: string): Record<string, unknown> {
  return withReason({ permission: decision }, reason);
}

/** Windsurf: uses boolean 'allowed' field */
function formatWindsurf(decision: string, reason?: string): Record<string, unknown> {
  return withReason({ allowed: decision === 'allow' }, reason);
}

/** Codex: wraps in hookSpecificOutput, maps 'ask' to 'deny' */
function formatCodex(decision: string, reason?: string): Record<string, unknown> {
  return { hookSpecificOutput: withReason({ permissionDecision: decision === 'ask' ? 'deny' : decision }, reason) };
}

/** Claude Code (default): uses 'decision' with 'message' for ask, 'reason' for deny */
function formatClaudeCode(decision: string, reason?: string): Record<string, unknown> {
  if (decision === 'allow') return { decision: 'allow' };
  if (decision === 'ask') return withReason({ decision: 'ask' }, reason, 'message');
  return withReason({ decision: 'deny' }, reason);
}

/** Platform formatter lookup */
const platformFormatters: Record<string, (decision: string, reason?: string) => Record<string, unknown>> = {
  gemini: formatGemini,
  cursor: formatCursor,
  windsurf: formatWindsurf,
  codex: formatCodex,
  claude_code: formatClaudeCode,
};

/** Known platform identifiers */
export const SUPPORTED_PLATFORMS = Object.keys(platformFormatters);

/**
 * Format permission evaluation response for platform-specific hook scripts.
 * Each platform expects a different JSON shape from its hook response.
 *
 * Unknown platforms default to claude_code format with a warning log.
 */
export function formatPermissionResponse(
  decision: 'allow' | 'deny' | 'ask',
  platform: string,
  _input: Record<string, unknown>,
  reason?: string,
): Record<string, unknown> {
  switch (platform) {
    case 'gemini': return formatGemini(decision, reason);
    case 'cursor': return formatCursor(decision, reason);
    case 'windsurf': return formatWindsurf(decision, reason);
    case 'codex': return formatCodex(decision, reason);
    case 'claude_code': return formatClaudeCode(decision, reason);
    default:
      // Import lazily to avoid circular dependency at module load time
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn(`[evaluatePermission] Unknown platform "${platform}", defaulting to claude_code format. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`);
      }).catch(() => { /* logger not available */ });
      return formatClaudeCode(decision, reason);
  }
}

/**
 * Evaluate a CLI permission request for PreToolUse hooks.
 *
 * @param params - Tool name, input, and target platform
 * @param deps - Injected dependencies from MCPAQLHandler
 * @returns Platform-formatted permission decision
 */
export async function evaluatePermission(
  params: { tool_name?: unknown; input?: unknown; platform?: unknown },
  deps: EvaluatePermissionDeps,
): Promise<Record<string, unknown>> {
  const toolName = typeof params.tool_name === 'string' ? params.tool_name : '';
  const inputRaw = params.input;
  const input = (inputRaw && typeof inputRaw === 'object')
    ? inputRaw as Record<string, unknown>
    : {};
  const platform = typeof params.platform === 'string' ? params.platform : 'claude_code';

  // Rate limit
  const rateStatus = deps.permissionPromptLimiter.checkLimit();
  if (!rateStatus.allowed) {
    return formatPermissionResponse('deny', platform, input, 'Rate limit exceeded');
  }
  deps.permissionPromptLimiter.consumeToken();

  // Stage 1: Static classification
  const classification = deps.classifyTool(toolName, input);
  if (classification.behavior === 'allow') {
    return formatPermissionResponse('allow', platform, input);
  }
  if (classification.behavior === 'deny') {
    return formatPermissionResponse('deny', platform, input, classification.reason);
  }

  // Stage 2: Element policy evaluation
  let elements: ActiveElement[];
  try {
    elements = await deps.getActiveElements();
  } catch (err) {
    throw new PermissionEvaluationError(
      `Failed to fetch active elements for policy evaluation: ${err instanceof Error ? err.message : String(err)}`,
      'element_fetch', toolName, err,
    );
  }
  const decision = deps.evaluateCliToolPolicy(toolName, input, elements);

  if (decision.behavior === 'deny') {
    return formatPermissionResponse('deny', platform, input, decision.message);
  }
  if (decision.behavior === 'confirm') {
    return formatPermissionResponse('ask', platform, input,
      decision.message || 'Requires confirmation per element policy');
  }

  // Default: allow
  return formatPermissionResponse('allow', platform, input);
}
