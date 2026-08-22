/**
 * modeFingerprint — must-fix #14 mode-switch invalidation.
 *
 * Asserts the fingerprint algorithm and the persistence-comparison
 * helper. End-to-end behavior (clearing OAuth state + rotating cookie
 * secret) is exercised via the EmbeddedAuthorizationServer initialize
 * path; this file covers the building blocks.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  computeFingerprint,
  computeAuthorizationGenerationFingerprint,
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

  it('does not change when the active signing kid rotates', () => {
    const a = computeFingerprint(baseInputs);
    const b = computeFingerprint({ ...baseInputs, primaryKid: 'kid-xyz' });
    expect(a).toBe(b);
  });

  it('does not change when the active cookie key rotates', () => {
    const a = computeFingerprint(baseInputs);
    const b = computeFingerprint({ ...baseInputs, primaryCookieKey: 'cookie-key-2' });
    expect(a).toBe(b);
  });

  it('tracks an operator override outside the v2 operating-mode fingerprint', () => {
    const a = computeFingerprint({ ...baseInputs, operatorManagedCookieKey: 'override-1' });
    const b = computeFingerprint({ ...baseInputs, operatorManagedCookieKey: 'override-2' });
    expect(a).toBe(b);
  });

  it('changes the credential generation when an override is introduced, changed, or removed', () => {
    const stored = computeAuthorizationGenerationFingerprint(baseInputs);
    const firstOverride = computeAuthorizationGenerationFingerprint({
      ...baseInputs,
      operatorManagedCookieKey: 'override-1',
    });
    const secondOverride = computeAuthorizationGenerationFingerprint({
      ...baseInputs,
      operatorManagedCookieKey: 'override-2',
    });
    expect(firstOverride).not.toBe(stored);
    expect(secondOverride).not.toBe(firstOverride);
  });

  it('includes a configured authorization generation without changing the operating-mode fingerprint', () => {
    expect(computeFingerprint({ ...baseInputs, authorizationGeneration: 1 }))
      .toBe(computeFingerprint({ ...baseInputs, authorizationGeneration: 2 }));
    expect(computeAuthorizationGenerationFingerprint({ ...baseInputs, authorizationGeneration: 1 }))
      .not.toBe(computeAuthorizationGenerationFingerprint({ ...baseInputs, authorizationGeneration: 2 }));
  });

  it('does not include mutable key material — fingerprint is safe and replica-stable', () => {
    const fp = computeFingerprint({ ...baseInputs, primaryCookieKey: 'super-secret-cookie-key' });
    expect(fp).not.toContain('super-secret-cookie-key');
    expect(fp).toBe(computeFingerprint({
      ...baseInputs,
      primaryKid: 'other-kid',
      primaryCookieKey: 'other-cookie-key',
    }));
  });
});

/**
 * The split API (checkModeFingerprint + persistModeFingerprint) lets the caller
 * run invalidation work BETWEEN the read and the write — a crash mid-sequence
 * then re-runs the idempotent invalidation on next boot. Replaces the earlier
 * combined `checkAndPersistModeFingerprint` which persisted before the caller's
 * invalidation could run.
 */
