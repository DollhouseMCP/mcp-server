/**
 * Unit tests for Memory trigger extraction (Issue #1124)
 * Verifies that MemoryManager properly extracts triggers from memory files
 * for Enhanced Index integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../src/elements/memories/Memory.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

    // Reset PortfolioManager singleton
    (PortfolioManager as any).instance = null;

    // Initialize manager
    memoryManager = new MemoryManager();
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
      expect(memory.metadata.triggers).toBeDefined();
      expect(Array.isArray(memory.metadata.triggers)).toBe(true);
      expect(memory.metadata.triggers).toContain('remember');
      expect(memory.metadata.triggers).toContain('recall');
      expect(memory.metadata.triggers).toContain('retrieve');
      expect(memory.metadata.triggers).toContain('context');
      expect(memory.metadata.triggers).toContain('history');
      expect(memory.metadata.triggers).toContain('recollect');
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
      expect(memory.metadata.triggers).toBeDefined();
      expect(Array.isArray(memory.metadata.triggers)).toBe(true);
      expect(memory.metadata.triggers).toHaveLength(0);
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
      expect(memory.metadata.triggers).toBeDefined();
      memory.metadata.triggers?.forEach(trigger => {
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
      });

      // Add a test entry
      await memory.addEntry('Test content for save', ['test']);

      // Save the memory
      const saveFile = 'saved-memory.yaml';
      await memoryManager.save(memory, saveFile);

      // Load it back and verify triggers were preserved
      const loadedMemory = await memoryManager.load(saveFile);

      expect(loadedMemory.metadata.triggers).toBeDefined();
      expect(loadedMemory.metadata.triggers).toContain('remember');
      expect(loadedMemory.metadata.triggers).toContain('recall');
      expect(loadedMemory.metadata.triggers).toContain('retrieve');
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
      expect(memory.metadata.triggers).toEqual([
        'remember', 'recall', 'retrieve', 'context', 'history', 'recollect'
      ]);

      // Common memory-related verbs should be included
      const commonMemoryVerbs = ['remember', 'recall', 'retrieve'];
      commonMemoryVerbs.forEach(verb => {
        expect(memory.metadata.triggers).toContain(verb);
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
      });

      expect(memory.metadata.triggers).toBeDefined();
      recommendedVerbs.forEach(verb => {
        expect(memory.metadata.triggers).toContain(verb);
      });
    });
  });
});