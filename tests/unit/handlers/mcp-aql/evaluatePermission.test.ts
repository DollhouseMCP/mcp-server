/**
 * Unit tests for auto-dollhouse evaluatePermission module.
 *
 * Tests platform-specific response formatting and the three-stage
 * evaluation pipeline (rate limit → static classification → element policy).
 */

import { jest } from '@jest/globals';
import { formatPermissionResponse, evaluatePermission, type EvaluatePermissionDeps } from '../../../../src/handlers/mcp-aql/evaluatePermission.js';

describe('evaluatePermission', () => {
  describe('formatPermissionResponse', () => {
    const input = { command: 'git status' };

    it('should format claude_code allow response', () => {
      expect(formatPermissionResponse('allow', 'claude_code', input))
        .toEqual({ decision: 'allow' });
    });

    it('should format claude_code deny response with reason', () => {
      expect(formatPermissionResponse('deny', 'claude_code', input, 'Blocked by policy'))
        .toEqual({ decision: 'deny', reason: 'Blocked by policy' });
    });

    it('should format claude_code ask response with message', () => {
      expect(formatPermissionResponse('ask', 'claude_code', input, 'Needs approval'))
        .toEqual({ decision: 'ask', message: 'Needs approval' });
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

    it('should format codex response (maps ask to deny)', () => {
      expect(formatPermissionResponse('ask', 'codex', input, 'Review needed'))
        .toEqual({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            reason: 'Review needed',
          },
        });
    });

    it('should default to claude_code format for unknown platform', () => {
      expect(formatPermissionResponse('allow', 'unknown_platform', input))
        .toEqual({ decision: 'allow' });
    });

    it('should omit reason when not provided', () => {
      expect(formatPermissionResponse('deny', 'gemini', input))
        .toEqual({ decision: 'deny' });
    });
  });

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

      expect(result).toEqual({ decision: 'deny', reason: 'Rate limit exceeded' });
    });

    it('should allow when static classification allows', async () => {
      const deps = createMockDeps({
        classifyTool: () => ({ behavior: 'allow' as any, riskLevel: 'safe', reason: 'Safe tool' }),
      });

      const result = await evaluatePermission(
        { tool_name: 'Read', input: { file_path: '/tmp/test' } },
        deps,
      );

      expect(result).toEqual({ decision: 'allow' });
    });

    it('should deny when static classification denies', async () => {
      const deps = createMockDeps({
        classifyTool: () => ({ behavior: 'deny' as any, riskLevel: 'blocked', reason: 'Blocked tool' }),
      });

      const result = await evaluatePermission(
        { tool_name: 'DangerousTool', input: {} },
        deps,
      );

      expect(result).toEqual({ decision: 'deny', reason: 'Blocked tool' });
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

      expect(result).toEqual({ decision: 'deny', reason: 'Element policy deny: Bash:git push --force*' });
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

      expect(result).toEqual({ decision: 'ask', message: 'Requires human approval' });
    });

    it('should allow when element policy allows', async () => {
      const deps = createMockDeps({
        evaluateCliToolPolicy: () => ({ behavior: 'allow' as any }),
      });

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: { command: 'npm test' } },
        deps,
      );

      expect(result).toEqual({ decision: 'allow' });
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
      expect(result).toEqual({ decision: 'deny', reason: 'No' });
    });

    it('should handle missing input gracefully', async () => {
      const deps = createMockDeps();

      const result = await evaluatePermission(
        { tool_name: 'Bash' },
        deps,
      );

      expect(result).toHaveProperty('decision');
    });

    it('should handle non-object input gracefully', async () => {
      const deps = createMockDeps();

      const result = await evaluatePermission(
        { tool_name: 'Bash', input: 'not-an-object' },
        deps,
      );

      expect(result).toHaveProperty('decision');
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
  });
});
