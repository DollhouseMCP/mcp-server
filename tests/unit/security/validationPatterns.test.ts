/**
 * Tests for VALIDATION_PATTERNS — ensures description validation
 * accepts legitimate characters found in real-world portfolio elements.
 *
 * Regression tests for #1687: 174 memories failed to load because
 * SAFE_DESCRIPTION rejected common symbols like #, +, %, =, @, →.
 */

import { VALIDATION_PATTERNS } from '../../../src/security/constants.js';

describe('VALIDATION_PATTERNS.SAFE_DESCRIPTION', () => {
  const pattern = VALIDATION_PATTERNS.SAFE_DESCRIPTION;

  describe('should accept legitimate descriptions', () => {
    const validDescriptions = [
      ['plain text', 'Simple element description'],
      ['programming languages', 'C++ development tools and C# runtime'],
      ['percentages', 'Task 100% complete with 95% accuracy'],
      ['email/handles', 'Contact user@domain.com for support'],
      ['unicode arrows', 'A → B workflow, bidirectional X ↔ Y'],
      ['key=value notation', 'Set key=value in config file'],
      ['currency', 'Costs $50 per month or €45'],
      ['hashtags', 'Tagged with #typescript and #mcp'],
      ['ampersand', 'Research & development team'],
      ['em-dash and en-dash', 'First section — overview – details'],
      ['math operators', '2 + 2 = 4, temperature ~72°F'],
      ['pipe separators', 'Option A | Option B | Option C'],
      ['parentheses and brackets', 'See docs (section [3.1]) for details'],
      ['curly braces', 'Template with {placeholder} values'],
      ['angle brackets', 'Type <string> parameter'],
      ['backticks', 'Run `npm test` command'],
      ['asterisks', 'Important *note* about security'],
      ['caret', 'Version ^2.0.0 compatible'],
      ['backslash', 'Windows path C:\\Users\\config'],
      ['checkmarks', 'Status: ✓ passed ✗ failed'],
      ['quotes and apostrophes', "It's a \"quoted\" description"],
      ['colons and semicolons', 'Time: 3:45pm; Status: active'],
      ['exclamation and question', 'What is this? Amazing!'],
      ['forward slash', 'src/web/public/index.html'],
      ['mixed unicode', 'Héllo wörld — café résumé'],
    ];

    it.each(validDescriptions)('%s: "%s"', (_label, desc) => {
      expect(pattern.test(desc)).toBe(true);
    });
  });

  describe('should reject dangerous content', () => {
    const invalidDescriptions = [
      ['null bytes', 'text\x00with null'],
      ['control characters', 'text\x01\x02control'],
    ];

    it.each(invalidDescriptions)('%s', (_label, desc) => {
      // Note: sanitizeInput() strips these before validation,
      // but the pattern itself should also reject them
      expect(pattern.test(desc)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should accept empty-looking but valid strings', () => {
      expect(pattern.test('...')).toBe(true);
      expect(pattern.test('---')).toBe(true);
      expect(pattern.test('___')).toBe(true);
    });

    it('should reject truly empty string', () => {
      expect(pattern.test('')).toBe(false);
    });

    it('should accept single character descriptions', () => {
      expect(pattern.test('A')).toBe(true);
      expect(pattern.test('#')).toBe(true);
      expect(pattern.test('→')).toBe(true);
    });
  });
});

describe('VALIDATION_PATTERNS.SAFE_NAME', () => {
  const pattern = VALIDATION_PATTERNS.SAFE_NAME;

  it('should accept standard element names', () => {
    expect(pattern.test('my-element')).toBe(true);
    expect(pattern.test('code_review')).toBe(true);
    expect(pattern.test('Version 2.0')).toBe(true);
    expect(pattern.test('café')).toBe(true);
  });

  it('should reject names with special characters', () => {
    expect(pattern.test('my@element')).toBe(false);
    expect(pattern.test('name#tag')).toBe(false);
    expect(pattern.test('a+b')).toBe(false);
  });
});
