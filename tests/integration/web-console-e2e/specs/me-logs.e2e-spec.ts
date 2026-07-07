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

  it('walks a second page through the opaque cursor over real HTTP', async () => {
    // Guarantee user-scoped log entries: portfolio mutations run inside the
    // per-user context bridge, so the element managers' logging is attributed
    // to this user (plain reads are not reliably attributed).
    for (const name of ['Log-Walk-A', 'Log-Walk-B']) {
      await world.clients.userA.post('/api/v1/me/portfolio/elements/personas', {
        body: { name, content: `You are ${name}.`, metadata: {}, tags: [] },
      });
    }

    type Page = { items: { id: string }[]; page: { cursor: string | null; next_cursor: string | null } };
    const first = (await world.clients.userA.get('/api/v1/me/logs?limit=1')).body as Page;
    expect(first.items).toHaveLength(1);
    expect(first.page.next_cursor).not.toBeNull();

    const second = (await world.clients.userA.get(
      `/api/v1/me/logs?limit=1&cursor=${encodeURIComponent(first.page.next_cursor ?? '')}`,
    )).body as Page;
    expect(second.items).toHaveLength(1);
    expect(second.page.cursor).toBe(first.page.next_cursor);
    // The walk continues, and it never repeats the first page's entry.
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });
});
