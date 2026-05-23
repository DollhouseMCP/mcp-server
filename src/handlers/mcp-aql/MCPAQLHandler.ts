/**
 * MCPAQLHandler - Unified handler for all MCP-AQL operations
 *
 * ARCHITECTURE:
 * - Thin resolver pattern: validates → routes → dispatches
 * - SOLID principles: depends on abstractions (HandlerRegistry interface)
 * - Defense in depth: Gatekeeper validates endpoint/operation matching and enforces policies
 * - Dispatch pattern: routes handler references to actual method calls
 *
 * OPERATION FLOW:
 * 1. Validate input structure (type guards)
 * 2. Validate permissions (Gatekeeper)
 * 3. Route operation (OperationRouter)
 * 4. Dispatch to handler (resolveHandlerReference)
 * 5. Return standardized result (OperationResult)
 *
 * ERROR HANDLING:
 * All errors are caught and returned as OperationFailure with:
 * - success: false
 * - error: human-readable message
 * - data: never (discriminated union enforces this)
 */

import { CRUDEndpoint } from './OperationRouter.js';
import { Gatekeeper } from './Gatekeeper.js';
import { type ActiveElement, canOperationBeElevated } from './policies/index.js';
import { isGatekeeperInfraOperation, getGatekeeperDiagnostics } from './policies/ElementPolicies.js';
import { PermissionLevel, GatekeeperErrorCode, type GatekeeperDecision } from './GatekeeperTypes.js';
import { getRoute } from './OperationRouter.js';
import { IntrospectionResolver } from './IntrospectionResolver.js';
import { SchemaDispatcher } from './SchemaDispatcher.js';
import { SearchHandler } from './SearchHandler.js';
import { ElementCRUDDispatcher } from './ElementCRUDDispatcher.js';
import { ConfigDispatcher } from './ConfigDispatcher.js';
import { AgentExecutionHandler } from './AgentExecutionHandler.js';
import { GatekeeperHandler } from './GatekeeperHandler.js';
import { MemorySaveHandler } from './MemorySaveHandler.js';
import { buildOperationSummary } from './OperationSummary.js';
import { applyFieldSelection } from './FieldSelection.js';
import { initializeNormalizers } from './normalizers/index.js';
import {
  OperationInput,
  OperationResult,
  OperationSuccess,
  OperationFailure,
  ResponseMeta,
  parseOperationInput,
  describeInvalidInput,
  BatchRequest,
  BatchResult,
  BatchOperationResult,
  isBatchRequest,
} from './types.js';
import { type ExecutingAgentEntry, validateRequiredString } from './shared.js';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { RateLimiterFactory, type RateLimiter, type RateLimitStatus } from '../../utils/RateLimiter.js';
import { env } from '../../config/env.js';
import type { DangerZoneEnforcer } from '../../security/DangerZoneEnforcer.js';
import type { IChallengeStore } from '../../state/IChallengeStore.js';
import type { IVerificationNotifier } from '../../services/VerificationNotifier.js';
import { generateDisplayCode } from '@dollhousemcp/safety';
import { randomUUID } from 'node:crypto';
import type { ElementCRUDHandler } from '../ElementCRUDHandler.js';
import type { MemoryManager } from '../../elements/memories/MemoryManager.js';
import type { AgentManager } from '../../elements/agents/AgentManager.js';
import type { CircuitBreakerState } from '../../elements/agents/resilienceEvaluator.js';
import type { ResilienceMetricsTracker } from '../../elements/agents/resilienceMetrics.js';
import type { TemplateRenderer } from '../../utils/TemplateRenderer.js';
import type { ElementQueryService } from '../../services/query/ElementQueryService.js';
import type { CollectionHandler } from '../CollectionHandler.js';
import type { PortfolioHandler } from '../PortfolioHandler.js';
import type { GitHubAuthHandler } from '../GitHubAuthHandler.js';
import type { ConfigHandler } from '../ConfigHandler.js';
import type { EnhancedIndexHandler } from '../EnhancedIndexHandler.js';
import type { PersonaHandler } from '../PersonaHandler.js';
import type { SyncHandler } from '../SyncHandlerV2.js';
import type { BuildInfoService } from '../../services/BuildInfoService.js';
import type { MemoryLogSink } from '../../logging/sinks/MemoryLogSink.js';
import type { LogQueryOptions } from '../../logging/types.js';
import type { MetricQueryOptions, MetricType } from '../../metrics/types.js';
import type { PerformanceMonitor } from '../../utils/PerformanceMonitor.js';
import type { OperationMetricsTracker } from '../../metrics/OperationMetricsTracker.js';
import type { GatekeeperMetricsTracker } from '../../metrics/GatekeeperMetricsTracker.js';
import { ElementType, type PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { getAutonomyMetrics } from '../../elements/agents/autonomyEvaluator.js';
import type { AutonomyMetricsSnapshot } from '../../elements/agents/autonomyEvaluator.js';

/**
 * Valid log categories accepted by LogQueryOptions.
 * Matches the LogCategory union type plus the 'all' wildcard.
 */
const VALID_LOG_CATEGORIES = new Set(['application', 'security', 'performance', 'telemetry', 'all']);

/**
 * Valid log levels accepted by LogQueryOptions.
 * Matches the LogLevel union type.
 */
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Validate and sanitize raw params into a safe LogQueryOptions object.
 * Strips unknown keys, validates types of known fields, and returns
 * only well-typed values. Invalid fields are silently dropped since
 * all LogQueryOptions fields are optional.
 *
 * @param params - Raw params from the MCP request
 * @returns Validated LogQueryOptions with only valid fields
 */
function validateLogQueryParams(params: Record<string, unknown>): LogQueryOptions {
  const options: LogQueryOptions = {};

  if (typeof params.category === 'string' && VALID_LOG_CATEGORIES.has(params.category)) {
    options.category = params.category as LogQueryOptions['category'];
  }
  if (typeof params.level === 'string' && VALID_LOG_LEVELS.has(params.level)) {
    options.level = params.level as LogQueryOptions['level'];
  }
  if (typeof params.source === 'string') {
    options.source = params.source;
  }
  if (typeof params.message === 'string') {
    options.message = params.message;
  }
  if (typeof params.since === 'string') {
    options.since = params.since;
  }
  if (typeof params.until === 'string') {
    options.until = params.until;
  }
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    options.limit = params.limit;
  }
  if (typeof params.offset === 'number' && Number.isFinite(params.offset)) {
    options.offset = params.offset;
  }
  if (typeof params.correlationId === 'string') {
    options.correlationId = params.correlationId;
  }
  // userId filter is not session-scoped — within a single session, all log
  // entries share the same userId. The sessionId guard in dispatchLogging()
  // restricts results to the caller's session, which implicitly scopes userId.
  if (typeof params.userId === 'string') {
    options.userId = params.userId;
  }
  // sessionId is validated but may be overridden by dispatchLogging()'s
  // session enforcement — callers cannot query other sessions' logs.
  if (typeof params.sessionId === 'string') {
    options.sessionId = params.sessionId;
  }

  return options;
}

const VALID_METRIC_TYPES = new Set<MetricType>(['counter', 'gauge', 'histogram']);

function validateMetricQueryParams(params: Record<string, unknown>): MetricQueryOptions {
  const options: MetricQueryOptions = {};

  if (Array.isArray(params.names)) {
    options.names = params.names.filter((n): n is string => typeof n === 'string');
  }
  if (typeof params.source === 'string') {
    options.source = params.source;
  }
  if (typeof params.type === 'string' && VALID_METRIC_TYPES.has(params.type as MetricType)) {
    options.type = params.type as MetricType;
  }
  if (typeof params.since === 'string') {
    options.since = params.since;
  }
  if (typeof params.until === 'string') {
    options.until = params.until;
  }
  if (typeof params.latest === 'boolean') {
    options.latest = params.latest;
  }
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    options.limit = params.limit;
  }
  if (typeof params.offset === 'number' && Number.isFinite(params.offset)) {
    options.offset = params.offset;
  }

  return options;
}

// ============================================================================
// Verification Security Utilities (Issue #142 — PR #478 review follow-ups)
// ============================================================================

/** UUID v4 format: 8-4-4-4-12 hex digits with version 4 marker and variant bits */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a challenge ID is a valid UUID v4 format.
 * Challenge IDs are generated by crypto.randomUUID() and must conform.
 * Rejects obviously invalid IDs before hitting the store to prevent enumeration.
 */
function validateChallengeIdFormat(challengeId: string): void {
  if (!UUID_V4_REGEX.test(challengeId)) {
    throw new VerificationError(
      GatekeeperErrorCode.VERIFICATION_FAILED,
      `Invalid challenge_id format. Expected UUID v4 (e.g., "550e8400-e29b-41d4-a716-446655440000").`
    );
  }
}

/**
 * Structured verification error with Gatekeeper error code.
 * Enables consistent error handling aligned with existing Gatekeeper patterns.
 */
class VerificationError extends Error {
  constructor(
    public readonly errorCode: GatekeeperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VerificationError';
  }
}

