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
 * user-owned (BYO) integration writes a bounded, scope-aware skill into the portfolio.
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

  it('lists the integration tools over the MCP protocol', async () => {
    const names = await client.listToolNames();
    expect(names).toEqual(expect.arrayContaining(['integration_request', 'list_operations', 'describe_operation', 'ingest_openapi_spec']));
  });

  it('executes integration_request via tools/call, injecting the credential server-side', async () => {
    const response = await client.callTool('integration_request', {
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

  it('ingests an OpenAPI spec for a BYO integration and writes a bounded generated skill', async () => {
    await harness.seedConnectedByoDescriptor(BYO_PROVIDER, BYO_HOST);

    const response = await client.callTool('ingest_openapi_spec', {
      provider: BYO_PROVIDER,
      spec: openApiSpec(BYO_HOST),
      regenerate_skill: true,
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      provider: BYO_PROVIDER,
      operationCount: 2,
      generatedSkill: { written: true, portfolioAction: 'created' },
    });

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
    const response = await client.callTool('ingest_openapi_spec', {
      provider: PROVIDER,
      spec: openApiSpec(),
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: 'integration_openapi_ingest_forbidden' });
  });

  it('regenerates the derived skill from the stored spec', async () => {
    await harness.seedConnectedByoDescriptor(BYO_PROVIDER, BYO_HOST);
    await client.callTool('ingest_openapi_spec', { provider: BYO_PROVIDER, spec: openApiSpec(BYO_HOST), regenerate_skill: true });

    const response = await client.callTool('regenerate_integration_skill', { provider: BYO_PROVIDER });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ portfolioName: BYO_SKILL });
  });
});
