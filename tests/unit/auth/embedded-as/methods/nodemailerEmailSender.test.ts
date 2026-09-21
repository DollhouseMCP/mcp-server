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

import { describe, it, expect, jest } from '@jest/globals';
import {
  classifySmtpReadinessFailure,
  NodemailerEmailSender,
  SmtpReadinessError,
} from '../../../../../src/auth/embedded-as/methods/nodemailerEmailSender.js';

const SMTP_HOST = 'smtp.example.com';
const FROM_EMAIL = 'from@example.com';

describe('NodemailerEmailSender — port enforcement', () => {
  it('refuses construction on a plaintext-only port (25)', () => {
    expect(() => new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 25,
      user: 'u', password: 'p', from: FROM_EMAIL,
    })).toThrow(/DOLLHOUSE_SMTP_PORT must be 587.*465/);
  });

  it('refuses construction on a plaintext-only port (2525)', () => {
    expect(() => new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 2525,
      user: 'u', password: 'p', from: FROM_EMAIL,
    })).toThrow(/DOLLHOUSE_SMTP_PORT must be 587.*465/);
  });

  it('accepts construction on STARTTLS port (587)', () => {
    expect(() => new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 587,
      user: 'u', password: 'p', from: FROM_EMAIL,
    })).not.toThrow();
  });

  it('accepts construction on implicit-TLS port (465)', () => {
    expect(() => new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 465,
      user: 'u', password: 'p', from: FROM_EMAIL,
    })).not.toThrow();
  });

  it.each([
    { port: 587, secure: true },
    { port: 465, secure: false },
  ])('refuses a TLS mode inconsistent with port $port', ({ port, secure }) => {
    expect(() => new NodemailerEmailSender({
      host: SMTP_HOST,
      port,
      secure,
      user: 'u', password: 'p', from: FROM_EMAIL,
    })).toThrow(/SMTP TLS mode/);
  });

  it('configures STARTTLS and all timeout phases on port 587', () => {
    const sender = new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 587,
      user: 'u', password: 'p', from: FROM_EMAIL,
      connectionTimeoutMs: 1_234,
    });
    const { options } = (sender as unknown as {
      transporter: { options: Record<string, unknown> };
    }).transporter;

    expect(options).toMatchObject({
      host: SMTP_HOST,
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'u', pass: 'p' },
      connectionTimeout: 1_234,
      greetingTimeout: 1_234,
      socketTimeout: 1_234,
    });
  });

  it('configures implicit TLS without requiring STARTTLS on port 465', () => {
    const sender = new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 465,
      user: 'u', password: 'p', from: FROM_EMAIL,
    });
    const { options } = (sender as unknown as {
      transporter: { options: Record<string, unknown> };
    }).transporter;

    expect(options).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
    });
  });
});

