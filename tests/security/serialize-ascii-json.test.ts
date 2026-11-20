import { expect, test } from '@jest/globals';
import { serializeAsciiJson } from '../../scripts/testing/serialize-ascii-json.mjs';

test('preserves JSON data while escaping every non-ASCII code unit', () => {
  const value = { text: '\u00e9\u202e\u202c\ud83d\ude00', nested: ['\ud800', 'ASCII', 42, null] };
  const serialized = serializeAsciiJson(value);
  expect(/[\u0080-\uffff]/.test(serialized)).toBe(false);
  expect(JSON.parse(serialized)).toEqual(value);
  expect(serialized).toBe(serializeAsciiJson(value));
  expect(serialized).toContain(String.raw`\ud83d\ude00`);
});
