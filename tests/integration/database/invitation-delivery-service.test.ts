import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { users } from '../../../src/database/schema/users.js';
import { accountInvitations } from '../../../src/database/schema/invitations.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationDeliveryStore } from '../../../src/invitations/PostgresInvitationDeliveryStore.js';
import { InvitationDeliveryService } from '../../../src/invitations/InvitationDeliveryService.js';
import type { IInvitationDeliveryStore } from '../../../src/invitations/IInvitationDeliveryStore.js';
import { generateInvitationToken } from '../../../src/invitations/InvitationToken.js';
import type { IssuedInvitation } from '../../../src/invitations/InvitationTypes.js';
import type { TransactionalEmail, EmailSubmissionResult } from '../../../src/auth/embedded-as/methods/TransactionalEmailSender.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
const inviterId = randomUUID();
const db = () => getTestAdminDb();
const ledger = () => new PostgresInvitationDeliveryStore(db());
const management = () => new PostgresInvitationManagementStore(db());
const options = { publicBaseUrl: 'https://beta.example.test', supportEmail: 'Support@example.test',
  describeRole: () => ({ name: 'Operations', description: 'Manage operational work.' }) };
const submitted = { state: 'submitted' as const, providerMessageId: null };
let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
  if (available) await db().insert(users).values({ id: inviterId, username: `email-admin-${inviterId}` });
});
afterAll(closeTestDb);
async function fixture(): Promise<IssuedInvitation> {
  const id = randomUUID();
  const token = generateInvitationToken(id, 1);
  const invitation = await management().runMutation(audit, mutation => mutation.issue({
    invitationId: id, userId: randomUUID(), username: `email-${id}`, displayName: 'Morgan',
    emailOriginal: `Tester-${id}@example.test`, emailNormalized: `tester-${id}@example.test`,
    inviterUserId: inviterId, intendedRoles: ['operator'], generation: 1,
    credentialSecret: token.secret, ttlHours: 24, correlationId: randomUUID(),
  }));
  return { invitation, credential: token.token };
}
function fake(send: (message: TransactionalEmail) => Promise<EmailSubmissionResult> = async () => submitted) {
  return { sendTransactionalEmail: jest.fn(send) };
}
function service(sender: ReturnType<typeof fake> | null, storage: IInvitationDeliveryStore = ledger()) {
  return new InvitationDeliveryService(storage, sender, options);
}
async function expectNoSecret(issued: IssuedInvitation, outcome: unknown) {
  const attempts = await ledger().list(issued.invitation.id);
  const events = await db().execute(sql`SELECT metadata FROM security_audit_events WHERE target_id = ${issued.invitation.id}`);
  for (const value of [outcome, attempts, events]) {
    expect(JSON.stringify(value)).not.toContain(issued.credential);
    expect(JSON.stringify(value)).not.toContain(issued.credential.split('.')[3]);
    expect(JSON.stringify(value)).not.toContain('submissionAuthorized');
  }
}

