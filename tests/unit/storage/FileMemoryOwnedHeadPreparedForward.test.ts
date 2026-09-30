import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import {
  FileMemoryOwnerSnapshots,
  type FinalizePublication,
  type UpdatePublication,
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
    duringUpdateMetadataStage: (stage, point) => pause(stage + ':' + point),
    afterUpdatePublication: phase => pause(phase),
    afterFinalizePublication: phase => pause(phase),
  });
  function pause(phase) {
      if (phase === stopPhase) {
        process.stdout.write('STOPPED\\n');
        process.stdin.resume();
        return new Promise(() => {});
      }
  }
  await store.forwardPreparedRenamedOwnedUpdate(JSON.parse(requestJson));
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

async function interrupted(stop: UpdatePublication = 'renamed-head') {
  const setup = await fixture();
  const writer = new FileMemoryOwnerSnapshots({
    coordinator: setup.coordinator,
    afterUpdatePublication: phase => {
      if (phase === stop) throw new Error('stopped before unlink');
    },
  });
  await expect(writer.updateOwnedHead(setup.owned, 'name: Updated\nentries: []\n'))
    .rejects.toMatchObject({ code: stop === 'prepared-journal' ? 'EOWNERRECOVERY' : 'EHEADCOMMITUNKNOWN' });
  const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { operationId: string };
  return { ...setup, request: { ...setup.request, operationId: journal.operationId } };
}

