import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => {
  world = await setupWorld();
  // Generate some admin audit events to read back (each admin mutation writes one).
  await world.clients.admin.post(`/api/v1/admin/accounts/users/${world.userB.id}/roles/grant`, { body: { role: 'account_admin' } });
  await world.clients.admin.post(`/api/v1/admin/accounts/users/${world.userB.id}/roles/revoke`, { body: { role: 'account_admin' } });
});

const admin = () => world.clients.admin;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('admin/audit — admin action log (HMAC chain)', () => {
  it('lists admin audit events', async () => {
    const res = await admin().get('/api/v1/admin/audit/admin');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('an unknown admin audit event is 404', async () => {
    const res = await admin().get(`/api/v1/admin/audit/admin/${UNKNOWN}`);
    expect([404, 400]).toContain(res.status);
  });

  it('streams the admin audit export (SSE)', async () => {
    const res = await admin().readStream('/api/v1/admin/audit/admin/export', { maxEvents: 1, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
  });
});

describe('admin/audit — approvals & authentication logs', () => {
  it('lists approval audit events', async () => {
    const res = await admin().get('/api/v1/admin/audit/approvals');
    expect(res.status).toBe(200);
  });

  it('an unknown approval audit event is 404', async () => {
    const res = await admin().get(`/api/v1/admin/audit/approvals/${UNKNOWN}`);
    expect([404, 400]).toContain(res.status);
  });

  it('lists authentication audit events', async () => {
    const res = await admin().get('/api/v1/admin/audit/authentication');
    expect(res.status).toBe(200);
  });
});
