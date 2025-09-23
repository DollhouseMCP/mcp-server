/**
 * Test setup utilities for Enhanced Index tests
 * Provides isolated test environment to prevent file system pollution
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Creates an isolated test environment with a temporary HOME directory
 * This prevents tests from modifying the real user's ~/.dollhouse directory
 */
export async function setupTestEnvironment(): Promise<string> {
  // Create a unique temporary directory for this test run
  const testId = `dollhouse-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const tempDir = path.join(os.tmpdir(), testId);

  // Create the test directory structure
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(path.join(tempDir, '.dollhouse', 'portfolio'), { recursive: true });

  // Store original HOME
  const originalHome = process.env.HOME;

  // Override HOME for tests
  process.env.HOME = tempDir;

  return originalHome || '';
}

/**
 * Cleans up the test environment and restores original HOME
 */
export async function cleanupTestEnvironment(originalHome: string, cleanupFiles = true): Promise<void> {
  const tempDir = process.env.HOME;

  // Restore original HOME
  process.env.HOME = originalHome;

  // Clean up test files if requested
  if (cleanupFiles && tempDir && tempDir.includes('dollhouse-test-')) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up test directory:', error);
    }
  }
}

/**
 * Resets the singleton instances to force re-initialization with test paths
 * We need to import and reset them directly since we're using ES modules
 */
export async function resetSingletons(): Promise<void> {
  // Dynamically import to reset singletons
  const { EnhancedIndexManager } = await import('../../../../src/portfolio/EnhancedIndexManager.js');
  (EnhancedIndexManager as any).instance = null;

  const { IndexConfigManager } = await import('../../../../src/portfolio/config/IndexConfig.js');
  (IndexConfigManager as any).instance = null;

  const { VerbTriggerManager } = await import('../../../../src/portfolio/VerbTriggerManager.js');
  (VerbTriggerManager as any).instance = null;

  const { RelationshipManager } = await import('../../../../src/portfolio/RelationshipManager.js');
  (RelationshipManager as any).instance = null;
}