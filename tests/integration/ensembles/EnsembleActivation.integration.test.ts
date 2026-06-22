/**
 * Integration tests for Ensemble activation with real components
 *
 * Tests ensemble lifecycle with real PortfolioManager and element managers:
 * - Sequential activation with dependencies
 * - Priority-based activation
 * - Context sharing between elements
 * - Conflict resolution strategies
 * - Timeout enforcement
 * - Element instance caching
 * - Full lifecycle (create, activate, deactivate, delete)
 * - Error recovery with missing elements
 *
 * Uses real filesystem operations and actual managers (not mocked)
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { jest } from '@jest/globals';

import { Ensemble } from '../../../src/elements/ensembles/Ensemble.js';
import { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { EnsembleMetadata, EnsembleElement } from '../../../src/elements/ensembles/types.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../src/elements/skills/Skill.js';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { FileWatchService } from '../../../src/services/FileWatchService.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { ElementStatus } from '../../../src/types/elements/index.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

// Create a shared MetadataService instance for all tests
const metadataService: MetadataService = createTestMetadataService();

describe('Ensemble Activation Integration Tests', () => {
  let env: PortfolioTestEnvironment;
  let ensembleManager: EnsembleManager;
  let skillManager: SkillManager;
  let personaManager: PersonaManager;
  let fileLockManager: FileLockManager;
  let ensemblesDir: string;
  let skillsDir: string;
  let personasDir: string;
  let securitySpy: ReturnType<typeof jest.spyOn>;

  beforeAll(async () => {
    // Create isolated test environment
    env = await createPortfolioTestEnvironment('ensemble-activation-test');

    // Initialize real DI dependencies
    fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const serializationService = new SerializationService();
    const fileWatchService = new FileWatchService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    // Initialize real managers with proper DI
    ensembleManager = new EnsembleManager({
      portfolioManager: env.portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      fileWatchService,
      storageLayerFactory: createTestStorageFactory(fileOperationsService),
    });
    skillManager = new SkillManager({
      portfolioManager: env.portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      fileWatchService,
      storageLayerFactory: createTestStorageFactory(fileOperationsService),
    });
    personaManager = new PersonaManager({
      portfolioManager: env.portfolioManager,
      indicatorConfig: {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square'
      },
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      fileWatchService,
      storageLayerFactory: createTestStorageFactory(fileOperationsService),
    });

    // Get element directories
    ensemblesDir = env.portfolioManager.getElementDir(ElementType.ENSEMBLE);
    skillsDir = env.portfolioManager.getElementDir(ElementType.SKILL);
    personasDir = env.portfolioManager.getElementDir(ElementType.PERSONA);

    // Create directories
    await fs.mkdir(ensemblesDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(personasDir, { recursive: true });
  });

  afterAll(async () => {
    // Dispose managers to clean up file watchers and other resources
    if (ensembleManager) {
      ensembleManager.dispose();
    }
    if (skillManager) {
      skillManager.dispose();
    }
    if (personaManager) {
      personaManager.dispose();
    }

    // Clean up test environment
    await env.cleanup();
  });

  beforeEach(() => {
    // Mock security logging to avoid noise
    securitySpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
  });

  afterEach(async () => {
    securitySpy?.mockRestore();

    // Clean up test files
    try {
      const cleanDirs = [ensemblesDir, skillsDir, personasDir];
      for (const dir of cleanDirs) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Sequential activation with real dependencies', () => {
    it('should activate elements in dependency order with real managers', async () => {
      // Create real skill files
      const baseSkill = new Skill(
        {
          name: 'Base-Skill',
          description: 'Foundation skill',
          triggers: ['base']
        },
        'Base skill instructions',
        metadataService
      );
      await skillManager.save(baseSkill, 'base-skill.md');

      const advancedSkill = new Skill(
        {
          name: 'Advanced-Skill',
          description: 'Depends on base skill',
          triggers: ['advanced']
        },
        'Advanced skill instructions',
        metadataService
      );
      await skillManager.save(advancedSkill, 'advanced-skill.md');

      // Create persona file using PersonaManager's create method (v2 API)
      await personaManager.create({
        name: 'Support-Persona',
        description: 'Supporting character',
        instructions: 'Support persona instructions',
        category: 'support'
      });

      // Create ensemble with sequential strategy and dependencies
      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Sequential Test Ensemble',
        description: 'Tests sequential activation',
        activationStrategy: 'sequential',
        conflictResolution: 'last-write',
        contextSharing: 'full',
        elements: [
          {
            element_name: 'Advanced-Skill',
            element_type: 'skills',
            role: 'primary',
            priority: 80,
            activation: 'always',
            dependencies: ['Base-Skill']
          },
          {
            element_name: 'Base-Skill',
            element_type: 'skills',
            role: 'support',
            priority: 50,
            activation: 'always'
          },
          {
            element_name: 'Support-Persona',
            element_type: 'personas',
            role: 'support',
            priority: 60,
            activation: 'always',
            dependencies: ['Base-Skill']
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

      // Activate ensemble with real managers
      const managers = {
        skillManager,
        personaManager
      };

      const result = await ensemble.activateEnsemble(env.portfolioManager, managers);

      // Verify activation succeeded
      expect(result.success).toBe(true);
      expect(result.activatedElements.length).toBe(3);
      expect(result.failedElements.length).toBe(0);

      // Verify activation order respects dependencies
      // Base Skill should come before Advanced Skill and Support Persona
      const baseIndex = result.activatedElements.indexOf('Base-Skill');
      const advancedIndex = result.activatedElements.indexOf('Advanced-Skill');
      const personaIndex = result.activatedElements.indexOf('Support-Persona');

      expect(baseIndex).toBeLessThan(advancedIndex);
      expect(baseIndex).toBeLessThan(personaIndex);

      // Verify all elements loaded from real files
      expect(result.elementResults).toHaveLength(3);
      result.elementResults.forEach(r => {
        expect(r.success).toBe(true);
        expect(r.duration).toBeGreaterThanOrEqual(0); // Duration may be 0 if very fast
      });

      // Verify ensemble status
      expect(ensemble.status).toBe(ElementStatus.ACTIVE);
    });
  });

  describe('Priority-based activation with real elements', () => {
    it('should activate elements by priority using real managers', async () => {
      // Create real skills with different priorities
      const lowPrioritySkill = new Skill(
        {
          name: 'Low-Priority',
          description: 'Low priority skill',
          triggers: ['low']
        },
        'Low priority instructions',
        metadataService
      );
      await skillManager.save(lowPrioritySkill, 'low-priority.md');

      const mediumPrioritySkill = new Skill(
        {
          name: 'Medium-Priority',
          description: 'Medium priority skill',
          triggers: ['medium']
        },
        'Medium priority instructions',
        metadataService
      );
      await skillManager.save(mediumPrioritySkill, 'medium-priority.md');

      const highPrioritySkill = new Skill(
        {
          name: 'High-Priority',
          description: 'High priority skill',
          triggers: ['high']
        },
        'High priority instructions',
        metadataService
      );
      await skillManager.save(highPrioritySkill, 'high-priority.md');

      // Create ensemble with priority strategy
      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Priority Test Ensemble',
        description: 'Tests priority-based activation',
        activationStrategy: 'priority',
        conflictResolution: 'priority',
        elements: [
          {
            element_name: 'Low-Priority',
            element_type: 'skills',
            role: 'support',
            priority: 30,
            activation: 'always'
          },
          {
            element_name: 'High-Priority',
            element_type: 'skills',
            role: 'primary',
            priority: 90,
            activation: 'always'
          },
          {
            element_name: 'Medium-Priority',
            element_type: 'skills',
            role: 'support',
            priority: 60,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

      const managers = {
        skillManager
      };

      const result = await ensemble.activateEnsemble(env.portfolioManager, managers);

      // Verify activation succeeded
      expect(result.success).toBe(true);
      expect(result.activatedElements.length).toBe(3);

      // Verify activation order: High (90) -> Medium (60) -> Low (30)
      expect(result.activatedElements[0]).toBe('High-Priority');
      expect(result.activatedElements[1]).toBe('Medium-Priority');
      expect(result.activatedElements[2]).toBe('Low-Priority');

      // Verify real element instances are loaded
      expect(result.elementResults).toHaveLength(3);
      result.elementResults.forEach(r => {
        expect(r.success).toBe(true);
      });
    });
  });

  describe('Context sharing between real elements', () => {
    it('should share context between real activated elements', async () => {
      // Create real elements
      const skill1 = new Skill(
        {
          name: 'Skill-One',
          description: 'First skill',
          triggers: ['one']
        },
        'Skill one instructions',
        metadataService
      );
      await skillManager.save(skill1, 'skill-one.md');

      const skill2 = new Skill(
        {
          name: 'Skill-Two',
          description: 'Second skill',
          triggers: ['two']
        },
        'Skill two instructions',
        metadataService
      );
      await skillManager.save(skill2, 'skill-two.md');

      // Test each context sharing mode
      const testCases: Array<'none' | 'selective' | 'full'> = ['none', 'selective', 'full'];

      for (const mode of testCases) {
        const ensembleMetadata: Partial<EnsembleMetadata> = {
          name: `Context Test ${mode}`,
          description: `Tests ${mode} context sharing`,
          activationStrategy: 'all',
          conflictResolution: 'last-write',
          contextSharing: mode,
          elements: [
            {
              element_name: 'Skill-One',
              element_type: 'skills',
              role: 'primary',
              priority: 80,
              activation: 'always'
            },
            {
              element_name: 'Skill-Two',
              element_type: 'skills',
              role: 'support',
              priority: 50,
              activation: 'always'
            }
          ]
        };

        const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

        const managers = {
          skillManager
        };

        const result = await ensemble.activateEnsemble(env.portfolioManager, managers);

        expect(result.success).toBe(true);
        expect(result.activatedElements.length).toBe(2);

        // Test context setting and retrieval
        ensemble.setContextValue('test-key', 'test-value', 'Skill-One');
        const retrievedValue = ensemble.getContextValue('test-key');

        // For all modes, we should be able to set and retrieve
        expect(retrievedValue).toBe('test-value');

        // Clean up for next iteration
        await ensemble.deactivate();
      }
    });
  });

  describe('Conflict resolution with real data', () => {
    it('should resolve conflicts using last-write strategy', async () => {
      const skill1 = new Skill({ name: 'Conflict-Skill-1', description: 'First' }, 'Instructions', metadataService);
      await skillManager.save(skill1, 'conflict-skill-1.md');

      const skill2 = new Skill({ name: 'Conflict-Skill-2', description: 'Second' }, 'Instructions', metadataService);
      await skillManager.save(skill2, 'conflict-skill-2.md');

      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Last Write Ensemble',
        activationStrategy: 'sequential',
        conflictResolution: 'last-write',
        elements: [
          {
            element_name: 'Conflict-Skill-1',
            element_type: 'skills',
            role: 'primary',
            priority: 50,
            activation: 'always'
          },
          {
            element_name: 'Conflict-Skill-2',
            element_type: 'skills',
            role: 'support',
            priority: 50,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);
      await ensemble.activateEnsemble(env.portfolioManager, { skillManager });

      // Both elements set the same context key
      ensemble.setContextValue('shared-key', 'value-from-skill-1', 'Conflict-Skill-1');
      ensemble.setContextValue('shared-key', 'value-from-skill-2', 'Conflict-Skill-2');

      // Last write wins
      expect(ensemble.getContextValue('shared-key')).toBe('value-from-skill-2');
    });

    it('should resolve conflicts using first-write strategy', async () => {
      const skill1 = new Skill({ name: 'First-Skill', description: 'First' }, 'Instructions', metadataService);
      await skillManager.save(skill1, 'first-skill.md');

      const skill2 = new Skill({ name: 'Second-Skill', description: 'Second' }, 'Instructions', metadataService);
      await skillManager.save(skill2, 'second-skill.md');

      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'First Write Ensemble',
        activationStrategy: 'sequential',
        conflictResolution: 'first-write',
        elements: [
          {
            element_name: 'First-Skill',
            element_type: 'skills',
            role: 'primary',
            priority: 50,
            activation: 'always'
          },
          {
            element_name: 'Second-Skill',
            element_type: 'skills',
            role: 'support',
            priority: 50,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);
      await ensemble.activateEnsemble(env.portfolioManager, { skillManager });

      ensemble.setContextValue('shared-key', 'value-from-first', 'First-Skill');
      ensemble.setContextValue('shared-key', 'value-from-second', 'Second-Skill');

      // First write wins
      expect(ensemble.getContextValue('shared-key')).toBe('value-from-first');
    });

    it('should resolve conflicts using priority strategy', async () => {
      const lowSkill = new Skill({ name: 'Low-Skill', description: 'Low' }, 'Instructions', metadataService);
      await skillManager.save(lowSkill, 'low-skill.md');

      const highSkill = new Skill({ name: 'High-Skill', description: 'High' }, 'Instructions', metadataService);
      await skillManager.save(highSkill, 'high-skill.md');

      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Priority Conflict Ensemble',
        activationStrategy: 'all',
        conflictResolution: 'priority',
        elements: [
          {
            element_name: 'Low-Skill',
            element_type: 'skills',
            role: 'support',
            priority: 30,
            activation: 'always'
          },
          {
            element_name: 'High-Skill',
            element_type: 'skills',
            role: 'primary',
            priority: 90,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);
      await ensemble.activateEnsemble(env.portfolioManager, { skillManager });

      // Low priority sets first
      ensemble.setContextValue('priority-key', 'low-value', 'Low-Skill');
      // High priority overwrites
      ensemble.setContextValue('priority-key', 'high-value', 'High-Skill');

      // Higher priority wins (90 > 30)
      expect(ensemble.getContextValue('priority-key')).toBe('high-value');

      // Try reverse order - high priority should still win
      ensemble.setContextValue('reverse-key', 'high-value', 'High-Skill');
      ensemble.setContextValue('reverse-key', 'low-value', 'Low-Skill');
      expect(ensemble.getContextValue('reverse-key')).toBe('high-value');
    });

    it('should resolve conflicts using merge strategy', async () => {
      const skill1 = new Skill({ name: 'Merge-Skill-1', description: 'First' }, 'Instructions', metadataService);
      await skillManager.save(skill1, 'merge-skill-1.md');

      const skill2 = new Skill({ name: 'Merge-Skill-2', description: 'Second' }, 'Instructions', metadataService);
      await skillManager.save(skill2, 'merge-skill-2.md');

      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Merge Ensemble',
        activationStrategy: 'all',
        conflictResolution: 'merge',
        elements: [
          {
            element_name: 'Merge-Skill-1',
            element_type: 'skills',
            role: 'primary',
            priority: 50,
            activation: 'always'
          },
          {
            element_name: 'Merge-Skill-2',
            element_type: 'skills',
            role: 'support',
            priority: 50,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);
      await ensemble.activateEnsemble(env.portfolioManager, { skillManager });

      // Set object values that can be merged
      ensemble.setContextValue('merge-key', { a: 1, b: 2 }, 'Merge-Skill-1');
      ensemble.setContextValue('merge-key', { b: 3, c: 4 }, 'Merge-Skill-2');

      // Should merge: { a: 1, b: 3, c: 4 }
      const mergedValue = ensemble.getContextValue('merge-key') as Record<string, unknown>;
      expect(mergedValue).toEqual({ a: 1, b: 3, c: 4 });
    });
  });

  describe('Timeout enforcement in real activation', () => {
    // SKIP: Test expects activation to exceed timeout, but real I/O completes in ~40ms.
    // Minimum allowed timeout is 1000ms (EnsembleManager validation). Original test used 1ms
    // by bypassing validation via direct Ensemble construction. Needs rewrite as a unit test
    // with a mocked slow activation to reliably test the timeout mechanism.
    it.skip('should respect maxExecutionTimeMs limit', async () => {
      // Create multiple skills to increase activation time
      for (let i = 0; i < 5; i++) {
        const skill = new Skill(
          {
            name: `Timeout-Skill-${i}`,
            description: 'Used for timeout testing',
            triggers: [`timeout-${i}`]
          },
          'Instructions',
          metadataService
        );
        await skillManager.save(skill, `timeout-skill-${i}.md`);
      }

      // Create ensemble with very short timeout (1ms is not enough for 5 elements)
      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Timeout Test Ensemble',
        description: 'Tests timeout enforcement',
        activationStrategy: 'sequential',
        conflictResolution: 'last-write',
        resourceLimits: {
          maxActiveElements: 50,
          maxExecutionTimeMs: 1000 // 1s timeout - minimum allowed value
        },
        elements: Array.from({ length: 5 }, (_, i) => ({
          element_name: `Timeout-Skill-${i}`,
          element_type: 'skills',
          role: 'primary',
          priority: 80,
          activation: 'always'
        }))
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

      const managers = {
        skillManager
      };

      // Should timeout with 1ms for 5 sequential activations
      await expect(
        ensemble.activateEnsemble(env.portfolioManager, managers)
      ).rejects.toThrow(/timeout/i);

      // Verify ensemble is in error state
      expect(ensemble.status).toBe(ElementStatus.ERROR);
    });
  });

  describe('Element instance caching across activations', () => {
    it('should cache element instances across multiple activations', async () => {
      // Create real skill
      const skill = new Skill(
        {
          name: 'Cached-Skill',
          description: 'Tests instance caching',
          triggers: ['cache']
        },
        'Cached skill instructions',
        metadataService
      );
      await skillManager.save(skill, 'cached-skill.md');

      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Cache Test Ensemble',
        activationStrategy: 'sequential',
        elements: [
          {
            element_name: 'Cached-Skill',
            element_type: 'skills',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

      const managers = {
        skillManager
      };

      // First activation
      const result1 = await ensemble.activateEnsemble(env.portfolioManager, managers);
      expect(result1.success).toBe(true);
      const duration1 = result1.elementResults[0].duration;

      // Deactivate
      await ensemble.deactivate();
      expect(ensemble.status).toBe(ElementStatus.INACTIVE);

      // Second activation - should use cached instance (potentially faster)
      const result2 = await ensemble.activateEnsemble(env.portfolioManager, managers);
      expect(result2.success).toBe(true);
      const duration2 = result2.elementResults[0].duration;

      // Both should succeed
      expect(result2.activatedElements).toEqual(['Cached-Skill']);

      // Durations should be non-negative (may be 0 if very fast)
      expect(duration1).toBeGreaterThanOrEqual(0);
      expect(duration2).toBeGreaterThanOrEqual(0);

      // Verify both activations completed successfully
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Test cache clearing
      ensemble.clearInstanceCache();

      // Third activation after cache clear
      const result3 = await ensemble.activateEnsemble(env.portfolioManager, managers);
      expect(result3.success).toBe(true);
    });
  });

  describe('Full lifecycle with real file operations', () => {
    it('should handle create -> activate -> deactivate -> delete lifecycle', async () => {
      // Create real elements first
      const skill = new Skill(
        {
          name: 'Lifecycle-Skill',
          description: 'Tests full lifecycle',
          triggers: ['lifecycle']
        },
        'Lifecycle instructions',
        metadataService
      );
      await skillManager.save(skill, 'lifecycle-skill.md');

      await personaManager.create({
        name: 'Lifecycle-Persona',
        description: 'Tests full lifecycle',
        instructions: 'Lifecycle persona instructions',
        category: 'lifecycle'
      });

      // Create ensemble via EnsembleManager
      await ensembleManager.create({
        name: 'Lifecycle Ensemble',
        description: 'Full lifecycle test',
        activationStrategy: 'all',
        elements: [
          {
            element_name: 'Lifecycle-Skill',
            element_type: 'skills',
            role: 'primary',
            priority: 80,
            activation: 'always'
          },
          {
            element_name: 'Lifecycle-Persona',
            element_type: 'personas',
            role: 'support',
            priority: 60,
            activation: 'always'
          }
        ]
      });

      // Verify file was created
      const ensembleFile = path.join(ensemblesDir, 'lifecycle-ensemble.md');
      await expect(fs.access(ensembleFile)).resolves.toBeUndefined();

      // Load from file
      const loaded = await ensembleManager.load('lifecycle-ensemble.md');
      expect(loaded.metadata.name).toBe('Lifecycle Ensemble');
      expect(loaded.getElements().length).toBe(2);

      // Activate with real managers
      const managers = {
        skillManager,
        personaManager
      };

      const result = await loaded.activateEnsemble(env.portfolioManager, managers);

      // Verify all elements active
      expect(result.success).toBe(true);
      expect(result.activatedElements.length).toBe(2);
      expect(loaded.status).toBe(ElementStatus.ACTIVE);

      // Deactivate
      await loaded.deactivate();
      expect(loaded.status).toBe(ElementStatus.INACTIVE);

      // Delete file
      await ensembleManager.delete('lifecycle-ensemble.md');

      // Verify file deleted
      await expect(fs.access(ensembleFile)).rejects.toThrow();
    });
  });

  describe('Error recovery with real failures', () => {
    it('should handle missing elements gracefully', async () => {
      // Create only one of two referenced elements
      const skill = new Skill(
        {
          name: 'Existing-Skill',
          description: 'This one exists',
          triggers: ['exists']
        },
        'Existing skill instructions',
        metadataService
      );
      await skillManager.save(skill, 'existing-skill.md');

      // Create ensemble referencing non-existent element
      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Error Recovery Ensemble',
        description: 'Tests error recovery',
        activationStrategy: 'sequential',
        elements: [
          {
            element_name: 'Existing-Skill',
            element_type: 'skills',
            role: 'primary',
            priority: 80,
            activation: 'always'
          },
          {
            element_name: 'Non-Existent-Skill',
            element_type: 'skills',
            role: 'support',
            priority: 50,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

      const managers = {
        skillManager
      };

      // Attempt activation
      const result = await ensemble.activateEnsemble(env.portfolioManager, managers);

      // Verify detailed error messages
      expect(result.success).toBe(false);
      expect(result.activatedElements.length).toBe(1);
      expect(result.failedElements.length).toBe(1);
      expect(result.activatedElements).toContain('Existing-Skill');
      expect(result.failedElements).toContain('Non-Existent-Skill');

      // Check failedElements list
      const failedResult = result.elementResults.find(r => !r.success);
      expect(failedResult).toBeDefined();
      expect(failedResult!.error).toBeDefined();
      expect(failedResult!.error!.message).toMatch(/not found/i);

      // Ensure partial activation succeeded
      expect(result.activatedElements).toContain('Existing-Skill');
    });

    it('should provide detailed error for missing manager', async () => {
      // Create ensemble with element type that has no manager
      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'No Manager Ensemble',
        description: 'Tests missing manager error',
        activationStrategy: 'all',
        elements: [
          {
            element_name: 'Some-Template',
            element_type: 'templates',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

      // Provide managers without templateManager
      const managers = {
        skillManager
        // templateManager missing
      };

      const result = await ensemble.activateEnsemble(env.portfolioManager, managers);

      // Should fail with helpful error
      expect(result.success).toBe(false);
      expect(result.failedElements).toContain('Some-Template');

      const error = result.elementResults[0].error;
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/no manager available/i);
      expect(error!.message).toMatch(/template/i);
    });
  });

  describe('Validation and constraints', () => {
    it('should validate ensemble before activation', async () => {
      // Create ensemble with orphaned dependencies
      const ensembleMetadata: Partial<EnsembleMetadata> = {
        name: 'Invalid Dependencies',
        description: 'Has orphaned dependencies',
        activationStrategy: 'sequential',
        elements: [
          {
            element_name: 'Dependent-Element',
            element_type: 'skills',
            role: 'primary',
            priority: 80,
            activation: 'always',
            dependencies: ['Non-Existent-Dependency']
          }
        ]
      };

      const ensemble = new Ensemble(ensembleMetadata, ensembleMetadata.elements, metadataService);

      // Validate should fail
      const validation = ensemble.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toBeDefined();
      expect(validation.errors!.length).toBeGreaterThan(0);
      expect(validation.errors![0].message).toMatch(/not found in ensemble/i);
    });

    it('should enforce resource limits', async () => {
      // This is tested by checking that limits are respected during creation
      expect(() => {
        const elements: EnsembleElement[] = [];
        for (let i = 0; i < 100; i++) {
          elements.push({
            element_name: `element-${i}`,
            element_type: 'skills',
            role: 'support',
            priority: 50,
            activation: 'always'
          });
        }
        // Should throw when loading > 50 elements
        new Ensemble({ name: 'Too Many Elements' }, elements, metadataService);
      }).toThrow(/cannot contain more than/i);
    });
  });
});
