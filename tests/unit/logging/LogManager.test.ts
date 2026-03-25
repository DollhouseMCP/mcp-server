import { LogManager, buildLogManagerConfig } from '../../../src/logging/LogManager.js';
import type {
  UnifiedLogEntry,
  ILogSink,
  LogManagerConfig,
} from '../../../src/logging/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<LogManagerConfig> = {}): LogManagerConfig {
  return {
    logDir: '/tmp/test-logs',
    logFormat: 'text',
    retentionDays: 30,
    securityRetentionDays: 90,
    flushIntervalMs: 0, // disable timer in tests
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
    logLevel: 'debug',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<UnifiedLogEntry> = {}): UnifiedLogEntry {
  return {
    id: 'LOG-1-0',
    timestamp: new Date().toISOString(),
    category: 'application',
    level: 'info',
    source: 'TestSource',
    message: 'test message',
    ...overrides,
  };
}

function makeMockSink(): ILogSink & {
  written: UnifiedLogEntry[];
  flushCount: number;
  closeCount: number;
} {
  const sink = {
    written: [] as UnifiedLogEntry[],
    flushCount: 0,
    closeCount: 0,
    write(entry: UnifiedLogEntry) {
      sink.written.push(entry);
    },
    async flush() {
      sink.flushCount++;
    },
    async close() {
      sink.closeCount++;
    },
  };
  return sink;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogManager', () => {
  let manager: LogManager;

  afterEach(async () => {
    if (manager) await manager.close();
  });

  // --- Routing ---

  it('routes entries to all registered sinks', () => {
    manager = new LogManager(makeConfig());
    const sinkA = makeMockSink();
    const sinkB = makeMockSink();
    manager.registerSink(sinkA);
    manager.registerSink(sinkB);

    const entry = makeEntry();
    manager.log(entry);

    expect(sinkA.written).toHaveLength(1);
    expect(sinkB.written).toHaveLength(1);
    expect(sinkA.written[0].message).toBe('test message');
    expect(sinkB.written[0].message).toBe('test message');
  });

  // --- Level filtering ---

  it('filters entries below the minimum log level', () => {
    manager = new LogManager(makeConfig({ logLevel: 'warn' }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    manager.log(makeEntry({ level: 'debug' }));
    manager.log(makeEntry({ level: 'info' }));
    manager.log(makeEntry({ level: 'warn' }));
    manager.log(makeEntry({ level: 'error' }));

    expect(sink.written).toHaveLength(2);
    expect(sink.written[0].level).toBe('warn');
    expect(sink.written[1].level).toBe('error');
  });

  // --- Sink registration ---

  it('supports multiple sinks receiving the same entries', () => {
    manager = new LogManager(makeConfig());
    const sinks = [makeMockSink(), makeMockSink(), makeMockSink()];
    sinks.forEach((s) => manager.registerSink(s));

    manager.log(makeEntry());

    sinks.forEach((s) => {
      expect(s.written).toHaveLength(1);
    });
  });

  // --- Entry size enforcement ---

  it('truncates oversized entries and sets _truncated flag', () => {
    const maxSize = 200;
    manager = new LogManager(makeConfig({ maxEntrySize: maxSize }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    // Create an entry with a large data field
    const bigData: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      bigData[`key_${i}`] = 'x'.repeat(20);
    }
    const entry = makeEntry({ data: bigData });
    manager.log(entry);

    // Should have 2 writes: truncation warning + the truncated entry
    expect(sink.written).toHaveLength(2);

    // First write is the truncation warning meta-entry
    const warning = sink.written[0];
    expect(warning.level).toBe('warn');
    expect(warning.source).toBe('LogManager');
    expect(warning.message).toContain('truncated');

    // Second write is the truncated entry
    const truncated = sink.written[1];
    expect(truncated.data?._truncated).toBe(true);
    expect(truncated.data?._originalSize).toBeGreaterThan(maxSize);
  });

  it('does not truncate entries under the size limit', () => {
    manager = new LogManager(makeConfig());
    const sink = makeMockSink();
    manager.registerSink(sink);

    const entry = makeEntry({ data: { small: 'value' } });
    manager.log(entry);

    expect(sink.written).toHaveLength(1);
    expect(sink.written[0].data).toEqual({ small: 'value' });
  });

  // --- Buffer flush on threshold ---

  it('triggers flush when buffer reaches capacity', async () => {
    const bufferSize = 5;
    manager = new LogManager(makeConfig({ bufferSize }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    for (let i = 0; i < bufferSize; i++) {
      manager.log(makeEntry({ id: `LOG-1-${i}` }));
    }

    // Wait for the async flush triggered by buffer-full
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.flushCount).toBeGreaterThanOrEqual(1);
  });

  // --- Timer flush ---

  it('triggers flush on timer interval', async () => {
    const flushIntervalMs = 50;
    manager = new LogManager(makeConfig({ flushIntervalMs }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    manager.log(makeEntry());

    // Wait for the timer to fire
    await new Promise((r) => setTimeout(r, flushIntervalMs + 30));
    expect(sink.flushCount).toBeGreaterThanOrEqual(1);
  });

  // --- Immediate flush for security warn/error ---

  it('triggers immediate flush for security warn entries', async () => {
    manager = new LogManager(makeConfig());
    const sink = makeMockSink();
    manager.registerSink(sink);

    manager.log(makeEntry({ category: 'security', level: 'warn' }));

    await new Promise((r) => setTimeout(r, 10));
    expect(sink.flushCount).toBeGreaterThanOrEqual(1);
  });

  it('triggers immediate flush for security error entries', async () => {
    manager = new LogManager(makeConfig());
    const sink = makeMockSink();
    manager.registerSink(sink);

    manager.log(makeEntry({ category: 'security', level: 'error' }));

    await new Promise((r) => setTimeout(r, 10));
    expect(sink.flushCount).toBeGreaterThanOrEqual(1);
  });

  it('does not immediately flush for security info entries', async () => {
    manager = new LogManager(makeConfig());
    const sink = makeMockSink();
    manager.registerSink(sink);

    manager.log(makeEntry({ category: 'security', level: 'info' }));

    // Give enough time for any async flush to fire
    await new Promise((r) => setTimeout(r, 10));
    // No flush should have been triggered (timer is disabled)
    expect(sink.flushCount).toBe(0);
  });

  // --- Rate limiting ---

  it('demotes excess immediate flushes to buffered path', async () => {
    const rate = 3;
    manager = new LogManager(makeConfig({ immediateFlushRate: rate }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    // Send more security errors than the rate limit
    for (let i = 0; i < rate + 5; i++) {
      manager.log(
        makeEntry({ id: `LOG-1-${i}`, category: 'security', level: 'error' }),
      );
    }

    await new Promise((r) => setTimeout(r, 10));

    // Should not exceed rate limit for immediate flushes
    // (some will be demoted to buffer instead)
    expect(sink.flushCount).toBeLessThanOrEqual(rate);
  });

  // --- Backpressure / eviction ---

  it('evicts oldest entries when buffer overflows and tracks drop count', async () => {
    const bufferSize = 3;
    // Threshold is max(5, ceil(bufferSize * 0.1)) = 5, so we need >= 5 drops
    const overflowCount = 6;
    manager = new LogManager(makeConfig({ bufferSize, logLevel: 'debug' }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    // Fill the buffer and overflow enough to exceed the drop-report threshold
    // Use application category with debug level to avoid immediate flush
    for (let i = 0; i < bufferSize + overflowCount; i++) {
      manager.log(
        makeEntry({
          id: `LOG-1-${i}`,
          category: 'application',
          level: 'debug',
        }),
      );
    }

    // Manually flush to see drop reporting
    await manager.flush();

    // The flush should have emitted a drop-report meta-entry
    const dropReport = sink.written.find(
      (e) =>
        e.source === 'LogManager' && e.message.includes('evicted'),
    );
    expect(dropReport).toBeDefined();
    expect(dropReport!.level).toBe('warn');
  });

  // --- Drop reporting ---

  it('reports drops at most once per flush', async () => {
    const bufferSize = 2;
    // Threshold is max(5, ceil(bufferSize * 0.1)) = 5, so overflow by 6
    const overflowCount = 6;
    manager = new LogManager(makeConfig({ bufferSize, logLevel: 'debug' }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    // Overflow the buffer enough to exceed the drop-report threshold
    for (let i = 0; i < bufferSize + overflowCount; i++) {
      manager.log(
        makeEntry({
          id: `LOG-1-${i}`,
          category: 'application',
          level: 'debug',
        }),
      );
    }

    await manager.flush();
    const dropReports1 = sink.written.filter(
      (e) => e.source === 'LogManager' && e.message.includes('evicted'),
    );

    // Second flush should not produce another drop report
    await manager.flush();
    const dropReports2 = sink.written.filter(
      (e) => e.source === 'LogManager' && e.message.includes('evicted'),
    );

    expect(dropReports2.length).toBe(dropReports1.length);
  });

  // --- Graceful shutdown ---

  it('flushes and closes all sinks on close()', async () => {
    manager = new LogManager(makeConfig());
    const sink = makeMockSink();
    manager.registerSink(sink);

    manager.log(makeEntry());
    await manager.close();

    expect(sink.flushCount).toBeGreaterThanOrEqual(1);
    expect(sink.closeCount).toBe(1);
  });

  it('clears the flush timer on close()', async () => {
    manager = new LogManager(makeConfig({ flushIntervalMs: 50 }));
    const sink = makeMockSink();
    manager.registerSink(sink);

    await manager.close();

    const flushCountAtClose = sink.flushCount;
    // Wait to see if the timer fires again
    await new Promise((r) => setTimeout(r, 100));
    expect(sink.flushCount).toBe(flushCountAtClose);
  });

  // --- ID generation ---

  it('generates IDs in LOG-{timestamp}-{counter} format', () => {
    manager = new LogManager(makeConfig());
    const id = manager.generateId();
    expect(id).toMatch(/^LOG-\d+-\d+$/);
  });

  it('generates sequential counter values', () => {
    manager = new LogManager(makeConfig());
    const id1 = manager.generateId();
    const id2 = manager.generateId();
    const counter1 = parseInt(id1.split('-')[2]);
    const counter2 = parseInt(id2.split('-')[2]);
    expect(counter2).toBe(counter1 + 1);
  });

  // --- No sinks ---

  it('handles logging with no sinks registered (graceful no-op)', () => {
    manager = new LogManager(makeConfig());
    expect(() => {
      manager.log(makeEntry());
    }).not.toThrow();
  });

  // --- Entries without data ---

  it('passes through entries without data field unchanged', () => {
    manager = new LogManager(makeConfig());
    const sink = makeMockSink();
    manager.registerSink(sink);

    const entry = makeEntry(); // no data field
    manager.log(entry);

    expect(sink.written).toHaveLength(1);
    expect(sink.written[0].data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildLogManagerConfig
// ---------------------------------------------------------------------------

describe('buildLogManagerConfig', () => {
  it('maps env vars to LogManagerConfig', () => {
    const envVars = {
      DOLLHOUSE_LOG_DIR: '/custom/logs',
      DOLLHOUSE_LOG_FORMAT: 'jsonl' as const,
      DOLLHOUSE_LOG_RETENTION_DAYS: 15,
      DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS: 60,
      DOLLHOUSE_LOG_FLUSH_INTERVAL_MS: 3000,
      DOLLHOUSE_LOG_BUFFER_SIZE: 200,
      DOLLHOUSE_LOG_MEMORY_CAPACITY: 4000,
      DOLLHOUSE_LOG_MEMORY_APP_CAPACITY: 4000,
      DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY: 2500,
      DOLLHOUSE_LOG_MEMORY_PERF_CAPACITY: 1500,
      DOLLHOUSE_LOG_MEMORY_TELEMETRY_CAPACITY: 800,
      DOLLHOUSE_LOG_MAX_ENTRY_SIZE: 8192,
      DOLLHOUSE_LOG_IMMEDIATE_FLUSH_RATE: 25,
      DOLLHOUSE_LOG_FILE_MAX_SIZE: 52428800,
      LOG_LEVEL: 'warn' as const,
    };

    const config = buildLogManagerConfig(envVars);

    expect(config.logDir).toBe('/custom/logs');
    expect(config.logFormat).toBe('jsonl');
    expect(config.retentionDays).toBe(15);
    expect(config.securityRetentionDays).toBe(60);
    expect(config.flushIntervalMs).toBe(3000);
    expect(config.bufferSize).toBe(200);
    expect(config.memoryCapacity).toBe(4000);
    expect(config.memoryAppCapacity).toBe(4000);
    expect(config.memorySecurityCapacity).toBe(2500);
    expect(config.memoryPerfCapacity).toBe(1500);
    expect(config.memoryTelemetryCapacity).toBe(800);
    expect(config.maxEntrySize).toBe(8192);
    expect(config.immediateFlushRate).toBe(25);
    expect(config.fileMaxSize).toBe(52428800);
    expect(config.logLevel).toBe('warn');
  });
});
