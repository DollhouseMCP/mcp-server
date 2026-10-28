/**
 * Shared persistence utilities for file-backed state stores.
 *
 * Provides retry logic, error handling patterns, and constants
 * used by FileActivationStateStore, FileConfirmationStore, and
 * FileChallengeStore.
 *
 * @since v2.1.0 — Pre-Phase 4 Store Consolidation
 */

import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

/** Maximum number of retry attempts for transient disk failures. */
export const PERSIST_MAX_RETRIES = 2;

/** Delay between retry attempts in milliseconds. */
export const PERSIST_RETRY_DELAY_MS = 100;

/**
 * Execute an async operation with retry on failure.
 *
 * @param operation - The async operation to attempt
 * @param maxRetries - Maximum retry count (default: PERSIST_MAX_RETRIES)
 * @param delayMs - Delay between retries in ms (default: PERSIST_RETRY_DELAY_MS)
 */
export async function withRetry(
  operation: () => Promise<void>,
  maxRetries: number = PERSIST_MAX_RETRIES,
  delayMs: number = PERSIST_RETRY_DELAY_MS,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (maxRetries > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return withRetry(operation, maxRetries - 1, delayMs);
    }
    throw error;
  }
}

/**
 * Fire-and-forget persistence with retry and security event logging on failure.
 *
 * @param operation - The async persist operation
 * @param storeName - Store class name for logging (e.g., 'FileActivationStateStore')
 * @param stateType - Human-readable state type (e.g., 'activation state')
 * @param sessionId - Session ID for log attribution
 */
export function fireAndForgetPersist(
  operation: () => Promise<void>,
  storeName: string,
  stateType: string,
  sessionId: string,
): void {
  withRetry(operation).catch(error => {
    logger.warn(`[${storeName}] Failed to persist ${stateType} after retries`, { error });

    SecurityMonitor.logSecurityEvent({
      type: 'OPERATION_FAILED',
      severity: 'MEDIUM',
      source: `${storeName}.persistAsync`,
      details: `Failed to persist ${stateType} for session '${sessionId}' after ${PERSIST_MAX_RETRIES + 1} attempts`,
      additionalData: { error: String(error), sessionId },
    });
  });
}

/** A read result carries facts; each store owns its recovery policy. */
export type PersistedStateRead<T> =
  | { status: 'absent' }
  | { status: 'loaded'; value: T }
  | { status: 'unreadable'; cause: unknown }
  | { status: 'unsupportedVersion' }
  | { status: 'invalid'; cause: unknown };

export function isStateObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readPersistedState<T>(
  read: () => Promise<string>,
  validate: (value: unknown) => T,
  version?: number,
): Promise<PersistedStateRead<T>> {
  let content: string;
  try {
    content = await read();
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { status: 'absent' } : { status: 'unreadable', cause };
  }
  try {
    const value: unknown = JSON.parse(content);
    if (version !== undefined) {
      if (!isStateObject(value) || typeof value.version !== 'number') {
        throw new Error('Persisted state requires a version');
      }
      if (value.version !== version) return { status: 'unsupportedVersion' };
    }
    return { status: 'loaded', value: validate(value) };
  } catch (cause) {
    return { status: 'invalid', cause };
  }
}

/** Read an object snapshot, reporting rejected state while treating absence as empty. */
export async function readValidatedState<T>(
  read: () => Promise<string>,
  validate: (value: Record<string, unknown>) => T,
  onIssue: (status: string) => void,
): Promise<T | undefined> {
  const result = await readPersistedState(read, value => {
    if (!isStateObject(value)) throw new Error('Invalid state object');
    return validate(value);
  }, 1);
  if (result.status === 'loaded') return result.value;
  if (result.status !== 'absent') onIssue(result.status);
  return undefined;
}

/** Report a rejected snapshot without choosing a store's fallback behavior. */
export function logPersistedStateIssue(status: string, storeName: string, sessionId: string): void {
  logger.warn(`[${storeName}] Persisted state is ${status}`, { sessionId });
  SecurityMonitor.logSecurityEvent({
    type: 'OPERATION_FAILED', severity: 'MEDIUM', source: `${storeName}.initialize`,
    details: `Persisted state is ${status}`, additionalData: { sessionId },
  });
}
