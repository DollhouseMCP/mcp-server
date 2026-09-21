import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';
import { invitationAdminBody, invitationAdminHarness, invitationAdminPath } from '../../../helpers/web-console/durableInvitationAdmin.js';
import type { IInvitationManagementStore, InvitationManagementMutation } from '../../../../src/invitations/IInvitationManagementStore.js';
import type { InvitationView } from '../../../../src/invitations/InvitationTypes.js';
import { InvitationError } from '../../../../src/invitations/InvitationTypes.js';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { createDurableInvitationAdminModule } from '../../../../src/web-console/modules/account-admin/DurableInvitationAdminModule.js';
import { projectInvitationAdminDto } from '../../../../src/web-console/modules/account-admin/DurableInvitationAdminDtos.js';

function memoryStore() {
  const views = new Map<string, InvitationView>();
  const mutation: InvitationManagementMutation = {
    issue: jest.fn<InvitationManagementMutation['issue']>(async input => {
      const now = new Date();
      const view: InvitationView = { id: input.invitationId, userId: input.userId, emailOriginal: input.emailOriginal,
        emailNormalized: input.emailNormalized, intendedUsername: input.username, intendedDisplayName: input.displayName,
        inviterUserId: input.inviterUserId, intendedRoles: input.intendedRoles, state: 'pending',
        correlationId: input.correlationId, version: 1, createdAt: now, updatedAt: now,
        acceptedAt: null, revokedAt: null, expiredAt: null,
        currentGeneration: { generation: 1, state: 'pending', issuedAt: now, expiresAt: new Date(now.getTime() + 86400000),
          credentialConsumedAt: null, acceptedAt: null, revokedAt: null, expiredAt: null, supersededAt: null, version: 1 } };
      views.set(view.id, view);
      return view;
    }),
    regenerate: jest.fn<InvitationManagementMutation['regenerate']>(async input => {
      const old = views.get(input.invitationId)!;
      const view = { ...old, currentGeneration: { ...old.currentGeneration, generation: old.currentGeneration.generation + 1 } };
      views.set(view.id, view); return view;
    }),
    revoke: jest.fn<InvitationManagementMutation['revoke']>(async id => { const old = views.get(id)!; const view = { ...old, state: 'revoked' as const }; views.set(id, view); return view; }),
  };
  const store: IInvitationManagementStore = { inspect: jest.fn<IInvitationManagementStore['inspect']>(async id => views.get(id) ?? null),
    runMutation: async (_audit, operation) => operation(mutation) };
  return { store, mutation };
}

