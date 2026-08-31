import { describe, expect, it } from '@jest/globals';

import {
  ConsoleModuleRegistry,
  InMemoryConsoleAccountAdminStore,
  InMemoryRuntimeSessionControlStore,
  createRuntimeSessionModule,
  projectRuntimeSessionAccount,
  projectRuntimeSessionOperational,
  projectRuntimeTermination,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const SECOND_ACCOUNT_CORRELATION_ID = '8d0e5e89-52d0-4f88-a7bc-8f2f65a708b9';
const SESSION_ID = 'mcp-session-1';
const SECOND_SESSION_ID = 'mcp-session-2';
const RUNTIME_TRANSPORT = 'streamable-http';
const NOW = new Date('2026-05-28T14:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-28T14:05:00.000Z');
const OPERATE_SESSIONS_PATH = '/api/v1/admin/operate/sessions';

function accountStore(): InMemoryConsoleAccountAdminStore {
  return new InMemoryConsoleAccountAdminStore([
    principal(USER_ID, ACCOUNT_CORRELATION_ID),
    principal(SECOND_USER_ID, SECOND_ACCOUNT_CORRELATION_ID),
  ]);
}

function principal(userId: string, accountCorrelationId: string) {
  return {
    userId,
    primarySub: `sub-${userId}`,
    username: `user-${userId.slice(0, 4)}`,
    displayName: null,
    email: null,
    emailVerified: false,
    authMethods: ['local-password'],
    roles: ['account_admin' as const],
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: null,
    adminFactorEnrolled: true,
    accountCorrelationId,
    authzVersion: 1,
  };
}

async function fixture() {
  const runtimeStore = new InMemoryRuntimeSessionControlStore();
  await runtimeStore.registerPresence({
    sessionId: SESSION_ID,
    userId: USER_ID,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    replicaId: 'replica-a',
    transport: RUNTIME_TRANSPORT,
    clientInfo: { name: 'Dollhouse CLI', version: '1.0.0' },
    startedAt: NOW,
    lastActiveAt: NOW,
    requestCount: 3,
    errorCount: 1,
    leaseUntil: FIVE_MINUTES,
  });
  await runtimeStore.registerPresence({
    sessionId: SECOND_SESSION_ID,
    userId: SECOND_USER_ID,
    accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    replicaId: 'replica-b',
    transport: RUNTIME_TRANSPORT,
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: FIVE_MINUTES,
  });
  const module = createRuntimeSessionModule({
    runtimeStore,
    accountAdminStore: accountStore(),
    now: () => NOW,
  });
  return { module, runtimeStore };
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
      grantedCapabilities: ['console:self', 'console:admin:accounts', 'console:admin:operate'],
      elevation: {
        capabilities: ['console:admin:accounts', 'console:admin:operate'],
        expiresAt: FIVE_MINUTES,
        acr: 'urn:dollhouse:acr:admin-stepup',
        amr: ['otp'],
        authTime: NOW,
      },
    },
    ...overrides,
  } as ConsoleRequest;
}

