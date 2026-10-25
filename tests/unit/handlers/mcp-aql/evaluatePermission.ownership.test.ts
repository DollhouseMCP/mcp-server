/**
 * evaluate_permission × ownership policy (Issue #3153).
 *
 * Verifies the hook pipeline consults the ownership policy after static
 * classification, forwards session/cwd context, and fails closed.
 */

import { jest } from '@jest/globals';
import { evaluatePermission, type EvaluatePermissionDeps } from '../../../../src/handlers/mcp-aql/evaluatePermission.js';
import type { OwnershipDecision } from '../../../../src/handlers/mcp-aql/policies/OwnershipPolicy.js';

function deps(overrides: Partial<EvaluatePermissionDeps> = {}): EvaluatePermissionDeps {
  return {
    permissionPromptLimiter: {
      checkLimit: () => ({ allowed: true, remainingTokens: 99, resetTime: new Date() }),
      consumeToken: jest.fn(),
    } as any,
    classifyTool: () => ({ behavior: 'evaluate' as const, riskLevel: 'moderate' as const, reason: 'Requires evaluation' }),
    evaluateCliToolPolicy: () => ({ behavior: 'evaluate' as const }),
    getActiveElements: async () => [],
    ...overrides,
  };
}

function ownership(decision: OwnershipDecision | undefined) {
  return { evaluate: jest.fn(async () => decision) };
}

const decisionOf = (response: Record<string, unknown>) =>
  (response.hookSpecificOutput as Record<string, unknown>).permissionDecision;
const reasonOf = (response: Record<string, unknown>) =>
  (response.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason;

const MERGE = { tool_name: 'Bash', input: { command: 'gh pr merge 42' }, platform: 'claude_code', session_id: 'sess-1', cwd: '/work/repo' };

describe('evaluatePermission ownership policy stage', () => {
  it('denies when the ownership policy denies, before element policies run', async () => {
    const policy = ownership({ behavior: 'deny', reason: 'authored by stranger', policySource: 'ownership_policy' });
    const getActiveElements = jest.fn(async () => []);
    const response = await evaluatePermission(MERGE, deps({ ownershipPolicy: policy, getActiveElements }));
    expect(decisionOf(response)).toBe('deny');
    expect(reasonOf(response)).toBe('authored by stranger');
    expect(getActiveElements).not.toHaveBeenCalled();
  });

  it('asks when the ownership policy requires confirmation', async () => {
    const policy = ownership({ behavior: 'confirm', reason: 'lookup failed', policySource: 'ownership_policy' });
    const response = await evaluatePermission(MERGE, deps({ ownershipPolicy: policy }));
    expect(decisionOf(response)).toBe('ask');
    expect(reasonOf(response)).toBe('lookup failed');
  });

  it('lets an element deny win over an ownership confirm', async () => {
    const policy = ownership({ behavior: 'confirm', reason: 'ask', policySource: 'ownership_policy' });
    const response = await evaluatePermission(MERGE, deps({
      ownershipPolicy: policy,
      evaluateCliToolPolicy: () => ({ behavior: 'deny' as const, message: 'element says no' }),
    }));
    expect(decisionOf(response)).toBe('deny');
    expect(reasonOf(response)).toBe('element says no');
  });

  it('allows when the policy allows and nothing else objects', async () => {
    const policy = ownership({ behavior: 'allow', reason: 'own PR', policySource: 'ownership_policy' });
    expect(decisionOf(await evaluatePermission(MERGE, deps({ ownershipPolicy: policy })))).toBe('allow');
  });

  it('forwards session_id and cwd to the policy', async () => {
    const policy = ownership(undefined);
    await evaluatePermission(MERGE, deps({ ownershipPolicy: policy }));
    expect(policy.evaluate).toHaveBeenCalledWith('Bash', { command: 'gh pr merge 42' }, { sessionId: 'sess-1', cwd: '/work/repo' });
  });

  it('does not consult the policy for statically allowed or denied tools', async () => {
    const policy = ownership({ behavior: 'deny', reason: 'x', policySource: 'ownership_policy' });
    await evaluatePermission(MERGE, deps({
      ownershipPolicy: policy,
      classifyTool: () => ({ behavior: 'allow' as const, riskLevel: 'safe' as const, reason: 'safe' }),
    }));
    await evaluatePermission(MERGE, deps({
      ownershipPolicy: policy,
      classifyTool: () => ({ behavior: 'deny' as const, riskLevel: 'dangerous' as const, reason: 'dangerous' }),
    }));
    expect(policy.evaluate).not.toHaveBeenCalled();
  });

  it('fails closed (ask) when the policy itself throws', async () => {
    const policy = { evaluate: jest.fn(async () => { throw new Error('gh exploded'); }) };
    const response = await evaluatePermission(MERGE, deps({ ownershipPolicy: policy }));
    expect(decisionOf(response)).toBe('ask');
    expect(reasonOf(response)).toMatch(/ownership policy/i);
  });

  it('behaves as before when no ownership policy is configured', async () => {
    expect(decisionOf(await evaluatePermission(MERGE, deps()))).toBe('allow');
  });
});