it('returns immediate links but never invokes durable response caching, including the same supplied key', async () => {
  const { store, mutation } = memoryStore();
  const h = await invitationAdminHarness({ store });
  const claim = jest.spyOn(h.idempotency, 'claim'); const complete = jest.spyOn(h.idempotency, 'complete');
  const key = randomUUID(); const body = invitationAdminBody();
  const first = await h.send('post', '', body, { 'Idempotency-Key': key });
  expect(first.status).toBe(201);
  expect(first.headers['cache-control']).toBe('no-store');
  expect(first.body.invitation.display_name).toBe('Renée Example');
  expect(first.body.claim_url).toMatch(/^https:\/\/console.example.test\/auth\/onboarding\/invitation#token=/);
  const second = await h.send('post', '', body, { 'Idempotency-Key': key });
  expect(second.status).toBe(201); expect(second.body.claim_url).not.toBe(first.body.claim_url);
  expect(mutation.issue).toHaveBeenCalledTimes(2);
  const id = first.body.invitation.id;
  expect((await h.send('get', `/${id}`)).body).not.toHaveProperty('claim_url');
  const regen = await h.send('post', `/${id}/regenerate`, {});
  expect(regen.status).toBe(200); expect(regen.body.invitation.generation).toBe(2);
  expect(regen.body.claim_url).not.toBe(first.body.claim_url);
  expect((await h.send('post', `/${id}/revoke`, {})).body).not.toHaveProperty('claim_url');
  expect(claim).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  expect(JSON.stringify(h.auditWriter.getEvents())).not.toContain(first.body.claim_url);
  expect(projectInvitationAdminDto({ ...first.body, credential: 'secret', invitation: { ...first.body.invitation, credentialHash: 'secret' } }, false))
    .toEqual({ invitation: first.body.invitation });
});

it('enforces authentication, CSRF, capability, elevation, and role ceilings before mutation', async () => {
  const { store, mutation } = memoryStore();
  const h = await invitationAdminHarness({ store });
  expect((await request(h.app).post(invitationAdminPath).send(invitationAdminBody())).status).toBe(401);
  expect((await h.send('post', '', invitationAdminBody(), { 'X-CSRF-Token': 'wrong' })).status).toBe(403);
  expect((await (await invitationAdminHarness({ store }, 'operator')).send('post', '', invitationAdminBody())).status).toBe(401);
  expect((await (await invitationAdminHarness({ store }, 'admin', false)).send('post', '', invitationAdminBody())).status).toBe(401);
  const accountAdmin = await invitationAdminHarness({ store }, 'account_admin');
  expect((await accountAdmin.send('post', '', invitationAdminBody())).status).toBe(403);
  expect(mutation.issue).not.toHaveBeenCalled();
  const created = await h.send('post', '', invitationAdminBody());
  for (const suffix of ['', '/regenerate', '/revoke']) {
    expect((await accountAdmin.send(suffix ? 'post' : 'get', `/${created.body.invitation.id}${suffix}`, suffix ? {} : undefined)).status).toBe(403);
  }
  expect(mutation.regenerate).not.toHaveBeenCalled(); expect(mutation.revoke).not.toHaveBeenCalled();
});

it('rejects extra authority fields, invalid bodies, identifiers and TTLs without mutation', async () => {
  const { store, mutation } = memoryStore(); const h = await invitationAdminHarness({ store });
  for (const body of [{ ...invitationAdminBody(), actorUserId: randomUUID() }, { ...invitationAdminBody(), ttl_hours: 0 },
    { ...invitationAdminBody(), intended_roles: ['owner'] }, { ...invitationAdminBody(), intended_roles: ['operator', 'operator'] },
    { ...invitationAdminBody(), display_name: 2 }]) expect((await h.send('post', '', body)).status).toBe(400);
  expect((await h.send('post', '?token=secret', invitationAdminBody())).status).toBe(400);
  expect((await h.send('get', '/invalid')).status).toBe(400);
  expect(mutation.issue).not.toHaveBeenCalled();
});

it('requires admission and fails closed on limiter outage/exhaustion without exposing errors', async () => {
  const { store, mutation } = memoryStore(); const rateLimits = new InMemoryRateLimitStore();
  const h = await invitationAdminHarness({ store, rateLimits });
  expect(() => createDurableInvitationAdminModule({ ...h.configured, rateLimits: undefined as never })).toThrow('admission');
  const update = jest.spyOn(rateLimits, 'update').mockRejectedValueOnce(new Error('sensitive limiter detail'));
  const down = await h.send('post', '', invitationAdminBody());
  expect(down.status).toBe(503); expect(down.text).not.toContain('sensitive');
  update.mockRestore();
  await rateLimits.update('durable_invitation_admin', `actor:${h.userId}`, () => ({ state: { until: (Math.floor(Date.now() / 60000) + 1) * 60000, count: 20 } }));
  expect((await h.send('post', '', invitationAdminBody())).status).toBe(429);
  expect(mutation.issue).not.toHaveBeenCalled();
});

it('sanitizes mutation errors and audits failures without reflecting request data', async () => {
  const { store } = memoryStore(); const h = await invitationAdminHarness({ store });
  jest.spyOn(store, 'runMutation').mockRejectedValueOnce(new Error('raw database secret'))
    .mockRejectedValueOnce(new InvitationError('invitation_conflict', 'sensitive duplicate details'));
  const unavailable = await h.send('post', '', invitationAdminBody());
  expect(unavailable.status).toBe(503); expect(unavailable.text).not.toContain('raw database');
  const conflict = await h.send('post', '', invitationAdminBody());
  expect(conflict.status).toBe(409); expect(conflict.text).not.toContain('sensitive');
  expect(h.auditWriter.getEvents().map(event => event.result)).toEqual(['failed', 'rejected']);
});
