# Critical Security Quick Start - Next Session

## 🚨 URGENT: Start Here

### Current Context
- Security audit suppression system working (0 findings)
- PR #260 merged successfully  
- 6 critical security issues identified and need immediate attention
- All issues added to DollhouseMCP roadmap project

## 🔴 Priority #1: Issue #198 - Security Review of Export/Import/Sharing Feature

### Background
- **CRITICAL PRIORITY** - Recently merged feature handles external URLs and user data
- PR #197 was merged with security fixes, but needs independent comprehensive audit
- Identified vulnerabilities: ReDoS, SSRF, rate limiting, input validation

### Quick Commands to Start
```bash
cd /Users/mick/Developer/MCP-Servers/DollhouseMCP
git checkout main
git pull origin main

# View the critical issue
gh issue view 198

# Review the merged PR that needs auditing  
gh pr view 197

# Check the main files to audit
ls -la src/persona/export-import/
cat src/persona/export-import/PersonaSharer.ts | head -50
```

### Key Files to Audit
1. `src/persona/export-import/PersonaSharer.ts` - URL validation, fetch operations
2. `src/persona/export-import/PersonaExporter.ts` - Export functionality
3. `src/persona/export-import/PersonaImporter.ts` - Import validation
4. `src/update/RateLimiter.ts` - Rate limiting implementation
5. Tests in `__tests__/unit/PersonaSharer.test.ts`

### Security Checklist
- [ ] **ReDoS Protection**: Verify regex pattern `[A-Za-z0-9+/=]+$` is properly constrained
- [ ] **SSRF Prevention**: Validate URL validation logic covers all attack vectors  
- [ ] **Rate Limiting**: Ensure rate limiter properly protects GitHub API
- [ ] **Input Validation**: Check all user inputs are sanitized
- [ ] **Path Traversal**: Verify no directory escape vulnerabilities
- [ ] **Command Injection**: Ensure no user input reaches shell commands

## 🔴 Priority #2: Issue #202 - GitHub Token Security

### Problem
- GitHub API tokens lack security measures (validation, redaction, scope checking)
- Risk of credential compromise and repository access
- Found in multiple files handling GitHub API

### Quick Start
```bash
# Find all files using GitHub tokens
grep -r "GITHUB_TOKEN" src/ --include="*.ts"
grep -r "github" src/ --include="*.ts" | grep -i token

# Key files to review
cat src/marketplace/GitHubClient.ts | head -30
cat src/persona/export-import/PersonaSharer.ts | grep -A5 -B5 token
```

### Implementation Needed
```typescript
// Need to implement src/security/tokenManager.ts improvements
export class TokenManager {
  static validateTokenFormat(token: string): boolean
  static getGitHubToken(): string | null  
  static redactToken(token: string): string
  static validateTokenScopes(requiredScopes: string[]): boolean
}
```

## 🔴 Priority #3: Issue #262 - CodeQL Regex Warnings

### Current Status
- We implemented regex escaping: `/[\\^$.()+?{}[\]|]/g`
- CodeQL may still be flagging issues (need to verify in latest CI)
- Located in `src/security/audit/config/suppressions.ts:399`

### Quick Check
```bash
# Check latest CI for CodeQL results
gh run list --branch main --limit 5
gh run view [latest-run-id] # Replace with actual ID

# Review our current regex escaping
grep -A10 -B5 "Escape all regex" src/security/audit/config/suppressions.ts
```

## 🔴 Priority #4: Issue #263 - Overly Broad Unicode Suppressions

### Problem
- Some suppressions might hide real vulnerabilities
- Marketplace/persona modules could have direct user input bypassing normalization
- Need to audit data flow and narrow scope

### Files to Review
```bash
# Check current suppressions
grep -A5 -B5 "src/marketplace" src/security/audit/config/suppressions.ts
grep -A5 -B5 "src/persona" src/security/audit/config/suppressions.ts
grep -A5 -B5 "src/utils" src/security/audit/config/suppressions.ts

# Check actual data flow in these modules
head -50 src/marketplace/PersonaSubmitter.ts
head -50 src/persona/PersonaManager.ts
```

## 🛠️ Tools & Commands

### Security Audit
```bash
# Run current security audit (should show 0 findings)
npm run security:audit

# Run specific test suites
npm test -- suppressions
npm test -- security/audit
```

### GitHub CLI Commands
```bash
# View critical issues
gh issue view 198 202 254 262 263

# Check project roadmap
gh project view 1 --owner DollhouseMCP

# Check latest PRs
gh pr list --state open
```

### File Locations
- Security configs: `src/security/audit/config/suppressions.ts`
- Export/import features: `src/persona/export-import/`
- Tests: `__tests__/unit/security/audit/`
- Documentation: `docs/development/`

## 📋 Expected Outcomes

### By End of Next Session
1. **Issue #198**: Complete security audit with findings/recommendations
2. **Issue #202**: TokenManager implementation started or completed
3. **Issue #262**: CodeQL warnings verified/resolved
4. **Issue #263**: Data flow audited, suppressions narrowed as needed

### Success Metrics
- All critical security vulnerabilities identified and documented
- Clear remediation plan for any findings
- Token security measures implemented
- CodeQL warnings resolved
- Suppression scope appropriately narrowed

---

**Remember**: These are CRITICAL security issues. Focus on #198 (export/import audit) first as it handles external data and was recently merged.

🔒 **Security First Approach**: Better to be overly cautious and find false positives than miss real vulnerabilities.