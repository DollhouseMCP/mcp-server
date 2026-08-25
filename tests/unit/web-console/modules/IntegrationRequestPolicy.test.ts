import { describe, expect, it } from '@jest/globals';

import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import type { ActiveElement } from '../../../../src/handlers/mcp-aql/policies/index.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';
import { IntegrationRequestPolicyEnforcer } from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';

const SEND_PATH = '/gmail/v1/users/me/messages/send';

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
