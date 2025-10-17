# Session Notes - October 15, 2025 (Evening)

**Date**: October 15, 2025
**Time**: 7:00 PM - 7:45 PM (45 minutes)
**Focus**: Capability Index Resources Investigation & Token Cost Analysis
**Outcome**: ✅ Mystery solved, path forward clarified

---

## Session Summary

Investigated user's concern about potential token overhead from experimental capability index resource injection feature. Discovered critical findings about MCP Resources protocol support and clarified actual vs perceived token costs.

**Key Discovery**: User has been running with CapabilityIndexResource.js built on October 3, but it's not actually being used (not hooked up in ServerSetup). MCP clients don't support resources/read yet anyway.

---

## Background Context

User was running from `~/Developer/Organizations/DollhouseMCP/active/mcp-server/dist/index.js` (not NPM install) and noticed they appeared to be using more tokens than expected. They believed they were running an experimental branch with 48K token capability index auto-injection.

**Initial Questions**:
1. What's the token cost difference between experimental branch and develop/main?
2. Is the capability index being auto-injected?
3. Should we ship the Resources feature?

---

## Investigation Process

### Step 1: Identify What's Actually Running

**Finding**: Multiple DollhouseMCP processes running from development directory:
```bash
ps aux | grep dollhouse
# Shows 19 processes running from:
# /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/dist/index.js
```

**Not** running from NPM install (`~/.dollhouse/claudecode-production/`) as initially assumed.

### Step 2: Check Branch Status

**Finding**: User is on `develop` branch, not experimental branch:
```bash
git branch --show-current
# Output: develop
```

**But**: Found `experiment/capability-index-resource-injection` branch exists locally (never pushed to GitHub)

### Step 3: Search for Resources Code

**Finding**: CapabilityIndexResource exists in `dist/` but not in source:

```bash
ls -la dist/server/resources/
# -rw-r--r--  CapabilityIndexResource.js (21,466 bytes, Oct 3 11:55)
# -rw-r--r--  CapabilityIndexResource.d.ts
# -rw-r--r--  CapabilityIndexResource.d.ts.map
```

**But**:
```bash
ls -la src/server/resources/
# Directory does not exist in working tree

git show experiment/capability-index-resource-injection:src/server/resources/CapabilityIndexResource.ts
# File does not exist on branch
```

**Conclusion**: TypeScript source was created on October 3, built to dist/, but **never committed to git**. Source file was subsequently deleted/lost.

### Step 4: Check If Resources Are Hooked Up

**Finding**: Resources code exists but is NOT registered:

```bash
grep "CapabilityIndexResource" dist/server/ServerSetup.js
# (no results)

grep "resources/" dist/index.js
# (no results)
```

**Conclusion**: The compiled JavaScript exists in dist/ but is **dormant** - never hooked up in server initialization.

### Step 5: Measure Actual Token Usage

User tested with Claude Code's token counter:

**Test 1: Without DollhouseMCP**
- Base Claude Code: 36,695 tokens

**Test 2: With DollhouseMCP**
- Claude Code + DollhouseMCP: ~60,000 tokens
- **DollhouseMCP overhead**: ~24,000 tokens

**Test 3: Context inspection**
- MCP tools: ~24,000 tokens
- This is from **tool descriptions only**, not capability index data

**Conclusion**: User is experiencing normal MCP tool overhead (~24K), NOT 48K capability index injection.

---

## Key Findings

### Finding 1: Resources Code Never Committed

**What happened**:
1. ✅ User created `src/server/resources/CapabilityIndexResource.ts` on October 3, 2025
2. ✅ Built it → `dist/server/resources/CapabilityIndexResource.js` (still exists)
3. ❌ **Never committed the TypeScript source to git** (intentionally - safety concern)
4. ❌ Never hooked up in ServerSetup.ts or index.ts
5. ❌ Source file was deleted/lost at some point
6. ✅ The compiled JS is still in dist/ folder (dormant)

**User's reasoning for not committing**: Legitimate safety concern about accidentally merging code that could impose 30-40K token overhead on all users.

### Finding 2: MCP Resources Protocol Status

From user's October 3, 2025 memory (`session-2025-10-03-morning-capability-index-resource-experiment-complete`):

**✅ Protocol Level**: WORKS PERFECTLY
- Server advertises resources capability
- Clients call `resources/list` successfully
- Server returns all 3 resources correctly
- Full MCP protocol compliance verified

**❌ Client Level**: NOT IMPLEMENTED YET
- **Claude Desktop**: Discovers resources, never reads them
- **Claude Code 2.0.5**: Discovers resources, never reads them
- **Gemini CLI**: GitHub Issue #3816 confirms resources not supported (July 2025)

