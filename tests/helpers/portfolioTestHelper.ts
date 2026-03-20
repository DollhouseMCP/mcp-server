/**
 * Test helper for managing PortfolioManager test environments
 * Ensures proper isolation and cleanup of test directories and environment variables
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import type { DollhouseContainer } from '../../src/di/Container.js';
import { Gatekeeper, PermissionLevel } from '../../src/handlers/mcp-aql/Gatekeeper.js';
import { getConfirmationRequiredOperations } from '../../src/handlers/mcp-aql/policies/OperationPolicies.js';

export interface PortfolioTestEnvironment {
  testDir: string;
  portfolioManager: PortfolioManager;
  cleanup: () => Promise<void>;
}

/**
 * Creates an isolated test environment for portfolio/element manager tests
 * Automatically handles:
 * - Creating temporary test directory
 * - Saving and restoring DOLLHOUSE_PORTFOLIO_DIR env var
 * - Initializing PortfolioManager
 * - Cleanup of test directory and env var restoration
 *
 * @param prefix - Prefix for the temp directory name (default: 'portfolio-test')
 * @returns Test environment with testDir, portfolioManager, and cleanup function
 *
 * @example
 * ```typescript
 * describe('My Test', () => {
 *   let env: PortfolioTestEnvironment;
 *
 *   beforeAll(async () => {
 *     env = await createPortfolioTestEnvironment('my-test');
 *   });
 *
 *   afterAll(async () => {
 *     await env.cleanup();
 *   });
 * });
 * ```
 */
export async function createPortfolioTestEnvironment(
  prefix: string = 'portfolio-test'
): Promise<PortfolioTestEnvironment> {
  // Save original environment variable
  const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

  // Create temporary test directory
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));

  // Set environment variable to test directory
  process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

  // Create and initialize PortfolioManager
  const fileLockManager = new FileLockManager();
  const fileOperations = new FileOperationsService(fileLockManager);
  const portfolioManager = new PortfolioManager(fileOperations);
  await portfolioManager.initialize();

  // Return environment with cleanup function
  return {
    testDir,
    portfolioManager,
    cleanup: async () => {
      // Clean up test directory
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors
        console.warn(`Failed to clean up test directory ${testDir}:`, error);
      }

      // Restore original environment variable
      if (originalPortfolioDir === undefined) {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      } else {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      }
    }
  };
}

/**
 * Creates a minimal test environment with just a directory and env var setup
 * Use this when you don't need a full PortfolioManager instance
 *
 * @param prefix - Prefix for the temp directory name
 * @returns Object with testDir and cleanup function
 */
export async function createTestDirectory(
  prefix: string = 'test'
): Promise<{ testDir: string; cleanup: () => Promise<void> }> {
  const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));

  process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

  return {
    testDir,
    cleanup: async () => {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }

      if (originalPortfolioDir === undefined) {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      } else {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      }
    }
  };
}

/**
 * Pre-confirms all state-changing operations on the Gatekeeper so integration
 * tests can execute without hitting confirmation prompts.
 *
 * Call this in beforeEach/beforeAll AFTER the DollhouseContainer has been
 * fully initialized (i.e., after server.listPersonas() or container.createHandlers())
 * and BEFORE invoking any MCPAQLHandler methods.
 *
 * The Gatekeeper enforce() pipeline still runs (route validation, element
 * policies) — only the session-confirmation layer is pre-satisfied.
 *
 * @param container - An initialized DollhouseContainer with Gatekeeper registered
 * @returns The resolved Gatekeeper instance for reuse in assertions or selective confirmation
 */
export function preConfirmAllOperations(container: DollhouseContainer): Gatekeeper {
  let gatekeeper: Gatekeeper;
  try {
    gatekeeper = container.resolve<Gatekeeper>('gatekeeper');
  } catch (error) {
    throw new Error(
      'Failed to resolve Gatekeeper from container. Ensure the container is fully initialized ' +
      '(call server.listPersonas() or container.createHandlers()) before calling preConfirmAllOperations().',
      { cause: error }
    );
  }
  for (const operation of getConfirmationRequiredOperations()) {
    gatekeeper.recordConfirmation(operation, PermissionLevel.CONFIRM_SESSION);
  }
  return gatekeeper;
}

/**
 * Revokes all session confirmations on the Gatekeeper, restoring enforcement
 * to its default state. Useful for tests that need to verify the confirmation
 * flow itself or reset state between test cases in a shared describe block.
 *
 * @param container - An initialized DollhouseContainer with Gatekeeper registered
 * @returns The resolved Gatekeeper instance for reuse
 */
/**
 * Wait for cache to settle after element creation.
 *
 * Issue #276: Element managers use async cache invalidation, so newly created
 * elements may not be immediately visible to read operations. This centralizes
 * the settle delay so a future deterministic solution only needs one change.
 *
 * @param ms - Settle time in milliseconds (default: 2000)
 */
export function waitForCacheSettle(ms = 2000): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function resetGatekeeperConfirmations(container: DollhouseContainer): Gatekeeper {
  let gatekeeper: Gatekeeper;
  try {
    gatekeeper = container.resolve<Gatekeeper>('gatekeeper');
  } catch (error) {
    throw new Error(
      'Failed to resolve Gatekeeper from container. Ensure the container is fully initialized ' +
      '(call server.listPersonas() or container.createHandlers()) before calling resetGatekeeperConfirmations().',
      { cause: error }
    );
  }
  gatekeeper.revokeAllConfirmations();
  return gatekeeper;
}
