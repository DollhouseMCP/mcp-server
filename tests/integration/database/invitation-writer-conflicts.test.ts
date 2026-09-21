import { randomBytes, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { eq, sql } from 'drizzle-orm';
import { createDatabaseConnection, type DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { users } from '../../../src/database/schema/users.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { normalizeAuthAllowlistValue } from '../../../src/auth/embedded-as/allowlistIdentity.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { InMemorySigningKeyStore } from '../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import { PostgresConsoleAccountInviteIssuer } from '../../../src/web-console/modules/account-admin/PostgresConsoleAccountInviteIssuer.js';
import { ConsoleStoreConflictError } from '../../../src/web-console/stores/ConsoleStoreValidation.js';
import { closeTestDb, isDatabaseAvailable, TEST_DB_ADMIN_URL } from './test-db-helpers.js';

const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
let connection: ReturnType<typeof createDatabaseConnection>;
let available = false;
const actorUserId = randomUUID();
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
  if (!available) return;
  connection = createDatabaseConnection({ connectionUrl: TEST_DB_ADMIN_URL, poolSize: 4, ssl: 'disable' });
  await connection.db.insert(users).values({ id: actorUserId, username: `conflict-admin-${actorUserId}` });
});
afterAll(async () => { await connection?.close(); await closeTestDb(); });

