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

  it('GET /auth/me carries the profile header fields with contract types', async () => {
    const res = await world.clients.userA.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    // The SPA profile header reads these; they mirror /me/profile's source.
    // Types are the contract: string-or-null scalars, string arrays.
    expect(body.display_name === null || typeof body.display_name === 'string').toBe(true);
    expect(body.email === null || typeof body.email === 'string').toBe(true);
    expect(Array.isArray(body.auth_methods)).toBe(true);
    expect((body.auth_methods as unknown[]).every(m => typeof m === 'string')).toBe(true);
    expect(Array.isArray(body.granted_capabilities)).toBe(true);
    expect((body.granted_capabilities as unknown[]).every(c => typeof c === 'string')).toBe(true);
  });

  it('an elevated admin can list users', async () => {
    const res = await world.clients.admin.get('/api/v1/admin/accounts/users');
    expect(res.status).toBe(200);
  });
});
