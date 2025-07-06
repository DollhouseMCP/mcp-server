# Post-Merge CI Checklist

## Immediate Actions After PR #80 Merge

### 1. Check CI Results (Within 5 minutes)
```bash
# Get the latest CI run ID
gh run list --workflow=core-build-test.yml --limit=1

# Check if diagnostic ran
gh run view <RUN_ID> --log | grep "Original tests failed, trying compiled approach"

# Check compiled test results
gh run view <RUN_ID> --log | grep -A20 "Run test suite (compiled method)"
```

### 2. Quick Status Check
```bash
# See all check results
gh pr checks 80

# Or check the merged commit
git log -1 --pretty=format:"%H" | xargs -I {} gh api repos/mickdarling/DollhouseMCP/commits/{}/check-runs
```

### 3. Interpret Results

#### ✅ SUCCESS Scenario:
```
Original tests: ❌ Failed (expected)
Compiled tests: ✅ Passed
```
**This confirms** the refactoring caused the issue. Module resolution works with compiled JS.

#### ❌ FAILURE Scenario:
```
Original tests: ❌ Failed
Compiled tests: ❌ Failed
```
**This means** the problem is deeper. Check error messages for:
- Different errors than module resolution
- Environment variable issues
- Circular dependency errors

### 4. If Compiled Tests Pass

**Immediate Decision Needed:**

Option 1: Keep compile-first approach
```bash
# Update package.json to use compiled tests in CI
npm run test:ci → npm run test:compiled:ci
```

Option 2: Fix the root cause
- Investigate why ts-jest-resolver didn't work
- Try jest-ts-webcompat-resolver
- Consider switching to Vitest

### 5. If Compiled Tests Fail

**Debug Commands:**
```bash
# Check what actually failed
gh run view <RUN_ID> --log-failed

# Look for specific errors
gh run view <RUN_ID> --log | grep -i "error\|fail" | grep -v "Failed to load"

# Download artifacts if available
gh run download <RUN_ID>
```

### 6. Quick Fixes to Try

If we need to iterate quickly:

```bash
# Create quick fix branch
git checkout -b ci-fix-attempt-2

# Try alternative resolver
npm install --save-dev jest-ts-webcompat-resolver

# Update jest.config.cjs
# Change resolver: 'ts-jest-resolver' 
# To: resolver: 'jest-ts-webcompat-resolver'

# Push and monitor
git add -A && git commit -m "Try alternative Jest resolver" && git push
```

### 7. Communication

Update the team/issue:
```bash
gh issue comment 79 --body "Merge complete. CI results: [describe what happened]"
```

## Key Metrics to Track

1. **Which OS failed?** (Ubuntu, macOS, Windows, or all)
2. **What type of error?** (Module resolution, timeout, other)
3. **How many tests passed/failed?**
4. **Did Docker tests still pass?**

## Emergency Rollback

If everything breaks:
```bash
git revert HEAD
git push origin main
```

But this is unlikely - the changes are mostly test configuration.