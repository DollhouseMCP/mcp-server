import { describe, expect, it, jest } from '@jest/globals';

import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import {
  AuthorizedIntegrationGateway,
  AuthorizedIntegrationOperationCatalog,
  AuthorizedIntegrationRemoteMcpBridge,
} from '../../../../src/web-console/modules/integrations/AuthorizedIntegrationGateway.js';
import {
  IntegrationRequestError,
  type IntegrationRequestGateway,
  type IntegrationRequestResult,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestGateway.js';
import {
  IntegrationPolicyUnavailableError,
  type IntegrationRequestPolicyEnforcer,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';
import type { IntegrationOperationCatalog } from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';
import type { IntegrationRemoteMcpBridge } from '../../../../src/web-console/modules/integrations/IntegrationRemoteMcpBridge.js';

const REMOTE_DOCS = 'remote-docs';

const REQUEST = {
  provider: 'gmail',
  method: 'GET',
  path: '/gmail/v1/users/me/profile',
} as const;

const GATEWAY_RESULT: IntegrationRequestResult = {
  provider: 'gmail',
  method: 'GET',
  host: 'gmail.googleapis.com',
  path: '/gmail/v1/users/me/profile',
  status: 200,
  response: {},
  refreshed: false,
  provenance: {
    source: 'third_party_integration',
    trust: 'untrusted',
    provider: 'gmail',
    method: 'GET',
    host: 'gmail.googleapis.com',
    path: '/gmail/v1/users/me/profile',
    readWriteClass: 'read',
    handling: 'data_only_not_instructions',
  },
};

function enforcerAllowing(approvalContext?: { requestId: string; scope: string }): IntegrationRequestPolicyEnforcer {
  return {
    authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({
      allowed: true,
      ...(approvalContext ? { approvalContext } : {}),
    }),
  } as unknown as IntegrationRequestPolicyEnforcer;
}

describe('integrations module barrel (FO2 isolation)', () => {
  it('does not re-export the raw execution authority constructors', async () => {
    const barrel = await import('../../../../src/web-console/modules/integrations/index.js');
    const exported = Object.keys(barrel);
    // The raw authorities must stay constructible only from the DI root; the
    // barrel exposes their error/DTO types and the Authorized* facades, never
    // the un-gated classes themselves.
    expect(exported).not.toContain('IntegrationRequestGateway');
    expect(exported).not.toContain('IntegrationOperationCatalog');
    expect(exported).not.toContain('IntegrationRemoteMcpBridge');
    // Facades remain exported.
    expect(exported).toContain('AuthorizedIntegrationGateway');
    expect(exported).toContain('AuthorizedIntegrationOperationCatalog');
    expect(exported).toContain('AuthorizedIntegrationRemoteMcpBridge');
  });
});

describe('AuthorizedIntegrationGateway', () => {
  it('feeds the exact same input object to authorize() and the raw gateway', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>().mockResolvedValue(GATEWAY_RESULT),
    } as unknown as IntegrationRequestGateway;
    const policyEnforcer = enforcerAllowing({ requestId: 'cli-1', scope: 'single' });
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const input = { ...REQUEST };
    const outcome = await authorized.request(input);

    // Identity, not equality: the approval HMAC binds to the exact input the
    // enforcer saw, so the facade must not rebuild or normalize it in between.
    expect((policyEnforcer.authorize as jest.Mock).mock.calls[0][0]).toBe(input);
    expect((gateway.request as jest.Mock).mock.calls[0][0]).toBe(input);
    expect(outcome).toEqual({
      ok: true,
      result: GATEWAY_RESULT,
      approvalContext: { requestId: 'cli-1', scope: 'single' },
    });
  });

  it('never invokes the raw gateway when policy denies', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({
        allowed: false,
        error: { code: 'integration_request_denied_by_policy', message: 'Denied.', status: 403 },
        policyContext: { source: 'element' },
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const outcome = await authorized.request({ ...REQUEST });

    expect(gateway.request).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'integration_request_denied_by_policy', message: 'Denied.', status: 403 },
      policyContext: { source: 'element' },
    });
  });

  it.each([
    'gho_sensitive-value-that-must-not-be-logged',
    'sk_live_12345678901234567890',
    'xoxb-1234567890-abcdef',
    'glpat-abcdef123456',
    'opaquecredentialvalue1234567890',
  ])('does not write token-shaped provider input into the security audit event: %s', async untrustedProvider => {
    SecurityMonitor.clearAllEventsForTesting();
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({ allowed: false }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    await authorized.request({ provider: untrustedProvider, method: 'GET', path: '/anything' });

    const event = SecurityMonitor.getRecentEvents().find(entry => entry.source === 'AuthorizedIntegrationGateway');
    expect(event?.details).toContain('provider <invalid>');
    expect(JSON.stringify(event)).not.toContain(untrustedProvider);
  });

  it('retains separate authorization decisions through security-event deduplication', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({ allowed: false }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    await authorized.request({ ...REQUEST });
    await authorized.request({ ...REQUEST });

    const events = SecurityMonitor.getRecentEvents()
      .filter(entry => entry.source === 'AuthorizedIntegrationGateway');
    expect(events).toHaveLength(2);
    expect(events[0]?.details).toBe(events[1]?.details);
  });

  it('falls back to a denial error when a disallowed decision carries none', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({ allowed: false }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const outcome = await authorized.request({ ...REQUEST });

    expect(gateway.request).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'integration_request_denied_by_policy', status: 403 },
    });
  });

  it('maps policy unavailability to a fail-closed 503 outcome', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>()
        .mockRejectedValue(new IntegrationPolicyUnavailableError()),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const outcome = await authorized.request({ ...REQUEST });

    expect(gateway.request).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'integration_request_policy_unavailable', status: 503 },
    });
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'AuthorizedIntegrationGateway',
      details: expect.stringContaining('decision unavailable'),
    }));
  });

  it('audits unexpected policy failures as unavailable before propagating them', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>()
        .mockRejectedValue(new Error('unexpected policy backend failure')),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    await expect(authorized.request({ ...REQUEST })).rejects.toThrow('unexpected policy backend failure');

    expect(gateway.request).not.toHaveBeenCalled();
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'AuthorizedIntegrationGateway',
      details: expect.stringContaining('decision unavailable'),
    }));
  });

  it('propagates transport errors from the raw gateway unchanged', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>()
        .mockRejectedValue(new IntegrationRequestError('integration_request_rate_limited', 'Rate limited.', 429)),
    } as unknown as IntegrationRequestGateway;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer: enforcerAllowing() });

    await expect(authorized.request({ ...REQUEST })).rejects.toMatchObject({
      code: 'integration_request_rate_limited',
      status: 429,
    });
  });
});

