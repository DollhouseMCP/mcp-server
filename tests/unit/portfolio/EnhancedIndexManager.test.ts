/**
 * Tests for EnhancedIndexManager - Demonstrating extensibility
 */

import { EnhancedIndexManager } from '../../../src/portfolio/EnhancedIndexManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PortfolioIndexManager } from '../../../src/portfolio/PortfolioIndexManager.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { NLPScoringManager } from '../../../src/portfolio/NLPScoringManager.js';
import { VerbTriggerManager } from '../../../src/portfolio/VerbTriggerManager.js';
import { RelationshipManager } from '../../../src/portfolio/RelationshipManager.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { DefaultEnhancedIndexHelpers } from '../../../src/portfolio/enhanced-index/EnhancedIndexHelpers.js';
import { ElementDefinitionBuilder } from '../../../src/portfolio/enhanced-index/ElementDefinitionBuilder.js';
import { SemanticRelationshipService } from '../../../src/portfolio/enhanced-index/SemanticRelationshipService.js';
import { ActionTriggerExtractor } from '../../../src/portfolio/enhanced-index/ActionTriggerExtractor.js';
import { TriggerMetricsTracker } from '../../../src/portfolio/enhanced-index/TriggerMetricsTracker.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

describe('EnhancedIndexManager - Extensibility Tests', () => {
  // Fixed issues:
  // 1. Reduced max comparisons from 500 to 100
  // 2. Added timeout circuit breakers (5 second max)
  // 3. Removed circular dependency with VerbTriggerManager
  // 4. Added proper cleanup to prevent file locking
  // 5. Converted to DI container pattern
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof EnhancedIndexManager>;
  let testDir: string;
  let testIndexPath: string;
  let portfolioPath: string;

  beforeEach(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enhanced-index-test-'));
    process.env.HOME = testDir;

    // Set up portfolio directory structure and minimal required files
    portfolioPath = path.join(testDir, '.dollhouse', 'portfolio');
    testIndexPath = path.join(portfolioPath, 'capability-index.yaml');

    // Create subdirectories for element types
    await fs.mkdir(path.join(portfolioPath, 'personas'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'skills'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'templates'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'agents'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'memories'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'ensembles'), { recursive: true });

    // Create a minimal portfolio index to prevent scanning errors
    const portfolioIndexPath = path.join(portfolioPath, 'index.json');
    await fs.writeFile(portfolioIndexPath, JSON.stringify({
      version: '1.0.0',
      entries: [],
      metadata: {
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    }));

    // Create a pre-built capability index with a recent timestamp to avoid rebuilding
    const minimalIndex = {
      version: '2.0.0',
      metadata: {
        version: '2.0.0',
        created: new Date().toISOString(),
        last_updated: new Date().toISOString(),  // Current time = fresh index
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

    // Create an empty config file to prevent loading issues
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

    // Register dependencies in dependency order
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
  });

  afterEach(async () => {
    // Use the new cleanup method to properly release resources
    if (manager) {
      try {
        await manager.cleanup();
      } catch (e) {
        // Ignore errors during cleanup
        console.warn('Error during manager cleanup:', e);
      }
    }

    // Dispose DI container
    await container.dispose();

    // Clean up test environment
    await fs.rm(testDir, { recursive: true, force: true });
  }, 30000);  // Increase timeout for cleanup

  describe('Schema Extensibility', () => {
    it('should support arbitrary element types without code changes', async () => {
      // Skip if initialization is hanging
      if (!manager) {
        console.warn('Manager not initialized, skipping test');
        return;
      }

      // Add a completely new element type
      // Use the pre-built index to avoid rebuilding
      const index = await manager.getIndex({ forceRebuild: false });

      // Demonstrate adding a new element type at runtime
      index.elements['workflows'] = {
        'data-processing-workflow': {
          core: {
            name: 'Data Processing Workflow',
            type: 'workflows',
            version: '1.0.0',
            description: 'ETL pipeline for user data'
          },
          // Custom fields specific to workflows
          custom: {
            steps: ['extract', 'transform', 'load'],
            schedule: '0 0 * * *',
            dependencies: ['database', 'cache'],
            retryPolicy: {
              maxRetries: 3,
              backoffMultiplier: 2
            }
          }
        }
      };

      // Verify the index was updated in memory
      expect(index.elements['workflows']).toBeDefined();
      expect(index.elements['workflows']?.['data-processing-workflow']?.custom?.schedule).toBe('0 0 * * *');

      // Save and verify persistence
      await manager.persist();

      // Force a fresh read from disk (not from cache)
      (manager as any).index = null;  // Clear cache
      const reloadedIndex = await manager.getIndex({ forceRebuild: false });

      expect(reloadedIndex.elements['workflows']).toBeDefined();
      expect(reloadedIndex.elements['workflows']?.['data-processing-workflow']?.custom?.schedule).toBe('0 0 * * *');
    });

    it('should handle nested custom fields and complex structures', async () => {
      const index = await manager.getIndex({ forceRebuild: false });

      // Add an element with deeply nested structures
      index.elements['pipelines'] = {
        'ml-training-pipeline': {
          core: {
            name: 'ML Training Pipeline',
            type: 'pipelines',
            version: '1.0.0',
            description: 'Machine learning model training pipeline'
          },
          custom: {
            stages: {
              preprocessing: {
                steps: ['normalize', 'augment', 'validate'],
                resources: {
                  cpu: '4 cores',
                  memory: '16GB',
                  gpu: 'optional'
                }
              },
              training: {
                algorithm: 'neural-network',
                hyperparameters: {
                  learningRate: 0.001,
                  batchSize: 32,
                  epochs: 100
                }
              },
              evaluation: {
                metrics: ['accuracy', 'precision', 'recall', 'f1-score'],
                thresholds: {
                  accuracy: 0.95,
                  f1Score: 0.90
                }
              }
            }
          },
          // Extensions can also be added
          extensions: {
            monitoring: {
              alerting: true,
              dashboardUrl: 'https://example.com/dashboard'
            }
          }
        } as any // Test extensibility - allows unknown fields
      };

      await manager.persist();

      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.pipelines?.['ml-training-pipeline']?.custom?.stages?.training?.hyperparameters?.learningRate).toBe(0.001);
      expect((reloaded.elements.pipelines?.['ml-training-pipeline'] as any)?.extensions?.monitoring?.alerting).toBe(true);
    });

    it('should preserve unknown fields during read-modify-write cycles', async () => {
      // Manually write a YAML file with unknown fields
      const customYaml = {
        version: '2.0.0',
        metadata: {
          created: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          total_elements: 2,
          // Unknown field - future schema version might add this
          futureFeature: 'some-value'
        },
        elements: {
          // Standard type
          personas: {
            'test-persona': {
              core: {
                name: 'test-persona',
                type: 'personas',
                version: '1.0.0',
                description: 'Test'
              }
            }
          },
          // Future type with unknown fields
          'quantum-agents': {
            'quantum-1': {
              core: {
                name: 'quantum-1',
                type: 'quantum-agents',
                version: '1.0.0',
                description: 'Quantum computing agent'
              },
              // Unknown structure - future feature
              quantumConfig: {
                qubits: 128,
                entanglementLevel: 'high',
                coherenceTime: '100ms'
              }
            }
          }
        },
        action_triggers: {},
        // Unknown top-level field - future extension
        experimentalFeatures: {
          enabled: true,
          features: ['quantum', 'neural-link']
        }
      };

      await fs.writeFile(testIndexPath, yamlDump(customYaml), 'utf-8');

      // Load through the manager (verify no error on unknown fields)
      const index = await manager.getIndex({ forceRebuild: false });

      // Verify known fields loaded correctly
      expect(index.metadata.total_elements).toBe(2);
      expect(index.elements.personas?.['test-persona']).toBeDefined();
      expect(index.elements['quantum-agents']?.['quantum-1']).toBeDefined();

      // Persist the index (write back to disk)
      await manager.persist();

      // Read the file directly and verify unknown fields are preserved
      const fileContent = await fs.readFile(testIndexPath, 'utf-8');
      const parsed = yamlLoad(fileContent) as any;

      // Verify unknown metadata field preserved
      expect(parsed.metadata.futureFeature).toBe('some-value');

      // Verify unknown element type preserved
      expect(parsed.elements['quantum-agents']).toBeDefined();
      expect(parsed.elements['quantum-agents']['quantum-1'].quantumConfig).toBeDefined();
      expect(parsed.elements['quantum-agents']['quantum-1'].quantumConfig.qubits).toBe(128);

      // Verify unknown top-level field preserved
      expect(parsed.experimentalFeatures).toBeDefined();
      expect(parsed.experimentalFeatures.features).toContain('quantum');
      expect(parsed.experimentalFeatures.features).toContain('neural-link');
    });

    it('should support custom indexing and search fields', async () => {
      const index = await manager.getIndex({ forceRebuild: false });

      // Add elements with custom search fields
      index.elements['commands'] = {
        'deploy-command': {
          core: {
            name: 'Deploy Command',
            type: 'commands',
            version: '1.0.0',
            description: 'Deployment automation command'
          },
          custom: {
            // Custom fields that could be indexed
            tags: ['deployment', 'automation', 'ci-cd'],
            category: 'devops',
            permissions: ['admin', 'deploy'],
            searchKeywords: ['deploy', 'release', 'production', 'rollout']
          }
        }
      };

      await manager.persist();

      // Future: Could implement search functionality
      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.commands?.['deploy-command']?.custom?.tags).toContain('automation');
    });

    it('should handle migration scenarios with version compatibility', async () => {
      const index = await manager.getIndex({ forceRebuild: false });

      // Simulate a v1 element
      index.elements['migrations'] = {
        'v1-element': {
          core: {
            name: 'Legacy Element',
            type: 'migrations',
            version: '1.0.0',
            description: 'Element from v1 schema'
          },
          // v1 structure
          legacyField: 'old-value',
          deprecatedConfig: {
            oldSetting: true
          }
        } as any // Test extensibility - allows unknown fields
      };

      await manager.persist();

      // Future: Migration logic could transform this to v2 format
      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect((reloaded.elements.migrations['v1-element'] as any).legacyField).toBe('old-value');
    });

    it('should allow custom validation rules through extensions', async () => {
      const index = await manager.getIndex({ forceRebuild: false });

      // Add element with validation rules
      index.elements['validators'] = {
        'input-validator': {
          core: {
            name: 'Input Validator',
            type: 'validators',
            version: '1.0.0',
            description: 'Input validation rules'
          },
          custom: {
            rules: [
              { field: 'email', type: 'email', required: true },
              { field: 'age', type: 'number', min: 18, max: 120 },
              { field: 'username', type: 'string', pattern: '^[a-zA-Z0-9_]+$' }
            ]
          },
          extensions: {
            validation: {
              strictMode: true,
              customValidators: ['checksum', 'luhn']
            }
          }
        } as any // Test extensibility - allows unknown fields
      };

      await manager.persist();
      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.validators?.['input-validator']?.custom?.rules).toHaveLength(3);
      expect((reloaded.elements.validators?.['input-validator'] as any)?.extensions?.validation?.strictMode).toBe(true);
    });

    it('should support plugin-style extensions', async () => {
      const index = await manager.getIndex({ forceRebuild: false });

      // Add plugin-style element
      index.elements['plugins'] = {
        'analytics-plugin': {
          core: {
            name: 'Analytics Plugin',
            type: 'plugins',
            version: '2.1.0',
            description: 'User analytics tracking plugin'
          },
          custom: {
            hooks: {
              'on-user-login': 'trackLogin',
              'on-page-view': 'trackPageView',
              'on-purchase': 'trackPurchase'
            },
            configuration: {
              apiKey: '${ANALYTICS_API_KEY}',
              endpoint: 'https://analytics.example.com',
              batchSize: 100,
              flushInterval: 5000
            }
          }
        }
      };

      await manager.persist();
      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.plugins?.['analytics-plugin']?.custom?.hooks?.['on-user-login']).toBe('trackLogin');
    });
  });

  describe('Defensive Error Handling', () => {
    it('should rebuild when YAML loads as null', async () => {
      // Write empty file (which yamlLoad returns as null)
      await fs.writeFile(testIndexPath, '', 'utf-8');

      // Should rebuild index without throwing
      const index = await manager.getIndex({ forceRebuild: false });

      // Should have valid structure after rebuild
      expect(index).toBeDefined();
      expect(index.metadata).toBeDefined();
      expect(index.elements).toBeDefined();
      expect(index.action_triggers).toBeDefined();
    });

    it('should handle undefined metadata gracefully', async () => {
      // Write YAML without metadata
      const malformedYaml = `
elements:
  personas: {}
action_triggers: {}
`;
      await fs.writeFile(testIndexPath, malformedYaml, 'utf-8');

      // Should rebuild index without throwing
      const index = await manager.getIndex({ forceRebuild: false });

      // Should have valid metadata after rebuild
      expect(index.metadata).toBeDefined();
      expect(index.metadata.version).toBeDefined();
    });

    it('should handle missing elements structure', async () => {
      // Write YAML with missing elements
      const incompleteYaml = `
metadata:
  version: '2.0.0'
  created: '2024-01-01T00:00:00Z'
  last_updated: '2024-01-01T00:00:00Z'
  total_elements: 0
action_triggers: {}
`;
      await fs.writeFile(testIndexPath, incompleteYaml, 'utf-8');

      // Should rebuild index without throwing
      const index = await manager.getIndex({ forceRebuild: false });

      // Should have valid elements structure after rebuild
      expect(index.elements).toBeDefined();
      expect(typeof index.elements).toBe('object');
    });

    it('should handle completely malformed YAML gracefully', async () => {
      // Write invalid YAML that will cause parse error
      const invalidYaml = `
this is not: valid: yaml: at all
  - mixed indentation
    and broken: syntax: everywhere
`;
      await fs.writeFile(testIndexPath, invalidYaml, 'utf-8');

      // Should handle parse error and rebuild
      const index = await manager.getIndex({ forceRebuild: false });

      // Should have valid structure after error handling
      expect(index).toBeDefined();
      expect(index.metadata).toBeDefined();
      expect(index.elements).toBeDefined();
    });
  });
});