describe('NodemailerEmailSender — verify() must-fix #10 startup gate', () => {
  it('throws a sanitized neutral category for Nodemailer-wrapped unreachable sockets', async () => {
    // 127.0.0.1:1 is reliably "connection refused" on test machines
    // (port 1 is reserved tcpmux, almost never bound). Short timeout
    // keeps the test fast.
    const sender = new NodemailerEmailSender({
      host: '127.0.0.1',
      port: 587,
      user: 'u', password: 'p', from: FROM_EMAIL,
      connectionTimeoutMs: 500,
    });

    const error = await sender.verify().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SmtpReadinessError);
    expect(error).toMatchObject({ category: 'unknown' });
    expect((error as Error).message).not.toContain('127.0.0.1');
    expect(error).not.toHaveProperty('cause');
  }, 5_000);

  it.each([
    [{ code: 'EAUTH' }, 'authentication'],
    [{ code: 'EDNS' }, 'dns'],
    [{ code: 'ENOTFOUND' }, 'dns'],
    [{ code: 'ESOCKET' }, 'unknown'],
    [{ code: 'ECONNECTION' }, 'connection'],
    [{ code: 'ECONNREFUSED' }, 'connection'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'ETLS' }, 'tls'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'tls'],
    [{ code: 'EPROTOCOL' }, 'protocol'],
    [{ responseCode: 535 }, 'authentication'],
    [{ responseCode: 550 }, 'protocol'],
    [{ code: 'UNEXPECTED' }, 'unknown'],
  ] as const)('classifies readiness failures without inspecting raw messages: %j', (error, category) => {
    expect(classifySmtpReadinessFailure({
      ...error,
      message: 'SECRET smtp://user:password@example.test private@example.test',
      response: 'SECRET response',
      cause: new Error('SECRET cause'),
    })).toBe(category);
  });

  it('does not retain raw verification errors, causes, credentials, responses, or hosts', async () => {
    const sender = new NodemailerEmailSender({
      host: SMTP_HOST, port: 587, user: 'secret-user', password: 'secret-password', from: FROM_EMAIL,
    });
    const transport = (sender as unknown as {
      transporter: { verify(): Promise<unknown> };
    }).transporter;
    transport.verify = jest.fn<() => Promise<unknown>>().mockRejectedValue(Object.assign(
      new Error('smtp://secret-user:secret-password@smtp.example.com SECRET'),
      { code: 'EAUTH', response: '535 private upstream response', cause: new Error('SECRET cause') },
    ));

    const error = await sender.verify().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SmtpReadinessError);
    expect(error).toMatchObject({ category: 'authentication' });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect((error as Error).message).not.toContain(SMTP_HOST);
    expect(error).not.toHaveProperty('cause');
  });

  it('fails closed with neutral guidance when Nodemailer wraps a certificate failure as ESOCKET', async () => {
    const sender = new NodemailerEmailSender({
      host: SMTP_HOST, port: 587, user: 'private-user', password: 'private-password', from: FROM_EMAIL,
    });
    const transport = (sender as unknown as { transporter: { verify(): Promise<unknown> } }).transporter;
    transport.verify = jest.fn<() => Promise<unknown>>().mockRejectedValue(Object.assign(
      new Error(`certificate has expired for ${SMTP_HOST}`),
      { code: 'ESOCKET', command: 'CONN', cause: new Error('private TLS details') },
    ));
    const error = await sender.verify().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SmtpReadinessError);
    expect(error).toMatchObject({ category: 'unknown' });
    expect(String(error)).toContain('Check the SMTP service configuration');
    expect(String(error)).not.toContain('network policy');
    expect(String(error)).not.toContain(SMTP_HOST);
    expect(JSON.stringify(error)).not.toContain('private');
    expect(error).not.toHaveProperty('cause');
  });
});

describe('NodemailerEmailSender — magic-link delivery', () => {
  function createSenderWithMockTransport() {
    const sender = new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 587,
      user: 'u', password: 'p', from: FROM_EMAIL,
    });
    const transport = (sender as unknown as {
      transporter: { sendMail: (message: unknown) => Promise<unknown> };
    }).transporter;
    const sendMail = jest.fn((_message: unknown) => Promise.resolve({ messageId: 'test' }));
    transport.sendMail = sendMail;
    return { sender, sendMail };
  }

  it('passes the expected envelope and escaped HTML to Nodemailer', async () => {
    const { sender, sendMail } = createSenderWithMockTransport();

    await sender.sendMagicLink({
      to: 'user@example.com',
      url: 'https://mcp.example/auth/email/verify?token=a&next="<done>"',
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: FROM_EMAIL,
      to: 'user@example.com',
      subject: 'Sign in to DollhouseMCP',
      text: expect.stringContaining('token=a&next="<done>"'),
      html: expect.stringContaining('token=a&amp;next=&quot;&lt;done&gt;&quot;'),
    }));
  });

  it('accepts a magic-link URL at the 2048-character limit', async () => {
    const { sender, sendMail } = createSenderWithMockTransport();

    await sender.sendMagicLink({
      to: 'user@example.com',
      url: 'x'.repeat(2_048),
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('rejects a magic-link URL over 2048 characters before delivery', async () => {
    const { sender, sendMail } = createSenderWithMockTransport();

    await expect(sender.sendMagicLink({
      to: 'user@example.com',
      url: 'x'.repeat(2_049),
    })).rejects.toThrow('magic-link URL exceeds 2048 chars (got 2049)');
    expect(sendMail).not.toHaveBeenCalled();
  });
});
