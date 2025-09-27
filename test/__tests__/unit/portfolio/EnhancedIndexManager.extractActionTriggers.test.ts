/**
 * Tests for EnhancedIndexManager.extractActionTriggers method
 *
 * Validates the enhanced verb extraction functionality including:
 * - Extraction from search.triggers field
 * - Extraction from actions field
 * - Extraction from keywords with verb detection
 * - Edge cases and security considerations
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock logger module BEFORE importing EnhancedIndexManager
jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Import logger after mocking
const { logger } = await import('../../../../src/utils/logger.js');

// Import EnhancedIndexManager AFTER mocking logger
const { EnhancedIndexManager } = await import('../../../../src/portfolio/EnhancedIndexManager.js');
type ElementDefinition = import('../../../../src/portfolio/EnhancedIndexManager.js').ElementDefinition;

describe('EnhancedIndexManager.extractActionTriggers', () => {
  let manager: EnhancedIndexManager;
  let triggers: Record<string, string[]>;

  beforeEach(() => {
    manager = EnhancedIndexManager.getInstance();
    triggers = {};
    jest.clearAllMocks();
  });

  describe('search.triggers extraction', () => {
    it('should extract triggers from search.triggers array', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['debug', 'troubleshoot', 'fix']
        }
      };

      // Access private method via reflection for testing
      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        debug: ['test-element'],
        troubleshoot: ['test-element'],
        fix: ['test-element']
      });
    });

    it('should handle single trigger string', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: 'debug' as any // Single string instead of array
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        debug: ['test-element']
      });
    });

    it('should normalize triggers to lowercase', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['DEBUG', 'TroubleSHOOT', 'FIX']
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        debug: ['test-element'],
        troubleshoot: ['test-element'],
        fix: ['test-element']
      });
    });

    it('should ignore empty/invalid triggers', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['', '  ', null, undefined, 123, 'valid-trigger'] as any
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        'valid-trigger': ['test-element']
      });
    });
  });

  describe('actions field extraction', () => {
    it('should extract verbs from actions field', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'skill'
        },
        actions: {
          analyze: { verb: 'analyze', behavior: 'analyze' },
          review: { verb: 'review', behavior: 'review' }
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        analyze: ['test-element'],
        review: ['test-element']
      });
    });

    it('should use action key as verb when verb property is missing', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'skill'
        },
        actions: {
          deploy: { behavior: 'execute' } as any
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        deploy: ['test-element']
      });
    });
  });

  describe('keyword verb extraction', () => {
    it('should extract verb-like keywords', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'template'
        },
        search: {
          keywords: ['create', 'generate', 'documentation', 'api']
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Should extract verb-like keywords only
      expect(triggers).toEqual({
        create: ['test-element'],
        generate: ['test-element']
        // 'documentation' and 'api' are not verb-like
      });
    });

    it('should detect verbs with common suffixes', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'agent'
        },
        search: {
          keywords: ['simplify', 'optimize', 'automate']
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        simplify: ['test-element'],
        optimize: ['test-element'],
        automate: ['test-element']
      });
    });
  });

  describe('duplicate handling', () => {
    it('should not add duplicate triggers for same element', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['debug', 'debug', 'DEBUG'],
          keywords: ['debug', 'test']
        },
        actions: {
          debug: { verb: 'debug', behavior: 'debug' }
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Should only have one entry for 'debug'
      expect(triggers).toEqual({
        debug: ['test-element'],
        test: ['test-element']
      });
    });

    it('should handle multiple elements with same trigger', () => {
      const elementDef1: ElementDefinition = {
        core: { name: 'element1', type: 'persona' },
        search: { triggers: ['debug'] }
      };

      const elementDef2: ElementDefinition = {
        core: { name: 'element2', type: 'skill' },
        search: { triggers: ['debug'] }
      };

      (manager as any).extractActionTriggers(elementDef1, 'element1', triggers);
      (manager as any).extractActionTriggers(elementDef2, 'element2', triggers);

      expect(triggers).toEqual({
        debug: ['element1', 'element2']
      });
    });
  });

  describe('edge cases and security', () => {
    it('should handle missing search field', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        }
        // No search field
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({});
    });

    it('should handle null/undefined elementDef gracefully', () => {
      expect(() => {
        (manager as any).extractActionTriggers(null, 'test-element', triggers);
      }).not.toThrow();

      expect(() => {
        (manager as any).extractActionTriggers(undefined, 'test-element', triggers);
      }).not.toThrow();
    });

    it('should enforce trigger count limits', () => {
      // Create element with more triggers than allowed
      const manyTriggers = Array.from({ length: 100 }, (_, i) => `trigger${i}`);

      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: manyTriggers
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Should only have MAX_TRIGGERS_PER_ELEMENT entries
      const triggerCount = Object.values(triggers).filter(
        elements => elements.includes('test-element')
      ).length;

      expect(triggerCount).toBeLessThanOrEqual(50); // MAX_TRIGGERS_PER_ELEMENT
      expect(logger.warn).toHaveBeenCalledWith(
        'Trigger limit exceeded for element',
        expect.objectContaining({ elementName: 'test-element' })
      );
    });

    it('should validate trigger string format', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: [
            'valid-trigger',
            'also-valid',
            '123invalid',  // Starts with number
            'invalid!',    // Contains special char
            'a'.repeat(100), // Too long
            '-invalid',    // Starts with hyphen
          ]
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Should only include valid triggers
      expect(Object.keys(triggers).sort()).toEqual(['also-valid', 'valid-trigger']);
    });

    it('should handle triggers with excessive length', () => {
      const longTrigger = 'a'.repeat(100);
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: [longTrigger, 'valid']
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Long trigger should be rejected
      expect(triggers).toEqual({
        valid: ['test-element']
      });
    });
  });

  describe('combined extraction', () => {
    it('should extract from all sources without duplication', () => {
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['debug', 'fix'],
          keywords: ['create', 'debug', 'api']
        },
        actions: {
          analyze: { verb: 'analyze', behavior: 'analyze' },
          debug: { verb: 'debug', behavior: 'debug' }
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      expect(triggers).toEqual({
        debug: ['test-element'],    // From triggers, keywords, and actions (no duplication)
        fix: ['test-element'],       // From triggers
        create: ['test-element'],    // From keywords (verb-like)
        analyze: ['test-element']    // From actions
        // 'api' not included as it's not verb-like
      });
    });
  });
});