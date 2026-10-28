import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, jest } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { MemoryIndexFile } from '../../../src/storage/MemoryIndexFile.js';
import { MemoryIndexPersistence } from '../../../src/storage/MemoryIndexPersistence.js';
import { logger } from '../../../src/utils/logger.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

import { supportsFileSymlinks } from '../../helpers/file-symlink-support.js';

const symlinkTest = supportsFileSymlinks() ? it : it.skip;
const roots: string[] = [];
afterEach(async () => {
  jest.restoreAllMocks(); jest.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'storage-resilience-')); roots.push(root); return root;
}

it('rethrows the retained scan error within cooldown and retries after invalidation, expiry and clear', async () => {
  const root = await directory(); const ops = createTestFileOperationsService();
  const failure = Object.assign(new Error('unavailable'), { code: 'EACCES' });
  const enumerate = jest.spyOn(ops, 'listDirectoryWithTypes').mockRejectedValue(failure);
  const layer = new ElementStorageLayer(ops, { elementDir: root, fileExtension: '.md', scanCooldownMs: 100 });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
  const retained = await layer.scan().catch((error: unknown) => error);
  expect(retained).toMatchObject({ cause: failure });
  await expect(layer.listSummaries()).rejects.toBe(retained);
  await expect(layer.findIndexedPath(['missing'])).rejects.toBe(retained);
  expect(enumerate).toHaveBeenCalledTimes(1);
  layer.invalidate(); await expect(layer.scan()).rejects.toMatchObject({ cause: failure });
  expect(enumerate).toHaveBeenCalledTimes(2);
  layer.clear(); await expect(layer.scan()).rejects.toMatchObject({ cause: failure });
  expect(enumerate).toHaveBeenCalledTimes(3);
  clock.mockReturnValue(1100); await expect(layer.scan()).rejects.toMatchObject({ cause: failure });
  expect(enumerate).toHaveBeenCalledTimes(4);
  enumerate.mockResolvedValue([]); clock.mockReturnValue(1200);
  await expect(layer.scan()).resolves.toEqual({ added: [], modified: [], removed: [], unchanged: [] });
  await expect(layer.scan()).resolves.toEqual({ added: [], modified: [], removed: [], unchanged: [] });
  expect(enumerate).toHaveBeenCalledTimes(5);
});

it('logs one error per persistence failure streak and quieter retry failures', async () => {
  const file = new MemoryIndexFile(path.resolve('index.json'), createTestFileOperationsService());
  const write = jest.spyOn(file, 'write').mockRejectedValue(new Error('full'));
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const persistence = new MemoryIndexPersistence(file);
  const request = () => persistence.request(() => ({ entries: [], blocked: {}, generation: 1 }), () => {});
  try {
    request(); expect(await persistence.flush()).toBe(false);
    expect(await persistence.flush()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1); expect(warn).toHaveBeenCalledTimes(1);
    write.mockResolvedValueOnce(); expect(await persistence.flush()).toBe(true);
    request(); expect(await persistence.flush()).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
  } finally { persistence.dispose(); }
});

it('bounds shutdown when the index writer never settles and cancels retry resources', async () => {
  jest.useFakeTimers();
  const layer = new MemoryStorageLayer(createTestFileOperationsService(), {
    memoriesDir: path.resolve('memories'), shutdownFlushTimeoutMs: 50,
  });
  const persistence = layer['getState']().persistence;
  jest.spyOn(persistence['file'], 'write').mockImplementation(() => new Promise(() => {}));
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  persistence.request(() => ({ entries: [], blocked: {}, generation: 1 }), () => {});
  let settled = false; const disposal = layer.dispose().then(() => { settled = true; });
  await jest.advanceTimersByTimeAsync(50);
  expect(settled).toBe(true); await disposal;
  expect(error).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith('MemoryStorageLayer: index persistence flush timed out');
  expect(persistence['timer']).toBeNull(); expect(persistence['pending']).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
});

