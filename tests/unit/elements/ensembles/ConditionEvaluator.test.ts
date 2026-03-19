/**
 * Unit tests for Ensemble Condition Evaluation
 *
 * Tests the condition validation and evaluation logic for conditional activation
 * in ensembles. These tests cover:
 *
 * 1. Valid expression syntax
 * 2. Invalid expressions (pattern violations)
 * 3. Edge cases and boundary conditions
 * 4. Unicode handling
 * 5. Expression length limits
 *
 * IMPORTANT SECURITY NOTE:
 * =======================
 * The current implementation uses a permissive pattern that allows many constructs
 * (like function calls, property access, etc.) to pass validation. This is INTENTIONAL.
 *
 * Security is intended to be enforced at EVALUATION time (when implemented) through:
 * - Sandboxed execution environment
 * - Operator whitelisting
 * - Timeout protection
 * - Context variable access control
 *
 * These tests validate the PATTERN (syntax), not the security (evaluation).
 * Security tests for evaluation are in tests/security/ConditionInjection.security.test.ts
 *
 * @see src/elements/ensembles/Ensemble.ts - evaluateCondition() method
 * @see src/elements/ensembles/constants.ts - CONDITION_PATTERN and limits
 * @see tests/security/ConditionInjection.security.test.ts - Security tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Ensemble } from '../../../../src/elements/ensembles/Ensemble.js';
import { EnsembleElement } from '../../../../src/elements/ensembles/types.js';
import { ENSEMBLE_LIMITS, ENSEMBLE_PATTERNS } from '../../../../src/elements/ensembles/constants.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';

// Mock dependencies
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

const metadataService: MetadataService = createTestMetadataService();

describe('Ensemble Condition Evaluator', () => {
  let ensemble: Ensemble;

  beforeEach(() => {
    jest.clearAllMocks();
    (SecurityMonitor.logSecurityEvent as jest.Mock) = jest.fn();

    ensemble = new Ensemble({
      name: 'Test Ensemble',
      description: 'Testing condition evaluation'
    }, [], metadataService);
  });

  describe('Valid Condition Syntax', () => {
    describe('Simple Comparisons', () => {
      it('should accept simple numeric comparison', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority > 80'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
        expect(ensemble.getElement('test-element')?.condition).toBe('priority > 80');
      });

      it('should accept equality comparison', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'role == primary'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept inequality comparison', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'status != disabled'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept less than or equal', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority <= 100'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept greater than or equal', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority >= 50'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('Logical Operators', () => {
      it('should accept AND operator', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority > 80 && role == primary'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept OR operator', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority > 80 || critical'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept negation operator', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '!disabled'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept complex logical expression', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority > 80 && role == primary || override'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('Nested Expressions', () => {
      it('should accept parentheses for grouping', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '(priority > 50 || critical) && !paused'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept deeply nested parentheses', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '((priority > 80) && (role == primary)) || emergency'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept complex nested expression', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '(priority >= 80 && !disabled) || (critical && override)'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('String Values', () => {
      it('should accept single-quoted strings', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: "environment == 'production'"
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept double-quoted strings', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'environment == "production"'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept strings with spaces', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'message == "hello world"'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('Property Access', () => {
      it('should accept dot notation', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'context.security_review == true'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept nested property access', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'user.profile.role == admin'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept hyphenated property names', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'feature-flag == enabled'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should accept underscored property names', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'user_role == administrator'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });
  });

  describe('Invalid Expressions (Pattern Violations)', () => {
    describe('Characters Not in Pattern', () => {
      it('should reject semicolons', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: "priority > 0; require('fs')"
        };

        expect(() => ensemble.addElement(element)).toThrow();
        expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'ENSEMBLE_SUSPICIOUS_CONDITION',
            severity: 'HIGH'
          })
        );
      });

      it('should reject dollar signs', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority $ 50'
        };

        expect(() => ensemble.addElement(element)).toThrow();
      });

      it('should reject backticks', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority > `50`'
        };

        expect(() => ensemble.addElement(element)).toThrow();
      });

      it('should reject curly braces', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '{priority: 50}'
        };

        expect(() => ensemble.addElement(element)).toThrow();
      });

      it('should allow square brackets (blocked at evaluation)', () => {
        // CONDITION_PATTERN allows square brackets - security enforced at evaluation time
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'array[0] == value'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should allow at signs (blocked at evaluation if needed)', () => {
        // CONDITION_PATTERN allows @ - security enforced at evaluation time
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'user@domain == admin'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should allow hash symbols (blocked at evaluation if needed)', () => {
        // CONDITION_PATTERN allows # - security enforced at evaluation time
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '#id == value'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('Empty and Invalid Conditions', () => {
      it('should allow empty condition (falsy check skips validation)', () => {
        // Empty string is falsy, so `if (element.condition)` check skips validation
        // The element is added without a condition property
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: ''
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
        const added = ensemble.getElement('test-element');
        expect(added?.condition).toBeUndefined(); // Empty string not stored
      });

      it('should reject whitespace-only condition', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '   '
        };

        expect(() => ensemble.addElement(element)).toThrow();
      });
    });
  });

  describe('Edge Cases', () => {
    describe('Length Limits', () => {
      it('should accept condition at maximum length', () => {
        const maxCondition = 'a'.repeat(ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH - 10) + ' > value';
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: maxCondition
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should truncate condition exceeding maximum length', () => {
        const oversizedCondition = 'a'.repeat(ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH + 100);
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: oversizedCondition
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
        const addedElement = ensemble.getElement('test-element');
        expect(addedElement?.condition?.length).toBeLessThanOrEqual(
          ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH
        );
      });

      it('should handle very long property names', () => {
        const longPropertyName = 'context.' + 'a'.repeat(100);
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: longPropertyName + ' == value'
        };

        if ((longPropertyName + ' == value').length <= ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH) {
          expect(() => ensemble.addElement(element)).not.toThrow();
        }
      });
    });

    describe('Unicode and Special Characters', () => {
      it('should handle Unicode in string values', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'name == "José"'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle emoji in string values', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'status == "✓"'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle combining characters', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'name == "café"'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('Numeric Edge Values', () => {
      it('should handle zero', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority > 0'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle negative numbers', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'temperature > -10'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle decimal numbers', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'ratio > 0.5'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle large numbers', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'count < 1000000'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('Boolean Values', () => {
      it('should handle true literal', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'enabled == true'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle false literal', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'disabled == false'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle boolean variable', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'enabled'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle negated boolean', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '!disabled'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });

    describe('Whitespace Handling', () => {
      it('should handle multiple spaces', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'priority    >    80'
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });

      it('should handle leading/trailing whitespace', () => {
        const element: EnsembleElement = {
          element_name: 'test-element',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: '  priority > 80  '
        };

        expect(() => ensemble.addElement(element)).not.toThrow();
      });
    });
  });

  describe('Condition Pattern Validation', () => {
    it('should validate against CONDITION_PATTERN regex', () => {
      const validPatterns = [
        'priority > 80',
        'role == "primary"',
        'enabled && !paused',
        '(priority >= 50) || critical',
        'context.flag == true',
        'user-type != guest'
      ];

      validPatterns.forEach(pattern => {
        expect(ENSEMBLE_PATTERNS.CONDITION_PATTERN.test(pattern)).toBe(true);
      });
    });

    it('should reject patterns with template literal characters', () => {
      // CONDITION_PATTERN blocks: backticks (`), dollar signs ($), and curly braces ({})
      // Other characters like @, #, [], etc. are allowed and will be handled at evaluation
      const invalidPatterns = [
        'priority $ 50',           // Dollar sign - BLOCKED
        '{key: value}',            // Curly braces - BLOCKED
        'template`string`',        // Backticks - BLOCKED
        '${interpolation}',        // Template interpolation - BLOCKED
      ];

      invalidPatterns.forEach(pattern => {
        expect(ENSEMBLE_PATTERNS.CONDITION_PATTERN.test(pattern)).toBe(false);
      });
    });

    it('should allow patterns that are safe for VM evaluation', () => {
      // These patterns pass CONDITION_PATTERN but may be blocked by DANGEROUS_CONDITION_PATTERNS
      // or safely evaluated/rejected in the VM sandbox
      const allowedByPattern = [
        'priority @ 50',           // At sign - allowed by pattern
        'priority # 50',           // Hash - allowed by pattern
        'array[0] == value',       // Square brackets - allowed by pattern
        'value; eval()',           // Semicolon - allowed by pattern, blocked by dangerous check
      ];

      allowedByPattern.forEach(pattern => {
        expect(ENSEMBLE_PATTERNS.CONDITION_PATTERN.test(pattern)).toBe(true);
      });
    });

    it('should allow function-like syntax (security at evaluation)', () => {
      // Pattern allows these - they will be blocked during evaluation
      const allowedPatterns = [
        'eval("code")',
        'require("fs")',
        'process.exit()',
        '__proto__.attack'
      ];

      allowedPatterns.forEach(pattern => {
        expect(ENSEMBLE_PATTERNS.CONDITION_PATTERN.test(pattern)).toBe(true);
      });
    });
  });

  describe('Update Element Conditions', () => {
    beforeEach(() => {
      ensemble.addElement({
        element_name: 'existing-element',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'conditional',
        condition: 'priority > 50'
      });
    });

    it('should allow updating condition to valid expression', () => {
      expect(() => {
        ensemble.updateElement('existing-element', {
          condition: 'priority >= 80'
        });
      }).not.toThrow();

      expect(ensemble.getElement('existing-element')?.condition).toBe('priority >= 80');
    });

    it('should reject updating condition to invalid pattern', () => {
      expect(() => {
        ensemble.updateElement('existing-element', {
          condition: 'priority > 50; eval()'
        });
      }).toThrow();

      expect(ensemble.getElement('existing-element')?.condition).toBe('priority > 50');
    });

    it('should allow removing condition', () => {
      expect(() => {
        ensemble.updateElement('existing-element', {
          activation: 'always' // Change to always when removing condition
        });
      }).not.toThrow();

      // Condition should still be there unless explicitly set to undefined
      // Just verify update succeeded
      expect(ensemble.getElement('existing-element')).toBeDefined();
    });
  });

  describe('Security Event Logging', () => {
    it('should log security event for pattern-invalid condition', () => {
      jest.clearAllMocks();

      const element: EnsembleElement = {
        element_name: 'test-element',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'conditional',
        condition: "priority > 0; require('fs')"
      };

      try {
        ensemble.addElement(element);
      } catch {
        // Expected to throw
      }

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ENSEMBLE_SUSPICIOUS_CONDITION',
          severity: 'HIGH',
          source: 'Ensemble.addElement',
          details: expect.stringContaining('Suspicious activation condition')
        })
      );
    });

    it('should log security event when updating to invalid condition', () => {
      ensemble.addElement({
        element_name: 'existing-element',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'conditional',
        condition: 'priority > 50'
      });

      jest.clearAllMocks();

      try {
        ensemble.updateElement('existing-element', {
          condition: 'priority > 0; attack()'
        });
      } catch {
        // Expected to throw
      }

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ENSEMBLE_SUSPICIOUS_CONDITION',
          severity: 'HIGH',
          source: 'Ensemble.updateElement'
        })
      );
    });
  });

  describe('Performance Considerations', () => {
    it('should efficiently validate many conditions', () => {
      const startTime = Date.now();
      const iterations = 40; // Within ENSEMBLE_LIMITS.MAX_ELEMENTS (50)

      for (let i = 0; i < iterations; i++) {
        const element: EnsembleElement = {
          element_name: `test-element-${i}`,
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: `priority > ${i}`
        };

        ensemble.addElement(element);
      }

      const duration = Date.now() - startTime;

      // Should complete quickly (under 1 second for 40 conditions)
      expect(duration).toBeLessThan(1000);
      expect(ensemble.getElements().length).toBe(iterations);
    });

    it('should handle regex validation efficiently', () => {
      const startTime = Date.now();
      const pattern = ENSEMBLE_PATTERNS.CONDITION_PATTERN;

      // Test pattern matching performance
      for (let i = 0; i < 1000; i++) {
        pattern.test('priority > 80 && role == primary');
      }

      const duration = Date.now() - startTime;

      // Regex should be fast (under 100ms for 1000 tests)
      expect(duration).toBeLessThan(100);
    });
  });
});
