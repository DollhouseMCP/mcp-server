import { afterEach, describe, expect, it as test, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';

const it = process.platform === 'win32' || !process.getuid ? test.skip : test;
const roots: string[] = [];
const USER = '11111111-1111-4111-8111-111111111111';
const input = { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01T00:00:00Z') };
async function fixture(hook?: (phase: 'observed' | 'verified', location: string) => void | Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-list-')));
  roots.push(root);
  await fs.writeFile(path.join(root, 'head.yaml'), input.rawContent);
  let fences = 0;
  let user = USER;
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => user,
    fence: { withTenantFence: (tenant, callback) => { fences++; return fence.withTenantFence(tenant, callback); } } });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const head = await owners.readHeadSnapshot('head.yaml');
  const token = await owners.adoptUnowned(head.token as UnownedFileMemoryToken);
  const store = new FileMemoryVolumeStore({ coordinator, owners, afterObservation: hook });
  const ownerRoot = path.join(root, 'volumes', 'by-id', token.ownerId);
  return { root, ownerRoot, token, owners, store, coordinator, fences: () => fences, changeUser: () => { user = randomUUID(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function archive(f: Fixture, volume = 1) {
  const receipt = await f.store.createExclusive(f.token, { ...input, minimumVolume: volume });
  const slot = path.join(f.ownerRoot, `v${receipt.volume}`);
  const generation = path.join(slot, `g-${receipt.generationId}`);
  return { slot, generation, marker: path.join(slot, 'COMMITTED'), meta: path.join(generation, 'metadata.json'), payload: path.join(generation, 'payload.yaml') };
}
async function proof(root: string): Promise<unknown> {
  const stat = await fs.lstat(root, { bigint: true });
  return { inode: stat.ino, device: stat.dev, ctime: stat.ctimeNs, mtime: stat.mtimeNs,
    mode: stat.mode, links: stat.nlink,
    children: stat.isDirectory() ? await Promise.all((await fs.readdir(root)).sort().map(async name => [name, await proof(path.join(root, name))])) : undefined,
    bytes: stat.isFile() ? await fs.readFile(root) : stat.isSymbolicLink() ? await fs.readlink(root) : undefined };
}
async function listInChild(f: Fixture): Promise<string> {
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const source = new URL('../../../src/storage/', import.meta.url);
  const script = path.join(f.root, 'payload-tripwire.mjs');
  const input = path.join(f.root, 'payload-tripwire.json');
  await fs.writeFile(input, JSON.stringify({ root: f.root, user: USER, token: f.token, source: source.href, extension }));
  await fs.writeFile(script, `
    import nativeFs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const input = JSON.parse(await nativeFs.readFile(process.argv[2], 'utf8'));
    const load = name => import(new URL(name + '.' + input.extension, input.source));
    const { FileMemoryOwnerSnapshots } = await load('FileMemoryOwnerSnapshots');
    const { FileMemoryTransactionCoordinator } = await load('FileMemoryTransactionCoordinator');
    const { FileMemoryFence } = await load('FileMemoryFence');
    const { FileMemoryVolumeStore } = await load('FileMemoryVolumeStore');
    let payloadOpens = 0;
    const originalOpen = nativeFs.open;
    nativeFs.open = function(file, ...arguments_) {
      if (String(file).endsWith('/payload.yaml')) { payloadOpens++; throw new Error('ARCHIVED_PAYLOAD_OPEN'); }
      return originalOpen.call(this, file, ...arguments_);
    };
    syncBuiltinESMExports();
    if ((await import('node:fs/promises')).open !== nativeFs.open) throw new Error('Payload tripwire was not linked');
    const coordinator = new FileMemoryTransactionCoordinator({tenantRoot:input.root,getCurrentUserId:()=>input.user,fence:new FileMemoryFence()});
    const owners = new FileMemoryOwnerSnapshots({coordinator});
    const result = await new FileMemoryVolumeStore({coordinator,owners}).list(input.token);
    console.log(JSON.stringify({complete:result.complete,volumes:result.entries.map(entry=>entry.volume),payloadOpens}));
  `);
  return execFileSync(process.execPath, [...(extension === 'ts' ? ['--import', 'tsx'] : []), script, input],
    { timeout: 8000, encoding: 'utf8', maxBuffer: 16384 });
}
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('bounded dormant file archive metadata observations', () => {
  it('proves missing empty without a fence or any filesystem mutation', async () => {
    const f = await fixture(); const before = await proof(f.root); const fences = f.fences();
    const result = await f.store.list(f.token);
    expect(result).toMatchObject({ entries: [], complete: true, totalCount: 0, observedCount: 0, acceptedCount: 0 });
    expect(result.scannedCount).toBeGreaterThan(0);
    expect(await proof(f.root)).toEqual(before); expect(f.fences()).toBe(fences);
  });
  it('returns immutable numerically ordered declarations and truthful entry truncation', async () => {
    const f = await fixture(); await archive(f, 10); await archive(f, 2);
    const before = await proof(f.root); const fences = f.fences();
    const full = await f.store.list(f.token);
    expect(full.entries.map(value => value.volume)).toEqual([2, 10]);
    expect(full).toMatchObject({ complete: true, totalCount: 2, observedCount: 2, acceptedCount: 2, returnedCount: 2 });
    expect(full.entries[0]).not.toHaveProperty('rawContent'); expect(full.entries[0]).not.toHaveProperty('operationId');
    expect(Object.isFrozen(full.entries[0])).toBe(true);
    const limited = await f.store.list(f.token, { entryLimit: 1 });
    expect(limited).toMatchObject({ complete: false, totalCount: null, acceptedCount: 2, returnedCount: 1 });
    expect(limited.entries[0].volume).toBe(2); expect(limited.diagnostics[0].reason).toBe('entry-limit');
    expect(await proof(f.root)).toEqual(before); expect(f.fences()).toBe(fences);
  });
  it('never verifies or exposes archived payload bytes', async () => {
    const f = await fixture(); const a = await archive(f);
    await fs.writeFile(a.payload, 'corrupt archived payload');
    expect((await f.store.list(f.token)).entries[0]).toMatchObject({ volume: 1, entryCount: 0 });
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
  });
  it.each(['v01', 'V1', 'v0001'])('suppresses all affected declarations for alias %s', async alias => {
    const f = await fixture(); await archive(f); await archive(f, 2);
    if (alias === 'V1') await fs.rename(path.join(f.ownerRoot, 'v1'), path.join(f.ownerRoot, alias));
    else await fs.mkdir(path.join(f.ownerRoot, alias), { mode: 0o700 });
    const before = await proof(f.root); const result = await f.store.list(f.token);
    expect(result.entries.map(value => value.volume)).toEqual([2]);
    expect(result).toMatchObject({ complete: false, totalCount: null, observedCount: alias === 'V1' ? 2 : 3 });
    expect(result.diagnostics.some(value => value.reason === 'alias')).toBe(true); expect(await proof(f.root)).toEqual(before);
  });
  it.each(['observed', 'verified'] as const)('rejects concurrent child addition at %s despite stable owner-directory inode', async phase => {
    let before: bigint;
    const f = await fixture(async current => {
      if (current !== phase) return;
      before = (await fs.lstat(f.ownerRoot, { bigint: true })).ino;
      await fs.mkdir(path.join(f.ownerRoot, 'v3'), { mode: 0o700 });
      expect((await fs.lstat(f.ownerRoot, { bigint: true })).ino).toBe(before);
    });
    await archive(f); await expect(f.store.list(f.token)).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
  });
  it.each(['observed', 'verified'] as const)('rejects marker and metadata same-byte ABA at %s', async phase => {
    for (const target of ['marker', 'meta'] as const) {
      let a: Awaited<ReturnType<typeof archive>>;
      let changed: unknown;
      let callsAtChange = -1;
      const declarations = jest.spyOn(FileMemoryVolumeStore.prototype as unknown as { listDeclaration: (...args: unknown[]) => Promise<unknown> }, 'listDeclaration');
      const f = await fixture(async current => {
        if (current !== phase) return;
        const file = a[target]; const held = path.join(f.root, `held-${target}`);
        await fs.rename(file, held);
        if (target === 'marker') await fs.mkdir(file, { mode: 0o700 });
        else await fs.writeFile(file, await fs.readFile(held), { mode: 0o600 });
        changed = await proof(f.root); callsAtChange = declarations.mock.calls.length;
      });
      a = await archive(f); await expect(f.store.list(f.token)).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
      expect(callsAtChange).toBeGreaterThan(0); expect(declarations.mock.calls).toHaveLength(callsAtChange);
      expect(await proof(f.root)).toEqual(changed);
    }
  });
  it('refuses resource exhaustion rather than trusting a first-N owner namespace', async () => {
    const f = await fixture(); await archive(f);
    await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.mkdir(path.join(f.ownerRoot, `unknown-${i}`), { mode: 0o700 })));
    const before = await proof(f.root);
    await expect(f.store.list(f.token)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(await proof(f.root)).toEqual(before);
  });
  it('preserves partial, corrupt and invalid-number slots as incomplete evidence', async () => {
    const f = await fixture(); const a = await archive(f);
    await fs.writeFile(a.meta, '{}', { mode: 0o600 });
    await fs.mkdir(path.join(f.ownerRoot, 'v2'), { mode: 0o700 });
    await fs.mkdir(path.join(f.ownerRoot, 'v0'), { mode: 0o700 });
    const before = await proof(f.root); const result = await f.store.list(f.token);
    expect(result).toMatchObject({ entries: [], complete: false, totalCount: null, observedCount: 3 });
    expect(result.diagnostics.length).toBeGreaterThan(1); expect(await proof(f.root)).toEqual(before);
  });
  it('composes under one tracked operation and refuses expired authority', async () => {
    const f = await fixture(); await archive(f); const perform = jest.spyOn(f.coordinator, 'perform');
    await f.coordinator.withTenantTransaction(context => f.store.listInTransaction(context, f.token));
    expect(perform).toHaveBeenCalledTimes(1);
    let expired: Parameters<FileMemoryVolumeStore['listAtScope']>[0];
    await f.coordinator.withTenantTransaction(context => f.coordinator.perform(context, async operation => {
      expired = operation; expect((await f.store.listAtScope(operation, f.token)).complete).toBe(true);
    }));
    expect(() => f.store.listAtScope(expired!, f.token)).toThrow('Active file-memory operation');
  });
  it('never opens a FIFO archived payload in a bounded subprocess', async () => {
    const f = await fixture(); const a = await archive(f);
    await fs.unlink(a.payload); execFileSync('mkfifo', [a.payload]);
    const output = await listInChild(f);
    expect(output).toContain('"complete":true,"volumes":[1]');
    expect(output).toContain('"payloadOpens":0');
    expect((await fs.lstat(a.payload)).isFIFO()).toBe(true);
  });
  it('rejects FIFO metadata without blocking or deleting it', async () => {
    const f = await fixture(); const a = await archive(f);
    await fs.rename(a.meta, path.join(f.root, 'held-meta')); execFileSync('mkfifo', [a.meta]); await fs.chmod(a.meta, 0o600);
    const output = await listInChild(f);
    expect(output).toContain('"complete":false,"volumes":[]'); expect(output).toContain('"payloadOpens":0');
    expect((await fs.lstat(a.meta)).isFIFO()).toBe(true);
  });
  it.each(['public', 'symlink', 'hardlink', 'oversize', 'invalid-utf8'] as const)(
    'preserves unsafe metadata descriptor %s and returns incomplete', async kind => {
      const f = await fixture(); const a = await archive(f);
      if (kind === 'public') await fs.chmod(a.meta, 0o644);
      else if (kind === 'hardlink') await fs.link(a.meta, path.join(f.root, 'held-meta'));
      else if (kind === 'symlink') { await fs.rename(a.meta, path.join(f.root, 'held-meta')); await fs.symlink(path.join(f.root, 'held-meta'), a.meta); }
      else await fs.writeFile(a.meta, kind === 'oversize' ? Buffer.alloc(4097) : Buffer.from([0xff]));
      const before = await proof(f.root); const result = await f.store.list(f.token);
      expect(result).toMatchObject({ complete: false, entries: [], totalCount: null });
      expect(await proof(f.root)).toEqual(before);
    });
  it.each([
    ['ownerId', '22222222-2222-4222-8222-222222222222'], ['userId', randomUUID()], ['volume', '1'],
    ['generationId', randomUUID()], ['entryCount', -1], ['entryCount', 2147483648], ['byteLength', '1'],
    ['sha256', 'not-a-digest'], ['sealedAt', 0], ['sealedAt', null], ['firstEntryAt', 'not-a-date'],
  ])('rejects malformed declaration %s=%s without reading payload', async (key, value) => {
    const f = await fixture(); const a = await archive(f); const declaration = JSON.parse(await fs.readFile(a.meta, 'utf8'));
    declaration[String(key)] = value; await fs.writeFile(a.meta, JSON.stringify(declaration), { mode: 0o600 });
    const before = await proof(f.root); const result = await f.store.list(f.token);
    expect(result).toMatchObject({ complete: false, entries: [], totalCount: null }); expect(await proof(f.root)).toEqual(before);
  });
  it('bounds and sanitizes diagnostics without making truncated diagnostics complete', async () => {
    const f = await fixture(); await archive(f);
    await Promise.all(Array.from({ length: 70 }, (_, index) => fs.mkdir(path.join(f.ownerRoot, `v${index + 2}`), { mode: 0o700 })));
    const result = await f.store.list(f.token);
    expect(result).toMatchObject({ complete: false, totalCount: null, diagnosticsTruncated: true, observedCount: 71 });
    expect(result.diagnostics).toHaveLength(64);
    expect(result.diagnostics.every(value => value.message.length <= 128 && !value.message.includes(f.root))).toBe(true);
  });
  it.each(['observed', 'verified'] as const)('rejects owner change and newly pending evidence at %s', async phase => {
    for (const change of ['head', 'journal'] as const) {
      const f = await fixture(async current => {
        if (current !== phase) return;
        if (change === 'head') await fs.writeFile(path.join(f.root, 'head.yaml'), 'entries: []\n# externally edited\n');
        else {
          const sidecar = (await fs.readdir(f.root)).find(name => name.endsWith('.memory-owner.json'))!;
          await fs.writeFile(path.join(f.root, sidecar.replace('.memory-owner.json', '.memory-write.json')), '{}', { mode: 0o600 });
        }
      });
      await archive(f); await expect(f.store.list(f.token)).rejects.toBeDefined();
    }
  });
  it.each(['observed', 'verified'] as const)('rejects ancestor symlink substitution after %s', async phase => {
    let changed: unknown; let callsAtChange = -1;
    const declarations = jest.spyOn(FileMemoryVolumeStore.prototype as unknown as { listDeclaration: (...args: unknown[]) => Promise<unknown> }, 'listDeclaration');
    const f = await fixture(async current => {
      if (current !== phase) return;
      const held = path.join(f.root, 'held-owner'); await fs.rename(f.ownerRoot, held); await fs.symlink(held, f.ownerRoot);
      changed = await proof(f.root); callsAtChange = declarations.mock.calls.length;
    });
    await archive(f); await expect(f.store.list(f.token)).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
    expect(callsAtChange).toBeGreaterThan(0); expect(declarations.mock.calls).toHaveLength(callsAtChange);
    expect(await proof(f.root)).toEqual(changed);
  });
  it('captures user, token and entry limit before awaiting the observation', async () => {
    const f = await fixture(); await archive(f); await archive(f, 2);
    const options = { entryLimit: 1 }; const mutable = { ...f.token, fileIdentity: { ...f.token.fileIdentity } };
    const pending = f.store.list(mutable, options);
    options.entryLimit = 2; mutable.ownerId = randomUUID(); mutable.fileIdentity.inode = '0'; f.changeUser();
    expect(await pending).toMatchObject({ returnedCount: 1, complete: false, totalCount: null });
    await expect(f.store.list(f.token)).rejects.toBeDefined();
  });
  it.each(['observed', 'verified'] as const)('never treats newly appeared missing namespace as empty after %s', async phase => {
    const f = await fixture(async current => { if (current === phase) await fs.mkdir(path.join(f.root, 'volumes'), { mode: 0o700 }); });
    await expect(f.store.list(f.token)).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
  });
  it.each(['observed', 'verified'] as const)('rejects fixed-component case-only rename at %s', async phase => {
    const f = await fixture(async current => { if (current === phase) await fs.rename(path.join(f.root, 'volumes'), path.join(f.root, 'Volumes')); });
    await archive(f); await expect(f.store.list(f.token)).rejects.toBeDefined();
  });
  it.each(['observed', 'verified'] as const)('rejects missing-namespace case alias at %s', async phase => {
    let changed: unknown; let mutated = false;
    const declarations = jest.spyOn(FileMemoryVolumeStore.prototype as unknown as { listDeclaration: (...args: unknown[]) => Promise<unknown> }, 'listDeclaration');
    const f = await fixture(async current => {
      if (current === phase) { await fs.mkdir(path.join(f.root, 'Volumes'), { mode: 0o700 }); mutated = true; changed = await proof(f.root); }
    });
    await expect(f.store.list(f.token)).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
    expect(mutated).toBe(true); expect(declarations).not.toHaveBeenCalled(); expect(await proof(f.root)).toEqual(changed);
  });
  it('shares the hard attempt budget through both proof rounds and can refuse below the return cap', async () => {
    const phases: string[] = []; const f = await fixture(phase => { phases.push(phase); }); const original = await archive(f);
    const metadata = JSON.parse(await fs.readFile(original.meta, 'utf8'));
    await Promise.all(Array.from({ length: 39 }, async (_, index) => {
      const volume = index + 2; const generationId = randomUUID(); const slot = path.join(f.ownerRoot, `v${volume}`);
      const generation = path.join(slot, `g-${generationId}`);
      await fs.mkdir(generation, { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(slot, 'COMMITTED'), { mode: 0o700 });
      await fs.writeFile(path.join(generation, 'payload.yaml'), input.rawContent, { mode: 0o600 });
      await fs.writeFile(path.join(generation, 'metadata.json'), JSON.stringify({ ...metadata, volume, generationId }), { mode: 0o600 });
    }));
    const before = await proof(f.root);
    await expect(f.store.list(f.token)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(phases).toEqual(['observed', 'verified']); expect(await proof(f.root)).toEqual(before);
  });
  it('validates extended-year chronological declarations numerically', async () => {
    const f = await fixture(); const a = await archive(f); const metadata = JSON.parse(await fs.readFile(a.meta, 'utf8'));
    metadata.firstEntryAt = '9999-01-01T00:00:00.000Z'; metadata.lastEntryAt = '+010000-01-01T00:00:00.000Z';
    await fs.writeFile(a.meta, JSON.stringify(metadata)); expect((await f.store.list(f.token)).complete).toBe(true);
    [metadata.firstEntryAt, metadata.lastEntryAt] = [metadata.lastEntryAt, metadata.firstEntryAt];
    await fs.writeFile(a.meta, JSON.stringify(metadata)); expect(await f.store.list(f.token)).toMatchObject({ complete: false, entries: [], totalCount: null });
  });
  it('rechecks ACTIVE authority after the last awaited child-set proof', async () => {
    const f = await fixture(); await archive(f); let revoked = false; let censuses = 0;
    const originalAuthority = f.coordinator.requireActiveOperationScope.bind(f.coordinator);
    jest.spyOn(f.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
      if (revoked) throw Object.assign(new Error('operation revoked after final census'), { code: 'EINVALIDOPERATION' });
      return originalAuthority(operation);
    });
    const internals = f.store as unknown as { proveListCensus(...args: unknown[]): Promise<void> };
    const originalCensus = internals.proveListCensus.bind(f.store);
    jest.spyOn(internals, 'proveListCensus').mockImplementation(async (...args) => {
      await originalCensus(...args); if (++censuses === 4) revoked = true;
    });
    await expect(f.coordinator.withTenantTransaction(context => f.store.listInTransaction(context, f.token)))
      .rejects.toMatchObject({ code: 'EINVALIDOPERATION' });
    expect(censuses).toBe(4);
  });
  it.each(['observed', 'verified'] as const)('refuses nonthrowing hook revocation at %s', async phase => {
    let revoked = false; const f = await fixture(current => { if (current === phase) revoked = true; }); await archive(f);
    const original = f.coordinator.requireActiveOperationScope.bind(f.coordinator);
    jest.spyOn(f.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
      if (revoked) throw Object.assign(new Error('hook revoked operation'), { code: 'EINVALIDOPERATION' });
      return original(operation);
    });
    await expect(f.coordinator.withTenantTransaction(context => f.store.listInTransaction(context, f.token)))
      .rejects.toMatchObject({ code: 'EINVALIDOPERATION' });
  });
  it('rejects generation UUID array coercion instead of returning a mutable non-string declaration', async () => {
    const f = await fixture(); const a = await archive(f); const metadata = JSON.parse(await fs.readFile(a.meta, 'utf8'));
    metadata.generationId = [metadata.generationId]; await fs.writeFile(a.meta, JSON.stringify(metadata));
    const before = await proof(f.root);
    expect(await f.store.list(f.token)).toMatchObject({ complete: false, entries: [], totalCount: null });
    expect(await proof(f.root)).toEqual(before);
  });
  it.each([0, -1, 129, 1.5, NaN])('rejects invalid entry limit %s before an observation', async entryLimit => {
    const f = await fixture(); expect(() => f.store.list(f.token, { entryLimit })).toThrow(RangeError);
  });
});