describe('AuthorizedIntegrationOperationCatalog', () => {
  it('authorizes spec ingestion against the gateway-rejectable sentinel target', async () => {
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>().mockResolvedValue({
        provider: 'gmail',
        descriptorId: '00000000-0000-4000-8000-000000000001',
        specHash: 'a'.repeat(64),
        operationCount: 1,
      }),
    } as unknown as IntegrationOperationCatalog;
    const policyEnforcer = enforcerAllowing();
    const authorized = new AuthorizedIntegrationOperationCatalog({ catalog, policyEnforcer });

    const spec = { openapi: '3.1.0', paths: {} };
    const outcome = await authorized.ingestOpenApiSpec({ provider: 'gmail', spec, sourceUrl: null, regenerateSkill: false });

    expect(policyEnforcer.authorize).toHaveBeenCalledWith({
      provider: 'gmail',
      method: 'PUT',
      path: '_internal:/integration/openapi_spec',
      body: { spec, regenerateSkill: false },
    });
    expect(outcome).toMatchObject({ ok: true, result: { operationCount: 1 } });
  });

  it('binds the regenerate-skill side effect into spec-ingestion approval input', async () => {
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>().mockResolvedValue({
        provider: 'gmail',
        descriptorId: '00000000-0000-4000-8000-000000000001',
        specHash: 'a'.repeat(64),
        operationCount: 1,
      }),
    } as unknown as IntegrationOperationCatalog;
    const policyEnforcer = enforcerAllowing();
    const authorized = new AuthorizedIntegrationOperationCatalog({ catalog, policyEnforcer });
    const spec = { openapi: '3.1.0', paths: {} };

    await authorized.ingestOpenApiSpec({ provider: 'gmail', spec, sourceUrl: null, regenerateSkill: false });
    await authorized.ingestOpenApiSpec({ provider: 'gmail', spec, sourceUrl: null, regenerateSkill: true });

    expect(policyEnforcer.authorize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      body: { spec, regenerateSkill: false },
    }));
    expect(policyEnforcer.authorize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      body: { spec, regenerateSkill: true },
    }));
  });

  it('never mutates through the catalog when policy denies a management write', async () => {
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>(),
      regenerateSkill: jest.fn<IntegrationOperationCatalog['regenerateSkill']>(),
    } as unknown as IntegrationOperationCatalog;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({
        allowed: false,
        error: { code: 'integration_request_approval_required', message: 'Approval required.', status: 403 },
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationOperationCatalog({ catalog, policyEnforcer });

    const ingest = await authorized.ingestOpenApiSpec({ provider: 'gmail', spec: {}, sourceUrl: null, regenerateSkill: false });
    const regenerate = await authorized.regenerateSkill({ provider: 'gmail' });

    expect(catalog.ingestOpenApiSpec).not.toHaveBeenCalled();
    expect(catalog.regenerateSkill).not.toHaveBeenCalled();
    expect(ingest).toMatchObject({ ok: false, error: { code: 'integration_request_approval_required' } });
    expect(regenerate).toMatchObject({ ok: false, error: { code: 'integration_request_approval_required' } });
    expect(policyEnforcer.authorize).toHaveBeenCalledWith({
      provider: 'gmail',
      method: 'PUT',
      path: '_internal:/integration/generated_skill',
    });
  });

  it('passes reads through without a policy check', async () => {
    const catalog = {
      listOperations: jest.fn<IntegrationOperationCatalog['listOperations']>(),
      describeOperation: jest.fn<IntegrationOperationCatalog['describeOperation']>(),
      listPromotedOperations: jest.fn<IntegrationOperationCatalog['listPromotedOperations']>().mockResolvedValue([]),
    } as unknown as IntegrationOperationCatalog;
    const policyEnforcer = enforcerAllowing();
    const authorized = new AuthorizedIntegrationOperationCatalog({ catalog, policyEnforcer });

    await authorized.listOperations({ provider: 'gmail' });
    await authorized.describeOperation({ provider: 'gmail', operationId: 'getProfile' });
    await authorized.listPromotedOperations();

    expect(policyEnforcer.authorize).not.toHaveBeenCalled();
    expect(catalog.listOperations).toHaveBeenCalledWith({ provider: 'gmail' });
    expect(catalog.describeOperation).toHaveBeenCalledWith({ provider: 'gmail', operationId: 'getProfile' });
    expect(catalog.listPromotedOperations).toHaveBeenCalledWith({});
  });
});

