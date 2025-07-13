/**
 * Tests for input length validation (Issue #165)
 */

import { describe, test, expect } from '@jest/globals';
import { 
  validateInputLengths, 
  validateContentSize,
  ContentValidationOptions 
} from '../../../src/security/InputValidator.js';
import { ContentValidator } from '../../../src/security/contentValidator.js';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';
import { YamlValidator } from '../../../src/security/yamlValidator.js';
import { SECURITY_LIMITS } from '../../../src/security/constants.js';
import { SecurityError } from '../../../src/security/errors.js';

describe('Input Length Validation', () => {
  describe('validateInputLengths', () => {
    test('accepts content within limits', () => {
      const validContent = 'a'.repeat(1000);
      expect(() => validateInputLengths(validContent, 'full')).not.toThrow();
      expect(() => validateInputLengths(validContent, 'yaml')).not.toThrow();
      expect(() => validateInputLengths(validContent, 'field')).not.toThrow();
    });

    test('rejects content exceeding full content limit', () => {
      const largeContent = 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);
      expect(() => validateInputLengths(largeContent, 'full')).toThrow(
        /Content exceeds maximum length of \d+ characters/
      );
    });

    test('rejects YAML exceeding limit', () => {
      const largeYaml = 'a'.repeat(SECURITY_LIMITS.MAX_YAML_LENGTH + 1);
      expect(() => validateInputLengths(largeYaml, 'yaml')).toThrow(
        /YAML content exceeds maximum length of \d+ characters/
      );
    });

    test('rejects metadata field exceeding limit', () => {
      const largeField = 'a'.repeat(SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH + 1);
      expect(() => validateInputLengths(largeField, 'field')).toThrow(
        /Field exceeds maximum length of \d+ characters/
      );
    });

    test('respects custom limits', () => {
      const content = 'a'.repeat(150);
      const options: ContentValidationOptions = {
        maxContentLength: 100,
        maxYamlLength: 100,
        maxMetadataFieldLength: 100
      };
      
      expect(() => validateInputLengths(content, 'full', options)).toThrow();
      expect(() => validateInputLengths(content, 'yaml', options)).toThrow();
      expect(() => validateInputLengths(content, 'field', options)).toThrow();
    });
  });

  describe('ContentValidator length checks', () => {
    test('rejects content exceeding limit before pattern matching', () => {
      const largeContent = 'Safe content '.repeat(50000); // ~650KB
      
      expect(() => {
        ContentValidator.validateAndSanitize(largeContent);
      }).toThrow(SecurityError);
      
      expect(() => {
        ContentValidator.validateAndSanitize(largeContent);
      }).toThrow(/Content exceeds maximum length/);
    });

    test('rejects YAML content exceeding limit', () => {
      const largeYaml = 'key: value\n'.repeat(10000); // ~110KB
      
      const result = ContentValidator.validateYamlContent(largeYaml);
      expect(result).toBe(false);
    });

    test('rejects metadata fields exceeding limit', () => {
      const metadata = {
        name: 'Test',
        description: 'a'.repeat(SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH + 1)
      };
      
      const result = ContentValidator.validateMetadata(metadata);
      expect(result.isValid).toBe(false);
      expect(result.detectedPatterns).toEqual(
        expect.arrayContaining(['description: Field exceeds maximum length of 1024 characters'])
      );
    });
  });

  describe('SecureYamlParser length checks', () => {
    test('rejects content exceeding total size limit', () => {
      const largeContent = '---\nkey: value\n---\n' + 'a'.repeat(1024 * 1024 + 1);
      
      expect(() => {
        SecureYamlParser.parse(largeContent);
      }).toThrow('Content exceeds maximum allowed size');
    });

    test('rejects YAML frontmatter exceeding limit', () => {
      const largeYaml = '---\n' + 'key: value\n'.repeat(10000) + '---\nContent';
      
      expect(() => {
        SecureYamlParser.parse(largeYaml);
      }).toThrow('YAML frontmatter exceeds maximum allowed size');
    });
  });

  describe('YamlValidator length checks', () => {
    test('rejects YAML content exceeding limit', () => {
      const largeYaml = 'key: value\n'.repeat(10000);
      
      expect(() => {
        YamlValidator.parsePersonaMetadataSafely(largeYaml);
      }).toThrow(/YAML content too large/);
    });
  });

  describe('validateContentSize', () => {
    test('validates content size in bytes', () => {
      const content = 'Hello World';
      expect(() => validateContentSize(content)).not.toThrow();
    });

    test('rejects content exceeding byte limit', () => {
      const content = 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);
      expect(() => validateContentSize(content)).toThrow(/Content too large/);
    });

    test('handles multi-byte characters correctly', () => {
      // Each emoji is 4 bytes
      const emojis = '🎭'.repeat(100); // 400 bytes
      expect(() => validateContentSize(emojis, 500)).not.toThrow();
      expect(() => validateContentSize(emojis, 300)).toThrow(/Content too large/);
    });
  });

  describe('Integration tests', () => {
    test('full persona validation respects all limits', () => {
      const validPersona = `---
name: Test Persona
description: A test persona
---

This is the content of the persona.`;

      // Should pass all validations
      const parsed = SecureYamlParser.parse(validPersona);
      expect(parsed.data.name).toBe('Test Persona');
      
      const contentResult = ContentValidator.validateAndSanitize(parsed.content);
      expect(contentResult.isValid).toBe(true);
    });

    test('large persona file is rejected early', () => {
      const largePersona = `---
name: Test
description: ${'a'.repeat(2000)}
---

Content`;

      // Should fail on metadata field length
      const result = ContentValidator.validateMetadata({
        name: 'Test',
        description: 'a'.repeat(2000)
      });
      expect(result.isValid).toBe(false);
    });
  });

  describe('Performance considerations', () => {
    test('length checks happen before expensive operations', () => {
      const largeContent = 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);
      
      // These should fail fast without running regex patterns
      const start = performance.now();
      
      try {
        ContentValidator.validateAndSanitize(largeContent);
      } catch (e) {
        // Expected
      }
      
      const elapsed = performance.now() - start;
      
      // Should fail very quickly (< 10ms)
      expect(elapsed).toBeLessThan(10);
    });
  });
});