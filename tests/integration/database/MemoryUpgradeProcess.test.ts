/** Native compiled OFF lifecycle acceptance; private barriers never replace production drain. */
import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ownedUpgradeProcess } from './fixtures/memory-upgrade-process.js';
import { text } from './fixtures/authenticated-memory-runtime.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

required('memory-safe actual compiled process upgrade', () => {
  it('preserves both durable acknowledgements from distinct sessions writing the same OFF memory across shutdown and restart', () =>
    ownedUpgradeProcess('distinct-session-overlap', async ({ f, token, spawn: start }) => {
      const runtime = await start();
      const firstClient = await runtime.connect(token); const secondClient = await runtime.connect(token);
      expect(runtime.sessionId(firstClient)).toBeTruthy(); expect(runtime.sessionId(secondClient)).toBeTruthy();
      expect(runtime.sessionId(firstClient)).not.toBe(runtime.sessionId(secondClient));
      await runtime.rpc('arm', { count: 2 });
      const controller = new AbortController();
      let secondSettled = false;
      const request = (client: typeof firstClient, content: string) => client.callTool({ name: 'mcp_aql_create', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content },
      } }, undefined, { signal: controller.signal });
      const first = request(firstClient, 'First session upgrade entry'); void first.catch(() => undefined);
      await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'save-enter' && frame.held));
      const second = request(secondClient, 'Second session upgrade entry').finally(() => { secondSettled = true; });
      void second.catch(() => undefined);
      try {
        const admissionDeadline = Date.now() + 15000;
        while ((await runtime.rpc('summary')).admitted < 2) {
          if (Date.now() >= admissionDeadline) throw new Error('Two actual requests were not simultaneously admitted');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(secondSettled).toBe(false);
        await runtime.rpc('release-all');
        const firstResult = await first;
        const firstReceipt = JSON.parse(text(firstResult)) as { success: boolean; data: { id: string } };
        expect(firstResult.isError).not.toBe(true); expect(firstReceipt.success).toBe(true);
        await runtime.waitUntil(() => runtime.messages.filter(frame => frame.event === 'save-enter' && frame.held).length === 2);
        const entered = runtime.messages.filter(frame => frame.event === 'save-enter' && frame.held);
        expect(entered[0].memoryInstance).not.toBe(entered[1].memoryInstance);
        expect(secondSettled).toBe(false);
        runtime.signal();
        await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'signal-observed'));
        expect(runtime.finalClosed).toBe(false);
        expect((await runtime.rpc('summary')).writes).toBeGreaterThan(0);
        await runtime.rpc('release-all');
        const secondResult = await second;
        const secondReceipt = JSON.parse(text(secondResult)) as { success: boolean; data: { id: string } };
        expect(secondResult.isError).not.toBe(true); expect(secondReceipt.success).toBe(true);
        expect(firstReceipt.data.id).toBeTruthy(); expect(secondReceipt.data.id).toBeTruthy();
        expect(firstReceipt.data.id).not.toBe(secondReceipt.data.id);
        const expected = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(expected.some(row => row.entry_id === firstReceipt.data.id && row.content === 'First session upgrade entry')).toBe(true);
        expect(expected.some(row => row.entry_id === secondReceipt.data.id && row.content === 'Second session upgrade entry')).toBe(true);
        expect(expected.some(row => row.content === 'Preserved entry')).toBe(true);
        await runtime.waitForClose(); expect(runtime.exitCode).toBe(0); expect(runtime.exitSignal).toBeNull();
        const fresh = await start(); expect(fresh.child.pid).not.toBe(runtime.child.pid);
        const freshClient = await fresh.connect(token);
        const read = await freshClient.callTool({ name: 'mcp_aql_read', arguments: {
          operation: 'get_element_details', params: { element_name: f.name, element_type: 'memories' },
        } });
        expect(read.isError).not.toBe(true);
        expect(text(read)).toContain('First session upgrade entry'); expect(text(read)).toContain('Second session upgrade entry');
        const actual = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        const normalized = (rows: typeof actual) => rows.map(row => ({ id: row.entry_id, content: row.content })).sort((a, b) => a.id.localeCompare(b.id));
        expect(normalized(actual)).toEqual(normalized(expected));
      } finally {
        if (!runtime.finalClosed) await runtime.rpc('release-all');
        controller.abort(); await Promise.allSettled([first, second]);
      }
    }), 180000);

  it('waits for an admitted OFF append before shutdown, then reads every acknowledged entry after restart', () =>
    ownedUpgradeProcess('append-overlap', async ({ f, token, spawn: start }) => {
      const runtime = await start();
      const client = await runtime.connect(token);
      await runtime.rpc('arm', { count: 1 });
      const controller = new AbortController();
      let responseSettled = false;
      const append = client.callTool({ name: 'mcp_aql_create', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content: 'Acknowledged upgrade entry' },
      } }, undefined, { signal: controller.signal }).then(result => { responseSettled = true; return result; }, cause => {
        responseSettled = true; controller.abort(cause); throw cause;
      });
      void append.catch(() => undefined);
      try {
        await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'save-enter' && frame.held));
        expect(responseSettled).toBe(false);
        const summary = await runtime.rpc('summary');
        expect(summary.admitted).toBeGreaterThan(0);
        expect(summary.writes).toBeGreaterThan(0);
        runtime.signal();
        await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'signal-observed'));
        expect(runtime.finalClosed).toBe(false);
        expect(responseSettled).toBe(false);
        await runtime.rpc('release-all');
        const result = await append;
        expect(result.isError).not.toBe(true);
        const receipt = JSON.parse(text(result)) as { success: boolean; data: { id: string; timestamp: string } };
        expect(receipt.success).toBe(true); expect(receipt.data.id).toBeTruthy();
        const beforeRestart = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(beforeRestart.some(row => row.entry_id === receipt.data.id && row.content === 'Acknowledged upgrade entry')).toBe(true);
        expect(beforeRestart.some(row => row.content === 'Preserved entry')).toBe(true);
        await runtime.waitForClose();
        expect(runtime.exitCode).toBe(0); expect(runtime.exitSignal).toBeNull();
        const fresh = await start(); expect(fresh.child.pid).not.toBe(runtime.child.pid);
        const freshClient = await fresh.connect(token);
        const read = await freshClient.callTool({ name: 'mcp_aql_read', arguments: {
          operation: 'get_element_details', params: { element_name: f.name, element_type: 'memories' },
        } });
        expect(read.isError).not.toBe(true);
        const visible = text(read);
        expect(visible).toContain('Acknowledged upgrade entry'); expect(visible).toContain('Preserved entry');
        const afterRestart = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(afterRestart.map(row => ({ id: row.entry_id, content: row.content })).sort((a, b) => a.id.localeCompare(b.id)))
          .toEqual(beforeRestart.map(row => ({ id: row.entry_id, content: row.content })).sort((a, b) => a.id.localeCompare(b.id)));
      } finally {
        if (!runtime.finalClosed) await runtime.rpc('release-all');
        controller.abort();
        await append.catch(() => undefined);
      }
    }), 180000);

  it('failed accepted manual persistence retains the disposed child owner and refuses non-force cutover until its exact candidate is known saved', () =>
    ownedUpgradeProcess('nonforce-deadline', async ({ f, directory, token, spawn: start, ownAuxiliary }) => {
      // Two actual ordinary DB rows share the normalized name. Appending to
      // the corrupted-name row must refuse before upsert can select its sibling.
      const corruptedName = f.name + '.backup-2025-11-14-22-40-57-303';
      const corruptedId = await f.layer.writeContent('memories', corruptedName, f.raw.replaceAll(f.name, corruptedName),
        {author:'test-author',version:'1.0.0',description:'',tags:[]});
      expect(corruptedId).not.toBe(f.memoryId);
      const runtime = await start(); const client = await runtime.connect(token);
      await runtime.rpc('fault', { enabled: true });
      await runtime.rpc('arm', { count: 1 });
      const controller = new AbortController();
      const append = client.callTool({ name: 'mcp_aql_create', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content: 'Retained failed upgrade candidate' },
      } }, undefined, { signal: controller.signal }).catch(cause => { controller.abort(cause); throw cause; });
      void append.catch(() => undefined);
      const bin = path.join(directory, 'helper-bin'); await mkdir(bin, { mode: 0o700 });
      const trace = path.join(directory, 'helper-command-trace.jsonl');
      const target = 'a'.repeat(64);
      // Fixed adapter runs the actual client on this owned process's Unix
      // socket. Selected Docker metadata is synthetic; engine eligibility is
      // qualified separately by the real Docker witness.
      const stateFormat = "{\"id\":{{json .Id}},\"running\":{{json .State.Running}},\"exitCode\":{{json .State.ExitCode}},\"oomKilled\":{{json .State.OOMKilled}},\"startedAt\":{{json .State.StartedAt}},\"restartCount\":{{json .RestartCount}},\"restarting\":{{json .State.Restarting}},\"readonly\":{{json .HostConfig.ReadonlyRootfs}},\"mounts\":{{json .Mounts}},\"enabled\":\"{{range .Config.Env}}{{if eq (index (split . \"=\") 0) \"DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR\"}}{{if eq . \"DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR=/app/.memory-upgrade-control\"}}enabled{{else}}invalid{{end}}{{end}}{{end}}\",\"capability\":{{json (index .Config.Labels \"org.dollhousemcp.memory-upgrade-drain\")}}}";
      const adapter = `#!/usr/bin/env python3
import os,sys,json,signal,re
from pathlib import Path
a=sys.argv[1:];p=Path(${JSON.stringify(trace)});pid=${runtime.child.pid};cid=${JSON.stringify(target)}
with p.open('a') as f: f.write(json.dumps(a)+'\\n')
if a==['inspect','--format',${JSON.stringify(stateFormat)},cid]:
 try: os.kill(pid,0);alive=True
 except ProcessLookupError: alive=False
 print(json.dumps({'id':cid,'running':alive,'exitCode':0,'oomKilled':False,'startedAt':'owned-'+str(pid),'restartCount':0,'restarting':False,'readonly':False,'mounts':[],'enabled':'enabled','capability':'v2'}));sys.exit(0)
if a[:8]==['exec','--user','1001:1001','--workdir','/app',cid,'node','/app/dist/lifecycle/requestMemoryDrain.js'] and len(a)==11 and a[8]==cid and re.fullmatch('[a-f0-9]{64}',a[9]) and a[10].isdigit():
 os.environ['DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR']=${JSON.stringify(runtime.controlDirectory)}
 os.execv(${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},${JSON.stringify(path.join(process.cwd(), 'dist/lifecycle/requestMemoryDrain.js'))},*a[8:]])
if a==['kill','--signal=TERM',cid]:
 os.kill(pid,signal.SIGTERM);sys.exit(0)
sys.exit(3)
`;
      await writeFile(path.join(bin, 'docker'), adapter, { mode: 0o700 });
      try {
        await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'save-enter' && frame.held));
        await runtime.rpc('release-all');
        const refused = await append;
        const refusedReceipt = JSON.parse(text(refused)) as { success?: boolean };
        expect(refused.isError === true || refusedReceipt.success === false).toBe(true);
        // A rejected signed append is unacknowledged and never mutates live RAM.
        expect((await runtime.rpc('summary')).failedWrites).toBe(0);
        const afterRejected = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(afterRejected.some(row => row.content === 'Retained failed upgrade candidate')).toBe(false);
        const identityBefore = await f.maintenance`SELECT to_jsonb(e) AS value FROM public.elements e ORDER BY id`;
        const childrenBefore = await f.snapshot();
        // This proof must reach the real identity guard, not the separate
        // injected save fault (normalization produces this fixture's name).
        await runtime.rpc('fault', {enabled:false});
        let rename;
        try { rename = await runtime.rpc('renamed-append-refusal'); }
        finally { await runtime.rpc('fault', {enabled:true}); }
        expect(rename).toMatchObject({saved:false,outcome:'refused-before-write',relocationRefused:true,sourceUnchanged:true,locatorUnchanged:true});
        expect(await f.maintenance`SELECT to_jsonb(e) AS value FROM public.elements e ORDER BY id`).toEqual(identityBefore);
        expect(await f.snapshot()).toEqual(childrenBefore);
        expect((await runtime.rpc('summary')).failedWrites).toBe(0);
        const manual = await runtime.rpc('manual-retained-save');
        expect(manual.saved).toBe(false); expect(manual.outcome).toBe('refused-before-write');
        expect(typeof manual.id).toBe('string');
        expect((await runtime.rpc('summary')).failedWrites).toBeGreaterThan(0);
        const beforeRecovery = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(beforeRecovery.some(row => row.content === 'Retained failed upgrade candidate')).toBe(false);
        // SDK close only disconnects locally. Explicit HTTP DELETE requests
        // real server session disposal; refusal must retain the failed candidate.
        await runtime.terminateSession(client).catch(() => undefined);
        await client.close().catch(() => undefined);
        await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'retained-owner-dispose-refused'));
        expect((await runtime.rpc('summary')).retainedOwners).toBeGreaterThan(0);
        const invokeHelper = () => {
          const helper = spawn('bash', [path.join(process.cwd(), 'scripts/hosted-graceful-stop.sh'), target, '1'], {
            env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'],
          });
          ownAuxiliary(helper); helper.stdout!.resume(); helper.stderr!.resume();
          return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            // Cap the owned helper process, never the old application. Require
            // final helper close even on a diagnostic cutoff; no SIGKILL.
            let cutoff = false;
            let closeCap: ReturnType<typeof setTimeout> | undefined;
            const cap = setTimeout(() => {
              cutoff = true; helper.kill('SIGTERM');
              closeCap = setTimeout(() => reject(new Error('Owned helper final close unproven')), 5000);
            }, 15000);
            helper.once('error', cause => { clearTimeout(cap); if (closeCap) clearTimeout(closeCap); reject(cause); });
            helper.once('close', (code, signal) => {
              clearTimeout(cap); if (closeCap) clearTimeout(closeCap);
              if (cutoff) reject(new Error('Owned non-force helper exceeded its bound'));
              else resolve({ code, signal });
            });
          });
        };
        const outcome = await invokeHelper();
        expect(outcome.code).not.toBe(0); expect(outcome.signal).toBeNull();
        expect(runtime.finalClosed).toBe(false); expect(runtime.child.exitCode).toBeNull();
        const blocked = await runtime.rpc('summary');
        expect(blocked.state).toBe('refused'); expect(blocked.failedWrites).toBeGreaterThan(0);
        expect(blocked.retainedOwners).toBeGreaterThan(0);
        const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
        expect(commands.some(argv => argv[0] === 'exec')).toBe(true);
        expect(commands.some(argv => argv[0] === 'kill')).toBe(false);
        expect(commands.every(argv => ['exec', 'kill', 'inspect'].includes(argv[0]))).toBe(true);
        expect(commands.flat().some(arg => /KILL|^stop$|^rm$|^run$|^start$/u.test(arg))).toBe(false);
        // The private manual caller accepted Memory.addEntry before the
        // injected prewrite failure. This is actual tracked manual work, not
        // a signed HTTP ACK, a DB rollback, or an unknown commit.
        // Remove only the owned synthetic storage fault. A fresh actual client
        // handshake must flush the retained candidate before its single TERM;
        // no test-only ledger clear or force-kill is allowed.
        await runtime.rpc('fault', { enabled: false });
        const settled = await invokeHelper();
        expect(settled).toEqual({code:0,signal:null});
        await runtime.waitForClose(); expect(runtime.exitCode).toBe(0);
        const finalCommands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
        expect(finalCommands.filter(argv => argv[0] === 'kill')).toHaveLength(1);
        expect(finalCommands.filter(argv => argv[0] === 'exec')).toHaveLength(2);
        const persisted = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(persisted.filter(row => row.content === 'Retained failed upgrade candidate')).toHaveLength(1);
        expect(persisted.find(row => row.entry_id === manual.id)?.content).toBe('Retained failed upgrade candidate');
        expect(new Set(persisted.map(row => row.entry_id)).size).toBe(persisted.length);
        expect(persisted.some(row => row.content === 'Preserved entry')).toBe(true);
      } finally {
        if (!runtime.finalClosed) {
          await runtime.rpc('fault', { enabled: false });
          await runtime.rpc('release-all');
        }
        controller.abort(); await append.catch(() => undefined);
      }
    }), 180000);
});
