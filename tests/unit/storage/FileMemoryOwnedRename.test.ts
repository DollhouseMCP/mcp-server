import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileMemoryOwnerSnapshots, type RenamePublication, type RenameOwnedRequest } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { Dir, type Dirent } from 'node:fs';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';
import { FileMemoryOwnedRename } from '../../../src/storage/FileMemoryOwnedRename.js';
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
    await expect(f.store().renameOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await evidence(f.sourceJournal)).toEqual(before); await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([`.${'a'.repeat(64)}.memory-owner.json`, `.${'b'.repeat(64)}.memory-write.json`, 'C:/Renamed.yaml'])('rejects unreadable reserved destination %s before artifacts', async destinationLocator => {
    const f = await fixture(), before = await evidence(f.source), names = (await fs.readdir(f.root)).sort();
    await expect(f.store().renameOwned({ ...f.request, destinationLocator })).rejects.toThrow();
    expect(await evidence(f.source)).toEqual(before); expect((await fs.readdir(f.root)).sort()).toEqual(names);
  });
  async function populated(f: Awaited<ReturnType<typeof fixture>>, count: number) {
    const retained: { target: string; before: Awaited<ReturnType<typeof evidence>> }[] = [];
    for (let index = 0; index < count; index++) {
      const locator = path.posix.join(path.posix.dirname(f.token.locator), `Existing${index}.yaml`), target = path.join(f.root, locator), ownerId = randomUUID();
      const raw = 'name: Existing\nentries: []\n'; await fs.writeFile(target, raw, { mode: 0o600 });
      const stat = await fs.lstat(target, { bigint: true });
      const active = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator, revision: '1', contentHash: createHash('sha256').update(raw).digest('hex'),
        fileIdentity: { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } });
      const sidecar = path.join(path.dirname(target), `.${createHash('sha256').update(path.basename(target)).digest('hex')}.memory-owner.json`), registry = path.join(f.root, '.memory-owners', 'owners', `${ownerId}.json`);
      await fs.writeFile(sidecar, active, { mode: 0o600 }); await fs.writeFile(registry, active, { mode: 0o600 });
      for (const item of [target, sidecar, registry]) retained.push({ target: item, before: await evidence(item) });
    }
    expect((await f.store().readHeadSnapshot(path.posix.join(path.posix.dirname(f.token.locator), 'Existing0.yaml'))).token.ownership).toBe('owned');
    return retained;
  }
  it.each([[false, 100], [false, 250], [false, 1000], [true, 100], [true, 250], [true, 1000]] as const)(
    'qualifies populated same-parent RENAME nested=%s owners=%i', async (nested, count) => {
      const f = await fixture(nested), retained = await populated(f, count);
      const archive = new FileMemoryVolumeStore({ coordinator: f.coordinator, owners: f.store() });
      const receipt = await archive.createExclusive(f.token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
      const archiveRoot = path.join(f.root, 'volumes', 'by-id', f.token.ownerId);
      const archiveNames = (await fs.readdir(archiveRoot)).sort();
      let reads = 0, eof = 0; const originalRead: (this: Dir) => Promise<Dirent<string> | null> = Dir.prototype.read;
      const spy = jest.spyOn(Dir.prototype, 'read').mockImplementation(async function(this: Dir) {
        reads++; const entry = await originalRead.call(this); if (!entry) eof++; return entry;
      } as typeof Dir.prototype.read);
      let moved;
      try { moved = await f.store().renameOwned(f.request); } finally { spy.mockRestore(); }
      expect(reads).toBeGreaterThan(0); expect(eof).toBeGreaterThan(0); expect(reads).toBeLessThanOrEqual(794624);
      expect(moved.revision).toBe(String(BigInt(f.token.revision) + 1n));
      for (const item of retained) expect(await evidence(item.target)).toEqual(item.before);
      expect((await fs.readdir(archiveRoot)).sort()).toEqual(archiveNames);
      expect((await archive.read(moved, receipt.volume)).status).toBe('found');
      await expect(archive.read(f.token, receipt.volume)).rejects.toThrow();
      expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(moved);
      process.stderr.write(`RENAME capacity ${JSON.stringify({ nested, count, reads, completedCensuses: eof })}\n`);
    });
  it.each([[false, 'prepared-durable'], [true, 'prepared-durable'], [false, 'linked-durable'], [true, 'linked-durable'], [false, 'final-durable'], [true, 'final-durable']] as const)(
    'qualifies populated 1000-owner fresh recovery nested=%s phase=%s', async (nested, stop) => {
      const f = await fixture(nested), retained = await populated(f, 1000);
      await expect(f.store(phase => { if (phase === stop) throw new Error('controlled populated stop'); }).renameOwned(f.request)).rejects.toThrow();
      const moved = await f.store().renameOwned(f.request);
      expect(moved.revision).toBe(String(BigInt(f.token.revision) + 1n));
      for (const item of retained) expect(await evidence(item.target)).toEqual(item.before);
      expect((await f.store().readHeadSnapshot(f.request.destinationLocator)).token).toEqual(moved);
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
    for (const item of retained) expect(await evidence(item.target)).toEqual(item.before);
    expect((await f.store().readHeadSnapshot(f.token.locator)).token).toEqual(f.token);
  });
  it('rejects maximum revision before artifacts', async () => {
    const f = await fixture(), names = (await fs.readdir(f.root)).sort();
    await expect(f.store().renameOwned({ ...f.request, expectedToken: { ...f.token, revision: '9223372036854775807' } })).rejects.toThrow();
    expect((await fs.readdir(f.root)).sort()).toEqual(names);
  });
  it('distinguishes physical reserved aliases from a genuinely distinct uppercase parent', async () => {
    const f = await fixture(), upper = path.join(f.root, '.MEMORY-OWNERS');
    try { await fs.mkdir(upper, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    const canonical = await fs.lstat(path.join(f.root, '.memory-owners'), { bigint: true }), actual = await fs.lstat(upper, { bigint: true });
    const locator = '.MEMORY-OWNERS/Upper.yaml'; await fs.writeFile(path.join(f.root, locator), CONTENT, { mode: 0o600 });
    const head = await fs.lstat(path.join(f.root, locator), { bigint: true }), ownerId = randomUUID();
    const fileIdentity = { device: String(head.dev), inode: String(head.ino), size: String(head.size), mtimeNs: String(head.mtimeNs), ctimeNs: String(head.ctimeNs) };
    const active = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator, revision: '1', contentHash: f.token.contentHash, fileIdentity });
    const sidecar = path.join(upper, `.${createHash('sha256').update('Upper.yaml').digest('hex')}.memory-owner.json`);
    await fs.writeFile(sidecar, active, { mode: 0o600 });
    await fs.writeFile(path.join(f.root, '.memory-owners', 'owners', `${ownerId}.json`), active, { mode: 0o600 });
    const token = { ...f.token, ownerId, locator, fileIdentity };
    if (actual.dev !== canonical.dev || actual.ino !== canonical.ino) expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
    const request = { operationId: randomUUID(), expectedToken: token, destinationLocator: '.MEMORY-OWNERS/Renamed.yaml' };
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
});
