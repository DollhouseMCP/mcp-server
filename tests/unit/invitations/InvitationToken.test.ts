import { describe, expect, it } from '@jest/globals';

import {
  generateInvitationToken,
  hashInvitationCredential,
  invitationCredentialMatches,
  InvitationTokenError,
  MAX_INVITATION_GENERATION,
  parseInvitationToken,
} from '../../../src/invitations/InvitationToken.js';

const INVITATION_ID = '123e4567-e89b-12d3-a456-426614174000';
const EMAIL = 'tester@example.com';
const EXPIRES_AT = new Date('2026-09-21T12:00:00.000Z');

describe('InvitationToken', () => {
  it('round-trips a versioned 256-bit credential without embedding email or expiry', () => {
    const generated = generateInvitationToken(INVITATION_ID, 3, () => Buffer.alloc(32, 0xab));

    expect(generated.token).toBe(
      'dhi1.Ej5FZ-ibEtOkVkJmFBdAAA.3.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s',
    );
    expect(parseInvitationToken(generated.token)).toEqual({
      invitationId: INVITATION_ID,
      generation: 3,
      secret: Buffer.alloc(32, 0xab),
    });
    expect(generated.token).not.toContain(EMAIL);
    expect(generated.token).not.toContain('2026');
  });

  it('binds the stored digest to purpose, id, generation, address, expiry, and secret', () => {
    const token = generateInvitationToken(INVITATION_ID, 1, () => Buffer.alloc(32, 7));
    const digest = hashInvitationCredential(token, EMAIL, EXPIRES_AT);

    expect(digest).toHaveLength(32);
    expect(invitationCredentialMatches(digest, hashInvitationCredential(token, EMAIL, EXPIRES_AT))).toBe(true);
    expect(invitationCredentialMatches(
      digest,
      hashInvitationCredential({ ...token, invitationId: '123e4567-e89b-12d3-a456-426614174001' }, EMAIL, EXPIRES_AT),
    )).toBe(false);
    expect(invitationCredentialMatches(
      digest,
      hashInvitationCredential({ ...token, generation: 2 }, EMAIL, EXPIRES_AT),
    )).toBe(false);
    expect(invitationCredentialMatches(
      digest,
      hashInvitationCredential(token, 'other@example.com', EXPIRES_AT),
    )).toBe(false);
    expect(invitationCredentialMatches(
      digest,
      hashInvitationCredential(token, EMAIL, new Date(EXPIRES_AT.getTime() + 1)),
    )).toBe(false);
    expect(invitationCredentialMatches(
      digest,
      hashInvitationCredential({ ...token, secret: Buffer.alloc(32, 8) }, EMAIL, EXPIRES_AT),
    )).toBe(false);
  });

  it.each([
    '',
    'dhi2.Ej5FZ-ibEtOkVkJmFBdAAA.1.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s',
    'dhi1.bad.1.bad',
    'dhi1.Ej5FZ-ibEtOkVkJmFBdAAA.0.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s',
    'dhi1.Ej5FZ-ibEtOkVkJmFBdAAA.1.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s.extra',
    'dhi1.Ej5FZ-ibEtOkVkJmFBdAAA.01.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s',
    'x'.repeat(161),
  ])('rejects malformed credential %s', value => {
    expect(() => parseInvitationToken(value)).toThrow(InvitationTokenError);
  });

  it.each([
    'dhi1.Ej5FZ-ibEtOkVkJmFBdAAB.1.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s',
    'dhi1.Ej5FZ-ibEtOkVkJmFBdAAA.1.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6t',
    'dhi1.Ej5FZ-ibEtOkVkJmFBdAAA=.1.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s',
  ])('rejects non-canonical base64url credential %s', value => {
    expect(() => parseInvitationToken(value)).toThrow(InvitationTokenError);
  });

  it('rejects invalid generation and random-source output', () => {
    expect(() => generateInvitationToken(INVITATION_ID, 0)).toThrow(InvitationTokenError);
    expect(generateInvitationToken(INVITATION_ID, MAX_INVITATION_GENERATION, () => Buffer.alloc(32, 1)).generation)
      .toBe(MAX_INVITATION_GENERATION);
    expect(parseInvitationToken(
      generateInvitationToken(INVITATION_ID, MAX_INVITATION_GENERATION, () => Buffer.alloc(32, 1)).token,
    ).generation).toBe(MAX_INVITATION_GENERATION);
    expect(() => generateInvitationToken(INVITATION_ID, MAX_INVITATION_GENERATION + 1))
      .toThrow(InvitationTokenError);
    const tooLarge = generateInvitationToken(INVITATION_ID, 1, () => Buffer.alloc(32, 1)).token
      .replace('.1.', `.${MAX_INVITATION_GENERATION + 1}.`);
    expect(() => parseInvitationToken(tooLarge)).toThrow(InvitationTokenError);
    expect(() => generateInvitationToken(INVITATION_ID, 1, () => Buffer.alloc(31)))
      .toThrow(InvitationTokenError);
  });

  it('rejects comparison buffers with non-digest lengths', () => {
    expect(invitationCredentialMatches(Buffer.alloc(31), Buffer.alloc(31))).toBe(false);
  });
});
