/**
 * Regression tests for structuredDetail flag behavior.
 *
 * Runs the same portfolio against both createApiRoutes (plain text detail)
 * and createGatewayApiRoutes (structured JSON detail) to verify:
 * - Listings are identical between modes
 * - Detail responses differ only in format, not content
 * - Structured JSON contains all required fields
 * - raw field in structured response matches plain text response
 */

import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiRoutes, createGatewayApiRoutes } from '../../../src/web/routes.js';

describe('Structured vs plain text detail regression', () => {
  let testDir: string;
  let plainApp: express.Express;
  let structuredApp: express.Express;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'routes-structured-'));
    for (const type of ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles']) {
      await mkdir(join(testDir, type), { recursive: true });
    }

    // Persona with full metadata
    await writeFile(join(testDir, 'personas', 'alex-sterling.md'), `---
name: Alex Sterling
description: A competent assistant
version: 2.2.0
author: mickdarling
tags:
  - coding
  - investigation
created: '2025-09-01'
category: development
---
# Alex Sterling

You are Alex Sterling.
`);

    // Skill
    await writeFile(join(testDir, 'skills', 'code-review.md'), `---
name: Code Review
description: Reviews code for quality
version: 1.0.0
author: tester
---
Review the code carefully.
`);

    // Ensemble
    await writeFile(join(testDir, 'ensembles', 'dev-team.md'), `---
name: Dev Team
description: Development team ensemble
version: 1.0.0
---
# Dev Team Ensemble
`);

    // Memory with index and file
    const memIndex = {
      version: 1,
      entries: {
        '2025-09-19/code-patterns.yaml': {
          name: 'code-patterns',
          description: 'Coding patterns reference',
          tags: ['code', 'patterns'],
          created: '2025-09-19',
        },
      },
    };
    await writeFile(join(testDir, 'memories', '_index.json'), JSON.stringify(memIndex));
    await mkdir(join(testDir, 'memories', '2025-09-19'), { recursive: true });
    await writeFile(
      join(testDir, 'memories', '2025-09-19', 'code-patterns.yaml'),
      'name: code-patterns\ndescription: Coding patterns\nentries:\n  - content: Use const over let\n',
    );

    // Create both apps from the same portfolio
    plainApp = express();
    plainApp.use('/api', createApiRoutes(testDir));

    structuredApp = express();
    // Gateway routes don't use handler for shared portfolio routes
    structuredApp.use('/api', createGatewayApiRoutes({} as any, testDir));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ── Listing consistency ────────────────────────────────────────────────────

  describe('Listing consistency between modes', () => {
    it('should return identical element listings', async () => {
      const plain = await request(plainApp).get('/api/elements');
      const structured = await request(structuredApp).get('/api/elements');

      expect(plain.status).toBe(200);
      expect(structured.status).toBe(200);
      expect(plain.body.totalCount).toBe(structured.body.totalCount);
      expect(plain.body.elements.personas.length).toBe(structured.body.elements.personas.length);
      expect(plain.body.elements.memories.length).toBe(structured.body.elements.memories.length);
    });

    it('should return identical element names', async () => {
      const plain = await request(plainApp).get('/api/elements');
      const structured = await request(structuredApp).get('/api/elements');

      const plainNames = plain.body.elements.personas.map((p: any) => p.name).sort();
      const structuredNames = structured.body.elements.personas.map((p: any) => p.name).sort();
      expect(plainNames).toEqual(structuredNames);
    });

    it('should return identical stats', async () => {
      const plain = await request(plainApp).get('/api/stats');
      const structured = await request(structuredApp).get('/api/stats');

      expect(plain.status).toBe(200);
      expect(structured.status).toBe(200);
      expect(plain.body).toEqual(structured.body);
    });
  });

  // ── Detail format differences ──────────────────────────────────────────────

  describe('Detail format — plain text mode', () => {
    it('should return text/plain content type', async () => {
      const res = await request(plainApp).get('/api/elements/personas/alex-sterling.md');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('should return raw file content as text', async () => {
      const res = await request(plainApp).get('/api/elements/personas/alex-sterling.md');
      expect(res.text).toContain('name: Alex Sterling');
      expect(res.text).toContain('# Alex Sterling');
    });
  });

  describe('Detail format — structured JSON mode', () => {
    it('should return application/json content type', async () => {
      const res = await request(structuredApp).get('/api/elements/personas/alex-sterling.md');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('should include all required fields', async () => {
      const res = await request(structuredApp).get('/api/elements/personas/alex-sterling.md');
      const body = res.body;
      expect(body).toHaveProperty('metadata');
      expect(body).toHaveProperty('body');
      expect(body).toHaveProperty('raw');
      expect(body).toHaveProperty('type');
      expect(body).toHaveProperty('validation');
    });

    it('should have parsed metadata', async () => {
      const res = await request(structuredApp).get('/api/elements/personas/alex-sterling.md');
      expect(res.body.metadata.name).toBe('Alex Sterling');
      expect(res.body.metadata.description).toBe('A competent assistant');
      expect(res.body.metadata.version).toBe('2.2.0');
      expect(res.body.metadata.author).toBe('mickdarling');
      expect(res.body.metadata.created).toBe('2025-09-01');
    });

    it('should have markdown body', async () => {
      const res = await request(structuredApp).get('/api/elements/personas/alex-sterling.md');
      expect(res.body.body).toContain('# Alex Sterling');
      expect(res.body.body).toContain('You are Alex Sterling.');
    });

    it('should singularize type', async () => {
      const res = await request(structuredApp).get('/api/elements/personas/alex-sterling.md');
      expect(res.body.type).toBe('persona');
    });

    it('should include validation status', async () => {
      const res = await request(structuredApp).get('/api/elements/personas/alex-sterling.md');
      expect(res.body.validation.status).toBe('pass');
    });

    it('should have raw field matching plain text response', async () => {
      const plain = await request(plainApp).get('/api/elements/personas/alex-sterling.md');
      const structured = await request(structuredApp).get('/api/elements/personas/alex-sterling.md');
      expect(structured.body.raw).toBe(plain.text);
    });
  });

  // ── Memory date-path format differences ────────────────────────────────────

  describe('Memory date-path format differences', () => {
    it('should return plain text in simple mode', async () => {
      const res = await request(plainApp).get('/api/elements/memories/2025-09-19/code-patterns.yaml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('code-patterns');
    });

    it('should return structured JSON in gateway mode', async () => {
      const res = await request(structuredApp).get('/api/elements/memories/2025-09-19/code-patterns.yaml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toHaveProperty('metadata');
      expect(res.body).toHaveProperty('raw');
      expect(res.body.type).toBe('memory');
      expect(res.body.validation.status).toBe('pass');
    });

    it('should have raw field matching plain text for memories', async () => {
      const plain = await request(plainApp).get('/api/elements/memories/2025-09-19/code-patterns.yaml');
      const structured = await request(structuredApp).get('/api/elements/memories/2025-09-19/code-patterns.yaml');
      expect(structured.body.raw).toBe(plain.text);
    });
  });

  // ── Per-type listing consistency ───────────────────────────────────────────

  describe('Per-type listing consistency', () => {
    it('should return identical persona listings', async () => {
      const plain = await request(plainApp).get('/api/elements/personas');
      const structured = await request(structuredApp).get('/api/elements/personas');
      expect(plain.body.count).toBe(structured.body.count);
    });

    it('should return identical memory listings', async () => {
      const plain = await request(plainApp).get('/api/elements/memories');
      const structured = await request(structuredApp).get('/api/elements/memories');
      expect(plain.body.count).toBe(structured.body.count);
    });
  });
});
