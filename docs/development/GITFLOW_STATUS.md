# GitFlow Status - Active as of July 29, 2025

## Current State
GitFlow branching strategy is now **ACTIVE** on the DollhouseMCP/mcp-server repository.

## Active Workflows

### 1. Branch Protection (`branch-protection.yml`)
- Runs on all PRs to main
- Enforces that PRs to main must come from:
  - `develop` branch (regular releases)
  - `release/*` branches (release candidates)
  - `hotfix/*` branches (emergency fixes)
- Adds helpful comments explaining violations
- Checks for version bumps (warning only)

### 2. Automated NPM Release (`release-npm.yml`)
- Triggers on version tags (e.g., `v1.3.1`)
- Automatically:
  - Builds the project
  - Runs all tests
  - Publishes to NPM
  - Creates GitHub release with changelog
  - Uploads build artifacts
- Requires `NPM_TOKEN` secret in repository settings

### 3. Security Audits (`security-audit.yml`)
- Now runs on both `main` and `develop` branches
- Triggers on push and pull requests to both branches

## How to Work with GitFlow

### Creating a Feature
```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
# Make changes
git push -u origin feature/your-feature-name
gh pr create --base develop
```

### Creating a Release
```bash
git checkout develop
git pull origin develop
git checkout -b release/1.3.1
# Update version in package.json
# Update CHANGELOG.md
git commit -m "chore: prepare release v1.3.1"
git push -u origin release/1.3.1
gh pr create --base main --title "Release v1.3.1"
```

### After Release is Merged to Main
```bash
git checkout main
git pull origin main
git tag v1.3.1
git push origin v1.3.1  # This triggers NPM release

# Merge back to develop
git checkout develop
git merge main
git push origin develop
```

### Emergency Hotfix
```bash
git checkout main
git pull origin main
git checkout -b hotfix/critical-bug-fix
# Fix the bug
git push -u origin hotfix/critical-bug-fix
gh pr create --base main --title "Hotfix: Critical bug fix"
```

## Important Notes

1. **Never push directly to main** - Branch protection will block it
2. **All features go through develop first**
3. **Version tags trigger automatic NPM releases**
4. **Keep develop up to date with main** after releases
5. **Use semantic versioning** for all releases

## Workflow Files
- `.github/workflows/branch-protection.yml`
- `.github/workflows/release-npm.yml`
- `.github/workflows/security-audit.yml`

Last updated: July 29, 2025