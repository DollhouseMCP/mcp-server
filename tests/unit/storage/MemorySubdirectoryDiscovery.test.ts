import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, jest } from '@jest/globals';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

import { supportsFileSymlinks } from '../../helpers/file-symlink-support.js';

const symlinkTest = supportsFileSymlinks() ? it : it.skip;
const roots: string[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'memory-directories-')); roots.push(root); return root;
}
it.each(['system', 'adapters', '2026-01-01'])('ignores a stray %s file in normal and guarded inventories', async name => {
  const root = await directory();
  await fs.writeFile(path.join(root, name), 'stray');
  await fs.writeFile(path.join(root, 'healthy.yaml'), 'name: Healthy\nentries: []');
  const layer = new MemoryStorageLayer(createTestFileOperationsService(), { memoriesDir: root });
  try {
    expect((await layer.scan()).added).toEqual(['healthy.yaml']);
    expect((await layer.readFreshSummariesAtDirectory(root)).map(entry => entry.filePath)).toEqual(['healthy.yaml']);
    expect((await layer.readIndexedPath(['Healthy'])).authoritative).toBe(true);
  } finally { await layer.dispose(); }
});
symlinkTest('scans directory symlinks and ignores file symlinks during guarded inventory', async () => {
  const root = await directory(); const target = path.join(root, 'target'); await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'linked.yaml'), 'name: Linked\nentries: []');
  await fs.writeFile(path.join(root, 'stray.txt'), 'stray');
  await fs.symlink(target, path.join(root, '2026-01-01'), 'junction');
  await fs.symlink(path.join(root, 'stray.txt'), path.join(root, '2026-01-02'), 'file');
  const layer = new MemoryStorageLayer(createTestFileOperationsService(), { memoriesDir: root });
  const expected = [path.posix.join('2026-01-01', 'linked.yaml')];
  try {
    expect((await layer.scan()).added).toEqual(expected);
    expect((await layer.readFreshSummariesAtDirectory(root)).map(entry => entry.filePath)).toEqual(expected);
  } finally { await layer.dispose(); }
});
it('uses the same absent and uncertain target policy for directory and file listing', async () => {
  const ops = createTestFileOperationsService(); const backend = new FileStorageBackend(ops);
  const names = ['directory.yaml', 'file.yaml', 'absent.yaml', 'uncertain.yaml'];
  jest.spyOn(ops, 'listDirectoryWithTypes').mockResolvedValue(names.map(name => ({ name, isFile: false, isDirectory: false })));
  jest.spyOn(ops, 'stat').mockImplementation(async target => {
    const name = path.basename(target);
    if (name === 'absent.yaml') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    if (name === 'uncertain.yaml') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return { isFile: () => name === 'file.yaml', isDirectory: () => name === 'directory.yaml' } as Awaited<ReturnType<typeof ops.stat>>;
  });
  const root = path.resolve('memories');
  expect(await backend.listDirectories(root)).toEqual(['directory.yaml', 'uncertain.yaml']);
  expect(await backend.listFiles(root, '.yaml')).toEqual(['file.yaml', 'uncertain.yaml']);
});
it('discovers system, adapters, sorted dates and root in that order', async () => {
  const root = await directory(); const ops = createTestFileOperationsService(); const backend = new FileStorageBackend(ops);
  jest.spyOn(backend, 'listDirectories').mockResolvedValue(['adapters', '2026-02-01', 'system', '2026-01-01']);
  const files = jest.spyOn(backend, 'listFiles').mockResolvedValue([]);
  const layer = new MemoryStorageLayer(ops, { memoriesDir: root, storageBackend: backend });
  try {
    await layer.scan();
    expect(files.mock.calls.map(([dir]) => dir)).toEqual(['system', 'adapters', '2026-01-01', '2026-02-01', ''].map(dir => path.join(root, dir)));
  } finally { await layer.dispose(); }
});
