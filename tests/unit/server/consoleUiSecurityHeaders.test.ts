import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setHttpModeActive } from '../../../src/index.js';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';
import { CONSOLE_UI_CSP } from '../../../src/web-console/middleware/ConsoleSecurityHeaders.js';

const UI_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/web-console/ui');

const EXPECTED_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    + "font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
};

describe('hosted console security headers', () => {
  beforeAll(() => setHttpModeActive(true));
  afterAll(() => setHttpModeActive(false));

  it('sends them on the page, its assets and the redirect, and nothing looser on a missing asset', async () => {
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
      const assetBasePath = shell.text.match(/\/ui\/__assets\/[a-f0-9]{16}/)?.[0];
      expect(assetBasePath).toBeDefined();

      const responses = {
        shell,
        indexHtml: await request(runtime.app).get('/ui/index.html'),
        redirect: await request(runtime.app).get('/ui').redirects(0),
        script: await request(runtime.app).get(`${assetBasePath}/app.js`),
        stylesheet: await request(runtime.app).get(`${assetBasePath}/styles.css`),
        vendorScript: await request(runtime.app).get(`${assetBasePath}/vendor/purify.min.js`),
        missing: await request(runtime.app).get(`${assetBasePath}/missing-module.js`),
        legacyAsset: await request(runtime.app).get('/ui/app.js'),
      };
      expect(responses.redirect.status).toBe(301);
      expect(responses.missing.status).toBe(404);

      for (const [name, response] of Object.entries(responses)) {
        // Express writes the not-found page itself and gives it a policy that allows nothing at all.
        const expected = name === 'missing'
          ? { ...EXPECTED_HEADERS, 'content-security-policy': "default-src 'none'" }
          : EXPECTED_HEADERS;
        expect({ name, headers: pick(response.headers) }).toEqual({ name, headers: expected });
      }
    } finally {
      await runtime.close();
    }
  });

  it('allows scripts from the console\'s own files only: no inline code, no eval, no other site', () => {
    const scriptSources = CONSOLE_UI_CSP.split('; ').find(directive => directive.startsWith('script-src '));

    expect(scriptSources).toBe("script-src 'self'");
    expect(CONSOLE_UI_CSP).toContain("frame-ancestors 'none'");
    expect(CONSOLE_UI_CSP).not.toContain('http');
    expect(CONSOLE_UI_CSP).not.toContain('*');
  });

  // The policy only works while the page keeps to it. These read the page's
  // own source, so a change that the policy would silently break fails here.
  describe('the page keeps to the policy', () => {
    it('has no inline script, and loads every script and stylesheet from its own files', async () => {
      const html = await readFile(join(UI_DIRECTORY, 'index.html'), 'utf8');

      // Tag and attribute names are matched in any letter case, and values in either kind of quote.
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.length).toBe((html.match(/<script\b/gi) ?? []).length);
      for (const [, attributes, body] of scripts) {
        expect(attributes).toMatch(/\bsrc\s*=\s*(?:"[^":]+"|'[^':]+')/i);
        expect(body.trim()).toBe('');
      }
      const urls = [...html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)]
        .map(match => match[1] ?? match[2] ?? match[3]);
      expect(urls.length).toBeGreaterThan(10);
      for (const url of urls) {
        expect(url).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
      }
    });

    it('attaches no handler in markup, in the page or in what its scripts write', async () => {
      const files = (await readdir(UI_DIRECTORY)).filter(name => name.endsWith('.js') || name.endsWith('.html'));
      expect(files.length).toBeGreaterThan(20);
      const offenders: string[] = [];
      for (const name of files) {
        const source = await readFile(join(UI_DIRECTORY, name), 'utf8');
        // An attribute such as onclick="..." inside a tag, whether in HTML or in a template the script writes.
        if (/<[a-z][^<>]*\son[a-z]+\s*=\s*["'`$]/i.test(source)) offenders.push(name);
        if (/\bjavascript:/i.test(source)) offenders.push(`${name} (javascript: URL)`);
      }
      expect(offenders).toEqual([]);
    });

    it('uses eval nowhere, in its own scripts or the libraries it ships', async () => {
      const own = (await readdir(UI_DIRECTORY)).filter(name => name.endsWith('.js'));
      const vendored = (await readdir(join(UI_DIRECTORY, 'vendor'))).filter(name => name.endsWith('.js')).map(name => join('vendor', name));
      expect(vendored.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const name of [...own, ...vendored]) {
        const source = await readFile(join(UI_DIRECTORY, name), 'utf8');
        if (/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/.test(source)) offenders.push(name);
      }
      expect(offenders).toEqual([]);
    });
  });
});

function pick(headers: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(EXPECTED_HEADERS).map(name => [name, headers[name]]));
}
