/**
 * auto-dollhouse#5: Operation extensions for the evaluate_permission MCP-AQL operation.
 *
 * Extracted from OperationRouter.ts, OperationSchema.ts, and MCPAQLTools.ts.
 * These definitions are registered at runtime when auto-dollhouse activates.
 *
 * DMCP-SEC-004: Static definitions only — no user input processing.
 * UnicodeValidator normalization is applied in evaluatePermission.ts and permissionRoutes.ts.
 */

/** Route definition for evaluate_permission */
export const evaluatePermissionRoute = {
  evaluate_permission: {
    endpoint: 'READ' as const,
    handler: 'Gatekeeper.evaluatePermission',
    description: 'Evaluate CLI permission for a tool via HTTP/hook (interactive session alternative to permission_prompt)',
  },
};

/** Schema definition for evaluate_permission */
export const evaluatePermissionSchema = {
  evaluate_permission: {
    endpoint: 'READ' as const,
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    description: 'Evaluate CLI permission for a tool via HTTP/hook. Returns platform-formatted response (claude_code, gemini, cursor, windsurf, codex). Alternative to permission_prompt for interactive sessions using PreToolUse hooks.',
    params: {
      tool_name: { type: 'string', required: true, description: 'The tool requesting permission (e.g., "Bash", "Edit", "Write")' },
      input: { type: 'object', description: 'The tool input parameters to evaluate' },
      platform: { type: 'string', description: 'Target platform for response formatting (default: "claude_code"). Options: claude_code, gemini, cursor, windsurf, codex' },
    },
    returns: { name: 'PlatformPermissionDecision', kind: 'object', description: 'Platform-formatted permission decision. Claude Code: { decision: "allow"|"deny"|"ask", reason? }. Gemini: { decision: "allow"|"deny", reason? }. Cursor: { permission: "allow"|"deny"|"ask", reason? }. Windsurf: { allowed: boolean, reason? }. Codex: { hookSpecificOutput: { permissionDecision, reason? } }.' },
    examples: [
      '{ operation: "evaluate_permission", params: { tool_name: "Bash", input: { command: "git status" } } }',
      '{ operation: "evaluate_permission", params: { tool_name: "Bash", input: { command: "git push --force" }, platform: "claude_code" } }',
    ],
  },
};

/** Tool documentation example for evaluate_permission */
export const evaluatePermissionToolExample =
  '{ operation: "evaluate_permission", params: { tool_name: "Bash", input: { command: "git status" }, platform: "claude_code" } }';
