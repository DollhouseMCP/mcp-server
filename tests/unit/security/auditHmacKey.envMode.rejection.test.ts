/**
 * Env-var resolver-mode rejection coverage.
 *
 * Separate file from auditHmacKey.envMode.test.ts because the env mock is
 * module-scoped — one value per test file. This file pins that a
 * misconfigured DOLLHOUSE_AUDIT_HMAC_SECRET (too short) is rejected by
 * the same parseHexSecret used by the file path, so the env route can't
 * silently produce a weak HMAC key.
 */

import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/config/env.js', () => ({
  env: {
    // 8 bytes of hex = 4 actual bytes, well below the 32-byte minimum.
    DOLLHOUSE_AUDIT_HMAC_SECRET: 'abcd1234',
  },
}));

const { AuditHmacKeyResolver } = await import('../../../src/security/auditHmacKey.js');

describe('AuditHmacKeyResolver — env-var mode rejection', () => {
  it('rejects a too-short DOLLHOUSE_AUDIT_HMAC_SECRET via parseHexSecret', async () => {
    const resolver = new AuditHmacKeyResolver();
    await expect(resolver.resolve()).rejects.toThrow(/at least 32 bytes/);
  });
});
