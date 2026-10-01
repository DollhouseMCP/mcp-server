/** Static test worker: real archive proof isolated from inherited Jest-worker contexts. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OwnedFileMemoryToken } from '../../../../src/storage/FileMemoryOwnerSnapshots.js';

const [fenceUrl, coordinatorUrl, ownersUrl, storeUrl, root, user] = process.argv.slice(2);
const { FileMemoryFence } = await import(fenceUrl);
const { FileMemoryTransactionCoordinator } = await import(coordinatorUrl);
const { FileMemoryOwnerSnapshots } = await import(ownersUrl);
const { FileMemoryVolumeStore } = await import(storeUrl);
const input = { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-09-29T00:00:00Z') };
async function run(): Promise<void> {
  const started = process.hrtime.bigint();
  const initialCpu = process.cpuUsage();
  let phase = 'fixture';
  let setupCompleted = 0;
  let collisionProofStarted = 0;
  let collisionProofCompleted = 0;
  let aliasScanCompleted = 0;
  let aliasScanMs = 0;
  let collisionProofMs = 0;
  let predicateCalls = 0;
  let predicateMs = 0;
  let legacyStoreSymbolCount: number | undefined;
  let inFlight: { kind: 'alias-scan' | 'collision-proof'; start: bigint } | undefined;
  const report = (resources = false) => {
    const cpu = process.cpuUsage(initialCpu);
    const usage = process.resourceUsage();
    // Parent validates and forwards these bounded records; never include paths or evidence.
    process.stdout.write(`${JSON.stringify({ diagnostic: 'archive-collision', phase,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      setupCompleted, collisionProofStarted, collisionProofCompleted, aliasScanCompleted, aliasScanMs, collisionProofMs,
      predicateCalls, predicateMs, legacyStoreSymbolCount, nodeVersion: process.version,
      inFlight: inFlight ? { kind: inFlight.kind, startMs: Number(inFlight.start - started) / 1e6,
        elapsedMs: Number(process.hrtime.bigint() - inFlight.start) / 1e6 } : null,
      ...(resources ? { cpuUserUs: cpu.user, cpuSystemUs: cpu.system,
        rssBytes: process.memoryUsage().rss, maxRssKiB: usage.maxRSS,
        fsRead: usage.fsRead, fsWrite: usage.fsWrite,
        voluntaryContextSwitches: usage.voluntaryContextSwitches,
        involuntaryContextSwitches: usage.involuntaryContextSwitches } : {}) })}\n`);
  };
  const milestone = (next: string) => { phase = next; report(); };
  // Observation only: this does not change the test timeout or establish host contention.
  const timer = setTimeout(() => report(true), 55000);
  let restore: (() => void) | undefined;
  try {
    report();
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => user, fence: new FileMemoryFence() });
    const owners = new FileMemoryOwnerSnapshots({ coordinator });
    const snapshot = await owners.readHeadSnapshot('ÜberNote.yaml');
    assert.equal(snapshot.token.ownership, 'owned');
    const token = snapshot.token as OwnedFileMemoryToken;
    const f = { store: new FileMemoryVolumeStore({ coordinator, owners }), token,
      ownerPath: path.join(root, 'volumes', 'by-id', token.ownerId) };
    milestone('first-publication');
    const first = await f.store.createExclusive(f.token, input);
    const source = path.join(f.ownerPath, 'v1');
    setupCompleted = 1;
    milestone('setup');
    for (let volume = 2; volume <= 1000; volume++) {
      const v = path.join(f.ownerPath, `v${volume}`);
      await fs.cp(source, v, { recursive: true, preserveTimestamps: false });
      const metadataPath = path.join(v, `g-${first.generationId}`, 'metadata.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      metadata.volume = volume;
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
      setupCompleted = volume;
      if (volume % 100 === 0) report();
    }
    // Test-only observation of the unchanged real private proof, without production hooks.
    const observed = f.store as unknown as {
      requireVolumeSpelling: (root: string, volume: number) => Promise<void>;
      requireCanonicalVolumeSpelling: (siblings: readonly string[], volume: number) => void;
      requireCommittedCollision: (...args: [string, OwnedFileMemoryToken, number, string]) => Promise<void>;
    };
    const descriptor = Object.getOwnPropertyDescriptor(observed, 'requireCommittedCollision');
    const aliasDescriptor = Object.getOwnPropertyDescriptor(observed, 'requireVolumeSpelling');
    const predicateDescriptor = Object.getOwnPropertyDescriptor(observed, 'requireCanonicalVolumeSpelling');
    const originalPredicate = observed.requireCanonicalVolumeSpelling;
    if (typeof originalPredicate !== 'function') throw new Error('Archive predicate diagnostic target is unavailable');
    const originalAlias = observed.requireVolumeSpelling;
    if (typeof originalAlias !== 'function') throw new Error('Archive alias diagnostic target is unavailable');
    const original = observed.requireCommittedCollision;
    if (typeof original !== 'function') throw new Error('Archive collision diagnostic target is unavailable');
    restore = () => {
      if (descriptor) Object.defineProperty(observed, 'requireCommittedCollision', descriptor);
      else delete (observed as Partial<typeof observed>).requireCommittedCollision;
      if (aliasDescriptor) Object.defineProperty(observed, 'requireVolumeSpelling', aliasDescriptor);
      else delete (observed as Partial<typeof observed>).requireVolumeSpelling;
      if (predicateDescriptor) Object.defineProperty(observed, 'requireCanonicalVolumeSpelling', predicateDescriptor);
      else delete (observed as Partial<typeof observed>).requireCanonicalVolumeSpelling;
    };
    Object.defineProperty(observed, 'requireCanonicalVolumeSpelling', { configurable: true, value: (...args: Parameters<typeof originalPredicate>) => {
      const span = process.hrtime.bigint();
      predicateCalls++;
      try { return originalPredicate.apply(f.store, args); }
      finally { predicateMs += Number(process.hrtime.bigint() - span) / 1e6; }
    } });
    Object.defineProperty(observed, 'requireVolumeSpelling', { configurable: true, value: async (...args: Parameters<typeof originalAlias>) => {
      const span = process.hrtime.bigint();
      inFlight = { kind: 'alias-scan', start: span };
      try {
        await originalAlias.apply(f.store, args);
        aliasScanCompleted++;
        aliasScanMs += Number(process.hrtime.bigint() - span) / 1e6;
      } finally { inFlight = undefined; }
    } });
    Object.defineProperty(observed, 'requireCommittedCollision', { configurable: true, value: async (...args: Parameters<typeof original>) => {
      const span = process.hrtime.bigint();
      inFlight = { kind: 'collision-proof', start: span };
      collisionProofStarted++;
      try {
        await original.apply(f.store, args);
        collisionProofCompleted++;
        collisionProofMs += Number(process.hrtime.bigint() - span) / 1e6;
        inFlight = undefined;
        if (collisionProofCompleted % 100 === 0) report();
      } finally { inFlight = undefined; }
    } });
    // Allocation phase includes namespace/alias scans before and between collision proofs.
    // Runtime-internal legacy ALS diagnostic only: not a public API or active-context count.
    // Inspect symbol descriptions only, never their stored values; modern runtimes may report zero.
    legacyStoreSymbolCount = Object.getOwnPropertySymbols(Promise.resolve(undefined))
      .filter(symbol => symbol.description === 'kResourceStore').length;
    milestone('probe');
    await assert.rejects(f.store.createExclusive(f.token, input), { code: 'EARCHIVEEXHAUSTED' });
    milestone('assertion');
    await assert.rejects(fs.stat(path.join(f.ownerPath, 'v1001')), { code: 'ENOENT' });
    milestone('done');
    assert.equal(aliasScanCompleted, 1000);
    assert.equal(collisionProofCompleted, 1000);
    assert.equal(predicateCalls, 1000);
    process.stdout.write(`${JSON.stringify({ result: 'archive-collision', code: 'EARCHIVEEXHAUSTED',
      setupCompleted, aliasScanCompleted, collisionProofCompleted, predicateCalls })}\n`);
  } finally {
    clearTimeout(timer);
    restore?.();
  }
}
try { await run(); }
catch {
  // Fixed failure signal; parent owns termination, result validation and fixture cleanup.
  process.stderr.write('Archive collision worker failed\n');
  process.exitCode = 1;
}
