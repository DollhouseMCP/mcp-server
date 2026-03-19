/**
 * Unit tests for FileStorageBackend
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as path from 'path';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { Stats } from 'fs';

function createMockFileOps(overrides: Partial<FileOperationsService> = {}): FileOperationsService {
  return {
    listDirectory: jest.fn<any>().mockResolvedValue([]),
    stat: jest.fn<any>().mockResolvedValue({ mtimeMs: 1000, size: 512 } as Stats),
    readFile: jest.fn<any>().mockResolvedValue('file content'),
    exists: jest.fn<any>().mockResolvedValue(true),
    ...overrides,
  } as unknown as FileOperationsService;
}

describe('FileStorageBackend', () => {
  describe('listFiles', () => {
    it('should filter files by extension', async () => {
      const fileOps = createMockFileOps({
        listDirectory: jest.fn<any>().mockResolvedValue([
          'alpha.md', 'beta.md', 'config.yaml', 'readme.txt', 'gamma.md'
        ]),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.listFiles('/elements/personas', '.md');

      expect(result).toEqual(['alpha.md', 'beta.md', 'gamma.md']);
    });

    it('should return empty array when no files match', async () => {
      const fileOps = createMockFileOps({
        listDirectory: jest.fn<any>().mockResolvedValue(['config.yaml']),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.listFiles('/elements/personas', '.md');

      expect(result).toEqual([]);
    });
  });

  describe('stat', () => {
    it('should return StorageItemMetadata from file stats', async () => {
      const fileOps = createMockFileOps({
        stat: jest.fn<any>().mockResolvedValue({ mtimeMs: 2000, size: 1024 } as Stats),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.stat('/elements/personas/alpha.md');

      expect(result.relativePath).toBe('alpha.md');
      expect(result.absolutePath).toBe('/elements/personas/alpha.md');
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

      const result = await backend.statMany('/dir', ['a.md', 'b.md']);

      expect(result.size).toBe(2);
      expect(result.get('a.md')?.mtimeMs).toBe(1000);
      expect(result.get('b.md')?.mtimeMs).toBe(2000);
    });

    it('should silently skip files that fail to stat', async () => {
      const fileOps = createMockFileOps({
        stat: jest.fn<any>()
          .mockResolvedValueOnce({ mtimeMs: 1000, size: 100 } as Stats)
          .mockRejectedValueOnce(new Error('ENOENT')),
      });
      const backend = new FileStorageBackend(fileOps);

      const result = await backend.statMany('/dir', ['a.md', 'deleted.md']);

      expect(result.size).toBe(1);
      expect(result.has('a.md')).toBe(true);
      expect(result.has('deleted.md')).toBe(false);
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

  describe('directoryExists', () => {
    it('should return true when directory exists', async () => {
      const fileOps = createMockFileOps({ exists: jest.fn<any>().mockResolvedValue(true) });
      const backend = new FileStorageBackend(fileOps);

      expect(await backend.directoryExists('/dir')).toBe(true);
    });

    it('should return false when directory does not exist', async () => {
      const fileOps = createMockFileOps({ exists: jest.fn<any>().mockResolvedValue(false) });
      const backend = new FileStorageBackend(fileOps);

      expect(await backend.directoryExists('/missing')).toBe(false);
    });
  });
});
