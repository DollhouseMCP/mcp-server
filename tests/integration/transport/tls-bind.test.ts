import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as net from 'node:net';
import express from 'express';
import {
  createHttpOrHttpsServer,
  isLoopbackHost,
} from '../../../src/server/createHttpOrHttpsServer.js';
import { TlsConfig } from '../../../src/server/TlsConfig.js';

async function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate test port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

describe('createHttpOrHttpsServer bind guard', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.get('/healthz', (_req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts an HTTP server on loopback without TLS', async () => {
    const port = await getFreePort('127.0.0.1');
    const { server, isHttps } = await createHttpOrHttpsServer(app, {
      host: '127.0.0.1',
      port,
      tlsConfig: new TlsConfig({}),
      allowUnsafeNonLoopback: false,
    });

    try {
      expect(isHttps).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('refuses non-loopback bind without TLS', async () => {
    await expect(
      createHttpOrHttpsServer(app, {
        host: '0.0.0.0',
        port: 0,
        tlsConfig: new TlsConfig({}),
        allowUnsafeNonLoopback: false,
      }),
    ).rejects.toThrow(/Refusing to bind to non-loopback host '0\.0\.0\.0' without TLS/);
  });

  it('allows non-loopback bind without TLS when the escape hatch is set', async () => {
    const port = await getFreePort('127.0.0.1');
    const { server, isHttps } = await createHttpOrHttpsServer(app, {
      host: '127.0.0.1',
      port,
      tlsConfig: new TlsConfig({}),
      allowUnsafeNonLoopback: true,
    });

    try {
      expect(isHttps).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('classifies loopback hosts correctly', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('classifies the entire 127.0.0.0/8 block as loopback (must-fix #8)', () => {
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.0.0.255')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
  });

  it('handles bracketed IPv6 form returned by URL.hostname', () => {
    // new URL('http://[::1]/').hostname returns '[::1]' in WHATWG.
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('does NOT mis-classify near-loopback hostnames as loopback', () => {
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('not-localhost')).toBe(false);
  });
});
