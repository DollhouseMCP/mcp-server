import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  computeFingerprint,
  reconcileModeFingerprint,
  FINGERPRINT_MODEL,
  FINGERPRINT_KEY,
  MODE_FINGERPRINT_VERSION,
  OAUTH_STATE_MODELS,
  type TransitioningModeFingerprintRecord,
} from '../../../../src/auth/embedded-as/modeFingerprint.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

const baseInputs = {
  provider: 'embedded',
  methodIds: ['github', 'magic-link'] as const,
  issuer: 'https://mcp.example.com',
  authorizationGeneration: 0,
};

const noOpInvalidation = async () => {};

describe('computeFingerprint', () => {
  it('is deterministic and method-order independent', () => {
    expect(computeFingerprint(baseInputs)).toBe(computeFingerprint({
      ...baseInputs,
      methodIds: ['magic-link', 'github'],
    }));
  });

  it.each([
    [{ provider: 'oidc' }, 'provider'],
    [{ methodIds: ['github'] }, 'methods'],
    [{ issuer: 'https://other.example.com' }, 'issuer'],
  ] as const)('changes when public %s identity changes', (change) => {
    expect(computeFingerprint(baseInputs)).not.toBe(computeFingerprint({
      ...baseInputs,
      ...change,
    }));
  });

  it('does not change with authorization generation', () => {
    expect(computeFingerprint(baseInputs)).toBe(computeFingerprint({
      ...baseInputs,
      authorizationGeneration: 99,
    }));
  });

  it('rejects invalid generations', () => {
    expect(() => computeFingerprint({ ...baseInputs, authorizationGeneration: -1 })).toThrow(
      'non-negative safe integer',
    );
  });
});

