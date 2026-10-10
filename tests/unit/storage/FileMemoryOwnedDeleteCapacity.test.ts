import { afterEach, beforeEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';
import { cleanupDirectoryReadObservers, observeDirectoryReads } from './fixtures/aggregateDirectoryReadObserver.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const RAW = 'entries: []\n';
const roots: string[] = [];
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
function bufferedProfile(count: number, nested: boolean, stop: string) {
  let started = 0, cpu = { user: 0, system: 0 }, unavailable = false, flushed = false;
  try { started = performance.now(); cpu = process.cpuUsage(); } catch { unavailable = true; }
  const samples: { phase: string; wallMs: number; userMicros: number; systemMicros: number; heapBytes: number }[] = [];
  return {
    mark(phase: string) {
      if (flushed || unavailable) return;
      try {
        if (samples.length >= 16) { unavailable = true; return; }
        const used = process.cpuUsage(cpu);
        samples.push({ phase, wallMs: performance.now() - started, userMicros: used.user,
          systemMicros: used.system, heapBytes: process.memoryUsage().heapUsed });
      } catch { unavailable = true; }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      try { process.stderr.write(`DELETE profile ${JSON.stringify({ count, nested, stop, unavailable, samples })}\n`); }
      catch { /* Measurements cannot replace an operation or assertion failure. */ }
    },
  };
}
let cleanupProfile: ReturnType<typeof bufferedProfile> | undefined;
function identity(stat: BigIntStats) {
  return { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mode: String(stat.mode),
    uid: String(stat.uid), links: String(stat.nlink), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}
type Evidence = { target: string; identity: ReturnType<typeof identity>; bytes?: Buffer };
async function capture(target: string): Promise<Evidence> {
  const stat = await fs.lstat(target, { bigint: true });
  return { target, identity: identity(stat), bytes: stat.isFile() ? await fs.readFile(target) : undefined };
}
async function verify(evidence: readonly Evidence[]) {
  const changed: string[] = [];
  for (const before of evidence) {
    const stat = await fs.lstat(before.target, { bigint: true });
    if (!isDeepStrictEqual(identity(stat), before.identity) ||
      (before.bytes && !(await fs.readFile(before.target)).equals(before.bytes))) changed.push(before.target);
  }
  expect(changed).toEqual([]);
}
async function treeEvidence(root: string): Promise<Evidence[]> {
  const result: Evidence[] = [];
  async function walk(target: string) {
    const value = await capture(target); result.push(value);
    if (!value.bytes) for (const name of (await fs.readdir(target)).sort()) await walk(path.join(target, name));
  }
  await walk(root); return result;
}

async function fixture(nested: boolean, count: number) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-capacity-')));
  roots.push(root);
  const locator = nested ? 'Notes/Memory.yaml' : 'Memory.yaml';
  await fs.mkdir(path.dirname(path.join(root, locator)), { recursive: true });
  await fs.writeFile(path.join(root, locator), RAW);
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const token = await owners.adoptUnowned((await owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
  const store = () => new FileMemoryVolumeStore({ coordinator, owners });
  const input = { minimumVolume: 1, rawContent: RAW, entryCount: 0, sealedAt: new Date('2026-10-01T00:00:00Z') };
  const receipt = await store().createExclusive(token, input);
  const foreignReceipt = await store().createExclusive(token, { ...input, minimumVolume: 2 });
  const owner = path.join(root, 'volumes', 'by-id', token.ownerId);
  const foreign = await treeEvidence(path.join(owner, `v${foreignReceipt.volume}`));
  const retained: Evidence[] = [];
  // Strict persistent fixture setup, not a claim about adoption throughput. Every
  // record binds the actual captured inode/bytes and uses the released ACTIVE format.
  for (let index = 0; index < count; index++) {
    const existing = path.posix.join(path.posix.dirname(locator), `Existing${index}.yaml`);
    const target = path.join(root, existing), ownerId = randomUUID();
    await fs.writeFile(target, RAW, { mode: 0o600 });
    const stat = await fs.lstat(target, { bigint: true });
    const record = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator: existing, revision: '1',
      contentHash: hash(RAW), fileIdentity: { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } });
    const sidecar = path.join(path.dirname(target), `.${hash(path.posix.basename(existing))}.memory-owner.json`);
    const registry = path.join(root, '.memory-owners', 'owners', `${ownerId}.json`);
    const archiveOwner = path.join(root, 'volumes', 'by-id', ownerId);
    await fs.writeFile(sidecar, record, { mode: 0o600 });
    await fs.writeFile(registry, record, { mode: 0o600 });
    await fs.mkdir(archiveOwner, { mode: 0o700 });
    retained.push(await capture(target), await capture(sidecar), await capture(registry), await capture(archiveOwner));
  }
  expect((await owners.readHeadSnapshot(path.posix.join(path.posix.dirname(locator), 'Existing0.yaml'))).token.ownership).toBe('owned');
  const namespaces = await Promise.all([path.dirname(path.join(root, locator)), path.join(root, '.memory-owners', 'owners'),
    path.join(root, 'volumes', 'by-id')].map(async target => ({ target, names: (await fs.readdir(target)).sort() })));
  return { root, locator, owners, token, store, receipt, owner, retained, foreign, namespaces,
    slot: path.join(owner, 'v1'), intent: path.join(owner, 'v1.cleanup.json') };
}

function phaseDiagnostic(count: number, nested: boolean, stop: string, lifecycleStarted?: () => number | undefined) {
  const started = performance.now();
  return (phase: string, counts: { attemptedReads: number; completedCensuses: number }) => {
    const lifecycle = lifecycleStarted?.();
    process.stderr.write(`DELETE phase ${JSON.stringify({ count, nested, stop, phase, elapsedMs: performance.now() - started,
      ...(lifecycle === undefined ? {} : { lifecycleElapsedMs: performance.now() - lifecycle }),
      node: process.version, pid: process.pid, ...counts })}\n`);
  };
}

afterEach(async () => {
  const profile = cleanupProfile; cleanupProfile = undefined;
  profile?.mark('cleanup-start');
  try {
    await cleanupDirectoryReadObservers(async () => {
      jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
    });
    profile?.mark('cleanup-end');
  } finally { profile?.mark('cleanup-finally'); profile?.flush(); }
});
describe('dormant head DELETE populated owner portfolios', () => {
  describe.each([100, 250, 1000].flatMap(count => [false, true].map(nested => [count, nested] as const)))(
    'retains all foreign owner evidence at %i existing owners, nested=%s', (count, nested) => {
      let f: Awaited<ReturnType<typeof fixture>>, archived: Evidence[], lifecycleStarted: number | undefined;
      let diagnostic: ReturnType<typeof phaseDiagnostic>, profile: ReturnType<typeof bufferedProfile>;
      beforeEach(async () => {
        profile = bufferedProfile(count, nested, 'fresh'); cleanupProfile = profile; profile.mark('setup-start');
        diagnostic = phaseDiagnostic(count, nested, 'fresh', () => lifecycleStarted);
        const setup = observeDirectoryReads(); let primary: { cause: unknown } | undefined;
        try { f = await fixture(nested, count); archived = await treeEvidence(f.owner); }
        catch (cause) { primary = { cause }; throw cause; }
        finally { setup.restore(primary); diagnostic('setup-complete', setup.measured); profile.mark('setup-end'); }
      }, 10000);
      it('completes fresh deletion and all preservation verification', async () => {
        const currentProfile = profile;
        try {
          lifecycleStarted = performance.now();
          currentProfile.mark('lifecycle-start');
          diagnostic('lifecycle-start', { attemptedReads: 0, completedCensuses: 0 });
          const reads = observeDirectoryReads(), started = performance.now();
          let result, primary: { cause: unknown } | undefined;
          try { result = await f.owners.deleteOwned({ operationId: randomUUID(), expectedToken: f.token }); }
          catch (cause) { primary = { cause }; throw cause; }
          finally { reads.restore(primary); diagnostic('operation-end', reads.measured); }
          expect(result.status).toBe('head-deleted');
          currentProfile.mark('operation-returned');
          expect(reads.measured.attemptedReads).toBeGreaterThan(0);
          expect(reads.measured.completedCensuses).toBeGreaterThan(0);
          expect(reads.measured.attemptedReads).toBeLessThanOrEqual(532480);
          console.info(JSON.stringify({ label: 'DELETE populated fixture', count, nested, operationMs: performance.now() - started, ...reads.measured }));
          currentProfile.mark('retained-verification-start');
          await verify(f.retained); currentProfile.mark('retained-verification-end');
          currentProfile.mark('archive-verification-start');
          await verify(archived); currentProfile.mark('archive-verification-end');
          currentProfile.mark('namespace-verification-start');
          const parent = path.dirname(path.join(f.root, f.locator));
          const sidecarName = `.${hash(path.posix.basename(f.locator))}.memory-owner.json`;
          for (const namespace of f.namespaces) {
            const expected = namespace.target === parent ? namespace.names.filter(name => name !== path.basename(f.locator) && name !== sidecarName) : namespace.names;
            expect((await fs.readdir(namespace.target)).sort()).toEqual(expected);
          }
          await expect(fs.lstat(path.join(f.root, f.locator))).rejects.toMatchObject({ code: 'ENOENT' });
          currentProfile.mark('namespace-verification-end');
          diagnostic('assertions-complete', reads.measured);
          currentProfile.mark('assertions-complete');
        } finally { currentProfile.mark('lifecycle-finally'); }
      }, 10000);
    });
  describe.each([[false, 'pair-durable'], [true, 'pair-durable'], [true, 'head-durable']] as const)(
    'retains populated recovery authority at 1,000 owners, nested=%s phase=%s', (nested, phase) => {
      let f: Awaited<ReturnType<typeof fixture>>, archived: Evidence[], lifecycleStarted: number | undefined;
      let diagnostic: ReturnType<typeof phaseDiagnostic>, profile: ReturnType<typeof bufferedProfile>;
      // Fixture construction and baseline capture remain serial, with a separate
      // explicit bound; all interruption, recovery and verification share one test.
      beforeEach(async () => {
        profile = bufferedProfile(1000, nested, phase); cleanupProfile = profile; profile.mark('setup-start');
        diagnostic = phaseDiagnostic(1000, nested, phase, () => lifecycleStarted);
        const setup = observeDirectoryReads(); let primary: { cause: unknown } | undefined;
        try { f = await fixture(nested, 1000); archived = await treeEvidence(f.owner); }
        catch (cause) { primary = { cause }; throw cause; }
        finally { setup.restore(primary); diagnostic('setup-complete', setup.measured); profile.mark('setup-end'); }
      }, 10000);
      it('completes interruption, recovery and all preservation verification', async () => {
        const currentProfile = profile;
        try {
          lifecycleStarted = performance.now();
          currentProfile.mark('lifecycle-start');
          diagnostic('lifecycle-start', { attemptedReads: 0, completedCensuses: 0 });
          let stop = true, reached = false; const cause = new Error('actual durable portfolio interruption');
          const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: f.root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
          const owners = new FileMemoryOwnerSnapshots({ coordinator, afterDeletePublication: current => { if (stop && current === phase) { reached = true; throw cause; } } });
          const request = { operationId: randomUUID(), expectedToken: f.token };
          const interruptedReads = observeDirectoryReads(); let interruptedFailure: { cause: unknown } | undefined;
          try { await expect(owners.deleteOwned(request)).rejects.toMatchObject({ cause }); }
          catch (cause) { interruptedFailure = { cause }; throw cause; }
          finally { interruptedReads.restore(interruptedFailure); diagnostic('interrupted-operation-end', interruptedReads.measured); }
          expect(reached).toBe(true); stop = false;
          currentProfile.mark('interruption-asserted');
          const reads = observeDirectoryReads(); let result, retryFailure: { cause: unknown } | undefined;
          try { result = await owners.deleteOwned(request); }
          catch (cause) { retryFailure = { cause }; throw cause; }
          finally { reads.restore(retryFailure); diagnostic('retry-end', reads.measured); }
          expect(result.status).toBe(phase === 'head-durable' ? 'already-head-deleted' : 'head-deleted');
          currentProfile.mark('retry-returned');
          if (phase === 'head-durable') expect(result.evidence).not.toHaveProperty('locator');
          expect(reads.measured.attemptedReads).toBeGreaterThan(0);
          expect(reads.measured.attemptedReads).toBeLessThanOrEqual(532480);
          currentProfile.mark('retained-verification-start');
          await verify(f.retained); currentProfile.mark('retained-verification-end');
          currentProfile.mark('archive-verification-start');
          await verify(archived); currentProfile.mark('archive-verification-end');
          currentProfile.mark('namespace-verification-start');
          for (const namespace of f.namespaces) {
            const parent = path.dirname(path.join(f.root, f.locator)), sidecar = `.${hash(path.posix.basename(f.locator))}.memory-owner.json`;
            const expected = namespace.target === parent ? namespace.names.filter(name => name !== path.basename(f.locator) && name !== sidecar) : namespace.names;
            expect((await fs.readdir(namespace.target)).sort()).toEqual(expected);
          }
          currentProfile.mark('namespace-verification-end');
          diagnostic('assertions-complete', reads.measured);
          currentProfile.mark('assertions-complete');
        } finally { currentProfile.mark('lifecycle-finally'); }
      }, 10000);
    });

});
