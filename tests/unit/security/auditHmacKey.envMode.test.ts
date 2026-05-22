/**
 * Env-var resolver-mode coverage.
 *
 * Lives in its own file because `env` in `src/config/env.ts` is parsed once
 * at module load via `envSchema.parse(process.env)` — mutating process.env
 * later doesn't affect the cached object. We have to mock the module to
 * inject a controlled value, and that mock has to be in place BEFORE
 * AuditHmacKeyResolver imports it. Co-locating with the file-mode tests
 * would force the mock on every test in that suite.
 */

import { describe, expect, it, jest } from '@jest/globals';

// Provide just enough of the env schema for AuditHmacKeyResolver to function.
// Other env keys aren't referenced by this resolver, so a minimal object is
// safer than partially mocking the real schema.
jest.unstable_mockModule('../../../src/config/env.js', () => ({
  env: {
    DOLLHOUSE_AUDIT_HMAC_SECRET: 'cc'.repeat(32),
  },
}));

const { AuditHmacKeyResolver } = await import('../../../src/security/auditHmacKey.js');

describe('AuditHmacKeyResolver — env-var mode', () => {
  it('uses DOLLHOUSE_AUDIT_HMAC_SECRET when set, returning keyId="env"', async () => {
    const resolver = new AuditHmacKeyResolver();
    const material = await resolver.resolve();

    expect(material.keyId).toBe('env');
    expect(material.key).toEqual(Buffer.alloc(32, 0xcc));
  });

  it('env-var path skips the database and file paths entirely', async () => {
    // Construct with NO database and NO rootDir — should still succeed because
    // the env-var branch returns before either fallback is consulted. If the
    // resolver were to fall through, file mode would try to write to
    // ~/.dollhouse/secrets/audit-hmac-key (real homedir, unsafe in test).
    const resolver = new AuditHmacKeyResolver({ database: undefined, rootDir: undefined });
    await expect(resolver.resolve()).resolves.toEqual({
      keyId: 'env',
      key: Buffer.alloc(32, 0xcc),
    });
  });
});
