/**
 * Unit tests for MemoryIndexFile
 */

import { jest } from '@jest/globals';
import { MemoryIndexFile } from '../../../src/storage/MemoryIndexFile.js';
import type { MemoryIndexData } from '../../../src/storage/MemoryIndexFile.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { ElementIndexEntry } from '../../../src/storage/types.js';

function makeEntry(filePath: string, name: string): ElementIndexEntry {
  return {
    filePath,
    name,
    description: `Description of ${name}`,
    version: '1.0.0',
    author: 'tester',
    tags: [],
    mtimeMs: Date.now(),
    sizeBytes: 100,
  };
}

function makeMockFileOps() {
  return {
    readFile: jest.fn<any>(),
    writeFile: jest.fn<any>(),
    exists: jest.fn<any>(),
    readElementFile: jest.fn<any>(),
    deleteFile: jest.fn<any>(),
    createDirectory: jest.fn<any>(),
    listDirectory: jest.fn<any>(),
    listDirectoryWithTypes: jest.fn<any>(),
    renameFile: jest.fn<any>(),
    stat: jest.fn<any>(),
    resolvePath: jest.fn<any>(),
    validatePath: jest.fn<any>(),
    createFileExclusive: jest.fn<any>(),
    copyFile: jest.fn<any>(),
    chmod: jest.fn<any>(),
    appendFile: jest.fn<any>(),
  } as unknown as FileOperationsService;
}

const INDEX_PATH = '/data/memories/_index.json';

