import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { PathValidator } from '../../../../src/security/pathValidator.js';

/**
 * SECURITY FIX #1290: Test symlink path traversal vulnerability
 *
 * This test verifies that PathValidator correctly resolves symlinks before
 * validating paths, preventing attackers from bypassing directory restrictions
 * by creating symlinks inside allowed directories that point to sensitive
 * files outside.
 *
 * Attack scenario:
 * 1. Attacker creates: /allowed/personas/evil.md -> /etc/passwd
 * 2. Without fix: path.resolve() returns /allowed/personas/evil.md (passes check)
 * 3. With fix: fs.realpath() returns /etc/passwd (fails check)
 */

/**
 * Helper function to create a symlink with proper error handling
 * @param target - The target path the symlink should point to
 * @param linkPath - The path where the symlink should be created
 * @returns true if symlink was created, false if skipped due to permissions
 */
async function createTestSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch (err) {
    // On some systems (Windows), symlink creation may require admin privileges
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      console.warn('Skipping symlink creation - insufficient permissions');
      return false;
    }
    throw err;
  }
}

/**
 * Helper function to set up test directory structure
 */
async function setupTestDirectories(): Promise<{
  tempDir: string;
  allowedDir: string;
  disallowedDir: string;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-symlink-test-'));
  const allowedDir = path.join(tempDir, 'allowed-personas');
  const disallowedDir = path.join(tempDir, 'sensitive');

  await fs.mkdir(allowedDir, { recursive: true });
  await fs.mkdir(disallowedDir, { recursive: true });

  // Resolve real paths (important on macOS where /tmp -> /private/var/folders)
  const realAllowedDir = await fs.realpath(allowedDir);
  const realDisallowedDir = await fs.realpath(disallowedDir);

  return { tempDir, allowedDir: realAllowedDir, disallowedDir: realDisallowedDir };
}

