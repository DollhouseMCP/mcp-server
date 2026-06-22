import { createHmac } from 'node:crypto';

import { normalizeIp } from '../../../auth/embedded-as/rateLimit.js';
import type { IRateLimitStore, RateLimitUpdate } from '../../../auth/embedded-as/storage/IRateLimitStore.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import {
  assertHash,
  assertUuid,
  ConsoleStoreValidationError,
} from '../../stores/ConsoleStoreValidation.js';

const WINDOW_MS = 60 * 60 * 1000;
const SESSION_LIMIT = 30;
const IP_LIMIT = 30;
const DEPLOYMENT_LIMIT = 200;
const SELECTOR_PREFIX = 'console-correlation-rate-limit-v1';

export interface ConsoleProtectedCorrelationRateLimitInput {
  readonly consoleSessionIdHash: Buffer;
  readonly ip: string | null | undefined;
  readonly accountCorrelationId: string;
}

export interface ConsoleProtectedCorrelationRateLimitResult {
  readonly allowed: boolean;
  /**
   * Minimum remaining attempts across all consumed budgets after this attempt.
   * The last allowed attempt and the first denied attempt both report 0.
   */
  readonly attemptsRemaining: number;
  readonly windowResetsAt: Date;
  readonly retryAfterSeconds: number | null;
  readonly exceededScopes: readonly ConsoleProtectedCorrelationRateLimitScope[];
}

export type ConsoleProtectedCorrelationRateLimitScope = 'session' | 'ip' | 'deployment';

export interface ConsoleProtectedCorrelationRateLimiterOptions {
  readonly store: IRateLimitStore;
  readonly selectorHmacKey: Buffer;
  readonly now?: () => Date;
}

interface WindowCounterState {
  readonly windowStartedAt: number;
  readonly attempts: number;
}

interface ConsumedBudget {
  readonly scope: ConsoleProtectedCorrelationRateLimitScope;
  readonly allowed: boolean;
  readonly attemptsRemaining: number;
  readonly windowResetsAt: Date;
  readonly retryAfterSeconds: number | null;
}

export class ConsoleProtectedCorrelationRateLimitDependencyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConsoleProtectedCorrelationRateLimitDependencyError';
  }
}

export class ConsoleProtectedCorrelationRateLimiter {
  constructor(private readonly options: ConsoleProtectedCorrelationRateLimiterOptions) {
    if (options.selectorHmacKey.length < 32) {
      throw new ConsoleStoreValidationError('selectorHmacKey must contain at least 32 bytes');
    }
  }

  async consume(input: ConsoleProtectedCorrelationRateLimitInput): Promise<ConsoleProtectedCorrelationRateLimitResult> {
    assertHash(input.consoleSessionIdHash, 'consoleSessionIdHash');
    assertUuid(input.accountCorrelationId, 'accountCorrelationId');

    const now = this.options.now?.() ?? new Date();
    const sessionSelector = this.selector('session', input.consoleSessionIdHash.toString('hex'));
    const ipSelector = this.selector('ip', normalizeIp(input.ip?.trim() || 'unknown'));
    const deploymentSelector = this.selector('deployment', 'global');

    let budgets: readonly ConsumedBudget[];
    try {
      budgets = await Promise.all([
        this.consumeBudget('session', sessionSelector, SESSION_LIMIT, now),
        this.consumeBudget('ip', ipSelector, IP_LIMIT, now),
        this.consumeBudget('deployment', deploymentSelector, DEPLOYMENT_LIMIT, now),
      ]);
    } catch (error) {
      throw new ConsoleProtectedCorrelationRateLimitDependencyError(
        'protected correlation rate-limit store unavailable',
        { cause: error },
      );
    }

    const exceededScopes = budgets.filter(budget => !budget.allowed).map(budget => budget.scope);
    if (exceededScopes.includes('deployment')) {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'HIGH',
        source: 'web-console',
        details: 'Protected account-correlation resolution deployment budget exhausted',
        ip: normalizeIp(input.ip?.trim() || 'unknown'),
        additionalData: {
          policy: 'protected_correlation_resolution',
          accountCorrelationSelector: this.selector('account_correlation_id', input.accountCorrelationId),
          exceededScopes,
        },
      });
    }

    return {
      allowed: exceededScopes.length === 0,
      attemptsRemaining: Math.min(...budgets.map(budget => budget.attemptsRemaining)),
      windowResetsAt: latestReset(budgets),
      retryAfterSeconds: retryAfterSeconds(budgets),
      exceededScopes,
    };
  }

  private async consumeBudget(
    scope: ConsoleProtectedCorrelationRateLimitScope,
    key: string,
    limit: number,
    at: Date,
  ): Promise<ConsumedBudget> {
    const nowMs = at.getTime();
    const update = await this.options.store.update<WindowCounterState, ConsumedBudget>(
      `console:admin:accounts:correlation-resolution:${scope}`,
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
  scope: ConsoleProtectedCorrelationRateLimitScope,
  prev: WindowCounterState | null,
  limit: number,
  nowMs: number,
): RateLimitUpdate<WindowCounterState, ConsumedBudget> {
  const state = prev && nowMs - prev.windowStartedAt < WINDOW_MS
    ? { windowStartedAt: prev.windowStartedAt, attempts: prev.attempts + 1 }
    : { windowStartedAt: nowMs, attempts: 1 };
  const resetMs = state.windowStartedAt + WINDOW_MS;
  const retryAfter = Math.max(0, Math.ceil((resetMs - nowMs) / 1000));
  const attemptsRemaining = Math.max(0, limit - state.attempts);
  return {
    state,
    result: {
      scope,
      allowed: state.attempts <= limit,
      attemptsRemaining,
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