describe('RuntimeSessionModule', () => {
  it('registers self, account-admin, and operator runtime-session routes with expected policies', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register((await fixture()).module);

    expect(registry.createRouteManifest().routes).toEqual([
      expect.objectContaining({
        moduleId: 'runtimeSessions',
        method: 'GET',
        path: '/api/v1/me/sessions',
        audience: 'self',
        requiredCapability: 'console:self',
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id',
        ownership: 'owned_session',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: '/api/v1/me/sessions/:session_id',
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/me/sessions/revoke-all',
        audience: 'self',
        requiredCapability: 'console:self',
        ownership: 'authenticated_user',
        elevation: 'none',
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/me/sessions/commands/:command_id',
        audience: 'self',
        requiredCapability: 'console:self',
        ownership: 'authenticated_user',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/accounts/users/:user_id/sessions',
        requiredCapability: 'console:admin:accounts',
        elevation: 'admin_30m',
        privacyClass: 'account_metadata',
        auditOperation: 'accounts.users.sessions.list',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: '/api/v1/admin/accounts/users/:user_id/sessions/:session_id',
        idempotency: 'required',
        auditOperation: 'accounts.users.sessions.terminate',
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/admin/accounts/users/:user_id/sessions/revoke-all',
        idempotency: 'required',
        auditOperation: 'accounts.users.sessions.revoke_all',
      }),
      expect.objectContaining({
        method: 'GET',
        path: OPERATE_SESSIONS_PATH,
        requiredCapability: 'console:admin:operate',
        privacyClass: 'operational_allowlist',
        auditOperation: 'operate.sessions.list',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/sessions/commands/:command_id',
        requiredCapability: 'console:admin:operate',
        auditOperation: 'operate.sessions.command_status',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/sessions/:session_id',
        auditOperation: 'operate.sessions.show',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: '/api/v1/admin/operate/sessions/:session_id',
        idempotency: 'required',
        auditOperation: 'operate.sessions.terminate',
      }),
    ]);
  });

  it('lists and reads self sessions without account correlation leakage', async () => {
    const { module } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', '/api/v1/me/sessions');
    const showRoute = findRoute(module.routes, 'GET', '/api/v1/me/sessions/:session_id');

    await expect(listRoute.handler(request())).resolves.toMatchObject({
      status: 200,
      // Snapshot-family envelope: noun-keyed, never a bare array.
      body: {
        sessions: [{
          session_id: SESSION_ID,
          client_info: { name: 'Dollhouse CLI', version: '1.0.0' },
        }],
      },
    });
    const result = await showRoute.handler(request({ params: { session_id: SESSION_ID } }));
    expect(result.body).not.toHaveProperty('account_correlation_id');
    expect(result.body).not.toHaveProperty('user_id');
  });

  it('enqueues self termination only for owned sessions', async () => {
    const { module, runtimeStore } = await fixture();
    const route = findRoute(module.routes, 'DELETE', '/api/v1/me/sessions/:session_id');

    await expect(route.handler(request({ params: { session_id: SECOND_SESSION_ID } })))
      .resolves.toMatchObject({ status: 404 });
    const result = await route.handler(request({ params: { session_id: SESSION_ID } }));

    expect(result).toMatchObject({
      status: 202,
      body: {
        session_id: SESSION_ID,
        target_replica_id: 'replica-a',
        reason: 'user_requested',
        status: 'accepted',
      },
    });
    await expect(runtimeStore.listPendingCommandsForReplica('replica-a')).resolves.toHaveLength(1);
  });

  it('projects account-admin session metadata without client info or pseudonym', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', '/api/v1/admin/accounts/users/:user_id/sessions');

    const result = await route.handler(request({ params: { user_id: USER_ID } }));
    const sessions = (result.body as { sessions: unknown[] }).sessions;
    const projected = projectRuntimeSessionAccount(sessions[0]);

    expect(projected).toEqual({
      session_id: SESSION_ID,
        transport: RUNTIME_TRANSPORT,
      created_at: NOW.toISOString(),
      last_active_at: NOW.toISOString(),
      status: 'active',
    });
    expect(projected).not.toHaveProperty('client_info');
    expect(projected).not.toHaveProperty('account_correlation_id');
  });

  it('enqueues account-admin single and revoke-all termination commands', async () => {
    const { module, runtimeStore } = await fixture();
    const terminateRoute = findRoute(
      module.routes,
      'DELETE',
      '/api/v1/admin/accounts/users/:user_id/sessions/:session_id',
    );
    const revokeAllRoute = findRoute(
      module.routes,
      'POST',
      '/api/v1/admin/accounts/users/:user_id/sessions/revoke-all',
    );

    await expect(terminateRoute.handler(request({ params: { user_id: USER_ID, session_id: SESSION_ID } })))
      .resolves.toMatchObject({ status: 202, body: { reason: 'admin_terminated' } });
    await expect(revokeAllRoute.handler(request({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({ status: 202, body: { user_id: SECOND_USER_ID, requested: 1 } });

    await expect(runtimeStore.listPendingCommandsForReplica('replica-a')).resolves.toHaveLength(1);
    await expect(runtimeStore.listPendingCommandsForReplica('replica-b')).resolves.toHaveLength(1);
  });

  it('persists the invoking actor for self and account-admin termination commands', async () => {
    const { module, runtimeStore } = await fixture();
    const selfTerminateRoute = findRoute(module.routes, 'DELETE', '/api/v1/me/sessions/:session_id');
    const selfRevokeAllRoute = findRoute(module.routes, 'POST', '/api/v1/me/sessions/revoke-all');
    const adminTerminateRoute = findRoute(
      module.routes,
      'DELETE',
      '/api/v1/admin/accounts/users/:user_id/sessions/:session_id',
    );
    const adminRevokeAllRoute = findRoute(
      module.routes,
      'POST',
      '/api/v1/admin/accounts/users/:user_id/sessions/revoke-all',
    );

    const selfSingle = await selfTerminateRoute.handler(request({ params: { session_id: SESSION_ID } }));
    const selfBulk = await selfRevokeAllRoute.handler(request());
    const adminSingle = await adminTerminateRoute.handler(request({
      params: { user_id: SECOND_USER_ID, session_id: SECOND_SESSION_ID },
    }));
    const adminBulk = await adminRevokeAllRoute.handler(request({ params: { user_id: SECOND_USER_ID } }));

    const commandIds = [selfSingle, selfBulk, adminSingle, adminBulk].map(result =>
      (result.body as { command_id?: string; commands?: Array<{ command_id: string }> }).command_id
        ?? (result.body as { commands: Array<{ command_id: string }> }).commands[0].command_id,
    );
    const commands = await Promise.all(commandIds.map(commandId => runtimeStore.getCommand(commandId)));

    expect(commands.map(command => command?.requestedBy)).toEqual([
      { kind: 'self', userId: USER_ID },
      { kind: 'self', userId: USER_ID },
      { kind: 'admin', userId: USER_ID },
      { kind: 'admin', userId: USER_ID },
    ]);
  });

  it('hides cross-user sessions from account-admin scoped termination', async () => {
    const { module, runtimeStore } = await fixture();
    const terminateRoute = findRoute(
      module.routes,
      'DELETE',
      '/api/v1/admin/accounts/users/:user_id/sessions/:session_id',
    );

    await expect(terminateRoute.handler(request({ params: { user_id: USER_ID, session_id: SECOND_SESSION_ID } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(runtimeStore.listPendingCommandsForReplica('replica-b')).resolves.toEqual([]);
  });

  it('returns an empty bounded revoke-all summary when the user has no active runtime sessions', async () => {
    const runtimeStore = new InMemoryRuntimeSessionControlStore();
    const module = createRuntimeSessionModule({
      runtimeStore,
      accountAdminStore: accountStore(),
      now: () => NOW,
    });
    const revokeAllRoute = findRoute(
      module.routes,
      'POST',
      '/api/v1/admin/accounts/users/:user_id/sessions/revoke-all',
    );

    await expect(revokeAllRoute.handler(request({ params: { user_id: USER_ID } })))
      .resolves.toEqual({
        status: 202,
        body: {
          user_id: USER_ID,
          requested: 0,
          commands: [],
        },
      });
  });

  it('exposes operator pseudonymous projection and operator termination', async () => {
    const { module, runtimeStore } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', OPERATE_SESSIONS_PATH);
    const showRoute = findRoute(module.routes, 'GET', '/api/v1/admin/operate/sessions/:session_id');
    const deleteRoute = findRoute(module.routes, 'DELETE', '/api/v1/admin/operate/sessions/:session_id');

    const list = await listRoute.handler(request());
    const items = (list.body as { items: Array<{ session_id: string }> }).items;
    const target = items.find(session => session.session_id === SESSION_ID);
    const projected = projectRuntimeSessionOperational(target);
    expect(projected).toMatchObject({
      session_id: SESSION_ID,
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      replica_id: 'replica-a',
      request_count: 3,
      error_count: 1,
    });
    expect(projected).not.toHaveProperty('user_id');
    await expect(showRoute.handler(request({ params: { session_id: SESSION_ID } })))
      .resolves.toMatchObject({ status: 200 });
    await expect(deleteRoute.handler(request({ params: { session_id: SESSION_ID } })))
      .resolves.toMatchObject({ status: 202, body: { reason: 'operator_terminated' } });
    await expect(runtimeStore.listPendingCommandsForReplica('replica-a')).resolves.toHaveLength(1);
  });

  it('privacy projectors strip unknown runtime fields at trust boundaries', () => {
    expect(projectRuntimeSessionOperational({
      session_id: SESSION_ID,
      transport: RUNTIME_TRANSPORT,
      created_at: NOW.toISOString(),
      last_active_at: NOW.toISOString(),
      status: 'active',
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      replica_id: 'replica-a',
      request_count: 1,
      error_count: 0,
      lease_until: FIVE_MINUTES.toISOString(),
      client_info: { name: 'client', secret: 'strip' },
      user_id: USER_ID,
      raw_transport: {},
    })).toEqual({
      session_id: SESSION_ID,
      transport: RUNTIME_TRANSPORT,
      created_at: NOW.toISOString(),
      last_active_at: NOW.toISOString(),
      status: 'active',
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      replica_id: 'replica-a',
      request_count: 1,
      error_count: 0,
      lease_until: FIVE_MINUTES.toISOString(),
      client_info: { name: 'client' },
    });
    expect(projectRuntimeTermination({
      session_id: SESSION_ID,
      command_id: 'f7ef8d07-d07d-4ac8-8d50-435fd4c9a300',
      target_replica_id: 'replica-a',
      reason: 'credential_revoked',
      status: 'accepted',
      raw_subject: 'strip',
    })).toEqual({
      session_id: SESSION_ID,
      command_id: 'f7ef8d07-d07d-4ac8-8d50-435fd4c9a300',
      target_replica_id: 'replica-a',
      reason: 'credential_revoked',
      status: 'accepted',
    });
    expect(() => projectRuntimeTermination({
      session_id: SESSION_ID,
      command_id: 'f7ef8d07-d07d-4ac8-8d50-435fd4c9a300',
      target_replica_id: 'replica-a',
      reason: 'unexpected_reason',
      status: 'accepted',
    })).toThrow('unknown reason');
  });

  it('preserves every runtime termination reason without lossy fallback', () => {
    const reasons = [
      'user_requested',
      'admin_disabled',
      'admin_terminated',
      'operator_terminated',
      'credential_revoked',
      'idle_expired',
    ] as const;

    for (const reason of reasons) {
      expect(projectRuntimeTermination({
        session_id: SESSION_ID,
        command_id: 'f7ef8d07-d07d-4ac8-8d50-435fd4c9a300',
        target_replica_id: 'replica-a',
        reason,
        status: 'accepted',
      })).toMatchObject({ reason });
    }
  });

  it('reports operator command status transitioning from pending to acknowledged, and 404s unknown commands', async () => {
    const { module, runtimeStore } = await fixture();
    const route = findRoute(module.routes, 'GET', '/api/v1/admin/operate/sessions/commands/:command_id');

    const command = await runtimeStore.createTerminationCommand({
      sessionId: SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'operator_terminated',
      requestedAt: NOW,
      requestedBy: { kind: 'operator', userId: SECOND_USER_ID },
    });

    await expect(route.handler(request({ params: { command_id: command.commandId } })))
      .resolves.toMatchObject({
        status: 200,
        body: {
          command_id: command.commandId,
          status: 'pending',
          replica_id: null,
          acknowledged_at: null,
        },
      });

    await expect(runtimeStore.acknowledgeCommand({
      commandId: command.commandId,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'terminated',
    })).resolves.toBe(true);

    await expect(route.handler(request({ params: { command_id: command.commandId } })))
      .resolves.toMatchObject({
        status: 200,
        body: {
          command_id: command.commandId,
          status: 'terminated',
          replica_id: 'replica-a',
          acknowledged_at: FIVE_MINUTES.toISOString(),
        },
      });

    await expect(route.handler(request({ params: { command_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('scopes self command status to the requesting user and hides commands requested by others', async () => {
    const { module, runtimeStore } = await fixture();
    const route = findRoute(module.routes, 'GET', '/api/v1/me/sessions/commands/:command_id');

    const ownCommand = await runtimeStore.createTerminationCommand({
      sessionId: SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'user_requested',
      requestedAt: NOW,
      requestedBy: { kind: 'self', userId: USER_ID },
    });
    const foreignCommand = await runtimeStore.createTerminationCommand({
      sessionId: SECOND_SESSION_ID,
      targetReplicaId: 'replica-b',
      reason: 'user_requested',
      requestedAt: NOW,
      requestedBy: { kind: 'self', userId: SECOND_USER_ID },
    });

    // request() authenticates as USER_ID (see the fixture above).
    await expect(route.handler(request({ params: { command_id: ownCommand.commandId } })))
      .resolves.toMatchObject({
        status: 200,
        body: { command_id: ownCommand.commandId, status: 'pending' },
      });
    await expect(route.handler(request({ params: { command_id: foreignCommand.commandId } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(route.handler(request({ params: { command_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('paginates operator session listing via keyset cursor with a deterministic tiebreak', async () => {
    const runtimeStore = new InMemoryRuntimeSessionControlStore();
    await runtimeStore.registerPresence({
      sessionId: 'mcp-session-a',
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    });
    // Same lastActiveAt as mcp-session-a: the (last_active_at DESC, session_id DESC)
    // tiebreaker must place this one first ('b' > 'a').
    await runtimeStore.registerPresence({
      sessionId: 'mcp-session-b',
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    });
    await runtimeStore.registerPresence({
      sessionId: 'mcp-session-c',
      userId: SECOND_USER_ID,
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-b',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: FIVE_MINUTES,
      leaseUntil: new Date(FIVE_MINUTES.getTime() + 300_000),
    });
    const module = createRuntimeSessionModule({
      runtimeStore,
      accountAdminStore: accountStore(),
      now: () => NOW,
    });
    const listRoute = findRoute(module.routes, 'GET', OPERATE_SESSIONS_PATH);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await listRoute.handler(request({ query: { limit: '1', ...(cursor ? { cursor } : {}) } }));
      const body = result.body as {
        items: Array<{ session_id: string }>;
        page: { next_cursor: string | null };
      };
      expect(body.items).toHaveLength(1);
      collected.push(...body.items.map(item => item.session_id));
      if (!body.page.next_cursor) break;
      cursor = body.page.next_cursor;
    }

    // Descending (last_active_at, session_id): c (latest) first, then b before a (tiebreak).
    expect(collected).toEqual(['mcp-session-c', 'mcp-session-b', 'mcp-session-a']);
    expect(new Set(collected).size).toBe(3);
  });

  it('filters operator session listing by user_id and status', async () => {
    const runtimeStore = new InMemoryRuntimeSessionControlStore();
    await runtimeStore.registerPresence({
      sessionId: 'mcp-session-x',
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    });
    await runtimeStore.registerPresence({
      sessionId: 'mcp-session-y',
      userId: SECOND_USER_ID,
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-b',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    });
    await runtimeStore.markPresenceClosing('mcp-session-y', NOW);
    const module = createRuntimeSessionModule({
      runtimeStore,
      accountAdminStore: accountStore(),
      now: () => NOW,
    });
    const listRoute = findRoute(module.routes, 'GET', OPERATE_SESSIONS_PATH);

    const byUser = await listRoute.handler(request({ query: { user_id: USER_ID } }));
    expect((byUser.body as { items: Array<{ session_id: string }> }).items.map(item => item.session_id))
      .toEqual(['mcp-session-x']);

    const byStatusClosing = await listRoute.handler(request({ query: { status: 'closing' } }));
    expect((byStatusClosing.body as { items: Array<{ session_id: string }> }).items.map(item => item.session_id))
      .toEqual(['mcp-session-y']);

    // Default (no status filter) only surfaces active sessions.
    const defaultActive = await listRoute.handler(request());
    expect((defaultActive.body as { items: Array<{ session_id: string }> }).items.map(item => item.session_id))
      .toEqual(['mcp-session-x']);
  });

  it('treats a garbage session-list cursor as the first page rather than erroring', async () => {
    const { module } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', OPERATE_SESSIONS_PATH);

    const result = await listRoute.handler(request({ query: { cursor: 'not-a-real-cursor', limit: '10' } }));
    expect(result.status).toBe(200);
    const body = result.body as { items: Array<{ session_id: string }> };
    expect(body.items.map(item => item.session_id).sort((a, b) => a.localeCompare(b)))
      .toEqual([SECOND_SESSION_ID, SESSION_ID].sort((a, b) => a.localeCompare(b)));
  });

  it('rejects a non-UUID user_id filter with a 400 rather than reaching the store', async () => {
    const { module } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', OPERATE_SESSIONS_PATH);

    const result = await listRoute.handler(request({ query: { user_id: 'not-a-uuid' } }));
    expect(result.status).toBe(400);
    expect((result.body as { code: string }).code).toBe('invalid_request');
  });
});
