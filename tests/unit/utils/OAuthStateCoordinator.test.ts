import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  withOAuthStateLock,
  withOAuthStateLockSync
} from '../../../src/utils/OAuthStateCoordinator.js';

const temporaryDirectories: string[] = [];

const liveOwnerReasons = ['LOCK_DEADLINE_EXCEEDED', 'CURRENT_PROCESS_IDENTITY_UNAVAILABLE',
  'TICKET_SPACE_EXHAUSTED', 'FILESYSTEM_OPERATION_ERROR', 'CHILD_SPAWN_ERROR', 'UNKNOWN_LOCK_ERROR'] as const;
const liveOwnerPhases = ['ready', 'lock', 'entered', 'returned', 'complete', 'error'] as const;
const liveOwnerErrorNames = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'Unknown'];
const liveOwnerErrorCodes = ['ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'ENOTSUP', 'EIO', 'ENOSPC', 'ETIMEDOUT'];

function liveOwnerTrace() {
  const samples: { event: string; elapsedMs: number }[] = [];
  let unavailable = false;
  let truncated = false;
  let started = 0;
  try { started = performance.now(); } catch { unavailable = true; }
  const mark = (event: 'owner-entered-observed' | 'owner-ticket-identity-asserted' | 'owner-ticket-aged' |
    'contender-ready-and-ticket-identity-observed' | 'no-premature-entry-asserted' |
    'owner-release-write-start' | 'owner-release-write-complete' | 'owner-close-observed' |
    'contender-close-observed' | 'final-assertions-complete' | 'cleanup-children-settled' |
    'owned-directory-removal-complete') => {
    try {
      if (samples.length === 16) { truncated = true; return; }
      samples.push({ event, elapsedMs: Math.round(performance.now() - started) });
    } catch { unavailable = true; }
  };
  return { mark, snapshot: () => ({ samples, unavailable, truncated }) };
}

// Only this fixture emits these bounded records; never include exception messages or paths.
const liveOwnerChildScript = `
  import fs from 'node:fs';
  const [moduleUrl, role, stateFile, readyFile, enteredFile, releaseFile, publication] = process.argv.slice(1);
  let phase = 'import';
  let sequence = 0;
  let unavailable = false;
  let started = 0;
  try { started = performance.now(); } catch { unavailable = true; }
  const reason = (error) => {
    try {
      if (error?.message === 'Timed out waiting for OAuth state lock: ' + stateFile + '.lock') return 'LOCK_DEADLINE_EXCEEDED';
      if (error?.name === 'TypeError' && error.message === 'Unable to determine process identity for OAuth state locking') return 'CURRENT_PROCESS_IDENTITY_UNAVAILABLE';
      if (error?.message === 'OAuth state lock ticket space exhausted') return 'TICKET_SPACE_EXHAUSTED';
      if (${JSON.stringify(liveOwnerErrorCodes)}.includes(error?.code)) return 'FILESYSTEM_OPERATION_ERROR';
    } catch { unavailable = true; }
    return 'UNKNOWN_LOCK_ERROR';
  };
  const emit = (event, error) => {
    try {
      if (sequence === 6) return;
      const failure = error === undefined ? {} : {
        reason: reason(error),
        name: ${JSON.stringify(liveOwnerErrorNames)}.includes(error?.name) ? error.name : 'Unknown',
        code: ${JSON.stringify(liveOwnerErrorCodes)}.includes(error?.code) ? error.code : null
      };
      process.stderr.write(JSON.stringify({ event, phase, sequence: ++sequence,
        elapsedMs: Math.round(performance.now() - started), unavailable, ...failure }) + '\\n');
    } catch { unavailable = true; }
  };
  try {
    const { withOAuthStateLockSync } = await import(moduleUrl);
    if (publication === 'directory-fallback') fs.linkSync = () => {
      const error = new Error('Fixture hard links unsupported');
      error.code = 'ENOTSUP';
      throw error;
    };
    phase = 'ready';
    fs.writeFileSync(readyFile, 'ready');
    emit('ready');
    phase = 'lock';
    emit('lock');
    withOAuthStateLockSync(stateFile, () => {
      phase = 'entered';
      fs.writeFileSync(enteredFile, 'entered');
      emit('entered');
      if (role === 'owner') while (!fs.existsSync(releaseFile)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      emit('returned');
    });
    phase = 'complete';
    emit('complete');
  } catch (error) { emit('error', error); process.exitCode = 1; }
`;

function observedChild(args: string[], onClose?: () => void) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', liveOwnerChildScript, ...args],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const started = performance.now();
  let diagnostic: { phase: string; name: string; code: string | null; reason: string } | null = null;
  const samples: { event: string; sequence: number; elapsedMs: number }[] = [];
  let unavailable = false;
  let truncated = false;
  let stderr = '';
  let closed = false;
  let exited = false;
  let failed = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 1_024) { stderr = stderr.slice(-1_024); truncated = true; }
    const lines = stderr.split('\n');
    stderr = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (liveOwnerPhases.includes(value.event as (typeof liveOwnerPhases)[number]) &&
            Number.isInteger(value.sequence) && Number(value.sequence) > 0 && Number(value.sequence) <= 6 &&
            typeof value.elapsedMs === 'number' && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) {
          if (samples.length < 6) samples.push({ event: String(value.event),
            sequence: Number(value.sequence), elapsedMs: value.elapsedMs });
          else truncated = true;
          unavailable ||= value.unavailable === true;
        }
        if (['import', 'ready', 'lock', 'entered', 'complete'].includes(String(value.phase)) &&
            liveOwnerErrorNames.includes(String(value.name)) &&
            (value.code === null || liveOwnerErrorCodes.includes(String(value.code))) &&
            liveOwnerReasons.includes(value.reason as (typeof liveOwnerReasons)[number])) {
          diagnostic = { phase: String(value.phase), name: String(value.name),
            code: value.code as string | null, reason: String(value.reason) };
        }
      } catch { /* Discard unstructured loader warnings and all raw error text. */ }
    }
  });
  child.once('error', () => {
    failed = true;
    diagnostic = { phase: 'import', name: 'Unknown', code: null, reason: 'CHILD_SPAWN_ERROR' };
  });
  child.once('exit', (code, exitSignal) => { exited = true; exitCode = code; signal = exitSignal; failed ||= code !== 0; });
  const completion = new Promise<void>(resolve => child.once('close', code => {
    closed = true;
    failed ||= code !== 0;
    resolve();
    try { onClose?.(); } catch { unavailable = true; }
  }));
  const snapshot = () => ({ role: args[1], exitCode, signal,
    elapsedMs: Math.round(performance.now() - started), diagnostic, samples,
    unavailable: unavailable || samples.length === 0 ||
      samples.some((sample, index) => sample.sequence !== index + 1) ||
      (closed && (failed ? diagnostic?.reason !== 'CHILD_SPAWN_ERROR' &&
        !samples.some(sample => sample.event === 'error') : !samples.some(sample => sample.event === 'complete'))),
    truncated });
  const summary = () => JSON.stringify(snapshot());
  return { child, completion, snapshot, isClosed: () => closed,
    assertAlive: () => {
      if (exited || closed || failed) throw new Error(`Lock fixture child ended: ${summary()}`);
    },
    assertSuccess: () => {
      if (failed) throw new Error(`Lock fixture child failed: ${summary()}`);
    } };
}

