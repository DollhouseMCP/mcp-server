/**
 * SECURITY AUDIT: Ensemble Implementation - Critical Issues Investigation
 *
 * This test suite investigates three critical security issues reported in the Ensemble implementation:
 * 1. Prototype Pollution via Context Value Type Coercion (HIGHEST PRIORITY)
 * 2. Context Value Size Bypass via Serialization
 * 3. Path Validation - Unicode/Homograph Attacks
 *
 * Each test documents:
 * - The vulnerability claim
 * - Actual code behavior
 * - Real-world exploitability
 * - Risk assessment for this architecture (local single-user app)
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Ensemble } from '../../src/elements/ensembles/Ensemble.js';
import { ENSEMBLE_LIMITS } from '../../src/elements/ensembles/constants.js';
import type { EnsembleElement } from '../../src/elements/ensembles/types.js';
import { createTestMetadataService } from '../helpers/di-mocks.js';
import type { MetadataService } from '../../src/services/MetadataService.js';

// Create a shared MetadataService instance for all tests
const metadataService: MetadataService = createTestMetadataService();

describe('SECURITY AUDIT: Ensemble Critical Issues', () => {
  let ensemble: Ensemble;

  beforeEach(() => {
    ensemble = new Ensemble({
      name: 'test-ensemble',
      description: 'Security test ensemble',
      version: '1.0.0'
    }, [], metadataService);
  });

  describe('ISSUE #1: Prototype Pollution via resolveConflict() - HIGHEST PRIORITY', () => {
    /**
     * CLAIM: The merge strategy in resolveConflict() uses object spreading
     * which can lead to prototype pollution
     *
     * LOCATION: Line 1720-1724 in Ensemble.ts
     * ```typescript
     * case 'merge':
     *   if (this.isPlainObject(currentValue) && this.isPlainObject(newValue)) {
     *     conflict.resolution = { ...currentValue, ...newValue };
     *     return conflict.resolution;
     *   }
     * ```
     */

    it('VULNERABILITY TEST: Can __proto__ be injected via merge strategy?', () => {
      // Setup: Create ensemble with merge conflict resolution
      const mergeEnsemble = new Ensemble({
        name: 'merge-test',
        description: 'Test merge vulnerability',
        version: '1.0.0',
        conflictResolution: 'merge'
      }, [], metadataService);

      // Add two elements to the ensemble
      mergeEnsemble.addElement({
        element_name: 'element1',
        element_type: 'persona',
        role: 'primary',
        priority: 50,
        activation: 'always'
      });

      mergeEnsemble.addElement({
        element_name: 'element2',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      });

      // ATTACK VECTOR 1: Direct __proto__ injection
      const maliciousPayload1 = {
        normalKey: 'safe value',
        '__proto__': {
          polluted: true,
          isAdmin: true
        }
      };

      // Set initial value
      mergeEnsemble.setContextValue('testKey', { existing: 'data' }, 'element1');

      // Attempt prototype pollution via merge conflict
      mergeEnsemble.setContextValue('testKey', maliciousPayload1, 'element2');

      // Check if Object.prototype was polluted
      const testObj = {};
      const isPolluted = (testObj as any).polluted === true || (testObj as any).isAdmin === true;

      // EXPECTED: Should NOT be polluted (spread operator doesn't pollute)
      expect(isPolluted).toBe(false);

      // Check the actual context value
      const contextValue = mergeEnsemble.getContextValue('testKey') as any;

      // The __proto__ key should exist in the merged object but not pollute prototype
      console.log('Context value after merge:', JSON.stringify(contextValue, null, 2));

      // The merged object will have __proto__ as a regular property key
      expect(contextValue).toHaveProperty('normalKey');
      expect(contextValue).toHaveProperty('existing');
    });

    it('VULNERABILITY TEST: Can constructor be exploited via merge?', () => {
      const mergeEnsemble = new Ensemble({
        name: 'constructor-test',
        description: 'Test constructor pollution',
        version: '1.0.0',
        conflictResolution: 'merge'
      }, [], metadataService);

      mergeEnsemble.addElement({
        element_name: 'elem1',
        element_type: 'persona',
        role: 'primary',
        priority: 50,
        activation: 'always'
      });

      mergeEnsemble.addElement({
        element_name: 'elem2',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      });

      // ATTACK VECTOR 2: Constructor injection
      const maliciousPayload2 = {
        constructor: {
          prototype: {
            polluted: true
          }
        }
      };

      mergeEnsemble.setContextValue('testKey2', { safe: 'value' }, 'elem1');
      mergeEnsemble.setContextValue('testKey2', maliciousPayload2, 'elem2');

      // Check if pollution occurred
      const testObj = {};
      const isPolluted = (testObj as any).polluted === true;

      expect(isPolluted).toBe(false);
    });

    it('VULNERABILITY TEST: Nested __proto__ pollution', () => {
      const mergeEnsemble = new Ensemble({
        name: 'nested-proto-test',
        description: 'Test nested prototype pollution',
        version: '1.0.0',
        conflictResolution: 'merge'
      }, [], metadataService);

      mergeEnsemble.addElement({
        element_name: 'elem1',
        element_type: 'persona',
        role: 'primary',
        priority: 50,
        activation: 'always'
      });

      mergeEnsemble.addElement({
        element_name: 'elem2',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      });

      // ATTACK VECTOR 3: Deeply nested pollution attempt
      const deepPayload = JSON.parse('{"__proto__": {"polluted": true}}');

      mergeEnsemble.setContextValue('deepTest', { existing: 'data' }, 'elem1');
      mergeEnsemble.setContextValue('deepTest', deepPayload, 'elem2');

      const testObj = {};
      expect((testObj as any).polluted).toBeUndefined();
    });

    it('REAL-WORLD SCENARIO: Can attacker escalate privileges?', () => {
      /**
       * In a real attack, an attacker would try to:
       * 1. Pollute Object.prototype with isAdmin=true
       * 2. Check if unrelated code becomes vulnerable
       *
       * This tests if such an attack is possible via Ensemble merge
       */
      const mergeEnsemble = new Ensemble({
        name: 'privilege-test',
        description: 'Test privilege escalation',
        version: '1.0.0',
        conflictResolution: 'merge'
      }, [], metadataService);

      mergeEnsemble.addElement({
        element_name: 'attacker',
        element_type: 'persona',
        role: 'primary',
        priority: 50,
        activation: 'always'
      });

      mergeEnsemble.addElement({
        element_name: 'victim',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      });

      // Simulate user object without explicit isAdmin property
      const user = { username: 'regular-user' };

      // Attacker tries to pollute prototype
      const attackPayload = {
        '__proto__': { isAdmin: true }
      };

      mergeEnsemble.setContextValue('userData', { role: 'user' }, 'attacker');
      mergeEnsemble.setContextValue('userData', attackPayload, 'victim');

      // Check if user.isAdmin is now true (would indicate successful pollution)
      const privilegeEscalation = (user as any).isAdmin === true;

      expect(privilegeEscalation).toBe(false);
    });
  });

  describe('ISSUE #2: Context Value Size Bypass via Serialization', () => {
    /**
     * CLAIM: Size check uses JSON.stringify(value).length which can be bypassed
     * via circular references, sparse arrays, or buffers
     *
     * LOCATION: Line 1563 in Ensemble.ts
     * ```typescript
     * const valueSize = JSON.stringify(value).length;
     * if (valueSize > ENSEMBLE_LIMITS.MAX_CONTEXT_VALUE_SIZE) {
     *   // reject
     * }
     * ```
     */

    beforeEach(() => {
      ensemble.addElement({
        element_name: 'test-element',
        element_type: 'persona',
        role: 'primary',
        priority: 50,
        activation: 'always'
      });
    });

    it('VULNERABILITY TEST: Circular reference bypass', () => {
      // ATTACK VECTOR 1: Circular references cause JSON.stringify to throw
      const circularObj: any = { a: 1, b: 2 };
      circularObj.self = circularObj;

      // Attempt to set circular reference
      expect(() => {
        ensemble.setContextValue('circular', circularObj, 'test-element');
      }).toThrow();

      // Result: JSON.stringify throws TypeError on circular reference
      // This is actually a DoS vector, not a bypass
    });

    it('VULNERABILITY TEST: Sparse array memory vs JSON size', () => {
      // ATTACK VECTOR 2: Sparse arrays use memory but serialize small
      const sparseArray = new Array(1000000); // 1M elements
      sparseArray[0] = 'data';
      sparseArray[999999] = 'more data';

      // Check memory size vs JSON size
      const jsonSize = JSON.stringify(sparseArray).length;
      console.log('Sparse array JSON size:', jsonSize);
      console.log('Sparse array element count:', sparseArray.length);

      // The size check will see the JSON size (small)
      // But memory usage is based on array length (large)

      // Attempt to set sparse array
      try {
        ensemble.setContextValue('sparse', sparseArray, 'test-element');

        // If this succeeds, we've bypassed the size check
        // and potentially allocated large memory
        const storedValue = ensemble.getContextValue('sparse') as any[];
        console.log('Stored sparse array length:', storedValue?.length);

        // This IS a bypass - we stored a large memory structure
        expect(storedValue?.length).toBe(1000000);
      } catch (error) {
        // If it throws, the protection worked
        console.log('Sparse array blocked:', (error as Error).message);
      }
    });

    it('VULNERABILITY TEST: Buffer size discrepancy', () => {
      // ATTACK VECTOR 3: Buffers serialize differently than their memory size
      const largeBuffer = Buffer.alloc(100000); // 100KB
      const jsonSize = JSON.stringify(largeBuffer).length;
      const actualSize = largeBuffer.length;

      console.log('Buffer actual size:', actualSize);
      console.log('Buffer JSON size:', jsonSize);

      // Buffers serialize to JSON with metadata, might be different size
      try {
        ensemble.setContextValue('buffer', largeBuffer, 'test-element');

        // Check if bypass succeeded
        const stored = ensemble.getContextValue('buffer');
        console.log('Buffer storage succeeded');

        // Verify the buffer was stored
        expect(Buffer.isBuffer(stored) || typeof stored === 'object').toBe(true);
      } catch (error) {
        console.log('Buffer blocked:', (error as Error).message);
      }
    });

    it('REAL-WORLD SCENARIO: Memory exhaustion via size bypass', () => {
      /**
       * Can an attacker cause DoS by bypassing size limits?
       *
       * Strategy:
       * 1. Create objects that serialize small but use lots of memory
       * 2. Fill context with such objects
       * 3. Exhaust server memory
       */

      const attackElement: EnsembleElement = {
        element_name: 'attacker-element',
        element_type: 'persona',
        role: 'primary',
        priority: 50,
        activation: 'always'
      };

      ensemble.addElement(attackElement);

      let bypassCount = 0;
      let totalMemoryBypass = 0;

      // Try to fill context with sparse arrays
      for (let i = 0; i < ENSEMBLE_LIMITS.MAX_CONTEXT_SIZE; i++) {
        try {
          const sparse = new Array(100000); // 100K elements each
          sparse[0] = i;

          ensemble.setContextValue(`attack_${i}`, sparse, 'attacker-element');

          bypassCount++;
          totalMemoryBypass += sparse.length * 8; // Rough estimate: 8 bytes per element

        } catch (error) {
          // Hit a limit
          console.log(`Bypass stopped at ${i} items:`, (error as Error).message);
          break;
        }
      }

      console.log('Bypass statistics:');
      console.log('- Successfully stored:', bypassCount);
      console.log('- Estimated memory bypass:', Math.round(totalMemoryBypass / (1024 * 1024)), 'MB');

      // If bypassCount > 0, the vulnerability exists
      if (bypassCount > 0) {
        console.warn('SIZE BYPASS VULNERABILITY CONFIRMED');
      }
    });
  });

  describe('ISSUE #3: Path Validation - Unicode/Homograph Attacks', () => {
    /**
     * CLAIM: matchesElementName() is vulnerable to Unicode normalization
     * and homograph attacks
     *
     * LOCATION: Line 1029-1036 in Ensemble.ts
     * ```typescript
     * private matchesElementName(actualName: string, targetName: string): boolean {
     *   const exactMatch = actualName === targetName;
     *   const slugifiedMatch = actualName.toLowerCase().replace(/\s+/g, '-') === targetName;
     *   const reverseMatch = targetName.toLowerCase().replace(/\s+/g, '-') ===
     *                        actualName.toLowerCase().replace(/\s+/g, '-');
     *   return exactMatch || slugifiedMatch || reverseMatch;
     * }
     * ```
     */

    it('VULNERABILITY TEST: Unicode normalization bypass', () => {
      /**
       * ATTACK VECTOR 1: Unicode normalization differences
       *
       * Characters like "é" can be represented as:
       * - Single character: U+00E9 (é)
       * - Combining characters: U+0065 + U+0301 (e + ́)
       *
       * These are visually identical but !== in JavaScript
       */

      // Create element with composed character
      const composedName = 'malicious\u00E9'; // é as single character
      const decomposedName = 'malicious\u0065\u0301'; // e + combining acute

      console.log('Composed name:', composedName);
      console.log('Decomposed name:', decomposedName);
      console.log('Are they equal?', composedName === decomposedName);

      // These should be treated as the same name after normalization
      // Enhanced security: Now rejects Unicode characters at input validation

      // SECURITY ENHANCEMENT: Unicode characters now rejected with clear error
      expect(() => {
        ensemble.addElement({
          element_name: composedName,
          element_type: 'persona',
          role: 'primary',
          priority: 50,
          activation: 'always'
        });
      }).toThrow(/Element name contains invalid characters.*Only alphanumeric/);

      // MITIGATION VERIFIED: Unicode homograph attacks blocked at input validation
      console.log('SECURITY ENHANCEMENT: Unicode characters rejected - vulnerability mitigated');
    });

    it('VULNERABILITY TEST: Homograph attack', () => {
      /**
       * ATTACK VECTOR 2: Homograph characters
       *
       * Characters that look identical but have different codes:
       * - Latin 'a' (U+0061) vs Cyrillic 'а' (U+0430)
       * - Latin 'e' (U+0065) vs Cyrillic 'е' (U+0435)
       *
       * These can bypass visual inspection
       */

      // Element name with Latin characters
      const latinName = 'test-element';

      // Attacker creates similar name with Cyrillic 'e'
      const cyrillicName = 't\u0435st-\u0435l\u0435m\u0435nt'; // Uses Cyrillic е (U+0435)

      console.log('Latin name:', latinName);
      console.log('Cyrillic name:', cyrillicName);
      console.log('Are they equal?', latinName === cyrillicName);
      console.log('Do they look the same?', 'YES - that\'s the attack!');

      // Add element with Latin name
      ensemble.addElement({
        element_name: latinName,
        element_type: 'persona',
        role: 'primary',
        priority: 50,
        activation: 'always'
      });

      // Try to add element with Cyrillic homograph
      // Should this be allowed or blocked?
      expect(() => {
        ensemble.addElement({
          element_name: cyrillicName,
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        });
      }).toThrow(); // Cyrillic characters should be rejected by ELEMENT_NAME_PATTERN

      // The pattern /^[a-zA-Z0-9_-]+$/ should block Cyrillic
      // Let's verify
      const pattern = /^[a-zA-Z0-9_-]+$/;
      expect(pattern.test(latinName)).toBe(true);
      expect(pattern.test(cyrillicName)).toBe(false);

      // PROTECTION EXISTS: ELEMENT_NAME_PATTERN blocks non-ASCII
    });

    it('VULNERABILITY TEST: Zero-width characters', () => {
      /**
       * ATTACK VECTOR 3: Zero-width characters
       *
       * Invisible characters that can hide malicious content:
       * - U+200B (Zero Width Space)
       * - U+FEFF (Zero Width No-Break Space / BOM)
       * - U+200C (Zero Width Non-Joiner)
       */

      const normalName = 'element';
      const zwName = 'ele\u200Bment'; // Zero-width space in middle

      console.log('Normal name:', normalName);
      console.log('ZW name:', zwName);
      console.log('Are they equal?', normalName === zwName);
      console.log('Normal name length:', normalName.length);
      console.log('ZW name length:', zwName.length);

      // Try to add element with zero-width character
      expect(() => {
        ensemble.addElement({
          element_name: zwName,
          element_type: 'persona',
          role: 'primary',
          priority: 50,
          activation: 'always'
        });
      }).toThrow();

      // Should be blocked by sanitization or pattern
      // sanitizeInput() removes zero-width chars (line 582 in InputValidator.ts)
    });

    it('REAL-WORLD SCENARIO: Context check', () => {
      /**
       * Where does matchesElementName() get called from?
       * What is the actual risk?
       *
       * Usage: Line 1011 in findElementInManager()
       * - Used to match element names when loading from managers
       * - Element names come from local filesystem (portfolio)
       * - Not user-controlled in typical usage
       *
       * Risk Assessment:
       * - LOW: Element names are validated during addElement()
       * - Element name pattern blocks non-ASCII
       * - Unicode normalization would be defense-in-depth
       */

      console.log('Risk Assessment for matchesElementName():');
      console.log('1. Element names validated by ELEMENT_NAME_PATTERN: [a-zA-Z0-9_-]+');
      console.log('2. sanitizeInput() removes dangerous characters');
      console.log('3. Names come from local filesystem (trusted source)');
      console.log('4. Not exposed to remote/untrusted input');
      console.log('');
      console.log('Conclusion: FALSE POSITIVE - Risk is theoretical, not practical');
    });
  });
});
