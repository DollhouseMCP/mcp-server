import { describe, it, expect, jest } from '@jest/globals';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';

const CODE_REVIEW_NAME = 'Code Review';

const { findElementFlexibly, sanitizeMetadata, validateGatekeeperPolicy } = await import('../../../../src/handlers/element-crud/helpers.js');

describe('element-crud helpers', () => {
  describe('findElementFlexibly', () => {
    const mockElements = [
      { metadata: { name: CODE_REVIEW_NAME } },
      { metadata: { name: 'Data Analysis' } },
      { metadata: { name: 'Creative Writing Helper' } },
      { metadata: { name: 'test-skill-name' } },
    ];

    describe('successful matching', () => {
      it.each([
        { description: 'by exact name match', searchName: CODE_REVIEW_NAME, expectedName: CODE_REVIEW_NAME },
        { description: 'by case-insensitive match', searchName: 'code review', expectedName: CODE_REVIEW_NAME },
        { description: 'with all uppercase', searchName: 'CODE REVIEW', expectedName: CODE_REVIEW_NAME },
        { description: 'with mixed case', searchName: 'CoDe ReViEw', expectedName: CODE_REVIEW_NAME },
        { description: 'by slugified name', searchName: 'code-review', expectedName: CODE_REVIEW_NAME },
        {
          description: 'with spaces converted to dashes',
          searchName: 'creative-writing-helper',
          expectedName: 'Creative Writing Helper',
        },
        { description: 'with underscores', searchName: 'test_skill_name', expectedName: 'test-skill-name' },
        { description: 'by partial slug match', searchName: 'writing', expectedName: 'Creative Writing Helper' },
        { description: 'by partial name match', searchName: 'analysis', expectedName: 'Data Analysis' },
        {
          description: 'by partial case-insensitive match',
          searchName: 'WRITING',
          expectedName: 'Creative Writing Helper',
        },
      ])('should find element $description', ({ searchName, expectedName }) => {
        const result = findElementFlexibly(searchName, mockElements);
        expect(result).toBeDefined();
        expect(result.metadata.name).toBe(expectedName);
      });
    });

    describe('edge cases', () => {
      it('should return undefined for non-existent element', () => {
        const result = findElementFlexibly('NonExistent', mockElements);
        expect(result).toBeUndefined();
      });

      it('should return undefined for empty search name', () => {
        const result = findElementFlexibly('', mockElements);
        expect(result).toBeUndefined();
      });

      it('should return undefined for empty element list', () => {
        const result = findElementFlexibly(CODE_REVIEW_NAME, []);
        expect(result).toBeUndefined();
      });

      it('should return undefined for null search name', () => {
        const result = findElementFlexibly(null as any, mockElements);
        expect(result).toBeUndefined();
      });

      it('should return undefined for undefined search name', () => {
        const result = findElementFlexibly(undefined as any, mockElements);
        expect(result).toBeUndefined();
      });

      it('should handle elements with missing metadata', () => {
        const elementsWithMissing = [
          { metadata: { name: 'Valid' } },
          { metadata: undefined },
          {},
        ];
        const result = findElementFlexibly('Valid', elementsWithMissing as any);
        expect(result).toBeDefined();
        expect(result?.metadata?.name).toBe('Valid');
      });

      it('should handle elements with null metadata.name', () => {
        const elementsWithNull = [
          { metadata: { name: 'Valid' } },
          { metadata: { name: null } },
        ];
        const result = findElementFlexibly('Valid', elementsWithNull as any);
        expect(result).toBeDefined();
        expect(result?.metadata?.name).toBe('Valid');
      });

      it('should return first matching element when multiple match', () => {
        const duplicates = [
          { metadata: { name: 'First Match' } },
          { metadata: { name: 'First Match' } },
        ];
        const result = findElementFlexibly('First Match', duplicates);
        expect(result).toBe(duplicates[0]);
      });
    });

    describe('prioritization', () => {
      it('should prefer exact match over partial match', () => {
        const elements = [
          { metadata: { name: 'Code' } },
          { metadata: { name: CODE_REVIEW_NAME } },
        ];
        const result = findElementFlexibly('Code', elements);
        expect(result.metadata.name).toBe('Code');
      });

      it('should prefer exact case-insensitive match over slug match', () => {
        const elements = [
          { metadata: { name: 'test-slug-match' } },
          { metadata: { name: 'Test Slug Match' } },
        ];
        const result = findElementFlexibly('test slug match', elements);
        expect(result.metadata.name).toBe('Test Slug Match');
      });
    });
  });

  describe('sanitizeMetadata', () => {
    describe('basic sanitization', () => {
      it('does not emit a security event when all metadata is safe', () => {
        const eventSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});

        sanitizeMetadata({ name: 'Test', nested: { safe: true } });

        expect(eventSpy).not.toHaveBeenCalled();
        eventSpy.mockRestore();
      });

      it('emits one security event listing dangerous properties that were removed', () => {
        const eventSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
        const input = JSON.parse('{"name":"Test","constructor":{},"nested":{"prototype":{}}}') as Record<string, unknown>;

        sanitizeMetadata(input);

        expect(eventSpy).toHaveBeenCalledTimes(1);
        expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({
          type: 'ELEMENT_VALIDATED',
          additionalData: { removedKeys: ['constructor', 'prototype'] },
        }));
        eventSpy.mockRestore();
      });

      it('should preserve safe properties', () => {
        const input = {
          name: 'Test',
          description: 'A test element',
          version: '1.0.0',
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual(input);
      });

      it('should remove __proto__ property', () => {
        const input = {
          name: 'Test',
          __proto__: { malicious: 'code' },
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual({ name: 'Test' });
        expect(Object.hasOwn(result, '__proto__')).toBe(false);
      });

      it('should remove constructor property', () => {
        const input = {
          name: 'Test',
          constructor: { malicious: 'code' },
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual({ name: 'Test' });
        expect(Object.hasOwn(result, 'constructor')).toBe(false);
      });

      it('should remove prototype property', () => {
        const input = {
          name: 'Test',
          prototype: { malicious: 'code' },
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual({ name: 'Test' });
        expect(Object.hasOwn(result, 'prototype')).toBe(false);
      });

      it('should remove all dangerous properties at once', () => {
        const input = {
          name: 'Test',
          __proto__: {},
          constructor: {},
          prototype: {},
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual({ name: 'Test' });
      });
    });

    describe('nested object sanitization', () => {
      it('should recursively sanitize nested objects', () => {
        const input = {
          name: 'Test',
          nested: {
            safe: 'value',
            __proto__: { bad: 'stuff' },
          },
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual({
          name: 'Test',
          nested: { safe: 'value' },
        });
      });

      it('should handle deeply nested objects', () => {
        const input = {
          level1: {
            level2: {
              level3: {
                safe: 'value',
                __proto__: {},
              },
            },
          },
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual({
          level1: {
            level2: {
              level3: { safe: 'value' },
            },
          },
        });
      });

      it('should preserve arrays in nested objects', () => {
        const input = {
          name: 'Test',
          nested: {
            array: [1, 2, 3],
            __proto__: {},
          },
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual({
          name: 'Test',
          nested: { array: [1, 2, 3] },
        });
      });
    });

    describe('array handling', () => {
      it('should preserve top-level arrays', () => {
        const input = {
          tags: ['tag1', 'tag2', 'tag3'],
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual(input);
      });

      it('should not recursively sanitize array elements', () => {
        const input = {
          items: [
            { __proto__: {}, value: 1 },
            { constructor: {}, value: 2 },
          ],
        };
        const result = sanitizeMetadata(input);
        // Arrays are preserved as-is, not recursively sanitized
        expect(result).toEqual(input);
      });
    });

    describe('edge cases', () => {
      it('should return empty object for undefined input', () => {
        const result = sanitizeMetadata();
        expect(result).toEqual({});
      });

      it('should return empty object for null input', () => {
        const result = sanitizeMetadata(null as any);
        expect(result).toEqual({});
      });

      it('should return empty object for non-object input', () => {
        const result = sanitizeMetadata('string' as any);
        expect(result).toEqual({});
      });

      it('should return empty object for number input', () => {
        const result = sanitizeMetadata(42 as any);
        expect(result).toEqual({});
      });

      it('should return empty object for boolean input', () => {
        const result = sanitizeMetadata(true as any);
        expect(result).toEqual({});
      });

      it('should handle empty object', () => {
        const result = sanitizeMetadata({});
        expect(result).toEqual({});
      });

      it('should preserve null values in properties', () => {
        const input = {
          name: 'Test',
          nullable: null,
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual(input);
      });

      it('should preserve undefined values in properties', () => {
        const input = {
          name: 'Test',
          undefinedValue: undefined,
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual(input);
      });

      it('should preserve number values', () => {
        const input = {
          count: 42,
          price: 9.99,
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual(input);
      });

      it('should preserve boolean values', () => {
        const input = {
          enabled: true,
          disabled: false,
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual(input);
      });

      it('should preserve string values', () => {
        const input = {
          text: 'hello',
          empty: '',
        };
        const result = sanitizeMetadata(input);
        expect(result).toEqual(input);
      });
    });

    describe('complex scenarios', () => {
      it('should handle realistic metadata object', () => {
        const input = {
          name: 'Code Review Skill',
          description: 'Reviews code for quality',
          version: '2.0.0',
          author: 'developer@example.com',
          tags: ['development', 'quality'],
          complexity: 'intermediate',
          domains: ['engineering', 'testing'],
          __proto__: { injected: 'malicious' },
          settings: {
            strict: true,
            rules: ['rule1', 'rule2'],
            constructor: { bad: 'stuff' },
          },
        };

        const result = sanitizeMetadata(input);

        expect(result.name).toBe('Code Review Skill');
        expect(result.description).toBe('Reviews code for quality');
        expect(result.tags).toEqual(['development', 'quality']);
        expect(result.settings.strict).toBe(true);
        expect(result.settings.rules).toEqual(['rule1', 'rule2']);
        expect(Object.hasOwn(result, '__proto__')).toBe(false);
        expect(Object.hasOwn(result.settings, 'constructor')).toBe(false);
      });
    });
  });

  describe('validateGatekeeperPolicy — pattern conflict detection (Phase 2)', () => {
    it('should return empty warnings when no gatekeeper policy', () => {
      const warnings = validateGatekeeperPolicy({ name: 'test' });
      expect(warnings).toEqual([]);
    });

    it('should return empty warnings when only denyPatterns are present', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            denyPatterns: ['Bash:rm*'],
          },
        },
      });
      expect(warnings).toEqual([]);
    });

    it('should return empty warnings when only allowPatterns are present', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            allowPatterns: ['Bash:git*'],
          },
        },
      });
      expect(warnings).toEqual([]);
    });

    it('should return empty warnings when no conflicts exist', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            denyPatterns: ['Bash:rm*'],
            allowPatterns: ['Bash:git*'],
          },
        },
      });
      expect(warnings).toEqual([]);
    });

    it('should return warnings when allow/deny patterns conflict', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            denyPatterns: ['Bash:git push*'],
            allowPatterns: ['Bash:git*'],
          },
        },
      });
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].property).toBe('gatekeeper.externalRestrictions');
      expect(warnings[0].message).toContain('deny takes precedence');
    });

    // Issue #674: warn when operation appears in both allow and confirm
    it('should warn when operation appears in both allow and confirm lists', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          allow: ['create_element', 'edit_element'],
          confirm: ['edit_element'],
        },
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
      expect(warnings[0].message).toContain("'edit_element' appears in both allow and confirm");
      expect(warnings[0].message).toContain('confirm');
    });

    it('should warn once per overlapping operation', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          allow: ['create_element', 'delete_element'],
          confirm: ['create_element', 'delete_element'],
        },
      });
      expect(warnings).toHaveLength(2);
    });

    it('should not warn when allow and confirm lists have no overlap', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          allow: ['create_element'],
          confirm: ['delete_element'],
        },
      });
      expect(warnings).toHaveLength(0);
    });

    it('should return warnings for exact pattern overlap', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            denyPatterns: ['Edit'],
            allowPatterns: ['Edit'],
          },
        },
      });
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].message).toContain('deny takes precedence');
    });

    it('should return error for malformed policy', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: 'invalid',
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
      expect(warnings[0].message).toContain('must be an object');
    });

    it('should return warnings for confirm/deny pattern overlap (Issue #1660)', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            denyPatterns: ['Bash:git push*'],
            confirmPatterns: ['Bash:git push*'],
          },
        },
      });
      expect(warnings.some(w => w.message.includes('deny takes precedence over confirm'))).toBe(true);
    });

    it('should return pattern syntax warnings for missing prefix (Issue #1664)', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            denyPatterns: ['rm -rf /'],
          },
        },
      });
      expect(warnings.some(w => w.message.includes('no tool prefix'))).toBe(true);
    });

    it('should return pattern syntax warnings for regex syntax (Issue #1664)', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            allowPatterns: ['Bash:git (push|pull)'],
          },
        },
      });
      expect(warnings.some(w => w.message.includes('regex syntax'))).toBe(true);
    });

    it('should not return syntax warnings for well-formed patterns', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: {
          externalRestrictions: {
            description: 'Test',
            denyPatterns: ['Bash:rm -rf*'],
            confirmPatterns: ['Bash:git push*'],
            allowPatterns: ['Bash:git *', 'Bash:npm *', 'Edit:src/*'],
          },
        },
      });
      // May have allow/deny conflicts, but no syntax warnings
      const syntaxWarnings = warnings.filter(w =>
        w.message.includes('no tool prefix') ||
        w.message.includes('regex syntax') ||
        w.message.includes('matches everything')
      );
      expect(syntaxWarnings).toHaveLength(0);
    });
  });
});
