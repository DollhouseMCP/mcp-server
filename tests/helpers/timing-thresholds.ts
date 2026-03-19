/**
 * Environment-specific timing thresholds for performance-sensitive tests
 *
 * Philosophy:
 * - Local development: Strict thresholds catch performance regressions early
 * - CI environment: Lenient thresholds account for resource contention
 * - Monitoring: Log warnings when approaching upper bounds to detect drift
 *
 * Usage:
 * ```typescript
 * import { getTimingThreshold, assertTiming } from '../helpers/timing-thresholds';
 *
 * const threshold = getTimingThreshold('parallel-operations');
 * assertTiming(duration, threshold, 'parallel lock operations');
 * ```
 */

export interface TimingThreshold {
  /** Strict threshold for local development */
  local: number;
  /** Lenient threshold for CI environments */
  ci: number;
  /** Warning threshold (percentage of limit) - logs if exceeded */
  warnAt: number;
  /** Description for logging */
  description: string;
}

/**
 * Predefined timing thresholds for common test scenarios
 */
export const TIMING_THRESHOLDS: Record<string, TimingThreshold> = {
  /**
   * Parallel operations should complete in ~50ms (3x50ms operations in parallel)
   * Local: 100ms gives 2x buffer
   * CI: 600ms accounts for worker contention (Windows/macOS Node 20.x+ can exceed 500ms)
   */
  'parallel-operations': {
    local: 100,
    ci: 600,
    warnAt: 0.8,
    description: 'Parallel lock operations (3x50ms)',
  },

  /**
   * Container parallel checks with DI overhead (~100-200ms each, 2 in parallel)
   * These tests involve actual DI container resolution which has inherent overhead.
   * Local: 3500ms accounts for multi-worker execution + DI initialization
   *   - Single test run: typically ~500-700ms
   *   - Full suite (50% workers): 2000-3500ms due to resource contention
   * CI: 5000ms accounts for extreme worker saturation (observed 25x+ in CI)
   */
  'container-parallel-checks': {
    local: 3500,
    ci: 5000,
    warnAt: 0.6,
    description: 'Container startup parallel checks',
  },

  /**
   * Parallel start time difference - both operations should start together
   * Local: 50ms - they should start nearly simultaneously
   * CI: 1000ms - worker scheduling can delay starts
   */
  'parallel-start-diff': {
    local: 50,
    ci: 1000,
    warnAt: 0.8,
    description: 'Time difference between parallel operation starts',
  },

  /**
   * BuildInfo retrieval - runs actual git/docker commands
   * Local: 1000ms - typically fast with local git/docker
   * CI: 15000ms - Windows CI can be extremely slow with shell commands
   */
  'build-info-retrieval': {
    local: 1000,
    ci: 15000,
    warnAt: 0.5,
    description: 'BuildInfo retrieval with git/docker commands',
  },
};

/**
 * Detect if running in CI environment
 */
export function isCI(): boolean {
  return process.env.CI === 'true' ||
         process.env.GITHUB_ACTIONS === 'true' ||
         process.env.JENKINS_URL !== undefined ||
         process.env.TRAVIS === 'true' ||
         process.env.CIRCLECI === 'true';
}

/**
 * Get the appropriate threshold for the current environment
 */
export function getTimingThreshold(name: keyof typeof TIMING_THRESHOLDS): number {
  const threshold = TIMING_THRESHOLDS[name];
  if (!threshold) {
    throw new Error(`Unknown timing threshold: ${name}`);
  }
  return isCI() ? threshold.ci : threshold.local;
}

/**
 * Get full threshold config for advanced usage
 */
export function getTimingConfig(name: keyof typeof TIMING_THRESHOLDS): TimingThreshold {
  const threshold = TIMING_THRESHOLDS[name];
  if (!threshold) {
    throw new Error(`Unknown timing threshold: ${name}`);
  }
  return threshold;
}

/**
 * Assert timing with environment-aware thresholds and monitoring
 *
 * @param actual - Actual duration in ms
 * @param thresholdName - Name of predefined threshold
 * @param context - Additional context for logging
 * @returns The threshold used (for test assertions)
 */
export function assertTiming(
  actual: number,
  thresholdName: keyof typeof TIMING_THRESHOLDS,
  context?: string
): number {
  const config = getTimingConfig(thresholdName);
  const threshold = isCI() ? config.ci : config.local;
  const warnThreshold = threshold * config.warnAt;
  const env = isCI() ? 'CI' : 'local';

  // Log warning if approaching threshold
  if (actual > warnThreshold) {
    const percentage = ((actual / threshold) * 100).toFixed(1);
    console.warn(
      `⚠️  TIMING WARNING [${env}]: ${config.description}` +
      `${context ? ` (${context})` : ''}\n` +
      `   Actual: ${actual}ms | Threshold: ${threshold}ms (${percentage}% used)\n` +
      `   Consider investigating if this persists.`
    );
  }

  // Track timing metrics for monitoring (could be extended to send to telemetry)
  if (process.env.TIMING_METRICS === 'true') {
    console.log(
      `TIMING_METRIC: ${thresholdName} | ${actual}ms | threshold=${threshold}ms | env=${env}`
    );
  }

  return threshold;
}

/**
 * Create a custom timing threshold for one-off tests
 *
 * @param localMs - Threshold for local development (strict)
 * @param ciMultiplier - Multiplier for CI environment (default: 2x)
 * @param _warnAt - Warning threshold percentage (unused, for API compatibility)
 * @returns Object with local, ci, and environment-selected threshold
 *
 * Enable TIMING_DEBUG=true to see which environment/threshold is being used
 */
export function createTimingThreshold(
  localMs: number,
  ciMultiplier: number = 2,
  _warnAt: number = 0.8
): { local: number; ci: number; threshold: number } {
  const ci = localMs * ciMultiplier;
  const env = isCI() ? 'CI' : 'local';
  const threshold = isCI() ? ci : localMs;

  // Log threshold selection when debugging is enabled
  if (process.env.TIMING_DEBUG === 'true') {
    console.log(
      `🕐 TIMING_DEBUG: createTimingThreshold(${localMs}ms, ${ciMultiplier}x) → ` +
      `env=${env}, threshold=${threshold}ms (local=${localMs}ms, ci=${ci}ms)`
    );
  }

  return {
    local: localMs,
    ci,
    threshold,
  };
}
