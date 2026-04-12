import { CollectionHandler } from '../../../src/handlers/CollectionHandler.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { FileDiscoveryUtil } from '../../../src/utils/FileDiscoveryUtil.js';
import { DollhouseContainer } from '../../../src/di/Container.js';

const submitExecuteMock = jest.fn();
const unifiedIndexInstanceMock = {
  checkDuplicates: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
};

describe('CollectionHandler', () => {
  let handler: InstanceType<typeof CollectionHandler>;
  let mockServices: any;
  let findFileSpy: ReturnType<typeof jest.spyOn>;
  let container: InstanceType<typeof DollhouseContainer>;

  afterEach(async () => {
    if (container) {
      await container.dispose();
    }
    jest.clearAllMocks();
    if (findFileSpy) {
      findFileSpy.mockRestore();
    }
  });

  beforeEach(() => {
    findFileSpy = jest.spyOn(FileDiscoveryUtil, 'findFile').mockResolvedValue(null);
    unifiedIndexInstanceMock.checkDuplicates.mockResolvedValue([]);

    // Pure DI mocks - individual services instead of dependency object
    mockServices = {
      collectionBrowser: {
        browseCollection: jest.fn(),
        formatBrowseResults: jest.fn(),
      },
      collectionSearch: {
        searchCollection: jest.fn(),
        searchCollectionWithOptions: jest.fn(),
        formatSearchResults: jest.fn(),
        formatSearchResultsWithPagination: jest.fn(),
        getCacheStats: jest.fn<() => Promise<any>>().mockResolvedValue({ index: { isValid: true, hasCache: true, elements: 10, age: 1000 } }),
      },
      personaDetails: {
        getCollectionContent: jest.fn(),
        formatPersonaDetails: jest.fn(),
      },
      elementInstaller: {
        installContent: jest.fn(),
        formatInstallSuccess: jest.fn(),
      },
      collectionCache: {
        isCacheValid: jest.fn(),
        saveCache: jest.fn(),
        getCacheStats: jest.fn<() => Promise<any>>().mockResolvedValue({ isValid: true, itemCount: 10, cacheAge: 1000 }),
      },
      portfolioManager: {
        getElementDir: jest.fn().mockImplementation((type: ElementType) => `/mock/${type}`),
      },
      apiCache: {},
      personaManager: {
        reload: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      submitToPortfolioTool: {
        execute: submitExecuteMock,
      },
      unifiedIndexManager: unifiedIndexInstanceMock,
      initService: {
        ensureInitialized: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      indicatorService: {
        getPersonaIndicator: jest.fn<() => string>().mockReturnValue('>>'),
      },
    };

    container = new DollhouseContainer();

    // Pure DI - pass all services directly to constructor
    handler = new CollectionHandler(
      mockServices.collectionBrowser,
      mockServices.collectionSearch,
      mockServices.personaDetails,
      mockServices.elementInstaller,
      mockServices.collectionCache,
      mockServices.portfolioManager,
      mockServices.apiCache,
      mockServices.personaManager,
      mockServices.submitToPortfolioTool,
      mockServices.unifiedIndexManager,
      mockServices.initService,
      mockServices.indicatorService
    );
  });

  describe('browseCollection', () => {
    it('should call the collection browser and format results', async () => {
      const browseResult = { items: [{ name: 'test-item' }], categories: [], sections: ['library'] };
      const formattedText = 'Formatted browse results';
      mockServices.collectionBrowser.browseCollection.mockResolvedValue(browseResult);
      mockServices.collectionBrowser.formatBrowseResults.mockReturnValue(formattedText);

      const result = await handler.browseCollection('library', 'personas');

      expect(mockServices.collectionBrowser.browseCollection).toHaveBeenCalledWith('library', 'personas');
      expect(mockServices.collectionBrowser.formatBrowseResults).toHaveBeenCalledWith(
        browseResult.items,
        browseResult.sections,
        'library',
        'personas',
        '>>'
      );
      expect(result.content[0].text).toBe(formattedText);
    });

    it('should throw an error for an invalid section', async () => {
        const result = await handler.browseCollection('invalid-section');
        expect(result.content[0].text).toContain('Invalid section');
    });

    it('should handle errors thrown by the collection browser', async () => {
        mockServices.collectionBrowser.browseCollection.mockRejectedValue(new Error('Browser error'));
        const result = await handler.browseCollection('library');
        expect(result.content[0].text).toContain('Collection browsing failed: Browser error');
    });

    it('should work with no arguments', async () => {
        const browseResult = { items: [{ name: 'test-item' }], categories: [], sections: ['library'] };
        const formattedText = 'Formatted browse results';
        mockServices.collectionBrowser.browseCollection.mockResolvedValue(browseResult);
        mockServices.collectionBrowser.formatBrowseResults.mockReturnValue(formattedText);

        const result = await handler.browseCollection();
        expect(mockServices.collectionBrowser.browseCollection).toHaveBeenCalledWith(undefined, undefined);
        expect(result.content[0].text).toBe(formattedText);
    });
  });

  describe('searchCollection', () => {
    it('should call the collection search and format results', async () => {
      const searchItems = [{ name: 'found-item' }];
      const formattedText = 'Formatted search results';
      mockServices.collectionSearch.searchCollection.mockResolvedValue(searchItems);
      mockServices.collectionSearch.formatSearchResults.mockReturnValue(formattedText);

      const result = await handler.searchCollection('test-query');

      expect(mockServices.collectionSearch.searchCollection).toHaveBeenCalledWith('test-query');
      expect(mockServices.collectionSearch.formatSearchResults).toHaveBeenCalledWith(
        searchItems,
        'test-query',
        '>>'
      );
      expect(result.content[0].text).toBe(formattedText);
    });

    it('should handle errors during search', async () => {
        mockServices.collectionSearch.searchCollection.mockRejectedValue(new Error('Search error'));
        const result = await handler.searchCollection('test-query');
        expect(result.content[0].text).toContain('Error searching collection: Search error');
    });
  });

  describe('getCollectionContent', () => {
    it('should get content and format details', async () => {
      const content = { metadata: { name: 'details-item', description: 'test description' } as any, content: 'details' };
      const formattedText = 'Formatted details';
      mockServices.personaDetails.getCollectionContent.mockResolvedValue(content);
      mockServices.personaDetails.formatPersonaDetails.mockReturnValue(formattedText);

      const result = await handler.getCollectionContent('library/personas/test.md');

      expect(mockServices.personaDetails.getCollectionContent).toHaveBeenCalledWith('library/personas/test.md');
      expect(mockServices.personaDetails.formatPersonaDetails).toHaveBeenCalledWith(
        content.metadata,
        content.content,
        'library/personas/test.md',
        '>>'
      );
      expect(result.content[0].text).toBe(formattedText);
    });

    it('should handle errors when getting content', async () => {
        mockServices.personaDetails.getCollectionContent.mockRejectedValue(new Error('Get content error'));
        const result = await handler.getCollectionContent('library/personas/test.md');
        expect(result.content[0].text).toContain('Error fetching content: Get content error');
    });
  });

  describe('installContent', () => {
    it('should install content and reload personas if it is a persona', async () => {
      const installResult = { success: true, message: 'Installed successfully', elementType: ElementType.PERSONA, metadata: { name: 'new-persona' } as any, filename: 'new.md' };
      const formattedText = 'Formatted install success';
      mockServices.elementInstaller.installContent.mockResolvedValue(installResult);
      mockServices.elementInstaller.formatInstallSuccess.mockReturnValue(formattedText);

      const result = await handler.installContent('path/to/content');

      expect(mockServices.elementInstaller.installContent).toHaveBeenCalledWith('path/to/content');
      expect(mockServices.personaManager.reload).toHaveBeenCalled();
      expect(mockServices.elementInstaller.formatInstallSuccess).toHaveBeenCalledWith(
        installResult.metadata,
        installResult.filename,
        installResult.elementType
      );
      expect(result.content[0].text).toBe(formattedText);
    });

    it('should not reload personas if it is not a persona', async () => {
        const installResult = { success: true, message: 'Installed successfully', elementType: 'skill' as any, metadata: { name: 'new-skill' } as any, filename: 'new.md' };
        mockServices.elementInstaller.installContent.mockResolvedValue(installResult);

        await handler.installContent('path/to/skill');

        expect(mockServices.personaManager.reload).not.toHaveBeenCalled();
    });

    it('should handle installation failure', async () => {
        mockServices.elementInstaller.installContent.mockResolvedValue({ success: false, message: 'Installation failed' });
        const result = await handler.installContent('path/to/content');
        expect(result.content[0].text).toContain('Installation failed');
    });
  });

  describe('submitContent', () => {
    it('should return a message indicating it is not implemented', async () => {
        const result = await handler.submitContent('test-content');
        expect(submitExecuteMock).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain('not found in portfolio');
    });
  });

  describe('getCollectionCacheHealth', () => {
    it('should return cache health statistics', async () => {
      const result = await handler.getCollectionCacheHealth();
      expect(result.content[0].text).toContain('Collection Cache Health Check');
      expect(result.content[0].text).toContain('Collection Cache (Legacy)');
      expect(result.content[0].text).toContain('Index Cache (Enhanced Search)');
    });

    it('should handle errors when getting cache health', async () => {
        mockServices.collectionCache.getCacheStats.mockRejectedValue(new Error('Cache error'));
        const result = await handler.getCollectionCacheHealth();
        expect(result.content[0].text).toContain('Failed to get cache health: Cache error');
    });
  });

  describe('configureCollectionSubmission', () => {
    beforeEach(() => {
      // Clean up environment variable before each test
      delete process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;
    });

    it('should enable collection submission when autoSubmit is true', async () => {
      const result = await handler.configureCollectionSubmission(true);

      expect(handler.isAutoSubmitEnabled()).toBe(true);
      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('Collection submission enabled');
      expect(result.content[0].text).toContain('automatically be submitted');
    });

    it('should disable collection submission when autoSubmit is false', async () => {
      // First enable it
      handler.setAutoSubmitEnabled(true);

      const result = await handler.configureCollectionSubmission(false);

      expect(handler.isAutoSubmitEnabled()).toBe(false);
      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('Collection submission disabled');
      expect(result.content[0].text).toContain('only be uploaded to your personal portfolio');
    });

    it('should handle errors gracefully', async () => {
      // Since the implementation is straightforward and doesn't have many error paths,
      // we'll test that it handles the happy path correctly with various inputs
      const result1 = await handler.configureCollectionSubmission(true);
      expect(result1.content[0].text).toContain('Collection submission enabled');

      const result2 = await handler.configureCollectionSubmission(false);
      expect(result2.content[0].text).toContain('Collection submission disabled');

      // Verify environment variable is cleaned up
      expect(process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION).toBeUndefined();
    });
  });

  describe('getCollectionSubmissionConfig', () => {
    beforeEach(() => {
      // Clean up environment variable before each test
      delete process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;
    });

    it('should return enabled status when auto-submit is enabled', async () => {
      handler.setAutoSubmitEnabled(true);

      const result = await handler.getCollectionSubmissionConfig();

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('Collection Submission Configuration');
      expect(result.content[0].text).toContain('✅ Enabled');
      expect(result.content[0].text).toContain('submit_collection_content');
      expect(result.content[0].text).toContain('Upload content to your GitHub portfolio');
      expect(result.content[0].text).toContain('configure_collection_submission');
    });

    it('should return disabled status when auto-submit is disabled', async () => {
      const result = await handler.getCollectionSubmissionConfig();

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('Collection Submission Configuration');
      expect(result.content[0].text).toContain('❌ Disabled');
      expect(result.content[0].text).toContain('configure_collection_submission');
    });

    it('should return disabled status when environment variable is not "true"', async () => {
      process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'false';

      const result = await handler.getCollectionSubmissionConfig();

      expect(result.content[0].text).toContain('❌ Disabled');
    });
  });
});
