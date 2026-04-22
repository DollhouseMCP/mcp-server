/**
 * Permission Flow Platform Adapter Tests (Issue #1669)
 *
 * Verifies that the MCP server's internal permission decisions translate
 * correctly to each platform's expected response format. This is the
 * bridge between the platform-agnostic policy engine and the platform-
 * specific hook/delegation protocols.
 *
 * Platforms covered:
 * - Claude Code (--permission-prompt-tool MCP delegation)
 * - Gemini CLI (BeforeTool hook JSON protocol)
 * - Cursor (preToolUse/beforeShellExecution hook JSON protocol)
 * - Codex CLI (PreToolUse hook with hookSpecificOutput)
 * - Windsurf (Cascade hook exit code protocol)
 * - VS Code Copilot (PreToolUse hook, Claude Code-compatible)
 * - JetBrains Junie (Action Allowlist regex export)
 *
 * These tests verify the TRANSLATION layer, not the policy evaluation
 * itself (that's covered by permission-flow-matrix.test.ts).
 *
 * Keep adapter expectations in sync with
 * docs/architecture/permission-hook-platform-contracts.md.
 *
 * @module
 */

import { describe, it, expect } from '@jest/globals';
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import {
  evaluateCliToolPolicy,
  type CliToolPolicyResult,
} from '../../../src/handlers/mcp-aql/policies/ToolClassification.js';
import type { ActiveElement } from '../../../src/handlers/mcp-aql/policies/ElementPolicies.js';
import {
  getDefaultPermissionLevel,
  getAutoApprovedOperations,
  getOperationsAtLevel,
} from '../../../src/handlers/mcp-aql/policies/OperationPolicies.js';

// ── Platform Response Format Types ──

/** Claude Code's --permission-prompt-tool response format */
interface ClaudeCodeResponse {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
  approvalRequest?: {
    requestId: string;
    toolName: string;
    riskLevel: string;
    reason: string;
  };
}

/** Gemini CLI BeforeTool hook response format */
interface GeminiHookResponse {
  decision: 'allow' | 'deny';
  reason?: string;
  systemMessage?: string;
}

/** Cursor beforeShellExecution/beforeMCPExecution hook response format */
interface CursorHookResponse {
  permission: 'allow' | 'deny' | 'ask';
  userMessage?: string;
  agentMessage?: string;
}

/** Codex CLI PreToolUse hook response format */
interface CodexHookResponse {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason?: string;
  };
}

/** Windsurf Cascade hook response (exit code based) */
interface WindsurfHookResponse {
  exitCode: 0 | 2;
  stderr?: string;
}

/** VS Code Copilot PreToolUse hook response (Claude Code compatible) */
interface VSCodeHookResponse {
  permission: 'allow' | 'deny' | 'ask';
  reason?: string;
}

/** JetBrains Junie allowlist entry */
interface JunieAllowlistEntry {
  pattern: string;
  type: 'exact' | 'regex';
}

// ── Platform Adapter Functions ──
// These simulate what the permission server adapters would produce.

/**
 * Translate a CliToolPolicyResult to Claude Code's response format.
 * Claude Code uses the full MCP permission_prompt protocol.
 */
function toClaudeCode(result: CliToolPolicyResult, toolName: string): ClaudeCodeResponse {
  if (result.behavior === 'allow' || result.behavior === 'evaluate') {
    return { behavior: 'allow' };
  }
  if (result.behavior === 'confirm') {
    // Claude Code's permission_prompt returns deny with an approvalRequest
    return {
      behavior: 'deny',
      message: result.message,
      approvalRequest: {
        requestId: `cli-test-${Date.now()}`,
        toolName,
        riskLevel: 'moderate',
        reason: result.message ?? 'Requires approval',
      },
    };
  }
  // deny
  return {
    behavior: 'deny',
    message: result.message,
  };
}

/**
 * Translate a CliToolPolicyResult to Gemini CLI BeforeTool hook format.
 * Gemini hooks return { decision: 'allow' | 'deny' } via JSON stdout.
 * No 'ask' option — confirm maps to deny with reason.
 */
