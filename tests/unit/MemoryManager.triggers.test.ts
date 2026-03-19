/**
 * Unit tests for Memory trigger extraction (Issue #1124)
 * Verifies that MemoryManager properly extracts triggers from memory files
 * for Enhanced Index integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Memory, MemoryMetadata } from '../../src/elements/memories/Memory.js';
import { createRealMemoryManager, createTestMetadataService } from '../helpers/di-mocks.js';
import type { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import type { MetadataService } from '../../src/services/MetadataService.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create a shared MetadataService instance for all tests
const metadataService: MetadataService = createTestMetadataService();

describe('MemoryManager - Trigger Extraction', () => {
  let memoryManager: MemoryManager;
  let testDir: string;
  let memoriesDir: string;
  let originalPortfolioDir: string | undefined;

  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-triggers-test-'));
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });

    // Save original portfolio dir
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Set test directory as portfolio dir
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Initialize MemoryManager using factory function
    memoryManager = createRealMemoryManager(testDir);
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
    const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(memoriesDir, entry.name);
      if (entry.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }
    }
  });

  describe('parseMemoryFile', () => {
    it('should extract triggers from memory metadata', async () => {
      // Copy fixture to memories directory
      const fixtureContent = await fs.readFile(
        path.join(__dirname, '../fixtures/memory-with-triggers.yaml'),
        'utf-8'
      );
      const testFile = path.join(memoriesDir, 'test-memory.yaml');
      await fs.writeFile(testFile, fixtureContent);

      // Load the memory with triggers (use basename)
      const memory = await memoryManager.load('test-memory.yaml');

      // Verify metadata was loaded correctly
      expect(memory.metadata.name).toBe('test-memory-triggers');
      expect(memory.metadata.description).toBe('Test memory with triggers for Enhanced Index');

      // Verify triggers were extracted
      const metadata = memory.metadata as MemoryMetadata;
      expect(metadata.triggers).toBeDefined();
      expect(Array.isArray(metadata.triggers)).toBe(true);
      expect(metadata.triggers).toContain('remember');
      expect(metadata.triggers).toContain('recall');
      expect(metadata.triggers).toContain('retrieve');
      expect(metadata.triggers).toContain('context');
      expect(metadata.triggers).toContain('history');
      expect(metadata.triggers).toContain('recollect');
    });

    it('should handle memories without triggers field', async () => {
      // Create a memory without triggers
      const memoryWithoutTriggers = `metadata:
  name: "memory-no-triggers"
  description: "Memory without triggers field"
  version: "1.0.0"

entries:
  - id: "entry-1"
    timestamp: "2025-09-26T16:00:00Z"
    content: "Test entry"`;

      const noTriggersFile = path.join(memoriesDir, 'no-triggers.yaml');
      await fs.writeFile(noTriggersFile, memoryWithoutTriggers);

      const memory = await memoryManager.load('no-triggers.yaml');

      // Should have empty triggers array
      expect((memory.metadata as MemoryMetadata).triggers).toBeDefined();
      expect(Array.isArray((memory.metadata as MemoryMetadata).triggers)).toBe(true);
      expect((memory.metadata as MemoryMetadata).triggers).toHaveLength(0);
    });

    it('should sanitize trigger values', async () => {
      // Create a memory with potentially unsafe trigger values
      const memoryWithUnsafeTriggers = `metadata:
  name: "memory-unsafe-triggers"
  description: "Memory with unsafe triggers"
  triggers: ["<script>alert('xss')</script>", "valid-trigger", "another$#@!trigger"]
  version: "1.0.0"

entries: []`;

      const unsafeFile = path.join(memoriesDir, 'unsafe-triggers.yaml');
      await fs.writeFile(unsafeFile, memoryWithUnsafeTriggers);

      const memory = await memoryManager.load('unsafe-triggers.yaml');

      // Triggers should be sanitized
      expect((memory.metadata as MemoryMetadata).triggers).toBeDefined();
      (memory.metadata as MemoryMetadata).triggers?.forEach(trigger => {
        expect(trigger).not.toContain('<script>');
        expect(trigger).not.toContain('</script>');
      });
    });
  });

  describe('save', () => {
    it('should preserve triggers when saving memory', async () => {
      // Create a memory with triggers
      const memory = new Memory({
        name: 'save-test-memory',
        description: 'Test saving with triggers',
        triggers: ['remember', 'recall', 'retrieve']
      }, metadataService);

      // Add a test entry
      await memory.addEntry('Test content for save', ['test']);

      // Save the memory
      const saveFile = 'saved-memory.yaml';
      await memoryManager.save(memory, saveFile);

      // Load it back and verify triggers were preserved
      const loadedMemory = await memoryManager.load(saveFile);

      expect((loadedMemory.metadata as MemoryMetadata).triggers).toBeDefined();
      expect((loadedMemory.metadata as MemoryMetadata).triggers).toContain('remember');
      expect((loadedMemory.metadata as MemoryMetadata).triggers).toContain('recall');
      expect((loadedMemory.metadata as MemoryMetadata).triggers).toContain('retrieve');
    });
  });

  describe('Edge Cases', () => {
    it('should filter out triggers with invalid characters', async () => {
      const memoryWithInvalidTriggers = `metadata:
  name: "memory-invalid-chars"
  description: "Memory with invalid character triggers"
  triggers: ["valid-trigger", "invalid!@#", "another$test", "good_one", "bad space", "okay-dash"]
  version: "1.0.0"

entries: []`;

      await fs.writeFile(path.join(memoriesDir, 'invalid-chars.yaml'), memoryWithInvalidTriggers);
      const memory = await memoryManager.load('invalid-chars.yaml');

      // Should only include valid triggers (alphanumeric, hyphens, underscores)
      expect((memory.metadata as MemoryMetadata).triggers).toBeDefined();
      expect((memory.metadata as MemoryMetadata).triggers).toContain('valid-trigger');
      expect((memory.metadata as MemoryMetadata).triggers).toContain('good_one');
      expect((memory.metadata as MemoryMetadata).triggers).toContain('okay-dash');

      // Invalid triggers should be filtered out
      expect((memory.metadata as MemoryMetadata).triggers).not.toContain('invalid!@#');
      expect((memory.metadata as MemoryMetadata).triggers).not.toContain('another$test');
      expect((memory.metadata as MemoryMetadata).triggers).not.toContain('bad space');
    });

    it('should handle extremely long trigger lists', async () => {
      // Create a memory with many triggers
      const manyTriggers = Array.from({ length: 100 }, (_, i) => `trigger-${i}`);
      const memoryWithManyTriggers = `metadata:
  name: "memory-many-triggers"
  description: "Memory with many triggers"
  triggers: ${JSON.stringify(manyTriggers)}
  version: "1.0.0"

entries: []`;

      await fs.writeFile(path.join(memoriesDir, 'many-triggers.yaml'), memoryWithManyTriggers);
      const memory = await memoryManager.load('many-triggers.yaml');

      // Should handle all triggers without error, but limit to 20
      expect((memory.metadata as MemoryMetadata).triggers).toBeDefined();
      expect(Array.isArray((memory.metadata as MemoryMetadata).triggers)).toBe(true);
      expect((memory.metadata as MemoryMetadata).triggers?.length).toBe(20); // Limited to 20 triggers max
    });

    it('should truncate triggers that exceed maximum length', async () => {
      const longTrigger = 'a'.repeat(100); // Much longer than MAX_TAG_LENGTH
      const memoryWithLongTrigger = `metadata:
  name: "memory-long-trigger"
  description: "Memory with overly long trigger"
  triggers: ["short", "${longTrigger}"]
  version: "1.0.0"

entries: []`;

      await fs.writeFile(path.join(memoriesDir, 'long-trigger.yaml'), memoryWithLongTrigger);
      const memory = await memoryManager.load('long-trigger.yaml');

      // Long trigger should be truncated to MAX_TAG_LENGTH
      expect((memory.metadata as MemoryMetadata).triggers).toBeDefined();
      expect((memory.metadata as MemoryMetadata).triggers).toContain('short');

      // The long trigger should be truncated
      const truncatedTrigger = (memory.metadata as MemoryMetadata).triggers?.find(t => t !== 'short');
      expect(truncatedTrigger).toBeDefined();
      expect(truncatedTrigger?.length).toBeLessThanOrEqual(50); // MAX_TAG_LENGTH default
    });

    it('should handle mixed valid and invalid trigger types', async () => {
      const memoryWithMixedTypes = `metadata:
  name: "memory-mixed-types"
  description: "Memory with mixed trigger types"
  triggers: ["valid-string", 123, null, true, {"object": "value"}, ["array"], "another-valid"]
  version: "1.0.0"

entries: []`;

      await fs.writeFile(path.join(memoriesDir, 'mixed-types.yaml'), memoryWithMixedTypes);

      // Should not throw error, but only include valid string triggers
      const memory = await memoryManager.load('mixed-types.yaml');

      expect((memory.metadata as MemoryMetadata).triggers).toBeDefined();
      expect((memory.metadata as MemoryMetadata).triggers).toContain('valid-string');
      expect((memory.metadata as MemoryMetadata).triggers).toContain('another-valid');
      // Numbers get converted to strings "123", booleans to "true", null becomes "null", objects/arrays become "[object Object]" and "array"
      expect((memory.metadata as MemoryMetadata).triggers).toContain('123');
      expect((memory.metadata as MemoryMetadata).triggers).toContain('true');
      expect((memory.metadata as MemoryMetadata).triggers).toContain('null');
      expect((memory.metadata as MemoryMetadata).triggers).toContain('array'); // ["array"] becomes "array"
      // Note: {"object": "value"} becomes "[object Object]" which contains spaces and gets rejected
      expect((memory.metadata as MemoryMetadata).triggers?.length).toBe(6); // valid-string, 123, null, true, array, another-valid
    });
  });

  describe('Enhanced Index Integration', () => {
    it('should make triggers available for portfolio indexing', async () => {
      // Copy fixture to memories directory
      const fixtureContent = await fs.readFile(
        path.join(__dirname, '../fixtures/memory-with-triggers.yaml'),
        'utf-8'
      );
      await fs.writeFile(path.join(memoriesDir, 'test-memory.yaml'), fixtureContent);

      // Load memory with triggers
      const memory = await memoryManager.load('test-memory.yaml');

      // The metadata.triggers field should be available for PortfolioIndexManager
      // This is what the Enhanced Index will use to build action_triggers
      expect(memory.metadata).toHaveProperty('triggers');
      expect((memory.metadata as MemoryMetadata).triggers).toEqual([
        'remember', 'recall', 'retrieve', 'context', 'history', 'recollect'
      ]);

      // Common memory-related verbs should be included
      const commonMemoryVerbs = ['remember', 'recall', 'retrieve'];
      commonMemoryVerbs.forEach(verb => {
        expect((memory.metadata as MemoryMetadata).triggers).toContain(verb);
      });
    });

    it('should support recommended memory trigger verbs', async () => {
      // Test that common memory verbs work as triggers
      const recommendedVerbs = [
        'remember',
        'recall',
        'retrieve',
        'recollect',
        'find',
        'search',
        'lookup',
        'history',
        'context',
        'past'
      ];

      const memory = new Memory({
        name: 'verb-test-memory',
        description: 'Test memory with recommended verbs',
        triggers: recommendedVerbs
      }, metadataService);

      expect((memory.metadata as MemoryMetadata).triggers).toBeDefined();
      recommendedVerbs.forEach(verb => {
        expect((memory.metadata as MemoryMetadata).triggers).toContain(verb);
      });
    });
  });
});