async function waitForLiveOwnerObservation(check: () => Promise<boolean>, children: ReturnType<typeof observedChild>[],
  fixtureDeadline = Infinity) {
  const deadline = Math.min(performance.now() + 5_000, fixtureDeadline);
  while (performance.now() < deadline) {
    children.forEach(child => child.assertAlive());
    const ready = await check();
    children.forEach(child => child.assertAlive());
    if (performance.now() >= deadline) break;
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Lock fixture observation timed out');
}

function transferChildFixtureCleanup(directory: string) {
  const index = temporaryDirectories.indexOf(directory);
  if (index >= 0) temporaryDirectories.splice(index, 1);
}

function requireFixtureTime(deadline: number) {
  if (performance.now() >= deadline) throw new Error('Lock fixture observation timed out');
}

async function readFixtureSlotOwner(slotPath: string): Promise<{ id: string; ownerPid: number; ownerIdentity: string }> {
  // Match the production parser's supported file and directory publication forms.
  const ownerPath = (await fs.stat(slotPath)).isDirectory() ? path.join(slotPath, 'owner.json') : slotPath;
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Record<string, unknown>;
  if (typeof owner.id !== 'string' || owner.id.length === 0 || !Number.isSafeInteger(owner.ownerPid) ||
      Number(owner.ownerPid) <= 0 || typeof owner.ownerIdentity !== 'string' || owner.ownerIdentity.length === 0) {
    throw new Error('Lock fixture ticket has no valid owner');
  }
  return { id: owner.id, ownerPid: Number(owner.ownerPid), ownerIdentity: owner.ownerIdentity };
}

async function stopObservedChild(observed: ReturnType<typeof observedChild>) {
  if (!observed.isClosed()) observed.child.kill('SIGKILL');
  await boundedChildCompletion(observed.completion, 2_000);
}

async function boundedChildCompletion(completion: Promise<void>, timeoutMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([completion, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Lock fixture child completion timed out')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function throwChildFixtureFailures(primary: { cause: unknown } | undefined, cleanup: unknown[]) {
  if (cleanup.length > 0) {
    throw new AggregateError([...(primary ? [primary.cause] : []), ...cleanup],
      'Lock fixture cleanup incomplete; child directory retained');
  }
  if (primary) throw primary.cause;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-state-coordinator-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function expectAllTicketsCompleted(stateFile: string): Promise<void> {
  const entries = await fs.readdir(`${stateFile}.lock`);
  const slots = entries.filter(entry => /^\d+\.slot$/.test(entry));
  const doneMarkers = new Set(entries.filter(entry => /^\d+\.done$/.test(entry)));

  expect(slots.length).toBeGreaterThan(0);
  expect(entries).toHaveLength(slots.length * 2);
  for (const slot of slots) {
    expect(doneMarkers.has(slot.replace(/\.slot$/, '.done'))).toBe(true);
  }
}

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('OAuthStateCoordinator', () => {
  it.each(['file', 'directory'])('reads the actual owner from a %s ticket representation', async representation => {
    const directory = await createTemporaryDirectory();
    const slot = path.join(directory, '1.slot');
    const owner = { id: 'fixture-ticket', ownerPid: process.pid, ownerIdentity: 'fixture-process-identity' };
    if (representation === 'directory') await fs.mkdir(slot);
    await fs.writeFile(representation === 'directory' ? path.join(slot, 'owner.json') : slot, JSON.stringify(owner));
    expect(await readFixtureSlotOwner(slot)).toEqual(owner);
  });
  it.each([undefined, null, new Error('primary assertion')])(
    'preserves primary %p alongside an incomplete child cleanup', primary => {
      const cleanup = new Error('Lock fixture child completion timed out');
      let outcome: { cause: unknown } | undefined;
      try { throwChildFixtureFailures({ cause: primary }, [cleanup]); } catch (cause) { outcome = { cause }; }
      expect(outcome?.cause).toBeInstanceOf(AggregateError);
      expect((outcome?.cause as AggregateError).errors).toEqual([primary, cleanup]);
      expect((outcome?.cause as AggregateError).errors[0]).toBe(primary);
      expect((outcome?.cause as AggregateError).errors[1]).toBe(cleanup);
      let alone: { cause: unknown } | undefined;
      try { throwChildFixtureFailures({ cause: primary }, []); } catch (cause) { alone = { cause }; }
      expect(alone).toBeDefined();
      expect(alone?.cause).toBe(primary);
    }
  );

  it('fails cleanup alone and returns only when both paths succeeded', () => {
    const cleanup = new Error('Lock fixture child completion timed out');
    let outcome: unknown;
    try { throwChildFixtureFailures(undefined, [cleanup]); } catch (cause) { outcome = cause; }
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([cleanup]);
    expect(() => throwChildFixtureFailures(undefined, [])).not.toThrow();
  });
  it('reports sanitized child failures without leaking import paths', async () => {
    const directory = await createTemporaryDirectory();
    const missingModule = pathToFileURL(path.join(directory, 'nonexistent-private-fixture-path.mjs')).href;
    const child = observedChild([missingModule, 'contender', '', '', '', '']);
    try {
      await boundedChildCompletion(child.completion);
      let failure: unknown;
      try { child.assertSuccess(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('"phase":"import"');
      expect(message).toContain('"code":"ERR_MODULE_NOT_FOUND"');
      expect(message).toContain('"role":"contender"');
      expect(message).toContain('"exitCode":1');
      expect(message).not.toContain('nonexistent-private-fixture-path');
      expect(() => child.assertAlive()).toThrow('Lock fixture child ended');
    } finally { await stopObservedChild(child); }
  });

  it('kills and observes close of a fixture owner blocked before release', async () => {
    const directory = await createTemporaryDirectory();
    const entered = path.join(directory, 'entered');
    const child = observedChild([pathToFileURL(path.join(process.cwd(), 'oauth-state-coordinator.mjs')).href,
      'owner', path.join(directory, 'state'), path.join(directory, 'ready'), entered, path.join(directory, 'release')]);
    transferChildFixtureCleanup(directory);
    try {
      await waitForLiveOwnerObservation(() => fs.access(entered).then(() => true, () => false), [child]);
    } finally { await stopObservedChild(child); await fs.rm(directory, { recursive: true, force: true }); }
    expect(child.isClosed()).toBe(true);
    expect(() => child.assertAlive()).toThrow('Lock fixture child ended');
  });

  it('bounds an incomplete child observation instead of waiting indefinitely', async () => {
    await expect(boundedChildCompletion(new Promise<void>(() => {}), 20)).rejects.toThrow('child completion timed out');
  });
  it('compacts completed prefixes while retaining the allocation high-water mark', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');

    for (let acquisition = 0; acquisition < 3; acquisition++) {
      await withOAuthStateLock(stateFile, async () => {});
    }

    const entries = await fs.readdir(`${stateFile}.lock`);
    expect(entries.sort()).toEqual(['3.done', '3.slot']);
  });

  it('does not compact completed tickets beneath another allocation intent', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;

    await withOAuthStateLock(stateFile, async () => {});
    const activeOwner = JSON.parse(
      await fs.readFile(path.join(lockDirectory, '1.slot'), 'utf8')
    ) as Record<string, unknown>;
    activeOwner.id = '00000000-0000-4000-8000-000000000999';
    const competingIntent = path.join(lockDirectory, '.999.competing.slot.tmp');
    await fs.writeFile(competingIntent, JSON.stringify(activeOwner), 'utf8');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(competingIntent, staleTime, staleTime);

    await withOAuthStateLock(stateFile, async () => {});
    await expect(fs.access(path.join(lockDirectory, '1.slot'))).resolves.toBeUndefined();

    await fs.unlink(competingIntent);
    await withOAuthStateLock(stateFile, async () => {});
    const entries = await fs.readdir(lockDirectory);
    expect(entries.sort()).toEqual(['3.done', '3.slot']);
  });

  it('retries cleanup of an intent that already published its numbered slot', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;

    await withOAuthStateLock(stateFile, async () => {});
    const leakedIntent = path.join(lockDirectory, '.published-but-not-cleaned.slot.tmp');
    await fs.link(path.join(lockDirectory, '1.slot'), leakedIntent);

    await withOAuthStateLock(stateFile, async () => {});

    const entries = await fs.readdir(lockDirectory);
    expect(entries.sort()).toEqual(['2.done', '2.slot']);
  });

  it('retries cleanup of done markers whose slots were already removed', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;

    await withOAuthStateLock(stateFile, async () => {});
    await withOAuthStateLock(stateFile, async () => {});
    await fs.writeFile(path.join(lockDirectory, '1.done'), '', 'utf8');

    await withOAuthStateLock(stateFile, async () => {});

    const entries = await fs.readdir(lockDirectory);
    expect(entries.sort()).toEqual(['3.done', '3.slot']);
  });

  it('retries a failed completion marker before publishing another ticket', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const originalWriteFileSync = fsSync.writeFileSync;
    let failDoneCreation = true;
    jest.spyOn(fsSync, 'writeFileSync').mockImplementation(((filePath, data, options) => {
      if (failDoneCreation && String(filePath).endsWith('.done')) {
        failDoneCreation = false;
        throw Object.assign(new Error('transient completion failure'), { code: 'EIO' });
      }
      return originalWriteFileSync(filePath, data, options as never);
    }) as typeof fsSync.writeFileSync);

    let firstOperationRan = false;
    expect(() => withOAuthStateLockSync(stateFile, () => { firstOperationRan = true; }))
      .toThrow('transient completion failure');
    expect(firstOperationRan).toBe(true);
    await waitForFile(path.join(`${stateFile}.lock`, '1.done'));

    let secondOperationRan = false;
    withOAuthStateLockSync(stateFile, () => { secondOperationRan = true; });
    expect(secondOperationRan).toBe(true);
    await expectAllTicketsCompleted(stateFile);
  });

  it('reclaims an expired unpublished intent even while its process is alive', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;

    await withOAuthStateLock(stateFile, async () => {});
    const activeOwner = JSON.parse(
      await fs.readFile(path.join(lockDirectory, '1.slot'), 'utf8')
    ) as Record<string, unknown>;
    activeOwner.id = '00000000-0000-4000-8000-000000000998';
    activeOwner.allocationDeadlineUptime = os.uptime() * 1_000 - 1;
    const abandonedIntent = path.join(lockDirectory, '.expired-live-owner.slot.tmp');
    await fs.writeFile(abandonedIntent, JSON.stringify(activeOwner), 'utf8');

    await withOAuthStateLock(stateFile, async () => {});

    const entries = await fs.readdir(lockDirectory);
    expect(entries.sort()).toEqual(['2.done', '2.slot']);
  });

  it('atomically publishes a complete directory ticket when hard links are unsupported', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    jest.spyOn(fsSync, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
    });

    let operationsRun = 0;
    for (let acquisition = 0; acquisition < 3; acquisition++) {
      withOAuthStateLockSync(stateFile, () => { operationsRun += 1; });
    }

    expect(operationsRun).toBe(3);
    const slot = JSON.parse(
      await fs.readFile(path.join(`${stateFile}.lock`, '3.slot', 'owner.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(slot.ownerPid).toBe(process.pid);
    expect((await fs.readdir(`${stateFile}.lock`)).sort()).toEqual(['3.done', '3.slot']);
    await expectAllTicketsCompleted(stateFile);
  });

  it('includes ticket allocation retries in the lock timeout', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    let monotonicNow = 0;
    let wallNow = 1_000_000;
    jest.spyOn(performance, 'now').mockImplementation(() => {
      monotonicNow += 1_000;
      return monotonicNow;
    });
    jest.spyOn(Date, 'now').mockImplementation(() => {
      wallNow -= 60_000;
      return wallNow;
    });
    jest.spyOn(fsSync, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('ticket already exists'), { code: 'EEXIST' });
    });

    expect(() => withOAuthStateLockSync(stateFile, () => {}))
      .toThrow('Timed out waiting for OAuth state lock');
  });

  it('serializes a flow cleanup and a replacement state write', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-a' }), 'utf8');

    let releaseCleanup!: () => void;
    const cleanupCanFinish = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let cleanupHasRead!: () => void;
    const cleanupRead = new Promise<void>(resolve => { cleanupHasRead = resolve; });

    const cleanup = withOAuthStateLock(stateFile, async () => {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { flowId?: string };
      expect(state.flowId).toBe('flow-a');
      cleanupHasRead();
      await cleanupCanFinish;
      await fs.unlink(stateFile);
    });

    await cleanupRead;
    let replacementEntered = false;
    const replacement = withOAuthStateLock(stateFile, async () => {
      replacementEntered = true;
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-b' }), 'utf8');
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(replacementEntered).toBe(false);
    releaseCleanup();
    await Promise.all([cleanup, replacement]);

    await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('flow-b');
    await expectAllTicketsCompleted(stateFile);
  });

  it('retains one process marker across overlapping local lock claims', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const markerPath = `${stateFile}.lock.process-${process.pid}.identity`;
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstHasEntered = new Promise<void>(resolve => { firstEntered = resolve; });
    let releaseSecond!: () => void;
    const secondCanFinish = new Promise<void>(resolve => { releaseSecond = resolve; });
    let secondEntered!: () => void;
    const secondHasEntered = new Promise<void>(resolve => { secondEntered = resolve; });

    const first = withOAuthStateLock(stateFile, async () => {
      firstEntered();
      await firstCanFinish;
    });
    await firstHasEntered;
    const second = withOAuthStateLock(stateFile, async () => {
      secondEntered();
      await secondCanFinish;
    });

    await expect(fs.access(markerPath)).resolves.toBeUndefined();
    releaseFirst();
    await Promise.all([first, secondHasEntered]);
    await expect(fs.access(markerPath)).resolves.toBeUndefined();
    releaseSecond();
    await second;
    await expect(fs.access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectAllTicketsCompleted(stateFile);
  });

  it('prevents a helper claim from overwriting a replacement flow across processes', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const claimStartedFile = path.join(directory, 'claim-started');
    await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-a' }), 'utf8');

    const coordinatorUrl = pathToFileURL(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs')
    ).href;
    const childScript = `
      import fs from 'node:fs';
      import { withOAuthStateLockSync, writeFileAtomicallySync } from ${JSON.stringify(coordinatorUrl)};
      const [stateFile, claimStartedFile] = process.argv.slice(1);
      withOAuthStateLockSync(stateFile, () => {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        fs.writeFileSync(claimStartedFile, 'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        writeFileAtomicallySync(stateFile, JSON.stringify({ ...state, pid: process.pid }));
      });
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
      stateFile,
      claimStartedFile
    ], { stdio: 'ignore' });
    const childExit = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Claim child exited ${code}`)));
    });

    await waitForFile(claimStartedFile);
    await withOAuthStateLock(stateFile, async () => {
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-b' }), 'utf8');
    });
    await childExit;

    const finalState = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
    expect(finalState).toEqual({ flowId: 'flow-b' });
    await expectAllTicketsCompleted(stateFile);
  });

  it('completes an abandoned ticket even when its slot contains a live reused PID', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;
    const orphanedId = '00000000-0000-4000-8000-000000000001';
    const orphanedSlot = path.join(lockDirectory, '1.slot');
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      orphanedSlot,
      JSON.stringify({
        id: orphanedId,
        ownerPid: process.pid,
        ownerIdentity: 'identity-from-the-previous-process-that-used-this-pid'
      }),
      { encoding: 'utf8', mode: 0o600 }
    );
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(orphanedSlot, staleTime, staleTime);

    await withOAuthStateLock(stateFile, async () => {
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'recovered-flow' }), 'utf8');
    });

    await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('recovered-flow');
    await expect(fs.access(orphanedSlot)).resolves.toBeUndefined();
    await expect(fs.access(path.join(lockDirectory, '1.done'))).resolves.toBeUndefined();
    await expectAllTicketsCompleted(stateFile);
  });

  it('recovers a dead-owner slot whose mtime is in the future after clock rollback', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;
    const orphanedSlot = path.join(lockDirectory, '1.slot');
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      orphanedSlot,
      JSON.stringify({
        id: '00000000-0000-4000-8000-000000000003',
        ownerPid: 99_999_999,
        ownerIdentity: 'dead-owner-before-clock-rollback'
      }),
      'utf8'
    );
    const futureTime = new Date(Date.now() + 60 * 60_000);
    await fs.utimes(orphanedSlot, futureTime, futureTime);

    await withOAuthStateLock(stateFile, async () => {
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'clock-recovered-flow' }), 'utf8');
    });

    await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('clock-recovered-flow');
    await expect(fs.access(path.join(lockDirectory, '1.done'))).resolves.toBeUndefined();
    await expectAllTicketsCompleted(stateFile);
  });

  it('fails closed for marker ordering only when the marker proves a backward clock step', async () => {
    const directory = await createTemporaryDirectory();
    const coordinatorSource = await fs.readFile(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs'),
      'utf8'
    );
    const instrumentedSource = coordinatorSource.replace(
      'function staleMarkerStillBelongsToProcess(',
      'export function staleMarkerStillBelongsToProcess('
    );
    expect(instrumentedSource).not.toBe(coordinatorSource);
    const instrumentedPath = path.join(directory, 'instrumented-coordinator.mjs');
    await fs.writeFile(instrumentedPath, instrumentedSource, 'utf8');
    const instrumentedModule = await import(pathToFileURL(instrumentedPath).href) as {
      staleMarkerStillBelongsToProcess: (
        marker: { identity: string; writtenAt: number; mtimeMs: number },
        ownerIdentity: string,
        currentIdentity: string
      ) => boolean;
    };
    const markerIdentity = 'win32:10000';

    // The marker timestamp precedes its own recorded process start, proving
    // rollback. The original OS identity is retained within the known Node /
    // kernel timestamp skew, while a materially different reused PID is not.
    expect(instrumentedModule.staleMarkerStillBelongsToProcess(
      { identity: markerIdentity, writtenAt: 9_000, mtimeMs: 0 },
      markerIdentity,
      'win32:10001'
    )).toBe(true);
    expect(instrumentedModule.staleMarkerStillBelongsToProcess(
      { identity: markerIdentity, writtenAt: 9_000, mtimeMs: 0 },
      markerIdentity,
      'win32:13000'
    )).toBe(false);

    // Without rollback evidence, exact marker ordering remains strict even
    // when the two process-start identities happen to be close.
    expect(instrumentedModule.staleMarkerStillBelongsToProcess(
      { identity: markerIdentity, writtenAt: 10_500, mtimeMs: 0 },
      markerIdentity,
      'win32:10501'
    )).toBe(false);

    // Rollback after marker publication can make a reused PID's start appear
    // older than the marker, but it still cannot agree with the recorded owner
    // start. The filesystem mtime is intentionally irrelevant here.
    expect(instrumentedModule.staleMarkerStillBelongsToProcess(
      { identity: markerIdentity, writtenAt: 20_000, mtimeMs: 99_999_999 },
      markerIdentity,
      'win32:5000'
    )).toBe(false);
  });

  it.each(['native', 'directory-fallback'])(
    'does not reclaim a stale-aged ticket while its original process is alive (%s)', async publication => {
    // Leave time for finally cleanup within the existing ten-second Jest timeout.
    const fixtureDeadline = performance.now() + 7_000;
    const trace = liveOwnerTrace();
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const ownerEnteredFile = path.join(directory, 'owner-entered');
    const releaseOwnerFile = path.join(directory, 'release-owner');
    const contenderEnteredFile = path.join(directory, 'contender-entered');
    const ownerReadyFile = path.join(directory, 'owner-ready');
    const contenderReadyFile = path.join(directory, 'contender-ready');
    const coordinatorUrl = pathToFileURL(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs')
    ).href;
    requireFixtureTime(fixtureDeadline);
    const owner = observedChild([coordinatorUrl, 'owner', stateFile, ownerReadyFile, ownerEnteredFile, releaseOwnerFile, publication],
      () => trace.mark('owner-close-observed'));
    // afterEach never deletes a directory that may still belong to a live child.
    transferChildFixtureCleanup(directory);
    let contender: ReturnType<typeof observedChild> | undefined;
    let primary: { cause: unknown } | undefined;
    let cleanupFailures: unknown[] = [];
    try {
    await waitForLiveOwnerObservation(async () => fs.access(ownerEnteredFile).then(() => true, () => false), [owner], fixtureDeadline);
    trace.mark('owner-entered-observed');
    const ownerIdentityMarker = `${stateFile}.lock.process-${owner.child.pid}.identity`;
    await expect(fs.access(ownerIdentityMarker)).resolves.toBeUndefined();
    const ownerSlot = path.join(`${stateFile}.lock`, '1.slot');
    const ownerTicket = await readFixtureSlotOwner(ownerSlot);
    if (publication === 'directory-fallback') expect((await fs.stat(ownerSlot)).isDirectory()).toBe(true);
    expect(ownerTicket.ownerPid).toBe(owner.child.pid);
    const marker = JSON.parse(await fs.readFile(ownerIdentityMarker, 'utf8')) as { identity: string };
    expect(marker.identity).toBe(ownerTicket.ownerIdentity);
    trace.mark('owner-ticket-identity-asserted');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(ownerSlot, staleTime, staleTime);
    trace.mark('owner-ticket-aged');

    owner.assertAlive();
    requireFixtureTime(fixtureDeadline);
    contender = observedChild([coordinatorUrl, 'contender', stateFile, contenderReadyFile, contenderEnteredFile, releaseOwnerFile, publication],
      () => trace.mark('contender-close-observed'));
    const currentContender = contender;
    await waitForLiveOwnerObservation(async () => {
      try {
        await fs.access(contenderReadyFile);
        const slot = path.join(`${stateFile}.lock`, '2.slot');
        const ticket = await readFixtureSlotOwner(slot);
        if (publication === 'directory-fallback' && !(await fs.stat(slot)).isDirectory()) return false;
        const identity = JSON.parse(await fs.readFile(`${stateFile}.lock.process-${currentContender.child.pid}.identity`, 'utf8'));
        return ticket.ownerPid === currentContender.child.pid && typeof ticket.ownerIdentity === 'string' &&
          ticket.ownerIdentity.length > 0 && identity.identity === ticket.ownerIdentity &&
          typeof ticket.id === 'string' && ticket.id.length > 0;
      } catch { return false; }
    }, [owner, contender], fixtureDeadline);
    trace.mark('contender-ready-and-ticket-identity-observed');
    await new Promise(resolve => setTimeout(resolve, 150));
    requireFixtureTime(fixtureDeadline);
    owner.assertAlive();
    contender.assertAlive();
    await expect(fs.access(contenderEnteredFile)).rejects.toMatchObject({ code: 'ENOENT' });
    trace.mark('no-premature-entry-asserted');
    trace.mark('owner-release-write-start');
    await fs.writeFile(releaseOwnerFile, 'release', 'utf8');
    trace.mark('owner-release-write-complete');
    await boundedChildCompletion(Promise.all([owner.completion, contender.completion]).then(() => undefined),
      Math.max(1, Math.min(5_000, fixtureDeadline - performance.now())));
    owner.assertSuccess();
    contender.assertSuccess();

    await expect(fs.access(contenderEnteredFile)).resolves.toBeUndefined();
    await expect(fs.access(ownerIdentityMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectAllTicketsCompleted(stateFile);
    trace.mark('final-assertions-complete');
    } catch (cause) { primary = { cause }; } finally {
      const cleanup = await Promise.allSettled([owner, ...(contender ? [contender] : [])].map(stopObservedChild));
      trace.mark('cleanup-children-settled');
      cleanupFailures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
      if (cleanupFailures.length === 0) {
        try {
          await fs.rm(directory, { recursive: true, force: true });
          trace.mark('owned-directory-removal-complete');
        }
        catch { cleanupFailures.push(new Error('Lock fixture directory cleanup failed')); }
      }
      // Parent observations share one monotonic clock; child elapsed values do not.
      // Emission failure cannot replace the original operation or cleanup cause.
      try {
        console.info('oauth-live-owner-diagnostic', JSON.stringify({ publication,
          parent: trace.snapshot(), owner: owner.snapshot(), contender: contender?.snapshot() ?? null,
          primaryFailed: primary !== undefined, cleanupFailures: cleanupFailures.length }));
      } catch { /* Diagnostic output is advisory to the unchanged assertions. */ }
    }
    throwChildFixtureFailures(primary, cleanupFailures);
  });

  it('serializes concurrent processes while they complete the same abandoned ticket', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const counterFile = path.join(directory, 'counter.txt');
    const lockDirectory = `${stateFile}.lock`;
    const orphanedId = '00000000-0000-4000-8000-000000000002';
    const orphanedSlot = path.join(lockDirectory, '1.slot');
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      orphanedSlot,
      JSON.stringify({ id: orphanedId, ownerPid: 99_999_999, ownerIdentity: 'dead-owner' }),
      'utf8'
    );
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(orphanedSlot, staleTime, staleTime);
    await fs.writeFile(counterFile, '0', 'utf8');

    const coordinatorUrl = pathToFileURL(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs')
    ).href;
    const childScript = `
      import fs from 'node:fs';
      import { withOAuthStateLockSync } from ${JSON.stringify(coordinatorUrl)};
      const [stateFile, counterFile] = process.argv.slice(1);
      withOAuthStateLockSync(stateFile, () => {
        const value = Number.parseInt(fs.readFileSync(counterFile, 'utf8'), 10);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        fs.writeFileSync(counterFile, String(value + 1));
      });
    `;

    const children = Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        childScript,
        stateFile,
        counterFile
      ], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0
        ? resolve()
        : reject(new Error(`Recovery child exited ${code}`)));
    }));

    await Promise.all(children);

    await expect(fs.readFile(counterFile, 'utf8')).resolves.toBe('8');
    await expectAllTicketsCompleted(stateFile);
  });
});
