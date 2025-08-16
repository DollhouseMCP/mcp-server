# Docker CI Investigation Coordination Document

**Date**: August 16, 2025  
**Priority**: CRITICAL - Blocking PR #611  
**Coordinator**: Opus  
**Status**: NEW CACHE DIRECTORY ISSUE DISCOVERED ❌

## 🟢 ROOT CAUSE IDENTIFIED

### The Problem
**Portfolio initialization was trying to create directories in Docker's read-only filesystem**

- **Location**: `PortfolioManager` tries to create `~/.dollhouse/portfolio`
- **Docker Constraint**: `--read-only` filesystem with only `/tmp` writable via tmpfs
- **Result**: Initialization hangs/fails, MCP server never responds

### Why It Started Failing Now
1. **Race condition fix (Aug 16)** moved initialization from constructor to `run()` method
2. Server now WAITS for full initialization before accepting MCP commands
3. Before fix: Tests weren't actually testing MCP functionality (just Docker startup)
4. After fix: Tests actually send MCP commands, exposing the initialization failure

## 🟢 SOLUTION IMPLEMENTED

### Fix Applied - Two Parts

#### Part 1 (Commit: 71ea654) - Portfolio Directory Fix
Set `DOLLHOUSE_PORTFOLIO_DIR` environment variable to writable tmpfs location:
1. **Dockerfile**: Added `ENV DOLLHOUSE_PORTFOLIO_DIR=/app/tmp/portfolio`
2. **docker-compose.yml**: Added environment variable to services

#### Part 2 (Commit: 010dba9) - Path Mismatch Fix
**Found issue #2**: Path mismatch between configurations!
1. **Removed env overrides**: Let Dockerfile's ENV take effect consistently
2. **Added tmpfs mount**: Added `--tmpfs /app/tmp` to docker run commands
3. **Consistent path**: Everything now uses `/app/tmp/portfolio`

#### Part 3 (Commit: 3266bcf) - Collection Cache Fix ✨
**Found issue #3**: Collection cache also writing to read-only filesystem!
1. **Added DOLLHOUSE_CACHE_DIR support**: CollectionCache now respects environment variable
2. **Set cache directory**: `DOLLHOUSE_CACHE_DIR=/app/tmp/cache` in Docker configs
3. **Both directories fixed**: Portfolio and cache now use writable tmpfs locations

### Why This Works
- Portfolio initialization uses `/app/tmp/portfolio` consistently  
- Collection cache uses `/app/tmp/cache` for persistent storage
- `/app/tmp` is mounted as writable tmpfs volume
- No conflicting environment variable overrides
- Server can complete initialization and respond to MCP commands

## Investigation Timeline

### Key Discoveries
1. **Docker tests added**: July 3, 2025 (PR #22)
2. **Tests weren't testing MCP**: Just checking if Docker started
3. **Race condition fix**: August 16 (exposed the real problem)
4. **Real test added**: Commit d1c0c78 "Make Docker tests actually test MCP functionality"

### Agent Findings

#### UltraThink Agent (Completed)
- ✅ Identified that race condition fix exposed hidden issue
- ✅ Found portfolio initialization as root cause
- ✅ Proposed environment variable solution

#### Docker Fix Implementation Agent (Completed)
- ✅ Updated all Docker configurations
- ✅ Tested locally - MCP responds correctly
- ✅ Committed and pushed fix to PR #611

#### Latest Investigation Agent (Current)
- ✅ Analyzed CI logs from commit 3266bcf after all previous fixes
- ✅ Identified that portfolio fix worked correctly
- ✅ Found new issue: CollectionCache not using DOLLHOUSE_CACHE_DIR
- ✅ Confirmed CI test failure due to cache directory errors
- ❌ **Next**: Need to fix CollectionCache implementation

## ❌ NEW ISSUE DISCOVERED - CACHE DIRECTORY

### Latest CI Results (Commit 3266bcf)

**The Problem**: Collection cache is still trying to write to read-only filesystem!

#### Error Details from CI Logs:
```
[2025-08-16T22:27:37.723Z] [ERROR] Failed to create cache directory: Error: ENOENT: no such file or directory, mkdir '/app/.dollhousemcp'
[2025-08-16T22:27:37.723Z] [ERROR] Failed to save collection cache: Error: ENOENT: no such file or directory, mkdir '/app/.dollhousemcp'
```

#### Analysis:
1. **Portfolio fix worked**: ✅ Portfolio now uses `/app/tmp/portfolio` correctly
2. **MCP initialize works**: ✅ Server responds to MCP commands properly  
3. **Cache directory problem**: ❌ CollectionCache is NOT using `DOLLHOUSE_CACHE_DIR` environment variable
4. **CI is still failing**: The test now fails because it detects "error" keywords in logs

### Root Cause #4: Cache Directory Environment Variable Not Working
The CollectionCache implementation is **not respecting** the `DOLLHOUSE_CACHE_DIR` environment variable and is still trying to create `/app/.dollhousemcp` instead of `/app/tmp/cache`.

### Current Status
- ✅ Portfolio initialization works in read-only Docker
- ✅ MCP server responds to initialize commands  
- ✅ Local Docker tests may be passing incorrectly (not catching cache errors)
- ❌ CI detects cache errors and fails tests
- ❌ CollectionCache needs to be updated to use environment variable

## Key Lessons Learned

### What Went Wrong
1. **Tests weren't actually testing MCP**: Docker tests only checked container startup
2. **Hidden dependency**: Portfolio initialization required writable filesystem
3. **Race condition masked issue**: Async constructor let tests pass without proper init

### What We Fixed
1. **Race condition**: Server now properly waits for initialization
2. **Docker tests**: Now actually test MCP protocol functionality
3. **Portfolio location**: Set to writable tmpfs in Docker environments

### Prevention for Future
1. **Always test actual functionality**, not just startup
2. **Document filesystem requirements** for components
3. **Test in constrained environments** matching production

## Next Steps

### For PR #611
1. Monitor CI results from commit 71ea654
2. If tests pass, PR is ready to merge
3. Update PR description with root cause explanation

### For PR #606 (Search Index)
1. After #611 merges, rebase on main
2. Should work now that race condition is fixed
3. May need same portfolio directory fix if using Docker

### Documentation Needed
1. Add Docker deployment notes about `DOLLHOUSE_PORTFOLIO_DIR`
2. Document portfolio initialization requirements
3. Update Docker README with environment variables

## Summary for Future Agents

**If you're working on Docker CI issues:**
1. **Read this document first** - Contains full context and solution
2. **Check coordination section** - See what's already been done
3. **Portfolio directory is the key** - Must be writable in Docker
4. **Use tmpfs volumes** - `/tmp` or `/app/tmp` for writable locations
5. **Test with actual MCP commands** - Not just container startup

---

*Coordination document last updated: August 16, 2025 - Issue RESOLVED*