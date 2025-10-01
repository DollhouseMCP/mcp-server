# SonarCloud Issue #1220 Startup Guide
**Automated Number Method Modernization (S7773)**

**Created**: October 1, 2025
**Based on**: Issue #1221 session learnings
**Estimated Time**: 20-30 minutes
**Expected Impact**: 251 → 146 issues (-105 issues, 42% reduction)

---

## 🎯 Quick Start Commands

### Step 1: Branch Check & Setup
```bash
# Verify current location
pwd
# Expected: /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server

# Check current branch
git branch --show-current
# Likely: feature/sonarcloud-hotspot-review-46-patterns

# Decision: Stay on current branch (continuing SonarCloud work) or create new branch
# If creating new branch (ask user first):
# git checkout develop && git pull
# git checkout -b feature/sonarcloud-s7773-number-methods

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

# AUTOMATION SKILL (Essential for Issue #1220!)
mcp__dollhousemcp-production__activate_element --name sonarcloud-modernizer --type skills
```

### Step 3: Read Issue #1220
```bash
gh issue view 1220
```

---

## 📋 Issue #1220 Overview

**Rule**: S7773 - Use built-in Number methods
**Count**: ~90-105 issues
**Type**: BUG (Reliability)
**Severity**: MINOR
**Effort**: 5min per issue (automated fixes = much faster!)

### What Needs Fixing

Replace global number functions with `Number.` prefixed equivalents:
- `parseInt()` → `Number.parseInt()`
- `parseFloat()` → `Number.parseFloat()`
- `isNaN()` → `Number.isNaN()`
- `isFinite()` → `Number.isFinite()`

### Why This Matters

Modern JavaScript best practice:
- Avoids global namespace pollution
- Clearer intent (explicitly using Number methods)
- Consistent with ES6+ patterns
- SonarCloud "Sonar Way" compliance

---

## 🔍 Step-by-Step Workflow

### Phase 1: Discovery (5 minutes)

#### Query for All S7773 Issues
```bash
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S7773 \
  --types BUG \
  --output_mode count
```

Expected output: `"total": 90-105`

#### Get Detailed List
```bash
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S7773 \
  --types BUG \
  --output_mode content \
  -n true \
  --page_size 100
```

#### Identify Affected Files
```bash
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S7773 \
  --output_mode files_with_matches
```

### Phase 2: Automated Fix (10 minutes)

#### Option A: Automated Bulk Fix (RECOMMENDED)
```bash
# Create backup branch point
git add -A
git commit -m "chore: backup before S7773 automated fixes" --no-verify || true

# Run automated find/replace
find . \( -name "*.ts" -o -name "*.js" \) \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -path "*/dist/*" \
  ! -path "*/build/*" \
  -exec sed -i '' \
    -e 's/\bparseInt(/Number.parseInt(/g' \
    -e 's/\bparseFloat(/Number.parseFloat(/g' \
    -e 's/\bisNaN(/Number.isNaN(/g' \
    -e 's/\bisFinite(/Number.isFinite(/g' \
    {} +

# CRITICAL: Check for double replacements (sed caught Number.parseInt and made Number.Number.parseInt)
grep -r "Number\.Number\." src/ test/ && echo "⚠️  FOUND DOUBLE REPLACEMENTS - NEED TO FIX" || echo "✓ No double replacements"

# Fix any double replacements
find . \( -name "*.ts" -o -name "*.js" \) \
  ! -path "*/node_modules/*" \
  -exec sed -i '' -e 's/Number\.Number\./Number./g' {} +
```

#### Option B: Manual File-by-File (if automated fails)
```bash
# For each file with issues:
# 1. Read the file
# 2. Edit to replace patterns
# 3. Save and move to next file

# Example for a single file:
# sed -i '' 's/\bparseInt(/Number.parseInt(/g' src/specific/file.ts
```

### Phase 3: Verification (10 minutes)

#### Build & Test
```bash
# Must pass both!
npm run build
npm test
```

**If tests fail**:
- Review the changes carefully
- Look for edge cases where replacement was incorrect
- Check comments or string literals that got replaced by accident
- Use `git diff` to review all changes

#### Verify Issue Count Reduction
```bash
# Re-query SonarCloud (may need to wait 2-3 minutes for CI scan)
gh pr checks <PR_NUMBER>  # Wait for "pass" status

# Then re-query
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --rules typescript:S7773 \
  --types BUG \
  --output_mode count
```

