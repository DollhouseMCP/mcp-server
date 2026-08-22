import { describe, expect, it, jest } from '@jest/globals';

import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import type { ActiveElement } from '../../../../src/handlers/mcp-aql/policies/index.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';
import {
  IntegrationPolicyUnavailableError,
  IntegrationRequestPolicyEnforcer,
} from '../../../../src/web-console/modules/integrations/IntegrationRequestPolicy.js';

const SEND_PATH = '/gmail/v1/users/me/messages/send';
const REMOTE_DOCS = 'remote-docs';
const DISCOVERY_INPUT = {
  provider: REMOTE_DOCS,
  descriptorId: '00000000-0000-4000-8000-000000000001',
  descriptorRoutingFingerprint: 'a'.repeat(64),
  serverUrl: 'https://mcp.example.com/mcp',
} as const;

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
      baseUrl: 'https://gmail.googleapis.com/v1?tenant=alpha',
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
      baseUrl: 'https://gmail.googleapis.com/v1?tenant=beta',
      body: { raw: 'abc' },
    })).resolves.toMatchObject({
      allowed: false,
      error: { code: 'integration_request_approval_required' },
    });

    await expect(enforcer.authorize({
      provider: 'gmail',
      method: 'POST',
      path: SEND_PATH,
      baseUrl: 'https://gmail.googleapis.com/v1?tenant=alpha',
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

  it('evaluateDiscovery allows unrestricted providers without creating approval requests', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-allow-test',
      new StaticAuditHmacKeyResolver('99'.repeat(32)),
    );
    const createSpy = jest.spyOn(gatekeeper, 'createCliApprovalRequest');
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.resolve([]),
    });

    await expect(enforcer.evaluateDiscovery(DISCOVERY_INPUT)).resolves.toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('evaluateDiscovery fails closed on confirm policies without creating approval requests', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-confirm-test',
      new StaticAuditHmacKeyResolver('aa'.repeat(32)),
    );
    const createSpy = jest.spyOn(gatekeeper, 'createCliApprovalRequest');
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      // integrationReadGuard confirms every integration read; discovery is a
      // session-start read with nobody present to confirm, so it must skip.
      getActiveElements: () => Promise.resolve([integrationReadGuard()]),
    });

    await expect(enforcer.evaluateDiscovery(DISCOVERY_INPUT)).resolves.toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('evaluateDiscovery honors standing tool_session read approvals', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-standing-test',
      new StaticAuditHmacKeyResolver('bb'.repeat(32)),
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

    await expect(enforcer.evaluateDiscovery(DISCOVERY_INPUT)).resolves.toBe(true);
  });

  it('evaluateDiscovery fails closed when policy evaluation is unavailable', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-discovery-unavailable-test',
      new StaticAuditHmacKeyResolver('cc'.repeat(32)),
    );
    const enforcer = new IntegrationRequestPolicyEnforcer({
      gatekeeper,
      getActiveElements: () => Promise.reject(new Error('element resolution failed')),
    });

    await expect(enforcer.evaluateDiscovery(DISCOVERY_INPUT)).resolves.toBe(false);
  });

  it('normalizes active-element loading failures to policy unavailability', async () => {
    const gatekeeper = new Gatekeeper(
      undefined,
      undefined,
      undefined,
      'integration-policy-elements-unavailable-test',
      new StaticAuditHmacKeyResolver('dd'.repeat(32)),
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
      new StaticAuditHmacKeyResolver('ee'.repeat(32)),
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
