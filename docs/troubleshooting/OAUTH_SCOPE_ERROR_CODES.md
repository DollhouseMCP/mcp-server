# OAuth Scope Validation Error Codes

## Overview

This document describes error codes related to OAuth token validation, particularly the scope mismatch issue that was fixed in PR #789.

## Error Codes

### TOKEN_VALIDATION_FAILED
**Message**: "GitHub token is invalid or expired. Please re-authenticate."

**Cause**: Token validation failed due to missing required scopes.

**Previous Issue**: OAuth tokens have `public_repo` scope but validation was checking for `repo` scope.

**Solution**: Fixed in PR #789 - Now correctly validates against `public_repo` scope for OAuth tokens.

### INVALID_TOKEN_FORMAT
**Message**: "Invalid token format. Please re-authenticate."

**Cause**: Token doesn't match any known GitHub token patterns (ghp_, gho_, github_pat_, etc.)

**Solution**: Re-authenticate using `setup_github_auth` command.

### TOKEN_VALIDATION_ERROR
**Message**: "Unable to validate GitHub token. Please check your connection and try again."

**Cause**: Network error or other unexpected error during validation.

**Solution**: Check network connection and retry.

### NOT_AUTHENTICATED  
**Message**: "Not authenticated. Please authenticate first using the GitHub OAuth flow."

**Cause**: No authentication present.

**Solution**: Run `setup_github_auth` to authenticate.

### NO_TOKEN
**Message**: "No GitHub token available. Please authenticate first."

**Cause**: Token retrieval failed.

**Solution**: Run `setup_github_auth` to re-authenticate.

## Scope Requirements

### OAuth Tokens (Device Flow)
- **Required Scope**: `public_repo`
- **Token Prefix**: `gho_`
- **Access**: Public repositories only

### Personal Access Tokens (PATs)
- **Classic PAT Scope**: `repo` (includes public_repo)
- **Fine-grained PAT**: Configure with repository access
- **Token Prefix**: `ghp_` or `github_pat_`
- **Access**: Both public and private repositories

## Testing the Fix

1. **Check Authentication**:
   ```
   check_github_auth
   ```
   Should show connected with `public_repo` scope.

2. **Configure Auto-Submit**:
   ```
   configure_collection_submission autoSubmit: true
   ```

3. **Submit Content**:
   ```
   submit_content "YourContentName"
   ```
   Should now work with OAuth tokens.

## Historical Context

### The Problem
- OAuth device flow requests `public_repo` scope
- Collection submission was validating for `repo` scope  
- This caused "token invalid or expired" errors despite successful auth

### The Fix (PR #789)
- Changed validation from `repo` to `public_repo` in:
  - `submitToPortfolioTool.ts`
  - `TokenManager.getRequiredScopes()`
- Added comments explaining OAuth vs PAT scope differences
- Ensured backward compatibility (PATs with `repo` still work)

## Validation Process

The token validation follows this flow:

1. **Format Check**: Verify token matches GitHub patterns
2. **API Validation**: Call GitHub API to verify token
3. **Scope Check**: Ensure `public_repo` scope is present
4. **Rate Limit Check**: Monitor API rate limits
5. **Expiration Check**: Warn if token may be expiring soon

## Rate Limiting

If validation is rate limited, the system will:
- Log a warning
- Allow the operation to proceed (trusting format check)
- Error code: `RATE_LIMIT_EXCEEDED` (handled gracefully)

---

*Last Updated: August 27, 2025 - OAuth scope validation fix*