Expected: `"total": 0` or very close to 0

### Phase 4: Commit & Document (5 minutes)

#### Commit Changes
```bash
git add -A

# Use this commit message format:
git commit -m "fix(sonarcloud): [S7773] Modernize Number parsing methods

- Replaced parseInt with Number.parseInt (XX instances)
- Replaced parseFloat with Number.parseFloat (XX instances)
- Replaced isNaN with Number.isNaN (XX instances)
- Replaced isFinite with Number.isFinite (XX instances)
- Files affected: across /src and /test directories
- SonarCloud impact: -XX reliability issues

Fixes #1220

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

#### Update GitHub Issue
```bash
gh issue comment 1220 --body "✅ **Issue #1220 Complete**

Automated Number method modernization completed successfully.

**Changes Applied**:
- \`parseInt()\` → \`Number.parseInt()\` (XX instances)
- \`parseFloat()\` → \`Number.parseFloat()\` (XX instances)
- \`isNaN()\` → \`Number.isNaN()\` (XX instances)
- \`isFinite()\` → \`Number.isFinite()\` (XX instances)

**Verification**:
- ✅ Build passed: \`npm run build\`
- ✅ Tests passed: \`npm test\`
- ✅ SonarCloud verified: 0 remaining S7773 issues

**Impact**: 251 → 146 total issues (-105, 42% reduction)
**Time**: XX minutes (estimated 20-30 minutes)"
```

#### Close Issue
```bash
gh issue close 1220 --comment "Task completed successfully. All S7773 issues resolved via automated Number method modernization."
```

---

## ⚠️ CRITICAL WARNINGS

### Known MCP Tool Issue
**The SonarCloud MCP marking tools have a parameter mismatch!**

If you need to mark any issues as false positive:
- ❌ DON'T use `mcp__sonarqube__markIssueFalsePositive` (will fail)
- ✅ DO use direct curl calls (see below)

```bash
# Mark false positive
curl -X POST "https://sonarcloud.io/api/issues/do_transition" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" \
  -d "issue=<issue_key>" \
  -d "transition=falsepositive"

# Add comment
curl -X POST "https://sonarcloud.io/api/issues/add_comment" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" \
  -d "issue=<issue_key>" \
  -d "text=<explanation>"
```

### Common Pitfalls

#### 1. Double Replacements
```typescript
// Problem: File already had Number.parseInt, sed replaced it again
Number.Number.parseInt(str)  // ❌ WRONG

// Fix: Run second sed pass to clean up
sed -i '' 's/Number\.Number\./Number./g' **/*.ts
```

#### 2. Radix Parameter Preservation
```typescript
// Make sure sed preserves the radix parameter
parseInt(str, 16)  →  Number.parseInt(str, 16)  // ✅ CORRECT
parseInt(str, 16)  →  Number.parseInt(str)      // ❌ WRONG
```

The provided sed pattern handles this correctly with `\b` word boundaries.

#### 3. String Literal Replacements
```typescript
// If sed replaces inside strings (shouldn't with \b, but check):
const msg = "Use parseInt() function"  // Should NOT be replaced
```

Use `git diff` to review and manually fix any incorrect string replacements.

---

## 📊 Success Criteria

### Must Have
- [ ] All S7773 issues marked as RESOLVED in SonarCloud
- [ ] `npm run build` succeeds
- [ ] `npm test` passes (all tests green)
- [ ] Git commit created with proper message format
- [ ] GitHub Issue #1220 updated and closed
- [ ] No double replacements (`Number.Number.`)
- [ ] No broken string literals or comments

### Should Have
- [ ] Total issue count: 251 → ~146 (may vary slightly)
- [ ] Session notes document created
- [ ] Changes reviewed for correctness
- [ ] Verification that radix parameters preserved

---

## 🔧 Troubleshooting

### "Build Failed After Changes"

**Likely cause**: Double replacement or syntax error

**Solution**:
```bash
# Check for double replacements
grep -r "Number\.Number\." src/ test/

# If found, fix them
find . -name "*.ts" -exec sed -i '' 's/Number\.Number\./Number./g' {} +

# Rebuild
npm run build
```

### "Tests Failing After Changes"

