import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { DatabaseMemoryLegacyTagAuditor } from '../../../src/storage/DatabaseMemoryLegacyTagAuditor.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { users } from '../../../src/database/schema/users.js';
import { elementTags } from '../../../src/database/schema/elements.js';
import { buildMemoryContent, cleanupAllTestData, closeTestDb, ensureTestUser, ensureTestUserB,
  fixedUserId, getTestAdminDb, getTestDb } from './test-db-helpers.js';

const limits = { owners: 10000, tags: 100000, bytes: 16777216, samples: 20, statementMs: 1000, wallMs: 5000 };
let userId: string;
let otherUserId: string;
let baseline: NonNullable<Awaited<ReturnType<DatabaseMemoryLegacyTagAuditor['inspect']>>['counts']>;
let baselineOwners: string[];
const unrelatedUserId = randomUUID();
let unrelatedOwnerId: string;
beforeAll(async () => {
  userId = await ensureTestUser(); otherUserId = await ensureTestUserB();
  await getTestAdminDb().insert(users).values({ id: unrelatedUserId, username: `audit-unrelated-${unrelatedUserId}` });
  unrelatedOwnerId = await new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(unrelatedUserId)).writeContent(
    'memories', 'unrelated-retained', buildMemoryContent('unrelated-retained', []),
    { author: 'test', version: '1.0.0', description: '', tags: ['unrelated-tag'] });
});
beforeEach(async () => {
  const report = await new DatabaseMemoryLegacyTagAuditor(getTestAdminDb()).inspect(limits);
  expect(report.status).toBe('complete');
  baseline = report.counts!;
  baselineOwners = report.privateReport.owners.map(owner => owner.ownerId);
});
afterEach(async () => {
  // Remove only synthetic legacy malformed rows in this isolated test DB.
  await getTestAdminDb().transaction(async tx => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM public.element_tags WHERE user_id IN (${userId}::uuid, ${otherUserId}::uuid)`);
  });
  await cleanupAllTestData();
});
afterAll(async () => {
  try {
    const retained = await getTestAdminDb().execute(sql`SELECT id FROM public.elements WHERE id = ${unrelatedOwnerId}::uuid`);
    expect(retained).toHaveLength(1);
  } finally {
    await getTestAdminDb().execute(sql`DELETE FROM public.users WHERE id = ${unrelatedUserId}::uuid`);
    await closeTestDb();
  }
});

async function seed() {
  const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
  const metadata = { author: 'test-author', version: '1.0.0', description: '', tags: ['SENSITIVE_TAG_VALUE'] };
  const first = await layer.writeContent('memories', 'SENSITIVE_MEMORY_NAME', buildMemoryContent('SENSITIVE_MEMORY_NAME', []), metadata);
  const second = await layer.writeContent('memories', 'private-second', buildMemoryContent('private-second', []), metadata);
  await getTestAdminDb().execute(sql`UPDATE public.elements SET visibility = 'public' WHERE id = ${first}::uuid`);
  // Model legacy references without changing the deployed constraint/trigger catalog.
  await getTestAdminDb().transaction(async tx => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.insert(elementTags).values([
      { elementId: first, userId: otherUserId, tag: 'PRIVATE_FOREIGN_TAG' },
      { elementId: second, userId: otherUserId, tag: 'INVISIBLE_FOREIGN_TAG' },
      { elementId: randomUUID(), userId: otherUserId, tag: 'ORPHAN_TAG' },
    ]);
  });
  return { first, second };
}

function scopedOperator(role: 'dollhouse_app' | 'audit_bypass'): DatabaseInstance {
  return { transaction: (callback: (tx: DrizzleTx) => Promise<unknown>) => getTestAdminDb().transaction(async tx => {
    await tx.execute(role === 'dollhouse_app' ? sql`SET LOCAL ROLE dollhouse_app` : sql`SET LOCAL ROLE audit_bypass`);
    return callback(tx);
  }) } as unknown as DatabaseInstance;
}

class PausedAudit extends DatabaseMemoryLegacyTagAuditor {
  reached!: () => void;
  resume!: () => void;
  readonly atSnapshot = new Promise<void>(resolve => { this.reached = resolve; });
  private readonly resumed = new Promise<void>(resolve => { this.resume = resolve; });
  protected override async afterSnapshot(): Promise<void> { this.reached(); await this.resumed; }
}

// No availability skip: this is required isolated real-PG qualification.
describe('bounded operator memory-owner and global tag census', () => {
  it('includes private/public malformed references without exposing content or granting authority', async () => {
    const { first, second } = await seed();
    const before = await getTestAdminDb().execute(sql`SELECT id, storage_revision, memory_entries_out_of_sync FROM public.elements ORDER BY id`);
    const report = await new DatabaseMemoryLegacyTagAuditor(getTestAdminDb()).inspect(limits);
    expect(report).toMatchObject({ status: 'complete', canBackfill: false, canApply: false, canActivate: false,
      counts: { owners: baseline.owners + 2, tags: baseline.tags + 5, exact: true, orphanTags: baseline.orphanTags + 1, mismatchedPrivateMemoryTags: baseline.mismatchedPrivateMemoryTags + 1, mismatchedPublicMemoryTags: baseline.mismatchedPublicMemoryTags + 1 } });
    expect(report.privateReport.owners.map(owner => owner.ownerId)).toEqual([...baselineOwners, first, second].sort());
    expect(report.privateReport.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(report)).not.toMatch(/SENSITIVE_|PRIVATE_FOREIGN_TAG|INVISIBLE_FOREIGN_TAG|ORPHAN_TAG/u);
    expect(await getTestAdminDb().execute(sql`SELECT id, storage_revision, memory_entries_out_of_sync FROM public.elements ORDER BY id`)).toEqual(before);
  });

  it('rejects an ordinary effective role even when its session user is privileged', async () => {
    await seed();
    const report = await new DatabaseMemoryLegacyTagAuditor(scopedOperator('dollhouse_app')).inspect(limits);
    expect(report).toMatchObject({ status: 'unknown', reason: 'privilege_unproved', counts: null });
    expect(report.privateReport.manifestSha256).toBeNull();
  });

  it('does not mistake table ownership for global visibility under FORCE RLS', async () => {
    await seed();
    const owners = await getTestAdminDb().execute(sql`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('elements','element_tags') ORDER BY c.relname`);
    try {
      await getTestAdminDb().execute(sql`ALTER TABLE public.elements OWNER TO dollhouse_app`);
      await getTestAdminDb().execute(sql`ALTER TABLE public.element_tags OWNER TO dollhouse_app`);
      expect(await new DatabaseMemoryLegacyTagAuditor(scopedOperator('dollhouse_app')).inspect(limits))
        .toMatchObject({ status: 'unknown', reason: 'privilege_unproved', counts: null });
    } finally {
      for (const row of owners) {
        await getTestAdminDb().execute(sql`ALTER TABLE public.${sql.identifier(String(row.relname))} OWNER TO ${sql.identifier(String(row.owner))}`);
      }
      expect(await getTestAdminDb().execute(sql`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('elements','element_tags') ORDER BY c.relname`)).toEqual(owners);
      await getTestAdminDb().execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON public.elements, public.element_tags TO dollhouse_app`);
    }
  });

  it('proves effective BYPASSRLS visibility without requiring a superuser', async () => {
    await seed();
    await getTestAdminDb().execute(sql`CREATE ROLE audit_bypass NOLOGIN NOSUPERUSER BYPASSRLS`);
    await getTestAdminDb().execute(sql`GRANT USAGE ON SCHEMA public TO audit_bypass`);
    await getTestAdminDb().execute(sql`GRANT SELECT ON public.elements, public.element_tags TO audit_bypass`);
    try {
      expect(await new DatabaseMemoryLegacyTagAuditor(scopedOperator('audit_bypass')).inspect(limits)).toMatchObject({
        status: 'complete', counts: { tags: baseline.tags + 5, mismatchedPrivateMemoryTags: baseline.mismatchedPrivateMemoryTags + 1, mismatchedPublicMemoryTags: baseline.mismatchedPublicMemoryTags + 1 } });
    } finally {
      await getTestAdminDb().execute(sql`DROP OWNED BY audit_bypass`);
      await getTestAdminDb().execute(sql`DROP ROLE audit_bypass`);
    }
  });

  it.each([{ owners: 1 }, { tags: 4 }, { bytes: 1 }])('returns incomplete without a completed digest for cap %j', async cap => {
    await seed();
    const report = await new DatabaseMemoryLegacyTagAuditor(getTestAdminDb()).inspect({ ...limits, ...cap });
    expect(report).toMatchObject({ status: 'incomplete', counts: { exact: false } });
    expect(report.privateReport.manifestSha256).toBeNull();
  });

  it('keeps full aggregate coverage complete when only private samples truncate', async () => {
    await seed();
    const report = await new DatabaseMemoryLegacyTagAuditor(getTestAdminDb()).inspect({ ...limits, owners: baseline.owners + 2, tags: baseline.tags + 5, samples: 1 });
    expect(report).toMatchObject({ status: 'complete', samplesTruncated: true, counts: { exact: true, tags: baseline.tags + 5 } });
    expect(report.privateReport.samples).toHaveLength(1);
    expect(report.privateReport.manifestSha256).not.toBeNull();
  });

  it('uses one consistent diagnostic snapshot across concurrent accepted writes', async () => {
    const auditor = new PausedAudit(getTestAdminDb());
    const pending = auditor.inspect(limits);
    try {
      await auditor.atSnapshot;
      const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
      await layer.writeContent('memories', 'concurrent', buildMemoryContent('concurrent', []),
        { author: 'test', version: '1.0.0', description: '', tags: ['new-tag'] });
      auditor.resume();
      expect(await pending).toMatchObject({ status: 'complete', counts: { owners: baseline.owners, tags: baseline.tags } });
      expect(await new DatabaseMemoryLegacyTagAuditor(getTestAdminDb()).inspect(limits)).toMatchObject({
        status: 'complete', counts: { owners: baseline.owners + 1, tags: baseline.tags + 1 } });
    } finally { auditor.resume(); }
  });

  it('sanitizes a real read-only write refusal and leaves revisions unchanged', async () => {
    await seed();
    let currentTx!: DrizzleTx;
    const captured = { transaction: (callback: (tx: DrizzleTx) => Promise<unknown>) => getTestAdminDb().transaction(tx => {
      currentTx = tx; return callback(tx);
    }) } as unknown as DatabaseInstance;
    class WriteProbe extends DatabaseMemoryLegacyTagAuditor {
      protected override async afterSnapshot(): Promise<void> { await currentTx.execute(sql`UPDATE public.elements SET memory_entries_out_of_sync = false`); }
    }
    const before = await getTestAdminDb().execute(sql`SELECT id, storage_revision FROM public.elements ORDER BY id`);
    expect(await new WriteProbe(captured).inspect(limits)).toMatchObject({ status: 'unknown', reason: 'query_failed', counts: null });
    expect(await getTestAdminDb().execute(sql`SELECT id, storage_revision FROM public.elements ORDER BY id`)).toEqual(before);
  });

  it('refuses an unexpected RLS catalog instead of reporting clean data', async () => {
    await getTestAdminDb().execute(sql`ALTER TABLE public.element_tags NO FORCE ROW LEVEL SECURITY`);
    try {
      expect(await new DatabaseMemoryLegacyTagAuditor(getTestAdminDb()).inspect(limits))
        .toMatchObject({ status: 'unknown', reason: 'schema_unproved', counts: null });
    } finally { await getTestAdminDb().execute(sql`ALTER TABLE public.element_tags FORCE ROW LEVEL SECURITY`); }
  });

  it('returns sanitized unknown after a real statement timeout', async () => {
    let currentTx!: DrizzleTx;
    let reached = false;
    const captured = { transaction: (callback: (tx: DrizzleTx) => Promise<unknown>) => getTestAdminDb().transaction(tx => {
      currentTx = tx; return callback(tx);
    }) } as unknown as DatabaseInstance;
    class SlowProbe extends DatabaseMemoryLegacyTagAuditor {
      protected override async afterSnapshot(): Promise<void> { reached = true; await currentTx.execute(sql`SELECT pg_sleep(0.5)`); }
    }
    const report = await new SlowProbe(captured).inspect({ ...limits, statementMs: 100 });
    expect(reached).toBe(true);
    expect(report).toMatchObject({ status: 'unknown', reason: 'query_failed', counts: null });
    expect(report.privateReport.manifestSha256).toBeNull();
  });
});