**Pattern Observed**:
```
Client connects → resources/list called → resources returned
[CLIENTS STOP HERE - NEVER CALL resources/read]
```

**Root Cause**: MCP Resources is a Phase 2 protocol feature. Tools are Phase 1 (mature, widely supported). Servers are implementing resources, but clients haven't caught up yet.

### Finding 3: Token Cost Reality

| Version | Resources Code | Actual Token Cost |
|---------|----------------|-------------------|
| v1.9.14 NPM | ❌ Not present | ~24K (tools only) |
| Experimental branch source | ❌ Not committed | ~24K (tools only) |
| User's running dist/ | ✅ Built but dormant | ~24K (tools only) |
| Develop/main | ❌ Not present | ~24K (tools only) |

**All versions have identical token cost** because:
1. Resources code in dist/ is not hooked up
2. Even if hooked up, clients don't call resources/read yet
3. Only tool descriptions consume tokens (~24K)

### Finding 4: What Resources Would Do (If Activated)

The CapabilityIndexResource.js in dist/ implements 3 resource variants:

1. **Summary**: `dollhouse://capability-index/summary`
   - Contains: metadata + action_triggers only
   - Actual measured: 1,254 tokens (not the 2.5-3.5K estimated)
   - Use case: Lightweight verb → element mappings

2. **Full**: `dollhouse://capability-index/full`
   - Contains: Complete index with all elements, relationships, semantic data
   - Actual measured: 48,306 tokens
   - Use case: Large context models (500K-4M tokens)

3. **Stats**: `dollhouse://capability-index/stats`
   - Contains: JSON measurement data
   - Size: Small (<100 tokens)
   - Use case: Debugging and monitoring

### Finding 5: The Risk User Was Right to Worry About

**Legitimate concern**: If MCP clients update to support resources/read, they might:

❌ **Naive implementation**: Auto-inject ALL discovered resources
- User's server advertises 3 resources
- Client auto-injects all 3: 1,254 + 48,306 + ~50 = **49,610 tokens**
- Users experience massive context consumption without opting in

✅ **Smart implementation**: User configuration or LLM-driven selection
- Let users configure which resources to load
- Let LLM request specific resources when needed
- Use context-aware auto-selection based on descriptions

