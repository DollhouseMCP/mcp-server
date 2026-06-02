import { setupWorld, type World } from '../harness/world.js';

let world: World;

beforeAll(async () => {
  world = await setupWorld();
});

describe('health (public)', () => {
  it('GET /api/v1/health is reachable without auth', async () => {
    const res = await world.clients.anon.get('/api/v1/health');
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/health/ready reports readiness', async () => {
    const res = await world.clients.anon.get('/api/v1/health/ready');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toBeTruthy();
  });
});

describe('authentication gate', () => {
  it('anonymous cannot read a self endpoint', async () => {
    const res = await world.clients.anon.get('/api/v1/me/profile');
    expect(res.status).toBe(401);
    expect(res.problemCode).toBe('unauthenticated');
  });

  it('anonymous cannot read an admin endpoint', async () => {
    const res = await world.clients.anon.get('/api/v1/admin/accounts/users');
    expect(res.status).toBe(401);
  });

  it('a normal user can read their own profile', async () => {
    const res = await world.clients.userA.get('/api/v1/me/profile');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('an elevated admin can list users', async () => {
    const res = await world.clients.admin.get('/api/v1/admin/accounts/users');
    expect(res.status).toBe(200);
  });
});
