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
import { type ActiveElement, translateToolConfigToPolicy, canOperationBeElevated } from './policies/index.js';
import { isGatekeeperInfraOperation, findConfirmDenyingElement, findConfirmAdvisoryElements } from './policies/ElementPolicies.js';
import { PermissionLevel, GatekeeperErrorCode } from './GatekeeperTypes.js';
import { getRoute } from './OperationRouter.js';
import { ALL_OPERATION_SCHEMAS } from './OperationSchema.js';
import { IntrospectionResolver } from './IntrospectionResolver.js';
import { SchemaDispatcher } from './SchemaDispatcher.js';
import { initializeNormalizers } from './normalizers/index.js';
import { filterFields, isValidPreset, normalizeFieldNames } from '../../utils/FieldFilter.js';
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
  normalizeMCPAQLElementType,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { isSearchMatch } from '../../utils/searchUtils.js';
import { PaginationService } from '../../services/query/PaginationService.js';
import { normalizeElementType, ALL_ELEMENT_TYPES, formatElementTypesList } from '../../utils/elementTypeNormalization.js';
import * as yaml from 'js-yaml';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { classifyTool, evaluateCliToolPolicy, assessRisk } from './policies/ToolClassification.js';
import type { CliApprovalScope, CliApprovalPolicy } from './GatekeeperTypes.js';
import { RateLimiterFactory } from '../../utils/RateLimiter.js';
import { env } from '../../config/env.js';
import { STORAGE_LAYER_CONFIG } from '../../config/performance-constants.js';
import type { DangerZoneEnforcer } from '../../security/DangerZoneEnforcer.js';
import type { IChallengeStore } from '../../state/IChallengeStore.js';
import type { IVerificationNotifier } from '../../services/VerificationNotifier.js';
import { generateDisplayCode } from '@dollhousemcp/safety';
import { randomUUID } from 'node:crypto';
import type { ElementCRUDHandler } from '../ElementCRUDHandler.js';
import type { MemoryManager } from '../../elements/memories/MemoryManager.js';
import type { AgentManager } from '../../elements/agents/AgentManager.js';
import type { AgentMetadataV2, AgentResiliencePolicy, AgentNotification } from '../../elements/agents/types.js';
import { evaluateResiliencePolicy, type CircuitBreakerState, type ResilienceContext } from '../../elements/agents/resilienceEvaluator.js';
import type { ResilienceMetricsTracker } from '../../elements/agents/resilienceMetrics.js';
import type { TemplateRenderer } from '../../utils/TemplateRenderer.js';
import type { ElementQueryService } from '../../services/query/ElementQueryService.js';
import { aggregateElements, validateAggregationOptions } from '../../services/query/AggregationService.js';
import type { IElement } from '../../types/elements/IElement.js';
import type { CollectionHandler } from '../CollectionHandler.js';
import type { PortfolioHandler } from '../PortfolioHandler.js';
import type { GitHubAuthHandler } from '../GitHubAuthHandler.js';
import type { ConfigHandler } from '../ConfigHandler.js';
import type { EnhancedIndexHandler } from '../EnhancedIndexHandler.js';
import { getPermissionHookStatus } from '../../utils/permissionHooks.js';
import type { PersonaHandler } from '../PersonaHandler.js';
import type { SyncHandler } from '../SyncHandlerV2.js';
import type { BuildInfoService } from '../../services/BuildInfoService.js';
import type { MemoryLogSink } from '../../logging/sinks/MemoryLogSink.js';
import type { LogQueryOptions } from '../../logging/types.js';
import type { MetricQueryOptions, MetricType } from '../../metrics/types.js';
import type { PerformanceMonitor } from '../../utils/PerformanceMonitor.js';
import type { OperationMetricsTracker } from '../../metrics/OperationMetricsTracker.js';
import type { GatekeeperMetricsTracker } from '../../metrics/GatekeeperMetricsTracker.js';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import { prepareHandoffState, parseHandoffBlock, generateHandoffBlock } from '../../elements/agents/handoff.js';
import { getAutonomyMetrics } from '../../elements/agents/autonomyEvaluator.js';
import type { AutonomyMetricsSnapshot } from '../../elements/agents/autonomyEvaluator.js';

// ============================================================================
// Parameter Validation Utilities (Issue #323)
// ============================================================================

/**
 * Validate and extract a required string parameter from params.
 * Throws a user-friendly error if the parameter is missing or not a string.
 *
 * @param params - The parameters object to extract from
 * @param paramName - The name of the required parameter
 * @param description - Human-readable description for the error message
 * @returns The validated string value
 * @throws Error with user-friendly message if validation fails
 */
