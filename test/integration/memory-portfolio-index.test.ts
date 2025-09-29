/**
 * Integration test for Issue #1188 - Memory indexing in PortfolioIndexManager
 * Verifies that memories in date folders are properly indexed
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PortfolioIndexManager } from '../../src/portfolio/PortfolioIndexManager.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../src/portfolio/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Helper function for flexible name matching
const normalizeMemoryName = (name: string): string => {
  return name.replaceAll(/[\s-]/g, '-').toLowerCase();
};

const findMemoryByName = (
  memories: any[],
  expectedName: string
): any => {
  const normalized = normalizeMemoryName(expectedName);
  return memories.find(m =>
    normalizeMemoryName(m.metadata.name) === normalized
  );
};

describe('PortfolioIndexManager Memory Indexing (Issue #1188)', () => {
  let tempDir: string;
  let originalHomeDir: string;
  let originalPortfolioDir: string | undefined;
  let indexManager: PortfolioIndexManager;
  const DEBUG_TESTS = process.env.DEBUG_TESTS === 'true';

  beforeAll(async () => {
    // Create temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portfolio-test-'));

    // Save original environment variables
    originalHomeDir = process.env.HOME || '';
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Override environment BEFORE any singleton initialization
    // This ensures PortfolioManager uses our test directory
    process.env.HOME = tempDir;
    process.env.DOLLHOUSE_PORTFOLIO_DIR = path.join(tempDir, '.dollhouse', 'portfolio');

    // Create portfolio structure with memories
    const memoriesDir = path.join(tempDir, '.dollhouse', 'portfolio', 'memories');
    const dateFolder = path.join(memoriesDir, '2025-09-28');
    await fs.mkdir(dateFolder, { recursive: true });

    // Create a test memory in date folder with proper YAML format
    // Memory files have metadata at root level, not nested
    const testMemoryYAML = `name: test-memory-index
description: Test memory for index verification
version: 1.0.0
tags:
  - test
  - index
triggers:
  - recall
  - remember
entries:
  - content: Test content for memory indexing`;

    await fs.writeFile(
      path.join(dateFolder, 'test-memory-index.yaml'),
      testMemoryYAML
    );

    // Create a root memory (legacy) with proper YAML format
    const legacyMemoryYAML = `name: legacy-memory
description: Legacy memory in root
tags:
  - legacy`;

    await fs.writeFile(
      path.join(memoriesDir, 'legacy-memory.yaml'),
      legacyMemoryYAML
    );

    // Create a sharded memory in a subdirectory
    const shardedMemoryDir = path.join(dateFolder, 'large-sharded-memory');
    await fs.mkdir(shardedMemoryDir, { recursive: true });

    // Create metadata file for sharded memory
    // Memory files have metadata at root level, not nested
    const shardedMetadataYAML = `name: large-sharded-memory
description: Large memory stored in shards
version: 1.0.0
tags:
  - large
  - sharded
triggers:
  - process
  - analyze
shardInfo:
  totalShards: 3
  maxShardSize: 1048576`;

    await fs.writeFile(
      path.join(shardedMemoryDir, 'metadata.yaml'),
      shardedMetadataYAML
    );

    // Create a couple of shard files
    await fs.writeFile(
      path.join(shardedMemoryDir, 'shard-001.yaml'),
      'entries:\n  - content: First shard content'
    );

    await fs.writeFile(
      path.join(shardedMemoryDir, 'shard-002.yaml'),
      'entries:\n  - content: Second shard content'
    );

    // Reset singleton instances for clean test
    // MUST reset PortfolioManager first since PortfolioIndexManager depends on it
    // Test isolation: Direct instance reset is acceptable for test code
    (PortfolioManager as any).instance = null;
    (PortfolioIndexManager as any).instance = null;

    // Now get fresh instances with test environment
    indexManager = PortfolioIndexManager.getInstance();
  });

  afterAll(async () => {
    // Reset singleton instances to ensure clean state for next tests
    // Test isolation: Direct instance reset is acceptable for test code
    (PortfolioManager as any).instance = null;
    (PortfolioIndexManager as any).instance = null;

    // Restore environment variables
    process.env.HOME = originalHomeDir;
    // Fix: Avoid negated condition (SonarCloud)
    if (originalPortfolioDir === undefined) {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    } else {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    }

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to clean up temp directory:', error);
    }
  });

  it('should index memory files from date folders', async () => {
    // Rebuild index to scan our test memories
    await indexManager.rebuildIndex();

    // Get the index
    const index = await indexManager.getIndex();

    // Check that memories are indexed
    const memories = index.byType.get(ElementType.MEMORY) || [];

    // Debug logging (only when DEBUG_TESTS is enabled)
    if (DEBUG_TESTS) {
      console.log('Found memories count:', memories.length);
      console.log('Memory names:', memories.map(m => m.metadata.name));
    }

    // Should find all three memories (test, legacy, sharded)
    expect(memories.length).toBeGreaterThanOrEqual(3);

    // Find our test memory using flexible name matching
    const testMemory = findMemoryByName(memories, 'test-memory-index');
    expect(testMemory).toBeDefined();
    expect(testMemory?.metadata.description).toBe('Test memory for index verification');
    expect(testMemory?.metadata.tags).toContain('test');
    expect(testMemory?.metadata.tags).toContain('index');
    expect(testMemory?.metadata.triggers).toContain('recall');

    // Find legacy memory
    const legacyMemory = memories.find(m => m.metadata.name === 'legacy-memory');
    expect(legacyMemory).toBeDefined();
    expect(legacyMemory?.metadata.tags).toContain('legacy');
  });

  it('should support finding memories by name', async () => {
    // Try finding with original name or transformed name
    const found = await indexManager.findByName('test-memory-index') ||
                  await indexManager.findByName('test memory index');
    expect(found).toBeDefined();
    // Verify name matches expected pattern (with hyphens or spaces)
    if (found) {
      expect(normalizeMemoryName(found.metadata.name)).toBe(
        normalizeMemoryName('test-memory-index')
      );
    }
    expect(found?.elementType).toBe(ElementType.MEMORY);
  });

  it('should support searching memories', async () => {
    const results = await indexManager.search('test memory', {
      elementType: ElementType.MEMORY
    });

    expect(results.length).toBeGreaterThan(0);
    const testResult = results.find(r => r.entry.metadata.name === 'test-memory-index');
    expect(testResult).toBeDefined();
  });

  it('should index memory triggers for verb-based search', async () => {
    const index = await indexManager.getIndex();

    // Check trigger index
    const recallTriggers = index.byTrigger.get('recall') || [];
    const memoryWithRecall = recallTriggers.find(e =>
      e.elementType === ElementType.MEMORY &&
      normalizeMemoryName(e.metadata.name) === normalizeMemoryName('test-memory-index')
    );

    expect(memoryWithRecall).toBeDefined();
  });

  it('should handle empty memory files gracefully', async () => {
    // Create an empty memory file
    const emptyMemoryPath = path.join(tempDir, '.dollhouse', 'portfolio', 'memories', '2025-09-28', 'empty-memory.yaml');
    await fs.writeFile(emptyMemoryPath, '');

    // Rebuild index
    await indexManager.rebuildIndex();
    const index = await indexManager.getIndex();
    const memories = index.byType.get(ElementType.MEMORY) || [];

    // Should still index other memories even if one is empty
    expect(memories.length).toBeGreaterThan(0);

    // Empty file should not crash the indexer
    const emptyMemory = memories.find(m => m.metadata.name === 'empty-memory');
    // It might create a default entry or skip it entirely - both are acceptable
    if (emptyMemory) {
      expect(emptyMemory.metadata.name).toBeDefined();
    }
  });

  it('should handle malformed YAML gracefully', async () => {
    // Create a malformed YAML file
    const malformedPath = path.join(tempDir, '.dollhouse', 'portfolio', 'memories', '2025-09-28', 'malformed.yaml');
    await fs.writeFile(malformedPath, `
name: malformed memory
tags: [unclosed bracket
description: "Unclosed quote
    `);

    // Rebuild index - should not crash
    await indexManager.rebuildIndex();
    const index = await indexManager.getIndex();
    const memories = index.byType.get(ElementType.MEMORY) || [];

    // Other memories should still be indexed
    expect(memories.length).toBeGreaterThan(0);

    // Malformed file should not appear in index
    const malformedMemory = memories.find(m => m.metadata.name === 'malformed memory');
    expect(malformedMemory).toBeUndefined();
  });

  it('should handle mixed metadata structures', async () => {
    // Create memory with metadata at different levels
    const mixedPath = path.join(tempDir, '.dollhouse', 'portfolio', 'memories', '2025-09-28', 'mixed-metadata.yaml');
    await fs.writeFile(mixedPath, `
# Top-level metadata (legacy style)
name: mixed-metadata-memory
description: Memory with mixed structure
tags:
  - mixed
  - structure

# Also has metadata key (newer style)
metadata:
  version: 2.0.0
  author: test-author

entries:
  - content: Test content
    `);

    await indexManager.rebuildIndex();

    const mixedMemory = await indexManager.findByName('mixed-metadata-memory');
    expect(mixedMemory).toBeDefined();
    expect(mixedMemory?.metadata.description).toBe('Memory with mixed structure');
    // Should prefer the metadata block for version
    expect(mixedMemory?.metadata.version).toBe('2.0.0');
  });

  it('should index sharded memories from subdirectories', async () => {
    const index = await indexManager.getIndex();
    const memories = index.byType.get(ElementType.MEMORY) || [];

    // Find the sharded memory using flexible name matching
    const shardedMemory = findMemoryByName(memories, 'large-sharded-memory') ||
                          memories.find(m => m.metadata.name === 'metadata');

    if (DEBUG_TESTS) {
      console.log('Sharded memory found:', shardedMemory?.metadata.name);
      console.log('Shard info:', shardedMemory?.shardInfo);
    }

    expect(shardedMemory).toBeDefined();
    expect(shardedMemory?.metadata.description).toBe('Large memory stored in shards');
    expect(shardedMemory?.metadata.tags).toContain('large');
    expect(shardedMemory?.metadata.tags).toContain('sharded');
    expect(shardedMemory?.metadata.keywords).toContain('sharded'); // Auto-added by indexer

    // Verify shard info was stored
    // Using type assertion for shardInfo access (memory-specific property)
    interface ShardedMemory {
      shardInfo?: {
        shardCount: number;
        shardDir: string;
      };
    }
    const shardInfo = (shardedMemory as ShardedMemory)?.shardInfo;
    expect(shardInfo).toBeDefined();
    // Expected: 3 files (metadata.yaml + shard-001.yaml + shard-002.yaml)
    const EXPECTED_SHARD_COUNT = 3;
    expect(shardInfo?.shardCount).toBe(EXPECTED_SHARD_COUNT);
    expect(shardInfo?.shardDir).toBe('2025-09-28/large-sharded-memory');
  });
});