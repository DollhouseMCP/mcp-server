const MAX_INTEGRATION_CLEANUP_WAIT_MS = 1_000;

export type IntegrationCleanupResult = 'completed' | 'failed' | 'timed_out';
export type IntegrationCleanupSettlement = Exclude<IntegrationCleanupResult, 'timed_out'>;

export interface IntegrationCleanupAttempt {
  readonly result: Promise<IntegrationCleanupResult>;
  readonly settlement: Promise<IntegrationCleanupSettlement>;
}

export function beginIntegrationCleanup(
  cleanup: () => Promise<unknown>,
  requestTimeoutMs: number,
): IntegrationCleanupAttempt {
  const finiteTimeoutMs = Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 1;
  const waitMs = Math.max(1, Math.min(finiteTimeoutMs, MAX_INTEGRATION_CLEANUP_WAIT_MS));
  let cleanupPromise: Promise<unknown>;
  try {
    cleanupPromise = cleanup();
  } catch {
    cleanupPromise = Promise.reject(new Error('integration cleanup failed synchronously'));
  }
  const settlement = cleanupPromise.then<IntegrationCleanupSettlement, IntegrationCleanupSettlement>(
    () => 'completed',
    () => 'failed',
  );
  const result = new Promise<IntegrationCleanupResult>((resolve) => {
    const timer = setTimeout(() => resolve('timed_out'), waitMs);
    timer.unref?.();
    void settlement.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  return { result, settlement };
}

/**
 * Give resource cleanup a bounded opportunity to finish without allowing a
 * hung close implementation to suppress the request's primary result forever.
 * The rejection handler remains attached after timeout, so a late failure
 * cannot become an unhandled rejection.
 */
export async function settleIntegrationCleanup(
  cleanup: () => Promise<unknown>,
  requestTimeoutMs: number,
): Promise<IntegrationCleanupResult> {
  return beginIntegrationCleanup(cleanup, requestTimeoutMs).result;
}