describe('AuthorizedIntegrationRemoteMcpBridge', () => {
  it('authorizes proxy calls against the per-tool sentinel target before the bridge runs', async () => {
    const bridge = {
      callTool: jest.fn<IntegrationRemoteMcpBridge['callTool']>().mockResolvedValue({
        provider: REMOTE_DOCS,
        remoteName: 'search',
        result: {},
        provenance: {
          source: 'third_party_integration',
          trust: 'untrusted',
          provider: REMOTE_DOCS,
          remoteTool: 'search',
          handling: 'data_only_not_instructions',
        },
      }),
    } as unknown as IntegrationRemoteMcpBridge;
    const policyEnforcer = enforcerAllowing();
    const authorized = new AuthorizedIntegrationRemoteMcpBridge({ bridge, policyEnforcer });

    const outcome = await authorized.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search me',
      arguments: { q: 'status' },
    });

    expect(policyEnforcer.authorize).toHaveBeenCalledWith({
      provider: REMOTE_DOCS,
      method: 'PUT',
      path: '_internal:/integration/remote_mcp/search%20me',
      body: { q: 'status' },
    });
    expect(bridge.callTool).toHaveBeenCalledWith({
      provider: REMOTE_DOCS,
      remoteName: 'search me',
      arguments: { q: 'status' },
    });
    expect(outcome).toMatchObject({ ok: true });
  });

  it('normalizes non-object arguments to an empty policy body and denies before the bridge', async () => {
    const bridge = {
      callTool: jest.fn<IntegrationRemoteMcpBridge['callTool']>(),
    } as unknown as IntegrationRemoteMcpBridge;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({
        allowed: false,
        error: { code: 'integration_request_denied_by_policy', message: 'Denied.', status: 403 },
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationRemoteMcpBridge({ bridge, policyEnforcer });

    const outcome = await authorized.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: 'not-an-object',
    });

    expect(policyEnforcer.authorize).toHaveBeenCalledWith({
      provider: REMOTE_DOCS,
      method: 'PUT',
      path: '_internal:/integration/remote_mcp/search',
      body: {},
    });
    expect(bridge.callTool).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false });
  });

  it('passes tool discovery through to the internally gated bridge', async () => {
    const bridge = {
      listAllowedTools: jest.fn<IntegrationRemoteMcpBridge['listAllowedTools']>().mockResolvedValue([]),
    } as unknown as IntegrationRemoteMcpBridge;
    const authorized = new AuthorizedIntegrationRemoteMcpBridge({ bridge, policyEnforcer: enforcerAllowing() });

    await expect(authorized.listAllowedTools()).resolves.toEqual([]);
    expect(bridge.listAllowedTools).toHaveBeenCalled();
  });
});
