import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, jest } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import { StorageScanError, sanitizeStorageError } from '../../../src/storage/StorageScanError.js';
import { SecurityError } from '../../../src/errors/SecurityError.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { STORAGE_SCAN_CONCURRENCY } from '../../../src/storage/mapStorageItems.js';
import { listElements } from '../../../src/handlers/element-crud/listElements.js';
import type { ElementCrudContext } from '../../../src/handlers/element-crud/types.js';
import { logger } from '../../../src/utils/logger.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

const roots: string[] = [];
const layers: Array<ElementStorageLayer | MemoryStorageLayer> = [];

it('redacts a real file lock timeout during scan and preserves its cause in fresh inventory', async () => {
  const f = await fixture('memory');
  const file = await f.write('locked', 'Locked');
  const target = path.join(f.root, file);
  let finish!: () => void;
  const operation = new Promise<void>(resolve => { finish = resolve; });
  try {
    const failure = await new FileLockManager().withLock(`file:${target}`, () => operation, { timeout: 1 }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'ETIMEDOUT', path: target });
    jest.spyOn(f.backend, 'readFile').mockRejectedValue(failure);
    await f.layer.scan();
    const entry = f.layer['getState']().table.unindexed().get(file);
    expect(entry).toMatchObject({ name: 'Error', code: 'ETIMEDOUT' });
    expect(entry?.reason).toContain(file);
    expect(entry?.reason).not.toContain(f.root);
    await expect((f.layer as MemoryStorageLayer).readFreshSummariesAtDirectory(f.root)).rejects.toMatchObject({
      cause: failure, message: expect.not.stringContaining(f.root),
    });
  } finally { finish(); await operation; }
});

it('preserves non-filesystem error identity and classifies errno, path and dest failures', () => {
  for (const error of [new Error('listener failed'), SecurityError.contentValidation('Invalid content'), 'failure', null]) {
    expect(sanitizeStorageError(error)).toBe(error);
  }
  const root = path.resolve('private-storage');
  for (const properties of [{ code: 'EIO' }, { path: path.join(root, 'file') }, { dest: path.join(root, 'file') }]) {
    const error = Object.assign(new Error(`Failure at ${root}`), properties);
    const safe = sanitizeStorageError(error, root) as StorageScanError;
    expect(safe).toBeInstanceOf(StorageScanError);
    expect(safe.cause).toBe(error);
    expect(safe.message).not.toContain(root);
    expect(sanitizeStorageError(safe)).toBe(safe);
  }
});

it.each(['element', 'memory'] as const)('preserves the parse reason for an unindexed %s file', async kind => {
  const f = await fixture(kind);
  const file = await f.write('malformed', 'Malformed');
  await fs.writeFile(path.join(f.root, file), kind === 'memory' ? 'metadata: [unfinished' : '---\nname: [unfinished\n---\nBody');
  await f.layer.scan();
  const reason = f.layer['getState']().table.unindexed().get(file)?.reason;
  expect(reason).toMatch(/unexpected end|flow collection/);
  expect(reason).not.toContain(f.root);
});
afterEach(async () => {
  for (const layer of layers.splice(0)) await layer.dispose();
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(kind: 'element' | 'memory', cooldown = 0) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'scan-safety-')); roots.push(root);
  const ops = createTestFileOperationsService();
  const backend = new FileStorageBackend(ops);
  const layer = kind === 'memory'
    ? new MemoryStorageLayer(ops, { memoriesDir: root, storageBackend: backend, scanCooldownMs: cooldown })
    : new ElementStorageLayer(ops, { elementDir: root, fileExtension: '.md', storageBackend: backend, scanCooldownMs: cooldown });
  layers.push(layer);
  const extension = kind === 'memory' ? '.yaml' : '.md';
  const write = async (filename: string, name: string, seconds = 1) => {
    const target = path.join(root, filename + extension);
    await fs.writeFile(target, kind === 'memory' ? `name: ${name}` : `---\nname: ${name}\n---\nContent`);
    await fs.utimes(target, seconds, seconds);
    return filename + extension;
  };
  return { root, ops, backend, layer, write };
}

