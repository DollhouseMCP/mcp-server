import { gzipSync } from 'node:zlib';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createStreamableHttpApp } from '../../../src/server/createStreamableHttpApp.js';

function fixture() {
  const app = createStreamableHttpApp({ host: '127.0.0.1', onboarding: {
    claimPageRouter: express.Router(), apiRouter: express.Router(),
  } });
  const handler = jest.fn((req: express.Request, res: express.Response) => res.json({ received: req.body }));
  app.use('/api/v1', express.json(), handler);
  return { app, handler };
}
const paths = ['/api/v1/admin/accounts/invitations',
  '/api/v1/admin/accounts/invitations/00000000-0000-4000-8000-000000000001/regenerate',
  '/api/v1/admin/accounts/invitations/00000000-0000-4000-8000-000000000001/revoke'];

it.each(paths)('bounds %s before any console handler or generic parser', async path => {
  const { app, handler } = fixture();
  const secret = 'private-claim-material';
  const tooLarge = await request(app).post(path).send({ display_name: secret.repeat(110) });
  expect(tooLarge.status).toBe(413);
  expect(tooLarge.headers['cache-control']).toBe('no-store');
  expect(tooLarge.headers['content-security-policy']).toContain("script-src 'none'");
  expect(tooLarge.text).not.toContain(secret);
  const malformed = await request(app).post(path).set('Content-Type', 'application/json').send('{"secret":"' + secret);
  expect(malformed.status).toBe(400);
  expect(malformed.body).toEqual({ error: 'Invitation request unavailable' });
  expect(malformed.text).not.toContain(secret);
  const compressed = await request(app).post(path).set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip').send(gzipSync('{}'));
  expect(compressed.status).toBe(415);
  expect((await request(app).post(path).type('form').send({ secret })).status).toBe(415);
  expect(handler).not.toHaveBeenCalled();
  expect((await request(app).post(path).send({ ttl_hours: 24 })).body).toEqual({ received: { ttl_hours: 24 } });
  expect(handler).toHaveBeenCalledTimes(1);
});

it('preserves ordinary console body limits and rejects invalid hosts before parsing', async () => {
  const { app, handler } = fixture();
  const body = { text: 'x'.repeat(3000) };
  expect((await request(app).post('/api/v1/unrelated').send(body)).body).toEqual({ received: body });
  handler.mockClear();
  expect((await request(app).post(paths[0]).set('Host', 'attacker.test')
    .set('Content-Type', 'application/json').send('{')).status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
});
