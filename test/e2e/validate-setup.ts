#!/usr/bin/env tsx

/**
 * Validate Test Environment Setup
 * Run this to check if your GitHub integration tests are properly configured
 */

import { setupTestEnvironment } from './setup-test-env.js';

async function validate() {
  console.log('\n🔍 Validating GitHub Integration Test Setup\n');
  
  try {
    const env = await setupTestEnvironment();
    
    console.log('\n✅ All checks passed! Your environment is ready for testing.\n');
    console.log('📋 Configuration Summary:');
    console.log(`   Token: ${env.githubToken.substring(0, 10)}...`);
    console.log(`   Repository: ${env.testRepo}`);
    console.log(`   User: ${env.githubUser}`);
    console.log(`   Cleanup: ${env.cleanupAfter ? 'Yes' : 'No'}`);
    console.log(`   Persona Prefix: ${env.personaPrefix}`);
    
    console.log('\n🚀 Ready to run tests! Use:');
    console.log('   npm run test:e2e:real');
    console.log('');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Setup validation failed:\n');
    console.error(error);
    console.error('\n📚 Please check the README for setup instructions.');
    console.error('   Path: test/e2e/README.md\n');
    process.exit(1);
  }
}

validate();