const DEADLOCK_RELIEF_REASON = 'Deadlock relief requested';
const DEADLOCK_RELIEF_TIMEOUT_MS = 5 * 60 * 1000;
const DEADLOCK_RELIEF_DIALOG_REASON =
  'Deadlock relief requested.\n\nThis will deactivate all active elements for the current session and clear persisted activation state.';

/**
 * Global rate limiter for verification attempts.
 * Tracks failed attempts within a sliding window to prevent brute-force attacks.
 *
 * Design: Since verification codes are one-time-use (deleted on any attempt),
 * the real attack vector is repeated challenge creation + immediate attempt.
 * This limiter caps total failures across all challenges within a time window.
 */
class VerificationRateLimiter {
  private failures: number[] = [];

  constructor(
    private readonly maxFailures: number = 10,
    private readonly windowMs: number = 60_000,
  ) {}

  /** Record a failed verification attempt. Returns true if rate limit is exceeded. */
  recordFailure(): boolean {
    const now = Date.now();
    this.failures.push(now);
    this.prune(now);
    return this.failures.length > this.maxFailures;
  }

  /** Check if rate limit is currently exceeded without recording. */
  isLimited(): boolean {
    this.prune(Date.now());
    return this.failures.length > this.maxFailures;
  }

  /** Remove entries outside the sliding window. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.failures.length > 0 && this.failures[0] < cutoff) {
      this.failures.shift();
    }
  }

  /** Current failure count in window (for metrics). */
  get failuresInWindow(): number {
    this.prune(Date.now());
    return this.failures.length;
  }

  /** Reset (for testing). */
  reset(): void {
    this.failures = [];
  }
}

/**
 * Verification metrics tracker following DangerZoneEnforcer.getMetrics() pattern.
 * Tracks success/failure/expiry rates and time-to-verify.
 */
export interface VerificationMetrics {
  /** Total verify_challenge calls since startup */
  totalAttempts: number;
  /** Successful verifications */
  totalSuccesses: number;
  /** Failed verifications (wrong code) */
  totalFailures: number;
  /** Expired challenge attempts */
  totalExpired: number;
  /** Invalid format attempts (rejected before store lookup) */
  totalInvalidFormat: number;
  /** Rate-limited attempts */
  totalRateLimited: number;
  /** Average time from challenge creation to successful verify (ms) */
  averageTimeToVerifyMs: number;
  /** Current failures in rate-limit window */
  failuresInCurrentWindow: number;
}

class VerificationMetricsTracker {
  private _totalAttempts = 0;
  private _totalSuccesses = 0;
  private _totalFailures = 0;
  private _totalExpired = 0;
  private _totalInvalidFormat = 0;
  private _totalRateLimited = 0;
  private verifyDurations: number[] = [];
  private static readonly MAX_DURATIONS = 1000;

  recordAttempt(): void { this._totalAttempts++; }
  recordSuccess(durationMs?: number): void {
    this._totalSuccesses++;
    if (durationMs !== undefined && durationMs >= 0) {
      this.verifyDurations.push(durationMs);
      if (this.verifyDurations.length > VerificationMetricsTracker.MAX_DURATIONS) {
        this.verifyDurations.shift();
      }
    }
  }
  recordFailure(): void { this._totalFailures++; }
  recordExpired(): void { this._totalExpired++; }
  recordInvalidFormat(): void { this._totalInvalidFormat++; }
  recordRateLimited(): void { this._totalRateLimited++; }

  getMetrics(rateLimiter: VerificationRateLimiter): VerificationMetrics {
    const avgDuration = this.verifyDurations.length > 0
      ? Math.round(this.verifyDurations.reduce((a, b) => a + b, 0) / this.verifyDurations.length)
      : 0;
    return {
      totalAttempts: this._totalAttempts,
      totalSuccesses: this._totalSuccesses,
      totalFailures: this._totalFailures,
      totalExpired: this._totalExpired,
      totalInvalidFormat: this._totalInvalidFormat,
      totalRateLimited: this._totalRateLimited,
      averageTimeToVerifyMs: avgDuration,
      failuresInCurrentWindow: rateLimiter.failuresInWindow,
    };
  }

  /** Reset (for testing). */
  reset(): void {
    this._totalAttempts = 0;
    this._totalSuccesses = 0;
    this._totalFailures = 0;
    this._totalExpired = 0;
    this._totalInvalidFormat = 0;
    this._totalRateLimited = 0;
    this.verifyDurations = [];
  }
}

/**
 * Handler registry interface for dependency injection.
 * Abstracts the concrete handler types for better testability and decoupling.
 */
export interface HandlerRegistry {
  elementCRUD: ElementCRUDHandler;
  memoryManager: MemoryManager;
  agentManager: AgentManager;
  templateRenderer: TemplateRenderer;
  elementQueryService: ElementQueryService;
  portfolioManager: PortfolioManager;
  // MCP-AQL extension handlers (Issue #241)
  collectionHandler?: CollectionHandler;
  portfolioHandler?: PortfolioHandler;
  authHandler?: GitHubAuthHandler;
  configHandler?: ConfigHandler;
  enhancedIndexHandler?: EnhancedIndexHandler;
  personaHandler?: PersonaHandler;
  syncHandler?: SyncHandler;
  buildInfoService?: BuildInfoService;
  cacheMemoryBudget?: import('../../cache/CacheMemoryBudget.js').CacheMemoryBudget;
  gatekeeper: Gatekeeper;
  // Issue #402: DI-injected danger zone enforcer (replaces singleton import)
  dangerZoneEnforcer?: DangerZoneEnforcer;
  // Issue #142: Server-side verification store for challenge codes
  // Issue #1945: Changed from VerificationStore to IChallengeStore for backend swappability
  verificationStore?: IChallengeStore;
  // Issue #522: Non-blocking OS dialog for verification codes (replaces returning code to LLM)
  verificationNotifier?: IVerificationNotifier;
  // Issue #528: MemoryLogSink for CRUDE-routed query_logs
  memorySink?: MemoryLogSink;
  // Metrics: MemoryMetricsSink for CRUDE-routed query_metrics
  metricsSink?: import('../../metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink;
  // Search metrics: PerformanceMonitor for recordSearch()
  performanceMonitor?: PerformanceMonitor;
  // Operation metrics: OperationMetricsTracker for CRUD operation stats
  operationMetricsTracker?: OperationMetricsTracker;
  // Gatekeeper metrics: GatekeeperMetricsTracker for policy enforcement stats
  gatekeeperMetricsTracker?: GatekeeperMetricsTracker;
  // Resilience: DI-managed instances (moved from module-level singletons)
  circuitBreaker?: CircuitBreakerState;
  resilienceMetrics?: ResilienceMetricsTracker;
  // Identity: session activation registry for HTTP identity checks
  activationRegistry?: import('../../state/SessionActivationState.js').SessionActivationRegistry;
  // Flag: database storage backend is active
  isDbMode?: boolean;
}

/**
 * MCPAQLHandler - Unified entry point for all MCP-AQL operations
 *
 * This handler implements the thin resolver pattern:
 * 1. Validates that operations are called via correct CRUD endpoints
 * 2. Routes operations to their handler references
 * 3. Dispatches to actual handler methods
 * 4. Returns standardized OperationResult
 *
 * DESIGN RATIONALE:
 * - Single Responsibility: Only orchestrates, delegates actual work
 * - Dependency Inversion: Depends on HandlerRegistry interface
 * - Interface Segregation: HandlerRegistry exposes only what's needed
 * - Open/Closed: New operations added to router, not this class
 */
/**
 * Minimal interface for correlation ID retrieval.
 * Keeps coupling loose — only requires what MCPAQLHandler actually needs.
 * Issue #301: Request correlation support.
 */
export interface CorrelationIdProvider {
  getCorrelationId(): string | undefined;
  getSessionContext?(): { sessionId: string } | undefined;
}

export class MCPAQLHandler {
  private readonly gatekeeper: Gatekeeper;
  private readonly searchHandler: SearchHandler;
  private readonly elementCRUDDispatcher: ElementCRUDDispatcher;
  private readonly configDispatcher: ConfigDispatcher;
  private readonly agentExecutionHandler: AgentExecutionHandler;
  private readonly gatekeeperHandler: GatekeeperHandler;
  private readonly memorySaveHandler: MemorySaveHandler;
  /** Issue #1947: Per-session rate limiters (prevents cross-session rate limit exhaustion) */
  private readonly permissionPromptLimiters = new Map<string, RateLimiter>();
  private readonly cliApprovalLimiters = new Map<string, RateLimiter>();
  /**
   * Build a standardized rate-limit deny response for permission_prompt.
   */
  private buildRateLimitDeny(
    limiterName: string,
    toolName: string,
    status: RateLimitStatus,
    riskLevel = 'blocked',
    reason = 'Rate limit exceeded',
  ): Record<string, unknown> {
    SecurityMonitor.logSecurityEvent({
      type: 'RATE_LIMIT_EXCEEDED',
      severity: 'HIGH',
      source: 'MCPAQLHandler.dispatchGatekeeper.permissionPrompt',
      details: `${limiterName} rate limit exceeded for ${toolName}`,
      additionalData: {
        toolName,
        limiter: limiterName,
        retryAfterMs: status.retryAfterMs,
        remainingTokens: status.remainingTokens,
        resetTime: status.resetTime.toISOString(),
      },
    });
    return {
      behavior: 'deny',
      message: `Rate limit exceeded for ${limiterName}. Retry after ${status.retryAfterMs}ms.`,
      classification: { riskLevel, reason, stage: 'rate_limit' },
    };
  }

