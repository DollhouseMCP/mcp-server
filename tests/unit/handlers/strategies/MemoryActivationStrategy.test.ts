import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MemoryActivationStrategy } from '../../../../src/handlers/strategies/MemoryActivationStrategy.js';
import type { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';

describe('MemoryActivationStrategy', () => {
  let strategy: MemoryActivationStrategy;
  let mockMemoryManager: jest.Mocked<MemoryManager>;

  beforeEach(() => {
    mockMemoryManager = {
      list: jest.fn(),
      get: jest.fn(),
      activateMemory: jest.fn(),
      deactivateMemory: jest.fn(),
      getActiveMemories: jest.fn(),
    } as unknown as jest.Mocked<MemoryManager>;

    strategy = new MemoryActivationStrategy(mockMemoryManager);
  });

  describe('activate', () => {
    it('should activate memory successfully with retention and tags', async () => {
      const mockMemory = {
        metadata: {
          name: 'test-memory',
          description: 'Test memory',
          retentionDays: 30,
          tags: ['project', 'context']
        },
        content: 'Memory content',
        activate: jest.fn().mockResolvedValue(undefined),
        deactivate: jest.fn(),
        getStatus: jest.fn(),
        getStats: jest.fn().mockReturnValue({
          entryCount: 5,
          totalSize: 1024
        })
      };

      mockMemoryManager.activateMemory.mockResolvedValue({
        success: true,
        message: 'Activated',
        memory: mockMemory
      });

      const result = await strategy.activate('test-memory');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-memory');
      expect(result.content[0].text).toContain('30 days');
      expect(result.content[0].text).toContain('project, context');
      expect(result.content[0].text).toContain('available for context');
    });

    it('should handle memory with permanent retention', async () => {
      const mockMemory = {
        metadata: {
          name: 'permanent-memory',
          description: 'Permanent'
        },
        content: 'Content',
        activate: jest.fn().mockResolvedValue(undefined),
        getStatus: jest.fn(),
        getStats: jest.fn().mockReturnValue({
          entryCount: 0,
          totalSize: 0
        })
      };

      mockMemoryManager.activateMemory.mockResolvedValue({
        success: true,
        message: 'Activated',
        memory: mockMemory
      });

      const result = await strategy.activate('permanent-memory');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('permanent days'); // default
    });

    it('should handle memory without tags', async () => {
      const mockMemory = {
        metadata: {
          name: 'no-tags',
          description: 'No tags',
          retentionDays: 7
        },
        activate: jest.fn().mockResolvedValue(undefined),
        getStatus: jest.fn(),
        getStats: jest.fn().mockReturnValue({
          entryCount: 2,
          totalSize: 512
        })
      };

      mockMemoryManager.activateMemory.mockResolvedValue({
        success: true,
        message: 'Activated',
        memory: mockMemory
      });

      const result = await strategy.activate('no-tags');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('none'); // default tags
    });

    it('should return error when memory not found', async () => {
      mockMemoryManager.activateMemory.mockResolvedValue({
        success: false,
        message: 'Memory not found'
      });

      const result = await strategy.activate('missing-memory');

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('missing-memory');
    });

    it('should propagate activation errors', async () => {
      mockMemoryManager.activateMemory.mockRejectedValue(new Error('Activation failed'));

      await expect(strategy.activate('error-memory')).rejects.toThrow('Activation failed');
    });
  });

  describe('deactivate', () => {
    it('should deactivate memory successfully', async () => {
      mockMemoryManager.deactivateMemory.mockResolvedValue({
        success: true,
        message: '✅ Memory active-memory deactivated'
      });

      const result = await strategy.deactivate('active-memory');

      expect(result.content[0].text).toContain('active-memory');
      expect(result.content[0].text).toContain('deactivated');
    });

    // Issue #275: Now throws error instead of returning error content
    it('should throw ElementNotFoundError when memory not found', async () => {
      mockMemoryManager.deactivateMemory.mockResolvedValue({
        success: false,
        message: 'Memory not found'
      });

      await expect(strategy.deactivate('missing-memory'))
        .rejects.toThrow('Memory \'missing-memory\' not found');
    });

    it('should propagate deactivation errors', async () => {
      mockMemoryManager.deactivateMemory.mockRejectedValue(new Error('Deactivation failed'));

      await expect(strategy.deactivate('error-memory')).rejects.toThrow('Deactivation failed');
    });
  });

  describe('getActiveElements', () => {
    it('should return empty message when no active memories', async () => {
      mockMemoryManager.getActiveMemories.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active memories');
      expect(result.content[0].text).toContain('🧠');
    });

    it('should list active memories with tags and retention', async () => {
      const activeMemories = [
        {
          metadata: {
            name: 'memory-one',
            tags: ['tag1', 'tag2'],
            retentionDays: 30
          },
          getStatus: jest.fn().mockReturnValue('active')
        },
        {
          metadata: {
            name: 'memory-two',
            retentionDays: 7
          },
          getStatus: jest.fn().mockReturnValue('active')
        }
      ];

      mockMemoryManager.getActiveMemories.mockResolvedValue(activeMemories);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('memory-one');
      expect(result.content[0].text).toContain('tag1, tag2');
      expect(result.content[0].text).toContain('30 days');
      expect(result.content[0].text).toContain('memory-two');
      expect(result.content[0].text).toContain('none'); // default tags
      expect(result.content[0].text).toContain('7 days');
    });

    it('should handle memories with permanent retention', async () => {
      const activeMemories = [
        {
          metadata: { name: 'permanent' },
          getStatus: jest.fn().mockReturnValue('active')
        }
      ];

      mockMemoryManager.getActiveMemories.mockResolvedValue(activeMemories);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('permanent');
      expect(result.content[0].text).toContain('permanent days');
    });

    it('should handle empty memory list', async () => {
      mockMemoryManager.getActiveMemories.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active memories');
    });
  });

  describe('getElementDetails', () => {
    it('should return complete memory details', async () => {
      const mockMemory = {
        metadata: {
          name: 'detailed-memory',
          description: 'A detailed memory',
          retentionDays: 90,
          tags: ['important', 'context'],
          storageBackend: 'database',
          privacyLevel: 'public'
        },
        content: 'Memory content here\nWith multiple lines',
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockMemoryManager.list.mockResolvedValue([mockMemory]);

      const result = await strategy.getElementDetails('detailed-memory');

      expect(result.content[0].text).toContain('detailed-memory');
      expect(result.content[0].text).toContain('A detailed memory');
      expect(result.content[0].text).toContain('active');
      expect(result.content[0].text).toContain('90 days');
      expect(result.content[0].text).toContain('important, context');
      expect(result.content[0].text).toContain('database');
      expect(result.content[0].text).toContain('public');
      expect(result.content[0].text).toContain('Memory content here');
    });

    it('should handle minimal memory metadata', async () => {
      const mockMemory = {
        metadata: {
          name: 'simple-memory',
          description: 'Simple'
        },
        content: null,
        getStatus: jest.fn().mockReturnValue('inactive')
      };

      mockMemoryManager.list.mockResolvedValue([mockMemory]);

      const result = await strategy.getElementDetails('simple-memory');

      expect(result.content[0].text).toContain('simple-memory');
      expect(result.content[0].text).toContain('inactive');
      expect(result.content[0].text).toContain('permanent days'); // default
      expect(result.content[0].text).toContain('none'); // default tags
      expect(result.content[0].text).toContain('file'); // default storage
      expect(result.content[0].text).toContain('private'); // default privacy
      expect(result.content[0].text).toContain('No content stored');
    });

    it('should throw ElementNotFoundError when memory not found', async () => {
      mockMemoryManager.list.mockResolvedValue([]);

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.getElementDetails('missing'))
        .rejects.toThrow('Memory \'missing\' not found');
    });

    it('should handle memory with empty content', async () => {
      const mockMemory = {
        metadata: {
          name: 'empty-content',
          description: 'Empty'
        },
        content: '',
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockMemoryManager.list.mockResolvedValue([mockMemory]);

      const result = await strategy.getElementDetails('empty-content');

      expect(result.content[0].text).toContain('empty-content');
      expect(result.content[0].text).toContain('No content stored');
    });

    it('should handle memory with undefined content', async () => {
      const mockMemory = {
        metadata: {
          name: 'undefined-content',
          description: 'Undefined'
        },
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockMemoryManager.list.mockResolvedValue([mockMemory]);

      const result = await strategy.getElementDetails('undefined-content');

      expect(result.content[0].text).toContain('undefined-content');
      expect(result.content[0].text).toContain('No content stored');
    });
  });
});
