// Test that OAuth flow works with default client ID
import { GitHubAuthManager } from './dist/auth/GitHubAuthManager.js';
import { APICache } from './dist/cache/APICache.js';

async function testOAuthDefault() {
  console.log('Testing OAuth with default client ID...');
  
  // Remove any env variable to ensure we're using the default
  delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
  
  const apiCache = new APICache();
  const authManager = new GitHubAuthManager(apiCache);
  
  try {
    // This should work now with the default client ID
    const deviceCode = await authManager.initiateDeviceFlow();
    
    console.log('✅ SUCCESS! OAuth device flow initiated with default client ID');
    console.log('User code:', deviceCode.user_code);
    console.log('Verification URL:', deviceCode.verification_uri);
    
    // Don't actually poll for token in test
    return true;
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    return false;
  }
}

testOAuthDefault().then(success => {
  process.exit(success ? 0 : 1);
});