  /** Issue #1947: Per-session verification rate limiters */
  private readonly verificationRateLimiters = new Map<string, VerificationRateLimiter>();
  /** Issue #142: Metrics tracker for verification operations */
  private readonly verificationMetrics = new VerificationMetricsTracker();
  /**
   * Tracks agents currently in an execution loop for Gatekeeper policy enforcement.
   *
   * **Lifecycle:** Entries are added in `dispatchExecute()` on `execute_agent` and
   * removed on `complete_execution`. Only agents with a gatekeeper policy (explicit
   * or synthesized from `tools` config) are tracked.
   *
   * **Policy resolution:** Entries are included in `getActiveElements()` so the
   * Gatekeeper evaluates agent policies alongside persona/skill/ensemble policies.
   * The standard priority applies: deny > scope_restriction > confirm > allow.
   *
   * **Memory safety:** The Map is bounded by concurrently executing agents. If a
   * session ends without `complete_execution`, the Map is garbage collected with
   * the MCPAQLHandler instance.
   *
   * Issue #449
   */
  private readonly executingAgents = new Map<string, ExecutingAgentEntry>();

  /**
   * Set of aborted goalIds. Once a goalId is aborted, all further execution
   * operations (record_execution_step, complete_execution, continue_execution)
   * for that goalId are rejected at the dispatch layer.
   *
   * Issue #249: Abort/cancellation infrastructure.
   */
  private readonly abortedGoals = new Set<string>();

  constructor(
    private readonly handlers: HandlerRegistry,
    private readonly contextTracker?: CorrelationIdProvider,
  ) {
    // Initialize normalizers for schema-driven operations (Issue #243)
    initializeNormalizers();
    // Issue #452: Store Gatekeeper instance for policy enforcement
    if (!handlers.gatekeeper) {
      throw new Error('Gatekeeper instance is required in HandlerRegistry. Provide one via the DI container.');
    }
    this.gatekeeper = handlers.gatekeeper;
    this.searchHandler = new SearchHandler(handlers);
    this.elementCRUDDispatcher = new ElementCRUDDispatcher(handlers);
    this.configDispatcher = new ConfigDispatcher(handlers);
    this.memorySaveHandler = new MemorySaveHandler(handlers, (name) => this.sessionKey(name));
    this.agentExecutionHandler = new AgentExecutionHandler(
      handlers,
      this.executingAgents,
      this.abortedGoals,
      (name) => this.sessionKey(name),
      contextTracker,
    );
    this.gatekeeperHandler = new GatekeeperHandler({
      handlers,
      gatekeeper: this.gatekeeper,
      contextTracker,
      executingAgents: this.executingAgents,
      verificationMetrics: this.verificationMetrics,
      getActiveElements: (sessionId?: string) => this.getActiveElements(sessionId),
      getPolicyReportElements: (sessionId?: string) => this.getPolicyReportElements(sessionId),
      getEndpointForOperation: (operation: string) => this.getEndpointForOperation(operation),
      issueDeadlockReliefChallenge: () => this.issueDeadlockReliefChallenge(),
      completeDeadlockRelief: (challengeId: string, code: string) => this.completeDeadlockRelief(challengeId, code),
      resolveVerificationRateLimiter: () => this.resolveVerificationRateLimiter(),
      resolvePermissionPromptLimiter: () => this.resolvePermissionPromptLimiter(),
      resolveCliApprovalLimiter: () => this.resolveCliApprovalLimiter(),
      buildRateLimitDeny: (limiterName, toolName, status, riskLevel, reason) =>
        this.buildRateLimitDeny(limiterName, toolName, status, riskLevel, reason),
    });
  }

  /**
   * Produce a session-scoped key for mutable collections.
   * Prevents cross-session state corruption under concurrent HTTP sessions.
   * Falls back to 'default' when no session is active (stdio, tests).
   */
  private sessionKey(name: string): string {
    const sessionId = this.contextTracker?.getSessionContext?.()?.sessionId ?? 'default';
    return `${sessionId}:${name}`;
  }

  /**
   * Resolve a per-session instance from a Map, creating on first access.
   * Issue #1947: All per-session rate limiters use this pattern.
   */
  private resolveSessionScoped<T>(map: Map<string, T>, factory: () => T): T {
    const key = this.contextTracker?.getSessionContext?.()?.sessionId ?? 'default';
    let instance = map.get(key);
    if (!instance) {
      instance = factory();
      map.set(key, instance);
    }
    return instance;
  }

  private resolveVerificationRateLimiter(): VerificationRateLimiter {
    return this.resolveSessionScoped(this.verificationRateLimiters, () => new VerificationRateLimiter());
  }

  private resolvePermissionPromptLimiter(): RateLimiter {
    return this.resolveSessionScoped(this.permissionPromptLimiters, () =>
      RateLimiterFactory.createPermissionPromptLimiter(
        env.DOLLHOUSE_PERMISSION_PROMPT_RATE_LIMIT, env.DOLLHOUSE_PERMISSION_RATE_WINDOW_MS
      ));
  }

  private resolveCliApprovalLimiter(): RateLimiter {
    return this.resolveSessionScoped(this.cliApprovalLimiters, () =>
      RateLimiterFactory.createCliApprovalLimiter(
        env.DOLLHOUSE_CLI_APPROVAL_RATE_LIMIT, env.DOLLHOUSE_PERMISSION_RATE_WINDOW_MS
      ));
  }

