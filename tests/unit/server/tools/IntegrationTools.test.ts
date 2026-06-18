import { describe, expect, it, jest } from '@jest/globals';

import { getIntegrationTools } from '../../../../src/server/tools/IntegrationTools.js';
import type { IntegrationRequestGateway } from '../../../../src/web-console/modules/integrations/IntegrationRequestGateway.js';
import {
  IntegrationPolicyUnavailableError,
  type IntegrationRequestPolicyEnforcer,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';

describe('IntegrationTools', () => {
  it('runs policy before gateway request and returns approval metadata', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policy = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({
        allowed: false,
        error: {
          code: 'integration_request_approval_required',
          message: 'Approval required.',
          status: 403,
        },
        approvalRequest: {
          requestId: 'cli-00000000-0000-4000-8000-000000000001',
          toolName: 'integration_request',
          riskLevel: 'dangerous',
          riskScore: 80,
          irreversible: false,
          reason: 'Requires approval.',
        },
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;

    const tool = getIntegrationTools(gateway, policy)[0];
    const result = await tool.handler({
      provider: 'gmail',
      method: 'POST',
      path: '/gmail/v1/users/me/messages/send',
    });

    expect(policy.authorize).toHaveBeenCalledWith({
      provider: 'gmail',
      method: 'POST',
      path: '/gmail/v1/users/me/messages/send',
      query: undefined,
      body: undefined,
    });
    expect(gateway.request).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: { code: 'integration_request_approval_required' },
      approvalRequest: { toolName: 'integration_request' },
    });
  });

  it('returns provenance-bearing gateway result when policy allows', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>().mockResolvedValue({
        provider: 'gmail',
        method: 'GET',
        host: 'gmail.googleapis.com',
        path: '/gmail/v1/users/me/profile',
        status: 200,
        response: { email: 'alice@example.com' },
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
      }),
    } as unknown as IntegrationRequestGateway;
    const policy = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({ allowed: true }),
    } as unknown as IntegrationRequestPolicyEnforcer;

    const tool = getIntegrationTools(gateway, policy)[0];
    const result = await tool.handler({
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
    });

    expect(gateway.request).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      result: {
        provenance: {
          source: 'third_party_integration',
          trust: 'untrusted',
          handling: 'data_only_not_instructions',
        },
      },
    });
  });

  it('returns a clean denial when policy checks are unavailable', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const policy = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>()
        .mockRejectedValue(new IntegrationPolicyUnavailableError()),
    } as unknown as IntegrationRequestPolicyEnforcer;

    const tool = getIntegrationTools(gateway, policy)[0];
    const result = await tool.handler({
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
    });

    expect(gateway.request).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: {
        code: 'integration_request_policy_unavailable',
        status: 503,
      },
    });
  });
});
