import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import {
  InMemoryIntegrationDescriptorStore,
  InMemoryIntegrationOpenApiSpecStore,
  InMemoryPortfolioElementStore,
  InMemoryUserIntegrationStore,
  type IntegrationDescriptorRecord,
  type UserIntegrationRecord,
  type UserIntegrationProvider,
} from '../../../../src/web-console/stores/index.js';
import {
  IntegrationOperationCatalog,
} from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const DESCRIPTOR_ID = '00000000-0000-4000-8000-000000000002';
const INTEGRATION_ID = '00000000-0000-4000-8000-000000000003';
const SPEC_ID = '00000000-0000-4000-8000-000000000004';
const SPEC_HASH = 'a'.repeat(64);
const GMAIL_READONLY = 'gmail.readonly';
const GMAIL_SEND = 'gmail.send';
const TIMESTAMP = '2026-06-18T00:00:00Z';

import { MCPAQLHandler, type HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { buildOperationSummary } from '../../../../src/handlers/mcp-aql/OperationSummary.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { getMCPAQLTools } from '../../../../src/server/tools/MCPAQLTools.js';
import { getIntegrationTools } from '../../../../src/server/tools/IntegrationTools.js';
import { AuthorizedIntegrationOperationCatalog, type AuthorizedIntegrationGateway } from '../../../../src/web-console/modules/integrations/AuthorizedIntegrationGateway.js';
import { IntegrationRequestPolicyEnforcer } from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';
import { getDefaultPermissionLevel, getOperationsAtLevel } from '../../../../src/handlers/mcp-aql/policies/OperationPolicies.js';
import type { ActiveElement } from '../../../../src/handlers/mcp-aql/policies/ElementPolicies.js';
import type { AgentToolConfig } from '../../../../src/elements/agents/types.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { classifyTool } from '../../../../src/handlers/mcp-aql/policies/ToolClassification.js';
import { env } from '../../../../src/config/env.js';

const LIST = 'list_integration_operations';
const DESCRIBE = 'describe_integration_operation';
const originalMode = env.MCP_AQL_ENDPOINT_MODE;
afterEach(() => { env.MCP_AQL_ENDPOINT_MODE = originalMode; jest.restoreAllMocks(); });

function setup(configured = true, options: Parameters<typeof createCatalog>[0] = { scopes: [GMAIL_READONLY] }, policy: { gatekeeper?: Gatekeeper; elements?: ActiveElement[]; tools?: AgentToolConfig; dbMode?: boolean } = {}) {
  const fixture = createCatalog(options);
  const gatekeeper = policy.gatekeeper ?? new Gatekeeper(undefined, { enableAuditLogging: false }, fixture.contextTracker);
  const policyEnforcer = new IntegrationRequestPolicyEnforcer({ gatekeeper, getActiveElements: async () => [] });
  const catalog = new AuthorizedIntegrationOperationCatalog({ catalog: fixture.catalog, policyEnforcer });
  const handlers = {
    gatekeeper,
    elementCRUD: { getActiveElementsForPolicy: async () => policy.elements ?? [], getActiveElements: async () => [] },
    agentManager: {
      resolveExecutionIdentity: async (name: string) => ({ kind: 'file', value: `${name}.md` }),
      executeAgent: async () => ({ goalId: 'goal-1' }),
      read: async () => ({ metadata: { name: 'restricted-agent', tools: policy.tools } }),
      getAgentState: async () => ({ goals: [], steps: [] }),
    },
    integrationOperationCatalog: configured ? catalog : undefined,
    isDbMode: policy.dbMode ?? true,
  } as unknown as HandlerRegistry;
  const handler = new MCPAQLHandler(handlers, fixture.contextTracker);
  const standalone = getIntegrationTools({} as AuthorizedIntegrationGateway, catalog);
  return { ...fixture, handler, standalone, gatekeeper };
}

async function invoke(fixture: ReturnType<typeof setup>, operation: string, params: Record<string, unknown> = {}) {
  const tools = getMCPAQLTools(fixture.handler);
  const tool = tools.find(candidate => candidate.tool.name === (env.MCP_AQL_ENDPOINT_MODE === 'single' ? 'mcp_aql' : `mcp_aql_${fixture.handler.operations.getRoute(operation)?.endpoint.toLowerCase() ?? 'read'}`))!;
  return JSON.parse((await tool.handler({ operation, params })).content[0].text);
}

function responseText(data: { content: Array<{ text: string }> }) {
  return JSON.parse(data.content[0].text);
}

describe.each(['crude', 'single'] as const)('Integration catalog READ operations (%s)', mode => {
  it('preserves standalone results, parameters and in-memory skill previews', async () => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    const writeSpec = jest.spyOn(fixture.specStore, 'upsert');
    for (const [operation, oldName, params] of [
      [LIST, 'list_operations', { provider: 'gmail', include_unavailable: true, include_skill: true, fields: ['missing'] }],
      [DESCRIBE, 'describe_operation', { provider: 'gmail', operation_id: 'listMessages', fields: ['missing'] }],
    ] as const) {
      await runAsUser(fixture.contextTracker, async () => {
        const expected = await fixture.standalone.find(tool => tool.tool.name === oldName)!.handler(params);
        const result = await invoke(fixture, operation, params);
        expect(result.success).toBe(true);
        expect(result.data).toEqual(expected);
      });
    }
    expect(writeSpec).not.toHaveBeenCalled();
  });

  it('agrees across dispatch, introspection, capabilities and descriptions', async () => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    for (const operation of [LIST, DESCRIBE]) {
      const details = await invoke(fixture, 'introspect', { query: 'operations', name: operation });
      expect(details.data.operation).toMatchObject({ element_name: operation, endpoint: 'READ', mcpTool: 'mcp_aql_read' });
      expect(details.data.operation.parameters.map((p: { element_name: string }) => p.element_name)).toContain('provider');
      const capabilities = await invoke(fixture, 'get_capabilities');
      expect(JSON.stringify(capabilities)).toContain(operation);
      expect(getMCPAQLTools(fixture.handler).map(tool => tool.tool.description).join()).toContain(operation);
      const wrongEndpoint = await fixture.handler.handleCreate({ operation, params: { provider: 'gmail' } });
      expect(wrongEndpoint).toMatchObject({ success: false });
    }
    for (const oldName of ['list_operations', 'describe_operation']) {
      expect(await invoke(fixture, oldName, { provider: 'gmail' })).toMatchObject({ success: false });
    }
  });

  it.each([true, false])('keeps availability per handler with configured-first=%s', async configuredFirst => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const pair = [setup(configuredFirst), setup(!configuredFirst)];
    for (const [index, fixture] of pair.entries()) {
      const configured = index === 0 ? configuredFirst : !configuredFirst;
      const spy = jest.spyOn(fixture.catalog, 'listOperations');
      const descriptions = getMCPAQLTools(fixture.handler).map(tool => tool.tool.description).join();
      expect(descriptions.includes(LIST)).toBe(configured);
      const discovery = await invoke(fixture, 'introspect', { query: 'operations' });
      expect(JSON.stringify(discovery).includes(LIST)).toBe(configured);
      const capabilities = await invoke(fixture, 'get_capabilities');
      expect(JSON.stringify(capabilities).includes(LIST)).toBe(configured);
      if (!configured) {
        expect(await invoke(fixture, LIST, { provider: 'gmail' })).toMatchObject({ success: false });
        expect(spy).not.toHaveBeenCalled();
      }
    }
  });


  it('preserves arbitrary nested result keys despite a fields parameter', async () => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    const payload = JSON.parse('{"name":"root","nested":{"name":"nested","constructor":{"name":"retained"},"prototype":42,"__proto__":{"name":"also retained"}}}');
    jest.spyOn(fixture.catalog, 'listOperations').mockResolvedValue(payload);
    const params = { provider: 'gmail', fields: ['missing'] };
    const expected = await fixture.standalone.find(tool => tool.tool.name === 'list_operations')!.handler(params);
    expect((await invoke(fixture, LIST, params)).data).toEqual(expected);
  });

  it.each(['disconnected', 'invisible'] as const)('preserves %s provider checks', async state => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup(true, {
      scopes: [GMAIL_READONLY],
      ...(state === 'disconnected' ? { integration: { ...integration([GMAIL_READONLY]), status: 'revoked' as const, revokedAt: new Date(TIMESTAMP) } }
        : { descriptor: descriptor({ ownership: 'byo', ownerUserId: '00000000-0000-4000-8000-000000000099' }) }),
    });
    await runAsUser(fixture.contextTracker, async () => {
      const params = { provider: 'gmail', include_unavailable: true };
      const expected = await fixture.standalone.find(tool => tool.tool.name === 'list_operations')!.handler(params);
      expect(responseText(expected).ok).toBe(false);
      expect((await invoke(fixture, LIST, params)).data).toEqual(expected);
    });
    expect(JSON.stringify(await invoke(fixture, 'get_capabilities'))).toContain(LIST);
  });

  it('filters scopes without granting them or writing a preview', async () => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const portfolioStore = new InMemoryPortfolioElementStore();
    const fixture = setup(true, { scopes: [GMAIL_READONLY], portfolioStore });
    const writes = jest.spyOn(portfolioStore, 'create');
    const updates = jest.spyOn(portfolioStore, 'update');
    await runAsUser(fixture.contextTracker, async () => {
      for (const includeUnavailable of [false, true]) {
        const params = { provider: 'gmail', include_unavailable: includeUnavailable, include_skill: true };
        const result = responseText((await invoke(fixture, LIST, params)).data).result;
        const unavailable = result.operations.filter((op: { available: boolean }) => !op.available);
        expect(unavailable).toHaveLength(includeUnavailable ? 1 : 0);
        expect(result.generatedSkill.content).not.toContain('sendMessage');
      }
    });
    expect(writes).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });

  it('derives default approval and safe classification from the configured operation set', () => {
    const configured = setup();
    const disabled = setup(false);
    for (const operation of [LIST, DESCRIBE]) {
      expect(getDefaultPermissionLevel(operation, configured.handler.operations)).toBe(PermissionLevel.AUTO_APPROVE);
      expect(getOperationsAtLevel(PermissionLevel.AUTO_APPROVE, configured.handler.operations)).toContain(operation);
      expect(getOperationsAtLevel(PermissionLevel.AUTO_APPROVE, disabled.handler.operations)).not.toContain(operation);
      expect(classifyTool('mcp__dollhouse__mcp_aql_read', { operation })).toMatchObject({ riskLevel: 'safe', behavior: 'allow' });
    }
  });
  it('retains configured discovery without identity and returns the catalog error', async () => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    const expected = await fixture.standalone.find(tool => tool.tool.name === 'list_operations')!.handler({ provider: 'gmail' });
    expect(responseText(expected).ok).toBe(false);
    const result = await invoke(fixture, LIST, { provider: 'gmail' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(expected);
    expect(getMCPAQLTools(fixture.handler).map(tool => tool.tool.description).join()).toContain(LIST);
  });
});
describe.each(['crude', 'single'] as const)('Integration READ policy enforcement (%s)', mode => {
  it.each([LIST, DESCRIBE])('confirms %s without leaking through a shared Gatekeeper', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const elements: ActiveElement[] = [{ type: 'persona', name: 'reviewer', metadata: { name: 'reviewer', gatekeeper: { confirm: [operation] } } }];
    const configured = setup(true, undefined, { elements, dbMode: false });
    const disabled = setup(false, undefined, { gatekeeper: configured.gatekeeper, elements, dbMode: false });
    const params = { provider: 'gmail', operation_id: 'listMessages' };
    await runAsUser(configured.contextTracker, async () => {
      // The main pipeline auto-confirms pending decisions (#1653); exercise the
      // pending Gatekeeper decision directly, then the public confirmation API.
      const pending = configured.gatekeeper.enforce({ operation, endpoint: 'READ', activeElements: elements }, configured.handler.operations);
      expect(pending).toMatchObject({ allowed: false, confirmationPending: true });
      const confirmation = await invoke(configured, 'confirm_operation', { operation });
      expect(confirmation).toMatchObject({ success: true, data: { confirmed: true } });
      const recorded = configured.gatekeeper.enforce({ operation, endpoint: 'READ', activeElements: elements }, configured.handler.operations);
      expect(recorded.allowed).toBe(true);
      expect(recorded.confirmationPending).not.toBe(true);
      expect(await invoke(configured, operation, params)).toMatchObject({ success: true });
      expect(await invoke(disabled, operation, params)).toMatchObject({ success: false, error: expect.stringContaining('Unknown operation') });
      expect(await invoke(disabled, 'confirm_operation', { operation })).toMatchObject({ success: false });
      elements[0].metadata.gatekeeper = { deny: [operation] };
      expect(await invoke(configured, operation, params)).toMatchObject({ success: false });
      expect(await invoke(configured, 'confirm_operation', { operation })).toMatchObject({ success: false });
    });
  });

  it.each([LIST, DESCRIBE])('reports %s as already approved with no confirmation policy', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    expect(await invoke(setup(true, undefined, { dbMode: false }), 'confirm_operation', { operation })).toMatchObject({ success: true, data: { confirmed: true } });
  });

  it.each([LIST, DESCRIBE])('uses the configured schema description in the %s confirmation summary', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup(true, undefined, { dbMode: false });
    const confirmation = await invoke(fixture, 'confirm_operation', { operation, provider: 'gmail' });
    expect(confirmation).toMatchObject({
      success: true,
      data: { summary: `${fixture.handler.operations.getSchema(operation)!.description} (provider)` },
    });
  });

  it('preserves base operation and unknown-operation summaries', () => {
    const { operations } = setup().handler;
    expect(buildOperationSummary('create_element', 'skill', { element_name: 'reviewer' }, operations)).toBe('Create a new skill called "reviewer"');
    expect(buildOperationSummary('query_logs', undefined, {}, operations)).toBe('Query recent log entries from the in-memory buffer. Returns filtered, paginated results sorted newest-first. Only queries the hot tier (in-memory); evicted entries exist only in disk log files.');
    expect(buildOperationSummary('unknown_operation', 'skill', { key: 'value' }, operations)).toBe('Perform operation: unknown operation (key) on skill');
  });

  it.each([{ allowed: [], denied: ['mcp_aql_read'] }, { allowed: ['mcp_aql_create'] }])('enforces agent tool restrictions %j', async tools => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup(true, undefined, { tools, dbMode: false });
    const catalogCall = jest.spyOn(fixture.catalog, 'listOperations');
    await runAsUser(fixture.contextTracker, async () => {
      expect(await invoke(fixture, 'execute_agent', { element_name: 'restricted-agent' })).toMatchObject({ success: true });
      for (const operation of [LIST, DESCRIBE, 'list_elements']) {
        expect(await invoke(fixture, operation, { provider: 'gmail', operation_id: 'listMessages', element_type: 'persona' })).toMatchObject({ success: false, error: expect.stringContaining('deny policy') });
      }
    });
    expect(catalogCall).not.toHaveBeenCalled();
  });
});

