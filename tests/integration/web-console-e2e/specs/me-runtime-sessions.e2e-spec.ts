import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('/me/sessions (MCP runtime sessions)', () => {
  it('lists the caller runtime sessions', async () => {
    const res = await world.clients.userA.get('/api/v1/me/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('an unknown session detail is 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}`);
    expect(res.status).toBe(404);
  });

  it('terminating an unknown session is 404 (not 500)', async () => {
    const res = await world.clients.userA.delete(`/api/v1/me/sessions/${UNKNOWN}`);
    expect([404, 400]).toContain(res.status);
  });
});

describe('/me/sessions/:id subresources on an unknown session', () => {
  it('activations list -> 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}/activations`);
    expect([404, 400]).toContain(res.status);
  });

  it('approvals list -> 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}/approvals`);
    expect([404, 400]).toContain(res.status);
  });

  it('executions list -> 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}/executions`);
    expect([404, 400]).toContain(res.status);
  });

  it('gatekeeper state -> 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}/gatekeeper`);
    expect([404, 400]).toContain(res.status);
  });

  it('logs -> 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}/logs`);
    expect([404, 400]).toContain(res.status);
  });

  it('metrics -> 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}/metrics`);
    expect([404, 400]).toContain(res.status);
  });
});