function toGeminiHook(result: CliToolPolicyResult): GeminiHookResponse {
  if (result.behavior === 'allow' || result.behavior === 'evaluate') {
    return { decision: 'allow' };
  }
  // Both 'deny' and 'confirm' map to deny — Gemini has no confirm/ask
  return {
    decision: 'deny',
    reason: result.message,
    systemMessage: result.behavior === 'confirm'
      ? `Requires approval: ${result.message}`
      : result.message,
  };
}

/**
 * Translate a CliToolPolicyResult to Cursor hook format.
 * Cursor hooks support { permission: 'allow' | 'deny' | 'ask' }.
 * 'confirm' maps to 'ask' (escalate to user dialog).
 */
function toCursorHook(result: CliToolPolicyResult): CursorHookResponse {
  if (result.behavior === 'allow' || result.behavior === 'evaluate') {
    return { permission: 'allow' };
  }
  if (result.behavior === 'confirm') {
    return {
      permission: 'ask',
      userMessage: result.message,
      agentMessage: `This action requires approval: ${result.message}`,
    };
  }
  return {
    permission: 'deny',
    userMessage: result.message,
    agentMessage: result.message,
  };
}

/**
 * Translate a CliToolPolicyResult to Codex CLI PreToolUse hook format.
 * Codex PreToolUse currently supports explicit deny only.
 * Allow/evaluate returns empty stdout; confirm maps to deny.
 */
function toCodexHook(result: CliToolPolicyResult): CodexHookResponse {
  if (result.behavior === 'allow' || result.behavior === 'evaluate') {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.message ?? '',
    },
  };
}

/**
 * Translate a CliToolPolicyResult to Windsurf exit code format.
 * Windsurf hooks are binary: exit 0 (allow) or exit 2 (block).
 * No structured response, no 'ask' option.
 */
function toWindsurfHook(result: CliToolPolicyResult): WindsurfHookResponse {
  if (result.behavior === 'allow' || result.behavior === 'evaluate') {
    return { exitCode: 0 };
  }
  return {
    exitCode: 2,
    stderr: result.message,
  };
}

/**
 * Translate a CliToolPolicyResult to VS Code Copilot PreToolUse format.
 * VS Code uses the same allow/deny/ask model as Cursor.
 * 'confirm' maps to 'ask'.
 */
function toVSCodeHook(result: CliToolPolicyResult): VSCodeHookResponse {
  if (result.behavior === 'allow' || result.behavior === 'evaluate') {
    return { permission: 'allow' };
  }
  if (result.behavior === 'confirm') {
    return { permission: 'ask', reason: result.message };
  }
  return { permission: 'deny', reason: result.message };
}

/**
 * Generate JetBrains Junie allowlist entries from element allow patterns.
 * Converts glob patterns to regex format for allowlist.json.
 */
function toJunieAllowlist(allowPatterns: string[]): JunieAllowlistEntry[] {
  return allowPatterns
    .filter(p => p.startsWith('Bash:'))
    .map(pattern => {
      const command = pattern.slice(5); // Strip 'Bash:' prefix
      // Convert glob wildcards to regex: escape special chars, then convert * and ?
      const escaped = command.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
      const regex = `^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`;
      return { pattern: regex, type: 'regex' as const };
    });
}

// ── Test Elements ──

/** Standard test ensemble with deny/confirm/allow patterns */
const TEST_ENSEMBLE: ActiveElement = {
  type: 'ensemble',
  name: 'test-auto-dollhouse',
  metadata: {
    gatekeeper: {
      externalRestrictions: {
        description: 'Test policy for platform adapter verification',
        denyPatterns: ['Bash:git push --force*', 'Bash:rm -rf*'],
        confirmPatterns: ['Bash:gh pr merge*', 'Bash:npm install*'],
        allowPatterns: [
          'Bash:git status*', 'Bash:git log*', 'Bash:git diff*',
          'Bash:git commit*', 'Bash:git push *',
          'Bash:gh issue *', 'Bash:gh pr list*', 'Bash:gh pr view*',
          'Bash:npm test*', 'Bash:npm run *',
          'Edit:*', 'Read:*', 'Glob:*', 'Grep:*',
        ],
      },
    },
  },
};

// ── Test Cases: Common scenarios every platform must handle ──

