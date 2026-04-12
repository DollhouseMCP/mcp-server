/**
 * Security Monitor for DollhouseMCP
 *
 * Centralized security event logging and monitoring system.
 *
 * ARCHITECTURE: Static facade backed by a DI-managed instance.
 * Call sites use SecurityMonitor.logSecurityEvent() (static API).
 * At startup, the DI container creates an instance and wires it via
 * SecurityMonitor.setInstance(). The static methods delegate to the
 * instance, enabling future session-scoped monitoring in Phase 3.
 */

import { logger } from '../utils/logger.js';
import { EvictingQueue } from '../utils/EvictingQueue.js';
import { EventDeduplicator } from '../utils/EventDeduplicator.js';

export interface SecurityEvent {
  type: 'CONTENT_INJECTION_ATTEMPT' | 'YAML_INJECTION_ATTEMPT' | 'PATH_TRAVERSAL_ATTEMPT' |
        'TOKEN_VALIDATION_FAILURE' | 'UPDATE_SECURITY_VIOLATION' | 'RATE_LIMIT_EXCEEDED' |
        'YAML_PARSING_WARNING' | 'YAML_PARSE_SUCCESS' | 'TOKEN_VALIDATION_SUCCESS' |
        'PATH_VALIDATION_SUCCESS' | 'RATE_LIMIT_WARNING' | 'TOKEN_CACHE_CLEARED' |
        'YAML_UNICODE_ATTACK' | 'UNICODE_DIRECTION_OVERRIDE' | 'UNICODE_MIXED_SCRIPT' |
        'UNICODE_VALIDATION_ERROR' | 'CONTENT_SIZE_EXCEEDED' | 'INCLUDE_DEPTH_EXCEEDED' |
        'TEMPLATE_RENDERED' | 'TEMPLATE_INCLUDE' | 'TEMPLATE_LOADED' | 'TEMPLATE_SAVED' |
        'TEMPLATE_DELETED' | 'MEMORY_CREATED' | 'MEMORY_ADDED' | 'MEMORY_SEARCHED' |
        'SENSITIVE_MEMORY_DELETED' | 'RETENTION_POLICY_ENFORCED' | 'MEMORY_CLEARED' |
        'MEMORY_LOADED' | 'MEMORY_SAVED' | 'MEMORY_DELETED' | 'MEMORY_LOAD_FAILED' |
        'MEMORY_SAVE_FAILED' | 'MEMORY_LIST_ITEM_FAILED' | 'MEMORY_IMPORT_FAILED' |
        'MEMORY_DESERIALIZE_FAILED' | 'MEMORY_INTEGRITY_VIOLATION' | 'MEMORY_UNICODE_VALIDATION_FAILED' |
        'MEMORY_DUPLICATE_DETECTED' | 'SEED_MEMORY_INSTALLED' | 'SEED_MEMORY_INSTALLATION_FAILED' |
        'ELEMENT_CREATED' | 'ELEMENT_LOADED' | 'ELEMENT_EDITED' | 'ELEMENT_ACTIVATED' | 'ELEMENT_DEACTIVATED' |
        'ELEMENT_VALIDATED' | 'ELEMENT_DELETED' |
        'AGENT_ACTIVATED' | 'AGENT_ACTIVATION_FAILED' | 'AGENT_ACTIVATION_ROLLBACK' |
        'AGENT_DEACTIVATED' | 'AGENT_EXECUTED' |
        'CONFIG_UPDATED' | 'IDENTITY_CHANGED' |
        'OPERATION_COMPLETED' | 'OPERATION_FAILED' | 'BATCH_COMPLETED' | 'BATCH_REJECTED' |
        'CONFIRMATION_RECORDED' | 'GATEKEEPER_DECISION' |
        'AUTH_FLOW_INITIATED' |
        'AGENT_DECISION' |
        'RULE_ENGINE_CONFIG_UPDATE' | 'RULE_ENGINE_CONFIG_VALIDATION_ERROR' |
        'GOAL_TEMPLATE_APPLIED' | 'GOAL_TEMPLATE_VALIDATION' |
        'ENSEMBLE_CIRCULAR_DEPENDENCY' | 'ENSEMBLE_RESOURCE_LIMIT_EXCEEDED' |
        'ENSEMBLE_ACTIVATION_TIMEOUT' | 'ENSEMBLE_ACTIVATION_FAILED' | 'ENSEMBLE_SUSPICIOUS_CONDITION' |
        'ENSEMBLE_CONDITION_EVALUATION_FAILED' |
        'ENSEMBLE_NESTED_DEPTH_EXCEEDED' | 'ENSEMBLE_CONTEXT_SIZE_EXCEEDED' |
        'ENSEMBLE_CONTEXT_VALUE_TOO_LARGE' | 'ENSEMBLE_SAVED' | 'ENSEMBLE_IMPORTED' | 'ENSEMBLE_DELETED' |
        'PORTFOLIO_INITIALIZATION' | 'PORTFOLIO_POPULATED' | 'FILE_COPIED' | 'DIRECTORY_MIGRATION' |
        'PORTFOLIO_CACHE_INVALIDATION' | 'PORTFOLIO_FETCH_SUCCESS' | 'TEST_DATA_BLOCKED' |
        'TEST_PATH_SECURITY_RISK' | 'TEST_PRODUCTION_ACCESS_BLOCKED' | 'TEST_PATH_INVALID' |
        'TEST_ENVIRONMENT_PRODUCTION_PATH' | 'TEST_ENVIRONMENT_DEPRECATED_VAR' | 'TOOL_CACHE_INVALIDATED' |
        'FILE_READ' | 'FILE_WRITTEN' | 'FILE_DELETED' |
        'DANGER_ZONE_TRIGGERED' | 'DANGER_ZONE_OPERATION' |
        'AUTONOMY_DENIED' | 'AUTONOMY_PAUSED' | 'SAFETY_EVALUATION_FAILURE' |
        'VERIFICATION_ATTEMPTED' | 'VERIFICATION_SUCCEEDED' |
        'VERIFICATION_FAILED' | 'VERIFICATION_EXPIRED' |
        'AGENT_AUTO_CONTINUED' | 'AGENT_STEP_RETRIED' |
        'AGENT_AUTO_RESTARTED' | 'AGENT_RESILIENCE_LIMIT_REACHED' |
        'PERMISSION_PROMPT_DENIED' |
        'CLI_APPROVAL_REQUESTED' | 'CLI_APPROVAL_GRANTED' | 'CLI_APPROVAL_CONSUMED' |
        'TOTP_ENROLLED' | 'TOTP_DISABLED' | 'TOTP_BACKUP_CODE_CONSUMED' | 'TOTP_VERIFICATION_FAILED' |
        'CONSOLE_TOKEN_ROTATED';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  source: string;
  details: string;
  userAgent?: string;
  ip?: string;
  additionalData?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface SecurityLogEntry extends SecurityEvent {
  timestamp: string;
  id: string;
}

/** Deduplication window: suppress identical events within this period */
const DEDUP_WINDOW_MS = 60_000;

/** Maximum dedup cache entries before LRU eviction */
const DEDUP_MAX_SIZE = 500;

export class SecurityMonitor {
  // ── Instance state (used when wired via DI) ──────────────────────────
  private _eventCount = 0;
  private readonly _events = new EvictingQueue<SecurityLogEntry>(1000);
  private _logListener?: (entry: SecurityLogEntry) => void;
  private readonly _dedup = new EventDeduplicator(DEDUP_WINDOW_MS, DEDUP_MAX_SIZE);

