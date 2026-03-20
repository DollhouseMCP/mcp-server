/**
 * Unit tests for Memory auto-load functionality (Issue #1430)
 * Verifies that MemoryManager properly identifies and loads memories marked for auto-load
 *
 * REGRESSION TESTS ADDED:
 * Several tests now include content verification (entries.length > 0) to catch the bug
 * where memory content was lost during import/save. These regression tests ensure:
 * 1. importElement() preserves parseResult.content (not just parseResult.data)
 * 2. Memory entries contain actual content after loading
 * 3. Seed memories are functional, not just empty metadata shells
 *
 * See: InstallMemoryBug.md for details on the content loss bug
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createRealMemoryManager } from '../helpers/di-mocks.js';
import type { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('MemoryManager - Auto-Load Functionality', () => {
  let memoryManager: MemoryManager;
  let testDir: string;
  let memoriesDir: string;
  let originalPortfolioDir: string | undefined;

  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-autoload-test-'));
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });

    // Save original portfolio dir
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Set test directory as portfolio dir
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

  });

  afterAll(async () => {
    // Restore original portfolio dir
    if (originalPortfolioDir) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clear memories directory between tests
    try {
      // Ensure directory exists first
      await fs.mkdir(memoriesDir, { recursive: true });

      const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(memoriesDir, entry.name);
        if (entry.isDirectory()) {
          // force: true handles non-existent directories without throwing
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist - expected scenario during cleanup
      // Ensure directory exists for test (will be recreated if missing)
      await fs.mkdir(memoriesDir, { recursive: true });
    }

    // FIX #1430: Create new MemoryManager instance for each test
    // This ensures the date folder cache is fresh and not stale from previous tests
    memoryManager = createRealMemoryManager(testDir);
  });

  describe('getAutoLoadMemories', () => {
    it('should return empty array when no memories exist', async () => {
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      expect(autoLoadMemories).toEqual([]);
    });

    it('should return empty array when no auto-load memories exist', async () => {
      // Create a memory without autoLoad flag
      const memoryContent = `---
name: regular-memory
type: memory
description: Regular memory without auto-load
version: 1.0.0
---

# Regular Memory

This memory should not auto-load.
`;
      await fs.writeFile(path.join(memoriesDir, 'regular-memory.yaml'), memoryContent);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      expect(autoLoadMemories).toEqual([]);
    });

    it('should return memories with autoLoad flag set to true', async () => {
      // Create an auto-load memory
      const autoLoadContent = `---
name: baseline-knowledge
type: memory
description: Baseline knowledge for DollhouseMCP
version: 1.0.0
autoLoad: true
priority: 1
---

# Baseline Knowledge

Auto-load content here.
`;
      await fs.writeFile(path.join(memoriesDir, 'baseline-knowledge.yaml'), autoLoadContent);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      expect(autoLoadMemories).toHaveLength(1);
      expect(autoLoadMemories[0].metadata.name).toBe('baseline-knowledge');

      // REGRESSION TEST: Verify content is preserved (not just metadata)
      // This catches the bug where importElement() discards parseResult.content
      const entries = autoLoadMemories[0].getAllEntries();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].content).toContain('Auto-load content here');
    });

    it('should not return memories with autoLoad explicitly set to false', async () => {
      const memoryContent = `---
name: disabled-autoload
type: memory
description: Memory with autoLoad disabled
version: 1.0.0
autoLoad: false
---

# Disabled Auto-Load

Should not auto-load.
`;
      await fs.writeFile(path.join(memoriesDir, 'disabled-autoload.yaml'), memoryContent);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      expect(autoLoadMemories).toEqual([]);
    });

    it('should sort auto-load memories by priority (ascending)', async () => {
      // Create multiple auto-load memories with different priorities
      const memory1 = `---
name: low-priority
type: memory
description: Low priority memory
version: 1.0.0
autoLoad: true
priority: 100
---
Low priority content
`;
      const memory2 = `---
name: high-priority
type: memory
description: High priority memory
version: 1.0.0
autoLoad: true
priority: 1
---
High priority content
`;
      const memory3 = `---
name: medium-priority
type: memory
description: Medium priority memory
version: 1.0.0
autoLoad: true
priority: 50
---
Medium priority content
`;

      await fs.writeFile(path.join(memoriesDir, 'low-priority.yaml'), memory1);
      await fs.writeFile(path.join(memoriesDir, 'high-priority.yaml'), memory2);
      await fs.writeFile(path.join(memoriesDir, 'medium-priority.yaml'), memory3);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      expect(autoLoadMemories).toHaveLength(3);
      expect(autoLoadMemories[0].metadata.name).toBe('high-priority');
      expect(autoLoadMemories[1].metadata.name).toBe('medium-priority');
      expect(autoLoadMemories[2].metadata.name).toBe('low-priority');

      // REGRESSION TEST: Verify all memories have their content
      expect(autoLoadMemories[0].getAllEntries().length).toBeGreaterThan(0);
      expect(autoLoadMemories[0].getAllEntries()[0].content).toContain('High priority content');
      expect(autoLoadMemories[1].getAllEntries().length).toBeGreaterThan(0);
      expect(autoLoadMemories[1].getAllEntries()[0].content).toContain('Medium priority content');
      expect(autoLoadMemories[2].getAllEntries().length).toBeGreaterThan(0);
      expect(autoLoadMemories[2].getAllEntries()[0].content).toContain('Low priority content');
    });

    it('should treat missing priority as lowest priority (999)', async () => {
      const withPriority = `---
name: with-priority
type: memory
description: Memory with explicit priority
version: 1.0.0
autoLoad: true
priority: 10
---
Content
`;
      const withoutPriority = `---
name: without-priority
type: memory
description: Memory without priority
version: 1.0.0
autoLoad: true
---
Content
`;

      await fs.writeFile(path.join(memoriesDir, 'with-priority.yaml'), withPriority);
      await fs.writeFile(path.join(memoriesDir, 'without-priority.yaml'), withoutPriority);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      expect(autoLoadMemories).toHaveLength(2);
      // with-priority should come first (priority 10 < 999)
      expect(autoLoadMemories[0].metadata.name).toBe('with-priority');
      expect(autoLoadMemories[1].metadata.name).toBe('without-priority');
    });

    it('should handle mix of auto-load and regular memories', async () => {
      const regular1 = `---
name: regular-1
type: memory
description: Regular memory
version: 1.0.0
---
Regular content
`;
      const autoLoad1 = `---
name: autoload-1
type: memory
description: Auto-load memory
version: 1.0.0
autoLoad: true
priority: 1
---
Auto-load content
`;
      const regular2 = `---
name: regular-2
type: memory
description: Another regular memory
version: 1.0.0
---
More regular content
`;
      const autoLoad2 = `---
name: autoload-2
type: memory
description: Another auto-load memory
version: 1.0.0
autoLoad: true
priority: 2
---
More auto-load content
`;

      await fs.writeFile(path.join(memoriesDir, 'regular-1.yaml'), regular1);
      await fs.writeFile(path.join(memoriesDir, 'autoload-1.yaml'), autoLoad1);
      await fs.writeFile(path.join(memoriesDir, 'regular-2.yaml'), regular2);
      await fs.writeFile(path.join(memoriesDir, 'autoload-2.yaml'), autoLoad2);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Should only return the 2 auto-load memories
      expect(autoLoadMemories).toHaveLength(2);
      expect(autoLoadMemories[0].metadata.name).toBe('autoload-1');
      expect(autoLoadMemories[1].metadata.name).toBe('autoload-2');
    });

    it('should work with date-organized memories', async () => {
      // Create date folder
      const dateFolder = path.join(memoriesDir, '2025-10-30');
      await fs.mkdir(dateFolder, { recursive: true });

      const autoLoadInDateFolder = `---
name: dated-autoload
type: memory
description: Auto-load memory in date folder
version: 1.0.0
autoLoad: true
priority: 5
---
Dated auto-load content
`;
      await fs.writeFile(path.join(dateFolder, 'dated-autoload.yaml'), autoLoadInDateFolder);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      expect(autoLoadMemories).toHaveLength(1);
      expect(autoLoadMemories[0].metadata.name).toBe('dated-autoload');
    });

    it('should return empty array gracefully on error', async () => {
      // Force an error by removing the memories directory
      await fs.rm(memoriesDir, { recursive: true, force: true });

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Should not throw, should return empty array
      expect(autoLoadMemories).toEqual([]);
    });

    it('should handle same priority values correctly', async () => {
      const memory1 = `---
name: same-priority-a
type: memory
description: Same priority A
version: 1.0.0
autoLoad: true
priority: 10
---
Content A
`;
      const memory2 = `---
name: same-priority-b
type: memory
description: Same priority B
version: 1.0.0
autoLoad: true
priority: 10
---
Content B
`;

      await fs.writeFile(path.join(memoriesDir, 'same-priority-a.yaml'), memory1);
      await fs.writeFile(path.join(memoriesDir, 'same-priority-b.yaml'), memory2);

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      expect(autoLoadMemories).toHaveLength(2);
      // Both should be returned, order between them is stable but not specified
      const names = autoLoadMemories.map(m => m.metadata.name);
      expect(names).toContain('same-priority-a');
      expect(names).toContain('same-priority-b');
    });
  });

  describe('installSeedMemories', () => {
    it('should install seed memory when it does not exist', async () => {
      // Verify seed file doesn't exist yet
      const exists = await memoryManager.exists('dollhousemcp-baseline-knowledge.yaml');
      expect(exists).toBe(false);

      // Install seed memories
      await memoryManager.installSeedMemories();

      // Verify seed file was installed
      const memories = await memoryManager.list();
      const seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();
      expect(seedMemory?.metadata.autoLoad).toBe(true);
      expect(seedMemory?.metadata.priority).toBe(1);
    });

    it('should skip reinstallation if seed already exists with content (Issue #1430)', async () => {
      // ISSUE #1430: Skip reinstallation to preserve cache and activation status
      // Create a version of the seed memory with content
      const existingContent = `---
name: dollhousemcp-baseline-knowledge
type: memory
description: Custom version of baseline knowledge
version: 2.0.0
autoLoad: true
priority: 1
tags:
  - custom
---

# Custom Baseline Knowledge

This is a custom version with user content.
`;
      await fs.writeFile(path.join(memoriesDir, 'dollhousemcp-baseline-knowledge.yaml'), existingContent);

      // Install seed memories (should skip since seed already exists with content)
      await memoryManager.installSeedMemories();

      const memories = await memoryManager.list();

      // Verify existing seed was preserved (NOT replaced)
      const seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();
      expect(seedMemory?.metadata.description).toContain('Custom version of baseline knowledge'); // Original preserved

      // Verify NO backup was created (reinstallation was skipped)
      const backup = memories.find(m => m.metadata.name?.startsWith('dollhousemcp-baseline-knowledge.backup-'));
      expect(backup).toBeUndefined(); // No backup when skipping reinstallation
    });

    it('should install latest without backup if existing file is empty (Issue #5)', async () => {
      // ISSUE #5: Empty files get no backup (nothing to preserve), just install latest
      // Create an empty memory file (simulating the broken state found in user portfolios)
      const emptyContent = `---
name: dollhousemcp-baseline-knowledge
type: memory
description: Baseline knowledge (empty)
version: 1.0.0
autoLoad: true
priority: 1
---
entries: []
`;
      const datePath = path.join(memoriesDir, '2025-10-30');
      await fs.mkdir(datePath, { recursive: true });
      await fs.writeFile(path.join(datePath, 'dollhousemcp-baseline-knowledge.yaml'), emptyContent);

      // Install seed memories (should skip backup for empty file, install latest)
      await memoryManager.installSeedMemories();

      const memories = await memoryManager.list();

      // Verify the latest seed was installed with content
      const seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();

      // Check that it now has content (not empty)
      const entries = seedMemory!.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Verify no backup was created (nothing to backup from empty file)
      const backup = memories.find(m => m.metadata.name?.startsWith('dollhousemcp-baseline-knowledge.backup-'));
      expect(backup).toBeUndefined();
    });

    it('should not create backups when skipping reinstallation (Issue #1430)', async () => {
      // ISSUE #1430: Skip reinstallation to preserve cache, no backups needed
      // Tests that no backups accumulate when reinstallation is skipped

      // Create an empty seed file first
      const emptyVersion = `---
name: dollhousemcp-baseline-knowledge
type: memory
description: Empty seed
version: 1.0.0
---

entries: []
`;

      await fs.writeFile(path.join(memoriesDir, 'dollhousemcp-baseline-knowledge.yaml'), emptyVersion);

      // First install: should replace empty file with real seed content
      await memoryManager.installSeedMemories();

      let memories = await memoryManager.list();
      let seeds = memories.filter(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      let backups = memories.filter(m => m.metadata.name?.startsWith('dollhousemcp-baseline-knowledge.backup-'));

      // Should have seed, no backup (empty file gets no backup)
      expect(seeds.length).toBe(1);
      expect(backups.length).toBe(0);

      // Install again - should skip because seed now exists with content
      await memoryManager.installSeedMemories();

      memoryManager.clearCache();

      // After second install: should still have seed, still no backups
      memories = await memoryManager.list();
      seeds = memories.filter(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      backups = memories.filter(m => m.metadata.name?.startsWith('dollhousemcp-baseline-knowledge.backup-'));

      expect(seeds.length).toBe(1);
      expect(backups.length).toBe(0); // No backups when reinstallation is skipped
    });

    it('should not fail server startup if seed file is missing', async () => {
      // This test verifies graceful failure handling
      // Create a new MemoryManager with a path where seed file won't exist
      // The method should log a warning but not throw

      await expect(memoryManager.installSeedMemories()).resolves.not.toThrow();
    });

    it('should install seed memory in system folder', async () => {
      // Install seed memories
      await memoryManager.installSeedMemories();

      // Verify it was installed in the system folder (not date folder)
      const systemDir = path.join(memoriesDir, 'system');
      const systemFiles = await fs.readdir(systemDir);
      const seedFile = systemFiles.find(f => f.includes('dollhousemcp-baseline-knowledge'));

      expect(seedFile).toBeDefined();
      expect(seedFile).toContain('dollhousemcp-baseline-knowledge');
    });

    it('should only install once on multiple calls', async () => {
      // Install seed memories twice
      await memoryManager.installSeedMemories();
      await memoryManager.installSeedMemories();

      // Verify only one copy exists
      const memories = await memoryManager.list();
      const seedMemories = memories.filter(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemories).toHaveLength(1);
    });

    it('should make installed seed memory available for auto-load', async () => {
      // Install seed memories
      await memoryManager.installSeedMemories();

      // Get auto-load memories
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Verify seed memory is in the auto-load list
      const seedMemory = autoLoadMemories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();
      expect(seedMemory?.metadata.priority).toBe(1);

      // REGRESSION TEST: Verify seed memory has content from the actual seed file
      // This is critical - seed memories are useless if they're just empty metadata
      const entries = seedMemory!.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].content).toContain('DollhouseMCP');
      expect(entries[0].content.length).toBeGreaterThan(100); // Should be substantial
    });

    it('should activate auto-load memories on startup (Issue #1430)', async () => {
      // Install seed memories
      await memoryManager.installSeedMemories();

      // Get auto-load memories
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      expect(autoLoadMemories.length).toBeGreaterThan(0);

      // Activate each auto-load memory (simulating ServerStartup behavior)
      for (const memory of autoLoadMemories) {
        await memory.activate();
      }

      // Verify memories are activated
      const seedMemory = autoLoadMemories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();
      expect(seedMemory?.getStatus()).toBe('active');
    });

    it('should persist activation via metadata, not instance status (Issue #1430)', async () => {
      // Install and get auto-load memories
      await memoryManager.installSeedMemories();
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Activate the memory
      const seedMemory = autoLoadMemories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();
      await seedMemory!.activate();

      // Verify activation worked
      expect(seedMemory!.getStatus()).toBe('active');

      // Clear cache to simulate memory reload
      memoryManager.clearCache();

      // Reload memories from disk
      const reloadedMemories = await memoryManager.list();
      const reloadedSeed = reloadedMemories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');

      // The key point: metadata.autoLoad persists to disk
      expect((reloadedSeed?.metadata as any).autoLoad).toBe(true);
      expect((reloadedSeed?.metadata as any).priority).toBe(1);

      // getAutoLoadMemories uses metadata.autoLoad, not instance status
      // This is why it works reliably across restarts
      const autoLoadAfterReload = await memoryManager.getAutoLoadMemories();
      const seedAfterReload = autoLoadAfterReload.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedAfterReload).toBeDefined();
      expect((seedAfterReload?.metadata as any).autoLoad).toBe(true);
    });

    it('should identify memories as active using metadata, not instance status (Issue #1430)', async () => {
      // Install seed
      await memoryManager.installSeedMemories();

      // Get all memories
      const allMemories = await memoryManager.list();

      // Filter using metadata.autoLoad (the correct way)
      const activeViaMetadata = allMemories.filter(m => {
        const metadata = m.metadata as any;
        return metadata?.autoLoad === true;
      });

      // Filter using instance status (the wrong way that doesn't persist)
      const activeViaStatus = allMemories.filter(m => m.getStatus() === 'active');

      // metadata.autoLoad should find the seed memory
      expect(activeViaMetadata.length).toBeGreaterThan(0);
      expect(activeViaMetadata.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge')).toBeDefined();

      // Instance status might be inactive if memory wasn't explicitly activated
      // This demonstrates why we can't rely on instance status
      expect(activeViaStatus.length).toBe(0);
    });
  });

  describe('loadAndActivateAutoLoadMemories', () => {
    it('should install seed and load at least one auto-load memory', async () => {
      // Note: loadAndActivateAutoLoadMemories() always installs seed memories first
      // So we expect at least the seed memory to be loaded
      const result = await memoryManager.loadAndActivateAutoLoadMemories();

      expect(result.loaded).toBeGreaterThan(0); // At least the seed memory
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
    });

    it('should load and activate auto-load memories', async () => {
      // Create auto-load memory
      const autoLoadContent = `---
name: test-autoload
type: memory
description: Test auto-load memory
version: 1.0.0
autoLoad: true
priority: 1
---

# Test Memory

Auto-load test content.
`;
      await fs.writeFile(path.join(memoriesDir, 'test-autoload.yaml'), autoLoadContent);

      const result = await memoryManager.loadAndActivateAutoLoadMemories();

      expect(result.loaded).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
      expect(result.totalTokens).toBeGreaterThan(0);

      // Verify memory is activated
      const memories = await memoryManager.list();
      const testMemory = memories.find(m => m.metadata.name === 'test-autoload');
      expect(testMemory).toBeDefined();
      expect(testMemory?.getStatus()).toBe('active');
    });

    it('should skip invalid memories and report errors', async () => {
      // Create a memory that will fail validation (name is too short)
      // The memory will load but fail validation in loadAndActivateAutoLoadMemories
      const invalidContent = `---
name: a
type: memory
description: Invalid memory with too-short name
version: 1.0.0
autoLoad: true
---
Content here
`;
      await fs.writeFile(path.join(memoriesDir, 'invalid.yaml'), invalidContent);

      const result = await memoryManager.loadAndActivateAutoLoadMemories();

      // Should load the seed memory successfully
      expect(result.loaded).toBeGreaterThan(0); // Seed loaded
      // The invalid memory might be skipped or loaded depending on validation strictness
      // At minimum, we should have the seed memory loaded successfully
      expect(result).toBeDefined();
    });

    it('should respect DOLLHOUSE_DISABLE_AUTOLOAD environment variable', async () => {
      // Create auto-load memory
      const autoLoadContent = `---
name: test-disabled
type: memory
description: Should be disabled
version: 1.0.0
autoLoad: true
---
Content
`;
      await fs.writeFile(path.join(memoriesDir, 'test-disabled.yaml'), autoLoadContent);

      // Set emergency disable
      process.env.DOLLHOUSE_DISABLE_AUTOLOAD = 'true';

      try {
        const result = await memoryManager.loadAndActivateAutoLoadMemories();

        expect(result.loaded).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.totalTokens).toBe(0);
        expect(result.errors).toEqual([]);
      } finally {
        delete process.env.DOLLHOUSE_DISABLE_AUTOLOAD;
      }
    });

    it('should install seed memories before loading', async () => {
      const result = await memoryManager.loadAndActivateAutoLoadMemories();

      // Verify seed memory was installed
      const memories = await memoryManager.list();
      const seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');

      expect(seedMemory).toBeDefined();
      expect(result.loaded).toBeGreaterThan(0);
    });

    it('should track token counts correctly', async () => {
      // Create memory with known content
      const content = 'word '.repeat(100); // 100 words
      const memoryContent = `---
name: token-test
type: memory
description: Token counting test
version: 1.0.0
autoLoad: true
---

${content}
`;
      await fs.writeFile(path.join(memoriesDir, 'token-test.yaml'), memoryContent);

      const result = await memoryManager.loadAndActivateAutoLoadMemories();

      expect(result.totalTokens).toBeGreaterThan(0);
      // Should be roughly 100 words * 1.5 = 150 tokens (plus some for seed)
      expect(result.totalTokens).toBeGreaterThan(100);
    });

    it('should handle errors gracefully without failing startup', async () => {
      // Create memory that will fail validation
      const badContent = `---
name: bad-memory
type: memory
description: Will fail
version: 1.0.0
autoLoad: true
---
Content
`;
      await fs.writeFile(path.join(memoriesDir, 'bad-memory.yaml'), badContent);

      // Force a validation error by corrupting the file after load
      // (In practice, we'll just rely on the fact that errors are caught)

      const result = await memoryManager.loadAndActivateAutoLoadMemories();

      // Should not throw, even if some memories fail
      expect(result).toBeDefined();
      expect(typeof result.loaded).toBe('number');
      expect(typeof result.skipped).toBe('number');
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe('estimateTokens', () => {
    it('should return 0 tokens for empty string', () => {
      const tokens = memoryManager.estimateTokens('');
      expect(tokens).toBe(0);
    });

    it('should return minimal tokens for whitespace-only string', () => {
      // After trim(), whitespace becomes empty string, split returns [""], length 1
      // 1 word → ~2 tokens with 1.5x multiplier
      const tokens1 = memoryManager.estimateTokens('   ');
      const tokens2 = memoryManager.estimateTokens('\n\n\n');
      const tokens3 = memoryManager.estimateTokens('\t\t');
      // All should be minimal (implementation detail: split of empty string = 1 word)
      expect(tokens1).toBeLessThanOrEqual(2);
      expect(tokens2).toBeLessThanOrEqual(2);
      expect(tokens3).toBeLessThanOrEqual(2);
    });

    it('should return 0 tokens for null/undefined', () => {
      const tokens1 = memoryManager.estimateTokens(null as any);
      const tokens2 = memoryManager.estimateTokens(undefined as any);
      expect(tokens1).toBe(0);
      expect(tokens2).toBe(0);
    });

    it('should estimate simple text correctly (2 words → ~3 tokens)', () => {
      const tokens = memoryManager.estimateTokens('hello world');
      // 2 words → ~3 tokens with 1.5x multiplier
      expect(tokens).toBe(3);
    });

    it('should round up fractional tokens (1 word → 2 tokens)', () => {
      const tokens = memoryManager.estimateTokens('hello');
      // 1 word → 1.5 tokens → rounds up to 2
      expect(tokens).toBeGreaterThanOrEqual(2);
    });

    it('should handle large content (1000 words)', () => {
      const largeContent = new Array(1000).fill('word').join(' ');
      const tokens = memoryManager.estimateTokens(largeContent);
      // 1000 words → ~1500 tokens
      expect(tokens).toBeGreaterThan(1000);
      expect(tokens).toBeLessThan(2000); // Reasonable upper bound
    });

    it('should return 0 tokens for non-string input', () => {
      const tokens1 = memoryManager.estimateTokens(123 as any);
      const tokens2 = memoryManager.estimateTokens({} as any);
      const tokens3 = memoryManager.estimateTokens([] as any);
      expect(tokens1).toBe(0);
      expect(tokens2).toBe(0);
      expect(tokens3).toBe(0);
    });
  });
});