describe('PathValidator - Symlink Security Tests (#1290)', () => {
  let tempDir: string;
  let allowedDir: string;
  let disallowedDir: string;
  let sensitiveFile: string;
  let symlinkPath: string;

  beforeAll(async () => {
    // Set up test directory structure
    const dirs = await setupTestDirectories();
    tempDir = dirs.tempDir;
    allowedDir = dirs.allowedDir;
    disallowedDir = dirs.disallowedDir;

    // Create a sensitive file outside allowed directory
    sensitiveFile = path.join(disallowedDir, 'secrets.txt');
    await fs.writeFile(sensitiveFile, 'SENSITIVE DATA - should not be accessible');

    // Create a symlink inside allowed directory pointing to sensitive file
    symlinkPath = path.join(allowedDir, 'innocent-looking.md');
    await createTestSymlink(sensitiveFile, symlinkPath);

    // Initialize PathValidator with allowed directory (only this directory, no defaults)
    PathValidator.initialize(allowedDir, ['.md', '.markdown', '.txt', '.yml', '.yaml']);
  });

  afterAll(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.warn('Failed to clean up temp directory:', err);
    }
  });

  test('should reject symlinks pointing outside allowed directories', async () => {
    // Skip if we couldn't create symlinks in beforeAll
    try {
      await fs.lstat(symlinkPath);
    } catch {
      console.warn('Symlink not created, skipping test');
      return;
    }

    // Verify symlink exists and points to sensitive file
    const stats = await fs.lstat(symlinkPath);
    expect(stats.isSymbolicLink()).toBe(true);

    const realTarget = await fs.realpath(symlinkPath);
    expect(realTarget).toBe(sensitiveFile);
    expect(realTarget).not.toContain('allowed-personas');

    // PathValidator should reject the symlink
    await expect(async () => {
      await PathValidator.validatePersonaPath(symlinkPath);
    }).rejects.toThrow('Path access denied');
  });

  test('should allow normal files within allowed directories', async () => {
    // Create a legitimate file
    const legitFile = path.join(allowedDir, 'normal-persona.md');
    await fs.writeFile(legitFile, '# Normal Persona');

    // Should be allowed
    const validatedPath = await PathValidator.validatePersonaPath(legitFile);
    expect(validatedPath).toBeTruthy();
    expect(validatedPath).toContain('allowed-personas');

    // Clean up
    await fs.unlink(legitFile);
  });

  test('should reject raw path strings with .. traversal patterns', async () => {
    // Use raw string with .. instead of path.join (which normalizes)
    const traversalPath = allowedDir + '/../sensitive/secrets.txt';

    // Should be rejected due to .. pattern
    await expect(async () => {
      await PathValidator.validatePersonaPath(traversalPath);
    }).rejects.toThrow(); // Will be rejected for traversal or path access
  });

  test('should handle symlinks in parent directories correctly', async () => {
    // Create a symlink to the allowed directory itself
    const symlinkToAllowedDir = path.join(tempDir, 'symlink-to-allowed');
    const created = await createTestSymlink(allowedDir, symlinkToAllowedDir);
    if (!created) return; // Skip test if symlink creation failed

    // Create a file inside the symlinked directory
    const fileInSymlinkedDir = path.join(symlinkToAllowedDir, 'test.md');
    await fs.writeFile(fileInSymlinkedDir, '# Test');

    // This should be allowed because it resolves to inside allowed directory
    const validatedPath = await PathValidator.validatePersonaPath(fileInSymlinkedDir);
    expect(validatedPath).toBeTruthy();

    // Clean up
    await fs.unlink(fileInSymlinkedDir);
    await fs.unlink(symlinkToAllowedDir);
  });

  test('should handle non-existent paths with symlinked parent directories', async () => {
    // Create a symlink to the allowed directory
    const symlinkToAllowedDir = path.join(tempDir, 'symlink-to-allowed-2');
    const created = await createTestSymlink(allowedDir, symlinkToAllowedDir);
    if (!created) return; // Skip test if symlink creation failed

    // Reference a non-existent file inside the symlinked directory
    const nonExistentFile = path.join(symlinkToAllowedDir, 'new-file.md');

    // Should be allowed because parent resolves to inside allowed directory
    const validatedPath = await PathValidator.validatePersonaPath(nonExistentFile);
    expect(validatedPath).toBeTruthy();
    expect(validatedPath).toContain('allowed-personas');

    // Clean up
    await fs.unlink(symlinkToAllowedDir);
  });

  test('should reject double symlink attack', async () => {
    // Create nested symlink attack:
    // innocent.md -> intermediate.md -> /sensitive/secrets.txt

    const intermediateSymlink = path.join(allowedDir, 'intermediate.md');
    const finalSymlink = path.join(allowedDir, 'innocent.md');

    // Create first symlink
    const created1 = await createTestSymlink(sensitiveFile, intermediateSymlink);
    if (!created1) return; // Skip test if symlink creation failed

    // Create second symlink
    const created2 = await createTestSymlink(intermediateSymlink, finalSymlink);
    if (!created2) {
      await fs.unlink(intermediateSymlink);
      return; // Skip test if second symlink creation failed
    }

    // Verify the symlink chain resolves to sensitive file
    const realTarget = await fs.realpath(finalSymlink);
    expect(realTarget).toBe(sensitiveFile);

    // PathValidator should reject the double-symlink
    await expect(async () => {
      await PathValidator.validatePersonaPath(finalSymlink);
    }).rejects.toThrow('Path access denied');

    // Clean up
    try {
      await fs.unlink(finalSymlink);
      await fs.unlink(intermediateSymlink);
    } catch {
      // Ignore cleanup errors
    }
  });

  test('should properly validate extension of symlink target, not symlink itself', async () => {
    // Create a symlink with .md extension pointing to a .txt file
    const txtFile = path.join(disallowedDir, 'config.txt');
    await fs.writeFile(txtFile, 'CONFIG DATA');

    const symlinkWithMdExt = path.join(allowedDir, 'looks-safe.md');
    const created = await createTestSymlink(txtFile, symlinkWithMdExt);
    if (!created) {
      await fs.unlink(txtFile);
      return; // Skip test if symlink creation failed
    }

    // Should be rejected because target is outside allowed directory
    // (Not because of extension - we validate the real path location first)
    await expect(async () => {
      await PathValidator.validatePersonaPath(symlinkWithMdExt);
    }).rejects.toThrow('Path access denied');

    // Clean up
    try {
      await fs.unlink(symlinkWithMdExt);
      await fs.unlink(txtFile);
    } catch {
      // Ignore cleanup errors
    }
  });
});
