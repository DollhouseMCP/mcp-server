import { afterEach, describe, expect, it as jestIt } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken, type OwnedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';
import type { ArchiveCleanupPhase } from '../../../src/storage/FileMemoryArchiveCleanup.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const CONTENT = 'entries: []\n';
type CrashStop = ArchiveCleanupPhase | `gap-${'marker' | 'payload' | 'metadata' | 'generation' | 'slot'}` | 'gap-slot-sync' | 'gap-slot-close';
const childSource = `
  const [ownersUrl,coordinatorUrl,fenceUrl,volumesUrl,root,user,locator,receiptRaw,stop]=process.argv.slice(1);
  const {createRequire,syncBuiltinESMExports}=await import('node:module');
  const require=createRequire(ownersUrl), fs=require('node:fs/promises'), path=require('node:path');
  const receipt=JSON.parse(receiptRaw);
  const owner=path.join(root,'volumes','by-id',receipt.ownerId),slot=path.join(owner,'v'+receipt.volume);
  const generation=path.join(slot,'g-'+receipt.generationId);
  const pause=()=>{process.stdout.write('CLEANUP_BARRIER\\n');process.stdin.resume();return new Promise(()=>{});};
  if(stop.startsWith('gap-')){
    const action=stop.slice(4);
    const selected={marker:path.join(slot,'COMMITTED'),payload:path.join(generation,'payload.yaml'),
      metadata:path.join(generation,'metadata.json'),generation,slot};
    if(action==='slot-sync'||action==='slot-close'){
      let removed=false;
      const rmdir=fs.rmdir.bind(fs),open=fs.open.bind(fs);
      fs.rmdir=async(...args)=>{const result=await rmdir(...args);if(args[0]===slot)removed=true;return result;};
      fs.open=async(...args)=>{
        const handle=await open(...args);
        if(removed&&args[0]===owner){const method=action==='slot-sync'?'sync':'close';const original=handle[method].bind(handle);handle[method]=async()=>{await original();await pause();};}
        return handle;
      };
    }else{
      const operation=action==='payload'||action==='metadata'?'unlink':'rmdir';
      const original=fs[operation].bind(fs);
      fs[operation]=async(...args)=>{const result=await original(...args);if(args[0]===selected[action])await pause();return result;};
    }
    syncBuiltinESMExports();
  }
  const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
  const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
  const {FileMemoryFence}=await import(fenceUrl);
  const {FileMemoryVolumeStore}=await import(volumesUrl);
  const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
  const owners=new FileMemoryOwnerSnapshots({coordinator});
  const token=(await owners.readHeadSnapshot(locator)).token;
  const store=new FileMemoryVolumeStore({coordinator,owners,afterCleanup:phase=>{
    if(phase===stop)return pause();
  }});
  await store.removeUnreferenced(token,receipt);
`;

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-crash-')));
  roots.push(root);
  const locator = 'Notes/Memory.yaml';
  await fs.mkdir(path.join(root, 'Notes'), { mode: 0o700 });
  await fs.writeFile(path.join(root, locator), CONTENT);
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const unowned = await owners.readHeadSnapshot(locator);
  const token = await owners.adoptUnowned(unowned.token as UnownedFileMemoryToken);
  const store = new FileMemoryVolumeStore({ coordinator, owners });
  const input = { minimumVolume: 1, rawContent: CONTENT, entryCount: 0, sealedAt: new Date('2026-10-01T00:00:00Z') };
  const receipt = await store.createExclusive(token, input);
  const foreign = await store.createExclusive(token, { ...input, minimumVolume: 2 });
  const owner = path.join(root, 'volumes', 'by-id', token.ownerId);
  return { root, locator, owners, store, receipt, owner, slot: path.join(owner, `v${receipt.volume}`),
    generation: path.join(owner, `v${receipt.volume}`, `g-${receipt.generationId}`),
    foreign: path.join(owner, `v${foreign.volume}`) };
}

