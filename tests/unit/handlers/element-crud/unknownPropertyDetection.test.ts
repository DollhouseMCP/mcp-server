/**
 * Tests for unknown metadata property detection.
 *
 * This feature warns LLMs when they use incorrect property names in metadata,
 * allowing them to correct their behavior in real-time.
 */

import { describe, it, expect } from '@jest/globals';
import {
  detectUnknownMetadataProperties,
  formatUnknownPropertyWarnings,
  validateGatekeeperPolicy
} from '../../../../src/handlers/element-crud/helpers.js';
import { ElementType } from '../../../../src/portfolio/PortfolioManager.js';

describe('Unknown Metadata Property Detection', () => {
  describe('detectUnknownMetadataProperties', () => {
    describe('Ensemble - members vs elements', () => {
      it('should warn when using "members" instead of "elements"', () => {
        const metadata = {
          name: 'test-ensemble',
          members: [{ type: 'skill', name: 'my-skill' }]
        };

        const warnings = detectUnknownMetadataProperties(ElementType.ENSEMBLE, metadata);

        expect(warnings).toHaveLength(1);
        expect(warnings[0].property).toBe('members');
        expect(warnings[0].suggestion).toBe('elements');
        expect(warnings[0].message).toContain("did you mean 'elements'");
      });

      it('should not warn when using "elements" correctly', () => {
        const metadata = {
          name: 'test-ensemble',
          elements: [{ type: 'skill', name: 'my-skill' }],
          activationStrategy: 'sequential'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.ENSEMBLE, metadata);

        expect(warnings).toHaveLength(0);
      });

      it('should accept all known ensemble properties', () => {
        const metadata = {
          name: 'test',
          description: 'test desc',
          elements: [],
          activationStrategy: 'sequential',
          activation_strategy: 'lazy',  // snake_case variant
          conflictResolution: 'priority',
          conflict_resolution: 'merge',
          contextSharing: 'full',
          context_sharing: 'selective'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.ENSEMBLE, metadata);

        expect(warnings).toHaveLength(0);
      });
    });

    describe('Common typos', () => {
      it('should suggest "description" for "discription"', () => {
        const metadata = {
          name: 'test',
          discription: 'typo!'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.SKILL, metadata);

        expect(warnings).toHaveLength(1);
        expect(warnings[0].property).toBe('discription');
        expect(warnings[0].suggestion).toBe('description');
      });

      it('should suggest "variables" for "varibles" in templates', () => {
        const metadata = {
          name: 'test',
          varibles: ['a', 'b']
        };

        const warnings = detectUnknownMetadataProperties(ElementType.TEMPLATE, metadata);

        expect(warnings).toHaveLength(1);
        expect(warnings[0].property).toBe('varibles');
        expect(warnings[0].suggestion).toBe('variables');
      });

      it('should detect multiple typos', () => {
        const metadata = {
          name: 'test',
          discription: 'typo 1',
          auther: 'typo 2'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.PERSONA, metadata);

        expect(warnings).toHaveLength(2);
        expect(warnings.map(w => w.property).sort()).toEqual(['auther', 'discription']);
      });
    });

    describe('Unknown properties without corrections', () => {
      it('should warn about completely unknown properties', () => {
        const metadata = {
          name: 'test',
          unknownField: 'value',
          anotherRandomField: 123
        };

        const warnings = detectUnknownMetadataProperties(ElementType.SKILL, metadata);

        expect(warnings).toHaveLength(2);
        expect(warnings[0].suggestion).toBeUndefined();
        expect(warnings[0].message).toContain('will be ignored');
      });
    });

    describe('Valid properties by element type', () => {
      it('should accept persona-specific properties', () => {
        const metadata = {
          name: 'test',
          triggers: ['hello'],
          tone: 'friendly',
          personality: 'helpful'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.PERSONA, metadata);
        expect(warnings).toHaveLength(0);
      });

      it('should accept skill-specific properties', () => {
        const metadata = {
          name: 'test',
          domain: 'coding',
          examples: ['example1'],
          prerequisites: []
        };

        const warnings = detectUnknownMetadataProperties(ElementType.SKILL, metadata);
        expect(warnings).toHaveLength(0);
      });

      it('should accept template-specific properties', () => {
        const metadata = {
          name: 'test',
          variables: ['var1'],
          outputFormat: 'json'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.TEMPLATE, metadata);
        expect(warnings).toHaveLength(0);
      });

      it('should accept agent-specific properties', () => {
        const metadata = {
          name: 'test',
          goals: ['goal1'],
          constraints: [],
          decisionFramework: 'simple'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.AGENT, metadata);
        expect(warnings).toHaveLength(0);
      });

      it('should accept memory-specific properties', () => {
        const metadata = {
          name: 'test',
          id: '123',
          retentionPolicy: 'permanent'
        };

        const warnings = detectUnknownMetadataProperties(ElementType.MEMORY, metadata);
        expect(warnings).toHaveLength(0);
      });
    });

    describe('Edge cases', () => {
      it('should handle undefined metadata', () => {
        const warnings = detectUnknownMetadataProperties(ElementType.PERSONA, undefined);
        expect(warnings).toHaveLength(0);
      });

      it('should handle empty metadata', () => {
        const warnings = detectUnknownMetadataProperties(ElementType.PERSONA, {});
        expect(warnings).toHaveLength(0);
      });

      it('should handle non-object metadata', () => {
        const warnings = detectUnknownMetadataProperties(
          ElementType.PERSONA,
          'not an object' as unknown as Record<string, unknown>
        );
        expect(warnings).toHaveLength(0);
      });
    });
  });

  describe('Gatekeeper policy recognition', () => {
    const ALL_TYPES = [
      ElementType.PERSONA,
      ElementType.SKILL,
      ElementType.TEMPLATE,
      ElementType.AGENT,
      ElementType.MEMORY,
      ElementType.ENSEMBLE
    ];

    it('should accept gatekeeper without warnings on all 6 element types', () => {
      for (const type of ALL_TYPES) {
        const metadata = {
          name: 'test',
          gatekeeper: { deny: ['delete_element'] }
        };
        const warnings = detectUnknownMetadataProperties(type, metadata);
        expect(warnings).toHaveLength(0);
      }
    });

    it('should produce no warnings for valid gatekeeper policy structure', () => {
      const metadata = {
        name: 'test',
        gatekeeper: {
          allow: ['list_elements', 'get_element'],
          confirm: ['edit_element'],
          deny: ['delete_element'],
          scopeRestrictions: {
            allowedTypes: ['personas', 'skills'],
            blockedTypes: ['memories']
          }
        }
      };

      const warnings = detectUnknownMetadataProperties(ElementType.PERSONA, metadata);
      expect(warnings).toHaveLength(0);
    });

    it('should warn when gatekeeper is not an object', () => {
      const metadata = {
        name: 'test',
        gatekeeper: 'not-an-object'
      };

      const warnings = detectUnknownMetadataProperties(ElementType.PERSONA, metadata);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
      expect(warnings[0].message).toContain('must be an object');
    });

    it('should warn when allow is not an array', () => {
      const metadata = {
        name: 'test',
        gatekeeper: { allow: 'not-an-array' }
      };

      const warnings = detectUnknownMetadataProperties(ElementType.SKILL, metadata);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
      expect(warnings[0].message).toContain('allow must be an array');
    });

    it('should warn when deny contains non-strings', () => {
      const metadata = {
        name: 'test',
        gatekeeper: { deny: [123, true] }
      };

      const warnings = detectUnknownMetadataProperties(ElementType.AGENT, metadata);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
      expect(warnings[0].message).toContain('deny must contain only strings');
    });

    it('should warn when scopeRestrictions is not an object', () => {
      const metadata = {
        name: 'test',
        gatekeeper: { scopeRestrictions: 'bad' }
      };

      const warnings = detectUnknownMetadataProperties(ElementType.TEMPLATE, metadata);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
      expect(warnings[0].message).toContain('scopeRestrictions must be an object');
    });

    it('should warn when scopeRestrictions.allowedTypes is not an array', () => {
      const metadata = {
        name: 'test',
        gatekeeper: {
          scopeRestrictions: { allowedTypes: 'personas' }
        }
      };

      const warnings = detectUnknownMetadataProperties(ElementType.ENSEMBLE, metadata);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
      expect(warnings[0].message).toContain('allowedTypes must be an array');
    });

    it('should accept empty gatekeeper object', () => {
      const metadata = {
        name: 'test',
        gatekeeper: {}
      };

      const warnings = detectUnknownMetadataProperties(ElementType.MEMORY, metadata);
      expect(warnings).toHaveLength(0);
    });
  });

  describe('validateGatekeeperPolicy', () => {
    it('should return empty array when no gatekeeper field', () => {
      const warnings = validateGatekeeperPolicy({ name: 'test' });
      expect(warnings).toHaveLength(0);
    });

    it('should return empty array for valid policy', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: { allow: ['list_elements'], deny: ['delete_element'] }
      });
      expect(warnings).toHaveLength(0);
    });

    it('should return warning for malformed policy', () => {
      const warnings = validateGatekeeperPolicy({
        gatekeeper: 'invalid'
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0].property).toBe('gatekeeper');
    });
  });

  describe('formatUnknownPropertyWarnings', () => {
    it('should return empty string for no warnings', () => {
      const result = formatUnknownPropertyWarnings([]);
      expect(result).toBe('');
    });

    it('should format single warning with suggestion', () => {
      const warnings = [{
        property: 'members',
        suggestion: 'elements',
        message: "Unknown property 'members' - did you mean 'elements'?"
      }];

      const result = formatUnknownPropertyWarnings(warnings);

      expect(result).toContain('⚠️ **Metadata Warnings:**');
      expect(result).toContain("did you mean 'elements'");
      expect(result).toContain("Use 'elements' instead");
    });

    it('should format warning without suggestion', () => {
      const warnings = [{
        property: 'unknownField',
        message: "Unknown property 'unknownField' for skill - this property will be ignored"
      }];

      const result = formatUnknownPropertyWarnings(warnings);

      expect(result).toContain('⚠️ **Metadata Warnings:**');
      expect(result).toContain('will be ignored');
      expect(result).not.toContain('Use');
    });

    it('should format multiple warnings', () => {
      const warnings = [
        { property: 'members', suggestion: 'elements', message: "msg1" },
        { property: 'discription', suggestion: 'description', message: "msg2" }
      ];

      const result = formatUnknownPropertyWarnings(warnings);

      expect(result).toContain('⚠️ **Metadata Warnings:**');
      expect(result.match(/•/g)?.length).toBe(2);
    });
  });
});
