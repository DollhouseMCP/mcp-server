/**
 * Portfolio configuration utilities
 * Handles repository name configuration for portfolio sync
 */

import { logger } from '../utils/logger.js';

/**
 * Validates a GitHub repository name against GitHub's naming requirements.
 *
 * GitHub repository names must:
 * - Contain only alphanumeric characters, hyphens, underscores, and dots
 * - Not contain slashes (use PORTFOLIO_REPOSITORY_NAME instead of owner/repo format)
 * - Not be empty or only whitespace
 *
 * @param name - The repository name to validate
 * @returns The trimmed repository name if valid
 * @throws Error if the repository name is invalid with guidance on how to fix it
 *
 * @example
 * // Valid repository names
 * validateRepositoryName('dollhouse-portfolio'); // 'dollhouse-portfolio'
 * validateRepositoryName('my_repo.test');        // 'my_repo.test'
 * validateRepositoryName('  repo-123  ');        // 'repo-123' (trimmed)
 *
 * @example
 * // Invalid repository names (throw errors)
 * validateRepositoryName('owner/repo');          // Error: contains slash
 * validateRepositoryName('');                    // Error: empty
 * validateRepositoryName('repo@name');           // Error: invalid character
 */
export function validateRepositoryName(name: string | undefined): string {
  const trimmed = name?.trim() ?? '';

  // Check for empty or whitespace-only
  if (!trimmed) {
    throw new Error(
      `Repository name cannot be empty.\n` +
      `Please set PORTFOLIO_REPOSITORY_NAME to a valid GitHub repository name.\n` +
      `Example: PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio`
    );
  }

  // Check for slash character (common mistake with GITHUB_REPOSITORY in CI)
  if (trimmed.includes('/')) {
    throw new Error(
      `Repository name cannot contain '/' character.\n` +
      `Expected: Just the repository name (e.g., 'dollhouse-portfolio')\n` +
      `Got: '${trimmed}'\n\n` +
      `It looks like you're using GitHub Actions' GITHUB_REPOSITORY format (owner/repo).\n` +
      `For portfolio configuration, use PORTFOLIO_REPOSITORY_NAME with just the repo name:\n\n` +
      `  PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio\n\n` +
      `The username should be specified separately in GITHUB_USERNAME.`
    );
  }

  // Check for invalid characters (GitHub allows: a-z, A-Z, 0-9, -, _, .)
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  if (!validPattern.test(trimmed)) {
    throw new Error(
      `Repository name contains invalid characters.\n` +
      `Got: '${trimmed}'\n` +
      `Allowed characters: letters (a-z, A-Z), numbers (0-9), hyphens (-), underscores (_), dots (.)\n` +
      `Example: PORTFOLIO_REPOSITORY_NAME=my-portfolio_v2.0`
    );
  }

  return trimmed;
}

/**
 * Get the configured portfolio repository name.
 *
 * Priority order:
 * 1. PORTFOLIO_REPOSITORY_NAME environment variable (preferred, dedicated config)
 * 2. GITHUB_REPOSITORY environment variable (legacy, deprecated for portfolio use)
 *    - Only used if it doesn't contain '/' (not in GitHub Actions "owner/repo" format)
 *    - Shows deprecation warning
 * 3. TEST_GITHUB_REPO environment variable (deprecated, backward compatibility)
 * 4. GITHUB_TEST_REPO environment variable (deprecated, backward compatibility)
 * 5. TEST_PORTFOLIO_REPO environment variable (deprecated, backward compatibility)
 * 6. Default: 'dollhouse-portfolio'
 *
 * @returns The configured portfolio repository name (validated)
 * @throws Error if any configured name is invalid
 *
 * @example
 * // Default usage (no env vars set)
 * const repo = getPortfolioRepositoryName(); // 'dollhouse-portfolio'
 *
 * @example
 * // With PORTFOLIO_REPOSITORY_NAME (preferred)
 * process.env.PORTFOLIO_REPOSITORY_NAME = 'my-portfolio';
 * const repo = getPortfolioRepositoryName(); // 'my-portfolio'
 *
 * @example
 * // With legacy GITHUB_REPOSITORY (shows deprecation warning)
 * process.env.GITHUB_REPOSITORY = 'my-portfolio';
 * const repo = getPortfolioRepositoryName(); // 'my-portfolio' + warning
 *
 * @example
 * // Error: GITHUB_REPOSITORY in GitHub Actions format
 * process.env.GITHUB_REPOSITORY = 'owner/repo';
 * getPortfolioRepositoryName(); // throws Error with migration guidance
 */
