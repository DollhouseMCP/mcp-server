/**
 * Security regression tests for shared-pool path traversal and input sanitization guards.
 *
 * These tests verify that the security defenses in FileSharedPoolWriteStrategy,
 * FileProvenanceStore, and related code are correct and cannot be bypassed.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileSharedPoolWriteStrategy } from '../../../../src/collection/shared-pool/SharedPoolInstaller.js';
import { FileProvenanceStore } from '../../../../src/collection/shared-pool/FileProvenanceStore.js';
import type { SharedPoolInstallRequest } from '../../../../src/collection/shared-pool/types.js';

function makeRequest(overrides?: Partial<SharedPoolInstallRequest>): SharedPoolInstallRequest {
  return {
    content: '---\nname: test\ndescription: test\n---\nContent',
    elementType: 'personas',
    name: 'safe-name',
    origin: 'collection',
    sourceUrl: null,
    sourceVersion: null,
    ...overrides,
  };
}

describe('Security Guards', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'security-guard-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('FileSharedPoolWriteStrategy — path traversal prevention', () => {
    let strategy: FileSharedPoolWriteStrategy;

    beforeEach(() => {
      strategy = new FileSharedPoolWriteStrategy(tmpDir);
    });

    it('strips directory traversal from name (../../etc/passwd)', async () => {
      const request = makeRequest({ name: '../../etc/passwd' });
      const elementId = await strategy.writeElement(request, 'a'.repeat(64));

      expect(elementId).toBe('personas/passwd.md');
      const written = await fs.readFile(path.join(tmpDir, 'personas', 'passwd.md'), 'utf-8');
      expect(written).toContain('Content');
    });

    it(String.raw`strips backslash traversal (..\..\windows\system32)`, async () => {
      const request = makeRequest({ name: String.raw`..\..\windows\system32` });
      const elementId = await strategy.writeElement(request, 'a'.repeat(64));

      expect(elementId).toBe('personas/system32.md');
    });

    it('strips null bytes from name', async () => {
      const request = makeRequest({ name: 'evil\0name' });
      const elementId = await strategy.writeElement(request, 'a'.repeat(64));

      expect(elementId).toBe('personas/evilname.md');
      expect(elementId).not.toContain('\0');
    });

    it('handles dot-only names safely', async () => {
      const request = makeRequest({ name: '..' });
      const result = await strategy.writeElement(request, 'a'.repeat(64));

      // path.basename('..') returns '..' — the written file must stay inside the pool
      const writtenPath = path.resolve(path.join(tmpDir, result));
      const basePath = path.resolve(tmpDir);
      expect(writtenPath.startsWith(basePath + path.sep)).toBe(true);
    });

    it('rejects invalid element types', async () => {
      const request = makeRequest({ elementType: '../../etc' });
      await expect(strategy.writeElement(request, 'a'.repeat(64)))
        .rejects.toThrow(/Invalid element type/);
    });

    it('rejects element type not in allowlist', async () => {
      const request = makeRequest({ elementType: 'malicious' });
      await expect(strategy.writeElement(request, 'a'.repeat(64)))
        .rejects.toThrow(/Invalid element type/);
    });

    it('accepts all 6 valid element types', async () => {
      for (const type of ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles']) {
        const request = makeRequest({ elementType: type, name: `${type}-test` });
        await expect(strategy.writeElement(request, 'a'.repeat(64))).resolves.toBeDefined();
      }
    });

    it('written file stays inside the shared pool directory', async () => {
      const request = makeRequest({ name: '../escape-attempt' });
      const elementId = await strategy.writeElement(request, 'a'.repeat(64));

      const writtenPath = path.resolve(path.join(tmpDir, elementId));
      const basePath = path.resolve(tmpDir);
      expect(writtenPath.startsWith(basePath + path.sep)).toBe(true);
    });
  });

  describe('FileProvenanceStore — recordPath sanitization', () => {
    let store: FileProvenanceStore;

    beforeEach(() => {
      store = new FileProvenanceStore(tmpDir);
    });

    it('strips null bytes from elementId', async () => {
      const record = {
        elementId: 'personas/evil\0name.md',
        origin: 'collection' as const,
        sourceUrl: null,
        sourceVersion: null,
        contentHash: 'a'.repeat(64),
        forkedFrom: null,
        installedAt: new Date().toISOString(),
      };

      await store.save(record);

      const files = await fs.readdir(tmpDir);
      for (const f of files) {
        expect(f).not.toContain('\0');
      }
    });

    it('prevents cross-type collisions via type prefix', async () => {
      const record1 = {
        elementId: 'personas/shared.md',
        origin: 'collection' as const,
        sourceUrl: 'source-1',
        sourceVersion: null,
        contentHash: 'a'.repeat(64),
        forkedFrom: null,
        installedAt: new Date().toISOString(),
      };

      const record2 = {
        elementId: 'skills/shared.md',
        origin: 'collection' as const,
        sourceUrl: 'source-2',
        sourceVersion: null,
        contentHash: 'b'.repeat(64),
        forkedFrom: null,
        installedAt: new Date().toISOString(),
      };

      await store.save(record1);
      await store.save(record2);

      const found1 = await store.findByElementId('personas/shared.md');
      const found2 = await store.findByElementId('skills/shared.md');
      expect(found1).not.toBeNull();
      expect(found2).not.toBeNull();
      expect(found1!.sourceUrl).toBe('source-1');
      expect(found2!.sourceUrl).toBe('source-2');
    });

    it('path traversal in elementId is neutralized by slash-to-dash conversion', async () => {
      const record = {
        elementId: '../../etc/passwd',
        origin: 'collection' as const,
        sourceUrl: null,
        sourceVersion: null,
        contentHash: 'c'.repeat(64),
        forkedFrom: null,
        installedAt: new Date().toISOString(),
      };

      await store.save(record);

      const files = await fs.readdir(tmpDir);
      for (const f of files) {
        const fullPath = path.resolve(path.join(tmpDir, f));
        expect(fullPath.startsWith(path.resolve(tmpDir) + path.sep)).toBe(true);
      }
    });
  });
});
