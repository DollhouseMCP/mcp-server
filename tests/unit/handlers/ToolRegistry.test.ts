import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const personaToolsFactory = jest.fn();
const elementToolsFactory = jest.fn();
const collectionToolsFactory = jest.fn();
const portfolioToolsFactory = jest.fn();
const authToolsFactory = jest.fn();
const configToolsFactory = jest.fn();
const enhancedIndexToolsFactory = jest.fn();
const buildInfoToolsFactory = jest.fn();

jest.unstable_mockModule('../../../src/server/tools/PersonaTools.js', () => ({
  getPersonaExportImportTools: personaToolsFactory,
}));

jest.unstable_mockModule('../../../src/server/tools/ElementTools.js', () => ({
  getElementTools: elementToolsFactory,
}));

jest.unstable_mockModule('../../../src/server/tools/CollectionTools.js', () => ({
  getCollectionTools: collectionToolsFactory,
}));

jest.unstable_mockModule('../../../src/server/tools/PortfolioTools.js', () => ({
  getPortfolioTools: portfolioToolsFactory,
}));

jest.unstable_mockModule('../../../src/server/tools/AuthTools.js', () => ({
  getAuthTools: authToolsFactory,
}));

jest.unstable_mockModule('../../../src/server/tools/ConfigToolsV2.js', () => ({
  getConfigToolsV2: configToolsFactory,
}));

jest.unstable_mockModule('../../../src/server/tools/EnhancedIndexTools.js', () => ({
  getEnhancedIndexTools: enhancedIndexToolsFactory,
}));

jest.unstable_mockModule('../../../src/server/tools/BuildInfoTools.js', () => ({
  getBuildInfoTools: buildInfoToolsFactory,
}));

const { ToolRegistry } = await import('../../../src/handlers/ToolRegistry.js');

