import { describe, it, expect } from '@jest/globals';
import { createVerificationChallenge } from '../../../../packages/safety/src/TieredSafetyService.js';
import { validateChallengeIdFormat, validateVerificationChallengeIdFormat } from '../../../../src/handlers/mcp-aql/shared.js';

describe('Verification challenge ID contract (#2656)', () => {
  it.each(['authenticator', 'display_code', 'passphrase'] as const)('accepts the actual package-generated %s ID', type => {
    const challenge = createVerificationChallenge('Contract test', type);
    expect(() => validateChallengeIdFormat(challenge.challengeId)).not.toThrow();
    expect(() => validateVerificationChallengeIdFormat(challenge.challengeId)).not.toThrow();
  });

  it('accepts the exact old generator format only in ordinary verification', () => {
    const id = 'challenge_1733781234567_a1b2c3d4e5f6';
    expect(() => validateVerificationChallengeIdFormat(id)).not.toThrow();
    expect(() => validateChallengeIdFormat(id)).toThrow('Invalid challenge_id format');
  });

  it.each([
    'challenge_173378123456_a1b2c3d4e5f6',
    'challenge_17337812345678_a1b2c3d4e5f6',
    'challenge_0733781234567_a1b2c3d4e5f6',
    'challenge_1733781234567_A1B2C3D4E5F6',
    'challenge_1733781234567_a1b2c3d4e5f',
    'challenge_1733781234567_a1b2c3d4e5f67',
    'challenge_1733781234567_a1b2c3d4e5fg',
    'challenge_1733781234567_a1b2c3d4e5f6\n',
    ' challenge_1733781234567_a1b2c3d4e5f6',
    '550e8400-e29b-11d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000\n',
    'arbitrary-id',
  ])('rejects malformed or noncanonical ID %p', id => {
    expect(() => validateVerificationChallengeIdFormat(id)).toThrow('Invalid challenge_id format');
  });
});
