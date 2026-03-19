import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ElementValidation, VALIDATION_CONSTANTS } from '../../../src/elements/base/ElementValidation.js';
import { UnicodeValidator } from '../../../src/security/validators/unicodeValidator.js';
import { logger } from '../../../src/utils/logger.js';

jest.mock('../../../src/security/validators/unicodeValidator.js');
jest.mock('../../../src/utils/logger.js');

const ValidationHelper = {
  MAX_OVERFLOW: VALIDATION_CONSTANTS.MAX_TRIGGERS + 2
};

describe('ElementValidation', () => {
  beforeEach(() => {
    (UnicodeValidator as any).normalize = jest.fn<(value: string) => { normalizedContent: string; isValid: boolean }>((value: string) => ({
      normalizedContent: value,
      isValid: true
    }));
    (logger as any).warn = jest.fn<(...args: any[]) => void>();
    jest.clearAllMocks();
  });

  it('validateName should normalize, sanitize, and reject empty results', () => {
    expect(ElementValidation.validateName('   My Name   ')).toBe('My Name');

    (UnicodeValidator.normalize as jest.Mock).mockReturnValueOnce({ normalizedContent: '', isValid: true });
    expect(() => ElementValidation.validateName('')).toThrow(/Name is required/);

    (UnicodeValidator.normalize as jest.Mock).mockReturnValueOnce({ normalizedContent: '\u0000', isValid: true });
    expect(() => ElementValidation.validateName('\u0000')).toThrow(/empty after sanitization/);
  });

  it('validateDescription should return sanitized string or undefined', () => {
    expect(ElementValidation.validateDescription(null)).toBeUndefined();
    expect(ElementValidation.validateDescription('  description ')).toBe('description');
  });

  it('validateTags should filter falsey values and sanitize entries', () => {
    const tags = ElementValidation.validateTags(['Tag One', '', null, 'two', undefined, 'three!']);
    expect(tags).toEqual(['Tag One', 'two', 'three']);
  });

  it('validateTriggers should return valid triggers, track rejections, and warn', () => {
    const triggers = [
      ' valid ',
      'with space',
      '\x00',
      ...Array(ValidationHelper.MAX_OVERFLOW).fill('extra')
    ];

    const result = ElementValidation.validateTriggers(triggers, 'TestElement', 3);

    expect(result.valid).toEqual(['valid']);
    // SECURITY: With validate-before-sanitize, both are rejected for invalid format
    // (null char doesn't match alphanumeric pattern, not treated as empty)
    expect(result.rejected).toEqual([
      '"with space" (invalid format - allowed: letters, numbers, hyphens, underscores, @ and .)',
      '"\u0000" (invalid format - allowed: letters, numbers, hyphens, underscores, @ and .)'
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining('Rejected 2 invalid trigger'),
      expect.stringContaining('Trigger limit exceeded')
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('validateCommonMetadata should apply field validators and include sanitized values', () => {
    const metadata = ElementValidation.validateCommonMetadata({
      name: ' Name ',
      description: ' Description ',
      author: ' Author ',
      version: ' 1.0.0 ',
      category: ' category ',
      tags: ['Tag', '', null],
      triggers: ['trigger-one', 'bad trigger']
    });

    expect(metadata.name).toBe('Name');
    expect(metadata.description).toBe('Description');
    expect(metadata.author).toBe('Author');
    expect(metadata.version).toBe('1.0.0');
    expect(metadata.category).toBe('category');
    expect(metadata.tags).toEqual(['Tag']);
    expect(metadata.triggers).toEqual(['trigger-one']);
  });

  it('validateNumber should enforce numeric bounds', () => {
    expect(ElementValidation.validateNumber('10', 5, 15)).toBe(10);
    expect(() => ElementValidation.validateNumber(undefined)).toThrow(/Invalid number/);
    expect(() => ElementValidation.validateNumber('abc')).toThrow(/Invalid number/);
    expect(() => ElementValidation.validateNumber(1, 5, 10)).toThrow(/out of range/);
  });

  it('validateBoolean should coerce values with default fallback', () => {
    expect(ElementValidation.validateBoolean(undefined)).toBe(false);
    expect(ElementValidation.validateBoolean(undefined, true)).toBe(true);
    expect(ElementValidation.validateBoolean(0)).toBe(false);
    expect(ElementValidation.validateBoolean('non-empty')).toBe(true);
  });
});
