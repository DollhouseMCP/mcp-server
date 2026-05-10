/**
 * modeFingerprint — must-fix #14 mode-switch invalidation.
 *
 * Asserts the fingerprint algorithm and the persistence-comparison
 * helper. End-to-end behavior (clearing OAuth state + rotating cookie
 * secret) is exercised via the EmbeddedAuthorizationServer initialize
 * path; this file covers the building blocks.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  computeFingerprint,
  checkAndPersistModeFingerprint,
  checkModeFingerprint,
  persistModeFingerprint,
  OAUTH_STATE_MODELS,
} from '../../../../src/auth/embedded-as/modeFingerprint.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

const baseInputs = {
  provider: 'embedded',
  methodIds: ['github', 'magic-link'] as const,
  issuer: 'http://127.0.0.1:3000',
  primaryKid: 'kid-abc',
  primaryCookieKey: 'cookie-key-1',
};

describe('computeFingerprint', () => {
  it('is deterministic — same inputs yield the same fingerprint', () => {
    expect(computeFingerprint(baseInputs)).toBe(computeFingerprint(baseInputs));
  });

  it('is order-insensitive on methodIds — sort canonicalizes', () => {
    const a = computeFingerprint({ ...baseInputs, methodIds: ['github', 'magic-link'] });
    const b = computeFingerprint({ ...baseInputs, methodIds: ['magic-link', 'github'] });
    expect(a).toBe(b);
  });

  it('changes when provider changes', () => {
    const a = computeFingerprint(baseInputs);
    const b = computeFingerprint({ ...baseInputs, provider: 'oidc' });
    expect(a).not.toBe(b);
  });

  it('changes when methodIds change', () => {
    const a = computeFingerprint(baseInputs);
    const b = computeFingerprint({ ...baseInputs, methodIds: ['github'] });
    expect(a).not.toBe(b);
  });

  it('changes when issuer changes', () => {
    const a = computeFingerprint(baseInputs);
    const b = computeFingerprint({ ...baseInputs, issuer: 'http://127.0.0.1:4000' });
    expect(a).not.toBe(b);
  });

  it('changes when primary kid changes', () => {
    const a = computeFingerprint(baseInputs);
    const b = computeFingerprint({ ...baseInputs, primaryKid: 'kid-xyz' });
    expect(a).not.toBe(b);
  });

  it('changes when primary cookie key changes', () => {
    const a = computeFingerprint(baseInputs);
    const b = computeFingerprint({ ...baseInputs, primaryCookieKey: 'cookie-key-2' });
    expect(a).not.toBe(b);
  });

  it('does not include the cookie key verbatim — fingerprint is safe to log', () => {
    const fp = computeFingerprint({ ...baseInputs, primaryCookieKey: 'super-secret-cookie-key' });
    expect(fp).not.toContain('super-secret-cookie-key');
  });
});

describe('checkAndPersistModeFingerprint', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  it('first run: persists the fingerprint and reports firstRun=true', async () => {
    const result = await checkAndPersistModeFingerprint(storage, baseInputs);
    expect(result.changed).toBe(false);
    expect(result.firstRun).toBe(true);
    expect(result.previous).toBeUndefined();
    expect(result.current).toBeTruthy();

    // Persisted to storage
    const stored = (await storage.genericGet('AuthModeFingerprint', 'current')) as
      | { fingerprint?: string } | null;
    expect(stored?.fingerprint).toBe(result.current);
  });

  it('subsequent run with identical inputs: changed=false, firstRun=false', async () => {
    await checkAndPersistModeFingerprint(storage, baseInputs);
    const result = await checkAndPersistModeFingerprint(storage, baseInputs);
    expect(result.changed).toBe(false);
    expect(result.firstRun).toBe(false);
    expect(result.previous).toBe(result.current);
  });

  it('subsequent run with changed methods: changed=true with previous + current populated', async () => {
    await checkAndPersistModeFingerprint(storage, baseInputs);
    const result = await checkAndPersistModeFingerprint(storage, {
      ...baseInputs,
      methodIds: ['local-password'],
    });
    expect(result.changed).toBe(true);
    expect(result.firstRun).toBe(false);
    expect(result.previous).toBeTruthy();
    expect(result.current).toBeTruthy();
    expect(result.previous).not.toBe(result.current);

    // The new fingerprint is now persisted
    const stored = (await storage.genericGet('AuthModeFingerprint', 'current')) as
      | { fingerprint?: string } | null;
    expect(stored?.fingerprint).toBe(result.current);
  });

  it('subsequent run with changed issuer: changed=true', async () => {
    await checkAndPersistModeFingerprint(storage, baseInputs);
    const result = await checkAndPersistModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://other.example.com',
    });
    expect(result.changed).toBe(true);
  });
});

/**
 * Cycle-17: cycle-16 introduced the split API (checkModeFingerprint +
 * persistModeFingerprint) so the caller can run invalidation work
 * BETWEEN the read and the write — a crash mid-sequence then re-runs
 * the idempotent invalidation on next boot. The deprecated
 * checkAndPersistModeFingerprint (above) is the legacy combined form.
 */
