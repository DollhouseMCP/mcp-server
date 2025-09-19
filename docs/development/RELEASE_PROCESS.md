# Release Process Guide

## Problem Identified
The GitHub Actions "Release to NPM" workflow fails because it expects the package.json version to match the git tag, but we update package.json locally without committing it before tagging.

## Correct Release Process

### Step 1: Prepare Release Branch
```bash
# Ensure you're on develop
git checkout develop
git pull origin develop

# Create release branch
git checkout -b release/v1.X.0
```

### Step 2: Update Version in package.json
```bash
# Update package.json version
npm version 1.X.0 --no-git-tag-version

# Commit the version change
git add package.json package-lock.json
git commit -m "chore: bump version to 1.X.0 for release"
```

### Step 3: Create PR to Main
```bash
# Push release branch
git push origin release/v1.X.0

# Create PR
gh pr create --base main --title "Release v1.X.0" --body "Release notes here..."
```

### Step 4: Merge and Tag
```bash
# After PR approval and merge
git checkout main
git pull origin main

# Create and push tag
git tag -a v1.X.0 -m "Release v1.X.0: Brief description"
git push origin v1.X.0
```

### Step 5: The Automated Process
Once the tag is pushed, GitHub Actions will:
1. ✅ Verify tag matches package.json (will pass now!)
2. Build the project
3. Run tests
4. Publish to NPM automatically
5. Create GitHub release

### Step 6: Sync Back to Develop
```bash
# Merge main back to develop
git checkout develop
git merge origin/main -m "Merge main (v1.X.0 release) back to develop per GitFlow"
git push origin develop
```

## What NOT to Do

❌ **Don't do this:**
```bash
# Tag first, update version later
git tag v1.X.0
npm version 1.X.0 --no-git-tag-version  # Local only
npm publish  # Manual publish
```

This causes the GitHub Actions workflow to fail because the repository's package.json doesn't match the tag.

## Manual NPM Publish (Emergency Only)

If you need to publish manually:
```bash
# Update version
npm version 1.X.0 --no-git-tag-version

# Publish
npm publish --access public

# IMPORTANT: Commit the version change
git add package.json package-lock.json
git commit -m "chore: update version to 1.X.0 after manual release"
git push origin main

# Then create tag
git tag -a v1.X.0 -m "Release v1.X.0"
git push origin v1.X.0
```

## Fixing Failed Releases

If the GitHub Actions workflow failed but NPM was published manually:

1. Update package.json to match the published version
2. Commit and push to main
3. Manually create GitHub release with `gh release create`

## Best Practices

1. **Always commit package.json version changes** before creating tags
2. **Use release branches** for version bumps
3. **Let GitHub Actions handle NPM publishing** when possible
4. **Test locally first** with `npm pack` to verify the package

## GitHub Actions Workflow

The workflow (`/.github/workflows/release-npm.yml`) expects:
- Trigger: Push of tag matching `v*`
- Package.json version MUST match tag (without the 'v' prefix)
- NPM_TOKEN secret must be configured
- Tests must pass

## Troubleshooting

### Workflow fails with version mismatch
- Package.json wasn't updated before tagging
- Solution: Follow the correct process above

### NPM publish succeeds but workflow shows failure
- This happens with manual publishing
- Solution: Create GitHub release manually

### Extended Node Compatibility badge shows failure
- Usually cascades from the release workflow failure
- Will resolve once proper release process is followed

---

*Last updated: September 19, 2025*
*Issue reference: #1004*