/** Real commits and RLS run only in independently owned databases on required CI. */
import { describe, expect, it } from '@jest/globals';
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { MEMORY_CONSTANTS } from '../../../src/elements/memories/constants.js';
import { DatabaseMemoryEquivalentReconciler, type MemoryEquivalentProposal } from '../../../src/storage/DatabaseMemoryEquivalentReconciler.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const requiredDescribe = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
async function isolated(body: (fixture: EquivalentFixture) => Promise<void>): Promise<void> {
  const fixture = await makeEquivalentFixture();
  let failure: { cause: unknown } | undefined;
  try { await body(fixture); } catch (cause) { failure = { cause }; }
  try { await fixture.cleanup(); }
  catch (cause) {
    if (failure) throw new AggregateError([failure.cause, cause], 'Test assertion and owned cleanup failed');
    throw cause;
  }
  if (failure) throw failure.cause;
}
function executor(f: EquivalentFixture, maintenance = f.maintenance, userId = f.userId) {
  return new DatabaseMemoryEquivalentReconciler(f.db, () => userId, maintenance, f.roleName);
}
async function prepared(f: EquivalentFixture, reconciler = executor(f)): Promise<MemoryEquivalentProposal> {
  const before = await f.snapshot();
  const result = await reconciler.prepareEquivalent({ userId: f.userId, memoryId: f.memoryId });
  expect(result.inspection).toMatchObject({ status: 'equivalent', canApply: false, dirty: true });
  expect(result.proposal).not.toBeNull();
  expect(await f.snapshot()).toEqual(before);
  if (!result.proposal) throw new Error('Real writer fixture did not produce an equivalent proposal');
  return result.proposal;
}
// Only raw execute statements are intercepted; structured Drizzle reads retain the real PendingQuery.values() interface.
type QueryParameters = NonNullable<Parameters<Sql['unsafe']>[1]>;
function intercepted(connection: Sql, matches: (statement: string) => boolean, intercept: (client: Sql, statement: string, parameters: QueryParameters) => Promise<unknown>): Sql {
  return new Proxy(connection, { get(target, property, receiver) {
    if (property === 'begin') return (options: string, callback: (client: unknown) => Promise<unknown>) =>
      target.begin(options, async reserved => callback(new Proxy(reserved, { get(client, key, innerReceiver) {
        if (key === 'unsafe') return (statement: string, parameters: QueryParameters) =>
          matches(statement) ? intercept(client as unknown as Sql, statement, parameters) : client.unsafe(statement, parameters);
        return Reflect.get(client, key, innerReceiver);
      } })));
    return Reflect.get(target, property, receiver);
  } });
}