function validateRequiredString(
  params: Record<string, unknown>,
  paramName: string,
  description: string
): string {
  const value = params[paramName];
  if (value === undefined || value === null || typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Missing required parameter '${paramName}'. Expected: string (${description})`
    );
  }
  return value;
}

/**
 * Normalize flat pagination params into a { page, pageSize } object.
 *
 * Issue #500: query_elements and search_elements silently ignored flat
 * pageSize/page/limit/offset params. This helper detects these at the
 * top level and normalizes them, matching the pattern used by listElements.
 *
 * Priority: nested pagination > limit/offset > flat page/pageSize > defaults
 */
function normalizePaginationParams(
  params: {
    pagination?: { page?: number; pageSize?: number };
    page?: number;
    pageSize?: number;
    limit?: number;
    offset?: number;
    [key: string]: unknown;
  }
): { page: number; pageSize: number } {
  // If nested pagination is present, use it directly
  if (params.pagination && typeof params.pagination === 'object') {
    const p = params.pagination;
    return {
      page: (typeof p.page === 'number' && p.page > 0) ? p.page : 1,
      pageSize: (typeof p.pageSize === 'number' && p.pageSize > 0) ? p.pageSize : 20,
    };
  }

  let page = 1;
  let pageSize = 20;

  // Support limit/offset style (convert to page/pageSize)
  if (typeof params.limit === 'number' && params.limit > 0) {
    pageSize = params.limit;
    if (typeof params.offset === 'number' && params.offset >= 0) {
      page = Math.floor(params.offset / params.limit) + 1;
    }
  }

  // Support flat page/pageSize (overrides limit/offset if both present)
  if (typeof params.page === 'number' && params.page > 0) {
    page = params.page;
  }
  if (typeof params.pageSize === 'number' && params.pageSize > 0) {
    pageSize = params.pageSize;
  }

  return { page, pageSize };
}

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
}

/**
 * Export package structure for element import/export operations
 */
interface ExportPackage {
  exportVersion: string;
  exportedAt: string;
  elementType: string;
  elementName?: string;
  format: 'json' | 'yaml';
  data: string;
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
  /**
   * Issue #656: Per-memory save debounce timers.
   * When addEntry is called rapidly, we coalesce saves — only the latest
   * state is written to disk after the debounce window expires.
   * Key: normalized memory name, Value: { timer, memory, manager }
   */
  private readonly pendingSaves = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    memory: import('../../elements/memories/Memory.js').Memory;
    manager: MemoryManager;
  }>();
  /** Issue #656: Debounce metrics — tracks saves coalesced vs actually written. */
  private readonly debounceMetrics = { coalesced: 0, written: 0 };
  /**
   * Issue #657: Per-memory save frequency tracker.
   * Sliding window counter: tracks addEntry calls per memory within the monitor window.
   * Logs warnings at configurable thresholds to catch runaway loops early.
   */
  private readonly saveFrequencyCounters = new Map<string, { timestamps: number[]; warned: boolean; critical: boolean }>();
  /** Issue #1947: Per-session rate limiters (prevents cross-session rate limit exhaustion) */
  private readonly permissionPromptLimiters = new Map<string, import('../../utils/RateLimiter.js').RateLimiter>();
  private readonly cliApprovalLimiters = new Map<string, import('../../utils/RateLimiter.js').RateLimiter>();
  /**
   * Build a standardized rate-limit deny response for permission_prompt.
   */
  private buildRateLimitDeny(
    limiterName: string,
    toolName: string,
    status: import('../../utils/RateLimiter.js').RateLimitStatus,
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
  private readonly executingAgents = new Map<string, {
    /** Agent element name (matches the Map key) */
    name: string;
    /** Metadata containing the resolved gatekeeper policy */
    metadata: Record<string, unknown>;
    /** Timestamp when execution started (for diagnostics) */
    startedAt: number;
    /** Resilience tracking: number of auto-continuations performed (Issue #526) */
    continuationCount: number;
    /** Resilience tracking: number of retries for the current step (Issue #526) */
    retryCount: number;
    /** Resilience tracking: original parameters from execute_agent (Issue #526) */
    originalParameters?: Record<string, unknown>;
    /** Resilience tracking: resolved policy from agent metadata (Issue #526) */
    resiliencePolicy?: AgentResiliencePolicy;
    /** Recent gatekeeper blocks during this agent's execution (Agent Notification System) */
    recentBlocks: Array<{
      operation: string;
      elementType?: string;
      reason: string;
      /** Permission level that caused the block (DENY, CONFIRM_SESSION, CONFIRM_SINGLE_USE) */
      level: string;
      timestamp: string;
      /** Whether this block has been reported in a notification */
      reported: boolean;
    }>;
  }>();

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

  private resolvePermissionPromptLimiter(): import('../../utils/RateLimiter.js').RateLimiter {
    return this.resolveSessionScoped(this.permissionPromptLimiters, () =>
      RateLimiterFactory.createPermissionPromptLimiter(
        env.DOLLHOUSE_PERMISSION_PROMPT_RATE_LIMIT, env.DOLLHOUSE_PERMISSION_RATE_WINDOW_MS
      ));
  }

  private resolveCliApprovalLimiter(): import('../../utils/RateLimiter.js').RateLimiter {
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

    // Clear pending save timers and remove entries
    for (const [key, entry] of this.pendingSaves) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        this.pendingSaves.delete(key);
      }
    }

    // Remove session-keyed entries from tracking collections
    this.deleteByPrefix(this.executingAgents, prefix);
    this.deleteByPrefix(this.saveFrequencyCounters, prefix);
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
        // Provide specific diagnostics depending on what went wrong
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

      const { operation, elementType, params } = parsedInput;

      // Step 2: Enforce Gatekeeper policy (Issue #452)
      if (env.DOLLHOUSE_GATEKEEPER_ENABLED) {
        // Full 4-layer check: route validation → element policies → session confirmations → defaults
        // Issue #758: Gatekeeper infrastructure operations (confirm_operation, verify_challenge, etc.)
        // skip element policy evaluation in the primary enforcement path to prevent cascading
        // confirmation loops. Element policies for the TARGET operation are evaluated separately
        // inside the confirm handler, and deny: ['confirm_operation'] is enforced as a sandbox.
        const activeElements = await this.getActiveElements();
        const decision = this.gatekeeper.enforce({
          operation,
          endpoint,
          elementType,
          activeElements,
          skipElementPolicies: isGatekeeperInfraOperation(operation),
        });

        // Record Gatekeeper decision for metrics
        this.handlers.gatekeeperMetricsTracker?.record({
          allowed: decision.allowed,
          permissionLevel: decision.permissionLevel,
          policySource: decision.policySource,
          confirmationPending: decision.confirmationPending,
        });

        if (!decision.allowed) {
          if (decision.confirmationPending) {
            // Issue #1653: Auto-confirm when the host (Claude Code, etc.) has already
            // approved this MCP tool call. The host's tool-level approval is the primary
            // human gate; the gatekeeper's confirm_operation round-trip is redundant when
            // the host gates every call.
            //
            // Safety layers that remain active (proven by permission-flow-harness tests):
            // - Element deny policies (hard deny, no confirmationPending flag)
            // - canBeElevated: false constraints
            // - Safety tier evaluation (runs before confirmation check)
            // - DangerZone verification (separate flow)
            //
            // The confirmation is recorded in the session so subsequent enforce() calls
            // for the same operation pass without re-confirming.
            const confirmLevel = decision.permissionLevel as
              PermissionLevel.CONFIRM_SESSION | PermissionLevel.CONFIRM_SINGLE_USE;

            // Risk scoring for destructive/high-impact operations.
            // Assigns a risk score (0-100) based on operation characteristics.
            // This is the MCP-AQL equivalent of assessRisk() for CLI tools.
            const riskScore = this.scoreOperationRisk(operation, endpoint, params);

            this.gatekeeper.recordConfirmation(operation, confirmLevel, elementType);

            // Build and log a detailed summary for session review.
            // Even though no human is prompted, this appears in query_logs
            // so operators can trace what was auto-confirmed and why.
            const summary = this.buildOperationSummary(operation, elementType, params);
            const scope = elementType ? ' ['.concat(elementType, ']') : '';
            let riskLabel = 'LOW';
            if (riskScore >= 80) riskLabel = 'HIGH';
            else if (riskScore >= 40) riskLabel = 'MODERATE';
            const parts = ['[Gatekeeper] Auto-confirmed (', riskLabel, ' risk=', String(riskScore),
              '): ', summary, scope, '. Reason: ', decision.reason];
            const logMessage = parts.join('');

            // CONFIRM_SINGLE_USE operations (delete, execute_agent, edit, abort)
            // are higher-risk — log at warn level for visibility in audit trails.
            if (confirmLevel === PermissionLevel.CONFIRM_SINGLE_USE) {
              logger.warn(logMessage);
            } else {
              logger.debug(logMessage);
            }
          } else {
            // Hard deny — operation is blocked by policy, no confirmation can help
            this.recordGatekeeperBlockForAgents(operation, elementType, decision.reason ?? 'Operation blocked by policy', decision.permissionLevel);
            throw new Error(`[Gatekeeper] ${decision.reason}`);
          }
        }

        // Issue #673: Protect gatekeeper policy fields from element-policy elevation.
        // edit_element is elevatable for normal fields (description, tags, etc.), but
        // editing gatekeeper policies always requires explicit user confirmation.
        // This prevents an element from auto-approving changes to security policies
        // on other elements (the primary privilege escalation vector).
        if (
          operation === 'edit_element' &&
          decision.policySource === 'element_policy' &&
          decision.permissionLevel === PermissionLevel.AUTO_APPROVE &&
          params
        ) {
          const inputObj = (params as Record<string, unknown>).input as Record<string, unknown> | undefined;
          const hasGatekeeperField =
            inputObj?.gatekeeper !== undefined ||
            (inputObj?.metadata as Record<string, unknown> | undefined)?.gatekeeper !== undefined;

          if (hasGatekeeperField) {
            logger.warn(`[MCPAQLHandler] Gatekeeper policy edit blocked from element-policy elevation — requires explicit confirmation`, {
              operation,
              elementType,
              policySource: decision.policySource,
            });
            return this.failure(
              `Editing gatekeeper policies requires explicit user confirmation and cannot be auto-approved by element policies. ` +
              `Use confirm_operation with params { operation: "edit_element"${elementType ? `, element_type: "${elementType}"` : ''} } to approve, then retry.`,
              startTime
            );
          }
        }
      } else {
        // Gatekeeper disabled — fall back to route validation only
        Gatekeeper.validate(operation, endpoint);
      }

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
      const data = this.applyFieldSelection(rawData, params as Record<string, unknown>);

      // Step 6: Log successful operation — only mutations are security-relevant
      if (endpoint !== 'READ') {
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
            parameterKeys: params ? Object.keys(params as Record<string, unknown>) : [],
          }
        });
      }
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

      // Log security events with appropriate severity
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
      return this.failure(message, startTime);
    }
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

    // ElementCRUD operations
    if (module === 'ElementCRUD') {
      return this.dispatchElementCRUD(method, input);
    }

    // Memory operations
    if (module === 'Memory') {
      return this.dispatchMemory(method, params as Record<string, unknown>);
    }

    // Agent operations
    if (module === 'Agent') {
      return this.dispatchAgent(method, params as Record<string, unknown>);
    }

    // Template operations
    if (module === 'Template') {
      return this.dispatchTemplate(method, params as Record<string, unknown>);
    }

    // Activation operations (cross-cutting concern)
    if (module === 'Activation') {
      return this.dispatchActivation(method, input);
    }

    // Search operations
    if (module === 'Search') {
      return this.dispatchSearch(method, input);
    }

    // NOTE: UnifiedSearch operations (Issue #243) are now schema-driven
    // via SchemaDispatcher with the 'searchParams' normalizer.
    // See PORTFOLIO_OPERATIONS.search in OperationSchema.ts

    // Introspection operations
    if (module === 'Introspection') {
      return this.dispatchIntrospection(method, params as Record<string, unknown>);
    }

    // Collection operations (Issue #241)
    if (module === 'Collection') {
      return this.dispatchCollection(method, params as Record<string, unknown>);
    }

    // Portfolio operations (Issue #241)
    if (module === 'Portfolio') {
      return this.dispatchPortfolio(method, params as Record<string, unknown>);
    }

    // Auth operations (Issue #241)
    if (module === 'Auth') {
      return this.dispatchAuth(method, params as Record<string, unknown>);
    }

    // Config operations (Issue #241)
    if (module === 'Config') {
      return this.dispatchConfig(method, params as Record<string, unknown>);
    }

    // EnhancedIndex operations (Issue #241)
    if (module === 'EnhancedIndex') {
      return this.dispatchEnhancedIndex(method, params as Record<string, unknown>);
    }

    // Persona operations (Issue #241)
    if (module === 'Persona') {
      return this.dispatchPersona(method, params as Record<string, unknown>);
    }

    // Execute operations (Issue #244 - CRUDE)
    if (module === 'Execute') {
      return this.dispatchExecute(method, params as Record<string, unknown>);
    }

    // Gatekeeper operations (Issue #452 - confirmation flow)
    if (module === 'Gatekeeper') {
      return this.dispatchGatekeeper(method, params as Record<string, unknown>);
    }

    // Logging operations (Issue #528 - CRUDE migration)
    if (module === 'Logging') {
      return this.dispatchLogging(method, params as Record<string, unknown>);
    }

    // Metrics operations (CRUDE-routed query_metrics)
    if (module === 'Metrics') {
      return this.dispatchMetrics(method, params as Record<string, unknown>);
    }

    // Browser operations (Issue #774: open portfolio browser)
    if (module === 'Browser') {
      return this.dispatchBrowser(method, params as Record<string, unknown>);
    }

    throw new Error(`Unknown handler module: ${module}`);
  }

  /**
   * Dispatch ElementCRUD operations to ElementCRUDHandler
   */
  private async dispatchElementCRUD(
    method: string,
    input: OperationInput
  ): Promise<unknown> {
    const { elementType, params } = input;
    const handler = this.handlers.elementCRUD;
    const p = params as Record<string, unknown>;

    switch (method) {
      case 'create': {
        // Issue #278: For ensembles, merge top-level elements into metadata
        // LLMs often pass elements at params level, not inside metadata
        const resolvedType = elementType || (p.type as string);
        let metadata = p.metadata as Record<string, unknown> | undefined;

        // Check for ensemble type (handles both plural constant and singular form)
        const isEnsemble = resolvedType === ElementType.ENSEMBLE || resolvedType === 'ensemble';
        if (isEnsemble) {
          // Issue #365: Recognize common synonyms for 'elements' (members, components, items)
          const synonyms = ['members', 'components', 'items'] as const;
          const elementsSource = p.elements || synonyms.reduce<unknown>(
            (found, syn) => found || p[syn], undefined
          );
          if (elementsSource && (!metadata || !metadata.elements)) {
            metadata = { ...metadata, elements: elementsSource };
          }
        }

        // Issue #602: 'instructions' is no longer an API field. Use 'content' for all types.
        // If an LLM sends 'instructions', pass it through so createElement can reject with guidance.
        return handler.createElement({
          name: p.name as string,
          type: resolvedType,
          description: p.description as string,
          content: p.content as string | undefined,
          instructions: p.instructions as string | undefined,  // Rejected with guidance in createElement
          metadata,
        });
      }

      case 'list':
        return handler.listElements(
          elementType || (p.type as string),
          p as Record<string, unknown>
        );

      case 'get':
        return handler.getElementDetails(
          p.name as string,
          elementType || (p.type as string)
        );

      // Issue #738: Currently shares code path with 'get'. Future divergence point —
      // 'getDetails' will return extended metadata (relationship graph, stack membership,
      // policy resolution, activation state, reverse dependencies).
      case 'getDetails':
        return handler.getElementDetails(
          p.name as string,
          elementType || (p.type as string)
        );

      case 'edit':
        return handler.editElement({
          name: p.name as string,
          type: elementType || (p.type as string),
          input: p.input as Record<string, unknown>,
        });

      case 'validate':
        return handler.validateElement({
          name: p.name as string,
          type: elementType || (p.type as string),
          strict: p.strict as boolean | undefined,
        });

      case 'delete':
        return handler.deleteElement({
          name: p.name as string,
          type: elementType || (p.type as string),
          deleteData: p.deleteData as boolean | undefined,
        });

      case 'import':
        return this.handleImportElement(p);

      case 'export':
        return this.handleExportElement(
          p.name as string,
          elementType || (p.type as string),
          (p.format as 'json' | 'yaml') || 'json'
        );

      default:
        throw new Error(`Unknown ElementCRUD method: ${method}`);
    }
  }

  /**
   * Handle element import operation.
   * Parses export package, deserializes element data, and creates the element.
   *
   * @param params - Operation parameters containing data and optional overwrite flag
   * @returns Promise resolving to created element
   * @throws Error if export package is invalid or element already exists (when overwrite is false)
   */
  private async handleImportElement(params: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.elementCRUD;

    // Parse export package (can be string or already-parsed object)
    let exportPackage: ExportPackage;
    if (typeof params.data === 'string') {
      try {
        exportPackage = JSON.parse(params.data) as ExportPackage;
      } catch (error) {
        throw new Error(`Invalid export package: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (typeof params.data === 'object' && params.data !== null) {
      exportPackage = params.data as ExportPackage;
    } else {
      throw new Error('Invalid export package: data parameter must be a string or object');
    }

    // Validate export package structure with detailed missing field reporting
    const requiredFields = ['exportVersion', 'elementType', 'format', 'data'] as const;
    const missingFields = requiredFields.filter(
      (field) => !exportPackage[field as keyof ExportPackage]
    );
    if (missingFields.length > 0) {
      throw new Error(`Invalid export package: missing fields: ${missingFields.join(', ')}`);
    }

    // Deserialize element data based on format
    let elementData: Record<string, unknown>;
    try {
      if (exportPackage.format === 'json') {
        elementData = JSON.parse(exportPackage.data) as Record<string, unknown>;
      } else if (exportPackage.format === 'yaml') {
        // SECURITY: Use JSON_SCHEMA for pure YAML parsing (prevents code execution)
        // JSON_SCHEMA = FAILSAFE + bool/int/float/null (safer than DEFAULT which adds timestamps)
        const parsed = yaml.load(exportPackage.data, { schema: yaml.JSON_SCHEMA });
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('Invalid YAML data: expected object');
        }
        elementData = parsed as Record<string, unknown>;
      } else {
        throw new Error(`Unsupported format: ${exportPackage.format}`);
      }
    } catch (error) {
      throw new Error(`Failed to deserialize element data: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Extract element fields
    const name = elementData.name as string;
    const description = elementData.description as string;
    const content = elementData.content as string | undefined;
    const metadata = elementData.metadata as Record<string, unknown> | undefined;

    if (!name || !description) {
      throw new Error('Invalid element data: missing required fields (name, description)');
    }

    // Check if overwrite is allowed
    const overwrite = params.overwrite === true;

    // If not overwriting, check if element exists
    if (!overwrite) {
      try {
        await handler.getElementDetails(name, exportPackage.elementType);
        // If we reach here, element exists
        throw new Error(`Element already exists: ${name}. Use overwrite:true to replace it.`);
      } catch (error) {
        // Element doesn't exist, or error getting details - proceed with creation
        if (error instanceof Error && error.message.includes('already exists')) {
          throw error; // Re-throw our own "already exists" error
        }
        // Otherwise, element doesn't exist - continue
      }
    }

    // Create the element (will overwrite if it exists)
    return handler.createElement({
      name,
      type: exportPackage.elementType,
      description,
      content,
      metadata,
    });
  }

  /**
   * Export an element to JSON or YAML format
   *
   * @param name - Element name to export
   * @param type - Element type (persona, skill, template, agent, memory, ensemble)
   * @param format - Export format: 'json' or 'yaml' (default: 'json')
   * @returns ExportPackage with serialized element data
   */
  private async handleExportElement(
    name: string,
    type: string,
    format: 'json' | 'yaml' = 'json'
  ): Promise<ExportPackage> {
    // Validate required parameters
    if (!name) {
      throw new Error('Export operation requires name parameter');
    }
    if (!type) {
      throw new Error('Export operation requires type parameter (via elementType or params.type)');
    }

    // Get element details using existing handler
    const elementDetails = await this.handlers.elementCRUD.getElementDetails(name, type);

    // Build export package
    const exportPackage: ExportPackage = {
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      elementType: type,
      elementName: name,
      format,
      data: '',
    };

    // Serialize to requested format
    if (format === 'yaml') {
      exportPackage.data = yaml.dump(elementDetails, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
      });
    } else {
      exportPackage.data = JSON.stringify(elementDetails, null, 2);
    }

    return exportPackage;
  }

  /**
   * Dispatch Memory operations to MemoryManager
   *
   * Memory operations work on individual Memory instances:
   * 1. Get the Memory by name from MemoryManager
   * 2. Call the operation on the Memory instance
   */

  /**
   * Issue #656: Debounce memory saves to prevent file descriptor exhaustion.
   * Coalesces rapid addEntry calls — only writes the latest state after the window expires.
   */
  private debouncedMemorySave(
    memoryName: string,
    memory: import('../../elements/memories/Memory.js').Memory,
    manager: MemoryManager,
  ): void {
    const key = this.sessionKey(memoryName.toLowerCase());
    const existing = this.pendingSaves.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.debounceMetrics.coalesced++;
      logger.debug(`[MCPAQLHandler] Coalesced save for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
    }
    const debounceMs = STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      this.pendingSaves.delete(key);
      this.debounceMetrics.written++;
      logger.debug(`[MCPAQLHandler] Flushing debounced save for memory '${memoryName}' (coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
      manager.save(memory).catch((err) => {
        logger.error(`[MCPAQLHandler] Debounced save failed for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written}): ${err}`);
      });
    }, debounceMs);
    // Ensure timer doesn't keep Node process alive (important for tests/shutdown)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
    this.pendingSaves.set(key, { timer, memory, manager });
  }

  /**
   * Issue #657: Track addEntry call frequency per memory and log warnings at thresholds.
   *
   * Uses a sliding window counter to detect runaway save loops before they exhaust resources.
   * Counters are bounded: max 500 tracked memories, oldest-first eviction when exceeded.
   * Warning/critical flags auto-reset when frequency drops below thresholds.
   *
   * @param memoryName - Name of the memory being written to
   */
  private trackSaveFrequency(memoryName: string): void {
    const key = this.sessionKey(memoryName.toLowerCase());
    const now = Date.now();
    const windowMs = STORAGE_LAYER_CONFIG.MEMORY_SAVE_MONITOR_WINDOW_MS;
    const warnThreshold = STORAGE_LAYER_CONFIG.MEMORY_SAVE_FREQUENCY_WARN_THRESHOLD;
    const criticalThreshold = STORAGE_LAYER_CONFIG.MEMORY_SAVE_FREQUENCY_CRITICAL_THRESHOLD;

    let counter = this.saveFrequencyCounters.get(key);
    if (!counter) {
      // Evict oldest entry if map exceeds size limit (prevents unbounded growth)
      if (this.saveFrequencyCounters.size >= 500) {
        const oldestKey = this.saveFrequencyCounters.keys().next().value;
        if (oldestKey) this.saveFrequencyCounters.delete(oldestKey);
      }
      counter = { timestamps: [], warned: false, critical: false };
      this.saveFrequencyCounters.set(key, counter);
    }

    // Prune timestamps outside the window
    const cutoff = now - windowMs;
    counter.timestamps = counter.timestamps.filter(t => t > cutoff);
    counter.timestamps.push(now);

    const count = counter.timestamps.length;

    if (count >= criticalThreshold && !counter.critical) {
      counter.critical = true;
      logger.error('[MCPAQLHandler] Save frequency critical threshold exceeded', {
        memoryName,
        count,
        threshold: criticalThreshold,
        windowSeconds: windowMs / 1000,
        trackedMemories: this.saveFrequencyCounters.size,
      });
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'HIGH',
        source: 'MCPAQLHandler.trackSaveFrequency',
        details: `Memory '${memoryName}' exceeds critical save frequency: ${count} calls in ${windowMs / 1000}s`,
        additionalData: { memoryName, count, threshold: criticalThreshold, windowMs },
      });
    } else if (count >= warnThreshold && !counter.warned) {
      counter.warned = true;
      logger.warn('[MCPAQLHandler] Save frequency warn threshold exceeded', {
        memoryName,
        count,
        threshold: warnThreshold,
        windowSeconds: windowMs / 1000,
      });
    }

    // Reset warning flags when count drops back below thresholds
    if (count < warnThreshold) {
      counter.warned = false;
      counter.critical = false;
    }
  }

  /**
   * Issue #656: Flush all pending debounced saves on shutdown.
   * Called by DI container dispose chain to ensure no data is lost.
   */
  async dispose(): Promise<void> {
    await this.flushPendingSaves();
  }

  /**
   * Issue #656: Flush all pending debounced saves immediately.
   */
  async flushPendingSaves(): Promise<void> {
    const pending = [...this.pendingSaves.entries()];
    this.pendingSaves.clear();
    if (pending.length > 0) {
      logger.info(`[MCPAQLHandler] Flushing ${pending.length} pending memory save(s) on shutdown (total coalesced: ${this.debounceMetrics.coalesced}, total written: ${this.debounceMetrics.written})`);
    }
    for (const [key, { timer, memory, manager }] of pending) {
      clearTimeout(timer);
      try {
        await manager.save(memory);
        this.debounceMetrics.written++;
      } catch (err) {
        const entryCount = typeof memory.getEntries === 'function' ? memory.getEntries().size : 'unknown';
        logger.error(`[MCPAQLHandler] Flush save failed for memory '${key}' (entries: ${entryCount}, pending remaining: ${pending.length}): ${err}`);
      }
    }
  }

  private async dispatchMemory(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const manager = this.handlers.memoryManager;
    // Issue #290: Use element_name parameter
    // Issue #323: Use shared validation utility
    const memoryName = validateRequiredString(
      params,
      'element_name',
      'the name of the memory to operate on'
    );

    // Get the memory instance by name using find()
    // Memory name is stored in metadata.name
    const memory = await manager.find(m => m.metadata.name === memoryName);
    if (!memory) {
      throw new Error(`Memory '${memoryName}' not found. Use list_elements to see available memories.`);
    }

    switch (method) {
      case 'addEntry': {
        // Fix #387: Accept 'entry' as alias for 'content'
        if (params.entry !== undefined && params.content === undefined) {
          params.content = params.entry;
        }
        // Memory.addEntry(content, tags?, metadata?)
        // Fix #387 Option D: Contextual error message guiding toward correct parameter
        if (params.content === undefined || params.content === null || typeof params.content !== 'string' || (params.content as string).trim() === '') {
          const hint = params.entry !== undefined
            ? `You passed 'entry', but an entry is the full object (content + tags + metadata + timestamp). ` +
              `Use 'content' to provide the text portion of the entry.`
            : `The 'content' parameter is the text portion of the memory entry.`;
          throw new Error(
            `Missing required parameter 'content'. ${hint} ` +
            `Example: { operation: "addEntry", params: { element_name: "${memoryName}", content: "your text here", tags: ["optional"] } }`
          );
        }
        const content = params.content as string;
        const tags = params.tags as string[] | undefined;
        const metadata = params.metadata as Record<string, unknown> | undefined;
        const entryResult = memory.addEntry(content, tags, metadata);
        // Issue #657: Track save frequency and alert on anomalous patterns.
        this.trackSaveFrequency(memoryName);
        // Issue #656: Debounce saves to prevent FD exhaustion from rapid addEntry calls.
        // The entry is already in memory — disk write is deferred and coalesced.
        this.debouncedMemorySave(memoryName, memory, manager);
        return entryResult;
      }

      case 'clear': {
        // Memory.clearAll(confirm) - requires explicit confirmation
        const clearResult = memory.clearAll(true);
        // Fix #438: Persist to disk so cleared state survives restart
        await manager.save(memory);
        return clearResult;
      }

      default:
        throw new Error(`Unknown Memory method: ${method}`);
    }
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
    const { elementType, params } = input;
    const queryService = this.handlers.elementQueryService;

    switch (method) {
      case 'search':
        return this.handleSearchElements(input);

      case 'query': {
        // Validate elementType is required for query
        if (!elementType) {
          throw new Error('elementType is required for query_elements operation');
        }

        // Get raw elements of the specified type (cast to IElement[] for query service)
        const elements = (await this.handlers.elementCRUD.getElements(elementType)) as IElement[];

        // Build QueryOptions from params
        const p = params as Record<string, unknown>;
        const queryOptions: {
          filters?: Record<string, unknown>;
          sort?: Record<string, unknown>;
          pagination?: Record<string, unknown>;
          aggregate?: Record<string, unknown>;
        } = {};

        if (p.filters) {
          queryOptions.filters = p.filters as Record<string, unknown>;
        }
        if (p.sort) {
          queryOptions.sort = p.sort as Record<string, unknown>;
        }
        if (p.pagination) {
          queryOptions.pagination = p.pagination as Record<string, unknown>;
        }

        // Handle aggregation requests (Issue #309) — delegates to shared AggregationService
        if (p.aggregate) {
          const aggregate = p.aggregate as { count?: boolean; group_by?: string };

          // Validate aggregation options
          const aggError = validateAggregationOptions(aggregate);
          if (aggError) {
            throw new Error(aggError);
          }

          return aggregateElements(
            elements,
            elementType,
            aggregate,
            queryOptions.filters as any
          );
        }

        // Issue #500: Normalize flat pagination params (pageSize, page, limit, offset)
        // This ensures flat params like { pageSize: 5 } work the same as { pagination: { pageSize: 5 } }
        const normalizedPagination = normalizePaginationParams(p);
        queryOptions.pagination = normalizedPagination;

        // Execute query with ElementQueryService
        const queryResult = queryService.query(elements, queryOptions);

        // Return concise structured response (Issue #299)
        return {
          items: queryResult.items.map((item: IElement) => ({
            name: item.metadata?.name || 'Unknown',
            description: item.metadata?.description || '',
            type: elementType,
            version: item.metadata?.version || item.version,
            tags: item.metadata?.tags,
          })),
          pagination: queryResult.pagination,
          sorting: queryResult.sorting,
          filters: queryResult.filters.applied.count > 0 ? { applied: queryResult.filters.applied } : undefined,
          element_type: elementType,
        };
      }

      default:
        throw new Error(`Unknown Search method: ${method}`);
    }
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

  /**
   * Search elements across one or all element types
   *
   * Implements simple case-insensitive substring matching on:
   * - metadata.name
   * - metadata.description
   * - content (if available)
   *
   * @param input - Operation input with optional elementType and search params
   * @returns Search results with matched elements and relevance info
   */
  private async handleSearchElements(input: OperationInput): Promise<unknown> {
    const searchStart = performance.now();
    const memoryBefore = process.memoryUsage().heapUsed;
    const { elementType, params } = input;
    const p = params as Record<string, unknown>;
    const query = (p.query as string)?.trim();

    // Issue #500: Normalize flat pagination params (pageSize, page, limit, offset)
    const { page, pageSize } = normalizePaginationParams(p);

    // Extract sort params
    const sortParam = p.sort as { sortBy?: string; sortOrder?: string } | undefined;
    const sortBy = sortParam?.sortBy ?? 'name';
    const sortOrder = (sortParam?.sortOrder ?? 'asc') as 'asc' | 'desc';

    // Input validation with length limit
    if (!query) {
      throw new Error('Search query is required');
    }
    if (query.length > 1000) {
      throw new Error('Search query must be under 1000 characters');
    }

    // Determine which element types to search (Issue #433: accept singular forms)
    let elementTypes: string[];
    if (elementType) {
      const normalized = normalizeElementType(elementType);
      if (!normalized) {
        throw new Error(`Invalid element type '${elementType}'. Valid types: ${formatElementTypesList()}`);
      }
      elementTypes = [normalized];
    } else {
      elementTypes = [...ALL_ELEMENT_TYPES];
    }

    const allResults: Array<{
      type: string;
      name: string;
      description: string;
      matchedIn: string[];
    }> = [];

    // Collect ALL matches (no early termination — pagination handles limiting)
    for (const type of elementTypes) {
      try {
        const elements = await this.handlers.elementCRUD.getElements(type);

        for (const element of elements as Array<Record<string, unknown>>) {
          const matchedIn: string[] = [];
          const metadata = (element.metadata as Record<string, unknown>) || {};

          // Check name match
          const name = (metadata.name as string) || '';
          if (name && isSearchMatch(query, name)) {
            matchedIn.push('name');
          }

          // Check description match
          const description = (metadata.description as string) || '';
          if (description && isSearchMatch(query, description)) {
            matchedIn.push('description');
          }

          // Check content match (if available)
          if (element.content && typeof element.content === 'string') {
            if (isSearchMatch(query, element.content as string)) {
              matchedIn.push('content');
            }
          }

          // If any matches found, add to results
          // Use 'name' here — FIELD_TRANSFORMS will rename to 'element_name' in applyFieldSelection
          if (matchedIn.length > 0) {
            allResults.push({
              type,
              name,
              description,
              matchedIn,
            });
          }
        }
      } catch (error) {
        // Skip element types that fail to load
        logger.debug(`Failed to load elements for search: ${type}`, { error });
      }
    }

    // Record search metrics via PerformanceMonitor
    this.handlers.performanceMonitor?.recordSearch({
      query,
      duration: performance.now() - searchStart,
      resultCount: allResults.length,
      sources: elementTypes,
      cacheHit: false,
      memoryBefore,
      memoryAfter: process.memoryUsage().heapUsed,
      timestamp: new Date(),
    });

    // Sort results (currently only 'name' is supported as a sort field)
    const sortedResults = [...allResults].sort((a, b) => {
      const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return sortOrder === 'desc' ? -cmp : cmp;
    });

    // Paginate via PaginationService
    const paginator = new PaginationService();
    const paginated = paginator.paginate(sortedResults, { page, pageSize });

    return {
      items: paginated.items,
      pagination: paginated.pagination,
      sorting: { sortBy, sortOrder },
      query,
    };
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
    switch (method) {
      case 'manage': {
        const handler = this.handlers.configHandler;
        if (!handler) {
          throw new Error('Config operations not available: ConfigHandler not configured');
        }
        return handler.handleConfigOperation({
          action: params.action as 'get' | 'set' | 'reset' | 'export' | 'import' | 'wizard',
          setting: params.setting as string | undefined,
          value: params.value,
          section: params.section as string | undefined,
          format: params.format as 'yaml' | 'json' | undefined,
          data: params.data as string | undefined,
        });
      }

      case 'getBuildInfo': {
        const service = this.handlers.buildInfoService;
        if (!service) {
          throw new Error('BuildInfo operations not available: BuildInfoService not configured');
        }
        const info = await service.getBuildInfo();
        return {
          content: [{
            type: 'text',
            text: service.formatBuildInfo(info)
          }]
        };
      }

      case 'getCacheBudgetReport': {
        const budget = this.handlers.cacheMemoryBudget;
        if (!budget) {
          throw new Error('Cache budget not available: CacheMemoryBudget not configured');
        }
        const report = budget.getReport();
        const lines: string[] = [
          '# Cache Memory Budget Report',
          '',
          `**Budget:** ${report.budgetMB} MB`,
          `**Used:** ${report.totalMemoryMB} MB (${report.utilizationPercent}%)`,
          `**Registered Caches:** ${report.caches.length}`,
          '',
        ];
        if (report.caches.length > 0) {
          lines.push('| Cache | Entries | Memory (MB) | Hit Rate | Last Activity |');
          lines.push('|-------|---------|-------------|----------|---------------|');
          for (const c of report.caches) {
            const activity = c.lastActivityMs > 0
              ? `${((Date.now() - c.lastActivityMs) / 1000).toFixed(0)}s ago`
              : 'never';
            lines.push(`| ${c.name} | ${c.entries} | ${c.memoryMB} | ${(c.hitRate * 100).toFixed(1)}% | ${activity} |`);
          }
        } else {
          lines.push('_No caches registered._');
        }
        return {
          content: [{
            type: 'text',
            text: lines.join('\n')
          }]
        };
      }

      default:
        throw new Error(`Unknown Config method: ${method}`);
    }
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
    switch (method) {
      case 'confirm': {
        const operation = validateRequiredString(
          params,
          'operation',
          'the operation name to confirm (e.g. "create_element")'
        );
        // Issue #1636: Normalize element_type to match the MCP-AQL singular form
        // used by the enforce path. Without this, scoped confirmations stored as
        // "create_element:skills" never match enforce lookups for "create_element:skill".
        const rawElementType = params.element_type as string | undefined;
        const elementType = rawElementType
          ? normalizeMCPAQLElementType(rawElementType) ?? rawElementType
          : undefined;

        // Issue #748: Build human-readable summary of what's being confirmed
        const summary = this.buildOperationSummary(operation, elementType, params);
        const activeElements = await this.getActiveElements();

        // Issue #758: Check for nuclear sandbox — deny: ['confirm_operation'] on any active element.
        // This is a hard block: the LLM cannot confirm ANY operation while the denying element
        // is active. The human must deactivate the element to restore confirmation capability.
        // This prevents automated confirm→execute loops that bypass human review.
        const denyingElement = findConfirmDenyingElement(activeElements);
        if (denyingElement) {
          logger.info(`[Gatekeeper] Sandbox active: ${denyingElement.type} "${denyingElement.name}" denies confirm_operation`, {
            blockedOperation: operation,
            elementType,
          });
          throw new Error(
            `Operation cannot be confirmed — ${denyingElement.type} "${denyingElement.name}" has sandboxed this session. ` +
            `All confirmations are blocked while this element is active. ` +
            `Deactivate the element to restore confirmation capability.`
          );
        }

        // Issue #758: Check for advisory — confirm: ['confirm_operation'] on active elements.
        // Not enforced as a gate, but surfaced to the human for awareness.
        const advisoryElements = findConfirmAdvisoryElements(activeElements);
        const advisoryNote = advisoryElements.length > 0
          ? ` Note: ${advisoryElements.map(e => `${e.type} "${e.name}"`).join(', ')} request additional scrutiny for confirmations.`
          : '';

        // Evaluate the TARGET operation's permission level with full element policies.
        // This is NOT checking confirm_operation itself (that was handled in the primary
        // enforcement path with skipElementPolicies). This checks what the target operation
        // needs so we record the right confirmation level.
        const decision = this.gatekeeper.enforce({
          operation,
          endpoint: this.getEndpointForOperation(operation),
          elementType,
          activeElements,
        });

        // If the operation doesn't actually need confirmation, inform the caller
        if (decision.allowed) {
          return {
            confirmed: true,
            message: `Operation "${operation}" is already approved (${decision.policySource ?? 'auto_approve'}). No confirmation needed.`,
            summary,
          };
        }

        if (!decision.confirmationPending) {
          // Hard deny on the target operation — confirmation won't help
          throw new Error(
            `Operation "${operation}" is denied by policy and cannot be confirmed. ${decision.reason}`
          );
        }

        // Record the confirmation in the session
        const level = decision.permissionLevel === PermissionLevel.CONFIRM_SINGLE_USE
          ? PermissionLevel.CONFIRM_SINGLE_USE
          : PermissionLevel.CONFIRM_SESSION;

        this.gatekeeper.recordConfirmation(operation, level, elementType);

        // Agent Notification System: clear matching blocks from executing agents
        for (const [, agentEntry] of this.executingAgents) {
          agentEntry.recentBlocks = agentEntry.recentBlocks.filter(
            b => b.operation !== operation || (elementType && b.elementType !== elementType)
          );
        }

        return {
          confirmed: true,
          message: `Confirmed: ${summary}.${advisoryNote}`,
          rationale: decision.reason,
          scope: elementType ? `Scoped to element type: ${elementType}` : 'All element types',
          level: level === PermissionLevel.CONFIRM_SINGLE_USE ? 'single_use' : 'session',
          summary,
        };
      }

      case 'verify': {
        // Issue #142: Verify a danger zone challenge code to unblock an agent.
        // This is step 9 of the verification flow (see autonomyEvaluator.ts header).
        //
        // Pipeline: validate params → rate limit check → UUID v4 format check →
        //           pre-check store (expired?) → verify code (wrong?) → unblock agent
        //
        // Each stage logs a distinct security event type:
        //   VERIFICATION_ATTEMPTED → VERIFICATION_FAILED (format/rate/wrong) or
        //   VERIFICATION_EXPIRED (not found) or VERIFICATION_SUCCEEDED
        this.verificationMetrics.recordAttempt();
        const attemptTimestamp = Date.now();

        const challengeId = validateRequiredString(
          params,
          'challenge_id',
          'the verification challenge ID'
        );
        const code = validateRequiredString(
          params,
          'code',
          'the verification code displayed on your screen'
        );

        // Log every verification attempt for audit trail
        SecurityMonitor.logSecurityEvent({
          type: 'VERIFICATION_ATTEMPTED',
          severity: 'MEDIUM',
          source: 'MCPAQLHandler.dispatchGatekeeper.verify',
          details: `Verification attempted for challenge ${challengeId}`,
          additionalData: { challengeId },
        });

        // Rate limiting: reject if too many recent failures
        if (this.resolveVerificationRateLimiter().isLimited()) {
          this.verificationMetrics.recordRateLimited();
          SecurityMonitor.logSecurityEvent({
            type: 'VERIFICATION_FAILED',
            severity: 'HIGH',
            source: 'MCPAQLHandler.dispatchGatekeeper.verify',
            details: `Verification rate-limited: too many failed attempts (challenge: ${challengeId})`,
            additionalData: { challengeId, reason: 'rate_limited' },
          });
          throw new VerificationError(
            GatekeeperErrorCode.VERIFICATION_FAILED,
            'Too many failed verification attempts. Please wait before trying again.'
          );
        }

        // UUID v4 format validation: reject invalid IDs before store lookup
        try {
          validateChallengeIdFormat(challengeId);
        } catch (error) {
          this.verificationMetrics.recordInvalidFormat();
          this.resolveVerificationRateLimiter().recordFailure();
          SecurityMonitor.logSecurityEvent({
            type: 'VERIFICATION_FAILED',
            severity: 'HIGH',
            source: 'MCPAQLHandler.dispatchGatekeeper.verify',
            details: `Verification rejected: invalid challenge_id format (${challengeId})`,
            additionalData: { challengeId, reason: 'invalid_format' },
          });
          throw error;
        }

        const store = this.handlers.verificationStore;
        if (!store) {
          throw new VerificationError(
            GatekeeperErrorCode.VERIFICATION_FAILED,
            'Verification system not available. Ensure the server is properly configured.'
          );
        }

        // Check if challenge exists and is not expired before attempting verify
        // This lets us distinguish "wrong code" from "expired" for granular logging
        const challengePreCheck = store.get(challengeId);
        if (!challengePreCheck) {
          // Challenge not found — either expired, already used, or never existed
          this.verificationMetrics.recordExpired();
          this.resolveVerificationRateLimiter().recordFailure();
          SecurityMonitor.logSecurityEvent({
            type: 'VERIFICATION_EXPIRED',
            severity: 'HIGH',
            source: 'MCPAQLHandler.dispatchGatekeeper.verify',
            details: `Verification failed: challenge ${challengeId} not found (expired, already used, or invalid)`,
            additionalData: { challengeId, reason: 'expired_or_not_found' },
          });
          throw new VerificationError(
            GatekeeperErrorCode.VERIFICATION_TIMEOUT,
            'Verification failed: challenge not found. It may have expired or already been used. ' +
            'Retry the blocked operation to receive a new verification code.'
          );
        }

        // Issue #1947: Check session ownership BEFORE consuming the challenge.
        // Prevents Session B from consuming Session A's one-time-use challenge.
        const preCheckSessionId = this.contextTracker?.getSessionContext?.()?.sessionId;
        const enforcerPreCheck = this.handlers.dangerZoneEnforcer;
        if (enforcerPreCheck) {
          for (const agentName of enforcerPreCheck.getBlockedAgents()) {
            const blockInfo = enforcerPreCheck.check(agentName);
            if (blockInfo.verificationId === challengeId && blockInfo.blocked) {
              // If block has sessionId, caller must match (or have a sessionId at all)
              if (blockInfo.sessionId && blockInfo.sessionId !== preCheckSessionId) {
                this.verificationMetrics.recordFailure();
                throw new VerificationError(
                  GatekeeperErrorCode.VERIFICATION_FAILED,
                  'Verification failed: this challenge belongs to a different session.'
                );
              }
              break;
            }
          }
        }

        // Verify the code (one-time use — store deletes challenge after this call)
        const valid = store.verify(challengeId, code);
        if (!valid) {
          this.verificationMetrics.recordFailure();
          const rateLimitExceeded = this.resolveVerificationRateLimiter().recordFailure();
          SecurityMonitor.logSecurityEvent({
            type: 'VERIFICATION_FAILED',
            severity: 'HIGH',
            source: 'MCPAQLHandler.dispatchGatekeeper.verify',
            details: `Verification failed for challenge ${challengeId}: incorrect code`,
            additionalData: { challengeId, reason: 'wrong_code', rateLimitExceeded },
          });
          throw new VerificationError(
            GatekeeperErrorCode.VERIFICATION_FAILED,
            'Verification failed: incorrect code. ' +
            'The code has been consumed (one-time use). ' +
            'Retry the blocked operation to receive a new verification code.'
          );
        }

        // Success — calculate time-to-verify and record metrics
        const verifyDurationMs = attemptTimestamp - (challengePreCheck.expiresAt - 5 * 60 * 1000);
        this.verificationMetrics.recordSuccess(verifyDurationMs > 0 ? verifyDurationMs : undefined);

        // Find which agent is blocked with this challengeId and unblock it
        const enforcer = this.handlers.dangerZoneEnforcer;
        if (enforcer) {
          const blockedAgents = enforcer.getBlockedAgents();
          let unblockedAgent: string | undefined;
          for (const agentName of blockedAgents) {
            const blockInfo = enforcer.check(agentName);
            if (blockInfo.verificationId === challengeId) {
              // Issue #1947: Pass sessionId to prevent cross-session unblock
              const currentSessionId = this.contextTracker?.getSessionContext?.()?.sessionId;
              const success = enforcer.unblock(agentName, challengeId, currentSessionId);
              if (success) {
                unblockedAgent = agentName;
              }
              break;
            }
          }

          if (unblockedAgent) {
            SecurityMonitor.logSecurityEvent({
              type: 'VERIFICATION_SUCCEEDED',
              severity: 'MEDIUM',
              source: 'MCPAQLHandler.dispatchGatekeeper.verify',
              details: `Verification succeeded: agent '${unblockedAgent}' unblocked (challenge: ${challengeId})`,
              additionalData: { challengeId, unblockedAgent },
            });
            return {
              verified: true,
              unblockedAgent,
              message: `Verification successful. Agent '${unblockedAgent}' has been unblocked. You may now retry the operation.`,
            };
          }
        }

        // Code was valid but no agent was found blocked with this challengeId
        // (could be a standalone verification, or block was already cleared)
        SecurityMonitor.logSecurityEvent({
          type: 'VERIFICATION_SUCCEEDED',
          severity: 'LOW',
          source: 'MCPAQLHandler.dispatchGatekeeper.verify',
          details: `Verification succeeded but no blocked agent found for challenge ${challengeId}`,
          additionalData: { challengeId },
        });
        return {
          verified: true,
          message: 'Verification successful. You may now retry the operation.',
        };
      }

      case 'beetlejuice': {
        // Issue #503: Safe-trigger the full danger zone verification pipeline.
        // Creates a challenge, stores it, and blocks an agent — all in one call.
        // Issue #522: Code is shown via OS dialog, NEVER returned to the LLM.
        const agentName = typeof params.agent_name === 'string' && params.agent_name.length > 0
          ? params.agent_name
          : 'beetlejuice-test-agent';

        const store = this.handlers.verificationStore;
        if (!store) {
          throw new Error('VerificationStore not available. Ensure the server is properly configured.');
        }
        const enforcer = this.handlers.dangerZoneEnforcer;
        if (!enforcer) {
          throw new Error('DangerZoneEnforcer not available. Ensure the server is properly configured.');
        }

        const BEETLEJUICE_CHALLENGE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes, matches default verificationTimeoutMinutes
        const challengeId = randomUUID();
        const code = generateDisplayCode();
        const expiresAt = Date.now() + BEETLEJUICE_CHALLENGE_TIMEOUT_MS;

        store.set(challengeId, { code, expiresAt, reason: 'Beetlejuice test trigger (Issue #503)' });
        // Issue #1947: Pass sessionId so only this session can verify
        const beetlejuiceSessionId = this.contextTracker?.getSessionContext?.()?.sessionId;
        enforcer.block(agentName, 'Beetlejuice test trigger', ['beetlejuice_beetlejuice_beetlejuice'], challengeId, undefined, beetlejuiceSessionId);

        // Issue #522: Show code via OS dialog (fire-and-forget, non-blocking)
        // The code is NEVER included in the MCP response — only the human sees it.
        this.handlers.verificationNotifier?.showCode(code, `Agent '${agentName}' requires verification (Beetlejuice trigger)`);

        SecurityMonitor.logSecurityEvent({
          type: 'DANGER_ZONE_TRIGGERED',
          severity: 'LOW',
          source: 'MCPAQLHandler.dispatchGatekeeper.beetlejuice',
          details: `Beetlejuice test trigger: agent '${agentName}' blocked with challenge ${challengeId}`,
          additionalData: { challengeId, agentName, testTrigger: true },
        });

        // Issue #522: Response deliberately omits code and instructions.
        // The human reads the code from the OS dialog and types it into chat.
        return {
          triggered: true,
          challenge_id: challengeId,
          agent_name: agentName,
          message: `Agent '${agentName}' is now blocked. A verification code has been displayed to the user. They must type it to proceed via verify_challenge.`,
        };
      }

      case 'permissionPrompt': {
        // Issue #625: Evaluate CLI-level permission prompts for --permission-prompt-tool
        // See: docs/architecture/PERMISSION_PROMPT_ARCHITECTURE.md for protocol details
        const toolName = validateRequiredString(
          params,
          'tool_name',
          'the tool requesting permission (e.g., "Bash", "Edit", "Write")'
        );
        const toolInputRaw = params.input;
        if (!toolInputRaw || typeof toolInputRaw !== 'object') {
          return {
            behavior: 'deny',
            message: `Missing required "input" parameter for ${toolName} tool evaluation.`,
            classification: {
              riskLevel: 'dangerous',
              reason: 'Cannot evaluate permission without tool input',
              stage: 'input_validation',
            },
          };
        }
        const toolInput = toolInputRaw as Record<string, unknown>;

        // Issue #665: Validate Bash commands have a non-empty command string
        if (toolName === 'Bash') {
          const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
          if (!command) {
            return {
              behavior: 'deny',
              message: `Missing required "command" in input for Bash tool. Cannot evaluate an empty command.`,
              classification: {
                riskLevel: 'dangerous',
                reason: 'Empty Bash command — denied by default for safety',
                stage: 'input_validation',
              },
            };
          }
        }

        // Issue #647: Capture agent_identity from Claude Code --permission-prompt-tool
        const agentIdentity = typeof params.agent_identity === 'string' ? params.agent_identity : undefined;

        // Issue #625 Phase 4: Rate limit check
        const promptRateStatus = this.resolvePermissionPromptLimiter().checkLimit();
        if (!promptRateStatus.allowed) {
          return this.buildRateLimitDeny('permission_prompt', toolName, promptRateStatus);
        }
        this.resolvePermissionPromptLimiter().consumeToken();

        // Issue #625 Phase 4: Track that permission_prompt is active (fail-safe detection)
        if (!this.gatekeeper.isPermissionPromptActive) {
          this.gatekeeper.markPermissionPromptActive();
        }

        // Stage 1: Static classification (fast path)
        const classification = classifyTool(toolName, toolInput);

        if (classification.behavior === 'allow') {
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            classification: {
              riskLevel: classification.riskLevel,
              reason: classification.reason,
              stage: 'static_classification',
            },
          };
        }
        if (classification.behavior === 'deny') {
          SecurityMonitor.logSecurityEvent({
            type: 'PERMISSION_PROMPT_DENIED',
            severity: 'MEDIUM',
            source: 'MCPAQLHandler.dispatchGatekeeper.permissionPrompt',
            details: `Permission denied for ${toolName}: ${classification.reason}`,
            additionalData: { toolName, riskLevel: classification.riskLevel, agentIdentity },
          });
          return {
            behavior: 'deny',
            message: classification.reason,
            ...(agentIdentity && { agent_identity: agentIdentity }),
            classification: {
              riskLevel: classification.riskLevel,
              reason: classification.reason,
              stage: 'static_classification',
            },
          };
        }

        // Stage 2: Active element policy check
        const activeElements = await this.getActiveElements();
        const elementDecision = evaluateCliToolPolicy(toolName, toolInput, activeElements);

        if (elementDecision.behavior === 'deny') {
          SecurityMonitor.logSecurityEvent({
            type: 'PERMISSION_PROMPT_DENIED',
            severity: 'MEDIUM',
            source: 'MCPAQLHandler.dispatchGatekeeper.permissionPrompt',
            details: `Permission denied by element policy for ${toolName}`,
            additionalData: { toolName, message: elementDecision.message, agentIdentity },
          });
          return {
            behavior: 'deny',
            message: elementDecision.message,
            ...(agentIdentity && { agent_identity: agentIdentity }),
            classification: {
              riskLevel: classification.riskLevel,
              reason: classification.reason,
              stage: 'element_policy',
            },
            policyContext: elementDecision.policyContext,
          };
        }

        // Stage 2.1: Pattern-based approval (confirmPatterns — Issue #1660)
        if (elementDecision.behavior === 'confirm') {
          const risk = assessRisk(toolName, toolInput, classification);
          const policySource = elementDecision.confirmSource || 'unknown';

          const approvalRateStatus = this.resolveCliApprovalLimiter().checkLimit();
          if (!approvalRateStatus.allowed) {
            return this.buildRateLimitDeny(
              'cli_approval', toolName, approvalRateStatus,
              classification.riskLevel, classification.reason,
            );
          }
          this.resolveCliApprovalLimiter().consumeToken();

          const approvalPolicy = resolveCliApprovalPolicy(activeElements);
          const ttlMs = approvalPolicy.ttlSeconds ? approvalPolicy.ttlSeconds * 1000 : undefined;
          const requestId = this.gatekeeper.createCliApprovalRequest(
            toolName,
            toolInput,
            classification.riskLevel,
            risk.score,
            risk.irreversible,
            elementDecision.message || `Confirmation required by element policy`,
            policySource,
            ttlMs,
          );

          return {
            behavior: 'deny',
            message: `Requires human approval. Request ID: ${requestId}. Call approve_cli_permission to authorize.`,
            classification: {
              riskLevel: classification.riskLevel,
              reason: classification.reason,
              stage: 'approval_required',
              riskScore: risk.score,
              irreversible: risk.irreversible,
            },
            approvalRequest: {
              requestId,
              toolName,
              riskLevel: classification.riskLevel,
              riskScore: risk.score,
              irreversible: risk.irreversible,
              reason: elementDecision.message || 'Confirmation required by element policy',
            },
            policyContext: elementDecision.policyContext,
          };
        }

        // Stage 2.5: Check existing CLI approval (Issue #625 Phase 3)
        const existingApproval = this.gatekeeper.checkCliApproval(toolName, toolInput);
        if (existingApproval) {
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            classification: {
              riskLevel: classification.riskLevel,
              reason: classification.reason,
              stage: 'cli_approval',
            },
            approvalContext: {
              requestId: existingApproval.requestId,
              scope: existingApproval.scope,
            },
            policyContext: elementDecision.policyContext,
          };
        }

        // Stage 2.75: Approval-required routing (Issue #625 Phase 3)
        const approvalPolicy = resolveCliApprovalPolicy(activeElements);
        if (approvalPolicy.requireApproval?.includes(classification.riskLevel as 'moderate' | 'dangerous')) {
          const risk = assessRisk(toolName, toolInput, classification);
          const policySource = activeElements
            .filter(el => el.metadata?.gatekeeper?.externalRestrictions?.approvalPolicy?.requireApproval?.length)
            .map(el => `${el.type}:${el.name}`)
            .join(', ') || 'env:DOLLHOUSE_CLI_APPROVAL_POLICY';

          // Issue #625 Phase 4: Rate limit CLI approval creation
          const approvalRateStatus = this.resolveCliApprovalLimiter().checkLimit();
          if (!approvalRateStatus.allowed) {
            return this.buildRateLimitDeny(
              'cli_approval', toolName, approvalRateStatus,
              classification.riskLevel, classification.reason,
            );
          }
          this.resolveCliApprovalLimiter().consumeToken();

          const ttlMs = approvalPolicy.ttlSeconds ? approvalPolicy.ttlSeconds * 1000 : undefined;
          const requestId = this.gatekeeper.createCliApprovalRequest(
            toolName,
            toolInput,
            classification.riskLevel,
            risk.score,
            risk.irreversible,
            `Tool '${toolName}' classified as ${classification.riskLevel}: ${classification.reason}`,
            policySource,
            ttlMs,
          );

          return {
            behavior: 'deny',
            message: `Requires human approval. Request ID: ${requestId}. Call approve_cli_permission to authorize.`,
            classification: {
              riskLevel: classification.riskLevel,
              reason: classification.reason,
              stage: 'approval_required',
              riskScore: risk.score,
              irreversible: risk.irreversible,
            },
            approvalRequest: {
              requestId,
              toolName,
              riskLevel: classification.riskLevel,
              riskScore: risk.score,
              irreversible: risk.irreversible,
              reason: classification.reason,
            },
            policyContext: elementDecision.policyContext,
          };
        }

        // Stage 3: Default — allow (permissive)
        return {
          behavior: 'allow',
          updatedInput: toolInput,
          classification: {
            riskLevel: classification.riskLevel,
            reason: classification.reason,
            stage: 'default',
          },
          policyContext: elementDecision.policyContext,
        };
      }

      case 'evaluatePermission': {
        // Evaluate CLI permission for PreToolUse hooks (all platforms)
        const { evaluatePermission } = await import('./evaluatePermission.js');
        return evaluatePermission(params, {
          permissionPromptLimiter: this.resolvePermissionPromptLimiter(),
          classifyTool,
          evaluateCliToolPolicy,
          getActiveElements: (sessionId?: string) => this.getActiveElements(sessionId),
        });
      }

      case 'getEffectiveCliPolicies': {
        // Issue #625 Phase 2: Get effective CLI permission policies
        const toolName = params.tool_name as string | undefined;
        const toolInput = (params.tool_input as Record<string, unknown>) ?? {};
        const reportSessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
        const reportingScope = params.reporting_scope === 'dashboard';

        // 1. Get all active elements
        const policyElements = reportingScope && !toolName
          ? await this.getPolicyReportElements(reportSessionId)
          : await this.getActiveElements();

        // 2. Extract externalRestrictions from each element
        const elementPolicies = policyElements.map(el => ({
          type: el.type,
          name: el.name,
          allowPatterns: el.metadata?.gatekeeper?.externalRestrictions?.allowPatterns ?? [],
          confirmPatterns: el.metadata?.gatekeeper?.externalRestrictions?.confirmPatterns ?? [],
          denyPatterns: el.metadata?.gatekeeper?.externalRestrictions?.denyPatterns ?? [],
          allowOperations: el.metadata?.gatekeeper?.allow ?? [],
          confirmOperations: el.metadata?.gatekeeper?.confirm ?? [],
          denyOperations: el.metadata?.gatekeeper?.deny ?? [],
          description: el.metadata?.gatekeeper?.externalRestrictions?.description ?? null,
          sessionIds: (el.metadata as Record<string, unknown>)?.sessionIds ?? undefined,
        }));

        // 3. Build combined view
        const combinedAllow = elementPolicies.flatMap(p => p.allowPatterns);
        const combinedConfirm = elementPolicies.flatMap(p => p.confirmPatterns);
        const combinedDeny = elementPolicies.flatMap(p => p.denyPatterns);
        const combinedAllowOperations = elementPolicies.flatMap(p => p.allowOperations);
        const combinedConfirmOperations = elementPolicies.flatMap(p => p.confirmOperations);
        const combinedDenyOperations = elementPolicies.flatMap(p => p.denyOperations);
        const hasAllowlist = combinedAllow.length > 0 || combinedAllowOperations.length > 0;

        // 4. If tool_name provided, evaluate it against current policies
        let evaluation: Record<string, unknown> | undefined = undefined;
        if (toolName) {
          const toolClassification = classifyTool(toolName, toolInput);
          const policyResult = toolClassification.behavior === 'evaluate'
            ? evaluateCliToolPolicy(toolName, toolInput, policyElements)
            : null;

          evaluation = {
            tool_name: toolName,
            tool_input: Object.keys(toolInput).length > 0 ? toolInput : undefined,
            staticClassification: {
              riskLevel: toolClassification.riskLevel,
              behavior: toolClassification.behavior,
              reason: toolClassification.reason,
            },
            elementPolicyResult: policyResult ? {
              behavior: policyResult.behavior,
              message: policyResult.message,
              policyContext: policyResult.policyContext,
            } : undefined,
            finalBehavior: policyResult?.behavior === 'deny' ? 'deny'
              : toolClassification.behavior === 'deny' ? 'deny' : 'allow',
          };
        }

        // 5. Fail-safe detection (Issue #625 Phase 4)
        const permissionPromptActive = this.gatekeeper.isPermissionPromptActive;
        const hookStatus = getPermissionHookStatus();
        const hookInstalled = hookStatus.installed;
        const enforcementReady = permissionPromptActive || hookInstalled;
        const hasCliRestrictions = combinedAllow.length > 0 || combinedDeny.length > 0 || combinedConfirm.length > 0;
        const hasOperationRestrictions = combinedAllowOperations.length > 0
          || combinedDenyOperations.length > 0
          || combinedConfirmOperations.length > 0;
        let advisory: string | undefined;
        if (hasCliRestrictions) {
          if (!enforcementReady) {
            advisory = 'Policies are loaded but NOT enforced. No permission hook detected and permission_prompt has not been called. Run open_setup and reinstall, or launch the CLI client with --permission-prompt-tool.';
          } else if (hookInstalled && !permissionPromptActive) {
            advisory = `Policies are loaded. Permission hook detected for ${hookStatus.host ?? 'a supported client'}, so enforcement depends on using that client configuration.`;
          }
        } else if (hasOperationRestrictions) {
          advisory = 'MCP-AQL operation policies are active for Dollhouse actions in this session.';
        }

        return {
          activeElementCount: policyElements.length,
          hasAllowlist,
          elements: elementPolicies,
          combinedAllowPatterns: combinedAllow,
          combinedConfirmPatterns: combinedConfirm,
          combinedDenyPatterns: combinedDeny,
          combinedAllowOperations,
          combinedConfirmOperations,
          combinedDenyOperations,
          evaluation,
          permissionPromptActive,
          hookInstalled,
          enforcementReady,
          hookHost: hookStatus.host,
          advisory,
        };
      }

      case 'approveCliPermission': {
        // Issue #625 Phase 3: Approve a pending CLI tool permission request
        const requestId = validateRequiredString(
          params,
          'request_id',
          'the approval request ID from permission_prompt deny response (format: cli-<UUID>)'
        );
        const scope = (params.scope as CliApprovalScope) ?? 'single';

        // Validate scope
        if (scope !== 'single' && scope !== 'tool_session') {
          throw new Error(`Invalid scope "${scope}". Must be "single" or "tool_session".`);
        }

        const record = this.gatekeeper.approveCliRequest(requestId, scope);
        if (!record) {
          throw new Error(`No pending approval for "${requestId}". It may have expired or already been approved.`);
        }

        return {
          approved: true,
          requestId,
          toolName: record.toolName,
          scope,
          message: scope === 'tool_session'
            ? `Approved for all uses of '${record.toolName}' this session.`
            : `Approved single use of '${record.toolName}'. Retry the tool call now.`,
        };
      }

      case 'getPendingCliApprovals': {
        // Issue #625 Phase 3: Get all pending CLI tool approval requests
        const pending = this.gatekeeper.getPendingCliApprovals();
        return {
          pending,
          count: pending.length,
        };
      }

      default:
        throw new Error(`Unknown Gatekeeper method: ${method}`);
    }
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
    const { homedir } = await import('node:os');
    const portfolioDir = homedir() + '/.dollhouse/portfolio';

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
   * Build a human-readable summary of an operation for confirmation prompts.
   * Issue #748: Natural language confirmation summaries.
   *
   * Translates raw operation names and params into plain language so users
   * understand what they're approving without parsing machine-readable payloads.
   */
  private buildOperationSummary(
    operation: string,
    elementType?: string,
    params?: Record<string, unknown>
  ): string {
    const p = params || {};
    const name = (p.element_name || p.name || '') as string;
    const typeLabel = elementType || (p.element_type as string) || 'element';

    // Operation-specific natural language templates
    switch (operation) {
      case 'create_element':
        return name
          ? `Create a new ${typeLabel} called "${name}"`
          : `Create a new ${typeLabel}`;
      case 'edit_element':
        return name
          ? `Edit the ${typeLabel} "${name}"`
          : `Edit a ${typeLabel}`;
      case 'delete_element':
        return name
          ? `Permanently delete the ${typeLabel} "${name}"`
          : `Permanently delete a ${typeLabel}`;
      case 'activate_element':
        return name
          ? `Activate the ${typeLabel} "${name}" (changes active permission surface)`
          : `Activate a ${typeLabel}`;
      case 'deactivate_element':
        return name
          ? `Deactivate the ${typeLabel} "${name}"`
          : `Deactivate a ${typeLabel}`;
      case 'execute_agent': {
        const goal = (p.goal || '') as string;
        const goalSuffix = goal ? ` with goal: ${goal}` : '';
        return name
          ? `Run the agent "${name}"${goalSuffix}`
          : `Execute an agent${goalSuffix}`;
      }
      case 'install_collection_content': {
        const path = (p.path || '') as string;
        return path
          ? `Install "${path}" from the community collection to your portfolio`
          : 'Install an element from the community collection';
      }
      case 'submit_collection_content':
        return 'Submit a local element to the community collection';
      case 'clear':
        return typeLabel !== 'element'
          ? `Clear all ${typeLabel} data`
          : 'Clear data';
      default: {
        // Fall back to operation description from schema, or formatted operation name
        // Include parameter keys so uncommon operations still provide useful context
        const schema = ALL_OPERATION_SCHEMAS[operation];
        const paramKeys = Object.keys(p).filter(k => k !== 'operation');
        const paramHint = paramKeys.length > 0 ? ` (${paramKeys.join(', ')})` : '';
        if (schema?.description) {
          return `${schema.description}${paramHint}`;
        }
        return `Perform operation: ${operation.replace(/_/g, ' ')}${paramHint}${elementType ? ` on ${elementType}` : ''}`;
      }
    }
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
    const manager = this.handlers.agentManager;

    // Issue #323: Validate element_name parameter (was incorrectly using 'name')
    // All execute operations require element_name to identify the target
    const elementName = validateRequiredString(
      params,
      'element_name',
      'the name of the agent/element to execute'
    );

    // Issue #110: Programmatic enforcement for DANGER_ZONE tier
    // Issue #402: Use DI-injected enforcer instead of singleton
    // Check if the agent is blocked due to danger zone trigger
    // Only allow 'getState' operation for blocked agents (read-only, needed for diagnostics)
    if (method !== 'getState' && this.handlers.dangerZoneEnforcer) {
      const blockCheck = this.handlers.dangerZoneEnforcer.check(elementName);
      if (blockCheck.blocked) {
        logger.warn(
          `Agent '${elementName}' blocked from executing '${method}': ${blockCheck.reason}`,
          {
            agentName: elementName,
            method,
            reason: blockCheck.reason,
          }
        );
        // Issue #405: Actionable guidance with verify_challenge instructions
        throw new Error(
          `Agent '${elementName}' is blocked due to danger zone trigger: ${blockCheck.reason}. ` +
          `${blockCheck.resolution}` +
          (blockCheck.verificationId
            ? ' Ask the human operator to read the verification code from the dialog on their screen.'
            : '')
        );
      }
    }

    // Issue #249: Reject execution operations for aborted goals.
    // Operations that modify execution state are blocked; getState and abort are allowed.
    if (method !== 'execute' && method !== 'getState' && method !== 'abort') {
      // Check if the agent's active goal has been aborted
      const agentGoalIds = await this.getActiveGoalIds(manager, elementName);
      for (const goalId of agentGoalIds) {
        if (this.abortedGoals.has(this.sessionKey(goalId))) {
          throw new Error(
            `Agent '${elementName}' execution was aborted (goalId: ${goalId}). ` +
            `Further execution operations are rejected. Use execute_agent to start a new execution.`
          );
        }
      }
    }

    switch (method) {
      case 'execute': {
        // Start execution of an agent or executable element
        const executeResult = await manager.executeAgent(
          elementName,
          params.parameters as Record<string, unknown>
        );

        // Issue #447: Validate runtime maxAutonomousSteps override
        const runtimeMaxSteps = params.maxAutonomousSteps;
        if (runtimeMaxSteps !== undefined) {
          if (typeof runtimeMaxSteps !== 'number' || !Number.isInteger(runtimeMaxSteps) || runtimeMaxSteps < 0) {
            throw new Error('maxAutonomousSteps must be a non-negative integer');
          }
        }

        // Issue #449: Track executing agent for Gatekeeper policy enforcement
        // Issue #447: Also store runtime maxAutonomousSteps override
        // Issue #526: Also store resilience policy and original parameters
        try {
          const agentElement = await manager.read(elementName);
          if (agentElement) {
            const agentMeta = agentElement.metadata as AgentMetadataV2;
            let gatekeeperPolicy = agentMeta.gatekeeper;

            // Synthesize policy from tools config if no explicit gatekeeper policy
            if (!gatekeeperPolicy && agentMeta.tools) {
              gatekeeperPolicy = translateToolConfigToPolicy(agentMeta.tools) ?? undefined;
            }

            // Issue #526: Extract resilience policy from agent metadata
            const resiliencePolicy = agentMeta.resilience;

            // Always track if there's a gatekeeper policy, runtime override, or resilience policy
            if (gatekeeperPolicy || runtimeMaxSteps !== undefined || resiliencePolicy) {
              this.executingAgents.set(this.sessionKey(elementName), {
                name: elementName,
                metadata: {
                  ...(gatekeeperPolicy ? { gatekeeper: gatekeeperPolicy } : {}),
                  ...(runtimeMaxSteps !== undefined ? { maxAutonomousSteps: runtimeMaxSteps } : {}),
                },
                startedAt: Date.now(),
                continuationCount: 0,
                retryCount: 0,
                originalParameters: params.parameters as Record<string, unknown> | undefined,
                resiliencePolicy,
                recentBlocks: [],
              });
            }
          } else if (runtimeMaxSteps !== undefined) {
            // No agent element to read, but we still need to store the override
            this.executingAgents.set(this.sessionKey(elementName), {
              name: elementName,
              metadata: { maxAutonomousSteps: runtimeMaxSteps },
              startedAt: Date.now(),
              continuationCount: 0,
              retryCount: 0,
              originalParameters: params.parameters as Record<string, unknown> | undefined,
              recentBlocks: [],
            });
          }
        } catch {
          // Non-fatal: agent executes even if tracking fails
          logger.warn('Failed to track executing agent for Gatekeeper policy', { agentName: elementName });
        }

        // Issue #125: Return structured JSON with type discriminator
        return { _type: 'ExecuteAgentResult', ...executeResult };
      }

      case 'getState': {
        // Query current execution state
        const stateResult = await manager.getAgentState({
          agentName: elementName,
          includeDecisionHistory: params.includeDecisionHistory as boolean | undefined,
          includeContext: params.includeContext as boolean | undefined,
        });
        // Issue #125: Return structured JSON with type discriminator
        return { _type: 'ExecutionState', ...stateResult };
      }

      case 'updateState': {
        // Record execution progress, step completion, or findings
        // Returns autonomy directive indicating continue/pause

        // Validate optional parameters
        const nextActionHint = params.nextActionHint;
        if (nextActionHint !== undefined && typeof nextActionHint !== 'string') {
          throw new Error('nextActionHint must be a string if provided');
        }

        const riskScore = params.riskScore;
        if (riskScore !== undefined) {
          if (typeof riskScore !== 'number' || isNaN(riskScore)) {
            throw new Error('riskScore must be a number if provided');
          }
          if (riskScore < 0 || riskScore > 100) {
            throw new Error('riskScore must be between 0 and 100');
          }
        }

        // Issue #447: Apply runtime maxAutonomousSteps override if stored for this agent
        const executingAgent = this.executingAgents.get(this.sessionKey(elementName));
        const maxStepsOverride = executingAgent?.metadata?.maxAutonomousSteps as number | undefined;

        const updateResult = await manager.recordAgentStep({
          agentName: elementName,
          stepDescription: params.stepDescription as string,
          outcome: params.outcome as 'success' | 'failure' | 'partial',
          findings: params.findings as string,
          confidence: params.confidence as number,
          nextActionHint: nextActionHint as string | undefined,
          riskScore: riskScore as number | undefined,
          maxStepsOverride,
        });

        // Issue #526: Evaluate resilience policy when autonomy says pause
        const resilienceResult = this.evaluateResilience(
          elementName,
          updateResult,
          params.outcome as string
        );

        // Agent Notification System: collect and attach notifications
        const finalResult = resilienceResult ?? updateResult;
        const autonomy = finalResult.autonomy as Record<string, unknown> | undefined;
        if (autonomy) {
          const notifications = this.collectNotifications(elementName, autonomy);
          if (notifications.length > 0) {
            autonomy.notifications = notifications;
          }
        }

        // Issue #125: Return structured JSON with type discriminator
        return { _type: 'StepResult', ...finalResult };
      }

      case 'complete': {
        // Signal execution finished successfully
        const completeResult = await manager.completeAgentGoal({
          agentName: elementName,
          outcome: params.outcome as 'success' | 'failure' | 'partial',
          summary: params.summary as string,
          goalId: params.goalId as string | undefined,
        });

        // Issue #526: Track resilience outcome and reset circuit breaker on success
        const completedAgent = this.executingAgents.get(this.sessionKey(elementName));
        if (completedAgent?.resiliencePolicy && (completedAgent.continuationCount > 0 || completedAgent.retryCount > 0)) {
          const isSuccess = params.outcome === 'success';
          this.handlers.resilienceMetrics?.recordCompletionAfterResilience(isSuccess);
          if (isSuccess) {
            this.handlers.circuitBreaker?.reset(elementName);
          }
        }

        // Issue #449: Remove agent from executing set so its policies stop applying
        this.executingAgents.delete(this.sessionKey(elementName));

        // Issue #125: Return structured JSON with type discriminator
        return { _type: 'CompletionResult', ...completeResult };
      }

      case 'continue': {
        // Resume execution from saved state
        const continueResult = await manager.continueAgentExecution({
          agentName: elementName,
          previousStepResult: params.previousStepResult as string | undefined,
          parameters: params.parameters as Record<string, unknown> | undefined,
        });
        // Issue #125: Return structured JSON with type discriminator
        return { _type: 'ContinueResult', ...continueResult };
      }

      case 'abort': {
        // Issue #249: Abort a running agent execution
        const reason = (params.reason as string) || 'Aborted by user';

        // Find the active goal for this agent
        const activeGoalIds = await this.getActiveGoalIds(manager, elementName);
        if (activeGoalIds.length === 0) {
          throw new Error(
            `No active execution found for agent '${elementName}'. ` +
            `Nothing to abort.`
          );
        }

        // Mark all active goals as aborted
        for (const goalId of activeGoalIds) {
          this.abortedGoals.add(this.sessionKey(goalId));
        }

        // Complete the agent goal with 'failure' outcome to persist the aborted state
        try {
          await manager.completeAgentGoal({
            agentName: elementName,
            outcome: 'failure',
            summary: `Execution aborted: ${reason}`,
          });
        } catch {
          // Non-fatal: goal may already be completed or agent state may be inconsistent
          logger.warn('Failed to mark aborted agent goal as failed', { agentName: elementName });
        }

        // Issue #526: Track resilience outcome (abort = failure after resilience)
        const abortedAgent = this.executingAgents.get(this.sessionKey(elementName));
        if (abortedAgent?.resiliencePolicy && (abortedAgent.continuationCount > 0 || abortedAgent.retryCount > 0)) {
          this.handlers.resilienceMetrics?.recordCompletionAfterResilience(false);
        }

        // Clean up executingAgents Map (stop Gatekeeper policy enforcement)
        this.executingAgents.delete(this.sessionKey(elementName));

        // Clean up DangerZoneEnforcer blocks for this agent
        if (this.handlers.dangerZoneEnforcer) {
          try {
            this.handlers.dangerZoneEnforcer.unblock(elementName);
          } catch {
            // Non-fatal: agent may not have been blocked
          }
        }

        SecurityMonitor.logSecurityEvent({
          type: 'AGENT_EXECUTED',
          severity: 'MEDIUM',
          source: 'MCPAQLHandler.dispatchExecute.abort',
          details: `Agent execution aborted: ${elementName} — ${reason}`,
          additionalData: {
            agentName: elementName,
            abortedGoalIds: activeGoalIds,
            reason,
          },
        });

        // Issue #125: Return structured JSON with type discriminator
        return {
          _type: 'AbortResult',
          success: true,
          agentName: elementName,
          abortedGoalIds: activeGoalIds,
          reason,
          message: `Agent '${elementName}' execution aborted. ${activeGoalIds.length} goal(s) terminated.`,
        };
      }

      case 'getGatheredData': {
        // Issue #68: Get aggregated execution data for a specific goal
        const goalId = params.goalId;
        if (typeof goalId !== 'string' || !goalId) {
          throw new Error('goalId is required for get_gathered_data');
        }
        const gatheredData = await manager.getGatheredData({
          agentName: elementName,
          goalId: goalId as string,
        });
        return { _type: 'GatheredData', ...gatheredData };
      }

      case 'prepareHandoff': {
        // Issue #69: Prepare a handoff state for session transfer
        const handoffGoalId = params.goalId;
        if (typeof handoffGoalId !== 'string' || !handoffGoalId) {
          throw new Error('goalId is required for prepare_handoff');
        }

        // Get gathered data for the goal
        const handoffGatheredData = await manager.getGatheredData({
          agentName: elementName,
          goalId: handoffGoalId,
        });

        // Read agent metadata for active elements and success criteria
        let activeElements: Record<string, string[]> = {};
        let successCriteria: string[] = [];
        try {
          const agentElement = await manager.read(elementName);
          if (agentElement) {
            const meta = agentElement.metadata as AgentMetadataV2;
            if (meta.activates) {
              activeElements = { ...meta.activates } as Record<string, string[]>;
            }
            successCriteria = meta.goal?.successCriteria || [];
          }
        } catch {
          // Non-fatal: proceed with defaults
        }
        // Always include the agent itself
        if (!activeElements['agents']) {
          activeElements['agents'] = [];
        }
        if (!activeElements['agents'].includes(elementName)) {
          activeElements['agents'].push(elementName);
        }

        // Build the handoff state
        const handoffState = prepareHandoffState(
          elementName,
          handoffGatheredData,
          activeElements,
          successCriteria
        );

        // Generate the copy-pasteable block
        const handoffBlock = generateHandoffBlock(handoffState);

        return {
          _type: 'HandoffResult',
          handoffState,
          handoffBlock,
        };
      }

      case 'resumeFromHandoff': {
        // Issue #69: Resume execution from a handoff block
        const handoffBlockParam = params.handoffBlock;
        if (typeof handoffBlockParam !== 'string' || !handoffBlockParam) {
          throw new Error('handoffBlock is required for resume_from_handoff (the full handoff block text)');
        }

        // Parse and validate the handoff block (checksum validated internally)
        const restoredState = parseHandoffBlock(handoffBlockParam);

        // Verify the agent name matches
        if (restoredState.agentName !== elementName) {
          logger.warn('Handoff agent mismatch detected', {
            expectedAgent: elementName,
            blockAgent: restoredState.agentName,
          });
          throw new Error(
            'Handoff agent mismatch: the handoff block was not prepared for this agent'
          );
        }

        // Merge caller-provided parameters with handoff metadata.
        // The caller must supply any required goal template parameters (e.g. task).
        const callerParams = (params.parameters as Record<string, unknown>) || {};
        const resumeParams = {
          ...callerParams,
          resumedFromHandoff: true,
          originalGoalId: restoredState.goalId,
        };

        // Resume execution using continue with restored context
        const continueResult = await manager.continueAgentExecution({
          agentName: elementName,
          previousStepResult: `Resumed from handoff (goalId: ${restoredState.goalId}, ${restoredState.goalProgress.stepsCompleted} steps completed)`,
          parameters: resumeParams,
        });

        return {
          _type: 'ResumeResult',
          ...continueResult,
          restoredFrom: {
            agentName: restoredState.agentName,
            goalId: restoredState.goalId,
            version: restoredState.version,
            stepsCompleted: restoredState.goalProgress.stepsCompleted,
            preparedAt: restoredState.preparedAt,
          },
        };
      }

      default:
        throw new Error(`Unknown Execute method: ${method}`);
    }
  }

  // ============================================================================
  // Agent Notification System
  // ============================================================================

  /** Maximum recent blocks tracked per agent to prevent unbounded growth */
  private static readonly MAX_RECENT_BLOCKS = 50;

  /**
   * Record a gatekeeper block against all currently executing agents.
   * Called when Gatekeeper.enforce() denies an operation, so that
   * record_execution_step can report it as a notification.
   *
   * @since v2.1.0 - Agent Notification System
   * @private
   */
  private recordGatekeeperBlockForAgents(
    operation: string,
    elementType: string | undefined,
    reason: string,
    level: string
  ): void {
    if (this.executingAgents.size === 0) return;

    const block = {
      operation,
      elementType,
      reason,
      level,
      timestamp: new Date().toISOString(),
      reported: false,
    };

    for (const [, agentEntry] of this.executingAgents) {
      agentEntry.recentBlocks.push(block);

      // Cap at MAX_RECENT_BLOCKS: evict oldest reported first, then oldest unreported
      while (agentEntry.recentBlocks.length > MCPAQLHandler.MAX_RECENT_BLOCKS) {
        const reportedIdx = agentEntry.recentBlocks.findIndex(b => b.reported);
        if (reportedIdx >= 0) {
          agentEntry.recentBlocks.splice(reportedIdx, 1);
        } else {
          agentEntry.recentBlocks.shift();
        }
      }
    }
  }

  /**
   * Collect notifications for an executing agent from all sources:
   * 1. Unreported gatekeeper blocks → permission_pending
   * 2. Autonomy pause (continue=false) → autonomy_pause
   * 3. DangerZone blocked agents (system-wide broadcast) → danger_zone
   *
   * Gatekeeper blocks are marked as "reported" after first collection
   * so they don't repeat on subsequent calls. DangerZone and autonomy
   * notifications are always emitted while the condition persists.
   *
   * @since v2.1.0 - Agent Notification System
   * @private
   */
  private collectNotifications(
    agentName: string,
    autonomy: Record<string, unknown>
  ): AgentNotification[] {
    const notifications: AgentNotification[] = [];
    const executingAgent = this.executingAgents.get(this.sessionKey(agentName));

    // Source 1: Unreported gatekeeper blocks
    if (executingAgent?.recentBlocks) {
      for (const block of executingAgent.recentBlocks) {
        if (!block.reported) {
          notifications.push({
            type: 'permission_pending',
            message: `${block.operation}${block.elementType ? `(${block.elementType})` : ''} requires confirmation`,
            metadata: {
              operation: block.operation,
              element_type: block.elementType,
              reason: block.reason,
              level: block.level,
            },
            timestamp: block.timestamp,
          });
          block.reported = true;
        }
      }
    }

    // Source 2: Autonomy pause
    if (autonomy.continue === false) {
      const reason = (autonomy.reason as string) || (autonomy.factors as string[] || []).join(', ');
      if (reason) {
        notifications.push({
          type: 'autonomy_pause',
          message: `Agent paused: ${reason}`,
          metadata: {
            reason,
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Source 3: DangerZone broadcast — alert ALL executing agents about any blocked agent
    const enforcer = this.handlers.dangerZoneEnforcer;
    if (enforcer?.hasBlockedAgents()) {
      for (const blockedAgent of enforcer.getBlockedAgents()) {
        const blockCheck = enforcer.check(blockedAgent);
        if (blockCheck.blocked) {
          notifications.push({
            type: 'danger_zone',
            message: `Agent '${blockedAgent}' is blocked due to danger zone trigger: ${blockCheck.reason}`,
            metadata: {
              agentName: blockedAgent,
              reason: blockCheck.reason,
              verificationId: blockCheck.verificationId,
            },
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    return notifications;
  }

  // ============================================================================
  // Resilience Evaluation (Issue #526)
  // ============================================================================

  /**
   * Evaluate resilience policy after a step result and potentially override
   * the autonomy directive to enable auto-continuation or retry.
   *
   * Returns a modified step result if resilience kicks in, or null to use
   * the original result (default behavior).
   *
   * @since v2.1.0 - Agent Execution Resilience (Issue #526)
   * @private
   */
  private evaluateResilience(
    agentName: string,
    updateResult: Record<string, unknown>,
    stepOutcome: string
  ): Record<string, unknown> | null {
    // Only evaluate when autonomy says pause
    const autonomy = updateResult.autonomy as { continue: boolean; reason?: string; factors?: string[] } | undefined;
    if (!autonomy || autonomy.continue === true) return null;

    // Look up the executing agent's resilience tracking state
    const executingAgent = this.executingAgents.get(this.sessionKey(agentName));
    if (!executingAgent?.resiliencePolicy) return null;

    // Determine what triggered the pause
    const isStepLimit = autonomy.reason?.startsWith('Maximum autonomous steps reached') ?? false;
    const isFailure = stepOutcome === 'failure';

    // Only handle step-limit and failure triggers
    if (!isStepLimit && !isFailure) return null;

    const context: ResilienceContext = {
      trigger: isStepLimit ? 'step_limit' : 'execution_failure',
      continuationCount: executingAgent.continuationCount,
      retryCount: executingAgent.retryCount,
      stepOutcome: stepOutcome as 'success' | 'failure' | 'partial',
      agentName,
    };

    const action = evaluateResiliencePolicy(executingAgent.resiliencePolicy, context, this.handlers.circuitBreaker);

    // If resilience says pause, record the limit and use the original result
    if (action.action === 'pause') {
      // Track if this was a limit exhaustion (not a default-pause policy)
      if (action.reason?.includes('exhausted') || action.reason?.includes('Circuit breaker')) {
        this.handlers.resilienceMetrics?.recordResilienceLimit();
        if (action.reason?.includes('Circuit breaker')) {
          this.handlers.resilienceMetrics?.recordCircuitBreakerTrip();
        }
      }
      return null;
    }

    // Auto-continue: override the autonomy directive to continue
    if (action.action === 'continue') {
      executingAgent.continuationCount++;
      executingAgent.retryCount = 0; // Reset retry count on continuation
      this.handlers.resilienceMetrics?.recordAutoContinuation();

      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_AUTO_CONTINUED',
        severity: 'MEDIUM',
        source: 'MCPAQLHandler.evaluateResilience',
        details: `Agent '${agentName}' auto-continued: ${action.reason}`,
        additionalData: {
          agentName,
          continuationCount: executingAgent.continuationCount,
          maxContinuations: action.maxContinuations,
          trigger: context.trigger,
        },
      });

      return {
        ...updateResult,
        autonomy: {
          ...autonomy,
          continue: true,
          reason: action.reason,
          factors: [...(autonomy.factors || []), `resilience: auto-continued (${executingAgent.continuationCount}/${action.maxContinuations || 'unlimited'})`],
          resilienceAction: action,
        },
      };
    }

    // Retry: tell LLM to retry with backoff guidance
    if (action.action === 'retry') {
      executingAgent.retryCount++;
      this.handlers.resilienceMetrics?.recordStepRetry();

      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_STEP_RETRIED',
        severity: 'MEDIUM',
        source: 'MCPAQLHandler.evaluateResilience',
        details: `Agent '${agentName}' step retry: ${action.reason}`,
        additionalData: {
          agentName,
          retryCount: executingAgent.retryCount,
          backoffMs: action.backoffMs,
          trigger: context.trigger,
        },
      });

      return {
        ...updateResult,
        autonomy: {
          ...autonomy,
          continue: true,
          reason: action.reason,
          factors: [...(autonomy.factors || []), `resilience: retry attempt ${executingAgent.retryCount}`],
          resilienceAction: action,
        },
      };
    }

    // Restart: override to continue, signal fresh restart to LLM
    if (action.action === 'restart') {
      executingAgent.continuationCount++;
      executingAgent.retryCount = 0;
      this.handlers.resilienceMetrics?.recordAutoRestart();

      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_AUTO_RESTARTED',
        severity: 'MEDIUM',
        source: 'MCPAQLHandler.evaluateResilience',
        details: `Agent '${agentName}' auto-restarted: ${action.reason}`,
        additionalData: {
          agentName,
          continuationCount: executingAgent.continuationCount,
          maxContinuations: action.maxContinuations,
          trigger: context.trigger,
          preserveState: executingAgent.resiliencePolicy?.preserveState ?? true,
        },
      });

      return {
        ...updateResult,
        autonomy: {
          ...autonomy,
          continue: true,
          reason: action.reason,
          factors: [...(autonomy.factors || []), `resilience: auto-restarted (${executingAgent.continuationCount}/${action.maxContinuations || 'unlimited'})`],
          resilienceAction: action,
        },
      };
    }

    return null;
  }

  /**
   * Get active goal IDs for an agent (Issue #249).
   * Queries the agent's state to find in-progress goals.
   * @private
   */
  private async getActiveGoalIds(
    manager: AgentManager,
    agentName: string
  ): Promise<string[]> {
    try {
      const stateResult = await manager.getAgentState({ agentName });
      if (stateResult?.state?.goals) {
        return stateResult.state.goals
          .filter((g: { status: string }) => g.status === 'in_progress')
          .map((g: { id: string }) => g.id);
      }
    } catch {
      // Agent may not have state yet
    }
    return [];
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

  // ============================================================================
  // Field Selection (Issue #202)
  // ============================================================================

  /**
   * Apply field selection and name transformation to handler response.
   *
   * Processes the `fields` parameter to filter response data:
   * - If fields is an array, filter to those fields only
   * - If fields is a preset string ('minimal', 'standard', 'full'), use preset
   * - If fields is not provided, transform names only (name → element_name)
   *
   * For responses with `results` or `items` arrays, field selection is applied
   * to each item in the array rather than filtering the container object.
   *
   * @param result - The raw handler result
   * @param params - Original params containing optional `fields`
   * @returns Transformed result with field selection applied
   */
  private applyFieldSelection(
    result: unknown,
    params?: Record<string, unknown>
  ): unknown {
    // Skip transformation for MCP response format with content array
    // These are formatted text responses that shouldn't be transformed
    if (this.isMCPResponse(result)) {
      return result;
    }

    const fieldsParam = params?.fields;

    // No fields param - apply name transformation only
    if (fieldsParam === undefined) {
      return this.transformWithArrayAwareness(result);
    }

    // Resolve fields from preset or array
    let fields: string[] | undefined;
    let preset: 'minimal' | 'standard' | 'full' | undefined;

    if (typeof fieldsParam === 'string') {
      if (isValidPreset(fieldsParam)) {
        if (fieldsParam === 'full') {
          // 'full' preset = all fields, just transform names
          return this.transformWithArrayAwareness(result);
        }
        preset = fieldsParam;
      } else {
        // Invalid preset - treat as single field
        fields = [fieldsParam];
      }
    } else if (Array.isArray(fieldsParam)) {
      // Filter to strings only, warn about non-string elements
      const nonStringCount = fieldsParam.filter(f => typeof f !== 'string').length;
      if (nonStringCount > 0) {
        logger.warn(
          `Field selection: ${nonStringCount} non-string element(s) in fields array ignored`
        );
      }

      const stringFields = fieldsParam.filter((f): f is string => typeof f === 'string');
      if (stringFields.length === 0) {
        fields = undefined;
      } else {
        // Normalize field names for security and check for Unicode issues
        const { normalized, warnings } = normalizeFieldNames(stringFields);
        if (warnings) {
          logger.warn(`Field selection Unicode normalization: ${warnings.join('; ')}`);
        }
        fields = normalized;
      }
    }

    // No valid fields - just transform names
    if (!fields && !preset) {
      return this.transformWithArrayAwareness(result);
    }

    // Apply field filtering with array-awareness
    return this.filterWithArrayAwareness(result, fields, preset);
  }

  /**
   * Transform response with awareness of nested arrays.
   * Applies name transformation to items within `results` or `items` arrays.
   */
  private transformWithArrayAwareness(result: unknown): unknown {
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;

      // Check for common array container patterns
      if (Array.isArray(obj.results)) {
        return {
          ...this.transformTopLevel(obj, ['results']),
          results: filterFields(obj.results, { transformNames: true }).data,
        };
      }
      if (Array.isArray(obj.items)) {
        return {
          ...this.transformTopLevel(obj, ['items']),
          items: filterFields(obj.items, { transformNames: true }).data,
        };
      }
    }

    // Default: transform entire response
    const { data } = filterFields(result, { transformNames: true });
    return data;
  }

  /**
   * Filter response with awareness of nested arrays.
   * Applies field filtering to items within `results` or `items` arrays.
   */
  private filterWithArrayAwareness(
    result: unknown,
    fields?: string[],
    preset?: 'minimal' | 'standard' | 'full'
  ): unknown {
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;

      // Check for common array container patterns
      if (Array.isArray(obj.results)) {
        return {
          ...this.transformTopLevel(obj, ['results']),
          results: filterFields(obj.results, { fields, preset, transformNames: true }).data,
        };
      }
      if (Array.isArray(obj.items)) {
        return {
          ...this.transformTopLevel(obj, ['items']),
          items: filterFields(obj.items, { fields, preset, transformNames: true }).data,
        };
      }
    }

    // Default: filter entire response
    const { data } = filterFields(result, { fields, preset, transformNames: true });
    return data;
  }

  /**
   * Transform top-level fields of an object, excluding specified keys.
   * Used to preserve container metadata (total, query, etc.) while filtering nested arrays.
   */
  private transformTopLevel(
    obj: Record<string, unknown>,
    excludeKeys: string[]
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!excludeKeys.includes(key)) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Check if result is an MCP response format (with content array).
   * These responses contain formatted text and shouldn't be transformed.
   */
  private isMCPResponse(result: unknown): boolean {
    return (
      result !== null &&
      typeof result === 'object' &&
      'content' in result &&
      Array.isArray((result as Record<string, unknown>).content)
    );
  }
}

/**
 * Resolve the effective CLI approval policy from all active elements.
 *
 * Unions `requireApproval` arrays across all elements. Takes the most
 * conservative (smallest) TTL. Falls back to env var `DOLLHOUSE_CLI_APPROVAL_POLICY`.
 *
 * @param activeElements - Currently active elements
 * @returns Resolved approval policy
 */
function resolveCliApprovalPolicy(activeElements: ActiveElement[]): CliApprovalPolicy {
  const requireApproval = new Set<'moderate' | 'dangerous'>();
  let defaultScope: CliApprovalScope | undefined;
  let ttlSeconds: number | undefined;

  for (const element of activeElements) {
    const policy = element.metadata?.gatekeeper?.externalRestrictions?.approvalPolicy;
    if (!policy) continue;

    if (policy.requireApproval) {
      for (const level of policy.requireApproval) {
        requireApproval.add(level);
      }
    }
    if (policy.defaultScope && !defaultScope) {
      defaultScope = policy.defaultScope;
    }
    if (policy.ttlSeconds !== undefined) {
      ttlSeconds = ttlSeconds === undefined ? policy.ttlSeconds : Math.min(ttlSeconds, policy.ttlSeconds);
    }
  }

  // Fallback to environment variable
  if (requireApproval.size === 0) {
    const envPolicy = process.env.DOLLHOUSE_CLI_APPROVAL_POLICY;
    if (envPolicy) {
      const levels = envPolicy.split(',').map(s => s.trim()).filter(s => s === 'moderate' || s === 'dangerous');
      for (const level of levels) {
        requireApproval.add(level as 'moderate' | 'dangerous');
      }
    }
  }

  return {
    requireApproval: requireApproval.size > 0 ? Array.from(requireApproval) : undefined,
    defaultScope,
    ttlSeconds,
  };
}
