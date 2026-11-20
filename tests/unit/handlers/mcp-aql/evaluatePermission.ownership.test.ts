/**
 * evaluate_permission × ownership policy (Issue #3153).
 *
 * Verifies the hook pipeline consults the ownership policy after static
 * classification, forwards session/cwd context, and fails closed.
 */

import { jest } from '@jest/globals';
import { evaluatePermission, type EvaluatePermissionDeps } from '../../../../src/handlers/mcp-aql/evaluatePermission.js';
import { classifyTool } from '../../../../src/handlers/mcp-aql/policies/ToolClassification.js';
import { OwnershipPolicyService } from '../../../../src/handlers/mcp-aql/policies/OwnershipPolicyService.js';
import { OwnershipCache, type OwnershipResolver } from '../../../../src/handlers/mcp-aql/policies/OwnershipLookup.js';
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

  it('keeps a static deny final without consulting ownership', async () => {
    const policy = ownership({ behavior: 'deny', reason: 'x', policySource: 'ownership_policy' });
    await evaluatePermission(MERGE, deps({
      ownershipPolicy: policy,
      classifyTool: () => ({ behavior: 'deny' as const, riskLevel: 'dangerous' as const, reason: 'dangerous' }),
    }));
    expect(policy.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    'gh pr checks 5 && gh pr merge 5 --squash',
    'gh pr view 5; gh pr merge 5',
    'git status && git push origin someone-elses-branch',
  ])('asks for a chained mutation even when the static glob allows it: %s', async (command) => {
    const input = { command };
    expect(classifyTool('Bash', input).behavior).toBe('allow');
    const lookup = jest.fn<OwnershipResolver['lookup']>().mockResolvedValue({ status: 'resolved', authorLogin: 'stranger' });
    const policy = new OwnershipPolicyService({
      config: { mode: 'confirm', ownerLogin: 'mickdarling', teammates: [] },
      resolver: { lookup, resolveOwnerLogin: async () => 'mickdarling' },
      cache: new OwnershipCache(),
    });
    const response = await evaluatePermission({ ...MERGE, input }, deps({ ownershipPolicy: policy, classifyTool }));
    expect(decisionOf(response)).toBe('ask');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'commit message heredoc', command: "git commit -m \"$(cat <<'EOF'\nSubject\nBody\nEOF\n)\"" },
    { name: 'PR creation heredoc', command: "gh pr create --title t --body \"$(cat <<'EOF'\nSummary\nEOF\n)\"" },
    { name: 'long Python script', command: "python - <<'EOF'\n" + 'print(1)\n'.repeat(600) + 'EOF\n' },
    { name: 'long local file write', command: 'cat > example.txt <<"EOF"\n' + 'local data\n'.repeat(600) + 'EOF\n' },
  ])('allows $name through ownership without an auth or author lookup', async ({ command }) => {
    const lookup = jest.fn<OwnershipResolver['lookup']>().mockResolvedValue({ status: 'error', message: 'unexpected lookup' });
    const resolveOwnerLogin = jest.fn<OwnershipResolver['resolveOwnerLogin']>().mockResolvedValue(undefined);
    const policy = new OwnershipPolicyService({
      config: { mode: 'confirm', teammates: [] }, resolver: { lookup, resolveOwnerLogin }, cache: new OwnershipCache(),
    });
    const response = await evaluatePermission({ ...MERGE, input: { command } }, deps({ ownershipPolicy: policy }));
    expect(decisionOf(response)).toBe('allow');
    expect(lookup).not.toHaveBeenCalled();
    expect(resolveOwnerLogin).not.toHaveBeenCalled();
  });

  it('preserves a static allow for a read with no ownership intent', async () => {
    const policy = ownership(undefined);
    const getActiveElements = jest.fn(async () => []);
    const response = await evaluatePermission({ ...MERGE, input: { command: 'gh pr view 5' } },
      deps({ ownershipPolicy: policy, classifyTool, getActiveElements }));
    expect(decisionOf(response)).toBe('allow');
    expect(policy.evaluate).toHaveBeenCalledTimes(1);
    expect(getActiveElements).not.toHaveBeenCalled();
  });

  it('lets ownership deny override a static allow', async () => {
    const policy = ownership({ behavior: 'deny', reason: 'foreign PR', policySource: 'ownership_policy' });
    const response = await evaluatePermission({ ...MERGE, input: { command: 'gh pr view 5; gh pr merge 5' } },
      deps({ ownershipPolicy: policy, classifyTool }));
    expect(decisionOf(response)).toBe('deny');
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
