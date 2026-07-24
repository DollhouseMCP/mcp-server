import { seedRuntimeSession } from '../harness/seed.js';
import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('/me/sessions (MCP runtime sessions)', () => {
  it('lists the caller runtime sessions in the snapshot envelope', async () => {
    const res = await world.clients.userA.get('/api/v1/me/sessions');
    expect(res.status).toBe(200);
    // Snapshot family: noun-keyed envelope, never a bare array.
    expect(Array.isArray((res.body as { sessions: unknown[] }).sessions)).toBe(true);
  });

  it('an unknown session detail is 404', async () => {
    const res = await world.clients.userA.get(`/api/v1/me/sessions/${UNKNOWN}`);
    expect(res.status).toBe(404);
  });

  it('terminating an unknown session is 404 (not 500)', async () => {
    const res = await world.clients.userA.delete(`/api/v1/me/sessions/${UNKNOWN}`);
    expect([404, 400]).toContain(res.status);
  });

  it('tracks an owned termination command without exposing it cross-user', async () => {
    const sessionId = await seedRuntimeSession(world.userA);
    const terminate = await world.clients.userA.delete(`/api/v1/me/sessions/${sessionId}`);
    expect(terminate.status).toBe(202);
    const commandId = (terminate.body as { command_id: string }).command_id;

    const ownStatus = await world.clients.userA.get(`/api/v1/me/sessions/commands/${commandId}`);
    expect(ownStatus.status).toBe(200);
    expect(ownStatus.body).toMatchObject({ command_id: commandId, status: 'pending' });

    const foreignStatus = await world.clients.userB.get(`/api/v1/me/sessions/commands/${commandId}`);
    expect(foreignStatus.status).toBe(404);
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
