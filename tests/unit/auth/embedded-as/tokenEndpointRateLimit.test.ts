import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { createTokenEndpointRateLimitMiddleware } from '../../../../src/auth/embedded-as/tokenEndpointRateLimit.js';

describe('token endpoint rate limiting', () => {
  it('allows the normal request budget and returns an OAuth slow_down response at the limit', async () => {
    const app = express();
    const store = new InMemoryRateLimitStore();
    const currentTime = Date.now();
    app.post('/token', createTokenEndpointRateLimitMiddleware(store, () => currentTime), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    for (let requestNumber = 0; requestNumber < 120; requestNumber += 1) {
      await request(app).post('/token').expect(200);
    }
    const limited = await request(app).post('/token').expect(429);

    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.body).toEqual({
      error: 'slow_down',
      error_description: 'Too many token endpoint requests',
    });
  });

  it('starts a fresh budget after the rate-limit window', async () => {
    let currentTime = Date.now();
    const app = express();
    const store = new InMemoryRateLimitStore();
    app.post('/token', createTokenEndpointRateLimitMiddleware(store, () => currentTime), (_req, res) => {
      res.sendStatus(204);
    });

    for (let requestNumber = 0; requestNumber < 120; requestNumber += 1) {
      await request(app).post('/token').expect(204);
    }
    await request(app).post('/token').expect(429);
    currentTime += 60_000;
    await request(app).post('/token').expect(204);
  });
});
