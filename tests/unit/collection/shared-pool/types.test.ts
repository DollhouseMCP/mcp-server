/**
 * Tests for shared-pool type exports and interface contracts.
 *
 * These tests verify the module barrel exports the expected types
 * and that the data model contracts are structurally sound.
 */

import { describe, it, expect } from '@jest/globals';
import type {
  SharedPoolOrigin,
  ProvenanceRecord,
  ProvenanceLookupResult,
  SharedPoolInstallRequest,
  SharedPoolInstallResult,
  EditRedirect,
  WriteRedirect,
} from '../../../../src/collection/shared-pool/types.js';

import type { IProvenanceStore } from '../../../../src/collection/shared-pool/IProvenanceStore.js';
import type { ISharedPoolInstaller } from '../../../../src/collection/shared-pool/ISharedPoolInstaller.js';

describe('shared-pool types', () => {
  describe('SharedPoolOrigin', () => {
    it('accepts valid origin values', () => {
      const origins: SharedPoolOrigin[] = ['collection', 'deployment_seed', 'fork'];
      expect(origins).toHaveLength(3);
    });
  });

  describe('ProvenanceRecord', () => {
    it('can represent a collection-origin record', () => {
      const record: ProvenanceRecord = {
        elementId: '550e8400-e29b-41d4-a716-446655440000',
        origin: 'collection',
        sourceUrl: 'github://DollhouseMCP/collection/library/personas/code-reviewer.md',
        sourceVersion: 'v1.2.0',
        contentHash: 'a'.repeat(64),
        forkedFrom: null,
        installedAt: '2026-04-21T12:00:00Z',
      };
      expect(record.origin).toBe('collection');
      expect(record.forkedFrom).toBeNull();
    });

    it('can represent a deployment_seed record', () => {
      const record: ProvenanceRecord = {
        elementId: 'personas/company-style-guide.md',
        origin: 'deployment_seed',
        sourceUrl: 'file:///opt/dollhousemcp/shared-pool/personas/company-style-guide.md',
        sourceVersion: null,
        contentHash: 'b'.repeat(64),
        forkedFrom: null,
        installedAt: '2026-04-21T12:00:00Z',
      };
      expect(record.origin).toBe('deployment_seed');
      expect(record.sourceVersion).toBeNull();
    });

    it('can represent a fork record', () => {
      const record: ProvenanceRecord = {
        elementId: '660e8400-e29b-41d4-a716-446655440000',
        origin: 'fork',
        sourceUrl: null,
        sourceVersion: null,
        contentHash: 'c'.repeat(64),
        forkedFrom: '550e8400-e29b-41d4-a716-446655440000',
        installedAt: '2026-04-21T14:00:00Z',
      };
      expect(record.origin).toBe('fork');
      expect(record.forkedFrom).not.toBeNull();
    });
  });

  describe('ProvenanceLookupResult', () => {
    it('can represent a match result', () => {
      const result: ProvenanceLookupResult = {
        status: 'match',
        record: {
          elementId: 'test-id',
          origin: 'collection',
          sourceUrl: 'test-url',
          sourceVersion: 'v1.0',
          contentHash: 'a'.repeat(64),
          forkedFrom: null,
          installedAt: '2026-04-21T12:00:00Z',
        },
      };
      expect(result.status).toBe('match');
    });

    it('can represent a hash_mismatch result', () => {
      const result: ProvenanceLookupResult = {
        status: 'hash_mismatch',
        record: {
          elementId: 'test-id',
          origin: 'collection',
          sourceUrl: 'test-url',
          sourceVersion: 'v1.0',
          contentHash: 'a'.repeat(64),
          forkedFrom: null,
          installedAt: '2026-04-21T12:00:00Z',
        },
        actualHash: 'b'.repeat(64),
      };
      expect(result.status).toBe('hash_mismatch');
    });

    it('can represent a not_found result', () => {
      const result: ProvenanceLookupResult = { status: 'not_found' };
      expect(result.status).toBe('not_found');
    });
  });

  describe('SharedPoolInstallRequest', () => {
    it('carries all fields needed for an install', () => {
      const request: SharedPoolInstallRequest = {
        content: '---\nname: test\n---\nContent here',
        elementType: 'personas',
        name: 'test-persona',
        origin: 'collection',
        sourceUrl: 'https://example.com/test',
        sourceVersion: 'v1.0.0',
      };
      expect(request.elementType).toBe('personas');
    });
  });

  describe('SharedPoolInstallResult', () => {
    it('can represent all three action outcomes', () => {
      const installed: SharedPoolInstallResult = {
        action: 'installed',
        elementId: 'new-id',
        provenance: {
          elementId: 'new-id',
          origin: 'collection',
          sourceUrl: null,
          sourceVersion: null,
          contentHash: 'd'.repeat(64),
          forkedFrom: null,
          installedAt: new Date().toISOString(),
        },
      };
      expect(installed.action).toBe('installed');

      const skipped: SharedPoolInstallResult = {
        action: 'skipped',
        elementId: 'existing-id',
        provenance: installed.provenance,
        reason: 'Identical content already in pool',
      };
      expect(skipped.action).toBe('skipped');

      const rejected: SharedPoolInstallResult = {
        action: 'rejected',
        elementId: 'existing-id',
        provenance: installed.provenance,
        reason: 'Content hash mismatch — possible tampering',
      };
      expect(rejected.action).toBe('rejected');
    });
  });

  describe('EditRedirect', () => {
    it('carries fork target info', () => {
      const redirect: EditRedirect = {
        forkedElementId: 'fork-uuid',
        forkedPath: 'users/abc/portfolio/personas/test.md',
      };
      expect(redirect.forkedElementId).toBeTruthy();
    });
  });

  describe('WriteRedirect', () => {
    it('can indicate admin-elevated writes', () => {
      const redirect: WriteRedirect = {
        targetPath: 'shared/personas/test.md',
        adminElevated: true,
      };
      expect(redirect.adminElevated).toBe(true);
    });

    it('can indicate regular writes', () => {
      const redirect: WriteRedirect = {
        targetPath: 'users/abc/portfolio/personas/test.md',
        adminElevated: false,
      };
      expect(redirect.adminElevated).toBe(false);
    });
  });

  describe('IProvenanceStore interface contract', () => {
    it('can be implemented with all required methods', () => {
      const store: IProvenanceStore = {
        lookup: async () => ({ status: 'not_found' }),
        findByElementId: async () => null,
        save: async () => {},
        update: async () => {},
        listByOrigin: async () => [],
      };
      expect(store.lookup).toBeDefined();
      expect(store.findByElementId).toBeDefined();
      expect(store.save).toBeDefined();
      expect(store.update).toBeDefined();
      expect(store.listByOrigin).toBeDefined();
    });
  });

  describe('ISharedPoolInstaller interface contract', () => {
    it('can be implemented with the install method', () => {
      const installer: ISharedPoolInstaller = {
        install: async () => ({
          action: 'installed' as const,
          elementId: 'test',
          provenance: {
            elementId: 'test',
            origin: 'collection' as const,
            sourceUrl: null,
            sourceVersion: null,
            contentHash: 'e'.repeat(64),
            forkedFrom: null,
            installedAt: new Date().toISOString(),
          },
        }),
      };
      expect(installer.install).toBeDefined();
    });
  });
});