  // ── Static facade state (fallback when no instance wired) ────────────
  private static _instance: SecurityMonitor | null = null;
  private static _fallback = new SecurityMonitor();

  /** Wire the DI-managed instance. Called once at container startup. */
  static setInstance(instance: SecurityMonitor): void {
    this._instance = instance;
  }

  /** Get the active instance (DI-managed or fallback). */
  private static get active(): SecurityMonitor {
    return this._instance ?? this._fallback;
  }

  // ── Instance methods ─────────────────────────────────────────────────

  instanceAddLogListener(fn: (entry: SecurityLogEntry) => void): () => void {
    this._logListener = fn;
    return () => { this._logListener = undefined; };
  }

  instanceLogSecurityEvent(event: SecurityEvent): void {
    if (this._dedup.shouldSuppress(`${event.type}\0${event.source}\0${event.details}`)) {
      return;
    }

    const logEntry: SecurityLogEntry = {
      ...event,
      timestamp: new Date().toISOString(),
      id: `SEC-${Date.now()}-${++this._eventCount}`,
    };

    this._events.push(logEntry);
    this._logListener?.(logEntry);

    if (event.severity === 'CRITICAL') {
      logger.error('[CRITICAL SECURITY ALERT]', {
        type: event.type,
        details: event.details,
        timestamp: logEntry.timestamp,
        id: logEntry.id
      });

      if (process.env.DOLLHOUSE_SECURITY_ALERTS === 'true') {
        // Alert mechanism integration point (Slack, PagerDuty, SIEM)
      }
    }
  }