describe('MemoryIndexFile', () => {
  let fileOps: FileOperationsService;
  let indexFile: MemoryIndexFile;

  beforeEach(() => {
    fileOps = makeMockFileOps();
    indexFile = new MemoryIndexFile(INDEX_PATH, fileOps);
  });

  afterEach(() => {
    indexFile.dispose();
  });

  describe('read()', () => {
    it('should return parsed data for a valid _index.json', async () => {
      const entries: Record<string, ElementIndexEntry> = {
        'system/core.yaml': makeEntry('system/core.yaml', 'Core'),
        '2025-01-01/notes.yaml': makeEntry('2025-01-01/notes.yaml', 'Notes'),
      };
      const data: MemoryIndexData = {
        version: 1,
        generatedAt: '2025-06-01T00:00:00.000Z',
        entryCount: 2,
        entries,
      };

      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(data));

      const result = await indexFile.read();
      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.entryCount).toBe(2);
      expect(Object.keys(result!.entries)).toHaveLength(2);
    });

    it('should return null when file does not exist (ENOENT)', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      (fileOps.readFile as jest.Mock<any>).mockRejectedValue(err);

      const result = await indexFile.read();
      expect(result).toBeNull();
    });

    it('should return null for corrupt JSON', async () => {
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue('not valid json {{{');

      const result = await indexFile.read();
      expect(result).toBeNull();
    });

    it('should return null when entryCount does not match actual entries', async () => {
      const data: MemoryIndexData = {
        version: 1,
        generatedAt: '2025-06-01T00:00:00.000Z',
        entryCount: 99, // mismatch
        entries: {
          'a.yaml': makeEntry('a.yaml', 'A'),
        },
      };
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(data));

      const result = await indexFile.read();
      expect(result).toBeNull();
    });

    it('should return null for wrong version number', async () => {
      const data = {
        version: 2,
        generatedAt: '2025-06-01T00:00:00.000Z',
        entryCount: 0,
        entries: {},
      };
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(data));

      const result = await indexFile.read();
      expect(result).toBeNull();
    });

    it('should re-throw unexpected errors', async () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      (fileOps.readFile as jest.Mock<any>).mockRejectedValue(err);

      await expect(indexFile.read()).rejects.toThrow('permission denied');
    });
  });

  describe('write()', () => {
    it('should write entries keyed by filePath', async () => {
      (fileOps.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      const entries = [
        makeEntry('system/core.yaml', 'Core'),
        makeEntry('2025-01-01/notes.yaml', 'Notes'),
      ];

      await indexFile.write(entries);

      expect(fileOps.writeFile).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenContent] = (fileOps.writeFile as jest.Mock<any>).mock.calls[0];
      expect(writtenPath).toBe(INDEX_PATH);

      const parsed = JSON.parse(writtenContent as string) as MemoryIndexData;
      expect(parsed.version).toBe(1);
      expect(parsed.entryCount).toBe(2);
      expect(parsed.entries['system/core.yaml'].name).toBe('Core');
      expect(parsed.entries['2025-01-01/notes.yaml'].name).toBe('Notes');
      expect(parsed.generatedAt).toBeDefined();
    });

    it('should catch ENOSPC gracefully without throwing', async () => {
      const err = new Error('no space left') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      (fileOps.writeFile as jest.Mock<any>).mockRejectedValue(err);

      // Should not throw
      await expect(indexFile.write([makeEntry('a.yaml', 'A')])).resolves.toBeUndefined();
    });

    it('should re-throw non-ENOSPC write errors', async () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      (fileOps.writeFile as jest.Mock<any>).mockRejectedValue(err);

      await expect(indexFile.write([makeEntry('a.yaml', 'A')])).rejects.toThrow('permission denied');
    });
  });

  describe('scheduleWrite() debouncing', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      (fileOps.writeFile as jest.Mock<any>).mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should coalesce multiple calls into a single write', () => {
      const indexWithDebounce = new MemoryIndexFile(INDEX_PATH, fileOps, { debounceMs: 500 });

      indexWithDebounce.scheduleWrite([makeEntry('a.yaml', 'A')]);
      indexWithDebounce.scheduleWrite([makeEntry('b.yaml', 'B')]);
      indexWithDebounce.scheduleWrite([makeEntry('c.yaml', 'C')]);

      // Before timer fires, no write
      expect(fileOps.writeFile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(500);

      // Only one write should happen, with the last entries
      expect(fileOps.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = (fileOps.writeFile as jest.Mock<any>).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent) as MemoryIndexData;
      expect(parsed.entries['c.yaml']).toBeDefined();
      expect(parsed.entries['a.yaml']).toBeUndefined();

      indexWithDebounce.dispose();
    });

    it('should reset timer on each scheduleWrite call', () => {
      const indexWithDebounce = new MemoryIndexFile(INDEX_PATH, fileOps, { debounceMs: 500 });

      indexWithDebounce.scheduleWrite([makeEntry('a.yaml', 'A')]);

      // Advance 400ms (not yet fired)
      jest.advanceTimersByTime(400);
      expect(fileOps.writeFile).not.toHaveBeenCalled();

      // Schedule again, resets timer
      indexWithDebounce.scheduleWrite([makeEntry('b.yaml', 'B')]);

      // Advance another 400ms (800ms total, but only 400ms since last schedule)
      jest.advanceTimersByTime(400);
      expect(fileOps.writeFile).not.toHaveBeenCalled();

      // Advance remaining 100ms to reach 500ms since last schedule
      jest.advanceTimersByTime(100);
      expect(fileOps.writeFile).toHaveBeenCalledTimes(1);

      indexWithDebounce.dispose();
    });
  });

  describe('flush()', () => {
    it('should write immediately when there are pending entries', async () => {
      jest.useFakeTimers();
      (fileOps.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      const indexWithDebounce = new MemoryIndexFile(INDEX_PATH, fileOps, { debounceMs: 5000 });

      indexWithDebounce.scheduleWrite([makeEntry('a.yaml', 'A')]);

      // Flush before timer fires
      await indexWithDebounce.flush();

      expect(fileOps.writeFile).toHaveBeenCalledTimes(1);

      // Advancing the timer should NOT cause another write
      jest.advanceTimersByTime(5000);
      expect(fileOps.writeFile).toHaveBeenCalledTimes(1);

      indexWithDebounce.dispose();
      jest.useRealTimers();
    });

    it('should be a no-op when there are no pending entries', async () => {
      (fileOps.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await indexFile.flush();

      expect(fileOps.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('should cancel pending timer without writing', () => {
      jest.useFakeTimers();
      (fileOps.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      const indexWithDebounce = new MemoryIndexFile(INDEX_PATH, fileOps, { debounceMs: 500 });

      indexWithDebounce.scheduleWrite([makeEntry('a.yaml', 'A')]);
      indexWithDebounce.dispose();

      // Advancing past debounce window should NOT trigger write
      jest.advanceTimersByTime(1000);
      expect(fileOps.writeFile).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('round-trip', () => {
    it('should write entries then read them back identically', async () => {
      const entries = [
        makeEntry('system/core.yaml', 'Core'),
        makeEntry('adapters/github.yaml', 'GitHub Adapter'),
      ];

      let storedContent = '';
      (fileOps.writeFile as jest.Mock<any>).mockImplementation(
        async (_path: string, content: string) => {
          storedContent = content;
        },
      );
      (fileOps.readFile as jest.Mock<any>).mockImplementation(async () => storedContent);

      await indexFile.write(entries);
      const result = await indexFile.read();

      expect(result).not.toBeNull();
      expect(result!.entryCount).toBe(2);
      expect(result!.entries['system/core.yaml'].name).toBe('Core');
      expect(result!.entries['adapters/github.yaml'].name).toBe('GitHub Adapter');
    });
  });
});
