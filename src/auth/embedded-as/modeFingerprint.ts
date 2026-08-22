/**
 * modeFingerprint
 *
 * Implements must-fix #14 (mode-switch invalidation). At startup the AS
 * computes a fingerprint of its operating mode (provider, configured
 * methods, issuer URL) and
 * compares to the last-persisted fingerprint. When the fingerprint
 * changes, all previously-issued tokens are presumed invalid: an
 * operator who flipped DOLLHOUSE_AUTH_PROVIDER or swapped
 * DOLLHOUSE_AUTH_METHODS should not have prior tokens keep working. The AS
 * clears OAuth-state K/V models and forces fresh signing material.
 *
 * Mutable signing keys are excluded from the v2 fingerprint. Coupling key
 * rotation to mode invalidation caused a fresh replica to treat an ordinary
 * administrative rotation as a mode change and rotate a second time.
 *
 * @module auth/embedded-as/modeFingerprint
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

export const FINGERPRINT_MODEL = 'AuthModeFingerprint';
export const FINGERPRINT_KEY = 'current';
const FINGERPRINT_VERSION = 2;
const COOKIE_OVERRIDE_FINGERPRINT_CONTEXT = 'DollhouseMCP cookie override v1\0';
const INVITE_OVERRIDE_FINGERPRINT_CONTEXT = 'DollhouseMCP invite override v1\0';

interface ModeFingerprintRecord {
  readonly fingerprint?: string;
  readonly version?: number;
  readonly cookieOverrideFingerprint?: string;
  readonly inviteOverrideFingerprint?: string;
  readonly generationFingerprint?: string;
  readonly transitionId?: string;
  readonly authorizationGeneration?: number;
}

/** OAuth-state K/V models that get wiped on mode change. */
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
  // Cycle-16 fix: oidc-provider's PKCE replay-detection records are
  // tied to the prior signing key + issuer. Surviving them across a
  // mode-switch lets a previously-replayed code_verifier evade
  // replay detection in the new mode.
  'ReplayDetection',
];

export interface ModeFingerprintInputs {
  /** AuthConfig.provider (e.g. 'embedded' | 'oidc' | 'local'). */
  provider: string;
  /** Configured method ids; sorted by the fingerprint function. */
  methodIds: readonly string[];
  /** Canonical issuer URL the AS publishes. */
  issuer: string;
  /** Optional operator-managed monotonic deployment epoch. */
  authorizationGeneration?: number;
  /** Primary signing kid from the JWKS keyset. */
  primaryKid: string;
  /**
   * Primary cookie signing key used only to recognize legacy v1 records.
   * It does not contribute to the v2 operating-mode fingerprint.
   */
  primaryCookieKey: string;
  /**
   * Cookie key supplied by the operator through
   * DOLLHOUSE_COOKIE_SIGNING_SECRET. Unlike primaryCookieKey, this value is
   * tracked separately so a mode switch can prove that an operator-managed
   * key was rotated without coupling ordinary durable-store rotation to the
   * operating-mode fingerprint.
   */
  operatorManagedCookieKey?: string;
  /** Operator-managed invite/magic-link HMAC key, tracked outside the mode hash. */
  operatorManagedInviteKey?: string;
  /**
   * Historical durable-store key pairs used only to recognize a v1 fingerprint
   * during migration. They never contribute to the v2 operating-mode hash.
   */
  legacyKeyCandidates?: readonly {
    readonly primaryKid: string;
    readonly primaryCookieKey: string;
  }[];
}

