/**
 * Tests for SharedPoolInstaller — the admin-elevated write path.
 *
 * Uses mock provenance store and write strategy to test the installer's
 * decision logic independently of backend specifics.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { SharedPoolInstaller } from '../../../../src/collection/shared-pool/SharedPoolInstaller.js';
import type { SharedPoolWriteStrategy } from '../../../../src/collection/shared-pool/SharedPoolInstaller.js';
import type { IProvenanceStore } from '../../../../src/collection/shared-pool/IProvenanceStore.js';
import type {
  SharedPoolInstallRequest,
  ProvenanceRecord,
} from '../../../../src/collection/shared-pool/types.js';

function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function makeRequest(overrides?: Partial<SharedPoolInstallRequest>): SharedPoolInstallRequest {
  return {
    content: '---\nname: test-persona\n---\nContent here',
    elementType: 'personas',
    name: 'test-persona',
    origin: 'collection',
    sourceUrl: 'github://DollhouseMCP/collection/library/personas/test-persona.md',
    sourceVersion: 'v1.0.0',
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<ProvenanceRecord>): ProvenanceRecord {
  return {
    elementId: 'existing-id',
    origin: 'collection',
    sourceUrl: 'github://DollhouseMCP/collection/library/personas/test-persona.md',
    sourceVersion: 'v1.0.0',
    contentHash: 'a'.repeat(64),
    forkedFrom: null,
    installedAt: '2026-04-21T12:00:00.000Z',
    ...overrides,
  };
}

describe('SharedPoolInstaller', () => {
  let mockStore: jest.Mocked<IProvenanceStore>;
  let mockWriteStrategy: jest.Mocked<SharedPoolWriteStrategy>;
  let installer: SharedPoolInstaller;

  beforeEach(() => {
    mockStore = {
      lookup: jest.fn<IProvenanceStore['lookup']>(),
      findByElementId: jest.fn<IProvenanceStore['findByElementId']>(),
      save: jest.fn<IProvenanceStore['save']>().mockResolvedValue(undefined),
      update: jest.fn<IProvenanceStore['update']>().mockResolvedValue(undefined),
      listByOrigin: jest.fn<IProvenanceStore['listByOrigin']>(),
    };

    mockWriteStrategy = {
      writeElement: jest.fn<SharedPoolWriteStrategy['writeElement']>()
        .mockResolvedValue('new-element-id'),
    };

    installer = new SharedPoolInstaller(mockStore, mockWriteStrategy);
  });

  describe('install — new element (not_found)', () => {
    beforeEach(() => {
      mockStore.lookup.mockResolvedValue({ status: 'not_found' });
    });

    it('writes content and saves provenance', async () => {
      const request = makeRequest();
      const result = await installer.install(request);

      expect(result.action).toBe('installed');
      expect(result.elementId).toBe('new-element-id');
      expect(mockWriteStrategy.writeElement).toHaveBeenCalledWith(
        request,
        computeHash(request.content),
      );
      expect(mockStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          elementId: 'new-element-id',
          origin: 'collection',
          sourceUrl: request.sourceUrl,
          sourceVersion: request.sourceVersion,
          contentHash: computeHash(request.content),
          forkedFrom: null,
        }),
      );
    });

    it('returns provenance record in the result', async () => {
      const result = await installer.install(makeRequest());

      expect(result.action).toBe('installed');
      if (result.action === 'installed') {
        expect(result.provenance.elementId).toBe('new-element-id');
        expect(result.provenance.origin).toBe('collection');
      }
    });
  });

  describe('install — duplicate (match)', () => {
    it('skips write when identical content exists', async () => {
      const request = makeRequest();
      const hash = computeHash(request.content);
      const record = makeRecord({ contentHash: hash });

      mockStore.lookup.mockResolvedValue({ status: 'match', record });

      const result = await installer.install(request);

      expect(result.action).toBe('skipped');
      if (result.action === 'skipped') {
        expect(result.reason).toContain('already exists');
      }
      expect(mockWriteStrategy.writeElement).not.toHaveBeenCalled();
      expect(mockStore.save).not.toHaveBeenCalled();
    });
  });

  describe('install — hash mismatch (collection origin)', () => {
    it('rejects when collection content hash differs', async () => {
      const request = makeRequest({ origin: 'collection' });
      const record = makeRecord({ contentHash: 'a'.repeat(64) });

      mockStore.lookup.mockResolvedValue({
        status: 'hash_mismatch',
        record,
        actualHash: computeHash(request.content),
      });

      const result = await installer.install(request);

      expect(result.action).toBe('rejected');
      if (result.action === 'rejected') {
        expect(result.reason).toContain('hash mismatch');
      }
      expect(mockWriteStrategy.writeElement).not.toHaveBeenCalled();
    });
  });

  describe('install — hash mismatch (deployment_seed origin)', () => {
    it('updates when deployment seed content changes', async () => {
      const request = makeRequest({ origin: 'deployment_seed' });
      const oldRecord = makeRecord({
        origin: 'deployment_seed',
        contentHash: 'old-hash'.padEnd(64, '0'),
      });

      mockStore.lookup.mockResolvedValue({
        status: 'hash_mismatch',
        record: oldRecord,
        actualHash: computeHash(request.content),
      });

      const result = await installer.install(request);

      expect(result.action).toBe('installed');
      expect(mockWriteStrategy.writeElement).toHaveBeenCalled();
      expect(mockStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          contentHash: computeHash(request.content),
        }),
      );
    });
  });

  describe('install — provenance correctness', () => {
    beforeEach(() => {
      mockStore.lookup.mockResolvedValue({ status: 'not_found' });
    });

    it('passes null sourceUrl and sourceVersion through', async () => {
      const request = makeRequest({ sourceUrl: null, sourceVersion: null });
      const result = await installer.install(request);

      expect(result.action).toBe('installed');
      if (result.action === 'installed') {
        expect(result.provenance.sourceUrl).toBeNull();
        expect(result.provenance.sourceVersion).toBeNull();
      }
    });

    it('sets forkedFrom to null for non-fork origins', async () => {
      const result = await installer.install(makeRequest());

      if (result.action === 'installed') {
        expect(result.provenance.forkedFrom).toBeNull();
      }
    });

    it('sets installedAt to an ISO-8601 timestamp', async () => {
      const before = new Date().toISOString();
      const result = await installer.install(makeRequest());
      const after = new Date().toISOString();

      if (result.action === 'installed') {
        expect(result.provenance.installedAt >= before).toBe(true);
        expect(result.provenance.installedAt <= after).toBe(true);
      }
    });
  });
});
