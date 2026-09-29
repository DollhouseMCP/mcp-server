import { afterEach, describe, expect, it } from '@jest/globals';
import { env } from '../../../../src/config/env.js';
import { describeIntegrationInvocation, formatIntegrationGuidance } from '../../../../src/server/tools/IntegrationInvocation.js';
import { getIntegrationReadTools } from '../../../../src/server/tools/IntegrationTools.js';
import type { IntegrationOperationDetails } from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';
import type { AuthorizedIntegrationOperationCatalog } from '../../../../src/web-console/modules/integrations/AuthorizedIntegrationGateway.js';
const original = { mode: env.MCP_INTERFACE_MODE, endpoint: env.MCP_AQL_ENDPOINT_MODE };
afterEach(() => { env.MCP_INTERFACE_MODE = original.mode; env.MCP_AQL_ENDPOINT_MODE = original.endpoint; });
const details = { gatewayRequest: { provider: 'mail', method: 'GET', pathTemplate: '/messages/{id}' } } as IntegrationOperationDetails;
describe.each(['discrete', 'crude', 'single'] as const)('integration invocation guidance in %s', mode => {
  it('decorates transient describe results without mutating catalog metadata', async () => {
    env.MCP_INTERFACE_MODE = mode === 'discrete' ? 'discrete' : 'mcpaql';
    env.MCP_AQL_ENDPOINT_MODE = mode === 'single' ? 'single' : 'crude';
    const result = describeIntegrationInvocation(details);
    const endpoint = mode === 'single' ? 'mcp_aql' : 'mcp_aql_execute';
    const params = { provider: 'mail', method: 'GET', path: '/messages/{id}' };
    expect(result.gatewayRequest.invocation).toEqual(mode === 'discrete' ? { tool: 'integration_request', args: params } : { endpoint, operation: 'integration_request', params });
    expect(details.gatewayRequest).not.toHaveProperty('invocation');
    const catalog = { describeOperation: async () => details, listOperations: async () => ({
      skillStatus: [
        { skill_name: 'legacy', status: 'legacy', guidance: 'Use create_integration_skill with provider and a new skill_name.' },
        { skill_name: 'outdated', status: 'outdated', guidance: 'Use update_integration_skill with provider and skill_name.' },
      ],
    }) } as unknown as AuthorizedIntegrationOperationCatalog;
    const tool = getIntegrationReadTools(catalog).find(tool => tool.tool.name === 'describe_operation')!;
    const response = JSON.parse((await tool.handler({ provider: 'mail', operation_id: 'read' })).content[0].text);
    expect(response.result.gatewayRequest.invocation).toEqual(result.gatewayRequest.invocation);
    expect(tool.tool.description).toBe(mode === 'discrete'
      ? 'Describe one OpenAPI-derived integration operation and call integration_request with provider, method, path and optional query/body.'
      : `Describe one OpenAPI-derived integration operation and call ${endpoint} with operation integration_request and params containing provider, method, path and optional query/body.`);

    const listTool = getIntegrationReadTools(catalog).find(tool => tool.tool.name === 'list_operations')!;
    const listed = JSON.parse((await listTool.handler({ provider: 'mail' })).content[0].text);
    for (const status of listed.result.skillStatus) {
      expect(status.guidance).toContain(mode === 'discrete' ? 'regenerate_integration_skill' : 'mcp_aql');
      if (mode === 'discrete') expect(status.guidance).not.toMatch(/create_integration_skill|update_integration_skill|MCP-AQL/u);
    }
    const guidance = formatIntegrationGuidance('Use mcp_aql_create / create_integration_skill with a new skill_name.');
    if (mode === 'single') {
      expect(guidance).toContain('mcp_aql / create_integration_skill');
      expect(guidance).not.toContain('mcp_aql_create');
    } else if (mode === 'crude') expect(guidance).toContain('mcp_aql_create / create_integration_skill');
    else { expect(guidance).toContain('regenerate_integration_skill'); expect(guidance).not.toContain('skill_name'); }
  });
});
