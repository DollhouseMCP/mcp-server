/**
 * Unit tests for responseFormatter — Issue #668 name suggestion logic
 */
import { formatExceptionError } from '../../../../src/handlers/element-crud/responseFormatter.js';
import { ElementType } from '../../../../src/portfolio/PortfolioManager.js';

describe('formatExceptionError', () => {
  it('should format a basic error message', () => {
    const error = new Error('Something went wrong');
    const result = formatExceptionError(error, 'create', ElementType.SKILL, 'test-skill');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Failed to create skill 'test-skill'");
    expect(text).toContain('Something went wrong');
  });

  describe('name suggestion for invalid characters (#668)', () => {
    it('should suggest corrected name when error mentions invalid characters', () => {
      const error = new Error('Validation failed: Input contains invalid characters: \'/\', \'@\'');
      const result = formatExceptionError(error, 'create', ElementType.SKILL, 'my/skill@test');
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Suggested name: 'my-skill-test'");
    });

    it('should not suggest when name has no invalid characters', () => {
      const error = new Error('Input contains invalid characters');
      const result = formatExceptionError(error, 'create', ElementType.PERSONA, 'valid-name');
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('Suggested name');
    });

    it('should collapse multiple consecutive invalid chars into single hyphen', () => {
      const error = new Error('Input contains invalid characters');
      const result = formatExceptionError(error, 'create', ElementType.SKILL, 'my///skill');
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Suggested name: 'my-skill'");
    });

    it('should trim leading/trailing hyphens from suggestion', () => {
      const error = new Error('Input contains invalid characters');
      const result = formatExceptionError(error, 'create', ElementType.SKILL, '@leading-trail@');
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Suggested name: 'leading-trail'");
    });

    it('should preserve valid characters while replacing invalid ones', () => {
      const error = new Error('Input contains invalid characters');
      const result = formatExceptionError(error, 'create', ElementType.SKILL, 'my_skill@2024');
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Suggested name: 'my_skill-2024'");
    });

    it('should not suggest when name contains only invalid characters', () => {
      const error = new Error('Input contains invalid characters');
      const result = formatExceptionError(error, 'create', ElementType.SKILL, '/@/');
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('Suggested name');
    });

    it('should not suggest when error is unrelated to invalid characters', () => {
      const error = new Error('Element already exists');
      const result = formatExceptionError(error, 'create', ElementType.SKILL, 'my/skill@test');
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('Suggested name');
    });
  });
});
