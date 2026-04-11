/**
 * Phase 4: Integration Hooks for Unified Logging System.
 *
 * Maps native events from 10 monitoring/logging systems into UnifiedLogEntry
 * objects and routes them through LogManager.  Each source system exposes a
 * lightweight `addLogListener` callback; the translation logic lives here so
 * source files stay minimal and never import UnifiedLogEntry.
 *
 * Usage:
 *   const cleanups = wireLogHooks(logManager, container);
 *   // later …
 *   cleanups.forEach(fn => fn());
 */

import type { LogManager } from './LogManager.js';
import type { LogLevel, UnifiedLogEntry } from './types.js';
import type { SessionContext } from '../context/SessionContext.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { DefaultElementProvider } from '../portfolio/DefaultElementProvider.js';
import { LRUCache } from '../cache/LRUCache.js';

// ---------------------------------------------------------------------------
// Severity → LogLevel helper (shared by SecurityMonitor, SecurityTelemetry,
// SecurityAuditor)
// ---------------------------------------------------------------------------

const SEVERITY_TO_LEVEL: Record<string, LogLevel> = {
  CRITICAL: 'error',
  HIGH: 'error',
  MEDIUM: 'warn',
  LOW: 'info',
  critical: 'error',
  high: 'error',
  medium: 'warn',
  low: 'info',
};

// ---------------------------------------------------------------------------
// Request context provider interface (subset of ContextTracker)
// ---------------------------------------------------------------------------

type RequestContextProvider = {
  getCorrelationId(): string | undefined;
  getSessionContext(): SessionContext | undefined;
};

// ---------------------------------------------------------------------------
// Exported factory for TriggerMetricsTracker (created outside DI container)
// ---------------------------------------------------------------------------

