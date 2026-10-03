import { describe, expect, it as jestIt } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeOwnedErasureFixture, captureErasureTree, captureErasureFiles } from './fixtures/ownedErasureFixture.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const childSource = `
const [ownersUrl,coordinatorUrl,fenceUrl,root,user,requestRaw,stop]=process.argv.slice(1);
const pause=()=>{process.stdout.write('ERASURE_BARRIER\\n');process.stdin.resume();return new Promise(()=>{});};
if(stop==='partial-segment-stage'){
 const {createRequire,syncBuiltinESMExports}=await import('node:module');
 const fs=createRequire(ownersUrl)('node:fs/promises'),open=fs.open.bind(fs);
 fs.open=async(...args)=>{const handle=await open(...args);
  if(/\\.s\\d{4}\\.json\\.erase-/u.test(String(args[0]))){
   const write=handle.write.bind(handle);
   handle.write=async(buffer,offset,length,position)=>{await write(buffer,offset,Math.max(1,Math.floor(length/2)),position);await pause();};
  }return handle;
 };syncBuiltinESMExports();
}
if(stop.startsWith('gap-final-')){
 const {createRequire,syncBuiltinESMExports}=await import('node:module');
 const fs=createRequire(ownersUrl)('node:fs/promises'),unlink=fs.unlink.bind(fs),open=fs.open.bind(fs);
 let retired=false;
 fs.unlink=async(...args)=>{const value=await unlink(...args);if(String(args[0]).endsWith('.erase.json')){
  retired=true;if(stop==='gap-final-journal-unlink')await pause();}return value;};
 fs.open=async(...args)=>{const handle=await open(...args);
  if(retired&&String(args[0])===root+'/.memory-owners/owners'){
   let synced=false;const sync=handle.sync.bind(handle),close=handle.close.bind(handle);
   handle.sync=async()=>{await sync();synced=true;if(stop==='gap-final-sync')await pause();};
   handle.close=async()=>{await close();if(synced&&stop==='gap-final-close')await pause();};
  }return handle;
 };
 syncBuiltinESMExports();
}
if(stop.startsWith('gap-directory-')||stop.startsWith('gap-root-')){
 const {createRequire,syncBuiltinESMExports}=await import('node:module');
 const fs=createRequire(ownersUrl)('node:fs/promises'),rmdir=fs.rmdir.bind(fs),open=fs.open.bind(fs);
 const selected=root+'/volumes/by-id/'+JSON.parse(requestRaw).expectedToken.ownerId;
 let parent=null;
 fs.rmdir=async(...args)=>{const value=await rmdir(...args),target=String(args[0]);
  if(parent===null&&(stop.startsWith('gap-root-')?target===selected:target.startsWith(selected+'/'))){
   parent=target.slice(0,target.lastIndexOf('/'));if(stop.endsWith('-rmdir'))await pause();
  }return value;};
 fs.open=async(...args)=>{const handle=await open(...args);
  if(parent!==null&&String(args[0])===parent){
   let synced=false;const sync=handle.sync.bind(handle),close=handle.close.bind(handle);
   handle.sync=async()=>{await sync();synced=true;if(stop.endsWith('-sync'))await pause();};
   handle.close=async()=>{await close();if(synced&&stop.endsWith('-close'))await pause();};
  }return handle;
 };syncBuiltinESMExports();
}
const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
const {FileMemoryFence}=await import(fenceUrl);
const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
const owners=new FileMemoryOwnerSnapshots({coordinator,afterErasurePublication:phase=>{
 if(phase===stop)return pause();
}});
await owners.eraseOwned(JSON.parse(requestRaw));
`;
describe('actual process interruption of dormant owner erasure', () => {
  it('observes the same rejecting public InTransaction promise when a caller omits await', async () => {
    const fixture = await makeOwnedErasureFixture({ volumes: 2 });
    try {
      const before = { archive: await captureErasureTree(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId)),
        registry: await captureErasureTree(path.join(fixture.root, '.memory-owners/owners')) };
      const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
      const modules = ['FileMemoryOwnerSnapshots', 'FileMemoryTransactionCoordinator', 'FileMemoryFence']
        .map(name => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href);
      const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
      const source = `
