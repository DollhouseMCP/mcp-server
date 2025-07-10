# SEC-004 and SEC-005 Implementation Plan

## SEC-004: GitHub API Token Exposure (HIGH - CVSS 7.5)

### Problem
- GitHub tokens face exposure risks through logs, errors, debug output
- Over-privileged token usage
- No token rotation mechanism
- Tokens could leak in error messages

### Implementation Plan

#### 1. Create SecureTokenManager (`src/security/tokenManager.ts`)
```typescript
export class SecureTokenManager {
  private static tokenCache: Map<string, string> = new Map();
  private static readonly TOKEN_ROTATION_INTERVAL = 3600000; // 1 hour

  static async getSecureGitHubToken(scope: TokenScope): Promise<string> {
    // Implementation details from audit
  }

  private static validateTokenFormat(token: string): void {
    // ghp_* or gho_* format validation
  }

  private static async validateTokenPermissions(token: string, scope: TokenScope): Promise<void> {
    // Check token has minimum required permissions
  }

  private static sanitizeErrorMessage(error: Error): string {
    // Remove any token patterns from error messages
  }
}
```

#### 2. Integration Points
- Update `GitHubClient` to use SecureTokenManager
- Modify all GitHub API calls to use secure token retrieval
- Add token validation on startup
- Implement secure error handling

#### 3. Security Features
- Token format validation
- Permission scope validation
- Automatic token rotation reminders
- Error message sanitization
- Secure environment variable handling

#### 4. Testing Requirements
- Token format validation tests
- Permission validation tests
- Error sanitization tests
- Cache behavior tests

---

## SEC-005: Docker Container Security (MEDIUM - CVSS 6.3)

### Problem
- Containers run as root
- No capability dropping
- Secrets exposed via environment
- Overly permissive volume mounts

### Implementation Plan

#### 1. Update Dockerfile
```dockerfile
# Multi-stage secure build
FROM node:20-alpine AS builder
# ... build stage ...

FROM node:20-alpine AS production
# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S dollhouse -u 1001 -G nodejs

# Security hardening
RUN apk del --no-cache git curl wget
USER dollhouse

# Set secure permissions
# ... rest of config ...
```

#### 2. Update docker-compose.yml
```yaml
services:
  dollhousemcp:
    user: "1001:1001"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
```

#### 3. Security Measures
- Non-root user execution
- Remove unnecessary packages
- Drop all capabilities
- Read-only root filesystem
- No privilege escalation
- Secure volume mounts

#### 4. Testing Requirements
- Container security scanning
- Non-root execution tests
- Capability verification
- Secret exposure tests

---

## Implementation Order

### Phase 1: SEC-004 Token Management
1. Create SecureTokenManager class
2. Add comprehensive tests
3. Update GitHubClient integration
4. Test with real GitHub API
5. Update documentation

### Phase 2: SEC-005 Docker Hardening
1. Update Dockerfile with security measures
2. Update docker-compose.yml
3. Test container functionality
4. Run security scans
5. Update deployment docs

## Success Criteria

### SEC-004
- [ ] No tokens in logs or error messages
- [ ] Token format validation working
- [ ] Permission validation implemented
- [ ] All GitHub API calls using secure manager
- [ ] 100% test coverage for token operations

### SEC-005
- [ ] Container runs as non-root
- [ ] All capabilities dropped
- [ ] No unnecessary packages
- [ ] Read-only filesystem working
- [ ] Security scans pass

## Related Issues
- #154: SEC-004 GitHub API Token Exposure
- #155: SEC-005 Docker Container Security Issues

## Notes for Implementation
- SEC-004 is higher priority due to CVSS score
- Both can be implemented independently
- Consider adding monitoring for token usage
- Docker changes need thorough testing