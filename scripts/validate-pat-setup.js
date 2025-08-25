#!/usr/bin/env node

/**
 * GitHub PAT Setup Validation Script
 * 
 * This script validates Personal Access Token (PAT) setup for testing
 * and provides clear instructions for proper configuration.
 * 
 * Checks performed:
 * - Environment variable TEST_GITHUB_TOKEN is set
 * - Token format is valid
 * - Token works with GitHub API
 * - Required scopes are present (repo, read:user, user:email, read:org)
 * - Rate limits and expiration status
 * 
 * Provides actionable feedback and setup instructions.
 */

import { 
  isTestMode, 
  getAuthToken, 
  validateToken 
} from './utils/github-auth.js';
import fs from 'fs/promises';

// Required scopes for full DollhouseMCP functionality
const REQUIRED_SCOPES = [
  { scope: 'repo', description: 'Full repository access (read/write)' },
  { scope: 'read:user', description: 'Read user profile information' },
  { scope: 'user:email', description: 'Access user email addresses' },
  { scope: 'read:org', description: 'Read organization membership' }
];

// Optional but recommended scopes
const OPTIONAL_SCOPES = [
  { scope: 'write:packages', description: 'Upload packages (if using GitHub Packages)' },
  { scope: 'delete:packages', description: 'Delete packages (for cleanup)' },
  { scope: 'gist', description: 'Create/edit gists (for sharing)' }
];

function printHeader() {
  console.log('═'.repeat(75));
  console.log('              GitHub PAT Setup Validation');
  console.log('        Personal Access Token Configuration Check');
  console.log('═'.repeat(75));
  console.log('');
}

