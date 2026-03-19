import { describe, it, expect } from '@jest/globals';
import { ElementDefinitionBuilder } from '../../../../src/portfolio/enhanced-index/ElementDefinitionBuilder.js';
import type { IndexEntry } from '../../../../src/portfolio/PortfolioIndexManager.js';
import type { EnhancedIndex } from '../../../../src/portfolio/types/IndexTypes.js';
import { ElementType } from '../../../../src/portfolio/types.js';

const builder = new ElementDefinitionBuilder();

describe('ElementDefinitionBuilder', () => {
  it('builds element definitions with search metadata and default actions', () => {
    const entry: IndexEntry = {
      filePath: '/tmp/personas/debug-detective.md',
      elementType: ElementType.PERSONA,
      metadata: {
        name: 'debug-detective',
        description: 'Finds bugs fast',
        version: '1.0.0',
        keywords: ['debug', 'investigate'],
        triggers: ['debug']
      },
      lastModified: new Date(),
      filename: 'debug-detective'
    };

    const definition = builder.build(entry, null);

    expect(definition.core.name).toBe('debug-detective');
    expect(definition.search?.keywords).toContain('debug');
    expect(definition.actions?.debug?.verb).toBe('debug');
  });

  it('preserves existing customizations when rebuilding', () => {
    const entry: IndexEntry = {
      filePath: '/tmp/skills/tester.md',
      elementType: ElementType.SKILL,
      metadata: {
        name: 'tester',
        description: 'Runs tests'
      },
      lastModified: new Date(),
      filename: 'tester'
    };

    const existing: EnhancedIndex = {
      metadata: {
        version: '2.0.0',
        created: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        total_elements: 1
      },
      action_triggers: {},
      elements: {
        [ElementType.SKILL]: {
          tester: {
            core: {
              name: 'tester',
              type: ElementType.SKILL
            },
            custom: { owner: 'qa-team' },
            relationships: {
              similar: []
            }
          }
        }
      }
    };

    const definition = builder.build(entry, existing);

    expect(definition.custom).toEqual({ owner: 'qa-team' });
    expect(definition.relationships).toBeDefined();
  });

  describe('activates relationship extraction (Issue #749)', () => {
    it('extracts activates references as "uses" relationships for agents', () => {
      const entry: IndexEntry = {
        filePath: '/tmp/agents/orchestrator.md',
        elementType: ElementType.AGENT,
        metadata: {
          name: 'orchestrator',
          description: 'Orchestrates workflows',
          activates: {
            skills: ['code-review', 'testing'],
            templates: ['bug-report']
          }
        },
        lastModified: new Date(),
        filename: 'orchestrator'
      };

      const definition = builder.build(entry, null);

      expect(definition.relationships).toBeDefined();
      const uses = definition.relationships!['uses'];
      expect(uses).toHaveLength(3);
      expect(uses).toContainEqual({ element: 'skills:code-review', type: 'uses', strength: 1.0 });
      expect(uses).toContainEqual({ element: 'skills:testing', type: 'uses', strength: 1.0 });
      expect(uses).toContainEqual({ element: 'templates:bug-report', type: 'uses', strength: 1.0 });
    });

    it('merges activates with existing relationships', () => {
      const entry: IndexEntry = {
        filePath: '/tmp/agents/agent-with-rels.md',
        elementType: ElementType.AGENT,
        metadata: {
          name: 'agent-with-rels',
          description: 'Has existing relationships',
          activates: { skills: ['new-skill'] }
        },
        lastModified: new Date(),
        filename: 'agent-with-rels'
      };

      const existing: EnhancedIndex = {
        metadata: {
          version: '2.0.0',
          created: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          total_elements: 1
        },
        action_triggers: {},
        elements: {
          [ElementType.AGENT]: {
            'agent-with-rels': {
              core: { name: 'agent-with-rels', type: ElementType.AGENT },
              relationships: {
                uses: [{ element: 'personas:expert', type: 'uses', strength: 0.8 }]
              }
            }
          }
        }
      };

      const definition = builder.build(entry, existing);

      const uses = definition.relationships!['uses'];
      expect(uses).toHaveLength(2);
      expect(uses[0]).toEqual({ element: 'personas:expert', type: 'uses', strength: 0.8 });
      expect(uses[1]).toEqual({ element: 'skills:new-skill', type: 'uses', strength: 1.0 });
    });

    it('does not add relationships when activates is absent', () => {
      const entry: IndexEntry = {
        filePath: '/tmp/agents/simple.md',
        elementType: ElementType.AGENT,
        metadata: {
          name: 'simple',
          description: 'No activates'
        },
        lastModified: new Date(),
        filename: 'simple'
      };

      const definition = builder.build(entry, null);

      expect(definition.relationships).toBeUndefined();
    });

    it('skips empty arrays and non-string values in activates', () => {
      const entry: IndexEntry = {
        filePath: '/tmp/agents/edge-case.md',
        elementType: ElementType.AGENT,
        metadata: {
          name: 'edge-case',
          description: 'Edge cases',
          activates: {
            skills: [],
            templates: ['valid'],
            memories: ['']  // empty string — should be skipped
          }
        },
        lastModified: new Date(),
        filename: 'edge-case'
      };

      const definition = builder.build(entry, null);

      const uses = definition.relationships!['uses'];
      expect(uses).toHaveLength(1);
      expect(uses[0].element).toBe('templates:valid');
    });
  });
});
