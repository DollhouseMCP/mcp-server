import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as path from 'path';

// Create mock functions first
const mockUnlink = jest.fn<() => Promise<void>>();
const mockMkdir = jest.fn<() => Promise<void>>();
const mockAccess = jest.fn<() => Promise<void>>();
const mockReaddir = jest.fn<() => Promise<string[]>>();
const mockRename = jest.fn<() => Promise<void>>();
const mockStat = jest.fn<() => Promise<any>>();
const mockOpen = jest.fn<() => Promise<any>>();

// Mock fs module BEFORE importing the service
jest.unstable_mockModule('fs', () => ({
  promises: {
    unlink: mockUnlink,
    mkdir: mockMkdir,
    access: mockAccess,
    readdir: mockReaddir,
    rename: mockRename,
    stat: mockStat,
    open: mockOpen
  },
  constants: {
    O_CREAT: 64,
    O_EXCL: 128,
    O_WRONLY: 1
  }
}));

// Mock FileLockManager
const mockAtomicReadFile = jest.fn<() => Promise<string>>();
const mockAtomicWriteFile = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../../src/security/fileLockManager.js', () => ({
  FileLockManager: jest.fn().mockImplementation(() => ({
    atomicReadFile: mockAtomicReadFile,
    atomicWriteFile: mockAtomicWriteFile
  }))
}));

// Mock SecurityMonitor
const mockLogSecurityEvent = jest.fn();
jest.unstable_mockModule('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: mockLogSecurityEvent
  }
}));

// Mock logger
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Now import the service after mocks are set up
const { FileOperationsService } = await import('../../../src/services/FileOperationsService.js');
const { FileLockManager } = await import('../../../src/security/fileLockManager.js');
const { ElementType } = await import('../../../src/portfolio/types.js');

