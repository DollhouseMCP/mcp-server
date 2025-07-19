# DollhouseMCP Development Workflow

## Overview
This document defines the development workflow for DollhouseMCP to support multiple developers and maintain code quality.

## 🌳 Branch Strategy

### Main Branch Protection Rules
- **Protected branch**: `main`
- **Required status checks**: 
  - `core-build-test` (must pass)
  - `cross-platform-simple` (must pass)
- **Required reviews**: 1 approval for external contributors
- **Dismiss stale reviews**: When new commits are pushed
- **Include administrators**: No (allows quick fixes if needed)

### Branch Naming Conventions
- `feature/` - New features (e.g., `feature/universal-installer`)
- `fix/` - Bug fixes (e.g., `fix/arm64-docker-build`)
- `docs/` - Documentation updates (e.g., `docs/update-readme`)
- `test/` - Test additions/improvements (e.g., `test/mcp-protocol-integration`)
- `refactor/` - Code refactoring (e.g., `refactor/simplify-personas-loading`)

## 📋 Issue Management

### Creating Issues
1. Use issue templates in `.github/ISSUE_TEMPLATE/`
2. Apply appropriate labels:
   - Priority: `priority: critical`, `priority: high`, `priority: medium`, `priority: low`
   - Area: `area: docker`, `area: testing`, `area: ux`, `area: marketplace`, `area: platform-compat`, `area: core`
   - Type: `bug`, `enhancement`, `type: research`, `type: task`
   - Examples: `area: core` for MCP server changes, `area: ux` for interface improvements
3. Assign to milestone if applicable
4. Link to project board

### Working on Issues
1. **Assign yourself** to the issue
2. **Create a branch** from main:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feature/issue-number-description
   ```
3. **Update issue status** in project board to "In Progress"
4. **Make commits** with clear messages referencing the issue:
   ```bash
   git commit -m "feat: implement universal installer (#32)"
   ```

## 🔄 Pull Request Process

### Creating a PR
1. **Push your branch**:
   ```bash
   git push origin feature/your-branch-name
   ```
2. **Create PR via GitHub CLI**:
   ```bash
   gh pr create --title "feat: implement universal installer" \
     --body "Closes #32\n\n## Summary\n- Added universal installer script\n- Supports Windows, macOS, Linux\n\n## Test Plan\n- [ ] Tested on Windows 11\n- [ ] Tested on macOS 14\n- [ ] Tested on Ubuntu 22.04"
   ```
3. **Link to issue**: Use "Closes #XX" in PR description
4. **Request review**: Tag relevant developers

### PR Requirements
- **All CI checks must pass**
- **Code review approval required** (except for admin emergency fixes)
- **Update documentation** if adding/changing features
- **Add tests** for new functionality
- **Follow existing code style**

### Commit Message Format
Follow conventional commits:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `test:` - Tests only
- `refactor:` - Code refactoring
- `style:` - Formatting changes
- `ci:` - CI/CD changes
- `chore:` - Maintenance tasks

## 🧪 Testing Requirements

### Before Creating PR
1. **Run local tests**:
   ```bash
   npm test              # Run all tests
   npm run test:coverage # Run tests with coverage report
   npm run build         # Build TypeScript
   ```
2. **Test Docker build** if changes affect containerization:
   ```bash
   docker build -t dollhousemcp-test .
   ```
3. **Verify persona functionality** if changes affect core features

### CI/CD Checks
The following workflows run automatically:
- **Core Build & Test** - TypeScript compilation and unit tests
- **Cross-Platform Simple** - Basic multi-OS validation
- **Docker Testing** - Container build and runtime tests
- **Claude Code Review** - AI-powered code review (on request)

## 🚀 Release Process

### Version Numbering
Follow semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR**: Breaking changes
- **MINOR**: New features (backwards compatible)
- **PATCH**: Bug fixes

### Creating a Release
1. **Update version** in `package.json`
2. **Update CHANGELOG.md** with release notes
3. **Create release PR** to main
4. **After merge**, create GitHub release:
   ```bash
   gh release create v1.1.0 --title "v1.1.0 - CI/CD Reliability" \
     --notes "## Highlights\n- Fixed ARM64 Docker builds\n- Added MCP protocol tests\n\n## Full Changelog\n..."
   ```

## 👥 Collaboration Guidelines

### Code Reviews
- **Be constructive** and suggest improvements
- **Test locally** when reviewing complex changes
- **Check for**:
  - Security issues
  - Performance impacts
  - Documentation updates
  - Test coverage

### Communication
- **GitHub Issues**: Primary discussion for features/bugs
- **Pull Requests**: Code-specific discussions
- **Project Board**: Track overall progress

### Getting Help
- Check existing documentation in `/docs`
- Search closed issues for similar problems
- Ask in PR/issue comments
- Tag `@mickdarling` for critical decisions

## 🔒 Security Guidelines

### Never Commit
- Secrets, tokens, or API keys
- Personal information
- Large binary files
- Generated files (use .gitignore)

### Dependency Updates
- Review security advisories
- Test thoroughly after updates
- Document breaking changes

## 📝 Documentation Standards

### When to Update Docs
- Adding new features
- Changing existing behavior
- Fixing confusing documentation
- Adding examples

### Documentation Locations
- **README.md**: User-facing features
- **docs/**: Technical documentation
- **Code comments**: Implementation details
- **CLAUDE.md**: AI context information

## 🚨 Emergency Procedures

### Hotfix Process
1. Create branch from main: `hotfix/critical-issue`
2. Make minimal fix
3. Create PR with `priority: critical` label
4. Get expedited review
5. Merge and deploy immediately

### Rollback Process
1. Identify problematic commit
2. Create revert PR:
   ```bash
   git revert <commit-hash>
   gh pr create --title "revert: problematic feature" --label "priority: critical"
   ```
3. Merge after CI passes

## 📊 Useful Commands

### GitHub CLI Shortcuts
```bash
# View your assigned issues
gh issue list --assignee @me

# View PR status
gh pr status

# Check workflow runs
gh workflow list
gh run list --workflow=core-build-test.yml

# Review a PR
gh pr review --approve
gh pr review --comment -b "Looks good, but consider..."
gh pr review --request-changes -b "Please address..."
```

### Project Management
```bash
# Use project management scripts
./scripts/project-management.sh
./scripts/link-issues-to-project.sh
```

---

**Last Updated**: July 2025
**Review Date**: July 2026
**Maintainer**: @mickdarling