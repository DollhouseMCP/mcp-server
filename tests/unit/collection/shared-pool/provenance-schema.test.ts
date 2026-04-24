/**
 * Tests for the provenance Drizzle schema and migration artifacts.
 *
 * Validates that the schema definition, migration SQL, and snapshot
 * metadata are consistent and well-formed.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

const migrationsDir = path.resolve(
  import.meta.dirname,
  '../../../../src/database/migrations',
);

describe('provenance schema', () => {
  describe('Drizzle schema exports', () => {
    it('exports elementProvenance table from schema barrel', async () => {
      const schema = await import('../../../../src/database/schema/index.js');
      expect(schema.elementProvenance).toBeDefined();
    });

    it('elementProvenance table has expected column definitions', async () => {
      const { elementProvenance } = await import(
        '../../../../src/database/schema/provenance.js'
      );
      const columnNames = Object.keys(elementProvenance);
      // pgTable returns a table object whose keys include column names
      // plus internal drizzle symbols. We check that our domain columns
      // are present.
      expect(columnNames).toContain('elementId');
      expect(columnNames).toContain('origin');
      expect(columnNames).toContain('sourceUrl');
      expect(columnNames).toContain('sourceVersion');
      expect(columnNames).toContain('contentHash');
      expect(columnNames).toContain('forkedFrom');
      expect(columnNames).toContain('installedAt');
    });
  });

  describe('migration 0008 SQL', () => {
    const sqlPath = path.join(migrationsDir, '0008_shared_pool_provenance.sql');

    it('migration file exists', () => {
      expect(fs.existsSync(sqlPath)).toBe(true);
    });

    it('creates the element_provenance table', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "element_provenance"');
    });

    it('inserts the SYSTEM user with the pinned UUID', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain("'00000000-0000-0000-0000-000000000001'");
      expect(sql).toContain("'dollhousemcp-system'");
      expect(sql).toContain('ON CONFLICT');
    });

    it('creates the origin CHECK constraint', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('element_provenance_origin_check');
      expect(sql).toContain("'collection'");
      expect(sql).toContain("'deployment_seed'");
      expect(sql).toContain("'fork'");
    });

    it('creates the canonical identity index', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('idx_provenance_canonical');
      expect(sql).toContain('"origin"');
      expect(sql).toContain('"source_url"');
      expect(sql).toContain('"source_version"');
    });

    it('creates the forked_from index (partial)', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('idx_provenance_forked_from');
      expect(sql).toContain('WHERE "forked_from" IS NOT NULL');
    });

    it('enables RLS on element_provenance', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
      expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    });

    it('creates SELECT policy delegating to elements visibility', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('element_provenance_select');
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('"elements"."id" = "element_provenance"."element_id"');
    });

    it('does NOT create INSERT/UPDATE/DELETE policies for app role', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      // Should not have insert/update/delete policies — admin bypasses RLS
      expect(sql).not.toContain('element_provenance_insert');
      expect(sql).not.toContain('element_provenance_update');
      expect(sql).not.toContain('element_provenance_delete');
    });

    it('enforces fork origin requires non-null forked_from', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('element_provenance_fork_requires_forked_from');
      expect(sql).toContain("\"origin\" != 'fork' OR \"forked_from\" IS NOT NULL");
    });

    it('uses ON DELETE CASCADE for element_id FK', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('ON DELETE CASCADE');
    });

    it('uses ON DELETE SET NULL for forked_from FK', () => {
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      expect(sql).toContain('ON DELETE SET NULL');
    });
  });

  describe('migration metadata', () => {
    it('journal includes 0008 entry', () => {
      const journal = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf-8')
      );
      const entry = journal.entries.find(
        (e: { tag: string }) => e.tag === '0008_shared_pool_provenance'
      );
      expect(entry).toBeDefined();
      expect(entry.idx).toBe(8);
    });

    it('0008 snapshot exists and chains from 0007', () => {
      const snap0007 = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, 'meta', '0007_snapshot.json'), 'utf-8')
      );
      const snap0008 = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, 'meta', '0008_snapshot.json'), 'utf-8')
      );
      expect(snap0008.prevId).toBe(snap0007.id);
      expect(snap0008.id).toBeTruthy();
      expect(snap0008.id).not.toBe(snap0007.id);
    });

    it('0008 snapshot includes element_provenance table', () => {
      const snap = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, 'meta', '0008_snapshot.json'), 'utf-8')
      );
      expect(snap.tables['public.element_provenance']).toBeDefined();
      expect(snap.tables['public.element_provenance'].columns.element_id).toBeDefined();
      expect(snap.tables['public.element_provenance'].columns.origin).toBeDefined();
      expect(snap.tables['public.element_provenance'].columns.content_hash).toBeDefined();
    });

    it('0008 snapshot preserves all tables from 0007', () => {
      const snap0007 = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, 'meta', '0007_snapshot.json'), 'utf-8')
      );
      const snap0008 = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, 'meta', '0008_snapshot.json'), 'utf-8')
      );
      for (const tableName of Object.keys(snap0007.tables)) {
        expect(snap0008.tables[tableName]).toBeDefined();
      }
    });
  });
});
