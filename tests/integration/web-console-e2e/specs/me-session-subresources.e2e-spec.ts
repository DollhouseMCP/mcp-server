import { seedAgentExecution, seedPendingApproval, seedRuntimeSession } from '../harness/seed.js';
import { setupWorld, type World } from '../harness/world.js';

let world: World;
let sessionId: string;

beforeAll(async () => {
  world = await setupWorld();
  sessionId = await seedRuntimeSession(world.userA);
});

const me = () => world.clients.userA;
const sess = () => `/api/v1/me/sessions/${sessionId}`;

describe('session activations', () => {
  const elBase = '/api/v1/me/portfolio/elements/personas';
  const NAME = 'act-persona';

  it('activate -> list -> deactivate round-trip', async () => {
    const created = await me().post(elBase, { body: { name: NAME, content: 'activatable', metadata: {} } });
    expect(created.status).toBe(201);
    try {
      const activate = await me().post(`${sess()}/activations`, { body: { type: 'personas', name: NAME } });
      expect(activate.status).toBe(200);

      const list = await me().get(`${sess()}/activations`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(NAME);

      const deactivate = await me().delete(`${sess()}/activations/personas/${NAME}`);
      expect([200, 204]).toContain(deactivate.status);
    } finally {
      const r = await me().get(`${elBase}/${NAME}`);
      if (r.status === 200) await me().delete(`${elBase}/${NAME}`, { ifMatch: r.etag });
    }
  });

  it('activating a missing element is 404', async () => {
    const res = await me().post(`${sess()}/activations`, { body: { type: 'personas', name: 'no-such-element' } });
    expect(res.status).toBe(404);
  });
});

describe('session gatekeeper', () => {
  it('returns gatekeeper state for an owned session', async () => {
    const res = await me().get(`${sess()}/gatekeeper`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ session_id: sessionId });
  });
});

describe('session approvals', () => {
  it('lists a seeded pending approval and approves it', async () => {
    const approvalId = await seedPendingApproval(world.userA, sessionId);
    const list = await me().get(`${sess()}/approvals`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(approvalId);

    const approve = await me().post(`${sess()}/approvals/${approvalId}/approve`, { body: { scope: 'once' } });
    expect(approve.status).toBe(200);
    expect(JSON.stringify(approve.body)).toContain('approved');
  });

  it('denies a seeded pending approval', async () => {
    const approvalId = await seedPendingApproval(world.userA, sessionId);
    const deny = await me().post(`${sess()}/approvals/${approvalId}/deny`, { body: {} });
    expect(deny.status).toBe(200);
    expect(JSON.stringify(deny.body)).toContain('denied');
  });
});

describe('session executions', () => {
  let goalId: string;
  beforeAll(async () => { goalId = await seedAgentExecution(world.userA, sessionId); });

  it('lists executions', async () => {
    const res = await me().get(`${sess()}/executions`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(goalId);
  });

  it('returns execution detail', async () => {
    const res = await me().get(`${sess()}/executions/${goalId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ goal_id: goalId });
  });

  it('streams execution detail (SSE)', async () => {
    const res = await me().readStream(`${sess()}/executions/${goalId}/stream`, { maxEvents: 1, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.events.length).toBeGreaterThanOrEqual(1);
  });

  it('unknown execution goal is 404', async () => {
    const res = await me().get(`${sess()}/executions/goal-does-not-exist`);
    expect(res.status).toBe(404);
  });
});
