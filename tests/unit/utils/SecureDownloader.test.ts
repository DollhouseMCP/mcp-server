import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextEncoder } from 'util';
import { SecureDownloader, DownloadError } from '../../../src/utils/SecureDownloader.js';
import { PathValidator } from '../../../src/security/pathValidator.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { ContentValidator as SecurityContentValidator } from '../../../src/security/contentValidator.js';
import { IFileOperationsService } from '../../../src/services/FileOperationsService.js';

const textEncoder = new TextEncoder();

/**
 * Create a mock IFileOperationsService with all required methods
 */
function createMockFileOperationsService(): jest.Mocked<IFileOperationsService> {
  return {
    readFile: jest.fn<IFileOperationsService['readFile']>().mockResolvedValue(''),
    readElementFile: jest.fn<IFileOperationsService['readElementFile']>().mockResolvedValue(''),
    writeFile: jest.fn<IFileOperationsService['writeFile']>().mockResolvedValue(undefined),
    deleteFile: jest.fn<IFileOperationsService['deleteFile']>().mockResolvedValue(undefined),
    createDirectory: jest.fn<IFileOperationsService['createDirectory']>().mockResolvedValue(undefined),
    listDirectory: jest.fn<IFileOperationsService['listDirectory']>().mockResolvedValue([]),
    listDirectoryWithTypes: jest.fn<IFileOperationsService['listDirectoryWithTypes']>().mockResolvedValue([]),
    renameFile: jest.fn<IFileOperationsService['renameFile']>().mockResolvedValue(undefined),
    exists: jest.fn<IFileOperationsService['exists']>().mockResolvedValue(false),
    stat: jest.fn<IFileOperationsService['stat']>().mockResolvedValue({} as any),
    resolvePath: jest.fn<IFileOperationsService['resolvePath']>().mockReturnValue(''),
    validatePath: jest.fn<IFileOperationsService['validatePath']>().mockReturnValue(true),
    createFileExclusive: jest.fn<IFileOperationsService['createFileExclusive']>().mockResolvedValue(true),
    copyFile: jest.fn<IFileOperationsService['copyFile']>().mockResolvedValue(undefined),
    chmod: jest.fn<IFileOperationsService['chmod']>().mockResolvedValue(undefined),
    appendFile: jest.fn<IFileOperationsService['appendFile']>().mockResolvedValue(undefined)
  };
}

