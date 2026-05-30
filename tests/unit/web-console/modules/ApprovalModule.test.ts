import { describe, expect, it } from '@jest/globals';

import {
  ConsoleModuleRegistry,
  InMemoryRuntimeSessionControlStore,
  InMemorySessionApprovalEventSink,
  InMemorySessionApprovalStore,
  ConfirmationSessionApprovalStore,
  GatekeeperSessionApprovalStore,
  createApprovalModule,
  projectSessionApproval,
  projectSessionApprovalList,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';
import type { CliApprovalRecord } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import type { ConfirmationRecord } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { GatekeeperSession } from '../../../../src/handlers/mcp-aql/GatekeeperSession.js';
import type { ApprovalRef, ApprovalSearchFilter, IConfirmationStore } from '../../../../src/state/IConfirmationStore.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const SESSION_ID = 'mcp-session-1';
const SECOND_SESSION_ID = 'mcp-session-2';
const APPROVAL_ID = 'cli-018f3d47-73ae-4f10-a0de-0742618d4fb1';
const SECOND_APPROVAL_ID = 'cli-118f3d47-73ae-4f10-a0de-0742618d4fb2';
const APPROVAL_LIST_PATH = '/api/v1/me/sessions/:session_id/approvals';
const APPROVE_PATH = '/api/v1/me/sessions/:session_id/approvals/:approval_id/approve';
const DENY_PATH = '/api/v1/me/sessions/:session_id/approvals/:approval_id/deny';
const NOW = new Date('2026-05-29T14:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-29T14:05:00.000Z');

async function fixture() {
  const runtimeStore = new InMemoryRuntimeSessionControlStore();
  await runtimeStore.registerPresence({
    sessionId: SESSION_ID,
    userId: USER_ID,
    accountCorrelationId: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8',
    replicaId: 'replica-a',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: FIVE_MINUTES,
  });
  await runtimeStore.registerPresence({
    sessionId: SECOND_SESSION_ID,
    userId: SECOND_USER_ID,
    accountCorrelationId: '8d0e5e89-52d0-4f88-a7bc-8f2f65a708b9',
    replicaId: 'replica-b',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: FIVE_MINUTES,
  });
  const approvalStore = new InMemorySessionApprovalStore();
  approvalStore.seed(USER_ID, SESSION_ID, approvalRecord(APPROVAL_ID));
  approvalStore.seed(SECOND_USER_ID, SECOND_SESSION_ID, approvalRecord(SECOND_APPROVAL_ID));
  const eventSink = new InMemorySessionApprovalEventSink();
  const module = createApprovalModule({
    runtimeStore,
    approvalStore,
    eventSink,
    now: () => NOW,
  });
  return { module, approvalStore, eventSink };
}

function approvalRecord(id: string, overrides: Partial<CliApprovalRecord> = {}): CliApprovalRecord {
  return {
    requestId: id,
    toolName: 'Bash',
    toolInputDigest: { command: 'npm test' },
    toolInputHash: 'kid:hash',
    toolInputDetail: { command: 'npm test -- --runInBand' },
    riskLevel: 'moderate',
    riskScore: 55,
    irreversible: false,
    requestedAt: '2026-05-29T13:59:00.000Z',
    consumed: false,
    scope: 'single',
    denyReason: 'Tool requires approval',
    policySource: 'element_policy',
    ttlMs: 300_000,
    ...overrides,
  };
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  method: ConsoleRouteDefinition['method'],
  path: string,
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function request(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    get: (name: string) => name.toLowerCase() === 'user-agent' ? 'jest' : undefined,
    consoleContext: {
      correlationId: '94017d3c-7b7a-4e28-a3c2-701e0ea5471d',
      receivedAt: NOW,
    },
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: USER_ID,
      authSub: 'sub-user',
      authzVersion: 1,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
    ...overrides,
  } as ConsoleRequest;
}

describe('ApprovalModule', () => {
  it('registers descriptor-driven self approval routes with expected policies', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register((await fixture()).module);

    expect(registry.createRouteManifest().routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleId: 'approvals',
        method: 'GET',
        path: APPROVAL_LIST_PATH,
        requiredCapability: 'console:self',
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'POST',
        path: APPROVE_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'POST',
        path: DENY_PATH,
        idempotency: 'required',
      }),
    ]));
  });

  it('lists owner-private approvals only for the owned runtime session', async () => {
    const { module } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', APPROVAL_LIST_PATH);

    await expect(listRoute.handler(request({ params: { session_id: SECOND_SESSION_ID } })))
      .resolves.toMatchObject({ status: 404 });

    await expect(listRoute.handler(request({ params: { session_id: SESSION_ID } })))
      .resolves.toMatchObject({
        status: 200,
        body: {
          approvals: [expect.objectContaining({
            approval_id: APPROVAL_ID,
            status: 'pending',
            tool_name: 'Bash',
            tool_input_detail: { command: 'npm test -- --runInBand' },
          })],
        },
      });
  });

  it('approves a pending approval once and returns stable terminal state on retry', async () => {
    const { module, approvalStore, eventSink } = await fixture();
    const approveRoute = findRoute(module.routes, 'POST', APPROVE_PATH);

    await expect(approveRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: APPROVAL_ID },
      body: { scope: 'session' },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        approval_id: APPROVAL_ID,
        status: 'approved',
        scope: 'session',
        decided_at: NOW.toISOString(),
      },
    });
    await expect(approveRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: APPROVAL_ID },
      body: { scope: 'once' },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        status: 'approved',
        scope: 'session',
        decided_at: NOW.toISOString(),
      },
    });
    await expect(approvalStore.find(USER_ID, SESSION_ID, APPROVAL_ID))
      .resolves.toMatchObject({ approvedAt: NOW.toISOString(), scope: 'tool_session' });
    expect(eventSink.listEvents()).toEqual([
      expect.objectContaining({
        approvalId: APPROVAL_ID,
        decision: 'approved',
        scope: 'session',
      }),
    ]);
  });

  it('denies a pending approval and does not allow a later approve transition', async () => {
    const { module, eventSink } = await fixture();
    const denyRoute = findRoute(module.routes, 'POST', DENY_PATH);
    const approveRoute = findRoute(module.routes, 'POST', APPROVE_PATH);

    await expect(denyRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: APPROVAL_ID },
      body: {},
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        approval_id: APPROVAL_ID,
        status: 'denied',
        decided_at: NOW.toISOString(),
      },
    });
    await expect(approveRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: APPROVAL_ID },
      body: { scope: 'session' },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        status: 'denied',
        scope: 'once',
      },
    });
    expect(eventSink.listEvents()).toHaveLength(1);
  });

  it('returns expired terminal approvals without resurrecting them', async () => {
    const { module, approvalStore, eventSink } = await fixture();
    const expiredId = 'cli-218f3d47-73ae-4f10-a0de-0742618d4fb3';
    approvalStore.seed(USER_ID, SESSION_ID, approvalRecord(expiredId, {
      requestedAt: '2026-05-29T13:00:00.000Z',
      ttlMs: 1_000,
    }));
    const approveRoute = findRoute(module.routes, 'POST', APPROVE_PATH);

    await expect(approveRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: expiredId },
      body: { scope: 'session' },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        approval_id: expiredId,
        status: 'expired',
        decided_at: null,
      },
    });
    expect(eventSink.listEvents()).toEqual([]);
  });

  it('rejects invalid ids, invalid scopes, and missing approvals after owned-session validation', async () => {
    const { module } = await fixture();
    const approveRoute = findRoute(module.routes, 'POST', APPROVE_PATH);

    await expect(approveRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: 'not-cli-id' },
    }))).resolves.toMatchObject({ status: 422 });
    await expect(approveRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: APPROVAL_ID },
      body: { scope: 'forever' },
    }))).resolves.toMatchObject({ status: 422 });
    await expect(approveRoute.handler(request({
      params: { session_id: SESSION_ID, approval_id: 'cli-318f3d47-73ae-4f10-a0de-0742618d4fb4' },
    }))).resolves.toMatchObject({ status: 404 });
  });

  it('privacy projectors use explicit owner-private approval allowlists', () => {
    expect(projectSessionApproval({
      approval_id: APPROVAL_ID,
      session_id: SESSION_ID,
      status: 'pending',
      tool_name: 'Bash',
      tool_input_digest: { command: 'npm test' },
      tool_input_detail: { command: 'npm test -- --runInBand' },
      risk_level: 'moderate',
      risk_score: 55,
      irreversible: false,
      reason: 'Tool requires approval',
      policy_source: 'element_policy',
      scope: 'once',
      requested_at: NOW.toISOString(),
      expires_at: FIVE_MINUTES.toISOString(),
      decided_at: null,
      user_id: USER_ID,
      tool_input_hash: 'kid:hash',
      token: 'secret',
    })).toEqual({
      approval_id: APPROVAL_ID,
      session_id: SESSION_ID,
      status: 'pending',
      tool_name: 'Bash',
      tool_input_digest: { command: 'npm test' },
      tool_input_detail: { command: 'npm test -- --runInBand' },
      risk_level: 'moderate',
      risk_score: 55,
      irreversible: false,
      reason: 'Tool requires approval',
      policy_source: 'element_policy',
      scope: 'once',
      requested_at: NOW.toISOString(),
      expires_at: FIVE_MINUTES.toISOString(),
      decided_at: null,
    });
    expect(projectSessionApprovalList({ approvals: [{ approval_id: APPROVAL_ID }] }))
      .toEqual({ approvals: [expect.objectContaining({ approval_id: APPROVAL_ID })] });
  });

  it('bridges decisions to the existing confirmation store and promotes session-scoped approvals', async () => {
    const confirmationStore = new FakeConfirmationStore(SESSION_ID);
    const approval = approvalRecord(APPROVAL_ID);
    confirmationStore.saveCliApproval(APPROVAL_ID, approval);
    const approvalStore = new ConfirmationSessionApprovalStore(() => confirmationStore);

    const listed = await approvalStore.list(USER_ID, SESSION_ID);
    expect(listed).toEqual([approval]);

    await approvalStore.save(USER_ID, SESSION_ID, APPROVAL_ID, {
      ...approval,
      approvedAt: NOW.toISOString(),
      scope: 'tool_session',
    });

    expect(confirmationStore.getCliApproval(APPROVAL_ID)).toMatchObject({
      approvedAt: NOW.toISOString(),
      scope: 'tool_session',
    });
    expect(confirmationStore.getCliSessionApproval('Bash')).toMatchObject({
      requestId: APPROVAL_ID,
      scope: 'tool_session',
    });
    expect(confirmationStore.persistCount).toBe(1);
  });

  it('can decide the live Gatekeeper session so deny blocks later CLI consumption', async () => {
    const gatekeeper = new Gatekeeper();
    const liveSession = new GatekeeperSession(
      undefined,
      100,
      50,
      undefined,
      SESSION_ID,
      new StaticAuditHmacKeyResolver('77'.repeat(32)),
    );
    gatekeeper.registerSession(SESSION_ID, liveSession);
    const approvalId = await liveSession.createCliApprovalRequest({
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      riskLevel: 'moderate',
      riskScore: 55,
      irreversible: false,
      denyReason: 'Tool requires approval',
    });
    const approval = liveSession.getCliApproval(approvalId);
    expect(approval).toBeDefined();
    if (!approval) throw new Error('expected approval');
    const approvalStore = new GatekeeperSessionApprovalStore(gatekeeper);
    const deniedAt = approval.requestedAt;

    await approvalStore.save(USER_ID, SESSION_ID, approvalId, {
      ...approval,
      deniedAt,
    });

    expect(liveSession.getCliApproval(approvalId)).toMatchObject({
      deniedAt,
    });
    expect(liveSession.checkCliApproval('Bash', { command: 'npm test' })).toBeUndefined();
  });
});

