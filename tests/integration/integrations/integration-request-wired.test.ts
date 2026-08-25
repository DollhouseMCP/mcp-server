/**
 * Integrations v2 — core-path WIRED integration test (end-of-phase verification).
 *
 * Drives the per-session ToolRegistry directly (handler invocation) against a real
 * DollhouseContainer + local fake upstream. Exercises the non-null DI composition
 * branches (gateway / operation catalog / policy enforcer / remote-MCP bridge) that
 * unit tests only ever reach through mocks. See wiredIntegrationHarness for the boot
 * recipe and the SSRF-safe local-routing technique.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';

import { ACCESS_TOKEN, PROVIDER, bootWiredIntegration, type WiredHarness } from './wiredIntegrationHarness.js';

describe('Integrations v2 — wired integration_request (core path)', () => {
  let harness: WiredHarness;

  beforeEach(async () => {
    harness = await bootWiredIntegration({ remoteMcp: { tools: ['echo'] } });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('registers integration tools on the per-session registry', () => {
    expect(harness.hasTool('integration_request')).toBe(true);
    expect(harness.hasTool('list_operations')).toBe(true);
    expect(harness.hasTool('describe_operation')).toBe(true);
  });

  it('executes a read through the gateway, injecting the credential server-side', async () => {
    const response = await harness.callViaRegistry('integration_request', {
      provider: PROVIDER,
      method: 'GET',
      path: '/things/42',
    });

    expect(response.ok).toBe(true);
    const captured = harness.lastRequest();
    expect(captured?.method).toBe('GET');
    expect(captured?.url).toBe('/things/42');
    expect(captured?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(response.result).toMatchObject({
      provenance: { source: 'third_party_integration', trust: 'untrusted' },
    });
  });

  it('rejects path-based attempts to reach a host outside the descriptor', async () => {
    // The path is always resolved against the descriptor's apiHost, so a request cannot
    // be redirected to another host — the path-format guard rejects any such attempt and
    // nothing leaves the server.
    for (const path of [
      'https://not-allowed.example.com/things/42',
      '//not-allowed.example.com/things/42',
      String.raw`/things/\..\secret`,
    ]) {
      const response = await harness.callViaRegistry('integration_request', { provider: PROVIDER, method: 'GET', path });
      expect(response.ok).toBe(false);
      expect((response.error as { code?: string }).code).toBe('invalid_integration_path');
      expect(harness.lastRequest()).toBeUndefined();
    }
  });

  it('isolates credentials between user sessions', async () => {
    const callAsOther = await harness.openSession(randomUUID());

    const response = await callAsOther('integration_request', {
      provider: PROVIDER,
      method: 'GET',
      path: '/things/1',
    });

    // A second user with no connected credential for this provider must not be able to
    // ride the first user's credential — the call fails and never reaches the upstream.
    expect(response.ok).toBe(false);
    expect(harness.lastRequest()).toBeUndefined();
  });

  it('executes a write through the gateway, forwarding the request body', async () => {
    const response = await harness.callViaRegistry('integration_request', {
      provider: PROVIDER,
      method: 'POST',
      path: '/things',
      body: { name: 'widget' },
    });

    expect(response.ok).toBe(true);
    const captured = harness.lastRequest();
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('/things');
    expect(captured?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(captured?.body ?? '{}')).toEqual({ name: 'widget' });
  });

  it('redacts credential-shaped fields in the upstream response body', async () => {
    const response = await harness.callViaRegistry('integration_request', {
      provider: PROVIDER,
      method: 'GET',
      path: '/redact/thing',
    });

    expect(response.ok).toBe(true);
    const responseBody = (response.result as { response: Record<string, unknown> }).response;
    expect(responseBody.data).toBe('ok');
    // The credential-shaped key is scrubbed before the result is returned to the model.
    expect(responseBody.access_token).toBe('[redacted]');
  });

  it('requires approval for write-class requests under a dangerous approval policy', async () => {
    const previous = process.env.DOLLHOUSE_CLI_APPROVAL_POLICY;
    process.env.DOLLHOUSE_CLI_APPROVAL_POLICY = 'dangerous';
    try {
      const response = await harness.callViaRegistry('integration_request', {
        provider: PROVIDER,
        method: 'POST',
        path: '/things',
        body: { name: 'widget' },
      });

      // A write (POST) is dangerous-class, so it must be held for approval, not executed.
      expect(response.ok).toBe(false);
      expect((response as { approvalRequest?: unknown }).approvalRequest).toBeDefined();
      expect(harness.lastRequest()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DOLLHOUSE_CLI_APPROVAL_POLICY;
      else process.env.DOLLHOUSE_CLI_APPROVAL_POLICY = previous;
    }
  });

  it('derives operations from the stored OpenAPI spec via list_operations', async () => {
    const response = await harness.callViaRegistry('list_operations', { provider: PROVIDER });

    expect(response.ok).toBe(true);
    const operations = (response.result as { operations: { operationId: string }[] }).operations;
    expect(operations.map(op => op.operationId).sort()).toEqual(['createThing', 'getThing']);
  });

  it('describes an operation with gateway-request metadata and spec contract', async () => {
    const response = await harness.callViaRegistry('describe_operation', {
      provider: PROVIDER,
      operation_id: 'getThing',
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      operationId: 'getThing',
      method: 'GET',
      path: '/things/{id}',
      gatewayRequest: { tool: 'integration_request', provider: PROVIDER, method: 'GET', pathTemplate: '/things/{id}' },
      specContract: { descriptorId: harness.curatedDescriptorId },
    });
  });

  it('registers a promoted tool and routes it through the gateway', async () => {
    const promotedName = `integration_${PROVIDER.replace('-', '_')}_getthing`;
    expect(harness.hasTool(promotedName)).toBe(true);

    const response = await harness.callViaRegistry(promotedName, { path_params: { id: '7' } });

    expect(response.ok).toBe(true);
    const captured = harness.lastRequest();
    expect(captured?.method).toBe('GET');
    expect(captured?.url).toBe('/things/7');
    expect(captured?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('registers only allowlisted remote MCP tools and proxies with provenance', async () => {
    const echoTool = `remote_mcp_${PROVIDER.replace('-', '_')}_echo`;
    const secretTool = `remote_mcp_${PROVIDER.replace('-', '_')}_secret`;
    expect(harness.hasTool(echoTool)).toBe(true);
    expect(harness.hasTool(secretTool)).toBe(false);

    const response = await harness.callViaRegistry(echoTool, { message: 'hi' });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      provider: PROVIDER,
      remoteName: 'echo',
      provenance: { source: 'third_party_integration', trust: 'untrusted' },
    });
    // The decrypted credential was injected server-side into the remote MCP client.
    expect(harness.lastRemoteMcpBearerToken()).toBe(ACCESS_TOKEN);
  });
});
