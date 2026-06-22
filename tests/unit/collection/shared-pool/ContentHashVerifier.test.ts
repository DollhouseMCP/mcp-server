/**
 * Tests for ContentHashVerifier — SHA-256 computation and provenance comparison.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { ContentHashVerifier } from '../../../../src/collection/shared-pool/ContentHashVerifier.js';
import type { IProvenanceStore } from '../../../../src/collection/shared-pool/IProvenanceStore.js';
import type { ProvenanceLookupResult } from '../../../../src/collection/shared-pool/types.js';

function createMockStore(lookupResult: ProvenanceLookupResult): IProvenanceStore {
  return {
    lookup: jest.fn<IProvenanceStore['lookup']>().mockResolvedValue(lookupResult),
    findByElementId: jest.fn<IProvenanceStore['findByElementId']>().mockResolvedValue(null),
    save: jest.fn<IProvenanceStore['save']>().mockResolvedValue(undefined),
    update: jest.fn<IProvenanceStore['update']>().mockResolvedValue(undefined),
    listByOrigin: jest.fn<IProvenanceStore['listByOrigin']>().mockResolvedValue([]),
  };
}

describe('ContentHashVerifier', () => {
  describe('computeHash', () => {
    it('returns a 64-character hex string', () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      const hash = verifier.computeHash('test content');

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces the correct SHA-256 for known input', () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      const expected = createHash('sha256')
        .update('hello world', 'utf-8')
        .digest('hex');

      expect(verifier.computeHash('hello world')).toBe(expected);
    });

    it('produces different hashes for different content', () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      const hash1 = verifier.computeHash('content A');
      const hash2 = verifier.computeHash('content B');

      expect(hash1).not.toBe(hash2);
    });

    it('produces identical hashes for identical content', () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      expect(verifier.computeHash('same')).toBe(verifier.computeHash('same'));
    });

    it('handles empty string', () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      const hash = verifier.computeHash('');
      expect(hash).toHaveLength(64);
    });

    it('handles unicode content', () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      const hash = verifier.computeHash('日本語テスト 🎉');
      expect(hash).toHaveLength(64);
    });
  });

  describe('verify', () => {
    it('delegates to store.lookup with computed hash', async () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      const content = 'test content';
      const expectedHash = verifier.computeHash(content);

      await verifier.verify('collection', 'https://example.com', 'v1.0', content);

      expect(store.lookup).toHaveBeenCalledWith(
        'collection',
        'https://example.com',
        'v1.0',
        expectedHash,
      );
    });

    it('returns not_found when no provenance exists', async () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      const result = await verifier.verify('collection', null, null, 'new content');

      expect(result.status).toBe('not_found');
    });

    it('returns match when hash is identical', async () => {
      const record = {
        elementId: 'test-id',
        origin: 'collection' as const,
        sourceUrl: 'https://example.com',
        sourceVersion: 'v1.0',
        contentHash: 'a'.repeat(64),
        forkedFrom: null,
        installedAt: new Date().toISOString(),
      };
      const store = createMockStore({ status: 'match', record });
      const verifier = new ContentHashVerifier(store);

      const result = await verifier.verify('collection', 'https://example.com', 'v1.0', 'content');

      expect(result.status).toBe('match');
    });

    it('returns hash_mismatch when content differs', async () => {
      const record = {
        elementId: 'test-id',
        origin: 'collection' as const,
        sourceUrl: 'https://example.com',
        sourceVersion: 'v1.0',
        contentHash: 'a'.repeat(64),
        forkedFrom: null,
        installedAt: new Date().toISOString(),
      };
      const store = createMockStore({
        status: 'hash_mismatch',
        record,
        actualHash: 'b'.repeat(64),
      });
      const verifier = new ContentHashVerifier(store);

      const result = await verifier.verify('collection', 'https://example.com', 'v1.0', 'different');

      expect(result.status).toBe('hash_mismatch');
    });

    it('passes null sourceUrl and sourceVersion through', async () => {
      const store = createMockStore({ status: 'not_found' });
      const verifier = new ContentHashVerifier(store);

      await verifier.verify('deployment_seed', null, null, 'content');

      expect(store.lookup).toHaveBeenCalledWith(
        'deployment_seed',
        null,
        null,
        expect.any(String),
      );
    });
  });
});