requiredDescribe('owned CI database equivalent reconciliation', () => {
  it('commits only dirty qualification with one revision step and exact content, timestamps and children preserved', () => isolated(async f => {
    const reconciler = executor(f);
    const proposal = await prepared(f, reconciler);
    const before = await f.snapshot();
    const result = await reconciler.qualifyEquivalent(proposal, f.request());
    expect(result).toEqual({ status: 'qualified', token: { backend: 'database', userId: f.userId, ownerId: f.memoryId,
      locator: f.memoryId, name: f.name, revision: (BigInt(proposal.revision) + 1n).toString() } });
    const after = await f.snapshot();
    expect(after.dirty).toBe(false);
    expect(BigInt(after.revision)).toBe(BigInt(before.revision) + 1n);
    expect(after.content).toBe(before.content);
    expect(after.entries).toBe(before.entries);
    expect(after.tags).toBe(before.tags);
    expect(after.volumes).toBe(before.volumes);
    // A separate connection observes the actual committed row, not the transaction candidate.
    const [committed] = await f.competitor`SELECT storage_revision::text AS revision,memory_entries_out_of_sync AS dirty
      FROM public.elements WHERE id=${f.memoryId}::uuid`;
    expect(committed).toEqual({ revision: after.revision, dirty: false });
  }));

  it('a fresh clean equivalent proposal performs zero parent updates', () => isolated(async f => {
    const reconciler = executor(f);
    await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
    const result = await reconciler.prepareEquivalent({ userId: f.userId, memoryId: f.memoryId });
    expect(result.inspection.status).toBe('equivalent');
    expect(result.proposal?.dirty).toBe(false);
    if (!result.proposal) throw new Error('Expected clean equivalent proposal');
    const before = await f.snapshot();
    expect(await reconciler.qualifyEquivalent(result.proposal, f.request())).toMatchObject({ status: 'already-qualified' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('refuses a real intervening child mutation instead of replaying old raw content', () => isolated(async f => {
    const proposal = await prepared(f);
    await f.layer.addEntry(f.memoryId, { entryId: 'newer', timestamp: new Date('2026-09-28T13:00:00Z'), content: 'Accepted newer child' });
    const before = await f.snapshot();
    expect(await executor(f).qualifyEquivalent(proposal, f.request())).toMatchObject({ status: 'refused' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('refuses a stale complete projection even if raw and child equivalence remains intact', () => isolated(async f => {
    const proposal = await prepared(f);
    await f.maintenance`UPDATE public.elements SET updated_at=updated_at+interval '1 microsecond' WHERE id=${f.memoryId}::uuid`;
    const fresh = await executor(f).prepareEquivalent({ userId: f.userId, memoryId: f.memoryId });
    expect(fresh.inspection).toMatchObject({ status: 'equivalent', dirty: true });
    expect(fresh.proposal).not.toBeNull();
    expect(fresh.proposal?.projectionSha256).not.toBe(proposal.projectionSha256);
    expect(fresh.proposal?.revision).not.toBe(proposal.revision);
    const before = await f.snapshot();
    expect(await executor(f).qualifyEquivalent(proposal, f.request())).toEqual({ status: 'refused', reason: 'stale' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('ordinary RLS hides the selected private owner from another authenticated tenant', () => isolated(async f => {
    const rows = await f.ordinary.begin(async tx => {
      await tx`SELECT pg_catalog.set_config('app.current_user_id',${f.foreignUserId},true)`;
      return tx`SELECT id FROM public.elements WHERE id=${f.memoryId}::uuid`;
    });
    expect(rows).toHaveLength(0);
    const proposal = await prepared(f);
    const before = await f.snapshot();
    expect(await executor(f, f.maintenance, f.foreignUserId).qualifyEquivalent(proposal, f.request()))
      .toEqual({ status: 'refused', reason: 'owner-mismatch' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('refuses current database binding mismatch without changing any selected bytes', () => isolated(async f => {
    const proposal = await prepared(f);
    const before = await f.snapshot();
    expect(await executor(f).qualifyEquivalent(proposal, { ...f.request(), databaseOid: '4294967295' }))
      .toEqual({ status: 'refused', reason: 'context' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('privileged archive absence sees a foreign-owner volume hidden by ordinary RLS', () => isolated(async f => {
    const proposal = await prepared(f);
    // Deliberate legacy malformed ownership; disable the composite FK's internal
    // triggers only in this disposable database, then restore all before apply.
    await f.maintenance`ALTER TABLE public.memory_volumes DISABLE TRIGGER ALL`;
    try {
      await f.maintenance`INSERT INTO public.memory_volumes(user_id,memory_id,volume,raw_content,sha256,entry_count,sealed_at)
        VALUES(${f.foreignUserId}::uuid,${f.memoryId}::uuid,1,'foreign archive',${'c'.repeat(64)},0,now())`;
    } finally { await f.maintenance`ALTER TABLE public.memory_volumes ENABLE TRIGGER ALL`; }
    const before = await f.snapshot();
    expect(await executor(f).qualifyEquivalent(proposal, f.request())).toEqual({ status: 'refused', reason: 'archive-bearing' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('selected global tag proof refuses a legacy cross-owner reference without rewriting it', () => isolated(async f => {
    const proposal = await prepared(f);
    await f.maintenance`ALTER TABLE public.element_tags DISABLE TRIGGER USER`;
    try {
      await f.maintenance`INSERT INTO public.element_tags(element_id,user_id,tag)
        VALUES(${f.memoryId}::uuid,${f.foreignUserId}::uuid,'legacy foreign tag')`;
    } finally { await f.maintenance`ALTER TABLE public.element_tags ENABLE TRIGGER USER`; }
    const before = await f.snapshot();
    expect(await executor(f).qualifyEquivalent(proposal, f.request())).toMatchObject({ status: 'refused' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('privileged selected-child proof refuses a hidden legacy foreign child despite ordinary equivalence', () => isolated(async f => {
    await f.maintenance`ALTER TABLE public.memory_entries DISABLE TRIGGER USER`;
    try {
      await f.maintenance`INSERT INTO public.memory_entries(user_id,memory_id,entry_id,timestamp,content)
        VALUES(${f.foreignUserId}::uuid,${f.memoryId}::uuid,'hidden-foreign','2026-09-28T14:00:00Z','Preserved foreign child')`;
    } finally { await f.maintenance`ALTER TABLE public.memory_entries ENABLE TRIGGER USER`; }
    // All trigger/catalog state is restored before inspection and qualification.
    const proposal = await prepared(f);
    const before = await f.snapshot();
    expect(await executor(f).qualifyEquivalent(proposal, f.request())).toMatchObject({ status: 'refused' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('the held archive relation lock prevents a real concurrent archive phantom before commit', () => isolated(async f => {
    const proposal = await prepared(f);
    let attempted = false;
    let blockedCode: unknown;
    const guarded = intercepted(f.maintenance, statement => statement.includes('SELECT EXISTS(SELECT 1 FROM public.memory_volumes'), async (client, statement, parameters) => {
      const rows = await client.unsafe(statement, parameters);
      if (statement.includes('SELECT EXISTS(SELECT 1 FROM public.memory_volumes') && !attempted) {
        attempted = true;
        try {
          await f.competitor.begin(async tx => {
            await tx`SET LOCAL lock_timeout='100ms'`;
            await tx`INSERT INTO public.memory_volumes(user_id,memory_id,volume,raw_content,sha256,entry_count,sealed_at)
              VALUES(${f.userId}::uuid,${f.memoryId}::uuid,1,'concurrent archive',${'d'.repeat(64)},0,now())`;
          });
        } catch (cause) { blockedCode = (cause as { code?: string }).code; }
      }
      return rows;
    });
    expect(await executor(f, guarded).qualifyEquivalent(proposal, f.request())).toMatchObject({ status: 'qualified' });
    expect(attempted).toBe(true);
    expect(blockedCode).toBe('55P03');
    const [count] = await f.maintenance`SELECT count(*)::integer AS n FROM public.memory_volumes WHERE memory_id=${f.memoryId}::uuid`;
    expect(count.n).toBe(0);
  }));

  it('actual SQL failure after the dirty update is an acknowledged refusal and rolls back all selected bytes', () => isolated(async f => {
    const proposal = await prepared(f);
    const before = await f.snapshot();
    let updated = false;
    let injectedCode: unknown;
    const failing = intercepted(f.maintenance, statement => statement.startsWith('UPDATE public.elements SET memory_entries_out_of_sync=false'), async (client, statement, parameters) => {
      const rows = await client.unsafe(statement, parameters);
      if (statement.startsWith('UPDATE public.elements SET memory_entries_out_of_sync=false')) {
        updated = true;
        try { await client.unsafe('SELECT 1/0'); }
        catch (cause) { injectedCode = (cause as { code?: string }).code; throw cause; }
      }
      return rows;
    });
    const reconciler = executor(f, failing);
    const request = f.request();
    expect(await reconciler.qualifyEquivalent(proposal, request)).toEqual({ status: 'refused', reason: 'query' });
    expect(updated).toBe(true);
    expect(injectedCode).toBe('22012');
    expect(await f.snapshot()).toEqual(before);
  }));

  it('qualifies more than 1,000 distinct-time entries and legacy-size raw YAML without rewriting content', () => isolated(async f => {
    const entries = Array.from({ length: 1001 }, (_, i) => [
      `  - id: "entry-${i}"`, `    content: "Preserved ${i}"`,
      `    timestamp: "${new Date(Date.UTC(2026, 8, 28) - i * 1000).toISOString()}"`,
    ].join('\n')).join('\n');
    const normal = `${f.raw.split('entries:')[0]}entries:\n${entries}`;
    expect(await f.layer.writeContent('memories', f.name, normal,
      { author: 'test-author', version: '1.0.0', description: '', tags: [] })).toBe(f.memoryId);
    // Explicit legacy fixture substitution: an inert YAML comment exceeds ordinary writer size.
    const legacy = `${normal}\n#${'x'.repeat(MEMORY_CONSTANTS.MAX_YAML_SIZE + 1)}\n`;
    expect(legacy.length).toBeGreaterThan(MEMORY_CONSTANTS.MAX_YAML_SIZE);
    expect(legacy.length).toBeLessThan(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE);
    await f.maintenance`UPDATE public.elements SET raw_content=${legacy},
      content_hash=${createHash('sha256').update(legacy).digest('hex')},byte_size=${Buffer.byteLength(legacy)},
      memory_entries_out_of_sync=true WHERE id=${f.memoryId}::uuid`;
    const reconciler = executor(f);
    const result = await reconciler.prepareEquivalent({ userId: f.userId, memoryId: f.memoryId });
    expect(result.inspection).toMatchObject({ status: 'equivalent', counts: { rawEntries: 1001, childEntries: 1001 } });
    if (!result.proposal) throw new Error('Expected bounded legacy equivalent proposal');
    const before = await f.snapshot();
    expect(await reconciler.qualifyEquivalent(result.proposal, f.request())).toMatchObject({ status: 'qualified' });
    const after = await f.snapshot();
    expect(after.content).toBe(before.content);
    expect(after.entries).toBe(before.entries);
    expect(after.tags).toBe(before.tags);
  }));

  it.each(['ambiguous', 'over-limit'])('refuses actual %s selected raw without writing', kind => isolated(async f => {
    const proposal = await prepared(f);
    const raw = kind === 'ambiguous' ? `name: ${f.name}\nmetadata:\n  name: other\nentries: []\n`
      : `#${'x'.repeat(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE + 1)}\n`;
    await f.maintenance`UPDATE public.elements SET raw_content=${raw},
      content_hash=${createHash('sha256').update(raw).digest('hex')},byte_size=${Buffer.byteLength(raw)} WHERE id=${f.memoryId}::uuid`;
    const before = await f.snapshot();
    const reconciler = executor(f);
    const diagnostic = await reconciler.prepareEquivalent({ userId: f.userId, memoryId: f.memoryId });
    expect(diagnostic.proposal).toBeNull();
    expect(diagnostic.inspection.status).toBe(kind === 'ambiguous' ? 'ambiguous' : 'ineligible');
    expect(diagnostic.inspection.diagnostics).toContainEqual(kind === 'ambiguous'
      ? { code: 'mixed_metadata_sources', path: 'metadata' } : { code: 'legacy_size_limit', path: 'rawContent' });
    expect(await reconciler.qualifyEquivalent(proposal, f.request())).toMatchObject({ status: 'refused' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it.each([
    ['9007199254740992', '9007199254740993'],
    ['9.00000000000000000001', '9'],
    ['0.1', '0.10000000000000000001'],
  ])('refuses original numeric precision mismatch raw %s versus JSONB %s', (rawNumber, storedNumber) => isolated(async f => {
    const proposal = await prepared(f);
    const raw = `${f.raw}\n    metadata:\n      amount: ${rawNumber}\n`;
    await f.maintenance`UPDATE public.elements SET raw_content=${raw},
      content_hash=${createHash('sha256').update(raw).digest('hex')},byte_size=${Buffer.byteLength(raw)} WHERE id=${f.memoryId}::uuid`;
    await f.maintenance`UPDATE public.memory_entries SET entry_metadata=${`{"amount":${storedNumber}}`}::jsonb
      WHERE memory_id=${f.memoryId}::uuid AND user_id=${f.userId}::uuid AND entry_id='one'`;
    const [persisted] = await f.maintenance`SELECT
      (SELECT raw_content FROM public.elements WHERE id=${f.memoryId}::uuid) AS raw,
      (SELECT entry_metadata::text FROM public.memory_entries WHERE memory_id=${f.memoryId}::uuid AND entry_id='one') AS metadata`;
    expect(persisted.raw).toBe(raw);
    expect(persisted.metadata).toBe(`{"amount": ${storedNumber}}`);
    const before = await f.snapshot();
    const reconciler = executor(f);
    const diagnostic = await reconciler.prepareEquivalent({ userId: f.userId, memoryId: f.memoryId });
    expect(diagnostic.proposal).toBeNull();
    expect(diagnostic.inspection).toMatchObject({ status: 'ineligible',
      diagnostics: [{ code: 'unrepresentable_numeric_precision', path: 'projection' }] });
    expect(await reconciler.qualifyEquivalent(proposal, f.request())).toEqual({ status: 'refused', reason: 'ineligible' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('fresh refresh cannot clear poison while an older real transaction still holds its exclusion locks', () => isolated(async f => {
    const proposal = await prepared(f);
    let release!: () => void;
    const commitGate = new Promise<void>(resolve => { release = resolve; });
    let bodyFinished!: () => void;
    const bodyGate = new Promise<void>(resolve => { bodyFinished = resolve; });
    let actualBegin: Promise<unknown> | undefined;
    const early = new Proxy(f.maintenance, { get(target, property, receiver) {
      if (property === 'begin') return async (options: string, callback: Parameters<Sql['begin']>[1]) => {
        actualBegin = Promise.resolve(target.begin(options, async reserved => {
          const candidate = await callback(reserved);
          bodyFinished();
          await commitGate;
          return candidate;
        }));
        // Observe eventual failure immediately; keep the original promise for exact draining.
        void actualBegin.catch(() => undefined);
        await Promise.race([bodyGate, actualBegin.then(() => { throw new Error('Actual transaction finished before held-lock checkpoint'); })]);
        throw new Error('Test-only early outer driver settlement while server transaction remains open');
      };
      return Reflect.get(target, property, receiver);
    } });
    const reconciler = executor(f, early);
    const request = f.request();
    let actualLockFailure: unknown;
    const freshBarrier = intercepted(f.competitor, statement => statement.startsWith('LOCK TABLE '), async (client, statement, parameters) => {
      try { return await client.unsafe(statement, parameters); }
      catch (cause) {
        if ((cause as { code?: string }).code === '55P03') actualLockFailure = cause;
        throw cause;
      }
    });
    try {
      expect(await reconciler.qualifyEquivalent(proposal, request)).toEqual({ status: 'unknown', attemptId: request.runId });
      await expect(reconciler.refreshUnknown(freshBarrier)).rejects.toMatchObject({ reason: 'query' });
      // Capture the real server error before the established abort sentinel strips its cause.
      expect(actualLockFailure).toMatchObject({ code: '55P03' });
      expect(await reconciler.qualifyEquivalent(proposal, f.request())).toEqual({ status: 'unknown', attemptId: request.runId });
      release();
      await actualBegin;
      const refresh = await reconciler.refreshUnknown(f.competitor);
      expect(refresh).toMatchObject({ status: 'equivalent', dirty: false, canApply: false });
      expect(refresh).not.toHaveProperty('token');
    } finally {
      release();
      if (actualBegin) await actualBegin;
    }
  }));

  it('loss after real COMMIT never publishes the candidate token or treats refresh as a historical receipt', () => isolated(async f => {
    const proposal = await prepared(f);
    const lost = new Proxy(f.maintenance, { get(target, property, receiver) {
      if (property === 'begin') return async (options: string, callback: Parameters<Sql['begin']>[1]) => {
        await target.begin(options, callback);
        throw new Error('Test-only publication loss after acknowledged real COMMIT');
      };
      return Reflect.get(target, property, receiver);
    } });
    const reconciler = executor(f, lost);
    const request = f.request();
    expect(await reconciler.qualifyEquivalent(proposal, request)).toEqual({ status: 'unknown', attemptId: request.runId });
    expect((await f.snapshot()).dirty).toBe(false);
    expect(await reconciler.qualifyEquivalent(proposal, f.request())).toEqual({ status: 'unknown', attemptId: request.runId });
    const refresh = await reconciler.refreshUnknown(f.competitor);
    expect(refresh).toMatchObject({ status: 'equivalent', dirty: false, canApply: false });
    expect(refresh).not.toHaveProperty('token');
    // This is an acknowledged-commit publication fault, not a network COMMIT fault.
  }));
});
