import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as path from 'path';

const { deleteElement } = await import('../../../../src/handlers/element-crud/deleteElement.js');
const { ElementType } = await import('../../../../src/portfolio/PortfolioManager.js');
const { ElementNotFoundError } = await import('../../../../src/utils/ErrorHandler.js');
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';
import type { IFileOperationsService } from '../../../../src/services/FileOperationsService.js';

describe('deleteElement helper', () => {
  let mockContext: ElementCrudContext;
  let mockFileOperations: jest.Mocked<IFileOperationsService>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock FileOperationsService
    mockFileOperations = {
      readFile: jest.fn().mockResolvedValue(''),
      readElementFile: jest.fn().mockResolvedValue(''),
      writeFile: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      createDirectory: jest.fn().mockResolvedValue(undefined),
      resolvePath: jest.fn().mockImplementation((base, rel) => `${base}/${rel}`),
      validatePath: jest.fn().mockReturnValue(true),
      exists: jest.fn().mockResolvedValue(false), // Default: file doesn't exist
      listDirectory: jest.fn().mockResolvedValue([]),
      renameFile: jest.fn().mockResolvedValue(undefined),
      stat: jest.fn().mockRejectedValue(new Error('ENOENT: no such file or directory')), // Default: no data files
    } as any;

    mockContext = {
      skillManager: {
        list: jest.fn().mockResolvedValue([
          { metadata: { name: 'test-skill' }, id: 'skill-1', filename: 'test-skill.md' },
        ]),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      templateManager: {
        list: jest.fn().mockResolvedValue([
          { metadata: { name: 'test-template' }, id: 'template-1', filename: 'test-template.md' },
        ]),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      agentManager: {
        list: jest.fn().mockResolvedValue([
          { metadata: { name: 'test-agent' }, id: 'agent-1', filename: 'test-agent.md' },
        ]),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      memoryManager: {
        list: jest.fn().mockResolvedValue([
          { metadata: { name: 'test-memory' }, id: 'memory-1', filePath: '/mock/memories/2025-10-24/test-memory.yaml' },
        ]),
        delete: jest.fn().mockResolvedValue(undefined),
        clearCache: jest.fn(),
      },
      portfolioManager: {
        getElementDir: jest.fn().mockImplementation((type: string) => {
          if (type === ElementType.MEMORY) return '/mock/memories';
          return '/mock/elements';
        }),
        getFileExtension: jest.fn().mockReturnValue('.md'),
      },
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      fileOperations: mockFileOperations,
    } as any;
  });

  describe('type validation', () => {
    it('should return error for invalid element type', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test',
        type: 'invalid-type',
      });

      expect(result.content[0].text).toContain('❌ Invalid element type');
      expect(result.content[0].text).toContain('invalid-type');
    });

    it('should accept valid element type: skills', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(mockContext.skillManager.delete).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: templates', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test-template',
        type: ElementType.TEMPLATE,
      });

      expect(mockContext.templateManager.delete).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: agents', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
      });

      expect(mockContext.agentManager.delete).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: memories', async () => {
      // Mock exists to make the file appear to exist (firstExisting needs this)
      mockFileOperations.exists.mockResolvedValueOnce(true);

      const result = await deleteElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
      });

      // Memories use fileOperations.deleteFile
      expect(mockFileOperations.deleteFile).toHaveBeenCalledWith(
        '/mock/memories/2025-10-24/test-memory.yaml',
        ElementType.MEMORY,
        expect.objectContaining({ source: 'deleteElement.deleteMemory' })
      );
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('element not found', () => {
    // FIX: Issue #275 - Tests updated to expect ElementNotFoundError instead of error content
    it('should throw ElementNotFoundError when skill not found', async () => {
      mockContext.skillManager.list = jest.fn().mockResolvedValue([]);

      await expect(
        deleteElement(mockContext, {
          name: 'missing-skill',
          type: ElementType.SKILL,
        })
      ).rejects.toThrow(ElementNotFoundError);
    });

    it('should throw ElementNotFoundError when template not found', async () => {
      mockContext.templateManager.list = jest.fn().mockResolvedValue([]);

      await expect(
        deleteElement(mockContext, {
          name: 'missing-template',
          type: ElementType.TEMPLATE,
        })
      ).rejects.toThrow(ElementNotFoundError);
    });

    it('should throw ElementNotFoundError when agent not found', async () => {
      mockContext.agentManager.list = jest.fn().mockResolvedValue([]);

      await expect(
        deleteElement(mockContext, {
          name: 'missing-agent',
          type: ElementType.AGENT,
        })
      ).rejects.toThrow(ElementNotFoundError);
    });
  });

  describe('flexible name matching', () => {
    it('should find element by exact name match', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(mockContext.skillManager.delete).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should find element by case-insensitive match', async () => {
      const result = await deleteElement(mockContext, {
        name: 'TEST-SKILL',
        type: ElementType.SKILL,
      });

      expect(mockContext.skillManager.delete).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should find element by slug match', async () => {
      mockContext.skillManager.list = jest.fn().mockResolvedValue([
        { metadata: { name: 'Test Skill With Spaces' }, id: 'skill-1' },
      ]);

      const result = await deleteElement(mockContext, {
        name: 'test-skill-with-spaces',
        type: ElementType.SKILL,
      });

      expect(mockContext.skillManager.delete).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('successful deletion', () => {
    it('should delete skill successfully', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(mockContext.ensureInitialized).toHaveBeenCalled();
      expect(mockContext.skillManager.list).toHaveBeenCalled();
      expect(mockContext.skillManager.delete).toHaveBeenCalledWith('test-skill.md');
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-skill');
      expect(result.content[0].text).toContain('deleted');
    });

    it('should delete template successfully', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test-template',
        type: ElementType.TEMPLATE,
      });

      expect(mockContext.templateManager.delete).toHaveBeenCalledWith('test-template.md');
      expect(result.content[0].text).toContain('✅');
    });

    it('should delete agent successfully', async () => {
      const result = await deleteElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
      });

      expect(mockContext.agentManager.delete).toHaveBeenCalledWith('test-agent.md');
      expect(result.content[0].text).toContain('✅');
    });

    it('should delete memory successfully', async () => {
      // Mock exists to make the file appear to exist
      mockFileOperations.exists.mockResolvedValueOnce(true);

      const result = await deleteElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
      });

      // Memories use fileOperations.deleteFile
      expect(mockFileOperations.deleteFile).toHaveBeenCalledWith(
        '/mock/memories/2025-10-24/test-memory.yaml',
        ElementType.MEMORY,
        expect.objectContaining({ source: 'deleteElement.deleteMemory' })
      );
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('deleteData option handling', () => {
    it('should handle deleteData for standard elements (skills have data files)', async () => {
      // This tests the data file prompt logic
      // Note: Full data file handling requires integration tests
      const result = await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      // Should succeed without data files
      expect(mockContext.skillManager.delete).toHaveBeenCalledWith('test-skill.md');
      expect(result.content[0].text).toContain('✅');
    });

    it('should prompt for confirmation when agent has state files', async () => {
      // Mock stat to succeed, simulating an existing state file
      mockFileOperations.stat.mockResolvedValueOnce({ size: 1024 } as any);

      const result = await deleteElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        // Note: deleteData is undefined, which triggers the prompt
      });

      // Should NOT delete when data files exist and deleteData is undefined
      expect(mockContext.agentManager.delete).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('⚠️');
      expect(result.content[0].text).toContain('associated data files');
      expect(result.content[0].text).toContain('.state/test-agent-state.json');
    });

    it('should delete agent with state files when deleteData is true', async () => {
      // Mock stat to succeed, simulating an existing state file
      mockFileOperations.stat.mockResolvedValueOnce({ size: 1024 } as any);

      const result = await deleteElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        deleteData: true,
      });

      // Should delete both agent and data files
      // Use path.join for cross-platform compatibility (Windows uses backslashes)
      const expectedStatePath = path.join('/mock/elements', '.state', 'test-agent-state.json');
      expect(mockContext.agentManager.delete).toHaveBeenCalledWith('test-agent.md');
      expect(mockFileOperations.deleteFile).toHaveBeenCalledWith(
        expectedStatePath,
        ElementType.AGENT,
        expect.objectContaining({ source: 'deleteElement.removeDataFiles' })
      );
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('deleted');
    });

    it('should delete agent but preserve state files when deleteData is false', async () => {
      // Mock stat to succeed, simulating an existing state file
      mockFileOperations.stat.mockResolvedValueOnce({ size: 1024 } as any);

      const result = await deleteElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        deleteData: false,
      });

      // Should delete agent but NOT data files
      expect(mockContext.agentManager.delete).toHaveBeenCalledWith('test-agent.md');
      expect(mockFileOperations.deleteFile).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('preserved');
    });
  });

  describe('error handling', () => {
    // FIX: Wrap Error throwing in async functions to avoid Jest warnings
    // Jest was flagging Error construction in mockRejectedValue as unhandled,
    // but using mockImplementation with async throw avoids this false positive

    it('should handle manager.list errors gracefully', async () => {
      mockContext.skillManager.list = jest.fn().mockImplementation(async () => {
        throw new Error('List failed');
      });

      const result = await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('❌ Failed to delete element');
      expect(result.content[0].text).toContain('List failed');
    });

    it('should handle manager.delete errors gracefully', async () => {
      mockContext.skillManager.delete = jest.fn().mockImplementation(async () => {
        throw new Error('Delete failed');
      });

      const result = await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('❌ Failed to delete element');
      expect(result.content[0].text).toContain('Delete failed');
    });

    it('should handle ensureInitialized errors gracefully', async () => {
      mockContext.ensureInitialized = jest.fn().mockImplementation(async () => {
        throw new Error('Init failed');
      });

      // Note: ensureInitialized is called BEFORE the try-catch block,
      // so this will throw instead of returning an error message
      await expect(deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      })).rejects.toThrow('Init failed');
    });

    it('should handle non-Error rejections', async () => {
      // When a rejection is not an Error object
      mockContext.skillManager.list = jest.fn().mockImplementation(async () => {
        throw 'String error object';
      });

      const result = await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('❌ Failed to delete element');
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('should handle fileOperations.deleteFile errors for memories', async () => {
      // Mock exists to succeed (file exists), then deleteFile to fail
      mockFileOperations.exists.mockResolvedValueOnce(true);
      mockFileOperations.deleteFile.mockRejectedValueOnce(new Error('Permission denied'));

      const result = await deleteElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
      });

      expect(result.content[0].text).toContain('❌ Failed to delete element');
      expect(result.content[0].text).toContain('Permission denied');
    });
  });

  describe('initialization', () => {
    it('should call ensureInitialized', async () => {
      await deleteElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(mockContext.ensureInitialized).toHaveBeenCalled();
    });
  });
});
