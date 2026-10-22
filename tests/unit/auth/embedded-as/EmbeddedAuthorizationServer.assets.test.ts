import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { EmbeddedAuthorizationServer } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { TrivialConsentMethod } from '../../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { PackageResourceLocator } from '../../../../src/paths/PackageResourceLocator.js';

function appWithEmbeddedAs(basePath = '/'): express.Express {
  const as = new EmbeddedAuthorizationServer({
    publicBaseUrl: 'http://127.0.0.1:65530',
    methods: [new TrivialConsentMethod({ defaultSubject: 'asset-test' })],
    storage: new InMemoryAuthStorageLayer(),
  });
  const app = express();
  app.use(basePath, as.createRouter());
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

  it('serves assets below hidden package ancestors and a mounted base path, while keeping dotfiles private', async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), '.dollhouse-auth-assets-'));
    const publicRoot = path.join(packageRoot, 'src/web/public');
    let restoreLocate: (() => void) | undefined;
    try {
      await fs.mkdir(path.join(publicRoot, 'fonts'), { recursive: true });
      await fs.writeFile(path.join(publicRoot, 'fonts.css'), '@font-face { src: url(./fonts/test.woff2); }');
      await fs.writeFile(path.join(publicRoot, 'fonts/test.woff2'), 'public-font');
      await fs.writeFile(path.join(publicRoot, 'fonts/.private.woff2'), 'private-font');
      const fixtureLocator = new PackageResourceLocator(
        pathToFileURL(path.join(packageRoot, 'src/paths/PackageResourceLocator.js')).href,
      );
      const locate = fixtureLocator.locate.bind(fixtureLocator);
      const locateSpy = jest.spyOn(PackageResourceLocator.prototype, 'locate').mockImplementation(locate);
      restoreLocate = () => locateSpy.mockRestore();
      const app = appWithEmbeddedAs('/service/auth');

      const css = await request(app).get('/service/auth/fonts.css');
      expect(css.status).toBe(200);
      expect(css.headers['content-type']).toContain('text/css');
      expect(css.headers['cache-control']).toBe('public, max-age=3600');
      expect(css.text).toContain('url(./fonts/test.woff2)');

      const font = await request(app).get('/service/auth/fonts/test.woff2');
      expect(font.status).toBe(200);
      expect(font.headers['content-type']).toContain('font/woff2');

      const privateFont = await request(app).get('/service/auth/fonts/.private.woff2');
      expect(privateFont.status).toBe(404);
    } finally {
      restoreLocate?.();
      await fs.rm(packageRoot, { recursive: true, force: true });
    }
  });
});