**Likely cause**: Semantic change in behavior (rare but possible)

**Solution**:
```bash
# Run tests with verbose output
npm test -- --verbose

# Identify failing test
# Review the specific change in that file
git diff path/to/failing/test.ts

# Check if replacement was inappropriate (e.g., in mock data)
# Manually revert that specific change if needed
```

### "SonarCloud Still Shows Issues After Fix"

**Likely cause**: CI scan hasn't completed yet

**Solution**:
```bash
# Wait for CI to complete (usually 2-3 minutes)
gh pr checks <PR_NUMBER>

# Check status every 30 seconds
watch -n 30 'gh pr checks <PR_NUMBER> | grep SonarCloud'

# Once status shows "pass", re-query
mcp__sonarqube__issues --project_key DollhouseMCP_mcp-server --rules typescript:S7773 --output_mode count
```

### "Found Issues in node_modules/"

**This shouldn't happen** - the find command excludes node_modules.

If it does happen:
```bash
# Revert changes in node_modules
git checkout -- node_modules/

# Re-run find with explicit exclusions
find . -name "*.ts" \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  -exec sed -i '' 's/\bparseInt(/Number.parseInt(/g' {} +
```

---

## 📈 Expected Metrics

### Before (from Issue #1221 completion)
- Total issues: 251
- S7773 issues: ~90-105
- Reliability rating: B or C

### After (Issue #1220 completion)
- Total issues: ~146
- S7773 issues: 0
- Reliability rating: Improved
- Reduction: 42% of remaining issues

### Time Breakdown
- Discovery: 5 min
- Automated fix: 10 min
- Verification: 10 min
- Documentation: 5 min
- **Total**: 25-30 min (vs 20 min estimate)

---

## 📚 Reference Documentation

### Must Read (in order)
1. `docs/development/SONARCLOUD_QUERY_PROCEDURE.md` - How to query correctly
2. GitHub Issue #1220 - Task details
3. `docs/development/SESSION_NOTES_2025-10-01-AFTERNOON-ISSUE-1221.md` - Previous session learnings

### Reference As Needed
- `docs/development/SONARCLOUD_RELIABILITY_TRIAGE.md` - Overall strategy
- `docs/development/SONARCLOUD_RULES_REFERENCE.md` - Rule details
- SonarCloud Rule S7773: https://rules.sonarsource.com/typescript/RSPEC-7773

### Related Files
- Session notes template: `docs/development/SESSION_NOTES_*.md`
- sonarcloud-modernizer skill: Active in session, provides patterns

---

## 🎯 Quick Sanity Checks

Before starting:
- [ ] In correct directory: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server`
- [ ] Git status clean or on expected branch
- [ ] `SONARQUBE_TOKEN` environment variable set
- [ ] All Dollhouse elements activated

During work:
- [ ] Changes only in src/ and test/ directories (not node_modules/)
- [ ] No `Number.Number.` double replacements
- [ ] Build passes after each major change

After completion:
- [ ] Zero S7773 issues in SonarCloud
- [ ] All tests passing
- [ ] Issue #1220 closed
- [ ] Session notes created

---

## 💡 Pro Tips from Issue #1221

1. **Don't trust the MCP tools blindly** - They may have bugs. Have curl fallback ready.

2. **Always verify with actual queries** - Don't assume changes worked until SonarCloud confirms.

3. **Read sonarcloud-query-procedure memory** - It saves time by preventing wrong queries.

4. **Batch operations when possible** - sed across all files is faster than file-by-file.

5. **Test frequently** - Run `npm test` after bulk changes before committing.

6. **Document as you go** - Future Claude (and future you) will thank you.

7. **Check git diff before committing** - Automated replacements can be unpredictable.

8. **Actual time = Estimated time + 50%** - Buffer for verification and edge cases.

---

## 🚀 Ready to Start?

```bash
# Copy-paste this entire block to begin:

echo "🎯 Starting Issue #1220 - S7773 Number Method Modernization"
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
echo "Step 4: Query current issue count"
echo "(Run the SonarCloud query from Phase 1 above)"

echo ""
echo "✅ Ready to proceed with automated fixes!"
```

---

**Last Updated**: October 1, 2025
**Session**: Issue #1221 completion
**Next Issue**: #1222 (after this one)
**Status**: Ready to execute
