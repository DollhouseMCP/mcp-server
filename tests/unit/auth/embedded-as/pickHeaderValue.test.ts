/**
 * pickHeaderValue — Cycle-13 fix for the UA-array coercion bug.
 *
 * Express's `req.headers[name]` is `string | string[] | undefined`.
 * Earlier shape passed the value directly to `createHmac.update(...)`
 * which coerces an array via `toString()` to a comma-joined string
 * — producing a different hash from the same value sent as a single
 * header. The helper normalizes to the first element of an array,
 * making the rotation-context HMAC stable across header shapes.
 */

import { describe, it, expect } from '@jest/globals';
import { pickHeaderValue } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';

describe('pickHeaderValue (Cycle-13)', () => {
  it('returns a single string unchanged', () => {
    expect(pickHeaderValue('Mozilla/5.0')).toBe('Mozilla/5.0');
  });

  it('returns undefined for missing header', () => {
    expect(pickHeaderValue(undefined)).toBeUndefined();
  });

  it('returns first element when header is an array', () => {
    expect(pickHeaderValue(['agent-1', 'agent-2'])).toBe('agent-1');
  });

  it('returns undefined for empty array', () => {
    expect(pickHeaderValue([])).toBeUndefined();
  });

  it('returns the only element when array has length 1', () => {
    expect(pickHeaderValue(['only-agent'])).toBe('only-agent');
  });

  // Cycle-13 regression assertion: the same UA value sent as a
  // single header vs. a single-element array must produce the same
  // pickHeaderValue output. Earlier shape would have differed.
  it('regression: scalar string and single-element array produce the same value', () => {
    expect(pickHeaderValue('test-agent')).toBe(pickHeaderValue(['test-agent']));
  });

  it('regression: array form does not coerce to comma-joined string', () => {
    // Pre-cycle-13, `createHmac.update(['a', 'b'])` would call
    // `arr.toString()` producing 'a,b'. The helper picks 'a' so the
    // result has no comma.
    const value = pickHeaderValue(['a', 'b']);
    expect(value).toBe('a');
    expect(value).not.toContain(',');
  });
});
