# Release Issue Verification Procedure

## Overview

This procedure ensures that all issues mentioned in a release are properly closed after the release merges to `main`. This prevents issues from remaining open after they've been fixed.

## The Problem

Issues can remain open even after being fixed because:
1. PR descriptions missing `Fixes #XXX` keywords
2. Issues mentioned only in release notes, not in individual PRs
3. Multiple PRs for one issue, only one linked
4. Manual release notes without proper GitHub references

## The Solution

**Two-tier approach:**

### 1. Automated Verification (GitHub Action)

When a release PR merges to `main`, the `release-issue-verification.yml` workflow:
- ✅ Extracts all issue numbers from release notes
- ✅ Checks if each issue is open or closed
- ✅ Posts a verification report as a PR comment
- ✅ Auto-closes any open issues with reference to the release
- ✅ Uploads verification report as artifact

**This runs automatically** - no manual action needed for future releases.

### 2. Manual Cleanup (For Historical Issues)

Use the script to clean up old releases:

```bash
# Check a specific release PR
node scripts/verify-release-issues.js --pr 1238

# Check a specific release tag
node scripts/verify-release-issues.js --tag v1.9.16

# Actually close the issues (dry-run by default)
node scripts/verify-release-issues.js --pr 1238 --close

# Verbose output for debugging
node scripts/verify-release-issues.js --pr 1238 --close --verbose
```

## Usage Guide

### For Future Releases (Automated)

**Nothing to do!** The GitHub Action runs automatically when:
- A PR titled "Release v*" merges to `main`
- The workflow has `issues: write` permission

**You'll see:**
1. Verification report posted as PR comment
2. Open issues auto-closed with reference to release
3. Report artifact uploaded for review

### For Historical Cleanup

**Step 1: Find releases to check**
```bash
# List recent release PRs
gh pr list --base main --state merged --limit 10 | grep "Release v"

# Or list tags
gh release list --limit 10
```

**Step 2: Verify issues (dry-run)**
```bash
# Check what issues are referenced
node scripts/verify-release-issues.js --pr 1238

# Example output:
# 🔍 Release Issue Verification
#
# Found 6 issue references: #1220, #1221, #1222, #1224, #1228, #1236
#
# ⚠️  #1214: enhancement(formatter): Add configuration option (OPEN)
# ⚠️  #1211: fix(formatter): ElementFormatter hits scanner false positives (OPEN)
#
# 📊 Summary:
#   ✅ Already closed: 4
#   ⚠️  Still open: 2
#   ❓ Not found: 0
```

**Step 3: Review open issues**
- Check if they were actually fixed in the release
- Verify the release notes mention them
- Confirm they should be closed

**Step 4: Close issues**
```bash
# Actually close the verified issues
node scripts/verify-release-issues.js --pr 1238 --close
```

**Step 5: Document results**
Add to session notes:
```markdown
## Release Issue Verification

Ran verification for v1.9.16 (PR #1238):
- 4 issues already closed
- 2 issues closed manually: #1214, #1211
- All release issues now properly tracked
```

## How It Works

### Issue Number Extraction

The script finds issue numbers in multiple formats:
- `#123` - Direct issue reference
- `Issue #123` - Explicit issue mention
- `Fixes #123` - GitHub auto-close keyword
- `PR #123` - Pull request reference (checked as issues)

### Verification Logic

For each found issue number:
1. Query GitHub API for issue status
2. If not found → mark as "not found" (may be PR or external)
3. If closed → mark as "already closed" ✅
4. If open → mark as "needs closing" ⚠️

### Auto-Close Behavior

When closing an issue:
```
Closing as completed in PR #1238.
```

This creates an audit trail linking the issue to the release.

## Best Practices

### During Development

**Always link PRs to issues:**
```markdown
## Summary

Fixes memory loading bug

## Changes

- Fixed ElementFormatter security validation

Fixes #1211
```

**In release notes, reference issues:**
```markdown
### Bug Fixes
- **Issue #1211** - Fixed ElementFormatter security scanner false positives (PR #1212)
- **Issue #1213** - Fixed portfolio search file extensions (PR #1215)
```

### After Release to Main

**Automated workflow handles:**
1. ✅ Verification of all referenced issues
2. ✅ Auto-closing with proper reference
3. ✅ Posting report to PR
4. ✅ Uploading artifact

**You should:**
1. Review the verification report comment
2. Check artifact if issues arise
3. Manually verify any "not found" issues

### Historical Cleanup

**Quarterly or after major releases:**
```bash
# Check last 5 releases
for pr in 1238 1230 1217 1210 1201; do
  echo "Checking PR #$pr"
  node scripts/verify-release-issues.js --pr $pr --close
done
```

## Troubleshooting

### Script Errors

**"Must provide either --pr or --tag"**
- Solution: Add `--pr <number>` or `--tag <version>`

**"Release tag not found"**
- Solution: Use `gh release list` to find correct tag name
- Tags are usually `v1.9.16` format

