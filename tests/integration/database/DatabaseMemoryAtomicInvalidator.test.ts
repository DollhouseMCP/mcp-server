/** Real commits run only in a uniquely owned database on the existing CI PG service. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { observeDatabaseMemoryMaintenanceCatalog } from '../../../src/storage/DatabaseMemoryMaintenanceCatalogVerifier.js';
import { DatabaseMemoryAtomicInvalidator, type MemoryAtomicInvalidationRequest } from '../../../src/storage/DatabaseMemoryAtomicInvalidator.js';
import { TEST_DB_ADMIN_URL, TEST_DB_URL } from './test-db-helpers.js';

// Local integration commands never create resources; required CI always selects all cases.
const requiredDescribe = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
requiredDescribe('owned CI database atomic maintenance', () => {
  const databaseName = `memory_atomic_${randomUUID().replaceAll('-', '')}`;
  let admin: Sql;
  let owned: Sql;
  let fresh: Sql;
  let created = false;
  let baseline: Omit<MemoryAtomicInvalidationRequest, 'runId'>;
  const clients: Sql[] = [];
  async function cleanup(): Promise<void> {
    let primary: { cause: unknown } | undefined;
    try {
      // Close only clients created by this suite before exact-database cleanup.
      const closing = [...clients];
      const outcomes = await Promise.allSettled(closing.map(client => client.end({ timeout: 5 })));
      clients.splice(0, clients.length, ...closing.filter((_client, index) => outcomes[index].status === 'rejected'));
      if (clients.length > 0) throw new AggregateError(outcomes.filter(result => result.status === 'rejected')
        .map(result => (result as PromiseRejectedResult).reason), 'Owned CI client closure unproved; database preserved');
      if (created) {
        await admin`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
          WHERE datname=${databaseName} AND pid<>pg_catalog.pg_backend_pid()`;
        await admin`DROP DATABASE ${admin(databaseName)}`;
        created = false;
      }
    } catch (cause) { primary = { cause }; }
    try { if (admin) await admin.end({ timeout: 5 }); }
    catch (cause) {
      if (primary) throw new AggregateError([primary.cause, cause], 'Owned CI cleanup and administrator close failed');
      throw cause;
    }
    if (primary) throw primary.cause;
  }
  beforeAll(async () => {
    if (!process.env.CI || process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE !== '1') {
      throw new Error('Required owned-database suite needs the existing CI PostgreSQL harness');
    }
    const url = new URL(TEST_DB_ADMIN_URL);
    url.pathname = '/postgres';
    admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    try {
      // CREATE, never CREATE IF NOT EXISTS: collision cannot claim/drop another database.
      await admin`CREATE DATABASE ${admin(databaseName)}`;
      created = true;
      url.pathname = `/${databaseName}`;
      owned = postgres(url.toString(), { max: 1, connect_timeout: 5 });
      fresh = postgres(url.toString(), { max: 1, connect_timeout: 5 });
      clients.push(owned, fresh);
      await migrate(drizzle(owned), { migrationsFolder: path.join(process.cwd(), 'src/database/migrations') });
      const db = drizzle(owned);
      const proof = await db.transaction(tx => observeDatabaseMemoryMaintenanceCatalog(tx as unknown as DrizzleTx),
        { isolationLevel: 'repeatable read', accessMode: 'read only' });
      expect(proof.status).toBe('verified');
      const [identity] = await owned`SELECT oid::text FROM pg_catalog.pg_database WHERE datname=${databaseName}`;
      baseline = { candidateCommit: 'a'.repeat(40), expectedCatalogSha256: proof.descriptorSha256!,
        maintenanceEvidenceSha256: 'b'.repeat(64), maintenanceEvidenceId: 'CI-disposable-fixture',
        declaredContextId: 'CI-owned-database', databaseName, databaseOid: identity.oid };
    } catch (error) {
      try { await cleanup(); }
      catch (secondary) { throw new AggregateError([error, secondary], 'Owned CI setup and cleanup failed'); }
      throw error;
    }
  }, 60_000);
  afterAll(cleanup, 30_000);
  function request(): MemoryAtomicInvalidationRequest { return { ...baseline, runId: randomUUID() }; }
  type QueryParameters = NonNullable<Parameters<Sql['unsafe']>[1]>;
  function interceptedConnection(intercept: (client: Sql, statement: string, parameters: QueryParameters) => Promise<unknown>): Sql {
    return new Proxy(owned, { get(target, property, receiver) {
      if (property === 'begin') return (options: string, callback: (client: unknown) => Promise<unknown>) =>
        target.begin(options, async reserved => callback(new Proxy(reserved, { get(client, key, innerReceiver) {
          if (key === 'unsafe') return (statement: string, parameters: QueryParameters) =>
            intercept(client as unknown as Sql, statement, parameters);
          return Reflect.get(client, key, innerReceiver);
        } })));
      return Reflect.get(target, property, receiver);
    } });
  }

  it('commits an empty historical receipt and same-run replay performs zero writes', async () => {
    const executor = new DatabaseMemoryAtomicInvalidator(owned);
    const input = request();
    const first = await executor.invalidate(input);
    expect(first.status).toBe('committed');
    if (first.status !== 'committed') throw new Error('Expected actual committed receipt');
    expect(first.receipt).toMatchObject({ ownerCount: 0, tagCount: 0, canApply: false, canActivate: false });
    const replay = await executor.invalidate(input);
    expect(replay).toEqual({ status: 'replayed', receipt: first.receipt });
    const [count] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
    expect(count.n).toBe(1);
    expect(await executor.resolveRun(input, fresh)).toEqual({ status: 'replayed', receipt: first.receipt });
  });

  it('same ID with different declared binding refuses without creating a second receipt', async () => {
    const executor = new DatabaseMemoryAtomicInvalidator(owned);
    const input = request();
    expect((await executor.invalidate(input)).status).toBe('committed');
    expect(await executor.invalidate({ ...input, declaredContextId: 'different-context' }))
      .toEqual({ status: 'aborted', reason: 'conflict' });
    const [count] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
    expect(count.n).toBe(1);
  });

  it('wrong database binding refuses before receipt lookup or mutation', async () => {
    const input = { ...request(), databaseOid: '4294967295' };
    expect(await new DatabaseMemoryAtomicInvalidator(owned).invalidate(input)).toEqual({ status: 'aborted', reason: 'context' });
    const [count] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
    expect(count.n).toBe(0);
  });

  it('invalidates clean and already-dirty heads exactly once while preserving content and children', async () => {
    const tenant = randomUUID();
    const clean = randomUUID();
    const dirty = randomUUID();
    await owned`INSERT INTO public.users(id,username) VALUES(${tenant}::uuid,${`atomic-${tenant}`})`;
    for (const id of [clean, dirty]) {
      await owned`INSERT INTO public.elements(id,user_id,element_type,name,raw_content,content_hash,byte_size)
        VALUES(${id}::uuid,${tenant}::uuid,'memories',${id},'preserved-content',${'c'.repeat(64)},17)`;
    }
    await owned.begin(async seed => {
      await seed`SELECT pg_catalog.set_config('app.current_user_id',${tenant},true)`;
      await seed`INSERT INTO public.element_tags(element_id,user_id,tag) VALUES(${clean}::uuid,${tenant}::uuid,'preserved-tag')`;
      await seed`INSERT INTO public.memory_entries(user_id,memory_id,entry_id,timestamp,content)
        VALUES(${tenant}::uuid,${clean}::uuid,'preserved-entry',now(),'preserved-entry-content')`;
      await seed`INSERT INTO public.memory_volumes(user_id,memory_id,volume,raw_content,sha256,entry_count,sealed_at)
        VALUES(${tenant}::uuid,${clean}::uuid,1,'preserved-archive',${'d'.repeat(64)},0,now())`;
      await seed`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${clean}::uuid`;
    });
    const before = await owned`SELECT id::text,storage_revision::text,raw_content FROM public.elements WHERE user_id=${tenant}::uuid ORDER BY id`;
    const children = await owned`SELECT
      (SELECT jsonb_agg(to_jsonb(t)) FROM public.element_tags t) AS tags,
      (SELECT jsonb_agg(to_jsonb(e)) FROM public.memory_entries e) AS entries,
      (SELECT jsonb_agg(to_jsonb(v)) FROM public.memory_volumes v) AS volumes`;
    const executor = new DatabaseMemoryAtomicInvalidator(owned);
    const input = request();
    expect((await executor.invalidate(input)).status).toBe('committed');
    const after = await owned`SELECT id::text,storage_revision::text,raw_content,memory_entries_out_of_sync FROM public.elements WHERE user_id=${tenant}::uuid ORDER BY id`;
    expect(after).toHaveLength(2);
    after.forEach((row, index) => {
      expect(row.id).toBe(before[index].id);
      expect(BigInt(row.storage_revision)).toBe(BigInt(before[index].storage_revision) + 1n);
      expect(row.raw_content).toBe(before[index].raw_content);
      expect(row.memory_entries_out_of_sync).toBe(true);
    });
    expect(await owned`SELECT
      (SELECT jsonb_agg(to_jsonb(t)) FROM public.element_tags t) AS tags,
      (SELECT jsonb_agg(to_jsonb(e)) FROM public.memory_entries e) AS entries,
      (SELECT jsonb_agg(to_jsonb(v)) FROM public.memory_volumes v) AS volumes`).toEqual(children);
    expect((await executor.invalidate(input)).status).toBe('replayed');
    expect(await owned`SELECT id::text,storage_revision::text,raw_content,memory_entries_out_of_sync FROM public.elements WHERE user_id=${tenant}::uuid ORDER BY id`).toEqual(after);
  });

  it('concurrent independent operators serialize same-run replay without double revision advancement', async () => {
    const input = request();
    const before = await owned`SELECT id::text,storage_revision::text FROM public.elements WHERE element_type='memories' ORDER BY id`;
    const results = await Promise.all([new DatabaseMemoryAtomicInvalidator(owned).invalidate(input),
      new DatabaseMemoryAtomicInvalidator(fresh).invalidate(input)]);
    expect(results.map(result => result.status).sort()).toEqual(['committed', 'replayed']);
    const after = await owned`SELECT id::text,storage_revision::text FROM public.elements WHERE element_type='memories' ORDER BY id`;
    after.forEach((row, index) => expect(BigInt(row.storage_revision)).toBe(BigInt(before[index].storage_revision) + 1n));
  });

  it('different concurrent run IDs each produce one whole-set invalidation', async () => {
    const before = await owned`SELECT id::text,storage_revision::text FROM public.elements WHERE element_type='memories' ORDER BY id`;
    const results = await Promise.all([new DatabaseMemoryAtomicInvalidator(owned).invalidate(request()),
      new DatabaseMemoryAtomicInvalidator(fresh).invalidate(request())]);
    expect(results.map(result => result.status)).toEqual(['committed', 'committed']);
    const after = await owned`SELECT id::text,storage_revision::text FROM public.elements WHERE element_type='memories' ORDER BY id`;
    after.forEach((row, index) => expect(BigInt(row.storage_revision)).toBe(BigInt(before[index].storage_revision) + 2n));
  });

  it('a real committed receipt resolves an injected lost publication acknowledgement', async () => {
    const input = request();
    const lost = new Proxy(owned, { get(target, property, receiver) {
      if (property === 'begin') return async (options: string, callback: (client: unknown) => Promise<unknown>) => {
        await target.begin(options, callback as Parameters<Sql['begin']>[1]);
        throw new Error('Test-only loss after real driver COMMIT acknowledgement');
      };
      return Reflect.get(target, property, receiver);
    } });
    const executor = new DatabaseMemoryAtomicInvalidator(lost);
    expect(await executor.invalidate(input)).toEqual({ status: 'unknown', reason: null });
    const result = await executor.resolveRun(input, fresh);
    expect(result.status).toBe('replayed');
    const [count] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
    expect(count.n).toBe(1);
    // This is publication-loss injection after real commit, not a wire/network COMMIT fault.
  });

  it.each(['private', 'public'])('global census refuses a preexisting %s cross-tenant tag while preserving all head revisions', async visibility => {
    const [head] = await owned`SELECT id,user_id FROM public.elements WHERE element_type='memories' LIMIT 1`;
    const foreign = randomUUID();
    await owned`INSERT INTO public.users(id,username) VALUES(${foreign}::uuid,${`foreign-${foreign}`})`;
    await owned`UPDATE public.elements SET visibility=${visibility} WHERE id=${head.id}::uuid`;
    const before = await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`;
    await owned`ALTER TABLE public.element_tags DISABLE TRIGGER USER`;
    try { await owned`INSERT INTO public.element_tags(element_id,user_id,tag) VALUES(${head.id}::uuid,${foreign}::uuid,'legacy-malformed')`; }
    finally { await owned`ALTER TABLE public.element_tags ENABLE TRIGGER USER`; }
    try {
      expect(await new DatabaseMemoryAtomicInvalidator(owned).invalidate(request())).toEqual({ status: 'aborted', reason: 'unsafe-reference' });
      expect(await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`).toEqual(before);
    } finally {
      await owned`ALTER TABLE public.element_tags DISABLE TRIGGER USER`;
      try { await owned`DELETE FROM public.element_tags WHERE element_id=${head.id}::uuid AND tag='legacy-malformed'`; }
      finally { await owned`ALTER TABLE public.element_tags ENABLE TRIGGER USER`; }
    }
  });

  it('the existing ordinary role cannot invalidate or publish a receipt without fixture grants', async () => {
    const url = new URL(TEST_DB_URL);
    url.pathname = `/${databaseName}`;
    const ordinary = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    clients.push(ordinary);
    const [role] = await ordinary`SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const input = request();
    const result = await new DatabaseMemoryAtomicInvalidator(ordinary).invalidate(input);
    expect(['aborted', 'unknown']).toContain(result.status);
    const [count] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
    expect(count.n).toBe(0);
  });

  it('actual SQL failure after head updates rolls back all changes; resolution proves absence before explicit retry', async () => {
    const before = await owned`SELECT id::text,storage_revision::text,memory_entries_out_of_sync FROM public.elements ORDER BY id`;
    let armed = true;
    const injected = interceptedConnection(async (client, statement, parameters) => {
      if (armed && statement.startsWith('INSERT INTO public.memory_head_invalidation_runs')) {
        armed = false;
        return client.unsafe('SELECT 1/0');
      }
      return client.unsafe(statement, parameters);
    });
    const executor = new DatabaseMemoryAtomicInvalidator(injected);
    const input = request();
    expect(await executor.invalidate(input)).toEqual({ status: 'unknown', reason: null });
    expect(armed).toBe(false); // fault reached only after actual UPDATE and final proof
    expect(await owned`SELECT id::text,storage_revision::text,memory_entries_out_of_sync FROM public.elements ORDER BY id`).toEqual(before);
    expect(await executor.resolveRun(input, fresh)).toEqual({ status: 'absent', reason: null });
    expect((await executor.invalidate(input)).status).toBe('committed');
  });

  it('held elements exclusion blocks a new head; a head created after unlock is outside the historical receipt', async () => {
    const [tenant] = await owned`SELECT id FROM public.users LIMIT 1`;
    const future = randomUUID();
    let release!: () => void;
    let announce!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { announce = resolve; });
    let paused = false;
    const intercepted = interceptedConnection(async (client, statement, parameters) => {
      if (!paused && statement.includes('WITH owners AS MATERIALIZED')) {
        paused = true;
        announce();
        await released;
      }
      return client.unsafe(statement, parameters);
    });
    const operation = new DatabaseMemoryAtomicInvalidator(intercepted).invalidate(request());
    try {
      await Promise.race([entered, operation.then(() => { throw new Error('Executor ended before census barrier'); })]);
      await expect(fresh.begin(async writer => {
        await writer`SET LOCAL lock_timeout='100ms'`;
        await writer`INSERT INTO public.elements(id,user_id,element_type,name,raw_content,content_hash,byte_size)
          VALUES(${future}::uuid,${tenant.id}::uuid,'memories',${future},'future',${'e'.repeat(64)},6)`;
      })).rejects.toMatchObject({ code: '55P03' });
    } finally { release(); await operation; }
    const result = await operation;
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected actual commit');
    const count = result.receipt.ownerCount;
    await fresh`INSERT INTO public.elements(id,user_id,element_type,name,raw_content,content_hash,byte_size)
      VALUES(${future}::uuid,${tenant.id}::uuid,'memories',${future},'future',${'e'.repeat(64)},6)`;
    const [now] = await owned`SELECT count(*)::integer AS n FROM public.elements WHERE element_type='memories'`;
    expect(now.n).toBe(count + 1);
    expect(result.receipt.canApply).toBe(false);
    expect(result.receipt.canActivate).toBe(false);
  });

  it('owner overflow refuses instead of committing a bounded prefix', async () => {
    const [tenant] = await owned`SELECT id FROM public.users LIMIT 1`;
    const prefix = `cap-${randomUUID()}-`;
    await owned`INSERT INTO public.elements(user_id,element_type,name,raw_content,content_hash,byte_size)
      SELECT ${tenant.id}::uuid,'memories',${prefix}||n::text,'cap',${'f'.repeat(64)},3 FROM pg_catalog.generate_series(1,10001) n`;
    try {
      const before = await owned`SELECT sum(storage_revision)::text AS revisions FROM public.elements WHERE element_type='memories'`;
      const input = request();
      expect(await new DatabaseMemoryAtomicInvalidator(owned).invalidate(input)).toEqual({ status: 'aborted', reason: 'incomplete-census' });
      expect(await owned`SELECT sum(storage_revision)::text AS revisions FROM public.elements WHERE element_type='memories'`).toEqual(before);
      const [receipt] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
      expect(receipt.n).toBe(0);
    } finally { await owned`DELETE FROM public.elements WHERE user_id=${tenant.id}::uuid AND name LIKE ${`${prefix}%`}`; }
  });

  it('tag overflow refuses without rewriting heads or publishing a prefix receipt', async () => {
    const [head] = await owned`SELECT id,user_id FROM public.elements WHERE element_type='memories' LIMIT 1`;
    const prefix = `tagcap-${randomUUID()}-`;
    const before = await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`;
    await owned`ALTER TABLE public.element_tags DISABLE TRIGGER USER`;
    try { await owned`INSERT INTO public.element_tags(element_id,user_id,tag)
      SELECT ${head.id}::uuid,${head.user_id}::uuid,${prefix}||n::text FROM pg_catalog.generate_series(1,100001) n`; }
    finally { await owned`ALTER TABLE public.element_tags ENABLE TRIGGER USER`; }
    try {
      const input = request();
      expect(await new DatabaseMemoryAtomicInvalidator(owned).invalidate(input)).toEqual({ status: 'aborted', reason: 'incomplete-census' });
      expect(await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`).toEqual(before);
      const [count] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
      expect(count.n).toBe(0);
    } finally {
      await owned`ALTER TABLE public.element_tags DISABLE TRIGGER USER`;
      try { await owned`DELETE FROM public.element_tags WHERE element_id=${head.id}::uuid AND tag LIKE ${`${prefix}%`}`; }
      finally { await owned`ALTER TABLE public.element_tags ENABLE TRIGGER USER`; }
    }
  });

  it('encoded metadata overflow refuses below owner and tag count caps', async () => {
    const [head] = await owned`SELECT id,user_id FROM public.elements WHERE element_type='memories' LIMIT 1`;
    const prefix = `bytecap-${randomUUID()}-`;
    const before = await owned`SELECT id::text,storage_revision::text,memory_entries_out_of_sync FROM public.elements ORDER BY id`;
    await owned`ALTER TABLE public.element_tags DISABLE TRIGGER USER`;
    try { await owned`INSERT INTO public.element_tags(element_id,user_id,tag)
      SELECT ${head.id}::uuid,${head.user_id}::uuid,
        ${prefix}||pg_catalog.lpad(n::text,6,'0')||pg_catalog.repeat('😀',77)
      FROM pg_catalog.generate_series(1,40000) n`; }
    finally { await owned`ALTER TABLE public.element_tags ENABLE TRIGGER USER`; }
    try {
      const [premise] = await owned`WITH owners AS MATERIALIZED (
        SELECT id,user_id,storage_revision,memory_entries_out_of_sync FROM public.elements
        WHERE element_type='memories' ORDER BY id LIMIT 10001
      ), tags AS MATERIALIZED (
        SELECT element_id,user_id,tag FROM public.element_tags
        ORDER BY element_id,tag COLLATE pg_catalog."C" LIMIT 100001
      ) SELECT (SELECT count(*)::integer FROM owners) AS owners,
        (SELECT count(*)::integer FROM tags) AS tags,
        (SELECT coalesce(sum(pg_catalog.octet_length(pg_catalog.row_to_json(owners)::text)),0) FROM owners)::text AS owner_bytes,
        (SELECT coalesce(sum(pg_catalog.octet_length(pg_catalog.row_to_json(tags)::text)),0) FROM tags)::text AS tag_bytes`;
      expect(premise.owners).toBeLessThan(10000);
      expect(premise.tags).toBeLessThan(100000);
      expect(BigInt(premise.owner_bytes) + BigInt(premise.tag_bytes)).toBeGreaterThan(16n * 1024n * 1024n);
      const input = request();
      expect(await new DatabaseMemoryAtomicInvalidator(owned).invalidate(input)).toEqual({ status: 'aborted', reason: 'incomplete-census' });
      expect(await owned`SELECT id::text,storage_revision::text,memory_entries_out_of_sync FROM public.elements ORDER BY id`).toEqual(before);
      const [receipt] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
      expect(receipt.n).toBe(0);
    } finally {
      await owned`ALTER TABLE public.element_tags DISABLE TRIGGER USER`;
      try { await owned`DELETE FROM public.element_tags WHERE element_id=${head.id}::uuid AND tag LIKE ${`${prefix}%`}`; }
      finally { await owned`ALTER TABLE public.element_tags ENABLE TRIGGER USER`; }
    }
  });

  it('revision overflow refuses before any owner update', async () => {
    const [tenant] = await owned`SELECT id FROM public.users LIMIT 1`;
    const id = randomUUID();
    await owned`INSERT INTO public.elements(id,user_id,element_type,name,raw_content,content_hash,byte_size,storage_revision)
      VALUES(${id}::uuid,${tenant.id}::uuid,'memories',${id},'max',${'f'.repeat(64)},3,9223372036854775807)`;
    try {
      const before = await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`;
      expect(await new DatabaseMemoryAtomicInvalidator(owned).invalidate(request())).toEqual({ status: 'aborted', reason: 'revision' });
      expect(await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`).toEqual(before);
    } finally { await owned`DELETE FROM public.elements WHERE id=${id}::uuid`; }
  });

  it('replica context and an elements rewrite rule refuse before matching-receipt replay', async () => {
    const executor = new DatabaseMemoryAtomicInvalidator(owned);
    const input = request();
    expect((await executor.invalidate(input)).status).toBe('committed');
    await owned`SET session_replication_role=replica`;
    try { expect(await executor.invalidate(input)).toEqual({ status: 'aborted', reason: 'context' }); }
    finally { await owned`SET session_replication_role=origin`; }
    await owned`CREATE RULE atomic_fixture_rule AS ON UPDATE TO public.elements DO ALSO SELECT 1`;
    try { expect(await executor.invalidate(input)).toEqual({ status: 'aborted', reason: 'context' }); }
    finally { await owned`DROP RULE atomic_fixture_rule ON public.elements`; }
    expect((await executor.invalidate(input)).status).toBe('replayed');
  });

  it('pins public resolution ahead of an existing temporary same-name table', async () => {
    await owned`CREATE TEMP TABLE elements(id uuid, memory_entries_out_of_sync boolean)`;
    try {
      const result = await new DatabaseMemoryAtomicInvalidator(owned).invalidate(request());
      expect(result.status).toBe('committed');
      const [temporary] = await owned`SELECT count(*)::integer AS n FROM pg_temp.elements`;
      expect(temporary.n).toBe(0);
    } finally { await owned`DROP TABLE pg_temp.elements`; }
  });

  it('ordinary deployed-style table DML privileges still refuse global visibility under FORCE RLS', async () => {
    const url = new URL(TEST_DB_URL);
    url.pathname = `/${databaseName}`;
    const ordinary = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    clients.push(ordinary);
    const [role] = await ordinary`SELECT rolname,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    await owned`GRANT SELECT,INSERT,UPDATE,DELETE ON public.elements,public.element_tags,
      public.memory_entries,public.memory_head_invalidation_runs TO ${owned(role.rolname)}`;
    try {
      const [premise] = await ordinary`SELECT
        pg_catalog.has_table_privilege(current_user,'public.elements','SELECT') AS readable,
        pg_catalog.has_table_privilege(current_user,'public.elements','UPDATE') AS writable,
        pg_catalog.row_security_active('public.elements'::regclass) AS head_rls,
        pg_catalog.row_security_active('public.memory_head_invalidation_runs'::regclass) AS receipt_rls`;
      expect(premise).toEqual({ readable: true, writable: true, head_rls: true, receipt_rls: true });
      const before = await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`;
      const input = request();
      expect(await new DatabaseMemoryAtomicInvalidator(ordinary).invalidate(input)).toEqual({ status: 'aborted', reason: 'context' });
      expect(await owned`SELECT id::text,storage_revision::text FROM public.elements ORDER BY id`).toEqual(before);
      const [count] = await owned`SELECT count(*)::integer AS n FROM public.memory_head_invalidation_runs WHERE run_id=${input.runId}::uuid`;
      expect(count.n).toBe(0);
    } finally { await owned`REVOKE SELECT,INSERT,UPDATE,DELETE ON public.elements,public.element_tags,
      public.memory_entries,public.memory_head_invalidation_runs FROM ${owned(role.rolname)}`; }
  });
});
