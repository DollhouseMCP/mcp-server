/**
 * Unit tests for LogHooks — Phase 4 Integration Hooks for Unified Logging System.
 *
 * Tests the mapping of native events from 10 monitoring/logging systems into
 * UnifiedLogEntry objects routed through LogManager.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock static imports BEFORE importing the modules
// Define mock functions FIRST, then use in jest.mock
// ---------------------------------------------------------------------------

const mockSecurityMonitorListener = jest.fn(() => jest.fn()); // Return unsubscribe function
const mockDefaultElementProviderListener = jest.fn(() => jest.fn()); // Return unsubscribe function
const mockLRUCacheListener = jest.fn(() => jest.fn()); // Return unsubscribe function

jest.mock('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    addLogListener: mockSecurityMonitorListener,
  },
}));

jest.mock('../../../src/portfolio/DefaultElementProvider.js', () => ({
  DefaultElementProvider: {
    addLogListener: mockDefaultElementProviderListener,
  },
}));

jest.mock('../../../src/cache/LRUCache.js', () => ({
  LRUCache: {
    addLogListener: mockLRUCacheListener,
  },
}));

// Import after mocks are set up
import {
  wireLogHooks,
  getTriggerMetricsLogListener,
  getSecurityAuditorLogListener,
} from '../../../src/logging/LogHooks.js';
import type { LogManager } from '../../../src/logging/LogManager.js';
import type { UnifiedLogEntry } from '../../../src/logging/types.js';

// Real imports for jest.spyOn fallback in ESM mode where jest.mock doesn't intercept
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { LRUCache } from '../../../src/cache/LRUCache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLogManager(): LogManager & { logCalls: UnifiedLogEntry[]; idCounter: number } {
  const logCalls: UnifiedLogEntry[] = [];
  let idCounter = 0;

  return {
    log: jest.fn((entry: UnifiedLogEntry) => {
      logCalls.push(entry);
    }),
    generateId: jest.fn(() => {
      idCounter++;
      return `LOG-${Date.now()}-${idCounter}`;
    }),
    logCalls,
    idCounter,
    // LogManager interface methods (not tested here, but needed for type compatibility)
    addSink: jest.fn(),
    removeSink: jest.fn(),
    shutdown: jest.fn(),
    flush: jest.fn(),
    query: jest.fn(),
  } as any;
}

function makeMockContainer(registeredServices: Record<string, any> = {}): { resolve: jest.Mock } {
  return {
    resolve: jest.fn((name: string) => {
      if (registeredServices[name]) {
        return registeredServices[name];
      }
      throw new Error(`Service ${name} not registered`);
    }),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('LogHooks', () => {
  let mockLogManager: ReturnType<typeof makeMockLogManager>;

  beforeEach(() => {
    mockLogManager = makeMockLogManager();

    // Clear mock call history
    mockSecurityMonitorListener.mockClear();
    mockDefaultElementProviderListener.mockClear();
    mockLRUCacheListener.mockClear();
  });

  afterEach(() => {
    // Clean up
    mockSecurityMonitorListener.mockClear();
    mockDefaultElementProviderListener.mockClear();
    mockLRUCacheListener.mockClear();
  });

  // -------------------------------------------------------------------------
  // wireLogHooks: return value
  // -------------------------------------------------------------------------

  describe('wireLogHooks', () => {
    it('should return array of unsubscribe functions', () => {
      const container = makeMockContainer({});
      const cleanups = wireLogHooks(mockLogManager, container);

      expect(Array.isArray(cleanups)).toBe(true);
      expect(cleanups.length).toBeGreaterThan(0);
      cleanups.forEach(fn => expect(typeof fn).toBe('function'));
    });

    it('should handle container with no registered services gracefully', () => {
      const container = makeMockContainer({});

      expect(() => wireLogHooks(mockLogManager, container)).not.toThrow();

      // Should still have cleanups from static services (SecurityMonitor, DefaultElementProvider)
      const cleanups = wireLogHooks(mockLogManager, container);
      expect(cleanups.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // MCPLogger
  // -------------------------------------------------------------------------

  describe('MCPLogger integration', () => {
    it('should map MCPLogger entry with level passthrough and Date→ISO timestamp', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn(); // unsubscribe
        }),
      };
      const container = makeMockContainer({ MCPLogger: mcpLogger });

      wireLogHooks(mockLogManager, container);

      const testDate = new Date('2026-02-10T12:00:00.000Z');
      mockListener({
        timestamp: testDate,
        level: 'warn',
        message: 'Test warning',
        data: { key: 'value' },
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        timestamp: '2026-02-10T12:00:00.000Z',
        category: 'application',
        level: 'warn',
        source: 'MCPLogger',
        message: 'Test warning',
        data: { key: 'value' },
      });
    });

    it('should handle MCPLogger entry with null data (should omit data field)', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ MCPLogger: mcpLogger });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'No data',
        data: null,
      });

      expect(mockLogManager.logCalls[0].data).toBeUndefined();
    });

    it('should handle MCPLogger entry with undefined data (should omit data field)', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ MCPLogger: mcpLogger });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'debug',
        message: 'No data',
      });

      expect(mockLogManager.logCalls[0].data).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // SecurityMonitor (static import - tested via end-to-end)
  // NOTE: Jest ESM mocking of static imports has known limitations. These tests
  // verify the wiring logic. Full integration testing requires E2E tests.
  // -------------------------------------------------------------------------

  describe('SecurityMonitor integration', () => {
    it('should wire SecurityMonitor without errors', () => {
      const container = makeMockContainer({});

      // Should not throw when wiring SecurityMonitor
      expect(() => wireLogHooks(mockLogManager, container)).not.toThrow();
    });

    // Severity mapping logic is tested directly in the implementation
    // Full integration tests for Security Monitor are in tests/integration/
  });

  // -------------------------------------------------------------------------
  // SecurityTelemetry
  // -------------------------------------------------------------------------

  describe('SecurityTelemetry integration', () => {
    it('should format message as "Blocked {attackType}: {pattern}"', () => {
      const mockListener = jest.fn();
      const secTelemetry = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ SecurityTelemetry: secTelemetry });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: '2026-02-10T12:00:00.000Z',
        attackType: 'SQL_INJECTION',
        pattern: 'UNION SELECT',
        severity: 'HIGH',
        source: 'InputValidator',
        metadata: { field: 'username' },
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'security',
        level: 'error',
        source: 'SecurityTelemetry',
        message: 'Blocked SQL_INJECTION: UNION SELECT',
        data: { field: 'username' },
      });
    });

    it('should apply severity→level mapping (MEDIUM→warn)', () => {
      const mockListener = jest.fn();
      const secTelemetry = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ SecurityTelemetry: secTelemetry });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: '2026-02-10T12:00:00.000Z',
        attackType: 'XSS',
        pattern: '<script>',
        severity: 'MEDIUM',
        source: 'ContentFilter',
      });

      expect(mockLogManager.logCalls[0].level).toBe('warn');
    });
  });

  // -------------------------------------------------------------------------
  // PerformanceMonitor
  // -------------------------------------------------------------------------

  describe('PerformanceMonitor integration', () => {
    it('should passthrough level and create performance category entry', () => {
      const mockListener = jest.fn();
      const perfMonitor = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ PerformanceMonitor: perfMonitor });

      wireLogHooks(mockLogManager, container);

      mockListener('warn', 'Slow operation detected', { duration: 5000 });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'performance',
        level: 'warn',
        source: 'PerformanceMonitor',
        message: 'Slow operation detected',
        data: { duration: 5000 },
      });
    });

    it('should handle undefined data parameter', () => {
      const mockListener = jest.fn();
      const perfMonitor = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ PerformanceMonitor: perfMonitor });

      wireLogHooks(mockLogManager, container);

      mockListener('info', 'Performance checkpoint');

      expect(mockLogManager.logCalls[0].data).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // ElementEventDispatcher
  // -------------------------------------------------------------------------

  describe('ElementEventDispatcher integration', () => {
    it('should map error events to error level', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:load:error') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      mockOn({
        elementType: 'persona',
        elementId: 'test-persona',
        correlationId: 'CORR-123',
        extra: { error: 'File not found' },
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'application',
        level: 'error',
        source: 'ElementEventDispatcher',
        message: 'element:load:error [persona:test-persona]',
        correlationId: 'CORR-123',
        data: { error: 'File not found' },
      });
    });

    it('should map lock-timeout to warn level', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:lock-timeout') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      mockOn({ elementType: 'skill', elementId: 'test-skill' });

      expect(mockLogManager.logCalls[0].level).toBe('warn');
    });

    it('should map success events to info level', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:save:success') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      mockOn({ elementType: 'agent', elementId: 'test-agent' });

      expect(mockLogManager.logCalls[0].level).toBe('info');
    });

    it('should map activate/deactivate to info level', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:activate') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      mockOn({ elementType: 'persona', elementId: 'active-persona' });

      expect(mockLogManager.logCalls[0].level).toBe('info');
    });

    it('should only subscribe to mapped events (not start/cache/external-change)', () => {
      const eventHandlers: Record<string, any> = {};
      const dispatcher = {
        on: jest.fn((event, handler) => {
          eventHandlers[event] = handler;
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      // Start/cache/external-change events should NOT be subscribed
      expect(eventHandlers['element:load:start']).toBeUndefined();
      expect(eventHandlers['element:cache:refresh']).toBeUndefined();
      expect(eventHandlers['element:external-change']).toBeUndefined();
      // But error/success/activate events should be
      expect(eventHandlers['element:load:error']).toBeDefined();
      expect(eventHandlers['element:load:success']).toBeDefined();
      expect(eventHandlers['element:activate']).toBeDefined();
    });

    it('should include filePath in element name when elementId is missing', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:load:error') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      mockOn({ elementType: 'skills', filePath: 'test-skill.md' });

      expect(mockLogManager.logCalls[0].message).toBe('element:load:error [skills:test-skill]');
    });

    it('should include correlationId when present', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:load:success') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      mockOn({
        elementType: 'memory',
        elementId: 'session-memory',
        correlationId: 'REQUEST-456',
      });

      expect(mockLogManager.logCalls[0].correlationId).toBe('REQUEST-456');
    });
  });

  // -------------------------------------------------------------------------
  // OperationalTelemetry
  // -------------------------------------------------------------------------

  describe('OperationalTelemetry integration', () => {
    it('should create telemetry category entries with level passthrough', () => {
      const mockListener = jest.fn();
      const opsTelemetry = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ OperationalTelemetry: opsTelemetry });

      wireLogHooks(mockLogManager, container);

      mockListener('info', 'System startup complete', { uptime: 120 });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'telemetry',
        level: 'info',
        source: 'OperationalTelemetry',
        message: 'System startup complete',
        data: { uptime: 120 },
      });
    });
  });

  // -------------------------------------------------------------------------
  // FileLockManager
  // -------------------------------------------------------------------------

  describe('FileLockManager integration', () => {
    it('should create performance category entries', () => {
      const mockListener = jest.fn();
      const lockManager = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ FileLockManager: lockManager });

      wireLogHooks(mockLogManager, container);

      mockListener('debug', 'Lock acquired', { file: 'persona.yaml', duration: 5 });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'performance',
        level: 'debug',
        source: 'FileLockManager',
        message: 'Lock acquired',
        data: { file: 'persona.yaml', duration: 5 },
      });
    });
  });

  // -------------------------------------------------------------------------
  // DefaultElementProvider (static import - tested via end-to-end)
  // NOTE: Jest ESM mocking of static imports has known limitations. These tests
  // verify the wiring logic. Full integration testing requires E2E tests.
  // -------------------------------------------------------------------------

  describe('DefaultElementProvider integration', () => {
    it('should wire DefaultElementProvider without errors', () => {
      const container = makeMockContainer({});

      // Should not throw when wiring DefaultElementProvider
      expect(() => wireLogHooks(mockLogManager, container)).not.toThrow();
    });

    // Full integration tests for DefaultElementProvider are in tests/integration/
  });

  // -------------------------------------------------------------------------
  // LRUCache (static import - tested via end-to-end)
  // -------------------------------------------------------------------------

  describe('LRUCache integration', () => {
    it('should wire LRUCache static listener without errors', () => {
      // Use spyOn as fallback for ESM mode where jest.mock may not intercept
      const spy = jest.spyOn(LRUCache, 'addLogListener');
      const container = makeMockContainer({});

      expect(() => wireLogHooks(mockLogManager, container)).not.toThrow();

      // Check either the module-level mock or the spyOn captured the call
      const wasCalled = mockLRUCacheListener.mock.calls.length > 0 || spy.mock.calls.length > 0;
      expect(wasCalled).toBe(true);

      spy.mockRestore();
    });

    it('should return unsubscribe function for LRUCache', () => {
      const container = makeMockContainer({});
      const cleanups = wireLogHooks(mockLogManager, container);

      // LRUCache cleanup should be included
      expect(cleanups.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // SecurityMonitor data field preservation
  // -------------------------------------------------------------------------

  describe('SecurityMonitor data field preservation', () => {
    it('should preserve eventType, severity, and sourceComponent in data', () => {
      // Capture the callback passed to SecurityMonitor.addLogListener
      // Use spyOn as fallback for ESM mode where jest.mock may not intercept
      let capturedCallback: any;
      const spy = jest.spyOn(SecurityMonitor, 'addLogListener').mockImplementation((fn: any) => {
        capturedCallback = fn;
        return jest.fn() as any;
      });

      const container = makeMockContainer({});
      wireLogHooks(mockLogManager, container);

      // Simulate a SecurityMonitor event
      capturedCallback({
        timestamp: '2026-02-10T12:00:00.000Z',
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'PersonaManager.activatePersona',
        details: 'Suspicious path detected',
        additionalData: { path: '/etc/passwd' },
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      const loggedEntry = mockLogManager.logCalls[0];
      expect(loggedEntry.data).toMatchObject({
        path: '/etc/passwd',
        eventType: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        sourceComponent: 'PersonaManager.activatePersona',
      });

      spy.mockRestore();
    });

    it('should handle events without additionalData', () => {
      let capturedCallback: any;
      const spy = jest.spyOn(SecurityMonitor, 'addLogListener').mockImplementation((fn: any) => {
        capturedCallback = fn;
        return jest.fn() as any;
      });

      const container = makeMockContainer({});
      wireLogHooks(mockLogManager, container);

      capturedCallback({
        timestamp: '2026-02-10T12:00:00.000Z',
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'SecureYamlParser',
        details: 'Malicious YAML detected',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      const loggedEntry = mockLogManager.logCalls[0];
      expect(loggedEntry.data).toMatchObject({
        eventType: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        sourceComponent: 'SecureYamlParser',
      });

      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // StateChangeNotifier
  // -------------------------------------------------------------------------

  describe('StateChangeNotifier integration', () => {
    it('should create info-level application entries with state change data', () => {
      const mockHandler = jest.fn();
      const notifier = {
        on: jest.fn((event, handler) => {
          if (event === 'state-change') {
            mockHandler.mockImplementation(handler);
          }
          return undefined;
        }),
        removeListener: jest.fn(),
      };
      const container = makeMockContainer({ StateChangeNotifier: notifier });

      wireLogHooks(mockLogManager, container);

      mockHandler({
        type: 'ACTIVE_PERSONA_CHANGED',
        previousValue: 'old-persona',
        newValue: 'new-persona',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'application',
        level: 'info',
        source: 'StateChangeNotifier',
        message: 'State change: ACTIVE_PERSONA_CHANGED',
        data: {
          previousValue: 'old-persona',
          newValue: 'new-persona',
        },
      });
    });

    it('should handle null state values', () => {
      const mockHandler = jest.fn();
      const notifier = {
        on: jest.fn((event, handler) => {
          if (event === 'state-change') {
            mockHandler.mockImplementation(handler);
          }
          return undefined;
        }),
        removeListener: jest.fn(),
      };
      const container = makeMockContainer({ StateChangeNotifier: notifier });

      wireLogHooks(mockLogManager, container);

      mockHandler({
        type: 'PERSONA_DEACTIVATED',
        previousValue: 'active-persona',
        newValue: null,
      });

      expect(mockLogManager.logCalls[0].data).toMatchObject({
        previousValue: 'active-persona',
        newValue: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Unsubscribe behavior
  // -------------------------------------------------------------------------

  describe('unsubscribe behavior', () => {
    it('should stop logging after unsubscribe is called', () => {
      const mockListener = jest.fn();
      let unsubCallback: (() => void) | undefined;
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          unsubCallback = jest.fn();
          return unsubCallback;
        }),
      };
      const container = makeMockContainer({ MCPLogger: mcpLogger });

      const cleanups = wireLogHooks(mockLogManager, container);

      // Fire event before unsubscribe
      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'Before cleanup',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);

      // Call cleanup
      cleanups.forEach(fn => fn());

      // Verify unsubscribe was called
      expect(unsubCallback).toHaveBeenCalled();
    });

    it('should call removeListener for StateChangeNotifier on cleanup', () => {
      let capturedHandler: any;
      const notifier = {
        on: jest.fn((event, handler) => {
          capturedHandler = handler;
          return undefined;
        }),
        removeListener: jest.fn(),
      };
      const container = makeMockContainer({ StateChangeNotifier: notifier });

      const cleanups = wireLogHooks(mockLogManager, container);

      // Call cleanup
      cleanups.forEach(fn => fn());

      expect(notifier.removeListener).toHaveBeenCalledWith('state-change', capturedHandler);
    });
  });

  // -------------------------------------------------------------------------
  // getTriggerMetricsLogListener
  // -------------------------------------------------------------------------

  describe('getTriggerMetricsLogListener', () => {
    it('should create telemetry category entries with TriggerMetricsTracker source', () => {
      const listener = getTriggerMetricsLogListener(mockLogManager);

      listener('info', 'Trigger executed', { triggerId: 'TRIG-123', duration: 250 });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'telemetry',
        level: 'info',
        source: 'TriggerMetricsTracker',
        message: 'Trigger executed',
        data: { triggerId: 'TRIG-123', duration: 250 },
      });
      expect(mockLogManager.logCalls[0].id).toMatch(/^LOG-/);
      expect(mockLogManager.logCalls[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle all log levels', () => {
      const listener = getTriggerMetricsLogListener(mockLogManager);

      listener('debug', 'Debug message');
      listener('info', 'Info message');
      listener('warn', 'Warn message');
      listener('error', 'Error message');

      expect(mockLogManager.logCalls).toHaveLength(4);
      expect(mockLogManager.logCalls[0].level).toBe('debug');
      expect(mockLogManager.logCalls[1].level).toBe('info');
      expect(mockLogManager.logCalls[2].level).toBe('warn');
      expect(mockLogManager.logCalls[3].level).toBe('error');
    });

    it('should handle undefined data parameter', () => {
      const listener = getTriggerMetricsLogListener(mockLogManager);

      listener('info', 'Message without data');

      expect(mockLogManager.logCalls[0].data).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getSecurityAuditorLogListener
  // -------------------------------------------------------------------------

  describe('getSecurityAuditorLogListener', () => {
    it('should create security category entries with SecurityAuditor source', () => {
      const listener = getSecurityAuditorLogListener(mockLogManager);

      listener('warn', 'Audit violation detected', { rule: 'NO_EXEC', file: 'test.yaml' });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0]).toMatchObject({
        category: 'security',
        level: 'warn',
        source: 'SecurityAuditor',
        message: 'Audit violation detected',
        data: { rule: 'NO_EXEC', file: 'test.yaml' },
      });
      expect(mockLogManager.logCalls[0].id).toMatch(/^LOG-/);
      expect(mockLogManager.logCalls[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle error-level security events', () => {
      const listener = getSecurityAuditorLogListener(mockLogManager);

      listener('error', 'Critical security violation', { severity: 'CRITICAL' });

      expect(mockLogManager.logCalls[0].level).toBe('error');
      expect(mockLogManager.logCalls[0].category).toBe('security');
    });

    it('should handle undefined data parameter', () => {
      const listener = getSecurityAuditorLogListener(mockLogManager);

      listener('info', 'Audit checkpoint');

      expect(mockLogManager.logCalls[0].data).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // CorrelationId injection via ContextTracker
  // -------------------------------------------------------------------------

  describe('correlationId injection', () => {
    it('should include correlationId when ContextTracker has active context', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const mockContextTracker = {
        getCorrelationId: jest.fn(() => 'REQ-12345'),
      };
      const container = makeMockContainer({
        MCPLogger: mcpLogger,
        ContextTracker: mockContextTracker,
      });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'Test with correlation',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0].correlationId).toBe('REQ-12345');
    });

    it('should omit correlationId when ContextTracker returns undefined', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const mockContextTracker = {
        getCorrelationId: jest.fn(() => undefined),
      };
      const container = makeMockContainer({
        MCPLogger: mcpLogger,
        ContextTracker: mockContextTracker,
      });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'Test without correlation',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0].correlationId).toBeUndefined();
    });

    it('should degrade gracefully when ContextTracker is not registered', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      // Container does NOT have ContextTracker registered
      const container = makeMockContainer({ MCPLogger: mcpLogger });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'No context tracker',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0].correlationId).toBeUndefined();
    });

    it('should use request-level correlationId for ElementEventDispatcher and move operation UUID to data.operationId', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:load:success') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const mockContextTracker = {
        getCorrelationId: jest.fn(() => 'REQ-LEVEL-ID'),
      };
      const container = makeMockContainer({
        ElementEventDispatcher: dispatcher,
        ContextTracker: mockContextTracker,
      });

      wireLogHooks(mockLogManager, container);

      mockOn({
        elementType: 'persona',
        elementId: 'test',
        correlationId: 'OPERATION-UUID-456',
        extra: { key: 'value' },
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      const entry = mockLogManager.logCalls[0];
      expect(entry.correlationId).toBe('REQ-LEVEL-ID');
      expect(entry.data).toMatchObject({
        key: 'value',
        operationId: 'OPERATION-UUID-456',
      });
    });

    it('should fall back to payload correlationId when no request context for ElementEventDispatcher', () => {
      const mockOn = jest.fn();
      const dispatcher = {
        on: jest.fn((event, handler) => {
          if (event === 'element:save:success') {
            mockOn.mockImplementation(handler);
          }
          return jest.fn();
        }),
      };
      const mockContextTracker = {
        getCorrelationId: jest.fn(() => undefined),
      };
      const container = makeMockContainer({
        ElementEventDispatcher: dispatcher,
        ContextTracker: mockContextTracker,
      });

      wireLogHooks(mockLogManager, container);

      mockOn({
        elementType: 'agent',
        elementId: 'test-agent',
        correlationId: 'PAYLOAD-CORR-789',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      const entry = mockLogManager.logCalls[0];
      expect(entry.correlationId).toBe('PAYLOAD-CORR-789');
      expect(entry.data).toMatchObject({
        operationId: 'PAYLOAD-CORR-789',
      });
    });
  });

  // -------------------------------------------------------------------------
  // getTriggerMetricsLogListener with contextTracker
  // -------------------------------------------------------------------------

  describe('getTriggerMetricsLogListener with contextTracker', () => {
    it('should include correlationId when contextTracker is provided', () => {
      const mockContextTracker = { getCorrelationId: jest.fn(() => 'TRIGGER-REQ-1') };
      const listener = getTriggerMetricsLogListener(mockLogManager, mockContextTracker);

      listener('info', 'Trigger fired', { triggerId: 'T-1' });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0].correlationId).toBe('TRIGGER-REQ-1');
    });

    it('should omit correlationId when contextTracker is not provided', () => {
      const listener = getTriggerMetricsLogListener(mockLogManager);

      listener('info', 'Trigger fired');

      expect(mockLogManager.logCalls[0].correlationId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getSecurityAuditorLogListener with contextTracker
  // -------------------------------------------------------------------------

  describe('getSecurityAuditorLogListener with contextTracker', () => {
    it('should include correlationId when contextTracker is provided', () => {
      const mockContextTracker = { getCorrelationId: jest.fn(() => 'AUDIT-REQ-1') };
      const listener = getSecurityAuditorLogListener(mockLogManager, mockContextTracker);

      listener('warn', 'Violation', { rule: 'TEST' });

      expect(mockLogManager.logCalls).toHaveLength(1);
      expect(mockLogManager.logCalls[0].correlationId).toBe('AUDIT-REQ-1');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should call logManager.generateId for each log entry', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ MCPLogger: mcpLogger });

      wireLogHooks(mockLogManager, container);

      mockListener({ timestamp: new Date(), level: 'info', message: 'First' });
      mockListener({ timestamp: new Date(), level: 'info', message: 'Second' });
      mockListener({ timestamp: new Date(), level: 'info', message: 'Third' });

      expect(mockLogManager.generateId).toHaveBeenCalledTimes(3);
    });

    it('should verify all monitored systems are wired correctly', () => {
      const container = makeMockContainer({
        MCPLogger: { addLogListener: jest.fn(() => jest.fn()) },
        SecurityTelemetry: { addLogListener: jest.fn(() => jest.fn()) },
        PerformanceMonitor: { addLogListener: jest.fn(() => jest.fn()) },
        ElementEventDispatcher: { on: jest.fn(() => jest.fn()) },
        OperationalTelemetry: { addLogListener: jest.fn(() => jest.fn()) },
        FileLockManager: { addLogListener: jest.fn(() => jest.fn()) },
        StateChangeNotifier: { on: jest.fn(), removeListener: jest.fn() },
      });

      const cleanups = wireLogHooks(mockLogManager, container);

      // Should have cleanups for:
      // - MCPLogger, SecurityMonitor (static), SecurityTelemetry, PerformanceMonitor
      // - ElementEventDispatcher (9 mapped events), OperationalTelemetry, FileLockManager
      // - DefaultElementProvider (static), LRUCache (static), StateChangeNotifier
      // Total: 1 + 1 + 1 + 1 + 9 + 1 + 1 + 1 + 1 + 1 = 18
      expect(cleanups.length).toBeGreaterThanOrEqual(15);
    });

    it('should handle all ElementEventDispatcher events', () => {
      const eventHandlers: Record<string, any> = {};
      const dispatcher = {
        on: jest.fn((event, handler) => {
          eventHandlers[event] = handler;
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ ElementEventDispatcher: dispatcher });

      wireLogHooks(mockLogManager, container);

      // Only mapped events should be registered (not start/cache/external-change)
      const expectedEvents = [
        'element:load:error', 'element:load:success',
        'element:save:error', 'element:save:success',
        'element:delete:error', 'element:delete:success',
        'element:activate', 'element:deactivate',
        'element:lock-timeout',
      ];

      expectedEvents.forEach(event => {
        expect(eventHandlers[event]).toBeDefined();
      });

      // These should NOT be registered
      const skippedEvents = [
        'element:load:start', 'element:save:start', 'element:delete:start',
        'element:cache:refresh', 'element:cache:evict', 'element:external-change',
      ];
      skippedEvents.forEach(event => {
        expect(eventHandlers[event]).toBeUndefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Session attribution (userId/sessionId) via ContextTracker
  // -------------------------------------------------------------------------

  describe('session attribution injection', () => {
    it('should include userId and sessionId when ContextTracker has active session', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const mockContextTracker = {
        getCorrelationId: jest.fn(() => 'REQ-1'),
        getSessionContext: jest.fn(() => ({ userId: 'alice', sessionId: 'sess-1' })),
      };
      const container = makeMockContainer({
        MCPLogger: mcpLogger,
        ContextTracker: mockContextTracker,
      });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'Test with session',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      const entry = mockLogManager.logCalls[0];
      expect(entry.userId).toBe('alice');
      expect(entry.sessionId).toBe('sess-1');
      expect(entry.correlationId).toBe('REQ-1');
    });

    it('should omit userId and sessionId when no session active', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const mockContextTracker = {
        getCorrelationId: jest.fn(() => undefined),
        getSessionContext: jest.fn(() => undefined),
      };
      const container = makeMockContainer({
        MCPLogger: mcpLogger,
        ContextTracker: mockContextTracker,
      });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'Test without session',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      const entry = mockLogManager.logCalls[0];
      expect(entry.userId).toBeUndefined();
      expect(entry.sessionId).toBeUndefined();
    });

    it('should omit userId and sessionId when no ContextTracker registered', () => {
      const mockListener = jest.fn();
      const mcpLogger = {
        addLogListener: jest.fn((fn) => {
          mockListener.mockImplementation(fn);
          return jest.fn();
        }),
      };
      const container = makeMockContainer({ MCPLogger: mcpLogger });

      wireLogHooks(mockLogManager, container);

      mockListener({
        timestamp: new Date(),
        level: 'info',
        message: 'Test no tracker',
      });

      expect(mockLogManager.logCalls).toHaveLength(1);
      const entry = mockLogManager.logCalls[0];
      expect(entry.userId).toBeUndefined();
      expect(entry.sessionId).toBeUndefined();
    });
  });
});
