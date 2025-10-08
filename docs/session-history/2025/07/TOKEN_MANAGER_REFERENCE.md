# SecureTokenManager Reference Guide

## Overview
The SecureTokenManager provides secure GitHub token management with validation, caching, and error sanitization for DollhouseMCP.

## API Reference

### Main Method
```typescript
static async getSecureGitHubToken(scope: TokenScope): Promise<string>
```

### Token Scopes
```typescript
enum TokenScope {
  READ = 'read',   // Requires: repo or public_repo
  WRITE = 'write',  // Requires: repo or public_repo
  ADMIN = 'admin'   // Requires: repo AND admin:org
}
```

### Supported Token Formats
1. **Classic PAT**: `ghp_` + 36 alphanumeric chars
2. **OAuth Token**: `gho_` + 36 alphanumeric chars
3. **Fine-grained PAT**: `github_pat_` + 82 alphanumeric/underscore chars

## Implementation Details

### Token Validation Flow
```
1. Check cache for existing token
2. If cached and fresh (<1 hour), validate permissions
3. If not cached, get from environment
4. Validate format with regex
5. Validate permissions via GitHub API
6. Cache token with metadata
7. Return validated token
```

### Error Sanitization
All errors are sanitized to remove:
- Token patterns (ghp_*, gho_*, github_pat_*)
- Bearer tokens
- Environment variable values
- Replaced with: `[REDACTED]`

### Caching Behavior
- Cache key: 'github' (hardcoded)
- TTL: 1 hour (3600000ms)
- Stores: token, scope, createdAt, lastUsed
- Validates permissions on every request

### Security Events Logged
- TOKEN_VALIDATION_SUCCESS
- TOKEN_VALIDATION_FAILURE
- RATE_LIMIT_WARNING
- TOKEN_CACHE_CLEARED

## Integration Example

### GitHubClient Integration
```typescript
// Check if token exists before validation
if (process.env.GITHUB_TOKEN) {
  try {
    const token = await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
    headers['Authorization'] = `Bearer ${token}`;
  } catch (tokenError) {
    console.log('GitHub token validation failed, proceeding without authentication');
  }
}
```

## Configuration

### Environment Variables
- `GITHUB_TOKEN`: The GitHub personal access token

### Constants
```typescript
TOKEN_ROTATION_INTERVAL = 3600000 // 1 hour
MAX_EVENTS = 1000 // SecurityMonitor buffer
```

## Error Codes
- `TOKEN_NOT_FOUND`: No token in environment
- `INVALID_TOKEN_FORMAT`: Token format validation failed
- `TOKEN_TOO_SHORT`: Token length < 40 chars
- `TOKEN_INVALID_CHARS`: Contains whitespace
- `TOKEN_INVALID_OR_EXPIRED`: 401 from GitHub
- `INSUFFICIENT_PERMISSIONS`: 403 from GitHub
- `INSUFFICIENT_SCOPES`: Missing required OAuth scopes
- `PERMISSION_VALIDATION_FAILED`: Network error

## Testing

### Test Coverage
- 21 comprehensive tests
- Format validation (all 3 formats)
- Permission validation (all 3 scopes)
- Error sanitization
- Caching behavior
- Network error handling

### Key Test Scenarios
1. Valid token formats accepted
2. Invalid formats rejected
3. Permissions validated via API
4. Errors sanitized properly
5. Cache works correctly
6. Rate limits monitored

## Security Considerations

### Strengths
- No tokens in logs/errors
- Format validation prevents injection
- Permission validation prevents over-privileged access
- Caching reduces API calls
- Graceful fallback on failure

### Known Limitations
1. Minor timing attack possible (Issue #180)
2. Single cache key limits multi-account (Issue #178)
3. No automatic token rotation (Issue #176)
4. No rate limiting on validation (Issue #174)

## Performance

### Metrics
- Format validation: <1ms
- API validation: ~200-500ms (network dependent)
- Cache lookup: <1ms
- Error sanitization: <5ms

### Optimization
- Tokens cached for 1 hour
- Permission validation on every use (security > performance)
- Single API call for validation
- Efficient regex patterns

## Future Enhancements
1. Rate limiting (Issue #174)
2. Async cache refresh (Issue #175)
3. Token rotation (Issue #176)
4. Granular permissions (Issue #177)
5. Multi-account support (Issue #178)
6. Metrics collection (Issue #179)

## Troubleshooting

### Common Issues
1. **Token validation fails**: Check token has required scopes
2. **Rate limit warnings**: Token may be shared across services
3. **Cache not working**: Check if clearCache() being called
4. **Network errors**: GitHub API may be down

### Debug Commands
```bash
# Check token format
echo $GITHUB_TOKEN | grep -E '^(ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})$'

# Test GitHub API
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user

# Check scopes
curl -I -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | grep x-oauth-scopes
```