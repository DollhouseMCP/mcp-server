# GitFlow Guardian Hooks - Quick Reference

## 🚨 IMPORTANT: Git Hooks Location
**The Git hooks are in `.githooks/` directory, NOT `.git/hooks/`**

This is configured via:
```bash
git config core.hookspath .githooks
```

## Hook Files

### Location: `.githooks/`
```
.githooks/
├── config                  # Configuration file for hooks
├── post-checkout          # Shows messages when switching branches ✅
├── pre-commit            # Runs before commits
├── gh-pr-create-wrapper  # Wraps PR creation
└── setup-pr-wrapper      # PR setup helper
```

## How the GitFlow Guardian Works

### 1. Post-Checkout Hook (`.githooks/post-checkout`)
This is what shows the colored messages when you switch branches:
- 🔴 RED box for `main` branch
- 🟡 YELLOW box for `develop` branch  
- 🟢 GREEN box for `feature/*` branches
- 🔵 BLUE box for `release/*` branches
- 🟠 ORANGE box for `hotfix/*` branches

### 2. Current Functionality
- Shows helpful reminders when switching branches
- Displays branch-specific guidelines
- Uses colors to indicate branch type

### 3. What It DOESN'T Do Yet
- ❌ Doesn't prevent creating feature branches from main
- ❌ Doesn't warn when a feature branch is created from the wrong parent
- ❌ Doesn't ask for confirmation when switching to main

## GitFlow Rules

### Branches That Can Be Created From Main
✅ **Allowed from main:**
- `hotfix/*` - Emergency fixes
- `release/*` - Release candidates (though usually from develop)

❌ **NOT allowed from main:**
- `feature/*` - Must be created from develop
- `bugfix/*` - Must be created from develop

### Branches That Can Merge TO Main
✅ **Can merge to main:**
- `develop` - For releases
- `hotfix/*` - For emergency fixes
- `release/*` - For release candidates

❌ **Cannot merge to main:**
- `feature/*` - Must go through develop first
- `bugfix/*` - Must go through develop first

## How to Test/Debug Hooks

### Check if hooks are active:
```bash
git config core.hookspath
# Should output: .githooks
```

### Test post-checkout hook:
```bash
# Switch branches to see the messages
git checkout develop
git checkout main
git checkout -b feature/test
```

### View hook output:
The colored boxes you see when switching branches come from `.githooks/post-checkout`

## Finding This Information Again

**Keywords for searching:**
- GitFlow Guardian
- .githooks directory
- post-checkout hook
- colored branch messages
- "You are on a FEATURE branch"
- core.hookspath

**Quick command to verify:**
```bash
ls -la .githooks/
```

## Enhancements Needed

1. **Detect Wrong Parent Branch**
   - When creating `feature/*` from main, show warning
   - Suggest switching to develop first

2. **Main Branch Warning**
   - When switching to main, ask "Are you sure?"
   - Remind about GitFlow rules

3. **Pre-push Hook**
   - Prevent pushing feature branches that would create PRs to main

---
*Last Updated: August 11, 2025*
*This is THE reference for finding and understanding the GitFlow Guardian hooks*