  instanceGetRecentEvents(count: number = 100): SecurityLogEntry[] {
    return this._events.toArray().slice(-count);
  }

  instanceGetEventsBySeverity(severity: SecurityEvent['severity']): SecurityLogEntry[] {
    return this._events.toArray().filter(event => event.severity === severity);
  }

  instanceGetEventsByType(type: SecurityEvent['type']): SecurityLogEntry[] {
    return this._events.toArray().filter(event => event.type === type);
  }

  instanceGenerateSecurityReport(): {
    totalEvents: number;
    eventsBySeverity: Record<string, number>;
    eventsByType: Record<string, number>;
    recentCriticalEvents: SecurityLogEntry[];
  } {
    const eventsBySeverity: Record<string, number> = {
      CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0,
    };
    const eventsByType: Record<string, number> = {};

    for (const event of this._events.toArray()) {
      eventsBySeverity[event.severity]++;
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    }

    return {
      totalEvents: this._events.size,
      eventsBySeverity,
      eventsByType,
      recentCriticalEvents: this.instanceGetEventsBySeverity('CRITICAL').slice(-10),
    };
  }

  instanceClearOldEvents(daysToKeep: number = 7): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTimestamp = cutoffDate.toISOString();

    const remaining = this._events.toArray().filter(
      event => event.timestamp >= cutoffTimestamp
    );
    this._events.reset([...remaining]);
  }

  instanceClearAllEventsForTesting(): void {
    this._events.clear();
    this._eventCount = 0;
    this._dedup.clear();
  }

  // ── Static facade (delegates to active instance) ─────────────────────

  static addLogListener(fn: (entry: SecurityLogEntry) => void): () => void {
    return this.active.instanceAddLogListener(fn);
  }

  static logSecurityEvent(event: SecurityEvent): void {
    this.active.instanceLogSecurityEvent(event);
  }

  static getRecentEvents(count: number = 100): SecurityLogEntry[] {
    return this.active.instanceGetRecentEvents(count);
  }

  static getEventsBySeverity(severity: SecurityEvent['severity']): SecurityLogEntry[] {
    return this.active.instanceGetEventsBySeverity(severity);
  }

  static getEventsByType(type: SecurityEvent['type']): SecurityLogEntry[] {
    return this.active.instanceGetEventsByType(type);
  }

  static generateSecurityReport() {
    return this.active.instanceGenerateSecurityReport();
  }

  static clearOldEvents(daysToKeep: number = 7): void {
    this.active.instanceClearOldEvents(daysToKeep);
  }

  /** @internal Backward-compat accessor for tests that access SecurityMonitor['events'] directly. */
  static get events(): EvictingQueue<SecurityLogEntry> {
    return this.active._events;
  }

  static clearAllEventsForTesting(): void {
    this.active.instanceClearAllEventsForTesting();
    // Also reset the instance binding for test isolation
    this._instance = null;
    this._fallback = new SecurityMonitor();
  }
}
