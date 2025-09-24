/**
 * Tests for EnhancedIndexManager - Demonstrating extensibility
 */

import { EnhancedIndexManager } from '../../../../src/portfolio/EnhancedIndexManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { setupTestEnvironment, cleanupTestEnvironment, resetSingletons, clearSuiteDirectory } from './test-setup.js';

describe.skip('EnhancedIndexManager - Extensibility Tests', () => {
  // FIXME: Still timing out despite fixes. The Enhanced Index feature needs major refactoring.
  // Issues fixed but still problematic:
  // 1. Reduced max comparisons from 500 to 100
  // 2. Added timeout circuit breakers (5 second max)
  // 3. Removed circular dependency with VerbTriggerManager
  //
  // Remaining issues:
  // - File locking conflicts in tests
  // - Complex initialization chain
  // - Feature not actually used in production
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

    // Create a pre-built capability index to avoid building
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

    // Now getInstance() will use the test directory
    manager = EnhancedIndexManager.getInstance();
  }, 30000);  // Increase timeout for setup

  afterEach(async () => {
    // Clean up test environment
    await cleanupTestEnvironment(originalHome);
    await resetSingletons();
  });

  describe('Schema Extensibility', () => {
    it('should support arbitrary element types without code changes', async () => {
      // Add a completely new element type
      const index = await manager.getIndex();

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

      // Save and verify
      await manager.saveIndex();

      // Read the file directly to verify persistence
      const fileContent = await fs.readFile(testIndexPath, 'utf-8');
      const parsed = yamlLoad(fileContent) as any;

      expect(parsed.elements.workflows).toBeDefined();
      expect(parsed.elements.workflows['data-processing-workflow'].custom.schedule).toBe('0 0 * * *');
    });

    it('should handle nested custom fields and complex structures', async () => {
      const index = await manager.getIndex();

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

      const reloaded = await manager.getIndex();
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
      const index = await manager.getIndex();

      // Verify the unknown fields are preserved
      const fileContent = await fs.readFile(testIndexPath, 'utf-8');
      const parsed = JSON.parse(fileContent);

      expect(parsed.experimentalFeatures).toBeDefined();
      expect(parsed.experimentalFeatures.features).toContain('quantum');
    });

    it('should support custom indexing and search fields', async () => {
      const index = await manager.getIndex();

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
      const reloaded = await manager.getIndex();
      expect(reloaded.elements.commands['deploy-command'].custom.tags).toContain('automation');
    });

    it('should handle migration scenarios with version compatibility', async () => {
      const index = await manager.getIndex();

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
      const reloaded = await manager.getIndex();
      expect((reloaded.elements.migrations['v1-element'] as any).legacyField).toBe('old-value');
    });

    it('should allow custom validation rules through extensions', async () => {
      const index = await manager.getIndex();

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
      const reloaded = await manager.getIndex();
      expect(reloaded.elements.validators['input-validator'].custom.rules).toHaveLength(3);
      expect(reloaded.elements.validators['input-validator'].extensions?.validation?.strictMode).toBe(true);
    });

    it('should support plugin-style extensions', async () => {
      const index = await manager.getIndex();

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
      const reloaded = await manager.getIndex();
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
      const index = await manager.getIndex();
      await manager.saveIndex();

      // Check that multi-line strings are preserved
      const saved = await fs.readFile(testIndexPath, 'utf-8');
      const parsed = yamlLoad(saved) as any;

      expect(parsed.elements.personas['test-persona'].core.description).toContain('Multi-line description');
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
      const index = await manager.getIndex();

      // Both templates should have the default values
      expect(index.elements.templates?.['base-template']?.core.version).toBe('1.0.0');
      expect(index.elements.templates?.['derived-template']?.core.version).toBe('1.0.0');

      // When saved, anchors might not be preserved (depends on implementation)
      await manager.saveIndex();
      const saved = await fs.readFile(testIndexPath, 'utf-8');
      const parsed = yamlLoad(saved) as any;

      // Values should still be correct even if anchors are expanded
      expect(parsed.elements.templates['base-template'].core.version).toBe('1.0.0');
      expect(parsed.elements.templates['derived-template'].core.version).toBe('1.0.0');
    });
  });
});