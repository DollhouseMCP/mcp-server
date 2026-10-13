/** Compiled default-entrypoint admission gate; fixture cleanup is not a product drain. */
import { describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryUpgradeControlState } from '../../../src/lifecycle/MemoryUpgradeControlState.js';
import { requestMemoryDrain } from '../../../src/lifecycle/requestMemoryDrain.js';

const unix = process.platform === 'win32' ? describe.skip : describe;
const containerId = 'a'.repeat(64);
const sourceBootId = 'b'.repeat(64);
const nonce = 'c'.repeat(64);

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('Owned startup condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function startup(phase: 'absent' | 'requested' | 'unknown' | 'drained',
  body: (f: { child: ChildProcess; directory: string; control: string; rootAttempts: () => number;
    closed: () => boolean; stderr: () => string; waitClose: () => Promise<void> }) => Promise<void>): Promise<void> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcs-')));
  await fs.chmod(directory, 0o700);
  const control = path.join(directory, 'c'); await fs.mkdir(control, {mode: 0o700});
  if (Buffer.byteLength(path.join(control, 'control.sock')) > 103) {
    await fs.rm(directory, {recursive: true});
    throw new Error('Owned startup socket exceeds portable Unix path bound');
  }
  const state = new MemoryUpgradeControlState(control);
  if (phase !== 'absent') {
    const record = await state.request(containerId, sourceBootId);
    if (phase === 'drained') await state.markDrained(record);
    if (phase === 'unknown') await fs.unlink(path.join(control, 'state.json'));
  }
  const root = process.cwd();
  const preloader = path.join(directory, 'owned-startup-observer.mjs');
  await fs.writeFile(preloader, `
import { DollhouseContainer } from ${JSON.stringify(pathToFileURL(path.join(root, 'dist/di/Container.js')).href)};
let rootAttempts = 0;
DollhouseContainer.prototype.registerServices = function () {
  rootAttempts++; process.send?.({event:'normal-root-attempt'});
  // Detector positive control ends before service/bootstrap construction.
  process.exit(0);
};
process.on('message', message => {
  if (message === 'owned-fixture-finish' && rootAttempts === 0) process.exit(0);
});
// The observer must not supply the product's required keepalive.
process.channel?.unref();
process.send?.({event:'observer-ready'});
`, {mode: 0o600});
  const child = spawn(process.execPath, ['--import', preloader, path.join(root, 'dist/index.js'), '--http', '--port=0'], {
    cwd: directory, env: {PATH: process.env.PATH, HOME: directory, NODE_ENV: 'production',
      DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR: control, DOLLHOUSE_WEB_CONSOLE: 'false',
      DOLLHOUSE_HTTP_WEB_CONSOLE: 'false', DOLLHOUSE_PORTFOLIO_DIR: path.join(directory, 'portfolio'),
      DOLLHOUSE_LOG_DIR: path.join(directory, 'logs')}, stdio: ['ignore','pipe','pipe','ipc'],
  });
  let rootAttempts = 0; let observerReady = false; let closed = false; let stderr = '';
  child.stdout!.resume();
  child.stderr!.on('data', chunk => {stderr = (stderr + String(chunk)).slice(-4000);});
  child.on('message', message => {
    const event = (message as {event?: string}).event;
    if (event === 'normal-root-attempt') rootAttempts++;
    if (event === 'observer-ready') observerReady = true;
  });
  child.once('close', (code, signal) => {
    closed = true;
    console.info(`[memory-control-startup] phase=${phase} final-close code=${code} signal=${signal}`);
  });
  const waitClose = () => waitUntil(() => closed);
  let failure: unknown;
  try {
    await waitUntil(() => observerReady);
    if (phase !== 'absent') await waitUntil(async () => {
      if (closed) throw new Error('Owned control-only startup unexpectedly closed');
      try {return (await fs.lstat(path.join(control, 'control.sock'))).isSocket();}
      catch {return false;}
    });
    await body({child,directory,control,rootAttempts:()=>rootAttempts,closed:()=>closed,stderr:()=>stderr,waitClose});
  } catch (error) {failure = error;}
  finally {
    if (!closed && phase !== 'absent' && rootAttempts === 0 && child.connected) {
      // Only this no-root synthetic fixture may use its private IPC cleanup.
      // It is not an unknown-state drain certificate or an operator stop route.
      child.send('owned-fixture-finish');
    }
    await waitClose();
    if (!closed) throw new Error('Owned startup child remains; directory retained');
    await fs.rm(directory, {recursive:true,force:true});
  }
  if (failure) throw failure;
}

unix('compiled default entrypoint persistent memory hold', () => {
  it('proves the registerServices detector on normal no-latch startup', () => startup('absent', async f => {
    await f.waitClose(); expect(f.rootAttempts()).toBe(1); expect(f.child.exitCode).toBe(0);
  }), 30000);

  it.each(['requested','unknown'] as const)('%s successor stays control-only and refuses empty-accounting ACK and real SIGTERM', phase =>
    startup(phase, async f => {
      await expect(requestMemoryDrain(f.control, containerId, nonce, 1000)).rejects.toThrow('refused');
      expect(f.rootAttempts()).toBe(0);
      expect(f.child.kill('SIGTERM')).toBe(true);
      await waitUntil(() => f.stderr().includes('Memory control hold refuses shutdown'));
      expect(f.closed()).toBe(false); expect(f.child.exitCode).toBeNull();
      expect(f.rootAttempts()).toBe(0);
      expect(await fs.readdir(f.directory)).not.toContain('portfolio');
    }), 30000);

  it('drained successor exposes inherited closure only and real SIGTERM closes cleanly', () => startup('drained', async f => {
    const ack = await requestMemoryDrain(f.control, containerId, nonce, 1000);
    expect(ack).toMatchObject({phase:'drained',mode:'drained-successor',sourceBootId});
    expect(ack.bootId).not.toBe(sourceBootId);
    expect(f.rootAttempts()).toBe(0);
    expect(f.child.kill('SIGTERM')).toBe(true); await f.waitClose();
    expect(f.child.exitCode).toBe(0); expect(f.child.signalCode).toBeNull();
    expect(f.rootAttempts()).toBe(0);
    expect(await fs.readdir(f.directory)).not.toContain('portfolio');
    expect((await new MemoryUpgradeControlState(f.control).read()).kind).toBe('drained');
  }), 30000);
});
