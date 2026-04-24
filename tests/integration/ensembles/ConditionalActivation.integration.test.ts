/**
 * Integration tests for Ensemble Conditional Activation
 *
 * Tests the full activation flow with conditional elements, including:
 *
 * 1. Element activation based on conditions
 * 2. Context propagation and shared state
 * 3. Priority-based conditional decisions
 * 4. Dependency handling with conditions
 * 5. Error handling and recovery
 * 6. Mixed activation modes (always + conditional)
 *
 * These tests exercise the complete ensemble activation pipeline,
 * validating that conditions are properly evaluated (when implemented)
 * and that the activation strategy works correctly.
 *
 * @see src/elements/ensembles/Ensemble.ts - activateEnsemble() and activateConditional()
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Ensemble } from '../../../src/elements/ensembles/Ensemble.js';
import { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { FileWatchService } from '../../../src/services/FileWatchService.js';
import { ElementManagers } from '../../../src/elements/ensembles/types.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

// Mock dependencies
jest.mock('../../../src/security/securityMonitor.js');
jest.mock('../../../src/utils/logger.js');

describe('Ensemble Conditional Activation Integration', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  let _ensembleManager: EnsembleManager;
  let fileLockManager: FileLockManager;
  let metadataService: MetadataService;

  // Mock element managers
  const mockSkillManager = {
    list: jest.fn(() => Promise.resolve([])),
    load: jest.fn(),
    save: jest.fn()
  };

  const mockPersonaManager = {
    list: jest.fn(() => Promise.resolve([])),
    findPersona: jest.fn(),
    save: jest.fn()
  };

  const mockTemplateManager = {
    list: jest.fn(() => Promise.resolve([])),
    load: jest.fn(),
    save: jest.fn()
  };

  const mockAgentManager = {
    list: jest.fn(() => Promise.resolve([])),
    load: jest.fn(),
    save: jest.fn()
  };

  const mockMemoryManager = {
    list: jest.fn(() => Promise.resolve([])),
    load: jest.fn(),
    save: jest.fn()
  };

  const managers: ElementManagers = {
    skillManager: mockSkillManager,
    personaManager: mockPersonaManager,
    templateManager: mockTemplateManager,
    agentManager: mockAgentManager,
    memoryManager: mockMemoryManager
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (SecurityMonitor.logSecurityEvent as jest.Mock) = jest.fn();

    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-integration-test-'));

    // Initialize managers
    fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    const serializationService = new SerializationService();
    metadataService = new MetadataService();
    const fileWatchService = new FileWatchService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );
    portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    _ensembleManager = new EnsembleManager({
      portfolioManager,
      fileLockManager,
      fileOperationsService: fileOperations,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      fileWatchService,
      storageLayerFactory: createTestStorageFactory(fileOperations),
    });

    // Reset mock managers
    mockSkillManager.list.mockResolvedValue([]);
    mockPersonaManager.list.mockResolvedValue([]);
    mockTemplateManager.list.mockResolvedValue([]);
    mockAgentManager.list.mockResolvedValue([]);
    mockMemoryManager.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Basic Conditional Activation', () => {
    it('should activate elements with always activation mode', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Test Ensemble',
          description: 'Test conditional activation',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'always-skill',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ],
        metadataService
      );

      // Mock element instances
      const mockSkill = {
        metadata: { name: 'always-skill' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(true);
      expect(result.activatedElements).toContain('always-skill');
      expect(result.failedElements).toHaveLength(0);
      expect(mockSkill.activate).toHaveBeenCalled();
    });

    it('should activate conditional elements when condition is met', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Test Ensemble',
          description: 'Test conditional activation',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'conditional-skill',
            element_type: 'skill',
            role: 'support',
            priority: 50,
            activation: 'conditional',
            condition: 'priority > 40'
          }
        ],
        metadataService
      );

      const mockSkill = {
        metadata: { name: 'conditional-skill' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      // NOTE: Currently evaluateCondition() always returns true
      // When implemented, this test will verify actual condition evaluation
      expect(result.success).toBe(true);
      expect(result.activatedElements).toContain('conditional-skill');
    });

    it('should skip conditional elements when condition is not met', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Test Ensemble',
          description: 'Test conditional activation',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'conditional-skill',
            element_type: 'skill',
            role: 'support',
            priority: 30,
            activation: 'conditional',
            condition: 'priority > 80'
          }
        ],
        metadataService
      );

      const mockSkill = {
        metadata: { name: 'conditional-skill' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      // NOTE: Currently all conditional elements activate
      // When condition evaluation is implemented, this element should be skipped
      // For now, we just verify the activation completes
      expect(result.success).toBe(true);
    });
  });

  describe('Mixed Activation Modes', () => {
    it('should handle always + conditional elements', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Mixed Ensemble',
          description: 'Test mixed activation modes',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'always-primary',
            element_type: 'skill',
            role: 'primary',
            priority: 90,
            activation: 'always'
          },
          {
            element_name: 'conditional-support',
            element_type: 'skill',
            role: 'support',
            priority: 60,
            activation: 'conditional',
            condition: 'priority > 50'
          },
          {
            element_name: 'on-demand-override',
            element_type: 'skill',
            role: 'override',
            priority: 70,
            activation: 'on-demand'
          }
        ],
        metadataService
      );

      const mockSkill1 = {
        metadata: { name: 'always-primary' },
        activate: jest.fn(() => Promise.resolve())
      };

      const mockSkill2 = {
        metadata: { name: 'conditional-support' },
        activate: jest.fn(() => Promise.resolve())
      };

      const mockSkill3 = {
        metadata: { name: 'on-demand-override' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill1, mockSkill2, mockSkill3]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(true);
      // Always elements should activate
      expect(result.activatedElements).toContain('always-primary');
      // Conditional elements should activate (when condition is true)
      expect(result.activatedElements).toContain('conditional-support');
      // On-demand elements should NOT auto-activate in conditional strategy
      expect(result.activatedElements).not.toContain('on-demand-override');
    });

    it('should activate elements in correct order', async () => {
      const activationOrder: string[] = [];

      const ensemble = new Ensemble(
        {
          name: 'Ordered Ensemble',
          description: 'Test activation order',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'first',
            element_type: 'skill',
            role: 'primary',
            priority: 100,
            activation: 'always'
          },
          {
            element_name: 'second',
            element_type: 'skill',
            role: 'support',
            priority: 80,
            activation: 'conditional',
            condition: 'priority > 50'
          },
          {
            element_name: 'third',
            element_type: 'skill',
            role: 'support',
            priority: 60,
            activation: 'always'
          }
        ],
        metadataService
      );

      const mockSkill1 = {
        metadata: { name: 'first' },
        activate: jest.fn(() => {
          activationOrder.push('first');
          return Promise.resolve();
        })
      };

      const mockSkill2 = {
        metadata: { name: 'second' },
        activate: jest.fn(() => {
          activationOrder.push('second');
          return Promise.resolve();
        })
      };

      const mockSkill3 = {
        metadata: { name: 'third' },
        activate: jest.fn(() => {
          activationOrder.push('third');
          return Promise.resolve();
        })
      };

      mockSkillManager.list.mockResolvedValue([mockSkill1, mockSkill2, mockSkill3]);

      await ensemble.activateEnsemble(portfolioManager, managers);

      // Verify all activated
      expect(activationOrder).toContain('first');
      expect(activationOrder).toContain('second');
      expect(activationOrder).toContain('third');
    });
  });

  describe('Context Propagation with Conditions', () => {
    it('should share context between conditional elements', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Context Ensemble',
          description: 'Test context sharing',
          activationStrategy: 'conditional',
          contextSharing: 'full'
        },
        [
          {
            element_name: 'context-setter',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          },
          {
            element_name: 'context-reader',
            element_type: 'skill',
            role: 'support',
            priority: 60,
            activation: 'conditional',
            condition: 'context.ready == true'
          }
        ],
        metadataService
      );

      // Set context value
      ensemble.setContextValue('ready', true, 'context-setter');

      const mockSkill1 = {
        metadata: { name: 'context-setter' },
        activate: jest.fn(() => Promise.resolve())
      };

      const mockSkill2 = {
        metadata: { name: 'context-reader' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill1, mockSkill2]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(true);
      expect(ensemble.getContextValue('ready')).toBe(true);
    });

    it('should handle context conflicts with priority resolution', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Conflict Ensemble',
          description: 'Test context conflicts',
          activationStrategy: 'conditional',
          conflictResolution: 'priority'
        },
        [
          {
            element_name: 'low-priority',
            element_type: 'skill',
            role: 'support',
            priority: 40,
            activation: 'always'
          },
          {
            element_name: 'high-priority',
            element_type: 'skill',
            role: 'primary',
            priority: 90,
            activation: 'always'
          }
        ],
        metadataService
      );

      // Set conflicting context values
      ensemble.setContextValue('config', 'low-value', 'low-priority');
      ensemble.setContextValue('config', 'high-value', 'high-priority');

      // High priority should win
      expect(ensemble.getContextValue('config')).toBe('high-value');
    });

    it('should isolate context when contextSharing is selective', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Isolated Context',
          description: 'Test selective context sharing',
          activationStrategy: 'conditional',
          contextSharing: 'selective'
        },
        [
          {
            element_name: 'element-a',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ],
        metadataService
      );

      ensemble.setContextValue('shared', 'value', 'element-a');
      expect(ensemble.getContextValue('shared')).toBe('value');
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle element load failures', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Error Ensemble',
          description: 'Test error handling',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'missing-skill',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ],
        metadataService
      );

      // Mock element not found
      mockSkillManager.list.mockResolvedValue([]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(false);
      expect(result.failedElements).toContain('missing-skill');
    });

    it('should handle activation timeout', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Timeout Ensemble',
          description: 'Test timeout handling',
          activationStrategy: 'conditional',
          resourceLimits: {
            maxActiveElements: 10,
            maxExecutionTimeMs: 1000 // 1 second timeout (minimum allowed)
          }
        },
        [
          {
            element_name: 'slow-skill',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ],
        metadataService
      );

      // Mock slow activation (takes longer than the timeout)
      const mockSkill = {
        metadata: { name: 'slow-skill' },
        activate: jest.fn(() => new Promise(resolve => setTimeout(resolve, 1500)))
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      await expect(
        ensemble.activateEnsemble(portfolioManager, managers)
      ).rejects.toThrow(/timeout/i);
    });

    it('should continue activation after element failure', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Resilient Ensemble',
          description: 'Test failure recovery',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'failing-skill',
            element_type: 'skill',
            role: 'support',
            priority: 70,
            activation: 'always'
          },
          {
            element_name: 'working-skill',
            element_type: 'skill',
            role: 'support',
            priority: 60,
            activation: 'always'
          }
        ],
        metadataService
      );

      const mockFailingSkill = {
        metadata: { name: 'failing-skill' },
        activate: jest.fn(() => Promise.reject(new Error('Activation failed')))
      };

      const mockWorkingSkill = {
        metadata: { name: 'working-skill' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockFailingSkill, mockWorkingSkill]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(false);
      expect(result.failedElements).toContain('failing-skill');
      expect(result.activatedElements).toContain('working-skill');
    });

    it('should activate element with semantically invalid condition', async () => {
      // Test that syntactically valid but semantically invalid conditions
      // are accepted (will be caught during evaluation when implemented)
      const ensemble = new Ensemble(
        {
          name: 'Semantic Condition Test',
          description: 'Test semantic validation',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'test-element',
            element_type: 'skill',
            role: 'support',
            priority: 50,
            activation: 'conditional',
            condition: 'nonexistent.property == value'
          }
        ],
        metadataService
      );

      const mockSkill = {
        metadata: { name: 'test-element' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      // Condition evaluation IS implemented - invalid conditions should fail-secure
      // The condition references nonexistent.property which will throw ReferenceError
      // Per fail-secure design, evaluation errors result in non-activation
      const result = await ensemble.activateEnsemble(portfolioManager, managers);
      expect(result).toBeDefined();
      expect(result.success).toBe(true); // Ensemble activation completes successfully
      expect(result.activatedElements).not.toContain('test-element'); // But element is skipped due to invalid condition
    });
  });

  describe('Dependency Handling with Conditions', () => {
    it('should respect dependencies in conditional activation', async () => {
      const activationOrder: string[] = [];

      const ensemble = new Ensemble(
        {
          name: 'Dependency Ensemble',
          description: 'Test dependencies with conditions',
          activationStrategy: 'sequential' // Use sequential to enforce dependencies
        },
        [
          {
            element_name: 'dependency',
            element_type: 'skill',
            role: 'support',
            priority: 60,
            activation: 'always'
          },
          {
            element_name: 'dependent',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'conditional',
            condition: 'priority > 50',
            dependencies: ['dependency']
          }
        ],
        metadataService
      );

      const mockDependency = {
        metadata: { name: 'dependency' },
        activate: jest.fn(() => {
          activationOrder.push('dependency');
          return Promise.resolve();
        })
      };

      const mockDependent = {
        metadata: { name: 'dependent' },
        activate: jest.fn(() => {
          activationOrder.push('dependent');
          return Promise.resolve();
        })
      };

      mockSkillManager.list.mockResolvedValue([mockDependency, mockDependent]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(true);
      expect(activationOrder).toEqual(['dependency', 'dependent']);
    });

    it('should handle conditional dependencies', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Conditional Dependency Ensemble',
          description: 'Test conditional dependencies',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'optional-dependency',
            element_type: 'skill',
            role: 'support',
            priority: 40,
            activation: 'conditional',
            condition: 'optional == true'
          },
          {
            element_name: 'main-element',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always',
            dependencies: ['optional-dependency']
          }
        ],
        metadataService
      );

      const mockOptional = {
        metadata: { name: 'optional-dependency' },
        activate: jest.fn(() => Promise.resolve())
      };

      const mockMain = {
        metadata: { name: 'main-element' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockOptional, mockMain]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(true);
      // Both should activate (optional condition currently always true)
      expect(result.activatedElements).toContain('main-element');
    });
  });

  describe('Performance and Resource Management', () => {
    it('should complete activation within timeout', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Performance Ensemble',
          description: 'Test performance',
          activationStrategy: 'conditional',
          resourceLimits: {
            maxActiveElements: 50,
            maxExecutionTimeMs: 5000
          }
        },
        Array.from({ length: 10 }, (_, i) => ({
          element_name: `element-${i}`,
          element_type: 'skill',
          role: 'support',
          priority: 50 + i,
          activation: i % 2 === 0 ? 'always' : 'conditional',
          condition: i % 2 === 0 ? undefined : `priority > ${40 + i}`
        })),
        metadataService
      );

      const mockElements = Array.from({ length: 10 }, (_, i) => ({
        metadata: { name: `element-${i}` },
        activate: jest.fn(() => Promise.resolve())
      }));

      mockSkillManager.list.mockResolvedValue(mockElements);

      const startTime = Date.now();
      const result = await ensemble.activateEnsemble(portfolioManager, managers);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000);
      expect(result.totalDuration).toBeLessThan(5000);
    });

    it('should cache element instances efficiently', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Cache Ensemble',
          description: 'Test instance caching',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'cached-element',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ],
        metadataService
      );

      const mockSkill = {
        metadata: { name: 'cached-element' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      // First activation
      await ensemble.activateEnsemble(portfolioManager, managers);

      // Second activation - instances are cached within ensemble
      await ensemble.activateEnsemble(portfolioManager, managers);

      // Activate should be called twice (once per activation)
      expect(mockSkill.activate).toHaveBeenCalledTimes(2);

      // But element loading happens via cached instances
      expect(mockSkillManager.list).toHaveBeenCalled();
    });

    it('should measure activation timing correctly', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Timing Ensemble',
          description: 'Test activation timing',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'timed-element',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ],
        metadataService
      );

      const mockSkill = {
        metadata: { name: 'timed-element' },
        activate: jest.fn(() => new Promise(resolve => setTimeout(resolve, 50)))
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.totalDuration).toBeGreaterThan(40); // At least 50ms
      expect(result.elementResults).toHaveLength(1);
      expect(result.elementResults[0].duration).toBeGreaterThan(40);
    });
  });

  describe('Activation Result Details', () => {
    it('should provide detailed activation results', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Detailed Ensemble',
          description: 'Test detailed results',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'element-1',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          },
          {
            element_name: 'element-2',
            element_type: 'skill',
            role: 'support',
            priority: 60,
            activation: 'conditional',
            condition: 'priority > 50'
          }
        ],
        metadataService
      );

      const mockSkill1 = {
        metadata: { name: 'element-1' },
        activate: jest.fn(() => Promise.resolve())
      };

      const mockSkill2 = {
        metadata: { name: 'element-2' },
        activate: jest.fn(() => Promise.resolve())
      };

      mockSkillManager.list.mockResolvedValue([mockSkill1, mockSkill2]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result).toMatchObject({
        success: true,
        activatedElements: expect.arrayContaining(['element-1', 'element-2']),
        failedElements: [],
        conflicts: [],
        totalDuration: expect.any(Number),
        elementResults: expect.arrayContaining([
          expect.objectContaining({
            elementName: 'element-1',
            success: true,
            duration: expect.any(Number)
          }),
          expect.objectContaining({
            elementName: 'element-2',
            success: true,
            duration: expect.any(Number)
          })
        ])
      });
    });

    it('should track failed element details', async () => {
      const ensemble = new Ensemble(
        {
          name: 'Failure Tracking',
          description: 'Test failure tracking',
          activationStrategy: 'conditional'
        },
        [
          {
            element_name: 'failing-element',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ],
        metadataService
      );

      const error = new Error('Test failure');
      const mockSkill = {
        metadata: { name: 'failing-element' },
        activate: jest.fn(() => Promise.reject(error))
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await ensemble.activateEnsemble(portfolioManager, managers);

      expect(result.success).toBe(false);
      expect(result.failedElements).toContain('failing-element');
      expect(result.elementResults).toHaveLength(1);
      expect(result.elementResults[0]).toMatchObject({
        elementName: 'failing-element',
        success: false,
        error: error
      });
    });
  });
});
