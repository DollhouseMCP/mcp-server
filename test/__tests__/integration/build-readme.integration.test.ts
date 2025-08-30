/**
 * Integration tests for the modular README build script
 * These tests actually execute the build script and verify real output
 * 
 * @fileoverview Integration tests for scripts/build-readme.js
 * @author DollhouseMCP Team
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const BUILD_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'build-readme.js');
const REAL_README_DIR = path.join(PROJECT_ROOT, 'docs', 'readme');
const TEST_DIR = path.join(PROJECT_ROOT, 'test-temp', 'readme-integration');

// Backup paths for safety
const BACKUP_CONFIG = path.join(TEST_DIR, 'config.backup.json');

describe('README Builder Integration Tests', () => {
  let originalConfig: string | undefined;
  let originalCwd: string;

  beforeAll(async () => {
    // Store original working directory
    originalCwd = process.cwd();
    
    // Create test directory
    await fs.mkdir(TEST_DIR, { recursive: true });
    
    // Backup original config if it exists
    try {
      originalConfig = await fs.readFile(
        path.join(REAL_README_DIR, 'config.json'),
        'utf-8'
      );
      await fs.writeFile(BACKUP_CONFIG, originalConfig);
    } catch (error) {
      // No original config to backup
      originalConfig = undefined;
    }
  });

  afterAll(async () => {
    // Restore original config if it existed
    if (originalConfig) {
      await fs.writeFile(
        path.join(REAL_README_DIR, 'config.json'),
        originalConfig
      );
    }
    
    // Clean up test directory
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to clean up test directory:', error);
    }
    
    // Restore working directory
    process.chdir(originalCwd);
  });

  describe('Build Script Execution', () => {
    test('should successfully build NPM README from real chunks', async () => {
      // Change to project root for script execution
      process.chdir(PROJECT_ROOT);
      
      // Execute the build script for NPM target
      const { stdout, stderr } = await execAsync('node scripts/build-readme.js --target=npm');
      
      // Verify successful execution
      expect(stderr).toBe('');
      expect(stdout).toContain('DollhouseMCP README Builder');
      expect(stdout).toContain('Configuration loaded and validated');
      expect(stdout).toContain('Building npm README');
      expect(stdout).toContain('Build complete!');
      
      // Verify output file was created
      const outputPath = path.join(PROJECT_ROOT, 'README.npm.md');
      const outputExists = await fs.access(outputPath)
        .then(() => true)
        .catch(() => false);
      
      expect(outputExists).toBe(true);
      
      // Verify content of generated README
      const content = await fs.readFile(outputPath, 'utf-8');
      expect(content).toContain('# DollhouseMCP');
      expect(content).toContain('## 🚀 Quick Start');
      expect(content).toContain('npm install -g @dollhousemcp/mcp-server');
      
      // Verify no hardcoded versions
      expect(content).not.toMatch(/v1\.6\.\d+/); // No specific version numbers
      expect(content).not.toContain('v1.4.2'); // No old version references
    }, 30000); // 30 second timeout for integration test

    test('should handle missing chunks gracefully', async () => {
      // Create a test config with some missing chunks
      const testConfig = {
        versions: {
          test: {
            description: 'Test with missing chunks',
            chunks: [
              '00-header',
              'non-existent-chunk',
              '01-installation'
            ],
            output: '../../test-output.md'
          }
        },
        chunkDirectory: 'chunks',
        separator: '\n\n'
      };
      
      // Temporarily replace config
      const originalConfigPath = path.join(REAL_README_DIR, 'config.json');
      const originalConfigContent = await fs.readFile(originalConfigPath, 'utf-8');
      await fs.writeFile(originalConfigPath, JSON.stringify(testConfig, null, 2));
      
      try {
        // Execute build script
        process.chdir(PROJECT_ROOT);
        const { stdout } = await execAsync('node scripts/build-readme.js --target=test');
        
        // Should complete despite missing chunk
        expect(stdout).toContain('Build complete!');
        expect(stdout).toContain('Chunk not found: non-existent-chunk.md');
        
        // Verify output was still created
        const outputPath = path.join(PROJECT_ROOT, 'test-output.md');
        const content = await fs.readFile(outputPath, 'utf-8');
        
        // Should contain the chunks that do exist
        expect(content).toContain('# DollhouseMCP');
        expect(content).toContain('Quick Start');
        
        // Clean up test output
        await fs.unlink(outputPath);
      } finally {
        // Restore original config
        await fs.writeFile(originalConfigPath, originalConfigContent);
      }
    }, 30000);

    test('should validate config and report errors', async () => {
      // Create invalid config
      const invalidConfig = {
        // Missing required 'versions' property
        chunkDirectory: 'chunks'
      };
      
      const configPath = path.join(REAL_README_DIR, 'config.json');
      const originalContent = await fs.readFile(configPath, 'utf-8');
      
      try {
        await fs.writeFile(configPath, JSON.stringify(invalidConfig, null, 2));
        
        // Execute build script - should fail with proper error
        process.chdir(PROJECT_ROOT);
        
        try {
          await execAsync('node scripts/build-readme.js');
          // Should not reach here
          expect(true).toBe(false);
        } catch (error: any) {
          expect(error.message).toContain('Invalid config');
        }
        
      } finally {
        // Restore original config
        await fs.writeFile(configPath, originalContent);
      }
    }, 30000);

    test('should handle both NPM and GitHub targets', async () => {
      // Test that we can specify different targets
      process.chdir(PROJECT_ROOT);
      
      // Test NPM target
      const npmResult = await execAsync('node scripts/build-readme.js --target=npm');
      expect(npmResult.stdout).toContain('Building npm README');
      
      // Verify NPM output characteristics
      const npmContent = await fs.readFile(
        path.join(PROJECT_ROOT, 'README.npm.md'),
        'utf-8'
      );
      
      // NPM version should be concise
      const npmLines = npmContent.split('\n').length;
      expect(npmLines).toBeLessThan(300); // Should be much shorter than full README
      
      // Should contain essential sections
      expect(npmContent).toContain('Quick Start');
      expect(npmContent).toContain('Installation');
      expect(npmContent).toContain('Features');
    }, 30000);
  });

  describe('Error Handling', () => {
    test('should provide helpful error for missing config file', async () => {
      // Temporarily rename config
      const configPath = path.join(REAL_README_DIR, 'config.json');
      const tempPath = path.join(REAL_README_DIR, 'config.json.temp');
      
      await fs.rename(configPath, tempPath);
      
      try {
        process.chdir(PROJECT_ROOT);
        
        try {
          await execAsync('node scripts/build-readme.js');
          expect(true).toBe(false); // Should not reach
        } catch (error: any) {
          expect(error.message).toContain('Configuration file not found');
        }
      } finally {
        // Restore config
        await fs.rename(tempPath, configPath);
      }
    }, 30000);
  });

  describe('Output Validation', () => {
    test('should generate valid markdown', async () => {
      process.chdir(PROJECT_ROOT);
      await execAsync('node scripts/build-readme.js --target=npm');
      
      const content = await fs.readFile(
        path.join(PROJECT_ROOT, 'README.npm.md'),
        'utf-8'
      );
      
      // Check for balanced code blocks
      const codeBlocks = (content.match(/```/g) || []).length;
      expect(codeBlocks % 2).toBe(0);
      
      // Check for proper heading hierarchy
      const h1Count = (content.match(/^# /gm) || []).length;
      expect(h1Count).toBeGreaterThanOrEqual(1);
      
      // Check for proper link format
      const markdownLinks = content.match(/\[([^\]]+)\]\(([^)]+)\)/g) || [];
      markdownLinks.forEach(link => {
        expect(link).toMatch(/\[.+\]\(.+\)/);
      });
    }, 30000);

    test('should maintain consistent formatting', async () => {
      // Build twice and compare
      process.chdir(PROJECT_ROOT);
      
      await execAsync('node scripts/build-readme.js --target=npm');
      const firstBuild = await fs.readFile(
        path.join(PROJECT_ROOT, 'README.npm.md'),
        'utf-8'
      );
      
      await execAsync('node scripts/build-readme.js --target=npm');
      const secondBuild = await fs.readFile(
        path.join(PROJECT_ROOT, 'README.npm.md'),
        'utf-8'
      );
      
      // Builds should be identical
      expect(firstBuild).toBe(secondBuild);
    }, 30000);
  });
});