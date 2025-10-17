# Session Notes - October 15, 2025 (Afternoon)

**Date**: October 15, 2025
**Time**: ~2:00 PM - ~3:30 PM (90 minutes)
**Focus**: Telemetry research, GitHub issue templates for AI agents, issue management
**Outcome**: ✅ PR merged, templates created, critical learnings about scope and focus

## Session Summary

Started with VS Code crash recovery after parallel agent work on PR #1351. Successfully merged PR, created follow-up issues, researched operational telemetry, and created comprehensive GitHub issue templates for AI agents. Key learning: removing time estimates doesn't make an epic into a focused issue - need to fundamentally reduce scope.

## Work Completed

### 1. PR #1351 Merge
- **PR**: Add MCP Registry submission preparation files
- **Status**: Merged to develop (commit: 3e9c3f48)
- **Files**: server.json, MCP_REGISTRY_SUBMISSION_GUIDE.md, package.json
- **CI**: All 14/14 checks passed
- **Grade**: A (9.5/10) from code review

### 2. Follow-up Issues Created from PR Review
Created issues for three minor suggestions:

- **Issue #1353**: Add CI validation for version sync between server.json and package.json
  - Label: enhancement
  - Ensures versions stay synchronized

- **Issue #1354**: Add npm script for server.json schema validation
  - Label: enhancement
  - Updated with correct `ajv` implementation (not non-existent `@modelcontextprotocol/schema-validator`)

