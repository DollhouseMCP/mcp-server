import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IStorageLayer } from '../../../src/storage/IStorageLayer.js';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import type { ElementCrudContext } from '../../../src/handlers/element-crud/types.js';
import { editElement } from '../../../src/handlers/element-crud/editElement.js';
import { upgradeElement } from '../../../src/handlers/element-crud/upgradeElement.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';

const owned: { directory: string; dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of owned.splice(0)) {
    try { await f.dispose(); } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});
async function fixture(admitted = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-composition-'));
  const transaction = jest.fn(async () => { throw new Error('No database operation expected'); });
  const db = { transaction } as unknown as DatabaseInstance;
  const getUser = () => tenant;
  const tenant = randomUUID();
  let deps: ElementManagerDeps | undefined;
  const root = admittedMemoryContainer(db, getUser, directory, factory => incoming => {
    deps = incoming; return factory.createAdmittedMemoryManager(incoming);
  }, admitted);
  owned.push({ directory, dispose: () => root.container.dispose() });
  return { ...root, transaction, deps: () => deps! };
}
describe('normal registrar dormant admitted foreground composition', () => {
  it('uses the trusted provider and exactly one actual memory layer without construction-time database access', async () => {
    const f = await fixture(); const create = jest.spyOn(f.factory, 'createForElement');
    const manager = f.manager();
    expect(manager.isGuardedHeadUpdateEnabled()).toBe(true);
    expect(f.manager()).toBe(manager);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toBe('memories');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('preserves the ordinary database manager when the provider is absent', async () => {
    const f = await fixture(false);
    expect(f.manager().isGuardedHeadUpdateEnabled()).toBe(false);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(['factory', 'resolver'] as const)('rejects a different %s before layer creation or database access', async kind => {
    const f = await fixture(); f.manager();
    const create = jest.spyOn(f.factory, 'createForElement');
    const deps = { ...f.deps(), ...(kind === 'factory' ? { storageLayerFactory: { createForElement: f.factory.createForElement.bind(f.factory) } }
      : { getCurrentUserId: () => f.deps().getCurrentUserId!() }) };
    expect(() => f.factory.createAdmittedMemoryManager(deps)).toThrow('actual database factory and user resolver');
    expect(create).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
  });
  it('rejects a non-database virtual memory layer before database access', async () => {
    const f = await fixture(); f.manager();
    jest.spyOn(f.factory, 'createForElement').mockReturnValue({} as IStorageLayer);
    expect(() => f.factory.createAdmittedMemoryManager(f.deps())).toThrow(TypeError);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(['edit', 'upgrade', 'upgrade-preview'] as const)('refuses unsupported %s before initialization, discovery or mutation', async operation => {
    const f = await fixture(); const manager = f.manager();
    const ensureInitialized = jest.fn(async () => { throw new Error('Initialization must not run'); });
    const lookup = jest.spyOn(manager, 'findByName');
    const context = { memoryManager: manager, ensureInitialized } as unknown as ElementCrudContext;
    const result = operation === 'edit'
      ? await editElement(context, { name: 'owned', type: 'memory', input: { name: 'renamed' } })
      : await upgradeElement(context, { name: 'owned', type: 'memories', dry_run: operation === 'upgrade-preview' });
    expect(JSON.stringify(result)).toContain('Guarded memory');
    expect(ensureInitialized).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('refuses import, create and delete before parsing, discovery or storage access', async () => {
    const f = await fixture(); const manager = f.manager();
    const parse = jest.spyOn(JSON, 'parse'); const lookup = jest.spyOn(manager, 'findByName');
    await expect(manager.importElement('deliberately invalid JSON', 'json')).rejects.toThrow('UPDATE only');
    await expect(manager.create({ name: 'new', description: 'Unsupported create' })).rejects.toThrow('UPDATE only');
    await expect(manager.delete('owned')).rejects.toThrow('UPDATE only');
    expect(parse).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
  });
  it('keeps ordinary memory and non-memory initialization paths', async () => {
    const f = await fixture(false); const manager = f.manager();
    const cause = new Error('ordinary initialization reached');
    const ensureInitialized = jest.fn(async () => { throw cause; });
    const context = { memoryManager: manager, ensureInitialized } as unknown as ElementCrudContext;
    await expect(editElement(context, { name: 'ordinary', type: 'memory', input: {} })).rejects.toBe(cause);
    const g = await fixture();
    await expect(upgradeElement({ ...context, memoryManager: g.manager() }, { name: 'skill', type: 'skills' })).rejects.toBe(cause);
    expect(ensureInitialized).toHaveBeenCalledTimes(2);
  });
});
