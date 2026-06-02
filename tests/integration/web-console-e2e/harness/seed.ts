import { randomBytes, randomUUID } from 'node:crypto';

import argon2 from 'argon2';

import { db } from './pg.js';
import type { SeededPrincipal } from './forgeSession.js';

export interface SeededUser extends SeededPrincipal {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

export interface SeededWorld {
  /** A normal console user (no admin roles). */
  readonly userA: SeededUser;
  /** A second normal user — for cross-user isolation tests. */
  readonly userB: SeededUser;
  /** A full admin (auth_accounts.roles=['admin'] + active user_admin_roles). */
  readonly admin: SeededUser;
}

/** Shared password for all seeded principals (used by the real-login Playwright spec). */
export const SEED_PASSWORD = 'E2eConsole#2026!';

function principalFor(username: string): { sub: string; email: string } {
  return { sub: `local_${username}`, email: `${username}@e2e.dollhouse.local` };
}

/**
 * Wipe and recreate the e2e principals (idempotent). Creates `users`,
 * `auth_accounts` (local-password), and an active admin `user_admin_roles` row
 * for the admin. Returns the principals with their real `sub`s for forging.
 */
export async function seedWorld(): Promise<SeededWorld> {
  const sql = db();
  const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });
  const now = new Date();

  // Clean slate. Volatile event/audit/session tables accumulate per run and
  // hold RESTRICT foreign keys back to users (e.g. admin_audit_events.actor_user_id,
  // user_admin_roles.granted_by_user_id) that would block deleting the seed
  // users. They are pure test data on this isolated DB, so truncate them first.
  // (TRUNCATE ... CASCADE also clears anything transitively referencing them.)
  const VOLATILE_TABLES = [
    'admin_audit_events', 'admin_audit_chain_heads', 'approval_audit_events', 'security_audit_events',
    'security_invalidation_events', 'security_invalidation_acks',
    'session_activity_events', 'session_activation_events', 'session_activation_records',
    'runtime_session_presence', 'runtime_control_commands', 'runtime_control_acks',
    'console_sessions', 'console_login_transactions', 'idempotency_records',
    'user_admin_roles', 'user_integrations', 'portfolio_sync_jobs', 'user_settings',
    'account_factors', 'account_factor_backup_codes', 'account_allowlist_entries',
    'agent_states', 'elements', 'sessions',
  ];
  for (const table of VOLATILE_TABLES) {
    await sql.unsafe(`TRUNCATE TABLE ${table} CASCADE`).catch(() => { /* table may not exist */ });
  }
  // auth_accounts first (user_id is ON DELETE SET NULL, so it would orphan
  // otherwise), then the seed users. Match ALL e2e_* principals (prefix), not
  // just the three fixed ones — invite tests create persistent users like
  // `e2e_newinvitee` that must be cleaned between runs or the next invite for the
  // same username makes the issuer fail (503 "Account invite issuer failed").
  await sql`DELETE FROM auth_accounts WHERE sub LIKE 'local_e2e_%' OR external_sub LIKE 'e2e\_%' ESCAPE '\'`;
  await sql`DELETE FROM users WHERE username LIKE 'e2e\_%' ESCAPE '\'`;

  async function create(username: string, roles: string[]): Promise<SeededUser> {
    const { sub, email } = principalFor(username);
    const id = randomUUID();
    await sql`
      INSERT INTO users (id, username, email, display_name, created_at, updated_at, authz_version, account_correlation_id)
      VALUES (${id}, ${username}, ${email}, ${username}, ${now}, ${now}, 1, ${randomUUID()})
    `;
    await sql`
      INSERT INTO auth_accounts
        (provider, external_sub, sub, user_id, email, email_verified, display_name, password_hash, roles, created_at, updated_at)
      VALUES ('local', ${username}, ${sub}, ${id}, ${email}, true, ${username}, ${passwordHash}, ${sql.json(roles)}, ${now}, ${now})
    `;
    if (roles.includes('admin')) {
      await sql`
        INSERT INTO user_admin_roles (user_id, role, granted_at)
        VALUES (${id}, 'admin', ${now})
      `;
    }
    return { id, sub, username, email, password: SEED_PASSWORD };
  }

  const userA = await create('e2e_user_a', []);
  const userB = await create('e2e_user_b', []);
  const admin = await create('e2e_admin', ['admin']);

  // Mark the embedded auth server as bootstrapped (first admin claimed). Without
  // this, auth-server-touching admin ops (sign-in allowlist, invite) fail closed
  // with 503 bootstrap_required. Mirrors PostgresAuthStorageLayer.markBootstrapComplete.
  await sql`
    INSERT INTO auth_kv (model, id, payload, expires_at)
    VALUES ('AuthBootstrap', 'state',
      ${sql.json({ completed: true, adminSub: admin.sub, adminMethod: 'local-password', completedAt: now.getTime() })},
      NULL)
    ON CONFLICT (model, id) DO UPDATE SET payload = EXCLUDED.payload
  `;

  return { userA, userB, admin };
}

