import { beforeAll, describe, expect, it } from '@jest/globals';

import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const TYPE = 'personas';
// Mixed-case on purpose: the filename stem the store addresses elements by is
// lowercased, while the storage-layer name index is keyed by the raw name —
// a name like this is the regression guard for that resolution mismatch.
const NAME = 'E2E-Test-Persona';
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

  it('404s an unknown element as an RFC 9457 problem document', async () => {
    const res = await world.clients.userA.get(`${base}/does-not-exist`);
    expect(res.status).toBe(404);
    // Handler errors must ship the same problem+json envelope as middleware
    // errors: typed `type` URI, `instance` echoing the request correlation id.
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const problem = res.body as Record<string, unknown>;
    expect(problem.type).toBe('https://dollhousemcp.com/errors/portfolio_element_not_found');
    expect(problem.code).toBe('portfolio_element_not_found');
    expect(problem.instance).toBe(res.headers.get('x-correlation-id'));
  });
});

describe('/me/portfolio element authoring (write routes enabled)', () => {
  it('creates, edits, and deletes every supported portfolio type', async () => {
    const fixtures = [
      { type: 'personas', name: 'alpha-all-types-persona', content: 'Persona instructions.', preserved: 'Persona instructions.', metadata: { description: 'Persona' } },
      { type: 'skills', name: 'alpha-all-types-skill', content: 'Skill instructions.', preserved: 'Skill instructions.', metadata: { description: 'Skill' } },
      { type: 'templates', name: 'alpha-all-types-template', content: 'Hello {{name}}', preserved: 'Hello {{name}}', metadata: { description: 'Template' } },
      { type: 'agents', name: 'alpha-all-types-agent', content: 'Agent instructions.', preserved: 'Agent instructions.', metadata: { description: 'Agent', goal: 'Assist carefully' } },
      { type: 'memories', name: 'alpha-all-types-memory', content: 'entries:\n  - content: Remember the alpha test.', preserved: 'Remember the alpha test.', metadata: { description: 'Memory' } },
      { type: 'ensembles', name: 'alpha-all-types-ensemble', content: 'Alpha ensemble.', preserved: '"elements":[]', metadata: { description: 'Ensemble', elements: [] } },
    ] as const;

    for (const fixture of fixtures) {
      const typeBase = `/api/v1/me/portfolio/elements/${fixture.type}`;
      const created = await world.clients.userA.post(typeBase, {
        body: { name: fixture.name, content: fixture.content, metadata: fixture.metadata, tags: ['all-types'] },
      });
      expect(created.status).toBe(201);
      const read = await world.clients.userA.get(`${typeBase}/${fixture.name}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ type: fixture.type, name: fixture.name });
      const edited = await world.clients.userA.patch(`${typeBase}/${fixture.name}`, {
        body: { tags: ['edited-all-types'] },
        ifMatch: read.etag,
      });
      expect(edited.status).toBe(200);
      const afterEdit = await world.clients.userA.get(`${typeBase}/${fixture.name}`);
      expect(afterEdit.status).toBe(200);
      expect(JSON.stringify(afterEdit.body)).toContain(fixture.preserved);
      expect(afterEdit.body.tags).toEqual(['edited-all-types']);
      const deleted = await world.clients.userA.delete(`${typeBase}/${fixture.name}`, { ifMatch: edited.etag });
      expect(deleted.status).toBe(200);
    }
  });

  it('persists guided metadata when reference content is optional', async () => {
    const fixtures = [
      {
        type: 'personas',
        name: 'guided-empty-content-persona',
        metadata: {
          description: 'Guided persona',
          instructions: 'You are a careful guided persona.',
        },
      },
      {
        type: 'skills',
        name: 'guided-empty-content-skill',
        metadata: {
          description: 'Guided skill',
          instructions: 'Follow the guided procedure in order.',
        },
      },
      {
        type: 'agents',
        name: 'guided-empty-content-agent',
        metadata: {
          description: 'Guided agent',
          instructions: 'Work incrementally and verify each result.',
          goal: {
            template: 'Research {topic} and recommend a path.',
            parameters: [],
          },
        },
      },
      {
        type: 'ensembles',
        name: 'guided-empty-content-ensemble',
        metadata: {
          description: 'Guided ensemble',
          instructions: 'Coordinate the configured elements.',
          activationStrategy: 'priority',
          conflictResolution: 'merge',
          contextSharing: 'selective',
          allowNested: false,
          elements: [{
            element_name: 'guided-empty-content-persona',
            element_type: 'persona',
            role: 'primary',
            priority: 10,
            activation: 'always',
          }],
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const typeBase = `/api/v1/me/portfolio/elements/${fixture.type}`;
      const created = await world.clients.userA.post(typeBase, {
        body: {
          name: fixture.name,
          metadata: fixture.metadata,
          tags: ['guided'],
        },
      });
      expect(created.status).toBe(201);

      const read = await world.clients.userA.get(`${typeBase}/${fixture.name}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        type: fixture.type,
        name: fixture.name,
        tags: ['guided'],
      });
      expect(JSON.stringify(read.body.metadata)).toContain(fixture.metadata.description);
      expect(read.body.metadata.instructions).toBe(fixture.metadata.instructions);

      const deleted = await world.clients.userA.delete(`${typeBase}/${fixture.name}`, { ifMatch: read.etag });
      expect(deleted.status).toBe(200);
    }
  });

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

  // Memories are the one type the BFF stores as pure YAML (an `entries` array)
  // rather than markdown-with-frontmatter, so they need their own round-trip:
  // the persona path above structurally can't catch a memory serialization bug
  // (e.g. silently dropping entries on create).
  it('memory CRUD round-trip preserves entries (pure-YAML path)', async () => {
    const memBase = '/api/v1/me/portfolio/elements/memories';
    const memName = 'Mixed-Case-Memory'; // mixed-case: guards the name→id delete resolution
    const memContent = [
      'entries:',
      '  - content: First e2e memory entry.',
      '    tags: [e2e]',
      '  - content: Second e2e memory entry.',
    ].join('\n');

    const created = await world.clients.userA.post(memBase, {
      body: { name: memName, content: memContent, metadata: {}, tags: ['e2e'] },
    });
    expect(created.status).toBe(201);

    // The entries must survive the create round-trip — the regression guard for
    // the memory pure-YAML serialization path.
    const read = await world.clients.userA.get(`${memBase}/${memName}`);
    expect(read.status).toBe(200);
    expect(read.body.content).toContain('First e2e memory entry.');
    expect(read.body.content).toContain('Second e2e memory entry.');

    const render = await world.clients.userA.post(`${memBase}/${memName}/render`, { body: {} });
    expect(render.status).toBe(200);

    const edit = await world.clients.userA.patch(`${memBase}/${memName}`, {
      body: { content: 'entries:\n  - content: Edited memory entry.' },
      ifMatch: read.etag,
    });
    expect(edit.status).toBe(200);
    const afterEdit = await world.clients.userA.get(`${memBase}/${memName}`);
    expect(afterEdit.body.content).toContain('Edited memory entry.');

    const del = await world.clients.userA.delete(`${memBase}/${memName}`, { ifMatch: edit.etag });
    expect(del.status).toBe(200);
    const gone = await world.clients.userA.get(`${memBase}/${memName}`);
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

  it('rejects stale ETags for both update and hard delete', async () => {
    const name = 'stale-etag-persona';
    const created = await world.clients.userA.post(base, { body: { name, content: 'first', metadata: {} } });
    expect(created.status).toBe(201);
    const updated = await world.clients.userA.patch(`${base}/${name}`, {
      body: { content: 'second' },
      ifMatch: created.etag,
    });
    expect(updated.status).toBe(200);
    const staleUpdate = await world.clients.userA.patch(`${base}/${name}`, {
      body: { content: 'third' },
      ifMatch: created.etag,
    });
    expect(staleUpdate.status).toBe(412);
    const staleDelete = await world.clients.userA.delete(`${base}/${name}`, { ifMatch: created.etag });
    expect(staleDelete.status).toBe(412);
    const cleanup = await world.clients.userA.delete(`${base}/${name}`, { ifMatch: updated.etag });
    expect(cleanup.status).toBe(200);
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
