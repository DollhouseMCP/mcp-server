import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence, FileMemoryFenceTimeoutError } from '../../../src/storage/FileMemoryFence.js';
import {
  FileMemoryOwnerSnapshots,
  type AdoptionPublication,
  type UnownedFileMemoryToken,
} from '../../../src/storage/FileMemoryOwnerSnapshots.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const sourceExtension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const snapshotModuleUrl = new URL(
  `../../../src/storage/FileMemoryOwnerSnapshots.${sourceExtension}`, import.meta.url,
).href;
const fenceModuleUrl = new URL(`../../../src/storage/FileMemoryFence.${sourceExtension}`, import.meta.url).href;
const adoptionChild = `
  import { FileMemoryOwnerSnapshots } from ${JSON.stringify(snapshotModuleUrl)};
  import { FileMemoryFence } from ${JSON.stringify(fenceModuleUrl)};
  const [tenantRoot, locator, userId] = process.argv.slice(1);
  const store = new FileMemoryOwnerSnapshots({
    tenantRoot, getCurrentUserId: () => userId, fence: new FileMemoryFence(),
    afterPublication: phase => {
      if (phase === 'reserved-sidecar') {
        process.stdout.write('RESERVED\\n');
        process.stdin.resume();
        return new Promise(() => {});
      }
    },
  });
  const snapshot = await store.readHeadSnapshot(locator);
  await store.adoptUnowned(snapshot.token);
`;

function sidecarPath(headPath: string): string {
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  return path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
}

