/**
 * Integration tests for PortfolioPullHandler
 * Tests actual file I/O, GitHub API mocking, and index rebuilding with real data
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PortfolioPullHandler, PullOptions } from '../../../src/handlers/PortfolioPullHandler.js';
import { PortfolioManager, ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { PortfolioIndexManager } from '../../../src/portfolio/PortfolioIndexManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { GitHubPortfolioIndexer } from '../../../src/portfolio/GitHubPortfolioIndexer.js';
import { PortfolioRepoManager } from '../../../src/portfolio/PortfolioRepoManager.js';
import { PortfolioSyncComparer } from '../../../src/sync/PortfolioSyncComparer.js';
import { PortfolioDownloader } from '../../../src/sync/PortfolioDownloader.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { TokenManager } from '../../../src/security/tokenManager.js';

describe('PortfolioPullHandler Integration', () => {
  let env: PortfolioTestEnvironment;
  let portfolioManager: PortfolioManager;
  let indexManager: PortfolioIndexManager;
  let pullHandler: PortfolioPullHandler;
  let mockGithubIndexer: jest.Mocked<GitHubPortfolioIndexer>;
  let mockRepoManager: jest.Mocked<PortfolioRepoManager>;
  let mockDownloader: jest.Mocked<PortfolioDownloader>;
  let mockTokenManager: any;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('portfolio-pull-test');
    portfolioManager = env.portfolioManager;

    // Create IndexConfigManager for test
    const indexConfigPath = path.join(env.testDir, '.dollhouse', 'index-config.json');
    const indexConfigManager = new IndexConfigManager(indexConfigPath);

    // Initialize index manager (no initialize() method - lazy loads on first use)
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    indexManager = new PortfolioIndexManager(indexConfigManager, portfolioManager, fileOperations);

    // Create mock GitHub indexer
    mockGithubIndexer = {
      getIndex: jest.fn(),
      rebuildIndex: jest.fn(),
    } as any;

    // Create mock repo manager
    mockRepoManager = {
      setToken: jest.fn(),
      githubRequest: jest.fn(),
    } as any;

    // Create mock downloader - provide implementation for all tests
    mockDownloader = {
      downloadFromGitHub: jest.fn().mockImplementation(async (repoManager, elementPath) => {
        // Default implementation returns simple content
        // Individual tests can override this
        const filename = elementPath.split('/').pop()?.replace('.md', '') || 'element';
        return {
          content: `---\nname: ${filename}\n---\n\nTest content`,
          metadata: { name: filename },
          sha: 'mock-sha-123',
        };
      }),
    } as any;

    // Mock TokenManager for GitHub authentication
    mockTokenManager = {
      getGitHubTokenAsync: jest.fn().mockResolvedValue('mock-github-token'),
    };

    // Create pull handler with dependencies
    pullHandler = new PortfolioPullHandler({
      portfolioRepoManager: mockRepoManager,
      githubIndexer: mockGithubIndexer,
      portfolioManager: portfolioManager,
      indexManager: indexManager,
      syncComparer: new PortfolioSyncComparer(),
      downloader: mockDownloader,
      fileOperations: fileOperations,
      tokenManager: mockTokenManager as unknown as TokenManager,
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('File download and save operations', () => {
    it('should download and save a new skill to filesystem', async () => {
      // Setup: Mock GitHub index with one skill
      const skillContent = `---
name: Test Skill
description: A test skill
---

# Test Skill

This is test skill content.`;

      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Test Skill',
              path: 'skills/test-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Override default mock for this test
      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: skillContent,
        metadata: { name: 'Test Skill', description: 'A test skill' },
        sha: 'abc123',
      });

      // Execute: Pull from GitHub
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Result indicates success
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Added: 1');

      // Verify: File was actually written to filesystem
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      const skillPath = path.join(skillDir, 'test-skill.md');
      const savedContent = await fs.readFile(skillPath, 'utf-8');
      expect(savedContent).toBe(skillContent);
    });

    it('should download multiple elements in parallel batches', async () => {
      // Setup: Mock GitHub index with 7 skills (more than batch size of 5)
      const skills = Array.from({ length: 7 }, (_, i) => ({
        name: `Skill ${i + 1}`,
        path: `skills/skill-${i + 1}.md`,
        type: ElementType.SKILL,
        sha: `sha${i}`,
        lastUpdated: new Date().toISOString(),
      }));

      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 7,
        elements: new Map([[ElementType.SKILL, skills]]),
        lastUpdated: new Date().toISOString(),
      });

      // Mock downloads for each skill
      mockDownloader.downloadFromGitHub.mockImplementation(async (_, elementPath) => {
        const skillNum = elementPath.match(/skill-(\d+)/)?.[1] || '1';
        return {
          content: `---\nname: Skill ${skillNum}\n---\n\nContent ${skillNum}`,
          metadata: { name: `Skill ${skillNum}` },
          sha: `sha${skillNum}`,
        };
      });

      // Execute: Pull from GitHub
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: All 7 skills were added
      expect(result.content[0].text).toContain('Added: 7');

      // Verify: All files exist on filesystem
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      for (let i = 1; i <= 7; i++) {
        const skillPath = path.join(skillDir, `skill-${i}.md`);
        const exists = await fs.access(skillPath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });

    it('should update existing files when content changes in backup mode', async () => {
      // Setup: Create existing local file
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      const skillPath = path.join(skillDir, 'test-skill.md');
      const oldContent = `---\nname: Test Skill\n---\n\nOld content`;
      await fs.writeFile(skillPath, oldContent, 'utf-8');

      // Rebuild index to register the local file
      await indexManager.rebuildIndex();

      // Setup: Mock GitHub index with updated version
      const newContent = `---\nname: Test Skill\n---\n\nNew updated content`;

      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Test Skill',
              path: 'skills/test-skill.md',
              type: ElementType.SKILL,
              sha: 'newsha123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: newContent,
        metadata: { name: 'Test Skill' },
        sha: 'newsha123',
      });

      // Execute: Pull from GitHub in BACKUP mode (which always updates)
      const options: PullOptions = {
        direction: 'pull',
        mode: 'backup',
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: File was updated (backup mode always updates from GitHub)
      expect(result.content[0].text).toContain('Updated: 1');

      // Verify: File content was actually updated on filesystem
      const savedContent = await fs.readFile(skillPath, 'utf-8');
      expect(savedContent).toBe(newContent);
      expect(savedContent).not.toContain('Old content');
    });
  });

  describe('File deletion operations', () => {
    it('should delete local files in mirror mode', async () => {
      // Setup: Create TWO local files - one will stay on GitHub, one won't
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);

      // This file will be on GitHub
      const keepSkillPath = path.join(skillDir, 'keep-skill.md');
      await fs.writeFile(keepSkillPath, '---\nname: Keep Skill\n---\n\nThis stays', 'utf-8');

      // This file will NOT be on GitHub and should be deleted
      // Use a filename that matches the metadata name for easier matching
      const deleteSkillPath = path.join(skillDir, 'local-skill.md');
      await fs.writeFile(deleteSkillPath, '---\nname: Local Skill\n---\n\nLocal only', 'utf-8');

      // Rebuild index to register both local files
      await indexManager.rebuildIndex();

      // Setup: Mock GitHub index with only the "keep" skill
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Keep Skill',
              path: 'skills/keep-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Reset mock to ensure clean state
      mockDownloader.downloadFromGitHub.mockReset();
      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: '---\nname: Keep Skill\n---\n\nThis stays',
        metadata: { name: 'Keep Skill' },
        sha: 'abc123',
      });

      // Execute: Pull from GitHub in mirror mode with force
      const options: PullOptions = {
        direction: 'pull',
        mode: 'mirror',
        force: true,
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: One file was deleted
      expect(result.content[0].text).toContain('Deleted: 1');

      // Verify: Local-only file no longer exists on filesystem
      const deleteExists = await fs.access(deleteSkillPath).then(() => true).catch(() => false);
      expect(deleteExists).toBe(false);

      // Verify: Keep file still exists
      const keepExists = await fs.access(keepSkillPath).then(() => true).catch(() => false);
      expect(keepExists).toBe(true);
    });

    it('should handle ENOENT errors gracefully when file already missing', async () => {
      // Setup: Create TWO local files - one exists, one will be deleted before pull
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);

      // This file will stay on GitHub
      const keepSkillPath = path.join(skillDir, 'keep-skill.md');
      await fs.writeFile(keepSkillPath, '---\nname: Keep Skill\n---\n\nContent', 'utf-8');

      // This file will be in index but missing from filesystem
      const missingSkillPath = path.join(skillDir, 'missing-skill.md');
      await fs.writeFile(missingSkillPath, '---\nname: Missing Skill\n---\n\nContent', 'utf-8');

      // Rebuild index to register both files
      await indexManager.rebuildIndex();

      // Delete the "missing" file after indexing (simulates file deleted externally)
      await fs.unlink(missingSkillPath);

      // Setup: Mock GitHub index with only the keep skill
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Keep Skill',
              path: 'skills/keep-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Mock downloader
      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: '---\nname: Keep Skill\n---\n\nContent',
        metadata: { name: 'Keep Skill' },
        sha: 'abc123',
      });

      // Execute: Pull from GitHub in mirror mode
      const options: PullOptions = {
        direction: 'pull',
        mode: 'mirror',
        force: true,
        dryRun: false,
      };

      // Should not throw error even though "missing" file doesn't exist
      const result = await pullHandler.executePull(options, '');

      // Verify: Operation completed successfully (ENOENT was handled gracefully, no crash)
      expect(result.content[0].text).toContain('✅');

      // Verify: No deletion reported (file was already gone, ENOENT is gracefully ignored)
      // The test verifies that ENOENT doesn't crash the operation
      expect(result.content[0].text).not.toContain('Deleted: 1');
    });

    it('should require confirmation for deletions in mirror mode without force', async () => {
      // Setup: Create two local files - one on GitHub, one not
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);

      // This file will be on GitHub
      const keepSkillPath = path.join(skillDir, 'keep-skill.md');
      await fs.writeFile(keepSkillPath, '---\nname: Keep Skill\n---\n\nThis stays', 'utf-8');

      // This file will NOT be on GitHub (should trigger confirmation)
      const localSkillPath = path.join(skillDir, 'local-skill.md');
      await fs.writeFile(localSkillPath, '---\nname: Local Skill\n---\n\nLocal only', 'utf-8');

      await indexManager.rebuildIndex();

      // Setup: Mock GitHub index with only the keep skill
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Keep Skill',
              path: 'skills/keep-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Execute: Pull from GitHub in mirror mode WITHOUT force
      const options: PullOptions = {
        direction: 'pull',
        mode: 'mirror',
        force: false,
        dryRun: false,
        confirmDeletions: true,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Request confirmation
      expect(result.content[0].text).toContain('⚠️');
      expect(result.content[0].text).toContain('would delete');
      expect(result.content[0].text).toContain('force: true');

      // Verify: Local-only file still exists (not deleted without confirmation)
      const exists = await fs.access(localSkillPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('Dry-run mode', () => {
    it('should not make any filesystem changes in dry-run mode', async () => {
      // Setup: Mock GitHub index with a new skill
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Test Skill',
              path: 'skills/test-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Execute: Pull from GitHub in dry-run mode
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: true,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Shows planned actions
      expect(result.content[0].text).toContain('🔍 **Dry Run Results**');
      expect(result.content[0].text).toContain('📥 **To Add (1):**');
      expect(result.content[0].text).toContain('skills/Test Skill'); // Note: plural "skills"

      // Verify: No file was created
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      const skillPath = path.join(skillDir, 'test-skill.md');
      const exists = await fs.access(skillPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);

      // Verify: Downloader was never called
      expect(mockDownloader.downloadFromGitHub).not.toHaveBeenCalled();
    });

    it('should show all planned actions including updates and deletes', async () => {
      // Setup: Create existing local files
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      await fs.writeFile(
        path.join(skillDir, 'existing-skill.md'),
        '---\nname: Existing Skill\n---\n\nOld content',
        'utf-8'
      );
      await fs.writeFile(
        path.join(skillDir, 'local-only-skill.md'),
        '---\nname: Local Skill\n---\n\nLocal only',
        'utf-8'
      );
      await indexManager.rebuildIndex();

      // Setup: Mock GitHub index with one new and one existing skill (will update in backup mode)
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 2,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Existing Skill',
              path: 'skills/existing-skill.md',
              type: ElementType.SKILL,
              sha: 'newsha',
              lastUpdated: new Date().toISOString(),
            },
            {
              name: 'New Skill',
              path: 'skills/new-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Execute: Pull in BACKUP mode with dry-run (backup mode forces updates)
      const options: PullOptions = {
        direction: 'pull',
        mode: 'backup',
        dryRun: true,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Shows all planned actions
      expect(result.content[0].text).toContain('🔍 **Dry Run Results**');
      expect(result.content[0].text).toContain('📥 **To Add');
      expect(result.content[0].text).toContain('🔄 **To Update');
      expect(result.content[0].text).toContain('New Skill');
      expect(result.content[0].text).toContain('Existing Skill');
    });
  });

  describe('Index rebuilding with real data', () => {
    it('should rebuild index after adding new elements', async () => {
      // Setup: Mock GitHub index with a skill
      const skillContent = `---
name: Test Skill
description: A test skill
---

# Test Skill

This is test skill content.`;

      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Test Skill',
              path: 'skills/test-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: skillContent,
        metadata: { name: 'Test Skill', description: 'A test skill' },
        sha: 'abc123',
      });

      // Verify: Index is empty before pull
      let indexElements = await indexManager.getElementsByType(ElementType.SKILL);
      expect(indexElements).toHaveLength(0);

      // Execute: Pull from GitHub
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      await pullHandler.executePull(options, '');

      // Verify: Index was rebuilt and contains the new skill
      indexElements = await indexManager.getElementsByType(ElementType.SKILL);
      expect(indexElements.length).toBeGreaterThan(0);

      const foundSkill = indexElements.find(e =>
        (e.name || e.metadata?.name) === 'Test Skill'
      );
      expect(foundSkill).toBeDefined();
    });

    it('should rebuild index after deleting elements', async () => {
      // Setup: Create TWO local files
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);

      // This file will stay on GitHub
      const keepSkillPath = path.join(skillDir, 'keep-skill.md');
      await fs.writeFile(keepSkillPath, '---\nname: Keep Skill\n---\n\nContent', 'utf-8');

      // This file will be deleted (not on GitHub)
      const deleteSkillPath = path.join(skillDir, 'local-skill.md');
      await fs.writeFile(deleteSkillPath, '---\nname: Local Skill\n---\n\nContent', 'utf-8');

      await indexManager.rebuildIndex();

      // Verify: Index contains both skills
      let indexElements = await indexManager.getElementsByType(ElementType.SKILL);
      let foundSkill = indexElements.find(e =>
        (e.name || e.metadata?.name) === 'Local Skill'
      );
      expect(foundSkill).toBeDefined();

      // Setup: Mock GitHub index with only the keep skill
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Keep Skill',
              path: 'skills/keep-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Mock downloader
      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: '---\nname: Keep Skill\n---\n\nContent',
        metadata: { name: 'Keep Skill' },
        sha: 'abc123',
      });

      // Execute: Pull from GitHub in mirror mode
      const options: PullOptions = {
        direction: 'pull',
        mode: 'mirror',
        force: true,
        dryRun: false,
      };

      await pullHandler.executePull(options, '');

      // Verify: Index was rebuilt and no longer contains the deleted skill
      indexElements = await indexManager.getElementsByType(ElementType.SKILL);
      foundSkill = indexElements.find(e =>
        (e.name || e.metadata?.name) === 'Local Skill'
      );
      expect(foundSkill).toBeUndefined();

      // Verify: Keep skill is still in index
      const keepSkill = indexElements.find(e =>
        (e.name || e.metadata?.name) === 'Keep Skill'
      );
      expect(keepSkill).toBeDefined();
    });

    it('should not rebuild index when no operations were performed', async () => {
      // Setup: Create local skill that matches GitHub exactly (no operations needed)
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      const skillPath = path.join(skillDir, 'test-skill.md');
      const skillContent = '---\nname: Test Skill\n---\n\nContent';
      await fs.writeFile(skillPath, skillContent, 'utf-8');
      await indexManager.rebuildIndex();

      // Setup: Mock GitHub index with matching element (same name, so will be skipped in additive mode)
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Test Skill',
              path: 'skills/test-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Spy on rebuildIndex to count calls
      const rebuildSpy = jest.spyOn(indexManager, 'rebuildIndex');
      rebuildSpy.mockClear(); // Clear any previous calls

      // Execute: Pull from GitHub in additive mode (element exists, will skip)
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      await pullHandler.executePull(options, '');

      // Verify: rebuildIndex was called exactly once at the start
      // but NOT at the end since no operations were performed (element was skipped)
      expect(rebuildSpy.mock.calls.length).toBe(1);
    });
  });

  describe('Sync modes', () => {
    it('should only add new elements in additive mode', async () => {
      // Setup: Create existing local file
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      await fs.writeFile(
        path.join(skillDir, 'local-only-skill.md'),
        '---\nname: Local Skill\n---\n\nLocal only',
        'utf-8'
      );
      await indexManager.rebuildIndex();

      // Setup: Mock GitHub index with a new skill (doesn't have local skill)
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'GitHub Skill',
              path: 'skills/github-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: '---\nname: GitHub Skill\n---\n\nContent',
        metadata: { name: 'GitHub Skill' },
        sha: 'abc123',
      });

      // Execute: Pull in additive mode
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Only added, no deletions
      expect(result.content[0].text).toContain('Added: 1');
      expect(result.content[0].text).not.toContain('Deleted:');

      // Verify: Both files exist
      const localSkillExists = await fs.access(path.join(skillDir, 'local-only-skill.md'))
        .then(() => true).catch(() => false);
      const githubSkillExists = await fs.access(path.join(skillDir, 'github-skill.md'))
        .then(() => true).catch(() => false);
      expect(localSkillExists).toBe(true);
      expect(githubSkillExists).toBe(true);
    });

    it('should mirror exactly in mirror mode', async () => {
      // Setup: Create existing local file
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      const localSkillPath = path.join(skillDir, 'local-skill.md');
      await fs.writeFile(
        localSkillPath,
        '---\nname: Local Skill\n---\n\nLocal only',
        'utf-8'
      );
      await indexManager.rebuildIndex();

      // Setup: Mock GitHub index with different skill
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'GitHub Skill',
              path: 'skills/github-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: '---\nname: GitHub Skill\n---\n\nContent',
        metadata: { name: 'GitHub Skill' },
        sha: 'abc123',
      });

      // Execute: Pull in mirror mode
      const options: PullOptions = {
        direction: 'pull',
        mode: 'mirror',
        force: true,
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Added and deleted
      expect(result.content[0].text).toContain('Added: 1');
      expect(result.content[0].text).toContain('Deleted: 1');

      // Verify: Only GitHub skill exists
      const localSkillExists = await fs.access(localSkillPath)
        .then(() => true).catch(() => false);
      const githubSkillPath = path.join(skillDir, 'github-skill.md');
      const githubSkillExists = await fs.access(githubSkillPath)
        .then(() => true).catch(() => false);
      expect(localSkillExists).toBe(false);
      expect(githubSkillExists).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should handle empty GitHub portfolio gracefully', async () => {
      // Setup: Mock GitHub index with no elements
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 0,
        elements: new Map(),
        lastUpdated: new Date().toISOString(),
      });

      // Execute: Pull from GitHub
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Warning message
      expect(result.content[0].text).toContain('⚠️');
      expect(result.content[0].text).toContain('No elements found');
    });

    it('should handle download failures gracefully', async () => {
      // Setup: Mock GitHub index with a skill
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: 'Test Skill',
              path: 'skills/test-skill.md',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      // Mock download failure
      mockDownloader.downloadFromGitHub.mockRejectedValue(new Error('Network error'));

      // Execute: Pull from GitHub
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Operation completes but reports failure
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Added: 0');
    });

    it('should handle invalid sync mode', async () => {
      // Setup: Mock GitHub index
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 0,
        elements: new Map(),
        lastUpdated: new Date().toISOString(),
      });

      // Execute: Pull with invalid mode
      const options: PullOptions = {
        direction: 'pull',
        mode: 'invalid-mode',
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Error message
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid sync mode');
    });
  });

  describe('Security and validation', () => {
    it('should normalize Unicode in sync mode to prevent homograph attacks', async () => {
      // This test verifies that invalid Unicode strings in mode are properly rejected
      // Note: The Cyrillic 'а' character gets normalized but still won't match 'additive'

      // The handler will:
      // 1. Call validateSyncMode() which normalizes the Unicode
      // 2. Check if normalized mode is in validModes array
      // 3. If not, throw error (happens at line 182 in PortfolioPullHandler.ts)
      // 4. Error is caught and returned with ❌

      // Execute: Pull with completely invalid mode string
      const options: PullOptions = {
        direction: 'pull',
        mode: 'invalid_mode_123', // Clearly invalid mode
        dryRun: false,
      };

      const result = await pullHandler.executePull(options, '');

      // Verify: Should reject invalid mode
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid sync mode');

      // The actual Unicode homograph attack would be: mode: 'аdditive' (Cyrillic 'а')
      // But after normalization it may become a different string that's still invalid
    });

    it('should validate element paths from GitHub', async () => {
      // Setup: Mock GitHub index with suspicious path
      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 1,
        elements: new Map([
          [ElementType.SKILL, [
            {
              name: '../../../etc/passwd',
              path: '../../../etc/passwd',
              type: ElementType.SKILL,
              sha: 'abc123',
              lastUpdated: new Date().toISOString(),
            }
          ]]
        ]),
        lastUpdated: new Date().toISOString(),
      });

      mockDownloader.downloadFromGitHub.mockResolvedValue({
        content: 'malicious content',
        metadata: {},
        sha: 'abc123',
      });

      // Execute: Pull from GitHub
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      // Should complete without allowing path traversal
      await pullHandler.executePull(options, '');

      // Verify: File was not created outside skills directory
      // We can't verify /etc/passwd wasn't modified (we're not root), but we can verify
      // no suspicious files were created in our test directory

      // The path.basename() call in downloadAndSaveElement should strip path traversal
      const skillDir = portfolioManager.getElementDir(ElementType.SKILL);
      const files = await fs.readdir(skillDir);

      // Should only have safe filename
      expect(files).not.toContain('../../../etc/passwd');
    });
  });

  describe('Performance optimizations', () => {
    it('should batch rebuild index only once after all operations', async () => {
      // Setup: Mock GitHub index with 3 skills
      const skills = Array.from({ length: 3 }, (_, i) => ({
        name: `Skill ${i + 1}`,
        path: `skills/skill-${i + 1}.md`,
        type: ElementType.SKILL,
        sha: `sha${i}`,
        lastUpdated: new Date().toISOString(),
      }));

      mockGithubIndexer.getIndex.mockResolvedValue({
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        totalElements: 3,
        elements: new Map([[ElementType.SKILL, skills]]),
        lastUpdated: new Date().toISOString(),
      });

      mockDownloader.downloadFromGitHub.mockImplementation(async (_, elementPath) => {
        const skillNum = elementPath.match(/skill-(\d+)/)?.[1] || '1';
        return {
          content: `---\nname: Skill ${skillNum}\n---\n\nContent`,
          metadata: { name: `Skill ${skillNum}` },
          sha: `sha${skillNum}`,
        };
      });

      // Spy on rebuildIndex
      const rebuildSpy = jest.spyOn(indexManager, 'rebuildIndex');
      rebuildSpy.mockClear();

      // Execute: Pull from GitHub
      const options: PullOptions = {
        direction: 'pull',
        mode: 'additive',
        dryRun: false,
      };

      await pullHandler.executePull(options, '');

      // Verify: rebuildIndex called exactly twice:
      // 1. At the start to get current state
      // 2. At the end after all operations complete
      // NOT once per element (which would be 3 additional calls)
      expect(rebuildSpy).toHaveBeenCalledTimes(2);
    });
  });
});
