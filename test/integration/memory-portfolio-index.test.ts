/**
 * Integration test for Issue #1188 - Memory indexing in PortfolioIndexManager
 * Verifies that memories in date folders are properly indexed
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PortfolioIndexManager } from '../../src/portfolio/PortfolioIndexManager.js';
import { ElementType } from '../../src/portfolio/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('PortfolioIndexManager Memory Indexing (Issue #1188)', () => {
  let tempDir: string;
  let originalHomeDir: string;
  let indexManager: PortfolioIndexManager;

  beforeAll(async () => {
    // Create temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portfolio-test-'));

    // Save original home dir and override
    originalHomeDir = process.env.HOME || '';
    process.env.HOME = tempDir;

    // Create portfolio structure with memories
    const memoriesDir = path.join(tempDir, '.dollhouse', 'portfolio', 'memories');
    const dateFolder = path.join(memoriesDir, '2025-09-28');
    await fs.mkdir(dateFolder, { recursive: true });

    // Create a test memory in date folder with proper YAML format
    const testMemoryYAML = `metadata:
  name: test-memory-index
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

    // Reset singleton instance for clean test
    (PortfolioIndexManager as any).instance = null;
    indexManager = PortfolioIndexManager.getInstance();
  });

  afterAll(async () => {
    // Restore environment
    process.env.HOME = originalHomeDir;

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

    // Debug logging
    console.log('Found memories count:', memories.length);
    console.log('Memory names:', memories.map(m => m.metadata.name));

    // Should find both memories
    expect(memories.length).toBeGreaterThanOrEqual(2);

    // Find our test memory
    const testMemory = memories.find(m => m.metadata.name === 'test-memory-index');
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
    const found = await indexManager.findByName('test-memory-index');
    expect(found).toBeDefined();
    expect(found?.metadata.name).toBe('test-memory-index');
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
      e.metadata.name === 'test-memory-index'
    );

    expect(memoryWithRecall).toBeDefined();
  });
});