describe('ToolRegistry', () => {
  let registry: InstanceType<typeof ToolRegistry>;
  const mockServer = {} as any;

  beforeEach(() => {
    registry = new ToolRegistry(mockServer);
    jest.clearAllMocks();
  });

  it('register should store tool definitions and handlers', () => {
    const handler = jest.fn<() => Promise<any>>();
    const tool = {
      name: 'test-tool',
      description: 'Test tool description',
      inputSchema: { type: 'object' as const, properties: {} },
    };

    registry.register(tool, handler);

    expect(registry.has('test-tool')).toBe(true);
    expect(registry.getHandler('test-tool')).toBe(handler);

    const allTools = registry.getAllTools();
    expect(allTools).toHaveLength(1);
    expect(allTools[0]).toEqual({
      name: 'test-tool',
      description: 'Test tool description',
      inputSchema: { type: 'object', properties: {} },
    });
  });

  it('registerMany should register multiple tools', () => {
    const handlerA = jest.fn<() => Promise<any>>();
    const handlerB = jest.fn<() => Promise<any>>();

    registry.registerMany([
      {
        tool: {
          name: 'tool-a',
          description: 'A',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: handlerA,
      },
      {
        tool: {
          name: 'tool-b',
          description: 'B',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: handlerB,
      },
    ]);

    expect(registry.has('tool-a')).toBe(true);
    expect(registry.has('tool-b')).toBe(true);
    expect(registry.getHandler('tool-a')).toBe(handlerA);
    expect(registry.getHandler('tool-b')).toBe(handlerB);
  });

  it('registerPersonaTools should wire persona tools from provider', () => {
    const personaHandler = {} as any;
    const personaToolHandler = jest.fn<() => Promise<any>>();
    personaToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'import_persona',
          description: 'Import a persona',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: personaToolHandler,
      },
    ]);

    registry.registerPersonaTools(personaHandler);

    expect(personaToolsFactory).toHaveBeenCalledWith(personaHandler);
    expect(registry.has('import_persona')).toBe(true);
    expect(registry.getHandler('import_persona')).toBe(personaToolHandler);
  });

  it('registerElementTools should wire element tools from provider', () => {
    const elementHandler = {} as any;
    const elementToolHandler = jest.fn<() => Promise<any>>();
    elementToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'create_element',
          description: 'Create element',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: elementToolHandler,
      },
    ]);

    registry.registerElementTools(elementHandler);

    expect(elementToolsFactory).toHaveBeenCalledWith(elementHandler);
    expect(registry.has('create_element')).toBe(true);
    expect(registry.getHandler('create_element')).toBe(elementToolHandler);
  });

  it('registerCollectionTools should wire collection tools from provider', () => {
    const collectionHandler = {} as any;
    const collectionToolHandler = jest.fn<() => Promise<any>>();
    collectionToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'browse_collection',
          description: 'Browse collection',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: collectionToolHandler,
      },
    ]);

    registry.registerCollectionTools(collectionHandler);

    expect(collectionToolsFactory).toHaveBeenCalledWith(collectionHandler);
    expect(registry.has('browse_collection')).toBe(true);
    expect(registry.getHandler('browse_collection')).toBe(collectionToolHandler);
  });

  it('registerPortfolioTools should wire portfolio tools from provider', () => {
    const portfolioHandler = {} as any;
    const portfolioToolHandler = jest.fn<() => Promise<any>>();
    portfolioToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'portfolio_status',
          description: 'Portfolio status',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: portfolioToolHandler,
      },
    ]);

    registry.registerPortfolioTools(portfolioHandler);

    expect(portfolioToolsFactory).toHaveBeenCalledWith(portfolioHandler);
    expect(registry.has('portfolio_status')).toBe(true);
    expect(registry.getHandler('portfolio_status')).toBe(portfolioToolHandler);
  });

  it('registerAuthTools should wire auth tools from provider', () => {
    const authHandler = {} as any;
    const authToolHandler = jest.fn<() => Promise<any>>();
    authToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'github_auth',
          description: 'GitHub auth',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: authToolHandler,
      },
    ]);

    registry.registerAuthTools(authHandler);

    expect(authToolsFactory).toHaveBeenCalledWith(authHandler);
    expect(registry.has('github_auth')).toBe(true);
    expect(registry.getHandler('github_auth')).toBe(authToolHandler);
  });

  it('registerConfigTools should wire config tools from provider', () => {
    const configHandler = {
      handleConfigOperation: jest.fn(),
      handleSyncOperation: jest.fn(),
    } as any;
    const configToolHandler = jest.fn<() => Promise<any>>();
    configToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'config_set',
          description: 'Set config',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: configToolHandler,
      },
    ]);

    registry.registerConfigTools(configHandler);

    expect(configToolsFactory).toHaveBeenCalledWith(configHandler);
    expect(registry.has('config_set')).toBe(true);
    expect(registry.getHandler('config_set')).toBe(configToolHandler);
  });

  it('executes config handler with options only', async () => {
    const configHandler = {
      handleConfigOperation: jest.fn().mockResolvedValue(undefined),
      handleSyncOperation: jest.fn(),
    } as any;

    configToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'config_set',
          description: 'Set config',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: (options: any, ...rest: any[]) =>
          configHandler.handleConfigOperation(options, ...rest),
      },
    ]);

    registry.registerConfigTools(configHandler);

    const handler = registry.getHandler('config_set');
    await handler?.({ setting: 'sync.enabled', value: true });

    expect(configHandler.handleConfigOperation).toHaveBeenCalledTimes(1);
    expect(configHandler.handleConfigOperation).toHaveBeenCalledWith({
      setting: 'sync.enabled',
      value: true,
    });
  });

  it('registerEnhancedIndexTools should wire enhanced index tools from provider', () => {
    const enhancedIndexHandler = {} as any;
    const enhancedToolHandler = jest.fn<() => Promise<any>>();
    enhancedIndexToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'enhanced_index_status',
          description: 'Status',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        handler: enhancedToolHandler,
      },
    ]);

    registry.registerEnhancedIndexTools(enhancedIndexHandler, {} as any);

    expect(enhancedIndexToolsFactory).toHaveBeenCalledWith(enhancedIndexHandler, {} as any);
    expect(registry.has('enhanced_index_status')).toBe(true);
    expect(registry.getHandler('enhanced_index_status')).toBe(enhancedToolHandler);
  });

  it('registerBuildInfoTools should register tools without handlers', () => {
    buildInfoToolsFactory.mockReturnValue([
      {
        tool: {
          name: 'get_build_info',
          description: 'Build info',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      },
    ]);

    registry.registerBuildInfoTools({} as any);

    expect(buildInfoToolsFactory).toHaveBeenCalled();
    expect(registry.has('get_build_info')).toBe(true);
    expect(registry.getHandler('get_build_info')).toBeUndefined();
  });
});
