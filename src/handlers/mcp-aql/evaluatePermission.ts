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

/** Dependencies injected from MCPAQLHandler */
export interface EvaluatePermissionDeps {
  permissionPromptLimiter: RateLimiter;
  classifyTool: (toolName: string, toolInput: Record<string, unknown>) => ToolClassificationResult;
  evaluateCliToolPolicy: (toolName: string, toolInput: Record<string, unknown>, elements: ActiveElement[]) => CliToolPolicyResult;
  getActiveElements: () => Promise<ActiveElement[]>;
}

/**
 * Format permission evaluation response for platform-specific hook scripts.
 * Each platform expects a different JSON shape from its hook response.
 */
export function formatPermissionResponse(
  decision: 'allow' | 'deny' | 'ask',
  platform: string,
  input: Record<string, unknown>,
  reason?: string,
): Record<string, unknown> {
  switch (platform) {
    case 'gemini':
      return { decision: decision === 'ask' ? 'deny' : decision, ...(reason ? { reason } : {}) };
    case 'cursor':
      return { permission: decision, ...(reason ? { reason } : {}) };
    case 'windsurf':
      return { allowed: decision === 'allow', ...(reason ? { reason } : {}) };
    case 'codex':
      return {
        hookSpecificOutput: {
          permissionDecision: decision === 'ask' ? 'deny' : decision,
          ...(reason ? { reason } : {}),
        },
      };
    case 'claude_code':
    default:
      if (decision === 'allow') {
        return { decision: 'allow' };
      }
      if (decision === 'ask') {
        return { decision: 'ask', ...(reason ? { message: reason } : {}) };
      }
      return { decision: 'deny', ...(reason ? { reason } : {}) };
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
  const elements = await deps.getActiveElements();
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
