import { seedRuntimeSession } from '../harness/seed.js';
import { setupWorld, type World } from '../harness/world.js';

let world: World;
let sessionId: string;

beforeAll(async () => {
  world = await setupWorld();
  sessionId = await seedRuntimeSession(world.userA);
});

const me = () => world.clients.userA;

describe('runtime session info with seeded data', () => {
  it('lists the active session', async () => {
    const res = await me().get('/api/v1/me/sessions');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(sessionId);
  });

  it('returns session detail', async () => {
    const res = await me().get(`/api/v1/me/sessions/${sessionId}`);
    expect(res.status).toBe(200);
  });
});

describe('session telemetry (logs + metrics)', () => {
  it('returns session logs (seeded activity events)', async () => {
    const res = await me().get(`/api/v1/me/sessions/${sessionId}/logs`);
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('returns session metrics aggregated from activity', async () => {
    const res = await me().get(`/api/v1/me/sessions/${sessionId}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('logs/metrics for a non-owned session are 404', async () => {
    // user B does not own user A's session
    const res = await world.clients.userB.get(`/api/v1/me/sessions/${sessionId}/logs`);
    expect(res.status).toBe(404);
  });
});

describe('SSE streams', () => {
  it('logs/stream connects and delivers events', async () => {
    const res = await me().readStream(`/api/v1/me/sessions/${sessionId}/logs/stream`, { maxEvents: 1, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.events.length).toBeGreaterThanOrEqual(1);
  });

  it('metrics/stream connects', async () => {
    const res = await me().readStream(`/api/v1/me/sessions/${sessionId}/metrics/stream`, { maxEvents: 1, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
  });

  it('a non-owner cannot open the logs stream', async () => {
    const res = await world.clients.userB.readStream(`/api/v1/me/sessions/${sessionId}/logs/stream`, { maxEvents: 1, timeoutMs: 2000 });
    expect(res.status).toBe(404);
  });
});
