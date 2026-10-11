import { describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';

describe('configured process unattributed memory fences', () => {
  it('refuses global startup/background resolution before retrieving a fixed manager, including unknown configured registry', async () => {
    const container = new DollhouseContainer();
    const resolveFixed = jest.fn(() => { throw new Error('Fixed owner must not be retrieved'); });
    container.replace('MemoryManager', resolveFixed);
    // Unknown configuration is refused too; this is not a qualification fixture.
    container.register('DatabaseTenantMemoryRegistry', () => ({}));
    try {
      expect(() => container.resolve('ServerStartup')).toThrow('tenant-bound operation');
      expect(() => container.resolve('BackgroundValidator')).toThrow('tenant-bound operation');
      expect(resolveFixed).not.toHaveBeenCalled();
    } finally { await container.dispose(); }
  });

  it('fences a previously installed static owner while preserving an actual per-instance manager reference', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-static-fence-'));
    const tenant = randomUUID();
    let root: ReturnType<typeof admittedMemoryContainer> | undefined;
    try {
      root = admittedMemoryContainer({} as DatabaseInstance, () => tenant, directory,
        () => deps => new MemoryManager({ ...deps, fileWatchService: undefined }));
      const manager = root.manager();
      const metadata = root.container.resolve<MetadataService>('MetadataService');
      const oldRoot = { list: jest.fn<() => Promise<Memory[]>>().mockResolvedValue([]),
        save: jest.fn<(memory: Memory, filePath?: string) => Promise<void>>().mockResolvedValue(undefined) };
      Memory.setRootMemoryManager(oldRoot);
      await expect(Memory.findByTrustLevel('untrusted')).resolves.toEqual([]);
      oldRoot.list.mockClear();
      const selected = new Memory({ name: 'Selected instance' }, metadata, manager);
      const save = jest.spyOn(manager, 'save').mockResolvedValue(undefined);
      Memory.refuseUnattributedAccess();
      await expect(Memory.findByTrustLevel('untrusted')).rejects.toThrow('Tenant-bound');
      await expect(new Memory({ name: 'Unowned instance' }, metadata).save()).rejects.toThrow('Tenant-bound');
      // Installing another ordinary root cannot reset the configured fence.
      Memory.setRootMemoryManager(oldRoot);
      await expect(Memory.findByTrustLevel('untrusted')).rejects.toThrow('Tenant-bound');
      await expect(selected.save()).resolves.toBeUndefined();
      expect(save).toHaveBeenCalledWith(selected, undefined);
      expect(oldRoot.list).not.toHaveBeenCalled();
      expect(oldRoot.save).not.toHaveBeenCalled();
    } finally {
      try { await root?.container.dispose(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
