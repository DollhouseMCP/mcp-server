import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type OwnedFileMemoryToken, type UnownedFileMemoryToken } from '../../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore } from '../../../../src/storage/FileMemoryVolumeStore.js';

const USER = '11111111-1111-4111-8111-111111111111';
const RAW = 'name: Memory\nentries: []\n';
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
export interface OwnedErasureFixtureOptions {
  nested?: boolean;
  foreignOwners?: 0 | 100 | 250 | 1000;
  volumes?: 2 | 10;
  archive?: 'published' | 'no-volumes' | 'no-by-id' | 'no-owner-root' | 'empty-owner-root' | 'mixed';
}
export interface ErasureFileEvidence {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  identity: { device: string; inode: string; size: string; mtimeNs: string; ctimeNs: string };
  mode: string;
  uid: string;
  links: string;
  bytes?: Buffer;
  linkTarget?: string;
  names?: string[];
}

/** Isolated test evidence; never production ownership or deletion authority. */
export async function captureErasureFiles(paths: readonly string[]): Promise<ErasureFileEvidence[]> {
  const result: ErasureFileEvidence[] = [];
  for (const target of paths) {
    const stat = await fs.lstat(target, { bigint: true });
    result.push({ path: target,
      type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
      identity: { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) },
      mode: String(stat.mode), uid: String(stat.uid), links: String(stat.nlink),
      ...(stat.isFile() ? { bytes: await fs.readFile(target) } : {}),
      ...(stat.isSymbolicLink() ? { linkTarget: await fs.readlink(target) } : {}),
      ...(stat.isDirectory() ? { names: (await fs.readdir(target)).sort() } : {}),
    });
  }
  return result;
}

/** Traverses only actual directories in the isolated fixture; never follows a symlink. */
export async function captureErasureTree(root: string): Promise<ErasureFileEvidence[]> {
  const result: ErasureFileEvidence[] = [];
  async function visit(target: string): Promise<void> {
    const [record] = await captureErasureFiles([target]);
    result.push(record);
    if (record.type === 'directory') for (const name of record.names!) await visit(path.join(target, name));
  }
  await visit(root);
  return result;
}

async function requireAbsent(target: string): Promise<void> {
  try { await fs.lstat(target); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
  throw new Error(`Fixture expected an absent canonical component: ${target}`);
}

export async function makeOwnedErasureFixture(options: OwnedErasureFixtureOptions = {}, onRootAllocated?: (root: string) => void) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-erasure-'));
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  try {
    onRootAllocated?.(root);
    root = await fs.realpath(root);
    await fs.chmod(root, 0o700);
    const locator = options.nested ? 'Notes/Memory.yaml' : 'Memory.yaml';
    const head = path.join(root, locator);
    if (options.nested) await fs.mkdir(path.dirname(head), { mode: 0o700 });
    await fs.writeFile(head, RAW, { mode: 0o600 });
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
    const owners = new FileMemoryOwnerSnapshots({ coordinator });
    const snapshot = await owners.readHeadSnapshot(locator);
    const token: OwnedFileMemoryToken = await owners.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
    const archives = new FileMemoryVolumeStore({ coordinator, owners });
    const archive = options.archive ?? 'published';
    const volumes = path.join(root, 'volumes'), byId = path.join(volumes, 'by-id'), selected = path.join(byId, token.ownerId);
    if (archive === 'published' || archive === 'mixed') {
      for (let number = 1; number <= (options.volumes ?? 2); number++) {
        await archives.createExclusive(token, { minimumVolume: number, rawContent: RAW, entryCount: 0, sealedAt: new Date('2026-10-02T00:00:00Z') });
      }
    } else if (archive !== 'no-volumes') {
      await fs.mkdir(volumes, { mode: 0o700 });
      if (archive !== 'no-by-id') {
        await fs.mkdir(byId, { mode: 0o700 });
        if (archive === 'empty-owner-root') await fs.mkdir(selected, { mode: 0o700 });
      }
    }
    if (archive === 'mixed') {
      await fs.mkdir(path.join(selected, 'unknown-private'), { mode: 0o700 });
      await fs.mkdir(path.join(selected, 'v9000'), { mode: 0o700 });
      const partial = path.join(selected, 'v9001', `g-${randomUUID()}`);
      await fs.mkdir(path.dirname(partial), { mode: 0o700 });
      await fs.mkdir(partial, { mode: 0o700 });
      for (const [target, bytes] of [
        [path.join(selected, 'unknown-private', 'opaque.bin'), 'unknown owner-attributed bytes'],
        [path.join(selected, 'temporary.partial'), 'temporary bytes'],
        [path.join(selected, 'v9000.cleanup.json'), '{malformed cleanup'],
        [path.join(partial, 'payload.yaml'), 'partial: ['],
        [path.join(partial, 'metadata.json'), '{malformed metadata'],
      ] as const) await fs.writeFile(target, bytes, { mode: 0o600 });
    }
    const foreignFiles: string[] = [];
    // Match established capacity setup: canonical ACTIVE records bind real file
    // identities. This is fixture construction, not 1,000 leased adoptions.
    for (let index = 0; index < (options.foreignOwners ?? 0); index++) {
      const foreignLocator = path.posix.join(path.posix.dirname(locator), `Existing${index}.yaml`);
      const target = path.join(root, foreignLocator), ownerId = randomUUID();
      await fs.writeFile(target, RAW, { mode: 0o600 });
      const stat = await fs.lstat(target, { bigint: true });
      const record = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator: foreignLocator, revision: '1', contentHash: digest(RAW),
        fileIdentity: { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } });
      const sidecar = path.join(path.dirname(target), `.${digest(path.posix.basename(foreignLocator))}.memory-owner.json`);
      const registry = path.join(root, '.memory-owners', 'owners', `${ownerId}.json`);
      await fs.writeFile(sidecar, record, { mode: 0o600 });
      await fs.writeFile(registry, record, { mode: 0o600 });
      foreignFiles.push(target, sidecar, registry);
      // Do not create a missing canonical chain merely to add unrelated evidence.
      if (archive !== 'no-volumes' && archive !== 'no-by-id') {
        const foreignArchive = path.join(byId, ownerId);
        await fs.mkdir(foreignArchive, { mode: 0o700 });
        foreignFiles.push(foreignArchive);
      }
    }
    if (archive === 'no-volumes') await requireAbsent(volumes);
    if (archive === 'no-by-id') await requireAbsent(byId);
    if (archive === 'no-owner-root') await requireAbsent(selected);
    return { root, coordinator, owners, archives, token,
      request: { operationId: randomUUID(), deleteOperationId: randomUUID(), expectedToken: token },
      foreignFiles, cleanup };
  } catch (cause) {
    try { await cleanup(); }
    catch (cleanupCause) { throw new AggregateError([cause, cleanupCause], 'Erasure fixture setup and cleanup failed', { cause }); }
    throw cause;
  }
}
