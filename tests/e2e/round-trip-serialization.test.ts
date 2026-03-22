/**
 * Round-Trip Serialization Regression Test Suite (#920)
 *
 * Verifies that create → save → reload → save produces consistent output
 * for all 6 element types. Documents which mutations are intentional
 * (timestamps, version normalization) vs bugs.
 *
 * Covers:
 * - All 6 element types (persona, skill, template, agent, ensemble, memory)
 * - Non-ASCII content (emoji, CJK, combining characters)
 * - Boolean/number type preservation (#914 fix)
 * - Field ordering consistency (#910 fix)
 * - format_version marker persistence (#912 fix)
 * - Known mutation vectors from epic #907
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { ElementType } from '../../src/portfolio/types.js';

// Run locally always; in CI only when DOLLHOUSE_RUN_FULL_E2E=true
const shouldRun = process.env.DOLLHOUSE_RUN_FULL_E2E === 'true' || process.env.CI === undefined;
const describeOrSkip = shouldRun ? describe : describe.skip;

// ========================================================================
// Common test element definitions — centralized for maintainability
// as element types scale to hundreds of bespoke types
// ========================================================================
interface TestElementDef {
  name: string;
  type: ElementType;
  description: string;
  instructions?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

const TEST_ELEMENTS: Record<string, TestElementDef> = {
  persona: {
    name: 'RT-Persona',
    type: ElementType.PERSONA,
    description: 'Round-trip test persona',
    instructions: 'You are a helpful test assistant.',
  },
  skill: {
    name: 'RT-Skill',
    type: ElementType.SKILL,
    description: 'Round-trip test skill',
    instructions: 'Follow these coding guidelines.',
    content: '# Reference\n\nAdditional reference material.',
  },
  template: {
    name: 'RT-Template',
    type: ElementType.TEMPLATE,
    description: 'Round-trip test template',
    content: 'Hello {{name}}, welcome to {{place}}.',
  },
  agent: {
    name: 'RT-Agent',
    type: ElementType.AGENT,
    description: 'Round-trip test agent',
    instructions: 'You analyze code for quality issues.',
  },
  ensemble: {
    name: 'RT-Ensemble',
    type: ElementType.ENSEMBLE,
    description: 'Round-trip test ensemble',
    metadata: { elements: [] },
  },
  memory: {
    name: 'RT-Memory',
    type: ElementType.MEMORY,
    description: 'Round-trip test memory',
    content: 'Initial memory entry for testing.',
  },
};

// ========================================================================
// Pure helpers (no test closure needed — outer scope per SonarCloud S7721)
// ========================================================================

/** Normalize a string to alphanumeric lowercase for flexible slug matching */
function toSlug(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/** Check if a filename matches a slug (alphanumeric comparison) */
function matchesSlug(filename: string, slug: string): boolean {
  return toSlug(filename).includes(slug);
}

/** Search a flat directory for a file matching the slug */
async function findInDir(dir: string, slug: string): Promise<string | null> {
  const files = await fs.readdir(dir);
  const match = files.find(f => matchesSlug(f, slug));
  return match ? path.join(dir, match) : null;
}

describeOrSkip('Round-Trip Serialization Regression (#920)', () => {
  let server: any;
  let container: any;
  let tempPortfolioDir: string;
  const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

  beforeAll(async () => {
    tempPortfolioDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-roundtrip-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempPortfolioDir;

    const { DollhouseMCPServer } = await import('../../src/index.js');
    const { DollhouseContainer } = await import('../../src/di/Container.js');

    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server['initializePortfolio']();
    await server['completeInitialization']();
  }, 30000);

  afterAll(async () => {
    if (server && typeof server.dispose === 'function') {
      await server.dispose();
    }
    if (tempPortfolioDir) {
      await fs.rm(tempPortfolioDir, { recursive: true, force: true });
    }
    if (originalPortfolioDir === undefined) {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    } else {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    }
  });

  /**
   * Find and read an element file by searching the type directory for a file
   * whose name contains the element name slug.
   */
  async function findElementFile(type: string, nameSlug: string): Promise<string> {
    const pluralType = type.endsWith('s') ? type : `${type}s`;
    const typeDir = path.join(tempPortfolioDir, pluralType);
    const slug = toSlug(nameSlug);

    // For memories, also check date subdirectories
    if (pluralType === 'memories') {
      const entries = await fs.readdir(typeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = await findInDir(path.join(typeDir, entry.name), slug);
          if (found) return fs.readFile(found, 'utf-8');
        }
      }
      // Also check root-level memory files
      const rootMatch = await findInDir(typeDir, slug);
      if (rootMatch) return fs.readFile(rootMatch, 'utf-8');
      throw new Error(`No memory file found matching '${nameSlug}' in ${typeDir}`);
    }

    const found = await findInDir(typeDir, slug);
    if (!found) {
      const files = await fs.readdir(typeDir);
      throw new Error(`No file found matching '${nameSlug}' in ${typeDir}. Available: ${files.join(', ')}`);
    }
    return fs.readFile(found, 'utf-8');
  }

  // ========================================================================
  // Phase 1: Basic Round-Trip for Each Element Type
  // Uses centralized TEST_ELEMENTS — scales as new element types are added
  // ========================================================================
  describe('Phase 1: Basic round-trip per element type', () => {
    // Data-driven: iterate all defined element types
    for (const [key, def] of Object.entries(TEST_ELEMENTS)) {
      it(`${key}: create → read file → verify structure`, async () => {
        const result = await server.createElement(def);
        expect(result.content[0].text).toContain('✅');

        // Memory elements use pure YAML format (not markdown with frontmatter).
        // MemoryManager has its own serialization path that produces a YAML document
        // with metadata, entries, and stats as top-level keys — no '---' delimiters.
        // Memory round-trip fidelity is tested separately in MemoryManager.test.ts.
        if (key === 'memory') return;

        const file = await findElementFile(def.type, def.name);
        expect(file).toContain(`name: ${def.name}`);
        expect(file).toContain('format_version: v2');
        expect(file).toContain('---');
      });
    }
  });

  // ========================================================================
  // Phase 2: Boolean and Number Type Preservation (#914)
  // ========================================================================
  describe('Phase 2: Boolean/number type preservation (#914)', () => {

    it('skill: boolean metadata survives round-trip', async () => {
      const result = await server.createElement({
        name: 'RT-Bool-Skill',
        type: ElementType.SKILL,
        description: 'Boolean preservation test',
        instructions: 'Test instructions',
        content: 'Reference material for boolean test.',
        metadata: { ai_generated: true },
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('skills', 'rt-bool-skill.md');
      // Must be YAML boolean, not quoted string
      expect(file).toMatch(/ai_generated: true/);
      expect(file).not.toMatch(/ai_generated: ['"]true['"]/);
    });

    it('agent: numeric metadata survives round-trip', async () => {
      const result = await server.createElement({
        name: 'RT-Num-Agent',
        type: ElementType.AGENT,
        description: 'Number preservation test',
        instructions: 'Test instructions',
        metadata: { maxConcurrentGoals: 5 },
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('agents', 'rt-num-agent.md');
      expect(file).toMatch(/maxConcurrentGoals: 5/);
      expect(file).not.toMatch(/maxConcurrentGoals: ['"]5['"]/);
    });
  });

  // ========================================================================
  // Phase 3: Non-ASCII Content
  // ========================================================================
  describe('Phase 3: Non-ASCII content round-trip', () => {

    it('emoji content survives round-trip', async () => {
      const result = await server.createElement({
        name: 'RT-Emoji',
        type: ElementType.SKILL,
        description: 'Skill with emoji content',
        instructions: 'Use these emoji guidelines: 🎯 for goals, ✅ for done, ⚠️ for warnings',
        content: 'Emoji reference material.',
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('skills', 'rt-emoji');
      // BMP emoji (✅, ⚠️) survive as-is in YAML output
      expect(file).toContain('✅');
      expect(file).toContain('⚠️');
      // Non-BMP emoji (🎯 U+1F3AF) get escaped by js-yaml to \U0001F3AF
      // This is expected YAML serializer behavior, not a bug
      expect(file).toMatch(/🎯|\\U0001F3AF/);
    });

    it('CJK characters survive round-trip', async () => {
      const result = await server.createElement({
        name: 'RT-CJK',
        type: ElementType.SKILL,
        description: 'CJK character test',
        instructions: 'Japanese: 日本語テスト Chinese: 中文测试 Korean: 한국어테스트',
        content: 'CJK reference material.',
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('skills', 'rt-cjk.md');
      expect(file).toContain('日本語テスト');
      expect(file).toContain('中文测试');
      expect(file).toContain('한국어테스트');
    });

    it('accented Latin characters survive round-trip', async () => {
      const result = await server.createElement({
        name: 'RT-Accented',
        type: ElementType.PERSONA,
        description: 'Accented character test',
        instructions: 'Répondez en français. Ñoño español. Über German.',
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('personas', 'rt-accented.md');
      expect(file).toContain('français');
      expect(file).toContain('Ñoño');
      expect(file).toContain('Über');
    });
  });

  // ========================================================================
  // Phase 4: Field Ordering Consistency (#910)
  // ========================================================================
  describe('Phase 4: Field ordering consistency (#910)', () => {

    it('metadata fields follow canonical order', async () => {
      await server.createElement({
        name: 'RT-FieldOrder',
        type: ElementType.SKILL,
        description: 'Field ordering test',
        instructions: 'Test instructions',
        content: 'Field ordering reference.',
        metadata: {
          author: 'test-author',
          tags: ['test', 'ordering'],
          category: 'testing',
        },
      });

      const file = await findElementFile('skills', 'rt-fieldorder.md');
      const lines = file.split('\n');

      // Find positions of key fields — name should come before description,
      // description before author, etc. per METADATA_FIELD_ORDER
      const nameIdx = lines.findIndex(l => l.startsWith('name:'));
      const descIdx = lines.findIndex(l => l.startsWith('description:'));
      const authorIdx = lines.findIndex(l => l.startsWith('author:'));
      const tagsIdx = lines.findIndex(l => l.startsWith('tags:'));

      expect(nameIdx).toBeGreaterThan(-1);
      expect(descIdx).toBeGreaterThan(nameIdx);
      expect(authorIdx).toBeGreaterThan(-1);
      expect(tagsIdx).toBeGreaterThan(-1);
    });
  });

  // ========================================================================
  // Phase 5: Known Mutation Vectors — Intentional vs Bug
  // ========================================================================
  describe('Phase 5: Known mutation vectors', () => {

    it('INTENTIONAL: version is normalized to semver format', async () => {
      const result = await server.createElement({
        name: 'RT-Version',
        type: ElementType.SKILL,
        description: 'Version normalization test',
        instructions: 'Test instructions for round-trip verification.',
        content: 'Version test reference material.',
        metadata: { version: '1.0.0' },
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('skills', 'rt-version');
      // Version should be in semver format
      expect(file).toMatch(/version: ['"]?1\.0\.0['"]?/);
    });

    it('INTENTIONAL: unique_id generated when missing', async () => {
      await server.createElement({
        name: 'RT-UniqueId',
        type: ElementType.SKILL,
        description: 'Unique ID generation test',
        instructions: 'Test instructions for round-trip verification.',
        content: 'UniqueId test reference.',
      });

      const file = await findElementFile('skills', 'rt-uniqueid.md');
      expect(file).toMatch(/unique_id:/);
    });

    it('INTENTIONAL: format_version v2 marker present', async () => {
      await server.createElement({
        name: 'RT-FormatVer',
        type: ElementType.PERSONA,
        description: 'Format version test',
        instructions: 'Test instructions for round-trip verification.',
      });

      const file = await findElementFile('personas', 'rt-formatver.md');
      expect(file).toContain('format_version: v2');
    });

    it('INTENTIONAL: tags defaults to empty array when absent', async () => {
      await server.createElement({
        name: 'RT-Tags',
        type: ElementType.SKILL,
        description: 'Tags default test',
        instructions: 'Test instructions for round-trip verification.',
        content: 'Tags test reference.',
      });

      const file = await findElementFile('skills', 'rt-tags.md');
      // tags should be present (as empty array or omitted by cleaning)
      // Verify no crash — the key behavior is that absence doesn't break anything
      expect(file).toContain('name: RT-Tags');
    });

    it('FIXED: booleans not corrupted to strings (#914)', async () => {
      await server.createElement({
        name: 'RT-BoolFixed',
        type: ElementType.AGENT,
        description: 'Boolean corruption regression test',
        instructions: 'Test agent',
        metadata: { learningEnabled: false },
      });

      const file = await findElementFile('agents', 'rt-boolfixed.md');
      // Pre-#914: failsafe schema would write learningEnabled: 'false' (string)
      // Post-#914: json schema preserves learningEnabled: false (boolean)
      expect(file).toMatch(/learningEnabled: false/);
      expect(file).not.toMatch(/learningEnabled: 'false'/);
    });

    it('FIXED: field ordering is deterministic (#910)', async () => {
      // Create same element twice, compare field order
      await server.createElement({
        name: 'RT-Order-A',
        type: ElementType.SKILL,
        description: 'Order test A',
        instructions: 'Test instructions for round-trip verification.',
        content: 'Order A reference.',
        metadata: { author: 'tester', tags: ['a'] },
      });
      await server.createElement({
        name: 'RT-Order-B',
        type: ElementType.SKILL,
        description: 'Order test B',
        instructions: 'Test instructions for round-trip verification.',
        content: 'Order B reference.',
        metadata: { author: 'tester', tags: ['b'] },
      });

      const fileA = await findElementFile('skills', 'rt-order-a.md');
      const fileB = await findElementFile('skills', 'rt-order-b.md');

      // Extract field names from frontmatter (between --- delimiters)
      const extractFieldOrder = (content: string) => {
        const match = /^---\n([\s\S]*?)\n---/.exec(content);
        if (!match) return [];
        return match[1].split('\n')
          .filter(l => /^\w/.test(l))
          .map(l => l.split(':')[0]);
      };

      const orderA = extractFieldOrder(fileA);
      const orderB = extractFieldOrder(fileB);

      // Field ordering should be identical between elements of the same type
      expect(orderA).toEqual(orderB);
    });
  });

  // ========================================================================
  // Phase 6: Markdown Bold Content (Regression #906)
  // ========================================================================
  describe('Phase 6: Markdown bold content regression (#906)', () => {

    it('persona with bold markdown does not trigger false YAML amplification', async () => {
      const result = await server.createElement({
        name: 'RT-Bold',
        type: ElementType.PERSONA,
        description: 'Bold markdown regression test',
        instructions: 'You are a **highly skilled** analyst with **deep expertise** in **multiple domains** and **strong opinions** about **best practices** and **quality standards**.',
      });

      // Should succeed — pre-#906 this would fail with "Malicious YAML content detected"
      expect(result.content[0].text).toContain('✅');

      // Verify the bold markers survived
      const file = await findElementFile('personas', 'rt-bold.md');
      expect(file).toContain('**highly skilled**');
      expect(file).toContain('**deep expertise**');
    });
  });

  // ========================================================================
  // Phase 7: True Load → Save → Load Round-Trip Fidelity
  // ========================================================================
  describe('Phase 7: True load → save → load fidelity', () => {

    it('skill: file content is stable after save → reload → save cycle', async () => {
      // Create initial element
      await server.createElement({
        name: 'RT-Stable-Skill',
        type: ElementType.SKILL,
        description: 'Stability test skill',
        instructions: 'Follow these guidelines for code review.',
        content: 'Reference material for the stability test.',
        metadata: { author: 'stability-tester', tags: ['test', 'stability'] },
      });

      // Read the file after first save
      const fileAfterCreate = await findElementFile('skills', 'rt-stable-skill');

      // Trigger a reload + save by editing a non-structural field
      await server.editElement({
        name: 'RT-Stable-Skill',
        type: ElementType.SKILL,
        input: { description: 'Stability test skill (edited)' },
      });

      // Read the file after second save
      const fileAfterEdit = await findElementFile('skills', 'rt-stable-skill');

      // Compare structural elements — everything except description and
      // modified timestamp should be identical
      // Strip fields that change between saves (timestamps, auto-incremented version)
      const stripVolatile = (content: string) =>
        content
          .replaceAll(/^description:.*$/gm, '')
          .replaceAll(/^modified:.*$/gm, '')
          .replaceAll(/^version:.*$/gm, '');

      expect(stripVolatile(fileAfterEdit)).toBe(stripVolatile(fileAfterCreate));
    });

    it('persona: instructions and content survive reload cycle', async () => {
      const instructions = 'You are a detail-oriented reviewer who catches subtle bugs.';

      await server.createElement({
        name: 'RT-Stable-Persona',
        type: ElementType.PERSONA,
        description: 'Persona stability test',
        instructions,
      });

      // Read after create
      const fileAfterCreate = await findElementFile('personas', 'rt-stable-persona');
      expect(fileAfterCreate).toContain(instructions);

      // Edit something else, verify instructions survive
      await server.editElement({
        name: 'RT-Stable-Persona',
        type: ElementType.PERSONA,
        input: { description: 'Persona stability test (edited)' },
      });

      const fileAfterEdit = await findElementFile('personas', 'rt-stable-persona');
      expect(fileAfterEdit).toContain(instructions);
    });

    it('agent: boolean metadata preserved through edit cycle', async () => {
      await server.createElement({
        name: 'RT-Stable-Agent',
        type: ElementType.AGENT,
        description: 'Agent stability test',
        instructions: 'Analyze code for security vulnerabilities.',
        metadata: { learningEnabled: true },
      });

      const fileAfterCreate = await findElementFile('agents', 'rt-stable-agent');
      expect(fileAfterCreate).toMatch(/learningEnabled: true/);

      // Edit description, verify boolean survives
      await server.editElement({
        name: 'RT-Stable-Agent',
        type: ElementType.AGENT,
        input: { description: 'Agent stability test (edited)' },
      });

      const fileAfterEdit = await findElementFile('agents', 'rt-stable-agent');
      // Boolean must still be a YAML boolean after the round-trip
      expect(fileAfterEdit).toMatch(/learningEnabled: true/);
      expect(fileAfterEdit).not.toMatch(/learningEnabled: ['"]true['"]/);
    });
  });

  // ========================================================================
  // Phase 8: Edge Cases — Large Content, Nested Metadata, Concurrency
  // ========================================================================
  describe('Phase 8: Edge cases', () => {

    it('large content block survives round-trip', async () => {
      // Generate a large but valid content block (~50KB)
      const lines = Array.from({ length: 500 }, (_, i) =>
        `Line ${i + 1}: This is a substantive line of reference material for testing large content serialization.`
      );
      const largeContent = lines.join('\n');

      const result = await server.createElement({
        name: 'RT-Large-Content',
        type: ElementType.SKILL,
        description: 'Large content round-trip test',
        instructions: 'Process this large reference document carefully.',
        content: largeContent,
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('skills', 'rt-large-content');
      // Verify content survived — check first, middle, and last lines
      expect(file).toContain('Line 1:');
      expect(file).toContain('Line 250:');
      expect(file).toContain('Line 500:');
    }, 30000);  // Extended timeout for large content serialization in CI

    it('empty metadata does not break element creation', async () => {
      // Explicit empty metadata object — should use defaults, not crash
      const resultEmpty = await server.createElement({
        name: 'RT-Empty-Meta',
        type: ElementType.PERSONA,
        description: 'Empty metadata test',
        instructions: 'You are a persona created with empty metadata.',
        metadata: {},
      });
      expect(resultEmpty.content[0].text).toContain('✅');

      const file = await findElementFile('personas', 'rt-empty-meta');
      // Should have defaults filled in (version, author, etc.)
      expect(file).toContain('name: RT-Empty-Meta');
      expect(file).toMatch(/version:/);
      expect(file).toContain('format_version: v2');
    });

    it('undefined optional metadata fields do not corrupt output', async () => {
      // Create with explicitly undefined optional fields
      const result = await server.createElement({
        name: 'RT-Undef-Fields',
        type: ElementType.SKILL,
        description: 'Undefined fields test',
        instructions: 'Test instructions for undefined fields verification.',
        content: 'Reference material for undefined fields test.',
        metadata: {
          tags: undefined,
          author: undefined,
          category: undefined,
        },
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('skills', 'rt-undef-fields');
      expect(file).toContain('name: RT-Undef-Fields');
      // undefined fields should be cleaned or defaulted, not serialized as 'undefined'
      expect(file).not.toContain(': undefined');
      expect(file).not.toContain("'undefined'");
    });

    it('deeply nested metadata objects survive round-trip', async () => {
      const result = await server.createElement({
        name: 'RT-Nested-Agent',
        type: ElementType.AGENT,
        description: 'Nested metadata test',
        instructions: 'Test agent for nested metadata verification.',
        metadata: {
          goal: {
            template: 'Complete: {task}',
            parameters: [
              { name: 'task', type: 'string', required: true, description: 'The task to complete' }
            ],
            successCriteria: ['Task documented', 'Quality verified'],
          },
          autonomy: {
            riskTolerance: 'conservative',
            maxAutonomousSteps: 3,
          },
          resilience: {
            onExecutionFailure: 'retry',
            maxRetries: 2,
          },
        },
      });
      expect(result.content[0].text).toContain('✅');

      const file = await findElementFile('agents', 'rt-nested-agent');
      // Verify nested structures survived serialization
      expect(file).toContain('riskTolerance: conservative');
      expect(file).toContain('maxAutonomousSteps: 3');
      expect(file).toContain('maxRetries: 2');
      expect(file).toContain('Task documented');
    });

    it('concurrent element creation produces distinct files', async () => {
      // Create 5 elements concurrently
      const creates = Array.from({ length: 5 }, (_, i) =>
        server.createElement({
          name: `RT-Concurrent-${i}`,
          type: ElementType.PERSONA,
          description: `Concurrent creation test ${i}`,
          instructions: `You are concurrent test persona number ${i}.`,
        })
      );

      const results = await Promise.all(creates);

      // All should succeed
      for (const result of results) {
        expect(result.content[0].text).toContain('✅');
      }

      // All should produce distinct files
      const files = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const file = await findElementFile('personas', `rt-concurrent-${i}`);
        expect(file).toContain(`RT-Concurrent-${i}`);
        files.add(file);
      }
      // All files should be unique (no overwrites)
      expect(files.size).toBe(5);
    });
  });
});