function fixture() {
  const id = randomUUID();
  const email = `CAFÉ-${id}@Example.test`;
  const durable = { invitationId: id, userId: randomUUID(), username: `durable-${id}`, displayName: 'Durable',
    emailOriginal: email, emailNormalized: normalizeAuthAllowlistValue('email', email), inviterUserId: actorUserId,
    intendedRoles: ['operator'] as const, generation: 1 as const, credentialSecret: randomBytes(32), ttlHours: 24, correlationId: randomUUID() };
  const legacy = { username: `legacy-${id}`, displayName: 'Legacy', email: email.normalize('NFD').toLowerCase(),
    actorUserId, ttlMinutes: 15, roles: ['operator'] as const, issuedAt: new Date() };
  return { durable, legacy };
}
function issueDurable(db: DatabaseInstance, input: ReturnType<typeof fixture>['durable']) {
  return new PostgresInvitationManagementStore(db).runMutation(audit, mutation => mutation.issue(input));
}
function issueLegacy(db: DatabaseInstance, input: ReturnType<typeof fixture>['legacy'], signingKeyStore = new InMemorySigningKeyStore()) {
  return new PostgresConsoleAccountInviteIssuer({ db, signingKeyStore,
    publicBaseUrl: 'https://console.example.test' }).issueInvite(input);
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
// Keep the actual writer and every SQL statement intact. Only pause its real
// transaction after the callback, before COMMIT, to force both write orders.
function observedDb(onStart: (pid: number) => void, beforeCommit?: () => Promise<void>): DatabaseInstance {
  return { transaction: (callback: (tx: DrizzleTx) => Promise<unknown>) => connection.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    onStart(Number(row.pid));
    const result = await callback(tx);
    await beforeCommit?.();
    return result;
  }) } as DatabaseInstance;
}
async function expectBlockedOnUsers(pid: number) {
  for (let i = 0; i < 200; i++) {
    const rows = await connection.db.execute(sql`SELECT 1 FROM pg_locks
      WHERE pid = ${pid} AND relation = 'users'::regclass AND NOT granted`);
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Competing invitation writer never waited for users');
}

it.each(['durable', 'legacy'] as const)('rejects the other actual invitation writer after %s commits its canonical email', async first => {
  if (!available) return;
  const f = fixture();
  const ready = deferred();
  const release = deferred();
  const loserPid = deferred<number>();
  const winnerDb = observedDb(() => {}, async () => { ready.resolve(); await release.promise; });
  const loserDb = observedDb(pid => loserPid.resolve(pid));
  const winner = first === 'durable' ? issueDurable(winnerDb, f.durable) : issueLegacy(winnerDb, f.legacy);
  await ready.promise;
  const loser = (first === 'durable' ? issueLegacy(loserDb, f.legacy) : issueDurable(loserDb, f.durable)).catch(error => error);
  try { await expectBlockedOnUsers(await loserPid.promise); }
  finally { release.resolve(); }
  await winner;
  const error = await loser;
  if (first === 'durable') expect(error).toBeInstanceOf(ConsoleStoreConflictError);
  else expect(error).toMatchObject({ code: 'invitation_conflict' });
  const matching = (await connection.db.select().from(users)).filter(row => row.email !== null &&
    normalizeAuthAllowlistValue('email', row.email) === f.durable.emailNormalized);
  expect(matching).toHaveLength(1);
  expect(matching[0].username).toBe(first === 'durable' ? f.durable.username : f.legacy.username);
  const state = await connection.db.execute(sql`SELECT
    (SELECT count(*) FROM users WHERE username = ${first === 'durable' ? f.legacy.username : f.durable.username})::int AS loser_users,
    (SELECT count(*) FROM auth_accounts WHERE sub = ${`local_${f.legacy.username}`})::int AS identities,
    (SELECT count(*) FROM user_admin_roles WHERE user_id = ${matching[0].id}::uuid)::int AS roles,
    (SELECT count(*) FROM account_invitations WHERE id = ${f.durable.invitationId}::uuid)::int AS invitations,
    (SELECT count(*) FROM account_invitation_generations WHERE invitation_id = ${f.durable.invitationId}::uuid)::int AS generations,
    (SELECT count(*) FROM security_audit_events WHERE target_id = ${f.durable.invitationId})::int AS audits`);
  expect(state[0]).toEqual(first === 'durable'
    ? { loser_users: 0, identities: 0, roles: 0, invitations: 1, generations: 1, audits: 1 }
    : { loser_users: 0, identities: 1, roles: 1, invitations: 0, generations: 0, audits: 0 });
});

it.each(['auth_accounts', 'user_admin_roles', 'admin_audit_chain_heads'] as const)('fails without partial creation when a downstream %s writer precedes its users FK check', async table => {
  if (!available) return;
  const f = fixture();
  await connection.db.transaction(async writer => {
    // Match a downstream writer before its later users FK access. A blocking
    // issuer would wait here while holding users, preventing that FK access.
    await writer.execute(sql.raw(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`));
    await expect(issueLegacy(observedDb(() => {}), f.legacy)).rejects.toEqual(
      new ConsoleStoreConflictError('Account creation conflicted with another operation. Please retry.'));
    await writer.select().from(users).where(eq(users.id, actorUserId)).for('key share');
  });
  expect(await connection.db.select().from(users).where(eq(users.username, f.legacy.username))).toHaveLength(0);
  expect(await connection.db.execute(sql`SELECT sub FROM auth_accounts WHERE sub = ${`local_${f.legacy.username}`}`)).toHaveLength(0);
  expect((await issueLegacy(connection.db, f.legacy)).userId).toEqual(expect.any(String));
});

it.each(['durable', 'legacy'] as const)('compares older stored username encodings canonically in the %s writer', async kind => {
  if (!available) return;
  const f = fixture();
  const username = `${kind === 'durable' ? 'CAFE' : 'café'}-${randomUUID()}`;
  await connection.db.insert(users).values({ username: ` ${username.normalize('NFD').toUpperCase()} ` });
  const pending = kind === 'durable'
    ? issueDurable(connection.db, { ...f.durable, username })
    : issueLegacy(connection.db, { ...f.legacy, username });
  if (kind === 'durable') await expect(pending).rejects.toMatchObject({ code: 'invitation_conflict' });
  else await expect(pending).rejects.toBeInstanceOf(ConsoleStoreConflictError);
  expect(await connection.db.select().from(users).where(eq(users.username, username))).toHaveLength(0);
});


it('starts the legacy credential lifetime after a users lock wait longer than its requested TTL', async () => {
  if (!available) return;
  const f = fixture();
  const signingKeyStore = new InMemorySigningKeyStore();
  const startedAt = Date.now();
  const afterWait = startedAt + 16 * 60_000;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(startedAt);
  const pid = deferred<number>();
  let pending: ReturnType<typeof issueLegacy> | undefined;
  try {
    await connection.db.transaction(async blocker => {
      await blocker.select().from(users).where(eq(users.id, actorUserId)).for('update');
      pending = issueLegacy(observedDb(value => pid.resolve(value)), f.legacy, signingKeyStore);
      await expectBlockedOnUsers(await pid.promise);
      // Model elapsed wall time while the actual writer is blocked in PostgreSQL.
      // The old implementation minted at startedAt and returned an expired token.
      clock.mockReturnValue(afterWait);
    });
    const result = await pending!;
    expect(result.expiresAt.getTime()).toBe(afterWait + f.legacy.ttlMinutes * 60_000);
    const key = await signingKeyStore.getActive('invite');
    const verifier = new InviteTokenStore(Buffer.from(String(key!.payload.secret), 'base64'));
    const token = new URL(result.inviteUrl).searchParams.get('invite')!;
    expect(verifier.verify(token)).toMatchObject({ ok: true, payload: { sub: result.primarySub } });
  } finally { clock.mockRestore(); }
});
