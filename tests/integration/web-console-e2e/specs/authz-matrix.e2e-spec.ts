import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

// A representative admin endpoint from each admin capability.
const ADMIN_ENDPOINTS = [
  '/api/v1/admin/accounts/users',
  '/api/v1/admin/audit/admin',
  '/api/v1/admin/operate/config',
  '/api/v1/admin/security/signing-keys',
];

describe('anonymous is rejected', () => {
  it.each(['/api/v1/me/profile', ...ADMIN_ENDPOINTS])('401 on %s', async (path) => {
    const res = await world.clients.anon.get(path);
    expect(res.status).toBe(401);
  });
});

// Admin-audience routes check elevation FIRST (ConsoleAuthorization.ts:30), so a
// session without fresh step-up — whether a normal user or an un-elevated admin —
// gets 401 step_up_required, not 403. The capability 403 is only reachable with a
// valid elevation that nonetheless lacks the capability.
describe('a normal user cannot reach admin endpoints', () => {
  it.each(ADMIN_ENDPOINTS)('401 step_up_required on %s', async (path) => {
    const res = await world.clients.userA.get(path);
    expect(res.status).toBe(401);
    expect(res.problemCode).toBe('step_up_required');
  });
});

describe('an authenticated-but-unelevated admin cannot reach admin endpoints', () => {
  it.each(ADMIN_ENDPOINTS)('401 step_up_required on %s', async (path) => {
    const res = await world.clients.adminUnelevated.get(path);
    expect(res.status).toBe(401);
    expect(res.problemCode).toBe('step_up_required');
  });
});

describe('cross-user isolation (owner-scoped /me)', () => {
  const base = '/api/v1/me/portfolio/elements/personas';

  it("user B cannot see or read user A's element", async () => {
    const created = await world.clients.userA.post(base, {
      body: { name: 'iso-secret', content: 'private to A', metadata: {} },
    });
    expect(created.status).toBe(201);
    try {
      // B's list must not include A's element
      const bList = await world.clients.userB.get('/api/v1/me/portfolio/elements');
      expect(bList.status).toBe(200);
      expect(JSON.stringify(bList.body)).not.toContain('iso-secret');
      // B cannot read A's element by name
      const bRead = await world.clients.userB.get(`${base}/iso-secret`);
      expect(bRead.status).toBe(404);
      // A can read its own
      const aRead = await world.clients.userA.get(`${base}/iso-secret`);
      expect(aRead.status).toBe(200);
    } finally {
      const a = await world.clients.userA.get(`${base}/iso-secret`);
      if (a.status === 200) await world.clients.userA.delete(`${base}/iso-secret`, { ifMatch: a.etag });
    }
  });

  it("user B cannot read user A's profile via admin route without elevation", async () => {
    const res = await world.clients.userB.get(`/api/v1/admin/accounts/users/${world.userA.id}`);
    expect(res.status).toBe(401);
    expect(res.problemCode).toBe('step_up_required');
  });
});
