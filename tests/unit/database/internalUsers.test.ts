import { describe, expect, it } from '@jest/globals';

import { SYSTEM_USER_UUID } from '../../../src/collection/shared-pool/SharedPoolConfig.js';
import {
  CANARY_USER_UUID,
  CANARY_USERNAME,
  INTERNAL_USER_IDS,
  isInternalUserId,
} from '../../../src/database/internalUsers.js';

describe('internal users', () => {
  it('reserves the shared-pool system user and the canary, and nobody else', () => {
    expect(INTERNAL_USER_IDS).toEqual([SYSTEM_USER_UUID, CANARY_USER_UUID]);
    expect(new Set(INTERNAL_USER_IDS).size).toBe(2);
  });

  it('recognises a reserved ID whatever its letter case, and no other ID', () => {
    expect(isInternalUserId(CANARY_USER_UUID)).toBe(true);
    expect(isInternalUserId(CANARY_USER_UUID.toUpperCase())).toBe(true);
    expect(isInternalUserId(SYSTEM_USER_UUID)).toBe(true);
    expect(isInternalUserId('11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('gives the canary a username no sign-in subject can equal', () => {
    // Subjects are `<provider>_<id>`. A users row whose username equals a
    // subject can be matched by that sign-in, so this name has no underscore.
    expect(CANARY_USERNAME).not.toContain('_');
    expect(CANARY_USERNAME.length).toBeLessThanOrEqual(32);
  });
});
