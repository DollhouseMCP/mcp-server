import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

describe('/me/security/factors', () => {
  it('lists the caller MFA factors', async () => {
    const res = await world.clients.userA.get('/api/v1/me/security/factors');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('enroll-totp redirects to the auth server', async () => {
    const res = await world.clients.userA.get('/api/v1/me/security/factors/enroll/totp');
    expect([200, 302]).toContain(res.status);
  });

  it('disable-totp redirects to the auth server', async () => {
    const res = await world.clients.userA.get('/api/v1/me/security/factors/disable/totp');
    expect([200, 302]).toContain(res.status);
  });
});

describe('/me/security/sessions', () => {
  it('lists the caller console sessions (includes the active one)', async () => {
    const res = await world.clients.userA.get('/api/v1/me/security/sessions');
    expect(res.status).toBe(200);
    // The forged session should be visible to its owner.
    const count = Array.isArray(res.body) ? res.body.length : (res.body?.sessions?.length ?? res.body?.items?.length);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('revoke-all-others succeeds', async () => {
    const res = await world.clients.userA.post('/api/v1/me/security/sessions/revoke-all-others', { body: {} });
    expect([200, 204]).toContain(res.status);
  });

  it('revoking an unknown session is a 404 (not a 500)', async () => {
    const res = await world.clients.userA.delete('/api/v1/me/security/sessions/00000000-0000-4000-8000-000000000000');
    expect([404, 400]).toContain(res.status);
  });
});
