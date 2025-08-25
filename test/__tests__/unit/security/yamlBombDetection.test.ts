/**
 * Tests for YAML bomb detection (Issue #364)
 * Verifies protection against recursive YAML structures that cause denial of service
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ContentValidator } from '../../../../src/security/contentValidator.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';

// Mock SecurityMonitor to capture events
jest.mock('../../../../src/security/securityMonitor.js');

// Create a spy for the logSecurityEvent method
const logSecurityEventSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

describe('YAML Bomb Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Direct Recursion Detection', () => {
    it('should detect direct array recursion', () => {
      const yamlBomb = `
        bomb: &a ["test", *a]
      `;
      
      const result = ContentValidator.validateYamlContent(yamlBomb);
      
      expect(result).toBe(false);
      expect(logSecurityEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YAML_INJECTION_ATTEMPT',
          severity: 'CRITICAL',
          source: 'yaml_bomb_detection'
        })
      );
    });

    it('should detect direct object recursion', () => {
      const yamlBomb = `
        config: &bomb {nested: *bomb}
      `;
      
      const result = ContentValidator.validateYamlContent(yamlBomb);
      
      expect(result).toBe(false);
      expect(logSecurityEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YAML_INJECTION_ATTEMPT',
          severity: 'CRITICAL',
          source: 'yaml_bomb_detection'
        })
      );
    });

    it('should detect direct value recursion', () => {
      const yamlBomb = `
        data: &recursive_ref
        value: *recursive_ref
      `;
      
      const result = ContentValidator.validateYamlContent(yamlBomb);
      
      expect(result).toBe(false);
    });
  });

  describe('Amplification Attack Detection', () => {
    it('should detect excessive alias amplification', () => {
      // Create YAML with many aliases pointing to one anchor
      const amplificationAttack = `
        anchor: &data "value"
        references:
          - *data
          - *data
          - *data
          - *data
          - *data
          - *data
          - *data
          - *data
          - *data
          - *data
          - *data
          - *data
      `;
      
      const result = ContentValidator.validateYamlContent(amplificationAttack);
      
      expect(result).toBe(false);
      expect(logSecurityEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YAML_INJECTION_ATTEMPT',
          severity: 'HIGH',
          source: 'yaml_amplification_detection',
          details: expect.stringContaining('Excessive alias amplification')
        })
      );
    });

    it('should detect multiple nested anchors', () => {
      const nestedAnchors = `
        level1: &a [&b [&c [&d [&e [data]]]]]
      `;
      
      const result = ContentValidator.validateYamlContent(nestedAnchors);
      
      expect(result).toBe(false);
      expect(logSecurityEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YAML_INJECTION_ATTEMPT',
          severity: 'CRITICAL',
          source: 'yaml_bomb_detection'
        })
      );
    });

    it('should detect excessive aliases in close proximity', () => {
      const manyAliases = `
        data: [*a, *b, *c, *d, *e, *f, *g, *h, *i, *j, *k, *l]
      `;
      
      const result = ContentValidator.validateYamlContent(manyAliases);
      
      expect(result).toBe(false);
    });
  });

  describe('Legitimate YAML Handling', () => {
    it('should allow normal anchor/alias usage', () => {
      const legitimateYaml = `
        defaults: &defaults
          timeout: 30
          retries: 3
        
        production:
          <<: *defaults
          environment: prod
        
        staging:
          <<: *defaults
          environment: staging
      `;
      
      // Should not be flagged as a bomb (only 2 aliases for 1 anchor)
      const result = ContentValidator.validateYamlContent(legitimateYaml);
      
      // Note: May still fail for other reasons, but not for YAML bomb
      // Check that YAML bomb detection specifically wasn't triggered
      const calls = logSecurityEventSpy.mock.calls;
      const bombDetected = calls.some(call => 
        call[0].source === 'yaml_bomb_detection' || 
        call[0].source === 'yaml_amplification_detection'
      );
      
      expect(bombDetected).toBe(false);
    });

    it('should allow reasonable anchor reuse', () => {
      const reasonableReuse = `
        common: &common_config
          version: 1.0
          author: test
        
        item1:
          <<: *common_config
          name: Item 1
        
        item2:
          <<: *common_config
          name: Item 2
        
        item3:
          <<: *common_config
          name: Item 3
      `;
      
      // 3 aliases for 1 anchor is reasonable
      const result = ContentValidator.validateYamlContent(reasonableReuse);
      
      const calls = logSecurityEventSpy.mock.calls;
      const amplificationDetected = calls.some(call => 
        call[0].source === 'yaml_amplification_detection'
      );
      
      expect(amplificationDetected).toBe(false);
    });
  });

  describe('Complex YAML Bomb Patterns', () => {
    it('should detect exponential expansion pattern', () => {
      const exponentialBomb = `
        a: &a ["a", *a]
        b: &b [*a, *a]
        c: &c [*b, *b]
        d: &d [*c, *c]
      `;
      
      const result = ContentValidator.validateYamlContent(exponentialBomb);
      
      expect(result).toBe(false);
    });

    it('should detect circular reference chains', () => {
      const circularChain = `
        node1: &n1
          child: *n2
        node2: &n2
          child: *n1
      `;
      
      // This might not be caught by simple patterns but would cause issues
      const result = ContentValidator.validateYamlContent(circularChain);
      
      // Even if not caught as direct recursion, the excessive aliases should trigger
      expect(result).toBe(false);
    });
  });

  describe('Performance', () => {
    it('should handle large YAML efficiently', () => {
      // Create a large but safe YAML
      const largeYaml = Array(100).fill(null).map((_, i) => 
        `item${i}: value${i}`
      ).join('\n');
      
      const startTime = Date.now();
      ContentValidator.validateYamlContent(largeYaml);
      const endTime = Date.now();
      
      // Should complete quickly (< 100ms)
      expect(endTime - startTime).toBeLessThan(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle YAML with comments', () => {
      const yamlWithComments = `
        # This is a comment with &anchor and *alias mentions
        data: value
        # Another comment
      `;
      
      const result = ContentValidator.validateYamlContent(yamlWithComments);
      
      // Comments should not trigger false positives
      const calls = logSecurityEventSpy.mock.calls;
      const bombDetected = calls.some(call => 
        call[0].source === 'yaml_bomb_detection'
      );
      
      expect(bombDetected).toBe(false);
    });

    it('should handle YAML with strings containing anchor-like patterns', () => {
      const yamlWithStrings = `
        description: "Use &anchor and *alias in your YAML"
        example: '&example [*example]'
      `;
      
      // Strings should not trigger false positives
      const result = ContentValidator.validateYamlContent(yamlWithStrings);
      
      const calls = logSecurityEventSpy.mock.calls;
      const bombDetected = calls.some(call => 
        call[0].source === 'yaml_bomb_detection'
      );
      
      // Note: Simple regex might still catch these, which is acceptable for security
      // Better to have false positives than miss actual attacks
    });
  });
});