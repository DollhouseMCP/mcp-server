import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { describe, expect, it, jest } from '@jest/globals';
import { GatekeeperHandler, type GatekeeperHandlerDeps } from '../../../../src/handlers/mcp-aql/GatekeeperHandler.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { OperationRegistry } from '../../../../src/handlers/mcp-aql/OperationRegistry.js';
import { RateLimiterFactory } from '../../../../src/utils/RateLimiter.js';
import { classifyTool } from '../../../../src/handlers/mcp-aql/policies/ToolClassification.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';

function fixture() {
  const collect = jest.fn<GatekeeperHandlerDeps['getActiveElements']>().mockResolvedValue([]);
  const gatekeeper = new Gatekeeper(undefined, { enableAuditLogging: false });
  const enforce = jest.spyOn(gatekeeper, 'enforce');
  const recordConfirmation = jest.spyOn(gatekeeper, 'recordConfirmation');
  const createApproval = jest.spyOn(gatekeeper, 'createCliApprovalRequest');
  const operations = new OperationRegistry();
  const limiter = RateLimiterFactory.createPermissionPromptLimiter();
  const consume = jest.spyOn(limiter, 'consumeToken');
  const handler = new GatekeeperHandler({
    handlers: {} as HandlerRegistry, operations, gatekeeper, executingAgents: new Map(),
    getActiveElements: collect, getPolicyReportElements: collect,
    getEndpointForOperation: operation => operations.getRoute(operation)!.endpoint,
    resolvePermissionPromptLimiter: () => limiter,
    resolveCliApprovalLimiter: () => RateLimiterFactory.createCliApprovalLimiter(),
    resolveVerificationRateLimiter: () => ({ isLimited: () => false, recordFailure: () => false }),
    verificationMetrics: { recordAttempt() {}, recordSuccess() {}, recordFailure() {}, recordExpired() {}, recordInvalidFormat() {}, recordRateLimited() {} },
    issueDeadlockReliefChallenge: () => undefined, completeDeadlockRelief: async () => undefined,
    buildRateLimitDeny: () => ({ behavior: 'deny' }),
  });
  return { handler, collect, gatekeeper, enforce, recordConfirmation, createApproval, consume };
}

const PROMPT = { tool_name: 'Write', input: { file_path: '/tmp/result.txt', content: 'hello' }, agent_identity: 'worker' };
const CONFIRM = { operation: 'create_element', element_type: 'skill' };

describe('GatekeeperHandler policy acquisition failures', () => {
  it('returns a normal deny for permission_prompt when element collection fails', async () => {
    const f = fixture();
    expect(classifyTool(PROMPT.tool_name, PROMPT.input).behavior).toBe('evaluate');
    f.collect.mockRejectedValue(new Error('private storage detail'));
    await expect(f.handler.dispatch('permissionPrompt', PROMPT)).resolves.toMatchObject({
      behavior: 'deny', agent_identity: 'worker', classification: { stage: 'element_policy' },
    });
    expect(f.collect).toHaveBeenCalledTimes(1);
    expect(f.createApproval).not.toHaveBeenCalled();
    expect(f.consume).toHaveBeenCalledTimes(1);
    expect(f.gatekeeper.isPermissionPromptActive).toBe(true);
  });

  it('audits policy collection denial once without leaking the collector error', async () => {
    const f = fixture();
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const error = new Error('private storage detail');
    f.collect.mockRejectedValue(error);
    const response = await f.handler.dispatch('permissionPrompt', PROMPT);
    const denials = audit.mock.calls.filter(([event]) => event.type === 'PERMISSION_PROMPT_DENIED');
    expect(denials).toHaveLength(1);
    expect(denials[0][0]).toEqual({
      type: 'PERMISSION_PROMPT_DENIED', severity: 'MEDIUM',
      source: 'MCPAQLHandler.dispatchGatekeeper.permissionPrompt',
      details: 'Permission denied for Write: policy_collection_failed',
      additionalData: { toolName: 'Write', riskLevel: classifyTool(PROMPT.tool_name, PROMPT.input).riskLevel,
        agentIdentity: 'worker', reason: 'policy_collection_failed' },
    });
    expect(JSON.stringify({ response, denials })).not.toContain(error.message);
    expect(JSON.stringify({ response, denials })).not.toContain(error.stack);
  });

  it('leaves static classification ahead of policy collection', async () => {
    const f = fixture();
    f.collect.mockRejectedValue(new Error('unreachable collector'));
    await expect(f.handler.dispatch('permissionPrompt', { tool_name: 'Read', input: { file_path: '/tmp/result.txt' } }))
      .resolves.toMatchObject({ behavior: 'allow', classification: { stage: 'static_classification' } });
    expect(f.collect).not.toHaveBeenCalled();
  });

  it('refuses confirmation on collection failure without recording approval', async () => {
    const f = fixture();
    const error = new Error('policy storage unavailable');
    f.collect.mockRejectedValue(error);
    await expect(f.handler.dispatch('confirm', CONFIRM)).rejects.toBe(error);
    expect(f.enforce).not.toHaveBeenCalled();
    expect(f.recordConfirmation).not.toHaveBeenCalled();
  });

  it('retains the confirmation sandbox check when collection succeeds', async () => {
    const f = fixture();
    f.collect.mockResolvedValue([{ type: 'skill', name: 'sandbox', metadata: { gatekeeper: { deny: ['confirm_operation'] } } }]);
    await expect(f.handler.dispatch('confirm', CONFIRM)).rejects.toThrow('has sandboxed this session');
    expect(f.enforce).not.toHaveBeenCalled();
    expect(f.recordConfirmation).not.toHaveBeenCalled();
  });

  it('retains target policy denial when the sandbox permits confirmations', async () => {
    const f = fixture();
    f.collect.mockResolvedValue([{ type: 'skill', name: 'guard', metadata: { gatekeeper: { deny: ['create_element'] } } }]);
    await expect(f.handler.dispatch('confirm', CONFIRM)).rejects.toThrow('denied by policy and cannot be confirmed');
    expect(f.enforce).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create_element', endpoint: 'CREATE',
      elementType: 'skill', activeElements: expect.arrayContaining([expect.objectContaining({ name: 'guard' })]) }), expect.any(OperationRegistry));
    expect(f.recordConfirmation).not.toHaveBeenCalled();
  });

  it('still records a permitted target confirmation', async () => {
    const f = fixture();
    await expect(f.handler.dispatch('confirm', CONFIRM)).resolves.toMatchObject({ confirmed: true });
    expect(f.enforce).toHaveBeenCalledTimes(1);
    expect(f.recordConfirmation).toHaveBeenCalledTimes(1);
  });
});
