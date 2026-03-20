import { describe, test, expect } from '@jest/globals';
import { JsonlFormatter } from '../../../../src/logging/formatters/JsonlFormatter.js';
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

describe('JsonlFormatter', () => {
  const formatter = new JsonlFormatter();

  test('fileExtension is .jsonl', () => {
    expect(formatter.fileExtension).toBe('.jsonl');
  });

  test('formats minimal entry as valid JSON on one line ending with newline', () => {
    const output = formatter.format(makeEntry());
    expect(output.endsWith('\n')).toBe(true);
    expect(output.trim().includes('\n')).toBe(false);
    const parsed = JSON.parse(output);
    expect(parsed).toBeDefined();
  });

  test('uses shortened keys', () => {
    const output = formatter.format(makeEntry());
    const parsed = JSON.parse(output);
    expect(parsed.ts).toBe('2026-02-10T15:30:02.123Z');
    expect(parsed.cat).toBe('application');
    expect(parsed.src).toBe('TestSource');
    expect(parsed.msg).toBe('Test message');
    // Long keys should not exist
    expect(parsed.timestamp).toBeUndefined();
    expect(parsed.category).toBeUndefined();
    expect(parsed.source).toBeUndefined();
    expect(parsed.message).toBeUndefined();
  });

  test('omits optional fields when absent', () => {
    const output = formatter.format(makeEntry());
    const parsed = JSON.parse(output);
    expect('data' in parsed).toBe(false);
    expect('error' in parsed).toBe(false);
    expect('correlationId' in parsed).toBe(false);
  });

  test('includes all fields when present', () => {
    const output = formatter.format(makeEntry({
      data: { key: 'value' },
      error: { name: 'Error', message: 'fail', stack: 'at x' },
      correlationId: 'corr-42',
    }));
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('LOG-1234-0');
    expect(parsed.ts).toBe('2026-02-10T15:30:02.123Z');
    expect(parsed.level).toBe('info');
    expect(parsed.cat).toBe('application');
    expect(parsed.src).toBe('TestSource');
    expect(parsed.msg).toBe('Test message');
    expect(parsed.data).toEqual({ key: 'value' });
    expect(parsed.error).toEqual({ name: 'Error', message: 'fail', stack: 'at x' });
    expect(parsed.correlationId).toBe('corr-42');
  });

  test('output is parseable JSON', () => {
    const entries = [
      makeEntry(),
      makeEntry({ level: 'error', data: { nested: { x: [1, 2] } } }),
      makeEntry({ error: { name: 'E', message: 'm' } }),
    ];
    for (const entry of entries) {
      const output = formatter.format(entry);
      expect(() => JSON.parse(output)).not.toThrow();
    }
  });
});
