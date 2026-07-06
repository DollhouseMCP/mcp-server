import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

describe('/me/logs', () => {
  it('serves the cursor-family envelope', async () => {
    const res = await world.clients.userA.get('/api/v1/me/logs?limit=5');
    expect(res.status).toBe(200);
    const body = res.body as { items: unknown[]; page: { limit: number; cursor: unknown; next_cursor: unknown } };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.page.limit).toBe(5);
    // First page: cursor null; next_cursor is either null or an opaque string.
    expect(body.page.cursor).toBeNull();
    expect(body.page.next_cursor === null || typeof body.page.next_cursor === 'string').toBe(true);
  });

  it('treats a garbage cursor as the first page rather than erroring', async () => {
    const res = await world.clients.userA.get('/api/v1/me/logs?limit=5&cursor=not-a-real-cursor');
    expect(res.status).toBe(200);
    expect((res.body as { page: { cursor: unknown } }).page.cursor).toBeNull();
  });
});
