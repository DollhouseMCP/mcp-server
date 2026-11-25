import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { createTestFileOperationsService, createRealSkillManager, createRealMemoryManager } from '../../helpers/di-mocks.js';
import { ElementReadError } from '../../../src/elements/base/ElementReadError.js';

describe('file collection completeness', () => {
  const roots: string[] = [];
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });
  async function fixture() {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'collection-read-'));
    roots.push(root);
    const directory = path.join(root, 'skills');
    const operations = createTestFileOperationsService();
    const layer = new ElementStorageLayer(operations, { elementDir: directory, fileExtension: '.md', scanCooldownMs: 0 });
    return { root, directory, operations, layer };
  }

  it('returns complete empty discovery for a directory that has never existed', async () => {
    const { directory, layer } = await fixture();
    try {
      const report = await layer.readCollection();
      expect(report).toMatchObject({ complete: true, entries: [] });
      expect(report.unindexed.size).toBe(0);
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await layer.dispose(); }
  });

  it('refuses an existing directory whose enumeration fails', async () => {
    const { directory, operations, layer } = await fixture();
    await fs.mkdir(directory);
    jest.spyOn(operations, 'listDirectoryWithTypes').mockRejectedValue(Object.assign(new Error('cannot enumerate'), { code: 'EACCES' }));
    try {
      await expect(layer.readCollection()).rejects.toMatchObject({ code: 'EACCES' });
    } finally { await layer.dispose(); }
  });

  it('can create and read the first element after an empty list without listing creating directories', async () => {
    const { root, layer } = await fixture();
    await layer.dispose();
    const manager = createRealSkillManager(root);
    try {
      expect(await manager.list()).toEqual([]);
      await manager.create({ name: 'First skill', description: 'A first persisted skill', instructions: 'Follow these detailed instructions.' });
      expect((await manager.list()).map(element => element.metadata.name)).toContain('First skill');
    } finally { await manager.dispose(); }
  });

  it('lists incomplete survivors but refuses named content when a never-parsed newer copy exists', async () => {
    const { root, layer } = await fixture();
    await layer.dispose();
    const older = path.join(root, 'memories', '2026-10-01', 'policy-memory.yaml');
    const newer = path.join(root, 'memories', '2026-10-27', 'policy-memory.yaml');
    await fs.mkdir(path.dirname(older), { recursive: true });
    await fs.writeFile(older, 'metadata:\n  name: policy-memory\n  description: Older policy definition\nentries: []\n');
    const manager = createRealMemoryManager(root);
    try {
      expect((await manager.findByName('policy-memory'))?.metadata.name).toBe('policy-memory');
      await fs.mkdir(path.dirname(newer), { recursive: true });
      await fs.writeFile(newer, 'metadata: [unfinished');
      manager.clearCache();
      await manager['scanAndEvict']();
      await expect(manager.findByName('policy-memory')).rejects.toBeInstanceOf(ElementReadError);
      await expect(manager.list()).rejects.toBeInstanceOf(ElementReadError);
      const report = await manager.listReport();
      expect(report.complete).toBe(false);
      expect(report.items.map(item => item.metadata.name)).not.toContain('policy-memory');
      await expect(manager.activateMemory('policy-memory')).rejects.toBeInstanceOf(ElementReadError);
      expect(report.failures.map(failure => failure.reference)).toContain('2026-10-27/policy-memory.yaml');
    } finally { await manager.dispose(); }
  });

  it('withholds a failed known name while preserving unrelated advisory memory entries', async () => {
    const { root, layer } = await fixture();
    await layer.dispose();
    const directory = path.join(root, 'memories');
    await fs.mkdir(directory, { recursive: true });
    const older = path.join(directory, 'older.yaml');
    const newer = path.join(directory, 'newer.yaml');
    const healthy = path.join(directory, 'healthy.yaml');
    const definition = (name: string) => `metadata:\n  name: ${name}\n  description: Readable memory definition\nentries: []\n`;
    await fs.writeFile(older, definition('policy-memory'));
    await fs.writeFile(newer, definition('policy-memory'));
    await fs.writeFile(healthy, definition('healthy-memory'));
    const manager = createRealMemoryManager(root);
    try {
      await manager.list();
      await fs.writeFile(newer, 'metadata: [unfinished');
      await manager['scanAndEvict']();
      const report = await manager.listReport();
      expect(report.items.map(item => item.metadata.name)).toEqual(['healthy-memory']);
      expect(report.failures).toEqual([expect.objectContaining({ reference: 'newer.yaml', elementName: 'policy-memory' })]);
      await expect(manager.list()).rejects.toBeInstanceOf(ElementReadError);
      await expect(manager.findByName('policy-memory')).rejects.toBeInstanceOf(ElementReadError);
    } finally { await manager.dispose(); }
  });
});
