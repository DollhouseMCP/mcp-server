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
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';
import { env } from '../../../../src/config/env.js';

const LIST = 'list_integration_operations';
const DESCRIBE = 'describe_integration_operation';
const originalMode = env.MCP_AQL_ENDPOINT_MODE;
afterEach(() => { env.MCP_AQL_ENDPOINT_MODE = originalMode; jest.restoreAllMocks(); });

function setup(configured = true, options: Parameters<typeof createCatalog>[0] = { scopes: [GMAIL_READONLY] }, policy: { gatekeeper?: Gatekeeper; elements?: ActiveElement[]; tools?: AgentToolConfig; dbMode?: boolean } = {}) {
  const fixture = createCatalog(options);
  const gatekeeper = policy.gatekeeper ?? new Gatekeeper(undefined, { enableAuditLogging: false }, fixture.contextTracker, 'management-test', new StaticAuditHmacKeyResolver('66'.repeat(32)));
  const policyEnforcer = new IntegrationRequestPolicyEnforcer({ gatekeeper, getActiveElements: async () => policy.elements ?? [] });
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

const MANAGEMENT = ['create_integration_spec', 'update_integration_spec', 'create_integration_skill', 'update_integration_skill'] as const;

describe.each(['crude', 'single'] as const)('strict integration management routing (%s)', mode => {
  it.each(MANAGEMENT)('advertises %s only when configured and rejects wrong endpoints', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    const endpoint = operation.startsWith('create') ? 'CREATE' : 'UPDATE';
    expect(fixture.handler.operations.getRoute(operation)?.endpoint).toBe(endpoint);
    expect(fixture.handler.operations.getSchema(operation)?.params.provider?.required).toBe(true);
    expect(setup(false).handler.operations.getRoute(operation)).toBeUndefined();
    expect(await fixture.handler.handleRead({ operation, params: { provider: 'gmail' } })).toMatchObject({ success: false, error: expect.stringContaining(endpoint) });
    expect(getDefaultPermissionLevel(operation, fixture.handler.operations)).toBe(PermissionLevel.AUTO_APPROVE);
  });

  it.each(MANAGEMENT)('blocks whole batches containing %s before dispatch', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    const list = jest.spyOn(fixture.catalog, 'listOperations');
    const result = await fixture.handler.handleRead({ operations: [
      { operation: LIST, params: { provider: 'gmail' } }, { operation, params: { provider: 'gmail' } },
    ] });
    expect(result).toMatchObject({ success: false });
    expect(list).not.toHaveBeenCalled();
  });

  it.each(['create_integration_skill', 'update_integration_skill'])('preflights normalized mixed-format %s before any dispatch', async operation => {
    const fixture = setup();
    const list = jest.spyOn(fixture.catalog, 'listOperations');
    const create = jest.spyOn(fixture.catalog, 'createSkill');
    const update = jest.spyOn(fixture.catalog, 'updateSkill');
    const approval = jest.spyOn(fixture.gatekeeper, 'checkCliApprovalForInput');
    const dispatch = jest.spyOn(fixture.handler as unknown as { executeOperation: (...args: unknown[]) => Promise<unknown> }, 'executeOperation');
    const batch = { operations: [
      { operation: LIST, params: { provider: 'gmail' } },
      { operation: 'create_element', element_type: 'invalid', tool: operation,
        args: { provider: 'gmail', skill_name: 'batch-target' } },
    ] };
    const result = operation.startsWith('create')
      ? await fixture.handler.handleCreate(batch) : await fixture.handler.handleUpdate(batch);
    expect(result).toMatchObject({ success: false, results: [], error: expect.stringContaining('individual') });
    for (const call of [dispatch, list, create, update, approval]) expect(call).not.toHaveBeenCalled();
  });

  it.each(MANAGEMENT)('treats unconfigured batch operation %s as unknown', async operation => {
    const fixture = setup(false, undefined, { dbMode: false });
    const result = await fixture.handler.handleRead({ operations: [{ operation, params: { provider: 'gmail' } }] });
    expect(result).toMatchObject({ results: [{ result: { success: false, error: expect.stringContaining('Unknown operation') } }] });
    expect(JSON.stringify(result)).not.toContain('individual');
  });

  it.each(['create_integration_spec', 'update_integration_spec'])('rejects regenerate_skill on %s before catalog writes', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    const before = await fixture.specStore.findByDescriptorId(DESCRIPTOR_ID);
    const result = await invoke(fixture, operation, { provider: 'gmail', spec: openApiSpec(), regenerate_skill: false });
    expect(JSON.stringify(result)).toContain('integration_skill');
    expect(JSON.stringify(result)).toContain('separate');
    expect(await fixture.specStore.findByDescriptorId(DESCRIPTOR_ID)).toEqual(before);
  });

  it.each(MANAGEMENT)('rejects boundary-changing flags for %s without writes', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup();
    const create = jest.spyOn(fixture.specStore, 'create');
    const update = jest.spyOn(fixture.specStore, 'update');
    const createSkill = jest.spyOn(fixture.catalog, 'createSkill');
    const updateSkill = jest.spyOn(fixture.catalog, 'updateSkill');
    for (const key of ['force', 'upsert', 'overwrite']) {
      const result = await invoke(fixture, operation, { provider: 'gmail', [key]: true, ...(operation.endsWith('spec') ? { spec: openApiSpec() } : {}) });
      expect(responseText(result.data)).toMatchObject({ ok: false, error: { message: expect.stringContaining(operation) } });
    }
    for (const write of [create, update, createSkill, updateSkill]) expect(write).not.toHaveBeenCalled();
  });

  it.each(MANAGEMENT)('preserves payload keys and rejects unconfigured calls for %s', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const method = { create_integration_spec: 'createSpec', update_integration_spec: 'updateSpec', create_integration_skill: 'createSkill', update_integration_skill: 'updateSkill' }[operation] as 'createSpec';
    const payload = JSON.parse('{"name":"root","nested":{"constructor":{"name":"retained"},"prototype":42,"__proto__":{"name":"retained"}}}');
    for (const configured of [true, false]) {
      const fixture = setup(configured);
      const call = jest.spyOn(fixture.catalog, method).mockResolvedValue(payload);
      const params = { provider: 'gmail', ...(operation.endsWith('spec') ? { spec: openApiSpec() } : {}), fields: ['missing'] };
      let result = await invoke(fixture, operation, params);
      if (configured) {
        const pending = responseText(result.data);
        await fixture.gatekeeper.approveCliRequest(pending.approvalRequest.requestId, 'single');
        result = await invoke(fixture, operation, params);
      }
      if (configured) expect(responseText(result.data).result).toEqual(payload);
      else {
        expect(result).toMatchObject({ success: false, error: expect.stringContaining('Unknown operation') });
        expect(call).not.toHaveBeenCalled();
        expect(JSON.stringify(await invoke(fixture, 'get_capabilities'))).not.toContain(operation);
        expect(JSON.stringify(await invoke(fixture, 'introspect', { query: 'operations' }))).not.toContain(operation);
        expect(getMCPAQLTools(fixture.handler).map(tool => tool.tool.description).join()).not.toContain(operation);
      }
    }
  });

  it.each(MANAGEMENT)('enforces identity, visibility and connection before writing %s', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    for (const state of ['unauthenticated', 'disconnected', 'invisible', 'non-owner'] as const) {
      if (state === 'non-owner' && operation.endsWith('skill')) continue;
      const portfolioStore = new InMemoryPortfolioElementStore();
      const fixture = setup(true, { scopes: [GMAIL_READONLY], portfolioStore,
        descriptor: descriptor(state === 'non-owner' ? {} : { ownership: 'byo', ownerUserId: state === 'invisible' ? '00000000-0000-4000-8000-000000000099' : USER_ID }),
        ...(state === 'disconnected' ? { integration: { ...integration([GMAIL_READONLY]), status: 'revoked', revokedAt: new Date(TIMESTAMP) } } : {}),
      });
      const before = await fixture.specStore.findByDescriptorId(DESCRIPTOR_ID);
      const call = () => invoke(fixture, operation, { provider: 'gmail', ...(operation.endsWith('spec') ? { spec: openApiSpec() } : {}) });
      const result = state === 'unauthenticated' ? await call() : await runAsUser(fixture.contextTracker, call);
      expect(responseText(result.data)).toMatchObject({ ok: false });
      expect(await fixture.specStore.findByDescriptorId(DESCRIPTOR_ID)).toEqual(before);
      expect(await portfolioStore.listByUser(USER_ID)).toEqual([]);
    }
  });

  it.each(MANAGEMENT.flatMap(operation => [false, true].map(confirm => ({ operation, confirm }))))('uses one management approval for $operation (element confirm: $confirm)', async ({ operation, confirm }) => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const elements: ActiveElement[] = confirm ? [{ type: 'persona', name: 'guard', metadata: { name: 'guard', gatekeeper: {
      confirm: [operation], externalRestrictions: { description: 'Allow target', allowPatterns: ['integration_request:*'] },
    } } }] : [];
    const fixture = setup(true, { scopes: [GMAIL_READONLY], descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }) }, { elements, dbMode: false });
    const request = jest.spyOn(fixture.gatekeeper, 'createCliApprovalRequest');
    const generic = jest.spyOn(fixture.gatekeeper, 'recordConfirmation');
    const params = { provider: 'gmail', ...(operation.endsWith('spec') ? { spec: openApiSpec() } : { skill_name: 'review-target' }) };
    await runAsUser(fixture.contextTracker, async () => {
      if (operation === 'create_integration_spec') await fixture.specStore.deleteByDescriptorId(DESCRIPTOR_ID);
      if (operation === 'update_integration_skill') await fixture.catalog.createSkill({ provider: 'gmail', skillName: 'review-target' });
      if (operation === 'update_integration_skill') await fixture.specStore.upsert({
        descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash: 'b'.repeat(64),
        createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP),
      });
      const method = { create_integration_spec: 'createSpec', update_integration_spec: 'updateSpec', create_integration_skill: 'createSkill', update_integration_skill: 'updateSkill' }[operation] as 'createSpec';
      const write = jest.spyOn(fixture.catalog, method);
      const pending = responseText((await invoke(fixture, operation, params)).data);
      expect(pending).toMatchObject({ ok: false, approvalRequest: { requestId: expect.any(String) } });
      expect(request).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      const targets = {
        create_integration_spec: '_internal:/integration/openapi_spec/create',
        update_integration_spec: '_internal:/integration/openapi_spec/update',
        create_integration_skill: '_internal:/integration/generated_skill/create',
        update_integration_skill: '_internal:/integration/generated_skill/update',
      };
      expect(request.mock.calls[0][0].toolInput).toMatchObject({ path: targets[operation],
        body: { provider: 'gmail', ...(operation.endsWith('skill') ? { skillName: 'review-target' } : {}) },
      });
      expect(generic).not.toHaveBeenCalled();
      await fixture.gatekeeper.approveCliRequest(pending.approvalRequest.requestId,
        operation.startsWith('create') ? 'input_session' : 'single');
      expect(responseText((await invoke(fixture, operation, params)).data).ok).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      const repeated = responseText((await invoke(fixture, operation, params)).data);
      if (operation.startsWith('create')) {
        expect(repeated).toMatchObject({ ok: false, error: { code: expect.stringContaining('exists') } });
        expect(request).toHaveBeenCalledTimes(1);
      } else {
        expect(repeated).toMatchObject({ ok: false, approvalRequest: { requestId: expect.any(String) } });
        expect(write).toHaveBeenCalledTimes(1);
      }
      elements.push({ type: 'persona', name: 'deny-guard', metadata: { name: 'deny-guard', gatekeeper: { deny: [operation] } } });
      expect(await invoke(fixture, operation, params)).toMatchObject({ success: false, error: expect.stringContaining('deny policy') });
    });
  });

  it.each(MANAGEMENT)('never treats element allow or generic confirmation as management approval for %s', async operation => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const elements: ActiveElement[] = [{ type: 'persona', name: 'guard', metadata: { name: 'guard', gatekeeper: {
      allow: [operation],
    } } }];
    const fixture = setup(true, undefined, { elements, dbMode: false });
    await runAsUser(fixture.contextTracker, async () => {
      fixture.gatekeeper.recordConfirmation(operation, PermissionLevel.CONFIRM_SESSION);
      const result = await invoke(fixture, operation, { provider: 'gmail', ...(operation.endsWith('spec') ? { spec: openApiSpec() } : {}) });
      expect(responseText(result.data)).toMatchObject({ ok: false, approvalRequest: { requestId: expect.any(String) } });
    });
  });

  it.each(['mcp_aql_create', 'mcp_aql_update'])('enforces executing agent restriction %s', async denied => {
    env.MCP_AQL_ENDPOINT_MODE = mode;
    const fixture = setup(true, undefined, { tools: { allowed: [], denied: [denied] }, dbMode: false });
    await runAsUser(fixture.contextTracker, async () => {
      expect(await invoke(fixture, 'execute_agent', { element_name: 'restricted-agent' })).toMatchObject({ success: true });
      for (const operation of MANAGEMENT.filter(name => name.startsWith(denied.slice('mcp_aql_'.length)))) {
        expect(await invoke(fixture, operation, { provider: 'gmail', spec: openApiSpec() })).toMatchObject({ success: false, error: expect.stringContaining('deny policy') });
      }
    });
  });

  it('removes both legacy management tools only in MCP-AQL registration', () => {
    const fixture = setup();
    const tools = getIntegrationTools({} as AuthorizedIntegrationGateway, new AuthorizedIntegrationOperationCatalog({
      catalog: fixture.catalog, policyEnforcer: new IntegrationRequestPolicyEnforcer({ gatekeeper: fixture.gatekeeper, getActiveElements: async () => [] }),
    }), false);
    expect(tools.map(entry => entry.tool.name)).toEqual(['integration_request']);
    expect(fixture.standalone.map(entry => entry.tool.name)).toEqual(expect.arrayContaining(['ingest_openapi_spec', 'regenerate_integration_skill']));
  });
});

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
