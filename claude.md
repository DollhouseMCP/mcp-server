# Claude Context: DollhouseMCP MCP Server

## 🚨 Directory Context

**YOU ARE IN: /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server**

Always verify with `pwd` if unsure. This is the main MCP server repository.

## Quick Reference

### Essential Documentation

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** - Development workflow, setup, architecture, and PR guidelines
- **[docs/CONVENTIONS.md](./docs/CONVENTIONS.md)** - Naming standards and style guide
- **[docs/development/SESSION_MANAGEMENT.md](./docs/development/SESSION_MANAGEMENT.md)** - Session workflow, note-taking, and continuity strategy
- **[docs/development/GITFLOW_GUARDIAN.md](./docs/development/GITFLOW_GUARDIAN.md)** - Git workflow enforcement
- **[docs/development/PR_BEST_PRACTICES.md](./docs/development/PR_BEST_PRACTICES.md)** - Quality PR creation
- **[docs/development/SECURITY_FIX_DOCUMENTATION_PROCEDURE.md](./docs/development/SECURITY_FIX_DOCUMENTATION_PROCEDURE.md)** - Fix documentation patterns

### Project Information

**Repository**: <https://github.com/DollhouseMCP/mcp-server>
**NPM Package**: @dollhousemcp/mcp-server
**License**: AGPL-3.0 with Platform Stability Commitments

### Key Commands

```bash
# Development
npm run dev          # Development mode with watch
npm run build        # Build TypeScript
npm test            # Run all tests

# Git Operations
git checkout develop                    # Switch to develop
git checkout -b feature/new-feature     # Create feature branch
gh pr create --base develop             # Create PR to develop

# Check project status
gh issue list --limit 20               # View open issues
gh pr list                             # View open PRs
```

## GitFlow Workflow

This project uses GitFlow branching:

- `main` - Production code
- `develop` - Integration branch
- `feature/*` - New features (branch from develop)
- `fix/*` - Bug fixes (branch from develop)
- `hotfix/*` - Emergency production fixes (branch from main)

**Known Issue: GitFlow Guardian False Positive**

When creating a feature branch from develop, GitFlow Guardian may incorrectly warn you're on the wrong branch. This is a known bug - verify you branched from develop correctly and proceed.

See [GITFLOW_GUARDIAN.md](./docs/development/GITFLOW_GUARDIAN.md) for complete workflow details.

## Session Management

For development session continuity, see [SESSION_MANAGEMENT.md](./docs/development/SESSION_MANAGEMENT.md).

**Quick reference:**

- Create session notes in `docs/development/SESSION_NOTES_YYYY-MM-DD-{TOPIC}.md`
- Mirror to memory system using MCP tools (see SESSION_MANAGEMENT.md for workflow)
- Session notes are source of truth, memory is backup

## Common Tasks

### Starting Development

1. Ensure you're on the latest develop: `git checkout develop && git pull`
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes and test: `npm test`
4. Commit following conventions: See [CONVENTIONS.md](./docs/CONVENTIONS.md)
5. Push and create PR: `gh pr create --base develop`

### Running Tests

```bash
npm test                    # All tests with coverage
npm test -- --no-coverage   # Skip coverage
npm run test:watch          # Watch mode
npm run security:all        # Security test suite
```

### Creating Issues

Always check available labels first:

```bash
gh label list --limit 100 --json name --jq '.[].name'
```

Only use labels that exist in the repository.

## Quality Requirements

- Test coverage: >96% required
- All PRs require review
- CI checks must pass
- Documentation required with changes

## Getting Help

- Check documentation in `docs/` directory first
- Search closed issues for similar problems
- Review `CONTRIBUTING.md` for development guidelines
- Tag @mickdarling in issues/PRs if stuck

---

*For detailed development information, see the documentation links above.*
