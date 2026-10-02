import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { deepStrictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileMemoryOwnerSnapshots, type RenamePublication, type RenameOwnedRequest, type UnownedFileMemoryToken, type FileMemorySnapshot } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { Dir, type Dirent, type BigIntStats } from 'node:fs';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';
import { FileMemoryOwnedRename, captureRenameRequest } from '../../../src/storage/FileMemoryOwnedRename.js';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';

const USER = '11111111-1111-4111-8111-111111111111';
const CONTENT = 'name: Original\nentries: []\n';
const roots: string[] = [];
async function evidence(target: string) {
  const stat = await fs.lstat(target, { bigint: true });
  return { bytes: stat.isFile() ? await fs.readFile(target) : undefined,
    identity: stat.isDirectory() ? [stat.dev, stat.ino, stat.mode, stat.uid] : [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink] };
}
async function fixture(nested = false) {
  const supplied = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-owned-rename-'));
  roots.push(supplied); const root = await fs.realpath(supplied);
  const sourceLocator = nested ? 'Notes/Original.yaml' : 'Original.yaml', destinationLocator = nested ? 'Notes/Renamed.yaml' : 'Renamed.yaml';
  await fs.mkdir(path.dirname(path.join(root, sourceLocator)), { recursive: true });
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = (hook?: (phase: RenamePublication) => void | Promise<void>) => new FileMemoryOwnerSnapshots({ coordinator, afterRenamePublication: hook });
  const token = await store().createOwned({ operationId: randomUUID(), locator: sourceLocator, content: CONTENT });
  const request: RenameOwnedRequest = { operationId: randomUUID(), expectedToken: token, destinationLocator };
  const source = path.join(root, sourceLocator), destination = path.join(root, destinationLocator);
  const journal = (target: string) => path.join(path.dirname(target), `.${createHash('sha256').update(path.basename(target)).digest('hex')}.memory-write.json`);
  const foreign = path.join(root, 'Unrelated.yaml'); await fs.writeFile(foreign, 'foreign content', { mode: 0o600 });
  return { root, token, request, store, coordinator, source, destination, foreign, sourceJournal: journal(source), destinationJournal: journal(destination) };
}
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('dormant same-parent managed RENAME', () => {
  if (process.platform === 'win32') {
    it('retains the POSIX-only owner-store boundary', () => {
      expect(() => new FileMemoryOwnerSnapshots({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() })).toThrow('requires POSIX');
    }); return;
  }
  it.each([false, true])('preserves owner/content/inode and increments revision nested=%s', async nested => {
    const f = await fixture(nested), before = await fs.lstat(f.source, { bigint: true }), foreign = await evidence(f.foreign);
    const admission = FileMemoryOwnedRename.prototype as unknown as { reserve: () => void };
    const reserve = admission.reserve;
    let checkedQuota = false;
    jest.spyOn(admission, 'reserve').mockImplementation(function (this: typeof admission) {
      const budget = (this as unknown as { budget: { consumed: number; limit: number; weights: Map<string, number> } }).budget;
      const discovery = budget.consumed;
      reserve.call(this);
      const weights = budget.weights, P = [...weights.values()].reduce((sum, value) => sum + value, 0);
      const headRoles = nested ? ['Notes', '.'] : ['.'], registryRoles = ['.memory-owners/owners', '.memory-owners'];
      expect(headRoles.some(role => registryRoles.includes(role))).toBe(false);
      const weight = (roles: string[]) => roles.reduce((sum, role) => sum + weights.get(role)!, 0);
      expect(weight(headRoles) + weight(registryRoles)).toBeLessThanOrEqual(P);
      expect(budget.limit).toBe(discovery + 130 * P + 29 * weight(headRoles) + 3 * weight(registryRoles));
      expect(discovery).toBeLessThanOrEqual(P);
      expect(budget.limit).toBeLessThanOrEqual(160 * P);
      expect(budget.limit).toBeLessThanOrEqual(794624);
      checkedQuota = true;
    });
    const result = await f.store().renameOwned(f.request);
    expect(checkedQuota).toBe(true);
    expect(result.ownerId).toBe(f.token.ownerId); expect(result.revision).toBe(String(BigInt(f.token.revision) + 1n));
    expect(result.locator).toBe(f.request.destinationLocator); expect(result.contentHash).toBe(f.token.contentHash);
    expect(await fs.readFile(f.destination, 'utf8')).toBe(CONTENT);
    const after = await fs.lstat(f.destination, { bigint: true });
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.nlink]).toEqual([before.dev, before.ino, before.size, before.mtimeNs, 1n]);
    await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(result);
    expect(await evidence(f.foreign)).toEqual(foreign);
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
  });
  it('does not revive the original token after A to B to A', async () => {
    const f = await fixture(); const moved = await f.store().renameOwned(f.request);
    const returned = await f.store().renameOwned({ operationId: randomUUID(), expectedToken: moved, destinationLocator: f.token.locator });
    expect(returned.ownerId).toBe(f.token.ownerId); expect(returned.revision).toBe(String(BigInt(f.token.revision) + 2n));
    await expect(f.store().updateOwnedHead(f.token, CONTENT)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
  });
  it.each(['prepared-durable', 'linked-durable', 'moved-durable', 'destination-metadata-durable', 'metadata-durable', 'final-durable', 'after-old-sidecar', 'after-source-journal'] as RenamePublication[])(
    'forwards exact durable phase %s with the same reserved revision', async stop => {
      const f = await fixture(true), cause = new Error('controlled phase interruption'), foreign = await evidence(f.foreign);
      await expect(f.store(phase => { if (phase === stop) throw cause; }).renameOwned(f.request)).rejects.toMatchObject({ cause });
      const sourceJournal = await evidence(f.sourceJournal).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return undefined; });
      const destinationJournal = await evidence(f.destinationJournal);
      const readCode = stop === 'prepared-durable' ? 'ENOENT' : stop === 'linked-durable' ? 'EHEADCONFLICT' : 'EOWNERRECOVERY';
      await expect(f.store().readHeadSnapshot(f.request.destinationLocator)).rejects.toMatchObject({ code: readCode });
      expect(await evidence(f.destinationJournal)).toEqual(destinationJournal);
      expect(await evidence(f.sourceJournal).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return undefined; })).toEqual(sourceJournal);
      const moved = await f.store().renameOwned(f.request);
      expect(moved.revision).toBe(String(BigInt(f.token.revision) + 1n));
      expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(moved);
      expect(await evidence(f.foreign)).toEqual(foreign);
    });
  it.each(['partial-base', 'base-durable', 'partial-reservation', 'reservation-durable', 'after-link', 'after-source-unlink', 'after-destination-sidecar', 'after-registry', 'partial-final'] as RenamePublication[])(
    'preserves manual-only gap %s without a reconstructed receipt', async stop => {
      const f = await fixture(), cause = new Error('controlled unsupported gap');
      await expect(f.store(phase => { if (phase === stop) throw cause; }).renameOwned(f.request)).rejects.toMatchObject({ cause });
      const parent = path.dirname(f.source), names = (await fs.readdir(parent)).sort();
      const before = await Promise.all(names.map(async name => [name, await evidence(path.join(parent, name))]));
      const failure = await f.store().renameOwned(f.request).catch(error => error);
      expect(failure).toBeInstanceOf(Error); expect(failure.code).toMatch(/^E(?:OWNERRECOVERY|HEADCOMMITUNKNOWN|HEADCONFLICT)$/u);
      expect(failure.committed).not.toBe(true); expect(failure.token).toBeUndefined();
      expect((await fs.readdir(parent)).sort()).toEqual(names);
      expect(await Promise.all(names.map(async name => [name, await evidence(path.join(parent, name))]))).toEqual(before);
    });
  it('preserves foreign destination and performs no replacement', async () => {
    const f = await fixture(); await fs.writeFile(f.destination, 'same bytes or foreign inode', { mode: 0o600 }); const before = await evidence(f.destination);
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await evidence(f.destination)).toEqual(before); expect((await f.store().readHeadSnapshot(f.token.locator)).token).toEqual(f.token);
  });
  it.each(['Original.yaml', 'original.yaml', 'Elsewhere/Renamed.yaml'])('refuses unsupported destination %s before artifacts', async destinationLocator => {
    const f = await fixture(), before = (await fs.readdir(f.root)).sort();
    await expect(f.store().renameOwned({ ...f.request, destinationLocator })).rejects.toThrow();
    expect((await fs.readdir(f.root)).sort()).toEqual(before);
  });
  it('retains a genuine current receipt after post-audit failure', async () => {
    const f = await fixture(), cause = new Error('audit consumer failure');
    const error = await f.store(phase => { if (phase === 'after-audit') throw cause; }).renameOwned(f.request).catch(value => value);
    expect(error).toMatchObject({ code: 'EHEADCOMMITTED', committed: true, cause });
    expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(error.token);
  });
  it('sanitizes an earlier committed marker before this invocation acquires authority', async () => {
    const f = await fixture(), cause = Object.assign(new Error('forged'), { code: 'EHEADCOMMITTED', committed: true, token: f.token });
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: f.root, getCurrentUserId: () => { throw cause; }, fence: new FileMemoryFence() });
    const failure = await new FileMemoryOwnerSnapshots({ coordinator }).renameOwned(f.request).catch(value => value);
    expect(failure).toMatchObject({ code: 'EOWNERRECOVERY', cause }); expect(failure.committed).not.toBe(true); expect(failure.token).toBeUndefined();
  });

  it('preserves primary optional failure when its code getter throws', async () => {
    const f = await fixture(), primary = new Error('primary filesystem failure');
    Object.defineProperty(primary, 'code', { get() { throw new Error('code getter failure'); } });
    const before = await evidence(f.source), names = (await fs.readdir(f.root)).sort();
    const internals = FileMemoryOwnedRename.prototype as unknown as { read: (target: string, maximum: number, links?: string, privateFile?: boolean) => Promise<unknown> };
    const originalRead = internals.read; let reached = false;
    jest.spyOn(internals, 'read').mockImplementation(async function(this: typeof internals, target, maximum, links, privateFile) {
      if (target === f.destinationJournal) { reached = true; throw primary; }
      return originalRead.call(this, target, maximum, links, privateFile);
    });
    const failure = await f.store().renameOwned(f.request).catch(error => error);
    expect(failure).toBeInstanceOf(Error); expect(reached).toBe(true); expect(failure.cause).toBe(primary);
    expect(failure.committed).not.toBe(true); expect(failure.token).toBeUndefined();
    expect(await evidence(f.source)).toEqual(before); expect((await fs.readdir(f.root)).sort()).toEqual(names);
  });
  const causeProgram = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    const [ownersUrl,coordinatorUrl,fenceUrl,root,user,requestRaw,seam]=process.argv.slice(1);
    const request=JSON.parse(requestRaw), source=path.join(root,request.expectedToken.locator), destination=path.join(root,request.destinationLocator);
    const fs=createRequire(import.meta.url)('node:fs/promises'), primary=new Error('primary filesystem failure');
    Object.defineProperty(primary,'code',{get(){throw new Error('code getter failure');}});
    let reached=false;
    if(seam==='absent') {const original=fs.lstat;fs.lstat=async(...args)=>{if(String(args[0])===destination){reached=true;throw primary;}return original(...args);};}
    else {fs.link=async(from,to)=>{if(from!==source||to!==destination)throw new Error('unexpected link');reached=true;throw primary;};}
    syncBuiltinESMExports();
    const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
    const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
    const {FileMemoryFence}=await import(fenceUrl);
    const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
    try {await new FileMemoryOwnerSnapshots({coordinator}).renameOwned(request);process.stdout.write(JSON.stringify({reached,rejected:false}));}
    catch(error){process.stdout.write(JSON.stringify({reached,rejected:true,primary:error.cause===primary,token:'token' in error,committed:error.committed===true}));}
  `;
  it.each(['absent', 'link'] as const)('preserves primary %s failure when its actual syscall code getter throws', async seam => {
    const f = await fixture();
    if (seam === 'absent') await expect(f.store(phase => { if (phase === 'prepared-durable') throw new Error('stop'); }).renameOwned(f.request)).rejects.toThrow();
    const before = await evidence(f.source), names = (await fs.readdir(f.root)).sort();
    const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
    const modules = ['FileMemoryOwnerSnapshots', 'FileMemoryTransactionCoordinator', 'FileMemoryFence']
      .map(name => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href);
    const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
    const child = spawn(process.execPath, [...loader, '--input-type=module', '-e', causeProgram, ...modules, f.root, USER, JSON.stringify(f.request), seam],
      { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostics = '', didClose = false;
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { diagnostics += String(chunk); if (diagnostics.length > 1024) child.kill('SIGKILL'); });
    let startupError: Error | undefined;
    child.once('error', error => { startupError = error; });
    const closed = new Promise<number | null>(resolve => { child.once('close', code => { didClose = true; resolve(code); }); });
    const timer = setTimeout(() => { if (!didClose) child.kill('SIGKILL'); }, 5000);
    try {
      const exitCode = await closed;
      expect(startupError).toBeUndefined(); expect(exitCode).toBe(0); expect(diagnostics).toBe('');
      expect(JSON.parse(output)).toEqual({ reached: true, rejected: true, primary: true, token: false, committed: false });
      expect(await evidence(f.source)).toEqual(before);
      if (seam === 'absent') expect((await fs.readdir(f.root)).sort()).toEqual(names);
      else { expect(await fs.readFile(f.sourceJournal, 'utf8')).toContain('PREPARED_RENAME'); expect(await fs.readFile(f.destinationJournal, 'utf8')).toContain('RESERVED_RENAME'); }
    } finally { clearTimeout(timer); if (!didClose) child.kill('SIGKILL'); await closed; }
  });

  it('refuses a replaced partial journal before another write on the original descriptor', async () => {
    const f = await fixture(), originalRead = (FileMemoryOwnedRename.prototype as unknown as { read: (target: string, maximum: number, links?: string, privateFile?: boolean) => Promise<unknown> }).read;
    const internals = FileMemoryOwnedRename.prototype as unknown as { read: typeof originalRead };
    let intercepted = false; const backup = `${f.sourceJournal}.foreign-backup`;
    jest.spyOn(internals, 'read').mockImplementation(async function(this: typeof internals, target, maximum, links, privateFile) {
      if (!intercepted && target === f.sourceJournal && maximum < 8192) {
        intercepted = true; const partial = await fs.readFile(target);
        await fs.rename(target, backup); await fs.writeFile(target, partial, { flag: 'wx', mode: 0o600 });
      }
      return originalRead.call(this, target, maximum, links, privateFile);
    });
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(intercepted).toBe(true); expect(await fs.readFile(backup)).toEqual(await fs.readFile(f.sourceJournal));
    expect(await fs.readFile(f.source, 'utf8')).toBe(CONTENT);
    await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['link', 'unlink'] as const)('refuses original head mode drift in the actual %s syscall window', async operation => {
    const f = await fixture(), internals = FileMemoryOwnedRename.prototype as unknown as { read: (target: string, maximum: number, links?: string, privateFile?: boolean) => Promise<unknown> };
    const originalRead = internals.read; let changed = false;
    jest.spyOn(internals, 'read').mockImplementation(async function(this: typeof internals, target, maximum, links, privateFile) {
      if (!changed && ((operation === 'link' && target === f.source && links === '2') || (operation === 'unlink' && target === f.destination && links === '1'))) {
        changed = true; await fs.chmod(target, 0o640);
      }
      return originalRead.call(this, target, maximum, links, privateFile);
    });
    const failure = await f.store().renameOwned(f.request).catch(error => error);
    expect(changed).toBe(true); expect(failure).toMatchObject({ code: 'EHEADCOMMITUNKNOWN' });
    expect(failure.committed).not.toBe(true); expect(failure.token).toBeUndefined();
    expect(await fs.readFile(f.destination, 'utf8')).toBe(CONTENT);
  });
  it('refuses laundering PREPARED ctime through an edited otherwise complete record', async () => {
    const f = await fixture(); await expect(f.store(phase => { if (phase === 'prepared-durable') throw new Error('stop'); }).renameOwned(f.request)).rejects.toThrow();
    await fs.chmod(f.source, 0o640); await fs.chmod(f.source, 0o600);
    const value = JSON.parse(await fs.readFile(f.sourceJournal, 'utf8')), current = await fs.lstat(f.source, { bigint: true });
    value.currentHead.identity.ctimeNs = String(current.ctimeNs); await fs.writeFile(f.sourceJournal, JSON.stringify(value));
    const before = await evidence(f.sourceJournal);
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', residual: true });
    expect(await evidence(f.sourceJournal)).toEqual(before); await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([`.${'a'.repeat(64)}.memory-owner.json`, `.${'b'.repeat(64)}.memory-write.json`, 'C:/Renamed.yaml'])('rejects unreadable reserved destination %s before artifacts', async destinationLocator => {
    const f = await fixture(), before = await evidence(f.source), names = (await fs.readdir(f.root)).sort();
    await expect(f.store().renameOwned({ ...f.request, destinationLocator })).rejects.toThrow();
    expect(await evidence(f.source)).toEqual(before); expect((await fs.readdir(f.root)).sort()).toEqual(names);
  });
  async function fixtureBatch<T, R>(items: readonly T[], observe: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let offset = 0; offset < items.length; offset += 16) {
      const batch = await Promise.allSettled(items.slice(offset, offset + 16).map(async item => observe(item)));
      for (const result of batch) {
        if (result.status === 'rejected') throw result.reason;
        results.push(result.value);
      }
    }
    return results;
  }
  async function populated(f: Awaited<ReturnType<typeof fixture>>, count: number) {
    const batches = await fixtureBatch(Array.from({ length: count }, (_, index) => index), async index => {
      const locator = path.posix.join(path.posix.dirname(f.token.locator), `Existing${index}.yaml`), target = path.join(f.root, locator), ownerId = randomUUID();
      const raw = 'name: Existing\nentries: []\n'; await fs.writeFile(target, raw, { mode: 0o600 });
      const stat = await fs.lstat(target, { bigint: true });
      const active = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator, revision: '1', contentHash: createHash('sha256').update(raw).digest('hex'),
        fileIdentity: { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } });
      const sidecar = path.join(path.dirname(target), `.${createHash('sha256').update(path.basename(target)).digest('hex')}.memory-owner.json`), registry = path.join(f.root, '.memory-owners', 'owners', `${ownerId}.json`);
      await fs.writeFile(sidecar, active, { mode: 0o600 }); await fs.writeFile(registry, active, { mode: 0o600 });
      const retained: { target: string; before: Awaited<ReturnType<typeof evidence>> }[] = [];
      for (const item of [target, sidecar, registry]) retained.push({ target: item, before: await evidence(item) });
      return retained;
    });
    expect((await f.store().readHeadSnapshot(path.posix.join(path.posix.dirname(f.token.locator), 'Existing0.yaml'))).token.ownership).toBe('owned');
    return batches.flat();
  }
  function renameObservation() {
    const counts = { fullCaptures: 0, namesCaptures: 0, capturedChildren: 0 };
    const internals = FileMemoryOwnedRename.prototype as unknown as { observe: (locator: string, full: boolean) => Promise<{ children?: unknown[] }> };
    const original = internals.observe;
    const spy = jest.spyOn(internals, 'observe').mockImplementation(async function(this: typeof internals, locator, full) {
      const result = await original.call(this, locator, full);
      if (full) { counts.fullCaptures++; counts.capturedChildren += result.children!.length; } else counts.namesCaptures++;
      return result;
    });
    return { counts, restore: () => spy.mockRestore() };
  }
  function phaseDiagnostic(nested: boolean, stop: string, count: number) {
    const started = Date.now(); let records = 0;
    return (phase: string, counters: object = {}) => {
      if (count !== 1000 || records++ >= 8) return;
      process.stderr.write(`RENAME phase ${JSON.stringify({ nested, stop, phase, elapsedMs: Date.now() - started, node: process.version, pid: process.pid, ...counters })}\n`);
    };
  }
  it.each([[false, 100], [false, 250], [false, 1000], [true, 100], [true, 250], [true, 1000]] as const)(
    'qualifies populated same-parent RENAME nested=%s owners=%i', async (nested, count) => {
      const diagnostic = phaseDiagnostic(nested, 'fresh', count);
      const f = await fixture(nested), retained = await populated(f, count);
      const archive = new FileMemoryVolumeStore({ coordinator: f.coordinator, owners: f.store() });
      const receipt = await archive.createExclusive(f.token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
      const archiveRoot = path.join(f.root, 'volumes', 'by-id', f.token.ownerId);
      const archiveNames = (await fs.readdir(archiveRoot)).sort();
      diagnostic('setup-complete');
      const observation = renameObservation();
      let reads = 0, eof = 0; const originalRead: (this: Dir) => Promise<Dirent<string> | null> = Dir.prototype.read;
      const spy = jest.spyOn(Dir.prototype, 'read').mockImplementation(async function(this: Dir) {
        reads++; const entry = await originalRead.call(this); if (!entry) eof++; return entry;
      } as typeof Dir.prototype.read);
      let moved;
      diagnostic('operation-start');
      try { moved = await f.store().renameOwned(f.request); diagnostic('operation-end', { reads, completedCensuses: eof, ...observation.counts }); }
      finally { spy.mockRestore(); observation.restore(); }
      expect(reads).toBeGreaterThan(0); expect(eof).toBeGreaterThan(0); expect(reads).toBeLessThanOrEqual(794624);
      expect(moved.revision).toBe(String(BigInt(f.token.revision) + 1n));
      await fixtureBatch(retained, async item => { deepStrictEqual(await evidence(item.target), item.before, `Retained RENAME evidence changed: ${item.target}`); });
      expect((await fs.readdir(archiveRoot)).sort()).toEqual(archiveNames);
      expect((await archive.read(moved, receipt.volume)).status).toBe('found');
      await expect(archive.read(f.token, receipt.volume)).rejects.toThrow();
      expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(moved);
      diagnostic('assertions-complete');
      process.stderr.write(`RENAME capacity ${JSON.stringify({ nested, count, reads, completedCensuses: eof })}\n`);
    });
  it.each([[false, 'prepared-durable'], [true, 'prepared-durable'], [false, 'linked-durable'], [true, 'linked-durable'], [false, 'final-durable'], [true, 'final-durable']] as const)(
    'qualifies populated 1000-owner fresh recovery nested=%s phase=%s', async (nested, stop) => {
      const diagnostic = phaseDiagnostic(nested, stop, 1000);
      const f = await fixture(nested), retained = await populated(f, 1000);
      diagnostic('setup-complete');
      const observation = renameObservation();
      let moved;
      try {
        diagnostic('interrupted-operation-start');
        await expect(f.store(phase => { if (phase === stop) throw new Error('controlled populated stop'); }).renameOwned(f.request)).rejects.toThrow();
        diagnostic('interrupted-operation-end', observation.counts);
        diagnostic('retry-start');
        moved = await f.store().renameOwned(f.request); diagnostic('retry-end', observation.counts);
      } finally { observation.restore(); }
      expect(moved.revision).toBe(String(BigInt(f.token.revision) + 1n));
      await fixtureBatch(retained, async item => { deepStrictEqual(await evidence(item.target), item.before, `Retained RENAME evidence changed: ${item.target}`); });
      expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(moved);
      diagnostic('assertions-complete');
    });
  it.each(['symlink', 'hardlink'] as const)('preserves a foreign %s destination without publication', async kind => {
    const f = await fixture(), before = await evidence(f.source);
    if (kind === 'symlink') await fs.symlink(f.foreign, f.destination); else await fs.link(f.foreign, f.destination);
    const foreign = await evidence(f.foreign), destination = await evidence(f.destination);
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await evidence(f.source)).toEqual(before); expect(await evidence(f.destination)).toEqual(destination); expect(await evidence(f.foreign)).toEqual(foreign);
  });
  it.each(['prepared-durable', 'linked-durable', 'final-durable'] as RenamePublication[])(
    'refuses a changed foreign inode on fresh recovery from %s', async stop => {
      const f = await fixture(); await expect(f.store(phase => { if (phase === stop) throw new Error('stop'); }).renameOwned(f.request)).rejects.toThrow();
      const bytes = await fs.readFile(f.foreign); await fs.rename(f.foreign, `${f.foreign}.old`); await fs.writeFile(f.foreign, bytes, { mode: 0o600 }); await fs.unlink(`${f.foreign}.old`);
      const names = (await fs.readdir(f.root)).sort(), before = await evidence(f.destinationJournal);
      await expect(f.store().renameOwned(f.request)).rejects.toThrow();
      expect((await fs.readdir(f.root)).sort()).toEqual(names); expect(await evidence(f.destinationJournal)).toEqual(before);
    });
  it.each(['duplicate-key', 'whitespace', 'unknown-schema', 'changed-commitment'] as const)('preserves noncanonical or mismatched %s evidence', async change => {
    const f = await fixture(true); await expect(f.store(phase => { if (phase === 'prepared-durable') throw new Error('stop'); }).renameOwned(f.request)).rejects.toThrow();
    const raw = await fs.readFile(f.sourceJournal, 'utf8'); let changed = raw;
    if (change === 'duplicate-key') changed = raw.replace('"schema":4', '"schema":4,"schema":4');
    else if (change === 'whitespace') changed = ` ${raw}`;
    else { const record = JSON.parse(raw); if (change === 'unknown-schema') record.schema = 5; else record.baseline.namespace[0].sha256 = '0'.repeat(64); changed = JSON.stringify(record); }
    await fs.writeFile(f.sourceJournal, changed); const before = await evidence(f.sourceJournal);
    await expect(f.store().renameOwned(f.request)).rejects.toThrow(); expect(await evidence(f.sourceJournal)).toEqual(before);
    await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses projected aggregate namespace overflow before RENAME artifacts', async () => {
    const f = await fixture(true), retained = await populated(f, 1370), names = (await fs.readdir(path.dirname(f.source))).sort();
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADRESOURCE' } });
    expect((await fs.readdir(path.dirname(f.source))).sort()).toEqual(names);
    await fixtureBatch(retained, async item => { expect(await evidence(item.target)).toEqual(item.before); });
    expect((await f.store().readHeadSnapshot(f.token.locator)).token).toEqual(f.token);
  });
  it('rejects maximum revision before artifacts', async () => {
    const f = await fixture(), names = (await fs.readdir(f.root)).sort();
    await expect(f.store().renameOwned({ ...f.request, expectedToken: { ...f.token, revision: '9223372036854775807' } })).rejects.toThrow();
    expect((await fs.readdir(f.root)).sort()).toEqual(names);
  });
  it('refuses moving a genuinely adopted published archive payload before RENAME artifacts', async () => {
    const f = await fixture(), archive = new FileMemoryVolumeStore({ coordinator: f.coordinator, owners: f.store() });
    const receipt = await archive.createExclusive(f.token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
    const locator = `volumes/by-id/${f.token.ownerId}/v1/g-${receipt.generationId}/payload.yaml`;
    const token = await f.store().adoptUnowned((await f.store().readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
    expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
    const parent = path.join(f.root, path.posix.dirname(locator)), names = (await fs.readdir(parent)).sort();
    const before = await Promise.all(names.map(async name => [name, await evidence(path.join(parent, name))]));
    const registry = path.join(f.root, '.memory-owners', 'owners', `${token.ownerId}.json`), registryBefore = await evidence(registry);
    await expect(f.store().renameOwned({ operationId: randomUUID(), expectedToken: token, destinationLocator: `${path.posix.dirname(locator)}/Renamed.yaml` })).rejects.toThrow();
    expect((await fs.readdir(parent)).sort()).toEqual(names);
    expect(await Promise.all(names.map(async name => [name, await evidence(path.join(parent, name))]))).toEqual(before);
    expect(await evidence(registry)).toEqual(registryBefore);
  });
  it.each(['.MEMORY-OWNERS', 'VOLUMES'])('distinguishes physical reserved aliases from a genuinely distinct %s parent', async upperName => {
    const f = await fixture(), upper = path.join(f.root, upperName);
    if (upperName === 'VOLUMES') await new FileMemoryVolumeStore({ coordinator: f.coordinator, owners: f.store() }).createExclusive(f.token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
    try { await fs.mkdir(upper, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    const canonical = await fs.lstat(path.join(f.root, upperName === 'VOLUMES' ? 'volumes' : '.memory-owners'), { bigint: true }), actual = await fs.lstat(upper, { bigint: true });
    const locator = `${upperName}/Upper.yaml`; await fs.writeFile(path.join(f.root, locator), CONTENT, { mode: 0o600 });
    const head = await fs.lstat(path.join(f.root, locator), { bigint: true }), ownerId = randomUUID();
    const fileIdentity = { device: String(head.dev), inode: String(head.ino), size: String(head.size), mtimeNs: String(head.mtimeNs), ctimeNs: String(head.ctimeNs) };
    const active = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator, revision: '1', contentHash: f.token.contentHash, fileIdentity });
    const sidecar = path.join(upper, `.${createHash('sha256').update('Upper.yaml').digest('hex')}.memory-owner.json`);
    await fs.writeFile(sidecar, active, { mode: 0o600 });
    await fs.writeFile(path.join(f.root, '.memory-owners', 'owners', `${ownerId}.json`), active, { mode: 0o600 });
    const token = { ...f.token, ownerId, locator, fileIdentity };
    if (actual.dev !== canonical.dev || actual.ino !== canonical.ino) expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
    const request = { operationId: randomUUID(), expectedToken: token, destinationLocator: `${upperName}/Renamed.yaml` };
    if (actual.dev === canonical.dev && actual.ino === canonical.ino) {
      const before = await evidence(path.join(f.root, locator));
      await expect(f.store().renameOwned(request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(await evidence(path.join(f.root, locator))).toEqual(before);
    } else {
      const moved = await f.store().renameOwned(request);
      expect((await f.store().readHeadSnapshot(request.destinationLocator)).token).toEqual(moved);
    }
  });
  it('does not capture a token when the actual final directory close rejects', async () => {
    const f = await fixture(), cause = new Error('controlled final close'), internals = FileMemoryOwnedRename.prototype as unknown as {
      closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown> };
    const original = internals.closed; let armed = false, injected = false;
    jest.spyOn(internals, 'closed').mockImplementation(async function(this: typeof internals, handle, body) {
      if (armed && !injected && (await handle.stat()).isDirectory()) {
        injected = true; const realClose = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => { await realClose(); throw cause; });
      }
      return original.call(this, handle, body);
    });
    const failure = await f.store(phase => { if (phase === 'after-final') armed = true; }).renameOwned(f.request).catch(error => error);
    expect(injected).toBe(true); expect(failure).toMatchObject({ code: 'EHEADCOMMITUNKNOWN', cause });
    expect(failure.committed).not.toBe(true); expect(failure.token).toBeUndefined();
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token.ownership).toBe('owned');
  });
  it('checks real callback-induced foreign drift before head publication', async () => {
    const f = await fixture(), foreign = await fs.readFile(f.foreign);
    const failure = await f.store(async phase => {
      if (phase === 'before-link') { await fs.rename(f.foreign, `${f.foreign}.old`); await fs.writeFile(f.foreign, foreign, { mode: 0o600 }); await fs.unlink(`${f.foreign}.old`); }
    }).renameOwned(f.request).catch(error => error);
    expect(failure).toMatchObject({ code: 'EOWNERRECOVERY' }); expect(failure.token).toBeUndefined();
    await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['byte-ceiling', 'size-mismatch'] as const)('refuses recovery %s before reading head payload', async change => {
    const f = await fixture(); await expect(f.store(phase => { if (phase === 'prepared-durable') throw new Error('stop'); }).renameOwned(f.request)).rejects.toThrow();
    const record = JSON.parse(await fs.readFile(f.sourceJournal, 'utf8'));
    if (change === 'byte-ceiling') { record.binding.contentBytes = 3 * 2 * 1024 * 1024 + 1; record.binding.originalSourceIdentity.size = String(record.binding.contentBytes); }
    else record.binding.contentBytes++;
    await fs.writeFile(f.sourceJournal, JSON.stringify(record)); const before = await evidence(f.sourceJournal);
    await expect(f.store().renameOwned(f.request)).rejects.toThrow(); expect(await evidence(f.sourceJournal)).toEqual(before);
    expect(await fs.readFile(f.source, 'utf8')).toBe(CONTENT); await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  const childProgram = `
    const [ownersUrl,coordinatorUrl,fenceUrl,root,user,request,stop]=process.argv.slice(1);
    const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
    const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
    const {FileMemoryFence}=await import(fenceUrl);
    const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
    const store=new FileMemoryOwnerSnapshots({coordinator,afterRenamePublication:phase=>{
      if(phase===stop){process.stdout.write('RENAME_BARRIER\\n');process.stdin.resume();return new Promise(()=>{});}
    }});
    await store.renameOwned(JSON.parse(request));
  `;
  it.each(['partial-base', 'reservation-durable', 'prepared-durable', 'after-link', 'linked-durable', 'after-source-unlink',
    'moved-durable', 'destination-metadata-durable', 'metadata-durable', 'final-durable', 'after-old-sidecar', 'after-source-journal', 'after-final'] as RenamePublication[])(
    'preserves actual SIGKILL evidence at %s and never invents a past receipt', async stop => {
      const f = await fixture(true), foreign = await evidence(f.foreign);
      const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
      const modules = ['FileMemoryOwnerSnapshots', 'FileMemoryTransactionCoordinator', 'FileMemoryFence']
        .map(name => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href);
      const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
      const child = spawn(process.execPath, [...loader, '--input-type=module', '-e', childProgram,
        ...modules, f.root, USER, JSON.stringify(f.request), stop], { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
      let didClose = false, output = '';
      const closed = new Promise<void>(resolve => child.once('close', () => { didClose = true; resolve(); }));
      const ready = new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new Error('RENAME child startup failed')));
        child.once('close', () => reject(new Error('RENAME child closed before barrier')));
        child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 256) reject(new Error('Child output cap')); else if (output === 'RENAME_BARRIER\n') resolve(); });
        child.stderr.on('data', () => reject(new Error('RENAME child unexpected diagnostics')));
      });
      void ready.catch(() => undefined);
      const timer = setTimeout(() => { if (!didClose) child.kill('SIGKILL'); }, 5000);
      try {
        await ready; child.kill('SIGKILL'); await closed;
        // Exact confirmed owned-child death permits explicit test-only orphan lease removal.
        await fs.rm(path.join(f.root, '.memory-fences', 'tenant.lock'), { recursive: true });
        const manual = ['partial-base', 'reservation-durable', 'after-link', 'after-source-unlink', 'after-final'].includes(stop);
        const names = (await fs.readdir(path.dirname(f.source))).sort();
        const before = await Promise.all(names.map(async name => [name, await evidence(path.join(path.dirname(f.source), name))]));
        if (manual) {
          const failure = await f.store().renameOwned(f.request).catch(error => error);
          expect(failure).toBeInstanceOf(Error); expect(failure.code).toMatch(/^E(?:OWNERRECOVERY|HEADCOMMITUNKNOWN|HEADCONFLICT)$/u);
          expect(failure.committed).not.toBe(true); expect(failure.token).toBeUndefined();
          expect((await fs.readdir(path.dirname(f.source))).sort()).toEqual(names);
          expect(await Promise.all(names.map(async name => [name, await evidence(path.join(path.dirname(f.source), name))]))).toEqual(before);
        } else {
          const current = await f.store().renameOwned(f.request);
          expect(current.revision).toBe(String(BigInt(f.token.revision) + 1n));
          expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(current);
        }
        expect(await evidence(f.foreign)).toEqual(foreign);
      } finally {
        clearTimeout(timer); if (!didClose) child.kill('SIGKILL'); await closed;
      }
    });

  it.each(['a'.repeat(251) + '.yaml', '界'.repeat(86) + '.yaml', 'volumes', 'VOLUMES', '.memory-owners', '.MEMORY-FENCES'])(
    'rejects unusable root destination %s before artifacts', async destinationLocator => {
      const f = await fixture(), names = (await fs.readdir(f.root)).sort(), before = await evidence(f.source);
      await expect(f.store().renameOwned({ ...f.request, destinationLocator })).rejects.toThrow();
      expect((await fs.readdir(f.root)).sort()).toEqual(names); expect(await evidence(f.source)).toEqual(before);
      expect((await f.store().readHeadSnapshot(f.token.locator)).token).toEqual(f.token);
    });
  it('permits an exact 255-byte destination component', async () => {
    const f = await fixture(), destinationLocator = 'a'.repeat(250) + '.yaml';
    expect(Buffer.byteLength(destinationLocator)).toBe(255);
    const moved = await f.store().renameOwned({ ...f.request, destinationLocator });
    expect(moved.locator).toBe(destinationLocator);
    expect((await f.store().readHeadSnapshot(destinationLocator)).token).toEqual(moved);
  });
  it.each(['sidecar', 'registry'] as const)('rejects conflicting %s bytes captured after the real owner reader', async kind => {
    const f = await fixture(), store = f.store(), headBefore = await evidence(f.source), names = (await fs.readdir(f.root)).sort();
    const target = kind === 'sidecar' ? f.sourceJournal.replace('.memory-write.json', '.memory-owner.json') : path.join(f.root, '.memory-owners', 'owners', `${f.token.ownerId}.json`);
    const reader = store as unknown as { readAtRoot(root: string, user: string, locator: string, ...rest: unknown[]): Promise<FileMemorySnapshot> };
    const original = reader.readAtRoot.bind(store); let changed = false, retained: Awaited<ReturnType<typeof evidence>> | undefined;
    const spy = jest.spyOn(reader, 'readAtRoot').mockImplementation(async (...args) => {
      const snapshot = await original(...args);
      if (!changed) {
        changed = true; const record = JSON.parse(await fs.readFile(target, 'utf8'));
        record.ownerId = randomUUID(); await fs.writeFile(target, JSON.stringify(record)); retained = await evidence(target);
      }
      return snapshot;
    });
    try { await expect(store.renameOwned(f.request)).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(changed).toBe(true); expect(await evidence(target)).toEqual(retained);
    expect(await evidence(f.source)).toEqual(headBefore); expect((await fs.readdir(f.root)).sort()).toEqual(names);
    await expect(fs.lstat(f.sourceJournal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(f.destinationJournal)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a canonical volume identity matching a deeper captured source ancestor', async () => {
    const f = await fixture(), locator = 'Alias/Nested/Original.yaml';
    await fs.mkdir(path.join(f.root, 'Alias', 'Nested'), { recursive: true });
    const token = await f.store().createOwned({ operationId: randomUUID(), locator, content: CONTENT });
    const target = path.join(f.root, locator), before = await evidence(target), parent = path.dirname(target), names = (await fs.readdir(parent)).sort();
    const canonical = await fs.lstat(parent, { bigint: true });
    const prototype = FileMemoryOwnedRename.prototype as unknown as { canonicalVolume(): Promise<BigIntStats | undefined> };
    // Descriptor injection models a deeper physical alias without creating a privileged bind mount.
    const spy = jest.spyOn(prototype, 'canonicalVolume').mockResolvedValue(canonical);
    try { await expect(f.store().renameOwned({ operationId: randomUUID(), expectedToken: token, destinationLocator: 'Alias/Nested/Renamed.yaml' })).rejects.toMatchObject({ code: 'EHEADCONFLICT' }); }
    finally { spy.mockRestore(); }
    expect(await evidence(target)).toEqual(before); expect((await fs.readdir(parent)).sort()).toEqual(names);
    expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
  });

  it('refuses an over-envelope generated stage while the real original head and owner records remain readable', async () => {
    const f = await fixture(), limit = process.platform === 'linux' ? 4096 : 1024;
    let root = f.root;
    const rootBytes = limit - 150;
    while (Buffer.byteLength(root) < rootBytes) {
      const remaining = rootBytes - Buffer.byteLength(root) - 1;
      if (remaining < 1) break;
      const component = 'p'.repeat(Math.min(200, remaining));
      root = path.join(root, component); await fs.mkdir(root, { mode: 0o700 });
    }
    await fs.mkdir(path.join(root, '.memory-owners', 'owners'), { recursive: true, mode: 0o700 });
    const locator = 'Original.yaml', source = path.join(root, locator); await fs.writeFile(source, CONTENT, { mode: 0o600 });
    const stat = await fs.lstat(source, { bigint: true }), ownerId = randomUUID();
    const fileIdentity = { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    const token = { ...f.token, tenantRoot: root, ownerId, locator, fileIdentity };
    const active = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator, revision: '1', contentHash: token.contentHash, fileIdentity });
    const sidecar = path.join(root, `.${createHash('sha256').update(locator).digest('hex')}.memory-owner.json`), registry = path.join(root, '.memory-owners', 'owners', `${ownerId}.json`);
    await fs.writeFile(sidecar, active, { mode: 0o600 }); await fs.writeFile(registry, active, { mode: 0o600 });
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() }), store = new FileMemoryOwnerSnapshots({ coordinator });
    // Establish the normal lease namespace before capturing the preservation baseline.
    await coordinator.withTenantTransaction(() => undefined);
    expect((await store.readHeadSnapshot(locator)).token).toEqual(token);
    const request = { operationId: randomUUID(), expectedToken: token, destinationLocator: 'Renamed.yaml' };
    const journal = path.join(root, `.${createHash('sha256').update(locator).digest('hex')}.memory-write.json`);
    const stage = `${journal}.rename-${request.operationId}.DESTINATION_METADATA_RENAME.tmp`;
    expect(Buffer.byteLength(journal) + 1).toBeLessThanOrEqual(limit); expect(Buffer.byteLength(stage) + 1).toBeGreaterThan(limit);
    const before = await Promise.all([source, sidecar, registry].map(evidence)), names = (await fs.readdir(root)).sort();
    await expect(store.renameOwned(request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADRESOURCE' }, phase: 'initial', residual: false });
    expect(await Promise.all([source, sidecar, registry].map(evidence))).toEqual(before);
    expect((await fs.readdir(root)).sort()).toEqual(names); await expect(fs.lstat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.readHeadSnapshot(locator)).token).toEqual(token);
  });
  it('refuses unqualified platforms before capturing a RENAME request', async () => {
    const f = await fixture(); const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'freebsd' });
      expect(() => captureRenameRequest(f.request)).toThrow('qualified only on Linux and Darwin');
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it('rejects a canonical fence identity matching a deeper captured source ancestor', async () => {
    const f = await fixture(), locator = 'Alias/Nested/Original.yaml';
    await fs.mkdir(path.join(f.root, 'Alias', 'Nested'), { recursive: true });
    const token = await f.store().createOwned({ operationId: randomUUID(), locator, content: CONTENT });
    const target = path.join(f.root, locator), sidecar = path.join(path.dirname(target), `.${createHash('sha256').update('Original.yaml').digest('hex')}.memory-owner.json`);
    const registry = path.join(f.root, '.memory-owners', 'owners', `${token.ownerId}.json`), parent = path.dirname(target), names = (await fs.readdir(parent)).sort();
    const beforeEvidence = await Promise.all([target, sidecar, registry].map(evidence)), canonical = await fs.lstat(parent, { bigint: true });
    const prototype = FileMemoryOwnedRename.prototype as unknown as {
      validateConfinement(before: BigIntStats[], after: BigIntStats[], volumeBefore: BigIntStats | undefined, volumeAfter: BigIntStats | undefined): void;
    };
    const original = prototype.validateConfinement; let reached = false;
    // Inject actual deeper directory identity into both canonical-F observations, without a privileged bind mount.
    const spy = jest.spyOn(prototype, 'validateConfinement').mockImplementation(function(this: typeof prototype, before, after, volumeBefore, volumeAfter) {
      reached = true;
      original.call(this, [before[0], before[1], canonical], [after[0], after[1], canonical], volumeBefore, volumeAfter);
    });
    try { await expect(f.store().renameOwned({ operationId: randomUUID(), expectedToken: token, destinationLocator: 'Alias/Nested/Renamed.yaml' })).rejects.toMatchObject({ code: 'EHEADCONFLICT' }); }
    finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect(await Promise.all([target, sidecar, registry].map(evidence))).toEqual(beforeEvidence);
    expect((await fs.readdir(parent)).sort()).toEqual(names); expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
  });
  it('rejects a coerced operation UUID array before operation I/O', async () => {
    const f = await fixture();
    const transaction = jest.spyOn(f.coordinator, 'withTenantTransaction');
    expect(() => captureRenameRequest({ ...f.request, operationId: [f.request.operationId] } as unknown as RenameOwnedRequest)).toThrow(TypeError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reports an observed malformed canonical journal as preserved manual residual', async () => {
    const f = await fixture(); await fs.writeFile(f.sourceJournal, '{"schema":4', { mode: 0o600 });
    const targets = [f.source, f.sourceJournal, f.foreign], before = await Promise.all(targets.map(evidence));
    const names = (await fs.readdir(f.root)).sort();
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', residual: true });
    expect(await Promise.all(targets.map(evidence))).toEqual(before);
    expect((await fs.readdir(f.root)).sort()).toEqual(names);
    await expect(fs.lstat(f.destinationJournal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('binds original artifact devices to their captured containing directories on recovery=%s', async recovery => {
    const f = await fixture(true);
    if (recovery) await expect(f.store(phase => { if (phase === 'prepared-durable') throw new Error('stop'); }).renameOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const sidecar = path.join(path.dirname(f.source), `.${createHash('sha256').update('Original.yaml').digest('hex')}.memory-owner.json`);
    const registry = path.join(f.root, '.memory-owners', 'owners', `${f.token.ownerId}.json`);
    const targets = [f.source, sidecar, registry, ...(recovery ? [f.sourceJournal, f.destinationJournal] : [])];
    const before = await Promise.all(targets.map(evidence)), names = (await fs.readdir(path.dirname(f.source))).sort();
    const prototype = FileMemoryOwnedRename.prototype as unknown as {
      observe(locator: string, full: boolean): Promise<{ identity: RenameOwnedRequest['expectedToken']['fileIdentity'] }>;
      bindContainingDevice(target: string, captured: RenameOwnedRequest['expectedToken']['fileIdentity']): void;
    };
    const observe = prototype.observe, bind = prototype.bindContainingDevice, reached: string[] = [];
    // Descriptor injection models a visible device mismatch, without a live cross-device mount.
    const observation = jest.spyOn(prototype, 'observe').mockImplementation(async function(this: typeof prototype, locator, full) {
      const actual = await observe.call(this, locator, full);
      return locator === '.memory-owners/owners'
        ? { ...actual, identity: { ...actual.identity, device: String(BigInt(actual.identity.device) + 1000000n) } } : actual;
    });
    const binding = jest.spyOn(prototype, 'bindContainingDevice').mockImplementation(function(this: typeof prototype, target, captured) {
      if ([f.source, sidecar, registry].includes(target)) reached.push(target); bind.call(this, target, captured);
    });
    try { await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: recovery ? 'EOWNERRECOVERY' : 'EHEADCONFLICT' }); }
    finally { observation.mockRestore(); binding.mockRestore(); }
    expect(reached).toEqual([f.source, sidecar, registry]);
    expect(await Promise.all(targets.map(evidence))).toEqual(before);
    expect((await fs.readdir(path.dirname(f.source))).sort()).toEqual(names);
    if (!recovery) await expect(fs.lstat(f.sourceJournal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['prepared-durable', 'final-durable'] as RenamePublication[])('binds the present recovery journal device before parsing at %s', async phase => {
    const f = await fixture(true);
    await expect(f.store(stop => { if (stop === phase) throw new Error('stop'); }).renameOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const selected = phase === 'prepared-durable' ? f.sourceJournal : f.destinationJournal;
    const sidecar = path.join(path.dirname(f.source), `.${createHash('sha256').update('Original.yaml').digest('hex')}.memory-owner.json`);
    const registry = path.join(f.root, '.memory-owners', 'owners', `${f.token.ownerId}.json`);
    const targets = [phase === 'prepared-durable' ? f.source : f.destination, sidecar, registry, f.sourceJournal, f.destinationJournal, f.foreign];
    const before = await Promise.all(targets.map(evidence)), names = (await fs.readdir(path.dirname(f.source))).sort();
    const prototype = FileMemoryOwnedRename.prototype as unknown as {
      optional(target: string): Promise<{ identity: RenameOwnedRequest['expectedToken']['fileIdentity'] } | undefined>;
      bindContainingDevice(target: string, captured: RenameOwnedRequest['expectedToken']['fileIdentity']): void;
    };
    const optional = prototype.optional, bind = prototype.bindContainingDevice; let reached = false;
    // Preserve the real journal read and inject only the visible named-artifact device, not a live file mount.
    const observation = jest.spyOn(prototype, 'optional').mockImplementation(async function(this: typeof prototype, target) {
      const actual = await optional.call(this, target);
      return target === selected && actual ? { ...actual, identity: { ...actual.identity, device: String(BigInt(actual.identity.device) + 1000000n) } } : actual;
    });
    const binding = jest.spyOn(prototype, 'bindContainingDevice').mockImplementation(function(this: typeof prototype, target, captured) {
      if (target === selected) reached = true;
      bind.call(this, target, captured);
    });
    try { await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', residual: true }); }
    finally { observation.mockRestore(); binding.mockRestore(); }
    expect(reached).toBe(true); expect(await Promise.all(targets.map(evidence))).toEqual(before);
    expect((await fs.readdir(path.dirname(f.source))).sort()).toEqual(names);
  });

  it('preflights real composed/decomposed destination resolution without assuming filesystem normalization', async () => {
    const f = await fixture(), sourceLocator = 'Café.yaml', destinationLocator = 'Cafe\u0301.yaml';
    expect(sourceLocator.toLowerCase()).not.toBe(destinationLocator.toLowerCase());
    const token = await f.store().createOwned({ operationId: randomUUID(), locator: sourceLocator, content: CONTENT });
    const source = path.join(f.root, sourceLocator), destination = path.join(f.root, destinationLocator);
    const sidecar = path.join(f.root, `.${createHash('sha256').update(sourceLocator).digest('hex')}.memory-owner.json`);
    const registry = path.join(f.root, '.memory-owners', 'owners', `${token.ownerId}.json`);
    const targets = [source, sidecar, registry], before = await Promise.all(targets.map(evidence)), names = (await fs.readdir(f.root)).sort();
    const original = await fs.lstat(source, { bigint: true });
    const resolved = await fs.lstat(destination, { bigint: true }).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return undefined; });
    const request = { operationId: randomUUID(), expectedToken: token, destinationLocator };
    console.info('[RENAME NAME RESOLUTION]', { platform: process.platform, resolution: !resolved ? 'distinct-absent' : resolved.dev === original.dev && resolved.ino === original.ino ? 'same-identity-alias' : 'foreign-occupied' });
    if (resolved) {
      // Actual descriptor equality identifies a normalization alias; a different inode is still an occupied destination.
      const aliasesSource = resolved.dev === original.dev && resolved.ino === original.ino;
      if (aliasesSource) expect([resolved.dev, resolved.ino]).toEqual([original.dev, original.ino]);
      await expect(f.store().renameOwned(request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', residual: false });
      expect(await Promise.all(targets.map(evidence))).toEqual(before);
      expect((await fs.readdir(f.root)).sort()).toEqual(names);
      expect((await f.store().readHeadSnapshot(sourceLocator)).token).toEqual(token);
    } else {
      const moved = await f.store().renameOwned(request);
      expect(moved.ownerId).toBe(token.ownerId); expect(moved.revision).toBe(String(BigInt(token.revision) + 1n));
      expect(moved.locator).toBe(destinationLocator); expect(await fs.readFile(destination, 'utf8')).toBe(CONTENT);
      expect((await f.store().readHeadSnapshot(destinationLocator)).token).toEqual(moved);
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await fs.readdir(f.root)).some(name => name.endsWith('.memory-write.json') || name.includes('.rename-'))).toBe(false);
  });

});
