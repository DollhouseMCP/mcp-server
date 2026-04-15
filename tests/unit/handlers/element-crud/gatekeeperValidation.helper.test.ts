import { describe, expect, it } from '@jest/globals';

const {
  collectGatekeeperAuthoringErrors,
  formatGatekeeperValidationMessage,
} = await import('../../../../src/handlers/element-crud/helpers.js');

describe('gatekeeper authoring helpers', () => {
  describe('collectGatekeeperAuthoringErrors', () => {
    it('collects misplaced root externalRestrictions from the input object', () => {
      const errors = collectGatekeeperAuthoringErrors({
        name: 'test-skill',
        externalRestrictions: {
          allowPatterns: ['Read:*'],
        },
      });

      expect(errors).toContain(
        'externalRestrictions must be nested under gatekeeper.externalRestrictions'
      );
    });

    it('collects malformed nested externalRestrictions from metadata', () => {
      const errors = collectGatekeeperAuthoringErrors(
        { name: 'test-skill' },
        {
          gatekeeper: {
            externalRestrictions: {
              allowPatterns: ['Read:*'],
            },
          },
        }
      );

      expect(errors).toContain(
        'externalRestrictions.description is required and must be a non-empty string'
      );
    });

    it('deduplicates identical errors coming from input and metadata', () => {
      const errors = collectGatekeeperAuthoringErrors(
        {
          externalRestrictions: {
            allowPatterns: ['Read:*'],
          },
        },
        {
          externalRestrictions: {
            allowPatterns: ['Read:*'],
          },
        }
      );

      expect(errors).toEqual([
        'externalRestrictions must be nested under gatekeeper.externalRestrictions',
      ]);
    });
  });

  describe('formatGatekeeperValidationMessage', () => {
    it('formats a consistent bullet list message', () => {
      const message = formatGatekeeperValidationMessage([
        'first error',
        'second error',
        'first error',
      ]);

      expect(message).toBe([
        'Gatekeeper policy validation failed:',
        '  • first error',
        '  • second error',
      ].join('\n'));
    });
  });
});
