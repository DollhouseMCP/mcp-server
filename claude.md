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
- **`docs/development/SONARCLOUD_QUERY_PROCEDURE.md` - CRITICAL: How to query SonarCloud correctly**

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

## Naming Conventions & Style Guide

### Session Note Memories (in `~/.dollhouse/portfolio/memories/`)

**Format**: `session-YYYY-MM-DD-{timeofday}-{topic-summary}-{qualifier}`

**Components**:
- **Prefix**: Always `session-` (identifies as session notes)
- **Date**: ISO format `YYYY-MM-DD` (sortable, unambiguous)
- **Time of Day**: `morning`, `afternoon`, `evening`, `late-evening`
- **Topic**: Brief hyphenated summary of main focus (e.g., `issue-1211`, `v1913-release`, `sonarcloud-fixes`)
- **Qualifier** (optional): Additional context like `context`, `investigation`, `complete`, `status`

**Examples**:
```yaml
# Good examples:
session-2025-09-30-morning-issue-1211-and-1213-context.yaml
session-2025-09-29-evening-v1913-release.yaml
session-2025-09-27-afternoon-sonarcloud-fixes.yaml
session-2025-09-26-late-evening-docker-testing.yaml

# Bad examples (too generic):
session-2025-09-30.yaml                    ❌ No topic
session-morning-work.yaml                  ❌ No date
morning-session.yaml                       ❌ Wrong order, no date
sep-30-notes.yaml                          ❌ Non-ISO date
```

**Required Fields**:
```yaml
name: session-2025-09-30-morning-issue-1211-and-1213-context
description: Session work on Issue 1211 (fixed and merged) plus comprehensive investigation context for Issue 1213 memory loading bug
version: 1.0.0
retention: permanent  # Session notes should persist
tags:
  - session-notes      # ALWAYS include this tag
  - issue-1211         # Specific topics
  - issue-1213
  - memory-loading     # Technical areas
  - investigation-context  # Context type
```

**Search Flexibility**:
- By date: `2025-09-30`
- By time: `morning`, `afternoon`, `evening`
- By topic: `issue-1211`, `memory-loading`, `sonarcloud`
- By type: `session-notes` (tag)
- Full name: `session-2025-09-30-morning-issue-1211`

---

### Session Note Documents (in `docs/development/`)

**Format**: `SESSION_NOTES_YYYY-MM-DD-{TOPIC}.md`

**Components**:
- **Prefix**: Always `SESSION_NOTES_` (ALL CAPS for visibility)
- **Date**: ISO format `YYYY-MM-DD`
- **Topic**: ALL_CAPS_WITH_UNDERSCORES describing main focus

**Examples**:
```markdown
# Good examples:
SESSION_NOTES_2025-09-30-MORNING-ISSUE-1211.md
SESSION_NOTES_2025-09-29-EVENING-RELEASE.md
SESSION_NOTES_2025-09-27-SONARCLOUD-FIXES.md
SESSION_NOTES_2025-09-26-AFTERNOON.md        # Generic time is OK if no specific topic

# Bad examples:
session_notes_2025-09-30.md                  ❌ Not all caps
Session-Notes-Sep-30.md                      ❌ Non-ISO date
2025-09-30-notes.md                          ❌ Missing prefix
notes.md                                     ❌ Not descriptive
```

**File Structure**:
```markdown
# Session Notes - [Full Date]

**Date**: September 30, 2025
**Time**: 10:15 AM - 11:00 AM (45 minutes)
**Focus**: [Main objective]
**Outcome**: ✅ [Result]

## Session Summary
[Overview]

## [Work sections...]

## Key Learnings
[Technical and process insights]

## Next Session Priorities
[Clear handoff for next session]
```

---

### Memory Naming (General Guidelines)

**Topic-Based Memories**:
```yaml
# Format: {topic}-{subtopic}-{descriptor}
sonarcloud-rules-reference.yaml
sonarcloud-api-reference.yaml
project-context-v195.yaml
security-audit-process.yaml
```

**Technical Memories**:
```yaml
# Format: {system}-{component}-{purpose}
memory-auto-repair-mechanism.yaml
git-workflow-guidelines.yaml
docker-build-optimization.yaml
```

**Avoid**:
- Random IDs: `mem_1759077319164_w9m9fk56y` ❌
- Generic names: `notes.yaml`, `temp.yaml` ❌
- Dates without topics: `2025-09-30.yaml` ❌
- Unclear abbreviations: `sc-ref.yaml` ❌

---

### Tag Guidelines

**Always Include**:
- Content type: `session-notes`, `reference`, `guide`, `context`
- Main topics: `issue-1211`, `memory-system`, `security`
- Technical areas: `docker`, `testing`, `ci-cd`

**Tag Format**:
- Use lowercase with hyphens: `session-notes`, `issue-1211`
- Be specific: `sonarcloud-fixes` not just `fixes`
- Include issue numbers: `issue-1211`, `pr-1212`
- Add context type: `investigation-context`, `release-notes`

**Example Tag Set**:
```yaml
tags:
  - session-notes          # Content type
  - issue-1211             # Specific issue
  - security               # Technical area
  - false-positives        # Specific problem
  - investigation-context  # Context type
  - pr-1212               # Related PR
```

---

### Description Best Practices

**Good Descriptions**:
- Start with action or summary: "Session work on...", "Reference for...", "Guide to..."
- Include key outcomes: "(fixed and merged)", "(investigation needed)"
- Be specific about scope: "Issue 1211" not just "bug fix"
- Mention next steps if relevant: "ready for next session", "needs investigation"

**Examples**:
```yaml
# Good:
description: Session work on Issue 1211 (fixed and merged) plus comprehensive investigation context for Issue 1213 memory loading bug

description: Complete reference for SonarCloud rules, patterns, and fixes - instant lookup for rule IDs and remediation strategies

description: Evening session completing PR #1106 and fixing CI failures from EnhancedIndexManager and Docker Hub authentication

# Bad:
description: Session notes                    ❌ Too generic
description: Fixed stuff                      ❌ No specifics
description: 2025-09-30                       ❌ Just a date
```

---

### Why These Conventions Matter

1. **Searchability**: Find memories by date, time, topic, or any combination
2. **Chronological Sorting**: ISO dates ensure proper ordering
3. **Context Clarity**: Topic in name means you know what it is before opening
4. **Future Proofing**: Consistent naming scales as memory count grows
5. **Progressive Specificity**: Search broadly or narrowly as needed
6. **Documentation**: Names serve as table of contents for session history

---

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

## Creating GitHub Issues

**ALWAYS check available labels before creating issues:**

```bash
gh label list --limit 100 --json name --jq '.[].name'
```

**Rules:**
1. **NEVER guess or assume labels exist** - Always check first
2. **Only use labels from the list above** - No made-up labels
3. **Check once, create once** - Get it right the first time
4. **Pattern**: Check labels → Use only what exists → Create issue

This prevents failed issue creation attempts and ensures consistency.

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
*Last verified: September 30, 2025 (v1.9.13)*