import * as path from 'node:path';
/**
 * Unit tests for FileStorageBackend
 */

import { describe, it, expect, jest } from '@jest/globals';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { Stats } from 'fs';

function createMockFileOps(overrides: Partial<FileOperationsService> = {}): FileOperationsService {
  return {
    listDirectoryWithTypes: jest.fn<any>().mockResolvedValue([]),
    stat: jest.fn<any>().mockResolvedValue({ mtimeMs: 1000, size: 512 } as Stats),
    readFile: jest.fn<any>().mockResolvedValue('file content'),
    exists: jest.fn<any>().mockResolvedValue(true),
    directoryExists: FileOperationsService.prototype.directoryExists,
    ...overrides,
  } as unknown as FileOperationsService;
}

describe('FileStorageBackend', () => {
  describe('listFiles', () => {
    it('should filter files by extension', async () => {
      const fileOps = createMockFileOps({
        listDirectoryWithTypes: jest.fn<any>().mockResolvedValue([
          'alpha.md', 'beta.md', 'config.yaml', 'readme.txt', 'gamma.md'
        ].map(name => ({ name, isFile: true, isDirectory: false }))),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.listFiles(path.resolve('elements', 'personas'), '.md');

      expect(result).toEqual(['alpha.md', 'beta.md', 'gamma.md']);
    });

    it('should return empty array when no files match', async () => {
      const fileOps = createMockFileOps({
        listDirectoryWithTypes: jest.fn<any>().mockResolvedValue([{ name: 'config.yaml', isFile: true, isDirectory: false }]),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.listFiles(path.resolve('elements', 'personas'), '.md');

      expect(result).toEqual([]);
    });
  });

  describe('stat', () => {
    it('should return StorageItemMetadata from file stats', async () => {
      const fileOps = createMockFileOps({
        stat: jest.fn<any>().mockResolvedValue({ mtimeMs: 2000, size: 1024 } as Stats),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.stat(path.resolve('elements', 'personas', 'alpha.md'));

      expect(result.relativePath).toBe('alpha.md');
      expect(result.absolutePath).toBe(path.resolve('elements', 'personas', 'alpha.md'));
      expect(result.mtimeMs).toBe(2000);
      expect(result.sizeBytes).toBe(1024);
    });
  });

  describe('statMany', () => {
    it('should stat multiple files in parallel', async () => {
      const fileOps = createMockFileOps({
        stat: jest.fn<any>()
          .mockResolvedValueOnce({ mtimeMs: 1000, size: 100 } as Stats)
          .mockResolvedValueOnce({ mtimeMs: 2000, size: 200 } as Stats),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.statMany(path.resolve('dir'), ['a.md', 'b.md']);

      expect(result.stats.size).toBe(2);
      expect(result.stats.get('a.md')?.mtimeMs).toBe(1000);
      expect(result.stats.get('b.md')?.mtimeMs).toBe(2000);
    });

    it.each([['ENOENT', false], ['ENOTDIR', true]])('reports a %s stat as a failure only when it does not prove absence (%s)', async (code, reported) => {
      const error = Object.assign(new Error('gone'), { code });
      const fileOps = createMockFileOps({
        stat: jest.fn<any>()
          .mockResolvedValueOnce({ mtimeMs: 1000, size: 100 } as Stats)
          .mockRejectedValueOnce(error),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.statMany(path.resolve('dir'), ['a.md', 'deleted.md']);

      expect(result.stats.size).toBe(1);
      expect(result.stats.has('a.md')).toBe(true);
      expect(result.stats.has('deleted.md')).toBe(false);
      expect(result.failures.get('deleted.md')).toBe(reported ? error : undefined);
    });

    it('keeps an entry whose target stat is ENOTDIR so the scan reports it', async () => {
      const fileOps = createMockFileOps({
        listDirectoryWithTypes: jest.fn<any>().mockResolvedValue([
          { name: 'absent.md', isFile: false, isDirectory: false },
          { name: 'misplaced.md', isFile: false, isDirectory: false },
        ]),
        stat: jest.fn<any>().mockImplementation(async (target: string) => {
          throw Object.assign(new Error('target'), { code: path.basename(target) === 'absent.md' ? 'ENOENT' : 'ENOTDIR' });
        }),
      });
      const backend = new FileStorageBackend(fileOps);
      expect(await backend.listFiles(path.resolve('dir'), '.md')).toEqual(['misplaced.md']);
    });
  });

  describe('readFile', () => {
    it('should delegate to fileOps.readFile', async () => {
      const fileOps = createMockFileOps({
        readFile: jest.fn<any>().mockResolvedValue('---\nname: Test\n---\nContent'),
      });
      const backend = new FileStorageBackend(fileOps);

      const testPath = path.join(path.sep, 'dir', 'test.md');
      const result = await backend.readFile(testPath);

      expect(result).toBe('---\nname: Test\n---\nContent');
      expect(fileOps.readFile).toHaveBeenCalledWith(testPath);
    });
  });

  it('returns per-file stat errors while omitting absent paths', async () => {
    const stat = jest.fn<FileOperationsService['stat']>()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
      .mockRejectedValueOnce(Object.assign(new Error('I/O'), { code: 'EIO' }));
    const backend = new FileStorageBackend(createMockFileOps({ stat }));
    const result = await backend.statMany(path.resolve('dir'), ['gone.md', 'denied.md', 'io.md']);
    expect(result.stats.size).toBe(0);
    expect([...result.failures.keys()]).toEqual(['denied.md', 'io.md']);
    expect(result.failures.get('denied.md')).toMatchObject({ code: 'EACCES' });
    expect(result.failures.get('io.md')).toMatchObject({ code: 'EIO' });
  });

  describe('directoryExists', () => {
    it('refuses an ordinary file at the directory path instead of calling it missing', async () => {
      const backend = new FileStorageBackend(createMockFileOps({
        stat: jest.fn<FileOperationsService['stat']>().mockResolvedValue({ isDirectory: () => false } as Stats),
      }));
      await expect(backend.directoryExists(path.resolve('file'))).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it.each(['ENOENT', 'ENOTDIR', 'EACCES', 'EIO'])('classifies directory stat error %s', async code => {
      const error = Object.assign(new Error(code), { code });
      const backend = new FileStorageBackend(createMockFileOps({
        stat: jest.fn<FileOperationsService['stat']>().mockRejectedValue(error),
      }));
      // Only a missing path is absence; a file where the directory should be, or any other failure, rejects the scan.
      if (code === 'ENOENT') await expect(backend.directoryExists(path.resolve('dir'))).resolves.toBe(false);
      else await expect(backend.directoryExists(path.resolve('dir'))).rejects.toBe(error);
    });
    it('should return true when directory exists', async () => {
      const fileOps = createMockFileOps({ stat: jest.fn<FileOperationsService['stat']>().mockResolvedValue({ isDirectory: () => true } as Stats) });
      const backend = new FileStorageBackend(fileOps);

      expect(await backend.directoryExists(path.resolve('dir'))).toBe(true);
    });

    it('should return false when directory does not exist', async () => {
      const fileOps = createMockFileOps({ stat: jest.fn<FileOperationsService['stat']>().mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' })) });
      const backend = new FileStorageBackend(fileOps);

      expect(await backend.directoryExists(path.resolve('missing'))).toBe(false);
    });
  });
});
