import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs/promises';
import * as path from 'node:path';
const open = jest.fn(realFs.open);
jest.unstable_mockModule('node:fs/promises', () => ({ ...realFs, open }));
const { FileMemoryOwnerSnapshots } = await import('../../../src/storage/FileMemoryOwnerSnapshots.js');
const { FileMemoryOwnedErasure } = await import('../../../src/storage/FileMemoryOwnedErasure.js');
const { ErasureInspection } = await import('../../../src/storage/FileMemoryErasureInspection.js');
const { ERASURE_LEGACY_PROTOCOL } = await import('../../../src/storage/FileMemoryErasureEvidence.js');
const { makeOwnedErasureFixture, captureErasureTree, captureErasureFiles } = await import('./fixtures/ownedErasureFixture.js');
function causes(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [value];
  const error = value as Error & { errors?: unknown[] };
  return [value, ...(error.errors ?? []).flatMap(causes), ...(error.cause ? causes(error.cause) : [])];
}
afterEach(() => { open.mockReset(); open.mockImplementation(realFs.open); jest.restoreAllMocks(); });
(process.platform === 'win32' || !process.getuid ? describe.skip : describe)('public bounded selected proof scheduling', () => {
  it.each(['multiple', 'single', 'legacy'] as const)('drains actual selected observations and preserves ordered failure authority (%s)', async mode => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
    const registry = path.join(fixture.root, '.memory-owners/owners');
    const foreign = path.join(fixture.root, 'unrelated-private-bytes');
    await realFs.writeFile(foreign, 'foreign evidence retained', { mode: 0o600 });
    for (let index = 0; index < 20; index++) await realFs.writeFile(path.join(selected, `a${String(index).padStart(3, '0')}`), `selected ${index}`, { mode: 0o600 });
    const foreignBefore = await captureErasureFiles([foreign]);
    const legacyInterruption = new Error('genuine V1 inventory interruption');
    const closeFailure = Object.assign(new Error('actual sibling descriptor close refusal'), { code: 'EIO' });
    let armed = false, active = 0, peak = 0, pending = 0, closedFailure = false;
    const started: string[] = [], completed: string[] = [], publications: string[] = [];
    let preserved: Awaited<ReturnType<typeof captureErasureTree>> | undefined;
    let registryBefore: Awaited<ReturnType<typeof captureErasureTree>> | undefined;
    const boundaryErrors: unknown[] = [];
    const proofPrototype = FileMemoryOwnedErasure.prototype as unknown as {
      proofFailures(results: readonly PromiseSettledResult<void>[]): void;
    };
    const originalProofFailures = proofPrototype.proofFailures;
    jest.spyOn(proofPrototype, 'proofFailures').mockImplementation(function(this: typeof proofPrototype, results) {
      try { return originalProofFailures.call(this, results); }
      catch (cause) { boundaryErrors.push(cause); throw cause; }
    });
    const originalFile = ErasureInspection.prototype.file;
    jest.spyOn(ErasureInspection.prototype, 'file').mockImplementation(async function(this: InstanceType<typeof ErasureInspection>, locator: string) {
      if (!armed || !locator.startsWith(`volumes/by-id/${fixture.token.ownerId}/`)) return originalFile.call(this, locator);
      const name = path.basename(locator); started.push(name); active++; peak = Math.max(peak, active);
      try { return await originalFile.call(this, locator); }
      finally { active--; completed.push(name); }
    });
    open.mockImplementation(async (...args: Parameters<typeof realFs.open>) => {
      const handle = await realFs.open(...args), target = String(args[0]);
      if (armed && target === path.join(selected, mode === 'multiple' ? 'a001' : 'a000')) {
        pending++; const originalClose = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => {
          try { await originalClose(); closedFailure = true; throw closeFailure; }
          finally { pending--; }
        });
      }
      return handle;
    });
    const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator, afterErasurePublication: async phase => {
      publications.push(phase);
      if (phase !== 'inventory-durable') return;
      if (mode === 'legacy') throw legacyInterruption;
      if (mode === 'multiple') await realFs.chmod(path.join(selected, 'a000'), 0o644);
      preserved = await captureErasureTree(selected); registryBefore = await captureErasureTree(registry); armed = true;
    } });
    const legacy = mode === 'legacy' ? jest.spyOn(FileMemoryOwnedErasure.prototype, 'protocol', 'get').mockReturnValue(ERASURE_LEGACY_PROTOCOL) : undefined;
    try {
      const initial = await owners.eraseOwned(fixture.request).catch(error => error);
      legacy?.mockRestore();
      let failure = initial;
      if (mode === 'legacy') {
        expect(causes(initial)).toContain(legacyInterruption);
        const journal = JSON.parse(await realFs.readFile(path.join(registry, `${fixture.token.ownerId}.erase.json`), 'utf8'));
        expect(journal).toMatchObject({ schema: 1, domain: ERASURE_LEGACY_PROTOCOL.domain, state: 'INVENTORY_READY' });
        preserved = await captureErasureTree(selected); registryBefore = await captureErasureTree(registry); armed = true;
        failure = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId, operationId: fixture.request.operationId,
          deleteOperationId: fixture.request.deleteOperationId }).catch(error => error);
      }
      expect(failure).toBeInstanceOf(Error); expect(failure).not.toHaveProperty('result');
      expect(active).toBe(0); expect(pending).toBe(0); expect(closedFailure).toBe(true);
      expect([...completed].sort()).toEqual([...started].sort());
      expect(started).not.toContain('a016'); expect(publications).not.toContain('action-prepared-durable');
      if (mode === 'legacy') { expect(peak).toBe(1); expect(started).toEqual(['a000']); }
      else { expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(16); }
      if (mode === 'single') { expect(boundaryErrors).toHaveLength(1); expect(boundaryErrors[0]).toBe(closeFailure); }
      const nested = causes(failure);
      expect(nested).toContain(closeFailure);
      if (mode === 'multiple') {
        const aggregate = nested.find(value => value instanceof AggregateError && value.errors.includes(closeFailure)) as AggregateError;
        expect(aggregate).toBeDefined(); expect(aggregate.errors).toHaveLength(2);
        expect(aggregate.errors[0]).toMatchObject({ code: 'EERASURERESIDUAL' });
        expect(aggregate.errors[1]).toBe(closeFailure); expect(aggregate.cause).toBe(aggregate.errors[0]);
        expect(aggregate).toMatchObject({ code: 'EERASURERESIDUAL' });
      }
      armed = false;
      expect(await captureErasureTree(selected)).toEqual(preserved);
      expect(await captureErasureFiles([foreign])).toEqual(foreignBefore);
      expect(await captureErasureTree(registry)).toEqual(registryBefore);
    } finally { armed = false; legacy?.mockRestore(); await fixture.cleanup(); }
  }, 10_000);
});