describe('invitation delivery orchestration with real ledger and fake SMTP', () => {
  it('returns manual fallback without a provider attempt when email is not configured', async () => {
    if (!available) return;
    const issued = await fixture();
    const outcome = await service(null).deliver(issued, randomUUID(), audit);
    expect(outcome).toEqual({ status: 'manual_fallback', reason: 'not_configured', invitationId: issued.invitation.id, generation: 1 });
    expect(await ledger().list(issued.invitation.id)).toHaveLength(0);
    await expectNoSecret(issued, outcome);
  });

  it('commits a reservation before exactly one submission under duplicate concurrent correlations', async () => {
    if (!available) return;
    const issued = await fixture();
    const sender = fake(async message => {
      expect((await ledger().list(issued.invitation.id))[0].state).toBe('submitting');
      expect(message.to).toBe(issued.invitation.emailOriginal);
      expect(message.text).toContain(issued.credential);
      expect(message.html).toContain('No Dollhouse password');
      return submitted;
    });
    const delivery = service(sender);
    const correlation = randomUUID();
    const results = await Promise.all([delivery.deliver(issued, correlation, audit), delivery.deliver(issued, correlation, audit)]);
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.status).sort()).toEqual(['existing_attempt', 'recorded']);
    const [attempt] = await ledger().list(issued.invitation.id);
    expect(attempt).toMatchObject({ generation: 1, version: 2, state: 'submitted', providerMessageId: null });
    await expectNoSecret(issued, results);
    await expect(delivery.deliver(issued, randomUUID(), audit)).rejects.toMatchObject({ code: 'invitation_conflict' });
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it.each(['authentication', 'connection', 'tls', 'rejected'] as const)('permits only an explicit new-correlation retry after confirmed %s failure', async failureClass => {
    if (!available) return;
    const issued = await fixture();
    const sender = fake(async () => ({ state: 'failed', failureClass }));
    const delivery = service(sender);
    const correlation = randomUUID();
    expect((await delivery.deliver(issued, correlation, audit)).status).toBe('recorded');
    expect((await ledger().list(issued.invitation.id))[0].state).toBe('failed');
    expect((await delivery.deliver(issued, correlation, audit)).status).toBe('existing_attempt');
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    sender.sendTransactionalEmail.mockResolvedValueOnce(submitted);
    await delivery.deliver(issued, randomUUID(), audit);
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(2);
    expect((await ledger().list(issued.invitation.id)).map(row => row.state)).toEqual(['submitted', 'failed']);
  });

  it.each(['unknown', 'throw', 'empty', 'unrecognized', 'echo'] as const)('records %s provider ambiguity without a blind retry or secret persistence', async behavior => {
    if (!available) return;
    const issued = await fixture();
    const sender = fake(async () => {
      if (behavior === 'throw') throw new Error(`raw provider secret: ${issued.credential}`);
      if (behavior === 'empty') return undefined as unknown as EmailSubmissionResult;
      if (behavior === 'unrecognized') return { state: 'delivered', secret: issued.credential } as unknown as EmailSubmissionResult;
      if (behavior === 'echo') return { state: 'submitted', providerMessageId: issued.credential };
      return { state: 'unknown', failureClass: 'indeterminate' };
    });
    const delivery = service(sender);
    const outcome = await delivery.deliver(issued, randomUUID(), audit);
    expect(outcome).toMatchObject({ status: 'recorded', attempt: { state: 'unknown', generation: 1, version: 2 } });
    await expect(delivery.deliver(issued, randomUUID(), audit)).rejects.toMatchObject({ code: 'invitation_conflict' });
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    await expectNoSecret(issued, outcome);
  });

  it.each([false, true])('does not resend when result persistence fails (commit already happened: %s)', async committed => {
    if (!available) return;
    const issued = await fixture();
    const backing = ledger();
    let calls = 0;
    const storage: IInvitationDeliveryStore = { list: id => backing.list(id), runMutation: async (writer, operation) => {
      calls++;
      if (calls === 2 && !committed) throw new Error('result database unavailable');
      const result = await backing.runMutation(writer, operation);
      if (calls === 2) throw new Error('commit acknowledgement lost');
      return result;
    } };
    const sender = fake();
    const delivery = service(sender, storage);
    const correlation = randomUUID();
    const outcome = await delivery.deliver(issued, correlation, audit);
    expect(outcome).toMatchObject({ status: 'uncertain', lastKnownAttempt: { state: 'submitting', version: 1 } });
    expect((await ledger().list(issued.invitation.id))[0].state).toBe(committed ? 'submitted' : 'submitting');
    expect((await delivery.deliver(issued, correlation, audit)).status).toBe('existing_attempt');
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    await expectNoSecret(issued, outcome);
  });

  it('never converts an earlier crashed reservation into a new submission authorization', async () => {
    if (!available) return;
    const issued = await fixture();
    const correlation = randomUUID();
    await ledger().runMutation(audit, mutation => mutation.reserveDeliveryAttempt(issued.invitation.id, 1, 'smtp', correlation));
    const sender = fake();
    expect((await service(sender).deliver(issued, correlation, audit)).status).toBe('existing_attempt');
    expect(sender.sendTransactionalEmail).not.toHaveBeenCalled();
    await expect(service(sender).deliver(issued, randomUUID(), audit)).rejects.toMatchObject({ code: 'invitation_conflict' });
  });

  it('records a late old-generation result without restoring a generation invalidated during SMTP', async () => {
    if (!available) return;
    const issued = await fixture();
    const replacement = generateInvitationToken(issued.invitation.id, 2);
    const sender = fake(async () => {
      await management().runMutation(audit, mutation => mutation.regenerate({ invitationId: issued.invitation.id, credentialSecret: replacement.secret, ttlHours: 24, correlationId: randomUUID() }));
      return submitted;
    });
    expect(await service(sender).deliver(issued, randomUUID(), audit)).toMatchObject({ status: 'recorded', attempt: { generation: 1, state: 'submitted' } });
    const [current] = await db().select().from(accountInvitations).where(eq(accountInvitations.id, issued.invitation.id));
    expect(current).toMatchObject({ currentGeneration: 2, state: 'pending' });
    await expect(service(sender).deliver(issued, randomUUID(), audit)).rejects.toMatchObject({ code: 'invitation_superseded' });
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it('snapshots message inputs before awaiting and rejects mismatched credential context before reservation', async () => {
    if (!available) return;
    const issued = await fixture();
    const credential = issued.credential;
    const to = issued.invitation.emailOriginal;
    const sender = fake();
    const pending = service(sender).deliver(issued, randomUUID(), audit);
    (issued.invitation as { emailOriginal: string }).emailOriginal = 'attacker@example.test';
    (issued as { credential: string }).credential = 'changed';
    issued.invitation.currentGeneration.expiresAt.setTime(0);
    await pending;
    const message = sender.sendTransactionalEmail.mock.calls[0][0];
    expect(message.to).toBe(to);
    expect(message.text).toContain(credential);
    const other = await fixture();
    await expect(service(sender).deliver({ ...other, credential }, randomUUID(), audit)).rejects.toMatchObject({ code: 'invitation_invalid' });
    expect(await ledger().list(other.invitation.id)).toHaveLength(0);
    expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });
});
