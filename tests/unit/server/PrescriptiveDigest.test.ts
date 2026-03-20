import { generatePrescriptiveDigest, ActiveElementSummary } from '../../../dist/server/PrescriptiveDigest.js';

describe('PrescriptiveDigest', () => {
  describe('generatePrescriptiveDigest', () => {
    it('should return empty string for empty array', () => {
      expect(generatePrescriptiveDigest([])).toBe('');
    });

    it('should generate digest for a single active element', () => {
      const elements: ActiveElementSummary[] = [
        { type: 'persona', name: 'agentic-loop-architect' }
      ];
      const digest = generatePrescriptiveDigest(elements);
      expect(digest).toContain('Active elements:');
      expect(digest).toContain('persona: agentic-loop-architect');
      expect(digest).toContain('get_active_elements');
    });

    it('should group elements by type', () => {
      const elements: ActiveElementSummary[] = [
        { type: 'persona', name: 'architect' },
        { type: 'skill', name: 'code-reviewer' },
        { type: 'persona', name: 'teacher' },
      ];
      const digest = generatePrescriptiveDigest(elements);
      expect(digest).toContain('persona: architect, teacher');
      expect(digest).toContain('skill: code-reviewer');
    });

    it('should include recovery instructions', () => {
      const elements: ActiveElementSummary[] = [
        { type: 'skill', name: 'test-skill' }
      ];
      const digest = generatePrescriptiveDigest(elements);
      expect(digest).toContain('call get_active_elements for each type to refresh');
    });

    it('should handle all element types', () => {
      const elements: ActiveElementSummary[] = [
        { type: 'persona', name: 'p1' },
        { type: 'skill', name: 's1' },
        { type: 'ensemble', name: 'e1' },
      ];
      const digest = generatePrescriptiveDigest(elements);
      expect(digest).toContain('persona: p1');
      expect(digest).toContain('skill: s1');
      expect(digest).toContain('ensemble: e1');
    });

    it('should be wrapped in brackets for visual separation', () => {
      const elements: ActiveElementSummary[] = [
        { type: 'persona', name: 'test' }
      ];
      const digest = generatePrescriptiveDigest(elements);
      expect(digest.startsWith('[')).toBe(true);
      expect(digest.endsWith(']')).toBe(true);
    });
  });
});
