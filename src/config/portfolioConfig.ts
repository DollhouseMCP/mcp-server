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
 */
export function getPortfolioRepositoryName(): string {
  // For testing environments, use TEST_GITHUB_REPO if set
  if (process.env.TEST_GITHUB_REPO) {
    return process.env.TEST_GITHUB_REPO;
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
 */
export function isTestEnvironment(): boolean {
  return process.env.TEST_MODE === 'true' || 
         process.env.NODE_ENV === 'test' ||
         !!process.env.TEST_GITHUB_REPO;
}