export function getTriggerMetricsLogListener(
  logManager: LogManager,
  contextTracker?: RequestContextProvider,
): (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void {
  return (level, message, data) => {
    const entry: UnifiedLogEntry = {
      id: logManager.generateId(),
      timestamp: new Date().toISOString(),
      category: 'telemetry',
      level,
      source: 'TriggerMetricsTracker',
      message,
      data,
      correlationId: contextTracker?.getCorrelationId(),
      userId: contextTracker?.getSessionContext()?.userId,
      sessionId: contextTracker?.getSessionContext()?.sessionId,
    };
    logManager.log(entry);
  };
}

// ---------------------------------------------------------------------------
// Exported factory for SecurityAuditor (created outside DI container)
// ---------------------------------------------------------------------------

export function getSecurityAuditorLogListener(
  logManager: LogManager,
  contextTracker?: RequestContextProvider,
): (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void {
  return (level, message, data) => {
    const entry: UnifiedLogEntry = {
      id: logManager.generateId(),
      timestamp: new Date().toISOString(),
      category: 'security',
      level,
      source: 'SecurityAuditor',
      message,
      data,
      correlationId: contextTracker?.getCorrelationId(),
      userId: contextTracker?.getSessionContext()?.userId,
      sessionId: contextTracker?.getSessionContext()?.sessionId,
    };
    logManager.log(entry);
  };
}

// ---------------------------------------------------------------------------
// Main wiring function
// ---------------------------------------------------------------------------

/**
 * Wire all monitoring systems into the unified logging pipeline.
 *
 * @param logManager  The LogManager singleton from the DI container.
 * @param container   The DI container (used to resolve source services).
 * @returns Array of unsubscribe functions — call them during shutdown.
 */
export function wireLogHooks(
  logManager: LogManager,
  container: { resolve<T>(name: string): T },
): (() => void)[] {
  const cleanups: (() => void)[] = [];

  // Resolve ContextTracker for correlationId injection
  let contextTracker: RequestContextProvider | null = null;
  try {
    contextTracker = container.resolve<RequestContextProvider>('ContextTracker');
  } catch { /* ContextTracker not registered */ }

  // --- MCPLogger (application) -------------------------------------------
  try {
    const mcpLogger = container.resolve<{
      addLogListener(fn: (entry: { timestamp: Date; level: string; message: string; data?: any }) => void): () => void;
    }>('MCPLogger');
    const unsub = mcpLogger.addLogListener((logEntry) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: logEntry.timestamp.toISOString(),
        category: 'application',
        level: logEntry.level as LogLevel,
        source: 'MCPLogger',
        message: logEntry.message,
        data: logEntry.data != null ? logEntry.data : undefined,
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  } catch { /* MCPLogger not registered */ }

  // --- SecurityMonitor (security, static) ---------------------------------
  {
    const unsub = SecurityMonitor.addLogListener((logEntry) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: logEntry.timestamp,
        category: 'security',
        level: SEVERITY_TO_LEVEL[logEntry.severity] ?? 'info',
        source: 'SecurityMonitor',
        message: `[${logEntry.type}] ${logEntry.details}`,
        data: {
          ...logEntry.additionalData,
          eventType: logEntry.type,
          severity: logEntry.severity,
          sourceComponent: logEntry.source,
        },
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  }

  // --- SecurityTelemetry (security) ---------------------------------------
  try {
    const secTelemetry = container.resolve<{
      addLogListener(fn: (entry: {
        timestamp: string; attackType: string; pattern: string;
        severity: string; source: string; metadata?: Record<string, any>;
      }) => void): () => void;
    }>('SecurityTelemetry');
    const unsub = secTelemetry.addLogListener((telEntry) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: telEntry.timestamp,
        category: 'security',
        level: SEVERITY_TO_LEVEL[telEntry.severity] ?? 'info',
        source: 'SecurityTelemetry',
        message: `Blocked ${telEntry.attackType}: ${telEntry.pattern}`,
        data: telEntry.metadata,
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  } catch { /* SecurityTelemetry not registered */ }

  // --- PerformanceMonitor (performance) -----------------------------------
  try {
    const perfMonitor = container.resolve<{
      addLogListener(fn: (level: string, message: string, data?: Record<string, unknown>) => void): () => void;
    }>('PerformanceMonitor');
    const unsub = perfMonitor.addLogListener((level, message, data) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'performance',
        level: level as LogLevel,
        source: 'PerformanceMonitor',
        message,
        data,
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  } catch { /* PerformanceMonitor not registered */ }

  // --- ElementEventDispatcher (application) — already has on() -----------
  try {
    const dispatcher = container.resolve<{
      on(event: string, handler: (payload: any) => void): () => void;
    }>('ElementEventDispatcher');

    const eventLevelMap: Record<string, LogLevel> = {
      'element:load:error': 'error',
      'element:save:error': 'error',
      'element:delete:error': 'error',
      'element:lock-timeout': 'warn',
      'element:activate': 'info',
      'element:deactivate': 'info',
      'element:load:success': 'info',
      'element:save:success': 'info',
      'element:delete:success': 'info',
    };

    // Only log events that have a mapped level (errors, warnings, success, activate/deactivate).
    // Skip start/cache/external-change events — they fire per-element and create noise
    // without adding value beyond the completion/error logs.
    const loggedEvents = Object.keys(eventLevelMap);

    for (const eventName of loggedEvents) {
      const unsub = dispatcher.on(eventName, (payload: any) => {
        const level = eventLevelMap[eventName] ?? 'debug';
        const requestCorrelationId = contextTracker?.getCorrelationId();
        // Use elementId if available, fall back to filename from filePath
        const elementName = payload.elementId
          || (payload.filePath ? payload.filePath.replace(/\.[^.]+$/, '') : '');
        const entry: UnifiedLogEntry = {
          id: logManager.generateId(),
          timestamp: new Date().toISOString(),
          category: 'application',
          level,
          source: 'ElementEventDispatcher',
          message: `${eventName} [${payload.elementType ?? 'unknown'}:${elementName}]`,
          data: {
            ...payload.extra,
            ...(payload.correlationId ? { operationId: payload.correlationId } : {}),
            ...(payload.filePath ? { filePath: payload.filePath } : {}),
          },
          correlationId: requestCorrelationId ?? payload.correlationId,
          userId: contextTracker?.getSessionContext()?.userId,
          sessionId: contextTracker?.getSessionContext()?.sessionId,
        };
        logManager.log(entry);
      });
      cleanups.push(unsub);
    }
  } catch { /* ElementEventDispatcher not registered */ }

  // --- OperationalTelemetry (telemetry) -----------------------------------
  try {
    const opsTelemetry = container.resolve<{
      addLogListener(fn: (level: string, message: string, data?: Record<string, unknown>) => void): () => void;
    }>('OperationalTelemetry');
    const unsub = opsTelemetry.addLogListener((level, message, data) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'telemetry',
        level: level as LogLevel,
        source: 'OperationalTelemetry',
        message,
        data,
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  } catch { /* OperationalTelemetry not registered */ }

  // --- FileLockManager (performance) --------------------------------------
  try {
    const lockManager = container.resolve<{
      addLogListener(fn: (level: string, message: string, data?: Record<string, unknown>) => void): () => void;
    }>('FileLockManager');
    const unsub = lockManager.addLogListener((level, message, data) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'performance',
        level: level as LogLevel,
        source: 'FileLockManager',
        message,
        data,
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  } catch { /* FileLockManager not registered */ }

  // --- DefaultElementProvider (performance, static) -----------------------
  {
    const unsub = DefaultElementProvider.addLogListener((level, message, data) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'performance',
        level: level as LogLevel,
        source: 'DefaultElementProvider',
        message,
        data,
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  }

  // --- LRUCache (performance, static) ------------------------------------
  {
    const unsub = LRUCache.addLogListener((level, message, data) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'performance',
        level: level as LogLevel,
        source: 'LRUCache',
        message,
        data,
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    });
    cleanups.push(unsub);
  }

  // --- StateChangeNotifier (application) — extends EventEmitter ----------
  try {
    const notifier = container.resolve<{
      on(event: string, handler: (...args: any[]) => void): any;
      removeListener(event: string, handler: (...args: any[]) => void): any;
    }>('StateChangeNotifier');
    const handler = (event: { type: string; previousValue: string | null; newValue: string | null }) => {
      const entry: UnifiedLogEntry = {
        id: logManager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'application',
        level: 'info',
        source: 'StateChangeNotifier',
        message: `State change: ${event.type}`,
        data: { previousValue: event.previousValue, newValue: event.newValue },
        correlationId: contextTracker?.getCorrelationId(),
        userId: contextTracker?.getSessionContext()?.userId,
        sessionId: contextTracker?.getSessionContext()?.sessionId,
      };
      logManager.log(entry);
    };
    notifier.on('state-change', handler);
    cleanups.push(() => notifier.removeListener('state-change', handler));
  } catch { /* StateChangeNotifier not registered */ }

  return cleanups;
}
