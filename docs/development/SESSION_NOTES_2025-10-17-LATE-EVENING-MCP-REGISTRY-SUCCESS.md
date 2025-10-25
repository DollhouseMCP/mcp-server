# Session Notes - October 17, 2025 (Late Evening)

**Date**: October 17, 2025
**Time**: Late Evening
**Duration**: ~2 hours
**Focus**: MCP Registry Publishing Fix & Visibility Discovery
**Outcome**: ✅ **COMPLETE SUCCESS** - Published to registry, discovered visibility requirements

---

## Executive Summary

Successfully diagnosed and fixed the MCP registry publishing issue from the previous session. The previous conclusion that we needed "admin permissions" was **completely wrong** - the actual issue was a simple capitalization mismatch in the `mcpName` field. Released v1.9.20, successfully published to the official MCP Registry, but discovered that human-visible discovery requires separate submissions to community browsing platforms.

---

## What Was Actually Wrong (Previous Session Misdiagnosed)

### The Previous Session's Incorrect Conclusion
- ❌ Claimed we needed to "contact registry admins for permissions"
- ❌ Suggested waiting for admin intervention
- ❌ Recommended manual publishing as a workaround

### The Real Root Cause
The `mcpName` field in package.json was set to **lowercase** when it should have matched our GitHub organization's **capitalization**:

```json
// ❌ WRONG (what we had)
"mcpName": "io.github.dollhousemcp/mcp-server"

// ✅ CORRECT (what we needed)
"mcpName": "io.github.DollhouseMCP/mcp-server"
```

### Why This Mattered
The MCP Registry performs TWO validations:
1. **Permission check**: Against GitHub org name `io.github.DollhouseMCP/*` ✅ (we always passed)
2. **NPM validation**: Fetches `mcpName` from NPM package and compares to `server.json` name ❌ (this was failing)

The registry was fetching the lowercase `mcpName` from NPM and comparing it to our capital-case server.json name, causing validation failure.

---

## What We Did to Fix It

### 1. Created Hotfix Branch
```bash
git checkout -b hotfix/mcp-registry-case-sensitivity
```

### 2. Fixed Three Files

**package.json:**
- Updated `mcpName`: `io.github.dollhousemcp/mcp-server` → `io.github.DollhouseMCP/mcp-server`
- Bumped version: `1.9.19` → `1.9.20`

**server.json:**
- Updated version to `1.9.20` (both root and packages array)
- Name field already had correct capitalization

**CHANGELOG.md:**
- Added comprehensive v1.9.20 entry explaining the fix
- Documented the case sensitivity issue
- Provided context for future reference

### 3. Merged and Published

**PR #1374**: https://github.com/DollhouseMCP/mcp-server/pull/1374
- All 14 CI checks passed ✅
- Merged to main via squash
- Published v1.9.20 to NPM
- NPM now has corrected mcpName: https://registry.npmjs.org/@dollhousemcp/mcp-server/1.9.20

### 4. Tested MCP Registry Publication

Triggered workflow: https://github.com/DollhouseMCP/mcp-server/actions/runs/18606977360

**Result**: ✅ **SUCCESS!**
```
✓ Successfully published
✓ Server io.github.DollhouseMCP/mcp-server version 1.9.20
```

---

## The Visibility Discovery

### What We Published To (Technical Infrastructure)
✅ **Official MCP Registry API**: `registry.modelcontextprotocol.io`
- Queryable via: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=dollhouse"`
- Returns our server metadata as JSON
- Status: "active"
- Published: 2025-10-17T23:12:58Z

### What We're NOT On Yet (Human Browsing)

The MCP Registry ecosystem has **TWO LAYERS**:

1. **API Backend** (where we are) ✅
   - `registry.modelcontextprotocol.io`
   - Programmatic discovery for clients/tools
   - We successfully published here

