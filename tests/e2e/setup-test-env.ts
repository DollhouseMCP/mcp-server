/**
 * Test Environment Setup and Validation
 * Validates GitHub token and test repository before running tests
 * 
 * SECURITY NOTE: This is a test environment setup utility for controlled testing.
 * Unicode normalization (DMCP-SEC-004) and audit logging (DMCP-SEC-006) are not
 * required as this only sets up test environments with known, controlled data.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import {
  getTestGitHubToken,
  hasTestCredentials,
  getTestSkipMessage,
  getTestGitHubUsername,
  getTestGitHubRepository
} from '../../src/config/test-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TestEnvironment {
  githubToken: string;
  testRepo?: string;
  githubUser?: string;
  cleanupAfter?: boolean;
  verboseLogging?: boolean;
  retryAttempts?: number;
  timeoutMs?: number;
  rateLimitDelayMs?: number;
  maxConcurrentRequests?: number;
  personaPrefix?: string;
  testBranch?: string;
  skipTests?: boolean;
}

/**
 * Load and validate test environment configuration
 */
export async function setupTestEnvironment(): Promise<TestEnvironment> {
  // Try to load .env.test.local for other settings
  const envPath = path.join(__dirname, '.env.test.local');

  try {
    await fs.access(envPath);
    dotenv.config({ path: envPath });
    console.log('✅ Loaded test configuration from .env.test.local');
  } catch {
    console.log('ℹ️ No .env.test.local found, using environment variables');
  }

  // Check if test credentials are configured using centralized helper
  if (!hasTestCredentials()) {
    console.log(getTestSkipMessage());
    return {
      githubToken: '',
      skipTests: true
    };
  }

  // Get test token using centralized helper (throws if missing)
  const githubToken = getTestGitHubToken();

  // Only proceed with full setup if we have a token
  try {
    // Use centralized helpers for username and repository
    const githubUser = getTestGitHubUsername() || await getGitHubUser(githubToken);
    const testRepo = getTestGitHubRepository() || 'dollhouse-portfolio-test';

    // Validate repository format - must be JUST the repo name, not "owner/repo"
    if (testRepo.includes('/')) {
      throw new Error(
        `GITHUB_TEST_REPOSITORY format error!\n` +
        `Expected: Just repo name (e.g., 'dollhouse-test-sandbox')\n` +
        `Got: '${testRepo}' (contains '/')\n` +
        `The username is provided separately via GITHUB_TEST_USERNAME.\n` +
        `Please update your .env.local file.`
      );
    }

    // Parse optional settings with defaults
    const config: TestEnvironment = {
      githubToken,
      testRepo: `${githubUser}/${testRepo}`,  // Always construct full path
      githubUser,
      cleanupAfter: process.env.TEST_CLEANUP_AFTER !== 'false',
      verboseLogging: process.env.TEST_VERBOSE_LOGGING === 'true',
      retryAttempts: Number.parseInt(process.env.TEST_RETRY_ATTEMPTS || '3'),
      timeoutMs: Number.parseInt(process.env.TEST_TIMEOUT_MS || '30000'),
      rateLimitDelayMs: Number.parseInt(process.env.TEST_RATE_LIMIT_DELAY_MS || '1000'),
      maxConcurrentRequests: Number.parseInt(process.env.TEST_MAX_CONCURRENT_REQUESTS || '3'),
      personaPrefix: process.env.TEST_PERSONA_PREFIX || 'test-qa-',
      testBranch: process.env.TEST_BRANCH || 'main'
    };

    // Validate the configuration
    await validateTestEnvironment(config);

    return config;
  } catch (error) {
    // If validation fails, return skip configuration
    console.log('⏭️  Skipping E2E tests due to validation error:', error instanceof Error ? error.message : String(error));
    return {
      githubToken: '',
      skipTests: true
    };
  }
}

/**
 * Get GitHub username from token
 */
async function getGitHubUser(token: string): Promise<string> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to get GitHub user: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.login;
}

/**
 * Validate test environment configuration
 */
async function validateTestEnvironment(config: TestEnvironment): Promise<void> {
  console.log('\n🔍 Validating test environment...');
  
  // Check token scopes
  const scopesResponse = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${config.githubToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!scopesResponse.ok) {
    if (scopesResponse.status === 401) {
      throw new Error('❌ GitHub token is invalid or expired');
    }
    throw new Error(`❌ Failed to validate token: ${scopesResponse.status} ${scopesResponse.statusText}`);
  }

  const scopes = scopesResponse.headers.get('x-oauth-scopes') || '';
  const requiredScopes = ['repo', 'public_repo'];
  const hasRequiredScope = requiredScopes.some(scope => scopes.includes(scope));

  if (!hasRequiredScope) {
    throw new Error(
      `❌ GitHub token missing required scope. Has: "${scopes}"\n` +
      `   Need one of: ${requiredScopes.join(' or ')}`
    );
  }

  console.log(`✅ GitHub token valid with scopes: ${scopes}`);
  console.log(`✅ Test repo: ${config.testRepo}`);
  console.log(`✅ GitHub user: ${config.githubUser}`);
  
  // Check if test repo exists (create if needed)
  const [owner, repo] = config.testRepo.split('/');
  const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      'Authorization': `Bearer ${config.githubToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!repoResponse.ok && repoResponse.status === 404) {
    console.log(`📦 Test repository ${config.testRepo} not found. Creating...`);
    await createTestRepository(config);
  } else if (repoResponse.ok) {
    console.log(`✅ Test repository ${config.testRepo} exists`);
  } else {
    throw new Error(`❌ Failed to check repository: ${repoResponse.status} ${repoResponse.statusText}`);
  }

  console.log('\n✅ Test environment ready!\n');
}

/**
 * Create test repository if it doesn't exist
 */
async function createTestRepository(config: TestEnvironment): Promise<void> {
  const [, repoName] = config.testRepo.split('/');
  
  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: repoName,
      description: 'Test repository for DollhouseMCP QA testing',
      private: false,
      auto_init: true
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create test repository: ${JSON.stringify(error)}`);
  }

  console.log(`✅ Created test repository: ${config.testRepo}`);
  
  // Wait a moment for GitHub to initialize the repo
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Export error codes for testing
 */
export const ERROR_CODES = {
  PORTFOLIO_SYNC_001: 'Authentication failure',
  PORTFOLIO_SYNC_002: 'Repository not found',
  PORTFOLIO_SYNC_003: 'File creation failed',
  PORTFOLIO_SYNC_004: 'API response parsing error',
  PORTFOLIO_SYNC_005: 'Network error',
  PORTFOLIO_SYNC_006: 'Rate limit exceeded'
} as const;