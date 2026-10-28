import { describe, expect, it } from '@jest/globals';
import { analyzePatternRisks } from '../../../src/security/PatternRiskAnalyzer.js';

describe('Textual alternation boundaries', () => {
  it.each(['(a|a)*', '(ab|ab)+', '(a|b|a)+'])('recognizes repeated alternatives in %s', source => {
    expect(analyzePatternRisks(source).risks).toEqual([
      'Quantified alternation detected', 'Overlapping alternation detected',
    ]);
  });

  it('keeps distinct alternatives separate', () => {
    expect(analyzePatternRisks('(a|b)*').risks).toEqual(['Quantified alternation detected']);
  });

  it('keeps the nested opening delimiter in the textual alternative', () => {
    expect(analyzePatternRisks('((a|a))*').risks).toEqual([]);
  });

  it('stops after the first complete textual group consumes the closing delimiter', () => {
    expect(analyzePatternRisks('(x|(a|a))+').risks).toEqual([]);
  });

  it('recognizes later duplicate alternatives within that same textual group', () => {
    expect(analyzePatternRisks('(x|(a|a|a))+').risks).toEqual(['Overlapping alternation detected']);
  });
});