2. **Human Browsing Sites** (where we're NOT yet) ❌
   - Multiple independent platforms
   - Require separate submissions
   - Each has different requirements

---

## MCP Directory Platforms Discovered

### 1. mcp.so
- **Size**: 16,811+ servers
- **URL**: https://mcp.so/
- **Submission**: https://github.com/chatmcp/mcp-directory/issues/1
- **Method**: Manual submission via GitHub issue comment
- **Status**: ❌ Not listed yet
- **Next Step**: Submit server details to Issue #1

### 2. PulseMCP
- **Size**: 6,320+ servers (updated daily)
- **URL**: https://www.pulsemcp.com/servers
- **Method**: Unknown - possibly auto-syncs from official registry?
- **Notes**: Led by Tadas Antanavicius (official registry maintainer)
- **Status**: ❌ Not listed yet
- **Next Step**: Research submission process or wait for auto-sync

### 3. MCP Market
- **URL**: https://mcpmarket.com/
- **Features**: Complete collection with categories, leaderboards
- **Method**: Unknown
- **Status**: ❌ Not listed yet
- **Next Step**: Research submission process

### 4. mcpservers.org (Awesome MCP Servers)
- **URL**: https://mcpservers.org/
- **Type**: Curated collection
- **Method**: Unknown
- **Status**: ❌ Not listed yet
- **Next Step**: Research submission process

### 5. MCP Server Finder
- **URL**: https://www.mcpserverfinder.com/
- **Features**: Detailed profiles, implementation guides, reviews
- **Method**: Unknown
- **Status**: ❌ Not listed yet
- **Next Step**: Research submission process

### 6. github.com/mcp (GitHub MCP Registry)
- **Size**: ~40 curated entries
- **Type**: Manually curated by GitHub
- **Partners**: Microsoft, Figma, Dynatrace, HashiCorp, etc.
- **Method**: No public submission process (partnership-based)
- **Status**: ❌ Not listed yet
- **Next Step**: Probably not achievable short-term (requires GitHub curation)

### 7. Community Awesome Lists
- **punkpeye/awesome-mcp-servers**: https://github.com/punkpeye/awesome-mcp-servers
- **wong2/awesome-mcp-servers**: https://github.com/wong2/awesome-mcp-servers
- **appcypher/awesome-mcp-servers**: https://github.com/appcypher/awesome-mcp-servers
- **TensorBlock/awesome-mcp-servers**: https://github.com/TensorBlock/awesome-mcp-servers
- **Method**: Submit PR to each repository
- **Status**: ❌ Not listed yet
- **Next Step**: Submit PRs to community lists

---

## Key Learnings

### About MCP Registry Publishing

1. **The official registry is an API, not a visual site**
   - `registry.modelcontextprotocol.io` is for programmatic access
   - No human-browsable interface at that URL
   - Returns JSON, not HTML pages

2. **Human discovery happens elsewhere**
   - Multiple independent platforms built on top of the official registry
   - Each platform has its own curation/submission process
   - No automatic syndication (yet)

3. **Case sensitivity matters everywhere**
   - GitHub org names are case-preserving
   - NPM normalizes package scopes to lowercase
   - Custom fields like `mcpName` can preserve case
   - Registry validations are case-sensitive

### What "Successfully Published" Actually Means

**Technical Success** ✅:
- Our server is in the official registry database
- API queries return our metadata
- MCP clients can discover us programmatically
- VS Code, Claude Desktop, etc. can find us via API

**Human Visibility** ❌ (Pending):
- Not on browsing websites yet
- Requires manual submissions to each platform
- Each platform has different requirements
- No automatic syndication from official registry

---

## Next Session Priorities

### CRITICAL: Get Listed on Browsing Platforms

#### Immediate Actions (Session Start)
1. **Submit to mcp.so** (PRIORITY 1)
   - Comment on https://github.com/chatmcp/mcp-directory/issues/1
   - Use prepared submission text (user will customize)
   - Expected turnaround: Unknown

2. **Research PulseMCP submission** (PRIORITY 2)
   - Check if auto-sync is happening
   - Look for manual submission process
   - Contact maintainers if needed

3. **Research MCP Market submission** (PRIORITY 3)
   - Find submission process
   - Document requirements
   - Submit if process is clear

#### Follow-Up Actions (Next Few Days)
4. **Submit to mcpservers.org**
   - Research submission process
   - Prepare submission materials
   - Submit when ready

5. **Submit to MCP Server Finder**
   - Research submission process
   - Create detailed profile
   - Submit when ready

6. **Submit to Community Awesome Lists**
   - Fork repositories
   - Add DollhouseMCP entries
   - Submit PRs with proper formatting

#### Long-Term Aspirations
7. **Monitor for GitHub MCP Registry inclusion**
   - No action available (curated by GitHub)
   - Continue growing community presence
   - Possible future inclusion if project gains traction

### Documentation Tasks
8. **Create MCP Directory Submission Guide**
   - Document each platform's requirements
   - Create submission templates
   - Track submission status

9. **Update Release Workflow Documentation**
   - Add "Submit to directories" step
   - Create checklist for new releases
   - Document which submissions are automatic vs manual

---

## Files Modified This Session

### Code Changes
- `package.json` - Updated mcpName capitalization + version bump to 1.9.20
- `server.json` - Updated version to 1.9.20
- `CHANGELOG.md` - Added v1.9.20 release entry with full context

### PRs Created
- **PR #1374**: Fix mcpName capitalization for MCP Registry publishing
  - Status: ✅ Merged to main
  - All CI checks passed
  - Squash merged

### Releases
- **v1.9.20** published to NPM
  - Contains corrected mcpName field
  - Successfully validated by MCP Registry
  - Published at: 2025-10-17T23:12:58Z

---

## Session Performance Notes

### What Went Wrong
- Multiple misunderstandings about what registry publication means
- Initial confusion about visibility vs technical publication
- Some errors in drafting submission text
- Should have recognized the visibility issue faster

### What Went Right
- Successfully diagnosed the real root cause
- Fixed the issue correctly with proper PR process
- All CI checks passed
- Registry publication succeeded
- Discovered the full ecosystem of browsing platforms

---

## Statistics

- **Duration**: ~2 hours
- **PRs Created**: 1
- **Commits**: 1 (squash merged)
- **NPM Releases**: 1 (v1.9.20)
- **CI Runs**: 14 checks (all passed)
- **Registry Publications**: 1 (successful)
- **Directories Discovered**: 7+ platforms
- **Current Visibility**: API only (human browsing pending)

---

## Links for Reference

### Our Server
- **NPM Package**: https://www.npmjs.com/package/@dollhousemcp/mcp-server
- **GitHub Repo**: https://github.com/DollhouseMCP/mcp-server
- **Registry API**: https://registry.modelcontextprotocol.io/v0/servers?search=dollhouse
- **Workflow Run**: https://github.com/DollhouseMCP/mcp-server/actions/runs/18606977360

### Submission Targets
- **mcp.so submission**: https://github.com/chatmcp/mcp-directory/issues/1
- **PulseMCP**: https://www.pulsemcp.com/servers
- **MCP Market**: https://mcpmarket.com/
- **mcpservers.org**: https://mcpservers.org/
- **MCP Server Finder**: https://www.mcpserverfinder.com/

---

## Honest Assessment

**Technical Achievement**: ✅ Complete success. We fixed the bug, published successfully, and are now live on the official MCP Registry API.

**Visibility Achievement**: ⚠️ Incomplete. We're technically discoverable but not yet human-visible on major browsing platforms.

**Session Performance**: ⚠️ Below expectations. Should have been faster, should have anticipated the visibility issue, multiple misunderstandings along the way.

**Next Steps Clarity**: ✅ Very clear. We know exactly what needs to happen next - submit to each browsing platform manually.

---

*Session ended: 2025-10-17 ~23:45*
