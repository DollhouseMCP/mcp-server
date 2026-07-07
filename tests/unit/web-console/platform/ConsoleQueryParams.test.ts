import { describe, expect, it } from '@jest/globals';

import {
  boundedLimit,
  boundedString,
  firstString,
  optionalLimit,
} from '../../../../src/web-console/platform/ConsoleQueryParams.js';

describe('ConsoleQueryParams', () => {
  describe('firstString', () => {
    it.each([
      ['a plain string', 'value', 'value'],
      ['the first array element', ['first', 'second'], 'first'],
      ['undefined', undefined, null],
      ['a non-string array head', [42, 'second'], null],
      ['a number', 7, null],
    ])('reads %s', (_case, input, expected) => {
      expect(firstString(input)).toBe(expected);
    });
  });

  describe('boundedString', () => {
    it('trims and accepts in-bound strings', () => {
      expect(boundedString('  hello  ', 10)).toBe('hello');
    });

    it('rejects over-length input as null — never truncates', () => {
      // A silently truncated filter would match different data than the
      // client asked for; over-length is treated as absent.
      expect(boundedString('a'.repeat(11), 10)).toBeNull();
      expect(boundedString('a'.repeat(10), 10)).toBe('a'.repeat(10));
    });

    it.each([
      ['null', null],
      ['empty', ''],
      ['whitespace only', '   '],
    ])('treats %s as absent', (_case, input) => {
      expect(boundedString(input, 10)).toBeNull();
    });
  });

  describe('boundedLimit / optionalLimit', () => {
    it('accepts positive integers up to the cap', () => {
      expect(boundedLimit('5', 100, 1000)).toBe(5);
      expect(boundedLimit('5000', 100, 1000)).toBe(1000);
      expect(optionalLimit('5', 1000)).toBe(5);
      expect(optionalLimit('5000', 1000)).toBe(1000);
    });

    it.each([
      ['absent', null],
      ['zero', '0'],
      ['negative', '-3'],
      ['garbage', 'lots'],
    ])('%s input falls back / yields null', (_case, input) => {
      expect(boundedLimit(input, 100, 1000)).toBe(100);
      expect(optionalLimit(input, 1000)).toBeNull();
    });
  });
});
