/**
 * Integration test for Memory triggers with Enhanced Index
 * Verifies that memories with triggers appear in search_by_verb results
 * Issue #1124
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { EnhancedIndexManager } from '../../src/portfolio/EnhancedIndexManager.js';
import { ElementType } from '../../src/portfolio/types.js';
import { Memory } from '../../src/elements/memories/Memory.js';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('Memory Enhanced Index Integration', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  let enhancedIndex: EnhancedIndexManager;
  let memoryManager: MemoryManager;
  let originalPortfolioDir: string;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-index-test-'));
    const portfolioDir = path.join(testDir, '.dollhouse', 'portfolio');
    const memoriesDir = path.join(portfolioDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });

    // Save original portfolio directory
    portfolioManager = PortfolioManager.getInstance();
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR || '';

    // Set test directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = portfolioDir;

    // Reset singletons to use new directory
    (PortfolioManager as any).instance = null;
    portfolioManager = PortfolioManager.getInstance();

    enhancedIndex = EnhancedIndexManager.getInstance();
    memoryManager = new MemoryManager();

    // Create test memories with different triggers
    const testMemories = [
      {
        name: 'project-context',
        description: 'Project context and decisions',
        triggers: ['remember', 'recall', 'context', 'project', 'decisions'],
        content: 'Important project decisions and context'
      },
      {
        name: 'security-fixes',
        description: 'Security fix history',
        triggers: ['recall', 'security', 'fixes', 'history', 'audit'],
        content: 'History of security fixes and patches'
      },
      {
        name: 'meeting-notes',
        description: 'Meeting notes and action items',
        triggers: ['retrieve', 'meetings', 'notes', 'actions', 'remember'],
        content: 'Notes from team meetings'
      }
    ];

    // Save test memories to portfolio
    for (const memData of testMemories) {
      const memory = new Memory({
        name: memData.name,
        description: memData.description,
        triggers: memData.triggers
      });

      await memory.addEntry(memData.content, ['test']);

      const memoryPath = path.join(memoriesDir, `${memData.name}.yaml`);
      await memoryManager.save(memory, memoryPath);
    }

    // Force rebuild the Enhanced Index
    await enhancedIndex.rebuild();
  });

  afterAll(async () => {
    // Restore original portfolio directory
    if (originalPortfolioDir) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }

    // Reset singletons
    (PortfolioManager as any).instance = null;
    (EnhancedIndexManager as any).instance = null;

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('search_by_verb', () => {
    it('should find memories with "remember" trigger', async () => {
      const results = await enhancedIndex.searchByVerb('remember');

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);

      // Should find project-context and meeting-notes
      const memoryResults = results.filter(r => r.type === ElementType.MEMORY);
      expect(memoryResults.length).toBeGreaterThanOrEqual(2);

      const names = memoryResults.map(r => r.name);
      expect(names).toContain('project-context');
      expect(names).toContain('meeting-notes');
    });

    it('should find memories with "recall" trigger', async () => {
      const results = await enhancedIndex.searchByVerb('recall');

      const memoryResults = results.filter(r => r.type === ElementType.MEMORY);
      expect(memoryResults.length).toBeGreaterThanOrEqual(2);

      const names = memoryResults.map(r => r.name);
      expect(names).toContain('project-context');
      expect(names).toContain('security-fixes');
    });

    it('should find memories with "retrieve" trigger', async () => {
      const results = await enhancedIndex.searchByVerb('retrieve');

      const memoryResults = results.filter(r => r.type === ElementType.MEMORY);
      expect(memoryResults.length).toBeGreaterThanOrEqual(1);

      const names = memoryResults.map(r => r.name);
      expect(names).toContain('meeting-notes');
    });

    it('should find memories with context-specific triggers', async () => {
      // Test project-specific trigger
      const projectResults = await enhancedIndex.searchByVerb('project');
      const projectMemories = projectResults.filter(r => r.type === ElementType.MEMORY);
      expect(projectMemories.some(m => m.name === 'project-context')).toBe(true);

      // Test security-specific trigger
      const securityResults = await enhancedIndex.searchByVerb('security');
      const securityMemories = securityResults.filter(r => r.type === ElementType.MEMORY);
      expect(securityMemories.some(m => m.name === 'security-fixes')).toBe(true);

      // Test meeting-specific trigger
      const meetingResults = await enhancedIndex.searchByVerb('meetings');
      const meetingMemories = meetingResults.filter(r => r.type === ElementType.MEMORY);
      expect(meetingMemories.some(m => m.name === 'meeting-notes')).toBe(true);
    });

    it('should not find memories without matching triggers', async () => {
      const results = await enhancedIndex.searchByVerb('nonexistent-verb');

      const memoryResults = results.filter(r => r.type === ElementType.MEMORY);
      expect(memoryResults).toHaveLength(0);
    });
  });

  describe('getActionTriggers', () => {
    it('should list all memory triggers in action triggers', async () => {
      const triggers = await enhancedIndex.getActionTriggers();

      // Should include memory-specific triggers
      expect(triggers).toHaveProperty('remember');
      expect(triggers).toHaveProperty('recall');
      expect(triggers).toHaveProperty('retrieve');
      expect(triggers).toHaveProperty('context');
      expect(triggers).toHaveProperty('history');

      // Check that memories are listed under these triggers
      if (triggers.remember) {
        const rememberTargets = triggers.remember;
        expect(rememberTargets.some(t => t.includes('project-context'))).toBe(true);
        expect(rememberTargets.some(t => t.includes('meeting-notes'))).toBe(true);
      }

      if (triggers.recall) {
        const recallTargets = triggers.recall;
        expect(recallTargets.some(t => t.includes('project-context'))).toBe(true);
        expect(recallTargets.some(t => t.includes('security-fixes'))).toBe(true);
      }
    });
  });

  describe('Memory-specific verb behavior', () => {
    it('should enable natural language memory recall', async () => {
      // Test common memory recall patterns
      const recallPatterns = [
        { verb: 'remember', expected: ['project-context', 'meeting-notes'] },
        { verb: 'recall', expected: ['project-context', 'security-fixes'] },
        { verb: 'retrieve', expected: ['meeting-notes'] }
      ];

      for (const pattern of recallPatterns) {
        const results = await enhancedIndex.searchByVerb(pattern.verb);
        const memoryNames = results
          .filter(r => r.type === ElementType.MEMORY)
          .map(r => r.name);

        pattern.expected.forEach(expectedName => {
          expect(memoryNames).toContain(expectedName);
        });
      }
    });

    it('should support multiple trigger words per memory', async () => {
      // project-context has multiple triggers
      const projectMemoryTriggers = ['remember', 'recall', 'context', 'project', 'decisions'];

      for (const trigger of projectMemoryTriggers) {
        const results = await enhancedIndex.searchByVerb(trigger);
        const hasProjectContext = results.some(
          r => r.type === ElementType.MEMORY && r.name === 'project-context'
        );
        expect(hasProjectContext).toBe(true);
      }
    });
  });
});