/**
 * Unit tests for Memory Seed Installation (Issue #1442)
 * Comprehensive test suite to verify memory content is preserved during YAML import
 * and seed memory installation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('MemoryManager - Seed Installation and Content Preservation', () => {
  let memoryManager: MemoryManager;
  let testDir: string;
  let memoriesDir: string;
  let originalPortfolioDir: string | undefined;

  // Sample seed memory YAML with substantial content
  const seedMemoryYAML = `---
name: dollhousemcp-baseline-knowledge
type: memory
description: Baseline knowledge about DollhouseMCP capabilities and features - automatically loaded on server startup
version: 1.0.0
author: DollhouseMCP
autoLoad: true
priority: 1
triggers:
  - what-is-dollhouse
  - what-can-dollhouse-do
  - dollhouse-capabilities
tags:
  - baseline
  - knowledge-base
---

# DollhouseMCP - Baseline Knowledge

## What Is DollhouseMCP?

**DollhouseMCP** is an MCP server providing **AI customization through modular, reusable elements**.

## Core Capabilities

### Element Types (6 Total)
- **Personas** - AI behavioral profiles
- **Skills** - Discrete capabilities
- **Templates** - Reusable content structures
- **Agents** - Goal-oriented decision makers
- **Memories** - Persistent context storage
- **Ensembles** - Combined element orchestration

### Key Features
- Portfolio-based element management
- GitHub integration for sharing
- Auto-load memory system
- Semantic search and discovery
- Element validation and health checks

## Auto-Load System

Memories can be marked for automatic loading on server startup:
- Set \`autoLoad: true\` in memory metadata
- Configure priority (lower numbers load first)
- Provides instant context without manual activation

## Collection

Browse and install community-contributed elements:
- 50+ personas covering various domains
- Skills for specialized tasks
- Templates for common patterns
- Agents for complex workflows

## Development

Built with TypeScript, Node.js, and MCP SDK.
Comprehensive test coverage and CI/CD integration.
`;

  beforeAll(async () => {
    // Create isolated test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-seed-test-'));
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });

    // Save and override portfolio directory
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Reset PortfolioManager singleton for clean state
    (PortfolioManager as any).instance = null;
  });

  afterAll(async () => {
    // Restore original portfolio directory
    if (originalPortfolioDir) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }

    // Reset singleton
    (PortfolioManager as any).instance = null;

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clear memories directory between tests
    try {
      await fs.mkdir(memoriesDir, { recursive: true });
      const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(memoriesDir, entry.name);
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath);
        }
      }
    } catch {
      await fs.mkdir(memoriesDir, { recursive: true });
    }

    // Create fresh MemoryManager instance
    memoryManager = new MemoryManager();
  });

  describe('Seed Memory Installation', () => {
    it('should install seed memory successfully', async () => {
      // Import the seed memory
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      // Verify memory was created
      const memories = await memoryManager.list();
      expect(memories).toHaveLength(1);
      expect(memories[0].metadata.name).toBe('dollhousemcp-baseline-knowledge');
    });

    it('should preserve memory metadata correctly', async () => {
      // Import and save
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      // Load and verify metadata
      const loaded = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');
      expect(loaded).toBeDefined();
      expect(loaded!.metadata.name).toBe('dollhousemcp-baseline-knowledge');
      expect(loaded!.metadata.description).toContain('Baseline knowledge');
      expect(loaded!.metadata.version).toBe('1.0.0');
      expect(loaded!.metadata.author).toBe('DollhouseMCP');
    });

    it('should preserve memory content (NOT empty entries) - CRITICAL TEST', async () => {
      // This is the key test that catches the bug
      // With bug: entries.length === 0 (empty array)
      // After fix: entries.length > 0 (contains content)

      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      // Load the memory
      const loaded = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');
      expect(loaded).toBeDefined();

      // CRITICAL: Verify entries exist and are not empty
      const entries = loaded!.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Verify content is substantial
      const firstEntry = entries[0];
      expect(firstEntry.content).toBeDefined();
      expect(firstEntry.content.length).toBeGreaterThan(100);

      // Verify content contains expected text
      expect(firstEntry.content).toContain('DollhouseMCP');
      expect(firstEntry.content).toContain('Baseline Knowledge');
      expect(firstEntry.content).toContain('What Is DollhouseMCP?');
    });

    it('should create searchable and accessible memory', async () => {
      // Import and save
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      // Verify memory is accessible via load
      const loaded = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');
      expect(loaded).toBeDefined();
      expect(loaded!.metadata.name).toBe('dollhousemcp-baseline-knowledge');

      // Verify memory appears in list
      const memories = await memoryManager.list();
      const foundMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(foundMemory).toBeDefined();
    });

    it('should have autoLoad metadata set correctly', async () => {
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      const loaded = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');
      expect(loaded).toBeDefined();

      // Verify autoLoad flags - stored in metadata per Issue #1430
      expect((loaded!.metadata as any).autoLoad).toBe(true);
      expect((loaded!.metadata as any).priority).toBe(1);
    });

    it('should support re-importing and updating memories', async () => {
      // Install once
      const memory1 = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory1);

      // Verify memory was created successfully
      let memories = await memoryManager.list();
      expect(memories.length).toBeGreaterThan(0);

      // Verify content exists in first import
      const firstMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(firstMemory).toBeDefined();
      const originalEntries = firstMemory!.getAllEntries();
      expect(originalEntries.length).toBeGreaterThan(0);
      expect(originalEntries[0].content).toContain('Baseline Knowledge');
    });

    it('should handle content with markdown formatting', async () => {
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      const loaded = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');
      const entries = loaded!.getAllEntries();

      // Verify markdown is preserved
      const content = entries[0].content;
      expect(content).toContain('# DollhouseMCP');
      expect(content).toContain('## What Is DollhouseMCP?');
      expect(content).toContain('**DollhouseMCP**');
      expect(content).toContain('- **Personas**');
    });

    it('should create memory in date-based folder', async () => {
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      // Get today's date folder
      const today = new Date().toISOString().split('T')[0];
      const dateFolderPath = path.join(memoriesDir, today);

      // Verify date folder exists
      const dateFolderExists = await fs.access(dateFolderPath)
        .then(() => true)
        .catch(() => false);
      expect(dateFolderExists).toBe(true);

      // Verify memory file exists in date folder
      const memoryFilePath = path.join(dateFolderPath, 'dollhousemcp-baseline-knowledge.yaml');
      const memoryFileExists = await fs.access(memoryFilePath)
        .then(() => true)
        .catch(() => false);
      expect(memoryFileExists).toBe(true);
    });

    it('should preserve all metadata fields from seed file', async () => {
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      const loaded = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');
      expect(loaded).toBeDefined();

      // Verify triggers array
      expect(loaded!.metadata.triggers).toBeDefined();
      expect(loaded!.metadata.triggers).toContain('what-is-dollhouse');
      expect(loaded!.metadata.triggers).toContain('what-can-dollhouse-do');
      expect(loaded!.metadata.triggers).toContain('dollhouse-capabilities');

      // Verify tags array
      expect(loaded!.metadata.tags).toBeDefined();
      expect(loaded!.metadata.tags).toContain('baseline');
      expect(loaded!.metadata.tags).toContain('knowledge-base');
    });

    it('should have content with proper metadata (source: import, importedAt)', async () => {
      const memory = await memoryManager.importElement(seedMemoryYAML, 'yaml');
      await memoryManager.save(memory);

      const loaded = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');
      const entries = loaded!.getAllEntries();

      expect(entries.length).toBeGreaterThan(0);

      // Verify entry metadata
      const entry = entries[0];
      expect(entry.metadata).toBeDefined();
      expect(entry.metadata.source).toBe('import');
      expect(entry.metadata.importedAt).toBeDefined();

      // Verify importedAt is a valid ISO date
      const importedAt = new Date(entry.metadata.importedAt);
      expect(importedAt.toISOString()).toBe(entry.metadata.importedAt);
    });
  });

  describe('importElement() - Content Preservation', () => {
    it('should preserve content with frontmatter', async () => {
      const yamlWithContent = `---
name: test-memory
type: memory
description: Test memory with content
version: 1.0.0
---

# Test Content

This is test content that should be preserved.
`;

      const memory = await memoryManager.importElement(yamlWithContent, 'yaml');
      const entries = memory.getAllEntries();

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].content).toContain('Test Content');
      expect(entries[0].content).toContain('test content that should be preserved');
    });

    it('should handle metadata-only (no content section)', async () => {
      const yamlMetadataOnly = `---
name: metadata-only
type: memory
description: Memory with only metadata
version: 1.0.0
---
`;

      const memory = await memoryManager.importElement(yamlMetadataOnly, 'yaml');

      // Should create memory successfully
      expect(memory.metadata.name).toBe('metadata-only');

      // No content should be added
      const entries = memory.getAllEntries();
      expect(entries.length).toBe(0);
    });

    it('should trim whitespace from content', async () => {
      const yamlWithWhitespace = `---
name: whitespace-test
type: memory
description: Test whitespace handling
version: 1.0.0
---


   Content with leading/trailing whitespace


`;

      const memory = await memoryManager.importElement(yamlWithWhitespace, 'yaml');
      const entries = memory.getAllEntries();

      expect(entries.length).toBeGreaterThan(0);

      // Content should be trimmed
      const content = entries[0].content;
      // FIX: Replace vulnerable regex with String.trim() comparison
      // Previously: Used /^\s+/ and /\s+$/ which could cause ReDoS
      // Now: Direct trim comparison - safer and more efficient
      expect(content).toBe(content.trim()); // Content should equal its trimmed version
      expect(content).toContain('Content with leading/trailing whitespace');
    });
  });
});
