/**
 * Portfolio Roundtrip E2E Tests
 *
 * These tests verify the complete portfolio workflow:
 * 1. Upload element to GitHub
 * 2. Delete element locally
 * 3. Pull from GitHub using PortfolioPullHandler
 * 4. Verify element was restored correctly
 *
 * NOTE: These tests require a GitHub token and are skipped if not configured.
 * To run these tests, create a .env.test.local file with TEST_GITHUB_TOKEN.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from '@jest/globals';
import { setupTestEnvironment, TestEnvironment } from './setup-test-env.js';
import { GitHubTestClient } from '../helpers/github-api-client.js';
import { createTestPersona, createTestSkill } from '../helpers/test-persona-factory.js';
import { PortfolioRepoManager } from '../../src/portfolio/PortfolioRepoManager.js';
import { PortfolioPullHandler, type PortfolioPullHandlerDependencies } from '../../src/handlers/PortfolioPullHandler.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { PortfolioIndexManager } from '../../src/portfolio/PortfolioIndexManager.js';
import { IndexConfigManager } from '../../src/portfolio/config/IndexConfig.js';
import { GitHubPortfolioIndexer } from '../../src/portfolio/GitHubPortfolioIndexer.js';
import { PortfolioSyncComparer } from '../../src/sync/PortfolioSyncComparer.js';
import { PortfolioDownloader } from '../../src/sync/PortfolioDownloader.js';
import { retryWithBackoff, retryIfRetryable } from './utils/retry.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { createRealTokenManager, createRealPortfolioRepoManager } from '../helpers/di-mocks.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { PullOptions } from '../../src/handlers/PortfolioPullHandler.js';

// Skip the entire test suite in CI environments to prevent conflicts
// UNLESS DOLLHOUSE_RUN_FULL_E2E is explicitly set to 'true'
const shouldRunE2E = process.env.DOLLHOUSE_RUN_FULL_E2E === 'true' || !process.env.CI;
const describeOrSkip = shouldRunE2E ? describe : describe.skip;

describeOrSkip('Portfolio Roundtrip E2E Tests', () => {
  let testEnv: TestEnvironment;
  let githubClient: GitHubTestClient;
  let repoManager: PortfolioRepoManager;
  let pullHandler: PortfolioPullHandler;
  let portfolioManager: PortfolioManager;
  let indexManager: PortfolioIndexManager;
  let uploadedFiles: string[] = [];
  let testDir: string;

  beforeAll(async () => {
    console.log('\n🚀 Starting portfolio roundtrip E2E tests...\n');

    // Setup and validate environment
    testEnv = await setupTestEnvironment();

    // Skip tests if no token available
    if (testEnv.skipTests) {
      console.log('⏭️  Skipping portfolio roundtrip tests - no token available');
      return;
    }

    // Initialize GitHub client
    githubClient = new GitHubTestClient(testEnv);

    // Create temporary test directory
    testDir = path.join(process.cwd(), 'temp-roundtrip-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });

    // Initialize portfolio manager with test directory
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });

    // Initialize index manager
    const indexConfigPath = path.join(testDir, '.dollhouse', 'index-config.json');
    const indexConfigManager = new IndexConfigManager(indexConfigPath);
    indexManager = new PortfolioIndexManager(indexConfigManager, portfolioManager, fileOperations);

    // Initialize token manager with real dependencies
    const tokenManager = createRealTokenManager(fileOperations);

    // Initialize repo manager with JUST the repo name (not "owner/repo")
    const repoName = testEnv.testRepo.split('/')[1];
    repoManager = createRealPortfolioRepoManager(tokenManager, repoName);
    repoManager.setToken(testEnv.githubToken);

    // Initialize GitHub indexer - pass the repoManager so it uses the same instance with the token
    const githubIndexer = new GitHubPortfolioIndexer(repoManager);

    // Initialize sync comparer
    const syncComparer = new PortfolioSyncComparer();

    // Initialize downloader
    const downloader = new PortfolioDownloader();

    // Initialize pull handler with all dependencies
    const dependencies: PortfolioPullHandlerDependencies = {
      portfolioRepoManager: repoManager,
      githubIndexer,
      portfolioManager,
      indexManager,
      syncComparer,
      downloader,
      fileOperations,
      tokenManager
    };
    pullHandler = new PortfolioPullHandler(dependencies);

    console.log(`\n📋 Test Configuration:`);
    console.log(`   Repository: ${testEnv.testRepo}`);
    console.log(`   User: ${testEnv.githubUser}`);
    console.log(`   Cleanup: ${testEnv.cleanupAfter ? 'Yes' : 'No'}`);
    console.log(`   Test Directory: ${testDir}`);
    console.log(`   Branch: ${testEnv.testBranch}\n`);
  }, 60000);

  beforeEach(async () => {
    // Ensure test directories exist before each test
    if (!testEnv.skipTests && testDir) {
      const personasDir = path.join(testDir, 'personas');
      const skillsDir = path.join(testDir, 'skills');
      await fs.mkdir(personasDir, { recursive: true });
      await fs.mkdir(skillsDir, { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up uploaded files from GitHub
    if (testEnv?.cleanupAfter && uploadedFiles.length > 0 && githubClient) {
      console.log(`\n🧹 Cleaning up ${uploadedFiles.length} test files from GitHub...`);
      for (const file of uploadedFiles) {
        try {
          await githubClient.deleteFile(file);
        } catch (error) {
          console.log(`     ⚠️  Failed to delete ${file}: ${error}`);
        }
      }
      uploadedFiles = [];
    }

    // Clean up local test directory
    if (testDir) {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }

      // Recreate for next test
      await fs.mkdir(testDir, { recursive: true });
    }
  });

  afterAll(async () => {
    // Final cleanup of test directory
    if (testDir) {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    console.log('\n✅ Portfolio roundtrip E2E tests completed\n');
  });

  describe('Persona Roundtrip', () => {
    it('should upload persona, delete locally, and restore from GitHub', async () => {
      if (testEnv.skipTests) {
        console.log('⏭️  Test skipped - no GitHub token');
        return;
      }

      console.log('\n▶️ Test: Complete persona roundtrip workflow');

      // Step 1: Create test persona
      console.log('  1️⃣ Creating test persona...');
      const testPersona = createTestPersona({
        author: testEnv.githubUser,
        prefix: testEnv.personaPrefix,
        name: `${testEnv.personaPrefix}roundtrip-persona-${Date.now()}`
      });

      // Step 2: Upload to GitHub
      console.log('  2️⃣ Uploading persona to GitHub...');
      const uploadResult = await retryIfRetryable(
        async () => await repoManager.saveElement(testPersona, true),
        {
          maxAttempts: 5,
          onRetry: (attempt, error) => console.log(`     ↻ Retry ${attempt} due to: ${error.message}`)
        }
      );

      expect(uploadResult).toBeTruthy();
      expect(uploadResult).toContain('github.com');
      console.log(`     ✅ Upload successful: ${uploadResult}`);

      // Track uploaded file for cleanup
      const fileName = PortfolioRepoManager.generateFileName(testPersona.metadata.name || 'unnamed');
      const githubPath = `personas/${fileName}.md`;
      uploadedFiles.push(githubPath);

      // Step 3: Verify file exists on GitHub
      console.log('  3️⃣ Verifying file exists on GitHub...');
      const githubFile = await retryWithBackoff(
        async () => {
          const file = await githubClient.getFile(githubPath);
          if (!file) {
            throw new Error(`File not found at ${githubPath}`);
          }
          return file;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          onRetry: (attempt, _error, delayMs) => {
            console.log(`     ⏳ Retry ${attempt}/3: Waiting ${delayMs}ms for GitHub to process file...`);
          }
        }
      );

      expect(githubFile).not.toBeNull();
      expect(githubFile?.content).toContain(testPersona.metadata.name);
      console.log(`     ✅ File verified at: ${githubPath}`);

      // Step 4: Save persona locally first (so we have something to delete)
      console.log('  4️⃣ Creating local copy of persona...');
      const localPath = path.join(testDir, 'personas', `${fileName}.md`);
      await fs.writeFile(localPath, githubFile!.content, 'utf-8');
      console.log(`     ✅ Local file created at: ${localPath}`);

      // Step 5: Delete local copy
      console.log('  5️⃣ Deleting local copy...');
      await fs.unlink(localPath);

      // Verify it's gone
      await expect(fs.access(localPath)).rejects.toThrow();
      console.log('     ✅ Local file deleted');

      // Step 6: Pull from GitHub to restore
      console.log('  6️⃣ Pulling from GitHub to restore persona...');

      const pullOptions: PullOptions = {
        direction: 'pull',
        mode: 'backup', // Use backup mode to ensure we update from GitHub
        dryRun: false
      };

      const pullResult = await pullHandler.executePull(pullOptions, '');

      expect(pullResult.content[0].text).toContain('✅');
      // Verify at least some files were pulled (could be many from existing test data)
      expect(pullResult.content[0].text).toMatch(/📥 Added: \d+|🔄 Updated: \d+/);
      console.log('     ✅ Pull completed successfully');

      // Step 7: Verify file was restored
      console.log('  7️⃣ Verifying file was restored locally...');
      const restoredContent = await fs.readFile(localPath, 'utf-8');

      expect(restoredContent).toContain(testPersona.metadata.name);
      expect(restoredContent).toContain(testPersona.metadata.description);
      console.log('     ✅ File restored with correct content');

      console.log('\n✅ Persona roundtrip test PASSED');
    }, 90000);
  });

  describe('Skill Roundtrip', () => {
    it('should upload skill, delete locally, and restore from GitHub', async () => {
      if (testEnv.skipTests) {
        console.log('⏭️  Test skipped - no GitHub token');
        return;
      }

      console.log('\n▶️ Test: Complete skill roundtrip workflow');

      // Step 1: Create test skill
      console.log('  1️⃣ Creating test skill...');
      const testSkill = createTestSkill({
        author: testEnv.githubUser,
        prefix: testEnv.personaPrefix,
        name: `${testEnv.personaPrefix}roundtrip-skill-${Date.now()}`
      });

      // Step 2: Upload to GitHub
      console.log('  2️⃣ Uploading skill to GitHub...');
      const uploadResult = await retryIfRetryable(
        async () => await repoManager.saveElement(testSkill, true),
        {
          maxAttempts: 5,
          onRetry: (attempt, error) => console.log(`     ↻ Retry ${attempt} due to: ${error.message}`)
        }
      );

      expect(uploadResult).toBeTruthy();
      expect(uploadResult).toContain('github.com');
      console.log(`     ✅ Upload successful: ${uploadResult}`);

      // Track uploaded file for cleanup
      const fileName = PortfolioRepoManager.generateFileName(testSkill.metadata.name || 'unnamed');
      const githubPath = `skills/${fileName}.md`;
      uploadedFiles.push(githubPath);

      // Step 3: Verify file exists on GitHub
      console.log('  3️⃣ Verifying file exists on GitHub...');
      const githubFile = await retryWithBackoff(
        async () => {
          const file = await githubClient.getFile(githubPath);
          if (!file) {
            throw new Error(`File not found at ${githubPath}`);
          }
          return file;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          onRetry: (attempt, _error, delayMs) => {
            console.log(`     ⏳ Retry ${attempt}/3: Waiting ${delayMs}ms for GitHub to process file...`);
          }
        }
      );

      expect(githubFile).not.toBeNull();
      expect(githubFile?.content).toContain(testSkill.metadata.name);
      console.log(`     ✅ File verified at: ${githubPath}`);

      // Step 4: Save skill locally first
      console.log('  4️⃣ Creating local copy of skill...');
      const localPath = path.join(testDir, 'skills', `${fileName}.md`);
      await fs.writeFile(localPath, githubFile!.content, 'utf-8');
      console.log(`     ✅ Local file created at: ${localPath}`);

      // Step 5: Delete local copy
      console.log('  5️⃣ Deleting local copy...');
      await fs.unlink(localPath);

      // Verify it's gone
      await expect(fs.access(localPath)).rejects.toThrow();
      console.log('     ✅ Local file deleted');

      // Step 6: Pull from GitHub to restore
      console.log('  6️⃣ Pulling from GitHub to restore skill...');
      const pullOptions: PullOptions = {
        direction: 'pull',
        mode: 'backup',
        dryRun: false
      };

      const pullResult = await pullHandler.executePull(pullOptions, '');

      expect(pullResult.content[0].text).toContain('✅');
      // Verify at least some files were pulled (could be many from existing test data)
      expect(pullResult.content[0].text).toMatch(/📥 Added: \d+|🔄 Updated: \d+/);
      console.log('     ✅ Pull completed successfully');

      // Step 7: Verify file was restored
      console.log('  7️⃣ Verifying file was restored locally...');
      const restoredContent = await fs.readFile(localPath, 'utf-8');

      expect(restoredContent).toContain(testSkill.metadata.name);
      expect(restoredContent).toContain(testSkill.metadata.description);
      console.log('     ✅ File restored with correct content');

      console.log('\n✅ Skill roundtrip test PASSED');
    }, 90000);
  });

  describe('Mixed Element Types Roundtrip', () => {
    it('should handle pulling multiple element types from GitHub', async () => {
      if (testEnv.skipTests) {
        console.log('⏭️  Test skipped - no GitHub token');
        return;
      }

      console.log('\n▶️ Test: Pull multiple element types in one operation');

      // Step 1: Create and upload both a persona and a skill
      console.log('  1️⃣ Creating test elements (persona + skill)...');
      const testPersona = createTestPersona({
        author: testEnv.githubUser,
        prefix: testEnv.personaPrefix,
        name: `${testEnv.personaPrefix}multi-persona-${Date.now()}`
      });

      const testSkill = createTestSkill({
        author: testEnv.githubUser,
        prefix: testEnv.personaPrefix,
        name: `${testEnv.personaPrefix}multi-skill-${Date.now()}`
      });

      // Step 2: Upload both to GitHub
      console.log('  2️⃣ Uploading both elements to GitHub...');
      const personaResult = await retryIfRetryable(
        async () => await repoManager.saveElement(testPersona, true),
        {
          maxAttempts: 5,
          onRetry: (attempt, error) => console.log(`     ↻ Persona retry ${attempt} due to: ${error.message}`)
        }
      );

      const skillResult = await retryIfRetryable(
        async () => await repoManager.saveElement(testSkill, true),
        {
          maxAttempts: 5,
          onRetry: (attempt, error) => console.log(`     ↻ Skill retry ${attempt} due to: ${error.message}`)
        }
      );

      expect(personaResult).toContain('github.com');
      expect(skillResult).toContain('github.com');
      console.log('     ✅ Both uploads successful');

      // Track for cleanup
      const personaFileName = PortfolioRepoManager.generateFileName(testPersona.metadata.name || 'unnamed');
      const skillFileName = PortfolioRepoManager.generateFileName(testSkill.metadata.name || 'unnamed');
      uploadedFiles.push(`personas/${personaFileName}.md`);
      uploadedFiles.push(`skills/${skillFileName}.md`);

      // Step 3: Verify both exist on GitHub
      console.log('  3️⃣ Verifying both files exist on GitHub...');
      await retryWithBackoff(
        async () => {
          const personaFile = await githubClient.getFile(`personas/${personaFileName}.md`);
          if (!personaFile) throw new Error('Persona not found');
          return personaFile;
        },
        { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 5000 }
      );

      await retryWithBackoff(
        async () => {
          const skillFile = await githubClient.getFile(`skills/${skillFileName}.md`);
          if (!skillFile) throw new Error('Skill not found');
          return skillFile;
        },
        { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 5000 }
      );

      console.log('     ✅ Both files verified on GitHub');

      // Step 4: Pull all elements from GitHub
      console.log('  4️⃣ Pulling all elements from GitHub...');
      const pullOptions: PullOptions = {
        direction: 'pull',
        mode: 'backup',
        dryRun: false
      };

      const pullResult = await pullHandler.executePull(pullOptions, '');

      expect(pullResult.content[0].text).toContain('✅');
      // Should have added/updated at least 2 elements
      const text = pullResult.content[0].text;
      const addedMatch = text.match(/📥 Added: (\d+)/);
      const updatedMatch = text.match(/🔄 Updated: (\d+)/);
      const addedCount = addedMatch ? parseInt(addedMatch[1]) : 0;
      const updatedCount = updatedMatch ? parseInt(updatedMatch[1]) : 0;
      expect(addedCount + updatedCount).toBeGreaterThanOrEqual(2);
      console.log(`     ✅ Pull completed: ${addedCount} added, ${updatedCount} updated`);

      // Step 5: Verify both files exist locally
      console.log('  5️⃣ Verifying both files restored locally...');
      const personaPath = path.join(testDir, 'personas', `${personaFileName}.md`);
      const skillPath = path.join(testDir, 'skills', `${skillFileName}.md`);

      const personaContent = await fs.readFile(personaPath, 'utf-8');
      const skillContent = await fs.readFile(skillPath, 'utf-8');

      expect(personaContent).toContain(testPersona.metadata.name);
      expect(skillContent).toContain(testSkill.metadata.name);
      console.log('     ✅ Both files restored correctly');

      console.log('\n✅ Mixed element types roundtrip test PASSED');
    }, 120000);
  });

  describe('Dry Run Mode', () => {
    it('should preview changes without actually pulling files', async () => {
      if (testEnv.skipTests) {
        console.log('⏭️  Test skipped - no GitHub token');
        return;
      }

      console.log('\n▶️ Test: Dry run mode (preview only)');

      // Step 1: Create and upload a test persona
      console.log('  1️⃣ Creating and uploading test persona...');
      const testPersona = createTestPersona({
        author: testEnv.githubUser,
        prefix: testEnv.personaPrefix,
        name: `${testEnv.personaPrefix}dryrun-test-${Date.now()}`
      });

      await retryIfRetryable(
        async () => await repoManager.saveElement(testPersona, true),
        { maxAttempts: 5 }
      );

      const fileName = PortfolioRepoManager.generateFileName(testPersona.metadata.name || 'unnamed');
      const githubPath = `personas/${fileName}.md`;
      uploadedFiles.push(githubPath);

      // Wait for GitHub to process
      await retryWithBackoff(
        async () => {
          const file = await githubClient.getFile(githubPath);
          if (!file) throw new Error('File not found');
          return file;
        },
        { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 5000 }
      );

      console.log('     ✅ Test persona uploaded and verified');

      // Step 2: Run dry-run pull
      console.log('  2️⃣ Running dry-run pull...');
      const pullOptions: PullOptions = {
        direction: 'pull',
        mode: 'backup',
        dryRun: true
      };

      const dryRunResult = await pullHandler.executePull(pullOptions, '');

      expect(dryRunResult.content[0].text).toContain('Dry Run Results');
      expect(dryRunResult.content[0].text).toContain(testPersona.metadata.name);
      console.log('     ✅ Dry run preview generated');

      // Step 3: Verify no files were actually created
      console.log('  3️⃣ Verifying no files were actually created...');
      const localPath = path.join(testDir, 'personas', `${fileName}.md`);

      await expect(fs.access(localPath)).rejects.toThrow();
      console.log('     ✅ Confirmed: no files created during dry run');

      console.log('\n✅ Dry run mode test PASSED');
    }, 60000);
  });
});
