/** Disposable, uniquely owned resources on the existing required CI service only. */
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '../../../../src/database/schema/index.js';
import type { DrizzleTx } from '../../../../src/database/db-utils.js';
import { DatabaseMemoryStorageLayer } from '../../../../src/storage/DatabaseMemoryStorageLayer.js';
import { observeDatabaseMemoryMaintenanceCatalog } from '../../../../src/storage/DatabaseMemoryMaintenanceCatalogVerifier.js';
import type { MemoryEquivalentMaintenanceRequest } from '../../../../src/storage/DatabaseMemoryEquivalentReconciler.js';

export async function makeEquivalentFixture() {
  if (!process.env.CI || process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE !== '1') {
    throw new Error('Equivalent mutation fixtures require the existing CI PostgreSQL service');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `memory_equivalent_${suffix}`;
  const roleName = `memory_app_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const userId = randomUUID();
  const foreignUserId = randomUUID();
  const adminUrl = process.env.DOLLHOUSE_TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('Required CI administrator connection is not configured');
  const url = new URL(adminUrl);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
  const clients: Sql[] = [];
  let databaseCreated = false;
  let roleCreated = false;
  async function cleanup(): Promise<void> {
    let failure: { cause: unknown } | undefined;
    try {
      const closing = [...clients];
      const outcomes = await Promise.allSettled(closing.map(client => client.end({ timeout: 5 })));
      clients.splice(0, clients.length, ...closing.filter((_client, i) => outcomes[i].status === 'rejected'));
      if (clients.length) throw new AggregateError(outcomes.filter(outcome => outcome.status === 'rejected')
        .map(outcome => (outcome as PromiseRejectedResult).reason), 'Owned clients did not drain; resources preserved');
      if (databaseCreated) {
        await admin`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
          WHERE datname=${databaseName} AND pid<>pg_catalog.pg_backend_pid()`;
        await admin`DROP DATABASE ${admin(databaseName)}`;
        databaseCreated = false;
      }
      if (roleCreated) {
        await admin`DROP ROLE ${admin(roleName)}`;
        roleCreated = false;
      }
    } catch (cause) { failure = { cause }; }
    try { await admin.end({ timeout: 5 }); }
    catch (cause) {
      if (failure) throw new AggregateError([failure.cause, cause], 'Owned cleanup and administrator close failed');
      throw cause;
    }
    if (failure) throw failure.cause;
  }
  try {
    // Generated identifiers and hexadecimal password only; no supplied SQL fragments.
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    roleCreated = true;
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    databaseCreated = true;
    url.pathname = `/${databaseName}`;
    const maintenance = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    const competitor = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    clients.push(maintenance, competitor);
    await migrate(drizzle(maintenance), { migrationsFolder: path.join(process.cwd(), 'src/database/migrations') });
    await maintenance`GRANT CONNECT ON DATABASE ${maintenance(databaseName)} TO ${maintenance(roleName)}`;
    await maintenance`GRANT USAGE ON SCHEMA public TO ${maintenance(roleName)}`;
    await maintenance`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${maintenance(roleName)}`;
    await maintenance`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${maintenance(roleName)}`;
    await maintenance`REVOKE INSERT,UPDATE,DELETE ON public.users FROM ${maintenance(roleName)}`;
    await maintenance`INSERT INTO public.users(id,username) VALUES
      (${userId}::uuid,${`selected-${suffix}`}),(${foreignUserId}::uuid,${`foreign-${suffix}`})`;
    const appUrl = new URL(url);
    appUrl.username = roleName;
    appUrl.password = password;
    const ordinary = postgres(appUrl.toString(), { max: 1, connect_timeout: 5 });
    clients.push(ordinary);
    const db = drizzle(ordinary, { schema });
    const layer = new DatabaseMemoryStorageLayer(db, () => userId);
    const name = 'equivalent-fixture';
    // Same canonical shape as buildMemoryContent, without importing its shared cleanup module.
    const raw = [`name: ${name}`, `description: Test memory ${name}`, 'author: test-author', 'version: 1.0.0',
      'memoryType: user', 'autoLoad: false', 'tags:', '  - test', 'entries:', '  - id: "one"',
      '    content: "Preserved entry"', '    timestamp: "2026-09-28T12:00:00.000Z"'].join('\n');
    const memoryId = await layer.writeContent('memories', name, raw,
      { author: 'test-author', version: '1.0.0', description: '', tags: [] });
    await maintenance`UPDATE public.elements SET memory_entries_out_of_sync=true WHERE id=${memoryId}::uuid`;
    const proof = await drizzle(maintenance).transaction(tx => observeDatabaseMemoryMaintenanceCatalog(tx as unknown as DrizzleTx),
      { isolationLevel: 'repeatable read', accessMode: 'read only' });
    if (proof.status !== 'verified' || !proof.descriptorSha256) throw new Error('Fixture current catalog was not verified');
    const [identity] = await maintenance`SELECT oid::text FROM pg_catalog.pg_database WHERE datname=${databaseName}`;
    const request = (): MemoryEquivalentMaintenanceRequest => ({ runId: randomUUID(), candidateCommit: 'a'.repeat(40),
      expectedCatalogSha256: proof.descriptorSha256!, maintenanceEvidenceSha256: 'b'.repeat(64),
      maintenanceEvidenceId: 'CI-owned-equivalent-fixture', declaredContextId: 'CI-disposable-database',
      databaseName, databaseOid: identity.oid });
    async function snapshot() {
      const [row] = await maintenance`SELECT
        (SELECT to_jsonb(e)::text FROM public.elements e WHERE id=${memoryId}::uuid) AS parent,
        (SELECT (to_jsonb(e)-'storage_revision'-'memory_entries_out_of_sync')::text FROM public.elements e WHERE id=${memoryId}::uuid) AS content,
        (SELECT storage_revision::text FROM public.elements WHERE id=${memoryId}::uuid) AS revision,
        (SELECT memory_entries_out_of_sync FROM public.elements WHERE id=${memoryId}::uuid) AS dirty,
        (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb)::text FROM public.memory_entries e) AS entries,
        (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY element_id,user_id,tag),'[]'::jsonb)::text FROM public.element_tags t) AS tags,
        (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY memory_id,user_id,volume),'[]'::jsonb)::text FROM public.memory_volumes v) AS volumes`;
      return row;
    }
    return { db, ordinary, maintenance, competitor, roleName, userId, foreignUserId, memoryId, name, raw,
      layer, request, snapshot, cleanup };
  } catch (cause) {
    try { await cleanup(); }
    catch (secondary) { throw new AggregateError([cause, secondary], 'Owned fixture setup and cleanup failed'); }
    throw cause;
  }
}
export type EquivalentFixture = Awaited<ReturnType<typeof makeEquivalentFixture>>;
