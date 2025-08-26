# Session Notes - August 26, 2025 - Real MCP Tool Testing & Critical Findings

## Session Context
**Date**: August 26, 2025, ~2:00 PM - 3:00 PM  
**Focus**: Testing ACTUAL MCP server tools (not GitHub API/CLI)  
**Critical Discovery**: MCP submit_content tool has a path validation bug  

## Key Achievement: We Tested the REAL MCP Tools!

### What We Built
1. **Real GitHub Integration Tests** (`test/e2e/real-github-integration.test.ts`)
   - Tests that actually upload to GitHub (no mocks)
   - Found repository mismatch issue (uploads to `dollhouse-portfolio` instead of test repo)
   - 3 of 7 tests passed, revealing real issues

2. **MCP Tool Direct Testing** (`test/e2e/test-mcp-simple-submit.js`)
   - Tests the ACTUAL `server.submitContent()` method
   - This is what the MCP `submit_content` tool really calls
   - **CRITICAL FINDING**: Tool fails with "File path could not be safely processed"

## Critical Findings

### 1. Repository Configuration Issue
- **Problem**: PortfolioRepoManager hardcoded to use `dollhouse-portfolio`
- **Evidence**: Uploads succeed but go to wrong repo
- **URLs Generated**: `https://github.com/mickdarling/dollhouse-portfolio/commit/...`
- **Should Be**: `https://github.com/mickdarling/dollhouse-portfolio-test/commit/...`

### 2. MCP submit_content Path Validation Bug
```javascript
// Test personas created:
/Users/mick/.dollhouse/portfolio/personas/test-mcp-real-ziggy.md
/Users/mick/.dollhouse/portfolio/personas/mcp-test-simple.md

// MCP Tool Response:
{
  "content": [
    {
      "type": "text",
      "text": "❌ File path could not be safely processed"
    }
  ]
}
```
**The REAL MCP tool is rejecting legitimate test files!**

### 3. Token Scope Warning
- Token has: `read:org, read:user, repo, user:email`
- Warning: Missing `public_repo` scope (but `repo` includes it)
- This may be a false positive in validation

## Important Configuration

### GitHub Test Token
- **CRITICAL**: Must `source ~/.zshrc` to load `GITHUB_TEST_TOKEN`
- Token stored in `.zshrc` file
- Token confirmed working with GitHub API

### Test Repository Created
- ✅ Created: `mickdarling/dollhouse-portfolio-test`
- Used for integration testing
- Created via test setup, not MCP tools

## QA Personas Organization

### Successfully Organized Test Personas
- Created `/personas/qa/` subfolder in GitHub portfolio
- Moved 9 test personas to QA folder
- Used GitHub API directly (not MCP tools)
- Available at: https://github.com/mickdarling/dollhouse-portfolio/tree/main/personas/qa

### Test Personas Moved:
- test-auto-20250811-164351-ba06.md
- test-manual-20250811-164351-ba06.md
- test-qa-null-commit-test-* (2 files)
- test-qa-public-persona-* (2 files)
- test-qa-url-test-* (2 files)
- test-ziggy.md

## What Actually Works vs What Doesn't

### ✅ Working:
- GitHub API operations (when using CLI/direct API)
- URL generation with fallbacks
- Bulk sync prevention (only uploads requested files)
- Error code generation
- File uploads to GitHub (wrong repo but successful)

### ❌ Not Working:
- MCP submit_content tool (path validation failure)
- Repository configuration (hardcoded to production)
- Path safety validation (too restrictive)

## Critical Code Locations

### MCP Tool Handler
```javascript
// src/server/tools/CollectionTools.ts:145
handler: (args: any) => server.submitContent(args.content)
```

### The Actual Method Called
```javascript
// src/index.ts - DollhouseMCPServer.submitContent()
// This is what REALLY gets called by the MCP tool
```

## Test Files Created

### Local Test Personas
- `/Users/mick/.dollhouse/portfolio/personas/test-mcp-real-ziggy.md`
- `/Users/mick/.dollhouse/portfolio/personas/mcp-test-simple.md`
- `/Users/mick/.dollhouse/portfolio/personas/test-mcp-qa-folder.md`

### Test Scripts
- `test/e2e/real-github-integration.test.ts` - Full integration suite
- `test/e2e/test-mcp-simple-submit.js` - Direct MCP tool test
- `scripts/organize-qa-personas.js` - GitHub organization script

## Key Learnings

1. **Testing Real MCP Tools is Essential**
   - GitHub CLI/API tests don't reveal MCP tool issues
   - The actual MCP tools have different behavior than expected
   - Path validation is blocking legitimate operations

2. **Configuration Issues**
   - Repository names are hardcoded in places
   - Test configuration not respected by PortfolioRepoManager
   - Token validation may have false positives

3. **Security Too Restrictive**
   - Path safety check failing on valid paths
   - Many portfolio items flagged as security threats
   - Content validation preventing legitimate uploads

## Next Session Priorities

1. **Fix Path Validation Bug**
   - Investigate why legitimate paths fail safety check
   - May need to adjust PathValidator initialization

2. **Fix Repository Configuration**
   - Make PortfolioRepoManager respect test repo setting
   - Remove hardcoded repository names

3. **Complete MCP Tool Testing**
   - Once path validation fixed, test full upload flow
   - Verify if QA subfolder upload possible

## Session End State

- **Context**: 98% used
- **Status**: Identified critical MCP tool bug
- **Next Step**: Fix path validation in submitContent
- **Remember**: Always test REAL MCP tools, not just GitHub API!

---

**CRITICAL REMINDER**: The user emphasized testing ACTUAL MCP tools is what matters. GitHub API/CLI tests prove nothing about whether MCP tools work for users in Claude.