interface TestScenario {
  name: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  expectedBehavior: 'allow' | 'deny' | 'confirm' | 'evaluate';
}

/**
 * NOTE: Read, Glob, Grep, WebSearch, WebFetch are statically classified as
 * safe by classifyTool() BEFORE evaluateCliToolPolicy() is called. They never
 * reach the element policy evaluation layer. These tests focus on Bash commands
 * which are the primary subject of element policy deny/confirm/allow patterns.
 * The static classification layer is tested in ToolClassification.test.ts.
 */
const SCENARIOS: TestScenario[] = [
  // Safe Bash commands, explicitly allowed by element policy
  { name: 'git status (allowed)', toolName: 'Bash', toolInput: { command: 'git status' }, expectedBehavior: 'allow' },
  { name: 'npm test (allowed)', toolName: 'Bash', toolInput: { command: 'npm test' }, expectedBehavior: 'allow' },
  { name: 'npm run build (allowed)', toolName: 'Bash', toolInput: { command: 'npm run build' }, expectedBehavior: 'allow' },
  { name: 'git commit (allowed)', toolName: 'Bash', toolInput: { command: 'git commit -m "test"' }, expectedBehavior: 'allow' },
  { name: 'gh issue list (allowed)', toolName: 'Bash', toolInput: { command: 'gh issue list --limit 10' }, expectedBehavior: 'allow' },
  { name: 'git push (allowed, non-force)', toolName: 'Bash', toolInput: { command: 'git push origin develop' }, expectedBehavior: 'allow' },

  // Denied by element denyPatterns
  { name: 'git push --force (denied)', toolName: 'Bash', toolInput: { command: 'git push --force origin main' }, expectedBehavior: 'deny' },
  { name: 'rm -rf (denied)', toolName: 'Bash', toolInput: { command: 'rm -rf /tmp/stuff' }, expectedBehavior: 'deny' },

  // Requires confirmation via element confirmPatterns
  { name: 'gh pr merge (confirm)', toolName: 'Bash', toolInput: { command: 'gh pr merge 42 --merge' }, expectedBehavior: 'confirm' },
  { name: 'npm install (confirm)', toolName: 'Bash', toolInput: { command: 'npm install lodash' }, expectedBehavior: 'confirm' },

  // Not in any allowlist (denied by allowlist miss)
  { name: 'curl (not in allowlist)', toolName: 'Bash', toolInput: { command: 'curl https://example.com' }, expectedBehavior: 'deny' },
  { name: 'python (not in allowlist)', toolName: 'Bash', toolInput: { command: 'python3 -c "print(1)"' }, expectedBehavior: 'deny' },
  { name: 'docker run (not in allowlist)', toolName: 'Bash', toolInput: { command: 'docker run -it ubuntu' }, expectedBehavior: 'deny' },
];

// ── Tests ──

