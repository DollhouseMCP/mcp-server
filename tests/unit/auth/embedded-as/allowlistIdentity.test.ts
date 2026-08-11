import { describe, expect, it } from '@jest/globals';
import {
  normalizeAuthAllowlistPrincipal,
  normalizeAuthAllowlistValue,
} from '../../../../src/auth/embedded-as/allowlistIdentity.js';

describe('normalizeAuthAllowlistPrincipal', () => {
  it('preserves distinct Unicode principals instead of rewriting confusables', () => {
    const cyrillicAlice = '\u0430lice@example.test';

    expect(normalizeAuthAllowlistPrincipal(cyrillicAlice)).toBe(cyrillicAlice);
    expect(normalizeAuthAllowlistPrincipal(cyrillicAlice)).not.toBe('alice@example.test');
  });

  it('canonicalizes equivalent Unicode encodings and trims operator whitespace', () => {
    expect(normalizeAuthAllowlistPrincipal('  jose\u0301@example.test  '))
      .toBe('jos\u00e9@example.test');
  });

  it('applies allowlist casing rules after identity-preserving canonicalization', () => {
    expect(normalizeAuthAllowlistValue('email', ' ALICE@example.test ')).toBe('alice@example.test');
    expect(normalizeAuthAllowlistValue('github_username', 'Mick')).toBe('mick');
    expect(normalizeAuthAllowlistValue('github_id', ' 184286 ')).toBe('184286');
  });
});