export function computeFingerprint(inputs: ModeFingerprintInputs): string {
  // Explicit codepoint comparison, NOT `localeCompare`. The fingerprint must be
  // stable across hosts and operating-system locales — a deploy on a host with
  // `LC_COLLATE=en_US.UTF-8` and a replica with `LC_COLLATE=C` would otherwise
  // compute different fingerprints for the same logical mode, triggering
  // spurious mode-switch invalidation. Sonar's S2871 (suggest `localeCompare`)
  // is the wrong fix here. NOSONAR
  const sortedMethods = [...inputs.methodIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // NOSONAR — nested ternary is the compact three-way comparator form; extracting makes it less readable
  const canonical = JSON.stringify({
    v: FINGERPRINT_VERSION,
    p: inputs.provider,
    m: sortedMethods,
    i: inputs.issuer,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}

function computeLegacyFingerprint(inputs: ModeFingerprintInputs): string {
  const sortedMethods = [...inputs.methodIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cookieKeyHash = createHash('sha256')
    .update(inputs.primaryCookieKey)
    .digest('base64url');
  return createHash('sha256').update(JSON.stringify({
    p: inputs.provider,
    m: sortedMethods,
    i: inputs.issuer,
    k: inputs.primaryKid,
    c: cookieKeyHash,
  })).digest('base64url');
}

export interface CheckModeFingerprintResult {
  /** True when the persisted fingerprint differed from the current one. */
  changed: boolean;
  /** True when no fingerprint was persisted yet (first run, or post-clear). */
  firstRun: boolean;
  /** The previous fingerprint, when there was one. */
  previous?: string;
  /** The current fingerprint, always set. */
  current: string;
  /** Generation fence including operating mode and credential ownership. */
  currentGenerationFingerprint: string;
  /** Persisted generation fence, reconstructed for older v2 records. */
  previousGenerationFingerprint?: string;
  /** True when override ownership/material changed even if the mode did not. */
  credentialGenerationChanged: boolean;
  /** A matching legacy record should be rewritten without invalidation. */
  migrationRequired?: boolean;
  /** The current deployment uses an operator-managed cookie key. */
  cookieOverrideConfigured: boolean;
  /** The persisted record contains a fingerprint for that override. */
  cookieOverrideFingerprintRecorded: boolean;
  /** A recorded override fingerprint differs from the current configuration. */
  cookieOverrideChanged: boolean;
  /** An unchanged v2 mode should persist current override metadata. */
  cookieOverrideMetadataUpdateRequired?: boolean;
  /** The current deployment uses an operator-managed invite key. */
  inviteOverrideConfigured: boolean;
  /** The persisted record contains a fingerprint for that invite override. */
  inviteOverrideFingerprintRecorded: boolean;
  /** A recorded invite override fingerprint differs from current configuration. */
  inviteOverrideChanged: boolean;
  /** An unchanged v2 mode should persist current invite override metadata. */
  inviteOverrideMetadataUpdateRequired?: boolean;
  /** Exact durable snapshot used by the comparison; required for atomic persistence. */
  persistenceSnapshot: ModeFingerprintRecord | null;
}

function computeOverrideFingerprint(context: string, key: string | undefined): string | undefined {
  if (!key) return undefined;
  return createHash('sha256')
    .update(context)
    .update(key)
    .digest('base64url');
}

export function computeAuthorizationGenerationFingerprint(inputs: ModeFingerprintInputs): string {
  return computeGenerationFingerprint(
    computeFingerprint(inputs),
    computeOverrideFingerprint(COOKIE_OVERRIDE_FINGERPRINT_CONTEXT, inputs.operatorManagedCookieKey),
    computeOverrideFingerprint(INVITE_OVERRIDE_FINGERPRINT_CONTEXT, inputs.operatorManagedInviteKey),
    inputs.authorizationGeneration,
  );
}

function computeGenerationFingerprint(
  modeFingerprint: string,
  cookieOverrideFingerprint: string | undefined,
  inviteOverrideFingerprint: string | undefined,
  authorizationGeneration: number | undefined,
): string {
  return createHash('sha256').update(JSON.stringify({
    modeFingerprint,
    cookieCredential: cookieOverrideFingerprint ?? 'durable-store',
    inviteCredential: inviteOverrideFingerprint ?? 'durable-store',
    ...(authorizationGeneration !== undefined ? { authorizationGeneration } : {}),
  })).digest('base64url');
}

/**
 * Compare the current mode fingerprint to the persisted one. Returns
 * metadata describing the comparison. Does NOT persist on the
 * `changed: true` path — the caller MUST run the invalidation
 * (clearGenericByModels, rotate cookie secret, rotate signing key)
 * BEFORE calling `persistModeFingerprint` to record the new fingerprint.
 *
 * Why split the read and the write: a crash between fingerprint
 * persistence and OAuth-state clear leaves stale tokens valid against
 * the new mode (the next boot sees the new fingerprint, computes the
 * same fingerprint, decides nothing changed, and never clears). Clear
 * first, then persist — on a crash mid-sequence the next boot
 * recomputes `changed: true` and re-runs the (idempotent) clear.
 */
export async function checkModeFingerprint(
  storage: IAuthStorageLayer,
  inputs: ModeFingerprintInputs,
): Promise<CheckModeFingerprintResult> {
  const current = computeFingerprint(inputs);
  const currentGenerationFingerprint = computeAuthorizationGenerationFingerprint(inputs);
  const stored = (await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)) as ModeFingerprintRecord | null;
  const persistenceState = {
    persistenceSnapshot: stored ? structuredClone(stored) : null,
  };
  const previous = stored?.fingerprint;
  const currentAuthorizationGeneration = inputs.authorizationGeneration ?? 0;
  const previousAuthorizationGeneration = stored?.authorizationGeneration ?? 0;
  const generationEnforced = inputs.authorizationGeneration !== undefined
    || stored?.authorizationGeneration !== undefined;
  if (currentAuthorizationGeneration < previousAuthorizationGeneration) {
    throw new Error(
      `Authorization generation rollback rejected: configured generation ` +
      `${currentAuthorizationGeneration} is older than persisted generation ${previousAuthorizationGeneration}`,
    );
  }
  const currentCookieOverrideFingerprint = computeOverrideFingerprint(
    COOKIE_OVERRIDE_FINGERPRINT_CONTEXT,
    inputs.operatorManagedCookieKey,
  );
  const previousCookieOverrideFingerprint = stored?.cookieOverrideFingerprint;
  const cookieOverrideConfigured = currentCookieOverrideFingerprint !== undefined;
  const cookieOverrideFingerprintRecorded = previousCookieOverrideFingerprint !== undefined;
  const cookieOverrideChanged = cookieOverrideFingerprintRecorded
    && previousCookieOverrideFingerprint !== currentCookieOverrideFingerprint;
  const cookieOverrideState = {
    cookieOverrideConfigured,
    cookieOverrideFingerprintRecorded,
    cookieOverrideChanged,
  };
  const currentInviteOverrideFingerprint = computeOverrideFingerprint(
    INVITE_OVERRIDE_FINGERPRINT_CONTEXT,
    inputs.operatorManagedInviteKey,
  );
  const previousInviteOverrideFingerprint = stored?.inviteOverrideFingerprint;
  const inviteOverrideConfigured = currentInviteOverrideFingerprint !== undefined;
  const inviteOverrideFingerprintRecorded = previousInviteOverrideFingerprint !== undefined;
  const inviteOverrideChanged = inviteOverrideFingerprintRecorded
    && previousInviteOverrideFingerprint !== currentInviteOverrideFingerprint;
  const inviteOverrideState = {
    inviteOverrideConfigured,
    inviteOverrideFingerprintRecorded,
    inviteOverrideChanged,
  };
  const previousGenerationFingerprint = previous
    ? stored?.generationFingerprint ?? computeGenerationFingerprint(
      previous,
      previousCookieOverrideFingerprint,
      previousInviteOverrideFingerprint,
      stored?.authorizationGeneration,
    )
    : undefined;
  const credentialGenerationChanged = previousGenerationFingerprint !== undefined
    && previousGenerationFingerprint !== currentGenerationFingerprint;

  if (!previous) {
    return {
      changed: false,
      firstRun: true,
      current,
      currentGenerationFingerprint,
      credentialGenerationChanged: false,
      ...persistenceState,
      ...cookieOverrideState,
      ...inviteOverrideState,
    };
  }

  if (stored?.version === FINGERPRINT_VERSION && previous === current) {
    assertGenerationAdvancedForChange({
      generationEnforced,
      currentAuthorizationGeneration,
      previousAuthorizationGeneration,
      changed: credentialGenerationChanged,
    });
    return {
      changed: false,
      firstRun: false,
      previous,
      current,
      currentGenerationFingerprint,
      previousGenerationFingerprint,
      credentialGenerationChanged,
      ...persistenceState,
      ...cookieOverrideState,
      ...inviteOverrideState,
      cookieOverrideMetadataUpdateRequired:
        previousCookieOverrideFingerprint !== currentCookieOverrideFingerprint,
      inviteOverrideMetadataUpdateRequired:
        previousInviteOverrideFingerprint !== currentInviteOverrideFingerprint,
    };
  }

  if (stored?.version === undefined) {
    const candidates = [
      { primaryKid: inputs.primaryKid, primaryCookieKey: inputs.primaryCookieKey },
      ...(inputs.legacyKeyCandidates ?? []),
    ];
    const legacyMatch = candidates.some(candidate => previous === computeLegacyFingerprint({
      ...inputs,
      ...candidate,
      legacyKeyCandidates: undefined,
    }));
    if (legacyMatch) {
      if (generationEnforced && currentAuthorizationGeneration > previousAuthorizationGeneration) {
        return {
          changed: false,
          firstRun: false,
          previous,
          current,
          currentGenerationFingerprint,
          previousGenerationFingerprint,
          credentialGenerationChanged: true,
          ...persistenceState,
          ...cookieOverrideState,
          ...inviteOverrideState,
        };
      }
      return {
        changed: false,
        firstRun: false,
        previous,
        current,
        currentGenerationFingerprint,
        previousGenerationFingerprint,
        credentialGenerationChanged: false,
        migrationRequired: true,
        ...persistenceState,
        ...cookieOverrideState,
        ...inviteOverrideState,
      };
    }
  }

  assertGenerationAdvancedForChange({
    generationEnforced,
    currentAuthorizationGeneration,
    previousAuthorizationGeneration,
    changed: true,
  });

  return {
    changed: true,
    firstRun: false,
    previous,
    current,
    currentGenerationFingerprint,
    previousGenerationFingerprint,
    credentialGenerationChanged,
    ...persistenceState,
    ...cookieOverrideState,
    ...inviteOverrideState,
  };
}

/**
 * Persist the current mode fingerprint. Caller MUST run all
 * invalidation work first; this is the last step in the sequence so
 * a crash mid-sequence is safe (next boot recomputes `changed: true`
 * and re-runs the idempotent invalidation).
 */
export async function persistModeFingerprint(
  storage: IAuthStorageLayer,
  inputs: ModeFingerprintInputs,
  options: {
    readonly transitionId?: string;
    readonly expectedSnapshot?: ModeFingerprintRecord | null;
  } = {},
): Promise<void> {
  const current = computeFingerprint(inputs);
  const cookieOverrideFingerprint = computeOverrideFingerprint(
    COOKIE_OVERRIDE_FINGERPRINT_CONTEXT,
    inputs.operatorManagedCookieKey,
  );
  const inviteOverrideFingerprint = computeOverrideFingerprint(
    INVITE_OVERRIDE_FINGERPRINT_CONTEXT,
    inputs.operatorManagedInviteKey,
  );
  const target: ModeFingerprintRecord = {
    fingerprint: current,
    generationFingerprint: computeAuthorizationGenerationFingerprint(inputs),
    version: FINGERPRINT_VERSION,
    ...(inputs.authorizationGeneration !== undefined
      ? { authorizationGeneration: inputs.authorizationGeneration }
      : {}),
    ...(options.transitionId ? { transitionId: options.transitionId } : {}),
    ...(cookieOverrideFingerprint ? { cookieOverrideFingerprint } : {}),
    ...(inviteOverrideFingerprint ? { inviteOverrideFingerprint } : {}),
  };
  const expected = options.expectedSnapshot !== undefined
    ? options.expectedSnapshot
    : await readFingerprintRecord(storage);
  assertMonotonicFingerprintWrite(expected, target);

  const persisted = expected === null
    ? await storage.genericInsertIfAbsent(FINGERPRINT_MODEL, FINGERPRINT_KEY, target)
    : await storage.genericCompareAndSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, expected, target);
  if (persisted) return;

  const winner = await readFingerprintRecord(storage);
  if (isDeepStrictEqual(toJsonValue(winner), toJsonValue(target))) return;
  throw new Error(
    'Authorization fingerprint persistence conflict: another replica committed a different generation; retry initialization',
  );
}

function toJsonValue(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? undefined : JSON.parse(encoded) as unknown;
}

async function readFingerprintRecord(storage: IAuthStorageLayer): Promise<ModeFingerprintRecord | null> {
  return (await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)) as ModeFingerprintRecord | null;
}

function assertMonotonicFingerprintWrite(
  expected: ModeFingerprintRecord | null,
  target: ModeFingerprintRecord,
): void {
  if (!expected) return;
  const previousGeneration = expected.authorizationGeneration ?? 0;
  const targetGeneration = target.authorizationGeneration ?? 0;
  if (targetGeneration < previousGeneration) {
    throw new Error(
      `Authorization generation rollback rejected: target generation ${targetGeneration} ` +
      `is older than persisted generation ${previousGeneration}`,
    );
  }
  if (expected.version === FINGERPRINT_VERSION
      && expected.generationFingerprint
      && (expected.authorizationGeneration !== undefined || target.authorizationGeneration !== undefined)
      && targetGeneration === previousGeneration
      && expected.generationFingerprint !== target.generationFingerprint) {
    throw new Error(
      'Authorization fingerprint persistence rejected because configuration changed without advancing ' +
      `DOLLHOUSE_AUTH_GENERATION beyond ${previousGeneration}`,
    );
  }
}

function assertGenerationAdvancedForChange(input: {
  readonly generationEnforced: boolean;
  readonly currentAuthorizationGeneration: number;
  readonly previousAuthorizationGeneration: number;
  readonly changed: boolean;
}): void {
  if (!input.generationEnforced || !input.changed) return;
  if (input.currentAuthorizationGeneration <= input.previousAuthorizationGeneration) {
    throw new Error(
      'Authorization mode or credential configuration changed without advancing ' +
      `DOLLHOUSE_AUTH_GENERATION beyond ${input.previousAuthorizationGeneration}`,
    );
  }
}
