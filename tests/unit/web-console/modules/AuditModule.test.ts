import { describe, expect, it } from '@jest/globals';

import {
  InMemoryAdminAuditQuery,
  InMemoryApprovalAuditQuery,
  InMemoryAuthenticationAuditQuery,
  computeAdminAuditChainHmac,
  createAuditModule,
  executeConsoleRoute,
  projectAdminAuditEvent,
  projectAdminAuditPage,
  projectApprovalAuditEvent,
  projectApprovalAuditPage,
  projectAuthenticationAuditPage,
  type AdminAuditRow,
  type ApprovalAuditEventDto,
  type AuthenticationAuditEventDto,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-05-29T11:00:00.000Z');
const SESSION_HASH = Buffer.alloc(32, 7);
const AUDIT_KEY = Buffer.alloc(32, 3);
const AUDIT_KEY_ID = 'audit-key-1';
const AUDIT_KEY_MATERIAL = { keyId: AUDIT_KEY_ID, key: AUDIT_KEY };
const AUDIT_CAPABILITY = 'console:admin:audit';
const ADMIN_AUDIT_PRIVACY = 'admin_audit';
const APPROVAL_PRIVACY = 'approval_metadata';
const MUST_NOT_LEAK = 'must-not-leak';
const AUDIT_FIND = 'audit.find';
const AUDIT_SHOW = 'audit.show';
const AUDIT_EXPORT = 'audit.export';
const ADMIN_AUDIT_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const ADMIN_AUDIT_EXPORT_PATH = '/api/v1/admin/audit/admin/export';
const TEST_CORRELATION_ID = 'correlation-1';

function adminRow(overrides: Partial<AdminAuditRow> = {}): AdminAuditRow {
  const row = {
    id: ADMIN_AUDIT_ID,
    sequenceId: 1,
    occurredAt: NOW,
    actorUserId: '018f3d47-73ae-7f10-a0de-0742618d4fa1',
    actorSub: 'github_123',
    actorRole: null,
    actorCapabilityRole: 'account_admin',
    actorConsoleSessionHash: SESSION_HASH,
    capability: 'console:admin:accounts',
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: new Date('2026-05-29T10:55:00.000Z'),
    correlationId: '018f3d47-73ae-7f10-a0de-0742618d4fc1',
    endpoint: 'POST /api/v1/admin/accounts/users/{user_id}/disable',
    operation: 'accounts.users.disable',
    resourceKind: 'user_principal',
    resourceId: '018f3d47-73ae-7f10-a0de-0742618d4fb2',
    targetUserId: '018f3d47-73ae-7f10-a0de-0742618d4fb2',
    argsRedacted: { reason_present: true },
    result: 'approved',
    errorCode: null,
    resultDetailRedacted: { runtime_commands: 1 },
    clientIp: '203.0.113.10',
    userAgent: 'Mozilla/5.0',
    chainKeyId: AUDIT_KEY_ID,
    chainPrev: null,
    chainHmac: Buffer.alloc(32, 0),
    ...overrides,
  };
  return {
    ...row,
    chainHmac: overrides.chainHmac ?? computeAdminAuditChainHmac(row, AUDIT_KEY, row.chainPrev),
  };
}

function approvalRow(overrides: Partial<ApprovalAuditEventDto> = {}): ApprovalAuditEventDto {
  return {
    id: 'cli-approval-1',
    occurred_at: NOW.toISOString(),
    account_correlation_id: 'account-correlation-1',
    session_id: 'session-1',
    tool_name: 'Bash',
    operation: 'tool.execute',
    result: 'denied',
    decision_source: 'owner',
    correlation_id: TEST_CORRELATION_ID,
    integrity: {
      status: 'not_available',
      chain_key_id: null,
      chain_prev: null,
      chain_hmac: null,
    },
    ...overrides,
  };
}

function authenticationRow(overrides: Partial<AuthenticationAuditEventDto> = {}): AuthenticationAuditEventDto {
  return {
    id: 'auth-event-1',
    occurred_at: NOW.toISOString(),
    event: 'console.auth.step_up.granted',
    actor_user_id: '018f3d47-73ae-7f10-a0de-0742618d4fa1',
    actor_sub: 'github_123',
    capability: AUDIT_CAPABILITY,
    elevation_acr: 'urn:dollhouse:acr:admin-stepup',
    elevation_amr: ['otp'],
    result: 'approved',
    error_code: null,
    correlation_id: 'correlation-2',
    client_ip: '203.0.113.11',
    user_agent: 'Mozilla/5.0',
    ...overrides,
  };
}

function createModule() {
  return createAuditModule({
    adminAuditQuery: new InMemoryAdminAuditQuery([
      adminRow(),
      adminRow({
        id: '018f3d47-73ae-7f10-a0de-0742618d4fb3',
        sequenceId: 2,
        chainPrev: adminRow().chainHmac,
      }),
    ], AUDIT_KEY_MATERIAL),
    approvalAuditQuery: new InMemoryApprovalAuditQuery([approvalRow()]),
    authenticationAuditQuery: new InMemoryAuthenticationAuditQuery([authenticationRow()]),
  });
}

function findRoute(routes: readonly ConsoleRouteDefinition[], method: string, path: string): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

async function collectEvents<T>(events: AsyncIterable<T> | undefined): Promise<T[]> {
  if (!events) throw new Error('missing stream events');
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('AuditModule', () => {
  it('declares audited administrator read descriptors with selected freshness policies', () => {
    const module = createModule();

    expect(module).toMatchObject({
      id: 'audit',
      apiVersion: 'v1',
      capabilities: [AUDIT_CAPABILITY],
      auditOperations: [{ id: AUDIT_FIND }, { id: AUDIT_SHOW }, { id: AUDIT_EXPORT }],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/audit/admin',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: ADMIN_AUDIT_PRIVACY,
        auditOperation: AUDIT_FIND,
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/audit/admin/:id',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: ADMIN_AUDIT_PRIVACY,
        auditOperation: AUDIT_SHOW,
      }),
      expect.objectContaining({
        method: 'GET',
        path: ADMIN_AUDIT_EXPORT_PATH,
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: ADMIN_AUDIT_PRIVACY,
        auditOperation: AUDIT_EXPORT,
        responseKind: 'sse',
        streamPolicy: expect.objectContaining({
          lastEventId: 'unsupported',
          heartbeatMs: 15_000,
          revalidateMs: 15_000,
        }),
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/audit/approvals',
        elevation: 'admin_30m',
        privacyClass: APPROVAL_PRIVACY,
        auditOperation: AUDIT_FIND,
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/audit/approvals/:id',
        elevation: 'admin_5m',
        privacyClass: APPROVAL_PRIVACY,
        auditOperation: AUDIT_SHOW,
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/audit/authentication',
        elevation: 'admin_30m',
        privacyClass: ADMIN_AUDIT_PRIVACY,
        auditOperation: AUDIT_FIND,
      }),
    ]));
  });

  it('lists admin audit rows with chain metadata and bounded paging', async () => {
    const route = findRoute(createModule().routes, 'GET', '/api/v1/admin/audit/admin');
    const firstRow = adminRow();

    const result = await route.handler({ query: { limit: '1' }, params: {} } as never);

    expect(projectAdminAuditPage(result.body)).toEqual({
      items: [expect.objectContaining({
        id: ADMIN_AUDIT_ID,
        sequence_id: 1,
        actor_console_session_hash: SESSION_HASH.toString('hex'),
        chain_key_id: AUDIT_KEY_ID,
        chain_prev: null,
        chain_hmac: firstRow.chainHmac.toString('hex'),
        integrity: { status: 'verified', reason: null },
      })],
      page: {
        limit: 1,
        cursor: null,
        next_cursor: expect.any(String),
      },
    });
  });

  it('returns one admin audit row through the detail route', async () => {
    const route = findRoute(createModule().routes, 'GET', '/api/v1/admin/audit/admin/:id');

    const result = await route.handler({
      query: {},
      params: { id: ADMIN_AUDIT_ID },
    } as never);

    expect(projectAdminAuditEvent(result.body)).toMatchObject({
      id: ADMIN_AUDIT_ID,
      elevation_auth_time: Math.floor(new Date('2026-05-29T10:55:00.000Z').getTime() / 1000),
      args_redacted: { reason_present: true },
      result_detail_redacted: { runtime_commands: 1 },
    });
  });

  it('streams admin audit export rows through SSE update events with allowlisted payloads', async () => {
    const route = findRoute(createModule().routes, 'GET', ADMIN_AUDIT_EXPORT_PATH);

    const result = await executeConsoleRoute(route, {
      query: { batch_size: '1' },
      params: {},
      headers: {},
    } as never);

    expect(result.stream?.init).toEqual({
      stream_id: 'admin.audit.admin.export',
      stream_type: 'admin_audit_export',
      resume_supported: false,
      cursor: null,
      batch_size: 1,
    });
    const events = await collectEvents(result.stream?.events);
    expect(events).toEqual([
      {
        event: 'update',
        data: expect.objectContaining({
          id: ADMIN_AUDIT_ID,
          sequence_id: 1,
          actor_console_session_hash: SESSION_HASH.toString('hex'),
          chain_key_id: AUDIT_KEY_ID,
          integrity: { status: 'verified', reason: null },
        }),
      },
      {
        event: 'update',
        data: expect.objectContaining({
          id: '018f3d47-73ae-7f10-a0de-0742618d4fb3',
          sequence_id: 2,
          integrity: { status: 'verified', reason: null },
        }),
      },
      {
        event: 'end',
        data: { status: 'complete' },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(MUST_NOT_LEAK);
  });

  it('rejects Last-Event-ID on admin audit export until real resume is implemented', () => {
    const route = findRoute(createModule().routes, 'GET', ADMIN_AUDIT_EXPORT_PATH);

    expect(() => route.handler({
      query: {},
      params: {},
      headers: { 'last-event-id': 'admin-audit:1' },
    } as never)).toThrow('Invalid Last-Event-ID');
  });

  it('marks rows failed without failing the whole read when chain linkage is inconsistent', async () => {
    const query = new InMemoryAdminAuditQuery([
      adminRow(),
      adminRow({
        id: '018f3d47-73ae-7f10-a0de-0742618d4fb3',
        sequenceId: 2,
        chainPrev: Buffer.alloc(32, 99),
      }),
    ], AUDIT_KEY_MATERIAL);

    await expect(query.listAdminAudit({ limit: 10, cursor: null })).resolves.toMatchObject({
      items: [
        { integrity: { status: 'verified', reason: null } },
        { integrity: { status: 'failed', reason: 'chain_prev_mismatch' } },
      ],
    });
  });

  it('detects content tampering and bad chain-hmac length per row', async () => {
    const original = adminRow();
    const query = new InMemoryAdminAuditQuery([
      {
        ...original,
        targetUserId: '018f3d47-73ae-7f10-a0de-0742618d4999',
      },
      adminRow({
        id: '018f3d47-73ae-7f10-a0de-0742618d4fb3',
        sequenceId: 2,
        chainPrev: original.chainHmac,
        chainHmac: Buffer.alloc(31, 1),
      }),
    ], AUDIT_KEY_MATERIAL);

    await expect(query.listAdminAudit({ limit: 10, cursor: null })).resolves.toMatchObject({
      items: [
        { integrity: { status: 'failed', reason: 'chain_hmac_mismatch' } },
        { integrity: { status: 'failed', reason: 'invalid_chain_hmac_length' } },
      ],
    });
  });

  it('detects content tampering on single-row admin audit detail reads', async () => {
    const original = adminRow();
    const query = new InMemoryAdminAuditQuery([
      {
        ...original,
        result: 'failed',
      },
    ], AUDIT_KEY_MATERIAL);

    await expect(query.getAdminAudit(original.id)).resolves.toMatchObject({
      result: 'failed',
      integrity: { status: 'failed', reason: 'chain_hmac_mismatch' },
    });
  });

  it('marks historical admin audit rows not available when the verification key is not retained', async () => {
    const query = new InMemoryAdminAuditQuery([adminRow({ chainKeyId: 'old-key' })], AUDIT_KEY_MATERIAL);

    await expect(query.getAdminAudit(ADMIN_AUDIT_ID)).resolves.toMatchObject({
      integrity: { status: 'not_available', reason: 'verification_key_unavailable' },
    });
  });

  it('projects admin audit rows by allowlist rather than source object shape', () => {
    const projected = projectAdminAuditEvent({
      id: 'admin-event-1',
      sequence_id: 1,
      occurred_at: NOW.toISOString(),
      actor_user_id: 'actor-1',
      actor_sub: 'github_123',
      actor_role: null,
      actor_capability_role: 'auditor',
      actor_console_session_hash: SESSION_HASH.toString('hex'),
      capability: AUDIT_CAPABILITY,
      elevation_acr: null,
      elevation_amr: [],
      elevation_auth_time: null,
      correlation_id: TEST_CORRELATION_ID,
      endpoint: 'GET /api/v1/admin/audit/admin',
      operation: AUDIT_FIND,
      resource_kind: null,
      resource_id: null,
      target_user_id: null,
      args_redacted: {},
      result: 'approved',
      error_code: null,
      result_detail_redacted: null,
      client_ip: null,
      user_agent: null,
      chain_key_id: AUDIT_KEY_ID,
      chain_prev: null,
      chain_hmac: adminRow().chainHmac.toString('hex'),
      integrity: {
        status: 'verified',
        reason: null,
      },
      cookie: MUST_NOT_LEAK,
      token: MUST_NOT_LEAK,
      raw_session: MUST_NOT_LEAK,
    });

    expect(projected).toEqual({
      id: 'admin-event-1',
      sequence_id: 1,
      occurred_at: NOW.toISOString(),
      actor_user_id: 'actor-1',
      actor_sub: 'github_123',
      actor_role: null,
      actor_capability_role: 'auditor',
      actor_console_session_hash: SESSION_HASH.toString('hex'),
      capability: AUDIT_CAPABILITY,
      elevation_acr: null,
      elevation_amr: [],
      elevation_auth_time: null,
      correlation_id: TEST_CORRELATION_ID,
      endpoint: 'GET /api/v1/admin/audit/admin',
      operation: 'audit.find',
      resource_kind: null,
      resource_id: null,
      target_user_id: null,
      args_redacted: {},
      result: 'approved',
      error_code: null,
      result_detail_redacted: null,
      client_ip: null,
      user_agent: null,
      chain_key_id: AUDIT_KEY_ID,
      chain_prev: null,
      chain_hmac: adminRow().chainHmac.toString('hex'),
      integrity: {
        status: 'verified',
        reason: null,
      },
    });
    expect(projected).not.toHaveProperty('cookie');
  });

  it('coerces unknown projected admin audit enum values to DTO fallbacks', () => {
    const projected = projectAdminAuditEvent({
      id: 'admin-event-1',
      sequence_id: 1,
      occurred_at: NOW.toISOString(),
      actor_user_id: 'actor-1',
      actor_sub: 'github_123',
      actor_role: 'bogus',
      actor_capability_role: 'bogus',
      actor_console_session_hash: SESSION_HASH.toString('hex'),
      capability: 'nope',
      elevation_acr: null,
      elevation_amr: [],
      elevation_auth_time: null,
      correlation_id: TEST_CORRELATION_ID,
      endpoint: 'GET /api/v1/admin/audit/admin',
      operation: AUDIT_FIND,
      resource_kind: null,
      resource_id: null,
      target_user_id: null,
      args_redacted: {},
      result: 'something_unknown',
      error_code: null,
      result_detail_redacted: null,
      client_ip: null,
      user_agent: null,
      chain_key_id: AUDIT_KEY_ID,
      chain_prev: null,
      chain_hmac: adminRow().chainHmac.toString('hex'),
      integrity: {
        status: 'verified',
        reason: null,
      },
    });

    expect(projected).toMatchObject({
      actor_role: null,
      actor_capability_role: 'auditor',
      capability: AUDIT_CAPABILITY,
      result: 'failed',
    });
  });

  it('lists approval audit metadata without prompt, input, output, or digest fields', async () => {
    const route = findRoute(createAuditModule({
      adminAuditQuery: new InMemoryAdminAuditQuery(),
      approvalAuditQuery: new InMemoryApprovalAuditQuery([approvalRow({
        prompt: MUST_NOT_LEAK,
        tool_input: { command: MUST_NOT_LEAK },
        tool_input_hash: MUST_NOT_LEAK,
        output: MUST_NOT_LEAK,
      } as never)]),
      authenticationAuditQuery: new InMemoryAuthenticationAuditQuery(),
    }).routes, 'GET', '/api/v1/admin/audit/approvals');

    const result = await route.handler({ query: {}, params: {} } as never);
    const projected = projectApprovalAuditPage(result.body);

    expect(projected.items).toEqual([{
      id: 'cli-approval-1',
      occurred_at: NOW.toISOString(),
      account_correlation_id: 'account-correlation-1',
      session_id: 'session-1',
      tool_name: 'Bash',
      operation: 'tool.execute',
      result: 'denied',
      decision_source: 'owner',
      correlation_id: TEST_CORRELATION_ID,
      integrity: {
        status: 'not_available',
        chain_key_id: null,
        chain_prev: null,
        chain_hmac: null,
      },
    }]);
    expect(projected.items[0]).not.toHaveProperty('tool_input_hash');
  });

  it('returns one approval audit metadata row or 404 after id validation', async () => {
    const route = findRoute(createModule().routes, 'GET', '/api/v1/admin/audit/approvals/:id');

    await expect(route.handler({ query: {}, params: { id: 'cli-approval-1' } } as never))
      .resolves.toMatchObject({ status: 200 });
    await expect(route.handler({ query: {}, params: { id: 'missing' } } as never))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(route.handler({ query: {}, params: { id: '' } } as never))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
  });

  it('projects single approval audit metadata by allowlist', () => {
    const projected = projectApprovalAuditEvent({
      ...approvalRow(),
      prompt: MUST_NOT_LEAK,
      tool_input: { command: MUST_NOT_LEAK },
      tool_input_digest: { command: MUST_NOT_LEAK },
      tool_input_hash: MUST_NOT_LEAK,
      output: MUST_NOT_LEAK,
      user_id: MUST_NOT_LEAK,
    });

    expect(projected).toEqual(approvalRow());
    expect(projected).not.toHaveProperty('tool_input');
    expect(projected).not.toHaveProperty('tool_input_digest');
  });

  it('projects approval audit pages by allowlist', () => {
    expect(projectApprovalAuditPage({
      items: [{
        ...approvalRow(),
        prompt: MUST_NOT_LEAK,
        tool_input: { command: MUST_NOT_LEAK },
        tool_input_digest: { command: MUST_NOT_LEAK },
        tool_input_hash: MUST_NOT_LEAK,
        output: MUST_NOT_LEAK,
      }],
      page: { limit: 1, cursor: null, next_cursor: null },
    }).items[0]).toEqual(approvalRow());
  });

  it('lists authentication audit metadata without proof values', async () => {
    const route = findRoute(createAuditModule({
      adminAuditQuery: new InMemoryAdminAuditQuery(),
      approvalAuditQuery: new InMemoryApprovalAuditQuery(),
      authenticationAuditQuery: new InMemoryAuthenticationAuditQuery([authenticationRow({
        totp_code: MUST_NOT_LEAK,
        token: MUST_NOT_LEAK,
      } as never)]),
    }).routes, 'GET', '/api/v1/admin/audit/authentication');

    const result = await route.handler({ query: { limit: '1000' }, params: {} } as never);

    expect(projectAuthenticationAuditPage(result.body)).toEqual({
      items: [{
        id: 'auth-event-1',
        occurred_at: NOW.toISOString(),
        event: 'console.auth.step_up.granted',
        actor_user_id: '018f3d47-73ae-7f10-a0de-0742618d4fa1',
        actor_sub: 'github_123',
        capability: AUDIT_CAPABILITY,
        elevation_acr: 'urn:dollhouse:acr:admin-stepup',
        elevation_amr: ['otp'],
        result: 'approved',
        error_code: null,
        correlation_id: 'correlation-2',
        client_ip: '203.0.113.11',
        user_agent: 'Mozilla/5.0',
      }],
      page: {
        limit: 100,
        cursor: null,
        next_cursor: null,
      },
    });
  });
});
