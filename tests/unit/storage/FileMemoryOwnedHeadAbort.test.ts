import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';
import { FileMemoryOwnerSnapshots, type AbortPublication, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const moduleRoot = new URL('../../../src/storage/', import.meta.url);
const childScript = `
  import { FileMemoryOwnerSnapshots } from ${JSON.stringify(new URL(`FileMemoryOwnerSnapshots.${extension}`, moduleRoot).href)};
  import { FileMemoryTransactionCoordinator } from ${JSON.stringify(new URL(`FileMemoryTransactionCoordinator.${extension}`, moduleRoot).href)};
  import { FileMemoryFence } from ${JSON.stringify(new URL(`FileMemoryFence.${extension}`, moduleRoot).href)};
  const [tenantRoot, userId, requestJson, stopPhase] = process.argv.slice(1);
  const coordinator = new FileMemoryTransactionCoordinator({tenantRoot,getCurrentUserId:()=>userId,fence:new FileMemoryFence()});
  const store = new FileMemoryOwnerSnapshots({coordinator,afterAbortPublication:phase=>{
    if(phase===stopPhase){process.stdout.write('STOPPED\\n');process.stdin.resume();return new Promise(()=>{});}
  }});
  await store.abortPreparedOwnedUpdate(JSON.parse(requestJson));
`;

async function fixture(stop = 'prepared-journal', withArchive = false) {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-explicit-abort-'));
  roots.push(tenantRoot);
  const locator = 'Notes/ÜberNote.yaml';
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath));
  await fs.writeFile(headPath, 'name: Original\nentries: []\n');
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = new FileMemoryOwnerSnapshots({ coordinator });
  const legacy = await store.readHeadSnapshot(locator);
  const owned = await store.adoptUnowned(legacy.token as UnownedFileMemoryToken);
  const archiveFiles: string[] = [];
  if (withArchive) {
    const volumes = new FileMemoryVolumeStore({ coordinator, owners: store });
    const receipt = await volumes.createExclusive(owned, { minimumVolume: 1, rawContent: 'name: Archived\nentries: []\n',
      entryCount: 0, sealedAt: new Date('2026-10-01T00:00:00Z') });
    const volumePath = path.join(owned.tenantRoot, 'volumes', 'by-id', owned.ownerId, 'v1');
    const generation = path.join(volumePath, `g-${receipt.generationId}`);
    archiveFiles.push(volumePath, generation, path.join(volumePath, 'COMMITTED'),
      path.join(generation, 'payload.yaml'), path.join(generation, 'metadata.json'));
  }
  const writer = new FileMemoryOwnerSnapshots({ coordinator, afterUpdatePublication: phase => {
    if (phase === stop) throw new Error('interrupted update');
  } });
  await expect(writer.updateOwnedHead(owned, 'name: Updated\nentries: []\n')).rejects.toBeDefined();
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  const journalPath = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const request = { locator, ownerId: owned.ownerId, operationId: journal.operationId as string };
  const tempPath = path.join(path.dirname(headPath), journal.preparedTempName as string);
  const stagePath = `${journalPath}.abort-${request.operationId}.tmp`;
  const sidecarPath = journalPath.replace('.memory-write.json', '.memory-owner.json');
  const registryPath = path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`);
  // Committed/unindexed archive evidence is deliberately outside head-temp abort authority.
  const archivePath = path.join(tenantRoot, 'archive-evidence');
  await fs.writeFile(archivePath, 'committed archive remains unchanged', { mode: 0o600 });
  return { tenantRoot, locator, headPath, coordinator, store, owned, request, tempPath, stagePath,
    journalPath, sidecarPath, registryPath, archivePath, archiveFiles };
}
type Setup = Awaited<ReturnType<typeof fixture>>;

async function filesProof(files: string[]) {
  return Promise.all(files.map(async file => {
    const stat = await fs.lstat(file, { bigint: true });
    const bytes = stat.isSymbolicLink() ? await fs.readlink(file) : stat.isFile() ? await fs.readFile(file) : null;
    return { file, device: stat.dev, inode: stat.ino, size: stat.size, mode: stat.mode,
      links: stat.nlink, ctime: stat.ctimeNs, mtime: stat.mtimeNs, bytes };
  }));
}
async function unchangedProof(setup: Setup) {
  return filesProof([setup.headPath, setup.sidecarPath, setup.registryPath, setup.archivePath, ...setup.archiveFiles]);
}
async function residualProof(setup: Setup) {
  const directories = [path.dirname(setup.headPath), path.dirname(setup.registryPath)];
  const files: string[] = [setup.archivePath];
  for (const directory of directories) for (const name of (await fs.readdir(directory)).sort()) files.push(path.join(directory, name));
  return filesProof(files);
}
async function replaceSameBytes(file: string) {
  const raw = await fs.readFile(file);
  await fs.rename(file, `${file}.saved`);
  await fs.writeFile(file, raw, { mode: 0o600 });
}
async function pending(setup: Setup, phase: AbortPublication) {
  const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: current => {
    if (current === phase) throw new Error(`stopped at ${phase}`);
  } });
  await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toBeDefined();
}

afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('dormant explicit original PREPARED abort', () => {
  if (process.platform === 'win32') {
    it('retains the local POSIX restriction', () => {
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }

  it('aborts only the temp/journal, retains exact old triple and archives, and retries without attribution', async () => {
    const setup = await fixture('prepared-journal', true);
    const before = await unchangedProof(setup);
    const perform = jest.spyOn(setup.coordinator, 'perform');
    const result = await setup.store.abortPreparedOwnedUpdate(setup.request);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'known-aborted', receipt: { operationId: setup.request.operationId, token: setup.owned } });
    if (result.status !== 'known-aborted') throw new Error('expected known abort');
    expect(Object.isFrozen(result.receipt.token.fileIdentity)).toBe(true);
    expect(await unchangedProof(setup)).toEqual(before);
    await expect(fs.lstat(setup.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(setup.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await setup.store.abortPreparedOwnedUpdate(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });

  it.each(['ownerId', 'operationId', 'locator'] as const)('preserves all evidence for a wrong %s', async field => {
    const setup = await fixture();
    const before = await residualProof(setup);
    const request = { ...setup.request, [field]: field === 'locator' ? 'other.yaml' : randomUUID() };
    await expect(setup.store.abortPreparedOwnedUpdate(request)).rejects.toBeDefined();
    expect(await residualProof(setup)).toEqual(before);
  });

  it.each(['renamed-head', 'published-journal', 'updated-registry', 'updated-sidecar'])('does not abort %s', async phase => {
    const setup = await fixture(phase);
    const before = await residualProof(setup);
    await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it('does not reinterpret missing-temp PREPARED as an abort', async () => {
    const setup = await fixture();
    await fs.unlink(setup.tempPath);
    const before = await residualProof(setup);
    await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it.each(['partial-intent-stage', 'verified-intent-stage', 'after-intent-rename', 'after-temp-unlink'] as const)(
    'preserves interrupted %s and applies only exact next-stage retry', async phase => {
      const setup = await fixture();
      const old = await unchangedProof(setup);
      await pending(setup, phase);
      expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('unknown-manual-review');
      if (phase === 'partial-intent-stage') {
        const before = await residualProof(setup);
        await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
        expect(await residualProof(setup)).toEqual(before);
      } else expect((await setup.store.abortPreparedOwnedUpdate(setup.request)).status).toBe('known-aborted');
      expect(await unchangedProof(setup)).toEqual(old);
    });

  it.each(['headPath', 'tempPath', 'journalPath', 'sidecarPath', 'registryPath'] as const)(
    'rejects same-byte %s substitution at immediate intent rename barrier', async field => {
      const setup = await fixture();
      let afterReplacement: Awaited<ReturnType<typeof residualProof>>;
      const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: async phase => {
        if (phase === 'before-intent-rename') { await replaceSameBytes(setup[field]); afterReplacement = await residualProof(setup); }
      } });
      await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EABORTPENDING', residual: true });
      expect(await residualProof(setup)).toEqual(afterReplacement!);
    });

  it('rejects same-byte intent-stage replacement before rename', async () => {
    const setup = await fixture();
    let proof: Awaited<ReturnType<typeof residualProof>>;
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: async phase => {
      if (phase === 'verified-intent-stage') { await replaceSameBytes(setup.stagePath); proof = await residualProof(setup); }
    } });
    await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EABORTPENDING' });
    expect(await residualProof(setup)).toEqual(proof!);
  });

  it('rejects same-byte published intent replacement after rename', async () => {
    const setup = await fixture();
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: async phase => {
      if (phase === 'after-intent-rename') await replaceSameBytes(setup.journalPath);
    } });
    await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EABORTPENDING' });
    expect(await fs.readFile(setup.tempPath, 'utf8')).toContain('Updated');
  });

  it.each(['before-temp-unlink', 'before-journal-unlink'] as const)('rejects old metadata replacement at %s', async stop => {
    const setup = await fixture();
    let proof: Awaited<ReturnType<typeof residualProof>>;
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: async phase => {
      if (phase === stop) { await replaceSameBytes(setup.registryPath); proof = await residualProof(setup); }
    } });
    await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toBeDefined();
    expect(await residualProof(setup)).toEqual(proof!);
  });

  it.each(['foreign', 'alias', 'wrong-order', 'legacy', 'duplicate'])('preserves unexpected %s artifacts', async kind => {
    const setup = await fixture();
    const file = kind === 'alias' ? path.join(path.dirname(setup.journalPath), `${path.basename(setup.journalPath).toUpperCase()}.tmp`) : kind === 'wrong-order'
      ? `${setup.registryPath}.update-${setup.request.operationId}.tmp` : `${setup.journalPath}.${kind}.tmp`;
    await fs.writeFile(file, 'unbound evidence', { mode: 0o600 });
    const before = await residualProof(setup);
    await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(await residualProof(setup)).toEqual(before);
  });

  it.each(['public', 'hardlink', 'symlink', 'oversize'] as const)('rejects unsafe original temp %s without deleting it', async kind => {
    const setup = await fixture();
    if (kind === 'public') await fs.chmod(setup.tempPath, 0o644);
    else if (kind === 'hardlink') await fs.link(setup.tempPath, path.join(setup.tenantRoot, 'linked-temp'));
    else if (kind === 'symlink') {
      await fs.rename(setup.tempPath, path.join(setup.tenantRoot, 'saved-temp'));
      await fs.symlink(path.join(setup.tenantRoot, 'saved-temp'), setup.tempPath);
    } else await fs.writeFile(setup.tempPath, 'x'.repeat(1024 * 1024 * 4));
    const before = await residualProof(setup);
    await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toBeDefined();
    expect(await residualProof(setup)).toEqual(before);
  });

  it('rejects exact stage FIFO in a bounded subprocess', async () => {
    const setup = await fixture();
    execFileSync('mkfifo', [setup.stagePath]);
    await fs.chmod(setup.stagePath, 0o600);
    const script = childScript.replace('await store.abortPreparedOwnedUpdate(JSON.parse(requestJson));',
      `try { await store.abortPreparedOwnedUpdate(JSON.parse(requestJson)); process.exitCode=2; }
       catch(error){process.stdout.write(error.code);}`);
    const output = execFileSync(process.execPath, [
      ...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', script,
      setup.tenantRoot, USER, JSON.stringify(setup.request), 'no-stop',
    ], { timeout: 8000, encoding: 'utf8' });
    expect(output).toContain('EOWNERRECOVERY');
    expect((await fs.lstat(setup.stagePath)).isFIFO()).toBe(true);
    expect(await fs.readFile(setup.headPath, 'utf8')).toContain('Original');
  });

  it.each([null, undefined, new Error('hook-failure')])('preserves pending cause %s before commit', async cause => {
    const setup = await fixture();
    const before = await residualProof(setup);
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: phase => {
      if (phase === 'before-intent-stage') throw cause;
    } });
    await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EABORTPENDING', operationId: setup.request.operationId, residual: true, cause,
    });
    expect(await residualProof(setup)).toEqual(before);
  });

  it.each(['before-intent-rename', 'before-temp-unlink', 'before-journal-unlink'] as const)(
    'rechecks live authority at %s', async stop => {
      const setup = await fixture();
      const coordinator = setup.coordinator;
      const original = coordinator.requireActiveOperationScope.bind(coordinator);
      let revoked = false;
      jest.spyOn(coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
        if (revoked) throw new Error('operation authority revoked');
        return original(operation);
      });
      const store = new FileMemoryOwnerSnapshots({ coordinator, afterAbortPublication: phase => {
        if (phase === stop) revoked = true;
      } });
      await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toBeDefined();
      expect(await fs.readFile(setup.headPath, 'utf8')).toContain('Original');
      expect(await fs.readFile(setup.journalPath, 'utf8')).toBeDefined();
    });

  it('runs in the caller-owned lease with one tracked operation', async () => {
    const setup = await fixture();
    const perform = jest.spyOn(setup.coordinator, 'perform');
    const result = await setup.coordinator.withTenantTransaction(context => setup.store.abortPreparedOwnedUpdateInTransaction(context, setup.request));
    expect(result.status).toBe('known-aborted');
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('retains a known-aborted receipt after outer fence release failure', async () => {
    const setup = await fixture();
    const fence = new FileMemoryFence();
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: setup.tenantRoot, getCurrentUserId: () => USER,
      fence: { withTenantFence: (async (root, operation) => {
        await fence.withTenantFence(root, operation);
        throw new Error('release failed');
      }) as FileMemoryFence['withTenantFence'] } });
    const store = new FileMemoryOwnerSnapshots({ coordinator });
    await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
      code: 'EHEADABORTED', aborted: true, receipt: { operationId: setup.request.operationId, token: setup.owned },
    });
  });

  it.each(['after-journal-unlink', 'after-abort-read'] as const)('retains abort receipt after %s failure', async stop => {
    const setup = await fixture();
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: phase => {
      if (phase === stop) throw null;
    } });
    await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EHEADABORTED', aborted: true,
      receipt: { operationId: setup.request.operationId, token: { revision: '1' } }, cause: null });
    expect(await setup.store.abortPreparedOwnedUpdate(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });

  it('retains the receipt when the known-aborted audit event fails without leaking protected values', async () => {
    const setup = await fixture();
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(event => {
      expect(JSON.stringify(event)).not.toContain(setup.tenantRoot);
      expect(JSON.stringify(event)).not.toContain(setup.request.ownerId);
      expect(JSON.stringify(event)).not.toContain('entries:');
      if (event.additionalData?.outcome === 'known-aborted') throw new Error('audit unavailable');
    });
    await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EHEADABORTED', aborted: true });
    expect(audit).toHaveBeenCalled();
  });

  it.each(['known-aborted', 'pending-unknown', 'already-clean-no-attribution'] as const)(
    'records requested and %s outcomes through real same-window audit deduplication', async outcome => {
      const setup = await fixture();
      if (outcome === 'already-clean-no-attribution') await setup.store.abortPreparedOwnedUpdate(setup.request);
      SecurityMonitor.clearAllEventsForTesting();
      try {
        const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: phase => {
          if (outcome === 'pending-unknown' && phase === 'before-intent-stage') throw new Error('injected refusal');
        } });
        if (outcome === 'pending-unknown') {
          await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EABORTPENDING' });
        } else {
          expect((await store.abortPreparedOwnedUpdate(setup.request)).status).toBe(outcome);
        }
        const events = SecurityMonitor.getRecentEvents().filter(event => event.source === 'FileMemoryOwnerSnapshots.abort');
        expect(events.map(event => event.additionalData?.outcome)).toEqual(['requested', outcome]);
        expect(new Set(events.map(event => event.details)).size).toBe(2);
        expect(JSON.stringify(events)).not.toContain(setup.tenantRoot);
        expect(JSON.stringify(events)).not.toContain(setup.request.ownerId);
        expect(JSON.stringify(events)).not.toContain('entries:');
      } finally { SecurityMonitor.clearAllEventsForTesting(); }
    });

  it('records both distinct abort invocations without resetting the real monitor between them', async () => {
    const first = await fixture();
    const second = await fixture();
    SecurityMonitor.clearAllEventsForTesting();
    try {
      await first.store.abortPreparedOwnedUpdate(first.request);
      await second.store.abortPreparedOwnedUpdate(second.request);
      const events = SecurityMonitor.getRecentEvents().filter(event => event.source === 'FileMemoryOwnerSnapshots.abort');
      expect(events.map(event => event.additionalData?.outcome)).toEqual(['requested', 'known-aborted', 'requested', 'known-aborted']);
      expect(new Set(events.map(event => event.details)).size).toBe(4);
      const ids = events.map(event => event.details.match(/\(([0-9a-f-]{36})\)$/u)?.[1]);
      expect(ids[0]).toBeDefined();
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).toBe(ids[3]);
      expect(ids[0]).not.toBe(ids[2]);
    } finally { SecurityMonitor.clearAllEventsForTesting(); }
  });

  it.each(['after-journal-unlink', 'after-abort-read'] as const)(
    'records the known-aborted outcome before a later %s failure', async stop => {
      const setup = await fixture();
      SecurityMonitor.clearAllEventsForTesting();
      try {
        const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: phase => {
          if (phase === stop) throw new Error('later hook failed');
        } });
        await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EHEADABORTED', aborted: true });
        expect(SecurityMonitor.getRecentEvents().filter(event => event.source === 'FileMemoryOwnerSnapshots.abort')
          .map(event => event.additionalData?.outcome)).toEqual(['requested', 'known-aborted']);
      } finally { SecurityMonitor.clearAllEventsForTesting(); }
    });

  it.each(['sidecarPath', 'registryPath', 'authority'] as const)(
    'retains the original receipt after a nonthrowing real audit listener changes %s', async target => {
      const setup = await fixture();
      let revoked = false;
      let injected = false;
      const original = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
        if (revoked) throw new Error('listener revoked authority');
        return original(operation);
      });
      SecurityMonitor.clearAllEventsForTesting();
      const detach = SecurityMonitor.addLogListener(event => {
        if (event.source !== 'FileMemoryOwnerSnapshots.abort' || event.additionalData?.outcome !== 'known-aborted') return;
        injected = true;
        if (target === 'authority') revoked = true;
        else {
          const file = setup[target];
          const raw = syncFs.readFileSync(file);
          syncFs.renameSync(file, `${file}.saved`);
          syncFs.writeFileSync(file, raw, { mode: 0o600 });
          syncFs.unlinkSync(`${file}.saved`);
        }
      });
      try {
        await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
          code: 'EHEADABORTED', aborted: true, receipt: { operationId: setup.request.operationId, token: setup.owned },
        });
        expect(injected).toBe(true);
      } finally { detach(); SecurityMonitor.clearAllEventsForTesting(); }
    });

  it.each(['headPath', 'sidecarPath', 'registryPath', 'authority'] as const)(
    'refuses clean attribution after a nonthrowing real audit listener changes %s', async target => {
      const setup = await fixture();
      await setup.store.abortPreparedOwnedUpdate(setup.request);
      let revoked = false;
      let injected = false;
      const original = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
        if (revoked) throw new Error('listener revoked authority');
        return original(operation);
      });
      SecurityMonitor.clearAllEventsForTesting();
      const detach = SecurityMonitor.addLogListener(event => {
        if (event.source !== 'FileMemoryOwnerSnapshots.abort' || event.additionalData?.outcome !== 'already-clean-no-attribution') return;
        injected = true;
        if (target === 'authority') revoked = true;
        else {
          const file = setup[target];
          const raw = syncFs.readFileSync(file);
          syncFs.renameSync(file, `${file}.saved`);
          syncFs.writeFileSync(file, raw, { mode: 0o600 });
          syncFs.unlinkSync(`${file}.saved`);
        }
      });
      try {
        const attempt = setup.store.abortPreparedOwnedUpdate(setup.request);
        await expect(attempt).rejects.toMatchObject({ code: target === 'authority' ? 'EABORTPENDING' : 'EOWNERRECOVERY' });
        await expect(attempt).rejects.not.toHaveProperty('receipt');
        await expect(attempt).rejects.not.toHaveProperty('aborted');
        expect(injected).toBe(true);
      } finally { detach(); SecurityMonitor.clearAllEventsForTesting(); }
    });

  it.each((['after-journal-unlink', 'after-abort-read'] as const).flatMap(stop =>
    (['headPath', 'sidecarPath', 'registryPath'] as const).map(file => ({ stop, file }))))(
    'retains the original receipt after nonthrowing $file replacement at $stop', async ({ stop, file }) => {
      const setup = await fixture();
      const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: async phase => {
        if (phase === stop) {
          await replaceSameBytes(setup[file]);
          // Isolate descriptor replacement from the unrelated-artifact rejection.
          await fs.unlink(`${setup[file]}.saved`);
        }
      } });
      await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
        code: 'EHEADABORTED', aborted: true, receipt: { operationId: setup.request.operationId, token: setup.owned },
      });
      await expect(fs.lstat(setup.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(setup.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it.each(['after-journal-unlink', 'after-abort-read'] as const)(
    'retains the original receipt after nonthrowing authority revocation at %s', async stop => {
      const setup = await fixture();
      const original = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
      let revoked = false;
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
        if (revoked) throw new Error('operation authority revoked');
        return original(operation);
      });
      const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: phase => {
        if (phase === stop) revoked = true;
      } });
      await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
        code: 'EHEADABORTED', aborted: true, receipt: { operationId: setup.request.operationId, token: setup.owned },
      });
    });

  const permissionIt = process.getuid?.() === 0 ? it.skip : it;
  permissionIt.each(['before-intent-stage', 'before-intent-rename', 'before-temp-unlink', 'before-journal-unlink'] as const)(
    'types real permission refusal at %s and permits later exact retry', async stop => {
      const setup = await fixture();
      const directory = path.dirname(setup.headPath);
      const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAbortPublication: async phase => {
        if (phase === stop) await fs.chmod(directory, 0o500);
      } });
      try {
        await expect(store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({
          code: stop === 'before-journal-unlink' ? 'EABORTCOMMITUNKNOWN' : 'EABORTPENDING', residual: true,
          operationId: setup.request.operationId, cause: { code: 'EACCES' },
        });
      } finally { await fs.chmod(directory, 0o700); }
      expect((await setup.store.abortPreparedOwnedUpdate(setup.request)).status).toBe('known-aborted');
    });

  it.each(['before-intent-stage', 'partial-intent-stage', 'verified-intent-stage', 'before-intent-rename',
    'after-intent-rename', 'before-temp-unlink', 'after-temp-unlink', 'before-journal-unlink',
    'after-journal-unlink', 'after-abort-read'] as const)('qualifies real SIGKILL at %s with fresh orphan-handled retry', async stop => {
    const setup = await fixture();
    const old = await unchangedProof(setup);
    const child = spawn(process.execPath, [
      ...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', childScript,
      setup.tenantRoot, USER, JSON.stringify(setup.request), stop,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        let errors = '';
        const timer = setTimeout(() => reject(new Error(`Child missed ${stop}: ${errors}`)), 8000);
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
          if (output.includes('STOPPED\n')) { clearTimeout(timer); resolve(); }
        });
        child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${errors}`)); });
      });
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('blocked-by-fence');
      // Only this isolated test tenant's sole writer exited. Never production orphan cleanup.
      await fs.rm(path.join(setup.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      const diagnostic = await setup.store.inspectInterruptedOwnedHead(setup.locator);
      if (stop === 'partial-intent-stage') {
        const before = await residualProof(setup);
        expect(diagnostic.kind).toBe('unknown-manual-review');
        await expect(setup.store.abortPreparedOwnedUpdate(setup.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
        expect(await residualProof(setup)).toEqual(before);
      } else {
        const result = await setup.store.abortPreparedOwnedUpdate(setup.request);
        expect(result.status).toBe(stop === 'after-journal-unlink' || stop === 'after-abort-read'
          ? 'already-clean-no-attribution' : 'known-aborted');
        expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('clean-consistent');
      }
      expect(await unchangedProof(setup)).toEqual(old);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
