# SonarCloud Issue #1224 Startup Guide
**Miscellaneous MEDIUM Severity Issues (Investigation Required)**

**Created**: October 1, 2025
**Based on**: Issue #1221 session learnings
**Estimated Time**: 30-45 minutes (investigation-heavy)
**Expected Impact**: 146 → 142 issues (-4 issues, cleanup work)

---

## 🎯 Quick Start Commands

### Step 1: Branch Check & Setup
```bash
# Verify current location
pwd
# Expected: /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server

# Check current branch
git branch --show-current
# Options: Stay on current feature branch OR create new one

# If creating new branch (ask user first):
# git checkout develop && git pull
# git checkout -b feature/sonarcloud-medium-severity-cleanup

# Check git status
git status -sb
```

### Step 2: Activate Dollhouse Elements
```bash
# CRITICAL PERSONAS (Load both!)
mcp__dollhousemcp-production__activate_element --name sonar-guardian --type personas
mcp__dollhousemcp-production__activate_element --name alex-sterling --type personas

# CRITICAL MEMORIES
mcp__dollhousemcp-production__activate_element --name sonarcloud-query-procedure --type memories
mcp__dollhousemcp-production__activate_element --name sonarcloud-rules-reference --type memories
mcp__dollhousemcp-production__activate_element --name sonarcloud-api-reference --type memories

# Note: sonarcloud-modernizer skill NOT needed (no automated fixes)
```

### Step 3: Read Issue #1224
```bash
gh issue view 1224
```

---

## 📋 Issue #1224 Overview

**Type**: Mixed bag - requires case-by-case investigation
**Count**: 4 issues across 3 rules
**Severity**: MEDIUM (Code Smells)
**Approach**: Investigate → Understand → Fix individually

### Rules to Address

**1. typescript:S7737** (1 issue)
- Title: TBD (need to query)
- Category: TypeScript modernization
- Approach: Investigate context

**2. typescript:S2310 + javascript:S2310** (2 issues)
- Title: TBD (need to query)
- Category: Loop condition issues
- Approach: Investigate each instance

**3. typescript:S6671** (1 issue)
- Title: TBD (need to query)
- Category: TypeScript improvement
- Approach: Investigate context

### Why Investigation Required

Unlike Issue #1220 (automated bulk fixes), these issues:
- Are scattered across different rule types
- May have project-specific context
- Could be false positives
- Require understanding intent before fixing

---

## 🔍 Step-by-Step Workflow

### Phase 1: Information Gathering (10-15 minutes)

#### Query Each Rule Separately
```bash
# Rule S7737 (1 issue)
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S7737 \
  --types CODE_SMELL \
  --output_mode content \
  -n true

# Rule S2310 - TypeScript (1 issue)
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S2310 \
  --types CODE_SMELL \
  --output_mode content \
  -n true

# Rule S2310 - JavaScript (1 issue)
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules javascript:S2310 \
  --types CODE_SMELL \
  --output_mode content \
  -n true

# Rule S6671 (1 issue)
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S6671 \
  --types CODE_SMELL \
  --output_mode content \
  -n true
```

#### Document Each Issue
For each issue found, note:
- **File**: Where is it?
- **Line**: Exact location
- **Message**: What's the complaint?
- **Context**: Read the surrounding code
- **Intent**: What's the code trying to do?

**Template**:
```markdown
### Issue 1: S7737
- **File**: path/to/file.ts:123
- **Message**: "..."
- **Context**: [Brief explanation]
- **Fix Strategy**: [Approach]
- **Estimated Time**: X minutes
```

### Phase 2: Read SonarCloud Rule Documentation (5 minutes)

For each rule, understand the rationale:

```bash
# Open browser to rule documentation
open "https://rules.sonarsource.com/typescript/RSPEC-7737"
open "https://rules.sonarsource.com/typescript/RSPEC-2310"
open "https://rules.sonarsource.com/javascript/RSPEC-2310"
open "https://rules.sonarsource.com/typescript/RSPEC-6671"
```

**Questions to ask**:
1. Why does SonarCloud flag this?
2. What's the recommended fix?
3. Are there valid exceptions?
4. Could this be a false positive?

### Phase 3: Fix Each Issue (15-20 minutes)

#### Issue-by-Issue Approach
```bash
# For EACH issue:

# 1. Read the file
Read <file_path>

# 2. Understand the context (read 10-20 lines around the issue)

# 3. Determine fix approach:
#    Option A: Code fix (modify the code)
#    Option B: False positive (mark in SonarCloud)
#    Option C: Won't fix (mark with justification)

# 4. Apply fix

# 5. Test immediately
npm run build
npm test

# 6. Commit if successful
git add <file>
git commit -m "fix(sonarcloud): [Rule ID] Brief description

Fixes issue in <file>

Fixes #1224"
```

