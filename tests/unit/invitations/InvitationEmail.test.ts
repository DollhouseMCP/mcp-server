import { describe, expect, it } from '@jest/globals';

import { normalizeInvitationEmail } from '../../../src/invitations/InvitationEmail.js';

describe('normalizeInvitationEmail', () => {
  it('reuses allowlist NFC, trim, and lowercase semantics', () => {
    expect(normalizeInvitationEmail('  TÉSTER@Example.COM  '))
      .toBe('t\u00e9ster@example.com');
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
  ])(
    'rejects invalid address %s', value => {
    expect(() => normalizeInvitationEmail(value)).toThrow('valid email address');
    },
  );
});
