/**
 * NodemailerEmailSender — must-fix #10 (SMTP STARTTLS mandatory).
 *
 * The constructor refuses non-TLS ports outright; verify() refuses to
 * declare success unless nodemailer can connect, negotiate TLS, and
 * authenticate. Failure modes that reach production silently
 * (unreachable host, refused STARTTLS, bad credentials) must surface
 * during AuthProviderFactory startup so operators don't ship a magic-
 * link configuration that silently never delivers email.
 */

import { describe, it, expect } from '@jest/globals';
import { NodemailerEmailSender } from '../../../../../src/auth/embedded-as/methods/nodemailerEmailSender.js';

describe('NodemailerEmailSender — port enforcement', () => {
  it('refuses construction on a plaintext-only port (25)', () => {
    expect(() => new NodemailerEmailSender({
      host: 'smtp.example.com',
      port: 25,
      user: 'u', password: 'p', from: 'from@example.com',
    })).toThrow(/not a TLS-supporting port/);
  });

  it('refuses construction on a plaintext-only port (2525)', () => {
    expect(() => new NodemailerEmailSender({
      host: 'smtp.example.com',
      port: 2525,
      user: 'u', password: 'p', from: 'from@example.com',
    })).toThrow(/not a TLS-supporting port/);
  });

  it('accepts construction on STARTTLS port (587)', () => {
    expect(() => new NodemailerEmailSender({
      host: 'smtp.example.com',
      port: 587,
      user: 'u', password: 'p', from: 'from@example.com',
    })).not.toThrow();
  });

  it('accepts construction on implicit-TLS port (465)', () => {
    expect(() => new NodemailerEmailSender({
      host: 'smtp.example.com',
      port: 465,
      user: 'u', password: 'p', from: 'from@example.com',
    })).not.toThrow();
  });
});

describe('NodemailerEmailSender — verify() must-fix #10 startup gate', () => {
  it('throws with an actionable error when the SMTP host is unreachable', async () => {
    // 127.0.0.1:1 is reliably "connection refused" on test machines
    // (port 1 is reserved tcpmux, almost never bound). Short timeout
    // keeps the test fast.
    const sender = new NodemailerEmailSender({
      host: '127.0.0.1',
      port: 587,
      user: 'u', password: 'p', from: 'from@example.com',
      connectionTimeoutMs: 500,
    });

    await expect(sender.verify()).rejects.toThrow(/SMTP verify failed for 127\.0\.0\.1:587/);
  }, 5_000);

  it('error message tells the operator what to check (STARTTLS / port / credentials)', async () => {
    const sender = new NodemailerEmailSender({
      host: '127.0.0.1',
      port: 465,
      user: 'u', password: 'p', from: 'from@example.com',
      connectionTimeoutMs: 500,
    });

    await expect(sender.verify()).rejects.toThrow(/STARTTLS|implicit TLS|authenticate/);
  }, 5_000);
});
