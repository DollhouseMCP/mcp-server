/**
 * Ownership policy service (Issue #3153)
 *
 * Glues the pure policy (`OwnershipPolicy.ts`) to the gh-backed resolver and
 * the per-session cache (`OwnershipLookup.ts`). This is the single entry point
 * the permission hooks call:
 *
 *   const decision = await service.evaluate(toolName, toolInput, { sessionId, cwd });
 *   // undefined → the call does not modify any PR/issue/branch, or the policy is off
 *
 * When one tool call carries several mutations (`gh pr merge 1 && git push`),
 * the strictest decision wins: deny > confirm > allow.
 *
 * @module
 */

import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import {
  decideOwnership,
  detectGitHubMutations,
  parseOwnershipPolicyConfig,
  type GitHubMutationIntent,
  type OwnershipDecision,
  type OwnershipLookupResult,
  type OwnershipPolicyConfig,
} from './OwnershipPolicy.js';
import { GhOwnershipResolver, OwnershipCache, type OwnershipResolver } from './OwnershipLookup.js';

export interface OwnershipEvaluationContext {
  /** Session the lookup cache is scoped to. */
  sessionId?: string;
  /** Working directory of the agent; lets `gh` infer the repo and current branch. */
  cwd?: string;
}

export interface OwnershipPolicyServiceOptions {
  config: OwnershipPolicyConfig;
  resolver: OwnershipResolver;
  cache: OwnershipCache;
  /** How long a resolved owner identity is trusted before re-checking (default 1 hour). */
  ownerLoginTtlMs?: number;
  now?: () => number;
}

const BEHAVIOR_RANK: Record<OwnershipDecision['behavior'], number> = { allow: 0, confirm: 1, deny: 2 };

/**
 * Build the service from `DOLLHOUSE_GITHUB_OWNERSHIP_POLICY`,
 * `DOLLHOUSE_GITHUB_OWNER_LOGIN` and `DOLLHOUSE_GITHUB_TEAMMATES`.
 * Config problems are logged, never thrown: a bad value falls back to the
 * fail-closed defaults rather than taking the server down.
 */
export function createOwnershipPolicyServiceFromEnv(
  source: Pick<typeof env, 'DOLLHOUSE_GITHUB_OWNERSHIP_POLICY' | 'DOLLHOUSE_GITHUB_OWNER_LOGIN' | 'DOLLHOUSE_GITHUB_TEAMMATES'> = env,
): OwnershipPolicyService {
  const { config, warnings } = parseOwnershipPolicyConfig({
    mode: source.DOLLHOUSE_GITHUB_OWNERSHIP_POLICY,
    ownerLogin: source.DOLLHOUSE_GITHUB_OWNER_LOGIN,
    teammates: source.DOLLHOUSE_GITHUB_TEAMMATES,
  });
  for (const warning of warnings) {
    logger.warn(`[OwnershipPolicy] ${warning}`);
  }
  logger.debug('[OwnershipPolicy] configured', {
    mode: config.mode,
    ownerConfigured: Boolean(config.ownerLogin),
    teammates: config.teammates.length,
  });
  return new OwnershipPolicyService({ config, resolver: new GhOwnershipResolver(), cache: new OwnershipCache() });
}
const DEFAULT_SESSION_KEY = 'default';

export class OwnershipPolicyService {
  private readonly config: OwnershipPolicyConfig;
  private readonly resolver: OwnershipResolver;
  private readonly cache: OwnershipCache;
  private readonly ownerLoginTtlMs: number;
  private readonly now: () => number;
  private resolvedOwner?: { login: string; expiresAt: number };
  private ownerLookupInFlight?: Promise<string | undefined>;

  constructor(options: OwnershipPolicyServiceOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.cache = options.cache;
    this.ownerLoginTtlMs = options.ownerLoginTtlMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  get mode(): OwnershipPolicyConfig['mode'] {
    return this.config.mode;
  }

  /**
   * Evaluate a tool call. Returns `undefined` when the policy has nothing to
   * say (off, or no GitHub mutation detected); otherwise the strictest decision.
   */
  async evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: OwnershipEvaluationContext = {},
  ): Promise<OwnershipDecision | undefined> {
    if (this.config.mode === 'off') return undefined;
    const intents = detectGitHubMutations(toolName, toolInput);
    if (intents.length === 0) return undefined;

    const effectiveConfig = await this.effectiveConfig(context);
    let strictest: OwnershipDecision | undefined;
    for (const intent of intents) {
      const decision = await this.evaluateIntent(intent, effectiveConfig, context);
      if (!strictest || BEHAVIOR_RANK[decision.behavior] > BEHAVIOR_RANK[strictest.behavior]) {
        strictest = decision;
      }
      if (strictest.behavior === 'deny') break;
    }
    if (strictest && strictest.behavior !== 'allow') {
      logger.info('[OwnershipPolicy] GitHub mutation gated', {
        toolName,
        behavior: strictest.behavior,
        reason: strictest.reason,
        sessionId: context.sessionId,
      });
    }
    return strictest;
  }

  /** Forget cached lookups for a session (call on session disposal). */
  clearSession(sessionId: string): void {
    this.cache.clearSession(sessionId);
  }

  private async evaluateIntent(
    intent: GitHubMutationIntent,
    config: OwnershipPolicyConfig,
    context: OwnershipEvaluationContext,
  ): Promise<OwnershipDecision> {
    if (intent.kind === 'unresolvable') {
      return decideOwnership(intent, { status: 'error', message: 'target cannot be identified' }, config);
    }
    const sessionKey = context.sessionId ?? DEFAULT_SESSION_KEY;
    let lookup = this.cache.get(sessionKey, intent);
    if (!lookup) {
      lookup = await this.safeLookup(intent, context);
      this.cache.set(sessionKey, intent, lookup);
    }
    return decideOwnership(intent, lookup, config);
  }

  private async safeLookup(intent: GitHubMutationIntent, context: OwnershipEvaluationContext): Promise<OwnershipLookupResult> {
    try {
      return await this.resolver.lookup(intent, { cwd: context.cwd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[OwnershipPolicy] Ownership lookup threw', { action: intent.action, message });
      return { status: 'error', message: message.slice(0, 200) };
    }
  }

  /** Config with the owner login filled in from `gh` when it was not configured. */
  private async effectiveConfig(context: OwnershipEvaluationContext): Promise<OwnershipPolicyConfig> {
    if (this.config.ownerLogin) return this.config;
    const login = await this.resolveOwnerLogin(context);
    return login ? { ...this.config, ownerLogin: login } : this.config;
  }

  private async resolveOwnerLogin(context: OwnershipEvaluationContext): Promise<string | undefined> {
    if (this.resolvedOwner && this.resolvedOwner.expiresAt > this.now()) {
      return this.resolvedOwner.login;
    }
    if (!this.ownerLookupInFlight) {
      this.ownerLookupInFlight = this.resolver.resolveOwnerLogin({ cwd: context.cwd })
        .catch((error: unknown) => {
          logger.warn('[OwnershipPolicy] Owner identity lookup threw', { message: error instanceof Error ? error.message : String(error) });
          return undefined;
        })
        .finally(() => {
          this.ownerLookupInFlight = undefined;
        });
    }
    const login = await this.ownerLookupInFlight;
    if (login) {
      this.resolvedOwner = { login, expiresAt: this.now() + this.ownerLoginTtlMs };
    }
    return login;
  }
}