  /** Delete all entries from a Map or Set whose keys start with the given prefix. */
  private deleteByPrefix(collection: Map<string, unknown> | Set<string>, prefix: string): void {
    const keys = collection instanceof Set ? collection : collection.keys();
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        collection.delete(key);
      }
    }
  }

  /**
   * Remove all session-keyed state for a disconnected HTTP session.
   *
   * The shared MCPAQLHandler uses Maps keyed by `{sessionId}:{name}` to
   * track per-session state (executing agents, pending saves, etc.).
   * Without cleanup, these entries accumulate as sessions connect and
   * disconnect, causing a slow memory leak in long-running HTTP servers.
   *
   * Called by DollhouseContainer.createServerForHttpSession()'s dispose callback.
   */
  cleanupSession(sessionId: string): void {
    const prefix = `${sessionId}:`;

    this.memorySaveHandler.cleanupSession(sessionId);

    // Remove session-keyed entries from tracking collections
    this.deleteByPrefix(this.executingAgents, prefix);
    this.deleteByPrefix(this.abortedGoals, prefix);

    // Issue #1947: Remove per-session rate limiters
    this.verificationRateLimiters.delete(sessionId);
    this.permissionPromptLimiters.delete(sessionId);
    this.cliApprovalLimiters.delete(sessionId);
  }

  /**
   * Get verification metrics for monitoring/diagnostics.
   * Follows the same pattern as DangerZoneEnforcer.getMetrics().
   */
  getVerificationMetrics(): VerificationMetrics {
    return this.verificationMetrics.getMetrics(this.resolveVerificationRateLimiter());
  }

  /**
   * Get autonomy evaluation metrics for monitoring/diagnostics.
   * Issue #391: Follows the same pattern as getVerificationMetrics().
   */
  getAutonomyMetrics(): AutonomyMetricsSnapshot {
    return getAutonomyMetrics();
  }

  /**
   * Gather currently active elements for Gatekeeper policy evaluation.
   *
   * Queries PersonaManager, SkillManager, and EnsembleManager for active elements,
   * then appends any currently executing agents with gatekeeper policies. All
   * elements are mapped to the {@link ActiveElement} interface expected by
   * `Gatekeeper.enforce()`.
   *
   * Issue #452: Provides element context for Layer 2 (element policy resolution).
   * Issue #449: Includes executing agents alongside personas/skills/ensembles.
   *
   * @returns Array of active elements with their gatekeeper policies, or empty
   *          array if gathering fails (fail-open: only route policies apply).
   */
  private async getActiveElements(sessionId?: string): Promise<ActiveElement[]> {
    try {
      const rawElements = sessionId
        ? await this.handlers.elementCRUD.getPolicyElementsForReport(sessionId)
        : await this.handlers.elementCRUD.getActiveElementsForPolicy();
      const activeElements: ActiveElement[] = rawElements.map((el) => ({
        type: el.type,
        name: el.name,
        metadata: {
          name: el.name,
          description: (el.metadata.description as string) ?? undefined,
          gatekeeper: el.metadata?.gatekeeper as ActiveElement['metadata']['gatekeeper'] ?? undefined,
          ...this.copyGatekeeperDiagnostics(el.metadata),
        },
      }));

      // Issue #449: Include executing agents with gatekeeper policies
      if (!sessionId) {
        for (const [, agentEntry] of this.executingAgents) {
          activeElements.push({
            type: 'agent',
            name: agentEntry.name,
            metadata: {
              name: agentEntry.name,
              gatekeeper: agentEntry.metadata.gatekeeper as ActiveElement['metadata']['gatekeeper'],
            },
          });
        }
      }

      return activeElements;
    } catch (error) {
      // Fail open — if we can't gather active elements, enforce without them
      // This means only route validation and default policies will apply
      logger.warn('Failed to gather active elements for Gatekeeper policy evaluation', { error, sessionId });
      return [];
    }
  }

  private async getPolicyReportElements(sessionId?: string): Promise<ActiveElement[]> {
    try {
      const rawElements = await this.handlers.elementCRUD.getPolicyElementsForReport(sessionId);
      return rawElements.map((el) => ({
        type: el.type,
        name: el.name,
        metadata: {
          name: el.name,
          description: (el.metadata.description as string) ?? undefined,
          gatekeeper: el.metadata?.gatekeeper as ActiveElement['metadata']['gatekeeper'] ?? undefined,
          ...this.copyGatekeeperDiagnostics(el.metadata),
          ...(Array.isArray((el as { sessionIds?: string[] }).sessionIds)
            ? { sessionIds: (el as { sessionIds?: string[] }).sessionIds }
            : {}),
        },
      }));
    } catch (error) {
      logger.warn('Failed to gather policy elements for dashboard reporting', { error, sessionId });
      return sessionId ? [] : this.getActiveElements();
    }
  }

  private copyGatekeeperDiagnostics(metadata: unknown): Record<string, unknown> {
    const diagnostics = getGatekeeperDiagnostics(metadata);
    return diagnostics ? { gatekeeperDiagnostics: diagnostics } : {};
  }

  /**
   * Handle CREATE operations (additive, non-destructive)
   *
   * CREATE endpoint operations:
   * - create_element: Create new elements
   * - import_element: Import elements from exported data
   * - addEntry: Add entries to memory elements
   *
   * Supports batch operations when input contains `operations` array.
   *
   * @param input - Operation input with operation name and params, or BatchRequest
   * @returns OperationResult with success/failure status, or BatchResult for batch operations
   */
  async handleCreate(input: unknown): Promise<OperationResult | BatchResult> {
    if (isBatchRequest(input)) {
      return this.executeBatch(input, 'CREATE');
    }
    return this.executeOperation(input, 'CREATE');
  }

  /**
   * Handle READ operations (read-only, safe)
   *
   * READ endpoint operations:
   * - list_elements: List elements with filtering
   * - get_element: Get element by name
   * - get_element_details: Get detailed element information
   * - search_elements: Full-text search
   * - query_elements: Query with pagination
   * - get_active_elements: Get active elements
   * - validate_element: Validate element
   * - render: Render template
   * - export_element: Export element
   * - activate_element: Activate elements for use
   * - deactivate_element: Deactivate element
   *
   * Supports batch operations when input contains `operations` array.
   *
   * @param input - Operation input with operation name and params, or BatchRequest
   * @returns OperationResult with success/failure status, or BatchResult for batch operations
   */
  async handleRead(input: unknown): Promise<OperationResult | BatchResult> {
    if (isBatchRequest(input)) {
      return this.executeBatch(input, 'READ');
    }
    return this.executeOperation(input, 'READ');
  }

  /**
   * Handle UPDATE operations (modifying existing state)
   *
   * UPDATE endpoint operations:
   * - edit_element: Modify existing elements
   *
   * Supports batch operations when input contains `operations` array.
   *
   * @param input - Operation input with operation name and params, or BatchRequest
   * @returns OperationResult with success/failure status, or BatchResult for batch operations
   */
  async handleUpdate(input: unknown): Promise<OperationResult | BatchResult> {
    if (isBatchRequest(input)) {
      return this.executeBatch(input, 'UPDATE');
    }
    return this.executeOperation(input, 'UPDATE');
  }

  /**
   * Handle DELETE operations (destructive actions)
   *
   * DELETE endpoint operations:
   * - delete_element: Delete elements
   * - clear: Clear memory entries
   * - clear_github_auth: Remove GitHub authentication
   *
   * Supports batch operations when input contains `operations` array.
   *
   * @param input - Operation input with operation name and params, or BatchRequest
   * @returns OperationResult with success/failure status, or BatchResult for batch operations
   */
  async handleDelete(input: unknown): Promise<OperationResult | BatchResult> {
    if (isBatchRequest(input)) {
      return this.executeBatch(input, 'DELETE');
    }
    return this.executeOperation(input, 'DELETE');
  }

  /**
   * Handle EXECUTE operations (runtime execution lifecycle)
   *
   * EXECUTE endpoint operations:
   * - execute_agent: Start execution of an agent or executable element
   * - get_execution_state: Query current execution state
   * - record_execution_step: Record execution progress or findings
   * - complete_execution: Signal execution finished successfully
   * - continue_execution: Resume execution from saved state
   * - abort_execution: Cancel an ongoing execution
   *
   * Unlike CRUD operations (which are idempotent), EXECUTE operations manage
   * runtime state and are inherently non-idempotent. Calling execute twice
   * creates two separate executions.
   *
   * Supports batch operations when input contains `operations` array.
   *
   * @param input - Operation input with operation name and params, or BatchRequest
   * @returns OperationResult with success/failure status, or BatchResult for batch operations
   */
  async handleExecute(input: unknown): Promise<OperationResult | BatchResult> {
    if (isBatchRequest(input)) {
      return this.executeBatch(input, 'EXECUTE');
    }
    return this.executeOperation(input, 'EXECUTE');
  }

  /**
   * Core execution logic shared by all CRUD endpoints.
   * Implements the thin resolver pattern: validate → route → dispatch → return.
   *
   * OPERATION FLOW:
   * 1. Validate input structure
   * 2. Validate permissions (PermissionGuard)
   * 3. Route operation (OperationRouter)
   * 4. Dispatch to handler
   * 5. Return standardized result
   *
   * @param input - Raw input to validate and process
   * @param endpoint - CRUD endpoint being called
   * @returns Standardized OperationResult
   */
  private async executeOperation(
    input: unknown,
    endpoint: CRUDEndpoint
  ): Promise<OperationResult> {
    // Issue #301: Capture start time for response timing metadata
    const startTime = performance.now();

    // Step 1: Parse and normalize input (handles both proper and legacy formats)
    // Issue #205: Silent JSON fallback for edge cases
    const parsedInput = parseOperationInput(input);

    // Extract operation name for logging
    const operationName = parsedInput?.operation ?? 'unknown';

    try {
      // Check if parsing succeeded
      if (!parsedInput) {
        return this.invalidInputFailure(input, startTime);
      }

      const { operation, elementType, params } = parsedInput;

      // Step 1b: In HTTP+DB mode, require identity before data operations.
      // Identity operations (set/get/clear) and gatekeeper infra are exempt.
      if (this.requiresIdentityCheck(operation)) {
        const identityError = this.checkHttpIdentity();
        if (identityError) return this.failure(identityError, startTime);
      }

      const gatekeeperFailure = await this.enforceOperationGatekeeper(parsedInput, endpoint, startTime);
      if (gatekeeperFailure) return gatekeeperFailure;

      // Step 3: Route operation to handler reference
      const route = getRoute(operation);
      if (!route) {
        // This should never happen after PermissionGuard.validate, but guard defensively
        return this.failure(`Unknown operation: ${operation}`, startTime);
      }

      // Step 4: Dispatch to handler (merge implicitParams from route, user params take precedence)
      const mergedParams = route.implicitParams
        ? { ...route.implicitParams, ...params }
        : params ?? {};
      const rawData = await this.dispatch(route.handler, {
        operation,
        elementType,
        params: mergedParams,
      });

      // Step 5: Apply field selection (Issue #202)
      // Transform name → element_name for LLM consistency
      // Apply field filtering if fields param provided
      const data = applyFieldSelection(rawData, params as Record<string, unknown>);

      this.logOperationSuccess(endpoint, operation, elementType, params);
      const durationMs = performance.now() - startTime;
      this.handlers.operationMetricsTracker?.record(operationName, endpoint, durationMs, true);
      const typeSuffix = elementType ? ':' + elementType : '';
      logger.debug(`[MCP-AQL] ${endpoint} ${operation}${typeSuffix} (${durationMs.toFixed(1)}ms)`);
      return this.success(data, startTime);
    } catch (error) {
      // Catch all errors and return as OperationFailure
      const message = error instanceof Error ? error.message : String(error);
      const isSecurityViolation = message.includes('Security violation');

      const durationMs = performance.now() - startTime;
      this.handlers.operationMetricsTracker?.record(operationName, endpoint, durationMs, false);

      this.logOperationFailure(endpoint, operationName, message, isSecurityViolation, error);
      return this.failure(message, startTime);
    }
  }

  private invalidInputFailure(input: unknown, startTime: number): OperationFailure {
    const diagnostic = describeInvalidInput(input);
    const hasOperation = input && typeof input === 'object' && typeof (input as any).operation === 'string';
    const hint = hasOperation
      ? 'The input structure looks correct but validation failed. If content contains markdown or special characters, ensure the JSON is properly escaped.'
      : 'Use format: { operation: "list_elements", params: { type: "personas" } }';
    return this.failure(
      `Invalid input: expected OperationInput with "operation" and optional "params". ${diagnostic}. ${hint}`,
      startTime
    );
  }

  private async enforceOperationGatekeeper(
    input: OperationInput,
    endpoint: CRUDEndpoint,
    startTime: number
  ): Promise<OperationFailure | null> {
    const { operation, elementType, params } = input;
    if (!env.DOLLHOUSE_GATEKEEPER_ENABLED) {
      Gatekeeper.validate(operation, endpoint);
      return null;
    }

    const activeElements = await this.getActiveElements();
    const decision = this.gatekeeper.enforce({
      operation,
      endpoint,
      elementType,
      activeElements,
      skipElementPolicies: isGatekeeperInfraOperation(operation),
    });

    this.recordGatekeeperDecision(decision);
    this.handleDeniedGatekeeperDecision(decision, operation, endpoint, elementType, params);
    return this.blockGatekeeperPolicyEdit(decision, operation, elementType, params, startTime);
  }

  private recordGatekeeperDecision(decision: GatekeeperDecision): void {
    this.handlers.gatekeeperMetricsTracker?.record({
      allowed: decision.allowed,
      permissionLevel: decision.permissionLevel,
      policySource: decision.policySource,
      confirmationPending: decision.confirmationPending,
    });
  }

  private handleDeniedGatekeeperDecision(
    decision: GatekeeperDecision,
    operation: string,
    endpoint: CRUDEndpoint,
    elementType: string | undefined,
    params?: Record<string, unknown>
  ): void {
    if (decision.allowed) {
      return;
    }
    if (decision.confirmationPending) {
      this.autoConfirmGatekeeperDecision(decision, operation, endpoint, elementType, params);
      return;
    }

    this.agentExecutionHandler.recordGatekeeperBlock(
      operation,
      elementType,
      decision.reason ?? 'Operation blocked by policy',
      decision.permissionLevel
    );
    throw new Error(`[Gatekeeper] ${decision.reason}`);
  }

  private autoConfirmGatekeeperDecision(
    decision: GatekeeperDecision,
    operation: string,
    endpoint: CRUDEndpoint,
    elementType: string | undefined,
    params?: Record<string, unknown>
  ): void {
    const confirmLevel = decision.permissionLevel as
      PermissionLevel.CONFIRM_SESSION | PermissionLevel.CONFIRM_SINGLE_USE;
    const riskScore = this.scoreOperationRisk(operation, endpoint, params);

    this.gatekeeper.recordConfirmation(operation, confirmLevel, elementType);

    const summary = buildOperationSummary(operation, elementType, params);
    const scope = elementType ? ' ['.concat(elementType, ']') : '';
    let riskLabel = 'LOW';
    if (riskScore >= 80) {
      riskLabel = 'HIGH';
    } else if (riskScore >= 40) {
      riskLabel = 'MODERATE';
    }
    const logMessage = [
      '[Gatekeeper] Auto-confirmed (', riskLabel, ' risk=', String(riskScore),
      '): ', summary, scope, '. Reason: ', decision.reason,
    ].join('');

    if (confirmLevel === PermissionLevel.CONFIRM_SINGLE_USE) {
      logger.warn(logMessage);
    } else {
      logger.debug(logMessage);
    }
  }

  private blockGatekeeperPolicyEdit(
    decision: GatekeeperDecision,
    operation: string,
    elementType: string | undefined,
    params: Record<string, unknown> | undefined,
    startTime: number
  ): OperationFailure | null {
    const inputObj = params?.input as Record<string, unknown> | undefined;
    const hasGatekeeperField =
      inputObj?.gatekeeper !== undefined ||
      (inputObj?.metadata as Record<string, unknown> | undefined)?.gatekeeper !== undefined;
    const blocked = operation === 'edit_element' &&
      decision.policySource === 'element_policy' &&
      decision.permissionLevel === PermissionLevel.AUTO_APPROVE &&
      hasGatekeeperField;

    if (!blocked) {
      return null;
    }

    logger.warn(`[MCPAQLHandler] Gatekeeper policy edit blocked from element-policy elevation — requires explicit confirmation`, {
      operation,
      elementType,
      policySource: decision.policySource,
    });
    const elementTypeFragment = elementType ? `, element_type: "${elementType}"` : '';
    return this.failure(
      `Editing gatekeeper policies requires explicit user confirmation and cannot be auto-approved by element policies. ` +
      `Use confirm_operation with params { operation: "edit_element"${elementTypeFragment} } to approve, then retry.`,
      startTime
    );
  }

  private logOperationSuccess(
    endpoint: CRUDEndpoint,
    operation: string,
    elementType: string | undefined,
    params: Record<string, unknown> | undefined
  ): void {
    if (endpoint === 'READ') {
      return;
    }
    SecurityMonitor.logSecurityEvent({
      type: 'OPERATION_COMPLETED',
      severity: 'LOW',
      source: `MCPAQLHandler.${endpoint.toLowerCase()}`,
      details: elementType
        ? `${endpoint} '${operation}' completed on ${elementType}`
        : `${endpoint} '${operation}' completed`,
      additionalData: {
        endpoint,
        operation,
        elementType,
        parameterKeys: params ? Object.keys(params) : [],
      }
    });
  }

  private logOperationFailure(
    endpoint: CRUDEndpoint,
    operationName: string,
    message: string,
    isSecurityViolation: boolean,
    error: unknown
  ): void {
    SecurityMonitor.logSecurityEvent({
      type: isSecurityViolation ? 'UPDATE_SECURITY_VIOLATION' : 'OPERATION_FAILED',
      severity: isSecurityViolation ? 'HIGH' : 'MEDIUM',
      source: `MCPAQLHandler.${endpoint.toLowerCase()}`,
      details: `${endpoint} '${operationName}' failed: ${message}`,
      additionalData: { endpoint, operation: operationName, error: message }
    });

    logger.error(`${endpoint} '${operationName}' failed: ${message}`, {
      endpoint,
      operation: operationName,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  /**
   * Execute a batch of operations sequentially.
   * Operations are executed in order, and failures do not stop execution.
   *
   * EXECUTION SEMANTICS:
   * - Operations run sequentially (in order)
   * - Each operation is validated independently
   * - Failed operations don't stop the batch
   * - All results are collected and returned
   *
   * @param batch - BatchRequest with array of operations
   * @param endpoint - CRUD endpoint being called
   * @returns BatchResult with all operation results and summary
   */
  private async executeBatch(
    batch: BatchRequest,
    endpoint: CRUDEndpoint
  ): Promise<BatchResult> {
    // Issue #221/#543: Reject oversized batches to prevent resource exhaustion
    if (batch.operations.length > SECURITY_LIMITS.MAX_BATCH_OPERATIONS) {
      SecurityMonitor.logSecurityEvent({
        type: 'BATCH_REJECTED',
        severity: 'MEDIUM',
        source: `MCPAQLHandler.${endpoint.toLowerCase()}.batch`,
        details: `Batch of ${batch.operations.length} ops rejected — exceeds limit of ${SECURITY_LIMITS.MAX_BATCH_OPERATIONS}`,
        additionalData: { endpoint, requested: batch.operations.length, limit: SECURITY_LIMITS.MAX_BATCH_OPERATIONS },
      });
      return {
        success: false,
        results: [],
        summary: { total: batch.operations.length, succeeded: 0, failed: batch.operations.length },
        error: `Batch size ${batch.operations.length} exceeds maximum of ${SECURITY_LIMITS.MAX_BATCH_OPERATIONS} operations`,
        _meta: this.buildMeta(performance.now()),
      };
    }

    // Issue #301: Capture start time for batch-level timing metadata
    const startTime = performance.now();
    const results: BatchOperationResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < batch.operations.length; i++) {
      const op = batch.operations[i];

      // Pass raw operation through — parseOperationInput() in executeOperation()
      // handles all normalization (element_type vs elementType, legacy formats, etc.)
      const result = await this.executeOperation(op, endpoint);

      results.push({
        index: i,
        operation: op.operation,
        result,
      });

      if (result.success) {
        succeeded++;
      } else {
        failed++;
      }
    }

    // Log batch completion
    SecurityMonitor.logSecurityEvent({
      type: 'BATCH_COMPLETED',
      severity: 'LOW',
      source: `MCPAQLHandler.${endpoint.toLowerCase()}.batch`,
      details: `Batch of ${batch.operations.length} ops: ${succeeded} succeeded, ${failed} failed`,
      additionalData: {
        endpoint,
        total: batch.operations.length,
        succeeded,
        failed,
        operations: batch.operations.map(op => op.operation),
        failureRate: batch.operations.length > 0 ? Math.round((failed / batch.operations.length) * 100) : 0,
      },
    });

    return {
      success: true,
      results,
      summary: {
        total: batch.operations.length,
        succeeded,
        failed,
      },
      _meta: this.buildMeta(startTime),
    };
  }

  /**
   * Dispatch a handler reference to the actual handler method.
   *
   * Handler reference format: "Module.method"
   * Examples:
   * - "ElementCRUD.create" → this.handlers.elementCRUD.createElement(...)
   * - "Memory.addEntry" → this.handlers.memoryManager.addEntry(...)
   * - "Agent.execute" → this.handlers.agentManager.executeAgent(...)
   *
   * DISPATCH STRATEGY (Issue #247):
   * 1. Check if operation is schema-driven → use SchemaDispatcher
   * 2. Otherwise fall through to legacy module-based dispatch
   *
   * Schema-driven operations benefit from:
   * - Declarative configuration (no switch statements)
   * - Auto-generated parameter validation
   * - Single source of truth for operation metadata
   *
   * @param handlerRef - Handler reference in "Module.method" format
   * @param input - Validated operation input
   * @returns Promise resolving to operation-specific data
   * @throws Error if handler reference is unknown or method fails
   */
  private async dispatch(
    handlerRef: string,
    input: OperationInput
  ): Promise<unknown> {
    const { operation, params } = input;

    // Issue #247: Schema-driven dispatch for configured operations
    // This eliminates the need for manual switch statements
    // Issue #251: Pass full input for operations needing elementType resolution
    if (SchemaDispatcher.canDispatch(operation)) {
      return SchemaDispatcher.dispatch(
        operation,
        (params as Record<string, unknown>) || {},
        this.handlers,
        input
      );
    }

    // Legacy module-based dispatch for complex operations
    const [module, method] = handlerRef.split('.');

    const p = params as Record<string, unknown>;
    const dispatchers: Record<string, () => unknown> = {
      ElementCRUD: () => this.dispatchElementCRUD(method, input),
      Memory: () => this.dispatchMemory(method, p),
      Agent: () => this.dispatchAgent(method, p),
      Template: () => this.dispatchTemplate(method, p),
      Activation: () => this.dispatchActivation(method, input),
      Search: () => this.dispatchSearch(method, input),
      Introspection: () => this.dispatchIntrospection(method, p),
      Collection: () => this.dispatchCollection(method, p),
      Portfolio: () => this.dispatchPortfolio(method, p),
      Auth: () => this.dispatchAuth(method, p),
      Config: () => this.dispatchConfig(method, p),
      EnhancedIndex: () => this.dispatchEnhancedIndex(method, p),
      Persona: () => this.dispatchPersona(method, p),
      Execute: () => this.dispatchExecute(method, p),
      Gatekeeper: () => this.dispatchGatekeeper(method, p),
      Logging: () => this.dispatchLogging(method, p),
      Metrics: () => this.dispatchMetrics(method, p),
      Browser: () => this.dispatchBrowser(method, p),
    };
    const dispatcher = dispatchers[module];
    if (!dispatcher) {
      throw new Error(`Unknown handler module: ${module}`);
    }
    return dispatcher();
  }

  /**
   * Dispatch ElementCRUD operations to ElementCRUDHandler
   */
  private async dispatchElementCRUD(
    method: string,
    input: OperationInput
  ): Promise<unknown> {
    return this.elementCRUDDispatcher.dispatch(method, input);
  }

  async dispose(): Promise<void> {
    await this.memorySaveHandler.dispose();
  }

  async flushPendingSaves(): Promise<void> {
    await this.memorySaveHandler.flushPendingSaves();
  }

  private get saveFrequencyCounters(): Map<string, unknown> {
    return this.memorySaveHandler.getSaveFrequencyCountersForTesting() as Map<string, unknown>;
  }

  private trackSaveFrequency(memoryName: string): void {
    this.memorySaveHandler.trackSaveFrequencyForTesting(memoryName);
  }

  private async dispatchMemory(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return this.memorySaveHandler.dispatch(method, params);
  }

  /**
   * Dispatch Agent operations to AgentManager
   */
  private async dispatchAgent(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const manager = this.handlers.agentManager;
    // Issue #290: Use element_name parameter
    // Issue #323: Validate parameter before use
    const agentName = validateRequiredString(
      params,
      'element_name',
      'the name of the agent to execute'
    );

    switch (method) {
      case 'execute':
        return manager.executeAgent(
          agentName,
          params.parameters as Record<string, unknown>
        );

      default:
        throw new Error(`Unknown Agent method: ${method}`);
    }
  }

  /**
   * Dispatch Template operations to TemplateRenderer
   */
  private async dispatchTemplate(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const renderer = this.handlers.templateRenderer;
    // Issue #290: Use element_name parameter
    // Issue #323: Validate parameter before use
    const templateName = validateRequiredString(
      params,
      'element_name',
      'the name of the template to render'
    );

    switch (method) {
      case 'render':
        return renderer.render(
          templateName,
          params.variables as Record<string, unknown>,
          params.section as 'template' | 'style' | 'script' | undefined,
          params.all_sections as boolean | undefined
        );

      default:
        throw new Error(`Unknown Template method: ${method}`);
    }
  }

  /**
   * Dispatch Activation operations (cross-cutting concern)
   */
  private async dispatchActivation(
    method: string,
    input: OperationInput
  ): Promise<unknown> {
    const { elementType, params } = input;
    const handler = this.handlers.elementCRUD;
    const p = params as Record<string, unknown>;

    // Issue #290: Use element_name/element_type parameter names
    // Issue #323: Validate parameters before use
    // For getActive, element_name is not required
    if (method !== 'getActive') {
      const name = validateRequiredString(
        p,
        'element_name',
        'the name of the element to activate/deactivate'
      );

      // element_type can come from input.elementType or params.element_type
      const type = elementType || (p.element_type as string | undefined);
      if (!type || typeof type !== 'string' || type.trim() === '') {
        throw new Error(
          `Missing required parameter 'element_type'. Expected: string (persona, skill, template, agent, memory, or ensemble)`
        );
      }

      switch (method) {
        case 'activate':
          return handler.activateElement(
            name,
            type,
            p.context as Record<string, unknown> | undefined
          );

        case 'deactivate':
          return handler.deactivateElement(name, type);

        default:
          throw new Error(`Unknown Activation method: ${method}`);
      }
    }

    // getActive: element_type is optional - if not provided, returns all active elements
    // Issue #501: Pass type as string | undefined — getActiveElements handles both cases
    const type = elementType || (p.element_type as string | undefined);
    return handler.getActiveElements(type);
  }

  /**
   * Dispatch Search operations to ElementQueryService
   */
  private async dispatchSearch(
    method: string,
    input: OperationInput
  ): Promise<unknown> {
    return this.searchHandler.dispatch(method, input);
  }

  // NOTE: Unified Search operations (Issue #243) are now schema-driven.
  // The 'search' operation uses the 'searchParams' normalizer in OperationSchema.ts.
  // See: SearchParamsNormalizer for scope/pagination/sort/filter transformation.

  /**
   * Dispatch Introspection operations to IntrospectionResolver
   */
  private dispatchIntrospection(
    method: string,
    params: Record<string, unknown>
  ): unknown {
    switch (method) {
      case 'resolve':
        return IntrospectionResolver.resolve(params);

      default:
        throw new Error(`Unknown Introspection method: ${method}`);
    }
  }

  // ============================================================================
  // MCP-AQL Extension Dispatch Methods (Issue #241)
  // ============================================================================

  /**
   * Dispatch Collection operations to CollectionHandler
   */
  private async dispatchCollection(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const handler = this.handlers.collectionHandler;
    if (!handler) {
      throw new Error('Collection operations not available: CollectionHandler not configured');
    }

    switch (method) {
      case 'browse':
        return handler.browseCollection(
          params.section as string | undefined,
          params.type as string | undefined
        );

      case 'search':
        return handler.searchCollection(params.query as string);

      case 'searchEnhanced':
        return handler.searchCollectionEnhanced(params.query as string, params);

      case 'getContent':
        return handler.getCollectionContent(params.path as string);

      case 'getCacheHealth':
        return handler.getCollectionCacheHealth();

      case 'install':
        return handler.installContent(params.path as string);

      case 'submit':
        return handler.submitContent(params.content as string);

      default:
        throw new Error(`Unknown Collection method: ${method}`);
    }
  }

  /**
   * Dispatch Portfolio operations to PortfolioHandler
   */
  private async dispatchPortfolio(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const handler = this.handlers.portfolioHandler;
    if (!handler) {
      throw new Error('Portfolio operations not available: PortfolioHandler not configured');
    }

    switch (method) {
      case 'status':
        return handler.portfolioStatus(params.username as string | undefined);

      case 'init':
        return handler.initPortfolio({
          repositoryName: params.repository_name as string | undefined,
          private: params.private as boolean | undefined,
          description: params.description as string | undefined,
        });

      case 'config':
        return handler.portfolioConfig({
          autoSync: params.auto_sync as boolean | undefined,
          defaultVisibility: params.default_visibility as string | undefined,
          autoSubmit: params.auto_submit as boolean | undefined,
          repositoryName: params.repository_name as string | undefined,
        });

      case 'sync':
        return handler.syncPortfolio({
          direction: (params.direction as string) || 'push',
          mode: params.mode as string | undefined,
          force: params.force as boolean || false,
          dryRun: params.dry_run as boolean || false,
          confirmDeletions: params.confirm_deletions as boolean | undefined,
        });

      case 'search':
        return handler.searchPortfolio({
          query: params.query as string,
          elementType: params.type as string | undefined,
          fuzzyMatch: params.fuzzy_match as boolean | undefined,
          maxResults: params.max_results as number | undefined,
          includeKeywords: params.include_keywords as boolean | undefined,
          includeTags: params.include_tags as boolean | undefined,
          includeTriggers: params.include_triggers as boolean | undefined,
          includeDescriptions: params.include_descriptions as boolean | undefined,
        });

      case 'searchAll':
        return handler.searchAll({
          query: params.query as string,
          sources: params.sources as string[] | undefined,
          elementType: params.type as string | undefined,
          page: params.page as number | undefined,
          pageSize: params.page_size as number | undefined,
          sortBy: params.sort_by as string | undefined,
        });

      case 'elementManager': {
        const syncHandler = this.handlers.syncHandler;
        if (!syncHandler) {
          throw new Error('Portfolio element manager not available: SyncHandler not configured');
        }
        return syncHandler.handleSyncOperation({
          operation: params.operation as 'list-remote' | 'download' | 'upload' | 'compare',
          element_name: params.element_name as string | undefined,
          element_type: params.element_type as ElementType | undefined,
          filter: params.filter as { type?: ElementType; author?: string; updated_after?: string } | undefined,
          options: params.options as { force?: boolean; dry_run?: boolean; include_private?: boolean } | undefined,
        });
      }

      default:
        throw new Error(`Unknown Portfolio method: ${method}`);
    }
  }

  /**
   * Dispatch Auth operations to GitHubAuthHandler
   */
  private async dispatchAuth(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const handler = this.handlers.authHandler;
    if (!handler) {
      throw new Error('Auth operations not available: GitHubAuthHandler not configured');
    }

    switch (method) {
      case 'setup':
        return handler.setupGitHubAuth();

      case 'check':
        return handler.checkGitHubAuth();

      case 'clear':
        return handler.clearGitHubAuth();

      case 'configureOAuth':
        return handler.configureOAuth(params.client_id as string | undefined);

      case 'oauthHelperStatus':
        return handler.getOAuthHelperStatus(params.verbose as boolean | undefined);

      default:
        throw new Error(`Unknown Auth method: ${method}`);
    }
  }

  /**
   * Dispatch Config operations to ConfigHandler and BuildInfoService
   */
  private async dispatchConfig(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return this.configDispatcher.dispatch(method, params);
  }

  /**
   * Dispatch EnhancedIndex operations to EnhancedIndexHandler
   */
  private async dispatchEnhancedIndex(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const handler = this.handlers.enhancedIndexHandler;
    if (!handler) {
      throw new Error('EnhancedIndex operations not available: EnhancedIndexHandler not configured');
    }

    switch (method) {
      case 'findSimilar':
        return handler.findSimilarElements({
          elementName: params.element_name as string,
          elementType: params.element_type as string | undefined,
          limit: (params.limit as number) ?? 10,
          threshold: (params.threshold as number) ?? 0.5,
        });

      case 'getRelationships':
        return handler.getElementRelationships({
          elementName: params.element_name as string,
          elementType: params.element_type as string | undefined,
          relationshipTypes: params.relationship_types as string[] | undefined,
        });

      case 'searchByVerb':
        return handler.searchByVerb({
          verb: params.verb as string,
          limit: (params.limit as number) ?? 20,
        });

      case 'getStats':
        return handler.getRelationshipStats();

      default:
        throw new Error(`Unknown EnhancedIndex method: ${method}`);
    }
  }

  /**
   * Dispatch Persona operations to PersonaHandler
   */
  private async dispatchPersona(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const handler = this.handlers.personaHandler;
    if (!handler) {
      throw new Error('Persona operations not available: PersonaHandler not configured');
    }

    switch (method) {
      case 'import': {
        // Issue #323: Validate source parameter before use
        const source = validateRequiredString(
          params,
          'source',
          'URL or file path to import persona from'
        );
        return handler.importPersona(source, params.overwrite as boolean | undefined);
      }

      default:
        throw new Error(`Unknown Persona method: ${method}`);
    }
  }

  private challengeIsForDeadlockRelief(challenge: { reason: string } | undefined): boolean {
    return typeof challenge?.reason === 'string' && challenge.reason.startsWith(DEADLOCK_RELIEF_REASON);
  }

  private issueDeadlockReliefChallenge(): {
    pending: true;
    challenge_id: string;
    message: string;
    warning: string;
  } {
    const store = this.handlers.verificationStore;
    if (!store) {
      throw new Error('Verification system not available. Ensure the server is properly configured.');
    }

    const challengeId = randomUUID();
    const code = generateDisplayCode();
    store.set(challengeId, {
      code,
      expiresAt: Date.now() + DEADLOCK_RELIEF_TIMEOUT_MS,
      reason: DEADLOCK_RELIEF_REASON,
    });

    this.handlers.verificationNotifier?.showCode(code, DEADLOCK_RELIEF_DIALOG_REASON);

    SecurityMonitor.logSecurityEvent({
      type: 'DANGER_ZONE_TRIGGERED',
      severity: 'MEDIUM',
      source: 'MCPAQLHandler.issueDeadlockReliefChallenge',
      details: `Deadlock relief challenge issued for session ${this.gatekeeper.sessionId}`,
      additionalData: {
        challengeId,
        sessionId: this.gatekeeper.sessionId,
      },
    });

    return {
      pending: true,
      challenge_id: challengeId,
      message: 'Deadlock relief requires human confirmation. A verification code has been displayed to the user.',
      warning: 'Completing this flow will deactivate all active elements for the current session and clear persisted activation state.',
    };
  }

  private async completeDeadlockRelief(challengeId: string, code: string): Promise<{
    released: true;
    challenge_id: string;
    sessionId?: string;
    activeBeforeReset: Array<{ type: string; name: string }>;
    deactivated: Array<{ type: string; name: string }>;
    failed: Array<{ type: string; name: string; error: string }>;
    persistedStateCleared: boolean;
    likelyDeadlockCause: {
      sandboxingElement?: { type: string; name: string };
      advisoryElements: Array<{ type: string; name: string }>;
    };
    snapshotFile?: string;
    message: string;
  }> {
    const store = this.handlers.verificationStore;
    if (!store) {
      throw new VerificationError(
        GatekeeperErrorCode.VERIFICATION_FAILED,
        'Verification system not available. Ensure the server is properly configured.',
      );
    }

    validateChallengeIdFormat(challengeId);

    const challenge = store.get(challengeId);
    if (!challenge) {
      throw new VerificationError(
        GatekeeperErrorCode.VERIFICATION_TIMEOUT,
        'Deadlock relief challenge not found. It may have expired or already been used. Retry release_deadlock to receive a new code.',
      );
    }

    if (!this.challengeIsForDeadlockRelief(challenge)) {
      throw new VerificationError(
        GatekeeperErrorCode.VERIFICATION_FAILED,
        'This challenge is not for deadlock relief. Use the matching verification flow for the requested operation.',
      );
    }

    const valid = store.verify(challengeId, code);
    if (!valid) {
      throw new VerificationError(
        GatekeeperErrorCode.VERIFICATION_FAILED,
        'Verification failed: incorrect code. The code has been consumed (one-time use). Retry release_deadlock to receive a new code.',
      );
    }

    const reset = await this.handlers.elementCRUD.releaseDeadlock();

    SecurityMonitor.logSecurityEvent({
      type: 'VERIFICATION_SUCCEEDED',
      severity: 'MEDIUM',
      source: 'MCPAQLHandler.completeDeadlockRelief',
      details: `Deadlock relief completed for session ${this.gatekeeper.sessionId}`,
      additionalData: {
        challengeId,
        sessionId: this.gatekeeper.sessionId,
        deactivatedCount: reset.deactivated.length,
        failedCount: reset.failed.length,
      },
    });

    const snapshotSuffix = reset.snapshotFile
      ? ` A recovery snapshot was saved to ${reset.snapshotFile}.`
      : '';
    const message = reset.failed.length > 0
      ? `Deadlock relief completed with ${reset.failed.length} deactivation failure(s). Review the failed list, likely deadlock cause, and recovery snapshot before reactivating elements.`
      : `Deadlock relief completed. All active elements for this session were deactivated and persisted activation state was cleared.${snapshotSuffix}`;

    return {
      released: true,
      challenge_id: challengeId,
      ...reset,
      message,
    };
  }

  /**
   * Dispatch Gatekeeper operations for confirmation management.
   *
   * Issue #452: Handles the confirm_operation flow where users approve
   * operations that require confirmation per Gatekeeper policy.
   *
   * Flow:
   * 1. Gatekeeper.enforce() returns confirmationPending: true
   * 2. LLM calls confirm_operation with the operation name
   * 3. This method records the confirmation in the session
   * 4. LLM retries the original operation, which now passes via Layer 3
   */
  private async dispatchGatekeeper(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return this.gatekeeperHandler.dispatch(method, params);
  }

  /**
   * Dispatch Logging operations (Issue #528 - CRUDE migration)
   *
   * Routes query_logs through the unified CRUDE pipeline instead of
   * a standalone MCP tool, providing operation routing, gatekeeper
   * policy enforcement, and structured response format.
   */
  private dispatchLogging(
    method: string,
    params: Record<string, unknown>
  ): unknown {
    if (!this.handlers.memorySink) {
      throw new Error('MemoryLogSink not available — logging query requires memory sink');
    }

    switch (method) {
      case 'query': {
        const options = validateLogQueryParams(params);
        // Session-scoped log filtering: auto-inject the calling session's ID
        // when no explicit sessionId is provided, and reject cross-session
        // queries when a session context is active.
        const callerSessionId = this.contextTracker?.getSessionContext?.()?.sessionId;
        if (callerSessionId) {
          // Enforce session boundary — callers cannot read other sessions' logs
          if (options.sessionId && options.sessionId !== callerSessionId) {
            throw new Error('Cannot query logs for a different session');
          }
          options.sessionId = callerSessionId;
        }
        const result = this.handlers.memorySink.query(options);
        return { _type: 'LogQueryResult', ...result };
      }
      default:
        throw new Error(`Unknown Logging method: ${method}`);
    }
  }

  /**
   * Dispatch Metrics operations.
   *
   * Routes query_metrics through the unified CRUDE pipeline, providing
   * operation routing, gatekeeper policy enforcement, and structured response format.
   *
   * Note: Metrics are server-global (CPU, memory, cache hit rates, operation
   * counts) and are not session-scoped. All sessions can view all metrics.
   * This is intentional for operational monitoring in single-operator deployments.
   */
  private dispatchMetrics(
    method: string,
    params: Record<string, unknown>
  ): unknown {
    if (!this.handlers.metricsSink) {
      return {
        _type: 'MetricQueryResult',
        snapshots: [],
        total: 0,
        hasMore: false,
        message: 'Metrics collection is not enabled. Set DOLLHOUSE_METRICS_ENABLED=true to activate.',
      };
    }

    if (method === 'query') {
      const options = validateMetricQueryParams(params);
      const result = this.handlers.metricsSink.query(options);
      return { _type: 'MetricQueryResult', ...result };
    }
    throw new Error(`Unknown Metrics method: ${method}`);
  }

  /**
   * Dispatch Browser operations (Issue #774: open portfolio browser)
   */
  /**
   * Dispatch Browser operations.
   *
   * Starts the portfolio web server (if not running) and opens the
   * system browser. Returns the URL and any warnings if the browser
   * could not be opened automatically.
   *
   * @param method - The browser method to dispatch ('open')
   * @returns MCP response with URL and optional warning
   * @see Issue #774
   */
  /**
   * Extract URL query parameters from operation params.
   * Serializes all params except 'tab' as string key-value pairs.
   * @see Issue #1765 - URL parameter support for portfolio browser
   */
  private static extractUrlParams(params: Record<string, unknown>): Record<string, string> | undefined {
    const urlParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === 'tab' || value === undefined || value === null || value === '') continue;
      urlParams[key] = MCPAQLHandler.serializeParamValue(value);
    }
    return Object.keys(urlParams).length > 0 ? urlParams : undefined;
  }

  /** Serialize a param value to a URL-safe string. */
  private static serializeParamValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
    return JSON.stringify(value);
  }

  private async dispatchBrowser(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method !== 'open') {
      throw new Error(`Unknown Browser method: ${method}`);
    }

    const { openPortfolioBrowser } = await import('../../web/server.js');
    const portfolioDir = this.handlers.portfolioManager.getBaseDir();

    const tab = typeof params?.tab === 'string' ? params.tab : undefined;
    const urlParams = params ? MCPAQLHandler.extractUrlParams(params) : undefined;

    // Issue #796: Pass MCPAQLHandler to web server for gateway routing.
    // Issue #1850: Pass sinks so fallback server has full console functionality.
    const result = await openPortfolioBrowser({
      portfolioDir,
      mcpAqlHandler: this,
      tab,
      urlParams,
      memorySink: this.handlers.memorySink,
      metricsSink: this.handlers.metricsSink,
    });

    const status = result.alreadyRunning ? 'already running' : 'started';
    const browserStatus = result.browserOpened ? 'opened' : 'could not open automatically';
    const warning = result.warning ? `\n\n⚠️ ${result.warning}` : '';
    const tabNote = tab ? ` (${tab} tab)` : '';

    return {
      content: [{
        type: 'text',
        text: `Portfolio browser ${status} at ${result.url}${tabNote} — browser ${browserStatus}${warning}`,
      }],
    };
  }

  /**
   * Look up the CRUDE endpoint for a given operation name.
   * Used by dispatchGatekeeper to determine the correct endpoint context.
   */
  private getEndpointForOperation(operation: string): CRUDEndpoint {
    const route = getRoute(operation);
    if (!route) {
      throw new Error(`Unknown operation: ${operation}`);
    }
    return route.endpoint;
  }

  /**
   * Score the risk of an MCP-AQL operation for auto-confirm audit trails.
   *
   * Returns a score from 0-100 based on operation characteristics:
   * - DELETE endpoint operations: base 80 (destructive, data loss)
   * - EXECUTE endpoint operations: base 60 (unpredictable side effects)
   * - UPDATE endpoint operations: base 40 (modifies existing data)
   * - CREATE endpoint operations: base 20 (additive, low risk)
   *
   * Modifiers:
   * - Operations with canBeElevated: false get +10 (structurally dangerous)
   * - Operations targeting gatekeeper fields get +10 (privilege escalation vector)
   *
   * @param operation - The operation name
   * @param endpoint - The CRUDE endpoint
   * @param params - Operation parameters (for field inspection)
   * @returns Risk score 0-100
   */
  private scoreOperationRisk(
    operation: string,
    endpoint: string,
    params?: Record<string, unknown>
  ): number {
    // Base score by endpoint type
    const baseScores: Record<string, number> = {
      DELETE: 80,
      EXECUTE: 60,
      UPDATE: 40,
      CREATE: 20,
      READ: 0,
    };
    let score = baseScores[endpoint] ?? 40;

    // Modifier: non-elevatable operations are structurally more dangerous
    if (!canOperationBeElevated(operation)) {
      score += 10;
    }

    // Modifier: operations targeting gatekeeper fields (privilege escalation vector)
    if (params && operation === 'edit_element') {
      const inputObj = params.input as Record<string, unknown> | undefined;
      if (inputObj?.gatekeeper !== undefined ||
          (inputObj?.metadata as Record<string, unknown> | undefined)?.gatekeeper !== undefined) {
        score += 10;
      }
    }

    return Math.min(score, 100);
  }

  /**
   * Dispatch Execute operations for execution lifecycle management (Issue #244)
   *
   * Execute operations handle runtime state of executable elements:
   * - execute: Start a new execution
   * - getState: Query current execution state
   * - updateState: Record progress, findings, step completion
   * - complete: Signal successful completion
   * - continue: Resume from saved state
   * - abort: Cancel an ongoing execution
   *
   * These operations are non-idempotent by nature (unlike CRUD operations).
   * Currently routes to AgentManager, but designed for future extensibility
   * to workflows, pipelines, and other executable element types.
   */
  private async dispatchExecute(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return this.agentExecutionHandler.dispatch(method, params);
  }

  /**
   * Get the current correlation ID from the underlying ContextTracker.
   * Exposed for use by UnifiedEndpoint and other wrappers.
   * Issue #301.
   */
  getCorrelationId(): string | undefined {
    return this.contextTracker?.getCorrelationId();
  }

  // ============================================================================
  // Result Helper Methods
  // ============================================================================

  /**
   * Build response metadata with correlation ID and timing.
   * Issue #301: Request IDs and distributed tracing support.
   */
  private buildMeta(startTime: number): ResponseMeta {
    return {
      requestId: this.contextTracker?.getCorrelationId() ?? 'unknown',
      durationMs: parseFloat((performance.now() - startTime).toFixed(2)),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a successful operation result
   */
  private success(data: unknown, startTime: number): OperationSuccess {
    return {
      success: true,
      data,
      _meta: this.buildMeta(startTime),
    };
  }

  /**
   * Create a failed operation result
   */
  private failure(error: string, startTime: number): OperationFailure {
    return {
      success: false,
      error,
      _meta: this.buildMeta(startTime),
    };
  }

  private static readonly IDENTITY_EXEMPT_OPS = new Set([
    'set_user_identity', 'get_user_identity', 'clear_user_identity',
    'confirm_operation', 'verify_challenge', 'approve_cli_permission',
    'introspect', 'get_build_info', 'get_logs',
  ]);

  private requiresIdentityCheck(operation: string): boolean {
    if (MCPAQLHandler.IDENTITY_EXEMPT_OPS.has(operation)) return false;
    if (!this.handlers.isDbMode) return false;
    // DOLLHOUSE_USER set = operator established identity at startup
    if (process.env.DOLLHOUSE_USER?.trim()) return false;
    const session = this.contextTracker?.getSessionContext?.();
    if (!session) return false;
    // Per-session DB override from future auth
    const state = this.handlers.activationRegistry?.get(session.sessionId);
    if (state?.dbUserId) return false;
    return true;
  }

  private checkHttpIdentity(): string | null {
    return 'No user identity set. Set the DOLLHOUSE_USER environment variable ' +
      'when starting the server to establish your identity. ' +
      'Example: DOLLHOUSE_USER=your-name node dist/index.js';
  }

}
