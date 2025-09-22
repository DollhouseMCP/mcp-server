# Session Notes - September 21, 2025 - Docker Claude Code Authentication Investigation

## Session Overview
**Date**: September 21, 2025
**Time**: ~2:00 PM - 4:20 PM PST
**Focus**: Docker Claude Code integration with DollhouseMCP for capability index testing
**Result**: ⚠️ **PARTIAL SUCCESS** - Infrastructure verified, authentication issue identified
**Persona**: Alex Sterling (evidence-based verification guardian)

## Context

Following morning's capability index architecture work, attempted to run empirical tests using Docker Claude Code + DollhouseMCP integration. Goal was to test whether Claude would use capability indexes with 97% token reduction.

User was CERTAIN this worked before, remembering successful Docker Claude Code tests from September 10, 2025.

## What We Successfully Accomplished

### 1. Infrastructure Verification ✅

**Docker Image Built Successfully**:
- Image: `claude-mcp-test-env`
- Claude Code v1.0.110 installed
- DollhouseMCP v1.9.8 built and configured
- MCP config at `/home/claude/.config/claude-code/config.json`

**MCP Server Verified Working**:
```bash
# Direct test showed MCP server starts correctly:
[2025-09-21T20:09:45.844Z] [INFO] Starting DollhouseMCP server...
[2025-09-21T20:09:45.849Z] [DEBUG] Saved 34 items to collection cache
```

### 2. Found Previous Documentation ✅

Located comprehensive documentation from September 10, 2025:
- `SESSION_NOTES_2025_09_10_EVENING_DOCKER_SUCCESS.md` - Claims "COMPLETE SUCCESS"
- `SESSION_NOTES_2025_09_10_DOCKER_CLAUDE_CODE.md` - Detailed implementation
- `docker/CLAUDE_CODE_INTEGRATION.md` - Full integration guide
- `scripts/test-claude-docker.sh` - Test automation script

**Key Discovery from Docs**:
- They used `ANTHROPIC_API_KEY` environment variable
- Required `--mcp-config` flag explicitly
- Ran as `claude` user (not root) for security

### 3. Identified the Authentication Problem ❌

**The Blocker**:
```
Invalid API key · Please run /login
```

**Root Cause Identified**:
- Claude Code v1.0.110 uses OAuth authentication, NOT API keys directly
- The `/login` command requires browser interaction (impossible in Docker)
- `ANTHROPIC_API_KEY` environment variable doesn't authenticate Claude Code

**Evidence**:
1. API key IS passed to container correctly: `sk-ant-api03-...`
2. MCP server starts fine (doesn't need Claude auth)
3. Claude Code consistently rejects with "Invalid API key"
4. No evidence of actual Claude queries working in September 10 logs

## Critical Discovery: Missing Piece

The September 10 documentation shows infrastructure setup but **NO ACTUAL CLAUDE CODE QUERIES EXECUTING**. They built the container, verified MCP tools were detected, but there's no evidence of Claude Code actually running queries with the API key.

**Suspicious Gap**:
- Docs say "Full success"
- Show build commands
- Show MCP config
- DON'T show actual working Claude queries
- DON'T show how authentication was solved

## What We Tried

1. **Direct API Key**: ❌ `Invalid API key`
2. **With --print flag**: ❌ `Invalid API key`
3. **With --allowedTools**: ❌ `Invalid API key`
4. **With --permission-mode**: ❌ `Invalid API key`
5. **Mounting .claude.json**: ❌ `Invalid API key` (and permission errors)
6. **Different config paths**: ❌ Same issue

## File System Evidence

Found test directories showing attempted runs:
```
docker-test-runs/claude-1758477697/
docker-test-runs/claude-1758477789/
```

All contain proper CLAUDE.md files with capability indexes but no successful execution.

## The Mystery

User is **100% certain** this worked before. Possibilities:

1. **Different Claude Code version** had API key support (not v1.0.110)
2. **OAuth token was somehow cached** in a config we haven't found
3. **Alternative authentication method** exists we haven't discovered
4. **Configuration files were saved** but not where we're looking

## What's Needed for Next Session

### Search for Missing Configuration
```bash
# Look for any saved auth configs around September 10
find . -name "*.json" -o -name "*.env" | xargs grep -l "claude\|token\|auth"

# Check for Docker volumes that might have auth
docker volume ls

# Look for alternative Dockerfiles
find . -name "Dockerfile*" | xargs grep -l "claude"
```

### Alternative Approaches

1. **Test MCP directly** without Claude Code
2. **Find if Claude Code has API key mode** in different version
3. **Locate the actual working config** from September 10

## Capability Index Testing Status

Despite authentication issues, we:
- ✅ Created comprehensive test framework
- ✅ Validated index structures score 100/100
- ✅ Confirmed 97% token reduction theoretically
- ❌ Could not run empirical tests with real Claude

## User Frustration Point

> "I'm really annoyed that these configuration files were not saved"

The user KNOWS this worked and specifically remembers asking for configs to be saved. The evidence exists somewhere - we just haven't found it yet.

## Summary

**What we proved**:
- Docker infrastructure works
- MCP server runs correctly
- Capability index structure is sound

**What's blocking us**:
- Claude Code OAuth authentication in Docker
- Missing configuration from previous successful run

**Next session priority**:
- Find the saved configuration files
- Search around September 10 timeframe more thoroughly
- Identify what made it work before

---

*Session Duration*: ~2.5 hours
*Context Usage*: Started at ~40k, ending near limit
*Key Learning*: Claude Code v1.0.110 doesn't accept API keys directly - needs OAuth or alternative auth method we haven't found yet