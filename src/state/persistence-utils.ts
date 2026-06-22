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
  let attempt = 0;
  while (true) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt < maxRetries) {
        attempt++;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw error;
      }
    }
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

/**
 * Standard error handler for file-backed store initialization.
 * Handles ENOENT (no file yet) and other errors (corruption, permissions).
 *
 * @param error - The caught error
 * @param storeName - Store class name for logging
 * @param stateType - Human-readable state type (e.g., 'activation', 'confirmation')
 * @param sessionId - Session ID for log attribution
 */
export function handleInitializeError(
  error: unknown,
  storeName: string,
  stateType: string,
  sessionId: string,
): void {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    logger.debug(`[${storeName}] No ${stateType} file found for session '${sessionId}', starting fresh`);
  } else {
    logger.warn(`[${storeName}] Failed to load ${stateType} file for session '${sessionId}', starting fresh`, { error });

    SecurityMonitor.logSecurityEvent({
      type: 'OPERATION_FAILED',
      severity: 'MEDIUM',
      source: `${storeName}.initialize`,
      details: `Failed to load ${stateType} file for session '${sessionId}' — starting fresh (possible data corruption)`,
      additionalData: { error: String(error), sessionId },
    });
  }
}
