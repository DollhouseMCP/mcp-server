# OAuth Investigation Findings

**Date**: August 22, 2025  
**Investigator**: Opus 4.1  
**Issue**: OAuth token persistence (#517)

## Executive Summary

**The OAuth flow IS working!** The token is being created and stored at `~/.dollhouse/.auth/pending_token.txt`. However, there appears to be a disconnect in how the token is being read back by the MCP server.

## How the Current OAuth Flow Works

### 1. Device Flow Initiation ✅
- User runs `setup_github_auth` tool
- Server calls `initiateDeviceFlow()` 
- Returns device code (e.g., "2CDB-592B")
- User visits GitHub and enters code

### 2. Background Polling Process ✅
- Server spawns `oauth-helper.mjs` as detached process
- Helper polls GitHub every 5 seconds
- When user authorizes, GitHub returns access token
- Token is stored at `~/.dollhouse/.auth/pending_token.txt`

### 3. Token Storage ✅
**Evidence Found:**
- Token file exists: `~/.dollhouse/.auth/pending_token.txt`
- Token value: `gho_[REDACTED]` (valid GitHub token format)
- OAuth state tracked in: `~/.dollhouse/.auth/oauth-helper-state.json`

### 4. Token Retrieval ❌ 
**THIS IS WHERE IT BREAKS**
- The MCP server doesn't seem to read the stored token
- `checkGitHubAuth()` returns not authenticated
- QA tests show "No GitHub token found in environment"

## Root Cause Analysis

### The Problem
The token is being stored in `~/.dollhouse/.auth/pending_token.txt` but the TokenManager or GitHubAuthManager isn't reading from this location.

### Evidence
1. **Token IS stored**: File exists with valid GitHub token
2. **Helper IS working**: oauth-helper.mjs successfully polls and stores token
3. **Server NOT reading**: Auth status shows not authenticated despite token existing

### Likely Issue
The TokenManager is probably looking for the token in a different location or format than where oauth-helper.mjs stores it.

## Quick Fix Approach

### Option 1: Update TokenManager to Read from pending_token.txt
```typescript
// In TokenManager or GitHubAuthManager
async getStoredToken(): Promise<string | null> {
  // Check new location first
  const pendingTokenPath = path.join(homedir(), '.dollhouse', '.auth', 'pending_token.txt');
  try {
    const token = await fs.readFile(pendingTokenPath, 'utf-8');
    if (token && token.startsWith('gho_')) {
      return token.trim();
    }
  } catch (e) {
    // Fall back to other locations
  }
  
  // Check other locations...
  return null;
}
```

### Option 2: Move Token After Polling Completes
Update oauth-helper.mjs to move the token to wherever TokenManager expects it.

### Option 3: Unified Token Storage
Create a single source of truth for token storage that both oauth-helper and TokenManager use.

## Testing the Fix

### Manual Test Steps
1. Clear any existing auth: `rm -rf ~/.dollhouse/.auth`
2. Run setup_github_auth tool
3. Complete GitHub authorization
4. Check if token persists: `cat ~/.dollhouse/.auth/pending_token.txt`
5. Run check_github_auth tool
6. Should show authenticated with username

### QA Test Validation
```javascript
// Add to QA tests
async function testOAuthRoundtrip() {
  // 1. Setup OAuth (mock or real)
  await setupGitHubAuth();
  
  // 2. Wait for token
  await waitForToken();
  
  // 3. Verify authentication
  const status = await checkGitHubAuth();
  assert(status.isAuthenticated);
  
  // 4. Test GitHub API call
  const user = await getGitHubUser();
  assert(user.login);
  
  // 5. Clear auth
  await clearGitHubAuth();
}
```

## Immediate Action Items

### 1. Find Where TokenManager Expects Token
Need to check:
- `src/security/tokenManager.ts`
- `src/auth/GitHubAuthManager.ts`
- Where `getAuthStatus()` looks for tokens

### 2. Align Token Storage Locations
Either:
- Update TokenManager to read from `pending_token.txt`
- Update oauth-helper to write where TokenManager expects
- Create symlink between locations

### 3. Add Token Migration
If token location changed, add migration code to move existing tokens.

## Impact on Roundtrip Testing

Once fixed, this enables:
1. ✅ OAuth authentication
2. ✅ GitHub API access
3. ✅ Portfolio uploads
4. ✅ Collection submissions
5. ✅ Full roundtrip QA test

## Recommendation

**Quick Fix**: Update TokenManager to also check `~/.dollhouse/.auth/pending_token.txt` when looking for tokens. This is a 5-minute fix that would immediately resolve the issue.

**Long-term**: Consolidate token storage to a single, well-documented location with proper encryption.

---

*The good news: OAuth IS working! We just need to connect the token storage with token reading.*