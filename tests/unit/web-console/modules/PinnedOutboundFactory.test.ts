import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createPinnedOutboundFactory } from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const PINNED_HOSTNAME = 'pinned-host.invalid';
const LOOPBACK = '127.0.0.1';
const TLS_FIXTURE_DIRECTORY = new URL('../../../fixtures/tls/pinned-outbound/', import.meta.url);
const PINNED_FACTORY_MODULE_URL = new URL(
  '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.ts',
  import.meta.url,
).href;
const TRUSTED_FETCH_CHILD = `
const address = process.env.DOLLHOUSE_PINNED_TLS_ADDRESS;
const factoryModuleUrl = process.env.DOLLHOUSE_PINNED_TLS_FACTORY_MODULE;
const mode = process.env.DOLLHOUSE_PINNED_TLS_MODE;
const port = Number(process.env.DOLLHOUSE_PINNED_TLS_PORT);
let outbound;
let result;
try {
  let response;
  if (mode === 'factory') {
    const { createPinnedOutboundFactory } = await import(factoryModuleUrl);
    outbound = createPinnedOutboundFactory()({
      hostname: process.env.DOLLHOUSE_PINNED_TLS_HOSTNAME,
      address,
      family: 4,
    });
    response = await outbound.fetch(
      \`https://\${process.env.DOLLHOUSE_PINNED_TLS_HOSTNAME}:\${port}/tls-probe\`,
    );
  } else {
    const { fetch } = await import('undici');
    response = await fetch(\`https://\${address}:\${port}/tls-probe\`);
  }
  result = { ok: true, status: response.status, body: await response.text() };
} catch (error) {
  const cause = error && typeof error === 'object' ? error.cause : undefined;
  result = {
    ok: false,
    code: cause && typeof cause === 'object' ? cause.code : error?.code,
    message: error instanceof Error ? error.message : String(error),
  };
} finally {
  await outbound?.close();
}
process.stdout.write(JSON.stringify(result));
`;

interface TrustedFetchResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly body?: string;
  readonly code?: string;
  readonly message?: string;
}

describe('createPinnedOutboundFactory', () => {
  let server: Server;
  let port: number;
  let hostnameTlsServer: ReturnType<typeof createHttpsServer>;
  let hostnameTlsPort: number;
  let addressTlsServer: ReturnType<typeof createHttpsServer>;
  let addressTlsPort: number;
  const seenHosts: string[] = [];
  const seenPaths: string[] = [];
  const seenServerNames: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenHosts.push(req.headers.host ?? '');
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

    const [hostnameCert, hostnameKey, addressCert, addressKey] = await Promise.all([
      readFile(new URL('hostname-cert.pem', TLS_FIXTURE_DIRECTORY)),
      readFile(new URL('hostname-key.pem', TLS_FIXTURE_DIRECTORY)),
      readFile(new URL('address-cert.pem', TLS_FIXTURE_DIRECTORY)),
      readFile(new URL('address-key.pem', TLS_FIXTURE_DIRECTORY)),
    ]);
    hostnameTlsServer = createHttpsServer({ cert: hostnameCert, key: hostnameKey }, (_req, res) => {
      res.end('tls-ok');
    });
    hostnameTlsServer.on('secureConnection', socket => {
      if (typeof socket.servername === 'string') seenServerNames.push(socket.servername);
    });
    await new Promise<void>(resolve => hostnameTlsServer.listen(0, LOOPBACK, resolve));
    hostnameTlsPort = (hostnameTlsServer.address() as AddressInfo).port;

    addressTlsServer = createHttpsServer({ cert: addressCert, key: addressKey }, (_req, res) => {
      res.end('tls-address-ok');
    });
    await new Promise<void>(resolve => addressTlsServer.listen(0, LOOPBACK, resolve));
    addressTlsPort = (addressTlsServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([
      new Promise<void>(resolve => hostnameTlsServer.close(() => resolve())),
      new Promise<void>(resolve => addressTlsServer.close(() => resolve())),
    ]);
  });

  it('connects through the vetted address without resolving the URL hostname', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      const response = await outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/probe`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    } finally {
      await outbound.close();
    }
  });

  it('presents the vetted hostname to the server rather than the pinned address', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      const response = await outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/host-check`);
      await response.arrayBuffer();
      expect(seenHosts.at(-1)).toBe(`${PINNED_HOSTNAME}:${port}`);
    } finally {
      await outbound.close();
    }
  });

  it('preserves the vetted hostname for TLS SNI and certificate validation', async () => {
    const result = await trustedTlsFetch(hostnameTlsPort, 'factory');

    expect(result).toEqual({ ok: true, status: 200, body: 'tls-ok' });
    expect(seenServerNames.at(-1)).toBe(PINNED_HOSTNAME);
    expect(seenServerNames.at(-1)).not.toBe(LOOPBACK);
  });

  it('rejects a trusted certificate for the pinned address that a host-rewriting client accepts', async () => {
    const pinnedResult = await trustedTlsFetch(addressTlsPort, 'factory');
    const deliberatelyBrokenControl = await trustedTlsFetch(addressTlsPort, 'rewritten');

    expect(pinnedResult).toMatchObject({ ok: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(deliberatelyBrokenControl).toEqual({
      ok: true,
      status: 200,
      body: 'tls-address-ok',
    });
  });

  it('rejects redirects without visiting the redirect target', async () => {
    const outbound = createPinnedOutboundFactory()({
      hostname: PINNED_HOSTNAME,
      address: LOOPBACK,
      family: 4,
    });
    try {
      await expect(
        outbound.fetch(`http://${PINNED_HOSTNAME}:${port}/redirect`, { redirect: 'follow' }),
      ).rejects.toThrow();
      expect(seenPaths).toContain('/redirect');
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

  it('close releases the socket pool and rejects further requests', async () => {
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

function trustedTlsFetch(port: number, mode: 'factory' | 'rewritten'): Promise<TrustedFetchResult> {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    TRUSTED_FETCH_CHILD,
  ], {
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    env: {
      ...process.env,
      DOLLHOUSE_PINNED_TLS_ADDRESS: LOOPBACK,
      DOLLHOUSE_PINNED_TLS_FACTORY_MODULE: PINNED_FACTORY_MODULE_URL,
      DOLLHOUSE_PINNED_TLS_HOSTNAME: PINNED_HOSTNAME,
      DOLLHOUSE_PINNED_TLS_MODE: mode,
      DOLLHOUSE_PINNED_TLS_PORT: String(port),
      NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('ca.pem', TLS_FIXTURE_DIRECTORY)),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`TLS fixture child exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as TrustedFetchResult);
      } catch {
        reject(new Error(`TLS fixture child returned invalid JSON: ${stdout} ${stderr}`));
      }
    });
  });
}