describe('Permission Flow Platform Adapters (Issue #1669)', () => {

  // First verify our test scenarios produce the expected raw behaviors
  describe('Raw policy evaluation baseline', () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name} → ${scenario.expectedBehavior}`, () => {
        const result = evaluateCliToolPolicy(
          scenario.toolName,
          scenario.toolInput,
          [TEST_ENSEMBLE]
        );
        // 'evaluate' means "fall through to default" which is effectively allow
        // when no static classification blocks it
        if (scenario.expectedBehavior === 'allow') {
          expect(['allow', 'evaluate']).toContain(result.behavior);
        } else {
          expect(result.behavior).toBe(scenario.expectedBehavior);
        }
      });
    }
  });

  // ── Claude Code Adapter ──

  describe('Claude Code adapter (--permission-prompt-tool)', () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name}`, () => {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        const response = toClaudeCode(raw, scenario.toolName);

        if (scenario.expectedBehavior === 'allow') {
          expect(response.behavior).toBe('allow');
          expect(response.approvalRequest).toBeUndefined();
        } else if (scenario.expectedBehavior === 'confirm') {
          expect(response.behavior).toBe('deny');
          expect(response.approvalRequest).toBeDefined();
          expect(response.approvalRequest?.reason).toMatch(/requires approval|confirmation/i);
        } else {
          expect(response.behavior).toBe('deny');
          expect(response.message).toBeDefined();
        }
      });
    }

    it('confirm response should include approvalRequest with requestId', () => {
      const raw = evaluateCliToolPolicy('Bash', { command: 'gh pr merge 42' }, [TEST_ENSEMBLE]);
      const response = toClaudeCode(raw, 'Bash');
      expect(response.approvalRequest?.requestId).toBeDefined();
      expect(response.approvalRequest?.toolName).toBe('Bash');
    });
  });

  // ── Gemini CLI Adapter ──

  describe('Gemini CLI adapter (BeforeTool hook)', () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name}`, () => {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        const response = toGeminiHook(raw);

        if (scenario.expectedBehavior === 'allow') {
          expect(response.decision).toBe('allow');
        } else {
          // Both deny and confirm → deny in Gemini (no ask option)
          expect(response.decision).toBe('deny');
          expect(response.reason).toBeDefined();
        }
      });
    }

    it('confirm maps to deny with "Requires approval" systemMessage', () => {
      const raw = evaluateCliToolPolicy('Bash', { command: 'npm install lodash' }, [TEST_ENSEMBLE]);
      const response = toGeminiHook(raw);
      expect(response.decision).toBe('deny');
      expect(response.systemMessage).toMatch(/requires approval/i);
    });

    it('hard deny does not include "Requires approval" prefix', () => {
      const raw = evaluateCliToolPolicy('Bash', { command: 'git push --force origin' }, [TEST_ENSEMBLE]);
      const response = toGeminiHook(raw);
      expect(response.decision).toBe('deny');
      expect(response.systemMessage).not.toMatch(/^Requires approval/);
    });
  });

  // ── Cursor Adapter ──

  describe('Cursor adapter (preToolUse hook)', () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name}`, () => {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        const response = toCursorHook(raw);

        if (scenario.expectedBehavior === 'allow') {
          expect(response.permission).toBe('allow');
        } else if (scenario.expectedBehavior === 'confirm') {
          // Cursor supports 'ask' — confirm maps to ask
          expect(response.permission).toBe('ask');
          expect(response.userMessage).toBeDefined();
        } else {
          expect(response.permission).toBe('deny');
        }
      });
    }

    it('ask response includes both userMessage and agentMessage', () => {
      const raw = evaluateCliToolPolicy('Bash', { command: 'gh pr merge 42' }, [TEST_ENSEMBLE]);
      const response = toCursorHook(raw);
      expect(response.permission).toBe('ask');
      expect(response.userMessage).toBeDefined();
      expect(response.agentMessage).toMatch(/requires approval/i);
    });
  });

  // ── Codex CLI Adapter ──

  describe('Codex CLI adapter (PreToolUse hook)', () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name}`, () => {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        const response = toCodexHook(raw);

        if (scenario.expectedBehavior === 'allow') {
          expect(response).toEqual({});
        } else {
          // Both deny and confirm → deny in Codex (no ask)
          expect(response.hookSpecificOutput).toBeDefined();
          expect(response.hookSpecificOutput?.permissionDecision).toBe('deny');
        }
      });
    }

    it('deny includes reason in permissionDecisionReason', () => {
      const raw = evaluateCliToolPolicy('Bash', { command: 'git push --force' }, [TEST_ENSEMBLE]);
      const response = toCodexHook(raw);
      expect(response.hookSpecificOutput?.permissionDecisionReason).toBeDefined();
    });
  });

  // ── Windsurf Adapter ──

  describe('Windsurf adapter (Cascade hook exit codes)', () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name}`, () => {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        const response = toWindsurfHook(raw);

        if (scenario.expectedBehavior === 'allow') {
          expect(response.exitCode).toBe(0);
        } else {
          // All non-allow → exit code 2 (Windsurf is binary)
          expect(response.exitCode).toBe(2);
        }
      });
    }

    it('block response includes reason in stderr', () => {
      const raw = evaluateCliToolPolicy('Bash', { command: 'rm -rf /tmp' }, [TEST_ENSEMBLE]);
      const response = toWindsurfHook(raw);
      expect(response.exitCode).toBe(2);
      expect(response.stderr).toBeDefined();
    });
  });

  // ── VS Code Copilot Adapter ──

  describe('VS Code Copilot adapter (PreToolUse hook)', () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name}`, () => {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        const response = toVSCodeHook(raw);

        if (scenario.expectedBehavior === 'allow') {
          expect(response.permission).toBe('allow');
        } else if (scenario.expectedBehavior === 'confirm') {
          // VS Code supports 'ask' like Cursor
          expect(response.permission).toBe('ask');
          expect(response.reason).toBeDefined();
        } else {
          expect(response.permission).toBe('deny');
        }
      });
    }

    it('should produce identical results to Cursor for all scenarios', () => {
      for (const scenario of SCENARIOS) {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        const cursorResponse = toCursorHook(raw);
        const vscodeResponse = toVSCodeHook(raw);
        // VS Code and Cursor use the same allow/deny/ask model
        expect(vscodeResponse.permission).toBe(cursorResponse.permission);
      }
    });
  });

  // ── JetBrains Junie Adapter ──

  describe('JetBrains Junie adapter (Action Allowlist export)', () => {
    it('should export Bash allow patterns as regex entries', () => {
      const allowPatterns = TEST_ENSEMBLE.metadata?.gatekeeper?.externalRestrictions?.allowPatterns ?? [];
      const entries = toJunieAllowlist(allowPatterns);

      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.type).toBe('regex');
        expect(entry.pattern).toMatch(/^\^/); // Starts with ^
        expect(entry.pattern).toMatch(/\$$/); // Ends with $
      }
    });

    it('should convert glob * to regex .*', () => {
      const entries = toJunieAllowlist(['Bash:git status*']);
      expect(entries).toHaveLength(1);
      expect(entries[0].pattern).toBe('^git status.*$');
    });

    it('should skip non-Bash patterns', () => {
      const entries = toJunieAllowlist(['Bash:git *', 'Edit:*', 'Read:*']);
      expect(entries).toHaveLength(1);
      expect(entries[0].pattern).toMatch(/git/);
    });

    it('should produce entries that match expected commands', () => {
      const entries = toJunieAllowlist(['Bash:npm test*']);
      const regex = new RegExp(entries[0].pattern);
      expect(regex.test('npm test')).toBe(true);
      expect(regex.test('npm test --coverage')).toBe(true);
      expect(regex.test('npm install lodash')).toBe(false);
    });
  });

  // ── Cross-Platform Decision Consistency ──

  describe('Cross-platform decision consistency', () => {
    it('all platforms should agree on allow decisions', () => {
      const allowScenarios = SCENARIOS.filter(s => s.expectedBehavior === 'allow');
      for (const scenario of allowScenarios) {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        expect(toClaudeCode(raw, scenario.toolName).behavior).toBe('allow');
        expect(toGeminiHook(raw).decision).toBe('allow');
        expect(toCursorHook(raw).permission).toBe('allow');
        expect(toCodexHook(raw)).toEqual({});
        expect(toWindsurfHook(raw).exitCode).toBe(0);
        expect(toVSCodeHook(raw).permission).toBe('allow');
      }
    });

    it('all platforms should agree on deny decisions', () => {
      const denyScenarios = SCENARIOS.filter(s => s.expectedBehavior === 'deny');
      for (const scenario of denyScenarios) {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);
        expect(toClaudeCode(raw, scenario.toolName).behavior).toBe('deny');
        expect(toGeminiHook(raw).decision).toBe('deny');
        expect(toCursorHook(raw).permission).toBe('deny');
        expect(toCodexHook(raw).hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(toWindsurfHook(raw).exitCode).toBe(2);
        expect(toVSCodeHook(raw).permission).toBe('deny');
      }
    });

    it('confirm decisions should map to platform-appropriate responses', () => {
      const confirmScenarios = SCENARIOS.filter(s => s.expectedBehavior === 'confirm');
      for (const scenario of confirmScenarios) {
        const raw = evaluateCliToolPolicy(scenario.toolName, scenario.toolInput, [TEST_ENSEMBLE]);

        // Claude Code: deny with approvalRequest
        const claude = toClaudeCode(raw, scenario.toolName);
        expect(claude.behavior).toBe('deny');
        expect(claude.approvalRequest).toBeDefined();

        // Gemini: deny (no ask option)
        expect(toGeminiHook(raw).decision).toBe('deny');

        // Cursor: ask (has ask option)
        expect(toCursorHook(raw).permission).toBe('ask');

        // Codex: deny (no ask)
        expect(toCodexHook(raw).hookSpecificOutput?.permissionDecision).toBe('deny');

        // Windsurf: exit 2 (binary, no ask)
        expect(toWindsurfHook(raw).exitCode).toBe(2);

        // VS Code: ask (has ask option, like Cursor)
        expect(toVSCodeHook(raw).permission).toBe('ask');
      }
    });
  });

  // ── Platform Capability Matrix ──

  describe('Platform capability matrix', () => {
    const PLATFORM_CAPABILITIES = {
      'Claude Code': { allow: true, deny: true, ask: false, confirm: true, modifyInput: true },
      'Gemini CLI': { allow: true, deny: true, ask: false, confirm: false, modifyInput: true },
      'Cursor': { allow: true, deny: true, ask: true, confirm: false, modifyInput: false },
      'Codex CLI': { allow: true, deny: true, ask: false, confirm: false, modifyInput: false, explicitAllow: false },
      'Windsurf': { allow: true, deny: true, ask: false, confirm: false, modifyInput: false },
      'VS Code': { allow: true, deny: true, ask: true, confirm: false, modifyInput: false },
      'JetBrains': { allow: true, deny: false, ask: false, confirm: false, modifyInput: false },
    };

    it('should document platform capabilities for each decision type', () => {
      // This test serves as living documentation
      for (const [platform, caps] of Object.entries(PLATFORM_CAPABILITIES)) {
        // Every platform must support allow and deny at minimum
        expect(caps.allow).toBe(true);
        if (platform !== 'JetBrains') {
          expect(caps.deny).toBe(true);
        }
      }
    });

    it('only Cursor and VS Code support the ask (escalate to user) decision', () => {
      const askPlatforms = Object.entries(PLATFORM_CAPABILITIES)
        .filter(([, caps]) => caps.ask)
        .map(([name]) => name);
      expect(askPlatforms).toEqual(['Cursor', 'VS Code']);
    });

    it('only Claude Code supports the full confirm round-trip', () => {
      const confirmPlatforms = Object.entries(PLATFORM_CAPABILITIES)
        .filter(([, caps]) => caps.confirm)
        .map(([name]) => name);
      expect(confirmPlatforms).toEqual(['Claude Code']);
    });

    it('JetBrains is allowlist-only (no deny, no runtime evaluation)', () => {
      const jb = PLATFORM_CAPABILITIES['JetBrains'];
      expect(jb.allow).toBe(true);
      expect(jb.deny).toBe(false);
      expect(jb.ask).toBe(false);
      expect(jb.confirm).toBe(false);
    });
  });

  // ── MCP-AQL Operation-Level Platform Mapping ──

  describe('MCP-AQL operation permission levels — platform implications', () => {
    it('AUTO_APPROVE operations need no platform-specific handling', () => {
      const autoOps = getAutoApprovedOperations();
      // These just pass through on every platform — no hook needed
      expect(autoOps.length).toBeGreaterThan(20);
    });

    it('CONFIRM_SESSION operations map to single-approval on all platforms', () => {
      const sessionOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SESSION);
      // On Claude Code: currently requires confirm_operation round-trip
      // On other platforms: would map to a single deny/ask on first call
      // After #1653 auto-confirm: would be single-approval everywhere
      for (const op of sessionOps) {
        expect(getDefaultPermissionLevel(op)).toBe(PermissionLevel.CONFIRM_SESSION);
      }
    });

    it('CONFIRM_SINGLE_USE operations require per-invocation approval on all platforms', () => {
      const singleOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SINGLE_USE);
      // These need approval every time, regardless of platform
      // On Claude Code: confirm_operation (single_use) + retry
      // On hook platforms: deny every time, user must re-invoke
      for (const op of singleOps) {
        expect(getDefaultPermissionLevel(op)).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
        // These are the operations that remain high-friction on all platforms
      }
      expect(singleOps).toContain('execute_agent');
      expect(singleOps).toContain('delete_element');
      expect(singleOps).toContain('edit_element');
    });
  });
});
