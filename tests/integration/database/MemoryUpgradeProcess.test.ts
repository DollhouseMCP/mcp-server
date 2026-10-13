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

  it('failed persistence retains the disposed child owner and refuses non-force cutover until its exact candidate is known saved', () =>
    ownedUpgradeProcess('nonforce-deadline', async ({ f, directory, token, spawn: start, ownAuxiliary }) => {
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
      // Fixed command adapter exercises the ACTUAL shell helper and real Node
      // SIGTERM/liveness. This is a process proof, not Docker-engine acceptance.
      const adapter = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');const pid=${runtime.child.pid};const id=${JSON.stringify(target)};if(a[0]==='kill'&&a.includes(id)&&a.some(x=>x==='--signal=TERM'||x==='--signal=SIGTERM'||x==='SIGTERM'||x==='TERM')){process.kill(pid,'SIGTERM');process.exit(0)}if(a[0]==='inspect'&&a.includes(id)&&a[2]===${JSON.stringify('{{index .Config.Labels "org.dollhousemcp.memory-upgrade-drain"}}')}){process.stdout.write('v1\\n');process.exit(0)}if(a[0]==='inspect'&&a.includes(id)&&a[2]===${JSON.stringify('{{.Id}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}')}){let alive;try{process.kill(pid,0);alive=true}catch{alive=false}process.stdout.write(id+'|'+String(alive)+'|0|false\\n');process.exit(0)}process.stderr.write('Unsupported owned helper command\\n');process.exit(3);\n`;
      await writeFile(path.join(bin, 'docker'), adapter, { mode: 0o700 });
      try {
        await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'save-enter' && frame.held));
        await runtime.rpc('release-all');
        const refused = await append;
        const refusedReceipt = JSON.parse(text(refused)) as { success?: boolean };
        expect(refused.isError === true || refusedReceipt.success === false).toBe(true);
        expect((await runtime.rpc('summary')).failedWrites).toBeGreaterThan(0);
        const beforeRecovery = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(beforeRecovery.some(row => row.content === 'Retained failed upgrade candidate')).toBe(false);
        // Real transport closure invokes production child disposal. It must
        // refuse while the exact failed candidate remains retained.
        await client.close().catch(() => undefined);
        await runtime.waitUntil(() => runtime.messages.some(frame => frame.event === 'retained-owner-dispose-refused'));
        expect((await runtime.rpc('summary')).retainedOwners).toBeGreaterThan(0);
        const helper = spawn('bash', [path.join(process.cwd(), 'scripts/hosted-graceful-stop.sh'), target, '1'], {
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        ownAuxiliary(helper); helper.stdout!.resume(); helper.stderr!.resume();
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
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
        expect(outcome.code).not.toBe(0); expect(outcome.signal).toBeNull();
        expect(runtime.finalClosed).toBe(false); expect(runtime.child.exitCode).toBeNull();
        const blocked = await runtime.rpc('summary');
        expect(blocked.state).toBe('refused'); expect(blocked.failedWrites).toBeGreaterThan(0);
        expect(blocked.retainedOwners).toBeGreaterThan(0);
        const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
        expect(commands.some(argv => argv[0] === 'kill')).toBe(true);
        expect(commands.every(argv => ['kill', 'inspect'].includes(argv[0]))).toBe(true);
        expect(commands.flat().some(arg => /KILL|^stop$|^rm$|^run$|^start$/u.test(arg))).toBe(false);
        // The injected error precedes the original SQL body: this proves an
        // actual-process tracked failure, not a DB rollback/unknown commit.
        // Remove only the owned synthetic storage fault. A fresh real signal
        // must cause the production flush to persist the retained candidate;
        // no test-only ledger clear or force-kill is allowed.
        await runtime.rpc('fault', { enabled: false });
        runtime.signal();
        await runtime.waitForClose(); expect(runtime.exitCode).toBe(0);
        const persisted = await f.maintenance`SELECT entry_id,content FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid`;
        expect(persisted.filter(row => row.content === 'Retained failed upgrade candidate')).toHaveLength(1);
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
