import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryDirectoryScanLimitError } from '../../../src/storage/FileMemoryDirectoryScanBudget.js';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryOwnedErasure } from '../../../src/storage/FileMemoryOwnedErasure.js';
import { ErasureAccounting, ErasureInspection } from '../../../src/storage/FileMemoryErasureInspection.js';
import { MEMORY_CONSTANTS } from '../../../src/elements/memories/constants.js';
import { ERASURE_LEGACY_PROTOCOL, erasureParseRecord, erasureParseSegment, erasureSegmentName, erasureSerialize } from '../../../src/storage/FileMemoryErasureEvidence.js';
import { makeOwnedErasureFixture, captureErasureTree, captureErasureFiles } from './fixtures/ownedErasureFixture.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';
(supported ? describe : describe.skip)('dormant whole-owner erasure', () => {
  jest.setTimeout(10_000);
  it('rechecks the captured registry parent after an awaited V2 selected-stage observation', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const original = ErasureInspection.prototype.file;
    let injected = false, laterRegistryCaptures = 0;
    const capture = ErasureInspection.prototype.sharedDirectory;
    const captureSpy = jest.spyOn(ErasureInspection.prototype, 'sharedDirectory').mockImplementation(function(this: ErasureInspection, locator, privateMode) {
      if (injected && locator === '.memory-owners/owners') laterRegistryCaptures++;
      return capture.call(this, locator, privateMode);
    });
    const added = path.join(fixture.root, '.memory-owners/owners', 'unexpected-name');
    const spy = jest.spyOn(ErasureInspection.prototype, 'file').mockImplementation(async function(this: ErasureInspection, locator) {
      const observed = await original.call(this, locator);
      if (!injected && locator.endsWith('.tmp')) { injected = true; await fs.writeFile(added, 'preserved foreign name', { mode: 0o600, flag: 'wx' }); }
      return observed;
    });
    try {
      const archive = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), before = await captureErasureTree(archive);
      const error = await fixture.owners.eraseOwned(fixture.request).catch(cause => cause);
      expect(injected).toBe(true); expect(laterRegistryCaptures).toBe(0);
      expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(archive)).toEqual(before); expect(await fs.readFile(added, 'utf8')).toBe('preserved foreign name');
    } finally { spy.mockRestore(); captureSpy.mockRestore(); await fixture.cleanup(); }
  });
  it.each(['head', 'registry', 'head-replacement'] as const)('allows only unrelated %s metadata drift under explicit V2 and preserves resulting evidence', async selected => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2, foreignOwners: 100 });
    const target = fixture.foreignFiles[selected === 'registry' ? 2 : 0];
    let after: Awaited<ReturnType<typeof captureErasureFiles>> | undefined;
    try {
      const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: async phase => {
          if (phase === 'inventory-durable') {
            const journal = erasureParseRecord(await fs.readFile(path.join(fixture.root, '.memory-owners/owners', fixture.token.ownerId + '.erase.json'), 'utf8'));
            expect(journal.schema).toBe(2); expect(journal.head.namespace.every(item => item.kind === 'names')).toBe(true);
            if (selected === 'head-replacement') {
              await fs.writeFile(target + '.replacement', 'foreign replacement bytes', { mode: 0o600, flag: 'wx' });
              await fs.rename(target + '.replacement', target);
            } else await fs.chmod(target, 0o640);
            after = await captureErasureFiles(fixture.foreignFiles);
          }
        } });
      expect((await owners.eraseOwned(fixture.request)).status).toBe('erased');
      expect(after).toBeDefined(); expect(await captureErasureFiles(fixture.foreignFiles)).toEqual(after);
    } finally { await fixture.cleanup(); }
  });
  it('recovers interrupted V2 authority with permitted unrelated metadata drift while preserving current foreign bytes', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2, foreignOwners: 100 });
    try {
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'ready-durable') throw new Error('V2 recovery window'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toBeDefined();
      const journal = erasureParseRecord(await fs.readFile(path.join(fixture.root, '.memory-owners/owners', fixture.token.ownerId + '.erase.json'), 'utf8'));
      expect(journal.schema).toBe(2);
      await fs.chmod(fixture.foreignFiles[2], 0o640);
      const foreign = await captureErasureFiles(fixture.foreignFiles);
      expect(['erased', 'already-erased']).toContain((await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId })).status);
      expect(await captureErasureFiles(fixture.foreignFiles)).toEqual(foreign);
    } finally { await fixture.cleanup(); }
  });
  it.each(['ready-durable', 'action-prepared-durable', 'evidence-retiring-durable'] as const)(
    'recovers genuine V1 %s authority without upgrading its version or proof policy', async phase => {
      const fixture = await makeOwnedErasureFixture({ volumes: 2, nested: true });
      // Internal version-selection seam runs the actual retained V1 writer/proofs. No record fields are rewritten.
      const legacy = jest.spyOn(FileMemoryOwnedErasure.prototype, 'protocol', 'get').mockReturnValue(ERASURE_LEGACY_PROTOCOL);
      try {
        const oldWriter = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
          afterErasurePublication: value => { if (value === phase) throw new Error('genuine legacy interruption'); } });
        await expect(oldWriter.eraseOwned(fixture.request)).rejects.toBeDefined();
        const journal = erasureParseRecord(await fs.readFile(path.join(fixture.root, '.memory-owners/owners', fixture.token.ownerId + '.erase.json'), 'utf8'));
        expect(journal.schema).toBe(1); expect(journal.head.namespace.every(item => item.kind === undefined)).toBe(true);
        legacy.mockRestore();
        const versions: number[] = [];
        const recovery = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
          afterErasurePublication: async publication => {
            if (publication === 'after-audit' || publication === 'before-return') return;
            versions.push(erasureParseRecord(await fs.readFile(path.join(fixture.root, '.memory-owners/owners', fixture.token.ownerId + '.erase.json'), 'utf8')).schema);
          } });
        expect(['erased', 'already-erased']).toContain((await recovery.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
          operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId })).status);
        expect(versions.length).toBeGreaterThan(0); expect(versions.every(version => version === 1)).toBe(true);
      } finally { legacy.mockRestore(); await fixture.cleanup(); }
    });
  it('retains the V1 unrelated metadata refusal and selected bytes instead of silently upgrading', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2, foreignOwners: 100 });
    const legacy = jest.spyOn(FileMemoryOwnedErasure.prototype, 'protocol', 'get').mockReturnValue(ERASURE_LEGACY_PROTOCOL);
    try {
      const oldWriter = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: value => { if (value === 'ready-durable') throw new Error('legacy window'); } });
      await expect(oldWriter.eraseOwned(fixture.request)).rejects.toBeDefined(); legacy.mockRestore();
      await fs.chmod(fixture.foreignFiles[2], 0o640);
      const archive = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
      const before = await captureErasureTree(archive), foreign = await captureErasureFiles(fixture.foreignFiles);
      const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
      expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(archive)).toEqual(before); expect(await captureErasureFiles(fixture.foreignFiles)).toEqual(foreign);
      expect(erasureParseRecord(await fs.readFile(path.join(fixture.root, '.memory-owners/owners', fixture.token.ownerId + '.erase.json'), 'utf8')).schema).toBe(1);
    } finally { legacy.mockRestore(); await fixture.cleanup(); }
  });
  it('retires the genuine head, every attributed archive byte and terminal evidence', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const reports: unknown[] = [];
    const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator, afterErasureWork: report => { reports.push(report); } });
    try {
      const result = await owners.eraseOwned(fixture.request);
      expect(result).toEqual({ status: 'erased', evidence: { tenantRoot: fixture.root, userId: fixture.token.userId,
        ownerId: fixture.token.ownerId, operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId } });
      for (const locator of [fixture.token.locator, `volumes/by-id/${fixture.token.ownerId}`,
        `.memory-owners/owners/${fixture.token.ownerId}.json`, `.memory-owners/owners/${fixture.token.ownerId}.erase.json`]) {
        await expect(fs.lstat(path.join(fixture.root, locator))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect((await fs.readdir(path.join(fixture.root, '.memory-owners/owners'))).filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ actual: { archiveMutationAttempts: expect.any(Number) }, head: { directoryReads: expect.any(Number) } });
    } finally { await fixture.cleanup(); }
  });
  it.each(['no-volumes', 'no-by-id', 'no-owner-root', 'empty-owner-root', 'mixed'] as const)(
    'qualifies the fixed canonical archive witness and cleanup for %s', async archive => {
      const fixture = await makeOwnedErasureFixture({ archive, volumes: 2 });
      try {
        const result = await fixture.owners.eraseOwned(fixture.request);
        expect(result.status).toBe('erased');
        await expect(fs.lstat(path.join(fixture.root, fixture.token.locator))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.lstat(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await fs.readdir(path.join(fixture.root, '.memory-owners/owners'))).filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
        if (archive === 'no-volumes') await expect(fs.lstat(path.join(fixture.root, 'volumes'))).rejects.toMatchObject({ code: 'ENOENT' });
        if (archive === 'no-by-id') await expect(fs.lstat(path.join(fixture.root, 'volumes/by-id'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await fixture.cleanup(); }
    });
  it.each([['volumes', 'Volumes'], ['volumes/by-id', 'volumes/By-ID']] as const)(
    'refuses a spelling alias instead of granting first-missing authority for %s', async (canonical, alias) => {
      const fixture = await makeOwnedErasureFixture({ volumes: 2 });
      try {
        await fs.rename(path.join(fixture.root, canonical), path.join(fixture.root, alias));
        const before = await captureErasureTree(path.join(fixture.root, alias));
        const error = await fixture.owners.eraseOwned(fixture.request).catch(cause => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toHaveProperty('result');
        expect(await captureErasureTree(path.join(fixture.root, alias))).toEqual(before);
      } finally { await fixture.cleanup(); }
    });
  it.each(['head-prepared-durable', 'ready-durable'] as const)('resumes a genuine %s interruption without inventing a prior receipt', async publication => {
    const fixture = await makeOwnedErasureFixture({ nested: true, volumes: 2 });
    const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
    try {
      const before = await captureErasureTree(selected), stop = new Error(`stop at ${publication}`);
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === publication) throw stop; } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toBeDefined();
      expect(await captureErasureTree(selected)).toEqual(before);
      const result = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId });
      expect(result.status).toBe('erased');
      await expect(fs.lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.readdir(path.join(fixture.root, '.memory-owners/owners'))).filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
  it.each(['inventory-durable', 'action-prepared-durable', 'after-owner-action', 'owner-root-removed-durable',
    'evidence-retiring-durable', 'retire-action-prepared-durable', 'after-evidence-retirement'] as const)(
    'continues the exact surviving authority after %s', async publication => {
      const fixture = await makeOwnedErasureFixture({ volumes: 2 });
      try {
        let stopped = false;
        const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
          afterErasurePublication: phase => { if (phase === publication && !stopped) { stopped = true; throw new Error(`interrupt ${publication}`); } } });
        await expect(interrupted.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
        expect(stopped).toBe(true);
        const result = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
          operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId });
        expect(['erased', 'already-erased']).toContain(result.status);
        await expect(fs.lstat(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await fs.readdir(path.join(fixture.root, '.memory-owners/owners'))).filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
      } finally { await fixture.cleanup(); }
    });
  it('preserves incomplete immutable preparation without granting archive deletion authority', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), registry = path.join(fixture.root, '.memory-owners/owners');
    try {
      const before = await captureErasureTree(selected);
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'segment-durable') throw new Error('incomplete inventory'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
      const evidence = await captureErasureTree(registry);
      await expect(fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId })).rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
      expect(await captureErasureTree(selected)).toEqual(before); expect(await captureErasureTree(registry)).toEqual(evidence);
    } finally { await fixture.cleanup(); }
  });
  it('refuses a mixed-version segment even when its forged anchor binds the actual replacement bytes', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'inventory-durable') throw new Error('mixed-version window'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toBeDefined();
      const registry = path.join(fixture.root, '.memory-owners/owners'), journal = path.join(registry, fixture.token.ownerId + '.erase.json');
      const record = erasureParseRecord(await fs.readFile(journal, 'utf8')), anchor = record.manifest!.anchor!;
      const target = path.join(registry, erasureSegmentName(fixture.token.ownerId, fixture.request.operationId, anchor.ordinal));
      const segment = erasureParseSegment(await fs.readFile(target, 'utf8'));
      const raw = erasureSerialize({ ...segment, ...ERASURE_LEGACY_PROTOCOL });
      await fs.writeFile(target, raw);
      const stat = await fs.lstat(target, { bigint: true });
      record.manifest!.anchor = { ordinal: anchor.ordinal, digest: createHash('sha256').update(raw).digest('hex'), identity: {
        device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } };
      await fs.writeFile(journal, erasureSerialize(record));
      const archive = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
      const before = { archive: await captureErasureTree(archive), registry: await captureErasureTree(registry) };
      const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
      expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('result'); expect(error).not.toHaveProperty('headDeleted');
      expect({ archive: await captureErasureTree(archive), registry: await captureErasureTree(registry) }).toEqual(before);
    } finally { await fixture.cleanup(); }
  });
  it('refuses a pending action whose declared target differs from authenticated inventory', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'action-prepared-durable') throw new Error('pending action'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
      const journal = path.join(fixture.root, '.memory-owners/owners', `${fixture.token.ownerId}.erase.json`);
      const record = erasureParseRecord(await fs.readFile(journal, 'utf8'));
      record.action!.name = 'different-target';
      await fs.writeFile(journal, erasureSerialize(record));
      const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
      const registry = path.join(fixture.root, '.memory-owners/owners');
      const before = { archive: await captureErasureTree(selected), registry: await captureErasureTree(registry) };
      const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
      expect(error).toMatchObject({ code: 'EERASURERESIDUAL' });
      expect(error).not.toHaveProperty('headDeleted'); expect(error).not.toHaveProperty('result');
      expect({ archive: await captureErasureTree(selected), registry: await captureErasureTree(registry) }).toEqual(before);
    } finally { await fixture.cleanup(); }
  });
  it('preserves remaining evidence when a pending retirement declares different artifact metadata', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'retire-action-prepared-durable') throw new Error('pending retirement'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
      const registry = path.join(fixture.root, '.memory-owners/owners');
      const journal = path.join(registry, `${fixture.token.ownerId}.erase.json`);
      const record = erasureParseRecord(await fs.readFile(journal, 'utf8'));
      record.retirement!.artifact.mode = '0';
      await fs.writeFile(journal, erasureSerialize(record));
      const before = await captureErasureTree(registry);
      const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
      expect(error).toMatchObject({ code: 'EERASURERESIDUAL' }); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(registry)).toEqual(before);
    } finally { await fixture.cleanup(); }
  });
  it.each(['changed-survivor', 'new-child'] as const)('takes a fresh complete proof after a hook introduces %s', async change => {
    const fixture = await makeOwnedErasureFixture({ archive: 'mixed', volumes: 2 });
    try {
      const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
      let before: Awaited<ReturnType<typeof captureErasureTree>> | undefined;
      let archiveAttempts: number | undefined;
      const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: async phase => {
          if (phase !== 'before-owner-action') return;
          await fs.writeFile(path.join(selected, change === 'new-child' ? 'new-private-child' : 'unknown-private/opaque.bin'),
            'changed fixture bytes', { mode: 0o600 });
          before = await captureErasureTree(selected);
        },
        afterErasureWork: report => { archiveAttempts = report.actual.archiveMutationAttempts; } });
      const error = await owners.eraseOwned(fixture.request).catch(cause => cause);
      expect(error).toMatchObject({ headDeleted: true, archiveMutationAttempted: false });
      expect(error).not.toHaveProperty('result'); expect(before).toBeDefined(); expect(archiveAttempts).toBe(0);
      expect(await captureErasureTree(selected)).toEqual(before);
    } finally { await fixture.cleanup(); }
  });
  it('refuses surplus selected evidence before retiring any further attribution record', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const registry = path.join(fixture.root, '.memory-owners/owners');
      let before: Awaited<ReturnType<typeof captureErasureTree>> | undefined;
      const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: async phase => {
          if (phase !== 'retire-action-prepared-durable') return;
          await fs.writeFile(path.join(registry, `${fixture.token.ownerId}.erase-surplus.json`), '{}', { mode: 0o600, flag: 'wx' });
          before = await captureErasureTree(registry);
        } });
      await expect(owners.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
      expect(before).toBeDefined(); expect(await captureErasureTree(registry)).toEqual(before);
      const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
      expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(registry)).toEqual(before);
    } finally { await fixture.cleanup(); }
  });
  it.each(['Notes', '.memory-owners', '.memory-owners/owners', '.memory-fences'])(
    'refuses an archive-chain physical alias to independent namespace %s', async namespace => {
    const fixture = await makeOwnedErasureFixture({ nested: true, volumes: 2 });
    const genuine = ErasureInspection.prototype.sharedDirectory;
    const spy = jest.spyOn(ErasureInspection.prototype, 'sharedDirectory').mockImplementation(async function(this: ErasureInspection, locator, privateMode) {
      if (locator !== 'volumes/by-id') return genuine.call(this, locator, privateMode);
      // The conflicting identity is an actual independently observed directory, not fabricated stat values.
      const registry = await genuine.call(this, namespace, privateMode);
      const selected = await genuine.call(this, locator, privateMode);
      return { ...selected, identity: registry.identity };
    });
    try {
      const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), before = await captureErasureTree(selected);
      const error = await fixture.owners.eraseOwned(fixture.request).catch(cause => cause);
      expect(error).toHaveProperty('headDeleted', true); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(selected)).toEqual(before);
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });
  it.each([
    ['ready-durable', 'published'], ['inventory-durable', 'published'],
    ['evidence-retiring-durable', 'published'], ['ready-durable', 'no-volumes'],
  ] as const)('preserves a genuine flat replacement owner after %s with %s archives', async (publication, archive) => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2, archive });
    try {
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === publication) throw new Error('replacement window'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
      await fs.writeFile(path.join(fixture.root, fixture.token.locator), 'entries: []\n', { mode: 0o600, flag: 'wx' });
      const snapshot = await fixture.owners.readHeadSnapshot(fixture.token.locator);
      const replacement = await fixture.owners.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
      expect(replacement.ownerId).not.toBe(fixture.token.ownerId);
      const files = [path.join(fixture.root, fixture.token.locator),
        path.join(fixture.root, `.${createHash('sha256').update(fixture.token.locator).digest('hex')}.memory-owner.json`),
        path.join(fixture.root, '.memory-owners/owners', `${replacement.ownerId}.json`)];
      const before = await captureErasureFiles(files);
      const result = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId });
      expect(['erased', 'already-erased']).toContain(result.status);
      expect(await captureErasureFiles(files)).toEqual(before);
      expect((await fixture.owners.readHeadSnapshot(fixture.token.locator)).token).toEqual(replacement);
      await expect(fs.lstat(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId))).rejects.toMatchObject({ code: 'ENOENT' });
      if (archive === 'no-volumes') await expect(fs.lstat(path.join(fixture.root, 'volumes'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fixture.cleanup(); }
  });
  it.each(['sidecar', 'registry'] as const)('refuses padded replacement %s metadata beyond the existing ownership bound', async selected => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'ready-durable') throw new Error('replacement window'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
      await fs.writeFile(path.join(fixture.root, fixture.token.locator), 'entries: []\n', { mode: 0o600, flag: 'wx' });
      const snapshot = await fixture.owners.readHeadSnapshot(fixture.token.locator);
      const replacement = await fixture.owners.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
      const sidecar = path.join(fixture.root, `.${createHash('sha256').update(fixture.token.locator).digest('hex')}.memory-owner.json`);
      const registry = path.join(fixture.root, '.memory-owners/owners', `${replacement.ownerId}.json`);
      const target = selected === 'sidecar' ? sidecar : registry;
      const raw = await fs.readFile(target, 'utf8');
      await fs.writeFile(target, raw + ' '.repeat(4097 - Buffer.byteLength(raw, 'utf8')));
      const archive = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
      const before = await captureErasureTree(archive);
      const files = [path.join(fixture.root, fixture.token.locator), sidecar, registry];
      const ownership = await captureErasureFiles(files);
      await expect(fixture.owners.readHeadSnapshot(fixture.token.locator)).rejects.toBeDefined();
      const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
      expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(archive)).toEqual(before);
      expect(await captureErasureFiles(files)).toEqual(ownership);
    } finally { await fixture.cleanup(); }
  });
  it('accounts the extra genuine replacement observation during HEAD_PREPARED recovery', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const reserve = ErasureAccounting.prototype.reserveOperations;
    const headAllowances: number[] = [];
    const readReplacement = ErasureInspection.prototype.replacementHead;
    let replacementCalls = 0, readyCalls: number | undefined;
    const readSpy = jest.spyOn(ErasureInspection.prototype, 'replacementHead').mockImplementation(function(this: ErasureInspection, locator) {
      replacementCalls++; return readReplacement.call(this, locator);
    });
    const spy = jest.spyOn(ErasureAccounting.prototype, 'reserveOperations').mockImplementation(function(this: ErasureAccounting, remaining, phase) {
      if (phase === 'head-tail') headAllowances.push(remaining.replacementHeadReadBytes);
      return reserve.call(this, remaining, phase);
    });
    try {
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterDeletePublication: phase => { if (phase === 'after-intent-retirement') throw new Error('HEAD_PREPARED tail'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toBeDefined();
      await fs.writeFile(path.join(fixture.root, fixture.token.locator), 'entries: []\n', { mode: 0o600, flag: 'wx' });
      const snapshot = await fixture.owners.readHeadSnapshot(fixture.token.locator);
      const replacement = await fixture.owners.adoptUnowned(snapshot.token as UnownedFileMemoryToken);
      const files = [path.join(fixture.root, fixture.token.locator),
        path.join(fixture.root, `.${createHash('sha256').update(fixture.token.locator).digest('hex')}.memory-owner.json`),
        path.join(fixture.root, '.memory-owners/owners', `${replacement.ownerId}.json`)];
      const before = await captureErasureFiles(files);
      const recovering = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'ready-durable') readyCalls = replacementCalls; } });
      await expect(recovering.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId })).resolves.toMatchObject({ status: 'erased' });
      expect(readyCalls).toBe(18);
      expect(headAllowances).toEqual([18 * (3 * MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE + 1)]);
      expect(await captureErasureFiles(files)).toEqual(before);
    } finally { readSpy.mockRestore(); spy.mockRestore(); await fixture.cleanup(); }
  });
  it('does not claim qualified head deletion from a READY state with changed current parent authority', async () => {
    const fixture = await makeOwnedErasureFixture({ nested: true, volumes: 2 });
    try {
      await fs.mkdir(path.join(fixture.root, 'Other'), { mode: 0o700 });
      const other = await fs.lstat(path.join(fixture.root, 'Other'), { bigint: true });
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'ready-durable') throw new Error('ready interruption'); } });
      await expect(interrupted.eraseOwned(fixture.request)).rejects.toMatchObject({ headDeleted: true });
      const journal = path.join(fixture.root, '.memory-owners/owners', `${fixture.token.ownerId}.erase.json`);
      const record = erasureParseRecord(await fs.readFile(journal, 'utf8'));
      record.head.namespace.find(item => item.locator === 'Notes')!.inode = String(other.ino);
      await fs.writeFile(journal, erasureSerialize(record));
      const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), before = await captureErasureTree(selected);
      const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
      expect(error).toMatchObject({ code: 'EERASURERESIDUAL' }); expect(error).not.toHaveProperty('headDeleted'); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(selected)).toEqual(before);
    } finally { await fixture.cleanup(); }
  });
  it('keeps actual final R close refusal ambiguous and discloses the no-record acknowledgment gap', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const registry = path.join(fixture.root, '.memory-owners/owners'), cause = new Error('final erasure close refused');
    type Internals = { closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown> };
    const prototype = ErasureInspection.prototype as unknown as Internals, original = prototype.closed;
    let refused = false;
    const spy = jest.spyOn(prototype, 'closed').mockImplementation(async function(this: Internals, handle, body) {
      if (!(await fs.readdir(registry)).some(name => name.startsWith(fixture.token.ownerId))) {
        const sync = handle.sync.bind(handle), close = handle.close.bind(handle); let synced = false;
        handle.sync = async () => { await sync(); synced = true; };
        handle.close = async () => { await close(); if (synced) { refused = true; throw cause; } };
      }
      return original.call(this, handle, body);
    });
    try {
      const error = await fixture.owners.eraseOwned(fixture.request).catch(value => value);
      expect(refused).toBe(true); expect(error).toMatchObject({ code: 'EERASURECOMMITUNKNOWN', headDeleted: true });
      expect(error.cause.cause).toBe(cause); expect(error).not.toHaveProperty('result');
      await expect(fs.lstat(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.readdir(registry)).filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
      spy.mockRestore();
      const later = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
        operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(value => value);
      expect(later).toMatchObject({ code: 'EERASURERESIDUAL' }); expect(later).not.toHaveProperty('result');
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });
  it('retains only the genuine captured erasure result after a later audit boundary failure', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const cause = new Error('controlled post-capture failure');
      const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: phase => { if (phase === 'after-audit') throw cause; } });
      const error = await owners.eraseOwned(fixture.request).catch(failure => failure);
      expect(error).toMatchObject({ code: 'EOWNERERASED', result: { status: 'erased', evidence: {
        ownerId: fixture.token.ownerId, operationId: fixture.request.operationId,
        deleteOperationId: fixture.request.deleteOperationId } } });
      expect(error.cause.cause).toBe(cause);
      await expect(fs.lstat(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fixture.cleanup(); }
  });
  it('refuses a wide registry at inherited public head admission before any erasure publication', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const registry = path.join(fixture.root, '.memory-owners/owners');
    try {
      // This genuine fresh request hits DELETE's 532,480-read ceiling before the later
      // erasure composed-family guard; it does not fabricate post-head authority.
      for (let offset = 0; offset < 4091; offset += 16) {
        await Promise.all(Array.from({ length: Math.min(16, 4091 - offset) }, (_, index) =>
          fs.writeFile(path.join(registry, `unrelated-${offset + index}`), 'retained', { mode: 0o600 })));
      }
      const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
      const head = path.join(fixture.root, fixture.token.locator), parent = path.dirname(head);
      const sidecar = path.join(parent, `.${createHash('sha256').update(path.basename(head)).digest('hex')}.memory-owner.json`);
      const headNames = (await fs.readdir(parent)).sort();
      const before = { archive: await captureErasureTree(selected), registry: await captureErasureTree(registry),
        head: await captureErasureFiles([head, sidecar]) };
      let publication = false;
      const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator,
        afterErasurePublication: () => { publication = true; } });
      const error = await owners.eraseOwned(fixture.request).catch(value => value);
      expect(publication).toBe(false);
      expect(error).toMatchObject({ code: 'EHEADCONFLICT' });
      expect(error.cause).toBeInstanceOf(FileMemoryDirectoryScanLimitError);
      expect(error.cause).toMatchObject({ code: 'EHEADRESOURCE', message: 'Memory directory inspection budget exhausted' });
      expect(error).not.toHaveProperty('result'); expect(error).not.toHaveProperty('headDeleted');
      expect({ archive: await captureErasureTree(selected), registry: await captureErasureTree(registry),
        head: await captureErasureFiles([head, sidecar]) }).toEqual(before);
      await expect(fs.lstat(path.join(registry, `${fixture.token.ownerId}.erase.json`))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.readdir(parent)).sort()).toEqual(headNames);
      expect((await fs.readdir(registry)).filter(name => name.startsWith(`${fixture.token.ownerId}.erase`))).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
  it('retains the qualified result and exact cause after actual outer lease release fails', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2, foreignOwners: 100 });
    const foreign = await captureErasureFiles(fixture.foreignFiles);
    const prototype = FileMemoryFence.prototype as unknown as { release(lease: unknown): Promise<void> };
    const original = prototype.release, cause = Object.assign(new Error('controlled post-release failure'), { code: 'EIO' });
    let released = false;
    const spy = jest.spyOn(prototype, 'release').mockImplementation(async function(this: FileMemoryFence, lease) {
      await original.call(this, lease); released = true; throw cause;
    });
    try {
      const error = await fixture.owners.eraseOwned(fixture.request).catch(value => value);
      expect(released).toBe(true);
      expect(error).toMatchObject({ code: 'EOWNERERASED', result: { status: 'erased', evidence: {
        ownerId: fixture.token.ownerId, operationId: fixture.request.operationId,
        deleteOperationId: fixture.request.deleteOperationId } } });
      expect(error.cause).toBe(cause);
      await expect(fs.lstat(path.join(fixture.root, fixture.token.locator))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(path.join(fixture.root, '.memory-fences/tenant.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.readdir(path.join(fixture.root, '.memory-owners/owners')))
        .filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
      expect(await captureErasureFiles(fixture.foreignFiles)).toEqual(foreign);
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });
  it('keeps ordinary DELETE head-only and refuses to upgrade its minimal tombstone into erasure authority', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), before = await captureErasureTree(selected);
      const result = await fixture.owners.deleteOwned({ operationId: fixture.request.deleteOperationId, expectedToken: fixture.token });
      expect(result).toMatchObject({ status: 'head-deleted', erasure: 'pending' });
      expect(await captureErasureTree(selected)).toEqual(before);
      await expect(fs.lstat(path.join(fixture.root, '.memory-owners/owners', `${fixture.token.ownerId}.erase.json`))).rejects.toMatchObject({ code: 'ENOENT' });
      const error = await fixture.owners.eraseOwned(fixture.request).catch(value => value);
      expect(error).toMatchObject({ code: 'EERASURERESIDUAL' }); expect(error).not.toHaveProperty('result');
      expect(await captureErasureTree(selected)).toEqual(before);
    } finally { await fixture.cleanup(); }
  });
});
