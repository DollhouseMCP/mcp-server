import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const admin = () => world.clients.admin;

describe('admin/accounts — users & roles', () => {
  it('lists users', async () => {
    const res = await admin().get('/api/v1/admin/accounts/users');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('e2e_user_a');
  });

  it('reads a user detail', async () => {
    const res = await admin().get(`/api/v1/admin/accounts/users/${world.userB.id}`);
    expect(res.status).toBe(200);
  });

  it('lists a user roles', async () => {
    const res = await admin().get(`/api/v1/admin/accounts/users/${world.userB.id}/roles`);
    expect(res.status).toBe(200);
  });

  it('grants then revokes a role', async () => {
    const grant = await admin().post(`/api/v1/admin/accounts/users/${world.userB.id}/roles/grant`, {
      body: { role: 'account_admin' },
    });
    expect([200, 201]).toContain(grant.status);
    const afterGrant = await admin().get(`/api/v1/admin/accounts/users/${world.userB.id}/roles`);
    expect(JSON.stringify(afterGrant.body)).toContain('account_admin');

    const revoke = await admin().post(`/api/v1/admin/accounts/users/${world.userB.id}/roles/revoke`, {
      body: { role: 'account_admin' },
    });
    expect(revoke.status).toBe(200);
  });

  it('replaces a user\'s roles (PUT)', async () => {
    const res = await admin().put(`/api/v1/admin/accounts/users/${world.userB.id}/roles`, {
      body: { roles: ['account_admin'] },
    });
    expect([200, 201]).toContain(res.status);
    const after = await admin().get(`/api/v1/admin/accounts/users/${world.userB.id}/roles`);
    expect(JSON.stringify(after.body)).toContain('account_admin');
    // reset to no roles
    await admin().put(`/api/v1/admin/accounts/users/${world.userB.id}/roles`, { body: { roles: [] } });
  });

  it('disables then re-enables an account', async () => {
    const disable = await admin().post(`/api/v1/admin/accounts/users/${world.userB.id}/disable`, { body: {} });
    expect(disable.status).toBe(200);
    const enable = await admin().post(`/api/v1/admin/accounts/users/${world.userB.id}/enable`, { body: {} });
    expect(enable.status).toBe(200);
  });

  it('revokes all credentials for a user (incident op)', async () => {
    const res = await admin().post(`/api/v1/admin/accounts/users/${world.userB.id}/credentials/revoke-all`, { body: {} });
    expect([200, 204]).toContain(res.status);
  });
});

describe('admin/accounts — allowlist CRUD', () => {
  it('create -> read -> update -> delete an allowlist entry', async () => {
    const created = await admin().post('/api/v1/admin/accounts/allowlist', {
      body: { kind: 'email', value: 'invitee@e2e.dollhouse.local', note: 'e2e' },
    });
    expect([200, 201]).toContain(created.status);
    const id = created.body?.id ?? created.body?.entry?.id;
    expect(id).toBeTruthy();

    const read = await admin().get(`/api/v1/admin/accounts/allowlist/${id}`);
    expect(read.status).toBe(200);

    const update = await admin().patch(`/api/v1/admin/accounts/allowlist/${id}`, { body: { note: 'updated' } });
    expect(update.status).toBe(200);

    const del = await admin().delete(`/api/v1/admin/accounts/allowlist/${id}`);
    expect([200, 204]).toContain(del.status);
  });

  it('lists allowlist entries', async () => {
    const res = await admin().get('/api/v1/admin/accounts/allowlist');
    expect(res.status).toBe(200);
  });
});

describe('admin/accounts — invite, bootstrap, correlations', () => {
  it('issues an invite for a new username/email', async () => {
    const res = await admin().post('/api/v1/admin/accounts/users/invite', {
      body: { username: 'e2e_newinvitee', email: 'newinvite@e2e.dollhouse.local', ttl_minutes: 30, roles: [] },
    });
    expect([200, 201]).toContain(res.status);
  });

  it('a duplicate-username invite is a 409 conflict, not a 503', async () => {
    const body = { username: 'e2e_dupe', email: 'dupe@e2e.dollhouse.local' };
    const first = await admin().post('/api/v1/admin/accounts/users/invite', { body });
    expect([200, 201]).toContain(first.status);
    const second = await admin().post('/api/v1/admin/accounts/users/invite', { body });
    expect(second.status).toBe(409);
    expect(second.problemCode).toBe('conflict');
  });

  it('reads bootstrap state', async () => {
    const res = await admin().get('/api/v1/admin/accounts/bootstrap');
    expect(res.status).toBe(200);
  });

  it('correlation lookup responds without a server error', async () => {
    const res = await admin().get('/api/v1/admin/accounts/correlations/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBeLessThan(500);
  });
});
