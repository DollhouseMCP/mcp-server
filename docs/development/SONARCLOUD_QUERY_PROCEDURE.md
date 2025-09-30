# SonarCloud Query Procedure for Claude Code

**CRITICAL**: This procedure prevents wasting time on wrong issues.

## The Problem

Generic SonarCloud queries return ALL issues across an entire PR, including:
- OLD issues in files that existed before your changes
- Issues in files you merely touched but didn't introduce
- Hundreds/thousands of irrelevant issues from the codebase

This causes Claude Code to "fix" the wrong issues while actual PR-specific issues remain unfixed.

## The Solution: Query by Changed Files

### Step 1: Identify Changed Files
```bash
git diff develop...HEAD --name-only
```

This shows ONLY the files YOU changed in this PR.

### Step 2: Query Each Changed File Individually
```bash
mcp__sonarqube__issues \
  --pull_request <PR_NUMBER> \
  --components "<specific_file_path>" \
  --output_mode content \
  -n true
```

**Example:**
```bash
# For a test file you added:
mcp__sonarqube__issues \
  --pull_request 1215 \
  --components "test/__tests__/unit/portfolio/portfolio-search-file-extensions.test.ts" \
  --output_mode content \
  -n true
```

### Step 3: Fix Issues in That File
- Read the file
- Make the fixes
- Run tests to verify
- Commit with clear message

### Step 4: Verify Fix Worked
```bash
# Check CI status first
gh pr checks <PR_NUMBER>

# Wait until SonarCloud shows "pass" (usually 1-2 minutes)

# Re-query the file to confirm zero issues
mcp__sonarqube__issues \
  --pull_request <PR_NUMBER> \
  --components "<file_you_fixed>" \
  --output_mode files_with_matches
```

If the query returns empty `"issues": []`, the file is clean.

## Why This Works

- **Matches SonarCloud Web UI**: The web interface auto-filters to changed files
- **Avoids Pollution**: Pre-existing issues in touched files don't confuse you
- **Targeted Fixes**: You see ONLY issues you can actually fix
- **Verification**: Empty result means success

## Complete Example Session

```bash
# 1. See what you changed
$ git diff develop...HEAD --name-only
test/__tests__/unit/portfolio/portfolio-search-file-extensions.test.ts
src/index.ts
src/portfolio/PortfolioManager.ts

# 2. Query the test file (most likely to have new issues)
$ mcp__sonarqube__issues --pull_request 1215 \
    --components "test/__tests__/unit/portfolio/portfolio-search-file-extensions.test.ts" \
    --output_mode content -n true

# Output shows 5 issues:
# - L12: Remove unused jest import
# - L13: Use node:fs/promises
# - L14: Use node:path
# - L15: Use node:os
# - L41: Handle exception

# 3. Fix all 5 issues in the file

# 4. Commit and push
$ git add test/__tests__/unit/portfolio/portfolio-search-file-extensions.test.ts
$ git commit -m "fix(sonarcloud): Fix 5 issues in test file"
$ git push

# 5. Wait for CI
$ gh pr checks 1215
SonarCloud Code Analysis    pass    39s

# 6. Verify fixed
$ mcp__sonarqube__issues --pull_request 1215 \
    --components "test/__tests__/unit/portfolio/portfolio-search-file-extensions.test.ts" \
    --output_mode files_with_matches

# Output: {"issues": [], ...} ✅ SUCCESS
```

## Red Flags (What NOT to Do)

### ❌ DON'T: Query without --components
```bash
# This returns THOUSANDS of issues from the entire codebase
mcp__sonarqube__issues --pull_request 1215 --sinceLeakPeriod true
```

### ❌ DON'T: Assume old issues are yours
```bash
# Issue from Sept 27 in a Docker file = NOT your issue
# Issue from TODAY in YOUR new test file = YOUR issue
```

### ❌ DON'T: Query before CI completes
```bash
# Check first:
gh pr checks <PR_NUMBER>

# Wait for SonarCloud to show "pass" before querying
```

### ❌ DON'T: Fix issues in files you didn't create/modify
```bash
# If the file was already there with issues, that's technical debt
# Unless you're explicitly doing a cleanup PR, skip pre-existing issues
```

## Workflow Integration

### At PR Creation
```bash
# After creating PR, wait 2-3 minutes for initial scan
# Then check each changed file
git diff develop...HEAD --name-only | while read file; do
  echo "=== Checking $file ==="
  mcp__sonarqube__issues --pull_request <PR_NUM> --components "$file"
done
```

### Before Merge
```bash
# Verify all YOUR changed files are clean
for file in $(git diff develop...HEAD --name-only); do
  issues=$(mcp__sonarqube__issues --pull_request <PR_NUM> \
    --components "$file" --output_mode files_with_matches | \
    jq '.paging.total')

  if [ "$issues" -gt 0 ]; then
    echo "❌ $file has $issues issues"
  else
    echo "✅ $file is clean"
  fi
done
```

## Edge Cases

### Changed File Has Pre-Existing Issues
If you modified a file that already had issues:
1. Check issue `creationDate` - if it's old, it's pre-existing
2. Check issue `updateDate` - if it's recent, it might be new
3. Compare with `git show develop:<file>` to see if issue existed before

### Multiple Files Changed
Query each file separately. Don't try to batch query - you lose context.

### False Positives
If SonarCloud flags something incorrectly, use the MCP to mark as false positive:
```bash
mcp__sonarqube__markIssueFalsePositive \
  --issue_key <KEY> \
  --comment "Explanation of why this is not an issue"
```

## Troubleshooting

### "Still seeing issues after fixing"
- Wait 1-2 minutes for CI to complete
- Check `gh pr checks` for SonarCloud status
- Re-query after it shows "pass"

### "Query returns empty but web UI shows issues"
- Check you're using correct PR number
- Check file path is exact (case-sensitive)
- Try querying without `--components` to see if issues exist at all

### "Too many issues to fix"
- Prioritize files YOU created or substantially modified
- Ignore pre-existing issues in files you barely touched
- Create follow-up issues for technical debt cleanup

---

**Last Updated**: 2025-09-30
**Verified Working**: PR #1215
**Related**: sonar-guardian persona, SonarCloud MCP integration