function printSection(title) {
  console.log('─'.repeat(50));
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

function printStatus(status, message, details = null) {
  const icon = status === 'success' ? '✅' : status === 'warning' ? '⚠️ ' : '❌';
  console.log(`${icon} ${message}`);
  if (details) {
    console.log(`   ${details}`);
  }
}

function printInstructions() {
  console.log('');
  printSection('Setup Instructions');
  console.log('');
  console.log('To create a Personal Access Token for testing:');
  console.log('');
  console.log('1. 📍 Go to GitHub Settings');
  console.log('   https://github.com/settings/tokens');
  console.log('');
  console.log('2. 🔧 Click "Generate new token (classic)"');
  console.log('   - Give it a descriptive name like "DollhouseMCP Testing"');
  console.log('   - Set expiration (recommend 90 days for testing)');
  console.log('');
  console.log('3. ✅ Select these required scopes:');
  for (const { scope, description } of REQUIRED_SCOPES) {
    console.log(`   ☐ ${scope.padEnd(15)} - ${description}`);
  }
  console.log('');
  console.log('4. 🔧 Optional scopes (for extended functionality):');
  for (const { scope, description } of OPTIONAL_SCOPES) {
    console.log(`   ☐ ${scope.padEnd(15)} - ${description}`);
  }
  console.log('');
  console.log('5. 💾 Copy the token and set it as an environment variable:');
  console.log('   export TEST_GITHUB_TOKEN=<paste_your_token_here>');
  console.log('');
  console.log('   Or add to your shell profile (~/.zshrc, ~/.bashrc):');
  console.log('   echo \'export TEST_GITHUB_TOKEN=<paste_your_token_here>\' >> ~/.zshrc');
  console.log('');
  console.log('6. ✅ Verify setup by running this script again');
  console.log('');
}

async function checkEnvironmentVariable() {
  printSection('Environment Variable Check');
  console.log('');
  
  const token = process.env.TEST_GITHUB_TOKEN;
  
  if (!token) {
    printStatus('error', 'TEST_GITHUB_TOKEN is not set');
    console.log('   This environment variable is required for PAT authentication');
    return { hasToken: false, token: null };
  }
  
  if (token.length < 10) {
    printStatus('error', 'TEST_GITHUB_TOKEN appears to be too short');
    console.log('   GitHub tokens are typically 40+ characters long');
    return { hasToken: false, token: null };
  }
  
  // Check token format
  const isValidFormat = token.startsWith('ghp_') || 
                       token.startsWith('github_pat_') || 
                       token.startsWith('gho_');
  
  if (!isValidFormat) {
    printStatus('warning', 'Token format may be incorrect');
    console.log('   Expected format: ghp_xxxx (classic) or github_pat_xxxx (fine-grained)');
    console.log('   Your token starts with:', token.substring(0, 8) + '...');
  } else {
    printStatus('success', 'TEST_GITHUB_TOKEN is set and has correct format');
    const tokenType = token.startsWith('ghp_') ? 'Classic PAT' : 
                     token.startsWith('github_pat_') ? 'Fine-grained PAT' : 
                     'OAuth token';
    console.log(`   Token type: ${tokenType}`);
    console.log(`   Token prefix: ${token.substring(0, 12)}...`);
  }
  
  console.log('');
  return { hasToken: true, token };
}

async function checkTokenValidity(token) {
  printSection('Token Validity Check');
  console.log('');
  
  if (!token) {
    printStatus('error', 'No token to validate');
    return { valid: false };
  }
  
  try {
    console.log('🔍 Contacting GitHub API...');
    const validation = await validateToken(token);
    
    if (!validation.valid) {
      printStatus('error', 'Token is invalid or expired');
      console.log(`   Error: ${validation.error}`);
      return { valid: false };
    }
    
    printStatus('success', 'Token is valid and active');
    console.log(`   Authenticated as: ${validation.user}`);
    if (validation.name) {
      console.log(`   Display name: ${validation.name}`);
    }
    
    // Check rate limits
    if (validation.rateLimit) {
      const { remaining, limit, reset } = validation.rateLimit;
      const percentage = Math.round((remaining / limit) * 100);
      
      if (remaining < 100) {
        printStatus('warning', `Low rate limit remaining: ${remaining}/${limit} (${percentage}%)`);
        console.log(`   Resets at: ${reset.toLocaleString()}`);
      } else {
        printStatus('success', `Rate limit: ${remaining}/${limit} (${percentage}%)`);
        console.log(`   Resets at: ${reset.toLocaleString()}`);
      }
    }
    
    console.log('');
    return { valid: true, validation };
  } catch (error) {
    printStatus('error', 'Failed to validate token');
    console.log(`   Error: ${error.message}`);
    console.log('   This could indicate network issues or an invalid token');
    console.log('');
    return { valid: false };
  }
}

async function checkScopes(validation) {
  printSection('Scope Validation');
  console.log('');
  
  if (!validation || !validation.scopes) {
    printStatus('error', 'Could not retrieve token scopes');
    return { allRequired: false, missingScopes: REQUIRED_SCOPES.map(s => s.scope) };
  }
  
  const availableScopes = validation.scopes;
  console.log(`Available scopes: ${availableScopes.join(', ') || 'None reported'}`);
  console.log('');
  
  const missingRequired = [];
  const missingOptional = [];
  
  // Check required scopes
  console.log('Required Scopes:');
  for (const { scope, description } of REQUIRED_SCOPES) {
    const hasScope = availableScopes.includes(scope);
    printStatus(hasScope ? 'success' : 'error', 
                `${scope.padEnd(15)} - ${description}`);
    
    if (!hasScope) {
      missingRequired.push(scope);
    }
  }
  
  console.log('');
  
  // Check optional scopes
  console.log('Optional Scopes:');
  for (const { scope, description } of OPTIONAL_SCOPES) {
    const hasScope = availableScopes.includes(scope);
    printStatus(hasScope ? 'success' : 'warning', 
                `${scope.padEnd(15)} - ${description}`);
    
    if (!hasScope) {
      missingOptional.push(scope);
    }
  }
  
  console.log('');
  
  const allRequiredPresent = missingRequired.length === 0;
  
  if (allRequiredPresent) {
    printStatus('success', 'All required scopes are present');
  } else {
    printStatus('error', `Missing ${missingRequired.length} required scope(s)`);
    console.log(`   Missing: ${missingRequired.join(', ')}`);
  }
  
  if (missingOptional.length > 0) {
    printStatus('warning', `Missing ${missingOptional.length} optional scope(s)`);
    console.log(`   Missing: ${missingOptional.join(', ')}`);
    console.log('   Some extended features may not work');
  }
  
  console.log('');
  return { allRequired: allRequiredPresent, missingRequired, missingOptional };
}

async function checkModeDetection() {
  printSection('Mode Detection Check');
  console.log('');
  
  const testMode = isTestMode();
  const token = await getAuthToken();
  
  if (testMode && token) {
    printStatus('success', 'Test mode is correctly detected');
    console.log('   Using TEST_GITHUB_TOKEN for authentication');
    console.log('   This is the recommended mode for automated testing');
  } else if (!testMode && token) {
    printStatus('warning', 'Production mode detected');
    console.log('   Using OAuth token for authentication');
    console.log('   Test mode would be activated if TEST_GITHUB_TOKEN is set');
  } else if (!testMode && !token) {
    printStatus('warning', 'No authentication configured');
    console.log('   Neither PAT nor OAuth token available');
  } else {
    printStatus('error', 'Inconsistent authentication state');
    console.log(`   Test mode: ${testMode}, Token available: ${!!token}`);
  }
  
  console.log('');
  return { testMode, hasToken: !!token };
}

function generateSummary(results) {
  printSection('Setup Summary');
  console.log('');
  
  const { envCheck, validityCheck, scopeCheck, modeCheck } = results;
  
  // Calculate overall status
  const hasValidToken = envCheck.hasToken && validityCheck.valid;
  const hasAllScopes = scopeCheck.allRequired;
  const isFullyConfigured = hasValidToken && hasAllScopes;
  
  if (isFullyConfigured) {
    printStatus('success', 'PAT setup is complete and ready for use! 🎉');
    console.log('');
    console.log('What you can do now:');
    console.log('  ✅ Run automated tests with full GitHub API access');
    console.log('  ✅ Use all DollhouseMCP GitHub integration features');
    console.log('  ✅ Submit personas to collections');
    console.log('  ✅ Browse and install elements from GitHub');
    console.log('');
    console.log('Test your setup:');
    console.log('  npm test');
    console.log('  node test/qa/oauth-pat-test.mjs');
    
  } else if (hasValidToken && !hasAllScopes) {
    printStatus('warning', 'PAT is valid but missing required scopes');
    console.log('');
    console.log('What works:');
    console.log('  ✅ Basic GitHub API access');
    console.log('  ✅ User authentication');
    console.log('');
    console.log('What may not work:');
    if (scopeCheck.missingRequired.includes('repo')) {
      console.log('  ❌ Repository access (browsing, submitting)');
    }
    if (scopeCheck.missingRequired.includes('read:user')) {
      console.log('  ❌ User profile access');
    }
    if (scopeCheck.missingRequired.includes('user:email')) {
      console.log('  ❌ Email access for attribution');
    }
    if (scopeCheck.missingRequired.includes('read:org')) {
      console.log('  ❌ Organization repository access');
    }
    console.log('');
    console.log('To fix: Create a new PAT with the missing scopes listed above.');
    
  } else if (!hasValidToken) {
    printStatus('error', 'PAT setup needs configuration');
    console.log('');
    console.log('Current limitations:');
    console.log('  ❌ Cannot access GitHub API');
    console.log('  ❌ Cannot run GitHub integration tests');
    console.log('  ❌ Cannot submit or browse elements');
    console.log('');
    console.log('To fix: Follow the setup instructions above.');
  }
  
  console.log('');
  
  // Rate limit warning
  if (validityCheck.validation?.rateLimit?.remaining < 500) {
    console.log('⚠️  Note: Your rate limit is getting low.');
    console.log('   Consider limiting API calls or waiting for reset.');
    console.log('');
  }
  
  return isFullyConfigured;
}

async function main() {
  printHeader();
  
  try {
    // Run all checks
    const envCheck = await checkEnvironmentVariable();
    const validityCheck = await checkTokenValidity(envCheck.token);
    const scopeCheck = await checkScopes(validityCheck.validation);
    const modeCheck = await checkModeDetection();
    
    // Generate summary
    const isFullyConfigured = generateSummary({
      envCheck,
      validityCheck,
      scopeCheck,
      modeCheck
    });
    
    // Show instructions if needed
    if (!isFullyConfigured) {
      printInstructions();
    }
    
    console.log('═'.repeat(75));
    
    // Exit with appropriate code
    process.exit(isFullyConfigured ? 0 : 1);
    
  } catch (error) {
    console.log('');
    printStatus('error', 'Validation failed with unexpected error');
    console.log(`Error: ${error.message}`);
    console.log('');
    console.log('This might indicate:');
    console.log('  • Network connectivity issues');
    console.log('  • GitHub API is down');
    console.log('  • Invalid token format');
    console.log('');
    process.exit(2);
  }
}

// If run directly, execute main function
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default {
  checkEnvironmentVariable,
  checkTokenValidity,
  checkScopes,
  checkModeDetection,
  generateSummary,
  REQUIRED_SCOPES,
  OPTIONAL_SCOPES
};