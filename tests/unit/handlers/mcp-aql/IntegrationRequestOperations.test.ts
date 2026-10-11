import { createMockMemoryManager } from '../../../helpers/di-mocks.js';
import { INTEGRATION_ENTRY_POINTS } from '../../../../src/security/IntegrationEntryPoint.js';
import { env } from '../../../../src/config/env.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';
import { IntegrationRequestPolicyEnforcer } from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';
import type { IntegrationRequestGateway } from '../../../../src/web-console/modules/integrations/IntegrationRequestGateway.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { describe, expect, it, jest } from '@jest/globals';
import { MCPAQLHandler, type HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { UnifiedEndpoint } from '../../../../src/handlers/mcp-aql/UnifiedEndpoint.js';
import { parseOperationInput } from '../../../../src/handlers/mcp-aql/types.js';
import { classifyTool } from '../../../../src/handlers/mcp-aql/policies/ToolClassification.js';
import { getIntegrationTools } from '../../../../src/server/tools/IntegrationTools.js';
import { AuthorizedIntegrationGateway } from '../../../../src/web-console/modules/integrations/AuthorizedIntegrationGateway.js';

const params = { provider: 'test', method: 'GET', path: '/items' };
function setup(configured = true) {
  const request = jest.fn<AuthorizedIntegrationGateway['request']>().mockResolvedValue({ ok: true, result: JSON.parse('{"name":"preserved","constructor":{"name":"nested"}}') });
  const gateway = { request } as unknown as AuthorizedIntegrationGateway;
  const gatekeeper = new Gatekeeper(undefined, { enableAuditLogging: false }, undefined, 'request-tests', new StaticAuditHmacKeyResolver('ab'.repeat(32)));
  const metric = jest.fn();
  const handler = new MCPAQLHandler({ gatekeeper, memoryManager: createMockMemoryManager(), operationMetricsTracker: { record: metric }, integrationRequestGateway: configured ? gateway : undefined,
    elementCRUD: { getActiveElementsForPolicy: async () => [], getActiveElements: async () => [] },
  } as unknown as HandlerRegistry);
  return { handler, request, gateway, metric, gatekeeper };
}
describe('integration request EXECUTE operation', () => {
  it('registers independently of a catalog and is unknown when unconfigured', async () => {
    expect(setup().handler.operations.getRoute('integration_request')?.endpoint).toBe('EXECUTE');
    expect(setup(false).handler.operations.getRoute('integration_request')).toBeUndefined();
  });
  it.each(['handleCreate', 'handleRead', 'handleUpdate', 'handleDelete'] as const)('rejects %s', async endpoint => {
    const { handler, request } = setup();
    expect(await handler[endpoint]({ operation: 'integration_request', params })).toMatchObject({ success: false });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['crude', 'single'] as const)('gives request-specific wrong-endpoint guidance in %s mode', async mode => {
    const previous = env.MCP_AQL_ENDPOINT_MODE;
    env.MCP_AQL_ENDPOINT_MODE = mode;
    try {
      const { handler } = setup();
      const response = await handler.handleRead({ operation: 'integration_request', params });
      expect(JSON.stringify(response)).toContain('provider, method, path and optional query/body');
      expect(JSON.stringify(response)).toContain(mode === 'single' ? 'via mcp_aql endpoint' : 'via mcp_aql_execute endpoint');
      expect(JSON.stringify(response)).not.toContain('skill_name');
    } finally { env.MCP_AQL_ENDPOINT_MODE = previous; }
  });

  it.each(INTEGRATION_ENTRY_POINTS)('public approval command restricts legacy scopes and explains retry through %s', async entryPoint => {
    const { handler, gatekeeper } = setup();
    const requestId = await gatekeeper.createCliApprovalRequest({
      toolName: 'integration_request', toolInput: params, riskLevel: 'safe', riskScore: 0,
      irreversible: false, denyReason: 'Legacy pending request', entry_point: entryPoint,
    });
    expect(await handler.handleExecute({ operation: 'approve_cli_permission', params: { request_id: requestId, scope: 'tool_session' } })).toMatchObject({ success: false });
    const response = await handler.handleExecute({ operation: 'approve_cli_permission', params: { request_id: requestId, scope: 'input_session' } });
    expect(response).toMatchObject({ success: true });
    const expected = {
      mcp_aql: 'Retry mcp_aql with operation integration_request',
      mcp_aql_execute: 'Retry mcp_aql_execute with operation integration_request',
      discrete_tool: 'Retry integration_request with the same arguments.',
      promoted_tool: 'Retry the original promoted tool',
      legacy_tool_args: 'Retry the original endpoint',
    }[entryPoint];
    expect(JSON.stringify(response)).toContain(expected);
  });

  it.each([
    { path: '_internal:/integration/remote_mcp_discovery', entry_point: 'mcp_aql' as const },
    { path: '/items', entry_point: undefined },
  ])('keeps generic retry guidance without outbound path and attribution together: %j', async provenance => {
    const { handler, gatekeeper } = setup();
    const requestId = await gatekeeper.createCliApprovalRequest({
      toolName: 'integration_request', toolInput: { ...params, path: provenance.path },
      entry_point: provenance.entry_point, riskLevel: 'safe', riskScore: 0, irreversible: false, denyReason: 'Original call',
    });
    const response = await handler.handleExecute({ operation: 'approve_cli_permission', params: { request_id: requestId } });
    expect(response).toMatchObject({ success: true });
    expect(JSON.stringify(response)).toContain('Retry the original call');
    expect(JSON.stringify(response)).not.toContain('with operation integration_request');
  });
  it.each(['execute', 'single', 'legacy'] as const)('preserves discrete bytes and calls gateway once through %s', async mode => {
    const { handler, gateway, request } = setup();
    const standalone = await getIntegrationTools(gateway)[0].handler(params);
    request.mockClear();
    const input = mode === 'legacy' ? { tool: 'integration_request', args: { ...params, fields: ['missing'] } }
      : { operation: 'integration_request', params: { ...params, fields: ['missing'] } };
    const response = mode === 'single' ? await new UnifiedEndpoint(handler).handle(input) : await handler.handleExecute(input);
    expect(response).toMatchObject({ success: true, data: standalone });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ ...params, query: undefined, body: undefined });
  });

  it('logs a policy denial as failed while retaining the MCP response', async () => {
    const { handler, request, metric } = setup();
    request.mockResolvedValue({ ok: false, error: { code: 'integration_request_approval_required', message: 'approval required', status: 403 } });
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const response = await handler.handleExecute({ operation: 'integration_request', params });
    expect(response).toMatchObject({ success: true });
    expect(audit.mock.calls.some(([event]) => event.type === 'OPERATION_COMPLETED')).toBe(false);
    expect(audit.mock.calls.some(([event]) => event.type === 'OPERATION_FAILED')).toBe(true);
    expect(metric).toHaveBeenCalledWith('integration_request', 'EXECUTE', expect.any(Number), false);
    audit.mockRestore();
  });
  it('rejects a whole batch before any dispatch', async () => {
    const { handler, request } = setup();
    const result = await handler.handleExecute({ operations: [{ operation: 'integration_request', params }] });
    expect(result).toMatchObject({ success: false, results: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
describe('integration envelope validation and client classification', () => {
  const malformed = [
    { operation: 'integration_request', method: 'GET', params },
    { operation: 'integration_request', params: { ...params, secret: 'private' } },
    { operation: 'integration_request', params: [] },
    { operation: 'integration_request' },
    { tool: 'integration_request', args: params, body: 'secret' },
    { tool: 'integration_request', args: params, params },
    { operation: 'list_elements', tool: 'integration_request', args: params },
  ];
  it.each(malformed)('rejects malformed input %j', input => {
    expect(parseOperationInput(input)).toBeNull();
    expect(classifyTool('mcp__DollhouseMCP__mcp_aql_execute', input)).toMatchObject({ riskLevel: 'dangerous', behavior: 'evaluate' });
  });
  it.each(['mcp__DollhouseMCP__mcp_aql_execute', 'mcp__DollhouseMCP__mcp_aql'])('classifies nested methods for %s', tool => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'INVALID']) {
      for (const input of [{ operation: 'integration_request', params: { ...params, method } }, { tool: 'integration_request', args: { ...params, method } }]) {
        expect(classifyTool(tool, input)).toMatchObject({ behavior: 'evaluate', riskLevel: method === 'GET' ? 'safe' : 'dangerous' });
      }
    }
  });
});

describe.each(['discrete', 'execute', 'single', 'legacy'] as const)('request policy through %s', mode => {
  it.each(['deny', 'confirm', 'allow'] as const)('honors %s without a second approval or gateway call', async policy => {
    const elements = [{ type: 'skill', name: 'guard', metadata: { name: 'guard', gatekeeper: { [policy]: ['integration_request'] } } }];
    const gatekeeper = new Gatekeeper(undefined, undefined, undefined, 'request-policy', new StaticAuditHmacKeyResolver('ac'.repeat(32)));
    const raw = { request: jest.fn<IntegrationRequestGateway['request']>().mockResolvedValue({} as never) };
    const gateway = new AuthorizedIntegrationGateway({ gateway: raw as unknown as IntegrationRequestGateway,
      policyEnforcer: new IntegrationRequestPolicyEnforcer({ gatekeeper, getActiveElements: async () => elements }),
    });
    const handler = new MCPAQLHandler({ gatekeeper, memoryManager: createMockMemoryManager(), integrationRequestGateway: gateway,
      elementCRUD: { getActiveElementsForPolicy: async () => elements, getActiveElements: async () => [] },
    } as unknown as HandlerRegistry);
    const request = { ...params, method: 'POST', body: { text: 'approved bytes' } };
    const invoke = async () => {
      if (mode === 'discrete') return getIntegrationTools(gateway)[0].handler(request);
      const input = mode === 'legacy' ? { tool: 'integration_request', args: request } : { operation: 'integration_request', params: request };
      const result = mode === 'single' ? await new UnifiedEndpoint(handler).handle(input) : await handler.handleExecute(input);
      return 'data' in result ? result.data : result;
    };
    gatekeeper.recordConfirmation('integration_request', PermissionLevel.CONFIRM_SINGLE_USE);
    const pending = await invoke();
    expect(raw.request).not.toHaveBeenCalled();
    if (policy === 'deny') {
      expect(JSON.stringify(pending)).toMatch(/denied|blocked/i);
      expect(gatekeeper.getPendingCliApprovals()).toHaveLength(0);
    } else {
      expect(gatekeeper.getPendingCliApprovals()).toHaveLength(1);
      const approval = gatekeeper.getPendingCliApprovals()[0];
      const expectedEntry = { discrete: 'discrete_tool', execute: 'mcp_aql_execute', single: 'mcp_aql', legacy: 'legacy_tool_args' }[mode];
      expect(approval.entry_point).toBe(expectedEntry);
      expect(approval.allowedScopes).toEqual(['single']);
      await gatekeeper.approveCliRequest(approval.requestId, 'single');
      await invoke();
      expect(raw.request).toHaveBeenCalledTimes(1);
      await invoke();
      expect(raw.request).toHaveBeenCalledTimes(1);
    }
  });
});
