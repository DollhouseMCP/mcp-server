import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { RegexValidator } from '../../src/security/regexValidator.js';

const cases = JSON.parse(readFileSync(resolve('tests/fixtures/security/regex-classifications.json'), 'utf8')) as {
  source: string; expected: ReturnType<typeof RegexValidator.analyzePattern>;
}[];

describe('Pattern classification compatibility', () => {
  it.each(cases.map((entry, index) => ({ ...entry, index })))('preserves classification $index', ({ source, expected }) => {
    expect(RegexValidator.analyzePattern(new RegExp(source))).toEqual(expected);
  });
});
