/**
 * auto-dollhouse#5: Permission evaluation for PreToolUse hooks.
 *
 * Extracted from MCPAQLHandler.ts — evaluatePermission case + formatPermissionResponse.
 * This is a simplified version of permissionPrompt for interactive sessions.
 * No approval workflow, no permissionPromptActive tracking.
 * Returns platform-formatted responses for hook scripts.
 */

import type { RateLimiter } from '../utils/RateLimiter.js';
import type { ToolClassificationResult, CliToolPolicyResult } from '../handlers/mcp-aql/policies/ToolClassification.js';
import type { ActiveElement } from '../handlers/mcp-aql/policies/ElementPolicies.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

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
      return { decision: decision === 'ask' ? 'deny' : decision, ...(reason && { reason }) };
    case 'cursor':
      return { permission: decision, ...(reason && { reason }) };
    case 'windsurf':
      // Windsurf uses exit codes at the HTTP layer; JSON body is informational
      return { allowed: decision === 'allow', ...(reason && { reason }) };
    case 'codex':
      return {
        hookSpecificOutput: {
          permissionDecision: decision === 'ask' ? 'deny' : decision,
          ...(reason && { reason }),
        },
      };
    case 'claude_code':
    default:
      // Claude Code PreToolUse hook format
      if (decision === 'allow') {
        return { decision: 'allow' };
      }
      if (decision === 'ask') {
        return { decision: 'ask', ...(reason && { message: reason }) };
      }
      return { decision: 'deny', ...(reason && { reason }) };
  }
}

/**
 * Evaluate a CLI permission request for PreToolUse hooks.
 *
 * Three-stage pipeline: rate limit -> static classification -> element policy.
 * Returns platform-formatted response for the calling hook script.
 */
export async function evaluatePermission(
  params: { tool_name?: unknown; input?: unknown; platform?: unknown },
  deps: EvaluatePermissionDeps,
): Promise<Record<string, unknown>> {
  // DMCP-SEC-004: Normalize user input to prevent Unicode-based attacks
  const rawToolName = typeof params.tool_name === 'string' ? params.tool_name : '';
  const toolName = UnicodeValidator.normalize(rawToolName).normalizedContent;
  const inputRaw = params.input;
  const input = (inputRaw && typeof inputRaw === 'object')
    ? inputRaw as Record<string, unknown>
    : {};
  const platform = typeof params.platform === 'string'
    ? UnicodeValidator.normalize(params.platform).normalizedContent
    : 'claude_code';

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
    // Hooks don't support approval workflows — map confirm to 'ask' (let the platform prompt)
    return formatPermissionResponse('ask', platform, input,
      decision.message || 'Requires confirmation per element policy');
  }

  // Default: allow
  return formatPermissionResponse('allow', platform, input);
}
