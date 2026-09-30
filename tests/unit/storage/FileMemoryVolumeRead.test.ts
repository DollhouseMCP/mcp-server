import { describe, it as jestIt, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore, MAX_FILE_MEMORY_VOLUME_BYTES } from '../../../src/storage/FileMemoryVolumeStore.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const roots: string[] = [];
const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const USER = '11111111-1111-4111-8111-111111111111';
const input = { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-09-30T00:00:00Z') };
async function fixture(hook?: (phase: 'observed' | 'verified', location: string) => void | Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-read-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'ÜberNote.yaml'), input.rawContent);
  let fenceCalls = 0;
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER,
    fence: { withTenantFence: (tenant, callback) => { fenceCalls++; return fence.withTenantFence(tenant, callback); } } });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const legacy = await owners.readHeadSnapshot('ÜberNote.yaml');
  const token = await owners.adoptUnowned(legacy.token as UnownedFileMemoryToken);
  const store = new FileMemoryVolumeStore({ coordinator, owners, afterObservation: hook });
  return { root, token, store, owners, coordinator, calls: () => fenceCalls };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('dormant verified file archive observation', () => {
  it('reads committed unindexed bytes without acquiring a fence or changing any archive inode', async () => {
    const f = await fixture();
    const receipt = await f.store.createExclusive(f.token, { ...input, rawContent: 'entries:\n  - content: 中🙂\n', entryCount: 1 });
    const calls = f.calls();
    const location = path.join(f.root, 'volumes', 'by-id', f.token.ownerId, 'v1');
    const before = await fs.stat(location, { bigint: true });
    const result = await f.store.read(f.token, 1);
    expect(result).toMatchObject({ status: 'found', volume: 1, rawContent: 'entries:\n  - content: 中🙂\n', metadata: { generationId: receipt.generationId, entryCount: 1 } });
    expect(f.calls()).toBe(calls);
    const after = await fs.stat(location, { bigint: true });
    expect([after.ino, after.ctimeNs, after.mtimeNs]).toEqual([before.ino, before.ctimeNs, before.mtimeNs]);
    expect(result).not.toHaveProperty('operationId');
    expect(result).not.toHaveProperty('receipt');
  });
  it('proves absent without creating volumes or a tenant lock', async () => {
    const f = await fixture();
    const before = await fs.readdir(f.root);
    const calls = f.calls();
    expect(await f.store.read(f.token, 1)).toMatchObject({ status: 'absent', volume: 1 });
    expect(await fs.readdir(f.root)).toEqual(before);
    expect(f.calls()).toBe(calls);
  });
  it('reads empty volumes and absence in an existing owner namespace', async () => {
    const f = await fixture(); await f.store.createExclusive(f.token, input);
    expect(await f.store.read(f.token, 1)).toMatchObject({ status: 'found', rawContent: input.rawContent });
    expect(await f.store.read(f.token, 2)).toMatchObject({ status: 'absent' });
  });
  it.each(['observed', 'verified'] as const)('rejects marker ABA after %s without exposing bytes', async phase => {
    const f = await fixture(async (p, location) => {
      if (p !== phase) return;
      await fs.rename(path.join(location, 'COMMITTED'), path.join(f.root, 'held-marker'));
      await fs.mkdir(path.join(location, 'COMMITTED'), { mode: 0o700 });
    });
    await f.store.createExclusive(f.token, input);
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
  });
  it.each(['observed', 'verified'] as const)('rejects same-byte payload replacement after %s', async phase => {
    const f = await fixture(async (p, location) => {
      if (p !== phase) return;
      const [generation] = (await fs.readdir(location)).filter(name => name.startsWith('g-'));
      const payload = path.join(location, generation, 'payload.yaml');
      await fs.rename(payload, path.join(f.root, 'held-payload'));
      await fs.writeFile(payload, input.rawContent, { mode: 0o600 });
    });
    await f.store.createExclusive(f.token, input);
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
  });
  it.each(['observed', 'verified'].flatMap(phase => ['owner', 'by-id', 'volumes', 'root'].map(ancestor => [phase, ancestor])))('rejects %s ancestor substitution at %s', async (phase, ancestor) => {
    const f = await fixture(async (p, location) => {
      if (p !== phase) return;
      const owner = path.dirname(location);
      const target = ancestor === 'root' ? f.root : ancestor === 'volumes' ? path.join(f.root, 'volumes') : ancestor === 'by-id' ? path.dirname(owner) : owner;
      await fs.rename(target, `${target}-held`);
      if (ancestor === 'root') roots.push(`${target}-held`);
      await fs.symlink(`${target}-held`, target);
    });
    await f.store.createExclusive(f.token, input);
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
  });
  it('does not report absent when a missing namespace appears during observation', async () => {
    const f = await fixture(async () => { await fs.mkdir(path.join(f.root, 'volumes'), { mode: 0o700 }); });
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
  });
  it('denies stale and cross-user owner tokens before archive observation', async () => {
    const f = await fixture();
    await expect(f.store.read({ ...f.token, userId: 'other' }, 1)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    await fs.writeFile(path.join(f.root, f.token.locator), 'entries: []\n# changed\n');
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });
  it('rejects owner head change after observation', async () => {
    const f = await fixture(async () => { await fs.writeFile(path.join(f.root, f.token.locator), 'entries: []\n# changed\n'); });
    await f.store.createExclusive(f.token, input);
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });
  it('rejects partial slots and oversized payload before allocating content', async () => {
    const f = await fixture(); const receipt = await f.store.createExclusive(f.token, input);
    const location = path.join(f.root, 'volumes', 'by-id', f.token.ownerId, 'v1');
    await fs.truncate(path.join(location, `g-${receipt.generationId}`, 'payload.yaml'), MAX_FILE_MEMORY_VOLUME_BYTES + 1);
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
    await fs.mkdir(path.join(path.dirname(location), 'v2'), { mode: 0o700 });
    await expect(f.store.read(f.token, 2)).rejects.toHaveProperty('code');
  });
  it('rejects forged and expired operations; composes a valid operation without nested perform', async () => {
    const f = await fixture(); await f.store.createExclusive(f.token, input);
    expect(() => f.store.readAtScope({ tenantRoot: f.root, userId: USER } as never, f.token, 1)).toThrow();
    let expired: Parameters<FileMemoryVolumeStore['readAtScope']>[0] | undefined;
    await f.coordinator.withTenantTransaction(lease => f.coordinator.perform(lease, async scope => {
      expired = scope; expect(await f.store.readAtScope(scope, f.token, 1)).toMatchObject({ status: 'found' });
    }));
    expect(() => f.store.readAtScope(expired!, f.token, 1)).toThrow();
  });
  it.each(['hash', 'count', 'date', 'utf8', 'yaml', 'codeunits', 'metadata-size', 'hardlink', 'symlink'] as const)(
    'refuses corrupt or unsafe %s evidence', async kind => {
      const f = await fixture(); const receipt = await f.store.createExclusive(f.token, input);
      const generation = path.join(f.root, 'volumes', 'by-id', f.token.ownerId, 'v1', `g-${receipt.generationId}`);
      const payload = path.join(generation, 'payload.yaml');
      const metaPath = path.join(generation, 'metadata.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      if (kind === 'hash') meta.sha256 = '0'.repeat(64);
      if (kind === 'count') meta.entryCount = 1;
      if (kind === 'date') meta.sealedAt = null;
      if (kind === 'utf8' || kind === 'yaml' || kind === 'codeunits') {
        const bytes = kind === 'utf8' ? Buffer.from([0xff]) : Buffer.from(kind === 'codeunits' ? ' '.repeat(262145) : 'entries: [');
        await fs.writeFile(payload, bytes); meta.byteLength = bytes.length;
        meta.sha256 = createHash('sha256').update(bytes).digest('hex');
      }
      if (kind === 'hardlink') await fs.link(payload, path.join(f.root, 'payload-alias'));
      if (kind === 'symlink') { await fs.rename(payload, path.join(f.root, 'held-payload')); await fs.symlink(path.join(f.root, 'held-payload'), payload); }
      await fs.writeFile(metaPath, kind === 'metadata-size' ? ' '.repeat(4097) : JSON.stringify(meta));
      await expect(f.store.read(f.token, 1)).rejects.toHaveProperty('code');
    });
  it.each(['observed', 'verified'] as const)('refuses numerical aliases introduced after %s', async phase => {
    const f = await fixture(async (p, location) => { if (p === phase) await fs.mkdir(path.join(path.dirname(location), 'v01'), { mode: 0o700 }); });
    await f.store.createExclusive(f.token, input);
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
  });
  it.each(['RESERVED', 'DELETING', 'journal'] as const)('refuses %s owner evidence without modifying it', async state => {
    const f = await fixture(); await f.store.createExclusive(f.token, input);
    const sidecar = (await fs.readdir(f.root)).find(name => name.endsWith('.memory-owner.json'))!;
    if (state === 'journal') await fs.writeFile(path.join(f.root, sidecar.replace('.memory-owner.json', '.memory-write.json')), '{broken', { mode: 0o600 });
    else {
      const record = JSON.parse(await fs.readFile(path.join(f.root, sidecar), 'utf8'));
      record.state = state; await fs.writeFile(path.join(f.root, sidecar), JSON.stringify(record));
    }
    const before = await fs.readdir(f.root);
    await expect(f.store.read(f.token, 1)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await fs.readdir(f.root)).toEqual(before);
  });
  it.each(['payload.yaml', 'metadata.json'])('bounds FIFO %s in a subprocess without hanging the parent', async filename => {
    const f = await fixture(); const receipt = await f.store.createExclusive(f.token, input);
    const payload = path.join(f.root, 'volumes', 'by-id', f.token.ownerId, 'v1', `g-${receipt.generationId}`, filename);
    await fs.unlink(payload);
    await new Promise<void>((resolve, reject) => execFile('mkfifo', ['-m', '600', payload], cause => cause ? reject(cause) : resolve()));
    const moduleRoot = fileURLToPath(new URL('../../../src/storage/', import.meta.url));
    const script = `
      const {FileMemoryVolumeStore}=await import(process.argv[1]+'/FileMemoryVolumeStore.${extension}');
      const {FileMemoryOwnerSnapshots}=await import(process.argv[1]+'/FileMemoryOwnerSnapshots.${extension}');
      const {FileMemoryTransactionCoordinator}=await import(process.argv[1]+'/FileMemoryTransactionCoordinator.${extension}');
      const token=JSON.parse(process.argv[2]);
      const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:token.tenantRoot,getCurrentUserId:()=>token.userId,fence:{withTenantFence(){throw Error('unexpected fence')}}});
      try {await new FileMemoryVolumeStore({coordinator,owners:new FileMemoryOwnerSnapshots({coordinator})}).read(token,1);process.exit(2)}
      catch(error){if(error.code!=='EARCHIVEUNSAFE')throw error;console.log(error.code)}
    `;
    const stdout = await new Promise<string>((resolve, reject) => execFile(process.execPath,
      [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', script, moduleRoot, JSON.stringify(f.token)],
      { timeout: 5000 }, (cause, output) => cause ? reject(cause) : resolve(output)));
    expect(stdout.trim()).toBe('EARCHIVEUNSAFE');
  }, 10000);

  it('drains an accepted transaction read when the outer callback omits await', async () => {
    let observed = false;
    const f = await fixture(async () => { observed = true; });
    await f.store.createExclusive(f.token, input);
    let result: ReturnType<FileMemoryVolumeStore['readInTransaction']> | undefined;
    await f.coordinator.withTenantTransaction(lease => { result = f.store.readInTransaction(lease, f.token, 1); });
    expect(observed).toBe(true);
    expect(await result).toMatchObject({ status: 'found' });
  });
  it('refuses operation capability issued by another coordinator', async () => {
    const f = await fixture(); const other = await fixture();
    await other.coordinator.withTenantTransaction(lease => other.coordinator.perform(lease, scope => {
      expect(() => f.store.readAtScope(scope, f.token, 1)).toThrow('Active file-memory operation authority');
    }));
  });

});
