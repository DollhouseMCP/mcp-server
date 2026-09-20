import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { users } from '../../../src/database/schema/users.js';
import { accountInvitationGenerations } from '../../../src/database/schema/invitations.js';
import { InvitationManagementService } from '../../../src/invitations/InvitationManagementService.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { hashInvitationCredential, parseInvitationToken } from '../../../src/invitations/InvitationToken.js';
import type { IssueInvitationInput, IssuedInvitation } from '../../../src/invitations/InvitationTypes.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const inviterUserId = randomUUID();
const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
const input = (): IssueInvitationInput => ({
  username: `service-${randomUUID()}`, displayName: 'Service Test',
  email: `Person-${randomUUID()}@Example.com`, inviterUserId,
  intendedRoles: ['operator'], correlationId: randomUUID(),
});
const store = () => new PostgresInvitationManagementStore(getTestAdminDb());
const service = (ttl = 24) => new InvitationManagementService(store(), audit, ttl);

async function verifyPersistedHash(issued: IssuedInvitation) {
  const token = parseInvitationToken(issued.credential);
  const [row] = await getTestAdminDb().select().from(accountInvitationGenerations).where(and(
    eq(accountInvitationGenerations.invitationId, token.invitationId),
    eq(accountInvitationGenerations.generation, token.generation),
  ));
  expect(row.credentialHash).toEqual(hashInvitationCredential(token, issued.invitation.emailNormalized, row.expiresAt));
  return row;
}

let databaseAvailable = false;
beforeAll(async () => {
  databaseAvailable = await isDatabaseAvailable();
  if (!databaseAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') {
    throw new Error('PostgreSQL is required for invitation integration tests');
  }
  if (!databaseAvailable) return;
  await getTestAdminDb().insert(users).values({ id: inviterUserId, username: `service-admin-${inviterUserId}` });
});
afterAll(closeTestDb);

describe('invitation management service', () => {
  it('returns a usable credential after committing a pending account and preserves the original email', async () => {
    if (!databaseAvailable) return;
    const request = input();
    const issued = await service().issue(request);
    const row = await verifyPersistedHash(issued);
    expect(issued.invitation.emailOriginal).toBe(request.email);
    expect(issued.invitation.emailNormalized).toBe(request.email.toLowerCase());
    expect(row.expiresAt.getTime() - row.issuedAt.getTime()).toBe(24 * 3_600_000);
    const inspected = await service().inspect(issued.invitation.id);
    expect(inspected).toEqual(issued.invitation);
    expect(JSON.stringify(inspected)).not.toContain(issued.credential);
    expect(inspected).not.toHaveProperty('credential');
  });

  it('persists canonical Unicode account names from service input', async () => {
    if (!databaseAvailable) return;
    const suffix = randomUUID();
    const issued = await service().issue({
      ...input(),
      username: ` \u00a0CAFÉ-${suffix.normalize('NFD')}\u00a0 `,
      displayName: ' \u00a0Rene\u0301e Example\u00a0 ',
    });
    const expectedUsername = `café-${suffix}`;
    expect(issued.invitation).toMatchObject({
      intendedUsername: expectedUsername,
      intendedDisplayName: 'Renée Example',
    });
    const [user] = await getTestAdminDb().select().from(users).where(eq(users.id, issued.invitation.userId));
    expect(user).toMatchObject({ username: expectedUsername, displayName: 'Renée Example' });
  });

  it('uses the transaction-returned generation for concurrent regeneration credentials', async () => {
    if (!databaseAvailable) return;
    const issued = await service().issue(input());
    const regenerate = () => service().regenerate({ invitationId: issued.invitation.id, correlationId: randomUUID() });
    const replacements = await Promise.all([regenerate(), regenerate()]);
    expect(replacements.map(result => parseInvitationToken(result.credential).generation).sort()).toEqual([2, 3]);
    for (const replacement of replacements) await verifyPersistedHash(replacement);
    const current = await service().inspect(issued.invitation.id);
    expect(current?.currentGeneration.generation).toBe(3);
  });

  it('applies configured and per-operation TTLs only to new generations', async () => {
    if (!databaseAvailable) return;
    const issued = await service(48).issue({ ...input(), ttlHours: 1 });
    const old = await verifyPersistedHash(issued);
    const regenerated = await service(48).regenerate({ invitationId: issued.invitation.id, correlationId: randomUUID() });
    const fresh = await verifyPersistedHash(regenerated);
    expect(old.expiresAt.getTime() - old.issuedAt.getTime()).toBe(3_600_000);
    expect(fresh.expiresAt.getTime() - fresh.issuedAt.getTime()).toBe(48 * 3_600_000);
    expect((await verifyPersistedHash(issued)).expiresAt).toEqual(old.expiresAt);
  });

  it('owns request fields and roles before the first asynchronous boundary', async () => {
    if (!databaseAvailable) return;
    const request = input();
    const pending = service().issue(request);
    (request.intendedRoles as string[]).push('admin');
    Object.assign(request, { email: 'changed@example.com', username: 'changed', displayName: 'Changed' });
    const issued = await pending;
    expect(issued.invitation.intendedRoles).toEqual(['operator']);
    expect(issued.invitation.emailNormalized).not.toBe('changed@example.com');
    expect(issued.invitation.intendedDisplayName).toBe('Service Test');
    await verifyPersistedHash(issued);
  });

  it('returns no credential or account when audit fails', async () => {
    if (!databaseAvailable) return;
    const request = input();
    const failing = new InvitationManagementService(store(), {
      kind: 'system', appendSecurityEvent: async () => { throw new Error('audit unavailable'); },
    }, 24);
    await expect(failing.issue(request)).rejects.toThrow('audit unavailable');
    expect(await getTestAdminDb().select().from(users).where(eq(users.username, request.username))).toHaveLength(0);
  });

  it('rejects invalid configuration and input through stable lifecycle errors', async () => {
    if (!databaseAvailable) return;
    expect(() => service(0)).toThrow('Invalid invitation TTL');
    await expect(service().issue({ ...input(), ttlHours: 169 })).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(service().issue({ ...input(), email: 'invalid' })).rejects.toMatchObject({ code: 'invitation_invalid' });
  });

  it('exposes idempotent revocation without a recoverable credential', async () => {
    if (!databaseAvailable) return;
    const issued = await service().issue(input());
    const request = { invitationId: issued.invitation.id, correlationId: randomUUID() };
    const revoked = await service().revoke(request);
    expect(revoked.state).toBe('revoked');
    expect(revoked).not.toHaveProperty('credential');
    expect(await service().revoke(request)).toEqual(revoked);
    await expect(service().regenerate(request)).rejects.toMatchObject({ code: 'invitation_revoked' });
  });
});
