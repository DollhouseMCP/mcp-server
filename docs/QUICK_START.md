# Quick Start for Contributors

## 🚀 Getting Started in 5 Minutes

### 1. Find Work
```bash
# View high-priority issues
gh issue list --label "priority: high" --label "good first issue"

# Or use our management script
./scripts/project-management.sh
```

### 2. Claim an Issue
```bash
# Assign yourself
gh issue edit <ISSUE_NUMBER> --add-assignee @me

# Comment your plan
gh issue comment <ISSUE_NUMBER> --body "I'll work on this! Planning to..."
```

### 3. Start Working
```bash
# Create branch
git checkout -b fix/issue-<ISSUE_NUMBER>

# Make changes
# ... code ...

# Test locally
npm test
```

### 4. Submit PR
```bash
# Push changes
git push origin fix/issue-<ISSUE_NUMBER>

# Create PR
gh pr create --title "Fix: <description>" --body "Fixes #<ISSUE_NUMBER>"
```

## 📋 Issue Labels Guide

### Priority Labels (Choose One)
- 🔴 `priority: critical` - Drop everything
- 🟠 `priority: high` - Work on these first  
- 🟡 `priority: medium` - Normal priority
- 🟢 `priority: low` - When time permits

### Area Labels (Choose One)
- 🐳 `area: docker` - Containerization
- 🧪 `area: testing` - Test suite
- 🌐 `area: platform-compat` - Multi-platform
- 🏪 `area: marketplace` - GitHub marketplace
- 🎨 `area: ux` - User experience
- 🔒 `area: security` - Security issues

### Good Starting Points
- `good first issue` - Great for newcomers
- `help wanted` - We need help!
- `type: documentation` - Doc updates

## 🎯 Current Focus Areas

### v1.1.0 - CI/CD Reliability (Due: July 18)
- Fix Docker ARM64 issue (#28) - **HIGH PRIORITY**
- Add MCP integration tests (#29)
- Docker improvements (#33)

### v1.2.0 - Universal Platform Support (Due: Aug 15)
- Research platform compatibility (#30)
- Create universal installer (#32)

### v1.3.0 - Enhanced UX (Due: Sep 5)
- Persona active indicators (#31)
- Pre-prompt system
- Safety features

## 💡 Tips for Success

1. **Communicate Early** - Comment on issues before starting
2. **Ask Questions** - We're here to help!
3. **Test Thoroughly** - Run tests before submitting
4. **Small PRs** - Easier to review and merge
5. **Follow Style** - Match existing code patterns

## 🛠 Useful Commands

```bash
# Run project management script
./scripts/project-management.sh

# View your issues
gh issue list --assignee @me

# Check CI status
gh run list --limit 5

# View project board
gh browse --projects
```

## 📚 Resources

- [Contributing Guide](../CONTRIBUTING.md)
- [Project Setup](./PROJECT_SETUP.md)
- [Architecture Docs](../README.md)
- [Issue Templates](./.github/ISSUE_TEMPLATE/)

## ❓ Need Help?

- Check [Discussions](https://github.com/mickdarling/DollhouseMCP/discussions)
- Tag @mickdarling in issues/PRs
- Join our [Discord](#) (coming soon)

Welcome to DollhouseMCP! 🎭