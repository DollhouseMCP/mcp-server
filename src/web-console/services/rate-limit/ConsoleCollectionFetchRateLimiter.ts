import { createHmac } from 'node:crypto';

import { normalizeIp } from '../../../auth/embedded-as/rateLimit.js';
import type { IRateLimitStore, RateLimitUpdate } from '../../../auth/embedded-as/storage/IRateLimitStore.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import {
  assertHash,
  ConsoleStoreValidationError,
} from '../../stores/ConsoleStoreValidation.js';

// One-minute windows: a session gets a browsing-speed budget, and the
// deployment budget caps the total server-funded upstream (GitHub) exposure
// per replica set. Index-served requests are cheap; the budget exists for the
// fetch-through paths.
const WINDOW_MS = 60 * 1000;
const SESSION_LIMIT = 30;
const DEPLOYMENT_LIMIT = 300;
const SELECTOR_PREFIX = 'console-collection-rate-limit-v1';

export interface ConsoleCollectionFetchRateLimitInput {
  readonly consoleSessionIdHash: Buffer;
  readonly ip: string | null | undefined;
}

export interface ConsoleCollectionFetchRateLimitResult {
  readonly allowed: boolean;
  readonly windowResetsAt: Date;
  readonly retryAfterSeconds: number | null;
  readonly exceededScopes: readonly ConsoleCollectionFetchRateLimitScope[];
}

export type ConsoleCollectionFetchRateLimitScope = 'session' | 'deployment';

export interface ConsoleCollectionFetchRateLimiterOptions {
  readonly store: IRateLimitStore;
  readonly selectorHmacKey: Buffer;
  readonly now?: () => Date;
}

interface WindowCounterState {
  readonly windowStartedAt: number;
  readonly attempts: number;
}

interface ConsumedBudget {
  readonly scope: ConsoleCollectionFetchRateLimitScope;
  readonly allowed: boolean;
  readonly windowResetsAt: Date;
  readonly retryAfterSeconds: number | null;
}

export class ConsoleCollectionFetchRateLimitDependencyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConsoleCollectionFetchRateLimitDependencyError';
  }
}

/**
 * Per-session and per-deployment budget for the collection catalog routes.
 * Backed by the shared `IRateLimitStore`, so multi-replica DB deployments
 * enforce one budget rather than one per process.
 */
export class ConsoleCollectionFetchRateLimiter {
  constructor(private readonly options: ConsoleCollectionFetchRateLimiterOptions) {
    if (options.selectorHmacKey.length < 32) {
      throw new ConsoleStoreValidationError('selectorHmacKey must contain at least 32 bytes');
    }
  }

  async consume(input: ConsoleCollectionFetchRateLimitInput): Promise<ConsoleCollectionFetchRateLimitResult> {
    assertHash(input.consoleSessionIdHash, 'consoleSessionIdHash');

    const now = this.options.now?.() ?? new Date();
    const sessionSelector = this.selector('session', input.consoleSessionIdHash.toString('hex'));
    const deploymentSelector = this.selector('deployment', 'global');

    // Consume the session budget FIRST and only charge the shared deployment
    // budget when the session is allowed. A session-rejected request never
    // reaches the upstream GitHub fetch, so it must not spend the deployment
    // budget — otherwise one abusive session could exhaust the shared budget
    // and deny every other session (the invariant this policy exists to hold).
    let budgets: readonly ConsumedBudget[];
    try {
      const session = await this.consumeBudget('session', sessionSelector, SESSION_LIMIT, now);
      budgets = session.allowed
        ? [session, await this.consumeBudget('deployment', deploymentSelector, DEPLOYMENT_LIMIT, now)]
        : [session];
    } catch (error) {
      throw new ConsoleCollectionFetchRateLimitDependencyError(
        'collection fetch rate-limit store unavailable',
        { cause: error },
      );
    }

    const exceededScopes = budgets.filter(budget => !budget.allowed).map(budget => budget.scope);
    if (exceededScopes.includes('deployment')) {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        source: 'web-console',
        details: 'Collection catalog deployment fetch budget exhausted',
        ip: normalizeIp(input.ip?.trim() || 'unknown'),
        additionalData: {
          policy: 'collection_fetch',
          exceededScopes,
        },
      });
    }

    return {
      allowed: exceededScopes.length === 0,
      windowResetsAt: latestReset(budgets),
      retryAfterSeconds: retryAfterSeconds(budgets),
      exceededScopes,
    };
  }

  private async consumeBudget(
    scope: ConsoleCollectionFetchRateLimitScope,
    key: string,
    limit: number,
    at: Date,
  ): Promise<ConsumedBudget> {
    const nowMs = at.getTime();
    const update = await this.options.store.update<WindowCounterState, ConsumedBudget>(
      `console:collection:fetch:${scope}`,
      key,
      prev => stepCounter(scope, prev, limit, nowMs),
      { expiresAt: nowMs + WINDOW_MS * 2 },
    );
    if (!update.result) {
      throw new Error(`rate-limit store did not return a ${scope} result`);
    }
    return update.result;
  }

  private selector(scope: string, value: string): string {
    return createHmac('sha256', this.options.selectorHmacKey)
      .update(SELECTOR_PREFIX)
      .update('\0')
      .update(scope)
      .update('\0')
      .update(value)
      .digest('base64url');
  }
}

function stepCounter(
  scope: ConsoleCollectionFetchRateLimitScope,
  prev: WindowCounterState | null,
  limit: number,
  nowMs: number,
): RateLimitUpdate<WindowCounterState, ConsumedBudget> {
  const state = prev && nowMs - prev.windowStartedAt < WINDOW_MS
    ? { windowStartedAt: prev.windowStartedAt, attempts: prev.attempts + 1 }
    : { windowStartedAt: nowMs, attempts: 1 };
  const resetMs = state.windowStartedAt + WINDOW_MS;
  const retryAfter = Math.max(0, Math.ceil((resetMs - nowMs) / 1000));
  return {
    state,
    result: {
      scope,
      allowed: state.attempts <= limit,
      windowResetsAt: new Date(resetMs),
      retryAfterSeconds: state.attempts > limit ? retryAfter : null,
    },
  };
}

function latestReset(budgets: readonly ConsumedBudget[]): Date {
  return new Date(Math.max(...budgets.map(budget => budget.windowResetsAt.getTime())));
}

function retryAfterSeconds(budgets: readonly ConsumedBudget[]): number | null {
  const exceeded = budgets
    .map(budget => budget.retryAfterSeconds)
    .filter((value): value is number => value !== null);
  return exceeded.length ? Math.max(...exceeded) : null;
}
