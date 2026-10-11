/** Actual compiled HTTP dispatch, verified ES256 middleware and fresh-process boot. */
import { describe, expect, it } from '@jest/globals';
import { ownedAuthenticated, read, text } from './fixtures/authenticated-memory-runtime.js';
import { decodeMemoryCandidate, encodeMemoryCandidate } from '../../../src/storage/DatabaseMemoryCandidateEnvelope.js';
import { DatabaseMemoryReconciliationInspector } from '../../../src/storage/DatabaseMemoryReconciliationInspector.js';
import type { MemoryUpdateCandidate } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { createHash } from 'node:crypto';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
function permanentRaw(name: string, count: number, content = 'Permanent owner entry'): string {
  const header = [`name: ${name}`, 'description: Permanent authenticated legacy fixture', 'author: test-author',
    'version: 1.0.0', 'memoryType: user', 'autoLoad: false', 'entries:'];
  for (let index = 0; index < count; index++) header.push(`  - id: "entry-${index}"`,
    `    content: ${JSON.stringify(`${content}-${index}`)}`,
    `    timestamp: "${new Date(Date.UTC(2026, 8, 28) + count - index).toISOString()}"`);
  return header.join('\n');
}
required('authenticated compiled guarded memory runtime', () => {
  it.each([1000, 1001])('loads %i permanent legacy entries through signed HTTP without pruning, then refuses a full append', count =>
    ownedAuthenticated(`permanent-${count}`, async ({ f, token, spawn }) => {
      const runtime = spawn(); await runtime.ready();
      const client = await runtime.connect(token);
      const before = await f.snapshot();
      const held = await runtime.hold(client, f.name);
      expect(held.frame.user).toBe(f.userId);
      const loaded = await runtime.rpc('load', { handle: held.frame.handle });
      expect(loaded.error).toBeUndefined(); expect(loaded.result.entries).toBe(count);
      expect(await f.snapshot()).toEqual(before);
      await runtime.rpc('release', { handle: held.frame.handle }); await held.response;
      const append = await client.callTool({ name: 'mcp_aql_create', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content: 'Capacity cannot discard an existing entry' },
      } });
      expect(text(append)).toMatch(/full|capacity|maximum|limit/iu);
      expect(await f.snapshot()).toEqual(before);
      expect(await f.maintenance`SELECT id FROM public.memory_candidate_handoffs`).toHaveLength(0);
      expect((await runtime.rpc('stats')).result.rootMemoryResolutions).toBe(0);
    }, name => permanentRaw(name, count)), 180000);

  it('reads legacy UTF-8 above two MiB but below two MiB JS units, and refuses the smaller write cap without loss', () =>
    ownedAuthenticated('large-utf8-read', async ({ f, token, spawn }) => {
      const before = await f.snapshot();
      const raw = JSON.parse(before.parent).raw_content as string;
      expect(raw.length).toBeGreaterThan(256 * 1024);
      expect(raw.length).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(2 * 1024 * 1024);
      const runtime = spawn(); await runtime.ready();
      const client = await runtime.connect(token);
      const held = await runtime.hold(client, f.name);
      const loaded = await runtime.rpc('load', { handle: held.frame.handle });
      expect(loaded.error).toBeUndefined(); expect(loaded.result.entries).toBe(8);
      expect(await f.snapshot()).toEqual(before);
      await runtime.rpc('release', { handle: held.frame.handle }); await held.response;
      const append = await client.callTool({ name: 'mcp_aql_create', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content: 'Cannot rewrite a legacy oversized head' },
      } });
      expect(text(append)).toMatch(/size|256|limit|large/iu);
      expect(await f.snapshot()).toEqual(before);
      expect(await f.maintenance`SELECT id FROM public.memory_candidate_handoffs`).toHaveLength(0);
    }, name => permanentRaw(name, 8), async f => {
      // Stage a historical head beyond the CURRENT ordinary writer cap; its
      // complete matching projection is explicit owned fixture data. Real
      // maintenance inspection, not this substitution, grants boot eligibility.
      const content = '界'.repeat(100000), raw = permanentRaw(f.name, 8, content);
      await f.maintenance`UPDATE public.elements SET raw_content=${raw},
        content_hash=${createHash('sha256').update(raw).digest('hex')},byte_size=${Buffer.byteLength(raw)}
        WHERE id=${f.memoryId}::uuid`;
      for (let index = 0; index < 8; index++) await f.maintenance`UPDATE public.memory_entries
        SET content=${`${content}-${index}`} WHERE memory_id=${f.memoryId}::uuid AND entry_id=${`entry-${index}`}`;
    }), 180000);

  it('refuses actual cold boot for an above-recovery-bound owner without rewriting it', () =>
    ownedAuthenticated('above-recovery-bound', async ({ f, spawn }) => {
      // A controlled unsupported historical head, inserted only AFTER the
      // separate original baseline's genuine qualification. Never qualify or
      // clear this new dirty head to manufacture accepted write authority.
      const raw = `${f.raw}\n# ${'x'.repeat(2 * 1024 * 1024)}`;
      expect(raw.length).toBeGreaterThan(2 * 1024 * 1024);
      await f.maintenance`UPDATE public.elements SET raw_content=${raw},
        content_hash=${createHash('sha256').update(raw).digest('hex')},byte_size=${Buffer.byteLength(raw)}
        WHERE id=${f.memoryId}::uuid`;
      const before = await f.snapshot();
      const inspector = new DatabaseMemoryReconciliationInspector(f.db, () => f.userId);
      const observed = await inspector.inspect({ userId: f.userId, memoryId: f.memoryId });
      expect(observed.diagnostics.some(item => item.code === 'legacy_size_limit')).toBe(true);
      expect(await f.snapshot()).toEqual(before);
      const runtime = spawn();
      expect(await runtime.refused()).toMatch(/read qualification|qualif.*refus|legacy_size_limit/iu);
      expect(await f.snapshot()).toEqual(before);
      expect(await f.maintenance`SELECT id FROM public.memory_candidate_handoffs`).toHaveLength(0);
    }), 180000);

  it('retains the complete losing internal candidate after two real runtimes reach the same owner CAS, then refuses cold boot', () =>
    ownedAuthenticated('conflict-restart', async ({ f, token, spawn }) => {
      const left = spawn(), right = spawn();
      await Promise.all([left.ready(), right.ready()]);
      const [a, b] = await Promise.all([left.connect(token), right.connect(token)]);
      const [first, second] = await Promise.all([left.hold(a, f.name), right.hold(b, f.name)]);
      expect(first.frame.user).toBe(f.userId); expect(second.frame.user).toBe(f.userId);
      expect(first.frame.session).not.toBe(second.frame.session);
      expect(first.frame.request).toBeTruthy(); expect(second.frame.request).toBeTruthy();
      expect(first.frame.handle).not.toBe(second.frame.handle);
      expect((await right.rpc('load', { handle: first.frame.handle })).error).toBeDefined();
      const [loadedA, loadedB] = await Promise.all([left.rpc('load', { handle: first.frame.handle }),
        right.rpc('load', { handle: second.frame.handle })]);
      expect(loadedA.error).toBeUndefined(); expect(loadedB.error).toBeUndefined();
      // Runtime-only generated metadata can differ. Exact shared ORIGINAL
      // head revision is independently proved in both durable handoffs below.
      expect(loadedA.result.entryDigest).toBe(loadedB.result.entryDigest);
      const before = await f.snapshot();
      const lock = 390571;
      await f.competitor`SELECT pg_catalog.pg_advisory_lock(${lock})`;
      // After actual boot, instrument just this owned owner's genuine UPDATE.
      await f.maintenance.unsafe(`CREATE FUNCTION public.owned_memory_cas_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id='${f.memoryId}'::uuid THEN PERFORM pg_catalog.pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`);
      await f.maintenance`CREATE TRIGGER owned_memory_cas_barrier BEFORE UPDATE ON public.elements
        FOR EACH ROW EXECUTE FUNCTION public.owned_memory_cas_barrier()`;
      let released = false;
      try {
        const saveA = left.rpc('save', { handle: first.frame.handle, content: 'Complete left internal candidate' });
        const saveB = right.rpc('save', { handle: second.frame.handle, content: 'Complete right internal candidate' });
        const deadline = Date.now() + 15000;
        let prepared: { envelope: Buffer; digest: string; status: string; committed_token: unknown }[] = [];
        let ownerWait = false;
        while (Date.now() < deadline) {
          prepared = await f.maintenance`SELECT envelope,digest,status,committed_token FROM public.memory_candidate_handoffs`;
          const waits = await f.maintenance`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l
            JOIN pg_catalog.pg_stat_activity a USING(pid) WHERE a.datname=current_database()
              AND NOT l.granted AND l.locktype='transactionid' AND a.query ILIKE '%update%elements%') AS owner_wait`;
          ownerWait = waits[0].owner_wait;
          if (prepared.length === 2 && ownerWait) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(prepared).toHaveLength(2); expect(ownerWait).toBe(true);
        const candidates = prepared.map(row => decodeMemoryCandidate({ bytes: row.envelope, digest: row.digest }) as MemoryUpdateCandidate & {
          handoffEvidence: { original: { revision: string; userId: string; ownerId: string } };
        });
        expect(prepared.every(row => row.status === 'prepared' && row.committed_token === null)).toBe(true);
        for (const candidate of candidates) {
          expect(candidate.handoffEvidence.original.revision).toBe(before.revision);
          expect(candidate.handoffEvidence.original.userId).toBe(f.userId);
          expect(candidate.handoffEvidence.original.ownerId).toBe(f.memoryId);
          expect(candidate.content).toContain('Preserved entry');
        }
        expect(candidates.map(candidate => candidate.content).join('\n')).toContain('Complete left internal candidate');
        expect(candidates.map(candidate => candidate.content).join('\n')).toContain('Complete right internal candidate');
        // Explicit release and a second command cannot end/mutate an in-flight scope.
        expect((await left.rpc('release', { handle: first.frame.handle })).error).toBeDefined();
        expect((await right.rpc('load', { handle: second.frame.handle })).error).toBeDefined();
        await f.competitor`SELECT pg_catalog.pg_advisory_unlock(${lock})`; released = true;
        const outcomes = await Promise.all([saveA, saveB]);
        expect(outcomes.filter(outcome => !outcome.error)).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.error)).toHaveLength(1);
        const loser = outcomes[0].error ? { runtime: left, handle: first.frame.handle } : { runtime: right, handle: second.frame.handle };
        const pending = await loser.runtime.rpc('pending', { handle: loser.handle });
        expect(pending.result.status).toBe('refused');
        const evidence = await f.maintenance`SELECT envelope,digest,status,committed_token FROM public.memory_candidate_handoffs`;
        // The genuine central Memory.save owns its publication and retires
        // its successful handoff. Only the complete loser remains unresolved.
        expect(evidence).toHaveLength(1);
        expect(evidence[0].status).toBe('prepared');
        const retained = evidence.find(row => {
          const decoded = decodeMemoryCandidate({ bytes: row.envelope, digest: row.digest });
          return encodeMemoryCandidate({ name: decoded.name, content: decoded.content, metadata: decoded.metadata }).digest === pending.result.digest;
        })!;
        expect(retained).toBeDefined();
        const decoded = decodeMemoryCandidate({ bytes: retained.envelope, digest: retained.digest });
        expect(encodeMemoryCandidate({ name: decoded.name, content: decoded.content, metadata: decoded.metadata }).bytes.toString('hex'))
          .toBe(pending.result.bytes);
        expect(retained.committed_token).toBeNull();
        const quota = await f.maintenance`SELECT retained_rows,retained_bytes FROM public.memory_candidate_quotas WHERE user_id=${f.userId}::uuid`;
        expect(BigInt(quota[0].retained_rows)).toBe(1n); expect(BigInt(quota[0].retained_bytes)).toBe(BigInt(retained.envelope.length));
        const winner = await f.snapshot();
        // Parent/tag/child triggers advance the final token more than once;
        // the winner is one actual head write, not one catalog increment.
        expect(BigInt(winner.revision)).toBeGreaterThan(BigInt(before.revision));
        expect(winner.parent).toContain('Preserved entry');
        expect(JSON.parse(winner.entries)).toHaveLength(2);
        expect(['Complete left internal candidate', 'Complete right internal candidate']
          .filter(content => winner.parent.includes(content))).toHaveLength(1);
        expect(winner.dirty).toBe(false);
        await left.rpc('release', { handle: first.frame.handle });
        await right.rpc('release', { handle: second.frame.handle });
        await Promise.allSettled([first.response, second.response]);
        expect((await left.rpc('save', { handle: first.frame.handle, content: 'Ended invocation' })).error).toBeDefined();
        await Promise.all([left.close(), right.close()]);
        await f.maintenance`DROP TRIGGER owned_memory_cas_barrier ON public.elements`;
        await f.maintenance`DROP FUNCTION public.owned_memory_cas_barrier()`;
        const cold = spawn();
        expect(await cold.refused()).toContain('Retained memory outcomes require explicit resolution');
        expect(await f.snapshot()).toEqual(winner);
        expect(await f.maintenance`SELECT envelope,digest,status,committed_token FROM public.memory_candidate_handoffs`).toEqual(evidence);
        const off = spawn(false);
        expect(await off.refused()).toContain('matching trusted composition');
        expect(await f.snapshot()).toEqual(winner);
      } finally {
        if (!released) await f.competitor`SELECT pg_catalog.pg_advisory_unlock(${lock})`;
      }
    }), 240000);

  it('arbitrates two permitted signed AQL writes at the real owner CAS without losing the refused candidate', () =>
    ownedAuthenticated('public-aql-cas', async ({ f, token, spawn }) => {
      const left = spawn(), right = spawn(); await Promise.all([left.ready(), right.ready()]);
      const [a, b] = await Promise.all([left.connect(token), right.connect(token)]);
      // Both real READ routes preload the same original head before WRITE.
      expect(await read(a, 'get_element_details', { element_name: f.name, element_type: 'memories' }))
        .toContain('Preserved entry');
      expect(await read(b, 'get_element_details', { element_name: f.name, element_type: 'memories' }))
        .toContain('Preserved entry');
      const before = await f.snapshot(), lock = 390572;
      await f.competitor`SELECT pg_catalog.pg_advisory_lock(${lock})`;
      await f.maintenance.unsafe(`CREATE FUNCTION public.owned_public_aql_cas_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id='${f.memoryId}'::uuid THEN PERFORM pg_catalog.pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`);
      await f.maintenance`CREATE TRIGGER owned_public_aql_cas_barrier BEFORE UPDATE ON public.elements
        FOR EACH ROW EXECUTE FUNCTION public.owned_public_aql_cas_barrier()`;
      let released = false;
      try {
        const write = (client: typeof a, content: string) => client.callTool({ name: 'mcp_aql_create', arguments: {
          operation: 'addEntry', params: { element_name: f.name, content, metadata: { confidence: 0.5 } },
        } });
        const first = write(a, 'Left permitted public candidate'), second = write(b, 'Right permitted public candidate');
        const deadline = Date.now() + 15000;
        let prepared: { envelope: Buffer; digest: string; status: string; committed_token: unknown }[] = [];
        let ownerWait = false;
        while (Date.now() < deadline) {
          prepared = await f.maintenance`SELECT envelope,digest,status,committed_token FROM public.memory_candidate_handoffs`;
          const waiting = await f.maintenance`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l
            JOIN pg_catalog.pg_stat_activity a USING(pid) WHERE a.datname=current_database()
              AND NOT l.granted AND l.locktype='transactionid' AND a.query ILIKE '%update%elements%') AS owner_wait`;
          ownerWait = waiting[0].owner_wait;
          if (prepared.length === 2 && ownerWait) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(prepared).toHaveLength(2); expect(ownerWait).toBe(true);
        const captured = prepared.map(row => ({ row, candidate: decodeMemoryCandidate({ bytes: row.envelope, digest: row.digest }) as
          MemoryUpdateCandidate & { handoffEvidence: { original: { revision: string; ownerId: string; userId: string } } } }));
        for (const { row, candidate } of captured) {
          expect(row.status).toBe('prepared'); expect(row.committed_token).toBeNull();
          expect(candidate.handoffEvidence.original).toMatchObject({ revision: before.revision, ownerId: f.memoryId, userId: f.userId });
          expect(candidate.content).toContain('Preserved entry');
        }
        expect(captured.map(item => item.candidate.content).join('\n')).toContain('Left permitted public candidate');
        expect(captured.map(item => item.candidate.content).join('\n')).toContain('Right permitted public candidate');
        await f.competitor`SELECT pg_catalog.pg_advisory_unlock(${lock})`; released = true;
        const outcomes = await Promise.all([first, second]);
        const rendered = outcomes.map(result => JSON.parse(text(result)) as { success: boolean; error?: string; data?: { id: string } });
        expect(rendered.filter(result => result.success === true)).toHaveLength(1);
        expect(rendered.filter(result => result.success === false)).toHaveLength(1);
        const acknowledged = rendered.find(result => result.success === true)!;
        expect(acknowledged.error).toBeUndefined(); expect(acknowledged.data?.id).toMatch(/^mem_/u);
        expect(rendered.find(result => result.success === false)!.error).toContain('identity changed during save');
        const winner = await f.snapshot();
        expect(winner.dirty).toBe(false); expect(JSON.parse(winner.entries)).toHaveLength(2);
        expect(BigInt(winner.revision)).toBeGreaterThan(BigInt(before.revision));
        expect(winner.entries).toContain(acknowledged.data!.id);
        expect(winner.parent).toContain('Preserved entry');
        expect(['Left permitted public candidate', 'Right permitted public candidate']
          .filter(content => winner.parent.includes(content))).toHaveLength(1);
        const retained = await f.maintenance`SELECT envelope,digest,status,committed_token FROM public.memory_candidate_handoffs`;
        expect(retained).toHaveLength(1); expect(retained[0].status).toBe('prepared'); expect(retained[0].committed_token).toBeNull();
        const quota = await f.maintenance`SELECT retained_rows,retained_bytes FROM public.memory_candidate_quotas WHERE user_id=${f.userId}::uuid`;
        expect(BigInt(quota[0].retained_rows)).toBe(1n); expect(BigInt(quota[0].retained_bytes)).toBe(BigInt(retained[0].envelope.length));
        const original = captured.find(item => item.row.digest === retained[0].digest)!;
        expect(original).toBeDefined(); expect(retained[0].envelope).toEqual(original.row.envelope);
        // Complete canonical envelope, not an unnormalized request substring,
        // is the refused candidate authority. The winner must be its sibling.
        expect(winner.parent.includes(original.candidate.content.includes('Left permitted public candidate')
          ? 'Left permitted public candidate' : 'Right permitted public candidate')).toBe(false);
      } finally { if (!released) await f.competitor`SELECT pg_catalog.pg_advisory_unlock(${lock})`; }
    }), 180000);

  it('acknowledges a real authorized AQL append and requalifies the exact head in a different compiled process', () =>
    ownedAuthenticated('clean-restart', async ({ f, token, foreignToken, spawn }) => {
      const runtime = spawn();
      await runtime.ready();
      const client = await runtime.connect(token);
      const sameTenant = await runtime.connect(token);
      const foreign = await runtime.connect(foreignToken);
      const before = await f.snapshot();
      const first = await runtime.hold(client, f.name);
      const second = await runtime.hold(sameTenant, f.name);
      expect(first.frame.user).toBe(f.userId); expect(second.frame.user).toBe(f.userId);
      expect(first.frame.session).not.toBe(second.frame.session);
      expect(first.frame.request).not.toBe(second.frame.request);
      expect(first.frame.manager).toBe(second.frame.manager);
      await runtime.rpc('release', { handle: first.frame.handle });
      await runtime.rpc('release', { handle: second.frame.handle });
      await Promise.all([first.response, second.response]);
      const disconnecting = await runtime.connect(token);
      const ending = await runtime.hold(disconnecting, f.name);
      await runtime.disconnect(disconnecting);
      await ending.response.catch(() => undefined);
      expect((await runtime.rpc('load', { handle: ending.frame.handle })).error).toBeDefined();
      expect(await f.snapshot()).toEqual(before);
      expect(await read(client, 'activate_element', { element_name: f.name, element_type: 'memories' })).toContain(f.name);
      expect(await read(client, 'get_active_elements', { element_type: 'memories' })).toContain(f.name);
      expect(await read(sameTenant, 'get_active_elements', { element_type: 'memories' })).not.toContain(f.name);
      const details = await read(client, 'get_element_details', { element_name: f.name, element_type: 'memories' });
      expect(details).toContain('Preserved entry');
      expect(await read(foreign, 'get_element_details', { element_name: f.name, element_type: 'memories' }))
        .not.toContain('Preserved entry');
      expect(await f.snapshot()).toEqual(before);
      for (const authorization of [undefined, 'Bearer invalid.owned.token']) {
        const denied = await fetch(runtime.url, { method: 'POST', headers: { 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream', ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'denied-owned', version: '1' },
        } }) });
        expect(denied.status).toBe(401); await denied.text();
      }
      const foreignWrite = await foreign.callTool({ name: 'mcp_aql_create', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content: 'Foreign subject cannot select this owner' },
      } });
      expect(text(foreignWrite)).toMatch(/not found|not.*exist|error/iu);
      expect(await f.snapshot()).toEqual(before);
      const denied = await client.callTool({ name: 'mcp_aql_read', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content: 'Wrong endpoint must not write' },
      } });
      // AQL carries its semantic refusal in the response body; SDK isError
      // denotes an MCP transport/tool error and is not its endpoint contract.
      expect(text(denied)).toMatch(/CREATE|not.*READ|error/iu);
      expect(await f.snapshot()).toEqual(before);
      const appended = await client.callTool({ name: 'mcp_aql_create', arguments: {
        operation: 'addEntry', params: { element_name: f.name, content: 'Acknowledged signed AQL write',
          metadata: { confidence: 0.5 } },
      } });
      expect(appended.isError).not.toBe(true);
      expect(text(appended)).not.toMatch(/NOT saved|refus|error/iu);
      const winner = await f.snapshot();
      expect(winner.dirty).toBe(false);
      expect(winner.parent).toContain('Acknowledged signed AQL write');
      expect(winner.revision).not.toBe(before.revision);
      expect(await f.maintenance`SELECT id FROM public.memory_candidate_handoffs`).toHaveLength(0);
      expect((await runtime.rpc('stats')).result.rootMemoryResolutions).toBe(0);
      const oldPid = runtime.child.pid;
      await runtime.close();
      expect(runtime.child.exitCode !== null || runtime.child.signalCode !== null).toBe(true);
      const restarted = spawn();
      await restarted.ready();
      expect(restarted.child.pid).not.toBe(oldPid);
      const fresh = await restarted.connect(token);
      expect(await read(fresh, 'get_element_details', { element_name: f.name, element_type: 'memories' }))
        .toContain('Acknowledged signed AQL write');
      expect(await f.snapshot()).toEqual(winner);
      expect((await restarted.rpc('stats')).result.rootMemoryResolutions).toBe(0);
    }), 180000);
});
