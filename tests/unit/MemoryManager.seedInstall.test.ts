/**
 * Unit tests for Memory seed installation functionality
 *
 * Tests the installSeedMemories() method to ensure:
 * 1. Seed memories are installed correctly
 * 2. Content is preserved (not just metadata)
 * 3. Memories are functional after installation
 *
 * IMPORTANT: This test prevents regression of the bug where memory content
 * was lost during import/save (only metadata was preserved).
 *
 * See: InstallMemoryBug.md for details
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { createRealMemoryManager } from '../helpers/di-mocks.js';
import type { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('MemoryManager - Seed Installation', () => {
  let memoryManager: MemoryManager;
  let portfolioManager: PortfolioManager;
  let testDir: string;
  let memoriesDir: string;
  let originalPortfolioDir: string | undefined;

  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-seed-test-'));
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });

    // Save original portfolio dir
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Set test directory as portfolio dir
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Reset PortfolioManager singleton
    (PortfolioManager as any).instance = null;
  });

  afterAll(async () => {
    // Restore original portfolio dir
    if (originalPortfolioDir) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }

    // Reset PortfolioManager singleton
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

    // Create fresh instances using factory function
    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: testDir });
    await portfolioManager.initialize();
    memoryManager = createRealMemoryManager(testDir, {
      portfolioManager,
      fileLockManager,
      fileOperationsService
    });
  });

  describe('installSeedMemories', () => {
    it('should install seed memory successfully', async () => {
      // Install seed memories
      await memoryManager.installSeedMemories();

      // Verify memory was created
      const memories = await memoryManager.list();
      expect(memories.length).toBeGreaterThan(0);

      const baselineMemory = memories.find(m =>
        m.metadata.name === 'dollhousemcp-baseline-knowledge'
      );
      expect(baselineMemory).toBeDefined();
    });

    it('should preserve memory metadata correctly', async () => {
      await memoryManager.installSeedMemories();

      const memories = await memoryManager.list();
      const baselineMemory = memories.find(m =>
        m.metadata.name === 'dollhousemcp-baseline-knowledge'
      );

      expect(baselineMemory).toBeDefined();
      expect(baselineMemory!.metadata.name).toBe('dollhousemcp-baseline-knowledge');
      expect(baselineMemory!.metadata.description).toContain('Baseline knowledge');
      expect(baselineMemory!.metadata.version).toBe('1.0.0');
      expect(baselineMemory!.metadata.author).toBe('DollhouseMCP');
    });

    it('should preserve memory content (NOT empty entries)', async () => {
      await memoryManager.installSeedMemories();

      const memories = await memoryManager.list();
      const baselineMemory = memories.find(m =>
        m.metadata.name === 'dollhousemcp-baseline-knowledge'
      );

      expect(baselineMemory).toBeDefined();

      // CRITICAL TEST: Verify entries exist and contain content
      const entries = baselineMemory!.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Verify the content is not empty
      const firstEntry = entries[0];
      expect(firstEntry.content).toBeDefined();
      expect(firstEntry.content.length).toBeGreaterThan(100); // Should have substantial content

      // Verify content contains expected information
      expect(firstEntry.content).toContain('DollhouseMCP');
      expect(firstEntry.content).toContain('MCP server');
    });

    it('should create searchable and accessible memory', async () => {
      await memoryManager.installSeedMemories();

      // Load the memory by name
      const loadedMemory = await memoryManager.load('dollhousemcp-baseline-knowledge.yaml');

      expect(loadedMemory).toBeDefined();
      expect(loadedMemory.metadata.name).toBe('dollhousemcp-baseline-knowledge');

      // Verify it has content
      const entries = loadedMemory.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should have autoLoad metadata set correctly', async () => {
      await memoryManager.installSeedMemories();

      const memories = await memoryManager.list();
      const baselineMemory = memories.find(m =>
        m.metadata.name === 'dollhousemcp-baseline-knowledge'
      );

      expect(baselineMemory).toBeDefined();
      expect((baselineMemory!.metadata as any).autoLoad).toBe(true);
      expect((baselineMemory!.metadata as any).priority).toBe(1);
    });

    it('should skip reinstallation if memory already exists (idempotency - Issue #1430)', async () => {
      // Install once
      await memoryManager.installSeedMemories();

      const firstInstallMemories = await memoryManager.list();
      const seeds1 = firstInstallMemories.filter(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      const backups1 = firstInstallMemories.filter(m => m.metadata.name?.startsWith('dollhousemcp-baseline-knowledge.backup-'));

      // First install should NOT create a backup (nothing to backup)
      expect(seeds1.length).toBe(1);
      expect(backups1.length).toBe(0);

      // Install again (ISSUE #1430: Skip reinstallation to preserve cache)
      await memoryManager.installSeedMemories();

      const secondInstallMemories = await memoryManager.list();
      const seeds2 = secondInstallMemories.filter(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      const backups2 = secondInstallMemories.filter(m => m.metadata.name?.startsWith('dollhousemcp-baseline-knowledge.backup-'));

      // Should still have only 1 seed (no duplication), NO backups (reinstallation skipped)
      expect(seeds2.length).toBe(1);
      expect(seeds1.length).toBe(seeds2.length); // Seed count stays the same
      expect(backups2.length).toBe(0); // No backups when reinstallation is skipped
    });

    it('should handle content with markdown formatting', async () => {
      await memoryManager.installSeedMemories();

      const memories = await memoryManager.list();
      const baselineMemory = memories.find(m =>
        m.metadata.name === 'dollhousemcp-baseline-knowledge'
      );

      const entries = baselineMemory!.getAllEntries();
      const content = entries[0].content;

      // Verify markdown elements are preserved
      expect(content).toMatch(/#.*DollhouseMCP/); // Headings
      expect(content).toMatch(/\*\*.*\*\*/); // Bold text
      expect(content).toContain('---'); // Horizontal rules
    });

    it('should create memory in system folder', async () => {
      await memoryManager.installSeedMemories();

      // Check that the system folder was created
      const systemDir = path.join(memoriesDir, 'system');
      const entries = await fs.readdir(systemDir);

      // Verify the seed memory file exists in the system folder
      const seedFile = entries.find(f => f.includes('dollhousemcp-baseline-knowledge'));
      expect(seedFile).toBeDefined();

      const memoryPath = path.join(systemDir, seedFile!);
      await expect(fs.access(memoryPath)).resolves.not.toThrow();
    });

    it('should preserve all metadata fields from seed file', async () => {
      await memoryManager.installSeedMemories();

      const memories = await memoryManager.list();
      const baselineMemory = memories.find(m =>
        m.metadata.name === 'dollhousemcp-baseline-knowledge'
      );

      const metadata = baselineMemory!.metadata as any;

      // Verify triggers
      expect(metadata.triggers).toBeDefined();
      expect(Array.isArray(metadata.triggers)).toBe(true);
      expect(metadata.triggers).toContain('what-is-dollhouse');

      // Verify tags
      expect(metadata.tags).toBeDefined();
      expect(Array.isArray(metadata.tags)).toBe(true);
      expect(metadata.tags).toContain('dollhousemcp');
      expect(metadata.tags).toContain('baseline-knowledge');
    });
  });

  describe('importElement - content preservation', () => {
    it('should preserve content when importing YAML with frontmatter', async () => {
      const yamlContent = `---
name: test-memory
type: memory
description: Test memory with content
version: 1.0.0
---

# Test Content

This is the markdown content that should be preserved.

## Section 1

Important information here.
`;

      const importedMemory = await memoryManager.importElement(yamlContent, 'yaml');

      expect(importedMemory).toBeDefined();
      expect(importedMemory.metadata.name).toBe('test-memory');

      // CRITICAL: Verify content was imported
      const entries = importedMemory.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].content).toContain('Test Content');
      expect(entries[0].content).toContain('Important information');
    });

    it('should handle memory with only metadata (no content)', async () => {
      const yamlContent = `---
name: metadata-only
type: memory
description: Memory with no content
version: 1.0.0
---`;

      const importedMemory = await memoryManager.importElement(yamlContent, 'yaml');

      expect(importedMemory).toBeDefined();
      expect(importedMemory.metadata.name).toBe('metadata-only');

      // Should have zero entries when there's no content
      const entries = importedMemory.getAllEntries();
      expect(entries.length).toBe(0);
    });

    it('should trim whitespace from content', async () => {
      const yamlContent = `---
name: whitespace-test
type: memory
description: Test whitespace handling
version: 1.0.0
---


# Content with extra whitespace


   `;

      const importedMemory = await memoryManager.importElement(yamlContent, 'yaml');

      const entries = importedMemory.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Content should be trimmed
      const content = entries[0].content;
      expect(content.startsWith('# Content')).toBe(true);
      expect(content.endsWith('whitespace')).toBe(true);
    });
  });
});
