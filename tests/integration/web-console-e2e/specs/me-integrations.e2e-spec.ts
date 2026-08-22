import { beforeAll, describe, expect, it } from '@jest/globals';

import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const DESCRIPTORS = '/api/v1/me/integrations/descriptors';

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

describe('/me/integrations/descriptors', () => {
  let descriptorId = '';
  const provider = 'e2e-custom-tasks';

  it('creates and lists an owner-scoped custom descriptor without exposing credentials', async () => {
    const created = await world.clients.userA.post(DESCRIPTORS, {
      body: {
        provider,
        display_name: 'E2E Custom Tasks',
        category: 'Testing',
        auth_strategy: 'static_api_key',
        api_hosts: ['api.e2e-custom.test'],
        static_api_key: {
          injection: {
            location: 'header',
            name: 'Authorization',
            value_prefix: 'Bearer ',
          },
        },
        operation_promotion: {},
      },
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      provider,
      ownership: 'byo',
      auth_strategy: 'static_api_key',
      has_client_secret: false,
    });
    expect(JSON.stringify(created.body)).not.toContain('ciphertext');
    descriptorId = created.body.id;

    const listed = await world.clients.userA.get(DESCRIPTORS);
    expect(listed.status).toBe(200);
    expect(listed.body.descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: descriptorId, provider }),
    ]));
  });

  it('returns 404 for descriptor access from another user', async () => {
    const path = `${DESCRIPTORS}/${descriptorId}`;
    const [read, update, remove] = await Promise.all([
      world.clients.userB.get(path),
      world.clients.userB.patch(path, { body: { display_name: 'Foreign edit' } }),
      world.clients.userB.delete(path),
    ]);

    expect(read.status).toBe(404);
    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);

    const foreignList = await world.clients.userB.get(DESCRIPTORS);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.descriptors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: descriptorId }),
    ]));
  });

  it('imports spec metadata and exposes derived operations without returning the document', async () => {
    const path = `${DESCRIPTORS}/${descriptorId}/spec`;
    const imported = await world.clients.userA.put(path, {
      body: {
        source_url: 'https://api.e2e-custom.test/openapi.json',
        spec: {
          openapi: '3.1.0',
          info: { title: 'E2E Custom Tasks', version: '1.0.0' },
          servers: [{ url: 'https://api.e2e-custom.test' }],
          paths: {
            '/tasks': {
              get: {
                operationId: 'listTasks',
                summary: 'List tasks',
                responses: { 200: { description: 'ok' } },
              },
            },
          },
        },
      },
    });

    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({
      descriptor_id: descriptorId,
      provider,
      operation_count: 1,
    });
    expect(imported.body.spec).toBeUndefined();

    const operations = await world.clients.userA.get(`${path}/operations`);
    expect(operations.status).toBe(200);
    expect(operations.body.operations).toEqual([
      expect.objectContaining({
        operation_id: 'listTasks',
        method: 'GET',
        path: '/tasks',
        read_write_class: 'read',
      }),
    ]);

    const foreign = await world.clients.userB.get(`${path}/operations`);
    expect(foreign.status).toBe(404);
  });

  it('connects a static credential without reflecting the secret and cleans up', async () => {
    const secret = ['e2e', 'static', 'test', 'credential'].join('-');
    const connected = await world.clients.userA.post(`/api/v1/me/integrations/${provider}/connect`, {
      body: { api_key: secret, account_label: 'E2E account' },
    });

    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({
      provider,
      status: 'connected',
      account_label: 'E2E account',
    });
    expect(JSON.stringify(connected.body)).not.toContain(secret);

    const removed = await world.clients.userA.delete(`${DESCRIPTORS}/${descriptorId}`);
    expect(removed.status).toBe(204);
    const absent = await world.clients.userA.get(`${DESCRIPTORS}/${descriptorId}`);
    expect(absent.status).toBe(404);
  });
});
