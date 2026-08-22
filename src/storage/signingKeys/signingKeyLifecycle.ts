import type {
  SigningKey,
  SigningKeyKind,
  SigningKeyModeTransitionResult,
  SigningKeyWrite,
} from './ISigningKeyStore.js';

const AUTHORIZATION_GENERATION_PROPERTY = '__dollhouseAuthorizationGeneration';

interface AuthorizationGenerationMarker {
  readonly transitionId: string;
  readonly generationFingerprint: string;
}

/** A prebound signing key lost active status before its transaction used it. */
export class SigningKeyLifecycleConflictError extends Error {
  constructor(
    message: string,
    readonly lifecycleCause?: unknown,
  ) {
    super(message);
    this.name = 'SigningKeyLifecycleConflictError';
  }
}

export function isSigningKeyLifecycleConflictError(
  error: unknown,
): error is SigningKeyLifecycleConflictError {
  return error instanceof SigningKeyLifecycleConflictError;
}

export const JWKS_VERIFICATION_GRACE_MS = 2 * 60 * 60 * 1000;
export const COOKIE_VERIFICATION_GRACE_MS = (14 * 24 * 60 + 5) * 60 * 1000;
export const INVITE_VERIFICATION_GRACE_MS = 65 * 60 * 1000;

export function signingKeyVerificationGraceMs(kind: SigningKeyKind): number {
  switch (kind) {
    case 'jwks': return JWKS_VERIFICATION_GRACE_MS;
    case 'cookie': return COOKIE_VERIFICATION_GRACE_MS;
    case 'invite': return INVITE_VERIFICATION_GRACE_MS;
  }
}

/** Active keys and recently rotated keys verify; explicit retirement always wins. */
export function signingKeyCanVerify(key: SigningKey, now = Date.now()): boolean {
  if (key.retiredAt !== undefined) return false;
  if (key.active) return true;
  if (key.rotatedAt === undefined) return false;
  const age = now - key.rotatedAt;
  return age >= 0 && age <= signingKeyVerificationGraceMs(key.kind);
}

export interface StagedSigningKeyModeTransition extends SigningKeyModeTransitionResult {
  readonly keys: readonly SigningKey[];
}

/**
 * Build a complete mode-transition key set without mutating the caller's data.
 * Stores commit this staged result under their backend-specific atomic boundary.
 */
export function stageSigningKeyModeTransition(
  existingKeys: readonly SigningKey[],
  transition: {
    readonly replacements: readonly SigningKeyWrite[];
    readonly transitionId: string;
    readonly expectedGenerationFingerprint?: string;
    readonly targetGenerationFingerprint: string;
  },
  transitionedAt = Date.now(),
): StagedSigningKeyModeTransition {
  if (!Number.isFinite(transitionedAt) || transitionedAt < 0) {
    throw new Error('Authorization mode key transition requires a valid timestamp');
  }
  assertTransitionIdentity(transition.transitionId, transition.targetGenerationFingerprint);
  const activeJwks = existingKeys.find(key => key.kind === 'jwks' && key.active);
  const activeGeneration = activeJwks ? readAuthorizationGeneration(activeJwks.payload) : null;
  if (activeGeneration?.generationFingerprint === transition.targetGenerationFingerprint) {
    const installed = existingKeys
      .filter(key => key.active
        && readAuthorizationGeneration(key.payload)?.transitionId === activeGeneration.transitionId)
      .map(cloneSigningKey);
    return {
      keys: existingKeys.map(cloneSigningKey),
      transitionId: activeGeneration.transitionId,
      alreadyApplied: true,
      retired: [],
      installed,
    };
  }
  if (activeGeneration
      && activeGeneration.generationFingerprint !== transition.expectedGenerationFingerprint) {
    throw new Error(
      'Authorization mode key transition rejected because the active generation changed; retry from the current fingerprint',
    );
  }

  const replacementKinds = new Set<SigningKeyKind>();
  const replacementKids = new Set<string>();
  const existingKids = new Set(existingKeys.map(key => key.kid));
  for (const replacement of transition.replacements) {
    if (replacementKinds.has(replacement.kind)) {
      throw new Error(`Authorization mode key transition has multiple '${replacement.kind}' replacements`);
    }
    if (replacementKids.has(replacement.kid) || existingKids.has(replacement.kid)) {
      throw new Error(`SigningKeyStore: kid '${replacement.kid}' already exists; mode transition requires fresh kids.`);
    }
    replacementKinds.add(replacement.kind);
    replacementKids.add(replacement.kid);
  }

  const retired: SigningKey[] = [];
  const keys = existingKeys.map(key => {
    const staged = cloneSigningKey(key);
    if (staged.retiredAt === undefined) {
      staged.active = false;
      staged.rotatedAt ??= transitionedAt;
      staged.retiredAt ??= transitionedAt;
      retired.push(cloneSigningKey(staged));
    }
    return staged;
  });
  const installed = transition.replacements.map(replacement => ({
    kid: replacement.kid,
    kind: replacement.kind,
    payload: withAuthorizationGeneration(replacement.payload, {
      transitionId: transition.transitionId,
      generationFingerprint: transition.targetGenerationFingerprint,
    }),
    active: true,
    createdAt: transitionedAt,
  } satisfies SigningKey));
  keys.push(...installed.map(cloneSigningKey));
  return {
    keys,
    transitionId: transition.transitionId,
    alreadyApplied: false,
    retired,
    installed: installed.map(cloneSigningKey),
  };
}

/** Preserve the mode-generation fence across ordinary administrative rotation. */
export function inheritAuthorizationGeneration(
  current: SigningKey | null | undefined,
  write: SigningKeyWrite,
): SigningKeyWrite {
  const marker = current ? readAuthorizationGeneration(current.payload) : null;
  return {
    ...write,
    payload: marker
      ? withAuthorizationGeneration(write.payload, marker)
      : withoutAuthorizationGeneration(write.payload),
  };
}

export function readAuthorizationGeneration(
  payload: Record<string, unknown>,
): AuthorizationGenerationMarker | null {
  const value = payload[AUTHORIZATION_GENERATION_PROPERTY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AuthorizationGenerationMarker>;
  return typeof candidate.transitionId === 'string'
    && typeof candidate.generationFingerprint === 'string'
    ? {
      transitionId: candidate.transitionId,
      generationFingerprint: candidate.generationFingerprint,
    }
    : null;
}

function withAuthorizationGeneration(
  payload: Record<string, unknown>,
  marker: AuthorizationGenerationMarker,
): Record<string, unknown> {
  return {
    ...structuredClone(payload),
    [AUTHORIZATION_GENERATION_PROPERTY]: { ...marker },
  };
}

function withoutAuthorizationGeneration(payload: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(payload);
  delete cloned[AUTHORIZATION_GENERATION_PROPERTY];
  return cloned;
}

function assertTransitionIdentity(transitionId: string, generationFingerprint: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(transitionId)) {
    throw new Error('Authorization mode key transition requires a UUIDv4 transitionId');
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(generationFingerprint)) {
    throw new Error('Authorization mode key transition requires a SHA-256 generation fingerprint');
  }
}

export function cloneSigningKey(key: SigningKey): SigningKey {
  return {
    kid: key.kid,
    kind: key.kind,
    payload: structuredClone(key.payload),
    active: key.active,
    createdAt: key.createdAt,
    rotatedAt: key.rotatedAt,
    retiredAt: key.retiredAt,
  };
}
