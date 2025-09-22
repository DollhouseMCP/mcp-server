/**
 * Tests for RelationshipManager - Cross-element relationship discovery
 */

import { RelationshipManager } from '../../../../src/portfolio/RelationshipManager.js';
import { EnhancedIndex, ElementDefinition } from '../../../../src/portfolio/EnhancedIndexManager.js';

describe('RelationshipManager', () => {
  let manager: RelationshipManager;

  beforeEach(() => {
    manager = RelationshipManager.getInstance({
      minConfidence: 0.5,
      enableAutoDiscovery: true
    });
  });

  describe('Relationship Discovery', () => {
    it('should discover uses relationships from text patterns', async () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 2
        },
        action_triggers: {},
        elements: {
          skills: {
            'docker-setup': {
              core: {
                name: 'Docker Setup',
                type: 'skills',
                description: 'This skill uses docker-authentication for secure access'
              }
            },
            'docker-authentication': {
              core: {
                name: 'Docker Authentication',
                type: 'skills',
                description: 'Handles Docker registry authentication'
              }
            }
          }
        }
      };

      await manager.discoverRelationships(index);

      const dockerSetup = index.elements.skills['docker-setup'];
      expect(dockerSetup.relationships).toBeDefined();
      expect(dockerSetup.relationships!.uses).toBeDefined();
      expect(dockerSetup.relationships!.uses!.length).toBeGreaterThan(0);
      expect(dockerSetup.relationships!.uses![0].element).toContain('docker-authentication');
    });

    it('should discover prerequisite relationships', async () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 2
        },
        action_triggers: {},
        elements: {
          templates: {
            'basic-setup': {
              core: {
                name: 'Basic Setup',
                type: 'templates',
                description: 'Basic project setup template'
              }
            },
            'advanced-config': {
              core: {
                name: 'Advanced Config',
                type: 'templates',
                description: 'Advanced configuration, prerequisite for basic-setup completion'
              }
            }
          }
        }
      };

      await manager.discoverRelationships(index);

      const advancedConfig = index.elements.templates['advanced-config'];
      expect(advancedConfig.relationships).toBeDefined();
      expect(advancedConfig.relationships!.prerequisite_for).toBeDefined();
    });

    it('should discover helps_debug relationships', async () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 2
        },
        action_triggers: {},
        elements: {
          personas: {
            'debug-detective': {
              core: {
                name: 'Debug Detective',
                type: 'personas',
                description: 'Expert at debugging authentication issues'
              }
            }
          },
          memories: {
            'authentication-errors': {
              core: {
                name: 'Authentication Errors',
                type: 'memories',
                description: 'Common authentication problems and solutions'
              }
            }
          }
        }
      };

      await manager.discoverRelationships(index);

      const debugDetective = index.elements.personas['debug-detective'];
      expect(debugDetective.relationships).toBeDefined();
    });

    it('should add inverse relationships automatically', async () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 2
        },
        action_triggers: {},
        elements: {
          skills: {
            'parent-skill': {
              core: {
                name: 'Parent Skill',
                type: 'skills',
                description: 'This skill uses child-skill for processing'
              }
            },
            'child-skill': {
              core: {
                name: 'Child Skill',
                type: 'skills',
                description: 'Processing skill'
              }
            }
          }
        }
      };

      await manager.discoverRelationships(index);

      const parentSkill = index.elements.skills['parent-skill'];
      const childSkill = index.elements.skills['child-skill'];

      // Parent should have 'uses' relationship
      expect(parentSkill.relationships?.uses).toBeDefined();

      // Child should have inverse 'used_by' relationship
      expect(childSkill.relationships?.used_by).toBeDefined();
      expect(childSkill.relationships!.used_by![0].element).toContain('parent-skill');
    });
  });

  describe('Graph Traversal', () => {
    it('should find shortest path between elements', () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 4
        },
        action_triggers: {},
        elements: {
          skills: {
            'a': {
              core: { name: 'A', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:b', strength: 0.8 }]
              }
            },
            'b': {
              core: { name: 'B', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:c', strength: 0.7 }]
              }
            },
            'c': {
              core: { name: 'C', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:d', strength: 0.9 }]
              }
            },
            'd': {
              core: { name: 'D', type: 'skills' }
            }
          }
        }
      };

      const path = manager.findPath('skills:a', 'skills:d', index);

      expect(path).not.toBeNull();
      expect(path!.path).toEqual(['skills:a', 'skills:b', 'skills:c', 'skills:d']);
      expect(path!.relationships).toEqual(['uses', 'uses', 'uses']);
    });

    it('should respect maxDepth in path finding', () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 4
        },
        action_triggers: {},
        elements: {
          skills: {
            'a': {
              core: { name: 'A', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:b', strength: 0.8 }]
              }
            },
            'b': {
              core: { name: 'B', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:c', strength: 0.7 }]
              }
            },
            'c': {
              core: { name: 'C', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:d', strength: 0.9 }]
              }
            },
            'd': {
              core: { name: 'D', type: 'skills' }
            }
          }
        }
      };

      const path = manager.findPath('skills:a', 'skills:d', index, { maxDepth: 2 });

      expect(path).toBeNull();  // Path requires 3 hops, but maxDepth is 2
    });

    it('should get connected elements within depth', () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 5
        },
        action_triggers: {},
        elements: {
          skills: {
            'center': {
              core: { name: 'Center', type: 'skills' },
              relationships: {
                uses: [
                  { element: 'skills:near1', strength: 0.9 },
                  { element: 'skills:near2', strength: 0.8 }
                ]
              }
            },
            'near1': {
              core: { name: 'Near1', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:far1', strength: 0.7 }]
              }
            },
            'near2': {
              core: { name: 'Near2', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:far2', strength: 0.6 }]
              }
            },
            'far1': {
              core: { name: 'Far1', type: 'skills' }
            },
            'far2': {
              core: { name: 'Far2', type: 'skills' }
            }
          }
        }
      };

      const connected = manager.getConnectedElements('skills:center', index, { maxDepth: 1 });

      expect(connected.size).toBe(2);
      expect(connected.has('skills:near1')).toBe(true);
      expect(connected.has('skills:near2')).toBe(true);
      expect(connected.has('skills:far1')).toBe(false);
      expect(connected.has('skills:far2')).toBe(false);
    });

    it('should filter by relationship types', () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 3
        },
        action_triggers: {},
        elements: {
          skills: {
            'main': {
              core: { name: 'Main', type: 'skills' },
              relationships: {
                uses: [{ element: 'skills:dependency', strength: 0.8 }],
                similar_to: [{ element: 'skills:similar', strength: 0.9 }]
              }
            },
            'dependency': {
              core: { name: 'Dependency', type: 'skills' }
            },
            'similar': {
              core: { name: 'Similar', type: 'skills' }
            }
          }
        }
      };

      const connected = manager.getConnectedElements('skills:main', index, {
        maxDepth: 1,
        relationshipTypes: ['uses']
      });

      expect(connected.size).toBe(1);
      expect(connected.has('skills:dependency')).toBe(true);
      expect(connected.has('skills:similar')).toBe(false);
    });
  });

  describe('Relationship Statistics', () => {
    it('should calculate relationship statistics', () => {
      const index: EnhancedIndex = {
        metadata: {
          version: '1.0.0',
          last_updated: new Date().toISOString(),
          total_elements: 3
        },
        action_triggers: {},
        elements: {
          skills: {
            'a': {
              core: { name: 'A', type: 'skills' },
              relationships: {
                uses: [
                  { element: 'skills:b', strength: 0.8 },
                  { element: 'skills:c', strength: 0.7 }
                ],
                similar_to: [{ element: 'skills:c', strength: 0.9 }]
              }
            },
            'b': {
              core: { name: 'B', type: 'skills' },
              relationships: {
                used_by: [{ element: 'skills:a', strength: 0.8 }]
              }
            },
            'c': {
              core: { name: 'C', type: 'skills' }
            }
          }
        }
      };

      const stats = manager.getRelationshipStats(index);

      expect(stats.totalRelationships).toBe(4);
      expect(stats.elementsWithRelationships).toBe(2);
      expect(stats.uses).toBe(2);
      expect(stats.similar_to).toBe(1);
      expect(stats.used_by).toBe(1);
    });
  });
});