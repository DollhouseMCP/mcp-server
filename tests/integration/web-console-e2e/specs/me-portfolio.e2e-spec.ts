import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const TYPE = 'personas';
const NAME = 'e2e-test-persona';
const base = `/api/v1/me/portfolio/elements/${TYPE}`;

describe('/me/portfolio reads', () => {
  it('returns a portfolio summary', async () => {
    const res = await world.clients.userA.get('/api/v1/me/portfolio');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('lists elements', async () => {
    const res = await world.clients.userA.get('/api/v1/me/portfolio/elements');
    expect(res.status).toBe(200);
  });

  it('404s an unknown element', async () => {
    const res = await world.clients.userA.get(`${base}/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe('/me/portfolio element authoring (write routes enabled)', () => {
  it('full CRUD round-trip: create -> read -> validate -> render -> edit -> delete', async () => {
    // create
    const created = await world.clients.userA.post(base, {
      body: { name: NAME, content: 'You are a helpful e2e test persona.', metadata: {}, tags: ['e2e'] },
    });
    expect(created.status).toBe(201);
    expect(created.etag).toBeTruthy();
    expect(created.body).toMatchObject({ type: TYPE, name: NAME });

    // read back — the create-returned ETag must equal an immediate GET's ETag,
    // so a client can use the create response for a follow-up conditional write.
    const read = await world.clients.userA.get(`${base}/${NAME}`);
    expect(read.status).toBe(200);
    expect(read.body.name).toBe(NAME);
    expect(read.etag).toBe(created.etag);

    // validate + render (side-effect-free authoring helpers)
    const validate = await world.clients.userA.post(`${base}/${NAME}/validate`, { body: {} });
    expect(validate.status).toBe(200);
    const render = await world.clients.userA.post(`${base}/${NAME}/render`, { body: {} });
    expect(render.status).toBe(200);

    // edit using the create-returned ETag (proves the ETag is write-usable)
    const edit = await world.clients.userA.patch(`${base}/${NAME}`, {
      body: { content: 'Updated e2e persona content.' },
      ifMatch: created.etag,
    });
    expect(edit.status).toBe(200);
    const afterEdit = await world.clients.userA.get(`${base}/${NAME}`);
    expect(afterEdit.etag).toBe(edit.etag);

    // appears in the list
    const list = await world.clients.userA.get('/api/v1/me/portfolio/elements?type=personas');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(NAME);

    // delete using the edit-returned ETag
    const del = await world.clients.userA.delete(`${base}/${NAME}`, { ifMatch: edit.etag });
    expect(del.status).toBe(200);
    const gone = await world.clients.userA.get(`${base}/${NAME}`);
    expect(gone.status).toBe(404);
  });

  it('lists every created element (no silently-dropped rows)', async () => {
    const names = ['count-a', 'count-b', 'count-c'];
    for (const name of names) {
      const c = await world.clients.userA.post(base, { body: { name, content: `body ${name}`, metadata: {} } });
      expect(c.status).toBe(201);
    }
    try {
      const list = await world.clients.userA.get('/api/v1/me/portfolio/elements?type=personas');
      expect(list.status).toBe(200);
      const blob = JSON.stringify(list.body);
      for (const name of names) expect(blob).toContain(name);
    } finally {
      for (const name of names) {
        const r = await world.clients.userA.get(`${base}/${name}`);
        if (r.status === 200) await world.clients.userA.delete(`${base}/${name}`, { ifMatch: r.etag });
      }
    }
  });

  it('rejects create without required content (422)', async () => {
    const res = await world.clients.userA.post(base, { body: { name: 'bad-element', metadata: {} } });
    expect(res.status).toBe(422);
  });

  it('edit without If-Match is rejected', async () => {
    // seed one to edit
    await world.clients.userA.post(base, { body: { name: 'precond-persona', content: 'x', metadata: {} } });
    const res = await world.clients.userA.patch(`${base}/precond-persona`, { body: { content: 'y' } });
    expect([412, 428]).toContain(res.status);
    // cleanup
    const read = await world.clients.userA.get(`${base}/precond-persona`);
    if (read.status === 200) await world.clients.userA.delete(`${base}/precond-persona`, { ifMatch: read.etag });
  });
});

describe('/me/portfolio/sync', () => {
  it('sync job status 404s for an unknown job', async () => {
    const res = await world.clients.userA.get('/api/v1/me/portfolio/sync/00000000-0000-4000-8000-000000000000');
    expect([404, 400]).toContain(res.status);
  });

  it('starting a sync responds without a server error', async () => {
    // No GitHub integration is connected in e2e, so this should be a structured
    // client error (or an accepted job), never a 5xx.
    const res = await world.clients.userA.post('/api/v1/me/portfolio/sync', {
      body: { direction: 'push', conflict_policy: 'fail' },
    });
    expect([202, 400, 409, 422]).toContain(res.status);
  });
});

describe('/me/portfolio/sync — request-guard rejections', () => {
  const SYNC = '/api/v1/me/portfolio/sync';
  const body = { direction: 'push', conflict_policy: 'fail' };

  it('rejects a mutation whose CSRF token does not match the cookie (403)', async () => {
    // Double-submit gate: the header is overridden to a value that no longer
    // equals the dh_csrf cookie, so the request must be rejected before the handler.
    const res = await world.clients.userA.post(SYNC, {
      body,
      headers: { 'x-csrf-token': 'not-the-cookie-value' },
    });
    expect(res.status).toBe(403);
    expect(res.problemCode).toBe('csrf_failed');
  });

  it('rejects an idempotency-required mutation sent without an Idempotency-Key (422)', async () => {
    const res = await world.clients.userA.post(SYNC, { body, idempotencyKey: null });
    expect(res.status).toBe(422);
    expect(res.problemCode).toBe('validation_failed');
  });
});
