import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hono-static-security-'));
  await mkdir(join(root, 'static', 'admin'), { recursive: true });
  await writeFile(join(root, 'static', 'admin', 'secret.txt'), 'private fixture');
  await writeFile(join(root, 'static', 'hello world.txt'), 'public fixture');
  await writeFile(join(root, 'static', '100%.txt'), 'public percent fixture');
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // Send the original path through the real Node adapter, without a URL
    // helper normalizing the malformed percent sequence under test.
    get({ hostname: '127.0.0.1', port, path, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode!, body }));
    }).once('error', reject);
  });
}

async function withServer(app: Hono, check: (port: number) => Promise<void>): Promise<void> {
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await check((server.address() as AddressInfo).port);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

describe('Hono Node adapter static path security (CVE-2026-118663)', () => {
  it('keeps protected paths behind middleware and rejects a second decoding pass', async () => {
    const app = new Hono();
    app.use('/static/admin/*', context => context.text('Unauthorized', 401));
    app.use('/static/*', serveStatic({ root }));
    await withServer(app, async port => {
      for (const path of ['/static/admin/secret.txt', '/static/%61dmin/secret.txt']) {
        expect(await request(port, path)).toEqual({ status: 401, body: 'Unauthorized' });
      }
      const malformed = await request(port, '/static/%%36%31dmin/secret.txt');
      expect(malformed.status).toBe(404);
      expect(malformed.body).not.toContain('private fixture');
      expect(await request(port, '/static/hello%20world.txt'))
        .toEqual({ status: 200, body: 'public fixture' });
    });
  });

  it('requires explicit opt-in for public filenames containing a literal percent sign', async () => {
    const app = new Hono().use('/static/*', serveStatic({ root }));
    await withServer(app, async port => {
      expect((await request(port, '/static/100%25.txt')).status).toBe(404);
    });
    const publicApp = new Hono().use('/static/*', serveStatic({ root, allowPercentInPath: true }));
    await withServer(publicApp, async port => {
      expect(await request(port, '/static/100%25.txt'))
        .toEqual({ status: 200, body: 'public percent fixture' });
    });
  });
});