async function fixture(content = 'name: Legacy\ncontent: original\n', locator = 'Notes/ÜberNote.yaml') {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-owner-snapshot-'));
  roots.push(tenantRoot);
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath), { recursive: true });
  await fs.writeFile(headPath, content);
  const makeStore = (afterPublication?: (phase: AdoptionPublication) => void) =>
    new FileMemoryOwnerSnapshots({
      tenantRoot,
      getCurrentUserId: () => USER_ID,
      fence: new FileMemoryFence(),
      afterPublication,
    });
  return { tenantRoot, headPath, locator, makeStore };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('FileMemoryOwnerSnapshots local POSIX primitive', () => {
  if (process.platform === 'win32') {
    it('fails closed where POSIX owner and mode checks are unavailable', () => {
      expect(() => new FileMemoryOwnerSnapshots({
        tenantRoot: 'C:\\', getCurrentUserId: () => USER_ID, fence: new FileMemoryFence(),
      })).toThrow('requires POSIX');
    });
    return;
  }

  it('reads oversized legacy content without changing disk or adopting an owner', async () => {
    const content = `content: ${'a'.repeat(300_000)}\n`;
    const { tenantRoot, headPath, locator, makeStore } = await fixture(content);
    const before = await fs.readdir(tenantRoot);
    const headBefore = await fs.stat(headPath);
    const snapshot = await makeStore().readHeadSnapshot(locator);
    expect(snapshot.content).toBe(content);
    expect(snapshot.token.ownership).toBe('unowned');
    expect(snapshot.token.locator).toBe(locator);
    expect(await fs.readdir(tenantRoot)).toEqual(before);
    expect(await fs.readdir(path.dirname(headPath))).toEqual([path.basename(headPath)]);
    expect((await fs.stat(headPath)).mtimeMs).toBe(headBefore.mtimeMs);
  });

  it('adopts an unchanged legacy head with a durable owner and agreeing registry', async () => {
    const { tenantRoot, headPath, locator, makeStore } = await fixture();
    const store = makeStore();
    const before = await store.readHeadSnapshot(locator);
    const token = await store.adoptUnowned(before.token as UnownedFileMemoryToken);
    expect(token.ownership).toBe('owned');
    expect(token.ownerId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(token.revision).toBe('1');
    expect((await store.readHeadSnapshot(locator)).token).toEqual(token);
    const record = JSON.parse(await fs.readFile(sidecarPath(headPath), 'utf8'));
    const registry = JSON.parse(await fs.readFile(
      path.join(tenantRoot, '.memory-owners', 'owners', `${token.ownerId}.json`), 'utf8'));
    expect(record).toEqual(registry);
    expect(record.state).toBe('ACTIVE');
    expect((await fs.stat(sidecarPath(headPath))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(tenantRoot, '.memory-owners'))).mode & 0o777).toBe(0o700);
  });

  it('rejects stale or changed snapshots before publishing ownership', async () => {
    const { tenantRoot, headPath, locator, makeStore } = await fixture();
    const store = makeStore();
    const snapshot = await store.readHeadSnapshot(locator);
    await fs.writeFile(headPath, 'name: Changed\n');
    await expect(store.adoptUnowned(snapshot.token as UnownedFileMemoryToken))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await fs.readdir(path.dirname(headPath))).toEqual([path.basename(headPath)]);
    expect(await fs.readdir(tenantRoot)).not.toContain('.memory-owners');
  });

  it('rejects adoption of another user’s token before owner publication', async () => {
    const { tenantRoot, headPath, locator, makeStore } = await fixture();
    const snapshot = await makeStore().readHeadSnapshot(locator);
    const other = new FileMemoryOwnerSnapshots({
      tenantRoot,
      getCurrentUserId: () => '22222222-2222-4222-8222-222222222222',
      fence: new FileMemoryFence(),
    });
    await expect(other.adoptUnowned(snapshot.token as UnownedFileMemoryToken))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    await expect(fs.stat(sidecarPath(headPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes competing adoption attempts for the same unowned snapshot', async () => {
    const { locator, makeStore } = await fixture();
    const first = makeStore();
    const second = makeStore();
    const snapshot = await first.readHeadSnapshot(locator);
    const outcomes = await Promise.allSettled([
      first.adoptUnowned(snapshot.token as UnownedFileMemoryToken),
      second.adoptUnowned(snapshot.token as UnownedFileMemoryToken),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect((await first.readHeadSnapshot(locator)).token.ownership).toBe('owned');
  });

  it.each<AdoptionPublication>([
    'reserved-sidecar', 'reserved-registry', 'active-registry', 'active-sidecar',
  ])('fails closed after an injected %s publication interruption', async (phase) => {
    const { locator, makeStore } = await fixture();
    const store = makeStore(current => { if (current === phase) throw new Error('crash point'); });
    const snapshot = await store.readHeadSnapshot(locator);
    await expect(store.adoptUnowned(snapshot.token as UnownedFileMemoryToken)).rejects.toThrow('crash point');
    if (phase === 'active-sidecar') {
      expect((await store.readHeadSnapshot(locator)).token.ownership).toBe('owned');
    } else {
      await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      await expect(store.adoptUnowned(snapshot.token as UnownedFileMemoryToken))
        .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    }
  });

  it('keeps a real killed adopter RESERVED and its tenant lease abandoned', async () => {
    const { tenantRoot, locator, makeStore } = await fixture();
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', adoptionChild, tenantRoot, locator, USER_ID,
    ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        let errors = '';
        const timeout = setTimeout(() => reject(new Error(`Child did not reserve owner: ${errors}`)), 5_000);
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
          if (output.includes('RESERVED\n')) { clearTimeout(timeout); resolve(); }
        });
        child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => {
          clearTimeout(timeout);
          reject(new Error(`Adopter exited ${code}: ${errors}`));
        });
      });
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exit;
      await expect(makeStore().readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => 1, { timeoutMs: 50 }))
        .rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('rejects corrupted, missing, or mismatched owner registry without an unowned fallback', async () => {
    const { tenantRoot, locator, makeStore } = await fixture();
    const store = makeStore();
    const snapshot = await store.readHeadSnapshot(locator);
    const owned = await store.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
    const registryPath = path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`);
    const original = await fs.readFile(registryPath, 'utf8');
    await fs.unlink(registryPath);
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await fs.writeFile(registryPath, '{broken', { mode: 0o600 });
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await fs.writeFile(registryPath, original.replace(locator, 'Notes/Another.yaml'), { mode: 0o600 });
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it('rejects a copied sidecar whose registry belongs to another head', async () => {
    const { tenantRoot, headPath, locator, makeStore } = await fixture();
    const store = makeStore();
    const snapshot = await store.readHeadSnapshot(locator);
    await store.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
    const copyPath = path.join(tenantRoot, 'Notes', 'Copy.yaml');
    await fs.writeFile(copyPath, snapshot.content);
    await fs.copyFile(sidecarPath(headPath), sidecarPath(copyPath));
    await expect(store.readHeadSnapshot('Notes/Copy.yaml'))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it('rejects unsafe registry ancestors on read without repairing them', async () => {
    const { tenantRoot, locator, makeStore } = await fixture();
    const store = makeStore();
    const snapshot = await store.readHeadSnapshot(locator);
    await store.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
    const owners = path.join(tenantRoot, '.memory-owners', 'owners');
    await fs.chmod(owners, 0o755);
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.stat(owners)).mode & 0o777).toBe(0o755);
  });

  it('checks metadata size before publishing even the RESERVED sidecar', async () => {
    const { tenantRoot, headPath, locator } = await fixture();
    const longUserId = 'u'.repeat(5_000);
    const store = new FileMemoryOwnerSnapshots({
      tenantRoot, getCurrentUserId: () => longUserId, fence: new FileMemoryFence(),
    });
    const snapshot = await store.readHeadSnapshot(locator);
    await expect(store.adoptUnowned(snapshot.token as UnownedFileMemoryToken))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await expect(fs.stat(sidecarPath(headPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a fixed-length sidecar name for a long valid head basename', async () => {
    const locator = `${'n'.repeat(240)}.yaml`;
    const { headPath, makeStore } = await fixture('name: Long\n', locator);
    const store = makeStore();
    const snapshot = await store.readHeadSnapshot(locator);
    const owned = await store.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
    expect(owned.locator).toBe(locator);
    expect(path.basename(sidecarPath(headPath)).length).toBeLessThan(255);
  });

  it('keeps actual case and Unicode spelling instead of normalizing the locator', async () => {
    const { locator, makeStore } = await fixture();
    const exact = await makeStore().readHeadSnapshot(locator);
    expect(exact.token.locator).toBe('Notes/ÜberNote.yaml');
    try {
      const alias = await makeStore().readHeadSnapshot('Notes/übernote.yaml');
      // Case-insensitive hosts resolve the alias to the same actual spelling.
      expect(alias.token.locator).toBe(exact.token.locator);
    } catch (error) {
      // Case-sensitive hosts have no such path; there is no lowercase fallback.
      expect(error).toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects invalid UTF-8 head bytes instead of returning altered content', async () => {
    const { headPath, locator, makeStore } = await fixture();
    await fs.writeFile(headPath, Buffer.from([0xc3, 0x28]));
    await expect(makeStore().readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EINVALIDHEAD' });
  });

  it('preserves an existing UTF-8 byte-order mark in the returned snapshot', async () => {
    const content = '\ufeffname: Marked\n';
    const { locator, makeStore } = await fixture(content);
    expect((await makeStore().readHeadSnapshot(locator)).content).toBe(content);
  });

  it('rejects symlink and hardlink head aliases', async () => {
    const { tenantRoot, headPath, makeStore } = await fixture();
    const symlink = path.join(tenantRoot, 'alias.yaml');
    const hardlink = path.join(tenantRoot, 'linked.yaml');
    await fs.symlink(headPath, symlink);
    await fs.link(headPath, hardlink);
    await expect(makeStore().readHeadSnapshot('alias.yaml')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    await expect(makeStore().readHeadSnapshot('linked.yaml')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
  });
});
