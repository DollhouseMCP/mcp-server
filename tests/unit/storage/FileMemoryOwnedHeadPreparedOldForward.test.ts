import { afterEach, describe, expect, it, jest } from '@jest/globals';
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
    beforePreparedHeadRename: () => pause('before-head-rename'),
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
  await store.forwardPreparedOwnedUpdate(JSON.parse(requestJson));
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

async function interrupted(stop: UpdatePublication = 'prepared-journal') {
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

describe('dormant original old-head PREPARED forward completion', () => {
  if (process.platform === 'win32') {
    it('requires POSIX owner and mode checks', () => {
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence(),
      });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }

  it.each(['prepared-journal', 'renamed-head', 'published-journal', 'updated-registry', 'updated-sidecar'] as const)(
    'completes %s in one tracked operation and retries without attribution', async stop => {
      const setup = await interrupted(stop);
      const result = await setup.store.forwardPreparedOwnedUpdate(setup.request);
      expect(result.status).toBe('known-committed');
      if (result.status !== 'known-committed') throw new Error('Missing commit');
      expect(result.token).toMatchObject({ revision: '2', ownerId: setup.owned.ownerId });
      expect((await setup.store.readHeadSnapshot(setup.locator)).token).toEqual(result.token);
      expect(await setup.store.forwardPreparedOwnedUpdate(setup.request))
        .toEqual({ status: 'already-clean-no-attribution' });
    });

  it('does not broaden the already-renamed API to publish an old head', async () => {
    const setup = await interrupted();
    const before = await residualProof(setup);
    await expect(setup.store.forwardPreparedRenamedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it.each(['ownerId', 'operationId'] as const)('rejects wrong request %s without writes', async field => {
    const setup = await interrupted();
    const before = await residualProof(setup);
    const wrong = { ...setup.request, [field]: randomUUID() };
    await expect(setup.store.forwardPreparedOwnedUpdate(wrong)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it('rejects a foreign locator bound inside the fixed journal', async () => {
    const setup = await interrupted();
    const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as Record<string, unknown>;
    journal.locator = 'Notes/Other.yaml';
    await fs.writeFile(setup.journalPath, JSON.stringify(journal), { mode: 0o600 });
    const before = await residualProof(setup);
    await expect(setup.store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it.each(['head', 'temp'] as const)('rejects same-byte %s inode replacement before recovery', async target => {
    const setup = await interrupted();
    const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { preparedTempName: string };
    const file = target === 'head' ? setup.headPath : path.join(path.dirname(setup.headPath), journal.preparedTempName);
    const bytes = await fs.readFile(file);
    await fs.rename(file, `${file}.prior`);
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const before = await residualProof(setup);
    await expect(setup.store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it('rejects original-temp ABA at the immediate rename barrier', async () => {
    const setup = await interrupted();
    let residual: Awaited<ReturnType<typeof residualProof>> | undefined;
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      beforePreparedHeadRename: async () => {
        const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { preparedTempName: string };
        const file = path.join(path.dirname(setup.headPath), journal.preparedTempName);
        const bytes = await fs.readFile(file);
        await fs.rename(file, `${file}.prior`);
        await fs.writeFile(file, bytes, { mode: 0o600 });
        residual = await residualProof(setup);
      },
    });
    await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(residual);
    expect(await fs.readFile(setup.headPath, 'utf8')).toBe('name: Original\nentries: []\n');
  });

  it.each(['registry', 'sidecar', 'journal', 'foreign'] as const)(
    'preserves forbidden old-head %s stage', async target => {
      const setup = await interrupted();
      const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
      const sidecar = setup.journalPath.replace('.memory-write.json', '.memory-owner.json');
      const source = target === 'registry' ? registry : target === 'sidecar' ? sidecar : setup.journalPath;
      const stage = target === 'foreign' ? `${setup.journalPath}.update-${randomUUID()}.tmp`
        : `${source}.update-${setup.request.operationId}.tmp`;
      await fs.writeFile(stage, await fs.readFile(source), { mode: 0o600 });
      const before = await residualProof(setup);
      expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('unknown-manual-review');
      await expect(setup.store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      expect(await residualProof(setup)).toEqual(before);
    });

  it.each(['head', 'registry', 'sidecar'] as const)('rejects %s substitution at the head-rename barrier', async target => {
    const setup = await interrupted();
    let residual: Awaited<ReturnType<typeof residualProof>> | undefined;
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      beforePreparedHeadRename: async () => {
        const registry = path.join(setup.tenantRoot, '.memory-owners', 'owners', `${setup.owned.ownerId}.json`);
        const file = target === 'head' ? setup.headPath : target === 'registry' ? registry
          : setup.journalPath.replace('.memory-write.json', '.memory-owner.json');
        const bytes = await fs.readFile(file);
        await fs.rename(file, `${file}.prior`);
        await fs.writeFile(file, bytes, { mode: 0o600 });
        residual = await residualProof(setup);
      },
    });
    await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(residual);
  });

  it.each(['name: [broken\nentries: []\n', 'name: Bad\ngatekeeper: invalid\nentries: []\n',
    'name: Bad\nmetadata:\n  gatekeeper:\n    externalRestrictions:\n      denyPatterns:\n        - Bash:rm *\nentries: []\n'])(
    'validates bound original temp bytes before publication: %s', async content => {
      const setup = await interrupted();
      const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as Record<string, unknown>;
      const temp = path.join(path.dirname(setup.headPath), journal.preparedTempName as string);
      await fs.writeFile(temp, content);
      const stat = await fs.stat(temp, { bigint: true });
      await fs.writeFile(setup.journalPath, JSON.stringify({ ...journal,
        newContentHash: createHash('sha256').update(content).digest('hex'),
        preparedTempIdentity: { device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
          ctimeNs: stat.ctimeNs.toString(), mtimeNs: stat.mtimeNs.toString() } }));
      const before = await residualProof(setup);
      await expect(setup.store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EINVALIDHEAD' });
      expect(await residualProof(setup)).toEqual(before);
    });

  it('rejects another captured tenant without publication', async () => {
    const setup = await interrupted();
    const before = await residualProof(setup);
    const foreign = new FileMemoryOwnerSnapshots({ coordinator: new FileMemoryTransactionCoordinator({
      tenantRoot: setup.tenantRoot, getCurrentUserId: () => 'foreign-user', fence: new FileMemoryFence(),
    }) });
    await expect(foreign.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it('preserves renamed pending evidence after callback failure and resumes', async () => {
    const setup = await interrupted();
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterUpdatePublication: phase => { if (phase === 'renamed-head') throw new Error('after rename'); },
    });
    await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITUNKNOWN', operationId: setup.request.operationId, residual: true,
    });
    expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('renamed-before-published-journal');
    expect((await setup.store.forwardPreparedOwnedUpdate(setup.request)).status).toBe('known-committed');
  });

  it.each(['before-head', 'after-head'] as const)('rechecks tracked authority at %s barrier', async boundary => {
    const setup = await interrupted();
    let revoked = false;
    const requireScope = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
    jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
      if (revoked) throw Object.assign(new Error('revoked test authority'), { code: 'EINVALIDOPERATION' });
      return requireScope(operation);
    });
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      beforePreparedHeadRename: () => { if (boundary === 'before-head') revoked = true; },
      afterUpdatePublication: phase => { if (phase === 'renamed-head' && boundary === 'after-head') revoked = true; },
    });
    await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITUNKNOWN', residual: true, operationId: setup.request.operationId,
      cause: { code: 'EINVALIDOPERATION' },
    });
    revoked = false;
    expect(await fs.readFile(setup.headPath, 'utf8')).toBe(boundary === 'before-head'
      ? 'name: Original\nentries: []\n' : 'name: Updated\nentries: []\n');
    expect((await setup.store.forwardPreparedOwnedUpdate(setup.request)).status).toBe('known-committed');
  });

  it('rejects same-byte head replacement after the temp rename', async () => {
    const setup = await interrupted();
    let residual: Awaited<ReturnType<typeof residualProof>> | undefined;
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterUpdatePublication: async phase => {
        if (phase !== 'renamed-head') return;
        const bytes = await fs.readFile(setup.headPath);
        await fs.rename(setup.headPath, `${setup.headPath}.prior`);
        await fs.writeFile(setup.headPath, bytes, { mode: 0o600 });
        residual = await residualProof(setup);
      },
    });
    await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(residual);
  });

  it.each(['public-mode', 'hardlink', 'symlink'] as const)('preserves unsafe original temp %s', async kind => {
    const setup = await interrupted();
    const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { preparedTempName: string };
    const temp = path.join(path.dirname(setup.headPath), journal.preparedTempName);
    if (kind === 'public-mode') await fs.chmod(temp, 0o644);
    if (kind === 'hardlink') await fs.link(temp, path.join(setup.tenantRoot, 'linked-temp'));
    if (kind === 'symlink') {
      const saved = path.join(setup.tenantRoot, 'saved-temp');
      await fs.rename(temp, saved);
      await fs.symlink(saved, temp);
    }
    const before = await residualProof(setup);
    await expect(setup.store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: { symlink: 'EHEADCOMMITUNKNOWN', hardlink: 'EINVALIDHEAD', 'public-mode': 'EOWNERRECOVERY' }[kind],
    });
    expect(await residualProof(setup)).toEqual(before);
  });

  it('keeps the committed token after outer fence release failure', async () => {
    const setup = await interrupted();
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: setup.tenantRoot,
      getCurrentUserId: () => USER,
      fence: { async withTenantFence<T>(_root: string, operation: () => Promise<T> | T): Promise<T> {
        await operation();
        throw new Error('lease release failed');
      } },
    });
    await expect(new FileMemoryOwnerSnapshots({ coordinator }).forwardPreparedOwnedUpdate(setup.request))
      .rejects.toMatchObject({ code: 'EHEADCOMMITTED', committed: true, token: { revision: '2' } });
  });

  it('rejects an exact original-temp FIFO without blocking a subprocess', async () => {
    const setup = await interrupted();
    const journal = JSON.parse(await fs.readFile(setup.journalPath, 'utf8')) as { preparedTempName: string };
    const temp = path.join(path.dirname(setup.headPath), journal.preparedTempName);
    await fs.rename(temp, path.join(setup.tenantRoot, 'saved-temp'));
    execFileSync('mkfifo', [temp]);
    await fs.chmod(temp, 0o600);
    const script = finalizeChild.replace('await store.forwardPreparedOwnedUpdate(JSON.parse(requestJson));',
      `try { await store.forwardPreparedOwnedUpdate(JSON.parse(requestJson)); process.exitCode = 2; }
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
      expect(output).toBe('EINVALIDHEAD');
      expect((await fs.lstat(temp)).isFIFO()).toBe(true);
      expect(await fs.readFile(setup.headPath, 'utf8')).toBe('name: Original\nentries: []\n');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  const permissionIt = process.getuid?.() === 0 ? it.skip : it;
  permissionIt('types the actual original-temp rename failure and permits a later retry', async () => {
    const setup = await interrupted();
    const directory = path.dirname(setup.headPath);
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      beforePreparedHeadRename: () => fs.chmod(directory, 0o500),
    });
    try {
      await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
        code: 'EHEADCOMMITUNKNOWN', residual: true, operationId: setup.request.operationId,
        cause: { code: 'EACCES' },
      });
      expect(await fs.readFile(setup.headPath, 'utf8')).toBe('name: Original\nentries: []\n');
    } finally { await fs.chmod(directory, 0o700); }
    expect((await setup.store.forwardPreparedOwnedUpdate(setup.request)).status).toBe('known-committed');
  });

  it.each([null, undefined, new Error('runtime')])('retains typed pending evidence for hook cause %s', async cause => {
    const setup = await interrupted();
    const before = await residualProof(setup);
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      beforePreparedHeadRename: () => { throw cause; },
    });
    await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITUNKNOWN', operationId: setup.request.operationId,
    });
    expect(await residualProof(setup)).toEqual(before);
  });

  it('keeps the committed token after post-unlink hook failure', async () => {
    const setup = await interrupted();
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator,
      afterFinalizePublication: phase => { if (phase === 'after-unlink') throw new Error('postcommit'); },
    });
    await expect(store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADCOMMITTED', committed: true, token: { revision: '2' },
    });
  });

  it.each([
    'writer:prepared-journal', 'before-head-rename', 'renamed-head', 'published-journal:partial-write', 'published-journal:verified-before-rename', 'published-journal',
    'active-registry:partial-write', 'active-registry:verified-before-rename', 'updated-registry',
    'active-sidecar:partial-write', 'active-sidecar:verified-before-rename', 'updated-sidecar',
    'before-unlink', 'after-unlink', 'after-read',
  ])('qualifies real SIGKILL at %s and restart evidence', async phase => {
    const setup = phase === 'writer:prepared-journal' ? await fixture() : await interrupted();
    const childScript = phase === 'writer:prepared-journal'
      ? finalizeChild.replace('await store.forwardPreparedOwnedUpdate(JSON.parse(requestJson));',
        `await store.updateOwnedHead(JSON.parse(requestJson), 'name: Updated\\nentries: []\\n');`) : finalizeChild;
    const child = spawn(process.execPath, [
      ...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', childScript,
      setup.tenantRoot, USER, JSON.stringify(phase === 'writer:prepared-journal' ? setup.owned : setup.request),
      phase === 'writer:prepared-journal' ? 'prepared-journal' : phase,
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
      if (phase === 'writer:prepared-journal') {
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
        await expect(setup.store.forwardPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
        expect(await fs.readFile(stagePath)).toEqual(bytes);
        expect(await fs.stat(stagePath, { bigint: true })).toEqual(stat);
      } else {
        if (phase.includes('verified-before-rename')) expect(diagnostic.kind).toBe('unknown-manual-review');
        const result = await setup.store.forwardPreparedOwnedUpdate(setup.request);
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