describe('Integration READ batches', () => {
  it.each([true, false])('uses configured availability in CRUDE batches: %s', async configured => {
    env.MCP_AQL_ENDPOINT_MODE = 'crude';
    const fixture = setup(configured);
    const list = jest.spyOn(fixture.catalog, 'listOperations');
    const describeOperation = jest.spyOn(fixture.catalog, 'describeOperation');
    const tool = getMCPAQLTools(fixture.handler).find(candidate => candidate.tool.name === 'mcp_aql_read')!;
    const input = { operations: [
      { operation: LIST, params: { provider: 'gmail' } },
      { operation: DESCRIBE, params: { provider: 'gmail', operation_id: 'listMessages' } },
    ] };
    const response = await runAsUser(fixture.contextTracker, () => tool.handler(input));
    const batch = responseText(response);
    expect(batch.summary).toEqual({ total: 2, succeeded: configured ? 2 : 0, failed: configured ? 0 : 2 });
    if (configured) {
      expect(list).toHaveBeenCalledTimes(1);
      expect(describeOperation).toHaveBeenCalledTimes(1);
    } else {
      expect(list).not.toHaveBeenCalled();
      expect(describeOperation).not.toHaveBeenCalled();
      for (const item of batch.results) expect(item.result.error).toContain('Unknown operation');
    }
  });

  it('preserves single-endpoint rejection of batches', async () => {
    env.MCP_AQL_ENDPOINT_MODE = 'single';
    const fixture = setup();
    const list = jest.spyOn(fixture.catalog, 'listOperations');
    const tool = getMCPAQLTools(fixture.handler)[0];
    const response = await tool.handler({ operations: [{ operation: LIST, params: { provider: 'gmail' } }] });
    expect(responseText(response)).toMatchObject({ success: false, error: expect.stringContaining('Invalid input') });
    expect(list).not.toHaveBeenCalled();
  });
});

