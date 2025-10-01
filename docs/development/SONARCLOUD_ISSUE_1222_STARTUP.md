# SonarCloud Issue #1222 Startup Guide
**String.replaceAll Modernization (S7781)**

**Created**: October 1, 2025
**Based on**: Issue #1220 learnings (perl automation, verification patterns)
**Estimated Time**: 45-60 minutes
**Expected Impact**: 146 → 25 issues (-121 issues, 83% reduction)

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
# git checkout -b feature/sonarcloud-s7781-string-replaceall

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

# AUTOMATION SKILL (Essential for Issue #1222!)
mcp__dollhousemcp-production__activate_element --name sonarcloud-modernizer --type skills
```

### Step 3: Read Issue #1222
```bash
gh issue view 1222
```

---

## 📋 Issue #1222 Overview

**Rule**: S7781 - Use String.replaceAll()
**Count**: 121 issues (100 TypeScript, 21 JavaScript)
**Type**: CODE_SMELL (Maintainability)
**Severity**: LOW
**Effort**: ~45-60 minutes (semi-automated + manual review)

### What Needs Fixing

Replace `.replace(/pattern/g, replacement)` with `.replaceAll(pattern, replacement)`:

**Simple Cases (Safe to Automate)**:
```typescript
// String literal patterns
str.replace(/foo/g, 'bar')  →  str.replaceAll('foo', 'bar')
str.replace(/\//g, '-')     →  str.replaceAll('/', '-')
```

**Complex Cases (MANUAL REVIEW REQUIRED)**:
```typescript
// Function replacements - behavior may differ!
str.replace(/pattern/g, (match) => transform(match))  // ⚠️ CAREFUL!
// replaceAll has different callback signature in some cases

// Regex with special flags or complex patterns
str.replace(/[a-z]/gi, 'X')  // May need to stay as regex
```

### Why This Matters

Modern JavaScript best practice:
- **Readability**: More explicit intent (no regex needed for simple cases)
- **Maintainability**: Clearer what's being replaced
- **Performance**: Slightly faster for simple string replacements
- **Best Practice**: ES2021+ standard approach

### ⚠️ CRITICAL WARNINGS

**This is NOT fully automated!**

1. **Function replacements**: Require manual review for callback signature differences
2. **Regex flags**: Some complex patterns must stay as regex (case-insensitive, etc.)
3. **Special characters**: Escaping rules differ between regex and string literals
4. **Test thoroughly**: String replacement semantics can be subtle

---

## 🔍 Step-by-Step Workflow

### Phase 1: Discovery (10 minutes)

#### Query for All S7781 Issues
```bash
# Count issues
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=DollhouseMCP_mcp-server&rules=typescript:S7781,javascript:S7781&ps=1" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" | jq '.total'
```

Expected output: `121`

#### Get Detailed List with File Locations
```bash
# Get first 100 issues with file paths
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=DollhouseMCP_mcp-server&rules=typescript:S7781,javascript:S7781&ps=100" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" | jq -r '.issues[] | "\(.component):\(.line) - \(.message)"' > /tmp/s7781-issues.txt

# Review the list
cat /tmp/s7781-issues.txt | head -20
```

#### Categorize Issues: Simple vs Complex
```bash
# Identify which files have the issues
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=DollhouseMCP_mcp-server&rules=typescript:S7781,javascript:S7781&ps=500" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" | jq -r '.issues[].component' | sort | uniq -c | sort -rn
```

### Phase 2: Automated Fix - Simple Cases (15 minutes)

⚠️ **WARNING**: This automation handles ONLY simple string literal replacements. Function-based replacements MUST be done manually!

#### Backup First
```bash
# Create backup commit
git add -A
git commit -m "chore: backup before S7781 automated fixes" --no-verify || true
```

#### Strategy A: Conservative Automation (RECOMMENDED)
**Only replace obvious string literal patterns:**

```bash
# This script ONLY replaces patterns like: .replace(/literal/g, 'string')
# It does NOT touch function replacements or complex regex

# Read each affected file and check for safe patterns
# Use perl for reliable cross-platform regex

find . -type f \( -name "*.ts" -o -name "*.js" \) \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -path "*/dist/*" \
  ! -path "*/build/*" \
  -print0 | while IFS= read -r -d '' file; do
    # Only process files that actually have .replace( in them
    if grep -q '\.replace(' "$file"; then
      echo "Processing: $file"
    fi
  done
```

**STOP HERE**: Given the complexity, I recommend **manual file-by-file review** instead of bulk automation.

#### Strategy B: Manual Review (SAFER)
**For each affected file:**

1. Read the file to see the actual .replace() usage
2. Determine if it's a simple string replacement (safe) or function (complex)
3. Make the change manually with Edit tool
4. Test immediately after each change

Example workflow:
```bash
# 1. Pick a file from the list
file="src/specific/file.ts"

# 2. Show .replace( usage in that file
grep -n "\.replace(" "$file"

# 3. Read the file to understand context
# Use Read tool to see the full code

# 4. Make targeted edits
# Use Edit tool with exact string matching

# 5. Test after each file
npm run build && npm test
```

### Phase 3: Manual Review - Complex Cases (20 minutes)

**Identify complex cases that need manual review:**

```bash
# Find function-based replacements
grep -rn "\.replace.*function\|\.replace.*(.*=>" src/ test/ | grep "/g"

# Find regex with flags other than 'g'
grep -rn "\.replace(/.*[gimsuvy]" src/ test/
```

**For each complex case:**

1. **Understand the original behavior**
2. **Consider if replaceAll is appropriate**
3. **If yes**: Update and test thoroughly
4. **If no**: Leave as-is or add SonarCloud suppression comment

**Suppression comment format:**
```typescript
// NOSONAR - S7781: Complex regex pattern requires .replace() for flags
str.replace(/[a-z]/gi, 'X')
```

### Phase 4: Verification (10 minutes)

#### Build & Test
```bash
# Must pass both!
npm run build
npm test
```

**If tests fail**:
- Identify which file caused the failure
- Review the specific replacement
- Check if string escaping changed behavior
- Revert problematic changes if needed

#### Check for Common Mistakes
```bash
# 1. Check for broken string escaping
grep -r "replaceAll('.*\\\\" src/ test/

# 2. Check for accidental regex in string position
grep -r "replaceAll(/.*/" src/ test/

# 3. Verify no double replacements
grep -r "replaceAllAll" src/ test/
```

#### Verify Issue Count Reduction
```bash
# Wait for CI to complete (2-3 minutes)
gh pr checks <PR_NUMBER>

# Once CI passes, re-query SonarCloud
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=DollhouseMCP_mcp-server&rules=typescript:S7781&pullRequest=<PR_NUM>&ps=1" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" | jq '.total'
```

Expected: `0` or close to 0 (some complex cases may remain)

### Phase 5: Commit & Document (10 minutes)

#### Commit Changes
```bash
git add -A

# Use this commit message format:
git commit -m "$(cat <<'EOF'
fix(sonarcloud): [S7781] Modernize String.replace to replaceAll

- Replaced .replace(/pattern/g) with .replaceAll() (XX instances)
- Manual review completed for function-based replacements
- Complex regex patterns kept as-is with NOSONAR comments
- Files affected: across /src and /test directories
- SonarCloud impact: -XX maintainability issues

Fixes #1222

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

#### Update GitHub Issue
```bash
gh issue comment 1222 --body "✅ **Issue #1222 Progress Update**

**Changes Applied**:
- \`.replace(/pattern/g, 'string')\` → \`.replaceAll('pattern', 'string')\` (XX instances)
- Function-based replacements: XX reviewed, XX converted, XX kept as-is
- Complex regex patterns: XX kept with NOSONAR comments

**Verification**:
- ✅ Build passed: \`npm run build\`
- ✅ Tests passed: \`npm test\`
- ⏳ SonarCloud verification: Awaiting CI scan

**Status**: Commit pushed, awaiting final verification.
**Time**: XX minutes (estimated 45-60 minutes)"
```

#### Close Issue (After SonarCloud Verification)
```bash
gh issue close 1222 --comment "✅ **Task Complete**

All S7781 issues resolved via semi-automated modernization:
- Simple string replacements automated
- Function replacements manually reviewed
- Complex patterns documented with NOSONAR

SonarCloud verified: XX → 0 S7781 issues"
```

---

## ⚠️ CRITICAL WARNINGS

### Known Complexity Issues

**1. Function Replacement Callbacks**
```typescript
// ❌ NOT SAFE TO AUTO-CONVERT
str.replace(/(\w+)/g, (match, p1) => p1.toUpperCase())

// The callback signature is different!
// .replace gets: (match, p1, p2, ..., offset, string)
// .replaceAll gets: (match, offset, string) when using string pattern
```

**2. Regex Special Characters in Strings**
```typescript
// ❌ CAREFUL WITH ESCAPING
str.replace(/\./g, '-')   // Matches literal dot
str.replaceAll('.', '-')  // Also matches literal dot (no escaping needed)

// But watch out for special regex chars!
str.replace(/\$/g, 'USD') // Matches literal $
str.replaceAll('$', 'USD') // ERROR - $ is special in replacement string!
// Correct: str.replaceAll('$', '$$') // $$ escapes to literal $
```

**3. Case-Insensitive and Other Flags**
```typescript
// ❌ CANNOT CONVERT - keeps regex
str.replace(/pattern/gi, 'replacement')
// replaceAll doesn't support flags for string patterns
// Must stay as regex or convert pattern to case-insensitive form
```

### Common Pitfalls

#### 1. Breaking String Escaping
```typescript
// Before
str.replace(/\n/g, '\\n')  // Replaces newline with string "\n"

// After (WRONG!)
str.replaceAll('\n', '\\n')  // Still replaces newline, correct

// But watch for:
str.replace(/\\/g, '/')  // Replaces backslash with slash
str.replaceAll('\\', '/') // Must use '\\' for literal backslash
```

#### 2. Replacement String Special Chars
```typescript
// $ has special meaning in replacement strings!
str.replace(/x/g, '$1')    // Inserts captured group 1
str.replaceAll('x', '$1')  // Also inserts captured group 1!
str.replaceAll('x', '$$1') // Inserts literal "$1"
```

Use `git diff` extensively to review all changes!

---

## 📊 Success Criteria

### Must Have
- [ ] All simple S7781 string replacements converted
- [ ] All function replacements manually reviewed
- [ ] Complex patterns documented with NOSONAR
- [ ] `npm run build` succeeds
- [ ] `npm test` passes (all tests green)
- [ ] Git commit created with proper message format
- [ ] GitHub Issue #1222 updated and closed
- [ ] No broken string escaping
- [ ] No accidental regex-in-string errors

### Should Have
- [ ] Total issue count: 146 → ~25 (may vary based on complex patterns kept)
- [ ] Session notes document created
- [ ] List of files with NOSONAR comments documented
- [ ] Manual review notes for complex cases

---

## 🔧 Troubleshooting

### "Tests Failing - String Behavior Changed"

**Likely cause**: Escaping differences or special character handling

**Solution**:
```bash
# Find the failing test
npm test -- --verbose

# Review the specific file change
git diff path/to/failing/file.ts

# Check for common issues:
# 1. Backslash escaping: \ vs \\
# 2. Dollar sign in replacement: $ vs $$
# 3. Regex special chars in pattern: . * + ? ^ $ [ ] ( ) { } |

# Revert if needed and do manual conversion
git checkout -- path/to/problematic/file.ts
```

### "SonarCloud Still Shows Many Issues"

**Expected**: Some complex cases will remain and should have NOSONAR comments

**Solution**:
```bash
# Check which issues remain
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=DollhouseMCP_mcp-server&rules=typescript:S7781&pullRequest=<PR>&ps=100" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" | jq -r '.issues[] | "\(.component):\(.line)"'

# Review each remaining issue to determine if it needs:
# 1. Manual conversion (missed by automation)
# 2. NOSONAR comment (legitimately complex)
# 3. Code refactoring (better solution exists)
```

### "Build Passes But Runtime Behavior Different"

**Critical check**: Regex vs string pattern behavior

```typescript
// Regex can match more broadly
'a.b'.replace(/./g, 'X')      // 'XXX' (. matches any char)
'a.b'.replaceAll('.', 'X')    // 'aXb' (. is literal dot)

// If you see this pattern, KEEP as regex or adjust logic
```

---

## 📈 Expected Metrics

### Before (after Issue #1220 completion)
- Total issues: 146
- S7781 issues: 121
- Maintainability rating: B or C

### After (Issue #1222 completion)
- Total issues: ~25-40 (depending on complex cases)
- S7781 issues: 0-10 (complex cases with NOSONAR)
- Maintainability rating: Improved
- Reduction: 83-92% of S7781 issues

### Time Breakdown (Estimated)
- Discovery: 10 min
- Automated fix (simple): 15 min
- Manual review (complex): 20 min
- Verification: 10 min
- Documentation: 10 min
- **Total**: 60-65 min (45 min estimate + 35% buffer)

**Actual time may vary significantly based on:**
- Ratio of simple vs complex cases
- Test failures requiring investigation
- Need for code refactoring

---

## 📚 Reference Documentation

### Must Read (in order)
1. `docs/development/SONARCLOUD_QUERY_PROCEDURE.md` - How to query correctly
2. GitHub Issue #1222 - Task details
3. `docs/development/SESSION_NOTES_2025-10-01-AFTERNOON-ISSUE-1220-COMPLETE.md` - Automation learnings
4. [MDN: String.replaceAll()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replaceAll)

### Reference As Needed
- `docs/development/SONARCLOUD_RELIABILITY_TRIAGE.md` - Overall strategy
- `docs/development/SONARCLOUD_RULES_REFERENCE.md` - Rule details
- SonarCloud Rule S7781: https://rules.sonarsource.com/typescript/RSPEC-7781

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
- [ ] Reviewed S7781 rule documentation

During work:
- [ ] Changes only in src/ and test/ directories (not node_modules/)
- [ ] Manual review for each function-based replacement
- [ ] Test after each batch of changes
- [ ] Document complex cases with NOSONAR comments

After completion:
- [ ] Zero or near-zero S7781 issues in SonarCloud
- [ ] All tests passing
- [ ] All function replacements reviewed
- [ ] Issue #1222 closed
- [ ] Session notes created

---

## 💡 Pro Tips

### From Issue #1220 (Automation)
1. **Use perl, not sed** - More reliable on macOS
2. **Test frequently** - Don't batch too many changes
3. **git diff is your friend** - Review every change before committing

### For Issue #1222 (Semi-Manual)
4. **Don't over-automate** - Function replacements need human judgment
5. **NOSONAR is okay** - Not every issue needs fixing if code is correct
6. **Document your decisions** - Future maintainers will thank you
7. **When in doubt, keep as-is** - Regex is fine if it's clear and correct
8. **Test edge cases** - String escaping is subtle

### Time Management
9. **Budget for manual review** - It takes longer than automation
10. **Don't rush function replacements** - Getting them wrong is worse than not fixing
11. **Consider splitting work** - Simple cases first, complex cases as separate commit

---

## 🚀 Ready to Start?

```bash
# Copy-paste this entire block to begin:

echo "🎯 Starting Issue #1222 - S7781 String.replaceAll Modernization"
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
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=DollhouseMCP_mcp-server&rules=typescript:S7781&ps=1" \
  -H "Authorization: Bearer $SONARQUBE_TOKEN" | jq '.total'

echo ""
echo "✅ Ready to proceed with SEMI-AUTOMATED fixes (manual review required)!"
echo "⚠️  Remember: This is NOT fully automated - review function replacements carefully!"
```

---

**Last Updated**: October 1, 2025
**Session**: Issue #1220 completion (automation learnings applied)
**Previous Issue**: #1220 (fully automated - complete)
**Current Issue**: #1222 (semi-automated - requires manual review)
**Next Issue**: #1224 (after this one)
**Status**: Ready to execute with caution
