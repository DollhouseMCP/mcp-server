import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createPinnedOutboundFactory } from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const PINNED_HOSTNAME = 'pinned-host.invalid';
const LOOPBACK = '127.0.0.1';

describe('createPinnedOutboundFactory', () => {
  let server: Server;
  let port: number;
  let seenHosts: string[];
  let seenPaths: string[];

  beforeAll(async () => {
    seenHosts = [];
    seenPaths = [];
    server = createServer((req, res) => {
      seenHosts.push(req.headers.host ?? '');
      seenPaths.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('Location', '/redirect-target');
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('connects to the pinned address, not a DNS answer for the hostname', async () => {
    // `.invalid` is reserved (RFC 2606) and never resolves, so this request can
    // only succeed if the socket target came from the pin — structurally proving
    // that no connect-time DNS resolution influences the connection.
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      const response = await outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/probe`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await outbound.close();
    }
  });

  it('presents the original hostname to the server, not the pinned address', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      const response = await outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/host-check`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(seenHosts.at(-1)).toBe(`${PINNED_HOSTNAME}:${port}`);
    } finally {
      await outbound.close();
    }
  });

  it('rejects a real 302 under redirect: error without following it', async () => {
    // Behavioral proof that the production transport honors redirect: 'error' —
    // consumer suites stub the transport, so this is the one live-path check.
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      await expect(
        outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/redirect`, { redirect: 'error' }),
      ).rejects.toThrow();
      expect(seenPaths).toContain('/redirect');
      expect(seenPaths).not.toContain('/redirect-target');
    } finally {
      await outbound.close();
    }
  });

  it('close() releases the socket pool and further requests fail', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    const response = await outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/before-close`);
    await response.arrayBuffer();
    await outbound.close();
    await expect(outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/after-close`)).rejects.toThrow();
  });
});