const [ownersUrl,coordinatorUrl,fenceUrl,root,user,requestRaw]=process.argv.slice(1);
const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
const {FileMemoryFence}=await import(fenceUrl);
const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
const owners=new FileMemoryOwnerSnapshots({coordinator});
const request=JSON.parse(requestRaw);request.expectedToken.fileIdentity.mtimeNs=String(BigInt(request.expectedToken.fileIdentity.mtimeNs)+1n);
let rejected=false;
try{await coordinator.withTenantTransaction(context=>{owners.eraseOwnedInTransaction(context,request);});}
catch(cause){rejected=true;if(cause?.result||cause?.headDeleted)throw new Error('Invented completion');}
if(!rejected)throw new Error('Coordinator omitted tracked failure');
await new Promise(resolve=>setTimeout(resolve,25));process.stdout.write('OBSERVED_REJECTION\\n');
`;
      const child = spawn(process.execPath, ['--unhandled-rejections=strict', ...loader, '--input-type=module', '-e', source,
        ...modules, fixture.root, fixture.token.userId, JSON.stringify(fixture.request)], { cwd: fixture.root, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', diagnostics = '';
      child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(0, 512); });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(0, 4096); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      clearTimeout(timer);
      expect({ code, output, diagnostics }).toEqual({ code: 0, output: 'OBSERVED_REJECTION\n', diagnostics: '' });
      expect({ archive: await captureErasureTree(path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId)),
        registry: await captureErasureTree(path.join(fixture.root, '.memory-owners/owners')) }).toEqual(before);
    } finally { await fixture.cleanup(); }
  }, 10_000);
  it.each(['head-prepared-durable', 'ready-durable', 'inventory-durable', 'action-prepared-durable',
    'after-owner-action', 'owner-root-removed-durable', 'evidence-retiring-durable',
    'retire-action-prepared-durable', 'after-evidence-retirement', 'partial-segment-stage',
    'gap-final-journal-unlink', 'gap-final-sync', 'gap-final-close',
    'gap-directory-rmdir', 'gap-directory-sync', 'gap-directory-close',
    'gap-root-rmdir', 'gap-root-sync', 'gap-root-close'] as const)(
    'qualifies recovery or preserves manual residual after SIGKILL at %s', async stop => {
      const fixture = await makeOwnedErasureFixture({ nested: true, volumes: 2,
        foreignOwners: stop.startsWith('gap-directory-') || stop.startsWith('gap-root-') ? 100 : 0 });
      const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
      const modules = ['FileMemoryOwnerSnapshots', 'FileMemoryTransactionCoordinator', 'FileMemoryFence']
        .map(name => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href);
      const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
      const selected = path.join(fixture.root, 'volumes/by-id', fixture.token.ownerId);
      const before = await captureErasureTree(selected), foreign = await captureErasureFiles(fixture.foreignFiles);
      const child = spawn(process.execPath, [...loader, '--input-type=module', '-e', childSource, ...modules,
        fixture.root, fixture.token.userId, JSON.stringify(fixture.request), stop], { cwd: fixture.root, stdio: ['pipe', 'pipe', 'pipe'] });
      let dead = false, signal: NodeJS.Signals | null = null, output = '', diagnostics = '';
      const closed = new Promise<void>(resolve => child.once('close', (_code, actualSignal) => { dead = true; signal = actualSignal; resolve(); }));
      const ready = new Promise<void>((resolve, reject) => {
        child.once('error', reject); child.once('close', () => reject(new Error(`Erasure child closed before barrier: ${diagnostics}`)));
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output === 'ERASURE_BARRIER\n') resolve();
          else if (output.length > 256) reject(new Error('Erasure child output exceeded bound'));
        });
        child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(0, 4096); });
      });
      void ready.catch(() => undefined);
      const timer = setTimeout(() => { if (!dead) child.kill('SIGKILL'); }, 5000);
      try {
        await ready; child.kill('SIGKILL'); await closed; expect(signal).toBe('SIGKILL');
        if (stop.startsWith('gap-directory-') || stop.startsWith('gap-root-')) {
          const journal = JSON.parse(await fs.readFile(path.join(fixture.root, '.memory-owners/owners',
            `${fixture.token.ownerId}.erase.json`), 'utf8'));
          expect(journal).toMatchObject({ state: 'ACTION_PREPARED', action: { directory: true } });
          const target = path.posix.join(journal.action.parent.locator, journal.action.name);
          expect(target === `volumes/by-id/${fixture.token.ownerId}`).toBe(stop.startsWith('gap-root-'));
          await expect(fs.lstat(path.join(fixture.root, target))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await captureErasureFiles(fixture.foreignFiles)).toEqual(foreign);
        }
        // This is fixture cleanup after the exact test child is confirmed dead, not lease takeover.
        await fs.rm(path.join(fixture.root, '.memory-fences/tenant.lock'), { recursive: true });
        if (stop.startsWith('gap-final-')) {
          await expect(fs.lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
          const registry = path.join(fixture.root, '.memory-owners/owners');
          expect((await fs.readdir(registry)).filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
          const evidence = await captureErasureTree(registry);
          const error = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
            operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }).catch(cause => cause);
          expect(error).toMatchObject({ code: 'EERASURERESIDUAL' });
          expect(error).not.toHaveProperty('result'); expect(error).not.toHaveProperty('headDeleted');
          expect(await captureErasureTree(registry)).toEqual(evidence);
          return;
        }
        if (stop === 'partial-segment-stage') {
          const registry = path.join(fixture.root, '.memory-owners/owners'), evidence = await captureErasureTree(registry);
          await expect(fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
            operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId }))
            .rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
          expect(await captureErasureTree(registry)).toEqual(evidence);
          expect(await captureErasureTree(selected)).toEqual(before);
          return;
        }
        if (['head-prepared-durable', 'ready-durable', 'inventory-durable', 'action-prepared-durable'].includes(stop)) {
          expect(await captureErasureTree(selected)).toEqual(before);
        }
        const result = await fixture.owners.recoverOwnedErasure({ ownerId: fixture.token.ownerId,
          operationId: fixture.request.operationId, deleteOperationId: fixture.request.deleteOperationId });
        expect(['erased', 'already-erased']).toContain(result.status);
        expect(await captureErasureFiles(fixture.foreignFiles)).toEqual(foreign);
        await expect(fs.lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await fs.readdir(path.join(fixture.root, '.memory-owners/owners')))
          .filter(name => name.startsWith(fixture.token.ownerId))).toEqual([]);
      } finally {
        clearTimeout(timer); if (!dead) child.kill('SIGKILL'); await closed; await fixture.cleanup();
      }
    }, 10_000);
});
