import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { eq } from 'drizzle-orm';
import { withSystemContext } from '../../../src/database/admin.js';
import { deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { users } from '../../../src/database/schema/users.js';
import { accountInvitations, accountInvitationGenerations } from '../../../src/database/schema/invitations.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresAdminAuditWriter } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import { invitationAdminBody, invitationAdminHarness, invitationAuditKey } from '../../helpers/web-console/durableInvitationAdmin.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

let available = false;
const actorId = randomUUID();
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
  if (available) await getTestAdminDb().insert(users).values({ id: actorId, username: `lookup-admin-${actorId}` });
});
afterAll(closeTestDb);
const options = () => ({ store: new PostgresInvitationManagementStore(getTestAdminDb()),
  auditWriter: new PostgresAdminAuditWriter(getTestAdminDb(), { resolve: async () => invitationAuditKey }) });
type Harness = Awaited<ReturnType<typeof invitationAdminHarness>>;
const lookup = (h: Harness, id: string) => request(h.app).get(`/api/v1/admin/accounts/users/${id}/invitation`)
  .set('Origin', 'https://console.example.test').set('X-Console-Request', '1').set('Cookie', ['dh_session=session', 'dh_csrf=csrf']);

it('finds the selected account current generation without a claim link, history or domain mutation', async () => {
  if (!available) return;
  const h = await invitationAdminHarness(options(), 'admin', true, actorId);
  const issued = await h.send('post', '', invitationAdminBody());
  expect(issued.status).toBe(201);
  const { id, user_id: userId } = issued.body.invitation;
  expect((await h.send('post', `/${id}/regenerate`, {})).status).toBe(200);
  const before = await options().store.inspect(id);
  const response = await lookup(h, userId);
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(Object.keys(response.body)).toEqual(['invitation']);
  expect(response.body.invitation).toMatchObject({ id, user_id: userId, generation: 2 });
  for (const field of ['credential', 'credentialHash', 'claim_url', 'delivery', 'attempts', 'audit']) expect(response.body).not.toHaveProperty(field);
  expect(response.text).not.toContain(issued.body.claim_url);
  expect(await options().store.inspect(id)).toEqual(before);
});

it('uses the same neutral absence result and enforces authenticated admin elevation and stored role ceilings', async () => {
  if (!available) return;
  const h = await invitationAdminHarness(options(), 'admin', true, actorId);
  const absentAccount = await lookup(h, randomUUID());
  const noInvitation = await lookup(h, actorId);
  expect(absentAccount.status).toBe(404); expect(noInvitation.status).toBe(404);
  expect(absentAccount.body).toEqual(noInvitation.body);
  expect((await lookup(h, 'not-a-uuid')).status).toBe(400);
  const issued = await h.send('post', '', { ...invitationAdminBody(), intended_roles: ['admin'] });
  expect(issued.status).toBe(201);
  const id = issued.body.invitation.user_id;
  expect((await lookup(h, id).unset('Cookie')).status).toBe(401);
  expect((await lookup(await invitationAdminHarness(options(), 'operator', true, actorId), id)).status).toBe(401);
  expect((await lookup(await invitationAdminHarness(options(), 'admin', false, actorId), id)).status).toBe(401);
  const lower = await lookup(await invitationAdminHarness(options(), 'account_admin', true, actorId), id);
  expect(lower.status).toBe(403); expect(lower.body).not.toHaveProperty('invitation');
  expect(lower.text).not.toContain(issued.body.invitation.email);
  expect((await lookup(h, id).query({ email: 'injected@example.test' })).status).toBe(400);
});

