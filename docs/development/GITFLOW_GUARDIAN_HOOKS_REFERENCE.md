# GitFlow Guardian Hooks Reference

## Quick Status Check

```bash
# Check if hooks are active
git config core.hooksPath
# Should output: .githooks

# List active hooks
ls -la .githooks/
```

## Hook Files

### 1. Pre-Commit Hook (`.githooks/pre-commit`)
**Purpose**: Prevents direct commits to protected branches

**Protected Branches**:
- main / master
- develop

**Behavior**:
- Blocks commits to protected branches
- Validates branch naming conventions
- Shows GitFlow violation warning

**Override**: `git commit --no-verify -m "Emergency: reason"`

### 2. Post-Checkout Hook (`.githooks/post-checkout`)
**Purpose**: Provides branch-specific guidance and warnings

**Features** (Enhanced Aug 11, 2025):
- Detects feature branches created from main
- Shows enhanced warning when on main branch
- Provides context-aware suggestions
- Color-coded messages by branch type

**Branch Types**:
- **Red**: main/master (production)
- **Yellow**: develop (integration)
- **Green**: feature/* (safe to commit)
- **Blue**: fix/bugfix/* (bug fixes)
- **Red**: hotfix/* (urgent fixes)
- **Cyan**: release/* (release prep)

### 3. Pre-Push Hook (`.githooks/pre-push`) 
**Purpose**: Prevents pushing feature branches created from main

**Created**: Aug 11, 2025

**Detection Logic**:
- Checks merge base with main vs develop
- Blocks push if feature branch originated from main
- Provides fix instructions

**Override**: `SKIP_GITFLOW_CHECK=1 git push`

### 4. PR Creation Wrapper (`.githooks/gh-pr-create-wrapper`)
**Purpose**: Prevents creating PRs to wrong branches

**Setup Required**: `./.githooks/setup-pr-wrapper`

**Blocks**:
- feature/* → main (should go to develop)
- fix/* → main (should go to develop)

## Configuration File (`.githooks/config`)

```bash
# Protected branches
PROTECTED_BRANCHES=("main" "master" "develop")

# Allowed prefixes
ALLOWED_PREFIXES=("feature" "fix" "bugfix" "hotfix" "release" "docs" "test" "chore")

# Display settings
USE_COLORS=true
SHOW_CHECKOUT_MESSAGES=true
MAX_DISPLAY_LENGTH=50

# Protection settings
ENABLE_COMMIT_PROTECTION=true
ENABLE_PUSH_PROTECTION=true
ENFORCE_GITFLOW=true
```

## Common Scenarios

### Creating a Feature Branch (Correct Way)
```bash
git checkout develop
git pull origin develop
git checkout -b feature/my-feature
# Work and commit normally
git push -u origin feature/my-feature
gh pr create --base develop
```

### Creating a Feature Branch (Wrong Way - Now Blocked)
```bash
git checkout main  # ⚠️ Warning shown
git checkout -b feature/my-feature  # ⚠️ Warning about wrong parent
git push  # ❌ BLOCKED by pre-push hook
```

### Emergency Hotfix
```bash
git checkout main
git checkout -b hotfix/critical-fix  # ✅ Allowed from main
git commit -m "Fix critical issue"
git push -u origin hotfix/critical-fix
gh pr create --base main  # ✅ Hotfixes can go to main
```

### Bypass for Emergency
```bash
# Skip commit protection
git commit --no-verify -m "Emergency: [reason]"

# Skip push protection  
SKIP_GITFLOW_CHECK=1 git push

# Both bypasses
git commit --no-verify -m "Emergency fix"
SKIP_GITFLOW_CHECK=1 git push
```

## Troubleshooting

### Hooks Not Running
```bash
# Verify configuration
git config core.hooksPath

# Set hooks path
git config core.hooksPath .githooks

# Make executable
chmod +x .githooks/*
```

### False Positive on Branch Detection
The detection logic may show false positives if:
- Branch has been rebased
- Develop and main have diverged significantly
- Branch was created before hooks were installed

Use `SKIP_GITFLOW_CHECK=1` if you're certain the branch is correct.

### Want to Disable Temporarily
```bash
# For current repo
git config --unset core.hooksPath

# Re-enable
git config core.hooksPath .githooks
```

## Testing the Hooks

### Test Pre-Commit
```bash
git checkout develop
echo "test" > test.txt
git add test.txt
git commit -m "Test commit"
# Should see: "GITFLOW VIOLATION DETECTED"
```

### Test Post-Checkout
```bash
git checkout main
# Should see enhanced warning with suggestions

git checkout -b feature/test
# Should see warning if created from main
```

### Test Pre-Push
```bash
# From main
git checkout main
git checkout -b feature/test-block
git push -u origin feature/test-block
# Should see: "PUSH BLOCKED"
```

## Recent Updates (Aug 11, 2025)

### Problem Addressed
- PR #575 was created from main instead of develop
- Had to be closed and recreated as PR #576
- Wasted time and effort

### Solutions Implemented
1. **Enhanced main branch warning** - Makes it clear you shouldn't be there
2. **Feature branch detection** - Warns when branch created from wrong parent
3. **Pre-push protection** - Blocks pushing before it gets to PR stage

### Benefits
- Catches mistakes earlier (push vs PR)
- Educates developers on proper flow
- Reduces rework and rejected PRs
- Maintains clean git history

## Integration with CI/CD

These hooks are LOCAL only. For complete protection:

1. **GitHub Branch Protection** (already enabled)
   - Requires PR reviews
   - Status checks must pass
   - No direct pushes to main/develop

2. **GitHub Actions** (already implemented)
   - Validates PR base branch
   - Runs tests before merge
   - Enforces code quality

3. **GitFlow Guardian** (these hooks)
   - First line of defense
   - Immediate feedback
   - Education through messages

## Files Involved

```
.githooks/
├── config                  # Configuration
├── pre-commit             # Commit protection
├── post-checkout          # Branch warnings (enhanced)
├── pre-push              # Push protection (new)
├── gh-pr-create-wrapper  # PR creation protection
└── setup-pr-wrapper      # Setup script

docs/development/
├── GITFLOW_GUARDIAN.md    # Full documentation
└── GITFLOW_GUARDIAN_HOOKS_REFERENCE.md  # This quick reference
```

---

*Last Updated: August 11, 2025 - Added pre-push hook and enhanced warnings*