#### False Positive Marking (if needed)
```bash
# If an issue is a false positive, use curl (MCP tools are broken!)
curl -X POST "https://sonarcloud.io/api/issues/do_transition" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" \
  -d "issue=<issue_key>" \
  -d "transition=falsepositive"

curl -X POST "https://sonarcloud.io/api/issues/add_comment" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" \
  -d "issue=<issue_key>" \
  -d "text=FALSE POSITIVE: [Explanation why]. Reviewed in Issue #1224."
```

### Phase 4: Verification (5 minutes)

#### After All Fixes Applied
```bash
# Build verification
npm run build
# MUST succeed

# Test verification
npm test
# MUST pass all tests

# Re-query all rules to confirm zero issues
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S7737,typescript:S2310,javascript:S2310,typescript:S6671 \
  --types CODE_SMELL \
  --output_mode count

# Expected: "total": 0 or very close
```

### Phase 5: Documentation & Closing (5 minutes)

#### Update GitHub Issue
```bash
gh issue comment 1224 --body "✅ **Issue #1224 Complete**

All 4 MEDIUM severity issues resolved:

**S7737 (1 issue)**: [Brief description of what was done]
**S2310 (2 issues)**: [Brief description]
**S6671 (1 issue)**: [Brief description]

**Fixes Applied**:
- [File 1]: [What changed]
- [File 2]: [What changed]
- etc.

**Verification**:
- ✅ Build passed: \`npm run build\`
- ✅ Tests passed: \`npm test\`
- ✅ SonarCloud verified: 0 remaining issues for these rules

**Impact**: 146 → 142 total issues (-4, 2.7% reduction)
**Time**: XX minutes (estimated 30-45 minutes)"
```

#### Close Issue
```bash
gh issue close 1224 --comment "Task completed successfully. All MEDIUM severity miscellaneous issues resolved."
```

---

## ⚠️ CRITICAL WARNINGS

### Known MCP Tool Issue
**The SonarCloud MCP marking tools are BROKEN!**

```bash
# ❌ DON'T USE - Will fail
mcp__sonarqube__markIssueFalsePositive --issue_key "KEY" --comment "..."

# ✅ DO USE - Works
curl -X POST "https://sonarcloud.io/api/issues/do_transition" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" \
  -d "issue=<issue_key>" \
  -d "transition=falsepositive"
```

See `sonarcloud-api-reference` memory for full details.

### Investigation Pitfalls

#### 1. Don't Rush to Fix
- Read the code thoroughly first
- Understand the intent before changing
- Consider if the pattern is intentional

#### 2. Check Issue Age
```bash
# If creationDate is old (months ago), it's pre-existing
# You may want to mark as "Won't Fix" with reason rather than fix
```

#### 3. Test After EACH Fix
```bash
# Don't accumulate multiple fixes without testing
# One broken fix can make debugging harder
```

#### 4. Document Rationale
```bash
# If marking as false positive or won't fix, explain WHY
# Future Claude (or you) needs to understand the decision
```

---

## 📊 Success Criteria

