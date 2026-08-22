import { describe, expect, it, jest } from '@jest/globals';

import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import {
  AuthorizedIntegrationGateway,
  AuthorizedIntegrationOperationCatalog,
  AuthorizedIntegrationRemoteMcpBridge,
} from '../../../../src/web-console/modules/integrations/AuthorizedIntegrationGateway.js';
import {
  IntegrationRequestError,
  type PreparedIntegrationRequest,
  type IntegrationRequestGateway,
  type IntegrationRequestResult,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestGateway.js';
import {
  IntegrationPolicyUnavailableError,
  type IntegrationRequestPolicyEnforcer,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';
import type { IntegrationOperationCatalog } from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';
import type {
  IntegrationRemoteMcpBridge,
  PreparedRemoteMcpCall,
} from '../../../../src/web-console/modules/integrations/IntegrationRemoteMcpBridge.js';

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

const PREPARED_REQUEST: PreparedIntegrationRequest = {
  input: REQUEST,
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session-1',
  provider: 'gmail',
  method: 'GET',
  descriptorId: '00000000-0000-4000-8000-000000000002',
  descriptorRoutingFingerprint: 'a'.repeat(64),
  resolvedUrl: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  authMode: 'credentialed',
};

function gatewayMock(result: IntegrationRequestResult = GATEWAY_RESULT): IntegrationRequestGateway {
  return {
    prepareRequest: jest.fn<IntegrationRequestGateway['prepareRequest']>().mockResolvedValue(PREPARED_REQUEST),
    executePrepared: jest.fn<IntegrationRequestGateway['executePrepared']>().mockResolvedValue(result),
  } as unknown as IntegrationRequestGateway;
}

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
  it('authorizes the resolved execution contract and executes that exact plan', async () => {
    const gateway = gatewayMock();
    const policyEnforcer = enforcerAllowing({ requestId: 'cli-1', scope: 'single' });
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const input = { ...REQUEST };
    const outcome = await authorized.request(input);

    expect(gateway.prepareRequest).toHaveBeenCalledWith(input);
    expect(policyEnforcer.authorize).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
      descriptorId: PREPARED_REQUEST.descriptorId,
      descriptorRoutingFingerprint: PREPARED_REQUEST.descriptorRoutingFingerprint,
      resolvedUrl: PREPARED_REQUEST.resolvedUrl,
    }));
    expect(gateway.executePrepared).toHaveBeenCalledWith(PREPARED_REQUEST);
    expect(outcome).toEqual({
      ok: true,
      result: GATEWAY_RESULT,
      approvalContext: { requestId: 'cli-1', scope: 'single' },
    });
  });

  it('never invokes the raw gateway when policy denies', async () => {
    const gateway = gatewayMock();
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({
        allowed: false,
        error: { code: 'integration_request_denied_by_policy', message: 'Denied.', status: 403 },
        policyContext: { source: 'element' },
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const outcome = await authorized.request({ ...REQUEST });

    expect(gateway.executePrepared).not.toHaveBeenCalled();
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
    const gateway = gatewayMock();
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
    const gateway = gatewayMock();
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
    const gateway = gatewayMock();
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({ allowed: false }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const outcome = await authorized.request({ ...REQUEST });

    expect(gateway.executePrepared).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'integration_request_denied_by_policy', status: 403 },
    });
  });

  it('maps policy unavailability to a fail-closed 503 outcome', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const gateway = gatewayMock();
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>()
        .mockRejectedValue(new IntegrationPolicyUnavailableError()),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    const outcome = await authorized.request({ ...REQUEST });

    expect(gateway.executePrepared).not.toHaveBeenCalled();
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
    const gateway = gatewayMock();
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>()
        .mockRejectedValue(new Error('unexpected policy backend failure')),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer });

    await expect(authorized.request({ ...REQUEST })).rejects.toThrow('unexpected policy backend failure');

    expect(gateway.executePrepared).not.toHaveBeenCalled();
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'AuthorizedIntegrationGateway',
      details: expect.stringContaining('decision unavailable'),
    }));
  });

  it('propagates transport errors from the raw gateway unchanged', async () => {
    const gateway = gatewayMock();
    jest.mocked(gateway.executePrepared)
      .mockRejectedValue(new IntegrationRequestError('integration_request_rate_limited', 'Rate limited.', 429));
    const authorized = new AuthorizedIntegrationGateway({ gateway, policyEnforcer: enforcerAllowing() });

    await expect(authorized.request({ ...REQUEST })).rejects.toMatchObject({
      code: 'integration_request_rate_limited',
      status: 429,
    });
  });
});

