import { describe, expect, it } from '@jest/globals';
import { redactToolInput } from '../../../src/security/toolRedaction.js';
import { StaticAuditHmacKeyResolver } from '../../../src/security/auditHmacKey.js';
const resolver = new StaticAuditHmacKeyResolver('ab'.repeat(32));
describe('integration request host approval redaction', () => {
  it.each(['mcp_aql_execute', 'mcp_aql'])('keeps routing context and digests all request secrets through %s', async endpoint => {
    const params = { provider: 'mail', method: 'GET', path: '/items?custom=secret-path', query: { q: 'secret-query' }, body: 'secret-body' };
    const { digest } = await redactToolInput(`mcp__DollhouseMCP__${endpoint}`, { operation: 'integration_request', params }, resolver);
    expect(digest).toMatchObject({ operation: 'integration_request', provider: 'mail', method: 'GET', path: '/items', read_write_class: 'read' });
    for (const value of ['secret-path', 'secret-query', 'secret-body']) expect(JSON.stringify(digest)).not.toContain(value);
    for (const field of ['path_query', 'query', 'body']) expect(digest[field]).toBeDefined();
  });
  it('digests malformed envelopes instead of exposing arbitrary values', async () => {
    const { digest } = await redactToolInput('mcp__DollhouseMCP__mcp_aql_execute', { operation: 'integration_request', params: 'private-value', unexpected: 'private-extra' }, resolver);
    expect(JSON.stringify(digest)).not.toContain('private-');
  });
});