### Must Have
- [ ] All 4 issues queried and understood
- [ ] Fix strategy determined for each
- [ ] Fixes applied (or marked as false positive/won't fix)
- [ ] `npm run build` succeeds
- [ ] `npm test` passes (all tests green)
- [ ] SonarCloud shows 0 issues for these rules
- [ ] Git commits created with clear messages
- [ ] GitHub Issue #1224 updated and closed

### Should Have
- [ ] Total issue count: 146 → ~142
- [ ] Each fix has rationale documented (in commit or SonarCloud comment)
- [ ] No unintended side effects
- [ ] Code changes reviewed for correctness

---

## 🔧 Common Rule Patterns

### S2310: Loop Conditions
**Common issue**: Loop variables that are never updated

**Example**:
```typescript
// Problem
let i = 0;
while (i < 10) {
  console.log('Infinite loop!');
  // Missing: i++
}

// Fix
let i = 0;
while (i < 10) {
  console.log('Fixed!');
  i++;
}
```

**Could be false positive if**:
- Loop is intentionally controlled by other means
- External condition breaks the loop
- Code is test/mock code

### S7737: TypeScript Modernization
**Look for**: Outdated TypeScript patterns

**Common fixes**:
- Use optional chaining (`?.`)
- Use nullish coalescing (`??`)
- Modern type assertions
- Template literals

### S6671: TypeScript Best Practices
**Look for**: TypeScript-specific improvements

**Common issues**:
- Unnecessary type assertions
- Redundant types
- Better type definitions available

---

## 📈 Expected Metrics

### Before (from Issue #1220 completion)
- Total issues: 146
- MEDIUM severity misc: 4
- Time estimate: 30-45 min

### After (Issue #1224 completion)
- Total issues: ~142
- MEDIUM severity misc: 0
- Actual time: Document in issue comment
- Reduction: 2.7% of remaining issues

---

## 📚 Reference Documentation

### Must Read (in order)
1. GitHub Issue #1224 - Task details (gh issue view 1224)
2. `docs/development/SONARCLOUD_QUERY_PROCEDURE.md` - Query correctly
3. SonarCloud rule pages (links above)

### Reference As Needed
- `docs/development/SESSION_NOTES_2025-10-01-AFTERNOON-ISSUE-1221.md` - Previous learnings
- `sonarcloud-api-reference` memory - API workarounds
- `sonarcloud-rules-reference` memory - Quick rule lookups

---

## 🎯 Quick Sanity Checks

Before starting:
- [ ] In correct directory: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server`
- [ ] Git status known (clean or on expected branch)
- [ ] `SONARQUBE_TOKEN` environment variable set
- [ ] Dollhouse elements activated (sonar-guardian, alex-sterling, memories)

During work:
- [ ] Each issue queried and documented
- [ ] Context understood before fixing
- [ ] Tests pass after each fix
- [ ] No unintended changes in git diff

After completion:
- [ ] Zero issues for S7737, S2310, S6671
- [ ] All tests passing
- [ ] Issue #1224 closed with summary
- [ ] Rationale documented for all decisions

---

## 💡 Pro Tips

### From Issue #1221 Experience

1. **Test MCP tools first** - If marking false positives, test with one issue before bulk operations

2. **Document as you go** - Write down findings immediately, don't rely on memory

3. **Commit incrementally** - One fix per commit makes rollback easier if needed

4. **Add 50% time buffer** - 30 min estimate → plan for 45 min realistic

5. **Ask if unsure** - Better to ask user about intent than make wrong assumption

6. **Review git diff** - Always check what actually changed before committing

### Investigation-Specific Tips

1. **Read surrounding code** - Don't just look at the flagged line

2. **Check git history** - `git log -p <file>` shows why code was written that way

3. **Search for patterns** - `grep -r "similar_pattern" src/` finds related code

4. **Consider test code differently** - Tests may intentionally violate rules

5. **When in doubt, ask** - Mark as false positive with explanation is better than wrong fix

---

## 🚀 Ready to Start?

```bash
# Copy-paste this entire block to begin:

echo "🎯 Starting Issue #1224 - Miscellaneous MEDIUM Severity"
echo ""
echo "Step 1: Location check"
pwd

echo ""
echo "Step 2: Branch check"
git branch --show-current
git status -sb

echo ""
echo "Step 3: Activate Dollhouse elements"
echo "(Run the activation commands manually from the Quick Start section above)"

echo ""
echo "Step 4: Query first rule (S7737)"
echo "(Run the first query from Phase 1 above)"

echo ""
echo "✅ Ready to investigate!"
```

---

## 📝 Investigation Notes Template

Use this to track your progress:

```markdown
# Issue #1224 Investigation

## S7737 (1 issue)
- **File**:
- **Line**:
- **Message**:
- **Context**:
- **Decision**: [ ] Fix [ ] False Positive [ ] Won't Fix
- **Rationale**:
- **Status**:

## S2310 TypeScript (1 issue)
- **File**:
- **Line**:
- **Message**:
- **Context**:
- **Decision**: [ ] Fix [ ] False Positive [ ] Won't Fix
- **Rationale**:
- **Status**:

## S2310 JavaScript (1 issue)
- **File**:
- **Line**:
- **Message**:
- **Context**:
- **Decision**: [ ] Fix [ ] False Positive [ ] Won't Fix
- **Rationale**:
- **Status**:

## S6671 (1 issue)
- **File**:
- **Line**:
- **Message**:
- **Context**:
- **Decision**: [ ] Fix [ ] False Positive [ ] Won't Fix
- **Rationale**:
- **Status**:

---

## Summary
- **Issues Fixed**: X
- **False Positives**: X
- **Won't Fix**: X
- **Total Time**: XX minutes
- **Tests Passed**: ✅ / ❌
```

---

**Last Updated**: October 1, 2025
**Session**: Issue #1221 learnings applied
**Approach**: Investigation-first, not automated
**Status**: Ready to execute