async function residualProof(setup: Awaited<ReturnType<typeof interrupted>>) {
  const directories = [path.dirname(setup.headPath), path.join(setup.tenantRoot, '.memory-owners', 'owners')];
  const proof = [];
  for (const directory of directories) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const stat = await fs.lstat(file, { bigint: true });
      proof.push({ name, directory, device: stat.dev, inode: stat.ino, mode: stat.mode, links: stat.nlink,
        size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
        bytes: stat.isSymbolicLink() ? await fs.readlink(file) : await fs.readFile(file) });
    }
  }
  return proof;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('dormant already-renamed PREPARED forward completion', () => {
  if (process.platform === 'win32') {
    it('requires POSIX owner and mode checks', () => {
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence(),
      });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }

  it.each(['renamed-head', 'published-journal', 'updated-registry', 'updated-sidecar'] as const)(
    'completes the ordered %s state under one operation', async stop => {
      const setup = await interrupted(stop);
      const result = await setup.store.forwardPreparedRenamedOwnedUpdate(setup.request);
      expect(result.status).toBe('known-committed');
      if (result.status !== 'known-committed') throw new Error('Missing commit');
      expect(result.token).toMatchObject({ revision: '2', ownerId: setup.owned.ownerId });
      expect((await setup.store.readHeadSnapshot(setup.locator)).token).toEqual(result.token);
      expect(await setup.store.forwardPreparedRenamedOwnedUpdate(setup.request))
        .toEqual({ status: 'already-clean-no-attribution' });
    });

  it('preserves uppercase owner UUID spelling through deterministic recovery stages', async () => {
    const setup = await fixture();
    const ownerId = setup.owned.ownerId.toUpperCase();
    const oldRegistry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
    const registry = path.join(path.dirname(oldRegistry), `${ownerId}.json`);
    const sidecar = setup.journalPath.replace('.memory-write.json', '.memory-owner.json');
    for (const file of [oldRegistry, sidecar]) {
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(file, JSON.stringify({ ...record, ownerId }));
    }
    await fs.rename(oldRegistry, path.join(setup.tenantRoot, 'owner-intermediate'));
    await fs.rename(path.join(setup.tenantRoot, 'owner-intermediate'), registry);
    const writer = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterUpdatePublication: phase => { if (phase === 'renamed-head') throw new Error('stop'); },
    });
    await expect(writer.updateOwnedHead({ ...setup.owned, ownerId }, 'name: Updated\nentries: []\n'))
      .rejects.toMatchObject({ code: 'EHEADCOMMITUNKNOWN' });
    const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { operationId: string };
    const result = await setup.store.forwardPreparedRenamedOwnedUpdate({ ...setup.request, ownerId, operationId: journal.operationId });
    expect(result.status).toBe('known-committed');
    expect((await setup.store.readHeadSnapshot(setup.locator)).token).toMatchObject({ ownerId, revision: '2' });
    expect(await fs.readdir(path.dirname(registry))).toEqual([`${ownerId}.json`]);
  });

  it('reuses the exact complete journal stage inode rather than rewriting it', async () => {
    const setup = await interrupted();
    const stagePath = `${setup.journalPath}.update-${setup.request.operationId}.tmp`;
    const stageStore = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      duringUpdateMetadataStage: (stage, point) => {
        if (stage === 'published-journal' && point === 'verified-before-rename') throw new Error('retain stage');
      },
    });
    await expect(stageStore.forwardPreparedRenamedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EHEADCOMMITUNKNOWN' });
    const staged = await fs.stat(stagePath, { bigint: true });
    const bytes = await fs.readFile(stagePath);
    const reuse = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterUpdatePublication: async phase => {
        if (phase !== 'published-journal') return;
        const published = await fs.stat(setup.journalPath, { bigint: true });
        expect(published.ino).toBe(staged.ino);
        expect(published.dev).toBe(staged.dev);
        expect(published.size).toBe(staged.size);
        expect(published.mtimeNs).toBe(staged.mtimeNs);
        expect(await fs.readFile(setup.journalPath)).toEqual(bytes);
      },
    });
    expect((await reuse.forwardPreparedRenamedOwnedUpdate(setup.request)).status).toBe('known-committed');
  });

  it('preserves PREPARED old-head and head-temp evidence without publication', async () => {
    const setup = await interrupted('prepared-journal');
    const before = await residualProof(setup);
    expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('prepared-not-published');
    await expect(setup.store.forwardPreparedRenamedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it.each(['before-stage', 'before-rename', 'after-rename'])(
    'rejects same-byte head replacement at %s', async point => {
      const setup = await interrupted();
      const replace = async () => {
        const bytes = await fs.readFile(setup.headPath);
        await fs.rename(setup.headPath, path.join(setup.tenantRoot, 'old-head-inode'));
        await fs.writeFile(setup.headPath, bytes);
      };
      if (point === 'before-stage') await replace();
      const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
        duringUpdateMetadataStage: async (stage, phase) => {
          if (point === 'before-rename' && stage === 'published-journal' && phase === 'verified-before-rename') await replace();
        },
        afterUpdatePublication: async phase => {
          if (point === 'after-rename' && phase === 'published-journal') await replace();
        },
      });
      await expect(store.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
    });

  it('rejects a same-byte journal replacement after its stage rename', async () => {
    const setup = await interrupted();
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterUpdatePublication: async phase => {
        if (phase !== 'published-journal') return;
        const bytes = await fs.readFile(setup.journalPath);
        await fs.rename(setup.journalPath, path.join(setup.tenantRoot, 'replaced-journal'));
        await fs.writeFile(setup.journalPath, bytes, { mode: 0o600 });
      },
    });
    await expect(store.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
  });

  it.each(['ownerId', 'operationId', 'locator'] as const)('rejects a wrong %s without mutation', async field => {
    const setup = await interrupted();
    const before = await fs.readFile(setup.journalPath);
    await expect(setup.store.forwardPreparedRenamedOwnedUpdate({ ...setup.request,
      [field]: field === 'locator' ? 'Notes/other.yaml' : randomUUID() })).rejects.toBeDefined();
    expect(await fs.readFile(setup.journalPath)).toEqual(before);
  });

  it.each(['name: [broken\nentries: []\n', 'name: Bad\ngatekeeper: invalid\nentries: []\n',
    'name: Bad\nmetadata:\n  gatekeeper:\n    externalRestrictions:\n      denyPatterns:\n        - Bash:rm *\nentries: []\n'])(
    'validates published source before metadata mutation: %s', async content => {
      const setup = await interrupted();
      await fs.writeFile(setup.headPath, content);
      const stat = await fs.stat(setup.headPath, { bigint: true });
      const identity = { device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
        ctimeNs: stat.ctimeNs.toString(), mtimeNs: stat.mtimeNs.toString() };
      const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(setup.journalPath, JSON.stringify({ ...journal,
        newContentHash: createHash('sha256').update(content).digest('hex'),
        preparedTempIdentity: identity }));
      const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
      const before = await fs.readFile(registry);
      await expect(setup.store.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EINVALIDHEAD' });
      expect(await fs.readFile(registry)).toEqual(before);
      expect(await fs.readFile(setup.headPath, 'utf8')).toBe(content);
    });

  it('rejects a same-byte stage inode replacement between proof and rename', async () => {
    const setup = await interrupted();
    const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
    const stagePath = `${setup.journalPath}.update-${setup.request.operationId}.tmp`;
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      duringUpdateMetadataStage: async (stage, point) => {
        if (stage !== 'published-journal' || point !== 'verified-before-rename') return;
        const bytes = await fs.readFile(stagePath);
        await fs.rename(stagePath, path.join(setup.tenantRoot, 'saved-stage'));
        await fs.writeFile(stagePath, bytes, { mode: 0o600 });
      },
    });
    const before = await fs.readFile(registry);
    await expect(store.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await fs.readFile(registry)).toEqual(before);
    expect((await fs.lstat(stagePath)).isFile()).toBe(true);
  });

  it.each(['partial', 'malformed', 'legacy', 'duplicate', 'case-alias', 'foreign', 'public-mode',
    'hardlink', 'symlink', 'wrong-order', 'registry-alias', 'wrong-owner', 'wrong-locator'])(
    'preserves %s residual evidence without advancing metadata', async kind => {
      const setup = await interrupted();
      const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
      const sidecar = setup.journalPath.replace('.memory-write.json', '.memory-owner.json');
      const stagePath = `${setup.journalPath}.update-${setup.request.operationId}.tmp`;
      const staging = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
        duringUpdateMetadataStage: (_stage, point) => {
          if (point === 'verified-before-rename') throw new Error('retain complete stage');
        },
      });
      await expect(staging.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EHEADCOMMITUNKNOWN', residual: true });
      if (kind === 'partial') await fs.writeFile(stagePath, '{');
      if (kind === 'malformed') await fs.writeFile(stagePath, '{}');
      if (['foreign', 'wrong-owner', 'wrong-locator'].includes(kind)) {
        const record = JSON.parse(await fs.readFile(stagePath, 'utf8')) as Record<string, unknown>;
        await fs.writeFile(stagePath, JSON.stringify({ ...record, [kind === 'foreign' ? 'userId' : kind === 'wrong-owner' ? 'ownerId' : 'locator']:
          kind === 'wrong-locator' ? 'Notes/other.yaml' : randomUUID() }));
      }
      if (kind === 'legacy') await fs.rename(stagePath, `${registry}.${randomUUID()}.tmp`);
      if (kind === 'duplicate') await fs.copyFile(stagePath, `${registry}.update-${randomUUID()}.tmp`);
      if (kind === 'case-alias') await fs.rename(stagePath, stagePath.replace('.update-', '.UPDATE-'));
      if (kind === 'public-mode') await fs.chmod(stagePath, 0o644);
      if (kind === 'hardlink') await fs.link(stagePath, path.join(setup.tenantRoot, 'linked-stage'));
      if (kind === 'symlink') {
        await fs.rename(stagePath, path.join(setup.tenantRoot, 'saved-stage'));
        await fs.symlink(path.join(setup.tenantRoot, 'saved-stage'), stagePath);
      }
      if (kind === 'wrong-order') {
        await fs.copyFile(stagePath, sidecar);
        await fs.unlink(stagePath);
      }
      if (kind === 'registry-alias') await fs.rename(registry, registry.replace('.json', '.JSON'));
      const watched = [kind === 'registry-alias' ? registry.replace('.json', '.JSON') : registry, sidecar, setup.journalPath];
      const before = await Promise.all(watched.map(async file => ({ bytes: await fs.readFile(file),
        stat: await fs.stat(file, { bigint: true }) })));
      const residual = await residualProof(setup);
      expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).not.toBe('clean-consistent');
      await expect(setup.store.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toBeDefined();
      expect(await residualProof(setup)).toEqual(residual);
      for (const [index, file] of watched.entries()) {
        expect(await fs.readFile(file)).toEqual(before[index].bytes);
        expect(await fs.stat(file, { bigint: true })).toEqual(before[index].stat);
      }
    });

  it.each(['updated-registry', 'updated-sidecar'] as const)(
    'rejects a same-byte published metadata replacement at %s', async stop => {
      const setup = await interrupted();
      const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
      const sidecar = setup.journalPath.replace('.memory-write.json', '.memory-owner.json');
      const target = stop === 'updated-registry' ? registry : sidecar;
      const failing = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
        afterUpdatePublication: async phase => {
          if (phase !== stop) return;
          const bytes = await fs.readFile(target);
          await fs.rename(target, path.join(setup.tenantRoot, 'replaced-record'));
          await fs.writeFile(target, bytes, { mode: 0o600 });
        },
      });
      await expect(failing.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
    });

  it.each(['stage', 'journal', 'head'])(
    'rejects an exact-named FIFO %s in a subprocess without blocking', async kind => {
      const setup = await interrupted();
      const fifoPath = kind === 'stage' ? `${setup.journalPath}.update-${setup.request.operationId}.tmp` :
        kind === 'journal' ? setup.journalPath : setup.headPath;
      if (kind !== 'stage') await fs.rename(fifoPath, path.join(setup.tenantRoot, 'saved-artifact'));
      execFileSync('mkfifo', [fifoPath]);
      const script = finalizeChild.replace('await store.forwardPreparedRenamedOwnedUpdate(JSON.parse(requestJson));',
        `try { await store.forwardPreparedRenamedOwnedUpdate(JSON.parse(requestJson)); process.exitCode = 2; }
        catch (error) { process.stdout.write(error.code); }`);
      const child = spawn(process.execPath, [
        ...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', script,
        setup.tenantRoot, USER, JSON.stringify(setup.request), 'no-stop',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('FIFO blocked reader')); }, 8000);
          child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
          child.once('exit', code => { clearTimeout(timeout); resolve(code); });
          child.once('error', error => { clearTimeout(timeout); reject(error); });
        });
        expect(code).toBe(0);
        expect(output).toBe(kind === 'head' ? 'EHEADCONFLICT' : 'EOWNERRECOVERY');
        expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });

  it.each([null, undefined, 'fault-value'])('types non-Error stage failure %s without losing its cause', async cause => {
    const setup = await interrupted();
    const failing = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      duringUpdateMetadataStage: (_stage, point) => { if (point === 'partial-write') throw cause; },
    });
    await expect(failing.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITUNKNOWN', residual: true, operationId: setup.request.operationId, cause,
    });
  });

  it('types a stage write failure as pending with its original cause', async () => {
    const setup = await interrupted();
    const cause = new Error('stage write interrupted');
    const failing = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      duringUpdateMetadataStage: (_stage, point) => { if (point === 'partial-write') throw cause; },
    });
    await expect(failing.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITUNKNOWN', residual: true, operationId: setup.request.operationId, cause,
    });
    expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
  });

  const permissionIt = process.getuid?.() === 0 ? it.skip : it;
  permissionIt('types a metadata rename failure as pending and preserves its stage', async () => {
    const setup = await interrupted();
    const directory = path.dirname(setup.journalPath);
    const failing = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      duringUpdateMetadataStage: async (_stage, point) => {
        if (point === 'verified-before-rename') await fs.chmod(directory, 0o500);
      },
    });
    try {
      await expect(failing.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({
        code: 'EHEADCOMMITUNKNOWN', operationId: setup.request.operationId, residual: true,
        cause: { code: 'EACCES' },
      });
    } finally { await fs.chmod(directory, 0o700); }
    expect((await fs.lstat(setup.journalPath)).isFile()).toBe(true);
    expect((await fs.lstat(`${setup.journalPath}.update-${setup.request.operationId}.tmp`)).isFile()).toBe(true);
  });

  it('rejects another captured tenant and changed fixed journal before journal rename', async () => {
    const setup = await interrupted();
    const foreign = new FileMemoryOwnerSnapshots({ coordinator: new FileMemoryTransactionCoordinator({
      tenantRoot: setup.tenantRoot, getCurrentUserId: () => 'foreign-user', fence: new FileMemoryFence(),
    }) });
    await expect(foreign.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const failing = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      duringUpdateMetadataStage: async (_stage, point) => {
        if (point !== 'verified-before-rename') return;
        const bytes = await fs.readFile(setup.journalPath);
        await fs.rename(setup.journalPath, path.join(setup.tenantRoot, 'saved-journal'));
        await fs.writeFile(setup.journalPath, bytes, { mode: 0o600 });
      },
    });
    await expect(failing.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it('keeps the token after outer fence release failure', async () => {
    const setup = await interrupted();
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: setup.tenantRoot,
      getCurrentUserId: () => USER,
      fence: { async withTenantFence<T>(_root: string, operation: () => Promise<T> | T): Promise<T> {
        await operation();
        throw new Error('lease release failed');
      } },
    });
    await expect(new FileMemoryOwnerSnapshots({ coordinator }).forwardPreparedRenamedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EHEADCOMMITTED', committed: true, token: { revision: '2' } });
  });

  it('keeps the token after optional post-unlink read failure', async () => {
    const setup = await interrupted();
    const failing = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterFinalizePublication: async phase => {
        if (phase === 'after-unlink') await fs.rename(setup.headPath, path.join(setup.tenantRoot, 'moved.yaml'));
      },
    });
    await expect(failing.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITTED', committed: true, token: { revision: '2' },
    });
  });

  it('retains the committed token through post-unlink hook failure', async () => {
    const setup = await interrupted();
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterFinalizePublication: phase => { if (phase === 'after-unlink') throw new Error('postcommit'); },
    });
    await expect(store.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITTED', committed: true, token: { revision: '2' },
    });
  });

  it.each([
    'writer:renamed-head', 'published-journal:partial-write', 'published-journal:verified-before-rename', 'published-journal',
    'active-registry:partial-write', 'active-registry:verified-before-rename', 'updated-registry',
    'active-sidecar:partial-write', 'active-sidecar:verified-before-rename', 'updated-sidecar',
    'before-unlink', 'after-unlink', 'after-read',
  ])('qualifies real SIGKILL at %s and restart evidence', async phase => {
    const setup = phase === 'writer:renamed-head' ? await fixture() : await interrupted();
    const childScript = phase === 'writer:renamed-head'
      ? finalizeChild.replace('await store.forwardPreparedRenamedOwnedUpdate(JSON.parse(requestJson));',
        `await store.updateOwnedHead(JSON.parse(requestJson), 'name: Updated\\nentries: []\\n');`) : finalizeChild;
    const child = spawn(process.execPath, [
      ...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', childScript,
      setup.tenantRoot, USER, JSON.stringify(phase === 'writer:renamed-head' ? setup.owned : setup.request),
      phase === 'writer:renamed-head' ? 'renamed-head' : phase,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        let errors = '';
        const timeout = setTimeout(() => reject(new Error(`Child did not reach ${phase}: ${errors}`)), 8000);
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
      if (phase === 'writer:renamed-head') {
        const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { operationId: string };
        setup.request.operationId = journal.operationId;
      }
      expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('blocked-by-fence');
      // Isolated test tenant: the sole child has exited and no writer remains.
      // This is test-only orphan handling, never a production cleanup protocol.
      await fs.rm(path.join(setup.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
      const sidecar = setup.journalPath.replace('.memory-write.json', '.memory-owner.json');
      const stagePath = `${phase.startsWith('published-journal:') ? setup.journalPath : (phase.startsWith('active-sidecar') ? sidecar : registry)}.update-${setup.request.operationId}.tmp`;
      const diagnostic = await setup.store.inspectInterruptedOwnedHead(setup.locator);
      if (phase.includes('partial-write')) {
        const bytes = await fs.readFile(stagePath);
        const stat = await fs.stat(stagePath, { bigint: true });
        expect(diagnostic.kind).toBe('unknown-manual-review');
        await expect(setup.store.forwardPreparedRenamedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
        expect(await fs.readFile(stagePath)).toEqual(bytes);
        expect(await fs.stat(stagePath, { bigint: true })).toEqual(stat);
      } else {
        if (phase.includes('verified-before-rename')) expect(diagnostic.kind).toBe('unknown-manual-review');
        const result = await setup.store.forwardPreparedRenamedOwnedUpdate(setup.request);
        expect(result.status).toBe(phase === 'after-unlink' || phase === 'after-read'
          ? 'already-clean-no-attribution' : 'known-committed');
        expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('clean-consistent');
        expect((await setup.store.readHeadSnapshot(setup.locator)).token).toMatchObject({ revision: '2' });
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