export function getPortfolioRepositoryName(): string {
  // 1. Check preferred dedicated variable first
  let repo = process.env.PORTFOLIO_REPOSITORY_NAME?.trim();
  if (repo) {
    return validateRepositoryName(repo);
  }

  // 2. Check legacy GITHUB_REPOSITORY (with deprecation warning and validation)
  repo = process.env.GITHUB_REPOSITORY?.trim();
  if (repo) {
    // If it contains '/', it's in GitHub Actions "owner/repo" format
    // Skip it silently and fall through to other options or defaults
    if (repo.includes('/')) {
      logger.debug(
        `Ignoring GITHUB_REPOSITORY='${repo}' (GitHub Actions owner/repo format). ` +
        `Use PORTFOLIO_REPOSITORY_NAME for portfolio configuration.`
      );
    } else {
      // Valid repo name format, but show deprecation warning
      logger.warn(
        '⚠️  DEPRECATED: Using GITHUB_REPOSITORY for portfolio configuration is deprecated.\n' +
        '   Please use PORTFOLIO_REPOSITORY_NAME instead to avoid conflicts with GitHub Actions.\n' +
        '   Add to your .env.local: PORTFOLIO_REPOSITORY_NAME=' + repo
      );

      return validateRepositoryName(repo);
    }
  }

  // 3-5. Backward compatibility: Check for old variable names
  repo = process.env.TEST_GITHUB_REPO?.trim();
  if (repo) {
    logger.warn('⚠️  DEPRECATED: TEST_GITHUB_REPO is deprecated. Use PORTFOLIO_REPOSITORY_NAME for production or GITHUB_TEST_REPOSITORY for tests.');
    return validateRepositoryName(repo);
  }

  repo = process.env.GITHUB_TEST_REPO?.trim();
  if (repo) {
    logger.warn('⚠️  DEPRECATED: GITHUB_TEST_REPO is deprecated. Use PORTFOLIO_REPOSITORY_NAME for production or GITHUB_TEST_REPOSITORY for tests.');
    return validateRepositoryName(repo);
  }

  repo = process.env.TEST_PORTFOLIO_REPO?.trim();
  if (repo) {
    logger.warn('⚠️  DEPRECATED: TEST_PORTFOLIO_REPO is deprecated. Use PORTFOLIO_REPOSITORY_NAME for production or GITHUB_TEST_REPOSITORY for tests.');
    return validateRepositoryName(repo);
  }

  // TODO: Add support for reading from config file
  // const config = ConfigManager.getInstance();
  // if (config.github?.portfolio?.repository_name) {
  //   return validateRepositoryName(config.github.portfolio.repository_name);
  // }

  // 6. Default repository name
  return 'dollhouse-portfolio';
}

/**
 * Check if we're in a test environment
 *
 * @example
 * // When NODE_ENV=test
 * process.env.NODE_ENV = 'test';
 * const isTest = isTestEnvironment(); // true
 *
 * @example
 * // In production environment
 * process.env.NODE_ENV = 'production';
 * const isTest = isTestEnvironment(); // false
 *
 * @returns {boolean} True if running in a test environment
 */
export function isTestEnvironment(): boolean {
  return process.env.TEST_MODE === 'true' ||
         process.env.NODE_ENV === 'test' ||
         // Backward compatibility: old test detection
         !!process.env.TEST_GITHUB_REPO?.trim() ||
         !!process.env.GITHUB_TEST_TOKEN?.trim();
}