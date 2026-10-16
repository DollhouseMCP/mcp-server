import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { OwnedWindowsJob } from '../../helpers/ownedWindowsJob.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LinuxOwnedGroup } from '../../helpers/linuxOwnedGroup.js';
import { OwnedFixtureRegistry, type OwnedFixtureProcess } from '../../helpers/ownedFixtureProcess.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const python = process.platform === 'win32' ? 'python' : 'python3';
const jobSupport = readFileSync(new URL('../../helpers/owned_python_job.py', import.meta.url), 'utf8');
const registry = new OwnedFixtureRegistry();
let teardownSnapshot: (() => void) | undefined;
beforeEach(() => { teardownSnapshot = undefined; registry.assertSettled(); });
afterEach(async () => {
  try { await registry.cancelUnfinished(); }
  catch (error) {
    try { teardownSnapshot?.(); } catch { /* Evidence cannot replace cleanup failure, including falsy errors. */ }
    throw error;
  } finally { teardownSnapshot = undefined; }
});

type FixtureBootstrap = { version: number[]; executableCategory: 'python' | 'python-exe' | 'other' };
function boundedFixtureBootstrap(stderr: string): FixtureBootstrap | undefined {
  for (const line of stderr.split('\n').slice(0, -1)) {
    const match = /^OWNED_FIXTURE_BOOTSTRAP v1 (\d{1,2}) (\d{1,2}) (\d{1,2}) (python|python-exe|other)$/.exec(line.replace(/\r$/, ''));
    if (match) return { version: match.slice(1, 4).map(Number), executableCategory: match[4] as FixtureBootstrap['executableCategory'] };
  }
  return undefined;
}
const fixtureMilestones = new Set(['job-setup-start', 'job-ready', 'body-enter', 'finish-enter', 'finish-return']);
function boundedFixtureMilestones(stderr: string): string[] {
  const result: string[] = [];
  for (const line of stderr.split('\n').slice(0, -1)) {
    const label = line.replace(/\r$/, '').replace(/^OWNED_FIXTURE_MILESTONE /, '');
    if (line.startsWith('OWNED_FIXTURE_MILESTONE ') && fixtureMilestones.has(label)) result.push(label);
    if (result.length >= 8) break;
  }
  return result;
}
const fixtureParentPhases = new Set(['spawn-requested', 'spawn', 'first-stderr', 'spawn-error', 'exit', 'close',
  'cleanup-terminate-owned-tree', 'windows-job-quiescent', 'owned-group-zombie-only']);

function expectNotExecuting(owner: OwnedFixtureProcess, pid: number): Promise<void> {
  const deadline = performance.now() + 2500;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try { if (owner.processSettlement(pid) !== 'unsettled') { resolve(); return; } }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { resolve(); return; }
        reject(error); return;
      }
      if (performance.now() >= deadline) reject(new Error('Owned fixture process is still present'));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

