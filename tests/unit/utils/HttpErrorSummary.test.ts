import { describe, expect, it } from '@jest/globals';
import { httpErrorMessage } from '../../../src/utils/HttpErrorSummary.js';

describe('bounded HTTP throwable summaries', () => {
  it('retains Error messages and primitive stringification', () => {
    expect(httpErrorMessage(new Error('failure'))).toBe('failure');
    expect(httpErrorMessage(42)).toBe('42');
    expect(httpErrorMessage(null)).toBe('null');
  });
  it('never serializes request credentials, circular objects or free-form messages', () => {
    const thrown: Record<string, unknown> = { code: 'ECONNRESET', name: 'RequestFailure', message: 'Authorization: Bearer secret', headers: { Authorization: 'Bearer secret' }, config: { token: 'secret' } };
    thrown.circular = thrown;
    const summary = httpErrorMessage(thrown);
    expect(summary).toContain('ECONNRESET'); expect(summary).toContain('message=[redacted]');
    expect(summary).not.toContain('secret'); expect(summary.length).toBeLessThan(256);
  });
  it('does not invoke getters or custom inspection and bounds classifier values', () => {
    const thrown = { get message() { throw new Error('getter'); }, code: 'x'.repeat(1000) };
    expect(httpErrorMessage(thrown)).toContain('code=[redacted]');
    expect(httpErrorMessage(thrown)).toContain('message=[redacted]');
  });

});
