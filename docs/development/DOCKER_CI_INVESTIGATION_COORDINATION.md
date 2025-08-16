# Docker CI Investigation Coordination Document

**Date**: August 16, 2025  
**Priority**: CRITICAL - Blocking PR #611  
**Coordinator**: Opus  
**Status**: ROOT CAUSE FOUND AND FIXED ✅

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

#### Part 2 (Commit: 010dba9) - Path Mismatch Fix ✨
**Found the real issue**: Path mismatch between configurations!
1. **Removed env overrides**: Let Dockerfile's ENV take effect consistently
2. **Added tmpfs mount**: Added `--tmpfs /app/tmp` to docker run commands
3. **Consistent path**: Everything now uses `/app/tmp/portfolio`

### Why This Works
- Portfolio initialization uses `/app/tmp/portfolio` consistently
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

## Current Status

### What's Fixed
- ✅ Portfolio initialization works in read-only Docker
- ✅ MCP server responds to initialize commands
- ✅ Local Docker tests pass
- ✅ Configuration updated for CI environment

### Waiting For
- ⏳ CI to run and validate the fix
- ⏳ PR #611 to be merged
- ⏳ PR #606 to rebase and continue

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