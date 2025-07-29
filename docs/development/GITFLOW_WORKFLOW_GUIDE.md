# GitFlow Workflow Guide for DollhouseMCP

A practical guide to our branching strategy and development workflow.

## Table of Contents
1. [Overview](#overview)
2. [Branch Structure](#branch-structure)
3. [Common Workflows](#common-workflows)
4. [Command Reference](#command-reference)
5. [Best Practices](#best-practices)
6. [Troubleshooting](#troubleshooting)

---

## Overview

We use GitFlow, a branching model that provides structure and clarity to our development process. This guide will walk you through every scenario you might encounter.

### Why GitFlow?
- **Clear separation** between stable code (main) and development (develop)
- **Organized feature development** without breaking others' work
- **Safe hotfix process** for emergency fixes
- **Structured releases** with proper testing

---

## Branch Structure

```
main
├── The production branch - always stable, deployed to NPM
├── Protected - requires PR reviews and passing tests
└── Tagged for releases (v1.2.0, v1.2.1, etc.)

develop
├── The integration branch - features merge here first
├── Always ahead of main (except right after release)
└── Where CI runs integration tests

feature/*
├── New features and enhancements
├── Created from develop
└── Merged back to develop

hotfix/*
├── Emergency fixes for production
├── Created from main
└── Merged to both main AND develop

release/*
├── Release preparation branches
├── Created from develop when ready to release
└── Final testing and version bumps happen here
```

---

## Common Workflows

### 🚀 Starting a New Feature

**Scenario**: You want to add new personas to the collection.

```bash
# 1. Start from develop and make sure it's up to date
git checkout develop
git pull origin develop

# 2. Create your feature branch
git checkout -b feature/add-teacher-personas

# 3. Work on your feature
# ... make changes ...
git add .
git commit -m "Add 10 teacher personas for different subjects"

# 4. Stay updated with develop (do this regularly)
git fetch origin
git rebase origin/develop  # or 'git merge origin/develop' if you prefer

# 5. Push your branch
git push -u origin feature/add-teacher-personas

# 6. Create a Pull Request to develop (NOT main!)
gh pr create --base develop --title "Add teacher personas" \
  --body "Adds 10 new teacher personas covering math, science, history..."
```

**Note**: Never create PRs directly to main from feature branches!

---

### 🐛 Fixing a Bug in Development

**Scenario**: There's a bug in the develop branch that needs fixing.

```bash
# 1. Start from develop
git checkout develop
git pull origin develop

# 2. Create a fix branch
git checkout -b fix/category-type-issue

# 3. Fix the bug
# ... make changes ...
git add .
git commit -m "Fix: Replace 'category' with 'type' in tests"

# 4. Push and create PR
git push -u origin fix/category-type-issue
gh pr create --base develop --title "Fix category/type issue in tests"
```

---

### 🚨 Emergency Hotfix for Production

**Scenario**: There's a critical security issue in production that can't wait for the next release.

```bash
# 1. Start from main (production)
git checkout main
git pull origin main

# 2. Create hotfix branch
git checkout -b hotfix/security-vulnerability

# 3. Fix the critical issue
# ... make minimal changes ...
git add .
git commit -m "Hotfix: Patch critical security vulnerability in input validation"

# 4. Update version for hotfix
npm version patch  # Changes 1.2.0 → 1.2.1
git add package.json package-lock.json
git commit -m "Bump version to 1.2.1"

# 5. Push hotfix branch
git push -u origin hotfix/security-vulnerability

# 6. Create PR to main
gh pr create --base main --title "Hotfix: Security vulnerability" \
  --body "Critical fix for security issue. This needs immediate release."

# 7. After PR is merged to main, also merge to develop
git checkout develop
git pull origin develop
git merge origin/main  # or cherry-pick the commits
git push origin develop
```

**Important**: Hotfixes must be merged to BOTH main and develop!

---

### 📦 Preparing a Release

**Scenario**: Develop has new features ready and we want to release v1.3.0.

```bash
# 1. Start from develop
git checkout develop
git pull origin develop

# 2. Create release branch
git checkout -b release/1.3.0

# 3. Update version
npm version minor  # 1.2.0 → 1.3.0
git add package.json package-lock.json
git commit -m "Bump version to 1.3.0"

# 4. Update CHANGELOG.md
# ... edit CHANGELOG.md ...
git add CHANGELOG.md
git commit -m "Update changelog for v1.3.0"

# 5. Final testing on release branch
npm test
npm run build

# 6. Push release branch
git push -u origin release/1.3.0

# 7. Create PR to main
gh pr create --base main --title "Release v1.3.0" \
  --body "Release v1.3.0 with new personas and bug fixes. See CHANGELOG.md"

# 8. After merge to main, tag and release
git checkout main
git pull origin main
git tag v1.3.0
git push origin v1.3.0  # This triggers NPM publish!

# 9. Merge back to develop
git checkout develop
git merge origin/main
git push origin develop
```

---

## Command Reference

### Quick Commands Cheat Sheet

```bash
# Start new feature
git checkout develop && git pull && git checkout -b feature/name

# Update feature branch with latest develop
git fetch origin && git rebase origin/develop

# Start hotfix
git checkout main && git pull && git checkout -b hotfix/name

# Check what branch you're on
git branch --show-current

# See all branches
git branch -a

# Delete local feature branch after merge
git branch -d feature/name

# Force delete unmerged branch (careful!)
git branch -D feature/name
```

---

## Best Practices

### ✅ DO:
- Always create feature branches from `develop`
- Keep feature branches focused and short-lived
- Regularly sync your feature branch with develop
- Write clear, descriptive branch names
- Test thoroughly before creating PRs
- Update documentation with code changes

### ❌ DON'T:
- Never commit directly to `main` or `develop`
- Don't create PRs from feature to main
- Avoid long-running feature branches (>1 week)
- Don't merge without PR reviews
- Never force push to shared branches

### 📝 Branch Naming Conventions:
- `feature/add-personas` - New features
- `fix/broken-test` - Bug fixes
- `hotfix/security-issue` - Emergency fixes
- `docs/update-readme` - Documentation only
- `refactor/cleanup-code` - Code improvements
- `test/add-coverage` - Test improvements

---

## Troubleshooting

### "I accidentally committed to main/develop"

```bash
# Save your work
git stash

# Create proper branch
git checkout -b feature/my-feature

# Apply your changes
git stash pop

# Reset main/develop
git checkout main  # or develop
git reset --hard origin/main  # or origin/develop
```

### "My feature branch has conflicts with develop"

```bash
# Update your branch
git checkout feature/my-feature
git fetch origin
git rebase origin/develop

# Resolve conflicts
# ... fix conflicts in files ...
git add .
git rebase --continue

# If things go wrong
git rebase --abort
```

### "I need to update my PR after review feedback"

```bash
# Make changes on your feature branch
git checkout feature/my-feature
# ... make changes ...
git add .
git commit -m "Address review feedback"
git push  # Updates the PR automatically
```

### "The CI is failing on my PR"

1. Check the workflow logs in GitHub Actions
2. Run tests locally: `npm test`
3. Run linting: `npm run lint`
4. Ensure you're up to date with develop
5. Check for Node version compatibility

---

## Automation & CI/CD

Our GitHub Actions handle:
- **On PR to develop**: Run tests, linting, security checks
- **On merge to develop**: Run integration tests
- **On PR to main**: Enforce branch rules, version checks
- **On tag push**: Auto-publish to NPM, create release

You don't need to worry about deployment - just follow the workflow!

---

## Examples

### Real-world Feature Branch

```bash
# Monday: Start feature
git checkout develop
git pull origin develop
git checkout -b feature/add-50-personas

# Tuesday: Add first batch
git add collection/library/teachers/*
git commit -m "Add 25 teacher personas"

# Wednesday: Stay updated
git fetch origin
git rebase origin/develop

# Thursday: Complete feature
git add collection/library/professionals/*
git commit -m "Add 25 professional personas"

# Friday: Create PR
git push -u origin feature/add-50-personas
gh pr create --base develop
```

### Real-world Hotfix

```bash
# Issue reported at 3 PM
git checkout main
git pull origin main
git checkout -b hotfix/fix-xss-vulnerability

# 3:30 PM: Fix implemented
git add src/security/validator.ts
git commit -m "Hotfix: Sanitize user input to prevent XSS"

# 3:45 PM: Version bump
npm version patch
git add package*.json
git commit -m "Bump version to 1.2.1"

# 4:00 PM: PR created and reviewed
git push -u origin hotfix/fix-xss-vulnerability
gh pr create --base main --title "URGENT: Fix XSS vulnerability"

# 4:30 PM: Merged and released!
```

---

## Questions?

- Check existing PRs for examples
- Ask in team Slack
- Review the [CONTRIBUTING.md](../../CONTRIBUTING.md) guide
- When in doubt, ask before merging!

---

*Remember: The goal is to keep main stable, develop integrated, and features isolated until ready.*