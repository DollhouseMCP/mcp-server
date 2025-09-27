/**
 * Test setup utilities for Enhanced Index tests
 * Provides isolated test environment to prevent file system pollution
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// Store suite-level temp directory for reuse within the same test suite
let suiteDirectory: string | null = null;

/**
 * Creates an isolated test environment with a temporary HOME directory
 * This prevents tests from modifying the real user's ~/.dollhouse directory
 *
 * @param reuseSuiteDirectory - If true, reuses the same temp directory for all tests in the suite (optimization)
 */
export async function setupTestEnvironment(reuseSuiteDirectory = false): Promise<string> {
  // Store original HOME
  const originalHome = process.env.HOME;

  let tempDir: string;

  if (reuseSuiteDirectory && suiteDirectory) {
    // Reuse existing suite directory for performance
    tempDir = suiteDirectory;
  } else {
    // Create a unique temporary directory for this test run
    // Include PID to avoid race conditions between parallel test processes
    const pid = process.pid;
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const testId = `dollhouse-test-${pid}-${timestamp}-${random}`;
    tempDir = path.join(os.tmpdir(), testId);

    // Create the test directory structure
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, '.dollhouse', 'portfolio'), { recursive: true });

    // Store for potential reuse within suite
    if (reuseSuiteDirectory) {
      suiteDirectory = tempDir;
    }
  }

  // Override HOME for tests
  process.env.HOME = tempDir;

  return originalHome || '';
}

/**
 * Cleans up the test environment and restores original HOME
 *
 * @param originalHome - The original HOME environment variable to restore
 * @param cleanupFiles - If true, removes the temporary test directory (default: true)
 */
export async function cleanupTestEnvironment(originalHome: string, cleanupFiles = true): Promise<void> {
  const tempDir = process.env.HOME;

  // Restore original HOME
  process.env.HOME = originalHome;

  // Clean up test files if requested and not a suite directory
  if (cleanupFiles && tempDir && tempDir !== suiteDirectory && tempDir.includes('dollhouse-test-')) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up test directory:', error);
    }
  }
}

/**
 * Clears the suite directory cache and optionally removes the directory
 * Call this in afterAll() when using suite-level directory reuse
 *
 * @param cleanupFiles - If true, removes the suite temporary directory
 */
export async function clearSuiteDirectory(cleanupFiles = true): Promise<void> {
  if (suiteDirectory) {
    if (cleanupFiles && suiteDirectory.includes('dollhouse-test-')) {
      try {
        await fs.rm(suiteDirectory, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to clean up suite directory:', error);
      }
    }
    suiteDirectory = null;
  }
}

/**
 * Interface for singleton classes with instance property
 */
interface SingletonClass {
  instance: unknown | null;
}

/**
 * Resets the singleton instances to force re-initialization with test paths
 * We need to import and reset them directly since we're using ES modules
 */
export async function resetSingletons(): Promise<void> {
  // Dynamically import to reset singletons with proper typing
  const enhancedIndexModule = await import('../../../../src/portfolio/EnhancedIndexManager.js');
  const EnhancedIndexManager = enhancedIndexModule.EnhancedIndexManager as unknown as SingletonClass;
  EnhancedIndexManager.instance = null;

  const indexConfigModule = await import('../../../../src/portfolio/config/IndexConfig.js');
  const IndexConfigManager = indexConfigModule.IndexConfigManager as unknown as SingletonClass;
  IndexConfigManager.instance = null;

  const verbTriggerModule = await import('../../../../src/portfolio/VerbTriggerManager.js');
  const VerbTriggerManager = verbTriggerModule.VerbTriggerManager as unknown as SingletonClass;
  VerbTriggerManager.instance = null;

  const relationshipModule = await import('../../../../src/portfolio/RelationshipManager.js');
  const RelationshipManager = relationshipModule.RelationshipManager as unknown as SingletonClass;
  RelationshipManager.instance = null;
}