- **Issue #1355**: Add quick-start section to MCP Registry submission guide
  - Label: documentation
  - Kept as canonical (closed #1352 as duplicate)

- **Issue #1356**: CLOSED - Test coverage for MCP Registry
  - Reason: Not actually requested by reviewer
  - Reviewer said tests "appropriately omitted" (metadata files)

### 3. Operational Telemetry Research

**Critical Discovery**: Learned correct terminology and approach.

**What We Want**: **Operational Telemetry**
- Installation counts, OS distribution, crash reports
- NOT tool usage, NOT conversations, NOT user content
- Industry standard: VS Code, npm CLI, Homebrew all do this

**Key Insights**:
- MCP servers have NO way to prompt users (no UI, no terminal access)
- Traditional first-run prompts don't work
- Official Anthropic MCP servers DON'T collect telemetry
- Anthropic's MCP Directory Policy DISCOURAGES telemetry
- BUT Claude Code (the host) does collect operational telemetry via Statsig/Sentry

**Approach**:
- Opt-out (not opt-in) for minimal operational data
- Easy disable: `DOLLHOUSE_TELEMETRY=false`
- Local-only initially (events stored in log file)
- Server infrastructure separate

**Document Created**: `docs/investigation/TELEMETRY_BEST_PRACTICES_AND_RECOMMENDATIONS.md` (48KB)

### 4. GitHub Issue Templates for AI Agents

Created four comprehensive templates for AI agents (NOT humans):

**Created Templates**:
1. **github-issue-creation** (updated) - Features/enhancements
2. **github-issue-bug-report** (new) - Bug reports with reproduction steps
3. **github-issue-documentation** (new) - Documentation improvements
4. **github-issue-security** (new) - Security vulnerabilities

**Key Features**:
- ✅ Designed for AI agents (verbosity is intentional)
- ✅ Real repository labels (40+ actual labels included)
- ✅ Phase-based planning (NO time estimates enforced)
- ✅ Heredoc fixes (proper `'EOF'` quoting)
- ✅ Simple issue escape hatches (typos, small changes)
- ✅ Cross-references between templates
- ✅ Comprehensive trigger keywords

**Expert Review**: A- (92/100) overall
- Up from B+ (87/100) when reframed for AI agents
- "Formatting bug" flagged (newlines missing) but NOT a problem for AI agents
- Known DollhouseMCP limitation (only memories render properly)
- AI agents parse content fine without visual formatting

### 5. Issue #1357 - Operational Telemetry Epic

**Created**: Issue #1357 - Add operational telemetry for installation and usage metrics
- Label: enhancement, priority: high, area: performance
- **Updated** to match template standards:
  - ✅ Removed ALL time estimates
  - ✅ Added "Out of Scope" section
  - ✅ Converted "Success Metrics" to "Success Criteria" with checkboxes
  - ✅ Enhanced implementation plan with dependencies

### 6. Issue #1358 - Client-Side Telemetry (PROBLEM IDENTIFIED)

**Created**: Issue #1358 - Implement client-side operational telemetry for v1.9.19
- Label: enhancement, priority: high, area: performance, privacy
- **ISSUE**: Still too big (epic-sized, not focused)
- **PROBLEMS**:
  - 5 phases, ~35 checkboxes
  - Too prescriptive about implementation details
  - References `src/index.ts` (we're trying to keep that minimal!)
  - Not actually "next release" sized
- **LEARNING**: Removing time estimates doesn't make an epic smaller - need to fundamentally reduce scope

## Key Learnings

### 1. Operational vs Behavioral Telemetry

**Operational Telemetry** (what we want):
- Installation counts
- OS/platform distribution
- MCP client usage (Claude Desktop vs Code vs VS Code)
- Crash reports (sanitized, no PII)
- Heartbeats (server running)

**Behavioral Telemetry** (what we DON'T want):
- Tool usage
- Conversation data
- User content (personas, skills, etc.)
- Detailed logs

### 2. MCP Protocol Limitations for User Interaction

**Cannot do in MCP servers**:
- Terminal prompts (no user interaction)
- Dialog boxes (background process)
- First-run consent flows (traditional approach doesn't work)

**Must do instead**:
- Opt-out by default (industry standard for minimal operational data)
- Clear documentation
- Easy disable methods
- Local transparency (log file users can inspect)

### 3. Templates for AI Agents vs Humans

**For AI Agents**:
- ✅ Verbosity is GOOD (more guidance)
- ✅ Repetition is GOOD (reinforces rules)
- ✅ Length is NOT a problem (AI processes long context)
- ✅ Specificity matters more than brevity

**For Humans**:
- ❌ Verbosity is BAD (overwhelming)
- ❌ Repetition is BAD (annoying)
- ❌ Length is a PROBLEM (won't read)
- ❌ Brevity matters

**Formatting**: Newlines missing in DollhouseMCP templates (known issue), but AI agents don't care - they parse structure fine.

### 4. Issue Scope and Focus (CRITICAL LEARNING)

**The Problem**:
- Can follow template structure perfectly
- Can remove all time estimates correctly
- Can create detailed phases
- BUT still create epic-sized issues

**The Mistake**:
- "Break into phases" ≠ "make detailed phases"
- "Break into phases" = "make the WHOLE THING smaller"
- Removing "Week 1, Week 2" doesn't shrink scope
- Just makes timeline ambiguous, not focused

**What "Next Release" Actually Means**:
- Small, focused, shippable
- Maybe 1-2 phases max
- Maybe 5-10 checkboxes total
- NOT 35 checkboxes across 5 phases

**Example of Too Big** (Issue #1358):
```markdown
### Phase 1: Core Telemetry Class
- [ ] 6 tasks...

### Phase 2: Event Generation
- [ ] 7 tasks...

### Phase 3: Opt-Out Mechanisms
- [ ] 6 tasks...

### Phase 4: Integration and Testing
- [ ] 9 tasks...

### Phase 5: Documentation
- [ ] 6 tasks...
```
Total: 34 tasks = EPIC-SIZED

**What "Focused" Should Look Like**:
```markdown
### Phase 1: Minimal Viable Telemetry
- [ ] Generate UUID on first run
- [ ] Write install event to local file
- [ ] Respect DOLLHOUSE_TELEMETRY=false
- [ ] Add README section with opt-out instructions

### Phase 2: Testing
- [ ] Test UUID generation
- [ ] Test opt-out works
- [ ] Test on macOS/Windows/Linux
```
Total: 7 tasks = FOCUSED

### 5. Implementation Details vs Requirements

**Too Prescriptive** (Issue #1358):
- "Create `src/telemetry/OperationalTelemetry.ts`"
- "Integrate into src/index.ts"
- Dictating file structure without codebase context

**Better Approach**:
- "Implement telemetry client that generates UUID and tracks install events"
- Let implementer decide file structure
- Let implementer decide integration point
- Provide requirements, not architecture

**Why This Matters**:
- We don't know if `src/telemetry/` is the right place
- We don't know if index.ts is the right integration point
- User explicitly said "trying to keep index.ts minimal"
- Making assumptions about architecture we don't understand

## Next Session Priorities

### 1. Fix Issue #1358 Scope (CRITICAL)
- Reduce to truly focused, shippable work
- Remove prescriptive implementation details
- Maybe just: generate UUID, log event, respect opt-out
- Consider splitting into even smaller issues

### 2. Update Issue Templates with Scope Guidance
- Add section: "Is This Too Big?" decision tree
- Add examples of epic-sized vs focused
- Emphasize: phases don't make epics focused
- Add: "If >20 checkboxes, probably too big"

### 3. Create Server Infrastructure Issue (If Needed)
- Separate from client implementation
- Much later timeline
- Not blocking v1.9.19

## Files Modified

**Created**:
- `docs/investigation/TELEMETRY_BEST_PRACTICES_AND_RECOMMENDATIONS.md` (48KB)
- DollhouseMCP templates:
  - `github-issue-creation` (updated)
  - `github-issue-bug-report` (new)
  - `github-issue-documentation` (new)
  - `github-issue-security` (new)

**Updated**:
- Issue #1357 body (removed time estimates, added structure)

**Issues Created**:
- #1353 - CI validation for version sync
- #1354 - Schema validation npm script
- #1355 - Quick-start section for guide
- #1357 - Operational telemetry (epic)
- #1358 - Client-side telemetry (TOO BIG - needs revision)

**Issues Closed**:
- #1352 - Duplicate of #1355
- #1356 - Not actually requested

**PRs Merged**:
- #1351 - MCP Registry submission preparation

## Technical Debt / Issues Identified

1. **Issue #1358 scope too large** - Needs to be broken down or completely rewritten
2. **Templates need scope guidance** - Should help AI agents determine if issue is too big
3. **Implementation prescriptiveness** - Templates may encourage too much detail about "how" vs "what"

## Metrics

- **Session Duration**: ~90 minutes
- **PRs Merged**: 1 (#1351)
- **Issues Created**: 5 (#1353-1357, #1358)
- **Issues Closed**: 2 (#1352, #1356)
- **Templates Created**: 4 (bug, docs, security, updated feature)
- **Documents Created**: 1 (TELEMETRY_BEST_PRACTICES_AND_RECOMMENDATIONS.md)
- **Context Used**: ~138K tokens of 200K available

## Session Patterns Observed

### Positive
- ✅ Parallel agent work completed successfully (no crashes this time)
- ✅ Template structure naturally internalized
- ✅ Following core rules (no time estimates)
- ✅ Comprehensive documentation

### Negative
- ❌ Created epic-sized issue while trying to be focused
- ❌ Too prescriptive about implementation details
- ❌ Made assumptions about codebase structure
- ❌ "Perfect documentation but wrong scope" pattern

### Pattern to Break
**Following template structure ≠ Creating focused issues**
- Can have perfect sections, perfect format, perfect examples
- But still create too much work
- Need to focus on SCOPE reduction, not just structure adherence

## Questions for Next Session

1. How do we help AI agents (and humans) determine if an issue is epic-sized vs focused?
2. Should templates include decision trees for scope?
3. How do we balance "comprehensive guidance" with "don't be prescriptive about implementation"?
4. What does "next release" actually mean in terms of task count?

## References

- PR #1351: https://github.com/DollhouseMCP/mcp-server/pull/1351
- Issue #1357: https://github.com/DollhouseMCP/mcp-server/issues/1357
- Issue #1358: https://github.com/DollhouseMCP/mcp-server/issues/1358 (needs revision)
- Expert review score: A- (92/100) for template suite

---

**Key Takeaway**: Removing time estimates and following template structure are necessary but not sufficient for focused issues. Must fundamentally reduce scope and avoid prescriptive implementation details. Issue #1358 demonstrates this lesson - perfect format, wrong size.

**Status**: Session incomplete - issue #1358 needs revision, but out of context. Next session should start with scope reduction exercise.
