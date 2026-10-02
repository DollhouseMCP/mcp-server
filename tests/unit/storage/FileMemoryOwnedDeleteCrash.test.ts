import { afterEach, describe, expect, it as jestIt } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';
const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const childSource = `
const [ownersUrl,coordinatorUrl,fenceUrl,root,user,requestRaw,stop]=process.argv.slice(1);
const request=JSON.parse(requestRaw);
const {createRequire,syncBuiltinESMExports}=await import('node:module');
const require=createRequire(ownersUrl), fs=require('node:fs/promises'), path=require('node:path');
const {createHash}=await import('node:crypto');
const head=path.join(root,request.expectedToken.locator),parent=path.dirname(head);
const journal=path.join(parent,'.'+createHash('sha256').update(path.basename(head)).digest('hex')+'.memory-write.json');
const pause=()=>{process.stdout.write('DELETE_BARRIER\\n');process.stdin.resume();return new Promise(()=>{});};
if(stop.startsWith('gap-')){
 let retired=false; const unlink=fs.unlink.bind(fs),open=fs.open.bind(fs);
 fs.unlink=async(...args)=>{const result=await unlink(...args);if(stop==='gap-head-syscall'&&args[0]===head)await pause();if(args[0]===journal)retired=true;return result;};
 fs.open=async(...args)=>{const handle=await open(...args);if(retired&&args[0]===parent){const method=stop==='gap-final-sync'?'sync':stop==='gap-final-close'?'close':undefined;if(method){const original=handle[method].bind(handle);handle[method]=async()=>{await original();await pause();};}}return handle;};
 syncBuiltinESMExports();
}
const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
const {FileMemoryFence}=await import(fenceUrl);
const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
const owners=new FileMemoryOwnerSnapshots({coordinator,afterDeletePublication:phase=>{
 if(phase===stop)return pause();
}});
await owners.deleteOwned(request);
`;
async function evidence(root: string): Promise<unknown[]> {
  const stat = await fs.lstat(root, { bigint: true });
  const result: unknown[] = [{ device: stat.dev, inode: stat.ino, mode: stat.mode, uid: stat.uid, links: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
    bytes: stat.isFile() ? await fs.readFile(root) : undefined }];
  if (stat.isDirectory()) for (const name of (await fs.readdir(root)).sort()) result.push({ name, evidence: await evidence(path.join(root, name)) });
  return result;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('actual process interruption of dormant head DELETE', () => {
  it.each([
    ['partial-base', false, false], ['base-durable', true, false], ['registry-durable', true, false],
    ['pair-durable', true, false], ['head-durable', true, true], ['terminal-durable', true, true],
    ['after-registry', false, false], ['after-sidecar', false, false], ['after-head-unlink', false, true],
    ['after-terminal-registry', false, true], ['after-intent-retirement', true, true],
    ['gap-head-syscall', false, true], ['gap-final-sync', true, true], ['gap-final-close', true, true],
  ] as const)('preserves phase evidence at %s and never reconstructs historical deletion', async (stop, supported, headAbsent) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owned-delete-crash-'))); roots.push(root);
    const locator = 'Notes/Memory.yaml'; await fs.mkdir(path.join(root, 'Notes')); await fs.writeFile(path.join(root, locator), 'entries: []\n');
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
    const owners = new FileMemoryOwnerSnapshots({ coordinator });
    const token = await owners.adoptUnowned((await owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
    const volumes = new FileMemoryVolumeStore({ coordinator, owners });
    await volumes.createExclusive(token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
    const archives = path.join(root, 'volumes', 'by-id', token.ownerId), archiveBefore = await evidence(archives);
    const request = { operationId: randomUUID(), expectedToken: token };
    const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
    const modules = ['FileMemoryOwnerSnapshots', 'FileMemoryTransactionCoordinator', 'FileMemoryFence'].map(name => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href);
    const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
    const child = spawn(process.execPath, [...loader, '--input-type=module', '-e', childSource, ...modules, root, USER, JSON.stringify(request), stop], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let didClose = false, signal: NodeJS.Signals | null = null, output = '', diagnostics = '';
    const closed = new Promise<void>(resolve => child.once('close', (_code, stoppedBy) => { didClose = true; signal = stoppedBy; resolve(); }));
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('close', () => reject(new Error('DELETE child closed before exact barrier')));
      child.stdout.on('data', chunk => { output += String(chunk); if (output === 'DELETE_BARRIER\n') resolve(); else if (output.length > 256) reject(new Error('DELETE child output exceeded bound')); });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(0, 4096); reject(new Error('DELETE child emitted bounded diagnostics')); });
    });
    void ready.catch(() => undefined);
    const timer = setTimeout(() => { if (!didClose) child.kill('SIGKILL'); }, 5000);
    roots.splice(roots.indexOf(root), 1);
    let primary: { cause: unknown } | undefined, cleanup: { cause: unknown } | undefined;
    try {
      await ready; child.kill('SIGKILL'); await closed; expect(signal).toBe('SIGKILL');
      // Test-only lease removal occurs only after the exact owned child is confirmed dead.
      await fs.rm(path.join(root, '.memory-fences', 'tenant.lock'), { recursive: true });
      expect(await evidence(archives)).toEqual(archiveBefore);
      if (headAbsent) await expect(fs.lstat(path.join(root, locator))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await fs.readFile(path.join(root, locator), 'utf8')).toBe('entries: []\n');
      const before = await evidence(path.join(root, 'Notes'));
      if (supported) {
        const result = await owners.deleteOwned(request);
        expect(result.status).toBe(headAbsent ? 'already-head-deleted' : 'head-deleted');
        if (headAbsent) expect(result.evidence).not.toHaveProperty('locator');
        await expect(fs.lstat(path.join(root, locator))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(owners.deleteOwned(request)).rejects.toBeDefined();
        expect(await evidence(path.join(root, 'Notes'))).toEqual(before);
      }
      expect(await evidence(archives)).toEqual(archiveBefore);
    } catch (cause) { primary = { cause }; } finally {
      clearTimeout(timer); if (!didClose) child.kill('SIGKILL'); await closed;
      try { await fs.rm(root, { recursive: true, force: true }); } catch (cause) { cleanup = { cause }; }
    }
    if (primary && cleanup) throw new AggregateError([primary.cause, cleanup.cause], 'DELETE crash assertion and cleanup failed', { cause: primary.cause });
    if (primary) throw primary.cause;
    if (cleanup) throw cleanup.cause;
  });
});
