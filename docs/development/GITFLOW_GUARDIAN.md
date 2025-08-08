# GitFlow Guardian 🛡️

## Overview

GitFlow Guardian is a set of Git hooks that enforce GitFlow best practices and prevent common workflow violations. It acts as your personal GitFlow assistant, watching your Git operations and providing real-time feedback.

## Features

### 🚫 Prevents Direct Commits to Protected Branches
- Blocks commits to `main`/`master` and `develop`
- Forces use of feature branches
- Provides emergency bypass option (`--no-verify`)

### 📝 Enforces Branch Naming Conventions
- Validates branch names follow GitFlow patterns
- Suggests proper prefixes (feature/, fix/, hotfix/, etc.)
- Warns about non-standard branch names

### 💡 Provides Context-Aware Reminders
- Shows helpful messages when switching branches
- Reminds about branch-specific rules
- Displays current branch status

## Installation

### Quick Setup
```bash
# From repository root
./scripts/setup-gitflow-guardian.sh
```

### Manual Setup
```bash
# Configure Git to use our hooks directory
git config core.hooksPath .githooks

# Make hooks executable
chmod +x .githooks/pre-commit
chmod +x .githooks/post-checkout
```

### Verify Installation
```bash
# Check if hooks are configured
git config core.hooksPath
# Should output: .githooks
```

## Configuration

GitFlow Guardian can be customized via the `.githooks/config` file. This file allows you to:

- Define which branches are protected
- Specify allowed branch prefixes
- Control display settings
- Enable/disable hooks

### Configuration Options

```bash
# .githooks/config

# Protected branches that cannot receive direct commits
PROTECTED_BRANCHES=("main" "master" "develop")

# Allowed branch prefixes
ALLOWED_PREFIXES=("feature" "fix" "bugfix" "hotfix" "release" "docs" "test" "chore")

# Minimum branch name length after prefix
MIN_NAME_LENGTH=1

# Maximum branch name display length
MAX_DISPLAY_LENGTH=50

# Enable/disable colored output
USE_COLORS=true

# Enable/disable checkout messages
SHOW_CHECKOUT_MESSAGES=true

# Enable/disable commit protection
ENABLE_COMMIT_PROTECTION=true
```

## How It Works

### Pre-Commit Hook
Runs before every commit to check:
1. Are you on a protected branch (main/develop)?
2. Does your branch follow naming conventions?

If on a protected branch, the commit is blocked with this message:

```
╔════════════════════════════════════════════════════════════════╗
║                   🚨 GITFLOW VIOLATION DETECTED 🚨              ║
╠════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  You are attempting to commit directly to: develop              ║
║                                                                  ║
║  This violates GitFlow best practices!                          ║
```

### Post-Checkout Hook
Runs after switching branches to provide:
- Branch-specific reminders
- GitFlow best practices for that branch type
- Current status information

## Branch Types and Rules

### Protected Branches (No Direct Commits)
- `main` / `master` - Production code
- `develop` - Integration branch

### Feature Branches
- Pattern: `feature/*`
- Purpose: New features
- Merges to: `develop`

### Fix Branches
- Pattern: `fix/*` or `bugfix/*`
- Purpose: Bug fixes
- Merges to: `develop`

### Hotfix Branches
- Pattern: `hotfix/*`
- Purpose: Urgent production fixes
- Merges to: `main` AND `develop`

### Release Branches
- Pattern: `release/*`
- Purpose: Release preparation
- Merges to: `main` AND `develop`

### Other Accepted Prefixes
- `docs/*` - Documentation changes
- `test/*` - Test additions/fixes
- `chore/*` - Maintenance tasks
- `refactor/*` - Code refactoring

## Common Scenarios

### Scenario 1: Accidentally on develop
```bash
$ git commit -m "Add new feature"
# ❌ BLOCKED: Cannot commit to develop
# ✅ Solution: git checkout -b feature/my-feature
```

### Scenario 2: Emergency hotfix
```bash
$ git checkout main
$ git commit -m "Critical fix" --no-verify
# ⚠️ Bypasses protection (use sparingly!)
```

### Scenario 3: Creating a feature
```bash
$ git checkout -b feature/awesome-feature
# ✅ Shows: "You can safely commit here!"
$ git commit -m "Add awesome feature"
# ✅ Commit succeeds
```

## Disabling GitFlow Guardian

### Temporarily (Single Commit)
```bash
git commit --no-verify -m "Emergency: reason"
```

### For Current Repository
```bash
git config --unset core.hooksPath
```

### Globally (All Repositories)
```bash
git config --global --unset core.hooksPath
```

## Troubleshooting

### Hooks Not Running
```bash
# Check hooks path
git config core.hooksPath

# Ensure hooks are executable
chmod +x .githooks/*

# Re-run setup
./scripts/setup-gitflow-guardian.sh
```

### Want Different Protected Branches
Edit `.githooks/pre-commit` line 26:
```bash
if [[ "$BRANCH" == "main" ]] || [[ "$BRANCH" == "master" ]] || [[ "$BRANCH" == "develop" ]]; then
```

### Need Additional Branch Prefixes
Edit `.githooks/pre-commit` line 64:
```bash
if [[ ! "$BRANCH" =~ ^(feature|fix|bugfix|hotfix|release|support|docs|test|chore|refactor)/.+ ]]; then
```

## Benefits

1. **Prevents Mistakes**: No more accidental commits to main
2. **Enforces Standards**: Consistent branch naming across team
3. **Educational**: Teaches GitFlow through helpful messages
4. **Flexible**: Can be bypassed when truly necessary
5. **Lightweight**: Simple bash scripts, no dependencies

## For CI/CD Integration

These hooks only run locally. For CI/CD protection:
1. Use GitHub branch protection rules
2. Require pull request reviews
3. Set up status checks
4. Disable direct pushes

## Contributing

To improve GitFlow Guardian:
1. Edit hooks in `.githooks/`
2. Test locally
3. Submit PR with changes
4. Update this documentation

## FAQ

**Q: Can I still push to develop?**
A: The hooks only prevent local commits. Use PRs for develop.

**Q: What about merge commits?**
A: Merge commits are typically allowed as they come from PRs.

**Q: Can this break my workflow?**
A: No, you can always bypass with `--no-verify` if needed.

**Q: Do teammates need to install this?**
A: It's recommended but not required. Each developer installs locally.

---

*GitFlow Guardian - Your friendly neighborhood Git workflow enforcer!* 🦸‍♂️