describe('SecureDownloader', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as Partial<typeof globalThis>).fetch;
    }
  });

  describe('downloadToFile', () => {
    it('writes validated content atomically and logs success', async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'secure-dl-'));
      const targetPath = path.join(tempDir, 'secure-output.md');

      const mockFileOperations = createMockFileOperationsService();
      mockFileOperations.exists.mockResolvedValue(false);

      const fileLockManager = {
        withLock: jest.fn(async (_resource: string, callback: () => Promise<void>) => {
          await callback();
        }),
        atomicWriteFile: jest.fn().mockResolvedValue(undefined)
      } as unknown as typeof import('../../../src/security/fileLockManager.js').FileLockManager;

      const downloader = new SecureDownloader({
        fileLockManager,
        fileOperations: mockFileOperations
      });

      jest.spyOn(PathValidator, 'validatePersonaPath').mockResolvedValue(targetPath);
      jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
      jest.spyOn<any, any>(downloader as any, 'downloadToMemory').mockResolvedValue('SAFE CONTENT');
      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);

      await downloader.downloadToFile('https://example.com/persona', targetPath);

      // Verify exists was checked
      expect(mockFileOperations.exists).toHaveBeenCalledWith(targetPath);

      // Verify createDirectory was called for the target directory
      expect(mockFileOperations.createDirectory).toHaveBeenCalledWith(path.dirname(targetPath));

      // Verify writeFile was called with correct parameters
      expect(mockFileOperations.writeFile).toHaveBeenCalledTimes(1);
      const writeFileCalls = mockFileOperations.writeFile.mock.calls;
      expect(writeFileCalls.length).toBeGreaterThan(0);

      const [actualPath, actualContent, actualOptions] = writeFileCalls[0];

      // Normalize paths for cross-platform comparison (handles /var -> /private/var on macOS)
      const actualDir = path.dirname(actualPath);
      const expectedDir = path.dirname(targetPath);
      const actualFilename = path.basename(actualPath);
      const expectedFilename = path.basename(targetPath);

      expect(realpathSync(actualDir)).toBe(realpathSync(expectedDir));
      expect(actualFilename).toBe(expectedFilename);
      expect(actualContent).toBe('SAFE CONTENT');
      expect(actualOptions).toEqual(expect.objectContaining({
        source: 'SecureDownloader.atomicWriteFile',
        atomic: true
      }));

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'FILE_COPIED',
          metadata: expect.objectContaining({ destinationPath: targetPath })
        })
      );
    });

    it('throws filesystem error when destination already exists', async () => {
      const mockFileOperations = createMockFileOperationsService();
      // Mock exists to return true (file already exists)
      mockFileOperations.exists.mockResolvedValue(true);

      const downloader = new SecureDownloader({
        fileOperations: mockFileOperations
      });

      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'secure-dl-'));
      const existingPath = path.join(tempDir, 'existing.md');

      jest.spyOn(PathValidator, 'validatePersonaPath').mockResolvedValue(existingPath);
      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);

      await expect(
        downloader.downloadToFile('https://example.com/exists', existingPath)
      ).rejects.toMatchObject<Partial<DownloadError>>({
        code: 'FILESYSTEM_ERROR'
      });

      // Verify exists was called
      expect(mockFileOperations.exists).toHaveBeenCalledWith(existingPath);
    });

    it('rejects invalid destination paths before downloading', async () => {
      const mockFileOperations = createMockFileOperationsService();

      const downloader = new SecureDownloader({
        fileOperations: mockFileOperations
      });

      jest.spyOn(PathValidator, 'validatePersonaPath').mockRejectedValue(new Error('outside allowed directory'));
      jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);
      const fetchSpy = jest.fn();
      globalThis.fetch = fetchSpy;

      await expect(
        downloader.downloadToFile('https://example.com/persona', '../unauthorized.md')
      ).rejects.toMatchObject<Partial<DownloadError>>({
        code: 'SECURITY_ERROR'
      });

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('downloadToMemory', () => {
    it('rejects when custom validator fails', async () => {
      const downloader = new SecureDownloader();

      jest.spyOn<any, any>(downloader as any, 'fetchWithLimits').mockResolvedValue('payload');
      jest.spyOn(SecurityContentValidator, 'validateAndSanitize').mockReturnValue({
        isValid: true,
        sanitizedContent: 'payload'
      } as any);
      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);

      await expect(
        downloader.downloadToMemory('https://example.com/file', {
          validator: async () => ({ isValid: false, errorMessage: 'Rejected' })
        })
      ).rejects.toMatchObject<Partial<DownloadError>>({
        code: 'VALIDATION_ERROR',
        message: 'Rejected'
      });
    });

    it('returns sanitized content from security validator', async () => {
      const downloader = new SecureDownloader();

      jest.spyOn<any, any>(downloader as any, 'fetchWithLimits').mockResolvedValue('unsafe');
      jest.spyOn(SecurityContentValidator, 'validateAndSanitize').mockReturnValue({
        isValid: true,
        sanitizedContent: 'clean'
      } as any);
      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);

      const result = await downloader.downloadToMemory('https://example.com/file');
      expect(result).toBe('clean');
    });

    it('enforces maxSize limits during download', async () => {
      const downloader = new SecureDownloader();
      const chunk = textEncoder.encode('0123456789');
      const reader = {
        sent: false,
        async read() {
          if (!this.sent) {
            this.sent = true;
            return { done: false, value: chunk };
          }
          return { done: true, value: undefined };
        },
        releaseLock() { /* noop */ }
      };

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name === 'content-length' ? String(chunk.length) : null) },
        body: { getReader: () => reader }
      });

      jest.spyOn(SecurityContentValidator, 'validateAndSanitize').mockReturnValue({
        isValid: true,
        sanitizedContent: 'SAFE'
      } as any);
      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);

      await expect(
        downloader.downloadToMemory('https://example.com/too-large', { maxSize: 5 })
      ).rejects.toMatchObject<Partial<DownloadError>>({
        code: 'SECURITY_ERROR'
      });

      expect(SecurityContentValidator.validateAndSanitize).not.toHaveBeenCalled();
    });
  });

  describe('downloadStream', () => {
    it('cleans up temporary files when stream validator fails', async () => {
      const mockFileOperations = createMockFileOperationsService();
      mockFileOperations.exists.mockResolvedValue(false);

      const downloader = new SecureDownloader({
        tempDir: '.tmp-test',
        fileOperations: mockFileOperations
      });

      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);
      jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});

      const chunks = [textEncoder.encode('chunk-one')];
      const reader = {
        index: 0,
        async read() {
          if (this.index < chunks.length) {
            return { done: false, value: chunks[this.index++] };
          }
          return { done: true, value: undefined };
        },
        releaseLock() { /* noop */ }
      };
      const mockBody = {
        getReader: () => reader
      };
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body: mockBody
      });

      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'secure-dl-'));
      const destinationPath = path.join(tempDir, 'stream.bin');
      jest.spyOn(PathValidator, 'validatePersonaPath').mockResolvedValue(destinationPath);

      await expect(
        downloader.downloadStream('https://example.com/stream', destinationPath, {
          streamValidator: () => false
        })
      ).rejects.toMatchObject<Partial<DownloadError>>({
        code: 'VALIDATION_ERROR'
      });

      // Verify createDirectory was called for temp directory
      expect(mockFileOperations.createDirectory).toHaveBeenCalled();

      // Verify deleteFile was called for cleanup
      expect(mockFileOperations.deleteFile).toHaveBeenCalled();
    });

    it('enforces maxSize limits during streaming download', async () => {
      const mockFileOperations = createMockFileOperationsService();
      mockFileOperations.exists.mockResolvedValue(false);

      const downloader = new SecureDownloader({
        tempDir: '.tmp-test',
        fileOperations: mockFileOperations
      });

      jest.spyOn<any, any>(downloader as any, 'checkRateLimit').mockResolvedValue(undefined);
      jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});

      const chunks = [textEncoder.encode('chunk-one'), textEncoder.encode('chunk-two')];
      const reader = {
        index: 0,
        async read() {
          if (this.index < chunks.length) {
            return { done: false, value: chunks[this.index++] };
          }
          return { done: true, value: undefined };
        },
        releaseLock() { /* noop */ }
      };
      const mockBody = {
        getReader: () => reader
      };
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body: mockBody
      });

      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'secure-dl-'));
      const destinationPath = path.join(tempDir, 'stream.bin');
      jest.spyOn(PathValidator, 'validatePersonaPath').mockResolvedValue(destinationPath);

      await expect(
        downloader.downloadStream('https://example.com/stream', destinationPath, {
          maxSize: chunks[0].length + 2 // smaller than total size
        })
      ).rejects.toMatchObject<Partial<DownloadError>>({
        code: 'SECURITY_ERROR'
      });

      // Verify createDirectory was called for temp directory
      expect(mockFileOperations.createDirectory).toHaveBeenCalled();

      // Verify deleteFile was called for cleanup
      expect(mockFileOperations.deleteFile).toHaveBeenCalled();
    });
  });

  describe('combineValidators', () => {
    it('bubbles the first failing validator', async () => {
      const validator = SecureDownloader.combineValidators(
        async () => ({ isValid: true }),
        async () => ({ isValid: false, errorMessage: 'bad' }),
        async () => ({ isValid: true })
      );

      const result = await validator('content');
      expect(result).toEqual({ isValid: false, errorMessage: 'bad' });
    });
  });
});
