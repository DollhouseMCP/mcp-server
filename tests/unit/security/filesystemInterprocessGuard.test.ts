import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  withFilesystemInterprocessGuard,
  type FilesystemProcessIncarnation,
} from '../../../src/security/filesystemInterprocessGuard.js';

const CURRENT_INCARNATION: FilesystemProcessIncarnation = {
  source: 'darwin-ps',
  bootId: 'current-boot',
  processStartId: 'current-process-start',
};

describe('withFilesystemInterprocessGuard recovery', () => {
  let rootDir: string;
  let guardPath: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-guard-recovery-'));
    guardPath = path.join(rootDir, 'operation.guard');
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('reclaims a stale owner when the PID was reused in the same boot', async () => {
    await seedAbandonedMarker(guardPath, 'owner', {
      source: 'darwin-ps',
      bootId: CURRENT_INCARNATION.bootId,
      processStartId: 'previous-process-start',
    });

    await expect(withFilesystemInterprocessGuard(
      guardPath,
      async () => 'recovered',
      guardOptions(),
    )).resolves.toBe('recovered');
    await expect(fs.access(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a stale owner after reboot even when its PID is currently live', async () => {
    await seedAbandonedMarker(guardPath, 'owner', {
      source: 'darwin-ps',
      bootId: 'previous-boot',
      processStartId: CURRENT_INCARNATION.processStartId,
    });

    await expect(withFilesystemInterprocessGuard(
      guardPath,
      async () => 'recovered',
      guardOptions(),
    )).resolves.toBe('recovered');
    await expect(fs.access(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a delayed reclaimer remove the successor guard', async () => {
    await seedAbandonedMarker(guardPath, 'claim', {
      source: 'darwin-ps',
      bootId: 'previous-boot',
      processStartId: 'previous-process-start',
    });
    const firstAtClaim = deferred<void>();
    const allowFirstClaim = deferred<void>();
    const successorEntered = deferred<void>();
    const releaseSuccessor = deferred<void>();
    let delayedReclaimerEntered = false;

    const delayedReclaimer = withFilesystemInterprocessGuard(
      guardPath,
      async () => {
        delayedReclaimerEntered = true;
        return 'delayed';
      },
      guardOptions({
        beforeReclaimerMarkerClaim: async () => {
          firstAtClaim.resolve();
          await allowFirstClaim.promise;
        },
      }),
    );
    await firstAtClaim.promise;

    const successor = withFilesystemInterprocessGuard(
      guardPath,
      async () => {
        successorEntered.resolve();
        await releaseSuccessor.promise;
        return 'successor';
      },
      guardOptions(),
    );
    await successorEntered.promise;

    allowFirstClaim.resolve();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(delayedReclaimerEntered).toBe(false);

    releaseSuccessor.resolve();
    await expect(successor).resolves.toBe('successor');
    await expect(delayedReclaimer).resolves.toBe('delayed');
    await expect(fs.access(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an interrupted exact-marker reclaimer after its incarnation dies', async () => {
    const deadReclaimer: FilesystemProcessIncarnation = {
      source: 'darwin-ps',
      bootId: 'previous-boot',
      processStartId: 'dead-reclaimer-start',
    };
    await seedAbandonedMarker(guardPath, 'reclaimer', deadReclaimer);

    await expect(withFilesystemInterprocessGuard(
      guardPath,
      async () => 'recovered',
      guardOptions(),
    )).resolves.toBe('recovered');
    await expect(fs.access(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function guardOptions(
  hooks: { beforeReclaimerMarkerClaim?: (marker: string) => Promise<void> } = {},
) {
  return {
    timeoutMs: 2_000,
    retryMs: 5,
    testHooks: {
      processIncarnationProvider: async () => CURRENT_INCARNATION,
      ...hooks,
    },
  };
}

async function seedAbandonedMarker(
  guardPath: string,
  state: 'owner' | 'claim' | 'reclaimer',
  recordedIncarnation: FilesystemProcessIncarnation,
): Promise<void> {
  const ownerToken = randomUUID();
  const reclaimerToken = randomUUID();
  const owner = {
    version: 1,
    ownerToken,
    host: hostname(),
    pid: process.pid,
    createdAt: Date.now() - 10_000,
    incarnation: recordedIncarnation,
  };
  const markerName = state === 'owner'
    ? `owner-${ownerToken}.json`
    : state === 'claim'
      ? `.claim-${ownerToken}`
      : `.reclaim-${ownerToken}-${process.pid}-${incarnationDigest(recordedIncarnation)}-${reclaimerToken}`;
  await fs.mkdir(guardPath, { mode: 0o700 });
  await fs.writeFile(path.join(guardPath, markerName), JSON.stringify(owner), { mode: 0o600 });
}

function incarnationDigest(incarnation: FilesystemProcessIncarnation): string {
  return createHash('sha256').update(JSON.stringify([
    incarnation.source,
    incarnation.bootId,
    incarnation.processStartId,
  ])).digest('hex');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
