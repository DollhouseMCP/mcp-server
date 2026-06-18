import { describe, expect, it, jest } from '@jest/globals';

import { getIntegrationTools } from '../../../../src/server/tools/IntegrationTools.js';
import type { IntegrationRequestGateway } from '../../../../src/web-console/modules/integrations/IntegrationRequestGateway.js';
import {
  IntegrationPolicyUnavailableError,
  type IntegrationRequestPolicyEnforcer,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';
import {
  IntegrationOperationCatalogError,
  type IntegrationOperationCatalog,
} from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';

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

    const tool = getIntegrationTools(gateway, policy).find(candidate => candidate.tool.name === 'integration_request');
    if (!tool) throw new Error('integration_request tool missing');
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

    const tool = getIntegrationTools(gateway, policy).find(candidate => candidate.tool.name === 'integration_request');
    if (!tool) throw new Error('integration_request tool missing');
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

    const tool = getIntegrationTools(gateway, policy).find(candidate => candidate.tool.name === 'integration_request');
    if (!tool) throw new Error('integration_request tool missing');
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

  it('registers OpenAPI-derived operation discovery tools when a catalog is available', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const catalog = {
      listOperations: jest.fn<IntegrationOperationCatalog['listOperations']>().mockResolvedValue({
        provider: 'gmail',
        descriptorId: '00000000-0000-4000-8000-000000000001',
        specHash: 'a'.repeat(64),
        scopeAvailability: {
          enforcement: 'advisory_upstream_oauth_token',
          note: 'advisory',
        },
        operations: [{ operationId: 'getProfile', method: 'GET', path: '/profile', available: true }],
      }),
      describeOperation: jest.fn<IntegrationOperationCatalog['describeOperation']>(),
    } as unknown as IntegrationOperationCatalog;

    const tools = getIntegrationTools(gateway, null, catalog);
    expect(tools.map(entry => entry.tool.name)).toEqual([
      'integration_request',
      'ingest_openapi_spec',
      'regenerate_integration_skill',
      'list_operations',
      'describe_operation',
    ]);

    const listTool = tools.find(candidate => candidate.tool.name === 'list_operations');
    if (!listTool) throw new Error('list_operations tool missing');
    const result = await listTool.handler({
      provider: 'gmail',
      include_unavailable: true,
      include_skill: true,
    });

    expect(catalog.listOperations).toHaveBeenCalledWith({
      provider: 'gmail',
      includeUnavailable: true,
      includeSkill: true,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      result: {
        provider: 'gmail',
        operations: [{ operationId: 'getProfile' }],
      },
    });
  });

  it('runs integration write policy before OpenAPI ingestion', async () => {
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
          requestId: 'cli-00000000-0000-4000-8000-000000000002',
          toolName: 'integration_request',
          riskLevel: 'dangerous',
          riskScore: 80,
          irreversible: false,
          reason: 'Requires approval.',
        },
      }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>(),
      regenerateSkill: jest.fn<IntegrationOperationCatalog['regenerateSkill']>(),
      listOperations: jest.fn<IntegrationOperationCatalog['listOperations']>(),
      describeOperation: jest.fn<IntegrationOperationCatalog['describeOperation']>(),
    } as unknown as IntegrationOperationCatalog;

    const ingestTool = getIntegrationTools(gateway, policy, catalog)
      .find(candidate => candidate.tool.name === 'ingest_openapi_spec');
    if (!ingestTool) throw new Error('ingest_openapi_spec tool missing');

    const result = await ingestTool.handler({
      provider: 'gmail',
      spec: { openapi: '3.1.0', paths: { '/profile': { get: { responses: { 200: { description: 'ok' } } } } } },
    });

    expect(policy.authorize).toHaveBeenCalledWith({
      provider: 'gmail',
      method: 'PUT',
      path: '/_integration/openapi_spec',
      body: { openapi: '3.1.0', paths: { '/profile': { get: { responses: { 200: { description: 'ok' } } } } } },
    });
    expect(catalog.ingestOpenApiSpec).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: { code: 'integration_request_approval_required' },
    });
  });

  it('calls OpenAPI ingestion through the operation catalog', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>().mockResolvedValue({
        provider: 'gmail',
        descriptorId: '00000000-0000-4000-8000-000000000001',
        specHash: 'b'.repeat(64),
        operationCount: 1,
      }),
      regenerateSkill: jest.fn<IntegrationOperationCatalog['regenerateSkill']>(),
      listOperations: jest.fn<IntegrationOperationCatalog['listOperations']>(),
      describeOperation: jest.fn<IntegrationOperationCatalog['describeOperation']>(),
    } as unknown as IntegrationOperationCatalog;

    const policy = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({ allowed: true }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const ingestTool = getIntegrationTools(gateway, policy, catalog)
      .find(candidate => candidate.tool.name === 'ingest_openapi_spec');
    if (!ingestTool) throw new Error('ingest_openapi_spec tool missing');

    const result = await ingestTool.handler({
      provider: 'gmail',
      spec: { openapi: '3.1.0', paths: { '/profile': { get: { responses: { 200: { description: 'ok' } } } } } },
      source_url: 'https://gmail.googleapis.com/openapi.json',
      regenerate_skill: true,
    });

    expect(catalog.ingestOpenApiSpec).toHaveBeenCalledWith({
      provider: 'gmail',
      spec: { openapi: '3.1.0', paths: { '/profile': { get: { responses: { 200: { description: 'ok' } } } } } },
      sourceUrl: 'https://gmail.googleapis.com/openapi.json',
      regenerateSkill: true,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      result: {
        provider: 'gmail',
        operationCount: 1,
      },
    });
  });

  it('fails closed for integration management writes when policy enforcer is unavailable', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>(),
      regenerateSkill: jest.fn<IntegrationOperationCatalog['regenerateSkill']>(),
      listOperations: jest.fn<IntegrationOperationCatalog['listOperations']>(),
      describeOperation: jest.fn<IntegrationOperationCatalog['describeOperation']>(),
    } as unknown as IntegrationOperationCatalog;

    const ingestTool = getIntegrationTools(gateway, null, catalog)
      .find(candidate => candidate.tool.name === 'ingest_openapi_spec');
    if (!ingestTool) throw new Error('ingest_openapi_spec tool missing');

    const result = await ingestTool.handler({
      provider: 'gmail',
      spec: { openapi: '3.1.0', paths: { '/profile': { get: { responses: { 200: { description: 'ok' } } } } } },
    });

    expect(catalog.ingestOpenApiSpec).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: {
        code: 'integration_management_policy_unavailable',
        status: 503,
      },
    });
  });

  it('calls generated skill regeneration through the operation catalog', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const catalog = {
      ingestOpenApiSpec: jest.fn<IntegrationOperationCatalog['ingestOpenApiSpec']>(),
      regenerateSkill: jest.fn<IntegrationOperationCatalog['regenerateSkill']>().mockResolvedValue({
        name: 'using-gmail-integration',
        content: '# Using Gmail',
        byteLength: 13,
        truncated: false,
        regeneration: {
          source: 'openapi_spec',
          specHash: 'c'.repeat(64),
          scopeFingerprint: 'gmail.readonly',
          policy: 'regenerate_on_spec_hash_or_granted_scope_change_preserve_user_edits_by_creating_new_revision',
        },
        written: true,
        portfolioAction: 'updated',
        portfolioName: 'using-gmail-integration',
      }),
      listOperations: jest.fn<IntegrationOperationCatalog['listOperations']>(),
      describeOperation: jest.fn<IntegrationOperationCatalog['describeOperation']>(),
    } as unknown as IntegrationOperationCatalog;

    const policy = {
      authorize: jest.fn<IntegrationRequestPolicyEnforcer['authorize']>().mockResolvedValue({ allowed: true }),
    } as unknown as IntegrationRequestPolicyEnforcer;
    const tool = getIntegrationTools(gateway, policy, catalog)
      .find(candidate => candidate.tool.name === 'regenerate_integration_skill');
    if (!tool) throw new Error('regenerate_integration_skill tool missing');

    const result = await tool.handler({ provider: 'gmail' });

    expect(catalog.regenerateSkill).toHaveBeenCalledWith({ provider: 'gmail' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      result: {
        portfolioAction: 'updated',
        portfolioName: 'using-gmail-integration',
      },
    });
  });

  it('returns structured operation catalog errors', async () => {
    const gateway = {
      request: jest.fn<IntegrationRequestGateway['request']>(),
    } as unknown as IntegrationRequestGateway;
    const catalog = {
      listOperations: jest.fn<IntegrationOperationCatalog['listOperations']>(),
      describeOperation: jest.fn<IntegrationOperationCatalog['describeOperation']>()
        .mockRejectedValue(new IntegrationOperationCatalogError(
          'integration_operation_not_found',
          'Integration operation was not found in the stored OpenAPI spec.',
          404,
        )),
    } as unknown as IntegrationOperationCatalog;

    const describeTool = getIntegrationTools(gateway, null, catalog)
      .find(candidate => candidate.tool.name === 'describe_operation');
    if (!describeTool) throw new Error('describe_operation tool missing');

    const result = await describeTool.handler({
      provider: 'gmail',
      operation_id: 'missing',
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: {
        code: 'integration_operation_not_found',
        status: 404,
      },
    });
  });
});
