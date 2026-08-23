import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createPinnedOutboundFactory } from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const PINNED_HOSTNAME = 'pinned-host.invalid';
const LOOPBACK = '127.0.0.1';

describe('createPinnedOutboundFactory', () => {
  let server: Server;
  let port: number;
  const seenPaths: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenPaths.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('Location', '/redirect-target');
        res.end();
        return;
      }
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('connects through the vetted address even when the URL hostname cannot resolve', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      const response = await outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/probe`);
      expect(await response.text()).toBe('ok');
    } finally {
      await outbound.close();
    }
  });

  it('rejects redirects by default without visiting the redirect target', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      await expect(outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/redirect`)).rejects.toThrow();
      expect(seenPaths).not.toContain('/redirect-target');
    } finally {
      await outbound.close();
    }
  });

  it('rejects an IP literal or different hostname before opening a connection', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      await expect(outbound.fetch(`http://${LOOPBACK}:${port}/wrong-host`)).rejects.toThrow(
        'pinned outbound URL hostname does not match vetted hostname',
      );
      await expect(outbound.fetch(`http://other.invalid:${port}/wrong-host`)).rejects.toThrow(
        'pinned outbound URL hostname does not match vetted hostname',
      );
      await expect(outbound.fetch(`http://[::1]:${port}/wrong-host`)).rejects.toThrow(
        'pinned outbound URL hostname does not match vetted hostname',
      );
      expect(seenPaths).not.toContain('/wrong-host');
    } finally {
      await outbound.close();
    }
  });

  it.each([
    'PINNED-HOST.INVALID',
    'pinned-host.invalid.',
  ])('accepts equivalent canonical hostname %s', async hostname => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      const response = await outbound.fetch(`http://${hostname}:${port}/equivalent-host`);
      expect(await response.text()).toBe('ok');
    } finally {
      await outbound.close();
    }
  });
});
