import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PostgresIntegrationOpenApiSpecStore } from '../../../src/web-console/stores/PostgresIntegrationOpenApiSpecStore.js';
import { integrationProviderDescriptors } from '../../../src/database/schema/webConsole.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const descriptorIds: string[] = [];
beforeAll(async () => {
  if (!await isDatabaseAvailable()) throw new Error('PostgreSQL is required for strict spec write proof');
});
beforeEach(async () => {
  input.descriptorId = randomUUID();
  descriptorIds.push(input.descriptorId);
  await getTestAdminDb().insert(integrationProviderDescriptors).values({
    id: input.descriptorId, provider: `strict-${input.descriptorId}`, ownership: 'curated',
    displayName: 'Strict spec tests', category: 'test', authStrategy: 'coded', apiHosts: ['example.com'],
  });
});
afterAll(async () => {
  for (const id of descriptorIds) {
    await getTestAdminDb().delete(integrationProviderDescriptors).where(eq(integrationProviderDescriptors.id, id));
  }
  await closeTestDb();
});

const input = {
  descriptorId: '00000000-0000-4000-8000-000000000002',
  spec: { openapi: '3.0.0', paths: {} },
  specHash: 'a'.repeat(64),
  createdAt: new Date('2026-09-28T00:00:00Z'),
  updatedAt: new Date('2026-09-28T00:00:00Z'),
};

describe('strict PostgreSQL spec writes', () => {
  it('classifies a missing conditional update as a conflict', async () => {
    const store = new PostgresIntegrationOpenApiSpecStore(getTestAdminDb());
    await expect(store.update(input, input.specHash)).rejects.toMatchObject({ reason: 'conflict' });
    expect(await store.findByDescriptorId(input.descriptorId)).toBeNull();
  });
  it('creates once and preserves the winning document on collision', async () => {
    const store = new PostgresIntegrationOpenApiSpecStore(getTestAdminDb());
    const created = await store.create(input);
    await expect(store.create({ ...input, specHash: 'b'.repeat(64) })).rejects.toMatchObject({ reason: 'exists' });
    expect(await store.findByDescriptorId(input.descriptorId)).toEqual(created);
  });

  it('updates only an existing record and checks its expected hash', async () => {
    const store = new PostgresIntegrationOpenApiSpecStore(getTestAdminDb());
    await expect(store.update(input)).rejects.toMatchObject({ reason: 'missing' });
    const created = await store.create(input);
    const changed = { ...input, specHash: 'b'.repeat(64) };
    await expect(store.update(changed, 'c'.repeat(64))).rejects.toMatchObject({ reason: 'conflict' });
    expect(await store.findByDescriptorId(input.descriptorId)).toEqual(created);
    expect(await store.update(changed, input.specHash)).toMatchObject({ id: created.id, specHash: changed.specHash });
    expect(await store.update(input)).toMatchObject({ id: created.id, specHash: input.specHash });
  });

  it('allows exactly one concurrent create', async () => {
    const store = new PostgresIntegrationOpenApiSpecStore(getTestAdminDb());
    const results = await Promise.allSettled([store.create(input), store.create({ ...input, specHash: 'b'.repeat(64) })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('No create succeeded');
    expect(await store.findByDescriptorId(input.descriptorId)).toEqual(winner.value);
  });

  it('never reinserts a spec deleted after lookup', async () => {
    const store = new PostgresIntegrationOpenApiSpecStore(getTestAdminDb());
    await store.create(input);
    expect(await store.findByDescriptorId(input.descriptorId)).not.toBeNull();
    await store.deleteByDescriptorId(input.descriptorId);
    await expect(store.update(input)).rejects.toMatchObject({ reason: 'missing' });
    expect(await store.findByDescriptorId(input.descriptorId)).toBeNull();
  });
});
