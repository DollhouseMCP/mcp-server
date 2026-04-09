# Diagnostic Handoff: Issue #1850 — Empty Console Tabs

## Problem

The DollhouseMCP web console opens from Claude Desktop but all data tabs (Auth, Logs, Metrics, Sessions) are empty. The portfolio tab works. This suggests the web server started without its in-memory data sinks wired up.

## What We Need to Find

We need to determine **which code path started the web server**:

- **Path A (correct)**: `UnifiedConsole.startAsLeader()` → starts server with full sinks, token store, ingest routes → everything works
- **Path B (broken)**: `openPortfolioBrowser()` fallback → starts a bare server with no sinks → empty tabs
- **Path C (possible)**: `UnifiedConsole.startAsFollower()` → no server started, then Path B kicks in when user opens console

## Steps

### 1. Enable Debug Logging

Set this environment variable before starting Claude Desktop:

```bash
export DOLLHOUSE_DEBUG=true
```

Or add it to the Claude Desktop MCP server config for DollhouseMCP.

### 2. Start Claude Desktop and Open the Console

Ask Claude to open the portfolio browser:
> "Open the DollhouseMCP web console"

### 3. Check the Application Log

Read the log file at:
```
~/.dollhouse/logs/application-2026-04-08.log
```

(Use today's date if different.)

### 4. Search for These Key Log Entries

Search in order of importance:

#### a. Did the web console start at all?
```
grep -i "Web console" ~/.dollhouse/logs/application-*.log | tail -20
```
Look for:
- `[Container] Web console started as leader` — **Path A (correct)**
- `[Container] Web console started as follower` — **Path C (problem)**
- `[Container] Web console startup failed` — **crashed silently**

#### b. What did leader election decide?
```
grep -i "LeaderElection\|UnifiedConsole" ~/.dollhouse/logs/application-*.log | tail -20
```
Look for:
- `[UnifiedConsole] Leader started` with port and PID
- `[UnifiedConsole] Follower started` with leader info
- `[LeaderElection] Forcing leadership takeover` — means it detected a stale leader
- Any errors or warnings

#### c. Is there a stale lock file?
```
cat ~/.dollhouse/run/console-leader.lock
```
This JSON file shows which process claims leadership. Check if the `pid` is still running:
```
ps -p <pid from lock file>
```
If the process is dead, the lock is stale.

#### d. What did openPortfolioBrowser do?
```
grep -i "Portfolio browser\|serverRunning\|WebUI.*mounted" ~/.dollhouse/logs/application-*.log | tail -20
```
Look for:
- `[WebUI] Log viewer routes mounted` — sinks ARE wired (Path A)
- `[WebUI] API routes using MCP-AQL Gateway` without log/metrics routes — sinks are MISSING (Path B)
- `[WebUI] Console auth middleware mounted` — token store IS present

### 5. Check for Stale Port Files
```
ls -la ~/.dollhouse/run/
```
Multiple `permission-server-*.port` files indicate stale state from prior runs. The `console-leader.lock` file is the critical one.

## What to Report Back

The key answers we need:
1. Did the log say `started as leader` or `started as follower`?
2. Is there a `console-leader.lock` file and is the PID in it alive?
3. Were `Log viewer routes mounted` and `Console auth middleware mounted` present in the logs?
4. Any `Web console startup failed` warnings?

## Quick Fix to Test

If you find a stale lock file (dead PID), delete it and restart:
```bash
rm ~/.dollhouse/run/console-leader.lock
```
Then restart Claude Desktop. If the console works after that, the root cause is stale lock file handling.
