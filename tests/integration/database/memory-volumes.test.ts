import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';

import { elements } from '../../../src/database/schema/elements.js';
import { memoryVolumes } from '../../../src/database/schema/memoryVolumes.js';
import { getErrorCode } from '../../../src/database/db-utils.js';
import { withUserContext } from '../../../src/database/rls.js';
import { purgeUserScopedData } from '../../../src/database/userDataPurge.js';
import { DatabaseMemoryVolumeStore, MAX_MEMORY_VOLUME_NUMBER } from '../../../src/storage/DatabaseMemoryVolumeStore.js';
import {
  closeTestDb, ensureTestUser, ensureTestUserB, fixedUserId, getTestAdminDb, getTestDb,
} from './test-db-helpers.js';

const content = 'metadata:\n  name: sealed\nentries: []\n';
const sealedAt = new Date('2026-09-28T12:00:00Z');
const input = { minimumVolume: 1, rawContent: content, entryCount: 0, sealedAt };
const describePg = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
let userA: string;
let userB: string;
let memoryId: string;
let otherMemoryId: string;
let agentId: string;
const storeFor = (userId: string) => new DatabaseMemoryVolumeStore(getTestDb(), fixedUserId(userId));

async function rejectionCode(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
  } catch (error) {
    return getErrorCode(error);
  }
  throw new Error('Expected the database operation to fail');
}

async function parent(userId: string, elementType: string): Promise<string> {
  const rows = await withUserContext(getTestDb(), userId, (tx) => tx.insert(elements).values({
    userId,
    rawContent: content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    byteSize: Buffer.byteLength(content),
    elementType,
    name: `${elementType}-${randomUUID()}`,
    visibility: 'public',
  }).returning({ id: elements.id }));
  return rows[0].id;
}

beforeAll(async () => {
  userA = await ensureTestUser();
  userB = await ensureTestUserB();
});

beforeEach(async () => {
  memoryId = await parent(userA, 'memories');
  otherMemoryId = await parent(userB, 'memories');
  agentId = await parent(userA, 'agents');
});

afterEach(async () => {
  for (const userId of [userA, userB]) {
    await withUserContext(getTestDb(), userId, (tx) => tx.delete(elements).where(eq(elements.userId, userId)));
  }
});

afterAll(async () => {
  await closeTestDb();
});

