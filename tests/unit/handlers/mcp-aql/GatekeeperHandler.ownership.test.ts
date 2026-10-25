/**
 * permission_prompt × ownership policy (Issue #3153).
 *
 * The non-interactive --permission-prompt-tool path must deny or request
 * human approval for mutations of PRs/issues the agent does not own, and
 * honour an approval that was already granted for the retry.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { GatekeeperHandler, type GatekeeperHandlerDeps } from '../../../../src/handlers/mcp-aql/GatekeeperHandler.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { OperationRegistry } from '../../../../src/handlers/mcp-aql/OperationRegistry.js';
import { RateLimiterFactory } from '../../../../src/utils/RateLimiter.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { OwnershipDecision } from '../../../../src/handlers/mcp-aql/policies/OwnershipPolicy.js';

function fixture(decision: OwnershipDecision | undefined | Error) {
  const collect = jest.fn<GatekeeperHandlerDeps['getActiveElements']>().mockResolvedValue([]);
  const gatekeeper = new Gatekeeper(undefined, { enableAuditLogging: false });
  const createApproval = jest.spyOn(gatekeeper, 'createCliApprovalRequest').mockResolvedValue('cli-00000000-0000-4000-8000-000000000000');
  const checkApproval = jest.spyOn(gatekeeper, 'checkCliApproval');
  const operations = new OperationRegistry();
  const evaluate = jest.fn(async () => {
    if (decision instanceof Error) throw decision;
    return decision;
  });
  const handler = new GatekeeperHandler({
    handlers: {} as HandlerRegistry, operations, gatekeeper, executingAgents: new Map(),
    getActiveElements: collect, getPolicyReportElements: collect,
    getEndpointForOperation: operation => operations.getRoute(operation)!.endpoint,
    resolvePermissionPromptLimiter: () => RateLimiterFactory.createPermissionPromptLimiter(),
    resolveCliApprovalLimiter: () => RateLimiterFactory.createCliApprovalLimiter(),
    resolveVerificationRateLimiter: () => ({ isLimited: () => false, recordFailure: () => false }),
    verificationMetrics: { recordAttempt() {}, recordSuccess() {}, recordFailure() {}, recordExpired() {}, recordInvalidFormat() {}, recordRateLimited() {} },
    issueDeadlockReliefChallenge: () => undefined, completeDeadlockRelief: async () => undefined,
    buildRateLimitDeny: () => ({ behavior: 'deny' }),
    ownershipPolicy: { evaluate },
  });
  return { handler, collect, createApproval, checkApproval, evaluate };
}

const MERGE = { tool_name: 'Bash', input: { command: 'gh pr merge 42 --squash' }, agent_identity: 'worker', session_id: 'sess-9', cwd: '/work/repo' };

describe('GatekeeperHandler permission_prompt ownership policy', () => {
  it('denies a mutation of someone else\'s PR and audits it', async () => {
    const f = fixture({ behavior: 'deny', reason: 'authored by stranger', policySource: 'ownership_policy' });
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    await expect(f.handler.dispatch('permissionPrompt', MERGE)).resolves.toMatchObject({
      behavior: 'deny', message: 'authored by stranger', agent_identity: 'worker',
      classification: { stage: 'ownership_policy' },
    });
    expect(f.evaluate).toHaveBeenCalledWith('Bash', MERGE.input, { sessionId: 'sess-9', cwd: '/work/repo' });
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.createApproval).not.toHaveBeenCalled();
    expect(audit.mock.calls.some(([event]) => event.type === 'PERMISSION_PROMPT_DENIED' && event.additionalData?.policySource === 'ownership_policy')).toBe(true);
    audit.mockRestore();
  });

  it('creates an approval request when confirmation is required', async () => {
    const f = fixture({ behavior: 'confirm', reason: 'lookup failed', policySource: 'ownership_policy' });
    await expect(f.handler.dispatch('permissionPrompt', MERGE)).resolves.toMatchObject({
      behavior: 'deny',
      classification: { stage: 'approval_required' },
      approvalRequest: { toolName: 'Bash', reason: 'lookup failed' },
    });
    expect(f.createApproval).toHaveBeenCalledWith(expect.objectContaining({ policySource: 'ownership_policy', denyReason: 'lookup failed' }));
  });

  it('honours an existing CLI approval on the retry', async () => {
    const f = fixture({ behavior: 'confirm', reason: 'lookup failed', policySource: 'ownership_policy' });
    f.checkApproval.mockReturnValue({ requestId: 'cli-approved', scope: 'single' } as any);
    await expect(f.handler.dispatch('permissionPrompt', MERGE)).resolves.toMatchObject({
      behavior: 'allow', classification: { stage: 'cli_approval' }, approvalContext: { requestId: 'cli-approved' },
    });
    expect(f.createApproval).not.toHaveBeenCalled();
  });

  it('lets an element deny win over an ownership confirm', async () => {
    const f = fixture({ behavior: 'confirm', reason: 'lookup failed', policySource: 'ownership_policy' });
    f.collect.mockResolvedValue([{
      type: 'persona', name: 'locked',
      metadata: { gatekeeper: { externalRestrictions: { description: 'd', denyPatterns: ['Bash:gh pr merge*'] } } },
    } as any]);
    await expect(f.handler.dispatch('permissionPrompt', MERGE)).resolves.toMatchObject({
      behavior: 'deny', classification: { stage: 'element_policy' },
    });
    expect(f.createApproval).not.toHaveBeenCalled();
  });

  it('falls through to the default allow when the policy allows', async () => {
    const f = fixture({ behavior: 'allow', reason: 'own PR', policySource: 'ownership_policy' });
    await expect(f.handler.dispatch('permissionPrompt', MERGE)).resolves.toMatchObject({ behavior: 'allow', classification: { stage: 'default' } });
  });

  it('fails closed with an approval request when the policy throws', async () => {
    const f = fixture(new Error('gh exploded'));
    await expect(f.handler.dispatch('permissionPrompt', MERGE)).resolves.toMatchObject({
      behavior: 'deny', classification: { stage: 'approval_required' },
    });
    expect(f.createApproval).toHaveBeenCalledWith(expect.objectContaining({ policySource: 'ownership_policy' }));
  });

  it('enforces the policy in the evaluate_permission (hook) path too', async () => {
    const f = fixture({ behavior: 'deny', reason: 'authored by stranger', policySource: 'ownership_policy' });
    await expect(f.handler.dispatch('evaluatePermission', {
      tool_name: 'Bash', input: { command: 'gh pr merge 42' }, platform: 'claude_code', session_id: 'sess-9', cwd: '/work/repo',
    })).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'authored by stranger' },
    });
    expect(f.evaluate).toHaveBeenCalledWith('Bash', { command: 'gh pr merge 42' }, { sessionId: 'sess-9', cwd: '/work/repo' });
    expect(f.collect).not.toHaveBeenCalled();
  });

  it('asks in the hook path when the policy requires confirmation', async () => {
    const f = fixture({ behavior: 'confirm', reason: 'lookup failed', policySource: 'ownership_policy' });
    await expect(f.handler.dispatch('evaluatePermission', {
      tool_name: 'Bash', input: { command: 'git push' }, platform: 'claude_code', cwd: '/work/repo',
    })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'lookup failed' } });
  });

  it('is skipped for statically classified tools', async () => {
    const f = fixture({ behavior: 'deny', reason: 'x', policySource: 'ownership_policy' });
    await expect(f.handler.dispatch('permissionPrompt', { tool_name: 'Bash', input: { command: 'gh pr view 42' } }))
      .resolves.toMatchObject({ behavior: 'allow', classification: { stage: 'static_classification' } });
    expect(f.evaluate).not.toHaveBeenCalled();
  });
});
