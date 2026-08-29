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
import { NodemailerEmailSender } from '../../../../../src/auth/embedded-as/methods/nodemailerEmailSender.js';

const SMTP_HOST = 'smtp.example.com';
const FROM_EMAIL = 'from@example.com';

describe('NodemailerEmailSender — port enforcement', () => {
  it('refuses construction on a plaintext-only port (25)', () => {
    expect(() => new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 25,
      user: 'u', password: 'p', from: FROM_EMAIL,
    })).toThrow(/not a TLS-supporting port/);
  });

  it('refuses construction on a plaintext-only port (2525)', () => {
    expect(() => new NodemailerEmailSender({
      host: SMTP_HOST,
      port: 2525,
      user: 'u', password: 'p', from: FROM_EMAIL,
    })).toThrow(/not a TLS-supporting port/);
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
  it('throws with an actionable error when the SMTP host is unreachable', async () => {
    // 127.0.0.1:1 is reliably "connection refused" on test machines
    // (port 1 is reserved tcpmux, almost never bound). Short timeout
    // keeps the test fast.
    const sender = new NodemailerEmailSender({
      host: '127.0.0.1',
      port: 587,
      user: 'u', password: 'p', from: FROM_EMAIL,
      connectionTimeoutMs: 500,
    });

    await expect(sender.verify()).rejects.toThrow(/SMTP verify failed for 127\.0\.0\.1:587/);
  }, 5_000);

  it('error message tells the operator what to check (STARTTLS / port / credentials)', async () => {
    const sender = new NodemailerEmailSender({
      host: '127.0.0.1',
      port: 465,
      user: 'u', password: 'p', from: FROM_EMAIL,
      connectionTimeoutMs: 500,
    });

    const verificationError = await sender.verify().catch((error: unknown) => error);
    expect(verificationError).toBeInstanceOf(Error);
    if (!(verificationError instanceof Error)) {
      throw new Error('Expected SMTP verification to reject with an Error');
    }
    expect(verificationError.message).toContain('SMTP verify failed for 127.0.0.1:465');
    expect(verificationError.message).toContain(
      'Confirm the server supports STARTTLS (port 587) or implicit TLS (port 465)',
    );
  }, 5_000);
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
