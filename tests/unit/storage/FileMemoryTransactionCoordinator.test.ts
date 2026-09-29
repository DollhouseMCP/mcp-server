import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence, FileMemoryFenceTimeoutError } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import {
  FileMemoryTransactionCoordinator,
  type FileMemoryLeaseContext,
} from '../../../src/storage/FileMemoryTransactionCoordinator.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LOCATOR = 'Notes/ÜberNote.yaml';
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const sourceUrl = (name: string) => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-transaction-'));
  roots.push(tenantRoot);
  await fs.mkdir(path.join(tenantRoot, 'Notes'));
  await fs.writeFile(path.join(tenantRoot, LOCATOR), 'name: Legacy\ncontent: unchanged\n');
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({
    tenantRoot, getCurrentUserId: () => USER_ID, fence,
  });
  const owner = new FileMemoryOwnerSnapshots({ coordinator });
  return { tenantRoot, coordinator, owner, fence };
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error(`Child did not signal ${marker}: ${errors}`)), 5_000);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.includes(marker)) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${errors}`)); });
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await childExit(child);
    }
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('FileMemoryTransactionCoordinator', () => {
  if (process.platform === 'win32') {
    it('does not support POSIX tenant lease operations on Windows', async () => {
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot: 'C:\\', getCurrentUserId: () => USER_ID, fence: new FileMemoryFence(),
      });
      await expect(coordinator.withTenantTransaction(() => 1)).rejects.toThrow();
    });
    return;
  }

  it('keeps standalone read write-free and composes read/adoption under one lease', async () => {
    const { tenantRoot, coordinator, owner } = await fixture();
    const before = await fs.readdir(tenantRoot);
    const legacy = await owner.readHeadSnapshot(LOCATOR);
    expect(legacy.token.ownership).toBe('unowned');
    expect(await fs.readdir(tenantRoot)).toEqual(before);
    const adopted = await coordinator.withTenantTransaction(async context => {
      const within = await owner.readHeadSnapshotInTransaction(context, LOCATOR);
      expect(within.token).toEqual(legacy.token);
      const result = await owner.adoptUnownedInTransaction(context, within.token as UnownedFileMemoryToken);
      expect((await owner.readHeadSnapshotInTransaction(context, LOCATOR)).token.ownership).toBe('owned');
      return result;
    });
    expect(adopted.ownership).toBe('owned');
    expect((await owner.readHeadSnapshot(LOCATOR)).token).toEqual(adopted);
  });

  it('drains an unawaited public store method before releasing the tenant fence', async () => {
    const { tenantRoot, coordinator } = await fixture();
    const entered = deferred();
    const release = deferred();
    const owner = new FileMemoryOwnerSnapshots({
      coordinator,
      afterPublication: phase => {
        if (phase === 'reserved-sidecar') { entered.resolve(); return release.promise; }
      },
    });
    const legacy = await owner.readHeadSnapshot(LOCATOR);
    const operation = coordinator.withTenantTransaction(context => {
      void owner.adoptUnownedInTransaction(context, legacy.token as UnownedFileMemoryToken);
      return 'callback returned';
    });
    await entered.promise;
    const shortFence = new FileMemoryFence();
    await expect(shortFence.withTenantFence(tenantRoot, () => 1, { timeoutMs: 80 }))
      .rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    release.resolve();
    await expect(operation).resolves.toBe('callback returned');
    expect((await owner.readHeadSnapshot(LOCATOR)).token.ownership).toBe('owned');
  });

  it('runs sibling tracked operations FIFO and poisons later work after failure', async () => {
    const { coordinator } = await fixture();
    const entered = deferred();
    const release = deferred();
    const firstFailure = new Error('first operation failed');
    const events: string[] = [];
    const transaction = coordinator.withTenantTransaction(context => {
      void coordinator.perform(context, async () => {
        events.push('first-start');
        entered.resolve();
        await release.promise;
        throw firstFailure;
      });
      void coordinator.perform(context, () => { events.push('second-start'); });
      return 'returned';
    });
    await entered.promise;
    expect(events).toEqual(['first-start']);
    release.resolve();
    await expect(transaction).rejects.toBe(firstFailure);
    expect(events).toEqual(['first-start']);
  });

  it('records an operation failure even when it uses the queue-abort error code', async () => {
    const { coordinator } = await fixture();
    const failure = Object.assign(new Error('store operation failed'), { code: 'ELEASEABORTED' });
    const events: string[] = [];
    const transaction = coordinator.withTenantTransaction(context => {
      void coordinator.perform(context, () => { throw failure; });
      void coordinator.perform(context, () => { events.push('queued mutation'); });
      return 'callback returned';
    });
    await expect(transaction).rejects.toBe(failure);
    expect(events).toEqual([]);
  });

  it('serializes successful sibling operations even when submitted with Promise.all', async () => {
    const { coordinator } = await fixture();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const transaction = coordinator.withTenantTransaction(context => Promise.all([
      coordinator.perform(context, async () => {
        events.push('first-start');
        entered.resolve();
        await release.promise;
        events.push('first-end');
      }),
      coordinator.perform(context, () => { events.push('second-start'); }),
    ]));
    await entered.promise;
    expect(events).toEqual(['first-start']);
    release.resolve();
    await transaction;
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('does not report success after the callback catches a tracked failure', async () => {
    const { coordinator } = await fixture();
    const failure = new Error('caught by callback');
    await expect(coordinator.withTenantTransaction(async context => {
      try { await coordinator.perform(context, () => { throw failure; }); } catch { /* caller observed it */ }
      return 'success';
    })).rejects.toBe(failure);
  });

  it('keeps distinct coordinator contexts, expired handles, and user/root tokens separate', async () => {
    const { tenantRoot, coordinator, owner } = await fixture();
    const otherCoordinator = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => '22222222-2222-4222-8222-222222222222',
      fence: new FileMemoryFence(),
    });
    const legacy = await owner.readHeadSnapshot(LOCATOR);
    await expect(otherCoordinator.withTenantTransaction(context =>
      owner.readHeadSnapshotInTransaction(context, LOCATOR))).rejects.toMatchObject({ code: 'EWRONGLEASE' });
    let expired!: Parameters<typeof owner.readHeadSnapshotInTransaction>[0];
    await coordinator.withTenantTransaction(context => { expired = context; });
    expect(() => owner.readHeadSnapshotInTransaction(expired, LOCATOR))
      .toThrow('no longer open');
    await expect(otherCoordinator.withTenantTransaction(context =>
      otherCoordinator.perform(context, scope => {
        expect(scope.userId).not.toBe(legacy.token.userId);
      }))).resolves.toBeUndefined();
    const wrongUser = { ...legacy.token, userId: '22222222-2222-4222-8222-222222222222' };
    await expect(coordinator.withTenantTransaction(context =>
      owner.adoptUnownedInTransaction(context, wrongUser as UnownedFileMemoryToken)))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    const wrongRoot = { ...legacy.token, tenantRoot: `${tenantRoot}-other` };
    await expect(coordinator.withTenantTransaction(context =>
      owner.adoptUnownedInTransaction(context, wrongRoot as UnownedFileMemoryToken)))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(() => coordinator.perform({} as FileMemoryLeaseContext, () => 1))
      .toThrow('Invalid file-memory lease context');
  });

  it('captures one constructor-bound root and the entry user before asynchronous acquisition', async () => {
    const { tenantRoot } = await fixture();
    const anotherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-other-tenant-'));
    roots.push(anotherRoot);
    let currentUser = USER_ID;
    let resolverCalls = 0;
    const options = {
      tenantRoot,
      getCurrentUserId: () => { resolverCalls++; return currentUser; },
      fence: new FileMemoryFence(),
    };
    const coordinator = new FileMemoryTransactionCoordinator(options);
    const owner = new FileMemoryOwnerSnapshots({ coordinator });
    expect(() => new FileMemoryOwnerSnapshots({ coordinator, tenantRoot } as never))
      .toThrow('cannot override coordinator scope');
    const transaction = coordinator.withTenantTransaction(async context => {
      const first = await owner.readHeadSnapshotInTransaction(context, LOCATOR);
      const second = await owner.readHeadSnapshotInTransaction(context, LOCATOR);
      return [first.token, second.token];
    });
    currentUser = '22222222-2222-4222-8222-222222222222';
    options.tenantRoot = anotherRoot;
    const [first, second] = await transaction;
    expect(first.userId).toBe(USER_ID);
    expect(second.userId).toBe(USER_ID);
    expect(first.tenantRoot).toBe(await fs.realpath(tenantRoot));
    expect(second.tenantRoot).toBe(first.tenantRoot);
    expect(resolverCalls).toBe(1);
  });

  it('rejects nested transactions and nested store operations without deadlocking', async () => {
    const { tenantRoot, coordinator } = await fixture();
    const other = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => USER_ID, fence: new FileMemoryFence(),
    });
    await coordinator.withTenantTransaction(async context => {
      await expect(coordinator.withTenantTransaction(() => 1))
        .rejects.toMatchObject({ code: 'ENESTEDLEASE' });
      await expect(other.withTenantTransaction(() => 1))
        .rejects.toMatchObject({ code: 'ENESTEDLEASE' });
      await expect(coordinator.perform(context, () => {
        coordinator.perform(context, () => 1);
      })).rejects.toMatchObject({ code: 'ENESTEDOPERATION' });
    }).catch(error => expect(error).toMatchObject({ code: 'ENESTEDOPERATION' }));
  });

  it('drains an accepted operation when the callback throws and preserves both errors', async () => {
    const { coordinator } = await fixture();
    const entered = deferred();
    const release = deferred();
    const callbackError = new Error('callback failed');
    const operationError = new Error('operation failed');
    const transaction = coordinator.withTenantTransaction(async context => {
      void coordinator.perform(context, async () => {
        entered.resolve();
        await release.promise;
        throw operationError;
      });
      await entered.promise;
      throw callbackError;
    });
    await entered.promise;
    release.resolve();
    await expect(transaction).rejects.toMatchObject({
      cause: callbackError, errors: expect.arrayContaining([callbackError, operationError]),
    });
  });

  it('captures standalone adoption token before delayed lease acquisition', async () => {
    const { tenantRoot } = await fixture();
    const entered = deferred();
    const release = deferred();
    const realFence = new FileMemoryFence();
    const fence = {
      async withTenantFence<T>(root: string, operation: () => Promise<T> | T): Promise<T> {
        entered.resolve();
        await release.promise;
        return realFence.withTenantFence(root, operation);
      },
    };
    const coordinator = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => USER_ID, fence,
    });
    const owner = new FileMemoryOwnerSnapshots({ coordinator });
    const legacy = await owner.readHeadSnapshot(LOCATOR);
    const token = { ...legacy.token, fileIdentity: { ...legacy.token.fileIdentity } } as UnownedFileMemoryToken;
    const pending = owner.adoptUnowned(token);
    await entered.promise;
    (token as unknown as { locator: string }).locator = 'Other.yaml';
    (token.fileIdentity as unknown as { inode: string }).inode = '0';
    release.resolve();
    expect((await pending).locator).toBe(LOCATOR);
  });

  it('holds the tenant fence against another process', async () => {
    const { tenantRoot, coordinator } = await fixture();
    const script = `
      import { FileMemoryFence } from ${JSON.stringify(sourceUrl('FileMemoryFence'))};
      import { FileMemoryTransactionCoordinator } from ${JSON.stringify(sourceUrl('FileMemoryTransactionCoordinator'))};
      const root = process.argv[1];
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot: root, getCurrentUserId: () => ${JSON.stringify(USER_ID)}, fence: new FileMemoryFence(),
      });
      await coordinator.withTenantTransaction(async () => {
        process.stdout.write('LOCKED\\n');
        process.stdin.resume();
        await new Promise(resolve => process.stdin.once('end', resolve));
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, tenantRoot], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    await waitForOutput(child, 'LOCKED\n');
    const shortFence = new FileMemoryFence();
    await expect(shortFence.withTenantFence(tenantRoot, () => 1, { timeoutMs: 80 }))
      .rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    child.stdin.end();
    await expect(childExit(child)).resolves.toBe(0);
    await expect(coordinator.withTenantTransaction(() => 'after child')).resolves.toBe('after child');
  });

  it('does not emit an unhandled rejection for an ignored public store operation', async () => {
    const { tenantRoot } = await fixture();
    const script = `
      import { FileMemoryFence } from ${JSON.stringify(sourceUrl('FileMemoryFence'))};
      import { FileMemoryOwnerSnapshots } from ${JSON.stringify(sourceUrl('FileMemoryOwnerSnapshots'))};
      import { FileMemoryTransactionCoordinator } from ${JSON.stringify(sourceUrl('FileMemoryTransactionCoordinator'))};
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot: process.argv[1], getCurrentUserId: () => ${JSON.stringify(USER_ID)},
        fence: new FileMemoryFence(),
      });
      const owner = new FileMemoryOwnerSnapshots({ coordinator });
      const snapshot = await owner.readHeadSnapshot(${JSON.stringify(LOCATOR)});
      const wrong = { ...snapshot.token, userId: 'other-user' };
      try {
        await coordinator.withTenantTransaction(context => {
          void owner.adoptUnownedInTransaction(context, wrong);
          return 'ignored';
        });
        process.exitCode = 2;
      } catch (error) {
        if (error.code !== 'EHEADCONFLICT') throw error;
        process.stdout.write('TRACKED_FAILURE\\n');
      }
    `;
    const child = spawn(process.execPath, [
      '--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '--eval', script, tenantRoot,
    ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    await waitForOutput(child, 'TRACKED_FAILURE\n');
    await expect(childExit(child)).resolves.toBe(0);
  });
});