**"Failed to close issue"**
- Check GitHub token has `issues: write` permission
- Verify you're authenticated: `gh auth status`

### GitHub Action Failures

**Workflow doesn't run**
- Check PR title starts with "Release v"
- Verify PR was merged (not closed)
- Check workflow permissions in repo settings

**Issues not closed**
- Check workflow logs in Actions tab
- Verify `GH_TOKEN` has correct permissions
- Look for errors in verification report artifact

**False positives**
- Review "not found" issues manually
- May be PRs referenced as issues
- May be from other repositories

## Integration with Release Process

### Current Release Workflow

1. Create release PR from develop → main
2. PR title: "Release v1.9.X"
3. PR body: Release notes with issue references
4. Get approvals
5. **Merge to main** ← Triggers verification workflow
6. Tag and publish

### Enhanced with Verification

1-4. (Same as above)
5. **Merge to main**
   - ✅ Verification workflow runs automatically
   - ✅ Posts report as comment
   - ✅ Closes referenced issues
6. Review verification report
7. Tag and publish

## Examples

### Example 1: Dry-Run Check

```bash
$ node scripts/verify-release-issues.js --pr 1238

🔍 Release Issue Verification

Checking release PR #1238...
Found 6 issue references: #1220, #1221, #1222, #1224, #1228, #1236

⚠️  #1214: enhancement(formatter): Add configuration option (OPEN)
⚠️  #1211: fix(formatter): ElementFormatter hits scanner (OPEN)

📊 Summary:
  ✅ Already closed: 4
  ⚠️  Still open: 2
  ❓ Not found: 0

📝 Open Issues:
  #1214: enhancement(formatter): Add configuration option
  #1211: fix(formatter): ElementFormatter hits scanner

💡 Run with --close to automatically close these issues
```

### Example 2: Actually Closing

```bash
$ node scripts/verify-release-issues.js --pr 1238 --close

🔍 Release Issue Verification

Checking release PR #1238...
Found 6 issue references: #1220, #1221, #1222, #1224, #1228, #1236

📊 Summary:
  ✅ Already closed: 4
  ⚠️  Still open: 2
  ❓ Not found: 0

🔒 Closing open issues...
  ✅ Closed #1214
  ✅ Closed #1211

✅ Closed 2 of 2 issues
```

### Example 3: Using Tags

```bash
$ node scripts/verify-release-issues.js --tag v1.9.16 --verbose

🔍 Release Issue Verification

Checking release tag v1.9.16...
Found 6 issue references: #1220, #1221, #1222, #1224, #1228, #1236

✅ #1220: [SonarCloud] Fix S7773 (already closed)
✅ #1221: [SonarCloud] Mark test false positives (already closed)
✅ #1222: [SonarCloud] Fix S7781 (already closed)
✅ #1224: [SonarCloud] Fix MEDIUM severity (already closed)
✅ #1228: [SECURITY] Zero-width Unicode bypass (already closed)
✅ #1236: Documentation Claude Desktop exclusivity (already closed)

📊 Summary:
  ✅ Already closed: 6
  ⚠️  Still open: 0
  ❓ Not found: 0

✅ All referenced issues are properly closed!
```

## Configuration

### Script Location
`scripts/verify-release-issues.js`

### Workflow Location
`.github/workflows/release-issue-verification.yml`

### Required Permissions

**For local script:**
- GitHub CLI authenticated (`gh auth login`)
- Read access to repository

**For GitHub Action:**
- `issues: write` - to close issues
- `pull-requests: write` - to post comments
- `contents: read` - to checkout repo

## Maintenance

### When to Update

**Script needs update if:**
- New issue reference formats emerge
- GitHub API changes
- Need additional verification logic

**Workflow needs update if:**
- Release process changes
- Permission requirements change
- Want different trigger conditions

### Testing Changes

```bash
# Test on a known release
node scripts/verify-release-issues.js --pr 1238 --verbose

# Test workflow locally (requires act)
act pull_request --eventpath test-event.json
```

## FAQ

**Q: What if an issue was mentioned but shouldn't be closed?**
A: Don't include it in release notes, or use "Related to #XXX" instead of "Fixes #XXX"

**Q: Can I run this on old releases?**
A: Yes! Use `--pr` or `--tag` to check any historical release

**Q: What if the script closes the wrong issue?**
A: Reopen it manually and add a comment explaining why. Update release notes to not reference it.

**Q: Does this work for Dependabot PRs?**
A: No - only for release PRs (title starting with "Release v")

**Q: What about issues from other repos?**
A: They'll show as "not found" - manually verify if needed

## Related Documentation

- `docs/development/PR_BEST_PRACTICES.md` - How to link PRs to issues
- `docs/releases/` - Release notes templates
- `.github/workflows/` - Other CI/CD workflows

---

*Last updated: October 7, 2025*
*Version: 1.0.0*
