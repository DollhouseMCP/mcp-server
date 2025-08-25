#!/usr/bin/env node

/**
 * GitHub Authentication Utility
 * 
 * Provides unified authentication for GitHub API access
 * Supports both PAT (testing) and OAuth token (production)
 * 
 * WARNING: PAT mode is for TESTING ONLY
 * Production uses OAuth device flow - see docs/development/OAUTH_TESTING_VS_PRODUCTION.md
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/**
 * Check if running in test mode (PAT available)
 */
export function isTestMode() {
  return !!process.env.TEST_GITHUB_TOKEN;
}

/**
 * Get the appropriate auth token
 * @returns {Promise<string|null>} Token or null if not authenticated
 */
export async function getAuthToken() {
  // WARNING: Test mode - using PAT instead of OAuth
  if (process.env.TEST_GITHUB_TOKEN) {
    console.log('🧪 Using PAT for testing (not production OAuth flow)');
    return process.env.TEST_GITHUB_TOKEN;
  }
  
  // Production mode - look for OAuth token
  const tokenPaths = [
    path.join(homedir(), '.dollhouse', '.github_token'),
    path.join(homedir(), '.dollhouse', '.auth', 'github_token.txt'),
    path.join(process.cwd(), '.github_token')
  ];
  
  for (const tokenPath of tokenPaths) {
    try {
      const token = await fs.readFile(tokenPath, 'utf-8');
      const trimmed = token.trim();
      if (trimmed && (trimmed.startsWith('gho_') || trimmed.startsWith('ghp_') || trimmed.startsWith('github_pat_'))) {
        console.log('✅ Using OAuth token from:', tokenPath);
        return trimmed;
      }
    } catch (error) {
      // File doesn't exist or can't be read, try next
      continue;
    }
  }
  
  return null;
}

/**
 * Validate a GitHub token
 * @param {string} token - Token to validate
 * @returns {Promise<Object>} Validation result
 */
export async function validateToken(token) {
  if (!token) {
    return { valid: false, error: 'No token provided' };
  }
  
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (!response.ok) {
      return { 
        valid: false, 
        error: `GitHub API returned ${response.status}: ${response.statusText}` 
      };
    }
    
    const user = await response.json();
    
    // Check rate limit to verify scopes
    const rateResponse = await fetch('https://api.github.com/rate_limit', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    const rateLimit = await rateResponse.json();
    const scopes = rateResponse.headers.get('x-oauth-scopes') || '';
    
    return {
      valid: true,
      user: user.login,
      name: user.name,
      scopes: scopes.split(',').map(s => s.trim()).filter(Boolean),
      rateLimit: {
        limit: rateLimit.rate.limit,
        remaining: rateLimit.rate.remaining,
        reset: new Date(rateLimit.rate.reset * 1000)
      },
      isTestMode: isTestMode()
    };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to validate token: ${error.message}`
    };
  }
}

/**
 * Get auth headers for GitHub API requests
 * @param {string} [token] - Optional token, will auto-detect if not provided
 * @returns {Promise<Object>} Headers object
 */
export async function getAuthHeaders(token) {
  const authToken = token || await getAuthToken();
  
  if (!authToken) {
    throw new Error('No GitHub authentication token available');
  }
  
  return {
    'Authorization': `token ${authToken}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'DollhouseMCP-OAuth-Test'
  };
}

/**
 * Display authentication status
 */
export async function showAuthStatus() {
  const token = await getAuthToken();
  
  if (!token) {
    console.log('❌ Not authenticated');
    console.log('   Set TEST_GITHUB_TOKEN for testing or use OAuth device flow for production');
    return false;
  }
  
  const validation = await validateToken(token);
  
  if (!validation.valid) {
    console.log('❌ Invalid token:', validation.error);
    return false;
  }
  
  console.log('✅ Authenticated as:', validation.user);
  console.log('   Name:', validation.name || 'Not set');
  console.log('   Mode:', validation.isTestMode ? '🧪 TEST (PAT)' : '🔐 PRODUCTION (OAuth)');
  
  if (validation.scopes.length > 0) {
    console.log('   Scopes:', validation.scopes.join(', '));
  }
  
  console.log('   Rate Limit:', `${validation.rateLimit.remaining}/${validation.rateLimit.limit}`);
  console.log('   Reset:', validation.rateLimit.reset.toLocaleTimeString());
  
  // Warn if using PAT in what looks like production
  if (validation.isTestMode && !process.env.CI && !process.env.TEST) {
    console.log('\n⚠️  WARNING: Using PAT outside of CI/TEST environment');
    console.log('   PAT should only be used for automated testing');
    console.log('   Production should use OAuth device flow');
  }
  
  return true;
}

// If run directly, show auth status
if (import.meta.url === `file://${process.argv[1]}`) {
  showAuthStatus().then(success => {
    process.exit(success ? 0 : 1);
  });
}

export default {
  isTestMode,
  getAuthToken,
  validateToken,
  getAuthHeaders,
  showAuthStatus
};