function createCatalog(options: {
  readonly scopes: readonly string[];
  readonly descriptor?: IntegrationDescriptorRecord;
  readonly portfolioStore?: InMemoryPortfolioElementStore;
  readonly spec?: Readonly<Record<string, unknown>>;
  readonly integration?: UserIntegrationRecord;
}) {
  const contextTracker = new ContextTracker();
  const descriptorStore = new InMemoryIntegrationDescriptorStore([options.descriptor ?? descriptor()]);
  const specStore = new InMemoryIntegrationOpenApiSpecStore([{
    id: SPEC_ID,
    descriptorId: DESCRIPTOR_ID,
    spec: options.spec ?? openApiSpec(),
    sourceUrl: 'https://gmail.googleapis.com/openapi.json',
    specHash: SPEC_HASH,
    createdAt: new Date(TIMESTAMP),
    updatedAt: new Date(TIMESTAMP),
  }]);
  const integrationStore = new InMemoryUserIntegrationStore([options.integration ?? integration(options.scopes)]);
  return {
    contextTracker,
    catalog: new IntegrationOperationCatalog({
      descriptorStore,
      specStore,
      integrationStore,
      contextTracker,
      portfolioStore: options.portfolioStore ?? new InMemoryPortfolioElementStore(),
      now: () => new Date(TIMESTAMP),
    }),
    specStore,
    portfolioStore: options.portfolioStore,
  };
}

