import { describe, test, expect } from '@jest/globals';
import { PlainTextFormatter } from '../../../../src/logging/formatters/PlainTextFormatter.js';
import type { UnifiedLogEntry } from '../../../../src/logging/types.js';

function makeEntry(overrides: Partial<UnifiedLogEntry> = {}): UnifiedLogEntry {
  return {
    id: 'LOG-1234-0',
    timestamp: '2026-02-10T15:30:02.123Z',
    category: 'application',
    level: 'info',
    source: 'TestSource',
    message: 'Test message',
    ...overrides,
  };
}

describe('PlainTextFormatter', () => {
  const formatter = new PlainTextFormatter();

  test('fileExtension is .log', () => {
    expect(formatter.fileExtension).toBe('.log');
  });

  test('formats minimal entry with correct header line', () => {
    const output = formatter.format(makeEntry());
    const lines = output.split('\n');
    expect(lines[0]).toBe('[2026-02-10 15:30:02.123] [INFO] [TestSource] Test message');
  });

  test('entry ends with blank line separator', () => {
    const output = formatter.format(makeEntry());
    expect(output.endsWith('\n\n')).toBe(true);
  });

  test('formats entry with data as indented key-value lines', () => {
    const output = formatter.format(makeEntry({
      data: { path: '../../etc/passwd', severity: 'HIGH' },
    }));
    expect(output).toContain('  path: ../../etc/passwd\n');
    expect(output).toContain('  severity: HIGH\n');
  });

  test('formats entry with error name, message, and stack', () => {
    const output = formatter.format(makeEntry({
      level: 'error',
      error: {
        name: 'TypeError',
        message: 'Cannot read property',
        stack: 'at foo (file.ts:1)\nat bar (file.ts:2)',
      },
    }));
    expect(output).toContain('  TypeError: Cannot read property\n');
    expect(output).toContain('  at foo (file.ts:1)\n');
    expect(output).toContain('  at bar (file.ts:2)\n');
  });

  test('formats entry with error but no stack', () => {
    const output = formatter.format(makeEntry({
      error: { name: 'Error', message: 'oops' },
    }));
    expect(output).toContain('  Error: oops\n');
    // Should not have extra stack lines
    const lines = output.split('\n');
    const errorLineIndex = lines.findIndex(l => l.includes('Error: oops'));
    // Next non-empty line should be blank separator or data, not stack
    expect(lines[errorLineIndex + 1]).toBe('');
  });

  test('nested objects in data are JSON.stringified inline', () => {
    const output = formatter.format(makeEntry({
      data: { nested: { a: 1, b: [2, 3] } },
    }));
    expect(output).toContain('  nested: {"a":1,"b":[2,3]}\n');
  });

  test('formats entry with all fields', () => {
    const output = formatter.format(makeEntry({
      level: 'error',
      source: 'InputValidator',
      message: 'Path traversal blocked',
      data: { path: '../../etc/passwd', severity: 'HIGH' },
      error: { name: 'SecurityError', message: 'blocked' },
      correlationId: 'corr-123',
    }));
    expect(output).toContain('[ERROR]');
    expect(output).toContain('[InputValidator]');
    expect(output).toContain('Path traversal blocked');
    expect(output).toContain('  SecurityError: blocked');
    expect(output).toContain('  path: ../../etc/passwd');
    expect(output).toContain('  severity: HIGH');
  });

  test('correlationId appears in header when present', () => {
    const output = formatter.format(makeEntry({ correlationId: 'REQ-123-abc' }));
    const lines = output.split('\n');
    expect(lines[0]).toBe('[2026-02-10 15:30:02.123] [INFO] [TestSource] [REQ-123-abc] Test message');
  });

  test('no empty brackets when correlationId is absent', () => {
    const output = formatter.format(makeEntry());
    const lines = output.split('\n');
    expect(lines[0]).toBe('[2026-02-10 15:30:02.123] [INFO] [TestSource] Test message');
    expect(lines[0]).not.toContain('[]');
  });

  test('null and undefined data values are stringified', () => {
    const output = formatter.format(makeEntry({
      data: { count: 0, flag: false, nothing: null as unknown },
    }));
    expect(output).toContain('  count: 0\n');
    expect(output).toContain('  flag: false\n');
    expect(output).toContain('  nothing: null\n');
  });
});
