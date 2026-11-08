import { afterEach, describe, expect, it, jest } from '@jest/globals';
import nativePath from 'node:path';
import type { IStorageBackend } from '../../../../src/storage/IStorageBackend.js';

const path = nativePath.win32;
jest.unstable_mockModule('node:path', () => ({ ...path, default: path }));
const { createRealMemoryManager } = await import('../../../helpers/di-mocks.js');
const { MemoryStorageLayer } = await import('../../../../src/storage/MemoryStorageLayer.js');
const { FileStorageLayerBase } = await import('../../../../src/storage/FileStorageLayerBase.js');
const { FileOperationsService } = await import('../../../../src/services/FileOperationsService.js');
const { FileLockManager } = await import('../../../../src/security/fileLockManager.js');

const ROOT = path.resolve('C:/', 'portable-memory-fixture');
const DIR = path.join(ROOT, 'memories');
const folders = ['system', 'adapters', '2026-01-01'];
const absent = () => Object.assign(new Error('Missing fixture file'), { code: 'ENOENT' });

function fixture() {
  const files = new Map(folders.map(folder => [path.join(DIR, folder, 'notes.yaml'),
    `name: ${folder}-notes\ndescription: portable fixture\nentries: []\n`]));
  const metadata = (absolutePath: string) => ({ absolutePath,
    relativePath: path.relative(DIR, absolutePath).split(path.sep).join('/'), mtimeMs: 1, sizeBytes: 64 });
  const backend: IStorageBackend = {
    directoryExists: jest.fn<IStorageBackend['directoryExists']>().mockResolvedValue(true),
    listDirectories: jest.fn<IStorageBackend['listDirectories']>().mockResolvedValue(folders),
    listFiles: jest.fn<IStorageBackend['listFiles']>().mockImplementation(async directory =>
      [...files.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file))),
    stat: jest.fn<IStorageBackend['stat']>().mockImplementation(async absolutePath => {
      if (!files.has(absolutePath)) throw absent();
      return metadata(absolutePath);
    }),
    statMany: jest.fn<IStorageBackend['statMany']>().mockImplementation(async (directory, references) => ({
      stats: new Map(references.map(reference => [reference, metadata(path.join(directory, reference))])), failures: new Map(),
    })),
    readFile: jest.fn<IStorageBackend['readFile']>().mockImplementation(async absolutePath => {
      const content = files.get(absolutePath);
      if (content === undefined) throw absent();
      return content;
    }),
  };
  const ops = new FileOperationsService(new FileLockManager());
  jest.spyOn(ops, 'readFile').mockRejectedValue(absent()); // No persisted index in this fixture.
  jest.spyOn(ops, 'writeFile').mockResolvedValue(undefined);
  jest.spyOn(ops, 'exists').mockImplementation(async absolutePath => files.has(absolutePath));
  jest.spyOn(ops, 'listDirectory').mockImplementation(async directory => directory === DIR ? folders
    : [...files.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file)));
  const layer = new MemoryStorageLayer(ops, { memoriesDir: DIR, storageBackend: backend });
  const manager = createRealMemoryManager(ROOT, { fileOperationsService: ops,
    storageLayerFactory: { createForElement: () => layer } });
  const reads = jest.spyOn(layer, 'readContent');
  return { manager, layer, reads, backend };
}

afterEach(() => jest.restoreAllMocks());

describe('native Windows paths at memory storage boundaries', () => {
  it('lists real memory definitions with portable references through the shared loader', async () => {
    const f = fixture();
    try {
      const listed = await f.manager.list();
      expect(listed.map(memory => memory.getFilePath()).sort()).toEqual(folders.map(folder => `${folder}/notes.yaml`).sort());
      expect(f.reads.mock.calls.map(([reference]) => reference).sort()).toEqual(folders.map(folder => `${folder}/notes.yaml`).sort());
    } finally { await f.manager.dispose(); }
  });

  it.each(folders)('loads the held %s reference exactly', async folder => {
    const f = fixture();
    try {
      const memory = await f.manager.load(`${folder}/notes.yaml`);
      expect(memory.metadata.name).toBe(`${folder}-notes`);
      expect(f.reads).toHaveBeenCalledWith(`${folder}/notes.yaml`);
    } finally { await f.manager.dispose(); }
  });

  it('resolves a bare filename through the real subfolder fallback', async () => {
    const f = fixture();
    try {
      expect((await f.manager.load('notes.yaml')).metadata.name).toBe('system-notes');
      expect(f.reads).toHaveBeenCalledWith('system/notes.yaml');
    } finally { await f.manager.dispose(); }
  });

  it('uses portable references for per-directory diagnostic reads', async () => {
    const f = fixture();
    try {
      const failures: Array<{ file: string; error: string }> = [];
      expect(await f.manager['checkDirectoryFiles']('system', failures)).toEqual({ total: 1, loaded: 1 });
      expect(failures).toEqual([]);
      expect(f.reads).toHaveBeenCalledWith('system/notes.yaml');
    } finally { await f.manager.dispose(); }
  });

  it('attaches a portable held reference when the cache receives an absolute native path', async () => {
    const f = fixture();
    try {
      const memory = await f.manager.load('system/notes.yaml');
      f.manager['_cache'].withDirectoryPin(lease =>
        f.manager['cacheElement'](memory, path.join(DIR, 'system', 'notes.yaml'), lease));
      expect(memory.getFilePath()).toBe('system/notes.yaml');
    } finally { await f.manager.dispose(); }
  });

  it('reads a portable reference through FileStorageLayerBase without weakening input validation', async () => {
    const f = fixture();
    try {
      expect(await FileStorageLayerBase.prototype.readContent.call(f.layer, 'system/notes.yaml')).toContain('system-notes');
      expect(f.backend.readFile).toHaveBeenCalledWith(path.join(DIR, 'system', 'notes.yaml'));
      await expect(f.layer.readContent('system\\notes.yaml')).rejects.toThrow('Reference contains characters');
      await expect(f.layer.readContent('../outside.yaml')).rejects.toThrow(/Path access denied|Path traversal detected/);
    } finally { await f.manager.dispose(); }
  });
});
