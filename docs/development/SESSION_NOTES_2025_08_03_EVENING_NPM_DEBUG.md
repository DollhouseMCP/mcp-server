# Session Notes - August 3, 2025 Evening - NPM Installation Debug

## Session Overview
**Date**: August 3, 2025 (Evening, ~8:00 PM)
**Branch**: hotfix/v1.4.2-npm-initialization
**Context**: Critical NPM installation failure investigation
**Status**: Root cause identified, hotfix needed

## Major Findings ✅

### 1. NPM Package v1.4.1 Installation Failure Confirmed
- Fresh NPM installations fail with Claude Desktop
- Server exits ~2 seconds after initialization
- Created critical Issue #444

### 2. Root Cause Identified
**The NPM package works differently than expected:**
- ✅ NPM package DOES include all default personas/skills/templates in `/data/`
- ✅ Server starts successfully and creates portfolio structure
- ❌ Portfolio directories created EMPTY - no default content copied
- ❌ Server runs with 0 personas/elements loaded
- ❌ Claude Desktop disconnects (likely due to empty state)

### 3. Key Discovery
The disconnect between bundled content and runtime:
- **Bundled location**: `/opt/homebrew/lib/node_modules/@dollhousemcp/mcp-server/data/`
- **Runtime location**: `~/.dollhouse/portfolio/`
- **Missing logic**: No code copies from bundled to runtime location

### 4. Testing Results
```bash
# Portfolio created but empty
~/.dollhouse/portfolio/
├── agent/     (empty)
├── ensemble/  (empty)
├── memory/    (empty)
├── persona/   (empty)
├── skill/     (empty)
└── template/  (empty)

# NPM package has all content
/opt/homebrew/lib/node_modules/@dollhousemcp/mcp-server/data/
├── agents/     (3 files)
├── ensembles/  (4 files)
├── memories/   (3 files)
├── personas/   (6 files)
├── skills/     (7 files)
└── templates/  (8 files)
```

## Critical Insights

### Why NPM vs Git Matters
- **Git installations**: Likely use local `data/` directory directly
- **NPM installations**: Look in `~/.dollhouse/portfolio/` which starts empty
- Server handles empty directories gracefully (no crash)
- But Claude Desktop fails when server has no content

### Server Behavior
1. Running directly with `node` - works fine, waits for stdin
2. Running via `npx` with Claude - crashes after ~2 seconds
3. No error messages in logs or stderr
4. Creates all directories successfully before failing

## Required Hotfix v1.4.2

### Implementation Needed
1. Modify `PortfolioManager.initialize()` to:
   - Detect if portfolio is empty (first run)
   - Check if running from NPM (using `InstallationDetector`)
   - Copy all content from bundled `data/` to portfolio
   - Only copy if destination doesn't exist (don't overwrite)

2. Key files to modify:
   - `src/portfolio/PortfolioManager.ts` - Add copy logic
   - Use existing `InstallationDetector` utility
   - Recursive copy from NPM package data to portfolio

### Why This Approach
- Uses already-bundled content (no new files needed)
- Preserves user modifications (no overwrites)
- Works identically for all installation types after first run
- Maintains the portfolio structure design

## Test Plan for Tomorrow

1. Implement the copy logic
2. Build and test locally with empty portfolio
3. Test with `npm pack` and local install
4. Verify personas are copied and server starts
5. Test that existing content is not overwritten
6. Create v1.4.2 release

## Commands for Next Session

```bash
# Get on hotfix branch
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
git checkout hotfix/v1.4.2-npm-initialization

# Key files to edit
code src/portfolio/PortfolioManager.ts
code src/utils/installation.ts

# Test commands
rm -rf ~/.dollhouse/portfolio  # Clean slate
npm run build
node dist/index.js  # Should create and populate portfolio
```

## Current State
- Issue #444 created as critical
- Hotfix branch created
- Root cause fully understood
- Implementation plan clear
- Ready to code the fix tomorrow

---

**Next session focus**: Implement the portfolio initialization fix and release v1.4.2 hotfix.

**Time spent**: Approximately 2 hours debugging NPM installation failure.