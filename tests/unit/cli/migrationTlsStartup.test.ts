import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { migrationTlsOptions } from '../../../src/cli/migrationTls.js';

function readPacket(socket: Socket, minimum: number, maximum: number): Promise<Buffer> {
  return new Promise((done, reject) => {
    let data = Buffer.alloc(0);
    const finish = (error?: Error, packet?: Buffer) => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else if (packet) done(packet);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error('fixture connection closed before packet'));
    const onData = (chunk: Buffer) => {
      if (data.length + chunk.length > maximum) {
        finish(new Error('fixture packet exceeds limit'));
        return;
      }
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const length = data.readUInt32BE(0);
      if (length < minimum || length > maximum || data.length > length) {
        finish(new Error('invalid fixture packet length'));
      } else if (data.length === length) finish(undefined, data);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

it.each([false, true])('observes the real TLS startup with sanitized=%s', async (sanitized) => {
  const fixtures = resolve('tests/fixtures/tls/pinned-outbound');
  const certificate = resolve('tests/fixtures/postgres/localhost-cert.pem');
  const context = createSecureContext({
    key: readFileSync(resolve(fixtures, 'hostname-key.pem')),
    cert: readFileSync(certificate),
  });
  const sockets = new Set<Socket>();
  let packetReceived = false;
  let resolvePacket: (value: Buffer) => void = () => {};
  let rejectPacket: (error: Error) => void = () => {};
  const packet = new Promise<Buffer>((done, reject) => { resolvePacket = done; rejectPacket = reject; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', rejectPacket);
    void (async () => {
      const request = await readPacket(socket, 8, 8);
      if (request.readUInt32BE(4) !== 80877103) throw new Error('invalid SSL request');
      socket.write('S');
      const secure = new TLSSocket(socket, { isServer: true, secureContext: context });
      sockets.add(secure);
      secure.on('error', rejectPacket);
      const received = await readPacket(secure, 8, 65536);
      packetReceived = true;
      resolvePacket(received);
    })().catch(rejectPacket);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const original = `postgres://test:test@127.0.0.1:${address.port}/test?sslrootcert=system`;
  const settings = sanitized ? migrationTlsOptions(original) : { url: original, ssl: 'verify-full' };
  expect(settings.ssl).toBe('verify-full');
  const child = spawn(process.execPath, ['tests/fixtures/postgres/startup-client.mjs', settings.url, String(settings.ssl)], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.once('error', rejectPacket);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-1024); });
  const closed = new Promise<void>((done) => child.once('close', () => {
    if (!packetReceived) rejectPacket(new Error(`fixture TLS startup failed: ${stderr}`));
    done();
  }));
  let timer: NodeJS.Timeout | undefined;
  try {
    const received = await Promise.race([
      packet,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('startup fixture timed out')), 5000); }),
    ]);
    expect(received.subarray(8).toString('utf8')).toContain('user\0test\0');
    expect(received.subarray(8).toString('utf8').includes('sslrootcert')).toBe(!sanitized);
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    child.kill('SIGKILL');
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('fixture child did not close')), 5000);
      })]);
    } finally {
      clearTimeout(closeTimer);
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
});
