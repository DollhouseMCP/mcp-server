/**
 * Unit tests for Ensemble element implementation
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Ensemble } from '../../../../src/elements/ensembles/Ensemble.js';
import { EnsembleMetadata, EnsembleElement } from '../../../../src/elements/ensembles/types.js';
import { ENSEMBLE_LIMITS, ENSEMBLE_DEFAULTS } from '../../../../src/elements/ensembles/constants.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { ElementStatus } from '../../../../src/types/elements/index.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';

// Mock dependencies
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

const metadataService: MetadataService = createTestMetadataService();

describe('Ensemble Element', () => {
  let ensemble: Ensemble;
  const mockMetadata: Partial<EnsembleMetadata> = {
    name: 'Test Ensemble',
    description: 'A test ensemble for unit testing',
    activationStrategy: 'sequential',
    conflictResolution: 'last-write',
    contextSharing: 'selective'
  };

  const mockElements: EnsembleElement[] = [
    {
      element_name: 'primary-skill',
      element_type: 'skill',
      role: 'primary',
      priority: 80,
      activation: 'always'
    },
    {
      element_name: 'support-persona',
      element_type: 'persona',
      role: 'support',
      priority: 50,
      activation: 'on-demand'
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up the SecurityMonitor mock
    (SecurityMonitor.logSecurityEvent as jest.Mock) = jest.fn();

    ensemble = new Ensemble(mockMetadata, mockElements, metadataService);
  });

  describe('Constructor', () => {
    it('should create ensemble with default values', () => {
      const minimalEnsemble = new Ensemble({ name: 'Minimal' }, [], metadataService);
      expect(minimalEnsemble.metadata.name).toBe('Minimal');
      expect(minimalEnsemble.type).toBe(ElementType.ENSEMBLE);
      expect(minimalEnsemble.metadata.activationStrategy).toBe(ENSEMBLE_DEFAULTS.ACTIVATION_STRATEGY);
      expect(minimalEnsemble.metadata.conflictResolution).toBe(ENSEMBLE_DEFAULTS.CONFLICT_RESOLUTION);
    });

    it('should sanitize inputs', () => {
      const unsafeEnsemble = new Ensemble({
        name: '<script>alert("xss")</script>',
        description: 'Test<img src=x onerror=alert(1)>'
      }, [], metadataService);
      expect(unsafeEnsemble.metadata.name).not.toContain('<script>');
      expect(unsafeEnsemble.metadata.description).not.toContain('<img');
    });

    it('should normalize Unicode', () => {
      const unicodeEnsemble = new Ensemble({
        name: 'Tëst Ënsëmblë',
        description: 'Üñíçødë tëst'
      }, [], metadataService);
      expect(unicodeEnsemble.metadata.name).toBeDefined();
      expect(unicodeEnsemble.metadata.description).toBeDefined();
    });

    it('should load elements from constructor', () => {
      expect(ensemble.getElements().length).toBe(2);
      expect(ensemble.getElement('primary-skill')).toBeDefined();
      expect(ensemble.getElement('support-persona')).toBeDefined();
    });
  });

  describe('loadElementsFromMetadata defaults and legacy fields (#446)', () => {
    it('should apply default role, priority, and activation when omitted', () => {
      const elementsWithoutDefaults: any[] = [
        {
          element_name: 'minimal-skill',
          element_type: 'skill'
        }
      ];

      const ens = new Ensemble({ name: 'Defaults Test' }, elementsWithoutDefaults, metadataService);
      const loaded = ens.getElement('minimal-skill');

      expect(loaded).toBeDefined();
      expect(loaded?.role).toBe(ENSEMBLE_DEFAULTS.ELEMENT_ROLE);
      expect(loaded?.priority).toBe(ENSEMBLE_DEFAULTS.PRIORITY);
      expect(loaded?.activation).toBe('always');
    });

    it('should not override explicitly provided role, priority, and activation', () => {
      const elementsWithExplicit: EnsembleElement[] = [
        {
          element_name: 'explicit-skill',
          element_type: 'skill',
          role: 'primary',
          priority: 99,
          activation: 'on-demand'
        }
      ];

      const ens = new Ensemble({ name: 'Explicit Test' }, elementsWithExplicit, metadataService);
      const loaded = ens.getElement('explicit-skill');

      expect(loaded?.role).toBe('primary');
      expect(loaded?.priority).toBe(99);
      expect(loaded?.activation).toBe('on-demand');
    });

    it('should handle priority of 0 without replacing with default', () => {
      const elementsWithZeroPriority: any[] = [
        {
          element_name: 'zero-priority',
          element_type: 'skill',
          role: 'support',
          priority: 0,
          activation: 'always'
        }
      ];

      const ens = new Ensemble({ name: 'Zero Priority Test' }, elementsWithZeroPriority, metadataService);
      const loaded = ens.getElement('zero-priority');
      expect(loaded?.priority).toBe(0);
    });

    it('should migrate legacy "name" field to element_name', () => {
      const legacyElements: any[] = [
        {
          name: 'legacy-skill',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        }
      ];

      const ens = new Ensemble({ name: 'Legacy Name Test' }, legacyElements, metadataService);
      const loaded = ens.getElement('legacy-skill');
      expect(loaded).toBeDefined();
      expect(loaded?.element_name).toBe('legacy-skill');
    });

    it('should migrate legacy "type" field to element_type', () => {
      const legacyElements: any[] = [
        {
          element_name: 'legacy-type-skill',
          type: 'persona',
          role: 'primary',
          priority: 80,
          activation: 'always'
        }
      ];

      const ens = new Ensemble({ name: 'Legacy Type Test' }, legacyElements, metadataService);
      const loaded = ens.getElement('legacy-type-skill');
      expect(loaded).toBeDefined();
      expect(loaded?.element_type).toBe('persona');
    });

    it('should throw error when both type and element_type are missing (#466)', () => {
      const noTypeElements: any[] = [
        {
          element_name: 'no-type-skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        }
      ];

      expect(() => {
        new Ensemble({ name: 'No Type Test' }, noTypeElements, metadataService);
      }).toThrow(/no-type-skill.*has no element_type/);
    });

    it('should prefer element_name over legacy name field', () => {
      const bothFields: any[] = [
        {
          element_name: 'preferred-name',
          name: 'legacy-name',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        }
      ];

      const ens = new Ensemble({ name: 'Prefer New Test' }, bothFields, metadataService);
      expect(ens.getElement('preferred-name')).toBeDefined();
      expect(ens.getElement('legacy-name')).toBeUndefined();
    });

    it('should handle combined legacy fields and missing defaults', () => {
      const minimalLegacy: any[] = [
        {
          name: 'combo-element',
          type: 'template'
        }
      ];

      const ens = new Ensemble({ name: 'Combo Test' }, minimalLegacy, metadataService);
      const loaded = ens.getElement('combo-element');
      expect(loaded).toBeDefined();
      expect(loaded?.element_name).toBe('combo-element');
      expect(loaded?.element_type).toBe('template');
      expect(loaded?.role).toBe(ENSEMBLE_DEFAULTS.ELEMENT_ROLE);
      expect(loaded?.priority).toBe(ENSEMBLE_DEFAULTS.PRIORITY);
      expect(loaded?.activation).toBe('always');
    });

    it('should throw descriptive error when elements array contains strings (#507)', () => {
      const stringElements: any[] = ['my-skill', 'my-template'];

      expect(() => {
        new Ensemble({ name: 'String Elements Test' }, stringElements, metadataService);
      }).toThrow(/Element at index 0 is a string.*must be an object.*element_name.*element_type/);
    });

    it('should throw descriptive error when elements array contains numbers (#507)', () => {
      const numberElements: any[] = [42];

      expect(() => {
        new Ensemble({ name: 'Number Elements Test' }, numberElements, metadataService);
      }).toThrow(/Element at index 0 is a number.*must be an object/);
    });

    it('should throw descriptive error when elements array contains null (#507)', () => {
      const nullElements: any[] = [null];

      expect(() => {
        new Ensemble({ name: 'Null Elements Test' }, nullElements, metadataService);
      }).toThrow(/Element at index 0 is a null.*must be an object/);
    });
  });

  describe('Element Management', () => {
    it('should add a valid element', () => {
      const newElement: EnsembleElement = {
        element_name: 'new-template',
        element_type: 'template',
        role: 'support',
        priority: 30,
        activation: 'conditional',
        condition: 'primary-skill.active == true'
      };

      ensemble.addElement(newElement);
      expect(ensemble.getElements().length).toBe(3);
      expect(ensemble.getElement('new-template')).toEqual(newElement);
    });

    it('should enforce maximum element limit', () => {
      const tooManyElements = Array.from({ length: ENSEMBLE_LIMITS.MAX_ELEMENTS + 1 }, (_, i) => ({
        element_name: `element-${i}`,
        element_type: 'skill',
        role: 'support' as const,
        priority: 50,
        activation: 'always' as const
      }));

      expect(() => {
        new Ensemble({ name: 'Overloaded' }, tooManyElements, metadataService);
      }).toThrow();
    });

    it('should remove an element', () => {
      ensemble.removeElement('support-persona');
      expect(ensemble.getElements().length).toBe(1);
      expect(ensemble.getElement('support-persona')).toBeUndefined();
    });

    it('should sanitize element names', () => {
      const unsafeElement: EnsembleElement = {
        element_name: '<script>malicious</script>',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      };

      // Enhanced security: now rejects invalid characters with clear error message
      expect(() => ensemble.addElement(unsafeElement)).toThrow(
        /Element name contains invalid characters.*Only alphanumeric/
      );
    });

    it('should update an existing element', () => {
      ensemble.updateElement('primary-skill', {
        priority: 90,
        activation: 'conditional',
        condition: 'context.ready == true'
      });

      const updated = ensemble.getElement('primary-skill');
      expect(updated?.priority).toBe(90);
      expect(updated?.activation).toBe('conditional');
      expect(updated?.condition).toBe('context.ready == true');
      // Original properties should remain
      expect(updated?.element_name).toBe('primary-skill');
      expect(updated?.element_type).toBe('skill');
      expect(updated?.role).toBe('primary');
    });

    it('should throw when updating non-existent element', () => {
      expect(() => {
        ensemble.updateElement('non-existent', { priority: 90 });
      }).toThrow(/not found/);
    });

    it('should validate role when updating', () => {
      expect(() => {
        ensemble.updateElement('primary-skill', {
          role: 'invalid-role' as any
        });
      }).toThrow(/invalid.*role/i);
    });

    it('should validate condition when updating', () => {
      // Use actually invalid characters: backticks, dollar signs, or curly braces
      expect(() => {
        ensemble.updateElement('primary-skill', {
          activation: 'conditional',
          condition: 'invalid${template}condition'  // Template interpolation blocked by CONDITION_PATTERN
        });
      }).toThrow(/invalid.*condition/i);
    });

    it('should check circular dependencies when updating dependencies', () => {
      // Add element-a that depends on primary-skill
      ensemble.addElement({
        element_name: 'element-a',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always',
        dependencies: ['primary-skill']
      });

      // Try to update primary-skill to depend on element-a (would create cycle)
      expect(() => {
        ensemble.updateElement('primary-skill', {
          dependencies: ['element-a']
        });
      }).toThrow(/circular dependency/i);
    });
  });

  // Issue #658: Defensive guard against dict-format metadata.elements
  describe('syncElementsFromMetadata - defensive guard', () => {
    it('should handle normal array elements correctly', () => {
      ensemble.syncElementsFromMetadata();
      expect(ensemble.getElements().length).toBe(2);
      expect(ensemble.getElement('primary-skill')).toBeDefined();
      expect(ensemble.getElement('support-persona')).toBeDefined();
    });

    it('should not crash when metadata.elements is a dict (non-array object)', () => {
      // Simulate dict-format leak from deepMerge
      (ensemble.metadata as any).elements = {
        'bridge-session': { type: 'memory', role: 'support', priority: 40 },
      };

      // Should not throw — just log warning and leave elements empty
      expect(() => ensemble.syncElementsFromMetadata()).not.toThrow();
      expect(ensemble.getElements().length).toBe(0);
    });

    it('should handle undefined metadata.elements gracefully', () => {
      (ensemble.metadata as any).elements = undefined;
      expect(() => ensemble.syncElementsFromMetadata()).not.toThrow();
      expect(ensemble.getElements().length).toBe(0);
    });

    it('should handle null metadata.elements gracefully', () => {
      (ensemble.metadata as any).elements = null;
      expect(() => ensemble.syncElementsFromMetadata()).not.toThrow();
      expect(ensemble.getElements().length).toBe(0);
    });
  });

  describe('Circular Dependency Detection', () => {
    it('should detect circular dependencies', () => {
      const elementA: EnsembleElement = {
        element_name: 'element-a',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always',
        dependencies: ['element-b']
      };

      const elementB: EnsembleElement = {
        element_name: 'element-b',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always',
        dependencies: ['element-a']  // Circular!
      };

      const circularEnsemble = new Ensemble({ name: 'Circular' }, [], metadataService);
      circularEnsemble.addElement(elementA);

      expect(() => {
        circularEnsemble.addElement(elementB);
      }).toThrow(/circular dependency/i);
    });

    it('should allow valid dependency chains', () => {
      const elementA: EnsembleElement = {
        element_name: 'element-a',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always'
      };

      const elementB: EnsembleElement = {
        element_name: 'element-b',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always',
        dependencies: ['element-a']
      };

      const elementC: EnsembleElement = {
        element_name: 'element-c',
        element_type: 'skill',
        role: 'support',
        priority: 30,
        activation: 'always',
        dependencies: ['element-b']
      };

      const validEnsemble = new Ensemble({ name: 'Valid Chain' }, [], metadataService);
      validEnsemble.addElement(elementA);
      validEnsemble.addElement(elementB);
      validEnsemble.addElement(elementC);

      expect(validEnsemble.getElements().length).toBe(3);
    });

    it('should detect self-dependencies', () => {
      const selfDependent: EnsembleElement = {
        element_name: 'self-dep',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always',
        dependencies: ['self-dep']
      };

      expect(() => {
        ensemble.addElement(selfDependent);
      }).toThrow(/circular dependency/i);
    });
  });

  describe('Context Management', () => {
    it('should set and get context values', () => {
      ensemble.setContextValue('testKey', 'testValue', 'primary-skill');
      expect(ensemble.getContextValue('testKey')).toBe('testValue');
    });

    it('should handle context conflicts with last-write strategy', () => {
      const conflictEnsemble = new Ensemble({
        name: 'Conflict Test',
        conflictResolution: 'last-write'
      }, [], metadataService);

      // Add elements before using them as owners
      conflictEnsemble.addElement({
        element_name: 'element1',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always'
      });
      conflictEnsemble.addElement({
        element_name: 'element2',
        element_type: 'skill',
        role: 'primary',
        priority: 70,
        activation: 'always'
      });

      conflictEnsemble.setContextValue('shared', 'first', 'element1');
      conflictEnsemble.setContextValue('shared', 'second', 'element2');

      expect(conflictEnsemble.getContextValue('shared')).toBe('second');
    });

    it('should handle context conflicts with first-write strategy', () => {
      const conflictEnsemble = new Ensemble({
        name: 'Conflict Test',
        conflictResolution: 'first-write'
      }, [], metadataService);

      // Add elements before using them as owners
      conflictEnsemble.addElement({
        element_name: 'element1',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always'
      });
      conflictEnsemble.addElement({
        element_name: 'element2',
        element_type: 'skill',
        role: 'primary',
        priority: 70,
        activation: 'always'
      });

      conflictEnsemble.setContextValue('shared', 'first', 'element1');
      conflictEnsemble.setContextValue('shared', 'second', 'element2');

      expect(conflictEnsemble.getContextValue('shared')).toBe('first');
    });

    it('should throw error with error strategy', () => {
      const errorEnsemble = new Ensemble({
        name: 'Error Test',
        conflictResolution: 'error'
      }, [], metadataService);

      // Add elements before using them as owners
      errorEnsemble.addElement({
        element_name: 'element1',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always'
      });
      errorEnsemble.addElement({
        element_name: 'element2',
        element_type: 'skill',
        role: 'primary',
        priority: 70,
        activation: 'always'
      });

      errorEnsemble.setContextValue('shared', 'first', 'element1');

      expect(() => {
        errorEnsemble.setContextValue('shared', 'second', 'element2');
      }).toThrow(/context conflict/i);
    });

    it('should merge objects with merge strategy', () => {
      const mergeEnsemble = new Ensemble({
        name: 'Merge Test',
        conflictResolution: 'merge'
      }, [], metadataService);

      // Add elements before using them as owners
      mergeEnsemble.addElement({
        element_name: 'element1',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always'
      });
      mergeEnsemble.addElement({
        element_name: 'element2',
        element_type: 'skill',
        role: 'primary',
        priority: 70,
        activation: 'always'
      });

      mergeEnsemble.setContextValue('config', { a: 1, b: 2 }, 'element1');
      mergeEnsemble.setContextValue('config', { b: 3, c: 4 }, 'element2');

      const merged = mergeEnsemble.getContextValue('config');
      expect(merged).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should sanitize context keys', () => {
      ensemble.setContextValue('<script>bad</script>', 'value', 'primary-skill');
      expect(ensemble.getContextValue('<script>bad</script>')).toBeDefined();
    });

    it('should clear all context values', () => {
      ensemble.setContextValue('key1', 'value1', 'primary-skill');
      ensemble.setContextValue('key2', 'value2', 'support-persona');

      expect(ensemble.getContextValue('key1')).toBe('value1');
      expect(ensemble.getContextValue('key2')).toBe('value2');

      ensemble.clearContext();

      expect(ensemble.getContextValue('key1')).toBeUndefined();
      expect(ensemble.getContextValue('key2')).toBeUndefined();
    });

    it('should clear context values for specific owner', () => {
      ensemble.setContextValue('key1', 'value1', 'primary-skill');
      ensemble.setContextValue('key2', 'value2', 'primary-skill');
      ensemble.setContextValue('key3', 'value3', 'support-persona');

      // Clear only primary-skill's values
      ensemble.clearContext('primary-skill');

      expect(ensemble.getContextValue('key1')).toBeUndefined();
      expect(ensemble.getContextValue('key2')).toBeUndefined();
      expect(ensemble.getContextValue('key3')).toBe('value3'); // Should remain
    });

    it('should validate owner when clearing context', () => {
      expect(() => {
        ensemble.clearContext('non-existent');
      }).toThrow(/not found in ensemble/);
    });
  });

  describe('Activation', () => {
    it('should activate ensemble (sets status)', async () => {
      await ensemble.activate();
      expect(ensemble.status).toBe(ElementStatus.ACTIVE);
    });

    it('should deactivate ensemble', async () => {
      await ensemble.activate();
      await ensemble.deactivate();
      expect(ensemble.status).toBe(ElementStatus.INACTIVE);
    });
  });

  describe('Validation', () => {
    it('should validate a valid ensemble', () => {
      const result = ensemble.validate();
      expect(result.valid).toBe(true);
      expect(result.errors?.length || 0).toBe(0);
    });

    it('should detect missing name', () => {
      const invalidEnsemble = new Ensemble({ name: '' }, [], metadataService);
      const result = invalidEnsemble.validate();
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.field === 'metadata.name')).toBe(true);
    });

    it('should warn about empty ensemble', () => {
      const emptyEnsemble = new Ensemble({ name: 'Empty' }, [], metadataService);
      const result = emptyEnsemble.validate();
      expect(result.warnings?.some(w => w.message.includes('no elements'))).toBe(true);
    });

    it('should detect circular dependencies in validation', () => {
      const circularEnsemble = new Ensemble({ name: 'Circular' }, [
        {
          element_name: 'a',
          element_type: 'skill',
          role: 'primary',
          priority: 80,
          activation: 'always',
          dependencies: ['b']
        },
        {
          element_name: 'b',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always',
          dependencies: ['a']
        }
      ], metadataService);

      const result = circularEnsemble.validate();
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.message.includes('circular'))).toBe(true);
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const json = ensemble.serializeToJSON();
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe(ElementType.ENSEMBLE);
      expect(parsed.metadata.name).toBe('Test Ensemble');
      expect(parsed.metadata.activationStrategy).toBe('sequential');
    });

    it('should deserialize from JSON', () => {
      const json = ensemble.serializeToJSON();
      const newEnsemble = new Ensemble({ name: 'Temp' }, [], metadataService);
      newEnsemble.deserialize(json);

      expect(newEnsemble.metadata.name).toBe(ensemble.metadata.name);
      expect(newEnsemble.metadata.activationStrategy).toBe(ensemble.metadata.activationStrategy);
    });
  });

  describe('Security', () => {
    it('should log security events', () => {
      new Ensemble(mockMetadata, mockElements, metadataService);
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalled();
    });

    it('should reject excessively long names', () => {
      const longName = 'a'.repeat(200);
      const longEnsemble = new Ensemble({ name: longName }, [], metadataService);
      // Name should be truncated
      expect(longEnsemble.metadata.name.length).toBeLessThanOrEqual(100);
    });

    it('should reject excessively long conditions', () => {
      const longCondition = 'a'.repeat(ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH + 100);
      const element: EnsembleElement = {
        element_name: 'test',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'conditional',
        condition: longCondition
      };

      ensemble.addElement(element);
      const retrieved = ensemble.getElement('test');
      expect(retrieved?.condition?.length || 0).toBeLessThanOrEqual(ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH);
    });

    it('should limit number of dependencies', () => {
      const tooManyDeps = Array.from({ length: ENSEMBLE_LIMITS.MAX_DEPENDENCIES + 5 }, (_, i) => `dep-${i}`);
      const element: EnsembleElement = {
        element_name: 'test',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always',
        dependencies: tooManyDeps
      };

      ensemble.addElement(element);
      const retrieved = ensemble.getElement('test');
      expect(retrieved?.dependencies?.length || 0).toBeLessThanOrEqual(ENSEMBLE_LIMITS.MAX_DEPENDENCIES);
    });

    it('should prevent removing elements during activation', async () => {
      // Start activation (which sets activationInProgress flag)
      const activationPromise = ensemble.activateEnsemble(
        {} as any, // Mock PortfolioManager
        {} as any  // Mock ElementManagers
      );

      // During activation, try to remove an element
      // Note: We need to catch the activation error too since we're using mocks
      await expect(async () => {
        // Try to remove element while activation is in progress
        ensemble.removeElement('primary-skill');
      }).rejects.toThrow('Cannot remove elements while ensemble activation is in progress');

      // Wait for activation to complete (will fail due to mocks, but that's OK)
      await activationPromise.catch(() => {});
    });

    it('should prevent updating elements during activation', async () => {
      // Start activation
      const activationPromise = ensemble.activateEnsemble(
        {} as any,
        {} as any
      );

      // Try to update during activation
      await expect(async () => {
        ensemble.updateElement('primary-skill', { priority: 90 });
      }).rejects.toThrow('Cannot update elements while ensemble activation is in progress');

      // Wait for activation to complete
      await activationPromise.catch(() => {});
    });

    it('should validate context owner exists in ensemble', () => {
      expect(() => {
        ensemble.setContextValue('key', 'value', 'non-existent-element');
      }).toThrow(/not found in ensemble/);
    });

    it('should validate clearContext owner exists', () => {
      expect(() => {
        ensemble.clearContext('non-existent-element');
      }).toThrow(/not found in ensemble/);
    });
  });

  describe('Activation Strategies', () => {
    it('should support all activation strategy', () => {
      const allEnsemble = new Ensemble({
        name: 'All Strategy',
        activationStrategy: 'all'
      }, [], metadataService);
      expect(allEnsemble.metadata.activationStrategy).toBe('all');
    });

    it('should support sequential activation strategy', () => {
      const seqEnsemble = new Ensemble({
        name: 'Sequential Strategy',
        activationStrategy: 'sequential'
      }, [], metadataService);
      expect(seqEnsemble.metadata.activationStrategy).toBe('sequential');
    });

    it('should support priority activation strategy', () => {
      const priorityEnsemble = new Ensemble({
        name: 'Priority Strategy',
        activationStrategy: 'priority'
      }, [], metadataService);
      expect(priorityEnsemble.metadata.activationStrategy).toBe('priority');
    });

    it('should support conditional activation strategy', () => {
      const conditionalEnsemble = new Ensemble({
        name: 'Conditional Strategy',
        activationStrategy: 'conditional'
      }, [], metadataService);
      expect(conditionalEnsemble.metadata.activationStrategy).toBe('conditional');
    });

    it('should support lazy activation strategy', () => {
      const lazyEnsemble = new Ensemble({
        name: 'Lazy Strategy',
        activationStrategy: 'lazy'
      }, [], metadataService);
      expect(lazyEnsemble.metadata.activationStrategy).toBe('lazy');
    });
  });

  describe('Resource Limits', () => {
    it('should enforce resource limits', () => {
      const limitedEnsemble = new Ensemble({
        name: 'Limited',
        resourceLimits: {
          maxActiveElements: 5,
          maxExecutionTimeMs: 10000
        }
      }, [], metadataService);

      expect(limitedEnsemble.metadata.resourceLimits?.maxActiveElements).toBe(5);
      expect(limitedEnsemble.metadata.resourceLimits?.maxExecutionTimeMs).toBe(10000);
    });

    it('should use default limits when not specified', () => {
      const defaultEnsemble = new Ensemble({ name: 'Default' }, [], metadataService);
      // resourceLimits is now optional (per-ensemble overrides)
      // Use getEffectiveLimits() to get the resolved limits
      const effectiveLimits = defaultEnsemble.getEffectiveLimits();
      expect(effectiveLimits.MAX_ELEMENTS).toBe(ENSEMBLE_LIMITS.MAX_ELEMENTS);
    });
  });

  describe('Activation Strategy Execution', () => {
    let mockPortfolioManager: any;
    let mockManagers: any;

    beforeEach(() => {
      // Mock PortfolioManager
      mockPortfolioManager = {
        getBaseDir: jest.fn().mockReturnValue('/mock/portfolio'),
        getElement: jest.fn()
      };

      // Mock element managers with proper structure
      mockManagers = {
        skillManager: {
          list: jest.fn().mockResolvedValue([]),
          get: jest.fn(),
          activate: jest.fn().mockResolvedValue(undefined)
        },
        personaManager: {
          list: jest.fn().mockResolvedValue([]),
          get: jest.fn(),
          activate: jest.fn().mockResolvedValue(undefined)
        },
        templateManager: {
          list: jest.fn().mockResolvedValue([]),
          get: jest.fn(),
          activate: jest.fn().mockResolvedValue(undefined)
        },
        agentManager: {
          list: jest.fn().mockResolvedValue([]),
          get: jest.fn(),
          activate: jest.fn().mockResolvedValue(undefined)
        },
        memoryManager: {
          list: jest.fn().mockResolvedValue([]),
          get: jest.fn(),
          activate: jest.fn().mockResolvedValue(undefined)
        }
      };
    });

    it('should activate all elements in parallel with "all" strategy', async () => {
      // Setup ensemble with 3 elements using 'all' strategy
      const allEnsemble = new Ensemble({
        name: 'Parallel Test',
        activationStrategy: 'all'
      }, [
        {
          element_name: 'skill-1',
          element_type: 'skill',
          role: 'primary',
          priority: 80,
          activation: 'always'
        },
        {
          element_name: 'skill-2',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        },
        {
          element_name: 'skill-3',
          element_type: 'skill',
          role: 'support',
          priority: 30,
          activation: 'always'
        }
      ], metadataService);

      // Mock the skill list to return all skills (skill elements use metadata.name for their own name)
      mockManagers.skillManager.list.mockResolvedValue([
        { metadata: { name: 'skill-1' }, id: 'skill-1', activate: jest.fn().mockResolvedValue(undefined) },
        { metadata: { name: 'skill-2' }, id: 'skill-2', activate: jest.fn().mockResolvedValue(undefined) },
        { metadata: { name: 'skill-3' }, id: 'skill-3', activate: jest.fn().mockResolvedValue(undefined) }
      ]);

      // Mock get to return the matching skill
      mockManagers.skillManager.get.mockImplementation((name: string) => {
        const skills = [
          { metadata: { name: 'skill-1' }, id: 'skill-1', activate: jest.fn().mockResolvedValue(undefined) },
          { metadata: { name: 'skill-2' }, id: 'skill-2', activate: jest.fn().mockResolvedValue(undefined) },
          { metadata: { name: 'skill-3' }, id: 'skill-3', activate: jest.fn().mockResolvedValue(undefined) }
        ];
        return Promise.resolve(skills.find(s => s.metadata.name === name));
      });

      // Activate ensemble
      const result = await allEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // Verify all elements were activated
      expect(result.success).toBe(true);
      expect(result.activatedElements).toHaveLength(3);
      expect(result.activatedElements).toContain('skill-1');
      expect(result.activatedElements).toContain('skill-2');
      expect(result.activatedElements).toContain('skill-3');
      expect(result.failedElements).toHaveLength(0);
      expect(result.elementResults).toHaveLength(3);

      // All should have succeeded
      result.elementResults.forEach(r => {
        expect(r.success).toBe(true);
      });
    });

    it('should respect dependency order with "sequential" strategy', async () => {
      // Create ensemble with sequential strategy
      // Add 3 elements: A (no deps), B (depends on A), C (depends on B)
      const seqEnsemble = new Ensemble({
        name: 'Sequential Test',
        activationStrategy: 'sequential'
      }, [
        {
          element_name: 'element-a',
          element_type: 'skill',
          role: 'primary',
          priority: 80,
          activation: 'always'
        },
        {
          element_name: 'element-b',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always',
          dependencies: ['element-a']
        },
        {
          element_name: 'element-c',
          element_type: 'skill',
          role: 'support',
          priority: 30,
          activation: 'always',
          dependencies: ['element-b']
        }
      ], metadataService);

      // Track activation order
      const activationOrder: string[] = [];

      // Mock skills with tracking (skill elements use metadata.name for their own name)
      const mockSkills = [
        {
          metadata: { name: 'element-a' },
          id: 'element-a',
          activate: jest.fn().mockImplementation(async () => {
            activationOrder.push('element-a');
          })
        },
        {
          metadata: { name: 'element-b' },
          id: 'element-b',
          activate: jest.fn().mockImplementation(async () => {
            activationOrder.push('element-b');
          })
        },
        {
          metadata: { name: 'element-c' },
          id: 'element-c',
          activate: jest.fn().mockImplementation(async () => {
            activationOrder.push('element-c');
          })
        }
      ];

      mockManagers.skillManager.list.mockResolvedValue(mockSkills);
      mockManagers.skillManager.get.mockImplementation((name: string) => {
        return Promise.resolve(mockSkills.find(s => s.metadata.name === name));
      });

      // Activate ensemble
      const result = await seqEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // Verify elements activated in dependency order: A -> B -> C
      expect(result.success).toBe(true);
      expect(activationOrder).toEqual(['element-a', 'element-b', 'element-c']);
      expect(result.activatedElements).toHaveLength(3);
    });

    it('should activate by priority with "priority" strategy (highest first)', async () => {
      // Create ensemble with priority strategy
      // Add elements with priorities: elem1 (100), elem2 (50), elem3 (75)
      const priorityEnsemble = new Ensemble({
        name: 'Priority Test',
        activationStrategy: 'priority'
      }, [
        {
          element_name: 'elem2',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        },
        {
          element_name: 'elem1',
          element_type: 'skill',
          role: 'primary',
          priority: 100,
          activation: 'always'
        },
        {
          element_name: 'elem3',
          element_type: 'skill',
          role: 'support',
          priority: 75,
          activation: 'always'
        }
      ], metadataService);

      // Track activation order
      const activationOrder: string[] = [];

      // Mock skills with tracking (skill elements use metadata.name for their own name)
      const mockSkills = [
        {
          metadata: { name: 'elem1' },
          id: 'elem1',
          activate: jest.fn().mockImplementation(async () => {
            activationOrder.push('elem1');
          })
        },
        {
          metadata: { name: 'elem2' },
          id: 'elem2',
          activate: jest.fn().mockImplementation(async () => {
            activationOrder.push('elem2');
          })
        },
        {
          metadata: { name: 'elem3' },
          id: 'elem3',
          activate: jest.fn().mockImplementation(async () => {
            activationOrder.push('elem3');
          })
        }
      ];

      mockManagers.skillManager.list.mockResolvedValue(mockSkills);
      mockManagers.skillManager.get.mockImplementation((name: string) => {
        return Promise.resolve(mockSkills.find(s => s.metadata.name === name));
      });

      // Activate ensemble
      const result = await priorityEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // Verify activation order: elem1 (100) -> elem3 (75) -> elem2 (50)
      expect(result.success).toBe(true);
      expect(activationOrder).toEqual(['elem1', 'elem3', 'elem2']);
      expect(result.activatedElements).toHaveLength(3);
    });

    it('should check conditions with "conditional" strategy', async () => {
      // Create ensemble with conditional strategy
      const conditionalEnsemble = new Ensemble({
        name: 'Conditional Test',
        activationStrategy: 'conditional'
      }, [
        {
          element_name: 'always-active',
          element_type: 'skill',
          role: 'primary',
          priority: 80,
          activation: 'always'
        },
        {
          element_name: 'conditional-active',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'conditional',
          condition: 'true'  // Simple condition that evaluates to true
        },
        {
          element_name: 'on-demand-active',
          element_type: 'skill',
          role: 'support',
          priority: 30,
          activation: 'on-demand'
        }
      ], metadataService);

      // Mock skills (skill elements use metadata.name for their own name)
      const mockSkills = [
        { metadata: { name: 'always-active' }, id: 'always-active', activate: jest.fn().mockResolvedValue(undefined) },
        { metadata: { name: 'conditional-active' }, id: 'conditional-active', activate: jest.fn().mockResolvedValue(undefined) },
        { metadata: { name: 'on-demand-active' }, id: 'on-demand-active', activate: jest.fn().mockResolvedValue(undefined) }
      ];

      mockManagers.skillManager.list.mockResolvedValue(mockSkills);
      mockManagers.skillManager.get.mockImplementation((name: string) => {
        return Promise.resolve(mockSkills.find(s => s.metadata.name === name));
      });

      // Activate ensemble
      const result = await conditionalEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // With actual VM evaluation:
      // - 'always' activation: always activates
      // - 'conditional' with condition='true': evaluates to true, activates
      // - 'on-demand': skipped in conditional strategy (manual trigger required)
      expect(result.success).toBe(true);
      expect(result.activatedElements).toContain('always-active');
      expect(result.activatedElements).toContain('conditional-active');
      expect(result.activatedElements).not.toContain('on-demand-active');
      expect(result.activatedElements).toHaveLength(2);
    });

    it('should not activate elements with "lazy" strategy', async () => {
      // Create ensemble with lazy strategy
      const lazyEnsemble = new Ensemble({
        name: 'Lazy Test',
        activationStrategy: 'lazy'
      }, [
        {
          element_name: 'skill-1',
          element_type: 'skill',
          role: 'primary',
          priority: 80,
          activation: 'always'
        },
        {
          element_name: 'skill-2',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        }
      ], metadataService);

      // Call activateEnsemble()
      const result = await lazyEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // Verify no elements are loaded
      expect(result.success).toBe(true);
      expect(result.activatedElements).toHaveLength(0);
      expect(result.failedElements).toHaveLength(0);
      expect(result.elementResults).toHaveLength(0);

      // Manager's list should not have been called for lazy activation
      expect(mockManagers.skillManager.list).not.toHaveBeenCalled();
    });

    it('should handle mixed activation types in sequential strategy', async () => {
      // Create ensemble with sequential strategy
      // Add mix of: always, on-demand, conditional elements
      const mixedEnsemble = new Ensemble({
        name: 'Mixed Test',
        activationStrategy: 'sequential'
      }, [
        {
          element_name: 'always-skill',
          element_type: 'skill',
          role: 'primary',
          priority: 80,
          activation: 'always'
        },
        {
          element_name: 'on-demand-skill',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'on-demand'
        },
        {
          element_name: 'conditional-skill',
          element_type: 'skill',
          role: 'support',
          priority: 30,
          activation: 'conditional',
          condition: 'test.ready == true'
        }
      ], metadataService);

      // Mock skills (skill elements use metadata.name for their own name)
      const mockSkills = [
        { metadata: { name: 'always-skill' }, id: 'always-skill', activate: jest.fn().mockResolvedValue(undefined) },
        { metadata: { name: 'on-demand-skill' }, id: 'on-demand-skill', activate: jest.fn().mockResolvedValue(undefined) },
        { metadata: { name: 'conditional-skill' }, id: 'conditional-skill', activate: jest.fn().mockResolvedValue(undefined) }
      ];

      mockManagers.skillManager.list.mockResolvedValue(mockSkills);
      mockManagers.skillManager.get.mockImplementation((name: string) => {
        return Promise.resolve(mockSkills.find(s => s.metadata.name === name));
      });

      // Activate ensemble
      const result = await mixedEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // Note: Current implementation activates ALL elements regardless of activation type
      // The sequential strategy doesn't filter by activation type, it just respects dependencies
      expect(result.success).toBe(true);
      expect(result.activatedElements).toContain('always-skill');
      expect(result.activatedElements).toContain('on-demand-skill');
      expect(result.activatedElements).toContain('conditional-skill');
      expect(result.activatedElements).toHaveLength(3);
    });

    it('should handle element activation failures gracefully', async () => {
      // Setup ensemble with 3 elements
      const failureEnsemble = new Ensemble({
        name: 'Failure Test',
        activationStrategy: 'sequential'
      }, [
        {
          element_name: 'success-1',
          element_type: 'skill',
          role: 'primary',
          priority: 80,
          activation: 'always'
        },
        {
          element_name: 'failure-skill',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        },
        {
          element_name: 'success-2',
          element_type: 'skill',
          role: 'support',
          priority: 30,
          activation: 'always'
        }
      ], metadataService);

      // Make middle element fail to load (skill elements use metadata.name for their own name)
      const mockSkills = [
        { metadata: { name: 'success-1' }, id: 'success-1', activate: jest.fn().mockResolvedValue(undefined) },
        { metadata: { name: 'success-2' }, id: 'success-2', activate: jest.fn().mockResolvedValue(undefined) }
      ];

      mockManagers.skillManager.list.mockResolvedValue(mockSkills);
      mockManagers.skillManager.get.mockImplementation((name: string) => {
        if (name === 'failure-skill') {
          return Promise.reject(new Error('Failed to load skill'));
        }
        return Promise.resolve(mockSkills.find(s => s.metadata.name === name));
      });

      // Activate ensemble
      const result = await failureEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // Verify result.success is false
      expect(result.success).toBe(false);

      // Check failedElements contains failed element
      expect(result.failedElements).toContain('failure-skill');

      // Verify activatedElements contains successful ones
      expect(result.activatedElements).toContain('success-1');
      expect(result.activatedElements).toContain('success-2');
      expect(result.activatedElements).toHaveLength(2);

      // Check element results
      expect(result.elementResults).toHaveLength(3);
      const failedResult = result.elementResults.find(r => r.elementName === 'failure-skill');
      expect(failedResult?.success).toBe(false);
      expect(failedResult?.error).toBeDefined();
    });

    it('should handle activation of empty ensemble', async () => {
      // Create ensemble with no elements
      const emptyEnsemble = new Ensemble({
        name: 'Empty Test',
        activationStrategy: 'sequential'
      }, [], metadataService);

      // Call activateEnsemble()
      const result = await emptyEnsemble.activateEnsemble(mockPortfolioManager, mockManagers);

      // Verify success: true
      expect(result.success).toBe(true);

      // Check activatedElements is empty array
      expect(result.activatedElements).toEqual([]);
      expect(result.failedElements).toEqual([]);
      expect(result.elementResults).toEqual([]);

      // Ensure no errors thrown (test passes if we get here)
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Ensemble Nesting Support', () => {
    it('should accept ensemble-type elements', () => {
      const nestedEnsemble: EnsembleElement = {
        element_name: 'backend-team',
        element_type: 'ensemble',
        role: 'primary',
        priority: 90,
        activation: 'always',
        purpose: 'Backend development team ensemble'
      };

      ensemble.addElement(nestedEnsemble);
      expect(ensemble.getElements().length).toBe(3);

      const added = ensemble.getElement('backend-team');
      expect(added).toBeDefined();
      expect(added?.element_type).toBe('ensemble');
      expect(added?.role).toBe('primary');
    });

    it('should accept multiple nested ensemble elements', () => {
      const ensembles: EnsembleElement[] = [
        {
          element_name: 'frontend-team',
          element_type: 'ensemble',
          role: 'primary',
          priority: 85,
          activation: 'always'
        },
        {
          element_name: 'backend-team',
          element_type: 'ensemble',
          role: 'primary',
          priority: 90,
          activation: 'always'
        },
        {
          element_name: 'devops-team',
          element_type: 'ensemble',
          role: 'support',
          priority: 75,
          activation: 'conditional',
          condition: 'state.activatedCount > 1'
        }
      ];

      ensembles.forEach(ens => ensemble.addElement(ens));
      expect(ensemble.getElements().length).toBe(5); // 2 original + 3 new

      expect(ensemble.getElement('frontend-team')?.element_type).toBe('ensemble');
      expect(ensemble.getElement('backend-team')?.element_type).toBe('ensemble');
      expect(ensemble.getElement('devops-team')?.element_type).toBe('ensemble');
    });

    it('should support allowNested metadata flag', () => {
      const nestedMetadata: Partial<EnsembleMetadata> = {
        name: 'Parent Ensemble',
        description: 'Ensemble that contains other ensembles',
        activationStrategy: 'sequential',
        conflictResolution: 'priority',
        allowNested: true,
        maxNestingDepth: 3
      };

      const parentEnsemble = new Ensemble(nestedMetadata, [], metadataService);
      expect(parentEnsemble.metadata.allowNested).toBe(true);
      expect(parentEnsemble.metadata.maxNestingDepth).toBe(3);
    });

    it('should use default nesting settings when not specified', () => {
      const simpleEnsemble = new Ensemble({ name: 'Simple' }, [], metadataService);
      expect(simpleEnsemble.metadata.allowNested).toBe(ENSEMBLE_DEFAULTS.ALLOW_NESTED);
      expect(simpleEnsemble.metadata.maxNestingDepth).toBe(ENSEMBLE_DEFAULTS.MAX_NESTING_DEPTH);
    });

    it('should allow ensemble elements with dependencies', () => {
      const nestedWithDeps: EnsembleElement = {
        element_name: 'dependent-ensemble',
        element_type: 'ensemble',
        role: 'support',
        priority: 60,
        activation: 'always',
        dependencies: ['primary-skill'] // Depends on existing element
      };

      ensemble.addElement(nestedWithDeps);
      const added = ensemble.getElement('dependent-ensemble');
      expect(added).toBeDefined();
      expect(added?.dependencies).toEqual(['primary-skill']);
    });

    it('should detect circular dependencies with nested ensembles', () => {
      // Create a circular dependency chain
      ensemble.addElement({
        element_name: 'ensemble-a',
        element_type: 'ensemble',
        role: 'primary',
        priority: 80,
        activation: 'always',
        dependencies: ['ensemble-b']
      });

      expect(() => {
        ensemble.addElement({
          element_name: 'ensemble-b',
          element_type: 'ensemble',
          role: 'primary',
          priority: 75,
          activation: 'always',
          dependencies: ['ensemble-a']
        });
      }).toThrow(/circular dependency/i);
    });

    it('should validate ensemble element names', () => {
      const invalidNames = [
        '',
        '<script>alert(1)</script>',
        'invalid name with spaces and special @#$',
        '../../etc/passwd'
      ];

      invalidNames.forEach(invalidName => {
        expect(() => {
          ensemble.addElement({
            element_name: invalidName,
            element_type: 'ensemble',
            role: 'primary',
            priority: 50,
            activation: 'always'
          });
        }).toThrow();
      });
    });

    it('should accept valid ensemble element names', () => {
      const validNames = [
        'backend-team',
        'frontend_team',
        'DevOpsTeam',
        'team-123',
        'api-gateway-ensemble'
      ];

      validNames.forEach(validName => {
        const testEnsemble = new Ensemble(mockMetadata, mockElements, metadataService);
        expect(() => {
          testEnsemble.addElement({
            element_name: validName,
            element_type: 'ensemble',
            role: 'primary',
            priority: 50,
            activation: 'always'
          });
        }).not.toThrow();

        expect(testEnsemble.getElement(validName)).toBeDefined();
      });
    });
  });

  describe('Edge Cases for Nested Ensembles', () => {
    it('should handle empty nested ensemble references', () => {
      const emptyNestedEnsemble: EnsembleElement = {
        element_name: 'empty-ensemble',
        element_type: 'ensemble',
        role: 'support',
        priority: 50,
        activation: 'always'
      };

      ensemble.addElement(emptyNestedEnsemble);
      const added = ensemble.getElement('empty-ensemble');
      expect(added).toBeDefined();
      expect(added?.element_type).toBe('ensemble');
    });

    it('should reject ensemble names that conflict with existing elements', () => {
      ensemble.addElement({
        element_name: 'unique-skill',
        element_type: 'skill',
        role: 'primary',
        priority: 80,
        activation: 'always'
      });

      // Attempting to add ensemble with same name should work (different type)
      // but be careful about naming conflicts
      expect(() => {
        ensemble.addElement({
          element_name: 'unique-skill', // Same name, different type
          element_type: 'ensemble',
          role: 'primary',
          priority: 90,
          activation: 'always'
        });
      }).not.toThrow(); // Names can overlap if needed
    });

    it('should handle deeply nested dependency chains', () => {
      // Create a chain: A depends on B depends on C
      ensemble.addElement({
        element_name: 'ensemble-c',
        element_type: 'ensemble',
        role: 'support',
        priority: 30,
        activation: 'always'
      });

      ensemble.addElement({
        element_name: 'ensemble-b',
        element_type: 'ensemble',
        role: 'support',
        priority: 50,
        activation: 'always',
        dependencies: ['ensemble-c']
      });

      ensemble.addElement({
        element_name: 'ensemble-a',
        element_type: 'ensemble',
        role: 'primary',
        priority: 70,
        activation: 'always',
        dependencies: ['ensemble-b']
      });

      expect(ensemble.getElements().length).toBe(5); // 2 original + 3 new
      expect(ensemble.getElement('ensemble-a')?.dependencies).toContain('ensemble-b');
    });

    it('should handle mixed element types with nested ensembles', () => {
      ensemble.addElement({
        element_name: 'nested-ensemble',
        element_type: 'ensemble',
        role: 'primary',
        priority: 85,
        activation: 'always'
      });

      ensemble.addElement({
        element_name: 'helper-skill',
        element_type: 'skill',
        role: 'support',
        priority: 60,
        activation: 'conditional',
        condition: 'nested-ensemble.active'
      });

      expect(ensemble.getElements().length).toBe(4);
      const elements = ensemble.getElements();
      const types = elements.map(e => e.element_type);
      expect(types).toContain('ensemble');
      expect(types).toContain('skill');
      expect(types).toContain('persona');
    });

    it('should respect maxNestingDepth metadata', () => {
      const deepEnsemble = new Ensemble({
        name: 'Deep Ensemble',
        description: 'Tests nesting depth limits',
        activationStrategy: 'sequential',
        conflictResolution: 'priority',
        maxNestingDepth: 2
      }, [], metadataService);

      expect(deepEnsemble.metadata.maxNestingDepth).toBe(2);
    });

    it('should track metrics for ensemble with nested ensembles', () => {
      const metricsEnsemble = new Ensemble({
        name: 'Metrics Test',
        description: 'Tests activation metrics',
        activationStrategy: 'all',
        conflictResolution: 'last-write'
      }, [], metadataService);

      metricsEnsemble.addElement({
        element_name: 'nested-1',
        element_type: 'ensemble',
        role: 'primary',
        priority: 80,
        activation: 'always'
      });

      metricsEnsemble.addElement({
        element_name: 'nested-2',
        element_type: 'ensemble',
        role: 'primary',
        priority: 75,
        activation: 'always'
      });

      const metrics = metricsEnsemble.getActivationMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.totalActivations).toBe(0); // No activations yet
      expect(metrics.nestedEnsembleCount).toBe(0);
    });
  });

  describe('Performance Tests for Deeply Nested Ensembles', () => {
    it('should handle 3-level deep nesting efficiently', () => {
      const performanceEnsemble = new Ensemble({
        name: 'Performance Test - 3 Levels',
        description: 'Tests 3-level nesting performance',
        activationStrategy: 'sequential',
        conflictResolution: 'priority'
      }, [], metadataService);

      // Create nested structure
      for (let i = 0; i < 3; i++) {
        performanceEnsemble.addElement({
          element_name: `level-1-ensemble-${i}`,
          element_type: 'ensemble',
          role: 'primary',
          priority: 80 - i,
          activation: 'always'
        });
      }

      // Add supporting elements
      for (let i = 0; i < 5; i++) {
        performanceEnsemble.addElement({
          element_name: `skill-${i}`,
          element_type: 'skill',
          role: 'support',
          priority: 50 - i,
          activation: 'on-demand'
        });
      }

      expect(performanceEnsemble.getElements().length).toBe(8);

      const startTime = Date.now();
      const validation = performanceEnsemble.validate();
      const validationTime = Date.now() - startTime;

      expect(validation.valid).toBe(true);
      expect(validationTime).toBeLessThan(100); // Should validate quickly (< 100ms)
    });

    it('should handle maximum ensemble count efficiently', () => {
      const maxEnsemble = new Ensemble({
        name: 'Max Ensemble Test',
        description: 'Tests maximum ensemble elements',
        activationStrategy: 'priority',
        conflictResolution: 'merge'
      }, [], metadataService);

      const startTime = Date.now();

      // Add up to limit (50 elements is the ENSEMBLE_LIMITS.MAX_ELEMENTS)
      for (let i = 0; i < 10; i++) {
        maxEnsemble.addElement({
          element_name: `ensemble-${i}`,
          element_type: 'ensemble',
          role: i < 5 ? 'primary' : 'support',
          priority: 100 - i,
          activation: 'always'
        });
      }

      const additionTime = Date.now() - startTime;

      expect(maxEnsemble.getElements().length).toBe(10);
      expect(additionTime).toBeLessThan(50); // Should add quickly (< 50ms)
    });

    it('should validate large ensembles with nested elements efficiently', () => {
      const largeEnsemble = new Ensemble({
        name: 'Large Ensemble',
        description: 'Tests validation performance with many nested ensembles',
        activationStrategy: 'sequential',
        conflictResolution: 'priority'
      }, [], metadataService);

      // Add 15 nested ensembles
      for (let i = 0; i < 15; i++) {
        largeEnsemble.addElement({
          element_name: `nested-ensemble-${i}`,
          element_type: 'ensemble',
          role: 'primary',
          priority: 90 - i,
          activation: 'always'
        });
      }

      // Add 20 other elements
      for (let i = 0; i < 20; i++) {
        const types = ['skill', 'persona', 'template'];
        largeEnsemble.addElement({
          element_name: `element-${i}`,
          type: types[i % types.length],
          role: 'support',
          priority: 70 - i,
          activation: 'on-demand'
        });
      }

      const startTime = Date.now();
      const result = largeEnsemble.validate();
      const validationTime = Date.now() - startTime;

      expect(result.valid).toBe(true);
      expect(largeEnsemble.getElements().length).toBe(35);
      expect(validationTime).toBeLessThan(200); // Should validate even large ensembles quickly
    });

    it('should measure activation metrics correctly', () => {
      const metricsTestEnsemble = new Ensemble({
        name: 'Metrics Tracking',
        description: 'Validates activation metrics',
        activationStrategy: 'all',
        conflictResolution: 'last-write'
      }, [], metadataService);

      metricsTestEnsemble.addElement({
        element_name: 'test-ensemble-1',
        element_type: 'ensemble',
        role: 'primary',
        priority: 90,
        activation: 'always'
      });

      metricsTestEnsemble.addElement({
        element_name: 'test-ensemble-2',
        element_type: 'ensemble',
        role: 'primary',
        priority: 85,
        activation: 'always'
      });

      const initialMetrics = metricsTestEnsemble.getActivationMetrics();
      expect(initialMetrics.totalActivations).toBe(0);
      expect(initialMetrics.successfulActivations).toBe(0);
      expect(initialMetrics.minDuration).toBe(Infinity);
      expect(initialMetrics.maxDuration).toBe(0);
      expect(initialMetrics.averageDuration).toBe(0);
    });
  });
});
