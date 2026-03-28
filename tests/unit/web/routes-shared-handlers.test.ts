/**
 * Regression tests for shared route handlers extracted during refactoring.
 * Tests scanElementDirectory, resolveElementFilePath, buildValidationResponse,
 * isBackupOrCruft, and loadMemoriesFromIndex through the HTTP routes.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiRoutes } from '../../../src/web/routes.js';

describe('Shared route handler regression tests', () => {
  let testDir: string;
  let app: express.Express;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'routes-shared-'));
    for (const type of ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles']) {
      await mkdir(join(testDir, type), { recursive: true });
    }

    // Valid persona
    await writeFile(join(testDir, 'personas', 'test-persona.md'), `---
name: Test Persona
description: A test persona
version: 1.0.0
author: tester
tags:
  - test
created: '2025-09-01'
---
# Test Persona
You are a test persona.
`);

    // Valid skill
    await writeFile(join(testDir, 'skills', 'test-skill.md'), `---
name: Test Skill
description: A test skill
version: 1.0.0
---
# Test Skill
Do the thing.
`);

    // Backup/cruft files that should be filtered
    await writeFile(join(testDir, 'personas', '.hidden-file.md'), 'hidden');
    await writeFile(join(testDir, 'personas', 'test.backup-2026.md'), 'backup');
    await writeFile(join(testDir, 'personas', 'old-file.bak'), 'bak');
    await writeFile(join(testDir, 'personas', 'temp~'), 'temp');
    await writeFile(join(testDir, 'personas', 'thing copy.md'), 'copy');
    await writeFile(join(testDir, 'personas', 'data.state'), 'state');
    await writeFile(join(testDir, 'personas', '_index.json'), '{}');
    await writeFile(join(testDir, 'personas', 'readme.txt'), 'not an element');

    // Memory with index
    const memIndex = {
      version: 1,
      entries: {
        '2025-09-19/code-patterns.yaml': {
          name: 'code-patterns',
          description: 'Coding patterns',
          tags: ['code'],
          created: '2025-09-19',
        },
        '2025-10-01/session-log.yaml': {
          name: 'session-log',
          description: 'Session log',
          tags: ['session'],
          created: '2025-10-01',
        },
      },
    };
    await writeFile(join(testDir, 'memories', '_index.json'), JSON.stringify(memIndex));
    await mkdir(join(testDir, 'memories', '2025-09-19'), { recursive: true });
    await writeFile(
      join(testDir, 'memories', '2025-09-19', 'code-patterns.yaml'),
      'name: code-patterns\ndescription: Coding patterns\nentries:\n  - content: Use const\n',
    );

    app = express();
    app.use('/api', createApiRoutes(testDir));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ── scanElementDirectory behavior ──────────────────────────────────────────

  describe('scanElementDirectory (via /api/elements)', () => {
    it('should return only valid element files', async () => {
      const res = await request(app).get('/api/elements');
      expect(res.status).toBe(200);
      const personaNames = res.body.elements.personas.map((p: any) => p.name);
      expect(personaNames).toContain('Test Persona');
      expect(personaNames).toHaveLength(1);
    });

    it('should not include hidden files', async () => {
      const res = await request(app).get('/api/elements');
      const names = res.body.elements.personas.map((p: any) => p.name);
      expect(names).not.toContain('.hidden-file');
    });

    it('should not include backup files', async () => {
      const res = await request(app).get('/api/elements');
      const names = res.body.elements.personas.map((p: any) => p.name);
      expect(names).not.toContain('test.backup-2026');
    });

    it('should not include .bak files', async () => {
      const res = await request(app).get('/api/elements');
      const names = res.body.elements.personas.map((p: any) => p.name);
      expect(names).not.toContain('old-file');
    });

    it('should not include tilde backup files', async () => {
      const res = await request(app).get('/api/elements');
      const names = res.body.elements.personas.map((p: any) => p.name);
      expect(names).not.toContain('temp~');
    });

    it('should not include copy files', async () => {
      const res = await request(app).get('/api/elements');
      const names = res.body.elements.personas.map((p: any) => p.name);
      expect(names).not.toContain('thing copy');
    });

    it('should not include non-element extensions', async () => {
      const res = await request(app).get('/api/elements');
      const names = res.body.elements.personas.map((p: any) => p.name);
      expect(names).not.toContain('readme');
    });

    it('should extract correct metadata fields', async () => {
      const res = await request(app).get('/api/elements');
      const persona = res.body.elements.personas[0];
      expect(persona.name).toBe('Test Persona');
      expect(persona.description).toBe('A test persona');
      expect(persona.version).toBe('1.0.0');
      expect(persona.author).toBe('tester');
      expect(persona.created).toBe('2025-09-01');
      expect(persona.filename).toBe('test-persona.md');
      expect(persona.type).toBe('persona'); // singular
    });

    it('should handle empty type directories gracefully', async () => {
      const res = await request(app).get('/api/elements');
      expect(res.status).toBe(200);
      expect(res.body.elements.agents).toEqual([]);
    });
  });

  // ── loadMemoriesFromIndex behavior ─────────────────────────────────────────

  describe('loadMemoriesFromIndex (via /api/elements)', () => {
    it('should load memories from _index.json', async () => {
      const res = await request(app).get('/api/elements');
      expect(res.body.elements.memories).toHaveLength(2);
    });

    it('should extract memory metadata from index', async () => {
      const res = await request(app).get('/api/elements');
      const cp = res.body.elements.memories.find((m: any) => m.name === 'code-patterns');
      expect(cp).toBeDefined();
      expect(cp.description).toBe('Coding patterns');
      expect(cp.created).toBe('2025-09-19');
      expect(cp.filename).toBe('2025-09-19/code-patterns.yaml');
      expect(cp.type).toBe('memory');
    });

    it('should return 0 memories when no index exists', async () => {
      await rm(join(testDir, 'memories', '_index.json'));
      const res = await request(app).get('/api/elements');
      expect(res.body.elements.memories).toHaveLength(0);
    });
  });

  // ── resolveElementFilePath behavior ────────────────────────────────────────

  describe('resolveElementFilePath (via /api/elements/:type/:name)', () => {
    it('should resolve by exact filename', async () => {
      const res = await request(app).get('/api/elements/personas/test-persona.md');
      expect(res.status).toBe(200);
    });

    it('should resolve by bare name without extension', async () => {
      const res = await request(app).get('/api/elements/personas/test-persona');
      expect(res.status).toBe(200);
    });

    it('should return 404 for non-existent element', async () => {
      const res = await request(app).get('/api/elements/personas/does-not-exist');
      expect(res.status).toBe(404);
    });

    it('should reject path traversal with ..', async () => {
      const res = await request(app).get('/api/elements/personas/..%2F..%2Fetc%2Fpasswd');
      expect(res.status).toBe(400);
    });

    it('should not serve backslash paths', async () => {
      const res = await request(app).get('/api/elements/personas/test%5Cbad');
      // Express URL decoding + handler validation — either 400 or 404
      expect([400, 404]).toContain(res.status);
    });

    it('should not serve slash in non-memory name', async () => {
      // Express routes /personas/sub/file as /elements/:type/:name with type=personas, name missing
      const res = await request(app).get('/api/elements/personas/sub/file');
      expect([400, 404]).toContain(res.status);
    });
  });

  // ── Memory date-path handling ──────────────────────────────────────────────

  describe('Memory date-path routes', () => {
    it('should serve memory content via date path', async () => {
      const res = await request(app).get('/api/elements/memories/2025-09-19/code-patterns.yaml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('code-patterns');
    });

    it('should reject invalid date format', async () => {
      const res = await request(app).get('/api/elements/memories/not-a-date/file.yaml');
      expect(res.status).toBe(400);
    });

    it('should reject path traversal in date path', async () => {
      const res = await request(app).get('/api/elements/memories/..%2F..%2Fetc/passwd');
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent memory file', async () => {
      const res = await request(app).get('/api/elements/memories/2025-01-01/nonexistent.yaml');
      expect(res.status).toBe(404);
    });
  });

  // ── Stats route ────────────────────────────────────────────────────────────

  describe('registerStatsRoute (via /api/stats)', () => {
    it('should count valid files only, excluding cruft', async () => {
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.personas).toBe(1); // only test-persona.md
      expect(res.body.stats.skills).toBe(1);
      expect(res.body.stats.memories).toBe(2); // from index
      expect(res.body.stats.agents).toBe(0);
    });

    it('should return correct total', async () => {
      const res = await request(app).get('/api/stats');
      const expectedTotal = Object.values(res.body.stats as Record<string, number>)
        .reduce((sum, n) => sum + n, 0);
      expect(res.body.total).toBe(expectedTotal);
    });
  });
});
