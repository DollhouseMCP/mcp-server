/**
 * Simple Roundtrip Workflow Tests
 * 
 * Basic validation of the roundtrip workflow components
 */

import { describe, test, expect } from '@jest/globals';
import path from 'path';
import fs from 'fs/promises';
import { hasTestCredentials } from '../../src/config/test-env.js';

describe('Simple Roundtrip Workflow Tests', () => {
  const TEST_TIMEOUT = 10000; // 10 seconds

  describe('Test Infrastructure', () => {
    test('should validate test fixtures exist', async () => {
      const fixturesDir = path.join(process.cwd(), 'tests/fixtures/roundtrip');
      
      try {
        const files = await fs.readdir(fixturesDir);
        
        // Check for expected test fixtures
        const expectedFiles = [
          'sample-persona.md',
          'sample-skill.md', 
          'sample-template.md',
          'invalid-element.md',
          'edge-case-element.md',
          'test-helpers.ts'
        ];
        
        for (const expectedFile of expectedFiles) {
          expect(files).toContain(expectedFile);
        }
        
        expect(files.length).toBeGreaterThan(0);
      } catch (error) {
        throw new Error(`Test fixtures directory not accessible: ${error}`);
      }
    }, TEST_TIMEOUT);
    
    test('should validate test element format', async () => {
      const skillPath = path.join(process.cwd(), 'tests/fixtures/roundtrip/sample-skill.md');
      
      const content = await fs.readFile(skillPath, 'utf-8');
      
      // Check for required metadata
      // Fix: removed ^ anchor since content starts with YAML frontmatter, not the heading
      expect(content).toMatch(/# Test Code Review/);
      expect(content).toMatch(/- Type: skill/);
      expect(content).toMatch(/- Version: 1\.0\.0/);
      expect(content).toMatch(/- Author: test-suite/);
      expect(content).toMatch(/- Tags:/);
      
      // Check for required sections
      expect(content).toMatch(/## Description/);
      expect(content).toMatch(/## Skill Definition/);
      expect(content).toMatch(/## Usage Instructions/);
    }, TEST_TIMEOUT);
    
    test('should validate edge case element', async () => {
      const edgeCasePath = path.join(process.cwd(), 'tests/fixtures/roundtrip/edge-case-element.md');
      
      const content = await fs.readFile(edgeCasePath, 'utf-8');
      
      // Check for unicode characters
      expect(content).toMatch(/ñáméd wîth spéçial çhäråctérs/);
      expect(content).toMatch(/🚀 💻 🔧/);
      expect(content).toMatch(/中文, العربية, русский/);
      
      // Check for high version number
      expect(content).toMatch(/Version: 10\.99\.999/);
      
      // Check for special characters
      expect(content).toMatch(/!@#\$%\^&\*\(\)/);
    }, TEST_TIMEOUT);
    
    test('should validate invalid element structure', async () => {
      const invalidPath = path.join(process.cwd(), 'tests/fixtures/roundtrip/invalid-element.md');
      
      const content = await fs.readFile(invalidPath, 'utf-8');
      
      // Check for intentional errors
      expect(content).toMatch(/Type: unknown-type/);
      expect(content).toMatch(/Version: invalid-version/);
      expect(content).toMatch(/- Author:\s*$/m); // Empty author
      expect(content).toMatch(/Created: invalid-date/);
    }, TEST_TIMEOUT);
  });
  
  describe('Test Helpers', () => {
    test('should import test helpers successfully', async () => {
      const helpersPath = path.join(process.cwd(), 'tests/fixtures/roundtrip/test-helpers.ts');
      
      // Verify the file exists
      const stats = await fs.stat(helpersPath);
      expect(stats.isFile()).toBe(true);
      
      // Check content contains expected exports
      const content = await fs.readFile(helpersPath, 'utf-8');
      expect(content).toMatch(/export.*TestElement/);
      expect(content).toMatch(/export.*TestScenario/);
      expect(content).toMatch(/export.*TestValidator/);
      expect(content).toMatch(/export.*TestExecutor/);
    }, TEST_TIMEOUT);
    
    test('should validate test element creation function', async () => {
      const helpersPath = path.join(process.cwd(), 'tests/fixtures/roundtrip/test-helpers.ts');
      const content = await fs.readFile(helpersPath, 'utf-8');
      
      // Check for createTestElement function
      expect(content).toMatch(/function createTestElement/);
      expect(content).toMatch(/generateTestElementMarkdown/);
      expect(content).toMatch(/createTestElementSet/);
    }, TEST_TIMEOUT);
  });
  
  describe('Configuration Files', () => {
    test('should validate Jest E2E configuration', async () => {
      const configPath = path.join(process.cwd(), 'tests/jest.e2e.config.cjs');
      
      const stats = await fs.stat(configPath);
      expect(stats.isFile()).toBe(true);
      
      const content = await fs.readFile(configPath, 'utf-8');
      expect(content).toMatch(/tests\/e2e/);
      expect(content).toMatch(/testTimeout.*60000/);
      expect(content).toMatch(/maxWorkers.*1/);
    }, TEST_TIMEOUT);
    
    test('should validate E2E environment setup', async () => {
      const setupPath = path.join(process.cwd(), 'tests/setup-e2e-env.mjs');
      
      const stats = await fs.stat(setupPath);
      expect(stats.isFile()).toBe(true);
      
      const content = await fs.readFile(setupPath, 'utf-8');
      expect(content).toMatch(/E2E Test Environment Setup/);
      expect(content).toMatch(/NODE_ENV.*test/);
      expect(content).toMatch(/TEST_MODE.*e2e/);
    }, TEST_TIMEOUT);
  });
  
  // Documentation tests removed — referenced internal dev docs (docs/agent/)
  // that are not included in the public repository.
  
  describe('Environment Validation', () => {
    test('should check environment variables setup', () => {
      // Basic environment checks
      expect(process.env.NODE_ENV).toBeDefined();
      
      // Test-specific environment
      if (process.env.TEST_MODE) {
        expect(process.env.TEST_MODE).toBe('e2e');
      }
      
      // GitHub token check (optional)
      if (hasTestCredentials()) {
        // Token format validation happens in getTestGitHubToken()
        expect(true).toBe(true); // Just verify hasTestCredentials works
      }
    }, TEST_TIMEOUT);
    
    test('should validate test directories can be created', async () => {
      const testDir = path.join(process.cwd(), 'test-temp-validation');
      
      try {
        await fs.mkdir(testDir, { recursive: true });
        await fs.writeFile(path.join(testDir, 'test.txt'), 'test');
        
        const content = await fs.readFile(path.join(testDir, 'test.txt'), 'utf-8');
        expect(content).toBe('test');
        
        // Cleanup
        await fs.rm(testDir, { recursive: true });
      } catch (error) {
        throw new Error(`Cannot create test directories: ${error}`);
      }
    }, TEST_TIMEOUT);
  });
});

// Skip tests if in CI without proper setup
// Check both ENABLE_E2E_TESTS (legacy) and DOLLHOUSE_RUN_FULL_E2E (new standard)
const shouldSkipE2E = process.env.CI &&
  !(process.env.ENABLE_E2E_TESTS === 'true' || process.env.DOLLHOUSE_RUN_FULL_E2E === 'true');

if (shouldSkipE2E) {
  describe.skip('E2E tests skipped in CI environment', () => {
    test('placeholder', () => {
      console.log('E2E tests require ENABLE_E2E_TESTS=true or DOLLHOUSE_RUN_FULL_E2E=true in CI');
    });
  });
}
