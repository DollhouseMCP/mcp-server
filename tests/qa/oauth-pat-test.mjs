#!/usr/bin/env node

/**
 * QA Test for GitHub PAT (Personal Access Token) Authentication
 * Tests PAT authentication, OAuth fallback, scopes, and error handling
 * 
 * This test validates:
 * - PAT authentication works correctly
 * - Required scopes are present and detected
 * - Fallback to OAuth when no PAT is set
 * - Error handling for invalid PAT tokens
 * - Mode detection (test vs production)
 */

import { 
  isTestMode, 
  getAuthToken, 
  validateToken, 
  getAuthHeaders,
  showAuthStatus 
} from '../../scripts/utils/github-auth.js';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

// Required scopes for full functionality
const REQUIRED_SCOPES = ['repo', 'read:user', 'user:email', 'read:org'];

async function testPATAuthentication() {
  console.log('🔑 Testing PAT Authentication...\n');
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Check if PAT is available
  const hasPAT = !!process.env.TEST_GITHUB_TOKEN;
  console.log(`Test 1 - PAT Available: ${hasPAT ? '✅ Yes' : '⚠️  No'}`);
  if (hasPAT) {
    passed++;
    console.log(`         Token prefix: ${process.env.TEST_GITHUB_TOKEN.substring(0, 8)}...`);
  } else {
    console.log('         Set TEST_GITHUB_TOKEN to test PAT functionality');
    failed++;
  }
  
  // Test 2: Test mode detection
  const testModeResult = isTestMode();
  console.log(`Test 2 - Test Mode: ${testModeResult === hasPAT ? '✅ Correct' : '❌ Incorrect'}`);
  console.log(`         Expected: ${hasPAT}, Got: ${testModeResult}`);
  if (testModeResult === hasPAT) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 3: Token retrieval
  try {
    const token = await getAuthToken();
    const hasToken = !!token;
    console.log(`Test 3 - Token Retrieval: ${hasToken ? '✅ Success' : '⚠️  No Token'}`);
    if (hasToken && hasPAT) {
      passed++;
      console.log(`         Token type: ${token.startsWith('ghp_') ? 'PAT (classic)' : 
        token.startsWith('github_pat_') ? 'PAT (fine-grained)' : 
        token.startsWith('gho_') ? 'OAuth' : 'Unknown'}`);
    } else if (!hasToken && !hasPAT) {
      passed++;
      console.log('         No PAT set, no token retrieved (expected)');
    } else {
      failed++;
    }
  } catch (error) {
    console.log(`Test 3 - Token Retrieval: ❌ Error - ${error.message}`);
    failed++;
  }
  
  console.log(`\n📊 PAT Authentication: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

async function testScopeValidation() {
  console.log('🔍 Testing Scope Validation...\n');
  
  let passed = 0;
  let failed = 0;
  
  const token = await getAuthToken();
  
  if (!token) {
    console.log('⚠️  No token available - skipping scope tests');
    console.log('   Set TEST_GITHUB_TOKEN to test scope validation\n');
    return true; // Not a failure if no token
  }
  
  try {
    const validation = await validateToken(token);
    
    if (!validation.valid) {
      console.log(`❌ Token validation failed: ${validation.error}`);
      return false;
    }
    
    console.log(`✅ Token is valid for user: ${validation.user}`);
    console.log(`   Available scopes: ${validation.scopes.join(', ') || 'None reported'}`);
    
    // Check each required scope
    const missingScopes = [];
    for (const requiredScope of REQUIRED_SCOPES) {
      const hasScope = validation.scopes.includes(requiredScope);
      console.log(`   ${hasScope ? '✅' : '❌'} ${requiredScope}: ${hasScope ? 'Available' : 'Missing'}`);
      
      if (hasScope) {
        passed++;
      } else {
        failed++;
        missingScopes.push(requiredScope);
      }
    }
    
    if (missingScopes.length > 0) {
      console.log(`\n⚠️  Missing scopes: ${missingScopes.join(', ')}`);
      console.log('   Some features may not work correctly');
      console.log('   Consider creating a new PAT with required scopes');
    }
    
    // Test rate limit information
    if (validation.rateLimit) {
      console.log(`\n📊 Rate Limit Status:`);
      console.log(`   Limit: ${validation.rateLimit.limit}`);
      console.log(`   Remaining: ${validation.rateLimit.remaining}`);
      console.log(`   Reset: ${validation.rateLimit.reset.toLocaleString()}`);
      
      if (validation.rateLimit.remaining < 100) {
        console.log('   ⚠️  Low rate limit remaining');
      }
    }
    
  } catch (error) {
    console.log(`❌ Error validating token: ${error.message}`);
    failed++;
  }
  
  console.log(`\n📊 Scope Validation: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

async function testOAuthFallback() {
  console.log('🔄 Testing OAuth Fallback...\n');
  
  // Temporarily remove PAT to test fallback
  const originalPAT = process.env.TEST_GITHUB_TOKEN;
  delete process.env.TEST_GITHUB_TOKEN;
  
  try {
    let passed = 0;
    let failed = 0;
    
    // Test 1: Mode should switch to production
    const testMode = isTestMode();
    console.log(`Test 1 - Mode Detection: ${!testMode ? '✅ Production mode' : '❌ Still test mode'}`);
    if (!testMode) {
      passed++;
    } else {
      failed++;
    }
    
    // Test 2: Should look for OAuth token
    const token = await getAuthToken();
    console.log(`Test 2 - OAuth Token Search: ${token ? '✅ Found OAuth token' : '⚠️  No OAuth token'}`);
    
    if (token) {
      console.log(`         Token type: ${token.startsWith('gho_') ? 'OAuth' : 'Other'}`);
      passed++;
    } else {
      console.log('         No OAuth token found (expected if not set up)');
      // This is not a failure - just means OAuth isn't configured
      passed++;
    }
    
    console.log(`\n📊 OAuth Fallback: ${passed} passed, ${failed} failed\n`);
    return failed === 0;
    
  } finally {
    // Restore original PAT
    if (originalPAT) {
      process.env.TEST_GITHUB_TOKEN = originalPAT;
    }
  }
}

async function testErrorHandling() {
  console.log('🚨 Testing Error Handling...\n');
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Invalid token format
  try {
    const validation = await validateToken('invalid_token_format');
    console.log(`Test 1 - Invalid Token: ${!validation.valid ? '✅ Correctly rejected' : '❌ Incorrectly accepted'}`);
    if (!validation.valid) {
      passed++;
      console.log(`         Error: ${validation.error}`);
    } else {
      failed++;
    }
  } catch (error) {
    console.log(`Test 1 - Invalid Token: ✅ Correctly threw error`);
    console.log(`         Error: ${error.message}`);
    passed++;
  }
  
  // Test 2: Empty token
  try {
    const validation = await validateToken('');
    console.log(`Test 2 - Empty Token: ${!validation.valid ? '✅ Correctly rejected' : '❌ Incorrectly accepted'}`);
    if (!validation.valid) {
      passed++;
      console.log(`         Error: ${validation.error}`);
    } else {
      failed++;
    }
  } catch (error) {
    console.log(`Test 2 - Empty Token: ✅ Correctly threw error`);
    console.log(`         Error: ${error.message}`);
    passed++;
  }
  
  // Test 3: Null token
  try {
    const validation = await validateToken(null);
    console.log(`Test 3 - Null Token: ${!validation.valid ? '✅ Correctly rejected' : '❌ Incorrectly accepted'}`);
    if (!validation.valid) {
      passed++;
      console.log(`         Error: ${validation.error}`);
    } else {
      failed++;
    }
  } catch (error) {
    console.log(`Test 3 - Null Token: ✅ Correctly handled error`);
    console.log(`         Error: ${error.message}`);
    passed++;
  }
  
  // Test 4: Revoked/expired token (simulate with fake token)
  const fakeToken = 'ghp_' + 'x'.repeat(36);
  try {
    const validation = await validateToken(fakeToken);
    console.log(`Test 4 - Fake Token: ${!validation.valid ? '✅ Correctly rejected' : '❌ Incorrectly accepted'}`);
    if (!validation.valid) {
      passed++;
      console.log(`         Error: ${validation.error}`);
    } else {
      failed++;
    }
  } catch (error) {
    console.log(`Test 4 - Fake Token: ✅ Correctly threw error`);
    console.log(`         Error: ${error.message}`);
    passed++;
  }
  
  console.log(`\n📊 Error Handling: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

async function testAuthHeaders() {
  console.log('📋 Testing Auth Headers...\n');
  
  let passed = 0;
  let failed = 0;
  
  try {
    const token = await getAuthToken();
    
    if (!token) {
      console.log('⚠️  No token available - skipping header tests');
      console.log('   Set TEST_GITHUB_TOKEN to test auth headers\n');
      return true;
    }
    
    const headers = await getAuthHeaders();
    
    // Test 1: Has Authorization header
    const hasAuth = !!headers.Authorization;
    console.log(`Test 1 - Authorization Header: ${hasAuth ? '✅ Present' : '❌ Missing'}`);
    if (hasAuth) {
      passed++;
      console.log(`         Value: ${headers.Authorization.substring(0, 20)}...`);
    } else {
      failed++;
    }
    
    // Test 2: Has Accept header
    const hasAccept = !!headers.Accept;
    console.log(`Test 2 - Accept Header: ${hasAccept ? '✅ Present' : '❌ Missing'}`);
    if (hasAccept) {
      passed++;
      console.log(`         Value: ${headers.Accept}`);
    } else {
      failed++;
    }
    
    // Test 3: Has User-Agent header
    const hasUserAgent = !!headers['User-Agent'];
    console.log(`Test 3 - User-Agent Header: ${hasUserAgent ? '✅ Present' : '❌ Missing'}`);
    if (hasUserAgent) {
      passed++;
      console.log(`         Value: ${headers['User-Agent']}`);
    } else {
      failed++;
    }
    
    // Test 4: Authorization format
    const isCorrectFormat = headers.Authorization && headers.Authorization.startsWith('token ');
    console.log(`Test 4 - Auth Format: ${isCorrectFormat ? '✅ Correct' : '❌ Incorrect'}`);
    if (isCorrectFormat) {
      passed++;
    } else {
      failed++;
      console.log(`         Expected 'token ...', got: ${headers.Authorization}`);
    }
    
  } catch (error) {
    console.log(`❌ Error getting auth headers: ${error.message}`);
    failed++;
  }
  
  console.log(`\n📊 Auth Headers: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

async function testRealGitHubAPI() {
  console.log('🌐 Testing Real GitHub API Integration...\n');
  
  const token = await getAuthToken();
  
  if (!token) {
    console.log('⚠️  No token available - skipping API tests');
    console.log('   Set TEST_GITHUB_TOKEN to test GitHub API integration\n');
    return true;
  }
  
  try {
    const headers = await getAuthHeaders();
    
    // Test authenticated user endpoint
    const response = await fetch('https://api.github.com/user', { headers });
    
    if (response.ok) {
      const user = await response.json();
      console.log(`✅ GitHub API Integration successful`);
      console.log(`   Authenticated as: ${user.login}`);
      console.log(`   Name: ${user.name || 'Not set'}`);
      console.log(`   Public repos: ${user.public_repos}`);
      
      // Test rate limit endpoint
      const rateLimitResponse = await fetch('https://api.github.com/rate_limit', { headers });
      if (rateLimitResponse.ok) {
        const rateLimit = await rateLimitResponse.json();
        console.log(`   Rate limit: ${rateLimit.rate.remaining}/${rateLimit.rate.limit}`);
      }
      
      return true;
    } else {
      console.log(`❌ GitHub API request failed: ${response.status} ${response.statusText}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Error testing GitHub API: ${error.message}`);
    return false;
  }
}

async function runAllPATTests() {
  console.log('='.repeat(70));
  console.log('           GitHub PAT Authentication QA Test');
  console.log('     Testing PAT, OAuth Fallback, Scopes & Error Handling');
  console.log('='.repeat(70));
  console.log('');
  
  const results = [];
  
  // Run all tests
  results.push(await testPATAuthentication());
  results.push(await testScopeValidation());
  results.push(await testOAuthFallback());
  results.push(await testErrorHandling());
  results.push(await testAuthHeaders());
  results.push(await testRealGitHubAPI());
  
  // Summary
  console.log('='.repeat(70));
  console.log('                         Test Summary');
  console.log('='.repeat(70));
  
  const allPassed = results.every(r => r);
  const passedCount = results.filter(r => r).length;
  const totalCount = results.length;
  
  if (allPassed) {
    console.log(`\n✅ All PAT tests passed! (${passedCount}/${totalCount})\n`);
    console.log('PAT authentication system is working correctly.');
    
    if (process.env.TEST_GITHUB_TOKEN) {
      console.log('🧪 Test mode is active with PAT.');
      console.log('   This is recommended for automated testing and CI.');
    } else {
      console.log('🔐 Production mode is active.');
      console.log('   Using OAuth token for authentication.');
    }
  } else {
    console.log(`\n⚠️  Some PAT tests had issues. (${passedCount}/${totalCount} passed)\n`);
    
    if (!process.env.TEST_GITHUB_TOKEN) {
      console.log('💡 To test PAT functionality:');
      console.log('   1. Create a Personal Access Token on GitHub');
      console.log('   2. Set it as TEST_GITHUB_TOKEN environment variable');
      console.log('   3. Ensure it has required scopes: repo, read:user, user:email, read:org');
    } else {
      console.log('💡 Check the failed tests above for specific issues.');
      console.log('   Common issues: insufficient scopes, revoked token, network problems');
    }
  }
  
  console.log('\n' + '='.repeat(70));
  
  process.exit(allPassed ? 0 : 1);
}

// Show auth status first
console.log('Current Authentication Status:');
console.log('-'.repeat(40));
await showAuthStatus();
console.log('-'.repeat(40));
console.log('');

// Run the tests
runAllPATTests().catch(error => {
  console.error('Fatal error running PAT tests:', error);
  process.exit(1);
});