/**
 * Portfolio configuration utilities
 * Handles repository name configuration for portfolio sync
 */

/**
 * Get the configured portfolio repository name
 * Priority order:
 * 1. TEST_GITHUB_REPO environment variable (for testing)
 * 2. Configured repository name (future: from config file)
 * 3. Default: 'dollhouse-portfolio'
 * 
 * @example
 * // Default usage
 * const repo = getPortfolioRepositoryName(); // 'dollhouse-portfolio'
 * 
 * @example
 * // With TEST_GITHUB_REPO set
 * process.env.TEST_GITHUB_REPO = 'test-portfolio';
 * const repo = getPortfolioRepositoryName(); // 'test-portfolio'
 * 
 * @returns {string} The configured portfolio repository name
 */
export function getPortfolioRepositoryName(): string {
  // For testing environments, use TEST_GITHUB_REPO if set
  // Trim whitespace to handle edge cases
  const testRepo = process.env.TEST_GITHUB_REPO?.trim();
  if (testRepo) {
    return testRepo;
  }
  
  // TODO: Add support for reading from config file
  // const config = ConfigManager.getInstance();
  // if (config.github?.portfolio?.repository_name) {
  //   return config.github.portfolio.repository_name;
  // }
  
  // Default repository name
  return 'dollhouse-portfolio';
}

/**
 * Check if we're in a test environment
 * 
 * @example
 * // When TEST_GITHUB_REPO is set
 * process.env.TEST_GITHUB_REPO = 'test-repo';
 * const isTest = isTestEnvironment(); // true
 * 
 * @example
 * // In production environment
 * delete process.env.TEST_GITHUB_REPO;
 * const isTest = isTestEnvironment(); // false
 * 
 * @returns {boolean} True if running in a test environment
 */
export function isTestEnvironment(): boolean {
  return process.env.TEST_MODE === 'true' || 
         process.env.NODE_ENV === 'test' ||
         !!process.env.TEST_GITHUB_REPO?.trim();
}