import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { createRealMemoryManager, createTestFileOperationsService } from '../../helpers/di-mocks.js';
import { logger } from '../../../src/utils/logger.js';

function barrier() {
  let release!: () => void; let entered!: () => void;
  return { blocked: new Promise<void>(resolve => { release = resolve; }),
    started: new Promise<void>(resolve => { entered = resolve; }),
    release: () => release(), entered: () => entered() };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'memory-shutdown-'));
  const dir = path.join(root, 'memories'); await fs.mkdir(dir);
  const file = path.join(dir, 'a.yaml');
  await fs.writeFile(file, 'name: Old\ndescription: Useful memory description\nentries: []');
  const manager = createRealMemoryManager(root, { fileOperationsService: createTestFileOperationsService() });
  const layer = manager['storageLayer'] as MemoryStorageLayer;
  await layer.scan(); const state = layer['getState'](); await state.persistence.flush();
  await fs.writeFile(file, 'name: New\ndescription: Updated memory description\nentries: []');
  await layer.notifySaved('a.yaml', file);
  return { root, manager, layer, state, index: path.join(dir, '_index.json') };
}

it.each(['manager', 'container'])('%s disposal waits for its pending memory index snapshot', async mode => {
  const f = await fixture(); const gate = barrier(); const container = new DollhouseContainer();
  const write = f.state.persistence['file'].write.bind(f.state.persistence['file']);
  const spy = jest.spyOn(f.state.persistence['file'], 'write').mockImplementationOnce(async (...args) => {
    gate.entered(); await gate.blocked; await write(...args);
  });
  try {
    container.register('MemoryManager', () => f.manager, { override: true });
    container.resolve('MemoryManager');
    let finished = false;
    const disposal = (mode === 'container' ? container.dispose() : f.manager.dispose()).then(() => { finished = true; });
    await gate.started; expect(finished).toBe(false);
    gate.release(); await disposal;
    expect(JSON.parse(await fs.readFile(f.index, 'utf8')).entries['a.yaml'].name).toBe('New');
    expect(f.state.persistence.hasPendingWrite()).toBe(false);
  } finally {
    gate.release(); spy.mockRestore(); await container.dispose(); await fs.rm(f.root, { recursive: true, force: true });
  }
});

it('keeps retries across clearCache, then bounds disposal and cancels failed retry timers', async () => {
  const f = await fixture(); jest.useFakeTimers();
  const write = jest.spyOn(f.state.persistence['file'], 'write').mockRejectedValue(new Error('disk full'));
  const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    f.manager.clearCache();
    expect(await f.state.persistence.flush()).toBe(false);
    expect(f.state.persistence.hasPendingWrite()).toBe(true);
    expect(f.state.table.hasUnsavedChanges()).toBe(false);
    await f.manager.dispose();
    expect(f.state.persistence.hasPendingWrite()).toBe(false);
    expect(f.state.persistence['timer']).toBeNull();
    const attempts = write.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60000);
    expect(write).toHaveBeenCalledTimes(attempts);
    expect(log).toHaveBeenCalledWith('MemoryStorageLayer: index persistence flush failed');
  } finally {
    write.mockRestore(); log.mockRestore(); jest.useRealTimers();
    await f.manager.dispose(); await fs.rm(f.root, { recursive: true, force: true });
  }
});
