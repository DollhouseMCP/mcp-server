/**
 * Tests for FileProvenanceStore — file-mode provenance CRUD.
 *
 * Uses a real temp directory for I/O — no mocks. This validates the
 * actual file format, atomic write, and read-back cycle.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileProvenanceStore } from '../../../../src/collection/shared-pool/FileProvenanceStore.js';
import type { ProvenanceRecord } from '../../../../src/collection/shared-pool/types.js';

describe('FileProvenanceStore', () => {
  let tmpDir: string;
  let store: FileProvenanceStore;

  const makeRecord = (overrides?: Partial<ProvenanceRecord>): ProvenanceRecord => ({
    elementId: 'personas/code-reviewer.md',
    origin: 'collection',
    sourceUrl: 'github://DollhouseMCP/collection/library/personas/code-reviewer.md',
    sourceVersion: 'v1.0.0',
    contentHash: 'a'.repeat(64),
    forkedFrom: null,
    installedAt: '2026-04-21T12:00:00.000Z',
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-test-'));
    store = new FileProvenanceStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('save', () => {
    it('creates a JSON manifest file with type-prefixed name', async () => {
      const record = makeRecord();
      await store.save(record);

      const filePath = path.join(tmpDir, 'personas--code-reviewer.json');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.elementId).toBe('personas/code-reviewer.md');
      expect(content.origin).toBe('collection');
      expect(content.contentHash).toBe('a'.repeat(64));
    });

    it('throws if a record for the same element already exists', async () => {
      const record = makeRecord();
      await store.save(record);

      await expect(store.save(record)).rejects.toThrow(/already exists/);
    });

    it('creates the provenance directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'nested', 'deep');
      const nestedStore = new FileProvenanceStore(nestedDir);

      await nestedStore.save(makeRecord());

      const exists = await fs.access(nestedDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('findByElementId', () => {
    it('returns the record when it exists', async () => {
      const record = makeRecord();
      await store.save(record);

      const found = await store.findByElementId('personas/code-reviewer.md');
      expect(found).not.toBeNull();
      expect(found!.origin).toBe('collection');
      expect(found!.contentHash).toBe('a'.repeat(64));
    });

    it('returns null when no record exists', async () => {
      const found = await store.findByElementId('nonexistent');
      expect(found).toBeNull();
    });

    it('returns null when directory does not exist', async () => {
      const emptyStore = new FileProvenanceStore('/tmp/nonexistent-provenance-dir-test');
      const found = await emptyStore.findByElementId('anything');
      expect(found).toBeNull();
    });
  });

  describe('lookup', () => {
    it('returns match when canonical identity and hash match', async () => {
      const record = makeRecord();
      await store.save(record);

      const result = await store.lookup(
        'collection',
        'github://DollhouseMCP/collection/library/personas/code-reviewer.md',
        'v1.0.0',
        'a'.repeat(64),
      );

      expect(result.status).toBe('match');
      if (result.status === 'match') {
        expect(result.record.elementId).toBe('personas/code-reviewer.md');
      }
    });

    it('returns hash_mismatch when identity matches but hash differs', async () => {
      const record = makeRecord();
      await store.save(record);

      const result = await store.lookup(
        'collection',
        'github://DollhouseMCP/collection/library/personas/code-reviewer.md',
        'v1.0.0',
        'b'.repeat(64),
      );

      expect(result.status).toBe('hash_mismatch');
      if (result.status === 'hash_mismatch') {
        expect(result.actualHash).toBe('b'.repeat(64));
        expect(result.record.contentHash).toBe('a'.repeat(64));
      }
    });

    it('returns not_found when no matching identity exists', async () => {
      const result = await store.lookup('collection', 'nonexistent', 'v1.0', 'a'.repeat(64));
      expect(result.status).toBe('not_found');
    });

    it('handles null sourceUrl correctly', async () => {
      const record = makeRecord({ sourceUrl: null, sourceVersion: null });
      await store.save(record);

      const result = await store.lookup('collection', null, null, 'a'.repeat(64));
      expect(result.status).toBe('match');
    });

    it('distinguishes null from non-null sourceUrl', async () => {
      const record = makeRecord({ sourceUrl: null });
      await store.save(record);

      const result = await store.lookup(
        'collection',
        'some-url',
        'v1.0.0',
        'a'.repeat(64),
      );
      expect(result.status).toBe('not_found');
    });
  });

  describe('update', () => {
    it('overwrites an existing record', async () => {
      const record = makeRecord();
      await store.save(record);

      const updated = makeRecord({ contentHash: 'c'.repeat(64) });
      await store.update(updated);

      const found = await store.findByElementId('personas/code-reviewer.md');
      expect(found!.contentHash).toBe('c'.repeat(64));
    });
  });

  describe('listByOrigin', () => {
    it('returns records matching the origin', async () => {
      await store.save(makeRecord({ elementId: 'personas/a.md', origin: 'collection' }));
      await store.save(makeRecord({ elementId: 'skills/b.md', origin: 'deployment_seed' }));
      await store.save(makeRecord({ elementId: 'personas/c.md', origin: 'collection' }));

      const collections = await store.listByOrigin('collection');
      expect(collections).toHaveLength(2);

      const seeds = await store.listByOrigin('deployment_seed');
      expect(seeds).toHaveLength(1);
    });

    it('returns empty array when no records match', async () => {
      const result = await store.listByOrigin('fork');
      expect(result).toEqual([]);
    });

    it('returns empty array when directory does not exist', async () => {
      const emptyStore = new FileProvenanceStore('/tmp/nonexistent-provenance-dir-test-2');
      const result = await emptyStore.listByOrigin('collection');
      expect(result).toEqual([]);
    });
  });

  describe('file format', () => {
    it('writes valid JSON with newline terminator', async () => {
      await store.save(makeRecord());
      const raw = await fs.readFile(path.join(tmpDir, 'personas--code-reviewer.json'), 'utf-8');

      expect(raw.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('includes element type in the file name to prevent cross-type collisions', async () => {
      await store.save(makeRecord({ elementId: 'agents/deep/nested/my-agent.yaml' }));

      const files = await fs.readdir(tmpDir);
      expect(files).toContain('agents--deep--nested--my-agent.json');
    });

    it('different types with same base name get different provenance files', async () => {
      await store.save(makeRecord({ elementId: 'personas/shared-name.md' }));
      await store.save(makeRecord({
        elementId: 'skills/shared-name.md',
        sourceUrl: 'different-source',
      }));

      const files = await fs.readdir(tmpDir);
      expect(files).toContain('personas--shared-name.json');
      expect(files).toContain('skills--shared-name.json');
    });

    it('no .tmp files are left behind after a successful write', async () => {
      await store.save(makeRecord());

      const files = await fs.readdir(tmpDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