async function evidence(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  async function walk(relative: string) {
    const target = path.join(root, relative), stat = await fs.lstat(target, { bigint: true });
    result.push({ relative, device: stat.dev, inode: stat.ino, mode: stat.mode, links: stat.nlink,
      bytes: stat.isFile() ? await fs.readFile(target) : undefined });
    if (stat.isDirectory()) for (const name of (await fs.readdir(target)).sort()) await walk(path.join(relative, name));
  }
  await walk('.'); return result;
}
async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('file archive cleanup actual process crashes', () => {
  it.each([
    ['partial-intent', 0, false], ['before-intent-sync', 0, true], ['intent-durable', 0, true],
    ['after-marker', 1, true], ['after-payload', 2, true], ['after-metadata', 3, true],
    ['after-generation', 4, true], ['after-slot', 5, true], ['after-retire', 5, true],
    ['gap-marker', 1, true], ['gap-payload', 2, true], ['gap-metadata', 3, true],
    ['gap-generation', 4, true], ['gap-slot', 5, true], ['gap-slot-sync', 5, true], ['gap-slot-close', 5, true],
  ] as const)('preserves exact residual prefix at %s and retries without historical receipt reconstruction', async (stop, prefix, supported) => {
    const f = await fixture();
    const foreignBefore = await evidence(f.foreign);
    const headBefore = await fs.lstat(path.join(f.root, f.locator), { bigint: true });
    const generationBefore = await fs.lstat(f.generation, { bigint: true });
    const payload = path.join(f.generation, 'payload.yaml'), metadata = path.join(f.generation, 'metadata.json');
    const payloadBefore = await evidence(payload), metadataBefore = await evidence(metadata);
    const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
    const modules = ['FileMemoryOwnerSnapshots', 'FileMemoryTransactionCoordinator', 'FileMemoryFence', 'FileMemoryVolumeStore']
      .map(name => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href);
    const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
    const child = spawn(process.execPath, [...loader, '--input-type=module', '-e', childSource,
      ...modules, f.root, USER, f.locator, JSON.stringify(f.receipt), stop satisfies CrashStop],
    { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
    let didClose = false, output = '', stderr = '', signal: NodeJS.Signals | null = null;
    const closed = new Promise<void>(resolve => child.once('close', (_code, stoppedBy) => {
      didClose = true; signal = stoppedBy; resolve();
    }));
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', error => reject(error));
      child.once('close', () => reject(new Error(`Cleanup child closed before barrier: ${stderr}`)));
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.length > 256) reject(new Error('Cleanup child exceeded fixed output bound'));
        else if (output === 'CLEANUP_BARRIER\n') resolve();
      });
      child.stderr.on('data', chunk => {
        stderr = (stderr + String(chunk)).slice(0, 4096);
        reject(new Error(`Cleanup child emitted diagnostics: ${stderr}`));
      });
    });
    void ready.catch(() => undefined);
    const timer = setTimeout(() => { if (!didClose) child.kill('SIGKILL'); }, 5000);
    roots.splice(roots.indexOf(f.root), 1);
    try {
      await ready; child.kill('SIGKILL'); await closed;
      expect(signal).toBe('SIGKILL');
      // Only this confirmed-dead child owns this isolated lease. Production never takes it over.
      const lease = path.join(f.root, '.memory-fences', 'tenant.lock');
      expect(await exists(lease)).toBe(true);
      await fs.rm(lease, { recursive: true });
      const intent = path.join(f.owner, `v${f.receipt.volume}.cleanup.json`);
      expect(await exists(intent)).toBe(stop !== 'after-retire');
      expect(await exists(path.join(f.slot, 'COMMITTED'))).toBe(prefix === 0);
      expect(await exists(payload)).toBe(prefix < 2);
      expect(await exists(metadata)).toBe(prefix < 3);
      expect(await exists(f.generation)).toBe(prefix < 4);
      expect(await exists(f.slot)).toBe(prefix < 5);
      if (prefix < 2) expect(await evidence(payload)).toEqual(payloadBefore);
      if (prefix < 3) expect(await evidence(metadata)).toEqual(metadataBefore);
      if (prefix < 4) expect((await fs.lstat(f.generation, { bigint: true })).ino).toBe(generationBefore.ino);
      expect(await evidence(f.foreign)).toEqual(foreignBefore);
      const remainingBefore = await evidence(f.owner);
      const fresh = await f.owners.readHeadSnapshot(f.locator);
      const result = await f.store.removeUnreferenced(fresh.token as OwnedFileMemoryToken, f.receipt);
      if (!supported) {
        expect(result.status).toBe('refused');
        expect(await evidence(f.owner)).toEqual(remainingBefore);
      } else {
        expect(result.status).toBe(prefix < 5 ? 'removed' : 'absent');
        if (prefix < 5) {
          const { operationId: _publicationOperationId, ...durableReceipt } = f.receipt;
          expect(result.receipt).toEqual(durableReceipt);
          expect(result.receipt).not.toHaveProperty('operationId');
        } else expect(result).not.toHaveProperty('receipt');
        expect(await exists(f.slot)).toBe(false);
        expect(await exists(intent)).toBe(false);
      }
      expect(await evidence(f.foreign)).toEqual(foreignBefore);
      expect((await fs.lstat(path.join(f.root, f.locator), { bigint: true })).ino).toBe(headBefore.ino);
      expect(await fs.readFile(path.join(f.root, f.locator), 'utf8')).toBe(CONTENT);
    } finally {
      clearTimeout(timer);
      if (!didClose) child.kill('SIGKILL');
      await closed;
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
});