describe('reconcileModeFingerprint', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  it('atomically records a stable v2 record on first run without invalidating', async () => {
    const invalidate = jest.fn<() => Promise<void>>(async () => {});
    const result = await reconcileModeFingerprint(storage, baseInputs, invalidate);

    expect(result).toMatchObject({ changed: false, firstRun: true });
    expect(invalidate).not.toHaveBeenCalled();
    expect(await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)).toEqual({
      version: MODE_FINGERPRINT_VERSION,
      status: 'stable',
      fingerprint: computeFingerprint(baseInputs),
      authorizationGeneration: 0,
    });
  });

  it('leaves an unchanged restart alone', async () => {
    await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    const invalidate = jest.fn<() => Promise<void>>(async () => {});

    const result = await reconcileModeFingerprint(storage, baseInputs, invalidate);
    expect(result).toMatchObject({ changed: false, firstRun: false });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('claims and completes a public mode change', async () => {
    await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    const contexts: unknown[] = [];
    const changedInputs = { ...baseInputs, methodIds: ['local-password'] };

    const result = await reconcileModeFingerprint(storage, changedInputs, async (context) => {
      contexts.push(context);
      const pending = await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY);
      expect(pending).toMatchObject({ status: 'transitioning', reason: 'mode-change' });
    });

    expect(result).toMatchObject({ changed: true, reason: 'mode-change' });
    expect(contexts).toHaveLength(1);
    expect(await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)).toMatchObject({
      status: 'stable',
      fingerprint: computeFingerprint(changedInputs),
    });
  });

  it('uses a generation increase for deliberate global invalidation', async () => {
    await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    const result = await reconcileModeFingerprint(
      storage,
      { ...baseInputs, authorizationGeneration: 1 },
      noOpInvalidation,
    );

    expect(result).toMatchObject({ changed: true, reason: 'generation-increase' });
  });

  it('performs one transition when mode and generation change together', async () => {
    await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    const invalidate = jest.fn<() => Promise<void>>(async () => {});
    const result = await reconcileModeFingerprint(storage, {
      ...baseInputs,
      issuer: 'https://new.example.com',
      authorizationGeneration: 1,
    }, invalidate);

    expect(result).toMatchObject({ changed: true, reason: 'mode-change' });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('migrates a legacy secret-derived record with one conservative invalidation', async () => {
    const legacyVerifier = 'legacy-secret-derived-verifier';
    await storage.genericSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, { fingerprint: legacyVerifier });
    const contexts: unknown[] = [];

    await reconcileModeFingerprint(storage, baseInputs, async (context) => {
      contexts.push(context);
      expect(JSON.stringify(context)).not.toContain(legacyVerifier);
    });
    await reconcileModeFingerprint(storage, baseInputs, async () => {
      throw new Error('migration must not repeat');
    });

    expect(contexts).toHaveLength(1);
    expect(JSON.stringify(await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)))
      .not.toContain(legacyVerifier);
  });

  it('treats malformed records as a conservative legacy migration', async () => {
    await storage.genericSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, { version: 2, status: 'surprise' });
    const result = await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    expect(result).toMatchObject({ changed: true, reason: 'legacy-migration' });
  });

  it('rejects a generation rollback', async () => {
    await reconcileModeFingerprint(
      storage,
      { ...baseInputs, authorizationGeneration: 3 },
      noOpInvalidation,
    );
    await expect(reconcileModeFingerprint(
      storage,
      { ...baseInputs, authorizationGeneration: 2 },
      noOpInvalidation,
    )).rejects.toThrow('rollback refused');
  });

  it('lets exactly one replica own a concurrent transition', async () => {
    await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    let releaseWinner: (() => void) | undefined;
    const winnerBlocked = new Promise<void>((resolve) => { releaseWinner = resolve; });
    let winnerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { winnerStarted = resolve; });
    const invalidate = jest.fn<() => Promise<void>>(async () => {
      winnerStarted?.();
      await winnerBlocked;
    });
    const nextInputs = { ...baseInputs, authorizationGeneration: 1 };

    const first = reconcileModeFingerprint(storage, nextInputs, invalidate);
    await started;
    const second = reconcileModeFingerprint(storage, nextInputs, invalidate);
    releaseWinner?.();
    const results = await Promise.all([first, second]);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.changed)).toHaveLength(1);
  });

  it('accepts idempotent completion when a peer already stored the matching stable record', async () => {
    class PeerCompletionStorage extends InMemoryAuthStorageLayer {
      override async genericCompareAndSet(
        model: string,
        id: string,
        expectedPayload: unknown,
        payload: unknown,
        expiresInSec?: number,
      ): Promise<boolean> {
        const expected = expectedPayload as { status?: unknown };
        const desired = payload as { status?: unknown };
        if (expected.status === 'transitioning' && desired.status === 'stable') {
          await this.genericSet(model, id, payload, expiresInSec);
          return false;
        }
        return super.genericCompareAndSet(model, id, expectedPayload, payload, expiresInSec);
      }
    }

    storage = new PeerCompletionStorage();
    await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    const result = await reconcileModeFingerprint(
      storage,
      { ...baseInputs, authorizationGeneration: 1 },
      noOpInvalidation,
    );

    expect(result).toMatchObject({ changed: true, reason: 'generation-increase' });
    expect(await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)).toMatchObject({
      status: 'stable',
      authorizationGeneration: 1,
    });
  });

  it('recovers an interrupted transition after the backend releases a crashed owner lock', async () => {
    const fingerprint = computeFingerprint(baseInputs);
    const pending: TransitioningModeFingerprintRecord = {
      version: MODE_FINGERPRINT_VERSION,
      status: 'transitioning',
      fingerprint,
      authorizationGeneration: 0,
      transitionId: 'crashed-owner',
      transitionStartedAt: 1_000,
      reason: 'legacy-migration',
    };
    await storage.genericSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, pending);
    const invalidate = jest.fn<() => Promise<void>>(async () => {});

    const result = await reconcileModeFingerprint(storage, baseInputs, invalidate, {
      now: () => 40_000,
      createTransitionId: () => 'recovery-owner',
    });
    expect(result).toMatchObject({ changed: true, transitionId: 'recovery-owner' });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('leaves a visible transition when invalidation fails', async () => {
    await reconcileModeFingerprint(storage, baseInputs, noOpInvalidation);
    await expect(reconcileModeFingerprint(
      storage,
      { ...baseInputs, authorizationGeneration: 1 },
      async () => { throw new Error('rotation failed'); },
    )).rejects.toThrow('rotation failed');

    expect(await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)).toMatchObject({
      status: 'transitioning',
      authorizationGeneration: 1,
    });
  });

  it('rejects conflicting replica configuration during an active transition', async () => {
    const pending: TransitioningModeFingerprintRecord = {
      version: MODE_FINGERPRINT_VERSION,
      status: 'transitioning',
      fingerprint: computeFingerprint(baseInputs),
      authorizationGeneration: 0,
      transitionId: 'active-owner',
      transitionStartedAt: Date.now(),
      reason: 'mode-change',
    };
    await storage.genericSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, pending);

    await expect(reconcileModeFingerprint(
      storage,
      { ...baseInputs, issuer: 'https://conflict.example.com' },
      noOpInvalidation,
    )).rejects.toThrow('Conflicting authorization mode transition');
  });
});

describe('OAUTH_STATE_MODELS', () => {
  it('covers authorization state but not the transition record itself', () => {
    expect(OAUTH_STATE_MODELS).toEqual(expect.arrayContaining([
      'Session',
      'Grant',
      'AccessToken',
      'RefreshToken',
      'AuthorizationCode',
      'Interaction',
      'ReplayDetection',
    ]));
    expect(OAUTH_STATE_MODELS).not.toContain(FINGERPRINT_MODEL);
  });
});
