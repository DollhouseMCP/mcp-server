import { env } from '../../../src/config/env.js';
import { afterEach, describe, expect, it } from '@jest/globals';
import { classifyTool } from '../../../src/handlers/mcp-aql/policies/ToolClassification.js';
import { redactToolInput } from '../../../src/security/toolRedaction.js';
import { StaticAuditHmacKeyResolver } from '../../../src/security/auditHmacKey.js';
import { integrationOperationError } from '../../../src/handlers/mcp-aql/IntegrationOperationResult.js';
const settings = env as unknown as Record<string, unknown>;
const previousServerName = settings.DOLLHOUSE_MCP_SERVER_NAME;
afterEach(() => { settings.DOLLHOUSE_MCP_SERVER_NAME = previousServerName; });
const params = { provider: 'mail', method: 'GET', path: '/messages' };
const resolver = new StaticAuditHmacKeyResolver('ab'.repeat(32));
describe('integration review host boundaries', () => {

  it.each(['dollhousemcp', 'DollhouseMCP', 'DOLLHOUSEMCP', 'PersonalTools', 'personaltools'])('recognizes own namespace %s for classification and redaction', async server => {
    settings.DOLLHOUSE_MCP_SERVER_NAME = 'PersonalTools';
    const raw = { operation: 'integration_request', params: { ...params, query: { private: 'private-value' } } };
    for (const tool of ['mcp_aql_execute', 'mcp_aql']) {
      expect(classifyTool(`mcp__${server}__${tool}`, raw)).toMatchObject({ riskLevel: 'safe' });
      expect(JSON.stringify((await redactToolInput(`mcp__${server}__${tool}`, raw, resolver)).digest)).not.toContain('private-value');
    }
    expect(classifyTool(`mcp__${server}__integration_request`, params)).toMatchObject({ riskLevel: 'safe' });
    expect(classifyTool('mcp__foreign__mcp_aql_execute', raw)).toMatchObject({ riskLevel: 'moderate' });
    expect((await redactToolInput('mcp__foreign__mcp_aql_execute', raw, resolver)).digest).toEqual(raw);
  });
  it.each(['mcp_aql_execute', 'mcp_aql', 'integration_request'])('does not trust a foreign server tool %s', tool => {
    const inputs = tool === 'integration_request' ? [params] : [
      { operation: 'integration_request', params }, { tool: 'integration_request', args: params },
    ];
    for (const input of inputs) {
      expect(classifyTool(`mcp__foreign__${tool}`, input)).toMatchObject({ riskLevel: 'moderate', behavior: 'evaluate' });
      expect(classifyTool(`mcp__DollhouseMCP__${tool}`, input)).toMatchObject({ riskLevel: 'safe', behavior: 'evaluate' });
    }
  });
  it.each(['DollhouseMCP', 'foreign'])('preserves generic non-integration summaries for %s', async server => {
    const raw = { operation: 'create_element', params: { name: 'Visible', content: 'review this content', password: 'secret' } };
    const result = await redactToolInput(`mcp__${server}__mcp_aql_create`, raw, resolver);
    expect(result.digest).toEqual({ operation: 'create_element', params: { name: 'Visible', content: 'review this content', password: '[REDACTED]' } });
  });
  it('does not overwrite the path-derived query digest with an explicit query', async () => {
    const first = await redactToolInput('integration_request', { ...params, path: '/messages?hidden=one', path_query: '?separate=same' }, resolver);
    const second = await redactToolInput('integration_request', { ...params, path: '/messages?hidden=longer-value', path_query: '?separate=same' }, resolver);
    expect(first.digest).not.toEqual(second.digest);
    expect(JSON.stringify(first.digest)).not.toContain('hidden=one');
  });
  it('leaves a completed non-JSON MCP response alone', () => {
    expect(integrationOperationError({ content: [{ type: 'text', text: 'Completed successfully' }] })).toBeUndefined();
  });
});
