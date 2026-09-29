import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import {
  FileMemoryOwnerSnapshots,
  type FinalizePublication,
  type OwnedFileMemoryToken,
  type UnownedFileMemoryToken,
} from '../../../src/storage/FileMemoryOwnerSnapshots.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const moduleRoot = new URL('../../../src/storage/', import.meta.url);
const finalizeChild = `
  import { FileMemoryOwnerSnapshots } from ${JSON.stringify(new URL(`FileMemoryOwnerSnapshots.${extension}`, moduleRoot).href)};
  import { FileMemoryTransactionCoordinator } from ${JSON.stringify(new URL(`FileMemoryTransactionCoordinator.${extension}`, moduleRoot).href)};
  import { FileMemoryFence } from ${JSON.stringify(new URL(`FileMemoryFence.${extension}`, moduleRoot).href)};
  const [tenantRoot, userId, requestJson, stopPhase] = process.argv.slice(1);
  const coordinator = new FileMemoryTransactionCoordinator({
    tenantRoot, getCurrentUserId: () => userId, fence: new FileMemoryFence(),
  });
  const store = new FileMemoryOwnerSnapshots({ coordinator,
    afterFinalizePublication: phase => {
      if (phase === stopPhase) {
        process.stdout.write('STOPPED\\n');
        process.stdin.resume();
        return new Promise(() => {});
      }
    },
  });
  await store.finalizePublishedOwnedUpdate(JSON.parse(requestJson));
`;

async function fixture(afterFinalizePublication?: (phase: FinalizePublication) => void | Promise<void>) {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-owned-finalize-'));
  roots.push(tenantRoot);
  const locator = 'Notes/ÜberNote.yaml';
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath), { recursive: true });
  await fs.writeFile(headPath, 'name: Original\nentries: []\n');
  const coordinator = new FileMemoryTransactionCoordinator({
    tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence(),
  });
  const store = new FileMemoryOwnerSnapshots({ coordinator, afterFinalizePublication });
  const before = await store.readHeadSnapshot(locator);
  const owned = await store.adoptUnowned(before.token as UnownedFileMemoryToken);
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  const journalPath = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
  const request = { locator, ownerId: owned.ownerId, operationId: randomUUID() };
  return { tenantRoot, locator, headPath, journalPath, coordinator, store, owned, request };
}

async function interrupted(afterFinalizePublication?: (phase: FinalizePublication) => void | Promise<void>) {
  const setup = await fixture(afterFinalizePublication);
  const writer = new FileMemoryOwnerSnapshots({
    coordinator: setup.coordinator,
    afterUpdatePublication: phase => {
      if (phase === 'updated-sidecar') throw new Error('stopped before unlink');
    },
  });
  await expect(writer.updateOwnedHead(setup.owned, 'name: Updated\nentries: []\n'))
    .rejects.toMatchObject({ code: 'EHEADCOMMITUNKNOWN' });
  const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { operationId: string };
  return { ...setup, request: { ...setup.request, operationId: journal.operationId } };
}

