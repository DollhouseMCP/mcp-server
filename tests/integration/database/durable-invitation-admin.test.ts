import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { InvitationDeliveryService } from '../../../src/invitations/InvitationDeliveryService.js';
import { PostgresInvitationDeliveryStore } from '../../../src/invitations/PostgresInvitationDeliveryStore.js';
import type { IInvitationDeliveryStore } from '../../../src/invitations/IInvitationDeliveryStore.js';
import type { TransactionalEmailSender } from '../../../src/auth/embedded-as/methods/TransactionalEmailSender.js';
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

it.each(['submitted', 'failed', 'unknown', 'reservation_failure', 'result_failure', 'not_configured'] as const)(
  'preserves immediate issuance with real audit/ledger and %s fake SMTP outcome', async behavior => {
    if (!available) return;
    const backing = new PostgresInvitationDeliveryStore(getTestAdminDb());
    let operations = 0;
    const storage: IInvitationDeliveryStore = { list: async () => { throw new Error('Unexpected history scan'); },
      runMutation: async (audit, operation) => {
        operations++;
        if (behavior === 'reservation_failure' || (behavior === 'result_failure' && operations === 2)) {
          throw new Error('private database details');
        }
        return backing.runMutation(audit, operation);
      } };
    const sendTransactionalEmail = jest.fn<TransactionalEmailSender['sendTransactionalEmail']>(async message => {
      // The reservation is committed and visible before the single fake send.
      const token = message.text.match(/dhi1\.[A-Za-z0-9_-]+\.1\.[A-Za-z0-9_-]+/)![0];
      const parsed = parseInvitationToken(token);
      try { expect((await backing.list(parsed.invitationId))[0].state).toBe('submitting'); }
      finally { parsed.secret.fill(0); }
      return behavior === 'failed' ? { state: 'failed', failureClass: 'rejected' } :
        behavior === 'unknown' ? { state: 'unknown', failureClass: 'indeterminate' } : { state: 'submitted', providerMessageId: null };
    });
    const delivery = new InvitationDeliveryService(storage, behavior === 'not_configured' ? null : { sendTransactionalEmail }, {
      publicBaseUrl: 'https://console.example.test', supportEmail: 'support@example.test',
      describeRole: () => ({ name: 'Operations', description: 'Manage operational work.' }),
    });
    const h = await invitationAdminHarness({ store: new PostgresInvitationManagementStore(getTestAdminDb()), delivery,
      auditWriter: new PostgresAdminAuditWriter(getTestAdminDb(), keyResolver) }, 'admin', true, actorId, new PostgresIdempotencyStore(getTestAdminDb()));
    const key = randomUUID();
    const issued = await h.send('post', '', invitationAdminBody(), { 'Idempotency-Key': key });
    expect(issued.status).toBe(201);
    const id = issued.body.invitation.id as string;
    const token = tokenFrom(issued.body.claim_url);
    const expected = behavior === 'reservation_failure' ? { status: 'unavailable', state: 'unknown' } :
      behavior === 'result_failure' ? { status: 'uncertain', state: 'unknown', last_known_state: 'submitting' } :
        behavior === 'not_configured' ? { status: 'manual_fallback', state: 'not_attempted', reason: 'not_configured' } :
          { status: 'recorded', state: behavior };
    expect(issued.body.delivery).toEqual(expected);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(['reservation_failure', 'not_configured'].includes(behavior) ? 0 : 1);
    const inspected = await h.send('get', `/${id}`);
    expect(inspected.status).toBe(200); expect(inspected.body).not.toHaveProperty('claim_url');
    expect(inspected.body).not.toHaveProperty('delivery');
    const attempts = await backing.list(id);
    expect(attempts).toHaveLength(['reservation_failure', 'not_configured'].includes(behavior) ? 0 : 1);
    if (attempts.length) expect(attempts[0].state).toBe(behavior === 'result_failure' ? 'submitting' : behavior);
    const generations = await getTestAdminDb().select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, id));
    const parsed = parseInvitationToken(token);
    try { expect(generations[0].credentialHash).toEqual(hashInvitationCredential(parsed, issued.body.invitation.email.toLowerCase(), generations[0].expiresAt)); }
    finally { parsed.secret.fill(0); }
    const durable = JSON.stringify({ attempts, generations,
      admin: await getTestAdminDb().select().from(adminAuditEvents).where(eq(adminAuditEvents.resourceId, id)),
      security: await getTestAdminDb().execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${id}`) });
    expect(durable).not.toContain(token); expect(durable).not.toContain(token.split('.')[3]);
    expect(durable).not.toContain('private database');
    expect(await getTestAdminDb().execute(sql`SELECT * FROM idempotency_records WHERE idempotency_key = ${key}`)).toHaveLength(0);
  });

it('keeps the new manual link when regeneration email fails, with the older credential already superseded', async () => {
  if (!available) return;
  const backing = new PostgresInvitationDeliveryStore(getTestAdminDb());
  let id: string | undefined;
  const sendTransactionalEmail = jest.fn<TransactionalEmailSender['sendTransactionalEmail']>(async () => {
    if (id) {
      const generations = await getTestAdminDb().select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, id));
      expect(generations.find(row => row.generation === 1)!.state).toBe('superseded');
      return { state: 'failed', failureClass: 'connection' };
    }
    return { state: 'submitted', providerMessageId: null };
  });
  const delivery = new InvitationDeliveryService(backing, { sendTransactionalEmail }, {
    publicBaseUrl: 'https://console.example.test', supportEmail: 'support@example.test',
    describeRole: () => ({ name: 'Operations', description: 'Manage operational work.' }),
  });
  const h = await invitationAdminHarness({ store: new PostgresInvitationManagementStore(getTestAdminDb()), delivery,
    auditWriter: new PostgresAdminAuditWriter(getTestAdminDb(), keyResolver) }, 'admin', true, actorId);
  const issued = await h.send('post', '', invitationAdminBody());
  expect(issued.status).toBe(201); id = issued.body.invitation.id as string;
  const regenerated = await h.send('post', `/${id}/regenerate`, {});
  expect(regenerated.status).toBe(200);
  expect(regenerated.body.delivery).toEqual({ status: 'recorded', state: 'failed' });
  expect(regenerated.body.claim_url).not.toBe(issued.body.claim_url);
  expect(regenerated.body.invitation.generation).toBe(2);
  const parsed = parseInvitationToken(tokenFrom(regenerated.body.claim_url));
  const generations = await getTestAdminDb().select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, id));
  const current = generations.find(row => row.generation === 2)!;
  try { expect(current.credentialHash).toEqual(hashInvitationCredential(parsed, regenerated.body.invitation.email.toLowerCase(), current.expiresAt)); }
  finally { parsed.secret.fill(0); }
  expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
  expect((await backing.list(id)).map(attempt => attempt.state)).toEqual(['failed', 'submitted']);
});