it.each(['read', 'stat'] as const)('skips only absent files during fresh inventory %s', async operation => {
  const root = await directory(); const ops = createTestFileOperationsService();
  const file = path.join(root, 'gone.yaml'); await fs.writeFile(file, 'name: Gone\nentries: []');
  const layer = new MemoryStorageLayer(ops, { memoriesDir: root });
  const method = operation === 'read' ? 'readFile' : 'stat';
  const spy = jest.spyOn(ops, method).mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
  await expect(layer.readFreshSummariesAtDirectory(root)).resolves.toEqual([]);
  const failure = Object.assign(new Error('denied'), { code: 'EACCES' }); spy.mockRejectedValue(failure);
  await expect(layer.readFreshSummariesAtDirectory(root)).rejects.toMatchObject({ cause: failure });
  await layer.dispose();
});

it.each(['element', 'memory'] as const)('enumerates regular files, excluding directory names in the %s layout', async kind => {
  await checkFileEnumeration(kind, false);
});
symlinkTest.each(['element', 'memory'] as const)('enumerates regular files and file symlinks, excluding directory names in the %s layout', async kind => {
  await checkFileEnumeration(kind, true);
});
async function checkFileEnumeration(kind: 'element' | 'memory', links: boolean): Promise<void> {
  const root = await directory(); const ops = createTestFileOperationsService();
  const extension = kind === 'memory' ? '.yaml' : '.md';
  const subdir = kind === 'memory' ? '2026-01-01' : '';
  const dir = path.join(root, subdir); await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, `folder${extension}`));
  const content = kind === 'memory' ? 'name: Healthy\nentries: []' : '---\nname: Healthy\ndescription: A healthy definition\n---\nContent';
  await fs.writeFile(path.join(dir, `healthy${extension}`), content);
  const expected = [path.posix.join(subdir, `healthy${extension}`)];
  if (links) {
    await fs.symlink(path.join(dir, `healthy${extension}`), path.join(dir, `link${extension}`), 'file');
    await fs.symlink(path.join(dir, `folder${extension}`), path.join(dir, `dir-link${extension}`), 'junction');
    expected.push(path.posix.join(subdir, `link${extension}`));
  }
  const layer = kind === 'memory' ? new MemoryStorageLayer(ops, { memoriesDir: root })
    : new ElementStorageLayer(ops, { elementDir: root, fileExtension: extension });
  try {
    const diff = await layer.scan();
    expect(diff.added.sort()).toEqual(expected.sort());
    expect((await layer.readIndexedPath(['Healthy'])).authoritative).toBe(true);
  } finally { await layer.dispose(); }
}

it('skips unsafe persisted paths in both indexed entries and blocked identities', async () => {
  const ops = createTestFileOperationsService(); const file = new MemoryIndexFile(path.resolve('index.json'), ops, 'win32');
  const sep = path.posix.sep;
  const invalid = [`${sep}absolute.yaml`, path.win32.join('C:' + path.win32.sep, 'absolute.yaml'),
    path.posix.join('..', 'escape.yaml'), `system${sep}..${sep}escape.yaml`, `system${sep}${sep}empty.yaml`,
    `system${sep}.${sep}dot.yaml`, `system${sep}`, path.win32.join('system', 'windows.yaml'), 'C:relative.yaml'];
  const good = path.posix.join('system', 'good.yaml'); const keys = [good, ...invalid];
  const entries = Object.fromEntries(keys.map(filePath => [filePath, { filePath, name: 'Name', mtimeMs: 1 }]));
  const blocked = Object.fromEntries(keys.map(key => [key, { nameKey: 'name', mtimeMs: 1 }]));
  jest.spyOn(ops, 'readFile').mockResolvedValue(JSON.stringify({ version: 2, entryCount: keys.length, entries, blocked }));
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const result = await file.read();
  expect(Object.keys(result!.entries)).toEqual([good]); expect(Object.keys(result!.blocked!)).toEqual([good]);
  expect(warn).toHaveBeenCalledWith(`MemoryIndexFile: skipped ${invalid.length} malformed entries during load`);
  expect(warn).toHaveBeenCalledWith(`MemoryIndexFile: skipped ${invalid.length} malformed blocked entries during load`);
});
