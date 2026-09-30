import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { logger } from '../../../../src/utils/logger.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { env } from '../../../../src/config/env.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';
import type { ActiveElement } from '../../../../src/handlers/mcp-aql/policies/index.js';
import { IntegrationRequestPolicyEnforcer } from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';

const settings = env as unknown as Record<string, unknown>;
const original = settings.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL;
afterEach(() => { settings.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL = original; jest.restoreAllMocks(); });
const input = { provider: 'gmail', method: 'POST', path: '/messages', body: { text: 'hello' } };
function fixture(elements: ActiveElement[] = [], overrides = true) {
  const gatekeeper = new Gatekeeper(undefined, { allowElementPolicyOverrides: overrides }, undefined, 'migration', new StaticAuditHmacKeyResolver('aa'.repeat(32)));
  const enforcer = new IntegrationRequestPolicyEnforcer({ gatekeeper, getActiveElements: async () => elements });
  return { gatekeeper, enforcer };
}
function guard(field: 'deny' | 'confirm' | 'allow'): ActiveElement {
  return { type: 'skill', name: 'guard', metadata: { name: 'guard', gatekeeper: { [field]: ['integration_request'] } } };
}
function readGuard(): ActiveElement {
  return { type: 'skill', name: 'read-guard', metadata: { name: 'read-guard', gatekeeper: {
    externalRestrictions: { description: 'Confirm reads', confirmPatterns: ['integration_request:read'] },
  } } };
}
function id(value: { approvalRequest?: { requestId: string } }): string {
  if (!value.approvalRequest) throw new Error('Expected approval');
  return value.approvalRequest.requestId;
}
describe('integration request migration policy', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('requires exact single-use approval by default for %s', async method => {
    settings.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL = 'on';
    const { gatekeeper, enforcer } = fixture();
    const request = { ...input, method };
    const first = await enforcer.authorize(request);
    expect(first).toMatchObject({ allowed: false, approvalRequest: { allowedScopes: ['single'] } });
    expect(gatekeeper.getPendingCliApprovals()[0].policySource).toBe('default:integration_write');
    await gatekeeper.approveCliRequest(id(first), 'single');
    expect(await enforcer.authorize(request)).toMatchObject({ allowed: true, approvalContext: { scope: 'single' } });
    expect(await enforcer.authorize(request)).toMatchObject({ allowed: false });
  });
  it('operator opt-out leaves GETs and internal sentinels unchanged but cannot relax element confirm', async () => {
    settings.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL = 'on';
    const { enforcer } = fixture();
    expect(await enforcer.authorize({ ...input, method: 'GET' })).toMatchObject({ allowed: true });
    expect(await enforcer.authorize({ ...input, path: '_internal:/integration/openapi_spec' })).toMatchObject({ allowed: true });
    settings.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL = 'off';
    expect(await enforcer.authorize(input)).toMatchObject({ allowed: true });
    expect(await fixture([guard('confirm')]).enforcer.authorize(input)).toMatchObject({ allowed: false });
  });
  it.each(['deny', 'confirm', 'allow'] as const)('enforces operation %s inside the integration boundary', async field => {
    settings.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL = 'on';
    const { enforcer } = fixture([guard(field)]);
    const decision = await enforcer.authorize(input);
    expect(decision).toMatchObject({ allowed: false, error: { code: field === 'deny' ? 'integration_request_denied_by_policy' : 'integration_request_approval_required' } });
    if (field === 'deny') expect(decision.approvalRequest).toBeUndefined();
  });
  it('honors the operation-policy kill switch without relaxing default approval', async () => {
    settings.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL = 'on';
    const { enforcer } = fixture([guard('deny')], false);
    expect(await enforcer.authorize(input)).toMatchObject({ allowed: false, error: { code: 'integration_request_approval_required' } });
  });
  it('requires one approval for each operation-confirmed read', async () => {
    const { gatekeeper, enforcer } = fixture([guard('confirm')]);
    const request = { ...input, method: 'GET' };
    const first = await enforcer.authorize(request);
    expect(first).toMatchObject({ allowed: false, approvalRequest: { allowedScopes: ['single'] } });
    await gatekeeper.approveCliRequest(id(first), 'single');
    expect(await enforcer.authorize(request)).toMatchObject({ allowed: true });
    expect(await enforcer.authorize(request)).toMatchObject({ allowed: false });
  });
  it('pattern-confirmed reads require single-use approval for every request', async () => {
    const { gatekeeper, enforcer } = fixture([readGuard()]);
    const request = { ...input, method: 'GET' };
    const first = await enforcer.authorize(request);
    expect(first).toMatchObject({ approvalRequest: { allowedScopes: ['single'] } });
    await expect(gatekeeper.approveCliRequest(id(first), 'tool_session')).rejects.toThrow();
    await expect(gatekeeper.approveCliRequest(id(first), 'input_session')).rejects.toThrow();
    await gatekeeper.approveCliRequest(id(first), 'single');
    expect(await enforcer.authorize(request)).toMatchObject({ allowed: true });
    expect(await enforcer.authorize(request)).toMatchObject({ allowed: false });
    expect(await enforcer.authorize({ ...request, provider: 'other' })).toMatchObject({ allowed: false });
    expect(await enforcer.authorize({ ...request, path: '/other' })).toMatchObject({ allowed: false });
  });
  it('rejects pre-existing tool-wide approvals for both GET and remote discovery', async () => {
    const { gatekeeper, enforcer } = fixture([readGuard()]);
    const requestId = await gatekeeper.createCliApprovalRequest({ toolName: 'integration_request', toolInput: {},
      riskLevel: 'safe', riskScore: 0, irreversible: false, denyReason: 'legacy host approval', allowedScopes: ['tool_session'] });
    await gatekeeper.approveCliRequest(requestId, 'tool_session');
    expect(await enforcer.authorize({ ...input, method: 'GET' })).toMatchObject({ allowed: false });
    expect(await enforcer.evaluateDiscovery('gmail')).toBe(false);
  });
  it('records attribution outside the hash and audits the consuming entry point', async () => {
    const { gatekeeper, enforcer } = fixture();
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const first = await enforcer.authorize(input, undefined, { entry_point: 'discrete_tool' });
    const originalRecord = gatekeeper.getPendingCliApprovals()[0];
    expect(originalRecord.entry_point).toBe('discrete_tool');
    const second = await enforcer.authorize(input, undefined, { entry_point: 'mcp_aql' });
    const secondRecord = gatekeeper.getPendingCliApprovals().find(record => record.requestId === id(second));
    expect(secondRecord?.toolInputHash).toBe(originalRecord.toolInputHash);
    expect(secondRecord?.entry_point).toBe('mcp_aql');
    await gatekeeper.approveCliRequest(id(first), 'single');
    expect(await enforcer.authorize(input, undefined, { entry_point: 'promoted_tool' })).toMatchObject({ allowed: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'CLI_APPROVAL_CONSUMED', additionalData: expect.objectContaining({ entry_point: 'promoted_tool' }) }));
  });

  it.each([
    { provider: 'other' }, { method: 'DELETE' }, { path: '/elsewhere' },
    { path: '/messages?q=changed' }, { query: { q: 'changed' } }, { body: { text: 'changed' } },
  ])('rejects request mutation %j without consuming the original approval', async mutation => {
    const { enforcer, gatekeeper } = fixture();
    const first = await enforcer.authorize(input);
    await gatekeeper.approveCliRequest(id(first), 'single');
    expect(await enforcer.authorize({ ...input, ...mutation })).toMatchObject({ allowed: false });
    expect(await enforcer.authorize(input)).toMatchObject({ allowed: true });
  });
  it.each(['mcp__DollhouseMCP__integration_request', 'mcp__DollhouseMCP__integration_request*', 'mcp__DollhouseMCP__integration_request:write'])('warns for legacy prefixed pattern %s without rewriting policy', async pattern => {
    const previous = env.MCP_INTERFACE_MODE;
    env.MCP_INTERFACE_MODE = 'mcpaql';
    try {
      const element = guard('deny');
      element.metadata.gatekeeper!.deny = [pattern];
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      await fixture([element]).enforcer.authorize({ ...input, method: 'GET' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("gatekeeper.deny: ['integration_request']"));
      expect(element.metadata.gatekeeper!.deny).toEqual([pattern]);
    } finally { env.MCP_INTERFACE_MODE = previous; }
  });

  it.each(['mcp__DollhouseMCP__*', 'mcp__*', 'mcp__other__integration_request'])('deduplicates legacy allow warnings for %s by element version', async pattern => {
    const previous = env.MCP_INTERFACE_MODE;
    env.MCP_INTERFACE_MODE = 'mcpaql';
    try {
      const element = guard('allow');
      element.metadata.version = '1';
      element.metadata.gatekeeper = { externalRestrictions: { description: 'Legacy allow', allowPatterns: [pattern] } };
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const { enforcer } = fixture([element]);
      await enforcer.authorize(input);
      await enforcer.authorize(input);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("gatekeeper.allow: ['integration_request']"));
      element.metadata.version = '2';
      await enforcer.authorize(input);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { env.MCP_INTERFACE_MODE = previous; }
  });

  it('retains exact-input session reuse for ordinary reads and refuses reuse after pattern confirm is activated', async () => {
    const elements: ActiveElement[] = [];
    const { gatekeeper, enforcer } = fixture(elements);
    const request = { provider: 'gmail', method: 'GET', path: '/messages' };
    const requestId = await gatekeeper.createCliApprovalRequest({
      toolName: 'integration_request', toolInput: { ...request, read_write_class: 'read' },
      riskLevel: 'safe', riskScore: 0, irreversible: false, denyReason: 'legacy exact-input read',
    });
    await gatekeeper.approveCliRequest(requestId, 'input_session');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await enforcer.authorize(request)).toMatchObject({ allowed: true, approvalContext: { requestId, scope: 'input_session' } });
    }
    expect((await enforcer.authorize({ ...request, path: '/other' })).approvalContext).toBeUndefined();
    elements.push(readGuard());
    expect(await enforcer.authorize(request)).toMatchObject({ allowed: false, approvalRequest: { allowedScopes: ['single'] } });
  });

});
