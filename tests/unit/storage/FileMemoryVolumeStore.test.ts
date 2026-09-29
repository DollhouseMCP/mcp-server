import { afterEach, describe, expect, it as jestIt } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type OwnedFileMemoryToken, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore, retainCommittedFileArchives, type ArchivePublicationPhase, type CommittedFileArchiveError } from '../../../src/storage/FileMemoryVolumeStore.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const roots: string[] = [];
const USER = '11111111-1111-4111-8111-111111111111';
const input = { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-09-29T00:00:00Z') };
async function fixture(hook?: (phase: ArchivePublicationPhase, location: string) => Promise<void> | void, releaseFailure = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-publication-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'ÜberNote.yaml'), 'entries: []\n');
  let failRelease = false;
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER,
    fence: { withTenantFence: async (tenant, callback) => {
      const result = await fence.withTenantFence(tenant, callback, { timeoutMs: 100 });
      if (failRelease) throw new Error('release failure');
      return result;
    } } });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const snapshot = await owners.readHeadSnapshot('ÜberNote.yaml');
  const token = await owners.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
  failRelease = releaseFailure;
  const store = new FileMemoryVolumeStore({ coordinator, owners, afterPublication: hook });
  return { root, coordinator, owners, token, store, ownerPath: path.join(root, 'volumes', 'by-id', token.ownerId) };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('dormant file archive publication', () => {
  it('commits exact empty and multibyte bytes, advancing only verified committed collisions', async () => {
    const f = await fixture();
    const first = await f.store.createExclusive(f.token, input);
    const second = await f.store.createExclusive(f.token, { ...input, rawContent: 'entries:\n  - content: 中🙂\n', entryCount: 1 });
    expect(second.volume).toBe(2);
    const v = path.join(f.ownerPath, 'v2');
    const generation = path.join(v, `g-${second.generationId}`);
    expect(await fs.readFile(path.join(generation, 'payload.yaml'), 'utf8')).toBe('entries:\n  - content: 中🙂\n');
    expect(await fs.readdir(path.join(v, 'COMMITTED'))).toEqual([]);
    expect(String((await fs.stat(v, { bigint: true })).ino)).toBe(second.volumeIdentity.inode);
    expect(first.entryCount).toBe(0);
    expect((await fs.stat(generation)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(generation, 'payload.yaml'))).mode & 0o777).toBe(0o600);
  });
  it.each([
    { minimumVolume: 0 }, { minimumVolume: Number.MAX_SAFE_INTEGER + 1 }, { entryCount: -1 },
    { entryCount: 2_147_483_648 }, { entryCount: 1 }, { rawContent: 'entries: ["\ud800"]\n', entryCount: 1 },
    { sealedAt: new Date(NaN) }, { firstEntryAt: new Date('2026-09-30'), lastEntryAt: new Date('2026-09-29') },
    { rawContent: 'x'.repeat(262145) },
    { firstEntryAt: new Date('+010000-01-01T00:00:00.000Z'), lastEntryAt: new Date('9999-01-01T00:00:00.000Z') },
    { firstEntryAt: new Date('-000001-01-01T00:00:00.000Z'), lastEntryAt: new Date('-000002-01-01T00:00:00.000Z') },
  ])('rejects invalid captured input before archive artifacts: %p', async patch => {
    const f = await fixture();
    expect(() => f.store.createExclusive(f.token, { ...input, ...patch })).toThrow();
    await expect(fs.stat(path.join(f.root, 'volumes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires active same-flow authority and agreeing exact owner before archive I/O', async () => {
    const f = await fixture();
    await expect(f.store.createExclusiveAtScope({ tenantRoot: f.root, userId: USER } as never, f.token, input)).rejects.toMatchObject({ code: 'EINVALIDOPERATION' });
    await expect(f.store.createExclusive({ ...f.token, userId: 'another-user' }, input)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    await expect(fs.stat(path.join(f.root, 'volumes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('blocks a partial slot without silently allocating later numbers', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.ownerPath, 'v1'), { recursive: true, mode: 0o700 });
    await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEBLOCKED' });
    expect(await fs.readdir(f.ownerPath)).toEqual(['v1']);
  });
  it.each(['reserved-volume', 'reserved-generation', 'payload-written', 'metadata-written', 'verified-before-marker', 'before-marker'] as const)(
    'retains attributable uncommitted evidence after %s failure', async phase => {
      const f = await fixture(p => { if (p === phase) throw new Error('injected'); });
      await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNCOMMITTED', outcome: 'uncommitted' });
      const children = await fs.readdir(path.join(f.ownerPath, 'v1'));
      expect(children).not.toContain('COMMITTED');
      expect(children).toHaveLength(phase === 'reserved-volume' ? 0 : 1);
    });
  it.each(['committed-marker', 'verified-after-marker'] as const)('preserves receipt through %s failure', async phase => {
    const f = await fixture(p => { if (p === phase) throw new Error('injected'); });
    await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVECOMMITTED', committed: true, receipt: { volume: 1 } });
    expect(await fs.readdir(path.join(f.ownerPath, 'v1', 'COMMITTED'))).toEqual([]);
  });
  it('preserves standalone receipt through outer fence release failure', async () => {
    const f = await fixture(undefined, true);
    await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVECOMMITTED', receipt: { ownerId: f.token.ownerId } });
  });
  it('retains earlier committed receipt and later unknown cause through composed transaction failure', async () => {
    const f = await fixture();
    const later = Object.assign(new Error('later unknown'), { code: 'EHEADCOMMITUNKNOWN', residualPath: 'later-head' });
    let outcome: CommittedFileArchiveError | undefined;
    try {
      await retainCommittedFileArchives(retain => f.coordinator.withTenantTransaction(async lease => {
        retain(await f.store.createExclusiveInTransaction(lease, f.token, input));
        await f.coordinator.perform(lease, () => { throw later; });
      }));
    } catch (cause) { outcome = cause as CommittedFileArchiveError; }
    expect(outcome?.receipts).toHaveLength(1);
    expect(outcome?.cause).toBe(later);
    expect(outcome?.committed).toBe(true);
  });
  it.each(['payload.yaml', 'metadata.json'])('rejects identical-byte replacement of original writer inode: %s', async filename => {
    const f = await fixture(async (phase, v) => {
      if (phase !== 'metadata-written') return;
      const [g] = await fs.readdir(v);
      const p = path.join(v, g, filename);
      const bytes = await fs.readFile(p);
      await fs.rename(p, `${p}.old`);
      await fs.writeFile(p, bytes, { mode: 0o600 });
      await fs.unlink(`${p}.old`);
    });
    await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNCOMMITTED' });
    await expect(fs.stat(path.join(f.ownerPath, 'v1', 'COMMITTED'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects generation directory replacement despite same bytes', async () => {
    const f = await fixture(async (phase, v) => {
      if (phase !== 'verified-before-marker') return;
      const [g] = await fs.readdir(v);
      await fs.rename(path.join(v, g), path.join(v, `${g}-old`));
      await fs.mkdir(path.join(v, g), { mode: 0o700 });
    });
    await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNCOMMITTED' });
  });
  it('fails committed after marker when current payload becomes unsafe', async () => {
    const f = await fixture(async (phase, v) => {
      if (phase !== 'committed-marker') return;
      const g = (await fs.readdir(v)).find(name => name.startsWith('g-'))!;
      await fs.chmod(path.join(v, g, 'payload.yaml'), 0o644);
    });
    await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ committed: true, code: 'EARCHIVECOMMITTED' });
  });
  it('rejects symbolic namespace aliases without writing outside captured tenant', async () => {
    const f = await fixture();
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-outside-'));
    roots.push(target);
    await fs.symlink(target, path.join(f.root, 'volumes'));
    await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
    expect(await fs.readdir(target)).toEqual([]);
  });
  it('does not nest perform when used in one caller-owned operation', async () => {
    const f = await fixture();
    const receipt = await f.coordinator.withTenantTransaction(lease => f.coordinator.perform(lease,
      operation => f.store.createExclusiveAtScope(operation, f.token as OwnedFileMemoryToken, input)));
    expect(receipt.volume).toBe(1);
  });
});

it.each(['reserved-volume', 'reserved-generation', 'partial-payload', 'partial-metadata', 'before-marker', 'committed-marker'] as const)(
  'real SIGKILL at %s leaves attributable immutable crash evidence', async phase => {
    const { spawn } = await import('node:child_process');
    const f = await fixture();
    const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
    const moduleUrl = (name: string) => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href;
    const script = `
      import { FileMemoryFence } from ${JSON.stringify(moduleUrl('FileMemoryFence'))};
      import { FileMemoryTransactionCoordinator } from ${JSON.stringify(moduleUrl('FileMemoryTransactionCoordinator'))};
      import { FileMemoryOwnerSnapshots } from ${JSON.stringify(moduleUrl('FileMemoryOwnerSnapshots'))};
      import { FileMemoryVolumeStore } from ${JSON.stringify(moduleUrl('FileMemoryVolumeStore'))};
      const [tenantRoot, userId, barrierPhase] = process.argv.slice(1);
      const coordinator = new FileMemoryTransactionCoordinator({tenantRoot, getCurrentUserId: () => userId, fence: new FileMemoryFence()});
      const owners = new FileMemoryOwnerSnapshots({coordinator});
      const snapshot = await owners.readHeadSnapshot('ÜberNote.yaml');
      const store = new FileMemoryVolumeStore({coordinator, owners, afterPublication: async phase => {
        if (phase === barrierPhase) { process.stdout.write('BARRIER\\n'); process.stdin.resume(); await new Promise(() => {}); }
      }});
      await store.createExclusive(snapshot.token, {minimumVolume:1,rawContent:'entries: []\\n',entryCount:0,sealedAt:new Date('2026-09-29')});
    `;
    const child = spawn(process.execPath, [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', script, f.root, USER, phase], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Child barrier timeout: ${stderr}`)), 15000);
        child.stdout.on('data', chunk => { if (String(chunk).includes('BARRIER')) { clearTimeout(timeout); resolve(); } });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Child exited before barrier: ${stderr}`)); });
      });
      child.kill('SIGKILL');
      await exited;
      const v = path.join(f.ownerPath, 'v1');
      const before = await fs.readdir(v);
      const marker = before.includes('COMMITTED');
      expect(marker).toBe(phase === 'committed-marker');
      expect(before.filter(name => name.startsWith('g-'))).toHaveLength(phase === 'reserved-volume' ? 0 : 1);
      if (phase === 'reserved-generation') expect(await fs.readdir(path.join(v, before[0]))).toEqual([]);
      if (phase === 'partial-payload' || phase === 'partial-metadata') {
        const g = before.find(name => name.startsWith('g-'))!;
        const filename = phase === 'partial-payload' ? 'payload.yaml' : 'metadata.json';
        const partial = await fs.readFile(path.join(v, g, filename));
        expect(partial.length).toBeGreaterThan(0);
        if (phase === 'partial-payload') expect(partial.length).toBeLessThan(Buffer.byteLength(input.rawContent));
        else expect(() => JSON.parse(partial.toString('utf8'))).toThrow();
      }
      if (phase === 'before-marker' || marker) {
        const g = before.find(name => name.startsWith('g-'))!;
        expect(await fs.readFile(path.join(v, g, 'payload.yaml'), 'utf8')).toBe(input.rawContent);
      }
      // Read-only owner observation does not steal or remove the orphan lease.
      await f.owners.readHeadSnapshot('ÜberNote.yaml');
      const leasePath = path.join(f.root, '.memory-fences', 'tenant.lock');
      const leaseBefore = await fs.stat(leasePath);
      await expect(f.store.createExclusive(f.token, input)).rejects.toThrow('Timed out');
      expect((await fs.stat(leasePath)).ino).toBe(leaseBefore.ino);
      expect(await fs.readdir(v)).toEqual(before);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 20000);

it('retains receipt when marker disappears after its successful syscall', async () => {
  const f = await fixture(async (phase, v) => { if (phase === 'committed-marker') await fs.rmdir(path.join(v, 'COMMITTED')); });
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVECOMMITTED', receipt: { volume: 1 } });
});
it('rejects changed owner after premarker barrier', async () => {
  let root = '';
  const f = await fixture(async phase => { if (phase === 'before-marker') await fs.appendFile(path.join(root, 'ÜberNote.yaml'), 'changed: true\n'); });
  root = f.root;
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNCOMMITTED' });
  await expect(fs.stat(path.join(f.ownerPath, 'v1', 'COMMITTED'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['V1', 'v01'])('rejects numeric alias %s', async alias => {
  const f = await fixture();
  await fs.mkdir(path.join(f.ownerPath, alias), { recursive: true, mode: 0o700 });
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
});
it('blocks a second generation in a committed collision', async () => {
  const f = await fixture();
  await f.store.createExclusive(f.token, input);
  await fs.mkdir(path.join(f.ownerPath, 'v1', 'g-22222222-2222-4222-8222-222222222222'), { mode: 0o700 });
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEBLOCKED' });
});
it('does not qualify coerced metadata dates for collision advancement', async () => {
  const f = await fixture();
  const receipt = await f.store.createExclusive(f.token, input);
  const metadataPath = path.join(f.ownerPath, 'v1', `g-${receipt.generationId}`, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.sealedAt = null;
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
});
it('rejects hardlinked writer payload before marker', async () => {
  const f = await fixture(async (phase, v) => {
    if (phase === 'payload-written') {
      const [g] = await fs.readdir(v);
      await fs.link(path.join(v, g, 'payload.yaml'), path.join(v, 'alias'));
    }
  });
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNCOMMITTED' });
});
it('bounds FIFO inspection without blocking open', async () => {
  const { execFile } = await import('node:child_process');
  const f = await fixture();
  const receipt = await f.store.createExclusive(f.token, input);
  const p = path.join(f.ownerPath, 'v1', `g-${receipt.generationId}`, 'payload.yaml');
  await fs.unlink(p);
  await new Promise<void>((resolve, reject) => execFile('mkfifo', ['-m', '600', p], cause => cause ? reject(cause) : resolve()));
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
}, 5000);
it('preserves receipt through cyclic later errors', async () => {
  const f = await fixture();
  const later = new Error('cyclic');
  later.cause = later;
  await expect(retainCommittedFileArchives(retain => f.coordinator.withTenantTransaction(async lease => {
    retain(await f.store.createExclusiveInTransaction(lease, f.token, input));
    throw later;
  }))).rejects.toMatchObject({ code: 'EARCHIVECOMMITTED', cause: later });
});

it('allocates final safe number and refuses advancing beyond it', async () => {
  const f = await fixture();
  const receipt = await f.store.createExclusive(f.token, { ...input, minimumVolume: Number.MAX_SAFE_INTEGER });
  expect(receipt.volume).toBe(Number.MAX_SAFE_INTEGER);
  await expect(f.store.createExclusive(f.token, { ...input, minimumVolume: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: 'EARCHIVEEXHAUSTED' });
});
it('accepts uppercase durable UUID evidence while blocking lowercase namespace aliases', async () => {
  const f = await fixture();
  const oldOwner = f.token.ownerId;
  const uppercase = oldOwner.toUpperCase();
  // Fixture operator edit keeps head/sidecar/registry agreeing; no production adoption helper is changed.
  const headNames = await fs.readdir(f.root);
  const sidecar = headNames.find(name => name.endsWith('.memory-owner.json'))!;
  const sidecarPath = path.join(f.root, sidecar);
  const record = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  record.ownerId = uppercase;
  await fs.writeFile(sidecarPath, JSON.stringify(record));
  const registry = path.join(f.root, '.memory-owners', 'owners', `${oldOwner}.json`);
  const registryRecord = JSON.parse(await fs.readFile(registry, 'utf8'));
  registryRecord.ownerId = uppercase;
  await fs.unlink(registry);
  await fs.writeFile(path.join(f.root, '.memory-owners', 'owners', `${uppercase}.json`), JSON.stringify(registryRecord), { mode: 0o600 });
  const snapshot = await f.owners.readHeadSnapshot('ÜberNote.yaml');
  const token = snapshot.token as OwnedFileMemoryToken;
  const receipt = await f.store.createExclusive(token, input);
  expect(receipt.ownerId).toBe(uppercase);
  await fs.rename(path.join(f.root, 'volumes', 'by-id', uppercase), path.join(f.root, 'volumes', 'by-id', oldOwner));
  await expect(f.store.createExclusive(token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
});

it('bounds committed collision probes without allocating beyond the limit', async () => {
  const f = await fixture();
  const first = await f.store.createExclusive(f.token, input);
  const source = path.join(f.ownerPath, 'v1');
  for (let volume = 2; volume <= 1000; volume++) {
    const v = path.join(f.ownerPath, `v${volume}`);
    await fs.cp(source, v, { recursive: true, preserveTimestamps: false });
    const metadataPath = path.join(v, `g-${first.generationId}`, 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.volume = volume;
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
  }
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEEXHAUSTED' });
  await expect(fs.stat(path.join(f.ownerPath, 'v1001'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 60000);

it('reports unknown rather than unchanged when marker syscall rejects with EEXIST', async () => {
  const f = await fixture(async (phase, v) => {
    if (phase === 'invoking-marker') await fs.mkdir(path.join(v, 'COMMITTED'), { mode: 0o700 });
  });
  let outcome: NodeJS.ErrnoException & { outcome?: string; committed?: boolean; residualPath?: string } = new Error('missing');
  try { await f.store.createExclusive(f.token, input); }
  catch (cause) { outcome = cause as typeof outcome; }
  expect(outcome.code).toBe('EARCHIVECOMMITUNKNOWN');
  expect(outcome.outcome).toBe('unknown');
  expect(outcome.committed).toBeUndefined();
  expect(outcome.residualPath).toBe(await fs.realpath(path.join(f.ownerPath, 'v1')));
  expect((outcome.cause as NodeJS.ErrnoException).code).toBe('EEXIST');
});

it('accepts an existing 0755 tenant root while keeping archive namespace private', async () => {
  const f = await fixture();
  await fs.chmod(f.root, 0o755);
  await f.store.createExclusive(f.token, input);
  expect((await fs.stat(f.root)).mode & 0o777).toBe(0o755);
  expect((await fs.stat(path.join(f.root, 'volumes'))).mode & 0o777).toBe(0o700);
});

it('blocks RESERVED owner before archive I/O', async () => {
  const f = await fixture();
  const sidecar = (await fs.readdir(f.root)).find(name => name.endsWith('.memory-owner.json'))!;
  const p = path.join(f.root, sidecar);
  const record = JSON.parse(await fs.readFile(p, 'utf8'));
  record.state = 'RESERVED';
  await fs.writeFile(p, JSON.stringify(record));
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  await expect(fs.stat(path.join(f.root, 'volumes'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('detects ancestor replacement after reservation before content bytes', async () => {
  const f = await fixture(async (phase, v) => {
    if (phase !== 'reserved-generation') return;
    const owner = path.dirname(v);
    await fs.rename(owner, `${owner}-old`);
    await fs.symlink(`${owner}-old`, owner);
  });
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNCOMMITTED' });
  const v = path.join(`${f.ownerPath}-old`, 'v1');
  const [g] = await fs.readdir(v);
  expect(await fs.readdir(path.join(v, g))).toEqual([]);
});

if (process.platform === 'win32' || !process.getuid) {
  jestIt('rejects publication on unsupported platforms', () => {
    expect(() => new FileMemoryVolumeStore({ coordinator: {} as never, owners: {} as never })).toThrow('requires local POSIX');
  });
}

it.each(['modified-payload', 'replaced-metadata', 'extra-generation'] as const)('reverifies exact files after final barrier: %s', async mutation => {
  const f = await fixture(async (phase, v) => {
    if (phase !== 'invoking-marker') return;
    const [g] = await fs.readdir(v);
    if (mutation === 'modified-payload') await fs.appendFile(path.join(v, g, 'payload.yaml'), 'changed: true\n');
    if (mutation === 'replaced-metadata') {
      const p = path.join(v, g, 'metadata.json');
      const bytes = await fs.readFile(p);
      await fs.rename(p, `${p}.old`);
      await fs.writeFile(p, bytes, { mode: 0o600 });
      await fs.unlink(`${p}.old`);
    }
    if (mutation === 'extra-generation') await fs.mkdir(path.join(v, 'g-22222222-2222-4222-8222-222222222222'), { mode: 0o700 });
  });
  await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({ code: 'EARCHIVEUNCOMMITTED', committed: false });
  await expect(fs.stat(path.join(f.ownerPath, 'v1', 'COMMITTED'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['replaced-payload', 'replaced-metadata', 'removed-payload', 'removed-metadata', 'removed-marker'] as const)(
  'retains exact committed receipt when final hook changes archive: %s', async mutation => {
    let originalInode = '';
    const filename = mutation.includes('metadata') ? 'metadata.json' : 'payload.yaml';
    const f = await fixture(async (phase, v) => {
      if (phase !== 'verified-after-marker') return;
      const g = (await fs.readdir(v)).find(name => name.startsWith('g-'))!;
      const p = path.join(v, g, filename);
      originalInode = String((await fs.stat(p, { bigint: true })).ino);
      if (mutation === 'removed-marker') await fs.rmdir(path.join(v, 'COMMITTED'));
      else if (mutation.startsWith('removed')) await fs.unlink(p);
      else {
        const bytes = await fs.readFile(p);
        await fs.rename(p, `${p}.old`);
        await fs.writeFile(p, bytes, { mode: 0o600 });
        await fs.unlink(`${p}.old`);
      }
    });
    let outcome: CommittedFileArchiveError | undefined;
    try { await f.store.createExclusive(f.token, input); }
    catch (cause) { outcome = cause as CommittedFileArchiveError; }
    expect(outcome).toMatchObject({ code: 'EARCHIVECOMMITTED', committed: true, receipt: { volume: 1 } });
    const identity = filename === 'metadata.json' ? outcome?.receipt.metadataIdentity : outcome?.receipt.payloadIdentity;
    expect(identity?.inode).toBe(originalInode);
  });

it.each(['committed-marker', 'verified-after-marker'] as const)(
  'retains committed receipt after %s ancestor substitution', async barrier => {
    for (const ancestor of ['owner', 'by-id', 'volumes', 'tenant-root'] as const) {
      let originalPayloadInode = '';
      const f = await fixture(async (phase, v) => {
        if (phase !== barrier) return;
        const g = (await fs.readdir(v)).find(name => name.startsWith('g-'))!;
        originalPayloadInode = String((await fs.stat(path.join(v, g, 'payload.yaml'), { bigint: true })).ino);
        const owner = path.dirname(v);
        const byId = path.dirname(owner);
        const volumes = path.dirname(byId);
        const target = { owner, 'by-id': byId, volumes, 'tenant-root': path.dirname(volumes) }[ancestor];
        const moved = `${target}-old`;
        if (ancestor === 'tenant-root') roots.push(moved);
        await fs.rename(target, moved);
        await fs.symlink(moved, target);
      });
      let outcome: CommittedFileArchiveError | undefined;
      try { await f.store.createExclusive(f.token, input); }
      catch (cause) { outcome = cause as CommittedFileArchiveError; }
      expect(outcome).toMatchObject({ code: 'EARCHIVECOMMITTED', committed: true });
      expect(outcome?.receipt.payloadIdentity.inode).toBe(originalPayloadInode);
    }
  });

it.each(['before-marker', 'invoking-marker', 'committed-marker', 'verified-after-marker'] as const)(
  'rechecks numeric and namespace case aliases at %s', async barrier => {
    for (const alias of ['numeric', 'fixed-case'] as const) {
      const f = await fixture(async (phase, v) => {
        if (phase !== barrier) return;
        if (alias === 'numeric') await fs.mkdir(path.join(path.dirname(v), 'v01'), { mode: 0o700 });
        else {
          const volumes = path.dirname(path.dirname(path.dirname(v)));
          await fs.rename(volumes, path.join(path.dirname(volumes), 'Volumes'));
        }
      });
      const committed = barrier === 'committed-marker' || barrier === 'verified-after-marker';
      await expect(f.store.createExclusive(f.token, input)).rejects.toMatchObject({
        code: committed ? 'EARCHIVECOMMITTED' : 'EARCHIVEUNCOMMITTED', committed,
      });
    }
  });

it('accepts chronological finite extended-year dates using numeric epochs', async () => {
  const f = await fixture();
  const firstEntryAt = new Date('-000002-01-01T00:00:00.000Z');
  const lastEntryAt = new Date('-000001-01-01T00:00:00.000Z');
  const receipt = await f.store.createExclusive(f.token, { ...input, firstEntryAt, lastEntryAt });
  const metadata = JSON.parse(await fs.readFile(path.join(f.ownerPath, 'v1', `g-${receipt.generationId}`, 'metadata.json'), 'utf8'));
  expect(metadata.firstEntryAt).toBe(firstEntryAt.toISOString());
  expect(metadata.lastEntryAt).toBe(lastEntryAt.toISOString());
});
