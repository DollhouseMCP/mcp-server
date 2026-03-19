import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const { listElements } = await import('../../../../src/handlers/element-crud/listElements.js');
const { ElementType } = await import('../../../../src/portfolio/PortfolioManager.js');
const { createElementQueryService } = await import('../../../../src/services/query/ElementQueryService.js');
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';

describe('listElements helper', () => {
  let mockContext: ElementCrudContext;

  beforeEach(() => {
    mockContext = {
      skillManager: {
        list: jest.fn().mockResolvedValue([]),
      },
      templateManager: {
        list: jest.fn().mockResolvedValue([]),
      },
      agentManager: {
        list: jest.fn().mockResolvedValue([]),
      },
      memoryManager: {
        list: jest.fn().mockResolvedValue([]),
      },
      personaManager: {
        list: jest.fn().mockResolvedValue([]),
        getActivePersona: jest.fn().mockReturnValue(null),
      },
      ensembleManager: {
        list: jest.fn().mockResolvedValue([]),
      },
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getPersonaIndicator: jest.fn().mockReturnValue(''),
      elementQueryService: createElementQueryService(),
    } as any;
  });

  describe('type validation', () => {
    it('should accept valid element type: personas and return structured data', async () => {
      mockContext.personaManager.list = jest.fn().mockResolvedValue([
        {
          filename: 'creative-writer.md',
          unique_id: 'creative-writer_123',
          metadata: {
            name: 'Creative Writer',
            description: 'Writes imaginative stories on demand',
            category: 'creative',
            author: 'Dollhouse',
            price: 'free',
            version: '1.0',
            triggers: ['story', 'creative'],
          },
          content: 'Be creative.',
        },
      ]);

      const result = await listElements(mockContext, ElementType.PERSONA);

      expect(mockContext.personaManager.list).toHaveBeenCalled();
      // New structured format (Issue #299)
      expect(result.items).toBeDefined();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Creative Writer');
      expect(result.pagination).toBeDefined();
      expect(result.pagination.totalItems).toBe(1);
      expect(result.element_type).toBe('persona');
    });

    it('should return error for unknown element type', async () => {
      const result = await listElements(mockContext, 'invalid-type') as any;

      expect(result.code).toBe('UNKNOWN_TYPE');
      expect(result.error).toContain('Unknown element type');
      expect(result.error).toContain('invalid-type');
    });

    it('should accept valid element type: skills', async () => {
      const result = await listElements(mockContext, ElementType.SKILL);

      expect(mockContext.skillManager.list).toHaveBeenCalled();
      // Empty state: structured response with 0 items
      expect(result.items).toBeDefined();
      expect(result.items).toHaveLength(0);
      expect(result.element_type).toBe('skill');
    });

    it('should accept valid element type: templates', async () => {
      const result = await listElements(mockContext, ElementType.TEMPLATE);

      expect(mockContext.templateManager.list).toHaveBeenCalled();
      expect(result.items).toBeDefined();
      expect(result.items).toHaveLength(0);
    });

    it('should accept valid element type: agents', async () => {
      const result = await listElements(mockContext, ElementType.AGENT);

      expect(mockContext.agentManager.list).toHaveBeenCalled();
      expect(result.items).toBeDefined();
      expect(result.items).toHaveLength(0);
    });

    it('should accept valid element type: memories', async () => {
      const result = await listElements(mockContext, ElementType.MEMORY);

      expect(mockContext.memoryManager.list).toHaveBeenCalled();
      expect(result.items).toBeDefined();
      expect(result.items).toHaveLength(0);
    });
  });

  describe('empty state responses', () => {
    it('should return structured empty response when no skills installed', async () => {
      mockContext.skillManager.list = jest.fn().mockResolvedValue([]);

      const result = await listElements(mockContext, ElementType.SKILL);

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
    });

    it('should return structured empty response when no templates installed', async () => {
      mockContext.templateManager.list = jest.fn().mockResolvedValue([]);

      const result = await listElements(mockContext, ElementType.TEMPLATE);

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
    });

    it('should return structured empty response when no agents installed', async () => {
      mockContext.agentManager.list = jest.fn().mockResolvedValue([]);

      const result = await listElements(mockContext, ElementType.AGENT);

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
    });

    it('should return structured empty response when no memories stored', async () => {
      mockContext.memoryManager.list = jest.fn().mockResolvedValue([]);

      const result = await listElements(mockContext, ElementType.MEMORY);

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
    });
  });

  describe('listing skills', () => {
    it('should format skill list with concise metadata', async () => {
      mockContext.skillManager.list = jest.fn().mockResolvedValue([
        {
          metadata: {
            name: 'Code Review',
            description: 'Review code for quality',
            complexity: 'intermediate',
            domains: ['development', 'testing'],
            version: '2.0.0',
            tags: ['code', 'review'],
          },
          version: '2.0.0',
        },
      ]);

      const result = await listElements(mockContext, ElementType.SKILL);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Code Review');
      expect(result.items[0].description).toBe('Review code for quality');
      expect(result.items[0].version).toBe('2.0.0');
      expect(result.items[0].tags).toEqual(['code', 'review']);
      expect(result.items[0].type).toBe(ElementType.SKILL);
    });

    it('should handle skills with missing optional metadata', async () => {
      mockContext.skillManager.list = jest.fn().mockResolvedValue([
        {
          metadata: {
            name: 'Basic Skill',
            description: 'A basic skill',
          },
        },
      ]);

      const result = await listElements(mockContext, ElementType.SKILL);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Basic Skill');
    });

    it('should list multiple skills', async () => {
      mockContext.skillManager.list = jest.fn().mockResolvedValue([
        { metadata: { name: 'Skill 1', description: 'First skill' } },
        { metadata: { name: 'Skill 2', description: 'Second skill' } },
      ]);

      const result = await listElements(mockContext, ElementType.SKILL);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe('Skill 1');
      expect(result.items[1].name).toBe('Skill 2');
    });
  });

  describe('listing templates', () => {
    it('should format template list with concise metadata', async () => {
      mockContext.templateManager.list = jest.fn().mockResolvedValue([
        {
          metadata: {
            name: 'Email Template',
            description: 'Professional email',
            variables: [{ name: 'recipient' }, { name: 'subject' }],
            version: '1.5.0',
          },
          version: '1.5.0',
        },
      ]);

      const result = await listElements(mockContext, ElementType.TEMPLATE);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Email Template');
      expect(result.items[0].version).toBe('1.5.0');
    });
  });

  describe('listing agents', () => {
    it('should format agent list with concise metadata', async () => {
      mockContext.agentManager.list = jest.fn().mockResolvedValue([
        {
          metadata: {
            name: 'Research Agent',
            description: 'Autonomous researcher',
            specializations: ['web-search', 'summarization'],
            version: '3.0.0',
          },
          version: '3.0.0',
          getStatus: jest.fn().mockReturnValue('idle'),
        },
      ]);

      const result = await listElements(mockContext, ElementType.AGENT);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Research Agent');
      expect(result.items[0].version).toBe('3.0.0');
    });
  });

  describe('listing memories', () => {
    it('should format memory list with concise metadata', async () => {
      mockContext.memoryManager.list = jest.fn().mockResolvedValue([
        {
          metadata: {
            name: 'Project Context',
            description: 'Important project info',
            retentionDays: 90,
            tags: ['project', 'important'],
            version: '1.2.0',
          },
          version: '1.2.0',
        },
      ]);

      const result = await listElements(mockContext, ElementType.MEMORY);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Project Context');
      expect(result.items[0].tags).toEqual(['project', 'important']);
    });
  });

  describe('pagination', () => {
    it('should use default pageSize of 20', async () => {
      const skills = Array.from({ length: 30 }, (_, i) => ({
        metadata: {
          name: `Skill ${i + 1}`,
          description: `Description ${i + 1}`,
        },
      }));
      mockContext.skillManager.list = jest.fn().mockResolvedValue(skills);

      const result = await listElements(mockContext, ElementType.SKILL);

      expect(result.items).toHaveLength(20);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.pageSize).toBe(20);
      expect(result.pagination.totalItems).toBe(30);
      expect(result.pagination.totalPages).toBe(2);
      expect(result.pagination.hasNextPage).toBe(true);
    });

    it('should support explicit pagination params', async () => {
      const skills = Array.from({ length: 30 }, (_, i) => ({
        metadata: {
          name: `Skill ${i + 1}`,
          description: `Description ${i + 1}`,
        },
      }));
      mockContext.skillManager.list = jest.fn().mockResolvedValue(skills);

      const result = await listElements(mockContext, ElementType.SKILL, {
        pagination: { page: 2, pageSize: 5 },
      });

      expect(result.items).toHaveLength(5);
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.pageSize).toBe(5);
    });
  });

  describe('aggregation (Issue #309)', () => {
    it('should return count when aggregate.count is true', async () => {
      const skills = Array.from({ length: 15 }, (_, i) => ({
        metadata: {
          name: `Skill ${i + 1}`,
          description: `Description ${i + 1}`,
        },
      }));
      mockContext.skillManager.list = jest.fn().mockResolvedValue(skills);

      const result = await listElements(mockContext, ElementType.SKILL, {
        aggregate: { count: true },
      });

      expect(result.count).toBe(15);
      expect(result.element_type).toBe('skill');
      expect(result.items).toBeUndefined();
    });
  });

  describe('initialization', () => {
    it('should call ensureInitialized', async () => {
      await listElements(mockContext, ElementType.SKILL);

      expect(mockContext.ensureInitialized).toHaveBeenCalled();
    });
  });
});
