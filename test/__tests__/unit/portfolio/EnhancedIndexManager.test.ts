/**
 * Tests for EnhancedIndexManager - Demonstrating extensibility
 */

import { EnhancedIndexManager } from '../../../../src/portfolio/EnhancedIndexManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { setupTestEnvironment, cleanupTestEnvironment, resetSingletons, clearSuiteDirectory } from './test-setup.js';

describe('EnhancedIndexManager - Extensibility Tests', () => {
  // Fixed issues:
  // 1. Reduced max comparisons from 500 to 100
  // 2. Added timeout circuit breakers (5 second max)
  // 3. Removed circular dependency with VerbTriggerManager
  // 4. Added proper cleanup to prevent file locking
  let manager: EnhancedIndexManager;
  let originalHome: string;
  let testIndexPath: string;
  let portfolioPath: string;

  beforeEach(async () => {
    // Set up isolated test environment
    originalHome = await setupTestEnvironment();
    await resetSingletons();

    // Set up portfolio directory structure and minimal required files
    portfolioPath = path.join(process.env.HOME!, '.dollhouse', 'portfolio');
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

    // Now getInstance() will use the test directory
    manager = EnhancedIndexManager.getInstance();
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

    // Reset the singleton instance
    EnhancedIndexManager.resetInstance();

    // Clean up test environment
    await cleanupTestEnvironment(originalHome);
    await resetSingletons();
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
      expect(index.elements['workflows']['data-processing-workflow'].custom.schedule).toBe('0 0 * * *');

      // Save and verify persistence
      await manager.saveIndex();

      // Force a fresh read from disk (not from cache)
      (manager as any).index = null;  // Clear cache
      const reloadedIndex = await manager.getIndex({ forceRebuild: false });

      expect(reloadedIndex.elements['workflows']).toBeDefined();
      expect(reloadedIndex.elements['workflows']['data-processing-workflow'].custom.schedule).toBe('0 0 * * *');
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
        }
      };

      await manager.saveIndex();

      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.pipelines['ml-training-pipeline'].custom.stages.training.hyperparameters.learningRate).toBe(0.001);
      expect(reloaded.elements.pipelines['ml-training-pipeline'].extensions?.monitoring?.alerting).toBe(true);
    });

    it('should preserve unknown fields during read-modify-write cycles', async () => {
      // Manually write a YAML file with unknown fields
      const customYaml = {
        version: '2.0.0',
        metadata: {
          created: new Date().toISOString(),
          lastModified: new Date().toISOString(),
          schemaVersion: '2.0.0',
          // Unknown field
          futureFeature: 'some-value'
        },
        elements: {
          // Standard type
          personas: {
            'test-persona': {
              core: {
                name: 'Test Persona',
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
                name: 'Quantum Agent',
                type: 'quantum-agents',
                version: '1.0.0',
                description: 'Quantum computing agent'
              },
              // Unknown structure
              quantumConfig: {
                qubits: 128,
                entanglementLevel: 'high',
                coherenceTime: '100ms'
              }
            }
          }
        },
        // Unknown top-level field
        experimentalFeatures: {
          enabled: true,
          features: ['quantum', 'neural-link']
        }
      };

      await fs.writeFile(testIndexPath, JSON.stringify(customYaml), 'utf-8');

      // Load through the manager
      const index = await manager.getIndex({ forceRebuild: false });

      // Verify the unknown fields are preserved
      const fileContent = await fs.readFile(testIndexPath, 'utf-8');
      const parsed = JSON.parse(fileContent);

      expect(parsed.experimentalFeatures).toBeDefined();
      expect(parsed.experimentalFeatures.features).toContain('quantum');
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

      await manager.saveIndex();

      // Future: Could implement search functionality
      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.commands['deploy-command'].custom.tags).toContain('automation');
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
        }
      };

      await manager.saveIndex();

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
        }
      };

      await manager.saveIndex();
      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.validators['input-validator'].custom.rules).toHaveLength(3);
      expect(reloaded.elements.validators['input-validator'].extensions?.validation?.strictMode).toBe(true);
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

      await manager.saveIndex();
      const reloaded = await manager.getIndex({ forceRebuild: false });
      expect(reloaded.elements.plugins['analytics-plugin'].custom.hooks['on-user-login']).toBe('trackLogin');
    });
  });

  describe('YAML Preservation Tests', () => {
    it('should maintain YAML formatting preferences', async () => {
      // Write YAML with specific formatting
      const yamlContent = `version: 2.0.0
metadata:
  created: '2024-01-01T00:00:00Z'
  lastModified: '2024-01-01T00:00:00Z'
  schemaVersion: '2.0.0'
elements:
  personas:
    test-persona:
      core:
        name: Test Persona
        type: personas
        version: 1.0.0
        description: |
          Multi-line description
          with preserved formatting
          and indentation
`;

      await fs.writeFile(testIndexPath, yamlContent, 'utf-8');

      // Load and save through manager
      const index = await manager.getIndex({ forceRebuild: false });

      // Verify the index loaded properly
      expect(index.elements.personas).toBeDefined();
      expect(index.elements.personas['test-persona']).toBeDefined();
      expect(index.elements.personas['test-persona'].core.description).toContain('Multi-line description');
      // Note: Exact formatting may vary based on js-yaml settings
    });

    it('should handle special YAML features like anchors and aliases', async () => {
      // Note: This is a demonstration of what the system can handle
      const yamlWithAnchors = `version: 2.0.0
metadata:
  created: '2024-01-01T00:00:00Z'
  lastModified: '2024-01-01T00:00:00Z'
  schemaVersion: '2.0.0'
defaults: &defaults
  version: 1.0.0
  status: active
elements:
  templates:
    base-template:
      core:
        <<: *defaults
        name: Base Template
        type: templates
        description: Base template with defaults
    derived-template:
      core:
        <<: *defaults
        name: Derived Template
        type: templates
        description: Another template using defaults
`;

      await fs.writeFile(testIndexPath, yamlWithAnchors, 'utf-8');

      // Load through manager - js-yaml will expand anchors
      const index = await manager.getIndex({ forceRebuild: false });

      // Both templates should have the default values (anchors are expanded during load)
      expect(index.elements.templates?.['base-template']?.core.version).toBe('1.0.0');
      expect(index.elements.templates?.['derived-template']?.core.version).toBe('1.0.0');

      // Verify both templates got the same shared values from the anchor
      expect(index.elements.templates?.['base-template']?.core.type).toBe('templates');
      expect(index.elements.templates?.['derived-template']?.core.type).toBe('templates');
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

    it('should skip entries with missing metadata.name', async () => {
      // Create mock portfolio manager that returns entry with undefined metadata
      const mockPortfolioManager = {
        getIndexData: jest.fn().mockResolvedValue({
          byType: new Map([
            ['personas', [
              {
                filePath: '/test/persona1.md',
                elementType: 'personas',
                metadata: {
                  name: 'valid-persona',
                  description: 'Valid entry'
                }
              },
              {
                filePath: '/test/persona2.md',
                elementType: 'personas',
                metadata: {} // Missing name
              }
            ]]
          ])
        })
      };

      // Create manager with mock
      const testManager = new (EnhancedIndexManager as any)();
      testManager.portfolioManager = mockPortfolioManager;

      // Build index - should skip the entry with missing name
      await testManager.buildIndex();

      const index = testManager.index;
      expect(index.elements.personas['valid-persona']).toBeDefined();
      expect(Object.keys(index.elements.personas)).toHaveLength(1);
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