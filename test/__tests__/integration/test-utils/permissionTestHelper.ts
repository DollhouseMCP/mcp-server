/**
 * Test utility helpers for file permission testing
 * Provides consistent patterns for permission-based tests across platforms
 */

import * as fs from 'fs/promises';
import { logger } from '../../../../src/utils/logger.js';

export interface PermissionTestResult {
  skipped: boolean;
  reason?: string;
  error?: Error;
}

/**
 * Helper to safely restore file permissions after a test
 * Handles platform differences and missing files gracefully
 */
export async function restoreFilePermissions(
  filePath: string,
  originalMode: number = 0o644
): Promise<void> {
  try {
    await fs.chmod(filePath, originalMode);
  } catch (restoreError: any) {
    // File may not exist anymore, ignore ENOENT errors
    if (restoreError.code !== 'ENOENT') {
      // Use consistent warning level for permission issues
      if (process.platform === 'win32') {
        logger.warn(`Could not restore file permissions on Windows: ${restoreError.message}`, {
          file: filePath,
          error: restoreError.code
        });
      } else {
        logger.warn(`Error restoring file permissions: ${restoreError.message}`, {
          file: filePath,
          error: restoreError.code
        });
      }
    }
  }
}

/**
 * Check if a permission error should skip the test on the current platform
 */
export function shouldSkipPermissionTest(error: any): PermissionTestResult {
  if (!error) {
    return { skipped: false };
  }

  // File doesn't exist - skip test
  if (error.code === 'ENOENT') {
    return {
      skipped: true,
      reason: 'File does not exist',
      error
    };
  }

  // Windows permission errors - skip test
  if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
    return {
      skipped: true,
      reason: 'File permissions not fully supported on Windows',
      error
    };
  }

  return { skipped: false, error };
}

/**
 * Execute a test with file permission changes and automatic cleanup
 * Ensures permissions are always restored, even if test fails
 */
export async function withPermissionChange(
  filePath: string,
  testMode: number,
  testFn: () => Promise<void>,
  originalMode: number = 0o644
): Promise<void> {
  let testError: Error | null = null;
  let testPassed = false;

  try {
    // Change permissions for test
    await fs.chmod(filePath, testMode);

    // Run the test
    await testFn();
    testPassed = true;
  } catch (error: any) {
    testError = error;
  }

  // Always restore permissions
  await restoreFilePermissions(filePath, originalMode);

  // Handle any test errors after cleanup
  if (!testPassed && testError) {
    const skipResult = shouldSkipPermissionTest(testError);
    if (skipResult.skipped) {
      logger.info(`Permission test skipped: ${skipResult.reason}`);
      return; // Test skipped, don't throw
    }
    throw testError;
  }
}