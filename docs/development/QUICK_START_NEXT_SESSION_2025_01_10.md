# Quick Start Guide - Next Session

## Immediate Actions

### 1. Check PR #171 Status
```bash
gh pr view 171
# If not merged:
gh pr merge 171 --merge --admin  # (with your permission)
```

### 2. Update Main Branch
```bash
git checkout main
git pull origin main
```

### 3. Start SEC-004 Implementation
```bash
git checkout -b fix-sec-004-token-management
```

## SEC-004 Quick Implementation Guide

### Create Token Manager
```bash
# Create the security token manager
cat > src/security/tokenManager.ts << 'EOF'
/**
 * Secure Token Manager for DollhouseMCP
 * 
 * Provides secure GitHub token management with validation,
 * caching, and error sanitization.
 * 
 * Security: SEC-004 - Token exposure vulnerability protection
 */

import { SecurityError } from '../errors/SecurityError.js';
import { SecurityMonitor } from './securityMonitor.js';

export enum TokenScope {
  READ = 'read',
  WRITE = 'write',
  ADMIN = 'admin'
}

export class SecureTokenManager {
  private static tokenCache: Map<string, string> = new Map();
  private static readonly TOKEN_ROTATION_INTERVAL = 3600000; // 1 hour
  
  // Token patterns to sanitize from errors
  private static readonly TOKEN_PATTERNS = [
    /ghp_[a-zA-Z0-9]{36}/g,
    /gho_[a-zA-Z0-9]{36}/g,
    /github_pat_[a-zA-Z0-9_]{82}/g
  ];

  static async getSecureGitHubToken(scope: TokenScope): Promise<string> {
    // Implementation here
  }

  private static validateTokenFormat(token: string): void {
    // Validation here
  }

  private static sanitizeError(error: any): Error {
    // Sanitization here
  }
}
EOF
```

### Key Implementation Points

1. **Token Validation**
   - Format: ghp_* (personal) or gho_* (OAuth)
   - Length: 40 characters
   - No logging of actual tokens

2. **Error Sanitization**
   - Remove token patterns from all errors
   - Replace with [REDACTED]
   - Log security events

3. **Integration Updates**
   - Update GitHubClient constructor
   - Modify all token access points
   - Add startup validation

4. **Testing Focus**
   - Token format validation
   - Error message sanitization
   - Caching behavior
   - Permission validation

## Quick Test Commands

```bash
# Build project
npm run build

# Run security tests
npm test -- __tests__/security/

# Run specific test file
npm test -- __tests__/security/tokenManager.test.ts

# Check all tests
npm test
```

## Current Security Status

✅ **Completed**:
- SEC-001: Prompt Injection (merged)
- SEC-002: False positive (already secure)
- SEC-003: YAML Parsing (PR #171)

⏳ **Remaining**:
- SEC-004: Token Management (HIGH)
- SEC-005: Docker Security (MEDIUM)

## Key Files to Remember

### Security Components
- `/src/security/contentValidator.ts` - Pattern detection
- `/src/security/securityMonitor.ts` - Event logging
- `/src/security/secureYamlParser.ts` - YAML safety
- `/src/security/tokenManager.ts` - (to create)

### Integration Points
- `/src/marketplace/GitHubClient.ts` - Needs token manager
- `/src/index.ts` - Main server file
- Environment variables for tokens

## Environment Setup

```bash
# Ensure you have the GitHub token
echo $GITHUB_TOKEN

# Or set it
export GITHUB_TOKEN="your-token-here"
```

## PR Template for SEC-004

```markdown
## Summary
Implements secure token management to address SEC-004 vulnerability (CVSS 7.5).

## Problem
- Token exposure in logs/errors
- No validation or rotation
- Over-privileged usage

## Solution
SecureTokenManager with validation, sanitization, and caching

## Security Impact
Prevents token leakage and validates permissions

Related: #154
```

## Success Metrics
- [ ] No tokens in any logs
- [ ] All errors sanitized
- [ ] Token validation working
- [ ] All tests passing
- [ ] Claude review approval

## Contact
Repository: https://github.com/DollhouseMCP/mcp-server
Issues: Check security label
Your PRs: `gh pr list --author @me`

Ready to implement SEC-004!