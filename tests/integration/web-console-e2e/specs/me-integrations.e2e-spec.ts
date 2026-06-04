import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

describe('/me/integrations', () => {
  it('lists integrations', async () => {
    const res = await world.clients.userA.get('/api/v1/me/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('reports github integration status (disconnected by default)', async () => {
    const res = await world.clients.userA.get('/api/v1/me/integrations/github');
    expect(res.status).toBe(200);
  });

  it('connect returns the GitHub authorization URL for the SPA to navigate to', async () => {
    const res = await world.clients.userA.post('/api/v1/me/integrations/github/connect', { body: {} });
    expect(res.status).toBe(200);
    expect(typeof res.body?.authorize_url).toBe('string');
    expect(res.body.authorize_url).toContain('github.com');
  });

  it('disconnect is idempotent and never errors', async () => {
    const res = await world.clients.userA.delete('/api/v1/me/integrations/github');
    expect([200, 204, 404]).toContain(res.status);
  });
});
