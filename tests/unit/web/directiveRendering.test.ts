/**
 * Directive Rendering Logic - Unit Tests
 *
 * Tests the directive detection algorithm used by renderInstructions()
 * in the portfolio browser frontend. The logic is replicated here
 * for testability since the frontend is vanilla JS without a module system.
 */

import { describe, it, expect } from '@jest/globals';

// Replicate the directive detection logic from app.js
const DIRECTIVE_KEYWORDS = [
  'YOU','ALWAYS','NEVER','WHEN','PREFER','DO',"DON'T",'DONT','MUST','SHOULD',
  'IF','FOR','ENSURE','MAINTAIN','USE','AVOID','FOLLOW','PRIORITIZE','FOCUS',
  'REMEMBER','NOTE','IMPORTANT','CRITICAL',
];
const DIRECTIVE_PATTERN = new RegExp(
  `^(${DIRECTIVE_KEYWORDS.join('|')})(\\s)`, 'i'
);

function detectDirectiveStyle(text: string): {
  isDirective: boolean;
  directiveCount: number;
  totalParagraphs: number;
  parsed: Array<{ trimmed: string; match: RegExpMatchArray | null }>;
} {
  if (!text) return { isDirective: false, directiveCount: 0, totalParagraphs: 0, parsed: [] };

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const parsed = paragraphs.map(p => {
    const trimmed = p.trim();
    const match = trimmed.match(DIRECTIVE_PATTERN);
    return { trimmed, match };
  });

  const directiveCount = parsed.filter(p => p.match).length;
  const isDirective = directiveCount >= 2 && directiveCount >= paragraphs.length * 0.3;

  return { isDirective, directiveCount, totalParagraphs: paragraphs.length, parsed };
}

describe('Directive Detection', () => {
  it('should detect directive-style instructions', () => {
    const text = `YOU ARE a security expert.\n\nALWAYS check for vulnerabilities.\n\nNEVER expose sensitive data.`;
    const result = detectDirectiveStyle(text);
    expect(result.isDirective).toBe(true);
    expect(result.directiveCount).toBe(3);
  });

  it('should not detect regular markdown as directives', () => {
    const text = `# Introduction\n\nThis is a regular paragraph about code review.\n\nIt has multiple sections but no directives.`;
    const result = detectDirectiveStyle(text);
    expect(result.isDirective).toBe(false);
  });

  it('should handle null/empty input', () => {
    expect(detectDirectiveStyle('')).toEqual({
      isDirective: false, directiveCount: 0, totalParagraphs: 0, parsed: [],
    });
  });

  it('should require at least 2 directives', () => {
    const text = `ALWAYS be helpful.\n\nThis is just a regular paragraph.`;
    const result = detectDirectiveStyle(text);
    // 1 directive out of 2 paragraphs = 50% but only 1 directive (need >= 2)
    expect(result.isDirective).toBe(false);
  });

  it('should require at least 30% directive ratio', () => {
    const text = [
      'ALWAYS check inputs.',
      'NEVER trust user data.',
      'Regular paragraph one.',
      'Regular paragraph two.',
      'Regular paragraph three.',
      'Regular paragraph four.',
      'Regular paragraph five.',
      'Regular paragraph six.',
      'Regular paragraph seven.',
      'Regular paragraph eight.',
    ].join('\n\n');
    const result = detectDirectiveStyle(text);
    // 2 directives out of 10 = 20% < 30% threshold
    expect(result.isDirective).toBe(false);
  });

  it('should detect case-insensitively', () => {
    const text = `always be consistent.\n\nnever skip validation.\n\nwhen in doubt, ask.`;
    const result = detectDirectiveStyle(text);
    expect(result.isDirective).toBe(true);
  });

  it('should match all directive keywords', () => {
    for (const keyword of DIRECTIVE_KEYWORDS) {
      const clean = keyword.replace("'", '');
      const text = `${clean} do something.\n\n${clean} do another thing.`;
      const result = detectDirectiveStyle(text);
      expect(result.directiveCount).toBeGreaterThanOrEqual(2);
    }
  });

  it('should extract the keyword from the match', () => {
    const text = `ALWAYS validate.\n\nNEVER trust.\n\nWHEN possible, test.`;
    const result = detectDirectiveStyle(text);
    const keywords = result.parsed
      .filter(p => p.match)
      .map(p => p.match![1]);
    expect(keywords).toEqual(['ALWAYS', 'NEVER', 'WHEN']);
  });

  it('should handle mixed directive and non-directive paragraphs', () => {
    const text = `YOU ARE a code reviewer.\n\nALWAYS check for security issues.\n\nThis persona focuses on quality.\n\nNEVER approve code with known vulnerabilities.\n\nWHEN reviewing, consider performance.`;
    const result = detectDirectiveStyle(text);
    expect(result.isDirective).toBe(true);
    expect(result.directiveCount).toBe(4);
    expect(result.totalParagraphs).toBe(5);
  });

  it('should not match keywords mid-sentence', () => {
    const text = `The system should always validate.\n\nUsers must never skip auth.\n\nWe prefer to use tests.`;
    const result = detectDirectiveStyle(text);
    // "should", "must", "prefer" are NOT at the start — "The", "Users", "We" start the lines
    expect(result.isDirective).toBe(false);
  });

  it('should handle single-line instructions', () => {
    const text = `ALWAYS be helpful.`;
    const result = detectDirectiveStyle(text);
    // Only 1 paragraph, 1 directive — needs >= 2
    expect(result.isDirective).toBe(false);
    expect(result.directiveCount).toBe(1);
  });
});
