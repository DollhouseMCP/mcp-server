import { SyncHandler, SyncOperationOptions } from '../../../src/handlers/SyncHandlerV2.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import type { SyncResult } from '../../../src/portfolio/PortfolioSyncManager.js';

describe('SyncHandler', () => {
  let handler: InstanceType<typeof SyncHandler>;
  let mockServices: any;
  let container: InstanceType<typeof DollhouseContainer>;

  beforeEach(() => {
    // Mock services for DI
    mockServices = {
      syncManager: {
        handleSyncOperation: jest.fn<() => Promise<SyncResult>>(),
      },
      configManager: {
        initialize: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getSetting: jest.fn(),
      },
      indicatorService: {
        getPersonaIndicator: jest.fn<() => string>().mockReturnValue('>>'),
      },
    };

    container = new DollhouseContainer();

    // Create handler with mocked services
    handler = new SyncHandler(
      mockServices.syncManager,
      mockServices.configManager,
      mockServices.indicatorService
    );
  });

  afterEach(async () => {
    await container.dispose();
    jest.clearAllMocks();
  });

  describe('handleSyncOperation', () => {
    describe('sync enabled/disabled checks', () => {
      it('should block non-read-only operations when sync is disabled', async () => {
        mockServices.configManager.getSetting.mockReturnValue(false);

        const options: SyncOperationOptions = {
          operation: 'download',
          element_name: 'test-element',
          element_type: ElementType.PERSONA,
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toContain('Sync is Disabled');
        expect(result.content[0].text).toContain('sync.enabled');
        expect(mockServices.syncManager.handleSyncOperation).not.toHaveBeenCalled();
      });

      it('should allow list-remote when sync is disabled', async () => {
        mockServices.configManager.getSetting.mockReturnValue(false);
        mockServices.syncManager.handleSyncOperation.mockResolvedValue({
          success: true,
          message: 'Listed remote elements',
          elements: [],
        });

        const options: SyncOperationOptions = {
          operation: 'list-remote',
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toContain('GitHub Portfolio is Empty');
        expect(mockServices.syncManager.handleSyncOperation).toHaveBeenCalled();
      });

      it('should allow compare when sync is disabled', async () => {
        mockServices.configManager.getSetting.mockReturnValue(false);
        mockServices.syncManager.handleSyncOperation.mockResolvedValue({
          success: true,
          message: 'Comparison complete',
          data: {
            local: { version: '1.0.0', timestamp: Date.now() },
            remote: { version: '1.0.1', timestamp: Date.now() },
          },
        });

        const options: SyncOperationOptions = {
          operation: 'compare',
          element_name: 'test-element',
          element_type: ElementType.SKILL,
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toContain('Version Comparison');
        expect(mockServices.syncManager.handleSyncOperation).toHaveBeenCalled();
      });

      it('should allow operations when sync is enabled', async () => {
        mockServices.configManager.getSetting.mockReturnValue(true);
        mockServices.syncManager.handleSyncOperation.mockResolvedValue({
          success: true,
          message: 'Download complete',
        });

        const options: SyncOperationOptions = {
          operation: 'download',
          element_name: 'test-element',
          element_type: ElementType.TEMPLATE,
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toContain('Element Downloaded');
        expect(mockServices.syncManager.handleSyncOperation).toHaveBeenCalled();
      });
    });

    describe('operation mapping', () => {
      beforeEach(() => {
        mockServices.configManager.getSetting.mockReturnValue(true);
        mockServices.syncManager.handleSyncOperation.mockResolvedValue({
          success: true,
          message: 'Success',
        });
      });

      it('should map bulk-download to download operation', async () => {
        const options: SyncOperationOptions = {
          operation: 'bulk-download',
        };

        await handler.handleSyncOperation(options);

        const callArgs = mockServices.syncManager.handleSyncOperation.mock.calls[0][0];
        expect(callArgs.operation).toBe('download');
        expect(callArgs.bulk).toBe(true);
      });

      it('should map bulk-upload to upload operation', async () => {
        const options: SyncOperationOptions = {
          operation: 'bulk-upload',
        };

        await handler.handleSyncOperation(options);

        const callArgs = mockServices.syncManager.handleSyncOperation.mock.calls[0][0];
        expect(callArgs.operation).toBe('upload');
        expect(callArgs.bulk).toBe(true);
      });

      it('should set show_diff for compare operations', async () => {
        const options: SyncOperationOptions = {
          operation: 'compare',
          element_name: 'test',
          element_type: ElementType.AGENT,
        };

        await handler.handleSyncOperation(options);

        const callArgs = mockServices.syncManager.handleSyncOperation.mock.calls[0][0];
        expect(callArgs.show_diff).toBe(true);
      });

      it('should pass force option correctly', async () => {
        const options: SyncOperationOptions = {
          operation: 'download',
          element_name: 'test',
          element_type: ElementType.SKILL,
          options: {
            force: true,
          },
        };

        await handler.handleSyncOperation(options);

        const callArgs = mockServices.syncManager.handleSyncOperation.mock.calls[0][0];
        expect(callArgs.force).toBe(true);
        expect(callArgs.confirm).toBe(true); // force implies confirm
      });

      it('should use filter.type when element_type not provided', async () => {
        const options: SyncOperationOptions = {
          operation: 'list-remote',
          filter: {
            type: ElementType.MEMORY,
          },
        };

        await handler.handleSyncOperation(options);

        const callArgs = mockServices.syncManager.handleSyncOperation.mock.calls[0][0];
        expect(callArgs.element_type).toBe(ElementType.MEMORY);
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        mockServices.configManager.getSetting.mockReturnValue(true);
      });

      it('should handle sync manager errors', async () => {
        mockServices.syncManager.handleSyncOperation.mockRejectedValue(
          new Error('Sync failed')
        );

        const options: SyncOperationOptions = {
          operation: 'download',
          element_name: 'test',
          element_type: ElementType.PERSONA,
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toContain('❌ Sync operation failed');
        expect(result.content[0].text).toContain('Sync failed');
      });

      it('should sanitize error messages', async () => {
        const errorWithSensitiveData = new Error('API key abc123 failed');
        mockServices.syncManager.handleSyncOperation.mockRejectedValue(errorWithSensitiveData);

        const options: SyncOperationOptions = {
          operation: 'upload',
          element_name: 'test',
          element_type: ElementType.SKILL,
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toContain('❌ Sync operation failed');
      });

      it('should handle failed sync results', async () => {
        mockServices.syncManager.handleSyncOperation.mockResolvedValue({
          success: false,
          message: 'Element not found',
        });

        const options: SyncOperationOptions = {
          operation: 'download',
          element_name: 'missing',
          element_type: ElementType.TEMPLATE,
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toContain('❌ Element not found');
      });
    });

    describe('result formatting', () => {
      beforeEach(() => {
        mockServices.configManager.getSetting.mockReturnValue(true);
      });

      describe('list-remote formatting', () => {
        it('should format empty portfolio message', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Listed',
            elements: [],
          });

          const options: SyncOperationOptions = {
            operation: 'list-remote',
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('GitHub Portfolio is Empty');
          expect(result.content[0].text).toContain('Upload elements using');
        });

        it('should format list with elements grouped by type', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Listed',
            elements: [
              { name: 'persona1', type: 'personas', remoteVersion: '1.0.0', status: 'synced' },
              { name: 'persona2', type: 'personas', remoteVersion: '1.1.0' },
              { name: 'skill1', type: 'skills', remoteVersion: '2.0.0' },
            ],
          });

          const options: SyncOperationOptions = {
            operation: 'list-remote',
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('GitHub Portfolio Contents');
          expect(result.content[0].text).toContain('Found 3 elements');
          expect(result.content[0].text).toContain('**personas** (2)');
          expect(result.content[0].text).toContain('persona1 v1.0.0 (synced)');
          expect(result.content[0].text).toContain('persona2 v1.1.0');
          expect(result.content[0].text).toContain('**skills** (1)');
          expect(result.content[0].text).toContain('skill1 v2.0.0');
        });
      });

      describe('download formatting', () => {
        it('should format single download result', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Element downloaded successfully',
          });

          const options: SyncOperationOptions = {
            operation: 'download',
            element_name: 'my-persona',
            element_type: ElementType.PERSONA,
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('Element Downloaded');
          expect(result.content[0].text).toContain('my-persona (personas)');
          expect(result.content[0].text).toContain('Element downloaded successfully');
        });

        it('should format bulk download result', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Bulk download complete',
            elements: [
              { name: 'elem1', action: 'download' },
              { name: 'elem2', action: 'download' },
              { name: 'elem3', action: 'skip' },
            ],
          });

          const options: SyncOperationOptions = {
            operation: 'bulk-download',
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('Bulk Download Complete');
          expect(result.content[0].text).toContain('Downloaded: 2 elements');
          expect(result.content[0].text).toContain('Skipped: 1 elements');
        });
      });

      describe('upload formatting', () => {
        it('should format single upload result', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Element uploaded successfully',
          });

          const options: SyncOperationOptions = {
            operation: 'upload',
            element_name: 'my-skill',
            element_type: ElementType.SKILL,
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('Element Uploaded');
          expect(result.content[0].text).toContain('my-skill (skills)');
          expect(result.content[0].text).toContain('Element uploaded successfully');
        });

        it('should format bulk upload result', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Bulk upload complete',
            elements: [
              { name: 'elem1', action: 'upload' },
              { name: 'elem2', action: 'upload' },
              { name: 'elem3', action: 'upload' },
              { name: 'elem4', action: 'skip' },
            ],
          });

          const options: SyncOperationOptions = {
            operation: 'bulk-upload',
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('Bulk Upload Complete');
          expect(result.content[0].text).toContain('Uploaded: 3 elements');
          expect(result.content[0].text).toContain('Skipped: 1 elements');
        });
      });

      describe('compare formatting', () => {
        it('should format comparison with both versions present', async () => {
          const now = Date.now();
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Versions differ',
            data: {
              local: { version: '1.0.0', timestamp: now },
              remote: { version: '1.1.0', timestamp: now + 1000 },
              diff: '- old line\n+ new line',
            },
          });

          const options: SyncOperationOptions = {
            operation: 'compare',
            element_name: 'test-template',
            element_type: ElementType.TEMPLATE,
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('Version Comparison');
          expect(result.content[0].text).toContain('test-template (templates)');
          expect(result.content[0].text).toContain('**Local Version**: 1.0.0');
          expect(result.content[0].text).toContain('**Remote Version**: 1.1.0');
          expect(result.content[0].text).toContain('**Differences**');
          expect(result.content[0].text).toContain('- old line');
          expect(result.content[0].text).toContain('+ new line');
        });

        it('should format comparison when local is missing', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Local not found',
            data: {
              local: null,
              remote: { version: '1.0.0', timestamp: Date.now() },
            },
          });

          const options: SyncOperationOptions = {
            operation: 'compare',
            element_name: 'remote-only',
            element_type: ElementType.AGENT,
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('**Local Version**: Not found');
          expect(result.content[0].text).toContain('**Remote Version**: 1.0.0');
        });

        it('should format comparison when remote is missing', async () => {
          mockServices.syncManager.handleSyncOperation.mockResolvedValue({
            success: true,
            message: 'Remote not found',
            data: {
              local: { version: '1.0.0', timestamp: Date.now() },
              remote: null,
            },
          });

          const options: SyncOperationOptions = {
            operation: 'compare',
            element_name: 'local-only',
            element_type: ElementType.MEMORY,
          };

          const result = await handler.handleSyncOperation(options);

          expect(result.content[0].text).toContain('**Local Version**: 1.0.0');
          expect(result.content[0].text).toContain('**Remote Version**: Not found');
        });
      });
    });

    describe('indicator integration', () => {
      beforeEach(() => {
        mockServices.configManager.getSetting.mockReturnValue(true);
      });

      it('should include persona indicator in all responses', async () => {
        mockServices.indicatorService.getPersonaIndicator.mockReturnValue('[TEST] ');
        mockServices.syncManager.handleSyncOperation.mockResolvedValue({
          success: true,
          message: 'Success',
          elements: [],
        });

        const options: SyncOperationOptions = {
          operation: 'list-remote',
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toMatch(/^\[TEST\]/);
      });

      it('should include indicator in error messages', async () => {
        mockServices.indicatorService.getPersonaIndicator.mockReturnValue('[ERROR] ');
        mockServices.syncManager.handleSyncOperation.mockRejectedValue(new Error('Test error'));

        const options: SyncOperationOptions = {
          operation: 'download',
          element_name: 'test',
          element_type: ElementType.SKILL,
        };

        const result = await handler.handleSyncOperation(options);

        expect(result.content[0].text).toMatch(/^\[ERROR\]/);
      });
    });

    describe('initialization', () => {
      it('should initialize config manager before operations', async () => {
        mockServices.configManager.getSetting.mockReturnValue(true);
        mockServices.syncManager.handleSyncOperation.mockResolvedValue({
          success: true,
          message: 'Success',
        });

        const options: SyncOperationOptions = {
          operation: 'download',
          element_name: 'test',
          element_type: ElementType.PERSONA,
        };

        await handler.handleSyncOperation(options);

        expect(mockServices.configManager.initialize).toHaveBeenCalled();
        // Verify it was called before checking settings
        const initCall = mockServices.configManager.initialize.mock.invocationCallOrder[0];
        const getSettingCall = mockServices.configManager.getSetting.mock.invocationCallOrder[0];
        expect(initCall).toBeLessThan(getSettingCall);
      });
    });
  });
});
