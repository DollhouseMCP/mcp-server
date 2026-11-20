import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generatedRegexPatterns, constructedRegexPatterns } from '../helpers/generatedRegexPatterns.js';
import { RegexValidator } from '../../src/security/regexValidator.js';
import { ContentValidator } from '../../src/security/contentValidator.js';
import { validateFilename, validateCategory } from '../../src/security/InputValidator.js';
import { PathValidator } from '../../src/security/pathValidator.js';
import { CommandValidator } from '../../src/security/commandValidator.js';
import { logger } from '../../src/utils/logger.js';
import { SecurityMonitor } from '../../src/security/securityMonitor.js';

type Analysis = ReturnType<typeof RegexValidator.analyzePattern>;
type Expected = { value: Analysis } | { error: string; message: string };
type Pattern = { source: string; flags: string; expected: Expected };
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/security/regex-pattern-analysis.golden.json'), 'utf8')) as {
  entries: (Pattern & { group: string })[];
};
const groups = ['source', 'test', 'constructed', 'generated'].map(label => ({
  label, patterns: fixture.entries.filter(entry => entry.group === label),
}));
const referenceAnalysis = new Map<string, Analysis>();
for (const entry of fixture.entries) {
  if (!('value' in entry.expected)) continue;
  const pattern = new RegExp(entry.source, entry.flags);
  referenceAnalysis.set(JSON.stringify([pattern.source, pattern.flags]), entry.expected.value);
}

function frozenAnalysis(pattern: RegExp): Analysis {
  const result = referenceAnalysis.get(JSON.stringify([pattern.source, pattern.flags]));
  if (!result) throw new Error('Reference analysis is missing');
  return { ...result, risks: [...result.risks] };
}

function outcome(operation: () => unknown): unknown {
  try { return { value: operation() }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.name, message: error.message };
  }
}

function callerOutcomes(patterns: Pattern[]): unknown[] {
  const paths = new PathValidator(resolve('tmp', 'classification'), ['.md']);
  return patterns.map(({ source, flags }) => ({
    content: outcome(() => ContentValidator.validateAndSanitize(source)),
    filename: outcome(() => validateFilename(source)),
    category: outcome(() => validateCategory(source)),
    path: outcome(() => paths['validateFilename'](`${source}.md`)),
    command: outcome(() => CommandValidator.sanitizeCommand('git', [source])),
    validation: outcome(() => RegexValidator.validate('', new RegExp(source, flags), { logEvents: false })),
    creation: outcome(() => {
      const result = RegexValidator.createSafePattern(source, flags);
      return { source: result.source, flags: result.flags };
    }),
  }));
}

describe('Pattern classifier equivalence', () => {
  beforeEach(() => {
    SecurityMonitor.clearAllEventsForTesting();
    jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
    for (const level of ['debug', 'info', 'warn', 'error'] as const) jest.spyOn(logger, level).mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(groups)('preserves every analysis field for the $label corpus', ({ patterns }) => {
    const mismatches = patterns.flatMap(({ source, flags, expected }, index) => {
      const current = outcome(() => RegexValidator.analyzePattern(new RegExp(source, flags)));
      const reference = expected;
      return isDeepStrictEqual(current, reference) ? [] : [{ index, source, flags, current, reference }];
    });
    expect(mismatches).toEqual([]);
  });

  const callerGroups = groups.flatMap(({ label, patterns }) => {
    const chunks: { label: string; patterns: Pattern[] }[] = [];
    for (let start = 0; start < patterns.length; start += 500) chunks.push({ label: `${label}-${start}`, patterns: patterns.slice(start, start + 500) });
    return chunks;
  });

  it.each(callerGroups)('preserves caller outcomes for the $label corpus', ({ patterns }) => {
    const current = callerOutcomes(patterns);
    jest.spyOn(RegexValidator, 'analyzePattern').mockImplementation(frozenAnalysis);
    expect(callerOutcomes(patterns)).toEqual(current);
  });

  it('keeps deterministic construction inputs aligned with the reference data', () => {
    const sources = (group: string) => fixture.entries.filter(entry => entry.group === group).map(entry => entry.source);
    expect(sources('generated')).toEqual(generatedRegexPatterns());
    expect(sources('constructed')).toEqual(constructedRegexPatterns());
  });

  it('classifies a long pattern within a bounded interval', () => {
    const pattern = new RegExp(String.raw`\(`.repeat(5000));
    const started = performance.now();
    RegexValidator.analyzePattern(pattern);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
