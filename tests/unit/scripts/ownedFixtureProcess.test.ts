import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { OwnedFixtureRegistry, type OwnedFixtureProcess } from '../../helpers/ownedFixtureProcess.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const jobSupport = readFileSync(new URL('../../helpers/owned_python_job.py', import.meta.url), 'utf8');
const registry = new OwnedFixtureRegistry();
beforeEach(() => { registry.assertSettled(); });
afterEach(async () => { await registry.cancelUnfinished(); });

function expectAbsent(pid: number): Promise<void> {
  const deadline = performance.now() + 2500;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try { process.kill(pid, 0); }
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

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('owned fixture teardown', () => {
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

  it('preserves ordinary child exit0 and removes only its owned directory', async () => {
    let directory = '';
    const result = await registry.run(async owner => {
      directory = await mkdtemp(join(tmpdir(), 'owned-process-'));
      owner.ownDirectory(directory);
      const launcher = join(directory, 'normal.py');
      await writeFile(launcher, `import sys\n${jobSupport}\nfinish_job=establish_fixture_job()\ntry:\n print('fixture-normal',flush=True)\nfinally:\n finish_job()\n`);
      const child = owner.spawn(python, [launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.resume(); child.stderr!.resume();
      return new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
    });
    expect(result).toBe(0);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    registry.assertSettled();
  });

  it('cancels a deliberately hung launcher and its actual grandchild before another operation', async () => {
    const ready = deferred();
    let pids: number[] = [];
    let directory = '';
    const work = registry.run(async owner => {
      directory = await mkdtemp(join(tmpdir(), 'owned-process-'));
      owner.ownDirectory(directory);
      const launcher = join(directory, 'hung.py');
      await writeFile(launcher, `import sys\n${jobSupport}\nfinish_job=establish_fixture_job()\nimport os,json,subprocess,time\nchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint(json.dumps([os.getpid(),child.pid]),flush=True)\ntry:\n time.sleep(30)\nfinally:\n finish_job()\n`);
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
    await registry.cancelUnfinished();
    expect(await outcome).toContain('cancelled');
    await Promise.all(pids.map(expectAbsent));
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    registry.assertSettled();
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
