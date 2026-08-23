import { describe, expect, it } from '@jest/globals';

import {
  decodeConsoleCursor,
  encodeConsoleCursor,
  offsetConsoleCursor,
  offsetFromConsoleCursor,
} from '../../../../src/web-console/platform/ConsoleCursor.js';

describe('ConsoleCursor', () => {
  it('round-trips a payload through an opaque token', () => {
    const token = encodeConsoleCursor({ o: 42, k: 'seq' });
    expect(token).not.toContain('42');
    expect(decodeConsoleCursor(token)).toEqual({ o: 42, k: 'seq' });
  });

  it.each([
    ['empty string', ''],
    ['not base64 json', 'garbage!!!'],
    ['json but not an object', Buffer.from('[1,2]').toString('base64url')],
    ['oversized token', 'a'.repeat(513)],
  ])('rejects %s as null', (_case, token) => {
    expect(decodeConsoleCursor(token)).toBeNull();
  });

  it('maps offset cursors both ways, treating garbage as the first page', () => {
    expect(offsetFromConsoleCursor(null)).toBe(0);
    expect(offsetFromConsoleCursor('not-a-cursor')).toBe(0);
    expect(offsetFromConsoleCursor(offsetConsoleCursor(250))).toBe(250);
    expect(offsetFromConsoleCursor(encodeConsoleCursor({ o: -5 }))).toBe(0);
    expect(offsetFromConsoleCursor(encodeConsoleCursor({ o: 1.5 }))).toBe(0);
  });
});