function descriptor(overrides: Partial<IntegrationDescriptorRecord> = {}): IntegrationDescriptorRecord {
  return {
    id: DESCRIPTOR_ID,
    provider: 'gmail' as UserIntegrationProvider,
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Gmail',
    category: 'email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: [GMAIL_READONLY, GMAIL_SEND],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: {},
      accountLabel: {},
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'v1',
    operationPromotion: {},
    createdAt: new Date(TIMESTAMP),
    updatedAt: new Date(TIMESTAMP),
    ...overrides,
  };
}

function integration(scopes: readonly string[]): UserIntegrationRecord {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider: 'gmail' as UserIntegrationProvider,
    integrationDescriptorId: DESCRIPTOR_ID,
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    credentialKeyVersion: 'v1',
    status: 'connected',
    errorReason: null,
    cleanupAttemptCount: 0,
    cleanupNextAttemptAt: null,
    cleanupLeaseId: null,
    cleanupLeaseExpiresAt: null,
    connectedAt: new Date(TIMESTAMP),
    lastSyncAt: null,
    revokedAt: null,
  };
}

function openApiSpec(): Readonly<Record<string, unknown>> {
  return {
    openapi: '3.1.0',
    info: { title: 'Gmail fixture', version: '1.0.0' },
    security: [{ oauth: [GMAIL_READONLY] }],
    paths: {
      '/gmail/v1/users/{userId}/messages': {
        parameters: [{
          name: 'userId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }],
        get: {
          operationId: 'listMessages',
          summary: 'List messages',
          security: [
            { oauth: [GMAIL_READONLY] },
            { oauth: ['gmail.metadata'] },
          ],
          responses: {
            200: {
              description: 'Message list',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
        post: {
          operationId: 'sendMessage',
          summary: 'Send a message',
          security: [{ oauth: [GMAIL_SEND] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: {
              description: 'Sent message',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/gmail/v1/users/me/profile': {
        get: {
          operationId: 'getProfile',
          summary: 'Get profile',
          security: [],
          responses: { 200: { description: 'Profile' } },
        },
      },
    },
  };
}

function runAsUser<T>(contextTracker: ContextTracker, fn: () => Promise<T>): Promise<T> {
  return contextTracker.runAsync({
    type: 'test',
    requestId: 'req-1',
    timestamp: Date.now(),
    session: {
      userId: USER_ID,
      sessionId: 'session-1',
      tenantId: null,
      transport: 'http',
      createdAt: Date.now(),
      roles: [],
    },
  }, fn);
}
