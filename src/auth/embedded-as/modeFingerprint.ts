/**
 * Coordinates authorization-mode changes across server replicas.
 *
 * The persisted record contains public mode identity and an operator-managed
 * generation only. It deliberately contains no signing key, cookie secret, or
 * verifier derived from either: secret rotation belongs to the native key
 * lifecycle, while `authorizationGeneration` is the explicit signal for a
 * deployment-wide session invalidation.
 *
 * @module auth/embedded-as/modeFingerprint
 */

import { createHash, randomUUID } from 'node:crypto';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

export const FINGERPRINT_MODEL = 'AuthModeFingerprint';
export const FINGERPRINT_KEY = 'current';
export const MODE_FINGERPRINT_VERSION = 2;

/** OAuth-state K/V models that get wiped on an intentional mode transition. */
export const OAUTH_STATE_MODELS: readonly string[] = [
  'Session',
  'Grant',
  'AuthorizationCode',
  'AccessToken',
  'RefreshToken',
  'Interaction',
  'InteractionCsrf',
  'InteractionMethodChoice',
  'AdminStepUpPending',
  'AdminStepUpClaims',
  'AdminTotpRouteCsrf',
  'ConsoleTotpEnrollment',
  'PushedAuthorizationRequest',
  'BackchannelAuthenticationRequest',
  'ReplayDetection',
];

export interface ModeFingerprintInputs {
  /** AuthConfig.provider (for example, `embedded`). */
  provider: string;
  /** Configured method ids; sorted before hashing. */
  methodIds: readonly string[];
  /** Canonical issuer URL the authorization server publishes. */
  issuer: string;
  /**
   * Monotonic operator-controlled invalidation generation. Increment when an
   * operator-managed auth secret rotates or all existing grants must be
   * invalidated. Never decrement it during rollback.
   */
  authorizationGeneration: number;
}

export type ModeTransitionReason = 'mode-change' | 'generation-increase' | 'legacy-migration';

export interface StableModeFingerprintRecord {
  version: typeof MODE_FINGERPRINT_VERSION;
  status: 'stable';
  fingerprint: string;
  authorizationGeneration: number;
}

export interface TransitioningModeFingerprintRecord {
  version: typeof MODE_FINGERPRINT_VERSION;
  status: 'transitioning';
  fingerprint: string;
  authorizationGeneration: number;
  transitionId: string;
  transitionStartedAt: number;
  reason: ModeTransitionReason;
  previousAuthorizationGeneration?: number;
}

export type ModeFingerprintRecord =
  | StableModeFingerprintRecord
  | TransitioningModeFingerprintRecord;

export interface ModeTransitionContext {
  current: string;
  authorizationGeneration: number;
  previousAuthorizationGeneration?: number;
  reason: ModeTransitionReason;
  transitionId: string;
}

export interface ReconcileModeFingerprintResult {
  changed: boolean;
  firstRun: boolean;
  current: string;
  authorizationGeneration: number;
  reason?: ModeTransitionReason;
  transitionId?: string;
}

export interface ReconcileModeFingerprintOptions {
  now?: () => number;
  createTransitionId?: () => string;
}

function compareCodepoints(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('authorizationGeneration must be a non-negative safe integer');
  }
}

export function computeFingerprint(inputs: ModeFingerprintInputs): string {
  assertGeneration(inputs.authorizationGeneration);
  const canonical = JSON.stringify({
    provider: inputs.provider,
    methodIds: [...inputs.methodIds].sort(compareCodepoints),
    issuer: inputs.issuer,
  });
  // This is a stable identifier over public authorization metadata, not a
  // password or secret verifier. Fast SHA-256 is intentional here.
  return createHash('sha256').update(canonical).digest('base64url');
}

function isStableRecord(value: unknown): value is StableModeFingerprintRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StableModeFingerprintRecord>;
  return record.version === MODE_FINGERPRINT_VERSION
    && record.status === 'stable'
    && typeof record.fingerprint === 'string'
    && Number.isSafeInteger(record.authorizationGeneration)
    && (record.authorizationGeneration ?? -1) >= 0;
}

function isTransitioningRecord(value: unknown): value is TransitioningModeFingerprintRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TransitioningModeFingerprintRecord>;
  return record.version === MODE_FINGERPRINT_VERSION
    && record.status === 'transitioning'
    && typeof record.fingerprint === 'string'
    && Number.isSafeInteger(record.authorizationGeneration)
    && (record.authorizationGeneration ?? -1) >= 0
    && typeof record.transitionId === 'string'
    && record.transitionId.length > 0
    && typeof record.transitionStartedAt === 'number'
    && Number.isFinite(record.transitionStartedAt)
    && (record.reason === 'mode-change'
      || record.reason === 'generation-increase'
      || record.reason === 'legacy-migration');
}

function rollbackError(current: number, persisted: number): Error {
  return new Error(
    `DOLLHOUSE_AUTH_GENERATION rollback refused: configured ${current}, persisted ${persisted}. `
    + 'Use the persisted value or a larger generation across every replica.',
  );
}

function conflictError(): Error {
  return new Error(
    'Conflicting authorization mode transition detected. Ensure every replica uses the same '
    + 'issuer, auth methods, and DOLLHOUSE_AUTH_GENERATION.',
  );
}

