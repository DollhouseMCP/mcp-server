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
    await gatekeeper.approveCliRequest(approvalRequestId(first), 'tool_session');

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      body: { raw: 'abc' },
    })).resolves.toMatchObject({
      allowed: false,
      error: { code: 'integration_request_approval_required' },
    });

    const exact = await enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      body: { raw: 'abc' },
    });
    await gatekeeper.approveCliRequest(approvalRequestId(exact), 'single');

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
