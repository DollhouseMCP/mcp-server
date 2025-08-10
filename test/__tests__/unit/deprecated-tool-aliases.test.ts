/**
 * Tests for backward compatibility of deprecated tool aliases
 */

import { jest } from '@jest/globals';
import { getCollectionTools } from '../../../src/server/tools/CollectionTools.js';
import { IToolHandler } from '../../../src/server/types.js';

describe('Deprecated Tool Aliases', () => {
  let mockServer: jest.Mocked<IToolHandler>;
  let tools: Array<{ tool: any; handler: any }>;
  
  beforeEach(() => {
    // Create a mock server with all required methods
    mockServer = {
      // @ts-ignore - TypeScript has issues with Jest mock types in strict mode
      browseCollection: jest.fn().mockResolvedValue({ content: [] }),
      // @ts-ignore
      searchCollection: jest.fn().mockResolvedValue({ results: [] }),
      // @ts-ignore
      getCollectionContent: jest.fn().mockResolvedValue({ content: {} }),
      // @ts-ignore
      installContent: jest.fn().mockResolvedValue({ success: true }),
      // @ts-ignore
      submitContent: jest.fn().mockResolvedValue({ success: true }),
      // @ts-ignore
      getCollectionCacheHealth: jest.fn().mockResolvedValue({ status: 'healthy' })
    } as any;
    
    tools = getCollectionTools(mockServer);
  });

  describe('Tool Registration', () => {
    it('should register exactly 11 tools (6 new + 5 deprecated)', () => {
      expect(tools).toHaveLength(11);
    });

    it('should have all deprecated tool names registered', () => {
      const toolNames = tools.map(t => t.tool.name);
      expect(toolNames).toContain('browse_marketplace');
      expect(toolNames).toContain('search_marketplace');
      expect(toolNames).toContain('get_marketplace_persona');
      expect(toolNames).toContain('install_persona');
      expect(toolNames).toContain('submit_persona');
    });

    it('should have all new tool names registered', () => {
      const toolNames = tools.map(t => t.tool.name);
      expect(toolNames).toContain('browse_collection');
      expect(toolNames).toContain('search_collection');
      expect(toolNames).toContain('get_collection_content');
      expect(toolNames).toContain('install_content');
      expect(toolNames).toContain('submit_content');
      expect(toolNames).toContain('get_collection_cache_health');
    });

    it('should mark deprecated tools with [DEPRECATED] prefix in description', () => {
      const deprecatedTools = tools.filter(t => 
        ['browse_marketplace', 'search_marketplace', 'get_marketplace_persona', 
         'install_persona', 'submit_persona'].includes(t.tool.name)
      );
      
      deprecatedTools.forEach(tool => {
        expect(tool.tool.description).toMatch(/^\[DEPRECATED - Use \w+\]/);
        expect(tool.tool.description).toContain('Will be removed in v2.0.0');
      });
    });
  });

  describe('Handler Functionality', () => {
    it('browse_marketplace should call browseCollection with same arguments', async () => {
      const browseMarketplaceTool = tools.find(t => t.tool.name === 'browse_marketplace');
      const browseCollectionTool = tools.find(t => t.tool.name === 'browse_collection');
      
      const args = { section: 'library', type: 'personas' };
      
      await browseMarketplaceTool!.handler(args);
      await browseCollectionTool!.handler(args);
      
      expect(mockServer.browseCollection).toHaveBeenCalledTimes(2);
      expect(mockServer.browseCollection).toHaveBeenCalledWith('library', 'personas');
    });

    it('search_marketplace should call searchCollection with same arguments', async () => {
      const searchMarketplaceTool = tools.find(t => t.tool.name === 'search_marketplace');
      const searchCollectionTool = tools.find(t => t.tool.name === 'search_collection');
      
      const args = { query: 'creative writer' };
      
      await searchMarketplaceTool!.handler(args);
      await searchCollectionTool!.handler(args);
      
      expect(mockServer.searchCollection).toHaveBeenCalledTimes(2);
      expect(mockServer.searchCollection).toHaveBeenCalledWith('creative writer');
    });

    it('get_marketplace_persona should call getCollectionContent with same arguments', async () => {
      const getMarketplacePersonaTool = tools.find(t => t.tool.name === 'get_marketplace_persona');
      const getCollectionContentTool = tools.find(t => t.tool.name === 'get_collection_content');
      
      const args = { path: 'library/personas/creative/writer.md' };
      
      await getMarketplacePersonaTool!.handler(args);
      await getCollectionContentTool!.handler(args);
      
      expect(mockServer.getCollectionContent).toHaveBeenCalledTimes(2);
      expect(mockServer.getCollectionContent).toHaveBeenCalledWith('library/personas/creative/writer.md');
    });

    it('install_persona should call installContent with same arguments', async () => {
      const installPersonaTool = tools.find(t => t.tool.name === 'install_persona');
      const installContentTool = tools.find(t => t.tool.name === 'install_content');
      
      const args = { path: 'library/personas/creative/writer.md' };
      
      await installPersonaTool!.handler(args);
      await installContentTool!.handler(args);
      
      expect(mockServer.installContent).toHaveBeenCalledTimes(2);
      expect(mockServer.installContent).toHaveBeenCalledWith('library/personas/creative/writer.md');
    });

    it('submit_persona should call submitContent with same arguments', async () => {
      const submitPersonaTool = tools.find(t => t.tool.name === 'submit_persona');
      const submitContentTool = tools.find(t => t.tool.name === 'submit_content');
      
      const args = { content: 'My Custom Persona' };
      
      await submitPersonaTool!.handler(args);
      await submitContentTool!.handler(args);
      
      expect(mockServer.submitContent).toHaveBeenCalledTimes(2);
      expect(mockServer.submitContent).toHaveBeenCalledWith('My Custom Persona');
    });
  });

  describe('Input Schema Compatibility', () => {
    it('deprecated tools should have identical input schemas to new tools', () => {
      const pairs = [
        ['browse_marketplace', 'browse_collection'],
        ['search_marketplace', 'search_collection'],
        ['get_marketplace_persona', 'get_collection_content'],
        ['install_persona', 'install_content'],
        ['submit_persona', 'submit_content']
      ];
      
      pairs.forEach(([oldName, newName]) => {
        const oldTool = tools.find(t => t.tool.name === oldName);
        const newTool = tools.find(t => t.tool.name === newName);
        
        expect(oldTool!.tool.inputSchema).toEqual(newTool!.tool.inputSchema);
      });
    });

    it('should maintain required fields in input schemas', () => {
      const searchMarketplace = tools.find(t => t.tool.name === 'search_marketplace');
      expect(searchMarketplace!.tool.inputSchema.required).toEqual(['query']);
      
      const getMarketplacePersona = tools.find(t => t.tool.name === 'get_marketplace_persona');
      expect(getMarketplacePersona!.tool.inputSchema.required).toEqual(['path']);
      
      const installPersona = tools.find(t => t.tool.name === 'install_persona');
      expect(installPersona!.tool.inputSchema.required).toEqual(['path']);
      
      const submitPersona = tools.find(t => t.tool.name === 'submit_persona');
      expect(submitPersona!.tool.inputSchema.required).toEqual(['content']);
    });
  });

  describe('Handler Identity', () => {
    it('deprecated tools should use the exact same handler instances as new tools', () => {
      const pairs = [
        ['browse_marketplace', 'browse_collection'],
        ['search_marketplace', 'search_collection'],
        ['get_marketplace_persona', 'get_collection_content'],
        ['install_persona', 'install_content'],
        ['submit_persona', 'submit_content']
      ];
      
      pairs.forEach(([oldName, newName]) => {
        const oldTool = tools.find(t => t.tool.name === oldName);
        const newTool = tools.find(t => t.tool.name === newName);
        
        // Handlers should be the exact same function reference
        expect(oldTool!.handler).toBe(newTool!.handler);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing optional arguments correctly', async () => {
      const browseMarketplace = tools.find(t => t.tool.name === 'browse_marketplace');
      
      // Test with no arguments
      await browseMarketplace!.handler({});
      expect(mockServer.browseCollection).toHaveBeenCalledWith(undefined, undefined);
      
      // Test with partial arguments
      await browseMarketplace!.handler({ section: 'library' });
      expect(mockServer.browseCollection).toHaveBeenCalledWith('library', undefined);
    });

    it('should handle null arguments gracefully', async () => {
      const browseMarketplace = tools.find(t => t.tool.name === 'browse_marketplace');
      
      await browseMarketplace!.handler(null);
      expect(mockServer.browseCollection).toHaveBeenCalledWith(undefined, undefined);
    });
  });
});