function transitionReason(
  stored: unknown,
  fingerprint: string,
  generation: number,
): ModeTransitionReason {
  if (!isStableRecord(stored)) return 'legacy-migration';
  if (stored.fingerprint !== fingerprint) return 'mode-change';
  if (stored.authorizationGeneration !== generation) return 'generation-increase';
  throw new Error('Cannot create a transition for an unchanged authorization mode');
}

function createTransition(
  stored: unknown,
  fingerprint: string,
  generation: number,
  now: number,
  transitionId: string,
): TransitioningModeFingerprintRecord {
  let previousAuthorizationGeneration: number | undefined;
  if (isStableRecord(stored)) {
    previousAuthorizationGeneration = stored.authorizationGeneration;
  } else if (isTransitioningRecord(stored)) {
    previousAuthorizationGeneration = stored.previousAuthorizationGeneration;
  }
  const reason = isTransitioningRecord(stored)
    ? stored.reason
    : transitionReason(stored, fingerprint, generation);
  return {
    version: MODE_FINGERPRINT_VERSION,
    status: 'transitioning',
    fingerprint,
    authorizationGeneration: generation,
    transitionId,
    transitionStartedAt: now,
    reason,
    ...(previousAuthorizationGeneration === undefined ? {} : { previousAuthorizationGeneration }),
  };
}

async function completeTransition(
  storage: IAuthStorageLayer,
  transition: TransitioningModeFingerprintRecord,
): Promise<void> {
  const stable: StableModeFingerprintRecord = {
    version: MODE_FINGERPRINT_VERSION,
    status: 'stable',
    fingerprint: transition.fingerprint,
    authorizationGeneration: transition.authorizationGeneration,
  };
  if (await storage.genericCompareAndSet(
    FINGERPRINT_MODEL,
    FINGERPRINT_KEY,
    transition,
    stable,
  )) return;

  const current = await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY);
  if (isStableRecord(current)
    && current.fingerprint === stable.fingerprint
    && current.authorizationGeneration === stable.authorizationGeneration) return;
  throw new Error('Authorization transition ownership was lost before completion');
}

/**
 * Reconcile the persisted authorization mode under a backend-owned critical
 * section. PostgreSQL holds a transaction advisory lock for the entire
 * transition, so a crashed owner releases its claim while a merely paused
 * owner cannot be overtaken and later resume destructive work.
 */
export async function reconcileModeFingerprint(
  storage: IAuthStorageLayer,
  inputs: ModeFingerprintInputs,
  invalidate: (context: ModeTransitionContext) => Promise<void>,
  options: ReconcileModeFingerprintOptions = {},
): Promise<ReconcileModeFingerprintResult> {
  assertGeneration(inputs.authorizationGeneration);
  const fingerprint = computeFingerprint(inputs);
  const now = options.now ?? Date.now;
  const createTransitionId = options.createTransitionId ?? randomUUID;

  return storage.withGenericLock(FINGERPRINT_MODEL, FINGERPRINT_KEY, async () => {
    const stored = await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY);

    if (stored === null) {
      const stable: StableModeFingerprintRecord = {
        version: MODE_FINGERPRINT_VERSION,
        status: 'stable',
        fingerprint,
        authorizationGeneration: inputs.authorizationGeneration,
      };
      if (!await storage.genericInsertIfAbsent(FINGERPRINT_MODEL, FINGERPRINT_KEY, stable)) {
        throw new Error('Authorization mode first-run persistence conflict');
      }
      return {
        changed: false,
        firstRun: true,
        current: fingerprint,
        authorizationGeneration: inputs.authorizationGeneration,
      };
    }

    if (isStableRecord(stored)) {
      if (inputs.authorizationGeneration < stored.authorizationGeneration) {
        throw rollbackError(inputs.authorizationGeneration, stored.authorizationGeneration);
      }
      if (stored.fingerprint === fingerprint
        && stored.authorizationGeneration === inputs.authorizationGeneration) {
        return {
          changed: false,
          firstRun: false,
          current: fingerprint,
          authorizationGeneration: inputs.authorizationGeneration,
        };
      }
    }

    if (isTransitioningRecord(stored)) {
      if (inputs.authorizationGeneration < stored.authorizationGeneration) {
        throw rollbackError(inputs.authorizationGeneration, stored.authorizationGeneration);
      }
      if (stored.fingerprint !== fingerprint
        || stored.authorizationGeneration !== inputs.authorizationGeneration) {
        throw conflictError();
      }
    }

    const transition = createTransition(
      stored,
      fingerprint,
      inputs.authorizationGeneration,
      now(),
      createTransitionId(),
    );
    const claimed = await storage.genericCompareAndSet(
      FINGERPRINT_MODEL,
      FINGERPRINT_KEY,
      stored,
      transition,
    );
    if (!claimed) {
      throw new Error('Authorization transition claim conflict while holding the backend lock');
    }

    const context: ModeTransitionContext = {
      current: fingerprint,
      authorizationGeneration: inputs.authorizationGeneration,
      previousAuthorizationGeneration: transition.previousAuthorizationGeneration,
      reason: transition.reason,
      transitionId: transition.transitionId,
    };
    await invalidate(context);
    await completeTransition(storage, transition);
    return {
      changed: true,
      firstRun: false,
      current: fingerprint,
      authorizationGeneration: inputs.authorizationGeneration,
      reason: transition.reason,
      transitionId: transition.transitionId,
    };
  });
}
