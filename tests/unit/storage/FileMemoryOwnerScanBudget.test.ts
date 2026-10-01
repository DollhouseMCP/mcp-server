import { afterEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryDirectoryScanBudget } from '../../../src/storage/FileMemoryDirectoryScanBudget.js';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-owner-budget-')));
  roots.push(root);
  const locator = 'notes/owned.yaml';
  const head = path.join(root, locator);
  await fs.mkdir(path.dirname(head), { mode: 0o700 });
  await fs.writeFile(head, 'entries: []\n', { mode: 0o600 });
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const original = await owners.readHeadSnapshot(locator);
  const token = await owners.adoptUnowned(original.token as UnownedFileMemoryToken);
  const scope = await coordinator.captureReadScope();
  const sidecar = path.join(path.dirname(head), `.${createHash('sha256').update(path.basename(head)).digest('hex')}.memory-owner.json`);
  const registry = path.join(root, '.memory-owners', 'owners');
  return { root, head, sidecar, registry, owners, coordinator, token, scope };
}
async function evidence(files: readonly string[]) {
  return Promise.all(files.map(async file => {
    const stat = await fs.stat(file, { bigint: true });
    return { file, inode: stat.ino, ctime: stat.ctimeNs, mtime: stat.mtimeNs,
      bytes: stat.isFile() ? await fs.readFile(file) : undefined };
  }));
}
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('shared budget through real owned-head proofs', () => {
  it('charges both head scans and the owner registry without acquiring a fence or changing evidence', async () => {
    const f = await fixture();
    const before = await evidence([f.root, f.head, f.sidecar, f.registry]);
    const lease = jest.spyOn(f.coordinator, 'withTenantTransaction');
    const budget = new FileMemoryDirectoryScanBudget(8);
    expect(await f.owners.requireOwnedAtReadScope(f.scope, f.token, budget)).toEqual(f.token);
    // Two head entries + EOF, twice; one registry entry + EOF, once.
    expect(budget.consumed).toBe(8);
    expect(lease).not.toHaveBeenCalled();
    expect(await evidence([f.root, f.head, f.sidecar, f.registry])).toEqual(before);
  });
  it('fails rather than returning owner or absence proof when registry EOF cannot be established', async () => {
    const f = await fixture();
    const budget = new FileMemoryDirectoryScanBudget(7);
    await expect(f.owners.requireOwnedAtReadScope(f.scope, f.token, budget)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(budget.consumed).toBe(7);
    expect(await f.owners.requireOwnedAtReadScope(f.scope, f.token)).toEqual(f.token);
  });
  it('does not reset the budget for a repeated final proof', async () => {
    const f = await fixture();
    const budget = new FileMemoryDirectoryScanBudget(15);
    await f.owners.requireOwnedAtReadScope(f.scope, f.token, budget);
    await expect(f.owners.requireOwnedAtReadScope(f.scope, f.token, budget)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(budget.consumed).toBe(15);
  });
  it('shares the budget across tracked proofs without nesting perform', async () => {
    const f = await fixture();
    const budget = new FileMemoryDirectoryScanBudget(15);
    const perform = jest.spyOn(f.coordinator, 'perform');
    await f.coordinator.withTenantTransaction(context => f.coordinator.perform(context, async operation => {
      await f.owners.requireOwnedAtScope(operation, f.token, budget);
      await expect(f.owners.requireOwnedAtScope(operation, f.token, budget)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    }));
    expect(perform).toHaveBeenCalledTimes(1);
    expect(budget.consumed).toBe(15);
  });
  it('charges a genuine sidecar-stability retry against the same remaining budget', async () => {
    const f = await fixture();
    // Test-only barrier after an actual first sidecar descriptor read: make its
    // next read see equivalent JSON with different bytes, forcing the real retry.
    const reader = f.owners as unknown as { readRecord(file: string): Promise<{ raw: string } | undefined> };
    const originalRead = reader.readRecord.bind(f.owners);
    let changed = false;
    const read = jest.spyOn(reader, 'readRecord').mockImplementation(async file => {
      const result = await originalRead(file);
      if (file === f.sidecar && !changed) {
        changed = true;
        await fs.writeFile(f.sidecar, `${result!.raw}\n`, { mode: 0o600 });
      }
      return result;
    });
    const budget = new FileMemoryDirectoryScanBudget(15);
    await expect(f.owners.requireOwnedAtReadScope(f.scope, f.token, budget)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(changed).toBe(true);
    expect(read.mock.calls.filter(([file]) => file === f.sidecar)).toHaveLength(4);
    expect(budget.consumed).toBe(15);
    expect(await f.owners.requireOwnedAtReadScope(f.scope, f.token)).toEqual(f.token);
  });
  it('retains owner/artifact refusal and ordinary omitted-budget behavior', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 20 }, (_, index) => fs.writeFile(path.join(path.dirname(f.head), `unrelated-${index}`), 'safe')));
    await expect(f.owners.requireOwnedAtReadScope(f.scope, f.token, new FileMemoryDirectoryScanBudget(8))).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(await f.owners.requireOwnedAtReadScope(f.scope, f.token)).toEqual(f.token);
    const artifact = `${f.sidecar}.orphan`;
    await fs.writeFile(artifact, 'untrusted');
    await expect(f.owners.requireOwnedAtReadScope(f.scope, f.token, new FileMemoryDirectoryScanBudget())).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await expect(f.owners.requireOwnedAtReadScope(f.scope, f.token)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });
});
