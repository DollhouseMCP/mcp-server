import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { OperationRegistry } from '../../../../src/handlers/mcp-aql/OperationRegistry.js';
import { AuthorizedIntegrationGateway, AuthorizedIntegrationOperationCatalog } from '../../../../src/web-console/modules/integrations/AuthorizedIntegrationGateway.js';
import type { IntegrationRequestGateway } from '../../../../src/web-console/modules/integrations/IntegrationRequestGateway.js';
import type { IntegrationOperationCatalog } from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import type { ActiveElement } from '../../../../src/handlers/mcp-aql/policies/index.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';
import {
  IntegrationPolicyUnavailableError,
  IntegrationRequestPolicyEnforcer,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';

const SEND_PATH = '/gmail/v1/users/me/messages/send';
const REMOTE_DOCS = 'remote-docs';
afterEach(() => jest.restoreAllMocks());

function approvalRequestId(decision: { readonly approvalRequest?: { readonly requestId: string } }): string {
  if (!decision.approvalRequest) throw new Error('expected an approval request');
  return decision.approvalRequest.requestId;
}

describe('IntegrationRequestPolicyEnforcer', () => {
  it('requires approval for integration write policies and scopes single approval to exact input', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-test',
      new StaticAuditHmacKeyResolver('66'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([integrationWriteGuard()]),
    });

    const first = await enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      body: { raw: 'abc' },
    });

    expect(first).toMatchObject({
      allowed: false,
      error: { code: 'integration_request_approval_required' },
      approvalRequest: {
        toolName: 'integration_request',
        riskLevel: 'dangerous',
      },
    });

    await gatekeeper.approveCliRequest(approvalRequestId(first), 'single');

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: '/gmail/v1/users/me/messages/other',
      body: { raw: 'abc' },
    })).resolves.toMatchObject({
      allowed: false,
      error: { code: 'integration_request_approval_required' },
    });

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      body: { raw: 'abc' },
    })).resolves.toMatchObject({
      allowed: true,
      approvalContext: {
        requestId: approvalRequestId(first),
        scope: 'single',
      },
    });
  });

  it('does not accept tool_session approval for integration writes', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-write-session-test',
      new StaticAuditHmacKeyResolver('88'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([integrationWriteGuard()]),
    });

    const first = await enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      body: { raw: 'abc' },
    });
    await expect(gatekeeper.approveCliRequest(approvalRequestId(first), 'tool_session'))
      .rejects.toThrow('does not permit scope "tool_session"');
    await gatekeeper.approveCliRequest(approvalRequestId(first), 'single');

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      body: { raw: 'abc' },
    })).resolves.toMatchObject({
      allowed: true,
      approvalContext: { scope: 'single' },
    });
  });

  it('allows standing read approvals with tool_session scope', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-read-test',
      new StaticAuditHmacKeyResolver('77'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([integrationReadGuard()]),
    });

    const first = await enforcer.authorize({
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
    });
    expect(first).toMatchObject({
      allowed: false,
      error: { code: 'integration_request_approval_required' },
      approvalRequest: { riskLevel: 'safe' },
    });

    await gatekeeper.approveCliRequest(approvalRequestId(first), 'tool_session');

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
    })).resolves.toMatchObject({
      allowed: true,
      approvalContext: { scope: 'tool_session' },
    });
  });

  it('evaluates newly active deny policies before accepting an existing approval', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-deny-test',
      new StaticAuditHmacKeyResolver('99'.repeat(32)),
    );
    let activeElements: ActiveElement[] = [integrationReadGuard()];
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve(activeElements),
    });
    const request = {
      provider: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
    };
    const first = await enforcer.authorize(request);
    await gatekeeper.approveCliRequest(approvalRequestId(first), 'tool_session');

    activeElements = [integrationDenyGuard()];

    await expect(enforcer.authorize(request)).resolves.toMatchObject({
      allowed: false,
      error: { code: 'integration_request_denied_by_policy' },
    });
  });

  it('rejects paths longer than the complete policy matching boundary', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-path-length-test',
      new StaticAuditHmacKeyResolver('aa'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([]),
    });

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'GET',
      path: `/${'a'.repeat(995)}/admin`,
    })).resolves.toMatchObject({
      allowed: false,
      error: {
        code: 'integration_request_path_too_long',
        status: 414,
      },
    });
  });

  it.each(['/safe/../admin', '/safe/%2e%2e/admin', '/%61dmin', '/\u0430dmin'])(
    'matches deny policies against canonical outbound path for %s',
    async path => {
      const gatekeeper = new Gatekeeper(
        undefined,
        undefined,
        undefined,
        'integration-policy-canonical-path-test',
        new StaticAuditHmacKeyResolver('bb'.repeat(32)),
      );
      const enforcer = new IntegrationRequestPolicyEnforcer({
        gatekeeper,
        getActiveElements: () => Promise.resolve([integrationAdminDenyGuard()]),
      });

      await expect(enforcer.authorize({
        provider: 'gmail',
        method: 'DELETE',
        path,
      })).resolves.toMatchObject({
        allowed: false,
        error: { code: 'integration_request_denied_by_policy' },
      });
    },
  );

  it.each(['/safe%2F..%2Fadmin', '/%2561dmin', '/%00admin', '/admin%'])(
    'rejects ambiguous encoded policy path %s',
    async path => {
      const enforcer = new IntegrationRequestPolicyEnforcer({
        gatekeeper: new Gatekeeper(),
        getActiveElements: () => Promise.resolve([]),
      });

      await expect(enforcer.authorize({
        provider: 'gmail',
        method: 'GET',
        path,
      })).resolves.toMatchObject({
        allowed: false,
        error: { code: 'invalid_integration_path' },
      });
    },
  );

  it('keeps embedded query strings in the exact-input approval hash', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-query-approval-test',
      new StaticAuditHmacKeyResolver('cc'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([integrationWriteGuard()]),
    });
    const first = await enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: `${SEND_PATH}?mode=draft`,
      body: { raw: 'abc' },
    });
    await gatekeeper.approveCliRequest(approvalRequestId(first), 'single');

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: `${SEND_PATH}?mode=send`,
      body: { raw: 'abc' },
    })).resolves.toMatchObject({
      allowed: false,
      error: { code: 'integration_request_approval_required' },
    });
    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: `${SEND_PATH}?mode=draft`,
      body: { raw: 'abc' },
    })).resolves.toMatchObject({ allowed: true });
  });

  it('evaluateDiscovery allows unrestricted providers without creating approval requests', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-allow-test',
      new StaticAuditHmacKeyResolver('dd'.repeat(32)),
    );
    const createSpy = jest.spyOn(gatekeeper, 'createCliApprovalRequest');
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([]),
    });

    await expect(enforcer.evaluateDiscovery(REMOTE_DOCS)).resolves.toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('evaluateDiscovery fails closed on confirm policies without creating approval requests', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-confirm-test',
      new StaticAuditHmacKeyResolver('ee'.repeat(32)),
    );
    const createSpy = jest.spyOn(gatekeeper, 'createCliApprovalRequest');
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      // integrationReadGuard confirms every integration read; discovery is a
      // session-start read with nobody present to confirm, so it must skip.
      getActiveElements: () => Promise.resolve([integrationReadGuard()]),
    });

    await expect(enforcer.evaluateDiscovery(REMOTE_DOCS)).resolves.toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('evaluateDiscovery honors standing tool_session read approvals', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-standing-test',
      new StaticAuditHmacKeyResolver('ff'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([integrationReadGuard()]),
    });

    const first = await enforcer.authorize({
      provider: REMOTE_DOCS,
      method: 'GET',
      path: '/anything',
    });
    await gatekeeper.approveCliRequest(approvalRequestId(first), 'tool_session');

    await expect(enforcer.evaluateDiscovery(REMOTE_DOCS)).resolves.toBe(true);
  });

  it('evaluateDiscovery checks newly active deny policies before standing approvals', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-deny-test',
      new StaticAuditHmacKeyResolver('11'.repeat(32)),
    );
    let activeElements: ActiveElement[] = [integrationReadGuard()];
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve(activeElements),
    });

    const first = await enforcer.authorize({
      provider: REMOTE_DOCS,
      method: 'GET',
      path: '/anything',
    });
    await gatekeeper.approveCliRequest(approvalRequestId(first), 'tool_session');
    activeElements = [integrationDenyGuard()];

    await expect(enforcer.evaluateDiscovery(REMOTE_DOCS)).resolves.toBe(false);
  });

  it('evaluateDiscovery fails closed when policy evaluation is unavailable', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-unavailable-test',
      new StaticAuditHmacKeyResolver('22'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.reject(new Error('element resolution failed')),
    });

    await expect(enforcer.evaluateDiscovery(REMOTE_DOCS)).resolves.toBe(false);
  });

  it('normalizes active-element loading failures to policy unavailability', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-elements-unavailable-test',
      new StaticAuditHmacKeyResolver('33'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.reject(new Error('element resolution failed')),
    });

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'GET',
      path: '/anything',
    })).rejects.toBeInstanceOf(IntegrationPolicyUnavailableError);
  });

  it('normalizes approval-request persistence failures to policy unavailability', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-approval-unavailable-test',
      new StaticAuditHmacKeyResolver('44'.repeat(32)),
    );
    jest.spyOn(gatekeeper, 'createCliApprovalRequest')
      .mockRejectedValue(new Error('approval store unavailable'));
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([integrationWriteGuard()]),
    });

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      body: { raw: 'abc' },
    })).rejects.toBeInstanceOf(IntegrationPolicyUnavailableError);
  });
});

