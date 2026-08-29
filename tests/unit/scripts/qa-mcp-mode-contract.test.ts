import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  DISCRETE_CORE_TOOLS,
  MCP_AQL_CRUDE_TOOLS,
  QA_MODE_CONTRACTS,
  createIsolatedQaEnvironment,
  validateToolCallResult,
  validateToolSurface,
} from '../../../scripts/qa-mcp-mode-contract.js';

function tool(name: string) {
  return { name, inputSchema: { type: 'object' } };
}

describe('MCP QA mode contract', () => {
  it('pins every supported interface configuration', () => {
    expect(QA_MODE_CONTRACTS.map((contract) => contract.id)).toEqual([
      'discrete',
      'mcpaql-crude',
      'mcpaql-single',
    ]);
    expect(DISCRETE_CORE_TOOLS).toHaveLength(42);
    expect(new Set(DISCRETE_CORE_TOOLS)).toHaveProperty('size', 42);
    expect(MCP_AQL_CRUDE_TOOLS).toEqual([
      'mcp_aql_create',
      'mcp_aql_read',
      'mcp_aql_update',
      'mcp_aql_delete',
      'mcp_aql_execute',
    ]);
    expect(QA_MODE_CONTRACTS[0].calls[0]).toMatchObject({
      tool: 'list_elements',
      arguments: { type: 'personas' },
    });
  });

  it('only makes representative calls to required tools', () => {
    for (const contract of QA_MODE_CONTRACTS) {
      for (const call of contract.calls) {
        expect(contract.requiredTools).toContain(call.tool);
        expect(contract.forbiddenTools).not.toContain(call.tool);
      }
    }
  });

  it('accepts each required surface and additive integration tools', () => {
    for (const contract of QA_MODE_CONTRACTS) {
      const result = validateToolSurface(contract, [
        ...contract.requiredTools.map(tool),
        tool('integration_optional_tool'),
      ]);

      expect(result).toMatchObject({ success: true, errors: [] });
    }
  });

  it('rejects missing, forbidden, duplicate, and malformed tools', () => {
    const contract = QA_MODE_CONTRACTS[0];
    const advertised = contract.requiredTools.slice(1).map(tool);
    advertised.push(tool(contract.requiredTools[1]));
    advertised.push(tool('mcp_aql'));
    advertised.push({ name: 'malformed_tool', inputSchema: { type: 'string' } });

    const result = validateToolSurface(contract, advertised);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('duplicate tool names'),
      expect.stringContaining('missing required tools'),
      expect.stringContaining('wrong interface mode'),
      expect.stringContaining('lack a name or object input schema'),
    ]));
  });

  it('recognizes protocol and MCP-AQL failure results', () => {
    expect(validateToolCallResult(null)).toMatchObject({ success: false });
    expect(validateToolCallResult({ isError: true, content: [{ type: 'text', text: 'failed' }] }))
      .toMatchObject({ success: false });
    expect(validateToolCallResult({ content: [] })).toMatchObject({ success: false });
    expect(validateToolCallResult({
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'failed' }) }],
    })).toMatchObject({ success: false, error: 'failed' });
    expect(validateToolCallResult({
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { message: 'denied' } }) }],
    })).toMatchObject({ success: false, error: 'denied' });
    expect(validateToolCallResult({
      content: [{ type: 'text', text: JSON.stringify({ data: { isError: true, error: 'invalid' } }) }],
    })).toMatchObject({ success: false, error: 'invalid' });
    expect(validateToolCallResult({ content: [{ type: 'text', text: 'successful response' }] }))
      .toEqual({ success: true, error: null });
  });

  it('isolates filesystem state and blanks inherited credentials', async () => {
    const isolated = await createIsolatedQaEnvironment(QA_MODE_CONTRACTS[0], 'contract-test');
    try {
      expect(isolated.environment).toMatchObject({
        MCP_INTERFACE_MODE: 'discrete',
        DOLLHOUSE_ACTIVATION_PERSISTENCE: 'false',
        DOLLHOUSE_STORAGE_BACKEND: 'file',
        DOLLHOUSE_AUTH_STORAGE_BACKEND: 'filesystem',
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        DOLLHOUSE_DATABASE_URL: '',
        DOLLHOUSE_MASTER_ENCRYPTION_KEY: '',
      });

      for (const variable of [
        'DOLLHOUSE_HOME_DIR',
        'DOLLHOUSE_PORTFOLIO_DIR',
        'DOLLHOUSE_CACHE_DIR',
        'DOLLHOUSE_STATE_DIR',
        'DOLLHOUSE_RUN_DIR',
        'DOLLHOUSE_LOG_DIR',
        'DOLLHOUSE_SHARED_POOL_DIR',
        'DOLLHOUSE_SHARED_PROVENANCE_DIR',
      ]) {
        const directory = isolated.environment[variable];
        expect(typeof directory).toBe('string');
        expect(path.relative(isolated.root, directory)).not.toMatch(/^\.\.(?:[/\\]|$)/);
        await expect(access(directory)).resolves.toBeUndefined();
      }
    } finally {
      await isolated.dispose();
    }

    await expect(access(isolated.root)).rejects.toThrow();
  });
});
