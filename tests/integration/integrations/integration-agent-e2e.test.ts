import { requestViaExecute } from './wiredIntegrationHarness.js';
/**
 * Integrations v2 — connect→agent END-TO-END (end-of-phase verification).
 *
 * Unlike the core-path test (which invokes handlers directly), this drives the tools
 * over the REAL MCP protocol: the per-session server is connected to an in-memory
 * transport pair and an MCP Client issues tools/list + tools/call. This exercises the
 * full CallTool dispatch — session resolution, Unicode normalization, the gateway, and
 * server-side credential injection — as an agent would.
 *
 * It also covers the OpenAPI ingestion + generated-skill path: ingesting a spec for a
 * user-owned (BYO) integration is separate from explicitly creating a portfolio skill.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  ACCESS_TOKEN,
  PROVIDER,
  bootWiredIntegration,
  openApiSpec,
  type McpClientHandle,
  type WiredHarness,
} from './wiredIntegrationHarness.js';

const BYO_PROVIDER = 'wired-byo';
const BYO_HOST = 'api.byo.test';
const BYO_SKILL = 'using-wired-byo-integration';

describe('Integrations v2 — connect→agent end-to-end (real MCP transport)', () => {
  let harness: WiredHarness;
  let client: McpClientHandle;

  beforeEach(async () => {
    harness = await bootWiredIntegration();
    client = await harness.connectMcpClient();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function management(operation: string, params: Record<string, unknown>) {
    const endpoint = operation.startsWith('create') ? 'mcp_aql_create' : 'mcp_aql_update';
    const call = async () => {
      const envelope = await client.callTool(endpoint, { operation, params });
      expect(envelope).toMatchObject({ success: true });
      if (!('data' in envelope)) throw new Error('Expected MCP-AQL result');
      return JSON.parse((envelope.data as { content: { text: string }[] }).content[0].text);
    };
    const pending = await call();
    expect(pending).toMatchObject({ ok: false, error: { code: 'integration_request_approval_required' } });
    const approval = await client.callTool('mcp_aql_execute', { operation: 'approve_cli_permission', params: {
      request_id: pending.approvalRequest.requestId, scope: 'single',
    } });
    expect(approval).toMatchObject({ success: true });
    return call();
  }

  it('lists the integration tools over the MCP protocol', async () => {
    const names = await client.listToolNames();
    expect(names).toEqual(expect.arrayContaining(['mcp_aql_execute', 'mcp_aql_read', 'mcp_aql_create', 'mcp_aql_update']));
    expect(names).not.toContain('integration_request');
    expect(names).not.toContain('list_operations');
    expect(names).not.toContain('describe_operation');
    expect(names).not.toContain('ingest_openapi_spec');
    expect(names).not.toContain('regenerate_integration_skill');
  });

  it('executes integration_request via tools/call, injecting the credential server-side', async () => {
    const response = await requestViaExecute((name, args) => client.callTool(name, args), {
      provider: PROVIDER,
      method: 'GET',
      path: '/things/9',
    });

    expect(response.ok).toBe(true);
    const captured = harness.lastRequest();
    expect(captured?.method).toBe('GET');
    expect(captured?.url).toBe('/things/9');
    expect(captured?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(response.result).toMatchObject({
      provenance: { source: 'third_party_integration', trust: 'untrusted' },
    });
  });

  it('creates a BYO spec and separately creates a bounded generated skill', async () => {
    await harness.seedConnectedByoDescriptor(BYO_PROVIDER, BYO_HOST);

    const response = await management('create_integration_spec', {
      provider: BYO_PROVIDER,
      spec: openApiSpec(BYO_HOST),
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      provider: BYO_PROVIDER,
      operationCount: 2,
      outcome: 'created',
    });

    expect(await harness.findSkill(BYO_SKILL)).toBeNull();
    expect((await management('create_integration_skill', { provider: BYO_PROVIDER })).result).toMatchObject({ outcome: 'created', skill_name: BYO_SKILL });
    const skill = await harness.findSkill(BYO_SKILL);
    expect(skill).not.toBeNull();
    // Skills are v2 dual-field — the operation guidance is preserved in `instructions`,
    // not the (manager-rendered) markdown body.
    const rawInstructions = skill?.metadata.instructions;
    const instructions = typeof rawInstructions === 'string' ? rawInstructions : '';
    expect(instructions).toContain('integration_request');
    expect(skill?.metadata).toMatchObject({ source: 'integration_openapi_spec' });
    // Bounded helper, not a context dump.
    expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThanOrEqual(12 * 1024);
  });

  it('rejects spec ingestion for a curated (non-owned) descriptor', async () => {
    const response = await management('create_integration_spec', {
      provider: PROVIDER,
      spec: openApiSpec(),
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: 'integration_spec_forbidden' });
  });

  it('regenerates the derived skill from the stored spec', async () => {
    await harness.seedConnectedByoDescriptor(BYO_PROVIDER, BYO_HOST);
    await management('create_integration_spec', { provider: BYO_PROVIDER, spec: openApiSpec(BYO_HOST) });
    await management('create_integration_skill', { provider: BYO_PROVIDER });

    const response = await management('update_integration_skill', { provider: BYO_PROVIDER });

    expect(response).toMatchObject({ ok: true });
    expect(response.result).toMatchObject({ portfolioName: BYO_SKILL, outcome: 'no-op' });
    const changedSpec = { ...openApiSpec(BYO_HOST), info: { title: 'Updated integration', version: '2.0.0' } };
    expect((await management('update_integration_spec', { provider: BYO_PROVIDER, spec: changedSpec })).result).toMatchObject({ outcome: 'updated' });
    expect((await management('update_integration_skill', { provider: BYO_PROVIDER })).result).toMatchObject({ outcome: 'updated', skill_name: BYO_SKILL });
    expect((await management('update_integration_skill', { provider: BYO_PROVIDER })).result).toMatchObject({ outcome: 'no-op', skill_name: BYO_SKILL });
  });
});