class FakeConfirmationStore implements IConfirmationStore {
  readonly confirmations = new Map<string, ConfirmationRecord>();
  readonly cliApprovals = new Map<string, CliApprovalRecord>();
  readonly cliSessionApprovals = new Map<string, CliApprovalRecord>();
  persistCount = 0;
  private permissionPromptActive = false;

  constructor(private readonly sessionId: string) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  persist(): Promise<void> {
    this.persistCount++;
    return Promise.resolve();
  }

  saveConfirmation(key: string, record: ConfirmationRecord): void {
    this.confirmations.set(key, record);
  }

  getConfirmation(key: string): ConfirmationRecord | undefined {
    return this.confirmations.get(key);
  }

  deleteConfirmation(key: string): boolean {
    return this.confirmations.delete(key);
  }

  getAllConfirmations(): ConfirmationRecord[] {
    return Array.from(this.confirmations.values());
  }

  clearAllConfirmations(): void {
    this.confirmations.clear();
  }

  saveCliApproval(requestId: string, record: CliApprovalRecord): void {
    this.cliApprovals.set(requestId, record);
  }

  getCliApproval(requestId: string): CliApprovalRecord | undefined {
    return this.cliApprovals.get(requestId);
  }

  deleteCliApproval(requestId: string): boolean {
    return this.cliApprovals.delete(requestId);
  }

  getAllCliApprovals(): CliApprovalRecord[] {
    return Array.from(this.cliApprovals.values());
  }

  saveCliSessionApproval(toolName: string, record: CliApprovalRecord): void {
    this.cliSessionApprovals.set(toolName, record);
  }

  getCliSessionApproval(toolName: string): CliApprovalRecord | undefined {
    return this.cliSessionApprovals.get(toolName);
  }

  getAllCliSessionApprovals(): CliApprovalRecord[] {
    return Array.from(this.cliSessionApprovals.values());
  }

  findApprovals(_filter: ApprovalSearchFilter): Promise<ApprovalRef[]> {
    return Promise.resolve([]);
  }

  getRawApprovalDetail(_sessionId: string, _approvalId: string): Promise<Record<string, unknown> | null> {
    return Promise.resolve(null);
  }

  savePermissionPromptActive(active: boolean): void {
    this.permissionPromptActive = active;
  }

  getPermissionPromptActive(): boolean {
    return this.permissionPromptActive;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
