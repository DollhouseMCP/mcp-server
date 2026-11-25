import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { SubmitToPortfolioTool } from '../../../../src/tools/portfolio/submitToPortfolioTool.js';

describe('portfolio submission containment', () => {
  const base = path.resolve('virtual', 'portfolio');
  const tool: SubmitToPortfolioTool = Object.assign(Object.create(SubmitToPortfolioTool.prototype), {
    portfolioManager: { getBaseDir: () => base },
  });
  it('refuses NUL rather than silently addressing a different file', () => {
    expect(() => tool['normalizeWithinPortfolio'](path.join(base, 'a\0.md'))).toThrow('Null bytes');
  });
  it('refuses a sibling with the same prefix', () => {
    expect(() => tool['normalizeWithinPortfolio'](path.join(`${base}-evil`, 'a.md'))).toThrow('outside portfolio');
  });
  it('accepts an absolute reference inside the portfolio', () => {
    const reference = path.join(base, 'skills', 'a.md');
    expect(tool['normalizeWithinPortfolio'](reference)).toBe(reference);
  });
});