describe('FileOperationsService', () => {
  let service: InstanceType<typeof FileOperationsService>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Create a new service instance with a new FileLockManager mock
    service = new FileOperationsService(new FileLockManager() as any);
  });

  describe('readFile', () => {
    it('should read file using atomic lock manager', async () => {
      const filePath = '/test/file.txt';
      const content = 'test content';
      mockAtomicReadFile.mockResolvedValue(content);

      const result = await service.readFile(filePath);

      expect(mockAtomicReadFile).toHaveBeenCalledWith(filePath, { encoding: 'utf-8' });
      expect(result).toBe(content);
    });

    it('should pass encoding options', async () => {
      const filePath = '/test/file.txt';
      mockAtomicReadFile.mockResolvedValue('');

      await service.readFile(filePath, { encoding: 'base64' });

      expect(mockAtomicReadFile).toHaveBeenCalledWith(filePath, { encoding: 'base64' });
    });

    it('should throw error if file exceeds max size', async () => {
      const filePath = '/test/large_file.txt';
      const largeContent = 'a'.repeat(10 * 1024 * 1024 + 1); // 10MB + 1 byte
      mockAtomicReadFile.mockResolvedValue(largeContent);

      await expect(service.readFile(filePath)).rejects.toThrow('File exceeds maximum size');
    });
  });

  describe('readElementFile', () => {
    it('should delegate to readFile', async () => {
      const filePath = '/test/element.md';
      const content = 'element content';
      mockAtomicReadFile.mockResolvedValue(content);

      const result = await service.readElementFile(filePath, ElementType.PERSONA);

      expect(mockAtomicReadFile).toHaveBeenCalledWith(filePath, { encoding: 'utf-8' });
      expect(result).toBe(content);
    });
  });

  describe('writeFile', () => {
    it('should write file using atomic lock manager', async () => {
      const filePath = '/test/file.txt';
      const content = 'new content';
      mockAtomicWriteFile.mockResolvedValue(undefined);

      await service.writeFile(filePath, content);

      expect(mockAtomicWriteFile).toHaveBeenCalledWith(filePath, content, { encoding: 'utf-8' });
    });

    it('should throw error if content exceeds max size', async () => {
      const filePath = '/test/large_file.txt';
      const largeContent = 'a'.repeat(10 * 1024 * 1024 + 1);

      await expect(service.writeFile(filePath, largeContent)).rejects.toThrow('Content exceeds maximum size');
      expect(mockAtomicWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('deleteFile', () => {
    it('should delete file using fs.unlink', async () => {
      const filePath = '/test/file.txt';
      mockUnlink.mockResolvedValue(undefined);

      await service.deleteFile(filePath);

      expect(mockUnlink).toHaveBeenCalledWith(filePath);
    });

    it('should log security event when elementType is provided', async () => {
      const filePath = '/test/element.md';
      mockUnlink.mockResolvedValue(undefined);

      await service.deleteFile(filePath, ElementType.PERSONA);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'FILE_DELETED',
          severity: 'MEDIUM',
          details: expect.stringContaining('Deleted')
        })
      );
    });

    it('should ignore ENOENT errors', async () => {
      const filePath = '/test/missing.txt';
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      mockUnlink.mockRejectedValue(error);

      await expect(service.deleteFile(filePath)).resolves.not.toThrow();
    });

    it('should throw other errors', async () => {
      const filePath = '/test/locked.txt';
      const error: any = new Error('Permission denied');
      error.code = 'EACCES';
      mockUnlink.mockRejectedValue(error);

      await expect(service.deleteFile(filePath)).rejects.toThrow('Permission denied');
    });
  });

  describe('createDirectory', () => {
    it('should create directory recursively', async () => {
      const dirPath = '/test/dir';
      mockMkdir.mockResolvedValue(undefined);

      await service.createDirectory(dirPath);

      expect(mockMkdir).toHaveBeenCalledWith(dirPath, { recursive: true });
    });
  });

  describe('resolvePath', () => {
    it('should resolve valid paths', () => {
      const base = '/base';
      const relative = 'file.txt';

      const result = service.resolvePath(relative, base);
      expect(result).toBe(path.resolve(base, relative));
    });

    it('should throw on traversal attempts', () => {
      const base = '/base';
      const relative = '../outside.txt';

      expect(() => service.resolvePath(relative, base)).toThrow();
    });
  });

  describe('validatePath', () => {
    it('should return true for valid paths', () => {
      expect(service.validatePath('file.txt', '/base')).toBe(true);
    });

    it('should return false for invalid paths', () => {
      expect(service.validatePath('../outside.txt', '/base')).toBe(false);
    });
  });

  describe('exists', () => {
    it('should return true if file exists', async () => {
      mockAccess.mockResolvedValue(undefined);
      const result = await service.exists('/test/file.txt');
      expect(result).toBe(true);
      expect(mockAccess).toHaveBeenCalledWith('/test/file.txt');
    });

    it('should return false if file does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const result = await service.exists('/test/file.txt');
      expect(result).toBe(false);
    });
  });

  describe('listDirectory', () => {
    it('should list files in directory', async () => {
      const files = ['file1.txt', 'file2.txt'];
      mockReaddir.mockResolvedValue(files);

      const result = await service.listDirectory('/test/dir');
      expect(result).toEqual(files);
      expect(mockReaddir).toHaveBeenCalledWith('/test/dir');
    });

    it('should throw error if listing fails', async () => {
      mockReaddir.mockRejectedValue(new Error('Access denied'));
      await expect(service.listDirectory('/test/dir')).rejects.toThrow('Access denied');
    });
  });

  describe('renameFile', () => {
    it('should rename file', async () => {
      mockRename.mockResolvedValue(undefined);

      await service.renameFile('/old/path', '/new/path');
      expect(mockRename).toHaveBeenCalledWith('/old/path', '/new/path');
    });

    it('should throw error if rename fails', async () => {
      mockRename.mockRejectedValue(new Error('Failed'));
      await expect(service.renameFile('/old/path', '/new/path')).rejects.toThrow('Failed');
    });
  });

  describe('stat', () => {
    it('should return file stats', async () => {
      const mockStats = { size: 1024, isFile: () => true, isDirectory: () => false };
      mockStat.mockResolvedValue(mockStats);

      const result = await service.stat('/test/file.txt');
      expect(result).toBe(mockStats);
      expect(mockStat).toHaveBeenCalledWith('/test/file.txt');
    });

    it('should throw error if stat fails', async () => {
      mockStat.mockRejectedValue(new Error('File not found'));
      await expect(service.stat('/test/missing.txt')).rejects.toThrow('File not found');
    });
  });

  describe('createFileExclusive', () => {
    it('should create file exclusively when it does not exist', async () => {
      const filePath = '/test/new-file.txt';
      const content = 'new content';
      const mockFileHandle = {
        writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
      };
      mockOpen.mockResolvedValue(mockFileHandle);

      const result = await service.createFileExclusive(filePath, content);

      expect(result).toBe(true);
      expect(mockOpen).toHaveBeenCalledWith(filePath, 'wx');
      expect(mockFileHandle.writeFile).toHaveBeenCalledWith(content, { encoding: 'utf-8' });
      expect(mockFileHandle.close).toHaveBeenCalled();
    });

    it('should return false if file already exists', async () => {
      const filePath = '/test/existing-file.txt';
      const content = 'content';
      const error: any = new Error('File exists');
      error.code = 'EEXIST';
      mockOpen.mockRejectedValue(error);

      const result = await service.createFileExclusive(filePath, content);

      expect(result).toBe(false);
    });

    it('should throw error if content exceeds max size', async () => {
      const filePath = '/test/large-file.txt';
      const largeContent = 'a'.repeat(10 * 1024 * 1024 + 1);

      await expect(service.createFileExclusive(filePath, largeContent)).rejects.toThrow('Content exceeds maximum size');
      expect(mockOpen).not.toHaveBeenCalled();
    });

    it('should throw other errors', async () => {
      const filePath = '/test/file.txt';
      const content = 'content';
      const error: any = new Error('Permission denied');
      error.code = 'EACCES';
      mockOpen.mockRejectedValue(error);

      await expect(service.createFileExclusive(filePath, content)).rejects.toThrow('Permission denied');
    });
  });
});
