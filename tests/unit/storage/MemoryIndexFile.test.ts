/**
 * Unit tests for MemoryIndexFile
 */

import * as path from 'node:path';
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

const INDEX_PATH = path.resolve('data', 'memories', '_index.json');

describe('MemoryIndexFile', () => {
  let fileOps: FileOperationsService;
  let indexFile: MemoryIndexFile;

  beforeEach(() => {
    fileOps = makeMockFileOps();
    indexFile = new MemoryIndexFile(INDEX_PATH, fileOps);
  });


  it('roundtrips blocked name slots without including them in the entry count', async () => {
    const blocked = { 'new.yaml': { nameKey: 'shared', mtimeMs: 2 } };
    await indexFile.write([makeEntry('old.yaml', 'Shared')], blocked);
    const serialized = jest.mocked(fileOps.writeFile).mock.calls[0][1];
    jest.mocked(fileOps.readFile).mockResolvedValue(serialized);
    expect(await indexFile.read()).toMatchObject({ entryCount: 1, blocked });
  });

  it('skips malformed blocked entries and accepts a missing blocked field', async () => {
    const data = { version: 2, entryCount: 0, entries: {}, blocked: {
      'good.yaml': { nameKey: 'shared', mtimeMs: 2 },
      '': { nameKey: 'shared', mtimeMs: 2 },
      'empty.yaml': { nameKey: ' ', mtimeMs: 2 },
      'bad.yaml': { nameKey: 'shared', mtimeMs: '2' },
      'null.yaml': null,
      'infinite.yaml': { nameKey: 'shared', mtimeMs: Infinity },
    } };
    jest.mocked(fileOps.readFile).mockResolvedValue(JSON.stringify(data));
    expect((await indexFile.read())?.blocked).toEqual({ 'good.yaml': { nameKey: 'shared', mtimeMs: 2 } });
    jest.mocked(fileOps.readFile).mockResolvedValue(JSON.stringify({ version: 2, entryCount: 0, entries: {} }));
    expect((await indexFile.read())?.blocked).toEqual({});
  });

  it('skips entries whose path or mtime cannot identify a valid observation', async () => {
    const entries = {
      'good.yaml': makeEntry('good.yaml', 'Good'),
      'wrong.yaml': makeEntry('other.yaml', 'Wrong'),
      'infinite.yaml': { ...makeEntry('infinite.yaml', 'Bad'), mtimeMs: Infinity },
      'missing.yaml': { ...makeEntry('missing.yaml', 'Bad'), mtimeMs: undefined },
    };
    jest.mocked(fileOps.readFile).mockResolvedValue(JSON.stringify({ version: 2, entryCount: 4, entries }));
    const result = await indexFile.read();
    expect(Object.keys(result!.entries)).toEqual(['good.yaml']);
    expect(result!.entryCount).toBe(1);
  });

  describe('read()', () => {
    it('should return parsed data for a valid _index.json', async () => {
      const entries: Record<string, ElementIndexEntry> = {
        'system/core.yaml': makeEntry('system/core.yaml', 'Core'),
        '2025-01-01/notes.yaml': makeEntry('2025-01-01/notes.yaml', 'Notes'),
      };
      const data: MemoryIndexData = {
        version: 2,
        generatedAt: '2025-06-01T00:00:00.000Z',
        entryCount: 2,
        entries,
      };

      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(data));

      const result = await indexFile.read();
      expect(result).not.toBeNull();
      expect(result!.version).toBe(2);
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
        version: 2,
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
        version: 3,
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
      expect(parsed.version).toBe(2);
      expect(parsed.entryCount).toBe(2);
      expect(parsed.entries['system/core.yaml'].name).toBe('Core');
      expect(parsed.entries['2025-01-01/notes.yaml'].name).toBe('Notes');
      expect(parsed.generatedAt).toBeDefined();
    });

    it('reports ENOSPC to the persistence owner', async () => {
      const err = new Error('no space left') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      (fileOps.writeFile as jest.Mock<any>).mockRejectedValue(err);

      await expect(indexFile.write([makeEntry('a.yaml', 'A')])).rejects.toBe(err);
    });

    it('should re-throw non-ENOSPC write errors', async () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      (fileOps.writeFile as jest.Mock<any>).mockRejectedValue(err);

      await expect(indexFile.write([makeEntry('a.yaml', 'A')])).rejects.toThrow('permission denied');
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
