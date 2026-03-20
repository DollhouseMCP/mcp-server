/**
 * Tests for EnhancedIndexManager.extractActionTriggers method
 *
 * Validates the enhanced verb extraction functionality including:
 * - Extraction from search.triggers field
 * - Extraction from actions field
 * - Extraction from keywords with verb detection
 * - Edge cases and security considerations
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EnhancedIndexManager } from '../../../src/portfolio/EnhancedIndexManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PortfolioIndexManager } from '../../../src/portfolio/PortfolioIndexManager.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { NLPScoringManager } from '../../../src/portfolio/NLPScoringManager.js';
import { VerbTriggerManager } from '../../../src/portfolio/VerbTriggerManager.js';
import { RelationshipManager } from '../../../src/portfolio/RelationshipManager.js';
import { DefaultEnhancedIndexHelpers } from '../../../src/portfolio/enhanced-index/EnhancedIndexHelpers.js';
import { ElementDefinitionBuilder } from '../../../src/portfolio/enhanced-index/ElementDefinitionBuilder.js';
import { SemanticRelationshipService } from '../../../src/portfolio/enhanced-index/SemanticRelationshipService.js';
import { ActionTriggerExtractor } from '../../../src/portfolio/enhanced-index/ActionTriggerExtractor.js';
import { TriggerMetricsTracker } from '../../../src/portfolio/enhanced-index/TriggerMetricsTracker.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';
import type { ElementDefinition } from '../../../src/portfolio/EnhancedIndexManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { dump as yamlDump } from 'js-yaml';
import { logger } from '../../../src/utils/logger.js';

describe('EnhancedIndexManager.extractActionTriggers', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof EnhancedIndexManager>;
  let triggers: Record<string, string[]>;
  let testDir: string;
  let portfolioPath: string;
  let loggerWarnSpy: any;

  beforeEach(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-triggers-test-'));
    process.env.HOME = testDir;

    // Set up portfolio directory structure
    portfolioPath = path.join(testDir, '.dollhouse', 'portfolio');
    const testIndexPath = path.join(portfolioPath, 'capability-index.yaml');

    // Create subdirectories for element types
    await fs.mkdir(path.join(portfolioPath, 'personas'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'skills'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'templates'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'agents'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'memories'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'ensembles'), { recursive: true });

    // Create a minimal portfolio index
    const portfolioIndexPath = path.join(portfolioPath, 'index.json');
    await fs.writeFile(portfolioIndexPath, JSON.stringify({
      version: '1.0.0',
      entries: [],
      metadata: {
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    }));

    // Create a pre-built capability index
    const minimalIndex = {
      version: '2.0.0',
      metadata: {
        version: '2.0.0',
        created: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        total_elements: 0
      },
      action_triggers: {},
      elements: {},
      context: {
        recent_elements: [],
        session_patterns: {}
      },
      scoring: {
        corpus_stats: {
          total_documents: 0,
          average_length: 0
        }
      }
    };

    await fs.writeFile(testIndexPath, yamlDump(minimalIndex));

    // Create config file
    const configPath = path.join(portfolioPath, 'config', 'enhanced-index.yaml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, yamlDump({
      index: {
        ttlMinutes: 5,
        version: '2.0.0'
      },
      performance: {
        similarityThreshold: 0.3,
        maxElementsForFullMatrix: 100
      }
    }));

    // Create DI container and register all dependencies
    container = new DollhouseContainer();
    container.register('IndexConfigManager', () => new IndexConfigManager());
    const fileOperationsService = createTestFileOperationsService();
    container.register('FileOperationsService', () => fileOperationsService);
    container.register('ConfigManager', () => new ConfigManager(
      container.resolve('FileOperationsService'),
      os
    ));
    container.register('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: portfolioPath }));
    container.register('PortfolioIndexManager', () => new PortfolioIndexManager(
      container.resolve('IndexConfigManager'),
      container.resolve('PortfolioManager'),
      container.resolve('FileOperationsService')
    ));
    container.register('NLPScoringManager', () => new NLPScoringManager(
      container.resolve('IndexConfigManager')
    ));
    container.register('VerbTriggerManager', () => new VerbTriggerManager(
      container.resolve('IndexConfigManager')
    ));
    container.register('RelationshipManager', () => new RelationshipManager(
      container.resolve('IndexConfigManager')
    ));
    container.register('EnhancedIndexHelpers', () => new DefaultEnhancedIndexHelpers(
      new ElementDefinitionBuilder(),
      new SemanticRelationshipService({
        nlpScoring: container.resolve('NLPScoringManager'),
        relationshipManager: container.resolve('RelationshipManager')
      }),
      (context) => new ActionTriggerExtractor(context),
      (options) => new TriggerMetricsTracker(options)
    ));
    container.register('EnhancedIndexManager', () => new EnhancedIndexManager(
      container.resolve('IndexConfigManager'),
      container.resolve('ConfigManager'),
      container.resolve('PortfolioIndexManager'),
      container.resolve('NLPScoringManager'),
      container.resolve('VerbTriggerManager'),
      container.resolve('RelationshipManager'),
      container.resolve('EnhancedIndexHelpers'),
      container.resolve('FileOperationsService')
    ));

    // Resolve manager from container
    manager = container.resolve('EnhancedIndexManager');
    triggers = {};

    // Spy on logger methods
    loggerWarnSpy = jest.spyOn(logger, 'warn');
  });

  afterEach(async () => {
    // Cleanup manager
    if (manager) {
      try {
        await manager.cleanup();
      } catch (_e) {
        // Ignore cleanup errors
      }
    }

    // Dispose container
    await container.dispose();

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });

    // Restore all mocks
    jest.restoreAllMocks();
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

      // Should log warning when limit is exceeded
      if (triggerCount === 50) {
        expect(loggerWarnSpy).toHaveBeenCalledWith(
          'Trigger limit exceeded for element',
          expect.objectContaining({ elementName: 'test-element' })
        );
      }
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
