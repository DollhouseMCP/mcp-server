import { sanitizeStorageError, StorageScanError } from '../../storage/StorageScanError.js';
import { isContentRejection, markContentRejection } from '../../security/contentRejection.js';
import { ValidationError } from '../../security/errors.js';
import type { UnindexedEntry } from '../../storage/IStorageLayer.js';

export interface ElementReadFailure {
  readonly type?: string;
  readonly reference?: string;
  readonly reason: string;
  /**
   * The definition at this reference was read and its content rejected (its own bytes are the
   * failure). Absent for a storage, scan or indeterminate failure, which establishes nothing about
   * the definition's content.
   */
  readonly contentRejected?: true;
}

interface ElementReadErrorOptions extends ErrorOptions {
  failures?: readonly ElementReadFailure[];
}

/** The client-safe failure reasons the read contract reports. */
export const READ_FAILURE_REASONS = {
  /** A record the index saw fail (an unparseable or rejected definition) could hold the name. */
  recordFailed: 'Definition could not be read or validated',
  /** The definition's content was read and rejected. */
  contentRejected: 'Definition content could not be read or validated',
  /** A storage or validation operation failed: nothing is established about the definition. */
  storage: 'Storage or validation operation failed',
  /** Several definitions tie for the name. */
  ambiguous: 'Competing definition name',
} as const;

/** A failed read is never evidence that an element is absent. */
export class ElementReadError extends Error {
  override readonly name: string = 'ElementReadError';
  readonly failures: readonly ElementReadFailure[];
  readonly code?: string;

  constructor(message: string, readonly kind: 'absent' | 'unreadable' | 'indeterminate', options?: ElementReadErrorOptions) {
    const failures = options?.failures ?? [];
    const details = failures.map(failure => `${failure.reference === undefined ? 'collection' : JSON.stringify(failure.reference)}: ${failure.reason}`);
    super(details.length ? `${message}: ${details.join('; ')}` : message, options);
    this.failures = failures;
    const code = (options?.cause as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT from an auxiliary read must never masquerade as definition absence.
    if (typeof code === 'string' && (code !== 'ENOENT' || kind === 'absent')) this.code = code;
  }
}

/** The identified definition could not be read or validated. */
export class ElementUnreadableError extends ElementReadError {
  override readonly name: string = 'ElementUnreadableError';

  constructor(message: string, options?: ElementReadErrorOptions) {
    super(message, 'unreadable', options);
  }
}

/** Incomplete discovery cannot establish which definition answers the request. */
export class ElementIndeterminateError extends ElementReadError {
  override readonly name: string = 'ElementIndeterminateError';
  /** True when the name is ambiguous (definitions tie), not when a definition failed to read. */
  readonly ambiguous: boolean;

  constructor(message: string, options?: ElementReadErrorOptions & { ambiguous?: boolean }) {
    super(message, 'indeterminate', options);
    this.ambiguous = options?.ambiguous === true;
  }
}

/** The one ambiguity refusal: the competing references, typed as ambiguous. */
export function ambiguousNameError(references: readonly string[], cause?: unknown): ElementIndeterminateError {
  return new ElementIndeterminateError('Element name is ambiguous', { cause, ambiguous: true,
    failures: references.map(reference => ({ reference, reason: READ_FAILURE_REASONS.ambiguous })) });
}

/** A storage read established that the requested definition does not exist. */
export class ElementMissingError extends ElementReadError {
  override readonly name = 'ElementMissingError';
  override readonly code = 'ENOENT';

  constructor(reference: string, cause: unknown) {
    super('Element definition does not exist', 'absent', { cause, failures: [{ reference, reason: 'not found' }] });
  }
}

/** A guarded read must be retried from a new revision, never treated as unreadability. */
export class GuardedReadConflict extends Error {
  override readonly name = 'GuardedReadConflict';

  constructor(readonly code: string, cause: unknown) {
    super('Guarded element revision changed; read a fresh revision and retry', { cause });
  }
}

/** Diagnostic messages from parsers and drivers can contain definition bytes or query parameters. */
export function clientReadFailureReason(cause: unknown): string {
  if (cause instanceof ElementReadError || cause instanceof GuardedReadConflict || cause instanceof ValidationError) return cause.message;
  const visited = new Set<unknown>();
  let current = cause;
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const safe = sanitizeStorageError(current);
    if (safe instanceof StorageScanError) return safe.message;
    current = (current as { cause?: unknown }).cause;
  }
  return isContentRejection(cause) ? READ_FAILURE_REASONS.contentRejected : READ_FAILURE_REASONS.storage;
}

/**
 * A database identity resolution failure in the read contract: a same-tier name collision
 * (EAMBIGUOUS, naming the competing rows) is the shared selector's ambiguity; any other failure
 * is classified as a read failure of the requested text.
 */
export function identityResolutionFailure(cause: unknown, identifier: string): ElementReadError | GuardedReadConflict {
  const competitors = (cause as { code?: string; competitors?: unknown }).code === 'EAMBIGUOUS'
    ? (cause as { competitors?: unknown }).competitors : undefined;
  if (!Array.isArray(competitors)) return elementReadFailure(cause, identifier);
  return ambiguousNameError(competitors.map(String), cause);
}

/**
 * Classify every failure of a stored reference into the read contract. A path validator
 * rejection is an unreadable definition attributed to that reference (the validator's message is
 * client-safe); caller input is validated before the contract is entered, where the validator's
 * own error surfaces directly. This never throws.
 */
export function elementReadFailure(cause: unknown, reference?: string): ElementReadError | GuardedReadConflict {
  if (cause instanceof ElementReadError || cause instanceof GuardedReadConflict) return cause;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code && ['ESTALE', 'EHEADCONFLICT', 'EHEADOUTOFSYNC'].includes(code)) return new GuardedReadConflict(code, cause);
  return new ElementUnreadableError('Element read failed', { cause, failures: [{ reference,
    reason: clientReadFailureReason(cause), ...(isContentRejection(cause) ? { contentRejected: true as const } : {}) }] });
}

/**
 * Whether a read failed because the definition's own content was rejected: the one provenance rule
 * for a repair (back up or remove the rejected definition). A storage, scan or indeterminate failure,
 * including one raised by another reference while this one was read, never qualifies.
 */
export function isRejectedDefinition(error: unknown): error is ElementUnreadableError {
  return error instanceof ElementUnreadableError && isContentRejection(error);
}

/**
 * A read entered with caller text: the caller's own reference refusal (ValidationError) surfaces
 * unwrapped, as the validator raised it; every storage failure is classified by elementReadFailure.
 */
export function callerReadFailure(cause: unknown, reference?: string): ElementReadError | GuardedReadConflict | ValidationError {
  return cause instanceof ValidationError ? cause : elementReadFailure(cause, reference);
}

/** Preserve classification from the storage-owned rejection evidence without exposing rejected bytes. */
export function indexedReadFailure(reference: string, failure: UnindexedEntry): ElementReadError | GuardedReadConflict {
  const cause = failure.name === 'ValidationError'
    ? new ValidationError(failure.reason)
    : Object.assign(new Error(failure.reason), { name: failure.name, code: failure.code });
  if (failure.contentRejected) markContentRejection(cause);
  return elementReadFailure(cause, reference);
}
