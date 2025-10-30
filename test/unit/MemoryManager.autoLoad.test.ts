/**
 * Unit tests for Memory auto-load functionality (Issue #1430)
 * Verifies that MemoryManager properly identifies and loads memories marked for auto-load
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
      // Ensure directory exists first
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
    } catch (error) {
      // Directory doesn't exist or cleanup failed - this is expected and safe to ignore
      void error; // SonarCloud S2486: Intentionally ignored during test cleanup
      // Ensure directory exists for test (will be recreated if missing)
      await fs.mkdir(memoriesDir, { recursive: true });
    }

    // FIX #1430: Create new MemoryManager instance for each test
    // This ensures the date folder cache is fresh and not stale from previous tests
    memoryManager = new MemoryManager();
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

    it('should not overwrite existing seed memory', async () => {
      // Create a custom version of the seed memory
      const customContent = `---
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

This is a custom version that should not be overwritten.
`;
      await fs.writeFile(path.join(memoriesDir, 'dollhousemcp-baseline-knowledge.yaml'), customContent);

      // Try to install seed memories
      await memoryManager.installSeedMemories();

      // Verify the custom version was not overwritten
      const memories = await memoryManager.list();
      const seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();
      expect(seedMemory?.metadata.description).toBe('Custom version of baseline knowledge');
      expect(seedMemory?.metadata.version).toBe('2.0.0');
    });

    it('should not fail server startup if seed file is missing', async () => {
      // This test verifies graceful failure handling
      // Create a new MemoryManager with a path where seed file won't exist
      // The method should log a warning but not throw

      await expect(memoryManager.installSeedMemories()).resolves.not.toThrow();
    });

    it('should install seed memory in date-based folder', async () => {
      // Install seed memories
      await memoryManager.installSeedMemories();

      // Verify it was installed in a date folder
      const dateFolders = await fs.readdir(memoriesDir, { withFileTypes: true });
      const dateFolder = dateFolders.find(entry =>
        entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)
      );

      expect(dateFolder).toBeDefined();

      // Check that the seed file exists in the date folder
      if (dateFolder) {
        const filesInDateFolder = await fs.readdir(path.join(memoriesDir, dateFolder.name));
        const seedFile = filesInDateFolder.find(f => f.includes('dollhousemcp-baseline-knowledge'));
        expect(seedFile).toBeDefined();
      }
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
