import { describe, expect, it } from '@jest/globals';
import nodemailer from 'nodemailer';
import {
  resolveSmtpConfiguration,
  SmtpConfigurationError,
  validateSmtpOptions,
} from '../../../../../src/auth/embedded-as/methods/smtpConfiguration.js';

const complete = () => ({
  host: 'smtp.example.test',
  port: 587,
  user: 'resend',
  password: 'secret-password',
  from: 'Beta@example.test',
});

describe('SMTP configuration', () => {
  it('treats a wholly absent configuration as disabled for manual delivery', () => {
    expect(resolveSmtpConfiguration({})).toEqual({ state: 'disabled' });
  });

  it('treats an explicitly configured port without credentials as incomplete', () => {
    const error = captureConfigurationError(() => resolveSmtpConfiguration({ port: 587 }));
    expect(error.code).toBe('incomplete');
    expect(error.message).toContain('DOLLHOUSE_SMTP_HOST');
  });

  it('rejects partial configuration with only missing variable names', () => {
    const secret = 'must-not-appear';
    const error = captureConfigurationError(() => resolveSmtpConfiguration({
      host: 'smtp.example.test',
      user: 'resend',
      password: secret,
    }));

    expect(error.code).toBe('incomplete');
    expect(error.message).toContain('DOLLHOUSE_SMTP_FROM');
    expect(error.message).not.toContain(secret);
    expect(error).not.toHaveProperty('cause');
  });

  it.each([
    ['smtp.example.test'],
    ['localhost'],
    ['127.0.0.1'],
    ['2001:db8::1'],
  ])('accepts hostname or IP host %s', host => {
    expect(resolveSmtpConfiguration({ ...complete(), host })).toMatchObject({
      state: 'enabled',
      options: { host },
    });
  });

  it.each([
    'https://smtp.example.test',
    'user@smtp.example.test',
    'smtp.example.test/path',
    '-smtp.example.test',
    'smtp..example.test',
    'smtp_example.test',
    'smtp.example.test\n',
  ])('rejects malformed SMTP host %j', host => {
    expect(() => resolveSmtpConfiguration({ ...complete(), host })).toThrow(SmtpConfigurationError);
  });

  it('derives STARTTLS for 587 and implicit TLS for 465', () => {
    expect(resolveSmtpConfiguration(complete())).toMatchObject({
      state: 'enabled',
      options: { port: 587, secure: false, tlsMode: 'starttls' },
    });
    expect(resolveSmtpConfiguration({ ...complete(), port: 465 })).toMatchObject({
      state: 'enabled',
      options: { port: 465, secure: true, tlsMode: 'implicit' },
    });
  });

  it.each([25, 2525, 0, 65536, 587.5])('rejects unsupported SMTP port %s', port => {
    expect(() => resolveSmtpConfiguration({ ...complete(), port })).toThrow(/DOLLHOUSE_SMTP_PORT/);
  });

  it.each([
    { port: 587, secure: true },
    { port: 465, secure: false },
  ])('rejects explicit TLS mode mismatch: %j', mismatch => {
    expect(() => resolveSmtpConfiguration({ ...complete(), ...mismatch })).toThrow(/SMTP TLS mode/);
  });

  it('preserves NFC sender local-part case and applies octet limits to the exact SMTP address', () => {
    const config = resolveSmtpConfiguration({ ...complete(), from: '  JosE\u0301@example.test  ' });
    expect(config).toMatchObject({ state: 'enabled', options: { from: 'JosÉ@example.test' } });

    const expandedByLowercase = `${'ẞ'.repeat(32)}@example.test`;
    expect(() => resolveSmtpConfiguration({ ...complete(), from: expandedByLowercase }))
      .toThrow(/DOLLHOUSE_SMTP_FROM/);
  });

  it('rejects a Unicode sender domain whose IDNA wire label exceeds 63 bytes', () => {
    const from = `person@${'a'.repeat(59)}é.test`;
    expect(Buffer.byteLength(from.split('@')[1].split('.')[0], 'utf8')).toBeLessThanOrEqual(63);
    expect(() => resolveSmtpConfiguration({ ...complete(), from })).toThrow(/DOLLHOUSE_SMTP_FROM/);
  });

  it('preserves local-part case while Nodemailer renders a valid Unicode domain as IDNA', async () => {
    const config = resolveSmtpConfiguration({ ...complete(), from: 'Beta@bücher.example' });
    expect(config.state).toBe('enabled');
    if (config.state !== 'enabled') return;
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const info = await transport.sendMail({
      from: config.options.from,
      to: 'recipient@example.test',
      subject: 'test',
      text: 'test',
    });

    expect(info.envelope.from).toBe('Beta@xn--bcher-kva.example');
  });

  it.each([
    'Dollhouse Beta <beta@example.test>',
    'one@example.test,two@example.test',
    'beta@example.test\r\nBcc: other@example.test',
    'invalid@example',
  ])('rejects non-addr-spec or unsafe sender %j', from => {
    expect(() => resolveSmtpConfiguration({ ...complete(), from })).toThrow(/DOLLHOUSE_SMTP_FROM/);
  });

  it('rejects invalid auth without including either credential in the error', () => {
    const error = captureConfigurationError(() => resolveSmtpConfiguration({
      ...complete(),
      user: 'private-user',
      password: 'secret-password\n',
    }));
    expect(error.code).toBe('invalid_auth');
    expect(error.message).not.toContain('private-user');
    expect(error.message).not.toContain('secret-password');
    expect(error).not.toHaveProperty('cause');
  });

  it.each([0, -1, 120_001, 1.5, Number.NaN])('rejects invalid timeout %s', connectionTimeoutMs => {
    expect(() => validateSmtpOptions({ ...complete(), connectionTimeoutMs })).toThrow(/SMTP timeout/);
  });
});

function captureConfigurationError(action: () => unknown): SmtpConfigurationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SmtpConfigurationError);
    return error as SmtpConfigurationError;
  }
  throw new Error('Expected SmtpConfigurationError');
}
