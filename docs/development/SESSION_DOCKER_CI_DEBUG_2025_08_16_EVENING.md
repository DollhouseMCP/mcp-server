# Session: Docker CI Debug Investigation - August 16, 2025 Evening

**Time**: ~6:00 PM - 7:30 PM EST  
**Branch**: `fix/server-initialization-race-condition`  
**PR**: #611 - Fix server initialization race condition  
**Status**: IN PROGRESS - Docker tests still failing in CI but working locally

## Executive Summary

We've been debugging Docker CI test failures that are blocking PR #611. The core race condition fix is correct, but Docker tests fail in CI due to filesystem write issues in the read-only Docker environment. We've identified and partially fixed 4 separate issues, but CI tests are still failing.

## The Journey: 4 Issues Discovered

### Issue #1: Race Condition (FIXED ✅)
**Problem**: Server was connecting to MCP transport before initialization completed  
**Solution**: Moved initialization from constructor to `run()` method  
**Result**: Server now properly waits for initialization before accepting commands  
**Commit**: `facaf27` (from earlier session)

### Issue #2: Portfolio Directory (FIXED ✅) 
**Problem**: PortfolioManager tried to create `~/.dollhouse/portfolio` in read-only filesystem  
**Solution**: Set `DOLLHOUSE_PORTFOLIO_DIR=/app/tmp/portfolio` environment variable  
**Result**: Portfolio initializes in writable tmpfs location  
**Commit**: `71ea654`

### Issue #3: Path Mismatch (FIXED ✅)
**Problem**: Docker workflow was overriding Dockerfile env with wrong path `/tmp/portfolio`  
**Solution**: Removed env overrides, added `--tmpfs /app/tmp` mount  
**Result**: Consistent path usage across all Docker configs  
**Commit**: `010dba9`

### Issue #4: Collection Cache Directory (PARTIALLY FIXED ⚠️)
**Problem**: CollectionCache tries to create `/app/.dollhousemcp` in read-only filesystem  
**Solution**: Added `DOLLHOUSE_CACHE_DIR=/app/tmp/cache` support  
**Result**: Works locally but STILL FAILING in CI  
**Commits**: `3266bcf`, `7e162f8`

## Current State of CI Tests

### What's Working ✅
- Unit tests all passing (Windows, macOS, Ubuntu)
- Security audits passing
- Build artifacts validating correctly
- MCP server responds to initialize commands locally
- Portfolio initialization works in Docker
- Local Docker tests work perfectly

### What's Failing ❌
- Docker Build & Test (linux/amd64) - FAILING
- Docker Build & Test (linux/arm64) - FAILING/PENDING
- Docker Compose Test - FAILING

### The Mystery 🔍
**Local Docker**: Everything works perfectly with all our fixes  
**CI Docker**: Still fails with cache directory errors

## Key Discovery: Environment Variable Not Propagating in CI

The debug logging shows:
- **Locally**: `DOLLHOUSE_CACHE_DIR=/app/tmp/cache` is set and used correctly
- **In CI**: Environment variable appears to not be reaching the Node.js process
- **Error**: `Failed to create cache directory: Error: ENOENT: no such file or directory, mkdir '/app/.dollhousemcp'`

This suggests the environment variable is set in Docker configs but not actually being passed to the application in the CI environment.

## Files Modified This Session

### Docker Configuration Files
1. `.github/workflows/docker-testing.yml`
   - Removed conflicting env overrides
   - Added `--tmpfs /app/tmp` mount
   
2. `docker/Dockerfile`
   - Added `ENV DOLLHOUSE_CACHE_DIR=/app/tmp/cache`
   
3. `docker/docker-compose.yml`
   - Added `DOLLHOUSE_CACHE_DIR=/app/tmp/cache` to both services

### Source Code Files
4. `src/cache/CollectionCache.ts`
   - Modified constructor to check `DOLLHOUSE_CACHE_DIR` env var
   - Added debug logging to diagnose CI issues

