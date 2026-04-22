/**
 * Unit tests for auto-dollhouse evaluatePermission module.
 *
 * Tests platform-specific response formatting and the three-stage
 * evaluation pipeline (rate limit → static classification → element policy).
 */

import { jest } from '@jest/globals';
import { formatPermissionResponse, evaluatePermission, PermissionEvaluationError, SUPPORTED_PLATFORMS, type EvaluatePermissionDeps } from '../../../../src/handlers/mcp-aql/evaluatePermission.js';

function createMockDeps(overrides: Partial<EvaluatePermissionDeps> = {}): EvaluatePermissionDeps {
  return {
    permissionPromptLimiter: {
      checkLimit: () => ({ allowed: true, remainingTokens: 99, resetTime: new Date() }),
      consumeToken: jest.fn(),
      ...overrides.permissionPromptLimiter,
    } as any,
    classifyTool: overrides.classifyTool ?? (() => ({
      behavior: 'evaluate' as const,
      riskLevel: 'moderate',
      reason: 'Requires evaluation',
    })),
    evaluateCliToolPolicy: overrides.evaluateCliToolPolicy ?? (() => ({
      behavior: 'allow' as const,
    })),
    getActiveElements: overrides.getActiveElements ?? (async () => []),
  };
}

describe('evaluatePermission', () => {
  describe('formatPermissionResponse', () => {
    const input = { command: 'git status' };

    it('should format claude_code allow response', () => {
      expect(formatPermissionResponse('allow', 'claude_code', input))
        .toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        });
    });

    it('should format claude_code deny response with reason', () => {
      expect(formatPermissionResponse('deny', 'claude_code', input, 'Blocked by policy'))
        .toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Blocked by policy',
          },
        });
    });

    it('should format claude_code ask response with message', () => {
      expect(formatPermissionResponse('ask', 'claude_code', input, 'Needs approval'))
        .toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: 'Needs approval',
          },
        });
    });

    it('should format gemini response (maps ask to deny)', () => {
      expect(formatPermissionResponse('ask', 'gemini', input, 'Needs approval'))
        .toEqual({ decision: 'deny', reason: 'Needs approval' });
    });

    it('should format gemini allow response', () => {
      expect(formatPermissionResponse('allow', 'gemini', input))
        .toEqual({ decision: 'allow' });
    });

    it('should format cursor response', () => {
      expect(formatPermissionResponse('deny', 'cursor', input, 'Blocked'))
        .toEqual({ permission: 'deny', reason: 'Blocked' });
    });

    it('should format windsurf response', () => {
      expect(formatPermissionResponse('allow', 'windsurf', input))
        .toEqual({ allowed: true });
    });

    it('should format windsurf deny with reason', () => {
      expect(formatPermissionResponse('deny', 'windsurf', input, 'Nope'))
        .toEqual({ allowed: false, reason: 'Nope' });
    });

    it('should format codex allow response', () => {
      expect(formatPermissionResponse('allow', 'codex', input))
        .toEqual({});
    });

    it('should format codex response (maps ask to deny)', () => {
      expect(formatPermissionResponse('ask', 'codex', input, 'Review needed'))
        .toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Review needed',
          },
        });
    });

    it('should default to claude_code format for unknown platform', () => {
      expect(formatPermissionResponse('allow', 'unknown_platform', input))
        .toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        });
    });

    it('should omit reason when not provided', () => {
      expect(formatPermissionResponse('deny', 'gemini', input))
        .toEqual({ decision: 'deny' });
    });
  });

  describe('evaluatePermission pipeline', () => {
    it('should deny when rate limited', async () => {
      const deps = createMockDeps({
        permissionPromptLimiter: {
          checkLimit: () => ({ allowed: false, remainingTokens: 0, resetTime: new Date(), retryAfterMs: 1000 }),
          consumeToken: jest.fn(),
        } as any,
      });

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: { command: 'rm -rf /' }, platform: 'claude_code' },
        deps,
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Rate limit exceeded',
        },
      });
    });

    it('should allow when static classification allows', async () => {
      const deps = createMockDeps({
        classifyTool: () => ({ behavior: 'allow' as any, riskLevel: 'safe', reason: 'Safe tool' }),
      });

      const result = await evaluatePermission(
        { tool_name: 'Read', input: { file_path: 'src/index.ts' } },
        deps,
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    it('should deny when static classification denies', async () => {
      const deps = createMockDeps({
        classifyTool: () => ({ behavior: 'deny' as any, riskLevel: 'blocked', reason: 'Blocked tool' }),
      });

      const result = await evaluatePermission(
        { tool_name: 'DangerousTool', input: {} },
        deps,
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked tool',
        },
      });
    });

    it('should deny when element policy denies', async () => {
      const deps = createMockDeps({
        evaluateCliToolPolicy: () => ({
          behavior: 'deny' as any,
          message: 'Element policy deny: Bash:git push --force*',
        }),
      });

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: { command: 'git push --force' }, platform: 'claude_code' },
        deps,
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Element policy deny: Bash:git push --force*',
        },
      });
    });

    it('should map confirm to ask for hook platforms', async () => {
      const deps = createMockDeps({
        evaluateCliToolPolicy: () => ({
          behavior: 'confirm' as any,
          message: 'Requires human approval',
        }),
      });

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: { command: 'git push' }, platform: 'claude_code' },
        deps,
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Requires human approval',
        },
      });
    });

    it('should allow when element policy allows', async () => {
      const deps = createMockDeps({
        evaluateCliToolPolicy: () => ({ behavior: 'allow' as any }),
      });

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: { command: 'npm test' } },
        deps,
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    it('should default platform to claude_code', async () => {
      const deps = createMockDeps({
        classifyTool: () => ({ behavior: 'deny' as any, riskLevel: 'blocked', reason: 'No' }),
      });

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: { command: 'bad' } },
        deps,
      );

      // claude_code format
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'No',
        },
      });
    });

    it('should handle missing input gracefully', async () => {
      const deps = createMockDeps();

      const result = await evaluatePermission(
        { tool_name: 'Bash' },
        deps,
      );

      expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'allow');
    });

    it('should handle non-object input gracefully', async () => {
      const deps = createMockDeps();

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: 'not-an-object' },
        deps,
      );

      expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'allow');
    });

    it('should consume rate limit token on successful check', async () => {
      const consumeToken = jest.fn();
      const deps = createMockDeps({
        permissionPromptLimiter: {
          checkLimit: () => ({ allowed: true, remainingTokens: 50, resetTime: new Date() }),
          consumeToken,
        } as any,
      });

      await evaluatePermission({ tool_name: 'Bash', input: {} }, deps);

      expect(consumeToken).toHaveBeenCalledTimes(1);
    });

    it('should not consume rate limit token when rate limited', async () => {
      const consumeToken = jest.fn();
      const deps = createMockDeps({
        permissionPromptLimiter: {
          checkLimit: () => ({ allowed: false, remainingTokens: 0, resetTime: new Date(), retryAfterMs: 5000 }),
          consumeToken,
        } as any,
      });

      await evaluatePermission({ tool_name: 'Bash', input: {} }, deps);

      expect(consumeToken).not.toHaveBeenCalled();
    });

    it('should throw PermissionEvaluationError when element fetch fails', async () => {
      const deps = createMockDeps({
        getActiveElements: async () => { throw new Error('Database timeout'); },
      });

      await expect(evaluatePermission(
        { tool_name: 'Bash', input: { command: 'test' } },
        deps,
      )).rejects.toThrow(PermissionEvaluationError);

      try {
        await evaluatePermission({ tool_name: 'Bash', input: {} }, deps);
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionEvaluationError);
        expect((err as PermissionEvaluationError).stage).toBe('element_fetch');
        expect((err as PermissionEvaluationError).toolName).toBe('Bash');
      }
    });

    it('passes session_id through to the active-element lookup', async () => {
      const getActiveElements = jest.fn().mockResolvedValue([]);
      const deps = createMockDeps({ getActiveElements });

      await evaluatePermission(
        {
          tool_name: 'Bash',
          input: { command: 'git status' },
          platform: 'claude_code',
          session_id: 'session-follower-1',
        },
        deps,
      );

      expect(getActiveElements).toHaveBeenCalledWith('session-follower-1');
    });
  });

  describe('platform support', () => {
    it('should export list of supported platforms', () => {
      expect(SUPPORTED_PLATFORMS).toContain('claude_code');
      expect(SUPPORTED_PLATFORMS).toContain('gemini');
      expect(SUPPORTED_PLATFORMS).toContain('cursor');
      expect(SUPPORTED_PLATFORMS).toContain('windsurf');
      expect(SUPPORTED_PLATFORMS).toContain('codex');
      expect(SUPPORTED_PLATFORMS).toContain('vscode');
      expect(SUPPORTED_PLATFORMS.length).toBe(6);
    });

    it('should default to claude_code format for unknown platform', () => {
      const result = formatPermissionResponse('allow', 'unknown_platform', {});
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });
  });
});
