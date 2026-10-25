/**
 * Permission evaluation for PreToolUse hooks across all AI platforms.
 *
 * Provides the `evaluate_permission` MCP-AQL READ operation, enabling
 * Claude Code, Cursor, Gemini CLI, Windsurf, and Codex to use
 * DollhouseMCP as their permission evaluation backend via hooks.
 *
 * Four-stage evaluation pipeline:
 * 1. Rate limiting — prevents abuse
 * 2. Static tool classification — built-in allow/deny rules
 * 3. Ownership policy — who authored the PR/issue a GitHub mutation targets (Issue #3153)
 * 4. Element policy evaluation — active element gatekeeper policies
 *
 * Returns platform-specific response formats so each platform's hook
 * script receives the JSON shape it expects.
 */

import type { RateLimiter } from '../../utils/RateLimiter.js';
import type { ToolClassificationResult, CliToolPolicyResult } from './policies/ToolClassification.js';
import type { ActiveElement } from './policies/ElementPolicies.js';
import type { OwnershipDecision } from './policies/OwnershipPolicy.js';

/** Context handed to the ownership policy for cache scoping and `gh` repo inference. */
export interface OwnershipEvaluationInput {
  sessionId?: string;
  cwd?: string;
}

/** Minimal surface of OwnershipPolicyService the hook pipeline depends on. */
export interface OwnershipPolicyEvaluator {
  evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: OwnershipEvaluationInput,
  ): Promise<OwnershipDecision | undefined>;
}

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
  getActiveElements: (sessionId?: string) => Promise<ActiveElement[]>;
  /** Authorship-aware GitHub ownership policy (Issue #3153). Optional: absent = stage skipped. */
  ownershipPolicy?: OwnershipPolicyEvaluator;
}

/**
 * Run the ownership policy, converting a thrown error into a fail-closed
 * confirm so a broken lookup can never silently allow a mutation.
 */
export async function evaluateOwnershipStage(
  policy: OwnershipPolicyEvaluator | undefined,
  toolName: string,
  input: Record<string, unknown>,
  context: OwnershipEvaluationInput,
): Promise<OwnershipDecision | undefined> {
  if (!policy) return undefined;
  try {
    return await policy.evaluate(toolName, input, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      behavior: 'confirm',
      reason: `Ownership policy evaluation failed (${message.slice(0, 160)}); confirm before modifying GitHub state`,
      policySource: 'ownership_policy',
    };
  }
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

/** Codex PreToolUse currently supports block/deny only; allow is empty stdout. */
function formatCodex(decision: string, reason?: string): Record<string, unknown> {
  if (decision === 'allow') {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision === 'ask' ? 'deny' : decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
}

/** Claude Code (default): uses hookSpecificOutput.permissionDecision for PreToolUse */
function formatClaudeCode(decision: string, reason?: string): Record<string, unknown> {
  return {
    hookSpecificOutput: withReason({
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
    }, reason, 'permissionDecisionReason'),
  };
}

/** Platform formatter lookup */
const platformFormatters: Record<string, (decision: string, reason?: string) => Record<string, unknown>> = {
  gemini: formatGemini,
  cursor: formatCursor,
  windsurf: formatWindsurf,
  codex: formatCodex,
  vscode: formatClaudeCode,
  claude_code: formatClaudeCode,
};

/** Known platform identifiers */
export const SUPPORTED_PLATFORMS = Object.keys(platformFormatters);

function warnOnUnknownPlatform(platform: string): void {
  void import('../../utils/logger.js')
    .then(({ logger }) => {
      logger.warn(
        `[evaluatePermission] Unknown platform "${platform}", defaulting to claude_code format. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
      );
    })
    .catch((error) => {
      console.warn(
        `[evaluatePermission] Failed to load logger while handling unknown platform "${platform}".`,
        error,
      );
    });
}

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
      warnOnUnknownPlatform(platform);
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
  params: { tool_name?: unknown; input?: unknown; platform?: unknown; session_id?: unknown; cwd?: unknown },
  deps: EvaluatePermissionDeps,
): Promise<Record<string, unknown>> {
  const toolName = typeof params.tool_name === 'string' ? params.tool_name : '';
  const inputRaw = params.input;
  const input = (inputRaw && typeof inputRaw === 'object')
    ? inputRaw as Record<string, unknown>
    : {};
  const platform = typeof params.platform === 'string' ? params.platform : 'claude_code';
  const sessionId = typeof params.session_id === 'string' && params.session_id.trim() !== ''
    ? params.session_id
    : undefined;
  const cwd = typeof params.cwd === 'string' && params.cwd.trim() !== '' ? params.cwd : undefined;

  // Rate limit
  const rateStatus = deps.permissionPromptLimiter.checkLimit();
  if (!rateStatus.allowed) {
    return formatPermissionResponse('deny', platform, input, 'Rate limit exceeded');
  }
  deps.permissionPromptLimiter.consumeToken();

  const outcome = await decidePermission(toolName, input, { sessionId, cwd }, deps);
  return formatPermissionResponse(outcome.decision, platform, input, outcome.reason);
}

interface PermissionOutcome {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

/**
 * Stages 2–4 of the pipeline, platform-agnostic:
 * static classification → ownership policy → element policies.
 * An ownership deny is final; an ownership confirm is held until element
 * policies have had the chance to deny outright.
 */
async function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  context: OwnershipEvaluationInput,
  deps: EvaluatePermissionDeps,
): Promise<PermissionOutcome> {
  const classification = deps.classifyTool(toolName, input);
  if (classification.behavior === 'allow') return { decision: 'allow' };
  if (classification.behavior === 'deny') return { decision: 'deny', reason: classification.reason };

  const ownership = await evaluateOwnershipStage(deps.ownershipPolicy, toolName, input, context);
  if (ownership?.behavior === 'deny') return { decision: 'deny', reason: ownership.reason };

  const elements = await fetchActiveElements(deps, toolName, context.sessionId);
  const decision = deps.evaluateCliToolPolicy(toolName, input, elements);
  if (decision.behavior === 'deny') return { decision: 'deny', reason: decision.message };
  if (ownership?.behavior === 'confirm') return { decision: 'ask', reason: ownership.reason };
  if (decision.behavior === 'confirm') {
    return { decision: 'ask', reason: decision.message || 'Requires confirmation per element policy' };
  }
  return { decision: 'allow' };
}

async function fetchActiveElements(deps: EvaluatePermissionDeps, toolName: string, sessionId?: string): Promise<ActiveElement[]> {
  try {
    return await deps.getActiveElements(sessionId);
  } catch (err) {
    throw new PermissionEvaluationError(
      `Failed to fetch active elements for policy evaluation: ${err instanceof Error ? err.message : String(err)}`,
      'element_fetch', toolName, err,
    );
  }
}