### Documentation Files
5. `docs/development/DOCKER_CI_INVESTIGATION_COORDINATION.md`
   - Central coordination document for all agents
   - Contains full investigation history and findings
   
6. `docs/development/SESSION_FIX_610_FINAL_STATUS.md`
   - Previous session status document
   
7. `docs/development/NEXT_SESSION_DOCKER_CI_DEBUG.md`
   - Agent architecture plan document

## Agent Architecture Used

We used a multi-agent approach with:
- **Opus (Orchestrator)**: Coordinated investigation and synthesis
- **CI Environment Analyzer**: Researched GitHub Actions Docker behavior
- **Docker Debug Agent**: Analyzed output/logging issues
- **UltraThink Agent**: Deep analysis of problems and solutions
- **Docker Fix Implementation Agents**: Applied fixes to code

## Next Steps for Resuming

### Immediate Actions
1. **Check latest CI logs** from commit `7e162f8`
   - Look for debug output: `"CollectionCache: Using cache directory"`
   - See if env var is defined in CI environment
   
2. **If env var not propagating**, try alternative approaches:
   ```typescript
   // Option A: Check if running in Docker
   const isDocker = fs.existsSync('/app/tmp');
   if (isDocker) {
     this.cacheDir = '/app/tmp/cache';
   }
   
   // Option B: Try multiple locations
   const possibleDirs = [
     process.env.DOLLHOUSE_CACHE_DIR,
     '/app/tmp/cache',
     '/tmp/cache',
     path.join(process.cwd(), '.dollhousemcp', 'cache')
   ];
   ```

3. **Consider simpler fix**: Make CollectionCache optional/gracefully fail
   - If cache can't be created, just log warning and continue
   - Don't let cache failures break the entire server

### Investigation Paths
1. **Why does env var work locally but not in CI?**
   - Different Docker versions?
   - GitHub Actions runner configuration?
   - Docker Compose vs Docker run differences?

2. **Is there another directory trying to write?**
   - Check for other components beyond Portfolio and Cache
   - Look for temp file creation
   - Check for log file writes

3. **Should we change approach entirely?**
   - Disable read-only mode for CI tests?
   - Use different test strategy?
   - Mock filesystem operations?

## Commands to Resume

```bash
# Get on branch
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
git checkout fix/server-initialization-race-condition
git pull

# Check CI status
gh pr checks 611

# View latest CI logs
gh run view [RUN_ID] --log

# Test locally
docker build -t test-local --file docker/Dockerfile .
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"1.0.0","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}' | docker run -i test-local

# Check coordination document
cat docs/development/DOCKER_CI_INVESTIGATION_COORDINATION.md
```

## Key Insights

1. **The race condition fix is correct** - Don't revert it
2. **Docker tests weren't actually testing MCP** before our fixes
3. **Multiple filesystem issues** were masked by the race condition
4. **CI environment is fundamentally different** from local Docker
5. **Environment variables may not propagate** the same way in CI

## Time Investment

- **Total session time**: ~1.5 hours
- **Issues identified**: 4
- **Issues fixed locally**: 4
- **Issues fixed in CI**: 2-3 (partial)
- **Commits made**: 4

## Recommendation for Next Session

1. **First**: Check if the debug logging shows anything useful in CI
2. **If still failing**: Implement fallback logic for Docker detection
3. **Consider**: Making cache optional rather than required
4. **Document**: Add comprehensive Docker deployment guide
5. **Long-term**: Consider restructuring how Docker handles filesystem requirements

## Important Context

The user has been working on this project daily since July 1st. Docker tests were added July 3rd but weren't actually testing MCP functionality until recently. The race condition fix exposed these hidden filesystem issues that were always there but not caught by tests.

---

*Session paused at 7:30 PM EST - Docker CI tests still failing but significant progress made*  
*Next session should start by checking CI logs from commit 7e162f8*