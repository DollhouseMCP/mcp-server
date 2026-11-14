import { describe, expect, it as jestIt } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileMemoryOwnerSnapshots, type OwnedErasureWorkReport } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { runErasureCapacityLifecycle, capacityObserverTimeoutMs } from './fixtures/erasureCapacityLifecycle.js';
import { captureErasureFiles, makeOwnedErasureFixture } from './fixtures/ownedErasureFixture.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const cases = ([100, 250, 1000] as const).flatMap(foreignOwners =>
  [false, true].flatMap(nested => ([2, 10] as const).map(volumes => ({ foreignOwners, nested, volumes }))));

describe('dormant owner erasure populated portfolios', () => {
  for (const options of cases) {
    // Measured whole-case maxima: 8.50s for small/two-volume, 31.93s for
    // small/ten-volume, 39.37s for 1,000-owner/two-volume, 53.99s for the
    // largest tier (#3090, #3146). Allow 50% runner variance, rounded up to
    // 30s: 30/60/60/90s. Both layouts use the same workload tier. The work
    // counters and every foreign-file preservation assertion remain gates.
    const deadlineMs = 30_000 + (options.foreignOwners === 1000 ? 30_000 : 0)
      + (options.volumes === 10 ? 30_000 : 0);
    it(`erases ${options.volumes} volumes with ${options.foreignOwners} foreign owners, nested=${options.nested}`, async () => {
      let report: OwnedErasureWorkReport | undefined;
      let operationMs: number | undefined;
      let verificationMs: number | undefined;
      await runErasureCapacityLifecycle({ deadlineMs, label: JSON.stringify(options), completed: timing => {
        console.info('ERASURE capacity complete', JSON.stringify({ ...options, ...timing, deadlineMs,
          operationMs, verificationMs, report }));
      } }, async lifecycle => {
        const started = lifecycle.started;
        const fixture = await makeOwnedErasureFixture({ ...options, archive: 'published' }, root => {
          lifecycle.registerCleanup(() => fs.rm(root, { recursive: true, force: true }), root);
        });
        lifecycle.registerCleanup(fixture.cleanup, fixture.root);
        const phase = (name: string) => { lifecycle.phase(name); console.info('ERASURE capacity phase', JSON.stringify({ ...options, phase: name,
          elapsedMs: performance.now() - started, node: process.version, pid: process.pid })); };
        const before = await captureErasureFiles(fixture.foreignFiles);
        const head = path.join(fixture.root, fixture.token.locator);
        const headNames = (await fs.readdir(path.dirname(head))).sort();
        const selectedOwner = path.join(fixture.root, 'volumes', 'by-id', fixture.token.ownerId);
        const owners = new FileMemoryOwnerSnapshots({ coordinator: fixture.coordinator, afterErasureWork: value => { report = value; } });
        const setupMs = performance.now() - started;
        phase('setup-complete');
        const operationStarted = performance.now();
        const result = await owners.eraseOwned(fixture.request);
        operationMs = performance.now() - operationStarted;
        phase('operation-end');
        const verificationStarted = performance.now();
        expect(result.status).toBe('erased');
        await expect(fs.lstat(head)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.lstat(selectedOwner)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await captureErasureFiles(fixture.foreignFiles)).toEqual(before);
        // Exact remaining names exclude only the selected head and its own
        // sidecar; complete foreign names, bytes and full identities survive.
        const sidecar = headNames.find(name => name.endsWith('.memory-owner.json') && !fixture.foreignFiles.includes(path.join(path.dirname(head), name)));
        expect((await fs.readdir(path.dirname(head))).sort()).toEqual(headNames.filter(name => name !== path.basename(head) && name !== sidecar));
        const registryNames = await fs.readdir(path.join(fixture.root, '.memory-owners', 'owners'));
        expect(registryNames.some(name => name.startsWith(fixture.token.ownerId))).toBe(false);
        expect(report).toBeDefined();
        expect(report!.actual.directoryReads).toBeLessThanOrEqual(report!.reservedDirectoryReads!);
        expect(report!.discovery).toBeLessThanOrEqual(4096);
        if (report!.head) expect(report!.head.directoryReads).toBeLessThanOrEqual(report!.head.reservedDirectoryReads);
        verificationMs = performance.now() - verificationStarted;
        phase('assertions-complete');
        console.info('ERASURE capacity work', JSON.stringify({ ...options, setupMs, operationMs, verificationMs,
          preCleanupMs: performance.now() - started, discoveryReads: report!.discovery,
          reservedDirectoryReads: report!.reservedDirectoryReads, actual: report!.actual, head: report!.head }));
      });
    }, capacityObserverTimeoutMs(deadlineMs));
  }
});
