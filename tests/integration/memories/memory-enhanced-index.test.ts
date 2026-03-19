/**
 * Integration test for Memory triggers with Enhanced Index
 * Verifies that memories with triggers appear in search_by_verb results
 * Issue #1124
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { ElementType } from '../../../src/portfolio/types.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { createIntegrationContainer, IntegrationContainer } from '../../helpers/integration-container.js';
import { EnhancedIndexManager } from '../../../src/portfolio/EnhancedIndexManager.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';

describe('Memory Enhanced Index Integration', () => {
  let testDir: string;
  let enhancedIndex: EnhancedIndexManager;
  let memoryManager: MemoryManager;
  let metadataService: MetadataService;
  let containerContext: IntegrationContainer;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-index-test-'));
    containerContext = await createIntegrationContainer({
      portfolioDir: path.join(testDir, '.dollhouse', 'portfolio')
    });

    const memoriesDir = path.join(containerContext.portfolioDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
    enhancedIndex = containerContext.container.resolve<EnhancedIndexManager>('EnhancedIndexManager');
    memoryManager = containerContext.container.resolve<MemoryManager>('MemoryManager');
    metadataService = containerContext.container.resolve<MetadataService>('MetadataService');

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
      }, metadataService);

      await memory.addEntry(memData.content, ['test']);

      // Use relative path for save (MemoryManager expects basename, not full path)
      await memoryManager.save(memory, `${memData.name}.yaml`);
    }

    // Force rebuild the Enhanced Index
    await enhancedIndex.getIndex({ forceRebuild: true });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await containerContext.dispose();

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('getElementsByAction', () => {
    it('should find memories with "remember" trigger', async () => {
      const results = await enhancedIndex.getElementsByAction('remember');

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);

      // Should find project-context and meeting-notes
      expect(results).toEqual(expect.arrayContaining([
        'project-context',
        'meeting-notes'
      ]));
    });

    it('should find memories with "recall" trigger', async () => {
      const results = await enhancedIndex.getElementsByAction('recall');

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results).toEqual(expect.arrayContaining([
        'project-context',
        'security-fixes'
      ]));
    });

    it('should find memories with "retrieve" trigger', async () => {
      const results = await enhancedIndex.getElementsByAction('retrieve');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results).toContain('meeting-notes');
    });

    it('should find memories with context-specific triggers', async () => {
      // Test project-specific trigger
      const projectResults = await enhancedIndex.getElementsByAction('project');
      expect(projectResults).toContain('project-context');

      // Test security-specific trigger
      const securityResults = await enhancedIndex.getElementsByAction('security');
      expect(securityResults).toContain('security-fixes');

      // Test meeting-specific trigger
      const meetingResults = await enhancedIndex.getElementsByAction('meetings');
      expect(meetingResults).toContain('meeting-notes');
    });

    it('should not find memories without matching triggers', async () => {
      const results = await enhancedIndex.getElementsByAction('nonexistent-verb');

      expect(results).toHaveLength(0);
    });
  });

  describe('action trigger index', () => {
    it('should list all memory triggers in action triggers', async () => {
      const index = await enhancedIndex.getIndex();
      const triggers = index.action_triggers;
      const memoryElements = index.elements[ElementType.MEMORY] ?? {};

      // Should include memory-specific triggers
      expect(triggers).toHaveProperty('remember');
      expect(triggers).toHaveProperty('recall');
      expect(triggers).toHaveProperty('retrieve');
      expect(triggers).toHaveProperty('context');
      expect(triggers).toHaveProperty('history');

      // Memories should be present in the index with correct casing
      expect(Object.keys(memoryElements)).toEqual(expect.arrayContaining([
        'project-context',
        'security-fixes',
        'meeting-notes'
      ]));

      // Check that memories are listed under these triggers
      expect(triggers.remember).toEqual(expect.arrayContaining([
        'project-context',
        'meeting-notes'
      ]));

      expect(triggers.recall).toEqual(expect.arrayContaining([
        'project-context',
        'security-fixes'
      ]));
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
        const results = await enhancedIndex.getElementsByAction(pattern.verb);

        pattern.expected.forEach(expectedName => {
          expect(results).toContain(expectedName);
        });
      }
    });

    it('should support multiple trigger words per memory', async () => {
      // project-context has multiple triggers
      const projectMemoryTriggers = ['remember', 'recall', 'context', 'project', 'decisions'];

      for (const trigger of projectMemoryTriggers) {
        const results = await enhancedIndex.getElementsByAction(trigger);
        expect(results).toContain('project-context');
      }
    });
  });
});
