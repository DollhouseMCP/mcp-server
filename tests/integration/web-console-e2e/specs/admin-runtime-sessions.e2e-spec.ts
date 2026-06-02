import { seedRuntimeSession } from '../harness/seed.js';
import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const admin = () => world.clients.admin;

describe('admin/accounts — a user runtime sessions (operator/accounts view)', () => {
  it("lists a user's sessions", async () => {
    const sessionId = await seedRuntimeSession(world.userB);
    const res = await admin().get(`/api/v1/admin/accounts/users/${world.userB.id}/sessions`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(sessionId);
  });

  it("terminates a specific user session", async () => {
    const sessionId = await seedRuntimeSession(world.userB);
    const res = await admin().delete(`/api/v1/admin/accounts/users/${world.userB.id}/sessions/${encodeURIComponent(sessionId)}`);
    expect([200, 202, 204]).toContain(res.status);
  });

  it("revokes all of a user's sessions", async () => {
    await seedRuntimeSession(world.userB);
    const res = await admin().post(`/api/v1/admin/accounts/users/${world.userB.id}/sessions/revoke-all`, { body: {} });
    expect([200, 202, 204]).toContain(res.status);
  });

  it("terminating an unknown user session is 404", async () => {
    const res = await admin().delete(
      `/api/v1/admin/accounts/users/${world.userB.id}/sessions/00000000-0000-4000-8000-000000000000`);
    expect([404, 400]).toContain(res.status);
  });
});
