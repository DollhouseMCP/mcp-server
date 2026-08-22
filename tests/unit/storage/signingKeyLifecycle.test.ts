import { describe, expect, it } from '@jest/globals';

import type { SigningKey, SigningKeyKind } from '../../../src/storage/signingKeys/ISigningKeyStore.js';
import {
  COOKIE_VERIFICATION_GRACE_MS,
  INVITE_VERIFICATION_GRACE_MS,
  JWKS_VERIFICATION_GRACE_MS,
  signingKeyCanVerify,
  signingKeyVerificationGraceMs,
  stageSigningKeyModeTransition,
} from '../../../src/storage/signingKeys/signingKeyLifecycle.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');

function key(kind: SigningKeyKind, overrides: Partial<SigningKey> = {}): SigningKey {
  return {
    kid: `${kind}-test`,
    kind,
    payload: {},
    active: false,
    createdAt: NOW - 1_000,
    ...overrides,
  };
}

describe('signing-key verification lifecycle', () => {
  it('uses the concrete grace periods required by each credential lifetime', () => {
    expect(signingKeyVerificationGraceMs('jwks')).toBe(2 * 60 * 60 * 1000);
    expect(signingKeyVerificationGraceMs('cookie')).toBe((14 * 24 * 60 + 5) * 60 * 1000);
    expect(signingKeyVerificationGraceMs('invite')).toBe(65 * 60 * 1000);
  });

  it.each([
    ['jwks', JWKS_VERIFICATION_GRACE_MS],
    ['cookie', COOKIE_VERIFICATION_GRACE_MS],
    ['invite', INVITE_VERIFICATION_GRACE_MS],
  ] as const)('allows a rotated %s key only through its grace boundary', (kind, graceMs) => {
    expect(signingKeyCanVerify(key(kind, { rotatedAt: NOW - graceMs }), NOW)).toBe(true);
    expect(signingKeyCanVerify(key(kind, { rotatedAt: NOW - graceMs - 1 }), NOW)).toBe(false);
  });

  it('always accepts an active key and always rejects an explicitly retired key', () => {
    expect(signingKeyCanVerify(key('jwks', { active: true }), NOW)).toBe(true);
    expect(signingKeyCanVerify(key('jwks', { active: true, retiredAt: NOW - 1 }), NOW)).toBe(false);
  });

  it('rejects missing and future rotation timestamps', () => {
    expect(signingKeyCanVerify(key('invite'), NOW)).toBe(false);
    expect(signingKeyCanVerify(key('invite', { rotatedAt: NOW + 1 }), NOW)).toBe(false);
  });

  it('retires every prior non-retired key, including future-dated and expired keys', () => {
    const staged = stageSigningKeyModeTransition([
      key('jwks', { kid: 'future', rotatedAt: NOW + 60_000 }),
      key('cookie', { kid: 'expired', rotatedAt: NOW - COOKIE_VERIFICATION_GRACE_MS - 1 }),
      key('invite', { kid: 'already-retired', retiredAt: NOW - 1 }),
    ], {
      replacements: [{ kid: 'fresh', kind: 'jwks', payload: {} }],
      transitionId: '11111111-1111-4111-8111-111111111111',
      targetGenerationFingerprint: 'a'.repeat(43),
    }, NOW);

    expect(staged.retired.map(item => item.kid).sort()).toEqual(['expired', 'future']);
    expect(staged.keys.find(item => item.kid === 'future')?.retiredAt).toBe(NOW);
    expect(staged.keys.find(item => item.kid === 'expired')?.retiredAt).toBe(NOW);
    expect(staged.keys.find(item => item.kid === 'already-retired')?.retiredAt).toBe(NOW - 1);
  });

  it('returns an already-installed generation without replacing it again', () => {
    const transition = {
      replacements: [{ kid: 'fresh', kind: 'jwks' as const, payload: {} }],
      transitionId: '11111111-1111-4111-8111-111111111111',
      targetGenerationFingerprint: 'a'.repeat(43),
    };
    const first = stageSigningKeyModeTransition([], transition, NOW);
    const second = stageSigningKeyModeTransition(first.keys, {
      ...transition,
      replacements: [{ kid: 'ignored', kind: 'jwks', payload: {} }],
      transitionId: '22222222-2222-4222-8222-222222222222',
    }, NOW + 1);

    expect(second.alreadyApplied).toBe(true);
    expect(second.transitionId).toBe(transition.transitionId);
    expect(second.keys).toEqual(first.keys);
  });
});
