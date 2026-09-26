import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHttpModeActive } from '../../../src/index.js';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';
import { loadVersionedConsoleUi } from '../../../src/server/consoleUiAssets.js';

const CACHE_POLICY = 'no-store, max-age=0, must-revalidate';

describe('hosted console static cache policy', () => {
  beforeAll(() => setHttpModeActive(true));
  afterAll(() => setHttpModeActive(false));

  it('keeps the asset namespace stable until served content changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'console-ui-assets-'));
    try {
      await writeFile(join(directory, 'index.html'), '<script src="app.js"></script>');
      await writeFile(join(directory, 'app.js'), 'version one');
      const first = await loadVersionedConsoleUi(directory);
      const repeat = await loadVersionedConsoleUi(directory);
      expect(repeat).toEqual(first);
      expect(first.html).toContain(`${first.assetBasePath}/app.js`);

      await writeFile(join(directory, 'app.js'), 'version two');
      const next = await loadVersionedConsoleUi(directory);
      expect(next.assetBasePath).not.toBe(first.assetBasePath);
      expect(next.html).toContain(`${next.assetBasePath}/app.js`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('covers the HTML shell, module graph, CSS, conditional requests, and missing assets', async () => {
    const runtime = await createStreamableHttpRuntime(
      async () => ({ dispose: async () => {} }),
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        webConsoleApiV1: { router: express.Router(), markMounted: () => {} },
      },
    );

    try {
      const shell = await request(runtime.app).get('/ui/');
      expect(shell.status).toBe(200);
      expect(shell.headers['cache-control']).toBe(CACHE_POLICY);
      const assetBasePath = shell.text.match(/\/ui\/__assets\/[a-f0-9]{16}/)?.[0];
      expect(assetBasePath).toBeDefined();
      expect(shell.text).not.toContain('src="app.js"');
      const localAssetUrls = [...shell.text.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
      expect(localAssetUrls.length).toBeGreaterThan(15);
      expect(localAssetUrls.every(url => url.startsWith(`${assetBasePath}/`))).toBe(true);

      const indexHtml = await request(runtime.app).get('/ui/index.html');
      expect(indexHtml.text).toBe(shell.text);
      expect(indexHtml.headers['cache-control']).toBe(CACHE_POLICY);
      const redirect = await request(runtime.app).get('/ui').redirects(0);
      expect(redirect.status).toBe(301);
      expect(redirect.headers.location).toBe('/ui/');
      expect(redirect.headers['cache-control']).toBe(CACHE_POLICY);
      const redirectWithQuery = await request(runtime.app).get('/ui?tab=portfolio').redirects(0);
      expect(redirectWithQuery.status).toBe(301);
      expect(redirectWithQuery.headers.location).toBe('/ui/?tab=portfolio');

      for (const path of [
        `${assetBasePath}/app.js`,
        `${assetBasePath}/connect.js`,
        `${assetBasePath}/connect-catalog.js`,
        `${assetBasePath}/connect-extra-clients.js`,
        `${assetBasePath}/connect.css`,
        `${assetBasePath}/fonts.css`,
        `${assetBasePath}/fonts/manrope-xn7gYHE41ni1AdIRggOxSvfedN62Zw.woff2`,
        `${assetBasePath}/vendor/purify.min.js`,
      ]) {
        const response = await request(runtime.app).get(path);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe(CACHE_POLICY);
      }

      const app = await request(runtime.app).get(`${assetBasePath}/app.js`);
      expect(app.text).toContain("import('./connect.js')");
      const connectImportPath = new URL('./connect.js', `http://localhost${assetBasePath}/app.js`).pathname;
      expect(connectImportPath).toBe(`${assetBasePath}/connect.js`);
      const connect = await request(runtime.app).get(connectImportPath);
      expect(connect.text).toContain("from './connect-catalog.js'");
      expect(new URL('./connect-catalog.js', `http://localhost${connectImportPath}`).pathname)
        .toBe(`${assetBasePath}/connect-catalog.js`);

      const notModified = await request(runtime.app).get(`${assetBasePath}/app.js`).set('If-None-Match', app.headers.etag);
      expect(notModified.status).toBe(304);
      expect(notModified.headers['cache-control']).toBe(CACHE_POLICY);

      const head = await request(runtime.app).head(`${assetBasePath}/connect.js`);
      expect(head.status).toBe(200);
      expect(head.headers['cache-control']).toBe(CACHE_POLICY);

      const missing = await request(runtime.app).get(`${assetBasePath}/missing-module.js`);
      expect(missing.status).toBe(404);
      expect(missing.headers['cache-control']).toBe(CACHE_POLICY);
      const staleVersion = await request(runtime.app).get('/ui/__assets/0000000000000000/connect.js');
      expect(staleVersion.status).toBe(404);
      expect(staleVersion.headers['cache-control']).toBe(CACHE_POLICY);
      expect((await request(runtime.app).get(`${assetBasePath}/%69ndex.html`)).status).toBe(404);
      const unversioned = await request(runtime.app).get('/ui/connect.js');
      expect(unversioned.status).toBe(200);
      expect(unversioned.headers['cache-control']).toBe(CACHE_POLICY);

      const unrelated = await request(runtime.app).get('/version');
      expect(unrelated.status).toBe(200);
      expect(unrelated.headers['cache-control']).not.toBe(CACHE_POLICY);
    } finally {
      await runtime.close();
    }
  });
});