describe('checkModeFingerprint + persistModeFingerprint', () => {
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
      | { fingerprint?: string; version?: number } | null;
    expect(stored?.fingerprint).toBe(computeFingerprint(baseInputs));
    expect(stored?.version).toBe(2);
  });

  it('persists an explicitly configured authorization generation', async () => {
    await persistModeFingerprint(storage, { ...baseInputs, authorizationGeneration: 7 });
    await expect(storage.genericGet('AuthModeFingerprint', 'current')).resolves.toMatchObject({
      authorizationGeneration: 7,
    });
  });

  it('does not let a stale first-run replica overwrite a newer generation', async () => {
    const stale = await checkModeFingerprint(storage, {
      ...baseInputs,
      authorizationGeneration: 1,
    });
    const current = await checkModeFingerprint(storage, {
      ...baseInputs,
      authorizationGeneration: 2,
    });

    await persistModeFingerprint(storage, {
      ...baseInputs,
      authorizationGeneration: 2,
    }, { expectedSnapshot: current.persistenceSnapshot });
    await expect(persistModeFingerprint(storage, {
      ...baseInputs,
      authorizationGeneration: 1,
    }, { expectedSnapshot: stale.persistenceSnapshot })).rejects.toThrow(/persistence conflict/u);
    await expect(storage.genericGet('AuthModeFingerprint', 'current')).resolves.toMatchObject({
      authorizationGeneration: 2,
    });
  });

  it('does not let a stale migration overwrite an adopted generation', async () => {
    await persistModeFingerprint(storage, baseInputs);
    const stale = await checkModeFingerprint(storage, baseInputs);
    const current = await checkModeFingerprint(storage, {
      ...baseInputs,
      authorizationGeneration: 1,
    });
    expect(current.persistenceSnapshot).toEqual(
      await storage.genericGet('AuthModeFingerprint', 'current'),
    );
    await persistModeFingerprint(storage, {
      ...baseInputs,
      authorizationGeneration: 1,
    }, { expectedSnapshot: current.persistenceSnapshot });
    await expect(persistModeFingerprint(
      storage,
      baseInputs,
      { expectedSnapshot: stale.persistenceSnapshot },
    )).rejects.toThrow(/persistence conflict/u);
    await expect(storage.genericGet('AuthModeFingerprint', 'current')).resolves.toMatchObject({
      authorizationGeneration: 1,
    });
  });

  it('rejects a stale replica whose authorization generation is older', async () => {
    await persistModeFingerprint(storage, { ...baseInputs, authorizationGeneration: 4 });
    await expect(checkModeFingerprint(storage, { ...baseInputs, authorizationGeneration: 3 }))
      .rejects.toThrow(/generation rollback rejected/u);
  });

  it('requires a configured generation to advance when the mode changes', async () => {
    await persistModeFingerprint(storage, { ...baseInputs, authorizationGeneration: 4 });
    await expect(checkModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://new.example.test',
      authorizationGeneration: 4,
    })).rejects.toThrow(/without advancing DOLLHOUSE_AUTH_GENERATION/u);

    await expect(checkModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://new.example.test',
      authorizationGeneration: 5,
    })).resolves.toMatchObject({ changed: true });
  });

  it('keeps legacy unconfigured mode changes backward compatible', async () => {
    await persistModeFingerprint(storage, baseInputs);
    await expect(checkModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://legacy-change.example.test',
    })).resolves.toMatchObject({ changed: true });
  });

  it('persists only a one-way fingerprint for an operator-managed cookie key', async () => {
    const operatorManagedCookieKey = 'operator-managed-cookie-key';
    await persistModeFingerprint(storage, { ...baseInputs, operatorManagedCookieKey });
    const stored = (await storage.genericGet('AuthModeFingerprint', 'current')) as
      | { cookieOverrideFingerprint?: string } | null;

    expect(stored?.cookieOverrideFingerprint).toEqual(expect.any(String));
    expect(stored?.cookieOverrideFingerprint).not.toContain(operatorManagedCookieKey);
    expect(JSON.stringify(stored)).not.toContain(operatorManagedCookieKey);
  });

  it('persists only a one-way fingerprint for an operator-managed invite key', async () => {
    const operatorManagedInviteKey = 'operator-managed-invite-key';
    await persistModeFingerprint(storage, { ...baseInputs, operatorManagedInviteKey });
    const stored = (await storage.genericGet('AuthModeFingerprint', 'current')) as
      | { inviteOverrideFingerprint?: string } | null;

    expect(stored?.inviteOverrideFingerprint).toEqual(expect.any(String));
    expect(stored?.inviteOverrideFingerprint).not.toContain(operatorManagedInviteKey);
    expect(JSON.stringify(stored)).not.toContain(operatorManagedInviteKey);
  });

  it('recognizes operator-managed invite-key rotation without changing the mode fingerprint', async () => {
    await persistModeFingerprint(storage, {
      ...baseInputs,
      operatorManagedInviteKey: 'operator-invite-key-1',
    });
    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      operatorManagedInviteKey: 'operator-invite-key-2',
    });

    expect(result).toMatchObject({
      changed: false,
      credentialGenerationChanged: true,
      inviteOverrideConfigured: true,
      inviteOverrideFingerprintRecorded: true,
      inviteOverrideChanged: true,
      inviteOverrideMetadataUpdateRequired: true,
    });
  });

  it('does not claim invite-key rotation when a changed mode has no recorded invite baseline', async () => {
    await storage.genericSet('AuthModeFingerprint', 'current', {
      fingerprint: computeFingerprint(baseInputs),
      version: 2,
    });
    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://new-issuer.example.com',
      operatorManagedInviteKey: 'operator-invite-key-2',
    });

    expect(result).toMatchObject({
      changed: true,
      inviteOverrideConfigured: true,
      inviteOverrideFingerprintRecorded: false,
      inviteOverrideChanged: false,
    });
    expect(result).not.toHaveProperty('inviteOverrideMetadataUpdateRequired');
  });

  it('recognizes rotation of the operator-managed key without changing the mode fingerprint', async () => {
    await persistModeFingerprint(storage, {
      ...baseInputs,
      operatorManagedCookieKey: 'operator-cookie-key-1',
    });
    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      operatorManagedCookieKey: 'operator-cookie-key-2',
    });

    expect(result).toMatchObject({
      changed: false,
      credentialGenerationChanged: true,
      cookieOverrideConfigured: true,
      cookieOverrideFingerprintRecorded: true,
      cookieOverrideChanged: true,
    });
  });

  it('updates changed override metadata only when the v2 mode is unchanged', async () => {
    await storage.genericSet('AuthModeFingerprint', 'current', {
      fingerprint: computeFingerprint(baseInputs),
      version: 2,
      cookieOverrideFingerprint: 'prior-override-fingerprint',
    });
    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      operatorManagedCookieKey: 'operator-cookie-key-1',
    });

    expect(result).toMatchObject({
      changed: false,
      credentialGenerationChanged: true,
      cookieOverrideFingerprintRecorded: true,
      cookieOverrideChanged: true,
      cookieOverrideMetadataUpdateRequired: true,
    });
  });

  it('backfills missing override metadata only when the v2 mode is unchanged', async () => {
    await storage.genericSet('AuthModeFingerprint', 'current', {
      fingerprint: computeFingerprint(baseInputs),
      version: 2,
    });
    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      operatorManagedCookieKey: 'operator-cookie-key-1',
    });

    expect(result).toMatchObject({
      changed: false,
      credentialGenerationChanged: true,
      cookieOverrideFingerprintRecorded: false,
      cookieOverrideMetadataUpdateRequired: true,
    });
  });

  it('does not claim an override rotation when a changed mode has no recorded baseline', async () => {
    await storage.genericSet('AuthModeFingerprint', 'current', {
      fingerprint: computeFingerprint(baseInputs),
      version: 2,
    });
    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://new-issuer.example.com',
      operatorManagedCookieKey: 'operator-cookie-key-2',
    });

    expect(result).toMatchObject({
      changed: true,
      cookieOverrideConfigured: true,
      cookieOverrideFingerprintRecorded: false,
      cookieOverrideChanged: false,
    });
    expect(result).not.toHaveProperty('cookieOverrideMetadataUpdateRequired');
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
      | { fingerprint?: string; version?: number } | null;
    expect(stored?.fingerprint).toBe(computeFingerprint(baseInputs));
    expect(stored?.version).toBe(2);
  });

  it('recognizes and migrates a matching v1 fingerprint without destructive invalidation', async () => {
    const cookieKeyHash = createHash('sha256')
      .update(baseInputs.primaryCookieKey)
      .digest('base64url');
    const legacy = createHash('sha256').update(JSON.stringify({
      p: baseInputs.provider,
      m: [...baseInputs.methodIds].sort(),
      i: baseInputs.issuer,
      k: baseInputs.primaryKid,
      c: cookieKeyHash,
    })).digest('base64url');
    await storage.genericSet('AuthModeFingerprint', 'current', { fingerprint: legacy });

    const result = await checkModeFingerprint(storage, baseInputs);
    expect(result).toMatchObject({
      changed: false,
      firstRun: false,
      previous: legacy,
      current: computeFingerprint(baseInputs),
      migrationRequired: true,
    });
  });

  it('does not report a mode change when another replica rotates signing material', async () => {
    await persistModeFingerprint(storage, baseInputs);
    const afterExternalRotation = await checkModeFingerprint(storage, {
      ...baseInputs,
      primaryKid: 'replica-b-jwks',
      primaryCookieKey: 'replica-b-cookie',
    });

    expect(afterExternalRotation).toMatchObject({ changed: false, firstRun: false });
  });

  it('migrates v1 after an external rotation when retained durable keys match the old fingerprint', async () => {
    const cookieKeyHash = createHash('sha256')
      .update(baseInputs.primaryCookieKey)
      .digest('base64url');
    const legacy = createHash('sha256').update(JSON.stringify({
      p: baseInputs.provider,
      m: [...baseInputs.methodIds].sort(),
      i: baseInputs.issuer,
      k: baseInputs.primaryKid,
      c: cookieKeyHash,
    })).digest('base64url');
    await storage.genericSet('AuthModeFingerprint', 'current', { fingerprint: legacy });

    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      primaryKid: 'new-jwks-kid',
      primaryCookieKey: 'new-cookie-key',
      legacyKeyCandidates: [{
        primaryKid: baseInputs.primaryKid,
        primaryCookieKey: baseInputs.primaryCookieKey,
      }],
    });

    expect(result).toMatchObject({ changed: false, migrationRequired: true });
  });

  it('still reports a genuine legacy operating-mode change despite retained key candidates', async () => {
    const cookieKeyHash = createHash('sha256')
      .update(baseInputs.primaryCookieKey)
      .digest('base64url');
    const legacy = createHash('sha256').update(JSON.stringify({
      p: baseInputs.provider,
      m: [...baseInputs.methodIds].sort(),
      i: baseInputs.issuer,
      k: baseInputs.primaryKid,
      c: cookieKeyHash,
    })).digest('base64url');
    await storage.genericSet('AuthModeFingerprint', 'current', { fingerprint: legacy });

    const result = await checkModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://new-issuer.example.com',
      primaryKid: 'new-jwks-kid',
      primaryCookieKey: 'new-cookie-key',
      legacyKeyCandidates: [{
        primaryKid: baseInputs.primaryKid,
        primaryCookieKey: baseInputs.primaryCookieKey,
      }],
    });

    expect(result.changed).toBe(true);
    expect(result).not.toHaveProperty('migrationRequired');
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
    expect(OAUTH_STATE_MODELS).toContain('AdminStepUpClaims');
    expect(OAUTH_STATE_MODELS).toContain('AdminStepUpPending');
    expect(OAUTH_STATE_MODELS).toContain('AdminTotpRouteCsrf');
    expect(OAUTH_STATE_MODELS).toContain('ConsoleTotpEnrollment');
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
