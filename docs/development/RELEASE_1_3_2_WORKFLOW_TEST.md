# Release v1.3.2 - NPM Workflow Test

## Purpose
Testing the complete GitFlow release workflow end-to-end after fixing the NPM release automation.

## What Was Done

### 1. Fixed NPM Release Workflow ✅
- Cherry-picked commit ac6c718 from develop to main
- This adds TEST_PERSONAS_DIR environment variable to release workflow
- Pushed directly to main with admin bypass

### 2. Created Release v1.3.2 ✅
- Created release/v1.3.2 branch from main
- Bumped version to 1.3.2
- Updated CHANGELOG.md
- Created PR #401

## Current Status
- PR #401: https://github.com/DollhouseMCP/mcp-server/pull/401
- Status: Open, CI checks running
- Next: Wait for CI checks to pass, then merge

## What to Monitor

### During PR Phase
1. All CI checks should pass (7 required checks)
2. GitFlow validation should succeed
3. No test failures

### After Merge
1. **GitFlow Merge Workflow** should:
   - Create tag v1.3.2
   - Push tag to repository
   - Merge back to develop

2. **NPM Release Workflow** should:
   - Trigger on tag v1.3.2
   - Run tests successfully (with TEST_PERSONAS_DIR fix)
   - Publish to NPM
   - Create GitHub release

## Verification Commands

```bash
# Watch PR checks
gh pr checks 401 --watch

# After merge, watch workflow runs
gh run list --workflow release-npm.yml --limit 5

# Check if package was published
npm view @dollhousemcp/mcp-server@1.3.2

# Check GitHub releases
gh release list --limit 5
```

## Success Criteria
- ✅ PR merges successfully
- ✅ Tag v1.3.2 is created
- ✅ NPM package publishes automatically
- ✅ GitHub release is created
- ✅ No manual intervention required

## If Something Fails
1. Check workflow logs: `gh run view [RUN_ID]`
2. If NPM publish fails again, check the logs for new errors
3. Document any new issues for fixing

## Timeline
- Created: July 29, 2025 19:11 EDT
- PR #401 opened
- Waiting for CI checks...