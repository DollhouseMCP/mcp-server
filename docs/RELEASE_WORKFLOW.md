# Release Workflow Guide

This document outlines the complete release process for DollhouseMCP using GitFlow and the intelligent version update system.

> **Note**: This document consolidates and replaces the previous manual workflow documentation. The intelligent version update system (PR #760) automates most version-related tasks.

## Prerequisites

- You're on the `develop` branch with all features merged
- All CI checks are passing on `develop`
- You have decided on the new version number (following semantic versioning)

## Complete Release Process

### Step 1: Create Release Branch

```bash
# Ensure develop is up to date
git checkout develop
git pull origin develop

# Create release branch with version number
git checkout -b release/v1.6.5  # Replace with your version
```

### Step 2: Update Version Numbers

Use the intelligent version update script to automatically update all version references:

```bash
# First, do a dry run to see what will change
npm run version:bump -- 1.6.5 --dry-run

# If everything looks good, run the actual update
npm run version:bump -- 1.6.5 --notes "Add your release notes here"

# The script automatically:
# ✅ Updates package.json and package-lock.json
# ✅ Updates README.md version badges
# ✅ Adds entry to CHANGELOG.md with date
# ✅ Updates documentation files
# ✅ Creates/updates src/constants/version.ts
# ✅ Preserves historical version references
# ✅ Runs npm install --package-lock-only
```

### Step 3: Review and Commit Changes

```bash
# Review all changes made by the script
git diff

# If you need to make additional changes to CHANGELOG.md or other files, do so now

# Stage all changes
git add -A

# Commit with descriptive message
git commit -m "chore: bump version to 1.6.5

- Brief description of major features
- Any important fixes
- Breaking changes (if any)"

# Push the release branch
git push -u origin release/v1.6.5
```

### Step 4: Create Pull Request to Main

```bash
# Create PR from release branch to main
gh pr create --base main --title "Release v1.6.5" --body "## Release v1.6.5

### Features
- Feature 1 description (#PR-number)
- Feature 2 description (#PR-number)

### Bug Fixes
- Fix description (#PR-number)

### Breaking Changes (if any)
- Description of breaking change

### Checklist
- [ ] Version numbers updated
- [ ] CHANGELOG.md updated
- [ ] All tests passing
- [ ] Documentation updated

Ready for production release."
```

### Step 5: Merge and Tag Release

After the PR is approved and merged:

```bash
# Switch to main and pull latest
git checkout main
git pull origin main

# Create and push the version tag (this triggers NPM publish)
git tag v1.6.5
git push origin v1.6.5
```

### Step 6: Merge Back to Develop

**Important**: Keep develop in sync with main

```bash
# Switch to develop
git checkout develop
git pull origin develop

# Merge main into develop
git merge main

# Push the updated develop
git push origin develop
```

### Step 7: Clean Up

```bash
# Delete local release branch
git branch -d release/v1.6.5

# Delete remote release branch
git push origin --delete release/v1.6.5
```

## Quick Copy-Paste Commands

For convenience, here are all commands in sequence (replace `1.6.5` with your version):

```bash
# 1. Setup
git checkout develop && git pull
git checkout -b release/v1.6.5

# 2. Update version
npm run version:bump -- 1.6.5 --notes "Your release notes"

# 3. Commit
git add -A
git commit -m "chore: bump version to 1.6.5"
git push -u origin release/v1.6.5

# 4. Create PR
gh pr create --base main --title "Release v1.6.5"

# 5. After PR merged, tag it
git checkout main && git pull
git tag v1.6.5
git push origin v1.6.5

# 6. Sync develop
git checkout develop && git pull
git merge main
git push

# 7. Cleanup
git branch -d release/v1.6.5
git push origin --delete release/v1.6.5
```

## Hotfix Process

For emergency fixes to production:

```bash
# 1. Create hotfix from main
git checkout main && git pull
git checkout -b hotfix/v1.6.9

# 2. Make fixes and update version
npm run version:bump -- 1.6.6 --notes "Emergency fix for X"

# 3. Commit
git add -A
git commit -m "hotfix: fix critical issue with X"
git push -u origin hotfix/v1.6.9

# 4. PR to main
gh pr create --base main --title "Hotfix v1.6.9"

# 5. After merge, tag
git checkout main && git pull
git tag v1.6.9
git push origin v1.6.9

# 6. Merge to develop
git checkout develop && git pull
git merge main
git push

# 7. Cleanup
git push origin --delete hotfix/v1.6.9
```

## Using GitHub Actions (Alternative)

You can also trigger version updates via GitHub Actions:

1. Go to the Actions tab in GitHub
2. Select "Version Update" workflow
3. Click "Run workflow"
4. Enter:
   - Version number (e.g., 1.6.5)
   - Release notes
   - Choose whether to create PR or commit directly

## Version Numbering Guidelines

Follow semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR** (1.x.x): Breaking changes
- **MINOR** (x.6.x): New features, backwards compatible
- **PATCH** (x.x.5): Bug fixes only

Examples:
- New feature: 1.6.0 → 1.7.0
- Bug fix: 1.6.0 → 1.6.1
- Breaking change: 1.6.0 → 2.0.0

## Pre-release Checklist

Before starting the release process:

- [ ] All feature PRs merged to develop
- [ ] CI passing on develop
- [ ] No critical security alerts
- [ ] Documentation updated for new features
- [ ] Version number decided
- [ ] Release notes prepared

## Post-release Checklist

After release is complete:

- [ ] Tag created and pushed
- [ ] NPM package published (automatic)
- [ ] Release branch deleted
- [ ] Develop branch synced with main
- [ ] GitHub Release created (optional)
- [ ] Team notified

## Troubleshooting

### NPM Publish Failed
- Check if NPM_TOKEN is configured in GitHub Secrets
- Verify package.json has correct registry settings

### Version Script Issues
- Use `--dry-run` to test without changes
- Check for file permissions issues
- Ensure you're in the project root

### Merge Conflicts
- Resolve in favor of main for production code
- Keep develop's new features when merging back

## Additional Resources

- [GitFlow Guide](./development/GITFLOW_WORKFLOW_GUIDE.md)
- [Contributing Guide](../CONTRIBUTING.md)
- [Version Script Details](../scripts/update-version.mjs)

---
*Last updated: August 26, 2025*