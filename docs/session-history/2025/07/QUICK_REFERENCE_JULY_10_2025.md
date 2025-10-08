# Quick Reference - July 10, 2025

## Current Project State
- **Version**: 1.2.1 (ready for 1.2.2)
- **Security**: 100% COMPLETE ✅
- **Tests**: 487 (all passing)
- **Package Size**: 279.3 kB
- **Node Version**: 24 (not LTS until Oct 2025)

## Security Components Reference

### 1. ContentValidator
**File**: `src/security/contentValidator.ts`
**Purpose**: Detect/block prompt injections
**Key Methods**: 
- `validateContent()` - Main validation
- `sanitizeContent()` - Replace threats
- `validateYamlContent()` - YAML-specific

### 2. SecureYamlParser  
**File**: `src/security/secureYamlParser.ts`
**Purpose**: Safe YAML parsing
**Key Features**:
- FAILSAFE_SCHEMA only
- Pattern detection
- Field validation

### 3. SecureTokenManager
**File**: `src/security/tokenManager.ts`
**Purpose**: GitHub token security
**Key Features**:
- Format validation (ghp_*, gho_*, github_pat_*)
- Permission checks
- Error sanitization
- 1-hour cache

### 4. SecurityMonitor
**File**: `src/security/securityMonitor.ts`
**Purpose**: Event logging/alerting
**Key Methods**:
- `logSecurityEvent()`
- `getSecurityReport()`

## High-Priority Issues
```bash
# View high priority issues
gh issue list --label "priority: high" --state open

# Current high priority:
# #40  - NPM publishing
# #174 - Rate limiting 
# #175 - Async cache refresh
# #162 - Unicode normalization
```

## NPM Publishing Checklist
```bash
# 1. Update version
npm version 1.2.2

# 2. Update CHANGELOG.md
# Add security fixes summary

# 3. Dry run
npm publish --dry-run

# 4. Publish
npm publish

# 5. Create GitHub release
gh release create v1.2.2 --title "v1.2.2: Security Hardening Release" --notes "..."
```

## Common Commands
```bash
# Run all tests
npm test

# Run security tests only
npm test -- __tests__/security/

# Check CI status
gh run list --limit 5

# Create feature branch
git checkout -b feature/persona-export

# View specific issue
gh issue view 40
```

## Feature Ideas Priority List
1. **Persona Export/Import** - User requested
2. **Sharing via URL** - Enable collaboration  
3. **Enhanced Marketplace** - Ratings, stats
4. **VS Code Extension** - Developer productivity
5. **Web UI** - Visual persona editor

## Environment Variables
```bash
# Required for marketplace
export GITHUB_TOKEN="your-token"

# Optional
export DOLLHOUSE_USER="username"
export DOLLHOUSE_SECURITY_MODE="strict"
```

## Security Event Types
- CONTENT_INJECTION_ATTEMPT
- YAML_INJECTION_ATTEMPT
- TOKEN_VALIDATION_FAILURE
- PATH_TRAVERSAL_ATTEMPT
- RATE_LIMIT_WARNING

## Test Categories
- Unit tests: 300+
- Security tests: 115+
- Integration tests: 50+
- Performance tests: 20+

## Git Branch Strategy
- `main` - Production ready
- `feature/*` - New features
- `fix/*` - Bug fixes
- `security/*` - Security updates

## Release Process
1. Create feature branch
2. Implement & test
3. Create PR with detailed description
4. Wait for CI & reviews
5. Merge when approved
6. Update version & publish

## Performance Metrics
- Startup time: <2s
- Persona load: <100ms
- API calls: Cached 1hr
- Memory: ~50MB base

## Next Session Prep
1. Read NEXT_STEPS_JULY_10_2025.md
2. Check high-priority issues
3. Review user feedback
4. Plan session focus

## Contact for Issues
- GitHub Issues: Best for bugs/features
- Security: Use private vulnerability reporting
- NPM: @mickdarling/dollhousemcp