describePg('immutable PostgreSQL memory volumes', () => {
  it('creates, verifies and lists owner-scoped archives, including unindexed orphans', async () => {
    const store = storeFor(userA);
    const owner = { userId: userA, memoryId };
    const first = await store.createExclusive(owner, input);
    expect(first.volume).toBe(1);
    expect(first.file).toBe(`volumes/${memoryId}/v0001.yaml`);
    expect(first.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect((await store.read(owner, 1))?.rawContent).toBe(content);
    expect((await store.list(owner)).map(row => row.id)).toEqual([first.id]);
    expect((await store.list(owner))[0]).not.toHaveProperty('rawContent');

    // No live-head index exists in this slice; listing must still find the row.
    const second = await store.createExclusive(owner, input);
    expect(second.volume).toBe(2);
    expect((await store.list(owner)).map(row => row.volume)).toEqual([1, 2]);
    expect(await store.removeCreated({ ...first, id: second.id })).toBe(false);
    expect(await store.removeCreated(first)).toBe(true);
    expect(await store.removeCreated(first)).toBe(false);
    expect((await store.list(owner)).map(row => row.id)).toEqual([second.id]);
    // A stale receipt must not remove a new row reusing the same number.
    expect(await store.removeCreated(second)).toBe(true);
    const replacement = await store.createExclusive(owner, input);
    expect(replacement.volume).toBe(1);
    expect(await store.removeCreated(first)).toBe(false);
    expect((await store.list(owner)).map(row => row.id)).toEqual([replacement.id]);
    expect(await store.deleteAll(owner)).toBe(1);
    expect(await store.list(owner)).toEqual([]);
  });

  it('binds archives to the parent user and memory type even when the parent is public', async () => {
    const store = storeFor(userA);
    const otherStore = storeFor(userB);
    const owner = { userId: userA, memoryId };
    await store.createExclusive(owner, input);
    await expect(otherStore.read(owner, 1)).rejects.toThrow(/active user/);
    expect(await otherStore.read({ userId: userB, memoryId }, 1)).toBeNull();
    expect(await otherStore.list({ userId: userB, memoryId })).toEqual([]);
    expect(await otherStore.deleteAll({ userId: userB, memoryId })).toBe(0);
    expect(await rejectionCode(otherStore.createExclusive({ userId: userB, memoryId }, input))).toBe('23503');
    expect(await rejectionCode(store.createExclusive({ userId: userA, memoryId: agentId }, input))).toBe('23503');
    expect((await store.list(owner))).toHaveLength(1);

    const other = await otherStore.createExclusive({ userId: userB, memoryId: otherMemoryId }, input);
    expect(other.userId).toBe(userB);
    expect((await store.list(owner))).toHaveLength(1);
  });

  it('denies unscoped access and in-place updates while preserving sealed bytes', async () => {
    const store = storeFor(userA);
    const owner = { userId: userA, memoryId };
    const archive = await store.createExclusive(owner, input);
    const unscoped = await getTestDb().select({ id: memoryVolumes.id }).from(memoryVolumes);
    expect(unscoped).toEqual([]);

    let updateError: unknown;
    let updatedRows = 0;
    try {
      const rows = await withUserContext(getTestDb(), userA, (tx) => tx.update(memoryVolumes)
        .set({ rawContent: 'replaced' })
        .where(eq(memoryVolumes.id, archive.id))
        .returning({ id: memoryVolumes.id }));
      updatedRows = rows.length;
    } catch (error) {
      updateError = error;
    }
    expect(updatedRows).toBe(0);
    if (updateError) expect(getErrorCode(updateError)).toBe('42501');
    expect((await store.read(owner, 1))?.rawContent).toBe(content);

    // Even an operator-side corruption is detected before archive bytes are returned.
    await getTestAdminDb().update(memoryVolumes).set({ rawContent: 'tampered' })
      .where(eq(memoryVolumes.id, archive.id));
    await expect(store.read(owner, 1)).rejects.toThrow(/SHA-256 verification/);
  });

  it('checks YAML entry count before insert and holds a captured owner across awaits', async () => {
    const owner = { userId: userA, memoryId };
    const store = storeFor(userA);
    await expect(store.createExclusive(owner, { ...input, entryCount: 1 })).rejects.toThrow(/holds 0 entries/);
    expect(await store.list(owner)).toEqual([]);
    const captured = store.createExclusive(owner, input);
    owner.userId = userB;
    owner.memoryId = otherMemoryId;
    const row = await captured;
    expect(row.userId).toBe(userA);
    expect(row.memoryId).toBe(memoryId);
  });

  it('preserves valid entry timestamp bounds and rejects a reversed range', async () => {
    const store = storeFor(userA);
    const owner = { userId: userA, memoryId };
    const firstEntryAt = new Date('2026-09-01T00:00:00Z');
    const lastEntryAt = new Date('2026-09-02T00:00:00Z');
    await expect(store.createExclusive(owner, { ...input, firstEntryAt: lastEntryAt, lastEntryAt: firstEntryAt }))
      .rejects.toThrow(/first entry timestamp is after/);
    expect(await store.list(owner)).toEqual([]);
    const archive = await store.createExclusive(owner, { ...input, firstEntryAt, lastEntryAt });
    expect(archive.firstEntryAt).toEqual(firstEntryAt);
    expect(archive.lastEntryAt).toEqual(lastEntryAt);
  });

  it('rejects unsafe numbers and stops at the safe boundary on a collision', async () => {
    const store = storeFor(userA);
    const owner = { userId: userA, memoryId };
    await expect(store.createExclusive(owner, { ...input, minimumVolume: MAX_MEMORY_VOLUME_NUMBER + 1 }))
      .rejects.toThrow(/positive safe integer/);
    const last = await store.createExclusive(owner, { ...input, minimumVolume: MAX_MEMORY_VOLUME_NUMBER });
    expect(last.volume).toBe(MAX_MEMORY_VOLUME_NUMBER);
    await expect(store.createExclusive(owner, { ...input, minimumVolume: MAX_MEMORY_VOLUME_NUMBER }))
      .rejects.toThrow(/exhausted/);
  });

  it('cascades indexed and orphan archives with their durable parent and account purge', async () => {
    const store = storeFor(userA);
    const otherStore = storeFor(userB);
    const owner = { userId: userA, memoryId };
    await store.createExclusive(owner, input);
    await store.createExclusive(owner, input);
    await withUserContext(getTestDb(), userA, (tx) => tx.delete(elements).where(and(
      eq(elements.id, memoryId), eq(elements.userId, userA),
    )));
    expect(await store.list(owner)).toEqual([]);
    expect(await rejectionCode(store.createExclusive(owner, input))).toBe('23503');

    const secondOwner = { userId: userB, memoryId: otherMemoryId };
    await otherStore.createExclusive(secondOwner, input);
    await withUserContext(getTestDb(), userB, (tx) => purgeUserScopedData(tx, userB));
    expect(await otherStore.list(secondOwner)).toEqual([]);
  });

  it('serializes parent deletion against an in-flight archive insert', async () => {
    let allowCommit: (() => void) | undefined;
    let signalDeleted: (() => void) | undefined;
    const hold = new Promise<void>(resolve => { allowCommit = resolve; });
    const deleted = new Promise<void>(resolve => { signalDeleted = resolve; });
    let deletingPid = 0;
    const deletion = withUserContext(getTestDb(), userA, async (tx) => {
      const pidRows = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{ pid: number }>;
      deletingPid = pidRows[0].pid;
      await tx.delete(elements).where(eq(elements.id, memoryId));
      signalDeleted?.();
      await hold;
    });
    await deleted;
    let signalCreator: ((pid: number) => void) | undefined;
    const creatorPid = new Promise<number>(resolve => { signalCreator = resolve; });
    const creation = withUserContext(getTestDb(), userA, async (tx) => {
      const pidRows = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{ pid: number }>;
      signalCreator?.(pidRows[0].pid);
      await tx.insert(memoryVolumes).values({
        userId: userA,
        memoryId,
        volume: 1,
        rawContent: content,
        sha256: createHash('sha256').update(content).digest('hex'),
        entryCount: 0,
        sealedAt,
      });
    });
    const insertingPid = await creatorPid;
    try {
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const rows = (await getTestAdminDb().execute(sql`SELECT pg_blocking_pids(${insertingPid}) AS pids`)) as unknown as Array<{ pids: number[] }>;
        if (rows[0]?.pids.includes(deletingPid)) {
          blocked = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
    } finally {
      allowCommit?.();
    }
    await deletion;
    expect(await rejectionCode(creation)).toBe('23503');
    expect(await storeFor(userA).list({ userId: userA, memoryId })).toEqual([]);
  });
});

describePg('0055 additive migration', () => {
  it('upgrades a populated 0054-shaped schema without rewriting the live parent', async () => {
    const migrationPath = fileURLToPath(new URL('../../../src/database/migrations/0055_memory_volumes.sql', import.meta.url));
    const migration = await readFile(migrationPath, 'utf8');
    const marker = new Error('roll back isolated migration check');
    try {
      await getTestAdminDb().transaction(async (tx) => {
        await tx.execute(sql`DROP TABLE memory_volumes`);
        await tx.execute(sql`DROP INDEX idx_elements_id_user_type_unique`);
        const id = randomUUID();
        const name = `pre-0055-${id}`;
        await tx.execute(sql`INSERT INTO elements (id, user_id, raw_content, content_hash, byte_size, element_type, name)
          VALUES (${id}::uuid, ${userA}::uuid, ${content}, ${createHash('sha256').update(content).digest('hex')},
          ${Buffer.byteLength(content)}, 'memories', ${name})`);
        for (const statement of migration.replace(/--[^\n]*/g, '').split(';').map(part => part.trim()).filter(Boolean)) {
          await tx.execute(sql.raw(statement));
        }
        const rows = (await tx.execute(sql`SELECT raw_content, name FROM elements WHERE id = ${id}::uuid`)) as unknown as Array<{ raw_content: string; name: string }>;
        expect(rows).toEqual([{ raw_content: content, name }]);
        const table = (await tx.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'memory_volumes'`)) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
        expect(table).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
        throw marker;
      });
    } catch (error) {
      if (error !== marker) throw error;
    }
  });
});
