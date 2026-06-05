import { setupWorld, type World } from '../harness/world.js';

let world: World;
const THEME_KEY = '/api/v1/me/settings/display_config.theme';
beforeAll(async () => { world = await setupWorld(); });

describe('GET/PATCH /me/profile', () => {
  it('returns the caller principal profile', async () => {
    const res = await world.clients.userA.get('/api/v1/me/profile');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ display_name: expect.anything() });
  });

  it('updates display_name and reflects it on the next read', async () => {
    const patch = await world.clients.userA.patch('/api/v1/me/profile', { body: { display_name: 'Renamed A' } });
    expect(patch.status).toBe(200);
    const after = await world.clients.userA.get('/api/v1/me/profile');
    expect(after.body.display_name).toBe('Renamed A');
  });

  it('rejects unknown profile fields', async () => {
    const res = await world.clients.userA.patch('/api/v1/me/profile', { body: { email: 'x@y.z' } });
    expect(res.status).toBe(400);
    expect(res.problemCode).toBe('invalid_request');
  });
});

describe('/me/settings (ETag-guarded CRUD)', () => {
  it('lists settings with an ETag', async () => {
    const res = await world.clients.userA.get('/api/v1/me/settings');
    expect(res.status).toBe(200);
    expect(res.etag).toBeTruthy();
  });

  it('reads a single setting key', async () => {
    const res = await world.clients.userA.get('/api/v1/me/settings/display_config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'display_config' });
  });

  it('rejects an unknown section', async () => {
    const res = await world.clients.userA.get('/api/v1/me/settings/not_a_section');
    expect(res.status).toBe(404);
  });

  it('write requires If-Match (428 without it)', async () => {
    const res = await world.clients.userA.put(THEME_KEY, { body: { value: 'dark' } });
    expect(res.status).toBe(428);
    expect(res.problemCode).toBe('precondition_required');
  });

  it('round-trips a setting: put -> read -> delete', async () => {
    const read = await world.clients.userA.get(THEME_KEY);
    const put = await world.clients.userA.put(THEME_KEY, {
      body: { value: 'dark' },
      ifMatch: read.etag,
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ key: 'display_config.theme', value: 'dark' });

    const after = await world.clients.userA.get(THEME_KEY);
    expect(after.body.value).toBe('dark');

    const del = await world.clients.userA.delete(THEME_KEY, { ifMatch: after.etag });
    expect(del.status).toBe(200);
    const gone = await world.clients.userA.get(THEME_KEY);
    expect(gone.body.value).toBeNull();
  });

  it('stale If-Match is rejected (412)', async () => {
    const res = await world.clients.userA.put(THEME_KEY, {
      body: { value: 'light' },
      ifMatch: '"definitely-stale-etag"',
    });
    expect(res.status).toBe(412);
  });
});
