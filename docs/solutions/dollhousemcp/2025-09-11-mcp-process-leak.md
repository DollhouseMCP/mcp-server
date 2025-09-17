# FAILURE: 94 Zombie MCP Server Processes Accumulating
**Date**: 2025-09-11 23:05:00
**Status**: ❌ ACTIVE PROBLEM - RESOURCE LEAK
**Checklist**: N/A - Failure documentation
**Problem Category**: DollhouseMCP/Process Management
**Impact**: System resources, confusion, unpredictable behavior

## Problem Statement
### Discovery
```bash
ps aux | grep "/mcp-server/dist/index.js" | wc -l
# Result: 94
```

94 MCP server processes running simultaneously, some from 4 days ago.

### Symptoms
- Multiple Node.js processes consuming RAM
- Processes dating back to Saturday Sept 7
- Claude Code spawning new instances without killing old
- Test runs leaving zombie processes
- Docker containers not cleaning up

## Environment Context
### System Information
- **OS**: macOS Darwin 24.6.0
- **Claude Code**: Latest version
- **MCP Server**: DollhouseMCP v1.7.x
- **Working Directory**: `/Users/mick/Developer/Organizations/DollhouseMCP`

### Process Distribution
```
20 processes from Mon03PM
14 processes from Tue07PM
12 processes from Mon02PM
10 processes from Wed09AM
10 processes from Wed03PM
8 processes from Mon01PM
5 processes from Wed12PM
4 processes from various times
3 processes from Sat05PM (Sept 7)
```

## Root Causes Identified

### 1. Claude Code Process Management
- Spawns new MCP server on restart
- Doesn't kill previous instance
- No process tracking/management

### 2. Test Framework Issues
- Test runs spawn MCP servers
- No cleanup in teardown
- Processes persist after tests complete

### 3. Docker Container Cleanup
- Test containers keep running
- Example: Container from 7:28PM still active
- No automatic cleanup

## Mysteries & Unknowns

### Connection Routing Mystery
**Question**: How does Claude Code connect to ONE specific server among 94?
**Theory**: Maybe only the latest spawned server accepts connections?
**Evidence Needed**: Port binding investigation

### Process Accessibility Mystery
**Question**: Are old processes actually accessible or just orphaned?
**Theory**: They may be zombies with no active connections
**Evidence Needed**: Network connection analysis

### Performance Mystery
**Observation**: 94 processes didn't noticeably impact performance
**Implication**: DollhouseMCP is remarkably efficient
**Question**: How much RAM are they actually using?

## What We Tried
### Investigation Commands
```bash
# Count processes
ps aux | grep "/mcp-server/dist/index.js" | grep -v grep | wc -l

# Group by start time
ps aux | grep "/mcp-server/dist/index.js" | awk '{print $9}' | sort | uniq -c

# Check for test processes
ps aux | grep -E "dollhouse.*test|claude-mcp-test"

# Find Docker containers
docker ps | grep dollhouse
```

## Current State
- 94 zombie processes active
- Resources being consumed
- Behavior unpredictable
- Cleanup needed urgently

## Cleanup Strategy (NOT YET EXECUTED)

### Step 1: Save Evidence
```bash
# Document all processes
ps aux | grep dollhouse > ~/Desktop/zombie-processes-evidence.txt
```

### Step 2: Kill MCP Servers
```bash
# Kill all MCP server processes
pkill -f "mcp-server/dist/index.js"
```

### Step 3: Stop Docker Containers
```bash
# Find and stop test containers
docker ps | grep dollhouse | awk '{print $1}' | xargs docker stop
```

### Step 4: Verify Cleanup
```bash
ps aux | grep dollhouse | grep -v grep
```

## Long-term Solutions Needed

### Solution A: Process Management in Claude Code
```javascript
// Add to Claude Code's MCP launcher
process.on('SIGTERM', () => {
  childProcess.kill('SIGTERM');
});

process.on('exit', () => {
  childProcess.kill('SIGKILL');
});
```

### Solution B: Singleton Pattern
```javascript
// Check for existing before spawning
const existing = findProcess('mcp-server');
if (!existing) {
  spawnNewMCPServer();
} else {
  reuseExisting(existing);
}
```

### Solution C: Test Cleanup
```javascript
// In test teardown
afterEach(async () => {
  await killAllTestProcesses();
  await stopTestContainers();
});
```

## Impact Analysis
- **Resource Usage**: Unknown but accumulating
- **Predictability**: Which server responds is unclear
- **Testing**: Results may be inconsistent
- **Development**: Confusion about state

## Related Issues
- Skill activation failure (may be related to wrong process)
- Markdown corruption (separate but discovered simultaneously)
- Docker test failures (processes interfering?)

## GitHub Issue
**To Create**: Process leak - Claude Code doesn't clean up MCP servers
**Priority**: CRITICAL
**Labels**: bug, resource-leak, process-management

## Key Insight
Despite 94 processes, system remained responsive. This indicates:
1. DollhouseMCP is very efficient
2. Node.js handles multiple instances well
3. Problem might be more about predictability than performance

---
**Status**: AWAITING CLEANUP DECISION
**Risk**: May lose working skills after cleanup
**Recommendation**: Document what works first, then clean slate