async function waitForOwnedFile(target: string, deadline: number): Promise<void> {
  while (performance.now() < deadline) {
    try { await stat(target); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Owned Windows acknowledgement gate did not settle within cleanup budget');
}

async function withinCleanupDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  if (performance.now() >= deadline) throw new Error('Original cancellation exceeded cleanup budget');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Original cancellation did not settle within cleanup budget')), Math.max(0, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('owned fixture teardown', () => {
  it('keeps a bound Windows failure sticky after an earlier ACK (synthetic protocol only)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owned-protocol-'));
    try {
      const job = new OwnedWindowsJob(directory), child = { pid: 123 } as ChildProcess;
      const token = job.environment().OWNED_FIXTURE_JOB_TOKEN;
      const acknowledged = jest.fn();
      const ack = Buffer.from(`OWNED_FIXTURE_JOB_QUIESCENT ${token} 123\n`);
      job.observe(ack, child, acknowledged);
      await job.wait(performance.now() + 2500, child);
      job.observe(Buffer.from(`OWNED_FIXTURE_JOB_PROOF_FAILED ${token} 123\n`), child, acknowledged);
      job.observe(ack, child, acknowledged); // A fresh ACK cannot repair failure.
      await expect(job.wait(performance.now() + 2500, child)).rejects.toThrow('refused descendant settlement');
      expect(acknowledged).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([undefined, null, false, 0, ''])('preserves an original falsy rejection (%p) after owned cleanup', async failure => {
    let directory = '';
    const work = registry.run(async owner => {
      directory = await mkdtemp(join(tmpdir(), 'owned-process-'));
      owner.ownDirectory(directory);
      throw failure;
    });
    const outcome = await work.then(
      () => ({ rejected: false, error: 'unexpected success' }),
      error => ({ rejected: true, error }),
    );
    expect(outcome).toEqual({ rejected: true, error: failure });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    registry.assertSettled();
  });

  (process.platform === 'linux' ? it : it.skip)('settles same-stack cancellation before the spawn event without losing Linux identity', async () => {
    let child: ChildProcess | undefined, closed: Promise<void> | undefined;
    let childClosed = false, spawnObserved = false, directory = '', pid = 0;
    let owned!: OwnedFixtureProcess, spawnFailure: unknown;
    const deadline = performance.now() + 2500;
    const work = registry.run(async owner => {
      directory = await mkdtemp(join(tmpdir(), 'owned-immediate-cancel-'));
      owner.ownDirectory(directory);
      owned = owner;
      // Exactly one sleeping child, with no descendant or filesystem work.
      child = owner.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      pid = child.pid!;
      closed = new Promise<void>(resolve => child!.once('close', () => { childClosed = true; resolve(); }));
      child.once('error', error => { spawnFailure = error; });
      child.once('spawn', () => { spawnObserved = true; });
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(spawnObserved).toBe(false);
      owner.cancel(); // No await or event-loop turn between spawn and cancel.
      expect(spawnObserved).toBe(false);
      await closed;
    });
    const outcome = work.then(() => ({ failed: false as const }), cause => ({ failed: true as const, cause }));
    let primary: { cause: unknown } | undefined;
    const cleanupFailures: unknown[] = [];
    try {
      const result = await withinCleanupDeadline(outcome, deadline);
      expect(result.failed).toBe(true);
      if (result.failed) expect(result.cause).toMatchObject({ message: expect.stringContaining('cancelled') });
      expect(spawnFailure).toBeUndefined();
      expect(childClosed).toBe(true);
      await registry.run(async () => {
        expect(owned.processSettlement(pid)).toBe('absent');
        await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } catch (cause) { primary = { cause }; }
    finally {
      try {
        if (child && !childClosed) {
          // Negative controls may hit the old refusal. Reap only this exact sole
          // child handle; fallback cleanup never turns that failure into success.
          child.kill('SIGKILL');
          await withinCleanupDeadline(closed!, deadline);
        }
        await withinCleanupDeadline(outcome, deadline);
        if (primary && childClosed && directory) {
          if (performance.now() >= deadline) cleanupFailures.push(new Error('Immediate cancellation control cleanup exceeded its budget'));
          else await withinCleanupDeadline(rm(directory, { recursive: true, force: true }), deadline);
        }
      } catch (cause) { cleanupFailures.push(cause); }
    }
    if (primary) {
      if (cleanupFailures.length) throw new AggregateError([primary.cause, ...cleanupFailures], 'Immediate cancellation control and owned cleanup failed');
      throw primary.cause;
    }
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Immediate cancellation control cleanup failed');
    registry.assertSettled();
  });

  it('preserves ordinary child exit0 and removes only its owned directory', async () => {
    let directory = '';
    let owned!: OwnedFixtureProcess, pid!: number;
    const result = await registry.run(async owner => {
      let stderr = '', discardedBytes = 0, terminalEventObserved = false;
      teardownSnapshot = () => console.log('OWNED_FIXTURE_BOOTSTRAP_DIAGNOSTIC', JSON.stringify({
        fixture: 'normal', phase: 'teardown-failed', requestedCommand: python, terminalEventObserved,
        bootstrap: boundedFixtureBootstrap(stderr), milestones: boundedFixtureMilestones(stderr),
        capturedStderrCharacters: stderr.length, discardedCharacters: discardedBytes,
        parentEvents: owner.events.slice(0, 16).filter(event => fixtureParentPhases.has(event.phase) && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0).map(({ phase, elapsedMs }) => ({ phase, elapsedMs })),
        windowsFailure: owner.windowsFailureDetail(),
      }));
      directory = await mkdtemp(join(tmpdir(), 'owned-process-'));
      owner.ownDirectory(directory);
      owned = owner;
      const launcher = join(directory, 'normal.py');
      await writeFile(launcher, `import sys\ntry:\n _fixture_executable=sys.executable.replace(chr(92),'/').rsplit('/',1)[-1].lower()\n print('OWNED_FIXTURE_BOOTSTRAP v1 %d %d %d %s' % (sys.version_info[0],sys.version_info[1],sys.version_info[2],'python-exe' if _fixture_executable=='python.exe' else 'python' if _fixture_executable=='python' else 'other'),file=sys.stderr,flush=True)\nexcept BaseException:\n pass\ndef _fixture_milestone(label):\n try:\n  print('OWNED_FIXTURE_MILESTONE '+label,file=sys.stderr,flush=True)\n except BaseException:\n  pass\n${jobSupport}\n_fixture_milestone('job-setup-start')\nfinish_job=establish_fixture_job()\n_fixture_milestone('job-ready')\ntry:\n _fixture_milestone('body-enter')\n print('fixture-normal',flush=True)\nfinally:\n _fixture_milestone('finish-enter')\n finish_job()\n _fixture_milestone('finish-return')\n`);
      const child = owner.spawn(python, [launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
      pid = child.pid!;
      child.stdout!.resume(); child.stderr!.resume();
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString(); const available = Math.max(0, 4096 - stderr.length);
        stderr += text.slice(0, available); discardedBytes += Math.max(0, text.length - available);
      });
      return new Promise<number | null>((resolve, reject) => {
        child.once('error', error => { terminalEventObserved = true; reject(error); });
        child.once('close', code => { terminalEventObserved = true; resolve(code); });
      });
    });
    expect(result).toBe(0);
    if (process.platform === 'win32') await registry.run(async () => {
      expect(owned.processSettlement(pid)).toBe('absent');
      const phases = owned.events.map(event => event.phase);
      expect(phases.indexOf('windows-job-quiescent')).toBeGreaterThanOrEqual(0);
      expect(phases.indexOf('windows-job-quiescent')).toBeLessThan(phases.indexOf('close'));
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    registry.assertSettled();
  });

  it('cancels a deliberately hung launcher and its actual grandchild before another operation', async () => {
    const ready = deferred();
    let pids: number[] = [];
    let owned: OwnedFixtureProcess | undefined;
    let directory = '', gateReady = '', gateRelease = '';
    const work = registry.run(async owner => {
      directory = await mkdtemp(join(tmpdir(), 'owned-process-'));
      owner.ownDirectory(directory);
      owned = owner;
      const launcher = join(directory, 'hung.py');
      gateReady = join(directory, 'ack.ready'); gateRelease = join(directory, 'ack.release');
      // Hold the actual Windows proof frame, rather than relying on a timing race
      // between kernel termination and registry admission.
      const gate = process.platform === 'win32' ? `import os,time
original_stderr=sys.stderr
class HeldAcknowledgement:
 def write(self,text):
  if text.startswith('OWNED_FIXTURE_JOB_QUIESCENT '):
   open(${JSON.stringify(gateReady)},'x').close()
   while not os.path.exists(${JSON.stringify(gateRelease)}): time.sleep(.005)
  return original_stderr.write(text)
 def flush(self): return original_stderr.flush()
sys.stderr=HeldAcknowledgement()
` : '';
      await writeFile(launcher, `import sys\n${gate}${jobSupport}\nfinish_job=establish_fixture_job()\nimport os,json,subprocess,time\nchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint(json.dumps([os.getpid(),child.pid]),flush=True)\ntry:\n time.sleep(30)\nfinally:\n finish_job()\n`);
      const child = owner.spawn(python, [launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr!.resume();
      let output = '';
      child.stdout!.on('data', chunk => {
        output += chunk.toString();
        if (output.length > 1024 || !output.includes('\n')) return;
        pids = JSON.parse(output.trim()) as number[];
        expect(pids).toHaveLength(2);
        expect(pids[0]).toBe(child.pid);
        expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
        ready.release();
      });
      return new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
    });
    // Attach rejection handling before requesting cancellation.
    const outcome = work.then(() => 'unexpected-success', error => (error as Error).message);
    await ready.promise;
    if (process.platform === 'linux') {
      const live = new LinuxOwnedGroup(pids[0]);
      expect(live.captureBeforeKill(performance.now() + 2500)).toBe(true);
      expect(live.zombieOnly(performance.now() + 100)).toBe(false);
    }
    if (process.platform === 'win32') {
      const deadline = performance.now() + 2500;
      const cleanup = registry.cancelUnfinished().then(
        () => ({ failed: false as const }), cause => ({ failed: true as const, cause }),
      );
      let primary: { cause: unknown } | undefined;
      const cleanupFailures: unknown[] = [];
      try {
        await waitForOwnedFile(gateReady, deadline);
        expect((await stat(directory)).isDirectory()).toBe(true);
        expect(owned!.events.some(event => event.phase === 'windows-job-quiescent')).toBe(false);
        await expect(registry.run(async () => 'must-not-enter-before-proof')).rejects.toThrow('unsettled');
      } catch (cause) { primary = { cause }; }
      finally {
        try { await writeFile(gateRelease, 'release'); } catch (cause) { cleanupFailures.push(cause); }
        try {
          // Await BOTH the bounded hook and original callback under the SAME
          // deadline, even if the held-proof assertions failed.
          const [settled] = await withinCleanupDeadline(Promise.all([cleanup, outcome]), deadline);
          if (settled.failed) cleanupFailures.push(settled.cause);
        } catch (cause) { cleanupFailures.push(cause); }
      }
      if (primary) {
        if (cleanupFailures.length) throw new AggregateError([primary.cause, ...cleanupFailures], 'Windows proof gate and original cancellation settlement failed');
        throw primary.cause;
      }
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Original Windows cancellation settlement failed');
      // These are immediate checks INSIDE the first newly admitted callback;
      // no post-cleanup PID polling can conceal an admission ordering defect.
      await registry.run(async () => {
        expect(pids.map(pid => owned!.processSettlement(pid))).toEqual(['absent', 'absent']);
        const phases = owned!.events.map(event => event.phase);
        expect(phases.indexOf('windows-job-quiescent')).toBeGreaterThanOrEqual(0);
        expect(phases.indexOf('windows-job-quiescent')).toBeLessThan(phases.indexOf('close'));
      });
    } else {
      await registry.cancelUnfinished();
      await Promise.all(pids.map(pid => expectNotExecuting(owned!, pid)));
    }
    expect(await outcome).toContain('cancelled');
    if (process.env.OWNED_FIXTURE_REQUIRE_ZOMBIE === '1') {
      expect(owned!.events.some(event => event.phase === 'owned-group-zombie-only')).toBe(true);
      expect(pids.some(pid => owned!.processSettlement(pid) === 'owned-zombie')).toBe(true);
    }
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    registry.assertSettled();
  });

  windowsIt.each(['missing', 'wrong-nonce', 'post-ack-failure'] as const)('retains resources and admission after %s Windows proof', async mode => {
    const isolated = new OwnedFixtureRegistry(), ready = deferred();
    let owned!: OwnedFixtureProcess, directory = '';
    const work = isolated.run(async owner => {
      owned = owner;
      directory = await mkdtemp(join(tmpdir(), 'owned-windows-refusal-'));
      owner.ownDirectory(directory);
      // Exactly one child, no descendants: this intentionally violates only the
      // acknowledgement protocol and never claims Job Object settlement.
      const frame = mode === 'post-ack-failure'
        ? "token=os.environ['OWNED_FIXTURE_JOB_TOKEN'];print('OWNED_FIXTURE_JOB_QUIESCENT %s %d'%(token,os.getpid()),file=sys.stderr,flush=True);print('OWNED_FIXTURE_JOB_PROOF_FAILED %s %d'%(token,os.getpid()),file=sys.stderr,flush=True);"
        : mode === 'wrong-nonce' ? "print('OWNED_FIXTURE_JOB_QUIESCENT wrong-nonce %d'%os.getpid(),file=sys.stderr,flush=True);" : '';
      const child = owner.spawn(python, ['-c', `import os,sys,time;${frame}print('ready',flush=True);time.sleep(30)`], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr!.resume(); child.stdout!.once('data', () => ready.release());
      return new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    });
    const outcome = work.then(() => 'unexpected-success', error => (error as Error).message);
    await ready.promise;
    await expect(isolated.cancelUnfinished()).rejects.toThrow(/2500ms|unsettled/);
    await outcome;
    expect(owned.events.some(event => event.phase === 'windows-job-quiescent')).toBe(mode === 'post-ack-failure');
    expect((await stat(directory)).isDirectory()).toBe(true);
    await expect(isolated.run(async () => 'must-not-enter')).rejects.toThrow('unsettled');
    // The exact sole child has closed; retain the registry refusal, then remove
    // only this control's known directory after the no-admission proof.
    await rm(directory, { recursive: true, force: true });
  });

  (process.platform === 'linux' ? it : it.skip)('refuses a group signal and retains admission after unknown Linux identity', async () => {
    const isolated = new OwnedFixtureRegistry(), ready = deferred();
    let owned!: OwnedFixtureProcess, child!: ReturnType<OwnedFixtureProcess['spawn']>, directory = '';
    const work = isolated.run(async owner => {
      owned = owner;
      directory = await mkdtemp(join(tmpdir(), 'owned-process-refusal-'));
      owner.ownDirectory(directory);
      child = owner.spawn(python, ['-c', "import time;print('ready',flush=True);time.sleep(30)"], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr!.resume(); child.stdout!.once('data', () => ready.release());
      return new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    });
    const outcome = work.then(() => 'unexpected-success', error => (error as Error).message);
    await ready.promise;
    const refuse = jest.spyOn(LinuxOwnedGroup.prototype, 'captureBeforeKill').mockReturnValue(false);
    const signals = jest.spyOn(process, 'kill');
    try {
      expect(() => owned.cancel()).toThrow('refusing signal');
      expect(() => owned.cancel()).toThrow('refusing signal');
      await expect(owned.finish()).rejects.toThrow('refusing signal');
      expect(signals.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);
      expect(() => isolated.assertSettled()).toThrow('unsettled');
      expect((await stat(directory)).isDirectory()).toBe(true);
    } finally {
      signals.mockRestore(); refuse.mockRestore();
      // This control has exactly one child and no descendants. Reap that exact
      // child handle after proving the group guard refused every signal.
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGKILL'); await closed;
      await outcome;
      await rm(directory, { recursive: true, force: true });
    }
    expect(() => isolated.assertSettled()).toThrow('unsettled');
  });

  it('refuses a late spawn after cancellation during asynchronous setup', async () => {
    const setup = deferred();
    let ownerUnderTest: OwnedFixtureProcess | undefined;
    const work = registry.run(async owner => {
      ownerUnderTest = owner;
      await setup.promise;
      owner.spawn(python, ['-c', 'raise SystemExit(3)'], { stdio: 'ignore' });
    });
    const outcome = work.then(() => 'unexpected-success', error => (error as Error).message);
    const cleanup = registry.cancelUnfinished();
    setup.release();
    await cleanup;
    expect(await outcome).toContain('cancelled');
    expect(ownerUnderTest!.events.some(event => event.phase === 'spawn-requested')).toBe(false);
    registry.assertSettled();
  });

  it('keeps unresolved setup registered after bounded teardown and refuses the next operation', async () => {
    const setup = deferred();
    const work = registry.run(async () => { await setup.promise; });
    const outcome = work.then(() => 'unexpected-success', error => (error as Error).message);
    try {
      await expect(registry.cancelUnfinished()).rejects.toThrow('within 2500ms');
      expect(() => registry.assertSettled()).toThrow('unsettled');
      await expect(registry.run(async () => 'must-not-run')).rejects.toThrow('unsettled');
    } finally { setup.release(); }
    expect(await outcome).toContain('cancelled');
    registry.assertSettled();
  });
});
