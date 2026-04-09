/**
 * Unit tests for SchemaDispatcher
 *
 * Tests the schema-driven dispatch mechanism including:
 * - Operation routing to handlers
 * - Parameter validation
 * - Argument building
 * - Error handling
 */

import { jest } from '@jest/globals';
import { SchemaDispatcher, __test__ } from '../../../../src/handlers/mcp-aql/SchemaDispatcher.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';

const { getNestedValue, SAFE_PATH_PATTERN, FORBIDDEN_PATHS } = __test__;

describe('SchemaDispatcher', () => {
  // Mock handlers for testing
  const mockCollectionHandler = {
    browseCollection: jest.fn().mockResolvedValue({ items: [] }),
    searchCollection: jest.fn().mockResolvedValue({ results: [] }),
    searchCollectionEnhanced: jest.fn().mockResolvedValue({ results: [] }),
    getCollectionContent: jest.fn().mockResolvedValue({ content: 'test' }),
    getCollectionCacheHealth: jest.fn().mockResolvedValue({ healthy: true }),
    installContent: jest.fn().mockResolvedValue({ installed: true }),
    submitContent: jest.fn().mockResolvedValue({ submitted: true }),
  };

  const mockAuthHandler = {
    setupGitHubAuth: jest.fn().mockResolvedValue({ url: 'https://github.com' }),
    checkGitHubAuth: jest.fn().mockResolvedValue({ authenticated: true }),
    clearGitHubAuth: jest.fn().mockResolvedValue({ cleared: true }),
    configureOAuth: jest.fn().mockResolvedValue({ configured: true }),
    getOAuthHelperStatus: jest.fn().mockResolvedValue({ status: 'running' }),
  };

  const mockEnhancedIndexHandler = {
    findSimilarElements: jest.fn().mockResolvedValue({ similar: [] }),
    getElementRelationships: jest.fn().mockResolvedValue({ relationships: [] }),
    searchByVerb: jest.fn().mockResolvedValue({ results: [] }),
    getRelationshipStats: jest.fn().mockResolvedValue({ stats: {} }),
  };

  const mockTemplateRenderer = {
    render: jest.fn().mockResolvedValue('rendered content'),
  };

  const mockPersonaHandler = {
    importPersona: jest.fn().mockResolvedValue({ imported: true }),
  };

  const mockConfigHandler = {
    handleConfigOperation: jest.fn().mockResolvedValue({ config: {} }),
  };

  const mockBuildInfoService = {
    getBuildInfo: jest.fn().mockResolvedValue({ version: '1.0.0' }),
    formatBuildInfo: jest.fn().mockReturnValue('Build Info: 1.0.0'),
  };

  const mockRegistry: HandlerRegistry = {
    elementCRUD: {} as any,
    memoryManager: {} as any,
    agentManager: {} as any,
    templateRenderer: mockTemplateRenderer as any,
    elementQueryService: {} as any,
    collectionHandler: mockCollectionHandler as any,
    authHandler: mockAuthHandler as any,
    enhancedIndexHandler: mockEnhancedIndexHandler as any,
    personaHandler: mockPersonaHandler as any,
    configHandler: mockConfigHandler as any,
    buildInfoService: mockBuildInfoService as any,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('canDispatch()', () => {
    it('should return true for schema-driven operations', () => {
      expect(SchemaDispatcher.canDispatch('browse_collection')).toBe(true);
      expect(SchemaDispatcher.canDispatch('setup_github_auth')).toBe(true);
      expect(SchemaDispatcher.canDispatch('render')).toBe(true);
      expect(SchemaDispatcher.canDispatch('introspect')).toBe(true);
    });

    it('should return false for legacy operations', () => {
      // Legacy operations not yet migrated to schema
      expect(SchemaDispatcher.canDispatch('execute_agent')).toBe(false);
      expect(SchemaDispatcher.canDispatch('addEntry')).toBe(false);
      expect(SchemaDispatcher.canDispatch('activate_element')).toBe(false);
    });

    it('should return true for ElementCRUD operations (Issue #251)', () => {
      // ElementCRUD operations are now schema-driven
      expect(SchemaDispatcher.canDispatch('create_element')).toBe(true);
      expect(SchemaDispatcher.canDispatch('list_elements')).toBe(true);
      expect(SchemaDispatcher.canDispatch('get_element')).toBe(true);
      expect(SchemaDispatcher.canDispatch('edit_element')).toBe(true);
      expect(SchemaDispatcher.canDispatch('delete_element')).toBe(true);
    });
  });

  describe('dispatch() - Collection operations', () => {
    it('should dispatch browse_collection', async () => {
      await SchemaDispatcher.dispatch(
        'browse_collection',
        { section: 'skills', type: 'productivity' },
        mockRegistry
      );

      expect(mockCollectionHandler.browseCollection).toHaveBeenCalledWith(
        'skills',
        'productivity'
      );
    });

    it('should dispatch search_collection', async () => {
      await SchemaDispatcher.dispatch(
        'search_collection',
        { query: 'test' },
        mockRegistry
      );

      expect(mockCollectionHandler.searchCollection).toHaveBeenCalledWith('test');
    });

    it('should dispatch search_collection_enhanced with spread args', async () => {
      await SchemaDispatcher.dispatch(
        'search_collection_enhanced',
        { query: 'test', limit: 10 },
        mockRegistry
      );

      expect(mockCollectionHandler.searchCollectionEnhanced).toHaveBeenCalledWith(
        'test',
        { query: 'test', limit: 10 }
      );
    });

    it('should dispatch get_collection_cache_health with no args', async () => {
      await SchemaDispatcher.dispatch(
        'get_collection_cache_health',
        {},
        mockRegistry
      );

      expect(mockCollectionHandler.getCollectionCacheHealth).toHaveBeenCalled();
    });
  });

  describe('dispatch() - Auth operations', () => {
    it('should dispatch setup_github_auth', async () => {
      await SchemaDispatcher.dispatch(
        'setup_github_auth',
        {},
        mockRegistry
      );

      expect(mockAuthHandler.setupGitHubAuth).toHaveBeenCalled();
    });

    it('should dispatch check_github_auth', async () => {
      await SchemaDispatcher.dispatch(
        'check_github_auth',
        {},
        mockRegistry
      );

      expect(mockAuthHandler.checkGitHubAuth).toHaveBeenCalled();
    });

    it('should dispatch configure_oauth with client_id', async () => {
      await SchemaDispatcher.dispatch(
        'configure_oauth',
        { client_id: 'test-client-id' },
        mockRegistry
      );

      expect(mockAuthHandler.configureOAuth).toHaveBeenCalledWith('test-client-id');
    });
  });

  describe('dispatch() - Enhanced Index operations', () => {
    it('should dispatch find_similar_elements with mapped params', async () => {
      await SchemaDispatcher.dispatch(
        'find_similar_elements',
        { element_name: 'TestPersona', element_type: 'persona', limit: 5 },
        mockRegistry
      );

      expect(mockEnhancedIndexHandler.findSimilarElements).toHaveBeenCalledWith({
        elementName: 'TestPersona',
        elementType: 'persona',
        limit: 5,
        threshold: 0.5, // default value
      });
    });

    it('should dispatch search_by_verb with default limit', async () => {
      await SchemaDispatcher.dispatch(
        'search_by_verb',
        { verb: 'create' },
        mockRegistry
      );

      expect(mockEnhancedIndexHandler.searchByVerb).toHaveBeenCalledWith({
        verb: 'create',
        limit: 20, // default value
      });
    });
  });

  describe('dispatch() - Template operations', () => {
    it('should dispatch render', async () => {
      // Issue #290: Use element_name for consistency
      await SchemaDispatcher.dispatch(
        'render',
        { element_name: 'TestTemplate', variables: { foo: 'bar' } },
        mockRegistry
      );

      expect(mockTemplateRenderer.render).toHaveBeenCalledWith(
        'TestTemplate',
        { foo: 'bar' },
        undefined,
        undefined
      );
    });
  });

  describe('dispatch() - Persona operations', () => {
    it('should dispatch import_persona', async () => {
      await SchemaDispatcher.dispatch(
        'import_persona',
        { source: '/path/to/persona.md', overwrite: true },
        mockRegistry
      );

      expect(mockPersonaHandler.importPersona).toHaveBeenCalledWith(
        '/path/to/persona.md',
        true
      );
    });
  });

  describe('dispatch() - Config operations', () => {
    it('should dispatch dollhouse_config', async () => {
      await SchemaDispatcher.dispatch(
        'dollhouse_config',
        { action: 'get', setting: 'debug' },
        mockRegistry
      );

      expect(mockConfigHandler.handleConfigOperation).toHaveBeenCalledWith({
        action: 'get',
        setting: 'debug',
      });
    });

    it('should dispatch get_build_info', async () => {
      const result = await SchemaDispatcher.dispatch(
        'get_build_info',
        {},
        mockRegistry
      );

      expect(mockBuildInfoService.getBuildInfo).toHaveBeenCalled();
      expect(mockBuildInfoService.formatBuildInfo).toHaveBeenCalled();
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Build Info: 1.0.0' }],
      });
    });
  });

  describe('dispatch() - Introspection', () => {
    it('should dispatch introspect', async () => {
      const result = await SchemaDispatcher.dispatch(
        'introspect',
        { query: 'operations' },
        mockRegistry
      );

      // Introspect returns operation list
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });
  });

  describe('dispatch() - Error handling', () => {
    it('should throw for unknown operations', async () => {
      await expect(
        SchemaDispatcher.dispatch('nonexistent', {}, mockRegistry)
      ).rejects.toThrow("No schema definition found for operation 'nonexistent'");
    });

    it('should throw for missing required params', async () => {
      await expect(
        SchemaDispatcher.dispatch('search_collection', {}, mockRegistry)
      ).rejects.toThrow("Missing required parameter 'query' for operation 'search_collection'");
    });

    it('should throw for missing handler', async () => {
      const registryWithoutCollection = {
        ...mockRegistry,
        collectionHandler: undefined,
      };

      await expect(
        SchemaDispatcher.dispatch('browse_collection', {}, registryWithoutCollection)
      ).rejects.toThrow('CollectionHandler operations not available');
    });
  });

  describe('dispatch() - ElementCRUD input normalization (Issue #251)', () => {
    const mockElementCRUD = {
      createElement: jest.fn().mockResolvedValue({ name: 'TestElement', type: 'persona' }),
      listElements: jest.fn().mockResolvedValue([]),
      getElementDetails: jest.fn().mockResolvedValue({ name: 'TestElement' }),
      editElement: jest.fn().mockResolvedValue({ edited: true }),
      validateElement: jest.fn().mockResolvedValue({ valid: true }),
      deleteElement: jest.fn().mockResolvedValue({ deleted: true }),
    };

    const registryWithElementCRUD = {
      ...mockRegistry,
      elementCRUD: mockElementCRUD as any,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should resolve type from input.elementType when params.element_type is missing', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        { element_name: 'TestPersona', description: 'A test persona' },
        registryWithElementCRUD,
        { operation: 'create_element', elementType: 'persona', params: {} }
      );

      // Issue #290: mapTo converts element_name->elementName, element_type->elementType
      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'TestPersona',
          elementType: 'persona',
          description: 'A test persona',
        })
      );
    });

    it('should resolve type from params.type when input.elementType is missing', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        { element_name: 'TestSkill', element_type: 'skill', description: 'A test skill' },
        registryWithElementCRUD,
        { operation: 'create_element', params: { element_type: 'skill' } }
      );

      // Issue #290: mapTo converts element_name->elementName, element_type->elementType
      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'TestSkill',
          elementType: 'skill',
          description: 'A test skill',
        })
      );
    });

    it('should prefer input.elementType over params.element_type (source order)', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        { element_name: 'TestElement', element_type: 'template', description: 'Test' },
        registryWithElementCRUD,
        { operation: 'create_element', elementType: 'persona', params: { element_type: 'template' } }
      );

      // input.elementType is checked first in sources array
      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementType: 'persona',
        })
      );
    });

    it('should handle list_elements with type from input', async () => {
      await SchemaDispatcher.dispatch(
        'list_elements',
        {},
        registryWithElementCRUD,
        { operation: 'list_elements', elementType: 'skill', params: {} }
      );

      // typeWithParams argBuilder passes (type, fullParams)
      expect(mockElementCRUD.listElements).toHaveBeenCalledWith('skill', {});
    });

    it('should handle get_element with type from input', async () => {
      await SchemaDispatcher.dispatch(
        'get_element',
        { element_name: 'MyPersona' },
        registryWithElementCRUD,
        { operation: 'get_element', elementType: 'persona', params: {} }
      );

      expect(mockElementCRUD.getElementDetails).toHaveBeenCalledWith('MyPersona', 'persona');
    });

    it('should handle edit_element with namedWithType argBuilder', async () => {
      await SchemaDispatcher.dispatch(
        'edit_element',
        { element_name: 'MyPersona', input: { description: 'Updated description' } },
        registryWithElementCRUD,
        { operation: 'edit_element', elementType: 'persona', params: {} }
      );

      // Issue #290: mapTo converts element_name->elementName, element_type->elementType
      expect(mockElementCRUD.editElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'MyPersona',
          elementType: 'persona',
          input: { description: 'Updated description' },
        })
      );
    });

    it('should merge top-level template variables into metadata on create_element', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'RenderTemplate',
          description: 'A renderable template',
          content: 'Hello {{name}}',
          variables: [{ name: 'name', type: 'string', required: true }],
        },
        registryWithElementCRUD,
        { operation: 'create_element', elementType: 'template', params: {} }
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'RenderTemplate',
          elementType: 'template',
          metadata: {
            variables: [{ name: 'name', type: 'string', required: true }],
          },
        })
      );
    });

    it('should throw if type cannot be resolved from any source', async () => {
      await expect(
        SchemaDispatcher.dispatch(
          'create_element',
          { element_name: 'NoType', description: 'Missing type' },
          registryWithElementCRUD,
          { operation: 'create_element', params: {} }
        )
      ).rejects.toThrow("Missing required parameter 'element_type'");
    });

    describe('Security - Path validation', () => {
      it('should validate paths and handle valid schema sources', async () => {
        // The schema uses predefined safe paths like 'input.elementType' and 'params.element_type'
        // This test verifies that valid paths work correctly
        const validInput = {
          operation: 'list_elements',
          elementType: 'persona',
          params: { element_type: 'persona' },
        };

        await SchemaDispatcher.dispatch(
          'list_elements',
          { element_type: 'persona' },
          registryWithElementCRUD,
          validInput
        );

        // Verify the handler was called (paths validated internally)
        expect(mockElementCRUD.listElements).toHaveBeenCalled();
      });

      it('should use validated source resolution for create_element', async () => {
        // Valid paths should work - tests the path validation in getNestedValue
        const validInput = {
          operation: 'create_element',
          elementType: 'persona',
          params: { element_name: 'test', description: 'Test', element_type: 'persona' },
        };

        await SchemaDispatcher.dispatch(
          'create_element',
          { element_name: 'test', description: 'Test' },
          registryWithElementCRUD,
          validInput
        );

        expect(mockElementCRUD.createElement).toHaveBeenCalled();
      });
    });
  });

  describe('dispatch() - Portfolio paramStyle conversion (Issue #252)', () => {
    const mockPortfolioHandler = {
      portfolioStatus: jest.fn().mockResolvedValue({ status: 'ok' }),
      initPortfolio: jest.fn().mockResolvedValue({ initialized: true }),
      portfolioConfig: jest.fn().mockResolvedValue({ configured: true }),
      syncPortfolio: jest.fn().mockResolvedValue({ synced: true }),
      searchPortfolio: jest.fn().mockResolvedValue({ results: [] }),
      searchAll: jest.fn().mockResolvedValue({ results: [] }),
    };

    const mockSyncHandler = {
      handleSyncOperation: jest.fn().mockResolvedValue({ completed: true }),
    };

    const registryWithPortfolio = {
      ...mockRegistry,
      portfolioHandler: mockPortfolioHandler as any,
      syncHandler: mockSyncHandler as any,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should convert snake_case params to camelCase', async () => {
      await SchemaDispatcher.dispatch(
        'sync_portfolio',
        { direction: 'push', dry_run: true, confirm_deletions: false },
        registryWithPortfolio
      );

      expect(mockPortfolioHandler.syncPortfolio).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'push',
          dryRun: true,
          confirmDeletions: false,
        })
      );
    });

    it('should apply default values during conversion', async () => {
      await SchemaDispatcher.dispatch(
        'sync_portfolio',
        { direction: 'pull' },
        registryWithPortfolio
      );

      expect(mockPortfolioHandler.syncPortfolio).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'pull',
          force: false,
          dryRun: false,
        })
      );
    });

    it('should respect mapTo override over paramStyle', async () => {
      await SchemaDispatcher.dispatch(
        'search_portfolio',
        { query: 'test', type: 'persona', fuzzy_match: true },
        registryWithPortfolio
      );

      // 'type' should map to 'elementType' (explicit mapTo)
      // 'fuzzy_match' should convert to 'fuzzyMatch' (paramStyle)
      expect(mockPortfolioHandler.searchPortfolio).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          elementType: 'persona',
          fuzzyMatch: true,
        })
      );
    });

    it('should handle search_all with multiple snake_case params', async () => {
      await SchemaDispatcher.dispatch(
        'search_all',
        { query: 'test', page_size: 20, sort_by: 'name' },
        registryWithPortfolio
      );

      expect(mockPortfolioHandler.searchAll).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          pageSize: 20,
          sortBy: 'name',
        })
      );
    });

    it('should handle init_portfolio with snake_case params', async () => {
      await SchemaDispatcher.dispatch(
        'init_portfolio',
        { repository_name: 'my-portfolio', private: true },
        registryWithPortfolio
      );

      expect(mockPortfolioHandler.initPortfolio).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryName: 'my-portfolio',
          private: true,
        })
      );
    });

    it('should dispatch portfolio_element_manager to syncHandler', async () => {
      await SchemaDispatcher.dispatch(
        'portfolio_element_manager',
        { operation: 'download', element_name: 'TestPersona', element_type: 'persona' },
        registryWithPortfolio
      );

      expect(mockSyncHandler.handleSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'download',
          element_name: 'TestPersona',
          element_type: 'persona',
        })
      );
    });
  });

  /**
   * Issue #134 - Agent V2 field merging
   * Tests that V2 fields passed at top level are merged into metadata
   */
  describe('dispatch() - Agent V2 field merging (Issue #134)', () => {
    const mockElementCRUD = {
      createElement: jest.fn().mockResolvedValue({ name: 'TestAgent', type: 'agent' }),
      listElements: jest.fn().mockResolvedValue([]),
      getElementDetails: jest.fn().mockResolvedValue({ name: 'TestAgent' }),
      editElement: jest.fn().mockResolvedValue({ edited: true }),
      validateElement: jest.fn().mockResolvedValue({ valid: true }),
      deleteElement: jest.fn().mockResolvedValue({ deleted: true }),
    };

    const registryWithElementCRUD = {
      ...mockRegistry,
      elementCRUD: mockElementCRUD as any,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should merge systemPrompt from top level into metadata', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'TestAgent',
          element_type: 'agent',
          description: 'A test agent',
          systemPrompt: 'You are a helpful assistant.',
        },
        registryWithElementCRUD
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'TestAgent',
          elementType: 'agent',
          metadata: expect.objectContaining({
            systemPrompt: 'You are a helpful assistant.',
          }),
        })
      );
    });

    it('should merge system_prompt (snake_case) from top level into metadata as systemPrompt (Issue #725)', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'SnakePromptAgent',
          element_type: 'agent',
          description: 'A test agent',
          system_prompt: 'You are a snake_case assistant.',
        },
        registryWithElementCRUD
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'SnakePromptAgent',
          elementType: 'agent',
          metadata: expect.objectContaining({
            systemPrompt: 'You are a snake_case assistant.',
          }),
        })
      );
    });

    it('should merge goal from top level into metadata', async () => {
      const goal = {
        template: 'Complete {task}',
        parameters: [{ name: 'task', type: 'string', required: true }],
      };

      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'TestAgent',
          element_type: 'agent',
          description: 'A test agent',
          goal,
        },
        registryWithElementCRUD
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'TestAgent',
          elementType: 'agent',
          metadata: expect.objectContaining({
            goal,
          }),
        })
      );
    });

    it('should merge activates from top level into metadata', async () => {
      const activates = {
        personas: ['reviewer'],
        skills: ['code-analysis'],
      };

      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'TestAgent',
          element_type: 'agent',
          description: 'A test agent',
          activates,
        },
        registryWithElementCRUD
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'TestAgent',
          elementType: 'agent',
          metadata: expect.objectContaining({
            activates,
          }),
        })
      );
    });

    it('should merge tools from top level into metadata', async () => {
      const tools = {
        allowed: ['read_file', 'search'],
        denied: ['delete_file'],
      };

      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'TestAgent',
          element_type: 'agent',
          description: 'A test agent',
          tools,
        },
        registryWithElementCRUD
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'TestAgent',
          elementType: 'agent',
          metadata: expect.objectContaining({
            tools,
          }),
        })
      );
    });

    it('should merge autonomy from top level into metadata', async () => {
      const autonomy = {
        riskTolerance: 'moderate',
        maxAutonomousSteps: 10,
      };

      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'TestAgent',
          element_type: 'agent',
          description: 'A test agent',
          autonomy,
        },
        registryWithElementCRUD
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'TestAgent',
          elementType: 'agent',
          metadata: expect.objectContaining({
            autonomy,
          }),
        })
      );
    });

    it('should merge all V2 fields from top level into metadata', async () => {
      const v2Fields = {
        goal: { template: 'Test goal', parameters: [] },
        activates: { personas: ['test'] },
        tools: { allowed: ['read'], denied: [] },
        systemPrompt: 'Test prompt',
        autonomy: { riskTolerance: 'low' },
      };

      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'CompleteAgent',
          element_type: 'agent',
          description: 'Complete V2 agent',
          ...v2Fields,
        },
        registryWithElementCRUD
      );

      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          elementName: 'CompleteAgent',
          elementType: 'agent',
          metadata: expect.objectContaining(v2Fields),
        })
      );
    });

    it('should NOT overwrite V2 fields already in metadata', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'TestAgent',
          element_type: 'agent',
          description: 'A test agent',
          systemPrompt: 'Top level prompt',
          metadata: {
            systemPrompt: 'Metadata prompt',
          },
        },
        registryWithElementCRUD
      );

      // Should keep the metadata value, not overwrite with top-level
      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            systemPrompt: 'Metadata prompt',
          }),
        })
      );
    });

    it('should NOT merge V2 fields for non-agent types', async () => {
      await SchemaDispatcher.dispatch(
        'create_element',
        {
          element_name: 'TestPersona',
          element_type: 'persona',
          description: 'A test persona',
          systemPrompt: 'Should not be merged',
        },
        registryWithElementCRUD
      );

      // For non-agent types, systemPrompt should NOT be in metadata
      expect(mockElementCRUD.createElement).toHaveBeenCalledWith(
        expect.not.objectContaining({
          metadata: expect.objectContaining({
            systemPrompt: 'Should not be merged',
          }),
        })
      );
    });
  });

  /**
   * Issue #255 - Runtime type validation
   */
  describe('dispatch() - Type validation', () => {
    describe('string type validation', () => {
      it('should accept valid string parameter', async () => {
        await SchemaDispatcher.dispatch(
          'search_collection',
          { query: 'test query' },
          mockRegistry
        );

        expect(mockCollectionHandler.searchCollection).toHaveBeenCalledWith('test query');
      });

      it('should reject number when string expected', async () => {
        await expect(
          SchemaDispatcher.dispatch('search_collection', { query: 123 }, mockRegistry)
        ).rejects.toThrow("Parameter 'query' for operation 'search_collection' must be a string, got number");
      });

      it('should reject object when string expected', async () => {
        await expect(
          SchemaDispatcher.dispatch('search_collection', { query: { foo: 'bar' } }, mockRegistry)
        ).rejects.toThrow("Parameter 'query' for operation 'search_collection' must be a string, got object");
      });

      it('should reject null when string expected', async () => {
        await expect(
          SchemaDispatcher.dispatch('search_collection', { query: null }, mockRegistry)
        ).rejects.toThrow("Parameter 'query' for operation 'search_collection' must be a string, got null");
      });

      it('should reject array when string expected', async () => {
        await expect(
          SchemaDispatcher.dispatch('search_collection', { query: ['test'] }, mockRegistry)
        ).rejects.toThrow("Parameter 'query' for operation 'search_collection' must be a string, got array");
      });
    });

    describe('number type validation', () => {
      it('should accept valid number parameter', async () => {
        await SchemaDispatcher.dispatch(
          'find_similar_elements',
          { element_name: 'test', limit: 10, threshold: 0.5 },
          mockRegistry
        );

        expect(mockEnhancedIndexHandler.findSimilarElements).toHaveBeenCalled();
      });

      it('should reject string when number expected', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'find_similar_elements',
            { element_name: 'test', limit: 'ten' },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'limit' for operation 'find_similar_elements' must be a number, got string");
      });

      it('should reject NaN', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'find_similar_elements',
            { element_name: 'test', limit: NaN },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'limit' for operation 'find_similar_elements' must be a number, got number");
      });
    });

    describe('boolean type validation', () => {
      it('should accept valid boolean parameter', async () => {
        await SchemaDispatcher.dispatch(
          'import_persona',
          { source: '/path/to/file', overwrite: true },
          mockRegistry
        );

        expect(mockPersonaHandler.importPersona).toHaveBeenCalledWith('/path/to/file', true);
      });

      it('should reject string when boolean expected', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'import_persona',
            { source: '/path/to/file', overwrite: 'true' },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'overwrite' for operation 'import_persona' must be a boolean, got string");
      });

      it('should reject number when boolean expected', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'import_persona',
            { source: '/path/to/file', overwrite: 1 },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'overwrite' for operation 'import_persona' must be a boolean, got number");
      });
    });

    describe('object type validation', () => {
      it('should accept valid object parameter', async () => {
        // Issue #290: Use element_name for render operation
        await SchemaDispatcher.dispatch(
          'render',
          { element_name: 'test', variables: { foo: 'bar' } },
          mockRegistry
        );

        expect(mockTemplateRenderer.render).toHaveBeenCalledWith('test', { foo: 'bar' }, undefined, undefined);
      });

      it('should reject string when object expected', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'render',
            { element_name: 'test', variables: 'not an object' },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'variables' for operation 'render' must be an object, got string");
      });

      it('should reject array when object expected', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'render',
            { element_name: 'test', variables: ['array'] },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'variables' for operation 'render' must be an object, got array");
      });

      it('should reject null when object expected', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'render',
            { element_name: 'test', variables: null },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'variables' for operation 'render' must be an object, got null");
      });
    });

    describe('string[] type validation', () => {
      it('should accept valid string array parameter', async () => {
        await SchemaDispatcher.dispatch(
          'get_element_relationships',
          { element_name: 'test', relationship_types: ['similar', 'depends'] },
          mockRegistry
        );

        expect(mockEnhancedIndexHandler.getElementRelationships).toHaveBeenCalled();
      });

      it('should reject non-array when string[] expected', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'get_element_relationships',
            { element_name: 'test', relationship_types: 'similar' },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'relationship_types' for operation 'get_element_relationships' must be a string array, got string");
      });

      it('should reject array with non-string elements', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'get_element_relationships',
            { element_name: 'test', relationship_types: ['similar', 123] },
            mockRegistry
          )
        ).rejects.toThrow("Parameter 'relationship_types[1]' for operation 'get_element_relationships' must be a string, got number");
      });
    });

    describe('optional parameter validation', () => {
      it('should allow undefined for optional parameters', async () => {
        await SchemaDispatcher.dispatch(
          'find_similar_elements',
          { element_name: 'test' }, // limit and threshold are optional
          mockRegistry
        );

        expect(mockEnhancedIndexHandler.findSimilarElements).toHaveBeenCalled();
      });

      it('should still validate type when optional param is provided', async () => {
        await expect(
          SchemaDispatcher.dispatch(
            'find_similar_elements',
            { element_name: 'test', limit: 'ten' },
            mockRegistry
          )
        ).rejects.toThrow("must be a number");
      });
    });
  });

  /**
   * Security tests for getNestedValue path validation
   * Verifies protection against prototype pollution and path injection attacks
   */
  describe('Security - getNestedValue path validation', () => {
    const testObj = {
      input: { elementType: 'persona', name: 'test' },
      params: { element_type: 'skill' },
      nested: { deep: { value: 42 } },
    };

    describe('valid paths', () => {
      it('should resolve simple paths', () => {
        expect(getNestedValue(testObj, 'input')).toEqual({ elementType: 'persona', name: 'test' });
      });

      it('should resolve nested paths', () => {
        expect(getNestedValue(testObj, 'input.elementType')).toBe('persona');
        expect(getNestedValue(testObj, 'nested.deep.value')).toBe(42);
      });

      it('should return undefined for missing paths', () => {
        expect(getNestedValue(testObj, 'nonexistent')).toBeUndefined();
        expect(getNestedValue(testObj, 'input.missing')).toBeUndefined();
      });

      it('should handle paths with underscores', () => {
        expect(getNestedValue(testObj, 'params.element_type')).toBe('skill');
      });

      it('should handle paths starting with $ or _', () => {
        const obj = { $special: 'value', _private: 'data' };
        expect(getNestedValue(obj, '$special')).toBe('value');
        expect(getNestedValue(obj, '_private')).toBe('data');
      });
    });

    describe('prototype pollution protection', () => {
      it('should block __proto__ path segment', () => {
        expect(() => getNestedValue(testObj, '__proto__')).toThrow('Forbidden property path segment: __proto__');
      });

      it('should block __proto__ in nested path', () => {
        expect(() => getNestedValue(testObj, 'input.__proto__')).toThrow('Forbidden property path segment: __proto__');
      });

      it('should block __proto__ anywhere in path', () => {
        expect(() => getNestedValue(testObj, '__proto__.polluted')).toThrow('Forbidden property path segment: __proto__');
      });

      it('should block constructor path segment', () => {
        expect(() => getNestedValue(testObj, 'constructor')).toThrow('Forbidden property path segment: constructor');
      });

      it('should block constructor in nested path', () => {
        expect(() => getNestedValue(testObj, 'input.constructor')).toThrow('Forbidden property path segment: constructor');
      });

      it('should block prototype path segment', () => {
        expect(() => getNestedValue(testObj, 'prototype')).toThrow('Forbidden property path segment: prototype');
      });

      it('should block prototype in nested path', () => {
        expect(() => getNestedValue(testObj, 'constructor.prototype')).toThrow('Forbidden property path segment: constructor');
      });
    });

    describe('path format validation', () => {
      it('should reject paths with special characters', () => {
        expect(() => getNestedValue(testObj, 'input[0]')).toThrow('Invalid property path format');
        expect(() => getNestedValue(testObj, 'input["key"]')).toThrow('Invalid property path format');
      });

      it('should reject paths with semicolons (injection attempt)', () => {
        expect(() => getNestedValue(testObj, 'input;malicious')).toThrow('Invalid property path format');
      });

      it('should reject paths with parentheses (function call attempt)', () => {
        expect(() => getNestedValue(testObj, 'toString()')).toThrow('Invalid property path format');
      });

      it('should reject paths starting with numbers', () => {
        expect(() => getNestedValue(testObj, '0.input')).toThrow('Invalid property path format');
      });

      it('should reject empty paths', () => {
        expect(() => getNestedValue(testObj, '')).toThrow('Invalid property path format');
      });

      it('should reject paths with spaces', () => {
        expect(() => getNestedValue(testObj, 'input value')).toThrow('Invalid property path format');
      });

      it('should reject paths with newlines', () => {
        expect(() => getNestedValue(testObj, 'input\nvalue')).toThrow('Invalid property path format');
      });
    });

    describe('security constants verification', () => {
      it('should have SAFE_PATH_PATTERN that matches valid identifiers', () => {
        expect(SAFE_PATH_PATTERN.test('validPath')).toBe(true);
        expect(SAFE_PATH_PATTERN.test('valid.nested.path')).toBe(true);
        expect(SAFE_PATH_PATTERN.test('_private')).toBe(true);
        expect(SAFE_PATH_PATTERN.test('$special')).toBe(true);
        expect(SAFE_PATH_PATTERN.test('camelCase')).toBe(true);
        expect(SAFE_PATH_PATTERN.test('snake_case')).toBe(true);
      });

      it('should have SAFE_PATH_PATTERN that rejects dangerous patterns', () => {
        expect(SAFE_PATH_PATTERN.test('')).toBe(false);
        expect(SAFE_PATH_PATTERN.test('path[0]')).toBe(false);
        expect(SAFE_PATH_PATTERN.test('func()')).toBe(false);
        expect(SAFE_PATH_PATTERN.test('a;b')).toBe(false);
      });

      it('should have FORBIDDEN_PATHS containing all prototype pollution vectors', () => {
        expect(FORBIDDEN_PATHS.has('__proto__')).toBe(true);
        expect(FORBIDDEN_PATHS.has('constructor')).toBe(true);
        expect(FORBIDDEN_PATHS.has('prototype')).toBe(true);
      });

      it('should not block legitimate paths in FORBIDDEN_PATHS', () => {
        expect(FORBIDDEN_PATHS.has('input')).toBe(false);
        expect(FORBIDDEN_PATHS.has('params')).toBe(false);
        expect(FORBIDDEN_PATHS.has('elementType')).toBe(false);
      });
    });
  });
});
