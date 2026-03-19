#!/usr/bin/env node

/**
 * Cleanup Test Data Utility
 * Removes all test files from GitHub test repository
 */

import { setupTestEnvironment } from './setup-test-env.js';
import { GitHubTestClient } from '../helpers/github-api-client.js';

async function cleanupTestData() {
  console.log('\n🧹 DollhouseMCP Test Data Cleanup\n');
  
  try {
    // Setup environment
    const testEnv = await setupTestEnvironment();
    const githubClient = new GitHubTestClient(testEnv);
    
    console.log(`\n📋 Cleanup Configuration:`);
    console.log(`   Repository: ${testEnv.testRepo}`);
    console.log(`   Prefix: ${testEnv.personaPrefix}`);
    console.log(`   Branch: ${testEnv.testBranch}\n`);
    
    // List all files in personas directory
    console.log('🔍 Searching for test files...');
    const allFiles = await githubClient.listFiles('personas');
    
    // Filter for test files
    const testFiles = allFiles.filter(file => 
      file.includes(testEnv.personaPrefix) || 
      file.includes('test-qa-') ||
      file.includes('test-')
    );
    
    if (testFiles.length === 0) {
      console.log('✅ No test files found. Repository is clean!');
      return;
    }
    
    console.log(`\n📁 Found ${testFiles.length} test file(s) to clean:`);
    testFiles.forEach(file => console.log(`   - ${file}`));
    
    // Confirm before deletion
    // SECURITY NOTE: This is a simple warning message string literal, not a path operation
    // The security scanner incorrectly flags this as path traversal - false positive (OWASP-A03-003)
    console.log('\n⚠️  These files will be permanently deleted from GitHub.');
    console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Delete each file
    console.log('🗑️  Deleting test files...');
    let deleted = 0;
    let failed = 0;
    
    for (const file of testFiles) {
      process.stdout.write(`   Deleting ${file}... `);
      const success = await githubClient.deleteFile(file, 'Cleanup test data');
      
      if (success) {
        console.log('✅');
        deleted++;
      } else {
        console.log('❌');
        failed++;
      }
      
      // Rate limit delay
      await new Promise(resolve => setTimeout(resolve, testEnv.rateLimitDelayMs));
    }
    
    // Summary
    console.log('\n📊 Cleanup Summary:');
    console.log(`   ✅ Deleted: ${deleted} file(s)`);
    if (failed > 0) {
      console.log(`   ❌ Failed: ${failed} file(s)`);
    }
    
    // Check rate limit status
    const rateLimit = await githubClient.getRateLimit();
    console.log(`\n⚡ Rate Limit: ${rateLimit.remaining} requests remaining`);
    if (rateLimit.remaining < 100) {
      console.log(`   ⚠️  Rate limit resets at: ${rateLimit.reset.toLocaleString()}`);
    }
    
    console.log('\n✅ Cleanup complete!\n');
    
  } catch (error) {
    console.error('\n❌ Cleanup failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupTestData().catch(console.error);
}

export { cleanupTestData };