function integrationWriteGuard(): ActiveElement {
  return {
    type: 'skill',
    name: 'integration-write-guard',
    metadata: {
      name: 'integration-write-guard',
      gatekeeper: {
        externalRestrictions: {
          description: 'Confirm integration writes',
          confirmPatterns: ['integration_request:gmail:POST:*'],
        },
      },
    },
  };
}

function integrationReadGuard(): ActiveElement {
  return {
    type: 'persona',
    name: 'integration-read-guard',
    metadata: {
      name: 'integration-read-guard',
      gatekeeper: {
        externalRestrictions: {
          description: 'Confirm integration reads',
          confirmPatterns: ['integration_request:read'],
        },
      },
    },
  };
}

function integrationDenyGuard(): ActiveElement {
  return {
    type: 'agent',
    name: 'integration-deny-guard',
    metadata: {
      name: 'integration-deny-guard',
      gatekeeper: {
        externalRestrictions: {
          description: 'Deny integration reads',
          denyPatterns: ['integration_request:read'],
        },
      },
    },
  };
}

function integrationAdminDenyGuard(): ActiveElement {
  return {
    type: 'agent',
    name: 'integration-admin-deny-guard',
    metadata: {
      name: 'integration-admin-deny-guard',
      gatekeeper: {
        externalRestrictions: {
          description: 'Deny integration admin writes',
          denyPatterns: ['integration_request:gmail:DELETE:/admin'],
        },
      },
    },
  };
}