describe('AuthorizedIntegrationOperationCatalog', () => {
  it('authorizes and ingests the same immutable OpenAPI snapshot', async () => {
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>().mockResolvedValue({
        provider: 'gmail',
        descriptorId: '00000000-0000-4000-8000-000000000001',
        specHash: 'a'.repeat(64),
        operationCount: 1,
      }),
    } as unknown as IntegrationOperationCatalog;
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>(resolve => { releaseAuthorization = resolve; });
    const authorize = jest.fn<IntegrationRequestPolicyEnforcer['authorize']>(async () => {
      await authorizationGate;
      return { allowed: true };
    });
    const authorized = new AuthorizedIntegrationOperationCatalog({
      catalog,
      policyEnforcer: { authorize } as unknown as IntegrationRequestPolicyEnforcer,
    });
    const input = {
      provider: 'gmail',
      spec: { openapi: '3.1.0', paths: { '/approved': { get: {} } } },
      sourceUrl: null,
      regenerateSkill: false,
    };

    const pending = authorized.ingestOpenApiSpec(input);
    await waitForMockCall(authorize);
    input.spec.paths = { '/mutated': { get: {} } };
    input.regenerateSkill = true;
    releaseAuthorization();
    await pending;

    const approved = authorize.mock.calls[0]?.[0];
    const executed = jest.mocked(catalog.ingestOpenApiSpec).mock.calls[0]?.[0];
    expect(approved?.body).toEqual({
      spec: { openapi: '3.1.0', paths: { '/approved': { get: {} } } },
      regenerateSkill: false,
    });
    expect(executed).toMatchObject({
      spec: { openapi: '3.1.0', paths: { '/approved': { get: {} } } },
      regenerateSkill: false,
    });
    expect(approved?.body?.spec).toBe(executed?.spec);
    expect(Object.isFrozen(executed?.spec)).toBe(true);
  });

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

  it('executes the immutable regenerate-skill input that was authorized', async () => {
    let releaseAuthorization: (() => void) | undefined;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const catalog = {
      regenerateSkill: jest.fn<IntegrationOperationCatalog['regenerateSkill']>().mockResolvedValue({
        provider: 'gmail',
        descriptorId: '00000000-0000-4000-8000-000000000001',
        specHash: 'a'.repeat(64),
        skillName: 'using-gmail-integration',
        skillVersion: '1.0.0',
        byteLength: 100,
        truncated: false,
      }),
    } as unknown as IntegrationOperationCatalog;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockImplementation(async () => {
        await authorizationGate;
        return { allowed: true };
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationOperationCatalog({ catalog, policyEnforcer });
    const input = { provider: 'gmail' };

    const pending = authorized.regenerateSkill(input);
    input.provider = 'remote-docs';
    releaseAuthorization?.();
    await pending;

    expect(policyEnforcer.authorize).toHaveBeenCalledWith({
      provider: 'gmail',
      method: 'PUT',
      path: '_internal:/integration/generated_skill',
    });
    expect(catalog.regenerateSkill).toHaveBeenCalledWith({ provider: 'gmail' });
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
  it('authorizes the immutable prepared remote call rather than mutable caller input', async () => {
    const callerInput = {
      provider: REMOTE_DOCS,
      remoteName: 'caller-name',
      arguments: { q: 'caller-value' },
    };
    const preparedInput = Object.freeze({
      provider: REMOTE_DOCS,
      remoteName: 'approved-name',
      arguments: Object.freeze({ q: 'approved-value' }),
    });
    const plan: PreparedRemoteMcpCall = {
      input: preparedInput,
      userId: PREPARED_REQUEST.userId,
      sessionId: PREPARED_REQUEST.sessionId,
      provider: REMOTE_DOCS,
      descriptorId: PREPARED_REQUEST.descriptorId,
      descriptorRoutingFingerprint: PREPARED_REQUEST.descriptorRoutingFingerprint,
      serverUrl: 'https://mcp.example.com/mcp',
    };
    const bridge = {
      prepareCall: jest.fn<IntegrationRemoteMcpBridge['prepareCall']>().mockResolvedValue(plan),
      executePreparedCall: jest.fn<IntegrationRemoteMcpBridge['executePreparedCall']>().mockResolvedValue({
        provider: REMOTE_DOCS,
        remoteName: preparedInput.remoteName,
        result: {},
        provenance: {
          source: 'third_party_integration',
          trust: 'untrusted',
          provider: REMOTE_DOCS,
          remoteTool: preparedInput.remoteName,
          handling: 'data_only_not_instructions',
        },
      }),
    } as unknown as IntegrationRemoteMcpBridge;
    const policyEnforcer = enforcerAllowing();
    const authorized = new AuthorizedIntegrationRemoteMcpBridge({ bridge, policyEnforcer });

    await authorized.callTool(callerInput);

    expect(policyEnforcer.authorize).toHaveBeenCalledWith(expect.objectContaining({
      path: '_internal:/integration/remote_mcp/approved-name',
      body: {
        arguments: { q: 'approved-value' },
        remote_mcp_server_url: plan.serverUrl,
      },
    }));
    expect(bridge.executePreparedCall).toHaveBeenCalledWith(plan);
  });

  it('authorizes proxy calls against the per-tool sentinel target before the bridge runs', async () => {
    const input = {
      provider: REMOTE_DOCS,
      remoteName: 'search me',
      arguments: { q: 'status' },
    };
    const plan: PreparedRemoteMcpCall = {
      input,
      userId: PREPARED_REQUEST.userId,
      sessionId: PREPARED_REQUEST.sessionId,
      provider: REMOTE_DOCS,
      descriptorId: PREPARED_REQUEST.descriptorId,
      descriptorRoutingFingerprint: PREPARED_REQUEST.descriptorRoutingFingerprint,
      serverUrl: 'https://mcp.example.com/mcp',
    };
    const bridge = {
      prepareCall: jest.fn<IntegrationRemoteMcpBridge['prepareCall']>().mockResolvedValue(plan),
      executePreparedCall: jest.fn<IntegrationRemoteMcpBridge['executePreparedCall']>().mockResolvedValue({
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

    const outcome = await authorized.callTool(input);

    expect(policyEnforcer.authorize).toHaveBeenCalledWith(expect.objectContaining({
      provider: REMOTE_DOCS,
      method: 'PUT',
      path: '_internal:/integration/remote_mcp/search%20me',
      body: {
        arguments: { q: 'status' },
        remote_mcp_server_url: plan.serverUrl,
      },
      descriptorId: plan.descriptorId,
      descriptorRoutingFingerprint: plan.descriptorRoutingFingerprint,
      resolvedUrl: plan.serverUrl,
    }));
    expect(bridge.executePreparedCall).toHaveBeenCalledWith(plan);
    expect(outcome).toMatchObject({ ok: true });
  });

  it('normalizes non-object arguments to an empty policy body and denies before the bridge', async () => {
    const input = {
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: 'not-an-object',
    };
    const plan: PreparedRemoteMcpCall = {
      input,
      userId: PREPARED_REQUEST.userId,
      sessionId: PREPARED_REQUEST.sessionId,
      provider: REMOTE_DOCS,
      descriptorId: PREPARED_REQUEST.descriptorId,
      descriptorRoutingFingerprint: PREPARED_REQUEST.descriptorRoutingFingerprint,
      serverUrl: 'https://mcp.example.com/mcp',
    };
    const bridge = {
      prepareCall: jest.fn<IntegrationRemoteMcpBridge['prepareCall']>().mockResolvedValue(plan),
      executePreparedCall: jest.fn<IntegrationRemoteMcpBridge['executePreparedCall']>(),
    } as unknown as IntegrationRemoteMcpBridge;
    const policyEnforcer = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({
        allowed: false,
        error: { code: 'integration_request_denied_by_policy', message: 'Denied.', status: 403 },
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const authorized = new AuthorizedIntegrationRemoteMcpBridge({ bridge, policyEnforcer });

    const outcome = await authorized.callTool(input);

    expect(policyEnforcer.authorize).toHaveBeenCalledWith(expect.objectContaining({
      provider: REMOTE_DOCS,
      method: 'PUT',
      path: '_internal:/integration/remote_mcp/search',
      body: {
        arguments: {},
        remote_mcp_server_url: plan.serverUrl,
      },
    }));
    expect(bridge.executePreparedCall).not.toHaveBeenCalled();
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

async function waitForMockCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalled();
}
