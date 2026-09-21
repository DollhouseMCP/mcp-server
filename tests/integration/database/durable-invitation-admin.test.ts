import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { invitationAdminBody, invitationAdminHarness, invitationAuditKey } from '../../helpers/web-console/durableInvitationAdmin.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresIdempotencyStore } from '../../../src/web-console/stores/PostgresIdempotencyStore.js';
import { PostgresAdminAuditWriter } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import { createDurableInvitationAdminAuditFactory } from '../../../src/web-console/modules/account-admin/DurableInvitationAdminAudit.js';
import { parseInvitationToken, hashInvitationCredential } from '../../../src/invitations/InvitationToken.js';
import { users } from '../../../src/database/schema/users.js';
import { accountInvitations, accountInvitationGenerations } from '../../../src/database/schema/invitations.js';
import { adminAuditEvents } from '../../../src/database/schema/webConsole.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const actorId = randomUUID();
const keyResolver = { resolve: async () => invitationAuditKey };
let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL is unavailable');
  if (!available) return;
  await getTestAdminDb().insert(users).values({ id: actorId, username: `durable-admin-${actorId}` });
});
afterAll(closeTestDb);
const harness = () => invitationAdminHarness({ store: new PostgresInvitationManagementStore(getTestAdminDb()),
  auditWriter: new PostgresAdminAuditWriter(getTestAdminDb(), keyResolver) }, 'admin', true, actorId, new PostgresIdempotencyStore(getTestAdminDb()));
const tokenFrom = (link: string) => new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;

it('issues, inspects, regenerates and revokes through the secured service with same-TX audit and no durable raw credential', async () => {
  if (!available) return;
  const h = await harness(); const body = invitationAdminBody(); const key = randomUUID();
  const issued = await h.send('post', '', body, { 'Idempotency-Key': key });
  expect(issued.status).toBe(201);
  const id = issued.body.invitation.id as string;
  const token = tokenFrom(issued.body.claim_url);
  const parsed = parseInvitationToken(token);
  try {
    const [generation] = await getTestAdminDb().select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, id));
    expect(generation.credentialHash).toEqual(hashInvitationCredential(parsed, body.email.toLowerCase(), generation.expiresAt));
  } finally { parsed.secret.fill(0); }
  expect((await h.send('get', `/${id}`)).body).not.toHaveProperty('claim_url');
  // Same-key repeat is a real conflict, not a replay of the one-time link.
  const duplicate = await h.send('post', '', body, { 'Idempotency-Key': key });
  expect(duplicate.status).toBe(409); expect(duplicate.text).not.toContain(token);
  const fresh = await h.send('post', `/${id}/regenerate`, { ttl_hours: 1 }, { 'Idempotency-Key': key });
  expect(fresh.status).toBe(200); expect(fresh.body.invitation.generation).toBe(2);
  expect(fresh.body.claim_url).not.toBe(issued.body.claim_url);
  expect((await h.send('post', `/${id}/revoke`, {})).body.invitation.state).toBe('revoked');
  expect((await h.send('post', `/${id}/revoke`, {})).status).toBe(200);
  const [account] = await getTestAdminDb().select().from(users).where(eq(users.id, issued.body.invitation.user_id));
  expect(account.activationState).toBe('pending_activation');
  expect(account.displayName).toBe('Renée Example');
  const adminEvents = await getTestAdminDb().select().from(adminAuditEvents).where(eq(adminAuditEvents.resourceId, id));
  expect(adminEvents.map(event => event.operation)).toEqual(['invitation.issued', 'invitation.regenerated', 'invitation.revoked']);
  expect(adminEvents.every(event => event.actorUserId === actorId && event.capability === 'console:admin:accounts')).toBe(true);
  const durable = JSON.stringify({ account, adminEvents,
    invitations: await getTestAdminDb().select().from(accountInvitations).where(eq(accountInvitations.id, id)),
    generations: await getTestAdminDb().select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, id)),
    security: await getTestAdminDb().execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${id}`),
    idempotency: await getTestAdminDb().execute(sql`SELECT * FROM idempotency_records WHERE idempotency_key = ${key}`) });
  for (const secret of [token, token.split('.')[3], tokenFrom(fresh.body.claim_url)]) expect(durable).not.toContain(secret);
  expect(await getTestAdminDb().execute(sql`SELECT * FROM idempotency_records WHERE idempotency_key = ${key}`)).toHaveLength(0);
});

it('rolls back account, invitation, generation and both audits if the transaction-scoped admin append fails', async () => {
  if (!available) return;
  const realFactory = createDurableInvitationAdminAuditFactory(keyResolver);
  const h = await invitationAdminHarness({ store: new PostgresInvitationManagementStore(getTestAdminDb()),
    auditWriter: new PostgresAdminAuditWriter(getTestAdminDb(), keyResolver),
    auditFactory: async (req, route) => {
      const audit = await realFactory(req, route);
      return { ...audit, appendAdminEvent: async (tx, event) => {
        await audit.appendAdminEvent(tx, event); throw new Error('sensitive audit failure detail');
      } };
    } }, 'admin', true, actorId, new PostgresIdempotencyStore(getTestAdminDb()));
  const body = invitationAdminBody(); const correlationId = randomUUID();
  const failed = await h.send('post', '', body, { 'X-Correlation-ID': correlationId });
  expect(failed.status).toBe(503); expect(failed.body).not.toHaveProperty('claim_url');
  expect(failed.text).not.toContain('sensitive');
  expect(await getTestAdminDb().select().from(users).where(eq(users.username, body.username))).toHaveLength(0);
  expect(await getTestAdminDb().select().from(accountInvitations).where(eq(accountInvitations.correlationId, correlationId))).toHaveLength(0);
  expect(await getTestAdminDb().execute(sql`SELECT * FROM security_audit_events WHERE metadata->>'correlationId' = ${correlationId}`)).toHaveLength(0);
  const events = await getTestAdminDb().select().from(adminAuditEvents).where(eq(adminAuditEvents.correlationId, correlationId));
  expect(events).toHaveLength(1); expect(events[0].result).toBe('failed');
  expect(events[0].operation).toBe('invitation.admin.issue');
});
