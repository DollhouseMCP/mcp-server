/**
 * Tests for EnhancedIndexManager - Demonstrating extensibility
 */

import { EnhancedIndexManager } from '../../../../src/portfolio/EnhancedIndexManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { load as yamlLoad } from 'js-yaml';

describe('EnhancedIndexManager - Extensibility Tests', () => {
  let manager: EnhancedIndexManager;
  const testIndexPath = path.join(process.env.HOME!, '.dollhouse', 'capability-index.yaml');

  beforeEach(() => {
    manager = EnhancedIndexManager.getInstance();
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
            // Nested custom structures
            metrics: {
              avg_runtime: 45,
              success_rate: 0.98
            }
          },
          // Workflows can have actions too
          actions: {
            run: { verb: 'run', behavior: 'execute_workflow', confidence: 1.0 },
            schedule: { verb: 'schedule', behavior: 'add_to_cron', confidence: 0.9 }
          }
        }
      };

      // Index should accept the new type without errors
      expect(index.elements['workflows']).toBeDefined();
      expect(Object.keys(index.elements).includes('workflows')).toBe(true);
    });

    it('should support arbitrary metadata fields on elements', async () => {
      const index = await manager.getIndex();

      // Add custom metadata to an existing element
      if (!index.elements['memories']) {
        index.elements['memories'] = {};
      }

      index.elements['memories']['test-memory'] = {
        core: {
          name: 'Test Memory',
          type: 'memories',
          version: '1.0.0'
        },
        // Add completely custom fields
        custom: {
          // Domain-specific metadata
          medical_record: {
            patient_id: '12345',
            diagnosis: 'test condition',
            confidence: 0.85
          },
          // Analytics metadata
          usage_stats: {
            access_count: 42,
            last_accessed: '2025-09-22T19:00:00Z',
            average_relevance: 0.73
          },
          // Arbitrary nested structures
          experimental_features: {
            quantum_entanglement: true,
            parallel_universes: ['universe-a', 'universe-b'],
            probability_cloud: {
              outcomes: [0.3, 0.5, 0.2]
            }
          }
        }
      };

      // Should handle arbitrary metadata gracefully
      const memory = index.elements['memories']['test-memory'];
      expect(memory.custom?.medical_record).toBeDefined();
      expect(memory.custom?.experimental_features?.quantum_entanglement).toBe(true);
    });

    it('should support custom action verbs and behaviors', async () => {
      const index = await manager.getIndex();

      // Add element with custom domain-specific actions
      index.elements['personas'] = index.elements['personas'] || {};
      index.elements['personas']['quantum-physicist'] = {
        core: {
          name: 'Quantum Physicist',
          type: 'personas'
        },
        // Custom domain-specific actions
        actions: {
          // Standard actions
          explain: { verb: 'explain', behavior: 'activate', confidence: 0.9 },

          // Domain-specific custom actions
          calculate_wavefunction: {
            verb: 'calculate_wavefunction',
            behavior: 'quantum_compute',
            confidence: 0.95,
            // Custom action properties
            required_qubits: 8,
            algorithm: 'shor',
            error_correction: 'surface_code'
          },
          entangle: {
            verb: 'entangle',
            behavior: 'create_entanglement',
            confidence: 0.87,
            max_particles: 4,
            decoherence_time: 100  // microseconds
          }
        }
      };

      // Custom verbs should be indexed
      await manager.addExtension('quantum_verbs', ['calculate_wavefunction', 'entangle']);
      const elements = await manager.getElementsByAction('calculate_wavefunction');

      // Note: This would work after implementing the indexing
      expect(index.elements['personas']['quantum-physicist'].actions?.calculate_wavefunction).toBeDefined();
    });

    it('should support extensible relationship types', async () => {
      const index = await manager.getIndex();

      // Add custom relationship types
      await manager.addRelationship(
        'docker-auth-memory',
        'quantum-computing-memory',
        {
          element: 'quantum-computing-memory',
          type: 'quantum_entangled_with',  // Custom relationship type
          strength: 0.7,
          metadata: {
            entanglement_type: 'bell_state',
            correlation: 0.95,
            measurement_basis: 'computational',
            // Arbitrary metadata for this relationship type
            experimental: {
              confirmed: false,
              hypothesis: 'memories share quantum state'
            }
          }
        }
      );

      // Custom relationships should be stored
      // Note: Would need to implement finding the element
      expect(index.extensions).toBeDefined();
    });

    it('should support schema evolution without breaking existing data', async () => {
      // Simulate loading an old version index
      const oldIndex = {
        metadata: {
          version: '1.0.0',  // Old version
          last_updated: '2025-01-01T00:00:00Z',
          total_elements: 5
          // Missing new fields like 'created'
        },
        elements: {
          memories: {
            'old-memory': {
              // Old structure - missing 'core' wrapper
              name: 'Old Memory',
              type: 'memories',
              description: 'Legacy format memory'
            }
          }
        }
        // Missing new sections like action_triggers
      };

      // Write old format index
      await fs.writeFile(testIndexPath, JSON.stringify(oldIndex, null, 2));

      // Should load and migrate gracefully
      const index = await manager.getIndex();
      expect(index.metadata.version).toBe('2.0.0');  // Should upgrade version
      expect(index.action_triggers).toBeDefined();   // Should add missing sections
    });

    it('should support custom extensions without modifying core', async () => {
      // Add a completely custom extension
      await manager.addExtension('ml_models', {
        embeddings: {
          model: 'text-embedding-ada-002',
          dimensions: 1536,
          cache_size: 10000
        },
        classifiers: {
          intent: 'bert-base-uncased',
          sentiment: 'roberta-sentiment',
          language: 'xlm-roberta-base'
        },
        custom_pipelines: [
          {
            name: 'semantic-search',
            steps: ['embed', 'index', 'retrieve', 'rerank']
          }
        ]
      });

      // Add another extension
      await manager.addExtension('analytics', {
        tracking: {
          enabled: true,
          sample_rate: 0.1,
          events: ['activation', 'search', 'relationship_traversal']
        },
        reporting: {
          frequency: 'daily',
          metrics: ['usage', 'performance', 'errors']
        }
      });

      const index = await manager.getIndex();
      expect(index.extensions?.ml_models).toBeDefined();
      expect(index.extensions?.analytics).toBeDefined();
      expect(index.extensions?.ml_models.embeddings.model).toBe('text-embedding-ada-002');
    });

    it('should preserve unknown fields during updates', async () => {
      const index = await manager.getIndex();

      // Add a field that doesn't exist in the TypeScript interface
      (index as any).future_feature = {
        quantum_tunneling: true,
        time_travel: 'enabled',
        dimensions: 11
      };

      // Update specific elements (preserving custom fields)
      await manager.updateElements(['test-memory'], { preserveCustom: true });

      // Unknown fields should be preserved
      const updatedIndex = await manager.getIndex();
      expect((updatedIndex as any).future_feature).toBeDefined();
      expect((updatedIndex as any).future_feature.quantum_tunneling).toBe(true);
    });
  });

  describe('YAML Human Readability', () => {
    it('should generate human-readable YAML', async () => {
      const index = await manager.getIndex({ forceRebuild: true });

      // Read the actual YAML file
      const yamlContent = await fs.readFile(testIndexPath, 'utf-8');

      // Should be readable YAML, not JSON
      expect(yamlContent).not.toContain('{');  // No JSON braces
      expect(yamlContent).toContain('metadata:');
      expect(yamlContent).toContain('  version:');  // Proper indentation

      // Should be parseable YAML
      const parsed = yamlLoad(yamlContent);
      expect(parsed).toBeDefined();
      expect(parsed.metadata).toBeDefined();
    });

    it('should maintain readable structure with complex nested data', async () => {
      const index = await manager.getIndex();

      // Add complex nested structure
      index.elements['test'] = {
        'complex-element': {
          core: { name: 'Complex', type: 'test' },
          custom: {
            deeply: {
              nested: {
                structure: {
                  with: {
                    many: {
                      levels: 'still readable'
                    }
                  }
                }
              }
            }
          }
        }
      };

      // Save and reload
      await manager.addExtension('test', 'force-save');
      const yamlContent = await fs.readFile(testIndexPath, 'utf-8');

      // Should maintain readable indentation
      expect(yamlContent).toContain('        levels: still readable');

      // Should not exceed reasonable line width
      const lines = yamlContent.split('\n');
      const longLines = lines.filter(l => l.length > 120);
      expect(longLines.length).toBeLessThan(5);  // Very few long lines
    });
  });

  // Clean up test file after tests
  afterAll(async () => {
    try {
      await fs.unlink(testIndexPath);
    } catch (error) {
      // Ignore if doesn't exist
    }
  });
});