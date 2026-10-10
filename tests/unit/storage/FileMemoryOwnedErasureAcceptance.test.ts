import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileMemoryOwnerSnapshots, type ErasurePublication } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { erasureParseRecord, erasureParseSegment, erasureSegmentName } from '../../../src/storage/FileMemoryErasureEvidence.js';
import { makeOwnedErasureFixture, captureErasureTree } from './fixtures/ownedErasureFixture.js';
function containsCause(value: unknown, target: Error): boolean {
  if (value === target) return true;
  if (!value || typeof value !== 'object') return false;
  const error = value as Error & { errors?: unknown[] };
  return containsCause(error.cause, target) || (error.errors ?? []).some(cause => containsCause(cause, target));
}
function interruption(coordinator: Awaited<ReturnType<typeof makeOwnedErasureFixture>>['coordinator'], phase: ErasurePublication) {
  const cause = new Error(`exact acceptance interruption at ${phase}`); let reached = false;
  const owners = new FileMemoryOwnerSnapshots({ coordinator, afterErasurePublication: actual => {
    if (actual === phase) { reached = true; throw cause; }
  } });
  return { owners, cause, reached: () => reached };
}
function assertBinding(record: ReturnType<typeof erasureParseRecord>, fixture: Awaited<ReturnType<typeof makeOwnedErasureFixture>>, state: string) {
  expect(record).toMatchObject({ state, ownerId: fixture.token.ownerId, operationId: fixture.request.operationId,
    deleteOperationId: fixture.request.deleteOperationId, userId: fixture.token.userId });
}
/** Constant-size observations only; timing/output cannot replace an operation failure. */
function retiredPrefixTiming() {
  let started = 0, unavailable = false, flushed = false;
  const samples: { phase: string; elapsedMs: number }[] = [];
  try { started = performance.now(); } catch { unavailable = true; }
  return {
    mark(phase: string) {
      if (flushed || unavailable) return;
      try {
        if (samples.length >= 16) { unavailable = true; return; }
        samples.push({ phase, elapsedMs: performance.now() - started });
      } catch { unavailable = true; }
    },
    flush(observation: 'body-finally' | 'setup-failed' | 'jest-afterEach') {
      if (flushed) return;
      flushed = true;
      try { process.stderr.write(`ERASURE retired-prefix timing ${JSON.stringify({ node: process.version, observation, unavailable, samples })}\n`); }
      catch { /* Diagnostic output must preserve the original operation/cleanup outcome. */ }
    },
  };
}
let activeRetiredPrefixTiming: ReturnType<typeof retiredPrefixTiming> | undefined;
// A timed-out async body can remain pending. Emit its bounded partial phases without cancelling it.
afterEach(() => { activeRetiredPrefixTiming?.flush('jest-afterEach'); });
const supported = process.platform !== 'win32' && !!process.getuid;
(supported ? describe : describe.skip)('remaining public owner erasure authority acceptance', () => {
  it.each(['no-volumes', 'no-by-id', 'no-owner-root'] as const)('recovers the exact first-missing witness at READY and retirement (%s)', async archive => {
    const fixture = await makeOwnedErasureFixture({ archive, volumes: 2 });
    const missing = path.join(fixture.root, archive === 'no-volumes' ? 'volumes' : archive === 'no-by-id' ? 'volumes/by-id' : `volumes/by-id/${fixture.token.ownerId}`);
    const request = { ownerId: fixture.token.ownerId, operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId };
    try {
      const writer = interruption(fixture.coordinator, 'ready-durable');
      const failure = await writer.owners.eraseOwned(fixture.request).catch(cause => cause);
      expect(writer.reached()).toBe(true); expect(containsCause(failure, writer.cause)).toBe(true);
      assertBinding(erasureParseRecord(await fs.readFile(path.join(fixture.root, '.memory-owners/owners', `${fixture.token.ownerId}.erase.json`), 'utf8')), fixture, 'ERASURE_READY');
      await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
      const retirement = interruption(fixture.coordinator, 'evidence-retiring-durable');
      const retirementFailure = await retirement.owners.recoverOwnedErasure(request).catch(cause => cause);
      expect(retirement.reached()).toBe(true); expect(containsCause(retirementFailure, retirement.cause)).toBe(true);
      const journal = erasureParseRecord(await fs.readFile(path.join(fixture.root, '.memory-owners/owners', `${fixture.token.ownerId}.erase.json`), 'utf8'));
      assertBinding(journal, fixture, 'EVIDENCE_RETIRING'); expect(journal.archive!.firstMissing).toBe(archive === 'no-volumes' ? 1 : archive === 'no-by-id' ? 2 : 3);
      await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(['erased', 'already-erased']).toContain((await fixture.owners.recoverOwnedErasure(request)).status);
      await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fixture.cleanup(); }
  }, 10_000);
  it('refuses a newly appearing canonical chain on missing-witness recovery without deleting its bytes', async () => {
    const fixture = await makeOwnedErasureFixture({ archive: 'no-owner-root' });
    const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), registry = path.join(fixture.root, '.memory-owners/owners');
    try {
      const writer = interruption(fixture.coordinator, 'ready-durable');
      const failure = await writer.owners.eraseOwned(fixture.request).catch(cause => cause);
      expect(writer.reached()).toBe(true); expect(containsCause(failure, writer.cause)).toBe(true);
      assertBinding(erasureParseRecord(await fs.readFile(path.join(registry, `${fixture.token.ownerId}.erase.json`), 'utf8')), fixture, 'ERASURE_READY');
      await fs.mkdir(selected, { mode: 0o700 }); await fs.writeFile(path.join(selected, 'new-private'), 'newly appeared bytes', { mode: 0o600 });
      const before = { selected: await captureErasureTree(selected), registry: await captureErasureTree(registry) };
      await expect(fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId, operationId: fixture.request.operationId,
        deleteOperationId: fixture.request.deleteOperationId })).rejects.toBeDefined();
      expect({ selected: await captureErasureTree(selected), registry: await captureErasureTree(registry) }).toEqual(before);
    } finally { await fixture.cleanup(); }
  }, 10_000);
  it.each(['operationId', 'deleteOperationId'] as const)('refuses a wrong recovery %s without modifying actual selected authority', async field => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), registry = path.join(fixture.root, '.memory-owners/owners');
    try {
      const writer = interruption(fixture.coordinator, 'inventory-durable');
      const failure = await writer.owners.eraseOwned(fixture.request).catch(cause => cause);
      expect(writer.reached()).toBe(true); expect(containsCause(failure, writer.cause)).toBe(true);
      assertBinding(erasureParseRecord(await fs.readFile(path.join(registry, `${fixture.token.ownerId}.erase.json`), 'utf8')), fixture, 'INVENTORY_READY');
      const before = { selected: await captureErasureTree(selected), registry: await captureErasureTree(registry) };
      const request = { ownerId: fixture.token.ownerId, operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId,
        [field]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
      await expect(fixture.owners.recoverOwnedErasure(request)).rejects.toBeDefined();
      expect({ selected: await captureErasureTree(selected), registry: await captureErasureTree(registry) }).toEqual(before);
    } finally { await fixture.cleanup(); }
  }, 10_000);
  it.each(['tamper', 'missing', 'retired-prefix'] as const)('authenticates a genuine multiple-segment suffix (%s)', async change => {
    const timing = change === 'retired-prefix' ? retiredPrefixTiming() : undefined;
    if (timing) activeRetiredPrefixTiming = timing;
    timing?.mark('setup-start');
    const fixture = await makeOwnedErasureFixture({ volumes: 2 }).catch(cause => {
      timing?.mark('setup-failed'); timing?.flush('setup-failed'); throw cause;
    });
    timing?.mark('fixture-ready');
    const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId), registry = path.join(fixture.root, '.memory-owners/owners');
    // Real supported unknown private files increase encoded inventory width; no records are fabricated.
    const stop: ErasurePublication = change === 'retired-prefix' ? 'after-evidence-retirement' : 'inventory-durable';
    try {
    for (let index = 0; index < 16; index++) await fs.writeFile(path.join(selected, `${String(index).padStart(2, '0')}-${'x'.repeat(200)}`), 'private unknown', { mode: 0o600 });
      timing?.mark('setup-end');
      const writer = interruption(fixture.coordinator, stop);
      timing?.mark('erase-start');
      const failure = await writer.owners.eraseOwned(fixture.request).catch(cause => cause);
      timing?.mark('erase-end'); timing?.mark('verification-start');
      expect(writer.reached()).toBe(true); expect(containsCause(failure, writer.cause)).toBe(true);
      const journal = erasureParseRecord(await fs.readFile(path.join(registry, `${fixture.token.ownerId}.erase.json`), 'utf8'));
      assertBinding(journal, fixture, change === 'retired-prefix' ? 'RETIRE_ACTION_PREPARED' : 'INVENTORY_READY');
      expect(journal.manifest!.segments).toBeGreaterThan(1);
      const first = path.join(registry, erasureSegmentName(fixture.token.ownerId, fixture.request.operationId, 0));
      if (change === 'retired-prefix') {
        expect(journal.retirement!.kind).toBe('segment'); expect(journal.retirement!.successor!.ordinal).toBe(1);
        await expect(fs.lstat(first)).rejects.toMatchObject({ code: 'ENOENT' });
        timing?.mark('pre-recovery-verification-end'); timing?.mark('recovery-start');
        expect(['erased', 'already-erased']).toContain((await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
          operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId })).status);
        timing?.mark('recovery-end'); timing?.mark('post-recovery-verification-start');
        expect((await fs.readdir(registry)).filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
        timing?.mark('assertions-complete'); return;
      }
      const segment = erasureParseSegment(await fs.readFile(first, 'utf8'));
      expect(segment.successor!.ordinal).toBe(1);
      const successor = path.join(registry, erasureSegmentName(fixture.token.ownerId, fixture.request.operationId, 1));
      if (change === 'missing') await fs.unlink(successor);
      else await fs.appendFile(successor, ' '); // actual raw/identity tamper, not a forged replacement receipt
      const before = { selected: await captureErasureTree(selected), registry: await captureErasureTree(registry) };
      await expect(fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId, operationId: fixture.request.operationId,
        deleteOperationId: fixture.request.deleteOperationId })).rejects.toBeDefined();
      expect({ selected: await captureErasureTree(selected), registry: await captureErasureTree(registry) }).toEqual(before);
    } finally {
      timing?.mark('cleanup-start');
      try { await fixture.cleanup(); timing?.mark('cleanup-end'); }
      finally { timing?.mark('cleanup-finally'); timing?.flush('body-finally'); }
    }
  }, 10_000);
});
