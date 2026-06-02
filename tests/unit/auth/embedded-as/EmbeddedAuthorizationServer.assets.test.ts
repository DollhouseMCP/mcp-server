import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { EmbeddedAuthorizationServer } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { TrivialConsentMethod } from '../../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';

function appWithEmbeddedAs(): express.Express {
  const as = new EmbeddedAuthorizationServer({
    publicBaseUrl: 'http://127.0.0.1:65530',
    methods: [new TrivialConsentMethod({ defaultSubject: 'asset-test' })],
    storage: new InMemoryAuthStorageLayer(),
  });
  const app = express();
  app.use(as.createRouter());
  return app;
}

describe('EmbeddedAuthorizationServer — hosted auth assets', () => {
  it('serves the first-party assets used by generated auth pages', async () => {
    const app = appWithEmbeddedAs();

    const css = await request(app).get('/fonts.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.text).toContain('@font-face');

    const logo = await request(app).get('/dollhouse-logo.png');
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toContain('image/png');

    const font = await request(app).get('/fonts/plusjakartasans-LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko70yygg_vbd-E.woff2');
    expect(font.status).toBe(200);
    expect(font.headers['content-type']).toContain('font/woff2');
  });

  it('rejects path-shaped font names', async () => {
    const app = appWithEmbeddedAs();

    const res = await request(app).get('/fonts/not-a-font.txt');

    expect(res.status).toBe(404);
  });
});
