/**
 * Regression tests for console token injection into index.html (#1804).
 *
 * Verifies that:
 * 1. GET / returns HTML with the real token, not the {{CONSOLE_TOKEN}} placeholder
 * 2. Static assets (CSS, JS) are still served correctly by express.static
 * 3. Cache invalidates when the primary token changes (rotation)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Minimal index.html template matching the real one's token placeholder. */
const INDEX_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <meta name="dollhouse-console-token" content="{{CONSOLE_TOKEN}}">
  <meta name="dollhouse-console-asset-version" content="{{DOLLHOUSE_ASSET_VERSION}}">
  <link rel="icon" type="image/png" href="dollhouse-logo.png?v={{DOLLHOUSE_ASSET_VERSION}}">
  <link rel="stylesheet" href="styles.css?v={{DOLLHOUSE_ASSET_VERSION}}">
</head>
<body><h1>DollhouseMCP Console</h1><script src="app.js?v={{DOLLHOUSE_ASSET_VERSION}}"></script></body>
</html>`;

const TOKEN_META_PLACEHOLDER = '{{CONSOLE_TOKEN}}';
const ASSET_VERSION_PLACEHOLDER = '{{DOLLHOUSE_ASSET_VERSION}}';

/** A valid 64-hex-char token. */
const TEST_TOKEN = 'a'.repeat(64);
const ROTATED_TOKEN = 'b'.repeat(64);

/**
 * Build a minimal Express app that replicates the server's static file
 * serving + SPA fallback pattern. Uses a temp public directory with
 * index.html and a test CSS file.
 */
async function buildTestApp(options: {
  publicDir: string;
  getToken: () => string;
  getAssetVersion?: () => string;
}) {
  const app = express();

  // Same pattern as server.ts: static with index: false, then SPA fallback
  app.use(express.static(options.publicDir, { index: false }));

  let cachedHtml: string | null = null;
  let cachedToken: string | null = null;

  app.get('/{*path}', async (_req, res) => {
    const currentToken = options.getToken();
    const currentAssetVersion = options.getAssetVersion ? options.getAssetVersion() : '2.0.18';
    if (cachedHtml !== null && cachedToken === currentToken) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(cachedHtml);
      return;
    }
    const { readFile } = await import('node:fs/promises');
    const template = await readFile(join(options.publicDir, 'index.html'), 'utf8');
    const escaped = currentToken
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    cachedHtml = template.replaceAll(TOKEN_META_PLACEHOLDER, escaped);
    cachedHtml = cachedHtml.replaceAll(ASSET_VERSION_PLACEHOLDER, currentAssetVersion);
    cachedToken = currentToken;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(cachedHtml);
  });

  return app;
}

describe('token injection into index.html (#1804)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-token-inject-test-'));
    await writeFile(join(testDir, 'index.html'), INDEX_TEMPLATE, 'utf8');
    await writeFile(join(testDir, 'styles.css'), 'body { color: red; }', 'utf8');
    await writeFile(join(testDir, 'app.js'), 'console.log("ok");', 'utf8');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('GET / returns HTML with the real token, not the placeholder', async () => {
    const app = await buildTestApp({
      publicDir: testDir,
      getToken: () => TEST_TOKEN,
      getAssetVersion: () => '2.0.18',
    });

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain(`content="${TEST_TOKEN}"`);
    expect(res.text).not.toContain('{{CONSOLE_TOKEN}}');
    expect(res.text).toContain('content="2.0.18"');
    expect(res.text).toContain('href="dollhouse-logo.png?v=2.0.18"');
    expect(res.text).toContain('styles.css?v=2.0.18');
    expect(res.text).toContain('app.js?v=2.0.18');
    expect(res.text).not.toContain('{{DOLLHOUSE_ASSET_VERSION}}');
  });

  it('serves empty token when no token is available', async () => {
    const app = await buildTestApp({
      publicDir: testDir,
      getToken: () => '',
      getAssetVersion: () => '2.0.18',
    });

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('content=""');
    expect(res.text).not.toContain('{{CONSOLE_TOKEN}}');
  });

  it('static CSS files are still served by express.static', async () => {
    const app = await buildTestApp({
      publicDir: testDir,
      getToken: () => TEST_TOKEN,
      getAssetVersion: () => '2.0.18',
    });

    const res = await request(app).get('/styles.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.text).toContain('body { color: red; }');
  });

  it('static JS files are still served by express.static', async () => {
    const app = await buildTestApp({
      publicDir: testDir,
      getToken: () => TEST_TOKEN,
      getAssetVersion: () => '2.0.18',
    });

    const res = await request(app).get('/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log("ok")');
  });

  it('cache invalidates when the token changes (rotation)', async () => {
    let currentToken = TEST_TOKEN;
    const app = await buildTestApp({
      publicDir: testDir,
      getToken: () => currentToken,
      getAssetVersion: () => '2.0.18',
    });

    // First request caches with TEST_TOKEN
    const res1 = await request(app).get('/');
    expect(res1.text).toContain(`content="${TEST_TOKEN}"`);

    // Simulate rotation
    currentToken = ROTATED_TOKEN;

    // Second request should detect the token change and re-render
    const res2 = await request(app).get('/');
    expect(res2.text).toContain(`content="${ROTATED_TOKEN}"`);
    expect(res2.text).not.toContain(TEST_TOKEN);
  });

  it('HTML-escapes token values defensively', async () => {
    const app = await buildTestApp({
      publicDir: testDir,
      getToken: () => 'a"b<c&d',
      getAssetVersion: () => '2.0.18',
    });

    const res = await request(app).get('/');
    expect(res.text).toContain('content="a&quot;b&lt;c&amp;d"');
    expect(res.text).not.toContain('content="a"b<c&d"');
  });

  it('SPA fallback handles deep paths without breaking', async () => {
    const app = await buildTestApp({
      publicDir: testDir,
      getToken: () => TEST_TOKEN,
      getAssetVersion: () => '2.0.18',
    });

    const res = await request(app).get('/some/deep/path');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain(`content="${TEST_TOKEN}"`);
  });
});
