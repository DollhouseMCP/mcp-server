import { describe, expect, it } from '@jest/globals';

import {
  MAX_INVITATION_EMAIL_OCTETS,
  normalizeInvitationEmail,
} from '../../../src/invitations/InvitationEmail.js';

describe('normalizeInvitationEmail', () => {
  it('reuses allowlist NFC, trim, and lowercase semantics', () => {
    expect(normalizeInvitationEmail('  TÉSTER@Example.COM  '))
      .toBe('t\u00e9ster@example.com');
  });

  it.each([
    ['international local and domain parts', 'δοκιμή@παράδειγμα.δοκιμή'],
    ['supported dot-atom punctuation', "first.last+tag/o'reilly@example-domain.com"],
    ['punycode domain label', 'user@xn--bcher-kva.example'],
  ])('accepts %s', (_description, value) => {
    expect(normalizeInvitationEmail(value)).toBe(value);
  });

  it('accepts 254 UTF-8 octets and rejects 255', () => {
    const localPart = 'a'.repeat(64);
    const domainAtLimit = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    const atLimit = `${localPart}@${domainAtLimit}`;
    const beyondLimit = `${atLimit}e`;

    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_INVITATION_EMAIL_OCTETS);
    expect(Buffer.byteLength(beyondLimit, 'utf8')).toBe(MAX_INVITATION_EMAIL_OCTETS + 1);
    expect(normalizeInvitationEmail(atLimit)).toBe(atLimit);
    expect(() => normalizeInvitationEmail(beyondLimit)).toThrow('valid email address');
  });

  it('applies local-part limits to UTF-8 octets', () => {
    expect(normalizeInvitationEmail(`${'é'.repeat(32)}@example.com`))
      .toBe(`${'é'.repeat(32)}@example.com`);
    expect(() => normalizeInvitationEmail(`${'é'.repeat(33)}@example.com`))
      .toThrow('valid email address');
  });

  it.each([
    'missing-at.example.com',
    '@example.com',
    'user@example',
    'user@example..com',
    'user @example.com',
    'user\0@example.com',
    'user\n@example.com',
    'user\u007f@example.com',
    '.user@example.com',
    'user.@example.com',
    'user..name@example.com',
    '"user"@example.com',
    'user(comment)@example.com',
    'user😀@example.com',
    'user@[192.0.2.1]',
    'user@-example.com',
    'user@example-.com',
    'user@exam_ple.com',
    `${'a'.repeat(65)}@example.com`,
    `user@${'a'.repeat(64)}.com`,
  ])(
    'rejects invalid address %s', value => {
    expect(() => normalizeInvitationEmail(value)).toThrow('valid email address');
    },
  );

  it.each([undefined, null, 42, {}, []])('rejects non-string input %p with the stable validation message', value => {
    expect(() => normalizeInvitationEmail(value)).toThrow(
      new Error('invitation email must be a valid email address'),
    );
  });
});
