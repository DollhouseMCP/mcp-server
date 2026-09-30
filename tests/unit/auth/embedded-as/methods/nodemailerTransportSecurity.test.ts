import { describe, expect, it } from '@jest/globals';
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import nodemailer from 'nodemailer';
import { classifySmtpReadinessFailure } from '../../../../../src/auth/embedded-as/methods/nodemailerEmailSender.js';

// Only ephemeral loopback listeners and verify(): no external relay or DATA.
async function listening(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

describe('installed Nodemailer SMTP transport security', () => {
  it.each([false, true])('refuses rejected STARTTLS before plaintext AUTH (advertised=%s)', async advertised => {
    const commands: string[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.write('220 fixture ESMTP\r\n');
      let pending = '';
      socket.on('data', chunk => {
        pending += chunk.toString();
        let end: number;
        while ((end = pending.indexOf('\r\n')) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          commands.push(line);
          if (line.startsWith('EHLO')) {
            socket.write(`250-fixture\r\n${advertised ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN LOGIN\r\n`);
          } else if (line === 'STARTTLS') socket.write('454 TLS temporarily unavailable\r\n');
          else socket.write('500 unexpected command\r\n');
        }
      });
    });
    const port = await listening(server);
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false,
      requireTLS: true, auth: { user: 'fixture-user', pass: 'fixture-password' },
      connectionTimeout: 1000, greetingTimeout: 1000, socketTimeout: 1000 });
    try {
      const failure: unknown = await transport.verify().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code: 'ETLS' });
      expect(classifySmtpReadinessFailure(failure)).toBe('tls');
      expect(commands).toContain('STARTTLS');
      expect(commands.some(command => /^(AUTH|MAIL|RCPT|DATA)\b/u.test(command))).toBe(false);
    } finally {
      transport.close();
      sockets.forEach(socket => socket.destroy());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects an untrusted implicit TLS certificate before SMTP authentication', async () => {
    const fixture = new URL('../../../../fixtures/tls/pinned-outbound/', import.meta.url);
    const [key, cert] = await Promise.all([
      readFile(new URL('hostname-key.pem', fixture)), readFile(new URL('hostname-cert.pem', fixture)),
    ]);
    const commands: string[] = [];
    const sockets = new Set<net.Socket>();
    const server = tls.createServer({ key, cert }, socket => {
      socket.write('220 fixture ESMTP\r\n');
      socket.on('data', data => commands.push(data.toString()));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    const tlsPort = await listening(server);
    // Observe wire bytes before the TLS server can reject the handshake.
    // A post-handshake callback cannot detect leaked plaintext AUTH here.
    const wireChunks: Buffer[] = [];
    const proxy = net.createServer(socket => {
      const upstream = net.connect(tlsPort, '127.0.0.1');
      for (const connection of [socket, upstream]) {
        sockets.add(connection);
        connection.on('error', () => {});
        connection.on('close', () => sockets.delete(connection));
      }
      socket.on('data', data => wireChunks.push(Buffer.from(data)));
      socket.pipe(upstream).pipe(socket);
    });
    const port = await listening(proxy);
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: true,
      auth: { user: 'fixture-user', pass: 'fixture-password' },
      connectionTimeout: 1000, greetingTimeout: 1000, socketTimeout: 1000 });
    try {
      const failure: unknown = await transport.verify().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code: 'ESOCKET' });
      expect(classifySmtpReadinessFailure(failure)).toBe('unknown');
      expect(commands).toEqual([]);
      const wire = Buffer.concat(wireChunks);
      expect(wire.length).toBeGreaterThan(5);
      expect(wire[0]).toBe(22); // ClientHello handshake record, not SMTP.
      let offset = 0;
      while (offset < wire.length) {
        expect(wire.length - offset).toBeGreaterThanOrEqual(5);
        expect([20, 21, 22, 23]).toContain(wire[offset]);
        expect(wire[offset + 1]).toBe(3);
        offset += 5 + wire.readUInt16BE(offset + 3);
        expect(offset).toBeLessThanOrEqual(wire.length);
      }
    } finally {
      transport.close();
      sockets.forEach(socket => socket.destroy());
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('bounds a relay that never supplies an SMTP greeting', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    const port = await listening(server);
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port, requireTLS: true,
      connectionTimeout: 1000, greetingTimeout: 100, socketTimeout: 1000 });
    try {
      const failure: unknown = await transport.verify().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code: 'ETIMEDOUT' });
      expect(classifySmtpReadinessFailure(failure)).toBe('timeout');
    } finally {
      transport.close();
      sockets.forEach(socket => socket.destroy());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('classifies rejected authentication over verified implicit TLS', async () => {
    const fixture = new URL('../../../../fixtures/tls/pinned-outbound/', import.meta.url);
    const [key, cert, ca] = await Promise.all(['hostname-key.pem', 'hostname-cert.pem', 'ca.pem']
      .map(name => readFile(new URL(name, fixture))));
    const commands: string[] = [];
    const sockets = new Set<net.Socket>();
    const server = tls.createServer({ key, cert }, socket => {
      socket.write('220 fixture ESMTP\r\n');
      let pending = '';
      socket.on('data', data => {
        pending += data.toString();
        let end: number;
        while ((end = pending.indexOf('\r\n')) !== -1) {
          const command = pending.slice(0, end);
          pending = pending.slice(end + 2);
          commands.push(command);
          if (command.startsWith('EHLO')) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
          else socket.write('535 authentication rejected\r\n');
        }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    const port = await listening(server);
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: true,
      tls: { ca, servername: 'pinned-host.invalid' },
      auth: { user: 'fixture-user', pass: 'fixture-password' },
      connectionTimeout: 1000, greetingTimeout: 1000, socketTimeout: 1000 });
    try {
      const failure: unknown = await transport.verify().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code: 'EAUTH', responseCode: 535 });
      expect(classifySmtpReadinessFailure(failure)).toBe('authentication');
      expect(commands.some(command => command.startsWith('AUTH PLAIN'))).toBe(true);
      expect(commands.some(command => /^(MAIL|RCPT|DATA)\b/u.test(command))).toBe(false);
    } finally {
      transport.close();
      sockets.forEach(socket => socket.destroy());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
