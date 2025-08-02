# Release Workflow Guide

This document outlines the complete release workflow for DollhouseMCP, ensuring consistency between code, documentation, and published packages.

## Pre-Release Checklist

### 1. Documentation Updates (BEFORE Version Bump)
- [ ] Update README.md version number
- [ ] Update README.md changelog section
- [ ] Update test count if changed
- [ ] Update tool count if changed
- [ ] Add new features to key features section
- [ ] Verify all version references are consistent
- [ ] Update any outdated examples

### 2. Code Preparation
- [ ] All tests passing (`npm test`)
- [ ] Security audit clean (`npm run security:audit`)
- [ ] Build successful (`npm run build`)
- [ ] No console.log statements in production code
- [ ] Dependencies up to date

### 3. Branch Management
- [ ] Feature branch merged to develop
- [ ] Develop branch tested thoroughly
- [ ] Create release branch from develop (if major/minor)

## Release Process

### Step 1: Update Documentation First
```bash
# On develop branch
git checkout develop
git pull origin develop

# Create feature branch for release prep
git checkout -b feature/prepare-release-vX.Y.Z

# Update README.md with:
# - New version number
# - Changelog entry
# - Feature documentation
# - Updated counts/stats

# Commit documentation updates
git add .
git commit -m "docs: prepare documentation for vX.Y.Z release"
git push -u origin feature/prepare-release-vX.Y.Z

# Create PR to develop
gh pr create --base develop --title "docs: prepare for vX.Y.Z release"
```

### Step 2: Version Bump (AFTER Docs Merged)
```bash
# After docs PR is merged to develop
git checkout develop
git pull origin develop

# Bump version
npm version patch  # or minor/major

# This creates commit and tag automatically
git push origin develop
git push origin --tags
```

### Step 3: Create Release PR
```bash
# For hotfix (patch)
git checkout -b hotfix/vX.Y.Z develop
git push -u origin hotfix/vX.Y.Z

# For feature release (minor/major)
git checkout -b release/vX.Y.Z develop
git push -u origin release/vX.Y.Z

# Create PR to main
gh pr create --base main --title "Release vX.Y.Z"
```

### Step 4: GitHub Release
```bash
# After PR merged to main
gh release create vX.Y.Z --generate-notes --title "Release vX.Y.Z"
```

### Step 5: NPM Publish
The GitHub Action will automatically publish to NPM when:
1. A new version tag is pushed
2. The tag matches pattern `v*.*.*`
3. CI tests pass

## Version Guidelines

### Patch Version (X.Y.Z++)
- Bug fixes
- Security patches
- Documentation updates that fix errors
- Performance improvements

### Minor Version (X.Y++.0)
- New features
- New tools added
- Backward-compatible changes
- Major documentation additions

### Major Version (X++.0.0)
- Breaking changes
- Tool removals or renames
- Major architecture changes
- Incompatible API changes

## Common Pitfalls to Avoid

1. **Don't bump version before updating docs** - This causes README/package.json mismatch
2. **Don't skip changelog updates** - Users need to know what changed
3. **Don't merge directly to main** - Always go through develop first
4. **Don't forget to pull latest** - Avoid merge conflicts
5. **Don't publish manually** - Let CI handle NPM publishing

## Quick Commands Reference

```bash
# View current version
npm version

# Bump patch version (1.4.1 -> 1.4.2)
npm version patch

# Bump minor version (1.4.1 -> 1.5.0)
npm version minor

# Bump major version (1.4.1 -> 2.0.0)
npm version major

# Create release with notes
gh release create vX.Y.Z --generate-notes

# Check what files will be published
npm pack --dry-run
```

## Documentation-Only Changes

For README updates that don't involve functionality changes:

1. Create feature branch from develop
2. Update documentation
3. PR to develop (NO version bump)
4. Merge to develop
5. Can PR to main if critical
6. NO GitHub release or NPM publish

## Emergency Hotfix Process

For critical production issues:

1. Create hotfix branch from main
2. Fix issue + update README
3. Bump patch version
4. PR directly to main
5. After merge, backport to develop
6. Create GitHub release
7. NPM publishes automatically

## Automation Notes

Currently automated:
- ✅ Version tagging (via `npm version`)
- ✅ NPM publish (via GitHub Actions on tag)
- ✅ Release notes generation

Not yet automated:
- ❌ README version updates
- ❌ Changelog generation
- ❌ Tool/test count updates

Future improvements:
- Script to update README version automatically
- Generate changelog from commit messages
- Auto-detect tool count changes

---

Last updated: August 2, 2025