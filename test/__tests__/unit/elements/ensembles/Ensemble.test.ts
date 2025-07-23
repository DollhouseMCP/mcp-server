/**
 * Comprehensive tests for Ensemble element
 * Tests all functionality including security measures
 */

import { jest } from '@jest/globals';

import { Ensemble } from '../../../../../src/elements/ensembles/Ensemble.js';
import { ElementType } from '../../../../../src/portfolio/types.js';
import { ElementStatus } from '../../../../../src/types/elements/index.js';
import { SecurityMonitor } from '../../../../../src/security/securityMonitor.js';
import { 
  ENSEMBLE_LIMITS, 
  ENSEMBLE_DEFAULTS, 
  ENSEMBLE_ERRORS,
  ENSEMBLE_SECURITY_EVENTS 
} from '../../../../../src/elements/ensembles/constants.js';

// Mock SecurityMonitor
const mockLogSecurityEvent = jest.fn();
jest.mock('../../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: mockLogSecurityEvent
  }
}));

// Mock logger
jest.mock('../../../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

describe('Ensemble', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create an ensemble with default values', () => {
      const ensemble = new Ensemble({ name: 'Test Ensemble' });
      
      expect(ensemble.type).toBe(ElementType.ENSEMBLE);
      expect(ensemble.metadata.name).toBe('Test Ensemble');
      expect((ensemble.metadata as any).activationStrategy).toBe(ENSEMBLE_DEFAULTS.ACTIVATION_STRATEGY);
      expect((ensemble.metadata as any).conflictResolution).toBe(ENSEMBLE_DEFAULTS.CONFLICT_RESOLUTION);
    });

    it('should sanitize input during construction', () => {
      const ensemble = new Ensemble({
        name: '<script>alert("xss")</script>Test',
        description: 'Test<img src=x onerror=alert(1)>'
      });
      
      expect(ensemble.metadata.name).not.toContain('<script>');
      expect(ensemble.metadata.description).not.toContain('<img');
    });

    it('should reject invalid activation strategy', () => {
      expect(() => new Ensemble({
        name: 'Test',
        activationStrategy: 'invalid' as any
      })).toThrow(ENSEMBLE_ERRORS.INVALID_STRATEGY);
    });

    it('should reject invalid conflict resolution strategy', () => {
      expect(() => new Ensemble({
        name: 'Test',
        conflictResolution: 'invalid' as any
      })).toThrow(ENSEMBLE_ERRORS.INVALID_CONFLICT_RESOLUTION);
    });

    it('should enforce element limits', () => {
      expect(() => new Ensemble({
        name: 'Test',
        maxElements: ENSEMBLE_LIMITS.MAX_ELEMENTS + 1
      })).toThrow(ENSEMBLE_ERRORS.TOO_MANY_ELEMENTS);
    });

    it('should enforce nesting depth limits', () => {
      expect(() => new Ensemble({
        name: 'Test',
        maxNestingDepth: ENSEMBLE_LIMITS.MAX_NESTING_DEPTH + 1
      })).toThrow(ENSEMBLE_ERRORS.NESTING_TOO_DEEP);
    });
  });

  describe('addElement', () => {
    let ensemble: Ensemble;

    beforeEach(() => {
      ensemble = new Ensemble({ name: 'Test Ensemble' });
    });

    it('should add a valid element', () => {
      ensemble.addElement('element1', 'persona', 'primary');
      
      const elements = ensemble.getElements();
      expect(elements.size).toBe(1);
      expect(elements.get('element1')).toMatchObject({
        elementId: 'element1',
        elementType: 'persona',
        role: 'primary'
      });
    });

    it('should enforce element count limit', () => {
      const maxElements = (ensemble.metadata as any).maxElements;
      
      // Add maximum allowed elements
      for (let i = 0; i < maxElements; i++) {
        ensemble.addElement(`element${i}`, 'persona', 'support');
      }
      
      // Try to add one more
      expect(() => ensemble.addElement('extra', 'persona', 'support'))
        .toThrow(ENSEMBLE_ERRORS.TOO_MANY_ELEMENTS);
      
      expect(mockLogSecurityEvent).toHaveBeenCalledWith({
        type: ENSEMBLE_SECURITY_EVENTS.RESOURCE_LIMIT_EXCEEDED,
        severity: 'MEDIUM',
        source: 'Ensemble.addElement',
        details: expect.stringContaining('Maximum elements')
      });
    });

    it('should validate element ID format', () => {
      expect(() => ensemble.addElement('../../etc/passwd', 'persona', 'primary'))
        .toThrow('Invalid element ID format');
    });

    it('should validate element role', () => {
      expect(() => ensemble.addElement('element1', 'persona', 'invalid' as any))
        .toThrow('Invalid element role');
    });

    it('should validate activation condition', () => {
      // Valid condition
      ensemble.addElement('element1', 'persona', 'primary', {
        activationCondition: 'element2.active == true'
      });
      
      // Invalid condition (potential code injection)
      expect(() => ensemble.addElement('element2', 'persona', 'primary', {
        activationCondition: 'eval("malicious code")'
      })).toThrow('Invalid activation condition syntax');
      
      expect(mockLogSecurityEvent).toHaveBeenCalledWith({
        type: ENSEMBLE_SECURITY_EVENTS.SUSPICIOUS_CONDITION,
        severity: 'HIGH',
        source: 'Ensemble.addElement',
        details: expect.stringContaining('Suspicious activation condition')
      });
    });

    it('should enforce dependency limits', () => {
      const tooManyDeps = Array(ENSEMBLE_LIMITS.MAX_DEPENDENCIES + 1)
        .fill(0)
        .map((_, i) => `dep${i}`);
      
      expect(() => ensemble.addElement('element1', 'persona', 'primary', {
        dependencies: tooManyDeps
      })).toThrow(`Too many dependencies`);
    });

    it('should detect circular dependencies', () => {
      // Add elements
      ensemble.addElement('A', 'persona', 'primary');
      ensemble.addElement('B', 'persona', 'primary', { dependencies: ['A'] });
      
      // Try to create circular dependency
      expect(() => ensemble.addElement('C', 'persona', 'primary', { dependencies: ['B', 'D'] }))
        .not.toThrow(); // C depends on B and D (D doesn't exist yet, but that's ok)
      
      // Now try to make A depend on C (creating A->B->C->A cycle)
      ensemble.removeElement('A');
      expect(() => ensemble.addElement('A', 'persona', 'primary', { dependencies: ['C'] }))
        .toThrow(ENSEMBLE_ERRORS.CIRCULAR_DEPENDENCY);
      
      expect(mockLogSecurityEvent).toHaveBeenCalledWith({
        type: ENSEMBLE_SECURITY_EVENTS.CIRCULAR_DEPENDENCY,
        severity: 'HIGH',
        source: 'Ensemble.addElement',
        details: expect.stringContaining('Circular dependency detected')
      });
    });

    it('should handle self-referential dependencies', () => {
      expect(() => ensemble.addElement('A', 'persona', 'primary', { dependencies: ['A'] }))
        .toThrow(ENSEMBLE_ERRORS.CIRCULAR_DEPENDENCY);
    });
  });

  describe('removeElement', () => {
    let ensemble: Ensemble;

    beforeEach(() => {
      ensemble = new Ensemble({ name: 'Test Ensemble' });
      ensemble.addElement('element1', 'persona', 'primary');
      ensemble.addElement('element2', 'skill', 'support', { dependencies: ['element1'] });
      ensemble.addElement('element3', 'template', 'support');
    });

    it('should remove an element', () => {
      ensemble.removeElement('element1');
      
      const elements = ensemble.getElements();
      expect(elements.size).toBe(2);
      expect(elements.has('element1')).toBe(false);
    });

    it('should clean up dependencies when removing element', () => {
      ensemble.removeElement('element1');
      
      const element2 = ensemble.getElements().get('element2');
      expect(element2?.dependencies).toEqual([]);
    });

    it('should throw error for non-existent element', () => {
      expect(() => ensemble.removeElement('nonexistent'))
        .toThrow(ENSEMBLE_ERRORS.ELEMENT_NOT_FOUND);
    });

    it('should clean up shared context owned by removed element', () => {
      // Set some context values
      ensemble.setContextValue('key1', 'value1', 'element1');
      ensemble.setContextValue('key2', 'value2', 'element2');
      
      // Remove element1
      ensemble.removeElement('element1');
      
      // Check context
      expect(ensemble.getContextValue('key1')).toBeUndefined();
      expect(ensemble.getContextValue('key2')).toBe('value2');
    });
  });

  describe('activation', () => {
    let ensemble: Ensemble;

    beforeEach(() => {
      ensemble = new Ensemble({ 
        name: 'Test Ensemble',
        activationStrategy: 'sequential'
      });
      ensemble.addElement('element1', 'persona', 'primary');
      ensemble.addElement('element2', 'skill', 'support');
    });

    it('should activate ensemble sequentially', async () => {
      await ensemble.activate();
      
      expect(ensemble.getStatus()).toBe('active' as ElementStatus);
      
      const result = ensemble.getLastActivationResult();
      expect(result).toBeDefined();
      expect(result?.activatedElements).toContain('element1');
      expect(result?.activatedElements).toContain('element2');
      expect(result?.success).toBe(true);
    });

    it('should activate ensemble in parallel', async () => {
      const parallelEnsemble = new Ensemble({
        name: 'Parallel Test',
        activationStrategy: 'parallel'
      });
      parallelEnsemble.addElement('element1', 'persona', 'primary');
      parallelEnsemble.addElement('element2', 'skill', 'support');
      
      await parallelEnsemble.activate();
      
      const result = parallelEnsemble.getLastActivationResult();
      expect(result?.activatedElements.length).toBe(2);
    });

    it('should respect priority in priority activation', async () => {
      const priorityEnsemble = new Ensemble({
        name: 'Priority Test',
        activationStrategy: 'priority'
      });
      priorityEnsemble.addElement('low', 'persona', 'primary', { priority: 10 });
      priorityEnsemble.addElement('high', 'skill', 'primary', { priority: 90 });
      priorityEnsemble.addElement('medium', 'template', 'primary', { priority: 50 });
      
      await priorityEnsemble.activate();
      
      const result = priorityEnsemble.getLastActivationResult();
      // High priority should be activated first
      expect(result?.activatedElements[0]).toBe('high');
      expect(result?.activatedElements[1]).toBe('medium');
      expect(result?.activatedElements[2]).toBe('low');
    });

    it('should handle activation timeout', async () => {
      const timeoutEnsemble = new Ensemble({
        name: 'Timeout Test',
        activationStrategy: 'sequential',
        maxActivationTime: 50 // Very short timeout
      });
      
      // Add many elements to exceed timeout
      for (let i = 0; i < 10; i++) {
        timeoutEnsemble.addElement(`element${i}`, 'persona', 'support');
      }
      
      await expect(timeoutEnsemble.activate()).rejects.toThrow(ENSEMBLE_ERRORS.ACTIVATION_TIMEOUT);
      
      expect(mockLogSecurityEvent).toHaveBeenCalledWith({
        type: ENSEMBLE_SECURITY_EVENTS.ACTIVATION_TIMEOUT,
        severity: 'HIGH',
        source: 'Ensemble.activateSequential',
        details: expect.stringContaining('Activation timeout')
      });
    });

    it('should prevent concurrent activation', async () => {
      const promise1 = ensemble.activate();
      const promise2 = ensemble.activate();
      
      await expect(promise2).rejects.toThrow('Activation already in progress');
      await promise1; // Let first activation complete
    });

    it('should support lazy activation strategy', async () => {
      const lazyEnsemble = new Ensemble({
        name: 'Lazy Test',
        activationStrategy: 'lazy'
      });
      lazyEnsemble.addElement('element1', 'persona', 'primary');
      
      await lazyEnsemble.activate();
      
      // Lazy activation doesn't actually activate elements
      const result = lazyEnsemble.getLastActivationResult();
      expect(result?.activatedElements.length).toBe(0);
    });
  });

  describe('deactivation', () => {
    it('should deactivate ensemble and clear context', async () => {
      const ensemble = new Ensemble({ name: 'Test' });
      ensemble.addElement('element1', 'persona', 'primary');
      
      await ensemble.activate();
      ensemble.setContextValue('key', 'value', 'element1');
      
      await ensemble.deactivate();
      
      expect(ensemble.getStatus()).toBe('inactive' as ElementStatus);
      expect(ensemble.getContextValue('key')).toBeUndefined();
    });
  });

  describe('shared context', () => {
    let ensemble: Ensemble;

    beforeEach(() => {
      ensemble = new Ensemble({ 
        name: 'Test',
        conflictResolution: 'last-write'
      });
      ensemble.addElement('element1', 'persona', 'primary');
      ensemble.addElement('element2', 'skill', 'support');
    });

    it('should set and get context values', () => {
      ensemble.setContextValue('key1', 'value1', 'element1');
      expect(ensemble.getContextValue('key1')).toBe('value1');
    });

    it('should enforce context size limits', () => {
      // Fill context to limit
      for (let i = 0; i < ENSEMBLE_LIMITS.MAX_CONTEXT_SIZE; i++) {
        ensemble.setContextValue(`key${i}`, `value${i}`, 'element1');
      }
      
      // Try to add one more
      expect(() => ensemble.setContextValue('overflow', 'value', 'element1'))
        .toThrow(ENSEMBLE_ERRORS.CONTEXT_OVERFLOW);
      
      expect(mockLogSecurityEvent).toHaveBeenCalledWith({
        type: ENSEMBLE_SECURITY_EVENTS.CONTEXT_SIZE_EXCEEDED,
        severity: 'MEDIUM',
        source: 'Ensemble.setContextValue',
        details: expect.stringContaining('Context size limit')
      });
    });

    it('should enforce context value size limits', () => {
      const largeValue = 'x'.repeat(ENSEMBLE_LIMITS.MAX_CONTEXT_VALUE_SIZE + 1);
      
      expect(() => ensemble.setContextValue('key', largeValue, 'element1'))
        .toThrow('Context value too large');
    });

    it('should handle last-write conflict resolution', () => {
      ensemble.setContextValue('key', 'value1', 'element1');
      const conflict = ensemble.setContextValue('key', 'value2', 'element2');
      
      expect(ensemble.getContextValue('key')).toBe('value2');
      expect(conflict).toBeNull(); // last-write doesn't return conflict
    });

    it('should handle first-write conflict resolution', () => {
      const firstWriteEnsemble = new Ensemble({
        name: 'Test',
        conflictResolution: 'first-write'
      });
      firstWriteEnsemble.addElement('element1', 'persona', 'primary');
      firstWriteEnsemble.addElement('element2', 'skill', 'support');
      
      firstWriteEnsemble.setContextValue('key', 'value1', 'element1');
      const conflict = firstWriteEnsemble.setContextValue('key', 'value2', 'element2');
      
      expect(firstWriteEnsemble.getContextValue('key')).toBe('value1');
      expect(conflict).toMatchObject({
        key: 'key',
        currentValue: 'value1',
        newValue: 'value2'
      });
    });

    it('should handle error conflict resolution', () => {
      const errorEnsemble = new Ensemble({
        name: 'Test',
        conflictResolution: 'error'
      });
      errorEnsemble.addElement('element1', 'persona', 'primary');
      errorEnsemble.addElement('element2', 'skill', 'support');
      
      errorEnsemble.setContextValue('key', 'value1', 'element1');
      
      expect(() => errorEnsemble.setContextValue('key', 'value2', 'element2'))
        .toThrow("Context conflict on key 'key'");
    });

    it('should handle priority conflict resolution', () => {
      const priorityEnsemble = new Ensemble({
        name: 'Test',
        conflictResolution: 'priority'
      });
      priorityEnsemble.addElement('low', 'persona', 'primary', { priority: 10 });
      priorityEnsemble.addElement('high', 'skill', 'primary', { priority: 90 });
      
      priorityEnsemble.setContextValue('key', 'lowValue', 'low');
      priorityEnsemble.setContextValue('key', 'highValue', 'high');
      
      expect(priorityEnsemble.getContextValue('key')).toBe('highValue');
      
      // Lower priority can't override higher
      priorityEnsemble.setContextValue('key', 'lowValue2', 'low');
      expect(priorityEnsemble.getContextValue('key')).toBe('highValue');
    });

    it('should handle merge conflict resolution for objects', () => {
      const mergeEnsemble = new Ensemble({
        name: 'Test',
        conflictResolution: 'merge'
      });
      mergeEnsemble.addElement('element1', 'persona', 'primary');
      mergeEnsemble.addElement('element2', 'skill', 'support');
      
      mergeEnsemble.setContextValue('config', { a: 1, b: 2 }, 'element1');
      mergeEnsemble.setContextValue('config', { b: 3, c: 4 }, 'element2');
      
      expect(mergeEnsemble.getContextValue('config')).toEqual({
        a: 1,
        b: 3,
        c: 4
      });
    });
  });

  describe('validation', () => {
    it('should validate empty ensemble', () => {
      const ensemble = new Ensemble({ name: 'Empty' });
      const result = ensemble.validate();
      
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0].message).toContain('no elements');
    });

    it('should detect circular dependencies in validation', () => {
      const ensemble = new Ensemble({ name: 'Test' });
      
      // Force add elements with circular dependency for testing
      // This bypasses the addElement check
      const elements = ensemble.getElements() as any;
      elements.set('A', { elementId: 'A', elementType: 'persona', role: 'primary', dependencies: ['B'] });
      elements.set('B', { elementId: 'B', elementType: 'skill', role: 'support', dependencies: ['A'] });
      
      const result = ensemble.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain('Circular dependency');
    });

    it('should detect orphaned dependencies', () => {
      const ensemble = new Ensemble({ name: 'Test' });
      ensemble.addElement('element1', 'persona', 'primary', { dependencies: ['nonexistent'] });
      
      const result = ensemble.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain("Dependency 'nonexistent' not found");
    });
  });

  describe('serialization', () => {
    it('should serialize and deserialize ensemble', () => {
      const ensemble = new Ensemble({ 
        name: 'Test',
        description: 'Test ensemble',
        activationStrategy: 'priority'
      });
      ensemble.addElement('element1', 'persona', 'primary', { priority: 100 });
      ensemble.addElement('element2', 'skill', 'support', { 
        dependencies: ['element1'],
        activationCondition: 'element1.active == true'
      });
      ensemble.setContextValue('key', 'value', 'element1');
      
      const serialized = ensemble.serialize();
      
      const newEnsemble = new Ensemble();
      newEnsemble.deserialize(serialized);
      
      expect(newEnsemble.metadata.name).toBe('Test');
      expect(newEnsemble.getElements().size).toBe(2);
      expect(newEnsemble.getContextValue('key')).toBe('value');
    });
  });

  describe('security edge cases', () => {
    it('should sanitize all string inputs', () => {
      const ensemble = new Ensemble({ name: 'Test' });
      
      // XSS attempts in various inputs
      ensemble.addElement(
        '<script>alert(1)</script>',
        '"><img src=x onerror=alert(1)>',
        'primary',
        {
          activationCondition: 'safe.condition == true',
          dependencies: ['<dependency>']
        }
      );
      
      const elements = Array.from(ensemble.getElements().values());
      expect(elements[0].elementId).not.toContain('<script>');
      expect(elements[0].elementType).not.toContain('<img');
      expect(elements[0].dependencies![0]).not.toContain('<');
    });

    it('should handle Unicode normalization attacks', () => {
      const ensemble = new Ensemble({ 
        name: 'e\u0301' // é with combining accent
      });
      
      // Should be normalized
      expect(ensemble.metadata.name).toBe('é');
    });

    it('should prevent path traversal in element IDs', () => {
      const ensemble = new Ensemble({ name: 'Test' });
      
      const maliciousIds = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        'element/../../../secret',
        'element\0.txt'
      ];
      
      for (const id of maliciousIds) {
        expect(() => ensemble.addElement(id, 'persona', 'primary'))
          .toThrow('Invalid element ID format');
      }
    });
  });
});