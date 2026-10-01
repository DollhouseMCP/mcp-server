import { describe, expect, it } from '@jest/globals';
import { InMemoryIntegrationOpenApiSpecStore } from '../../../../src/web-console/stores/InMemoryIntegrationOpenApiSpecStore.js';

const input = {
  descriptorId: '00000000-0000-4000-8000-000000000002',
  spec: { openapi: '3.0.0', paths: {} },
  specHash: 'a'.repeat(64),
  createdAt: new Date('2026-09-28T00:00:00Z'),
  updatedAt: new Date('2026-09-28T00:00:00Z'),
};

describe('strict in-memory spec writes', () => {
  it('classifies a missing conditional update as a conflict', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();
    await expect(store.update(input, input.specHash)).rejects.toMatchObject({ reason: 'conflict' });
    expect(await store.findByDescriptorId(input.descriptorId)).toBeNull();
  });
  it('creates once and preserves the winning document on collision', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();
    const created = await store.create(input);
    await expect(store.create({ ...input, specHash: 'b'.repeat(64) })).rejects.toMatchObject({ reason: 'exists' });
    expect(await store.findByDescriptorId(input.descriptorId)).toEqual(created);
  });

  it('updates only an existing record and checks its expected hash', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();
    await expect(store.update(input)).rejects.toMatchObject({ reason: 'missing' });
    const created = await store.create(input);
    const changed = { ...input, specHash: 'b'.repeat(64) };
    await expect(store.update(changed, 'c'.repeat(64))).rejects.toMatchObject({ reason: 'conflict' });
    expect(await store.findByDescriptorId(input.descriptorId)).toEqual(created);
    expect(await store.update(changed, input.specHash)).toMatchObject({ id: created.id, specHash: changed.specHash });
    expect(await store.update(input)).toMatchObject({ id: created.id, specHash: input.specHash });
  });

  it('allows exactly one concurrent create', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();
    const results = await Promise.allSettled([store.create(input), store.create({ ...input, specHash: 'b'.repeat(64) })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await store.findByDescriptorId(input.descriptorId)).toMatchObject({ specHash: input.specHash });
  });

  it('never reinserts a spec deleted after lookup', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();
    await store.create(input);
    expect(await store.findByDescriptorId(input.descriptorId)).not.toBeNull();
    await store.deleteByDescriptorId(input.descriptorId);
    await expect(store.update(input)).rejects.toMatchObject({ reason: 'missing' });
    expect(await store.findByDescriptorId(input.descriptorId)).toBeNull();
  });
});
