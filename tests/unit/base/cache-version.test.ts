/**
 * The file layer vouches for a cached instance against the stat observed before that instance's
 * bytes were read, not against the index record: a scan that records a newer version without
 * evicting the cached instance never makes the stale instance look current.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

const skill = (description: string) => `---\nname: Alpha\ndescription: ${description}\n---\nFollow these detailed instructions.`;

describe('file cache version', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cache-version-'));
    suite = createRealManagerSuite(root);
    const dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    file = path.join(dir, 'alpha.md');
    await writeFile(file, skill('Version zero'));
  });
  afterEach(async () => {
    await suite.skillManager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('serves the edited bytes after a scan recorded them without evicting the cached instance', async () => {
    const manager = suite.skillManager;
    const cached = await manager.load('alpha.md');
    expect(cached.metadata.description).toBe('Version zero');
    expect(await manager.load('alpha.md')).toBe(cached);
    await writeFile(file, skill('Version one, edited'));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    // A scan whose diff is not evicted: the index now records version one.
    const layer = (manager as any).storageLayer;
    layer.invalidate();
    await layer.scan();
    const current = await manager.load('alpha.md');
    expect(current).not.toBe(cached);
    expect(current.metadata.description).toBe('Version one, edited');
    expect(await manager.load('alpha.md')).toBe(current);
  });

  it('never vouches for a saved instance when another writer rewrites the file right after the write', async () => {
    const manager = suite.skillManager;
    const saved = await manager.load('alpha.md');
    saved.metadata.description = 'Saved here';
    const locks = (suite as any).fileLockManager;
    const write = locks.atomicWriteFile.bind(locks);
    const atomicWrite = jest.spyOn(locks, 'atomicWriteFile').mockImplementation(async (...args: unknown[]) => {
      const version = await write(...args);
      // Another process rewrites the file before this process could observe it again.
      await writeFile(file, skill('Rewritten elsewhere'));
      await utimes(file, new Date(), new Date(Date.now() + 9_000));
      return version;
    });
    await manager.save(saved, 'alpha.md');
    atomicWrite.mockRestore();
    expect((await manager.load('alpha.md')).metadata.description).toBe('Rewritten elsewhere');
  });

  it('never vouches for a created instance when another writer rewrites the file right after the create', async () => {
    // Agent creates are exclusive; the created file's version comes from the exclusive handle itself.
    const agents = suite.agentManager;
    const dir = (agents as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    const files = (suite as any).fileOperationsService;
    const create = files.createFileExclusive.bind(files);
    const created = path.join(dir, 'fresh-agent.md');
    const exclusive = jest.spyOn(files, 'createFileExclusive').mockImplementation(async (...args: unknown[]) => {
      const result = await create(...args);
      // Another process rewrites the new file before this process could observe it again.
      const text = await readFile(created, 'utf8');
      await writeFile(created, text.replace('Created here', 'Rewritten elsewhere'));
      await utimes(created, new Date(), new Date(Date.now() + 9_000));
      return result;
    });
    expect((await agents.create('fresh-agent', 'Created here', 'Follow these detailed agent instructions.', {} as never)).success).toBe(true);
    expect(exclusive).toHaveBeenCalled();
    exclusive.mockRestore();
    expect((await agents.load('fresh-agent.md')).metadata.description).toBe('Rewritten elsewhere');
    await agents.dispose();
  });

  it('caches a saved instance unversioned when its write reports no version', async () => {
    const manager = suite.skillManager;
    const saved = await manager.load('alpha.md');
    saved.metadata.description = 'Saved without a reported version';
    const files = (suite as any).fileOperationsService;
    const write = files.writeFile.bind(files);
    const unreported = jest.spyOn(files, 'writeFile').mockImplementation(async (...args: unknown[]) => { await write(...args); });
    await manager.save(saved, 'alpha.md');
    unreported.mockRestore();
    // No stat after the write stands in for the write's own observation: the next load reads the file.
    expect((manager as any)._cache.versionOf(saved)).toBeUndefined();
  });
});