/**
 * Seed an active MCP runtime session (presence) for a principal plus a handful of
 * activity events, so the session-info, logs, metrics, and their SSE streams have
 * real data to return. Returns the session id. Call after seedWorld().
 */
export async function seedRuntimeSession(
  principal: SeededPrincipal,
  sessionId = `e2e-sess-${principal.id.slice(0, 8)}`,
): Promise<string> {
  const sql = db();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 3600e3);

  await sql`DELETE FROM runtime_session_presence WHERE session_id = ${sessionId}`;
  await sql`
    INSERT INTO runtime_session_presence
      (session_id, user_id, account_correlation_id, replica_id, transport, client_name, client_version,
       started_at, last_active_at, request_count, error_count, lease_until, status, closed_at)
    VALUES
      (${sessionId}, ${principal.id}, ${randomUUID()}, 'e2e-replica', 'streamable-http', 'e2e-client', '1.0.0',
       ${now}, ${now}, 5, 1, ${leaseUntil}, 'active', NULL)
  `;

  const events: ReadonlyArray<[string, string, string, string, string | null]> = [
    ['info', 'mcp', 'tool.call', 'listed elements', null],
    ['info', 'mcp', 'tool.call', 'activated persona', null],
    ['warn', 'security', 'policy.check', 'approval required', null],
    ['error', 'mcp', 'tool.call', 'tool failed', 'E_TOOL_FAILED'],
  ];
  for (const [level, subsystem, event, message, stableErrorCode] of events) {
    await sql`
      INSERT INTO session_activity_events
        (user_id, session_id, occurred_at, level, subsystem, event, message, correlation_id, stable_error_code)
      VALUES (${principal.id}, ${sessionId}, ${now}, ${level}, ${subsystem}, ${event}, ${message},
              ${randomUUID()}, ${stableErrorCode})
    `;
  }
  return sessionId;
}

/**
 * Seed a completed agent execution (one goal) for a session so the executions
 * list/detail/stream endpoints have data. Reads come from `agent_states` joined
 * to `elements` (PostgresSessionExecutionReader). Returns the goal id.
 */
export async function seedAgentExecution(
  principal: SeededPrincipal,
  sessionId: string,
): Promise<string> {
  const sql = db();
  const now = new Date();
  const agentId = randomUUID();
  const goalId = `goal-${randomUUID().slice(0, 8)}`;
  const raw = '---\nname: e2e-agent\ntype: agents\n---\nE2E agent.';
  await sql`
    INSERT INTO elements (id, user_id, raw_content, content_hash, byte_size, element_type, name, metadata, visibility, created_at, updated_at)
    VALUES (${agentId}, ${principal.id}, ${raw}, ${randomBytes(32).toString('hex')}, ${Buffer.byteLength(raw)},
            'agents', ${`e2e-agent-${goalId}`}, ${sql.json({})}, 'private', ${now}, ${now})
  `;
  await sql`
    INSERT INTO agent_states (agent_id, user_id, session_id, goals, decisions, context, last_active, session_count)
    VALUES (${agentId}, ${principal.id}, ${sessionId},
      ${sql.json([{ id: goalId, description: 'e2e goal', status: 'completed', createdAt: now.toISOString(), updatedAt: now.toISOString(), completedAt: now.toISOString() }])},
      ${sql.json([{ goalId, timestamp: now.toISOString(), decision: 'completed step', reasoning: 'e2e', outcome: 'ok' }])},
      ${sql.json({})}, ${now}, 1)
  `;
  return goalId;
}

/**
 * Seed a single pending CLI approval into the legacy `sessions` row (cli_approvals
 * is a JSONB array of [requestId, record] entries, per DatabaseConfirmationStore).
 * Returns the approval id (= requestId, format cli-<uuid>).
 */
export async function seedPendingApproval(
  principal: SeededPrincipal,
  sessionId: string,
): Promise<string> {
  const sql = db();
  const requestId = `cli-${randomUUID()}`;
  const record = {
    requestId,
    toolName: 'mcp_aql_execute',
    toolInputDigest: { op: 'e2e' },
    toolInputHash: `web-console-e2e-v1:${randomBytes(32).toString('hex')}`,
    riskLevel: 'high',
    riskScore: 80,
    irreversible: true,
    requestedAt: new Date().toISOString(),
    consumed: false,
    scope: 'single',
    denyReason: 'approval required',
    ttlMs: 300_000,
  };
  await sql`
    INSERT INTO sessions (user_id, session_id, cli_approvals)
    VALUES (${principal.id}, ${sessionId}, ${sql.json([[requestId, record]])})
    ON CONFLICT (user_id, session_id)
      DO UPDATE SET cli_approvals = EXCLUDED.cli_approvals
  `;
  return requestId;
}
