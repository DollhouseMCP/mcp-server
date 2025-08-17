# Quick Start: Docker CI Fix for PR #611

**Purpose**: Resume fixing Docker CI test failures blocking PR #611  
**Branch**: `fix/server-initialization-race-condition`  
**Last Updated**: August 16, 2025, 7:30 PM EST

## 🎯 30-Second Summary

Docker tests fail in CI because the read-only filesystem blocks directory creation. We've fixed 3 of 4 issues. The last issue is that `DOLLHOUSE_CACHE_DIR` environment variable works locally but not in CI.

## 🚀 Quick Resume Commands

```bash
# Get to the right place
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
git checkout fix/server-initialization-race-condition
git pull

# Check current CI status
gh pr checks 611

# View the latest CI logs (replace with actual run ID)
gh run view --log | grep -A5 -B5 "CollectionCache"
```

## 📍 Current Status

| Issue | Status | What It Was | Solution |
|-------|--------|-------------|----------|
| 1. Race Condition | ✅ FIXED | Server connected before init | Moved init to run() |
| 2. Portfolio Directory | ✅ FIXED | Couldn't write to ~/.dollhouse | Use /app/tmp/portfolio |
| 3. Path Mismatch | ✅ FIXED | Wrong env override | Removed overrides |
| 4. Collection Cache | ⚠️ PARTIAL | Can't create cache dir | Env var not working in CI |

## 🔍 The Current Problem

**What's happening**: CollectionCache tries to create `/app/.dollhousemcp` in read-only filesystem  
**Our fix**: Added `DOLLHOUSE_CACHE_DIR=/app/tmp/cache` environment variable  
**The issue**: Works locally but environment variable isn't reaching the app in CI  

## 📋 Next Steps (In Order)

### 1. Check Debug Logs
Look for this line in CI logs:
```
CollectionCache: Using cache directory: /app/tmp/cache
```

If you see `/app/.dollhousemcp` instead, the env var isn't working.

### 2. If Env Var Not Working, Apply Fallback Fix

Edit `/src/cache/CollectionCache.ts` constructor:
```typescript
constructor(baseDir?: string) {
  // Check if we're in Docker (has /app/tmp directory)
  if (fs.existsSync('/app/tmp')) {
    this.cacheDir = '/app/tmp/cache';
    logger.debug('CollectionCache: Detected Docker environment, using /app/tmp/cache');
  } else {
    // Original logic for non-Docker environments
    const envCacheDir = process.env.DOLLHOUSE_CACHE_DIR;
    // ... rest of existing code
  }
}
```

### 3. Test and Push
```bash
# Test locally first
docker build -t test-fix --file docker/Dockerfile .
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"1.0.0","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}' | docker run -i test-fix

# If it works, commit and push
git add -A
git commit -m "fix: Add Docker environment detection fallback for cache directory"
git push origin fix/server-initialization-race-condition
```

### 4. Monitor CI
```bash
# Wait for CI to start
sleep 30
gh pr checks 611 --watch
```

## 📚 Reference Documents

### Essential Reading (Start Here)
- **This Document**: Quick commands and current status
- **[Coordination Doc](./DOCKER_CI_INVESTIGATION_COORDINATION.md)**: Central tracking of all fixes and findings

### Detailed Context (If Needed)
- **[Tonight's Session](./SESSION_DOCKER_CI_DEBUG_2025_08_16_EVENING.md)**: Full details of this evening's work
- **[Previous Session](./SESSION_FIX_610_FINAL_STATUS.md)**: How we fixed the race condition
- **[Agent Architecture](./NEXT_SESSION_DOCKER_CI_DEBUG.md)**: Multi-agent approach we used

## 🎭 Key Players

- **PR #611**: The PR we're trying to fix (race condition fix)
- **PR #606**: Search index implementation (blocked by #611)
- **Issue #610**: The original race condition issue

## 💡 Important Context

1. **Why it matters**: This blocks PR #606 and other work
2. **Why it's tricky**: CI environment is fundamentally different from local Docker
3. **What changed**: We made tests actually test MCP (they weren't before)
4. **The pattern**: Each fix reveals another issue that was always there

## 🔧 Alternative Approaches (If Stuck)

### Option A: Make Cache Optional
```typescript
try {
  await this.ensureCacheDir();
} catch (error) {
  logger.warn('Cache directory creation failed, running without cache');
  this.cacheDisabled = true;
}
```

### Option B: Disable Read-Only for CI
In `.github/workflows/docker-testing.yml`, temporarily remove `--read-only` to unblock development.

### Option C: Mock the Cache in Tests
Create a test-specific cache implementation that uses memory instead of filesystem.

## 🏁 Success Criteria

You'll know it's working when:
1. Docker tests show ✅ in `gh pr checks 611`
2. No "Failed to create cache directory" errors in logs
3. MCP server responds with proper JSON-RPC response

## 🤝 For Help

- Check the coordination document for full history
- The session documents have all the details
- Each fix is documented with commits
- Local testing commands are provided above

---

**Remember**: The race condition fix is correct. Don't revert it. We're just fixing Docker environment issues that were always there but hidden.

Good luck! You're very close to getting this working! 🚀