# Claude Project Context: DollhouseMCP MCP Server

## 🚨 IMPORTANT: Directory Context
**YOU ARE IN: /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server**
- Always verify with `pwd` if unsure
- This is the main MCP server repository
- NOT experimental-server, NOT AILIS

## Project Overview

DollhouseMCP is a professional Model Context Protocol (MCP) server that enables dynamic AI customization through modular elements. It allows AI assistants to activate and switch between different behavioral personas, skills, memories, and other elements.

**Repository**: https://github.com/DollhouseMCP/mcp-server
**Collection**: https://github.com/DollhouseMCP/collection
**NPM Package**: @dollhousemcp/mcp-server
**License**: AGPL-3.0 with Platform Stability Commitments
**Current Version**: v1.9.12

## Key Documentation References

### Essential Guides
- `docs/development/GITFLOW_GUARDIAN.md` - Git workflow enforcement
- `docs/development/PR_BEST_PRACTICES.md` - Quality PR creation
- `docs/development/SECURITY_FIX_DOCUMENTATION_PROCEDURE.md` - Fix documentation patterns
- `docs/development/BRANCH_PROTECTION_CONFIG.md` - CI requirements
- `docs/development/ELEMENT_IMPLEMENTATION_GUIDE.md` - Element system reference

## GitFlow Guardian 🛡️

**IMPORTANT: Git hooks are in `.githooks/` directory, NOT `.git/hooks/`**
- Configured via: `git config core.hookspath .githooks`
- Pre-commit: Prevents commits to protected branches (main/develop)
- Post-checkout: Shows branch-specific warnings
- Pre-push: Blocks pushing feature branches created from main

**Emergency Override**:
```bash
git commit --no-verify -m "Emergency: reason"
SKIP_GITFLOW_CHECK=1 git push
```

**Known Bug**: False positive when creating feature branch from develop - verify you branched correctly and proceed.

## Core Architecture

### MCP Server Implementation
- **Transport**: StdioServerTransport (standard I/O for MCP integration)
- **Protocol**: JSON-RPC 2.0 communication
- **Tools**: 41+ MCP tools for element management
- **Entry Point**: `src/index.ts` - Main server class is `DollhouseMCPServer`

### Key Components
- **Element System** (`src/elements/`): Base classes and managers for all element types
- **Portfolio Manager** (`src/portfolio/`): Local storage and GitHub sync
- **Security Layer** (`src/security/`): Input validation, path security, YAML parsing
- **Collection System** (`src/collection/`): Community element browsing and installation
- **Auth Manager** (`src/auth/`): GitHub OAuth and token management

### Data Flow
1. Client Request → MCP Server (StdioServerTransport)
2. Tool Routing → Appropriate handler in DollhouseMCPServer
3. Element Processing → Element-specific manager (PersonaManager, SkillManager, etc.)
4. Storage → PortfolioManager (local files or GitHub sync)
5. Response → Client via JSON-RPC

## Element System Architecture

### Supported Element Types
- **Personas** - AI behavioral profiles
- **Skills** - Discrete capabilities
- **Templates** - Reusable content structures
- **Agents** - Goal-oriented decision makers
- **Memories** - Persistent context storage
- **Ensembles** - Combined element orchestration

### Portfolio Structure
```
~/.dollhouse/portfolio/
├── personas/         # Markdown files with YAML frontmatter
├── skills/           # Markdown files with YAML frontmatter
├── templates/        # Markdown files with YAML frontmatter
├── agents/           # Markdown files with YAML frontmatter
├── memories/         # YAML files organized by date
│   ├── 2025-09-18/   # Automatic YYYY-MM-DD folder structure
│   │   └── project-context.yaml
│   └── 2025-09-19/
│       ├── meeting-notes.yaml
│       └── code-review.yaml
└── ensembles/        # Markdown files with YAML frontmatter (NOT YET LIVE)
```

**Note**: Memories use YAML format exclusively (not Markdown) and are organized in date-based folders to prevent flat directory performance issues. Ensembles are under development and not yet functional.

## Development Workflow

### Branch Strategy
- `main` - Production code
- `develop` - Integration branch
- `feature/*` - New features
- `fix/*` - Bug fixes
- `hotfix/*` - Emergency production fixes

### Quality Requirements
- Test coverage: >96% required
- All PRs require review
- CI checks must pass
- Documentation required with changes

### Fix Documentation Pattern
```typescript
/**
 * Component description
 *
 * FIXES IMPLEMENTED (PR #XXX):
 * 1. CRITICAL: [Issue] - [Solution]
 * 2. HIGH: [Issue] - [Solution]
 * 3. BUG FIX: [Problem] - [Resolution]
 */

// At fix location:
// FIX: [Description]
// Previously: [old behavior]
// Now: [new behavior]
```

## Session Management

### Dual Approach (Belt & Suspenders)
1. **Session Notes**: `docs/development/SESSION_NOTES_[DATE].md`
2. **Memory System**: Mirror content to dollhouse memories
3. **Source of Truth**: Session notes (memory is backup)

## Testing & CI

### Run Tests
```bash
# All tests
npm test

# Without coverage
npm test -- --no-coverage

# Run a single test file
npm test -- path/to/test.test.ts

# Run tests matching a pattern
npm test -- --testNamePattern="Memory"

# Watch mode
npm run test:watch

# Integration and E2E tests
npm run test:integration
npm run test:e2e

# Security-specific tests
npm run security:critical     # Critical security tests only
npm run security:rapid        # Quick security validation
npm run security:all          # Full security test suite
```

### Required CI Checks
1. Test (ubuntu/windows/macos, Node 20.x)
2. Docker Build & Test (linux/amd64, linux/arm64)
3. Docker Compose Test
4. Validate Build Artifacts

## Common Commands

```bash
# Development
npm run dev          # Development mode with watch
npm run build        # Build TypeScript
npm run clean        # Clean build artifacts

# Testing
npm test            # Run all tests
npm run lint        # Check code style
npm run typecheck   # TypeScript type checking

# Git Operations
git checkout develop                    # Switch to develop
git checkout -b feature/new-feature     # Create feature branch
gh pr create --base develop             # Create PR to develop

# Check Status
gh issue list --limit 20               # View open issues
gh pr list                             # View open PRs
```

## Security & Best Practices

### Security Policy
- Fix security issues immediately (same session)
- No deferring to "someone else later"
- Create issues for tracking but fix critical items now
- Document all fixes thoroughly

### PR Best Practices
- Push code + description together
- Include commit SHA in comments
- Create follow-up issues for suggestions
- Reference specific changes in PR updates

## Important Reminders

1. **Always verify directory**: Use `pwd` before making changes
2. **Security first**: Fix issues immediately, don't defer
3. **Documentation required**: Every fix needs inline comments
4. **Test everything**: Maintain >96% coverage
5. **Use GitFlow**: Follow branch strategy consistently

---

*This document provides essential context for working in the mcp-server repository.*
*Last verified: September 29, 2025 (v1.9.12)*