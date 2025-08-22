# OAuth Token Issue #517 Investigation

## Problem Summary
OAuth tokens are not being read correctly. According to session notes, the OAuth flow IS working and tokens are being created, but there's a disconnect in how they're being validated or read.

## Current State Analysis

### Token Validation Patterns (tokenManager.ts)
```typescript
OAUTH_ACCESS_TOKEN: /^gho_[A-Za-z0-9_]{16,}$/  // Requires minimum 16 chars after gho_
```

### Token Reading Flow
1. `getGitHubTokenAsync()` checks:
   - Environment variable (GITHUB_TOKEN)
   - Encrypted storage (github_token.enc)
   - ❌ Does NOT check pending_token.txt

### OAuth Helper Behavior
- oauth-helper.mjs tries to import TokenManager
- If import fails (common with ESM/CommonJS issues), falls back to saving to `pending_token.txt`
- TokenManager never reads from this fallback location

## User Clarification
User mentioned that the issue might be overly restrictive token validation. GitHub may have changed their token formats, and we're being too strict with character requirements.

## Solution Approach
1. Make token validation more flexible - accept any `gho_` prefix with ANY content after it
2. Consider adding support for new token prefixes (GitHub seems to be going through the alphabet)
3. Optionally: Add fallback to check pending_token.txt

## Next Steps
1. Update token validation patterns to be more permissive
2. Test with actual OAuth tokens
3. Ensure backward compatibility