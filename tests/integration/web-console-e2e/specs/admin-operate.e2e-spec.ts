import { seedRuntimeSession } from '../harness/seed.js';
import { setupWorld, type World } from '../harness/world.js';

let world: World;
let sessionId: string;
beforeAll(async () => {
  world = await setupWorld();
  sessionId = await seedRuntimeSession(world.userA);
});

const admin = () => world.clients.admin;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('admin/operate — config', () => {
  it('lists operator config', async () => {
    const res = await admin().get('/api/v1/admin/operate/config');
    expect(res.status).toBe(200);
  });

  it('reads a config key', async () => {
    const res = await admin().get('/api/v1/admin/operate/config/enhanced_index.enabled');
    expect(res.status).toBe(200);
  });

  it('sets a config key', async () => {
    const read = await admin().get('/api/v1/admin/operate/config/enhanced_index.enabled');
    const res = await admin().put('/api/v1/admin/operate/config/enhanced_index.enabled', {
      body: { value: true },
      ifMatch: read.etag,
    });
    expect([200, 204]).toContain(res.status);
  });
});

describe('admin/operate — health', () => {
  it.each([
    '/api/v1/admin/operate/health',
    '/api/v1/admin/operate/health/database',
    '/api/v1/admin/operate/health/auth-server',
    '/api/v1/admin/operate/health/gatekeeper',
  ])('%s returns a health view', async (path) => {
    const res = await admin().get(path);
    expect(res.status).toBe(200);
  });
});

describe('admin/operate — logs & metrics (+ SSE)', () => {
  it('lists operator logs', async () => {
    const res = await admin().get('/api/v1/admin/operate/logs');
    expect(res.status).toBe(200);
  });
  it('streams operator logs (SSE)', async () => {
    const res = await admin().readStream('/api/v1/admin/operate/logs/stream', { maxEvents: 1, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
  });
  it('lists operator metrics', async () => {
    const res = await admin().get('/api/v1/admin/operate/metrics');
    expect(res.status).toBe(200);
  });
  it('streams operator metrics (SSE)', async () => {
    const res = await admin().readStream('/api/v1/admin/operate/metrics/stream', { maxEvents: 1, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
  });
});

describe('admin/operate — sessions (operator view)', () => {
  it('lists all active sessions (includes the seeded one)', async () => {
    const res = await admin().get('/api/v1/admin/operate/sessions');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(sessionId);
  });
  it('reads a session detail', async () => {
    const res = await admin().get(`/api/v1/admin/operate/sessions/${encodeURIComponent(sessionId)}`);
    expect(res.status).toBe(200);
  });
  it('terminating an unknown session is 404 (not 500)', async () => {
    const res = await admin().delete(`/api/v1/admin/operate/sessions/${UNKNOWN}`);
    expect([404, 400]).toContain(res.status);
  });
});
