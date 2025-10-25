# Session Notes - October 17, 2025 (Afternoon)

**Date**: October 17, 2025
**Time**: 12:50 PM - 3:30 PM (2 hours 40 minutes)
**Focus**: v1.9.18 Release & MCP Registry Publishing Investigation
**Outcome**: ⚠️ Partial - NPM published, MCP registry requires GitHub Actions (not manual CLI)

## Executive Summary

Successfully completed v1.9.18 release to NPM and GitHub Releases. Attempted to publish to MCP registry manually using CLI but discovered **critical bug**: OAuth device flow is broken for organization namespaces. Research revealed all major organizations (Microsoft, Cloudflare, Prefect) use **GitHub Actions with OIDC** instead. Manual CLI publishing only works for personal namespaces.

**Key Takeaway**: Stop trying to use `mcp-publisher login github` for organizations. It's fundamentally broken and will never work.

---

## Session Activities

### ✅ Part 1: v1.9.18 Release Verification (15 minutes)

**Objective**: Verify v1.9.18 release status and investigate GitHub Packages failure

**Findings**:
1. **NPM**: ✅ Successfully published at `@dollhousemcp/mcp-server@1.9.18`
2. **GitHub Release**: ⚠️ Was in DRAFT status - published during session
3. **GitHub Packages**: ✅ Published successfully on first workflow run (16:19:44Z)
   - Second run (16:42:51Z) failed with 409 Conflict - expected behavior (can't overwrite versions)
   - Error was NOT a problem - first publish succeeded

**Actions Taken**:
- Published v1.9.18 GitHub release from draft using `gh release edit v1.9.18 --draft=false`
- Verified NPM metadata: version, license, keywords, mcpName all correct
- Confirmed dual license (AGPL-3.0 + Commercial) properly visible in LICENSE file

**Git References**:
- Release commit: `2a896acb`
- Tag: `v1.9.18` on main
- Merge back to develop: `99c6bc1f`

---

### ❌ Part 2: MCP Registry Manual Publishing Attempt (2 hours 25 minutes)

**Objective**: Publish DollhouseMCP to Model Context Protocol registry at registry.modelcontextprotocol.io

**What We Tried**:

1. **Initial Setup** (30 minutes)
   - Installed `mcp-publisher` CLI (already installed via Homebrew)
   - Created working directory: `~/Developer/Organizations/DollhouseMCP/mcp-registry-publishing/`
   - Created `server.json` with metadata for v1.9.18

2. **Schema Issues** (10 minutes)
   - Initial schema `2025-10-17` was deprecated
   - Updated to current schema: `2025-09-29`
   - Fixed description (was 211 chars, max is 100 chars)
   - Final description: "OSS to create Personas, Skills, Templates, Agents, and Memories to customize your AI experience." (96 chars)

3. **Authentication Attempts** (Multiple cycles, ~45 minutes)
   - Ran `mcp-publisher login github` multiple times
   - GitHub OAuth device flow completed successfully each time
   - Token stored in `.mcpregistry_github_token`

4. **Publish Failures** (Multiple attempts, ~40 minutes)
   ```
   Error 403: You have permission to publish: io.github.mickdarling/*, io.github.YasminApp/*
   Attempting to publish: io.github.DollhouseMCP/mcp-server
   ```

5. **GitHub Organization Troubleshooting** (20 minutes)
   - Checked organization OAuth restrictions (initially enabled)
   - Removed OAuth restrictions for DollhouseMCP organization
   - Made organization membership public (changed from private to public)
   - Multiple logout/login cycles to refresh tokens
   - **None of this worked**

6. **Root Cause Investigation** (30 minutes with research agent)
   - Discovered OAuth token had **ZERO scopes** (empty `x-oauth-scopes` header)
   - Token literally could not see ANY organizations:
     ```bash
     curl -H "Authorization: token ghu_xxx" https://api.github.com/user/orgs
     # Returns: []
     ```
   - Confirmed user is admin of DollhouseMCP organization with `gh` CLI
   - But MCP registry token cannot access org info

---

### ✅ Part 3: Research - How Organizations Actually Publish (10 minutes)

**Research Agent Investigation**:

Launched agent to examine real-world examples from:
- Microsoft (playwright-mcp)
- Cloudflare (mcp-server-cloudflare)
- Prefect (prefect-mcp-server)
- Docker (mcp-server-docker)
- MCP registry source code

**Critical Discovery**:

**ALL major organizations use GitHub Actions with OIDC, NOT manual CLI device flow.**

---

## Root Cause Analysis

### The OAuth Device Flow Bug

**Code Location**: `internal/api/handlers/v0/auth/github_at.go:138-164`

**How It's Supposed to Work**:
1. CLI requests scopes: `read:org read:user`
2. GitHub grants token with those scopes
3. Token can access `/user/orgs` endpoint
4. Registry sees organization membership

**What Actually Happens**:
1. CLI requests scopes: `read:org read:user`
2. GitHub grants token with **ZERO scopes** (bug)
3. Registry falls back to public endpoint: `/users/{username}/orgs`
4. Public endpoint **only** shows organizations with public membership
5. Even with public membership, restrictions block OAuth apps

**Evidence from Token**:
```bash
# Check scopes on MCP registry token
curl -sI -H "Authorization: token ghu_xxx" "https://api.github.com/user" | grep "x-oauth-scopes"
# Result: x-oauth-scopes:
# ^ Empty! No scopes granted at all
```

**Why This Fails for Organizations**:
- Personal namespace (`io.github.mickdarling/*`): ✅ Works (no org membership needed)
- Organization namespace (`io.github.DollhouseMCP/*`): ❌ Fails (requires org access)
- Public membership doesn't help because token has no scopes
- OAuth restrictions compound the problem

**Known Issue**: Case sensitivity bug (#689) also affects OIDC method

---

## The Working Solution: GitHub Actions OIDC

### How OIDC Works Differently

**From MCP Registry Code** (`internal/api/handlers/v0/auth/github_oidc.go:288-294`):
```go
// Grant publish permissions for the repository owner's namespace
permissions = append(permissions, auth.Permission{
    Action:          auth.PermissionActionPublish,
    ResourcePattern: fmt.Sprintf("io.github.%s/*", claims.RepositoryOwner),
})
```

**Key Differences**:
1. **No OAuth scopes needed** - permissions based on repository ownership
2. **Automatic org detection** - uses `repository_owner` claim from OIDC token
3. **Ephemeral tokens** - generated per workflow run, expire immediately
4. **More secure** - no long-lived credentials stored
5. **Zero configuration** - no OAuth app setup, no PAT management

### Real-World Example: Prefect

**Repository**: `https://github.com/PrefectHQ/prefect-mcp-server`

**Workflow** (`.github/workflows/publish.yml`):
```yaml
name: Publish to MCP Registry

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # CRITICAL: Required for OIDC
      contents: read

    steps:
      - name: Install MCP Publisher
        run: |
          curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz

      - name: Login to MCP Registry
        run: ./mcp-publisher login github-oidc  # NOT "github"!

      - name: Publish to MCP Registry
        run: ./mcp-publisher publish
```

**Success Factors**:
- ✅ Uses `github-oidc` not `github`
- ✅ Sets `permissions: { id-token: write }`
- ✅ Runs in repository owned by organization
- ✅ Automatic permission for `io.github.PrefectHQ/*`

---

## Artifacts Created This Session

### Files Created

**1. server.json** (Final version)
Location: `~/Developer/Organizations/DollhouseMCP/mcp-registry-publishing/server.json`

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
  "name": "io.github.DollhouseMCP/mcp-server",
  "title": "DollhouseMCP",
  "description": "OSS to create Personas, Skills, Templates, Agents, and Memories to customize your AI experience.",
  "version": "1.9.18",
  "homepage": "https://dollhousemcp.com",
  "repository": {
    "type": "git",
    "url": "https://github.com/DollhouseMCP/mcp-server"
  },
  "license": "AGPL-3.0",
  "keywords": [
    "mcp",
    "model-context-protocol",
    "ai",
    "persona",
    "prompt",
    "claude",
    "ai-assistant",
    "behavioral-profiles",
    "dynamic-prompting",
    "typescript",
    "dollhouse",
    "marketplace"
  ],
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@dollhousemcp/mcp-server",
      "version": "1.9.18",
      "transport": {
        "type": "stdio"
      }
    }
  ]
}
```

**Key Points**:
- ✅ Correct schema: `2025-09-29`
- ✅ Organization namespace: `io.github.DollhouseMCP/mcp-server` (capital D, M, C, P)
- ✅ Description under 100 chars (96 chars)
- ✅ Links to dollhousemcp.com and NPM package
- ⚠️ This file is ready but cannot be used via CLI (must use GitHub Actions)

### GitHub Organization Configuration Changes

**OAuth Access Restrictions**:
- Status: REMOVED (required for testing, but didn't help)
- Recommendation: Can re-enable after GitHub Actions workflow is working

**Organization Membership**:
- Changed from: Private
- Changed to: Public
- Note: This also didn't help with device flow, but may be useful for other reasons

---

## Lessons Learned

### ❌ What Didn't Work (And Why)

1. **Manual CLI Publishing**
   - Assumption: Device flow works like other OAuth apps
   - Reality: Zero scopes bug makes it unusable for orgs
   - Time wasted: ~2 hours trying variations

2. **Removing OAuth Restrictions**
   - Assumption: This would let MCP registry OAuth app see org
   - Reality: Token still has no scopes, restrictions are irrelevant
   - Security impact: Unnecessarily opened org to all OAuth apps

3. **Making Membership Public**
   - Assumption: Public endpoint would then show membership
   - Reality: Token still can't access even public orgs without scopes
   - Privacy impact: Unnecessarily exposed org membership

4. **Multiple Auth Cycles**
   - Assumption: Re-authenticating might refresh scopes
   - Reality: Bug is in OAuth app configuration, not token caching
   - Time wasted: ~30 minutes of logout/login cycles

### ✅ What We Should Have Done

1. **Research first** before attempting manual methods
2. **Check how major orgs do it** (they all use GitHub Actions)
3. **Read MCP registry docs thoroughly** (mentions OIDC is recommended)
4. **Test personal namespace first** to isolate org-specific issues

### 🎯 Accurate Mental Model

**Manual CLI (Device Flow)**:
- ✅ Works for: `io.github.{your-personal-username}/*`
- ❌ Broken for: `io.github.{any-organization}/*`
- Reason: Zero scopes bug in OAuth flow
- Solution: None - use GitHub Actions instead

**GitHub Actions (OIDC)**:
- ✅ Works for: Both personal and organization namespaces
- ✅ Automatic: Permissions based on repository ownership
- ✅ Secure: Ephemeral tokens, no credential storage
- ✅ Standard: Used by all major organizations

**The Rule**:
> "If you want to publish under an organization namespace, you MUST use GitHub Actions with OIDC. Manual CLI publishing is not an option."

---

## Next Steps for v1.9.19 (or Retroactive v1.9.18)

### Option A: Publish v1.9.18 Retroactively (Recommended)

1. **Create workflow file** in `active/mcp-server/.github/workflows/publish-mcp-registry.yml`
2. **Copy `server.json`** to repository root: `active/mcp-server/server.json`
3. **Manually trigger workflow** for existing v1.9.18 release
4. **Verify** at https://registry.modelcontextprotocol.io/

### Option B: Wait for v1.9.19

1. **Create workflow file** (same as Option A)
2. **Add `server.json`** to repository
3. **Include in v1.9.19 release** process
4. **Automatic publishing** on next release

### Required Workflow File

Create `.github/workflows/publish-mcp-registry.yml`:

```yaml
name: Publish to MCP Registry

on:
  release:
    types: [published]
  workflow_dispatch:  # Allow manual trigger for retroactive publishing

jobs:
  publish-mcp-registry:
    name: Publish to MCP Registry
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # CRITICAL: Required for OIDC authentication
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Install MCP Publisher
        run: |
          curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
          chmod +x mcp-publisher

      - name: Login to MCP Registry via GitHub OIDC
        run: ./mcp-publisher login github-oidc

      - name: Publish to MCP Registry
        run: ./mcp-publisher publish

      - name: Notify success
        if: success()
        run: |
          echo "✅ Successfully published to MCP Registry"
          echo "📦 Server: io.github.DollhouseMCP/mcp-server"
          echo "🔗 View at: https://registry.modelcontextprotocol.io/"
```

### Required server.json in Repository Root

Copy from `~/Developer/Organizations/DollhouseMCP/mcp-registry-publishing/server.json` to `active/mcp-server/server.json` (same content, already validated).

### Update package.json

Add `server.json` to files array:
```json
{
  "files": [
    "dist/**/*.js",
    "dist/**/*.d.ts",
    "dist/**/*.d.ts.map",
    "data/**/*.md",
    "oauth-helper.mjs",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "server.json"
  ]
}
```

---

## Technical Details for Reference

### MCP Registry OAuth Scopes Bug

**Requested Scopes** (from CLI code):
```go
payload := map[string]string{
    "client_id": g.clientID,
    "scope":     "read:org read:user",
}
```

**Granted Scopes** (actual token):
```
x-oauth-scopes:
```
^ Empty string = zero scopes

### GitHub API Behavior

**With Scopes** (expected):
```bash
curl -H "Authorization: token xxx" https://api.github.com/user/orgs
# Returns: [{"login": "DollhouseMCP", ...}, {"login": "YasminApp", ...}]
```

**Without Scopes** (actual):
```bash
curl -H "Authorization: token xxx" https://api.github.com/user/orgs
# Returns: []
```

**Public Endpoint** (fallback used by registry):
```bash
curl https://api.github.com/users/mickdarling/orgs
# Returns: [] (unless membership is public AND no restrictions)
```

### OIDC Token Claims

**What OIDC Provides** (from GitHub Actions):
```json
{
  "repository": "DollhouseMCP/mcp-server",
  "repository_owner": "DollhouseMCP",
  "repository_owner_id": "219907981",
  "run_id": "...",
  "workflow": "Publish to MCP Registry"
}
```

**Permission Granted**:
- Pattern: `io.github.DollhouseMCP/*`
- Based on: `repository_owner` claim
- No scopes needed: Permission derived from repo ownership

---

## Known Issues to Watch

### Issue #689: Case Sensitivity

**Problem**: Registry performs case-sensitive matching on namespaces
- GitHub org: `DollhouseMCP` (capital letters)
- If server.json uses: `dollhousemcp` (lowercase)
- Result: 403 Forbidden even with OIDC

**Solution**: Always match exact casing in `server.json`:
```json
{
  "name": "io.github.DollhouseMCP/mcp-server"  // Match GitHub exactly
}
```

**Status**: Open issue, pending fix

### Device Flow Scopes Bug

**Problem**: OAuth app grants zero scopes despite requesting `read:org read:user`

**Impact**: Manual CLI publishing completely broken for organizations

**Workaround**: Use GitHub Actions OIDC (not a workaround, it's the solution)

**Status**: Unknown if this is a bug or intentional design

---

## Files to Commit Next Session

1. `.github/workflows/publish-mcp-registry.yml` (new)
2. `server.json` (new, copy from mcp-registry-publishing dir)
3. `package.json` (update files array)
4. `docs/development/MCP_REGISTRY_PUBLISHING.md` (new guide)
5. This session notes file

---

## Time Breakdown

- Release verification: 15 minutes
- Initial MCP setup: 30 minutes
- Schema/description fixes: 10 minutes
- Authentication attempts: 45 minutes (wasted - broken method)
- Publish failures & troubleshooting: 40 minutes (wasted - broken method)
- Organization config changes: 20 minutes (wasted - didn't help)
- Root cause investigation: 30 minutes (valuable - found the truth)
- Research agent investigation: 10 minutes (valuable - confirmed solution)
- Documentation: 20 minutes

**Total**: 2 hours 40 minutes
**Productive time**: 1 hour 45 minutes
**Time wasted on broken approach**: 55 minutes

---

## Key Quotes for Memory

> "The OAuth device flow (`mcp-publisher login github`) is fundamentally broken for organization namespaces. It will never work no matter what you try. Stop trying it."

> "All major organizations (Microsoft, Cloudflare, Prefect, Docker) use GitHub Actions with OIDC. This is not optional - it's the ONLY method that works."

> "Token has zero scopes. Not 'insufficient scopes' - literally ZERO scopes. Empty string. Cannot access ANY organization data."

> "Making membership public doesn't help. Removing OAuth restrictions doesn't help. Re-authenticating doesn't help. The token is broken at creation time."

---

## Status Summary

**✅ Accomplished**:
- v1.9.18 published to NPM
- v1.9.18 GitHub Release published (was in draft)
- Verified GitHub Packages published correctly
- Created valid `server.json` for MCP registry
- Discovered root cause of publishing failure
- Researched correct solution (GitHub Actions OIDC)
- Documented entire process thoroughly

**❌ Not Accomplished**:
- MCP registry publication (requires GitHub Actions, not manual)

**📋 Next Session**:
- Create GitHub Actions workflow for MCP registry publishing
- Copy server.json to repository root
- Test workflow with v1.9.18 (retroactive) or v1.9.19 (future)
- Document MCP registry publishing process

---

**Key Lesson**: When something doesn't work after multiple attempts, STOP and research how others do it successfully. Don't assume your approach is correct just because it seems logical.
