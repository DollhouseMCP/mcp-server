/**
 * Security Monitor for DollhouseMCP
 * 
 * Centralized security event logging and monitoring system
 * for tracking and alerting on security-related events.
 */

import { logger } from '../utils/logger.js';
import { EvictingQueue } from '../utils/EvictingQueue.js';

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
        'CLI_APPROVAL_REQUESTED' | 'CLI_APPROVAL_GRANTED' | 'CLI_APPROVAL_CONSUMED';
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

export class SecurityMonitor {
  private static eventCount = 0;
  private static events = new EvictingQueue<SecurityLogEntry>(1000);
  private static logListener?: (entry: SecurityLogEntry) => void;
  /** Tracks recently seen events to suppress repeated identical alerts */
  private static recentEventKeys = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 60_000;

  static addLogListener(fn: (entry: SecurityLogEntry) => void): () => void {
    this.logListener = fn;
    return () => { this.logListener = undefined; };
  }

  /**
   * Logs a security event, suppressing repeated identical events within the dedup window.
   */
  static logSecurityEvent(event: SecurityEvent): void {
    // Deduplicate: same type + source + details within window = suppress
    const dedupKey = `${event.type}:${event.source}:${event.details}`;
    const now = Date.now();
    const lastSeen = this.recentEventKeys.get(dedupKey);
    if (lastSeen && (now - lastSeen) < this.DEDUP_WINDOW_MS) {
      return; // suppress duplicate within window
    }
    this.recentEventKeys.set(dedupKey, now);

    // Evict stale dedup entries periodically
    if (this.recentEventKeys.size > 500) {
      for (const [key, ts] of this.recentEventKeys) {
        if ((now - ts) >= this.DEDUP_WINDOW_MS) this.recentEventKeys.delete(key);
      }
    }

    const logEntry: SecurityLogEntry = {
      ...event,
      timestamp: new Date().toISOString(),
      id: `SEC-${Date.now()}-${++this.eventCount}`,
    };

    // Bounded FIFO eviction — EvictingQueue handles capacity
    this.events.push(logEntry);
    this.logListener?.(logEntry);

    // In MCP servers, we cannot write to stderr/stdout as it breaks the JSON-RPC protocol
    // Security events are stored in memory and can be retrieved via API
    // Only send critical alerts via the proper channel

    if (event.severity === 'CRITICAL') {
      this.sendSecurityAlert(logEntry);
    }
  }

  /**
   * Sends security alerts for critical events
   */
  private static sendSecurityAlert(event: SecurityLogEntry): void {
    // In a production environment, this would integrate with:
    // - Slack webhooks
    // - Email alerts
    // - PagerDuty
    // - Security Information and Event Management (SIEM) systems
    
    // Log critical security alerts with structured data
    // DO NOT use console.error in MCP servers as it breaks the JSON-RPC protocol
    logger.error('[CRITICAL SECURITY ALERT]', {
      type: event.type,
      details: event.details,
      timestamp: event.timestamp,
      id: event.id
    });
    
    // If in production mode with proper config, send actual alerts
    if (process.env.DOLLHOUSE_SECURITY_ALERTS === 'true') {
      // TODO: Implement actual alert mechanisms
    }
  }

  /**
   * Gets recent security events for analysis
   */
  static getRecentEvents(count: number = 100): SecurityLogEntry[] {
    return this.events.toArray().slice(-count);
  }

  /**
   * Gets events by severity
   */
  static getEventsBySeverity(severity: SecurityEvent['severity']): SecurityLogEntry[] {
    return this.events.toArray().filter(event => event.severity === severity);
  }

  /**
   * Gets events by type
   */
  static getEventsByType(type: SecurityEvent['type']): SecurityLogEntry[] {
    return this.events.toArray().filter(event => event.type === type);
  }

  /**
   * Generates a security report
   */
  static generateSecurityReport(): {
    totalEvents: number;
    eventsBySeverity: Record<string, number>;
    eventsByType: Record<string, number>;
    recentCriticalEvents: SecurityLogEntry[];
  } {
    const eventsBySeverity: Record<string, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };

    const eventsByType: Record<string, number> = {};

    for (const event of this.events.toArray()) {
      eventsBySeverity[event.severity]++;
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    }

    return {
      totalEvents: this.events.size,
      eventsBySeverity,
      eventsByType,
      recentCriticalEvents: this.getEventsBySeverity('CRITICAL').slice(-10),
    };
  }

  /**
   * Clears old events (for memory management)
   */
  static clearOldEvents(daysToKeep: number = 7): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTimestamp = cutoffDate.toISOString();

    const remaining = this.events.toArray().filter(
      event => event.timestamp >= cutoffTimestamp
    );
    this.events.reset([...remaining]);
  }

  /**
   * TESTING ONLY: Clears all events and resets counter
   * Should only be called in test cleanup (afterEach/afterAll)
   * to prevent test pollution from accumulated security events
   */
  static clearAllEventsForTesting(): void {
    this.events.clear();
    this.eventCount = 0;
  }
}