async function rebindPublishedEvidence(
  setup: Awaited<ReturnType<typeof interrupted>>, content: string,
): Promise<void> {
  await fs.writeFile(setup.headPath, content);
  const stat = await fs.stat(setup.headPath, { bigint: true });
  const identity = {
    device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
    ctimeNs: stat.ctimeNs.toString(), mtimeNs: stat.mtimeNs.toString(),
  };
  const digest = createHash('sha256').update(content).digest('hex');
  const sidecar = path.join(path.dirname(setup.headPath),
    `.${createHash('sha256').update(path.basename(setup.headPath)).digest('hex')}.memory-owner.json`);
  const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
  for (const recordPath of [sidecar, registry]) {
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(recordPath, JSON.stringify({ ...record, contentHash: digest, fileIdentity: identity }),
      { mode: 0o600 });
  }
  const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(setup.journalPath, JSON.stringify({
    ...journal, newContentHash: digest, preparedTempIdentity: identity, publishedHeadIdentity: identity,
  }), { mode: 0o600 });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('dormant finalization of a fully published owned UPDATE', () => {
  if (process.platform === 'win32') {
    it('requires POSIX owner and mode checks', () => {
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence(),
      });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }

  it('unlinks only the exact published journal and returns a verified new token', async () => {
    const { store, request, locator, journalPath } = await interrupted();
    const result = await store.finalizePublishedOwnedUpdate(request);
    expect(result.status).toBe('known-committed');
    if (result.status !== 'known-committed') throw new Error('Unexpected result');
    expect(result.token.revision).toBe('2');
    expect((await store.readHeadSnapshot(locator)).token).toEqual(result.token);
    await expect(fs.lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.finalizePublishedOwnedUpdate(request)).toEqual({ status: 'already-clean-no-attribution' });
  });

  it('never attributes an already-clean head to a supplied operation', async () => {
    const { store, request, locator } = await fixture();
    expect(await store.finalizePublishedOwnedUpdate(request)).toEqual({ status: 'already-clean-no-attribution' });
    expect((await store.readHeadSnapshot(locator)).token).toMatchObject({ revision: '1' });
  });

  it('preserves the journal when owner or operation filters do not match', async () => {
    const { store, request, journalPath } = await interrupted();
    await expect(store.finalizePublishedOwnedUpdate({ ...request, operationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await expect(store.finalizePublishedOwnedUpdate({ ...request, ownerId: randomUUID() }))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.lstat(journalPath)).isFile()).toBe(true);
  });

  it.each([
    'name: [broken\nentries: []\n',
    'name: Bad\nmetadata:\n  gatekeeper:\n    externalRestrictions:\n      denyPatterns:\n        - Bash:rm *\nentries: []\n',
  ])('refuses to finalize published YAML rejected by normal save validation', async content => {
    const setup = await interrupted();
    await rebindPublishedEvidence(setup, content);
    expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind)
      .toBe('metadata-advanced-before-unlink');
    await expect(setup.store.finalizePublishedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EINVALIDHEAD' });
    expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
    expect(await fs.readFile(setup.headPath, 'utf8')).toBe(content);
  });

  it('preserves unexpected artifacts and denies another tenant and alias path', async () => {
    const setup = await interrupted();
    const wrongTenant = new FileMemoryOwnerSnapshots({ coordinator: new FileMemoryTransactionCoordinator({
      tenantRoot: setup.tenantRoot, getCurrentUserId: () => 'another-user', fence: new FileMemoryFence(),
    }) });
    await expect(wrongTenant.finalizePublishedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const alias = path.join(path.dirname(setup.headPath), 'Alias.yaml');
    await fs.symlink(setup.headPath, alias);
    await expect(setup.store.finalizePublishedOwnedUpdate({ ...setup.request, locator: 'Notes/Alias.yaml' }))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    const extra = `${setup.journalPath}.22222222-2222-4222-8222-222222222222.tmp`;
    await fs.writeFile(extra, 'partial', { mode: 0o600 });
    await expect(setup.store.finalizePublishedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
  });

  it('rejects a same-byte journal replacement before unlink', async () => {
    const { request, journalPath, locator, store, coordinator } = await interrupted();
    const tampering = new FileMemoryOwnerSnapshots({ coordinator,
      afterFinalizePublication: async phase => {
        if (phase !== 'before-unlink') return;
        const replacement = `${journalPath}.replacement`;
        await fs.copyFile(journalPath, replacement);
        await fs.rename(replacement, journalPath);
      },
    });
    await expect(tampering.finalizePublishedOwnedUpdate(request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.lstat(journalPath)).isFile()).toBe(true);
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it.each<FinalizePublication>(['after-unlink', 'after-read'])(
    'retains a committed token after a %s failure', async phase => {
      const { request, journalPath, store, locator, coordinator } = await interrupted();
      const failing = new FileMemoryOwnerSnapshots({ coordinator,
        afterFinalizePublication: current => { if (current === phase) throw new Error('postcommit hook'); },
      });
      let committed: OwnedFileMemoryToken | undefined;
      try { await failing.finalizePublishedOwnedUpdate(request); } catch (error) {
        expect(error).toMatchObject({ code: 'EHEADCOMMITTED', committed: true });
        committed = (error as { token: OwnedFileMemoryToken }).token;
      }
      expect(committed).toBeDefined();
      expect((await store.readHeadSnapshot(locator)).token).toEqual(committed);
      await expect(fs.lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('retains the pre-unlink token when the post-unlink head read fails', async () => {
    const { request, journalPath, coordinator, headPath } = await interrupted();
    const moved = `${headPath}.temporarily-hidden`;
    const failing = new FileMemoryOwnerSnapshots({ coordinator,
      afterFinalizePublication: async phase => {
        if (phase === 'after-unlink') await fs.rename(headPath, moved);
      },
    });
    let committed: OwnedFileMemoryToken | undefined;
    try { await failing.finalizePublishedOwnedUpdate(request); } catch (error) {
      expect(error).toMatchObject({ code: 'EHEADCOMMITTED', committed: true });
      committed = (error as { token: OwnedFileMemoryToken }).token;
    }
    expect(committed).toMatchObject({ ownerId: request.ownerId, revision: '2' });
    await expect(fs.lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(moved)).isFile()).toBe(true);
  });

  it('retains the committed token if the outer fence release fails', async () => {
    const { tenantRoot, request, store, locator } = await interrupted();
    const coordinator = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => USER,
      fence: { async withTenantFence<T>(_root: string, operation: () => Promise<T> | T): Promise<T> {
        await operation();
        throw new Error('lease release failed');
      } },
    });
    const failing = new FileMemoryOwnerSnapshots({ coordinator });
    let committed: OwnedFileMemoryToken | undefined;
    try { await failing.finalizePublishedOwnedUpdate(request); } catch (error) {
      expect(error).toMatchObject({ code: 'EHEADCOMMITTED', committed: true });
      committed = (error as { token: OwnedFileMemoryToken }).token;
    }
    expect(committed).toBeDefined();
    expect((await store.readHeadSnapshot(locator)).token).toEqual(committed);
  });

  // Root can unlink despite mode 0500; the permission fault is meaningful only for non-root CI users.
  const permissionIt = process.getuid?.() === 0 ? it.skip : it;
  permissionIt('reports an indeterminate unlink outcome without claiming a commit', async () => {
    const setup = await interrupted();
    const directory = path.dirname(setup.headPath);
    const failing = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterFinalizePublication: async phase => {
        if (phase === 'before-unlink') await fs.chmod(directory, 0o500);
      },
    });
    try {
      await expect(failing.finalizePublishedOwnedUpdate(setup.request)).rejects.toMatchObject({
        code: 'EHEADCOMMITUNKNOWN', operationId: setup.request.operationId,
      });
    } finally {
      await fs.chmod(directory, 0o700);
    }
    expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
  });

  it.each<FinalizePublication>(['before-unlink', 'after-unlink', 'after-read'])(
    'preserves a fail-closed or clean state after a real SIGKILL at %s', async phase => {
      const { tenantRoot, request, journalPath, store, locator } = await interrupted();
      const child = spawn(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval', finalizeChild,
        tenantRoot, USER, JSON.stringify(request), phase,
      ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      try {
        await new Promise<void>((resolve, reject) => {
          let output = '';
          let errors = '';
          const timeout = setTimeout(() => reject(new Error(`Child did not reach ${phase}: ${errors}`)), 8_000);
          child.stdout.on('data', (data: Buffer) => {
            output += data.toString();
            if (output.includes('STOPPED\n')) { clearTimeout(timeout); resolve(); }
          });
          child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
          child.once('error', error => { clearTimeout(timeout); reject(error); });
          child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Child exited ${code}: ${errors}`)); });
        });
        const exit = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exit;
        expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('blocked-by-fence');
        // Test-only manual removal after the killed writer has exited.
        await fs.rm(path.join(tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
        if (phase === 'before-unlink') {
          expect((await fs.lstat(journalPath)).isFile()).toBe(true);
          expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('metadata-advanced-before-unlink');
          expect((await store.finalizePublishedOwnedUpdate(request)).status).toBe('known-committed');
        } else {
          await expect(fs.lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await store.finalizePublishedOwnedUpdate(request)).toEqual({ status: 'already-clean-no-attribution' });
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  );
});
