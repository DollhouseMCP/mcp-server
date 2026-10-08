/** Compiled cookie routes; seeded sessions and external mount evidence are fixture assertions, not login qualification. */
import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ownedAuthenticated } from './fixtures/authenticated-memory-runtime.js';
import { consoleRuntime } from './fixtures/authenticated-memory-console.js';
import { decodeMemoryCandidate } from '../../../src/storage/DatabaseMemoryCandidateEnvelope.js';
import type { MemoryUpdateCandidate } from '../../../src/storage/MemoryHeadUpdateAdapter.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
required('actual compiled guarded console cookie routes', () => {
  it('preserves authorized GET/PATCH roundtrip and restart while denying authentication, CSRF, foreign target and stale ETag', () =>
    ownedAuthenticated('console-authority', async fixture => {
      const { f, subject, foreignSubject } = fixture;
      const console = await consoleRuntime(fixture), route = `/api/v1/me/portfolio/elements/memories/${f.name}`;
      const owner = await console.forge(f.userId, subject), foreign = await console.forge(f.foreignUserId, foreignSubject);
      // Healthy production rows require console:self; absence is a genuine
      // schema refusal, not a reason to fabricate an invalid session row.
      await expect(console.forge(f.userId, subject, { capabilities: [] })).rejects.toMatchObject({
        code: '23514', constraint_name: 'console_sessions_capability_check' });
      const expired = await console.forge(f.userId, subject, { expired: true });
      const before = await f.snapshot();
      for (const [cookie, expected] of [[undefined, 401], [expired.cookie, 401], [foreign.cookie, 404]] as const) {
        const result = await fetch(`${console.base}${route}`, { headers: cookie ? { Cookie: cookie } : {} });
        expect(result.status).toBe(expected); await result.text();
        expect(await f.snapshot()).toEqual(before);
      }
      const adminDenied = await fetch(`${console.base}/api/v1/admin/accounts/users/${f.foreignUserId}`,
        { headers: { Cookie: owner.cookie } });
      // Admin authorization checks fresh elevation before capability membership.
      expect(adminDenied.status).toBe(401); expect(await adminDenied.json()).toMatchObject({ code: 'step_up_required' });
      expect(await f.snapshot()).toEqual(before);
      const get = await fetch(`${console.base}${route}`, { headers: { Cookie: owner.cookie } });
      expect(get.status).toBe(200); const etag = get.headers.get('etag')!;
      const body = await get.json() as { metadata: Record<string, unknown>; content: string };
      expect(body.content).toContain('Preserved entry'); expect(body.metadata).not.toHaveProperty('entries');
      const headers = { Cookie: owner.cookie, Origin: console.base, 'x-csrf-token': owner.csrf, 'x-console-request': '1',
        'Content-Type': 'application/json', 'If-Match': etag };
      const patch = { metadata: { ...body.metadata, description: 'Acknowledged cookie console update' }, content: body.content };
      for (const override of [{ 'x-csrf-token': '' }, { Origin: 'http://foreign.invalid' }, { Cookie: foreign.cookie, 'x-csrf-token': foreign.csrf }]) {
        const refused = await fetch(`${console.base}${route}`, { method: 'PATCH', headers: { ...headers, ...override,
          'Idempotency-Key': randomUUID() }, body: JSON.stringify(patch) });
        expect(refused.status).toBe(override.Cookie ? 404 : 403); await refused.text();
        expect(await f.snapshot()).toEqual(before);
      }
      const updated = await fetch(`${console.base}${route}`, { method: 'PATCH', headers: { ...headers,
        'Idempotency-Key': randomUUID() }, body: JSON.stringify(patch) });
      expect(updated.status).toBe(200); expect(updated.headers.get('etag')).not.toBe(etag);
      expect((await updated.json() as { content: string }).content).toContain('Preserved entry');
      const winner = await f.snapshot();
      expect(winner.parent).toContain('Acknowledged cookie console update'); expect(winner.dirty).toBe(false);
      expect(await f.maintenance`SELECT id FROM public.memory_candidate_handoffs`).toHaveLength(0);
      const stale = await fetch(`${console.base}${route}`, { method: 'PATCH', headers: { ...headers,
        'Idempotency-Key': randomUUID() }, body: JSON.stringify({ metadata: { ...body.metadata, description: 'Stale cannot overwrite' } }) });
      expect(stale.status).toBe(412); await stale.text(); expect(await f.snapshot()).toEqual(winner);
      const oldPid = console.runtime.child.pid; await console.runtime.close(); expect(console.runtime.finalClosed).toBe(true);
      const restarted = await consoleRuntime(fixture); expect(restarted.runtime.child.pid).not.toBe(oldPid);
      const fresh = await restarted.forge(f.userId, subject);
      const reloaded = await fetch(`${restarted.base}${route}`, { headers: { Cookie: fresh.cookie } });
      expect(reloaded.status).toBe(200); expect(await reloaded.text()).toContain('Acknowledged cookie console update');
      expect(await f.snapshot()).toEqual(winner);
      expect((await restarted.runtime.rpc('stats')).result.rootMemoryResolutions).toBe(0);
    }), 240000);

  it('retains the complete console loser when two authenticated cookie runtimes enter the same original owner CAS', () =>
    ownedAuthenticated('console-cas', async fixture => {
      const { f, subject } = fixture;
      const left = await consoleRuntime(fixture), right = await consoleRuntime(fixture);
      const [a, b] = await Promise.all([left.forge(f.userId, subject), right.forge(f.userId, subject)]);
      const route = `/api/v1/me/portfolio/elements/memories/${f.name}`;
      const [getA, getB] = await Promise.all([fetch(`${left.base}${route}`, { headers: { Cookie: a.cookie } }),
        fetch(`${right.base}${route}`, { headers: { Cookie: b.cookie } })]);
      expect(getA.status).toBe(200); expect(getB.status).toBe(200);
      const etag = getA.headers.get('etag')!; expect(getB.headers.get('etag')).toBe(etag);
      const [bodyA, bodyB] = await Promise.all([getA.json(), getB.json()]) as { metadata: Record<string, unknown>; content: string }[];
      const before = await f.snapshot(), lock = 390573;
      await f.competitor`SELECT pg_catalog.pg_advisory_lock(${lock})`;
      await f.maintenance.unsafe(`CREATE FUNCTION public.owned_console_cas_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id='${f.memoryId}'::uuid THEN PERFORM pg_catalog.pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`);
      await f.maintenance`CREATE TRIGGER owned_console_cas_barrier BEFORE UPDATE ON public.elements
        FOR EACH ROW EXECUTE FUNCTION public.owned_console_cas_barrier()`;
      let released = false;
      try {
        const patch = (base: string, session: typeof a, body: typeof bodyA, description: string) => fetch(`${base}${route}`, {
          method: 'PATCH', headers: { Cookie: session.cookie, Origin: base, 'x-csrf-token': session.csrf,
            'x-console-request': '1', 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ metadata: { ...body.metadata, description }, content: body.content }),
        });
        const first = patch(left.base, a, bodyA, 'Left canonical console candidate');
        const second = patch(right.base, b, bodyB, 'Right canonical console candidate');
        let prepared: { envelope: Buffer; digest: string; status: string; committed_token: unknown }[] = [];
        let ownerWait = false; const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          prepared = await f.maintenance`SELECT envelope,digest,status,committed_token FROM public.memory_candidate_handoffs`;
          const wait = await f.maintenance`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l
            JOIN pg_catalog.pg_stat_activity a USING(pid) WHERE a.datname=current_database()
            AND NOT l.granted AND l.locktype='transactionid' AND a.query ILIKE '%update%elements%') AS owner_wait`;
          ownerWait = wait[0].owner_wait; if (prepared.length === 2 && ownerWait) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(prepared).toHaveLength(2); expect(ownerWait).toBe(true);
        const candidates = prepared.map(row => decodeMemoryCandidate({ bytes: row.envelope, digest: row.digest }) as
          MemoryUpdateCandidate & { handoffEvidence: { original: { revision: string; ownerId: string; userId: string } } });
        for (const candidate of candidates) {
          expect(candidate.handoffEvidence.original).toMatchObject({ revision: before.revision, ownerId: f.memoryId, userId: f.userId });
          expect(candidate.content).toContain('Preserved entry');
        }
        expect(prepared.every(row => row.status === 'prepared' && row.committed_token === null)).toBe(true);
        await f.competitor`SELECT pg_catalog.pg_advisory_unlock(${lock})`; released = true;
        const outcomes = await Promise.all([first, second]); expect(outcomes.map(result => result.status).sort()).toEqual([200, 412]);
        const ack = outcomes.find(result => result.status === 200)!;
        expect(ack.headers.get('etag')).not.toBe(etag); expect(await ack.text()).toContain('Preserved entry');
        await outcomes.find(result => result.status === 412)!.text();
        const winner = await f.snapshot(); expect(winner.dirty).toBe(false);
        expect(BigInt(winner.revision)).toBeGreaterThan(BigInt(before.revision));
        expect(winner.parent).toContain('Preserved entry');
        expect(['Left canonical console candidate', 'Right canonical console candidate']
          .filter(content => winner.parent.includes(content))).toHaveLength(1);
        const retained = await f.maintenance`SELECT envelope,digest,status,committed_token FROM public.memory_candidate_handoffs`;
        expect(retained).toHaveLength(1); expect(retained[0].status).toBe('prepared'); expect(retained[0].committed_token).toBeNull();
        const quota = await f.maintenance`SELECT retained_rows,retained_bytes FROM public.memory_candidate_quotas WHERE user_id=${f.userId}::uuid`;
        expect(BigInt(quota[0].retained_rows)).toBe(1n); expect(BigInt(quota[0].retained_bytes)).toBe(BigInt(retained[0].envelope.length));
        const original = prepared.find(row => row.digest === retained[0].digest)!;
        expect(original).toBeDefined(); expect(retained[0].envelope).toEqual(original.envelope);
        const candidate = decodeMemoryCandidate({ bytes: original.envelope, digest: original.digest });
        expect(winner.parent.includes(candidate.content.includes('Left canonical console candidate')
          ? 'Left canonical console candidate' : 'Right canonical console candidate')).toBe(false);
      } finally { if (!released) await f.competitor`SELECT pg_catalog.pg_advisory_unlock(${lock})`; }
    }), 240000);
});
