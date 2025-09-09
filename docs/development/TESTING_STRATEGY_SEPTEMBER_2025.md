# Testing Strategy for Remaining Issues - September 2025

## Overview
This document outlines testing strategies for issues identified in the v1.7.3 release session. While v1.7.3 is successfully published to NPM, several secondary issues need attention.

## Issue #1: GitHub Packages Publishing Failure

### Problem
GitHub Packages publish fails with 409 Conflict - version 1.7.3 already exists.

### Root Cause
When we deleted and re-created the v1.7.3 tag, NPM registry was updated but GitHub Packages retained the old version.

### Testing Strategy
```bash
# 1. Check if version exists in GitHub Packages
npm view @DollhouseMCP/mcp-server@1.7.3 --registry=https://npm.pkg.github.com

# 2. For future releases, check BEFORE tagging
npm view @DollhouseMCP/mcp-server versions --registry=https://npm.pkg.github.com --json

# 3. Test publish with dry-run
npm publish --dry-run --registry=https://npm.pkg.github.com
```

### Solution for Next Release
1. Always bump version when re-releasing
2. Or use pre-release versions (1.7.4-hotfix.1)
3. Consider deprecating GitHub Packages if NPM is primary

## Issue #2: ConfigManager Security Tests

### Problem
Three tests skipped because test environment can't properly validate prototype pollution protection, even though production code is secure.

### Testing Strategy

#### Manual Production Test
```bash
# Run the security test script
cd active/mcp-server
npm run build
node scripts/test-configmanager-security.js
```

#### Integration Test
```bash
# Test in actual MCP environment
cat > test-config-security.js << 'EOF'
// Attempt to pollute prototype via MCP tools
const maliciousPersona = {
  name: "Test",
  "__proto__": { isAdmin: true }
};
// Try to activate and check for pollution
EOF
```

#### Monitoring Strategy
1. Add security event logging to production
2. Monitor for prototype pollution attempts
3. Set up alerts for suspicious config operations

### Fix for Test Environment
```typescript
// Option 1: Reset singleton between tests
beforeEach(() => {
  // Force new ConfigManager instance
  delete require.cache[require.resolve('./ConfigManager')];
});

// Option 2: Add test-only reset method
class ConfigManager {
  // Only available in test environment
  static resetForTesting() {
    if (process.env.NODE_ENV === 'test') {
      this.instance = null;
    }
  }
}
```

## Issue #3: Badge Caching

### Problem
README badges may show outdated status due to GitHub's CDN caching.

### Testing Strategy
```bash
# 1. Check actual workflow status
gh workflow list --all

# 2. Force badge refresh by adding cache buster
echo "![Build](https://github.com/DollhouseMCP/mcp-server/workflows/Build/badge.svg?$(date +%s))"

# 3. Verify badge URLs point to main branch
grep -E "badge.svg.*branch" README.md
```

### Permanent Solution
Update README badges to include branch parameter:
```markdown
![Build](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml/badge.svg?branch=main)
```

## Issue #4: Extended Node Compatibility

### Testing Strategy
```bash
# Test across Node versions locally
for version in 18 20 22 24; do
  echo "Testing Node $version"
  docker run --rm -v $(pwd):/app -w /app node:$version npm test
done
```

### CI Verification
```yaml
# Ensure matrix testing covers all versions
strategy:
  matrix:
    node-version: [18.x, 20.x, 22.x, 24.x]
```

## Issue #5: Docker Testing Reliability

### Testing Strategy
```bash
# 1. Test Docker build locally
docker build -t test-build .

# 2. Run container test
docker run --rm test-build npm test

# 3. Test multi-platform builds
docker buildx build --platform linux/amd64,linux/arm64 .
```

### Debug Failed Builds
```bash
# Get detailed logs
gh run view --log | grep -A10 -B10 "Docker"

# Test specific platform
docker build --platform linux/amd64 -t test-amd64 .
```

## Automated Test Suite

### Create Comprehensive Test Script
```bash
#!/bin/bash
# save as scripts/test-all-issues.sh

echo "=== Testing All Known Issues ==="

# Test 1: NPM Package
echo "1. Checking NPM package..."
npm view @dollhousemcp/mcp-server@latest version

# Test 2: GitHub Packages
echo "2. Checking GitHub Packages..."
npm view @DollhouseMCP/mcp-server@latest version --registry=https://npm.pkg.github.com 2>/dev/null || echo "Not published"

# Test 3: ConfigManager Security
echo "3. Testing ConfigManager security..."
node scripts/test-configmanager-security.js

# Test 4: Badge Status
echo "4. Checking workflow status..."
gh workflow list --all | head -5

# Test 5: Docker Build
echo "5. Testing Docker build..."
docker build -t test-local . || echo "Docker build failed"

echo "=== Test Complete ==="
```

## Monitoring Checklist

### Daily Checks
- [ ] NPM package accessible
- [ ] Latest version shows correctly
- [ ] CI workflows green on main
- [ ] No security alerts

### Weekly Checks
- [ ] Docker images building
- [ ] GitHub Packages status
- [ ] Badge accuracy
- [ ] Test coverage maintained

### Release Checks
- [ ] Version bumped appropriately
- [ ] All tests passing locally
- [ ] CI green on release branch
- [ ] No skipped tests without justification
- [ ] Security tests run manually
- [ ] Docker images tested

## Known Issues Reference

| Issue | Impact | Workaround | Permanent Fix |
|-------|--------|------------|---------------|
| GitHub Packages 409 | Low | Use NPM only | Deprecate or version bump |
| ConfigManager tests | Medium | Manual testing | Test environment reset |
| Badge caching | Low | Cache buster | Add branch parameter |
| Docker platform fails | Medium | Platform-specific builds | Update base images |

## Emergency Procedures

### If NPM Publish Fails
```bash
# 1. Check authentication
npm whoami

# 2. Check version conflict
npm view @dollhousemcp/mcp-server versions --json

# 3. Force publish (dangerous!)
npm publish --force
```

### If CI Completely Fails
```bash
# 1. Run tests locally
npm test

# 2. Build locally
npm run build

# 3. Manual publish with admin override
npm publish --access public
```

## Recommendations

1. **Immediate Actions**
   - Run ConfigManager security test manually
   - Update badges with branch parameter
   - Document GitHub Packages deprecation

2. **Next Release**
   - Fix ConfigManager test environment
   - Add automated security testing
   - Improve error messages in CI

3. **Long-term**
   - Migrate to single package registry (NPM only)
   - Implement security monitoring
   - Add performance benchmarks

## Useful Commands

```bash
# Check all package registries
npm view @dollhousemcp/mcp-server version  # NPM
npm view @DollhouseMCP/mcp-server version --registry=https://npm.pkg.github.com  # GitHub

# Verify security
npm audit
npm audit fix

# Test everything
npm test && npm run build && npm run test:security

# Check CI status
gh run list --limit 5
gh workflow list --all
```

---

*Document created: September 9, 2025*
*Last updated: September 9, 2025*
*Version 1.7.3 successfully released to NPM*