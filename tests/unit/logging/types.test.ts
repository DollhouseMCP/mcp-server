import {
  LOG_LEVEL_PRIORITY,
  type UnifiedLogEntry,
  type LogCategory,
  type LogLevel,
  type ILogSink,
  type ILogFormatter,
  type LogManagerConfig,
} from '../../../src/logging/types.js';

describe('Logging types', () => {
  describe('LOG_LEVEL_PRIORITY', () => {
    it('assigns increasing priority from debug to error', () => {
      expect(LOG_LEVEL_PRIORITY.debug).toBeLessThan(LOG_LEVEL_PRIORITY.info);
      expect(LOG_LEVEL_PRIORITY.info).toBeLessThan(LOG_LEVEL_PRIORITY.warn);
      expect(LOG_LEVEL_PRIORITY.warn).toBeLessThan(LOG_LEVEL_PRIORITY.error);
    });

    it('covers all four log levels', () => {
      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
      levels.forEach((level) => {
        expect(LOG_LEVEL_PRIORITY[level]).toBeDefined();
        expect(typeof LOG_LEVEL_PRIORITY[level]).toBe('number');
      });
    });
  });

  describe('UnifiedLogEntry (structural validation)', () => {
    it('accepts a minimal valid entry', () => {
      const entry: UnifiedLogEntry = {
        id: 'LOG-1707580202123-42',
        timestamp: '2026-02-10T15:30:02.123Z',
        category: 'application',
        level: 'info',
        source: 'TestComponent',
        message: 'Something happened',
      };
      expect(entry.id).toMatch(/^LOG-/);
      expect(entry.data).toBeUndefined();
      expect(entry.error).toBeUndefined();
      expect(entry.correlationId).toBeUndefined();
    });

    it('accepts a fully populated entry', () => {
      const entry: UnifiedLogEntry = {
        id: 'LOG-1707580202123-42',
        timestamp: '2026-02-10T15:30:02.123Z',
        category: 'security',
        level: 'error',
        source: 'InputValidator',
        message: 'Path traversal blocked',
        data: { path: '../../etc/passwd', severity: 'HIGH' },
        error: { name: 'SecurityError', message: 'Blocked', stack: 'at ...' },
        correlationId: 'req-1707580202123-1',
      };
      expect(entry.data).toBeDefined();
      expect(entry.error?.name).toBe('SecurityError');
      expect(entry.correlationId).toMatch(/^req-/);
    });
  });

  describe('LogCategory', () => {
    it('accepts all valid categories', () => {
      const categories: LogCategory[] = [
        'application',
        'security',
        'performance',
        'telemetry',
      ];
      // TypeScript compile-time check — at runtime just verify the array length
      expect(categories).toHaveLength(4);
    });
  });

  describe('LogManagerConfig defaults', () => {
    it('has expected shape', () => {
      const config: LogManagerConfig = {
        logDir: '~/.dollhouse/logs/',
        logFormat: 'text',
        retentionDays: 30,
        securityRetentionDays: 90,
        flushIntervalMs: 5000,
        bufferSize: 100,
        memoryCapacity: 5000,
        memoryAppCapacity: 5000,
        memorySecurityCapacity: 3000,
        memoryPerfCapacity: 2000,
        memoryTelemetryCapacity: 1000,
        maxEntrySize: 16384,
        immediateFlushRate: 50,
        fileMaxSize: 104857600,
        viewerEnabled: false,
        viewerPort: 9100,
        logLevel: 'info',
      };

      expect(config.bufferSize).toBe(100);
      expect(config.viewerEnabled).toBe(false);
      expect(config.logLevel).toBe('info');
    });
  });

  describe('ILogSink interface (structural)', () => {
    it('can be implemented with required methods', () => {
      const sink: ILogSink = {
        write(_entry: UnifiedLogEntry) { /* no-op */ },
        async flush() { /* no-op */ },
        async close() { /* no-op */ },
      };
      expect(typeof sink.write).toBe('function');
      expect(typeof sink.flush).toBe('function');
      expect(typeof sink.close).toBe('function');
    });
  });

  describe('ILogFormatter interface (structural)', () => {
    it('can be implemented with required members', () => {
      const formatter: ILogFormatter = {
        format(_entry: UnifiedLogEntry) {
          return 'formatted';
        },
        fileExtension: '.log',
      };
      expect(typeof formatter.format).toBe('function');
      expect(formatter.fileExtension).toBe('.log');
    });
  });
});
