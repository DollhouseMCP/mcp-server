/**
 * Test Environment Setup and Validation
 * Validates GitHub token and test repository before running tests
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

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
  // Try to load .env.test.local first, then fall back to environment variables
  const envPath = path.join(__dirname, '.env.test.local');
  
  try {
    await fs.access(envPath);
    dotenv.config({ path: envPath });
    console.log('✅ Loaded test configuration from .env.test.local');
  } catch {
    console.log('ℹ️ No .env.test.local found, using environment variables');
  }

  // Validate required variables
  const githubToken = process.env.GITHUB_TEST_TOKEN;
  if (!githubToken) {
    // In CI environment, skip tests that require GitHub token
    if (process.env.CI) {
      console.log('⏭️  Skipping E2E tests in CI - GITHUB_TEST_TOKEN not available');
      return {
        githubToken: '',
        skipTests: true
      };
    }
    throw new Error(
      'GITHUB_TEST_TOKEN is required. Please set it in .env.test.local or environment variables.\n' +
      'Create a token at: https://github.com/settings/tokens with "repo" scope'
    );
  }

  const testRepo = process.env.GITHUB_TEST_REPO || 'dollhouse-portfolio-test';
  const githubUser = process.env.GITHUB_TEST_USER || await getGitHubUser(githubToken);

  // Parse optional settings with defaults
  const config: TestEnvironment = {
    githubToken,
    testRepo: testRepo.includes('/') ? testRepo : `${githubUser}/${testRepo}`,
    githubUser,
    cleanupAfter: process.env.TEST_CLEANUP_AFTER !== 'false',
    verboseLogging: process.env.TEST_VERBOSE_LOGGING === 'true',
    retryAttempts: parseInt(process.env.TEST_RETRY_ATTEMPTS || '3'),
    timeoutMs: parseInt(process.env.TEST_TIMEOUT_MS || '30000'),
    rateLimitDelayMs: parseInt(process.env.TEST_RATE_LIMIT_DELAY_MS || '1000'),
    maxConcurrentRequests: parseInt(process.env.TEST_MAX_CONCURRENT_REQUESTS || '3'),
    personaPrefix: process.env.TEST_PERSONA_PREFIX || 'test-qa-',
    testBranch: process.env.TEST_BRANCH || 'main'
  };

  // Validate the configuration
  await validateTestEnvironment(config);
  
  return config;
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
  const [_, repoName] = config.testRepo.split('/');
  
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