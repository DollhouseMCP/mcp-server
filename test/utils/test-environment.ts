/**
 * Test Environment Utilities
 *
 * Helper functions for detecting and validating test environments.
 * Provides consistent environment checks across all test suites.
 */

/**
 * Environment Variables Documentation:
 *
 * CI Environment Variables:
 * - CI: Set to 'true' in any CI environment (GitHub Actions, Jenkins, etc.)
 * - GITHUB_ACTIONS: Set to 'true' only in GitHub Actions
 *
 * GitHub Actions Specific Variables:
 * - GITHUB_WORKFLOW: Name of the workflow
 * - GITHUB_RUN_ID: Unique identifier for the workflow run
 * - GITHUB_RUN_NUMBER: Sequential number for the workflow run
 * - GITHUB_WORKSPACE: Path to the workspace directory
 * - RUNNER_OS: Operating system of the runner (Linux, Windows, macOS)
 *
 * Test-Specific Variables:
 * - TEST_PERSONAS_DIR: Directory for test personas (set in Extended Node workflow)
 * - TEST_GITHUB_TOKEN: GitHub token for integration tests
 * - NODE_ENV: Should be 'test' when running tests
 */

export interface TestEnvironment {
  isCI: boolean;
  isGitHubActions: boolean;
  hasTestPersonasDir: boolean;
  hasGitHubToken: boolean;
  platform: 'windows' | 'macos' | 'linux' | 'unknown';
}

/**
 * Checks if we're running in a CI environment
 */
export const isCI = (): boolean => {
  return process.env.CI === 'true';
};

/**
 * Checks if we're running in GitHub Actions specifically
 */
export const isGitHubActions = (): boolean => {
  return process.env.GITHUB_ACTIONS === 'true';
};

/**
 * Checks if we're in GitHub Actions and should validate GitHub-specific variables
 * This is the main helper for determining when to check for GitHub environment variables
 */
export const shouldValidateGitHubEnvironment = (): boolean => {
  return isCI() && isGitHubActions();
};

/**
 * Checks if we're in CI but not GitHub Actions (e.g., local with CI=true)
 */
export const isNonGitHubCI = (): boolean => {
  return isCI() && !isGitHubActions();
};

/**
 * Gets a skip message for non-GitHub CI environments
 */
export const getSkipMessage = (testDescription: string): string => {
  return `⏭️  Skipping ${testDescription} - not in GitHub Actions environment`;
};

/**
 * Validates that all required GitHub Actions variables are present
 * Only call this when shouldValidateGitHubEnvironment() returns true
 */
export const validateGitHubActionsVariables = (): {
  valid: boolean;
  missing: string[];
} => {
  const required = [
    'GITHUB_WORKFLOW',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_NUMBER',
    'RUNNER_OS'
  ];

  const missing = required.filter(varName => !process.env[varName]);

  return {
    valid: missing.length === 0,
    missing
  };
};

/**
 * Gets the current platform in a normalized format
 */
export const getPlatform = (): TestEnvironment['platform'] => {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
};

/**
 * Gets comprehensive test environment information
 */
export const getTestEnvironment = (): TestEnvironment => {
  return {
    isCI: isCI(),
    isGitHubActions: isGitHubActions(),
    hasTestPersonasDir: !!process.env.TEST_PERSONAS_DIR,
    hasGitHubToken: !!process.env.TEST_GITHUB_TOKEN,
    platform: getPlatform()
  };
};

/**
 * Helper for conditionally running GitHub Actions specific tests
 * Usage:
 * ```typescript
 * runInGitHubActions('should have GitHub variables', () => {
 *   expect(process.env.GITHUB_WORKFLOW).toBeDefined();
 * });
 * ```
 */
export const runInGitHubActions = (testName: string, testFn: () => void): void => {
  if (shouldValidateGitHubEnvironment()) {
    testFn();
  } else if (isNonGitHubCI()) {
    console.log(getSkipMessage(testName));
  }
};