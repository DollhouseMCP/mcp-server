# PR: Update GitHub Workflows for GitFlow Strategy

## Overview

This PR updates our GitHub Actions workflows to fully support the GitFlow branching strategy with `main` and `develop` branches.

## Changes Made

### 1. Updated Existing Workflows

#### security-audit.yml
- Added `develop` branch to push and pull_request triggers
- Now runs security audits on both production and integration branches

### 2. New Workflows Added

#### release-npm.yml
- Triggers on version tags (v*)
- Automates NPM publishing process
- Creates GitHub releases with changelogs
- Verifies version consistency between tags and package.json
- Uploads build artifacts

#### branch-protection.yml
- Enforces GitFlow rules for PRs to main
- Only allows PRs from develop, release/*, or hotfix/* branches
- Adds helpful comments explaining branch policies
- Checks for version bumps (warning only)
- Optional commit signature verification

## Benefits

1. **Automated Releases**: Tag a version and it automatically publishes to NPM
2. **Branch Protection**: Prevents accidental direct merges to main
3. **Security Coverage**: Security audits now cover develop branch
4. **Clear Workflow**: Automated comments guide contributors

## Testing

1. The branch protection workflow will activate on this PR
2. Security audit will run on develop after merge
3. Release workflow will activate when we tag the next version

## Configuration Required

Before using the release workflow:
1. Add `NPM_TOKEN` secret to repository settings
2. Ensure package.json version matches tag version
3. Update CHANGELOG.md with release notes

## Files Changed

- `.github/workflows/security-audit.yml` - Updated triggers
- `.github/workflows/release-npm.yml` - New file
- `.github/workflows/branch-protection.yml` - New file

## Example Release Process

```bash
# On develop branch, after testing
npm version patch  # or minor/major
git push origin develop

# Create PR to main
gh pr create --base main --head develop --title "Release v1.3.0"

# After merge to main
git checkout main
git pull
git tag v1.3.0
git push origin v1.3.0  # This triggers NPM release
```

## Checklist

- [x] Updated security-audit.yml for develop branch
- [x] Created release-npm.yml for automated publishing
- [x] Created branch-protection.yml for GitFlow enforcement
- [ ] Tested workflows (will test on merge)
- [ ] Updated documentation (if needed)

---

Ready for GitFlow! 🚀