describe('checkModeFingerprint + persistModeFingerprint (cycle-16 split API)', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  it('first run: changed=false, firstRun=true, NOTHING persisted yet', async () => {
    const result = await checkModeFingerprint(storage, baseInputs);
    expect(result.firstRun).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.current).toBeTruthy();
    // Critical contract: storage is untouched until persistModeFingerprint
    // is called explicitly.
    expect(await storage.genericGet('AuthModeFingerprint', 'current')).toBeNull();
  });

  it('persistModeFingerprint writes the fingerprint to storage', async () => {
    await persistModeFingerprint(storage, baseInputs);
    const stored = (await storage.genericGet('AuthModeFingerprint', 'current')) as
      | { fingerprint?: string } | null;
    expect(stored?.fingerprint).toBe(computeFingerprint(baseInputs));
  });

  it('changed=true without persistModeFingerprint: next call STILL reports changed=true', async () => {
    // The crash-safety contract: if the caller's invalidation work runs
    // between check and persist, and the process crashes mid-sequence,
    // the next boot must observe the unchanged stored fingerprint and
    // re-fire the invalidation.
    await persistModeFingerprint(storage, baseInputs);
    const newInputs = { ...baseInputs, methodIds: ['local-password'] as const };
    const first = await checkModeFingerprint(storage, newInputs);
    expect(first.changed).toBe(true);
    expect(first.previous).toBe(computeFingerprint(baseInputs));
    expect(first.current).toBe(computeFingerprint(newInputs));

    // Caller crashed before calling persistModeFingerprint. Next boot:
    const second = await checkModeFingerprint(storage, newInputs);
    expect(second.changed).toBe(true);
    expect(second.previous).toBe(computeFingerprint(baseInputs));
    expect(second.current).toBe(computeFingerprint(newInputs));
  });

  it('changed=true → caller persists → subsequent checks are stable (changed=false)', async () => {
    await persistModeFingerprint(storage, baseInputs);
    const newInputs = { ...baseInputs, methodIds: ['local-password'] as const };
    const result = await checkModeFingerprint(storage, newInputs);
    expect(result.changed).toBe(true);

    // Caller's invalidation runs, then persists.
    await persistModeFingerprint(storage, newInputs);

    const stable = await checkModeFingerprint(storage, newInputs);
    expect(stable.changed).toBe(false);
    expect(stable.firstRun).toBe(false);
  });

  it('persistModeFingerprint is idempotent on identical inputs', async () => {
    await persistModeFingerprint(storage, baseInputs);
    await persistModeFingerprint(storage, baseInputs);
    const stored = (await storage.genericGet('AuthModeFingerprint', 'current')) as
      | { fingerprint?: string } | null;
    expect(stored?.fingerprint).toBe(computeFingerprint(baseInputs));
  });
});

describe('OAUTH_STATE_MODELS', () => {
  it('lists the K/V models that must be cleared on mode switch', () => {
    expect(OAUTH_STATE_MODELS).toContain('Session');
    expect(OAUTH_STATE_MODELS).toContain('Grant');
    expect(OAUTH_STATE_MODELS).toContain('AccessToken');
    expect(OAUTH_STATE_MODELS).toContain('RefreshToken');
    expect(OAUTH_STATE_MODELS).toContain('AuthorizationCode');
    expect(OAUTH_STATE_MODELS).toContain('Interaction');
  });

  it('does NOT include AuthModeFingerprint (that record persists across mode switches)', () => {
    expect(OAUTH_STATE_MODELS).not.toContain('AuthModeFingerprint');
  });
});

describe('IAuthStorageLayer.clearGenericByModels (used by mode-switch path)', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  it('clears entries across the listed models and returns the count', async () => {
    await storage.genericSet('Session', 's-1', { v: 1 });
    await storage.genericSet('Session', 's-2', { v: 2 });
    await storage.genericSet('Grant', 'g-1', { v: 3 });
    await storage.genericSet('AccessToken', 't-1', { v: 4 });
    // A model we're NOT clearing
    await storage.genericSet('Survives', 'x-1', { v: 5 });

    const cleared = await storage.clearGenericByModels(['Session', 'Grant', 'AccessToken']);
    expect(cleared).toBe(4);

    expect(await storage.genericGet('Session', 's-1')).toBeNull();
    expect(await storage.genericGet('Session', 's-2')).toBeNull();
    expect(await storage.genericGet('Grant', 'g-1')).toBeNull();
    expect(await storage.genericGet('AccessToken', 't-1')).toBeNull();
    // Untouched
    expect(await storage.genericGet('Survives', 'x-1')).toEqual({ v: 5 });
  });

  it('returns 0 when no entries match', async () => {
    expect(await storage.clearGenericByModels(['Session'])).toBe(0);
  });

  it('handles empty model list', async () => {
    await storage.genericSet('Session', 's-1', { v: 1 });
    expect(await storage.clearGenericByModels([])).toBe(0);
    expect(await storage.genericGet('Session', 's-1')).toEqual({ v: 1 });
  });
});