it('selects the newest invitation deterministically when an account has terminal history', async () => {
  if (!available) return;
  const db = getTestAdminDb(), h = await invitationAdminHarness(options(), 'admin', true, actorId);
  const issued = await h.send('post', '', invitationAdminBody());
  expect(issued.status).toBe(201);
  const id = issued.body.invitation.id;
  expect((await h.send('post', `/${id}/revoke`, {})).status).toBe(200);
  const [original] = await db.select().from(accountInvitations).where(eq(accountInvitations.id, id));
  const [generation] = await db.select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, id));
  // Terminal-history rows are schema-valid, even though today's issuance service
  // always creates a new account. Equal creation times exercise the stable ID tie-break.
  const createdAt = new Date(original.createdAt.getTime() + 1000);
  const ids = [randomUUID(), randomUUID()].sort();
  for (const historicalId of ids) {
    await db.insert(accountInvitations).values({ ...original, id: historicalId, createdAt, updatedAt: createdAt });
    await db.insert(accountInvitationGenerations).values({ ...generation, invitationId: historicalId, credentialHash: randomBytes(32) });
  }
  const response = await lookup(h, original.userId);
  expect(response.status).toBe(200);
  expect(response.body.invitation.id).toBe(ids[1]); expect(response.body.invitation.state).toBe('revoked');
  expect(Object.keys(response.body)).toEqual(['invitation']);
});

it('keeps deleted account tombstones unavailable through the actual deletion path', async () => {
  if (!available) return;
  const db = getTestAdminDb(), h = await invitationAdminHarness(options(), 'admin', true, actorId);
  const issued = await h.send('post', '', invitationAdminBody());
  expect(issued.status).toBe(201);
  const userId = issued.body.invitation.user_id;
  expect((await lookup(h, userId)).status).toBe(200);
  const deleted = await withSystemContext(db, tx => deleteConsolePrincipalWithTx(tx, { userId, deletedByUserId: actorId, deletedAt: new Date() }));
  expect(deleted).toMatchObject({ outcome: 'anonymized' });
  const retained = await db.select().from(accountInvitations).where(eq(accountInvitations.userId, userId));
  expect(retained).toHaveLength(1);
  const response = await lookup(h, userId), absent = await lookup(h, randomUUID());
  expect(response.status).toBe(404); expect(response.body).toEqual(absent.body);
  expect(response.body).not.toHaveProperty('invitation');
  expect(await options().store.inspectForUser(userId)).toBeNull();
});

it('returns one coherent pre-deletion snapshot when real deletion commits after its read', async () => {
  if (!available) return;
  const db = getTestAdminDb(), h = await invitationAdminHarness(options(), 'admin', true, actorId);
  const issued = await h.send('post', '', invitationAdminBody()); expect(issued.status).toBe(201);
  const expected = await options().store.inspect(issued.body.invitation.id);
  let reads = 0;
  // Interpose only after actual SQL completion, before its caller continues.
  // The former two-query implementation returned redacted metadata here.
  const observed = observeReads(db, async () => {
    if (++reads !== 1) return;
    expect(await withSystemContext(db, tx => deleteConsolePrincipalWithTx(tx, {
      userId: issued.body.invitation.user_id, deletedByUserId: actorId, deletedAt: new Date(),
    }))).toMatchObject({ outcome: 'anonymized' });
  });
  const snapshot = await new PostgresInvitationManagementStore(observed).inspectForUser(issued.body.invitation.user_id);
  expect(snapshot).toEqual(expected); expect(reads).toBe(1);
  expect(await options().store.inspectForUser(issued.body.invitation.user_id)).toBeNull();
});

/** Preserve real PostgreSQL execution while controlling the statement-return boundary. */
function observeReads(db: DatabaseInstance, afterRead: () => Promise<void>): DatabaseInstance {
  const query = (value: any): any => new Proxy(value, { get(target, key) {
    const member = Reflect.get(target, key);
    if (key === 'then') return (resolve: any, reject: any) => member.call(target,
      async (rows: unknown) => { await afterRead(); return rows; }).then(resolve, reject);
    return typeof member !== 'function' ? member : (...args: unknown[]) => {
      const result = Reflect.apply(member, target, args);
      return result && typeof result.then === 'function' ? query(result) : result;
    };
  } });
  return new Proxy(db, { get(target, key) {
    if (key !== 'transaction') return Reflect.get(target, key);
    return (operation: (tx: DrizzleTx) => Promise<unknown>) => db.transaction(tx => operation(new Proxy(tx, {
      get(transaction, property) {
        if (property !== 'select') return Reflect.get(transaction, property);
        return (...args: unknown[]) => query(Reflect.apply(transaction.select, transaction, args));
      },
    })));
  } });
}