describe('strict management policy boundaries', () => {
  it.each(['create_integration_spec', 'update_integration_spec', 'create_integration_skill', 'update_integration_skill'] as const)('requires default input-bound approval for %s', async operation => {
    jest.replaceProperty(process, 'env', { ...process.env, DOLLHOUSE_CLI_APPROVAL_POLICY: '' });
    const f = fixture([]);
    const action = operation.startsWith('create') ? 'create' : 'update';
    const legacyPath = operation.endsWith('spec') ? oldPath : '_internal:/integration/generated_skill';
    const request = { ...input, path: `${legacyPath}/${action}` };
    const management = { operation, operations: f.operations, legacyPath };
    const pending = await f.enforcer.authorize(request, management);
    expect(pending).toMatchObject({ allowed: false, error: { code: 'integration_request_approval_required' } });
    await f.gatekeeper.approveCliRequest(approvalRequestId(pending), action === 'create' ? 'input_session' : 'single');
    expect(await f.enforcer.authorize({ ...request, body: { changed: true } }, management)).toMatchObject({ allowed: false });
    expect(await f.enforcer.authorize(request, management)).toMatchObject({ allowed: true });
    expect(await f.enforcer.authorize(request, management)).toMatchObject({ allowed: action === 'create' });
  });

  it.each(['allow', 'deny', 'confirm'] as const)('ignores element %s when overrides are disabled but retains default approval', async rule => {
    const f = fixture([element({ [rule]: ['create_integration_spec'] })], false);
    const result = await f.enforcer.authorize(input, { operation: 'create_integration_spec', operations: f.operations, legacyPath: oldPath });
    expect(result).toMatchObject({ allowed: false, error: { code: 'integration_request_approval_required' } });
  });

  it('applies a newly stricter approval policy before accepting an input-session approval', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, DOLLHOUSE_CLI_APPROVAL_POLICY: '' });
    const f = fixture([]);
    const management = { operation: 'create_integration_spec' as const, operations: f.operations, legacyPath: oldPath };
    const pending = await f.enforcer.authorize(input, management);
    await f.gatekeeper.approveCliRequest(approvalRequestId(pending), 'input_session');
    process.env.DOLLHOUSE_CLI_APPROVAL_POLICY = 'moderate,dangerous';
    const stricter = await f.enforcer.authorize(input, management);
    expect(stricter).toMatchObject({ allowed: false, approvalRequest: { allowedScopes: ['single'] } });
    await expect(f.gatekeeper.approveCliRequest(approvalRequestId(stricter), 'input_session')).rejects.toThrow('does not permit');
    await f.gatekeeper.approveCliRequest(approvalRequestId(stricter), 'single');
    expect(await f.enforcer.authorize(input, management)).toMatchObject({ allowed: true });
    expect(await f.enforcer.authorize(input, management)).toMatchObject({ allowed: false });
  });
  it('rejects a sentinel before consuming its exact-input management approval', async () => {
    const f = fixture([element({ externalRestrictions: { description: 'Confirm management writes', confirmPatterns: ['integration_request:gmail:PUT:*'] } })]);
    const input = { provider: 'gmail' as const, method: 'PUT', path: '_internal:/integration/generated_skill/update', body: { skillName: 'target' } };
    const pending = await f.enforcer.authorize(input);
    await f.gatekeeper.approveCliRequest(approvalRequestId(pending), 'single');
    const request = jest.fn<IntegrationRequestGateway['request']>();
    const facade = new AuthorizedIntegrationGateway({ gateway: { request } as unknown as IntegrationRequestGateway, policyEnforcer: f.enforcer });
    expect(await facade.request(input)).toMatchObject({ ok: false, error: { code: 'invalid_integration_path', status: 400 } });
    expect(request).not.toHaveBeenCalled();
    expect(await f.enforcer.authorize(input)).toMatchObject({ allowed: true, approvalContext: { requestId: approvalRequestId(pending) } });
  });
  function fixture(elements: ActiveElement[], allowElementPolicyOverrides = true) {
    const gatekeeper = new Gatekeeper(undefined, { allowElementPolicyOverrides }, undefined, 'strict-policy', new StaticAuditHmacKeyResolver('66'.repeat(32)));
    const enforcer = new IntegrationRequestPolicyEnforcer({ gatekeeper, getActiveElements: async () => elements });
    const operations = new OperationRegistry(new AuthorizedIntegrationOperationCatalog({ catalog: {} as IntegrationOperationCatalog, policyEnforcer: enforcer }));
    return { gatekeeper, enforcer, operations };
  }
  const oldPath = '_internal:/integration/openapi_spec';
  const input = { provider: 'gmail', method: 'PUT', path: `${oldPath}/create`, body: { spec: {} } };
  function element(gatekeeper: ActiveElement['metadata']['gatekeeper']): ActiveElement {
    return { name: 'strict', type: 'personas', metadata: { name: 'strict', gatekeeper } };
  }
  it.each(['create_integration_spec', 'update_integration_spec', 'create_integration_skill', 'update_integration_skill'] as const)('inherits legacy denies but not legacy allows for %s', async operation => {
    const legacyPath = operation.endsWith('spec') ? oldPath : '_internal:/integration/generated_skill';
    const action = operation.startsWith('create') ? 'create' : 'update';
    for (const field of ['denyPatterns', 'allowPatterns'] as const) {
      const f = fixture([element({ externalRestrictions: { description: 'Legacy rule', [field]: [`integration_request:gmail:PUT:${legacyPath}`] } })]);
      expect(await f.enforcer.authorize({ ...input, path: `${legacyPath}/${action}` }, { operation, operations: f.operations, legacyPath })).toMatchObject({ allowed: false, error: { code: 'integration_request_denied_by_policy' } });
    }
  });
  it('carries operation confirm into the sole input-bound approval despite external allow', async () => {
    const f = fixture([element({ confirm: ['create_integration_spec'], externalRestrictions: { description: 'Allow current target', allowPatterns: ['integration_request:*'] } })]);
    const management = { operation: 'create_integration_spec' as const, operations: f.operations, legacyPath: oldPath };
    const first = await f.enforcer.authorize(input, management);
    expect(first.approvalRequest).toBeDefined();
    await f.gatekeeper.approveCliRequest(approvalRequestId(first), 'single');
    expect(await f.enforcer.authorize(input, management)).toMatchObject({ allowed: true });
    expect((await f.enforcer.authorize(input, management)).approvalRequest).toBeDefined();
  });
  it('binds approvals to action, resource, target name and body', async () => {
    const f = fixture([element({ externalRestrictions: { description: 'Confirm writes', confirmPatterns: ['integration_request:gmail:PUT:*'] } })]);
    const skill = { ...input, path: '_internal:/integration/generated_skill/create', body: { skillName: 'one' } };
    const first = await f.enforcer.authorize(skill);
    await f.gatekeeper.approveCliRequest(approvalRequestId(first), 'single');
    for (const other of [input, { ...skill, path: '_internal:/integration/generated_skill' }, { ...skill, path: '_internal:/integration/generated_skill/update' },
      { ...skill, body: { skillName: 'two' } }, { ...skill, path: '/actual-api' }]) {
      expect((await f.enforcer.authorize(other)).allowed).toBe(false);
    }
    expect((await f.enforcer.authorize(skill)).allowed).toBe(true);
  });
});
