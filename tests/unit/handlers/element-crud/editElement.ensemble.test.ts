import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const { editElement } = await import('../../../../src/handlers/element-crud/editElement.js');
const { ElementType } = await import('../../../../src/portfolio/PortfolioManager.js');
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';

/**
 * Issue #658: edit_element on Ensemble silently wipes elements array
 *
 * Tests for:
 * - Dict-keyed elements input → converted to array
 * - Array elements input → validated correctly
 * - Upsert-by-name merge semantics (existing elements preserved)
 * - Invalid formats → error returned
 */
describe('editElement - ensemble elements (Issue #658)', () => {
  let mockContext: ElementCrudContext;

  const createMockEnsemble = (name: string, elements: any[] = []) => ({
    metadata: {
      name,
      version: '1.0.0',
      elements,
    },
    version: '1.0.0',
    validate: () => ({ valid: true }),
  });

  beforeEach(() => {
    mockContext = {
      skillManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      templateManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      agentManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      memoryManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      ensembleManager: {
        list: jest.fn().mockResolvedValue([]),
        save: jest.fn().mockResolvedValue(undefined),
      },
      personaManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getPersonaIndicator: jest.fn().mockReturnValue('>> '),
    } as any;
  });

  describe('dict-keyed elements input', () => {
    it('should convert dict-keyed elements to array format', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: {
            'bridge-session': { type: 'memory', role: 'support', priority: 40 },
          },
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(saved.metadata.elements)).toBe(true);
      expect(saved.metadata.elements.length).toBe(1);
      expect(saved.metadata.elements[0].element_name).toBe('bridge-session');
      expect(saved.metadata.elements[0].element_type).toBe('memory');
      expect(saved.metadata.elements[0].role).toBe('support');
      expect(saved.metadata.elements[0].priority).toBe(40);
    });

    it('should convert multi-entry dict to array with all entries', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: {
            'session-notes': { type: 'memory', role: 'support', priority: 40 },
            'code-reviewer': { type: 'skill', role: 'primary', priority: 80 },
          },
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(2);
      const names = saved.metadata.elements.map((e: any) => e.element_name);
      expect(names).toContain('session-notes');
      expect(names).toContain('code-reviewer');
    });

    it('should return error for dict entry with non-object value', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: {
            'bad-entry': 'not an object',
          },
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });
  });

  describe('array elements input', () => {
    it('should accept array of element objects', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'my-skill', element_type: 'skill', role: 'primary', priority: 90, activation: 'always' },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(1);
      expect(saved.metadata.elements[0].element_name).toBe('my-skill');
    });

    it('should accept legacy name/type fields in array', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { name: 'my-skill', type: 'skill', role: 'primary', priority: 90, activation: 'always' },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements[0].element_name).toBe('my-skill');
      expect(saved.metadata.elements[0].element_type).toBe('skill');
    });

    it('should return error for array element missing element_name', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_type: 'skill', role: 'primary' },
          ],
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('missing element_name');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });

    it('should return error for non-object item in array', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: ['just-a-string'],
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });
  });

  describe('merge semantics (upsert-by-name)', () => {
    it('should preserve existing elements when adding a new one', async () => {
      const existingElements = [
        { element_name: 'existing-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
        { element_name: 'existing-memory', element_type: 'memory', role: 'support', priority: 50, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'new-template', element_type: 'template', role: 'support', priority: 30, activation: 'always' },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(3);
      const names = saved.metadata.elements.map((e: any) => e.element_name);
      expect(names).toContain('existing-skill');
      expect(names).toContain('existing-memory');
      expect(names).toContain('new-template');
    });

    it('should update priority of existing element without losing others', async () => {
      const existingElements = [
        { element_name: 'skill-a', element_type: 'skill', role: 'primary', priority: 50, activation: 'always' },
        { element_name: 'skill-b', element_type: 'skill', role: 'support', priority: 30, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'skill-a', priority: 90 },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(2);
      const skillA = saved.metadata.elements.find((e: any) => e.element_name === 'skill-a');
      expect(skillA.priority).toBe(90);
      expect(skillA.element_type).toBe('skill'); // preserved from existing
      const skillB = saved.metadata.elements.find((e: any) => e.element_name === 'skill-b');
      expect(skillB.priority).toBe(30); // unchanged
    });

    it('should merge dict-keyed elements with existing array', async () => {
      const existingElements = [
        { element_name: 'existing-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: {
            'new-memory': { type: 'memory', role: 'support', priority: 40 },
          },
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(2);
      const names = saved.metadata.elements.map((e: any) => e.element_name);
      expect(names).toContain('existing-skill');
      expect(names).toContain('new-memory');
    });
  });

  describe('_remove marker (Issue #662)', () => {
    it('should not persist _remove or alias fields on upserted elements', async () => {
      const existingElements = [
        { element_name: 'skill-a', element_type: 'skill', role: 'primary', priority: 50, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            // Update with alias fields and _remove: false — none should persist
            { name: 'skill-a', type: 'skill', priority: 90, _remove: false },
            // New element with alias fields
            { name: 'memory-b', type: 'memory', element_name: 'memory-b', element_type: 'memory', role: 'support', priority: 40, activation: 'always' },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(2);
      for (const elem of saved.metadata.elements) {
        expect(elem).not.toHaveProperty('_remove');
        expect(elem).not.toHaveProperty('name');
        expect(elem).not.toHaveProperty('type');
      }
      // Verify the update took effect
      const skillA = saved.metadata.elements.find((e: any) => e.element_name === 'skill-a');
      expect(skillA.priority).toBe(90);
    });

    it('should remove element by name when _remove is true', async () => {
      const existingElements = [
        { element_name: 'skill-a', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
        { element_name: 'skill-b', element_type: 'skill', role: 'support', priority: 50, activation: 'always' },
        { element_name: 'memory-c', element_type: 'memory', role: 'support', priority: 30, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'skill-b', _remove: true },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(2);
      const names = saved.metadata.elements.map((e: any) => e.element_name);
      expect(names).toContain('skill-a');
      expect(names).toContain('memory-c');
      expect(names).not.toContain('skill-b');
    });

    it('should handle mixed add, update, and remove in one call', async () => {
      const existingElements = [
        { element_name: 'A', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
        { element_name: 'B', element_type: 'skill', role: 'support', priority: 50, activation: 'always' },
        { element_name: 'C', element_type: 'memory', role: 'support', priority: 30, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'A', priority: 90 },                    // update
            { element_name: 'B', _remove: true },                   // remove
            { element_name: 'C', priority: 10 },                    // update
            { element_name: 'D', element_type: 'skill', role: 'primary', priority: 60, activation: 'always' }, // add
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(3);
      const elemMap = new Map(saved.metadata.elements.map((e: any) => [e.element_name, e]));
      expect(elemMap.get('A').priority).toBe(90);      // updated
      expect(elemMap.has('B')).toBe(false);              // removed
      expect(elemMap.get('C').priority).toBe(10);        // updated
      expect(elemMap.get('D').element_type).toBe('skill'); // added
    });

    it('should warn when removing non-existent element', async () => {
      const existingElements = [
        { element_name: 'skill-a', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'nonexistent', _remove: true },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('not found');
      // Existing elements preserved
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(1);
      expect(saved.metadata.elements[0].element_name).toBe('skill-a');
    });

    it('should remove all elements if all marked _remove', async () => {
      const existingElements = [
        { element_name: 'A', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
        { element_name: 'B', element_type: 'skill', role: 'support', priority: 50, activation: 'always' },
      ];
      const ensemble = createMockEnsemble('test-ensemble', existingElements);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'A', _remove: true },
            { element_name: 'B', _remove: true },
          ],
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.elements.length).toBe(0);
    });
  });

  describe('invalid elements format', () => {
    it('should return error for string elements', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: 'not-valid' as any,
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });

    it('should return error for number elements', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: 42 as any,
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });

    it('should return error for null elements', async () => {
      const ensemble = createMockEnsemble('test-ensemble');
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: null as any,
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });

    it('should return error when _remove is a string instead of boolean', async () => {
      const ensemble = createMockEnsemble('test-ensemble', [
        { element_name: 'skill-a', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
      ]);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'skill-a', _remove: 'true' as any },
          ],
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('_remove');
      expect(result.content[0].text).toContain('boolean');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });

    it('should return error when _remove is a number instead of boolean', async () => {
      const ensemble = createMockEnsemble('test-ensemble', [
        { element_name: 'skill-a', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
      ]);
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([ensemble]);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'skill-a', _remove: 1 as any },
          ],
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('_remove');
      expect(result.content[0].text).toContain('boolean');
      expect(mockContext.ensembleManager.save).not.toHaveBeenCalled();
    });
  });

  describe('metadata.elements pathway (PR #1615)', () => {
    it('should accept elements via input.metadata.elements', async () => {
      const existing = createMockEnsemble('MetaTest', [
        { element_name: 'existing-skill', element_type: 'skill', role: 'primary', priority: 50, activation: 'always' }
      ]);

      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([existing]);
      mockContext.ensembleManager.save = jest.fn().mockResolvedValue(undefined);

      const result = await editElement(mockContext, {
        name: 'MetaTest',
        type: ElementType.ENSEMBLE,
        input: {
          metadata: {
            elements: [
              { element_name: 'new-skill', element_type: 'skill', role: 'support', priority: 30, activation: 'always' }
            ]
          }
        },
      });

      expect(result.content[0].text).toContain('✅');
      // Both existing and new elements should be present
      const savedElement = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      const savedElements = savedElement.metadata.elements;
      expect(savedElements).toHaveLength(2);
      expect(savedElements.map((e: any) => e.element_name).sort()).toEqual(['existing-skill', 'new-skill']);
    });

    it('should validate elements even when nested in metadata', async () => {
      const existing = createMockEnsemble('MetaTest', []);

      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([existing]);

      const result = await editElement(mockContext, {
        name: 'MetaTest',
        type: ElementType.ENSEMBLE,
        input: {
          metadata: {
            elements: 'not-an-array'
          }
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid');
    });

    it('should merge other metadata fields alongside elements', async () => {
      const existing = createMockEnsemble('MetaTest', []);

      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([existing]);
      mockContext.ensembleManager.save = jest.fn().mockResolvedValue(undefined);

      const result = await editElement(mockContext, {
        name: 'MetaTest',
        type: ElementType.ENSEMBLE,
        input: {
          metadata: {
            elements: [
              { element_name: 'a-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' }
            ],
            activationStrategy: 'sequential'
          }
        },
      });

      expect(result.content[0].text).toContain('✅');
      const savedElement = (mockContext.ensembleManager.save as jest.Mock).mock.calls[0][0];
      expect(savedElement.metadata.activationStrategy).toBe('sequential');
      expect(savedElement.metadata.elements).toHaveLength(1);
    });
  });
});
