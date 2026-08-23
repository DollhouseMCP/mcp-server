import { describe, expect, it } from '@jest/globals';

import {
  isIntegrationConnected,
  type UserIntegrationProvider,
  type UserIntegrationRecord,
} from '../../../../src/web-console/stores/IUserIntegrationStore.js';

function record(overrides: Partial<UserIntegrationRecord>): UserIntegrationRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    provider: 'gmail' as UserIntegrationProvider,
    externalAccountLabel: null,
    externalInstallationId: null,
    authorizedPermissions: {},
    accessTokenCiphertext: null,
    refreshTokenCiphertext: null,
    credentialKeyVersion: null,
    status: 'connected',
    errorReason: null,
    connectedAt: new Date('2026-06-26T00:00:00.000Z'),
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('isIntegrationConnected', () => {
  it('is true only for a connected, non-revoked record', () => {
    expect(isIntegrationConnected(record({ status: 'connected', revokedAt: null }))).toBe(true);
  });

  it('is false for a connected record that has been revoked (revocation race)', () => {
    // The key invariant: status may lag behind revocation; revokedAt must still gate access.
    expect(isIntegrationConnected(record({ status: 'connected', revokedAt: new Date() }))).toBe(false);
  });

  it('is false for revoked or errored status', () => {
    expect(isIntegrationConnected(record({ status: 'revoked' }))).toBe(false);
    expect(isIntegrationConnected(record({ status: 'error' }))).toBe(false);
  });

  it('is false for a null record', () => {
    expect(isIntegrationConnected(null)).toBe(false);
  });
});