**Current risk**: ZERO (clients don't support resources yet)

**Future risk**: HIGH (if clients naively auto-inject everything)

---

## The Solution: Configuration-Controlled Resources

**Recommendation**: Implement Resources with configuration controls BEFORE client support arrives.

### Proposed Configuration Schema

```typescript
// In ~/.dollhouse/config.json or similar
{
  "capability_index": {
    "advertise_resources": false,  // Default: don't advertise any resources
    "variants": {
      "summary": false,  // Opt-in: 1,254 token summary variant
      "full": false      // Opt-in: 48,306 token full variant
    }
  }
}
```

### Behavior Matrix

| Configuration | Resources Advertised | Client Behavior (when supported) |
|---------------|---------------------|----------------------------------|
| Default (all false) | None | No resources available |
| summary: true | Summary only | Client can read 1,254 token summary |
| full: true | Full only | Client can read 48,306 token full index |
| Both true | Both | Client can choose (or both if naive) |

### Protection Strategy

**Default behavior**:
- `advertise_resources: false` → Server never advertises resources in `resources/list`
- Zero risk of surprise token consumption
- Explicit opt-in required

**Power user opt-in**:
- `summary: true` → 1,254 tokens for smart tool selection
- Reasonable overhead for 200K+ context models

**Large context opt-in**:
- `full: true` → 48,306 tokens for comprehensive index
- Negligible overhead for 1M+ context models (4.8%)
- Essentially free for Gemini's 4M context (1.2%)

### Finding 6: Experimental Branch Investigation

**Branch checked**: `experiment/capability-index-resource-injection`

**Status**: Exists locally at commit `fdc4264b` (v1.9.15 base, 76 commits behind develop)

**Critical Discovery**: The CapabilityIndexResource.ts source file exists NOWHERE in git:
- ❌ Not on experimental branch
- ❌ Not on develop branch
- ❌ Not on main branch
- ❌ Not in any stash
- ✅ **Only exists as compiled JavaScript** in `dist/server/resources/CapabilityIndexResource.js` (21,466 bytes, Oct 3 11:55 AM)

**Why this matters**: The TypeScript source was created on October 3, built to dist/, but never committed to git (intentionally - user's safety concern about token overhead). The source file was subsequently deleted or lost. The only remaining artifact is the compiled JavaScript that persists in the gitignored dist/ folder across branch switches.

**Action required**: Reverse-engineer the JavaScript back to TypeScript ASAP to preserve this work and understand what the original implementation was doing.

---

## Code Recovery Plan

### What Needs to Be Done

1. **Recover TypeScript source** from compiled JavaScript in dist/
   - Reverse-engineer `dist/server/resources/CapabilityIndexResource.js`
   - Recreate `src/server/resources/CapabilityIndexResource.ts`
   - Add proper TypeScript types and interfaces

2. **Add configuration support**
   - Create configuration schema in ConfigManager
   - Add validation and defaults
   - Document configuration options

3. **Add server registration** (conditional on config)
   - Hook up in `src/index.ts` (add resources capability)
   - Hook up in `src/server/ServerSetup.ts` (register handlers)
   - Only register if config.capability_index.advertise_resources === true

4. **Add tests**
   - Unit tests for CapabilityIndexResource
   - Integration tests for configuration
   - Test all three variants (summary, full, stats)

5. **Documentation**
   - Add configuration guide
   - Add opt-in instructions for power users
   - Document token costs and use cases

6. **Commit properly**
   - Create feature branch: `feature/mcp-resources-capability-index`
   - Commit with comprehensive documentation
   - PR with detailed explanation and safety measures

### Files to Create/Modify

**New files**:
- `src/server/resources/CapabilityIndexResource.ts` (recovered from .js)
- `src/config/schemas/CapabilityIndexConfig.ts` (configuration schema)
- `test/__tests__/unit/server/resources/CapabilityIndexResource.test.ts`

**Modified files**:
- `src/index.ts` (add resources capability conditionally)
- `src/server/ServerSetup.ts` (register resource handlers conditionally)
- `src/config/ConfigManager.ts` (add capability_index section)
- `docs/CONFIGURATION.md` (document new config options)

---

## Branch Status Summary

### experiment/capability-index-resource-injection

**Status**: Exists locally, never pushed to GitHub

**Commit**: `fdc4264b` (based on v1.9.15, 76 commits behind develop)

**Contents**:
- NO Resources code in git history
- Only documentation and regular development changes
- Resources code was built locally but never committed

**Value beyond Resources code**: None - all other changes already merged to develop

**Recommendation**: Abandon this branch, create fresh feature branch from current develop

---

## Statistics

**Session Duration**: ~45 minutes
**Mystery Solved**: Token overhead source identified
**Code Recovered**: CapabilityIndexResource.js found in dist/
**Source Lost**: TypeScript never committed, subsequently deleted
**Risk Assessed**: User's caution was correct - naive client implementation could impose 49K tokens
**Solution Designed**: Configuration-controlled resource advertising with safe defaults

---

## Next Session Priorities

1. **PRIORITY: Recover and analyze original source code**
   - Reverse-engineer `dist/server/resources/CapabilityIndexResource.js` back to TypeScript
   - Document what the original implementation was doing
   - Understand the three resource variants (summary, full, stats)
   - Analyze the MCP Resources protocol implementation
   - Preserve this work before it's lost permanently

2. **Implement configuration**
   - Add schema to ConfigManager
   - Add validation and defaults
   - Test configuration loading

3. **Add conditional registration**
   - Hook up in ServerSetup only if enabled
   - Add resources capability to server only if enabled
   - Verify resources are NOT advertised by default

4. **Write tests**
   - Unit tests for resource generation
   - Integration tests for configuration
   - Test default behavior (no resources)

5. **Document thoroughly**
   - Configuration guide
   - Token cost analysis
   - Opt-in instructions
   - Safety guarantees

6. **Create PR**
   - Feature branch from current develop
   - Comprehensive PR description
   - Emphasize safety defaults

---

## Key Learnings

1. **User's caution was warranted**: Legitimate risk of imposing token overhead on users if clients naively auto-inject resources

2. **Current risk is zero**: Resources code exists but:
   - Not hooked up (dormant in dist/)
   - Clients don't support resources/read yet anyway

3. **Future-proofing is valuable**: Getting ahead of client support with configuration controls prevents problems later

4. **Configuration is essential**: Never auto-enable features that consume user resources (tokens, bandwidth, storage)

5. **Git is important**: Uncommitted code is easily lost - even compiled artifacts can stick around after source is deleted

6. **Tool overhead is normal**: ~24K tokens for 47 MCP tools is standard overhead, not excessive

---

## Related Documentation

- Memory: `session-2025-10-03-morning-capability-index-resource-experiment-complete` (October 3 experiment results)
- Session Notes: `SESSION_NOTES_2025-10-15-EVENING-SECURITY-AUDIT-FIXES.md` (earlier session today)
- Session Notes: `SESSION_NOTES_2025-10-15-EVENING-SONARCLOUD-FIXES.md` (earlier session today)

---

**Status**: Investigation complete, recovery plan documented, ready for implementation next session