it.each(['element', 'memory'] as const)('keeps %s enumeration errors path-safe through first scan and cooldown client responses', async kind => {
  const f = await fixture(kind, 60000);
  const target = kind === 'memory' ? path.join(f.root, '2026-10-02') : f.root;
  if (kind === 'memory') await fs.mkdir(target);
  const failure = Object.assign(new Error(`EACCES: permission denied, scandir '${target}'`), { code: 'EACCES', path: target });
  const list = f.ops.listDirectoryWithTypes.bind(f.ops);
  const calls = jest.spyOn(f.ops, 'listDirectoryWithTypes').mockImplementation(async dir => {
    if (dir === target) throw failure;
    return list(dir);
  });
  const manager = { list: () => f.layer.listSummaries() };
  const context = { ensureInitialized: async () => {}, memoryManager: manager, skillManager: manager } as unknown as ElementCrudContext;
  for (let i = 0; i < 2; i++) {
    const result = await listElements(context, kind === 'memory' ? 'memories' : 'skills');
    expect(result).toHaveProperty('error', expect.stringContaining('EACCES'));
    expect(JSON.stringify(result)).not.toContain(f.root);
  }
  const error = await f.layer.scan().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(StorageScanError);
  expect(error).toMatchObject({ cause: failure, code: 'EACCES', relativePath: kind === 'memory' ? '2026-10-02' : '.' });
  expect(calls.mock.calls.filter(([dir]) => dir === target)).toHaveLength(1);
});

it.each(['element', 'memory'] as const)('warns once per duplicate %s name winner change', async kind => {
  const f = await fixture(kind);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const first = await f.write('first', 'Shared', 1);
  await f.layer.scan(); expect(warn).not.toHaveBeenCalled();
  const second = await f.write('second', 'Shared', 2);
  await f.layer.scan();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain(first);
  expect(warn.mock.calls[0][0]).toContain(second);
  expect(warn.mock.calls[0][0]).not.toContain(f.root);
  expect(f.layer.getPathByName('Shared')).toBe(second);
  await f.layer.scan(); expect(warn).toHaveBeenCalledTimes(1);
  const third = await f.write('third', 'Shared', 3);
  await f.layer.scan(); expect(warn).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls[1][0]).toContain(third);
  expect(f.layer.getPathByName('Shared')).toBe(third);
});

it.each(['element', 'memory'] as const)('keeps %s per-file failure reasons path-safe with original diagnostics classified', async kind => {
  const f = await fixture(kind);
  const file = await f.write('blocked', 'Blocked');
  const failure = Object.assign(new Error(`Cannot read ${path.join(f.root, file)}`), { code: 'EIO' });
  jest.spyOn(f.backend, 'readFile').mockRejectedValue(failure);
  await f.layer.scan();
  const entry = f.layer['getState']().table.unindexed().get(file);
  expect(entry).toMatchObject({ name: 'Error', code: 'EIO' });
  expect(entry?.reason).toContain(file);
  expect(entry?.reason).not.toContain(f.root);
});

it('bounds stat and read concurrency without changing indexed results', async () => {
  const f = await fixture('element');
  const files = await Promise.all(Array.from({ length: STORAGE_SCAN_CONCURRENCY * 3 }, (_, i) => f.write(`entry-${i}`, `Entry ${i}`)));
  let stats = 0; let reads = 0; let maxStats = 0; let maxReads = 0;
  const stat = f.ops.stat.bind(f.ops); const read = f.backend.readFile.bind(f.backend);
  jest.spyOn(f.ops, 'stat').mockImplementation(async target => {
    stats++; maxStats = Math.max(maxStats, stats);
    try { await new Promise(resolve => setImmediate(resolve)); return await stat(target); }
    finally { stats--; }
  });
  jest.spyOn(f.backend, 'readFile').mockImplementation(async target => {
    reads++; maxReads = Math.max(maxReads, reads);
    try { await new Promise(resolve => setImmediate(resolve)); return await read(target); }
    finally { reads--; }
  });
  const result = await f.layer.scan();
  expect(result.added.sort()).toEqual(files.sort());
  expect(await f.layer.listSummaries()).toHaveLength(files.length);
  expect(maxStats).toBeGreaterThan(1); expect(maxStats).toBeLessThanOrEqual(STORAGE_SCAN_CONCURRENCY);
  expect(maxReads).toBeGreaterThan(1); expect(maxReads).toBeLessThanOrEqual(STORAGE_SCAN_CONCURRENCY);
});
