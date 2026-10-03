import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runErasureCapacityLifecycle, CAPACITY_OBSERVER_TIMEOUT_MS } from './fixtures/erasureCapacityLifecycle.js';
import { makeOwnedErasureFixture } from './fixtures/ownedErasureFixture.js';
import { runOrdinaryErasureCase, registerOrdinaryErasureFixture } from './fixtures/ordinaryErasureFixtureScope.js';

describe('cleanup-inclusive erasure capacity test lifecycle', () => {
  it('includes awaited cleanup in whole timing before reporting success', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erasure-lifecycle-'));
    let timing: { cleanupMs: number; wholeMs: number; failed: boolean } | undefined;
    await runErasureCapacityLifecycle({ deadlineMs: 1000, label: 'cleanup timing', completed: value => { timing = value; } }, async scope => {
      scope.registerCleanup(async () => { await delay(20); await fs.rm(root, { recursive: true }); }, root);
      await fs.writeFile(path.join(root, 'actual'), 'preserved until cleanup');
    });
    expect(timing).toMatchObject({ failed: false });
    expect(timing!.cleanupMs).toBeGreaterThanOrEqual(15);
    expect(timing!.wholeMs).toBeGreaterThanOrEqual(timing!.cleanupMs);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('registers and removes a genuine fixture root even when setup rejects', async () => {
    const cause = new Error('setup refusal');
    let root: string | undefined;
    await expect(runErasureCapacityLifecycle({ deadlineMs: 1000, label: 'setup refusal' }, async scope => {
      await makeOwnedErasureFixture({}, allocated => {
        root = allocated;
        scope.registerCleanup(() => fs.rm(allocated, { recursive: true, force: true }), allocated);
        throw cause;
      });
    })).rejects.toBe(cause);
    expect(root).toBeDefined();
    await expect(fs.lstat(root!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the body and real cleanup failure in original order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erasure-lifecycle-'));
    const body = new Error('body refusal'), cleanup = new Error('cleanup refused after actual removal');
    let failure: unknown;
    try {
      await runErasureCapacityLifecycle({ deadlineMs: 1000, label: 'dual failure' }, async scope => {
        scope.registerCleanup(async () => { await fs.rm(root, { recursive: true }); throw cleanup; }, root);
        throw body;
      });
    } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([body, cleanup]);
    expect((failure as AggregateError).cause).toBe(body);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not swallow a sole cleanup failure', async () => {
    const cause = new Error('cleanup-only');
    await expect(runErasureCapacityLifecycle({ deadlineMs: 1000, label: 'cleanup failure' }, async scope => {
      scope.registerCleanup(async () => { throw cause; }, 'no fixture allocated');
    })).rejects.toBe(cause);
  });

  it('drains late writes and cleanup before emitting measured timeout or advancing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erasure-lifecycle-'));
    const events: string[] = [];
    await expect(runErasureCapacityLifecycle({ deadlineMs: 1, label: 'late completion' }, async scope => {
      scope.registerCleanup(async () => { await delay(10); await fs.rm(root, { recursive: true }); events.push('cleanup'); }, root);
      await delay(15); await fs.writeFile(path.join(root, 'late-write'), 'actual late write'); events.push('write');
    })).rejects.toThrow('after awaited cleanup');
    events.push('next-case');
    await delay(20);
    expect(events).toEqual(['write', 'cleanup', 'next-case']);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['setup', 'cleanup', 'diagnostic failure'] as const)('terminates the actual isolated process on a %s hang without advancing', async phase => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erasure-lifecycle-hang-'));
    const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
    const moduleUrl = new URL(`./fixtures/erasureCapacityLifecycle.${extension}`, import.meta.url).href;
    const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
    const source = `
const [moduleUrl,root,phase]=process.argv.slice(1);
if(phase==='diagnostic failure'){
 const {createRequire,syncBuiltinESMExports}=await import('node:module');
 createRequire(moduleUrl)('node:fs').writeSync=()=>{throw new Error('diagnostic refused');};syncBuiltinESMExports();
}
const {runErasureCapacityLifecycle}=await import(moduleUrl);
const fs=await import('node:fs/promises');
await runErasureCapacityLifecycle({deadlineMs:10,watchdogMs:100,label:'actual hanging child'},async scope=>{
 scope.registerCleanup(async()=>{if(phase==='cleanup')await new Promise(()=>{});await fs.rm(root,{recursive:true});},root);
 await fs.writeFile(root+'/started','actual child');
 if(phase!=='cleanup')await new Promise(()=>{});
});
await fs.writeFile(root+'/next-case','MUST NOT EXIST');
`;
    const child = spawn(process.execPath, [...loader, '--input-type=module', '-e', source, moduleUrl, root, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(0, 4096); });
    let spawnError: Error | undefined;
    child.once('error', cause => { spawnError = cause; });
    const closed = new Promise<number | null>(resolve => { child.once('close', resolve); });
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const code = await closed;
      if (spawnError) throw spawnError;
      expect(code).toBe(98);
      if (phase !== 'diagnostic failure') {
        expect(diagnostics).toContain('ERASURE capacity terminal watchdog');
        expect(diagnostics).toContain('"cleanupCompleted":false');
      }
      expect(await fs.readFile(path.join(root, 'started'), 'utf8')).toBe('actual child');
      await expect(fs.lstat(path.join(root, 'next-case'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('ordinary scope drains every fixture without repeating successful cleanup', async () => {
    const roots = await Promise.all([1, 2].map(() => fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-erasure-lifecycle-'))));
    const attempts = [0, 0];
    await runOrdinaryErasureCase('two actual fixtures', async () => {
      const cleanups = roots.map((root, index) => registerOrdinaryErasureFixture(root, async () => {
        attempts[index]++; await fs.rm(root, { recursive: true });
      }));
      await cleanups[0](); // Existing body's finally owns this cleanup first.
    });
    expect(attempts).toEqual([1, 1]);
    for (const root of roots) await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }, CAPACITY_OBSERVER_TIMEOUT_MS);

  it('ordinary scope retains a rejected cleanup promise without retrying or advancing early', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-erasure-lifecycle-'));
    const cause = new Error('actual once-only cleanup failure');
    let attempts = 0;
    let failure: unknown;
    try {
      await runOrdinaryErasureCase('failed cleanup', async () => {
        const cleanup = registerOrdinaryErasureFixture(root, async () => {
          attempts++; await fs.rm(root, { recursive: true }); throw cause;
        });
        await cleanup();
      });
    } catch (caught) { failure = caught; }
    expect(attempts).toBe(1);
    expect(failure).toBe(cause);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }, CAPACITY_OBSERVER_TIMEOUT_MS);



});
