# Multi-Agent GitFlow Development Process

## Overview

This document defines the process for using multiple AI agents to develop features in parallel while maintaining GitFlow discipline and avoiding merge conflicts. It leverages an Opus orchestrator with Sonnet worker agents for optimal efficiency.

## Table of Contents
1. [Model Architecture](#model-architecture)
2. [GitFlow Requirements](#gitflow-requirements)
3. [Granular PR Strategy](#granular-pr-strategy)
4. [Three-Phase Handoff Protocol](#three-phase-handoff-protocol)
5. [Agent Instruction Templates](#agent-instruction-templates)
6. [Common Pitfalls](#common-pitfalls)
7. [Examples](#examples)

---

## Model Architecture

### Current Configuration
- **Orchestrator**: Claude Opus 4.1 (`claude-opus-4-1-20250805`)
  - Handles planning, strategy, and coordination
  - Reviews and validates agent understanding
  - Makes architectural decisions
  
- **Worker Agents**: Claude Sonnet 4 (`claude-sonnet-4-20250514`)
  - Execute specific, focused tasks
  - Implement granular PRs
  - Follow detailed instructions

### Why This Architecture Works
1. **Resource Optimization**: Opus for complex reasoning, Sonnet for execution
2. **Speed**: Sonnet agents complete focused tasks quickly
3. **Clarity**: Clear separation of planning vs execution
4. **Cost Efficiency**: Uses appropriate model for each task type

---

## GitFlow Requirements

### Branch Structure
```
main
├── Production branch - stable, deployed to NPM
├── Protected - requires PR reviews and passing tests
└── Tagged for releases (v1.2.0, v1.2.1, etc.)

develop
├── Integration branch - features merge here first
├── Always ahead of or equal to main
└── Where CI runs integration tests

feature/*
├── New features and enhancements
├── Created FROM develop
└── Merged TO develop (NEVER to main)

hotfix/*
├── Emergency fixes for production
├── Created FROM main
└── Merged to BOTH main AND develop

release/*
├── Release preparation branches
├── Created FROM develop
└── Merged to main, then back to develop
```

### Critical Rules
1. **NEVER** create PR from feature branch directly to main
2. **ALWAYS** start feature branches from develop
3. **ALWAYS** pull latest before creating branches
4. **ONLY** hotfix and release branches can PR to main

### Proper Commands
```bash
# Feature branch (most common)
git checkout develop
git pull origin develop
git checkout -b feature/descriptive-name

# Hotfix branch (critical fixes only)
git checkout main
git pull origin main
git checkout -b hotfix/critical-fix

# Create PR to develop (features)
gh pr create --base develop --title "feat: Description"

# Create PR to main (hotfixes only)
gh pr create --base main --title "hotfix: Description"
```

---

## Granular PR Strategy

### Core Principle: 1 PR = 1 Concept

Instead of large PRs that touch many files, break work into atomic units.

### Benefits
- **Fewer Conflicts**: Small PRs rarely conflict
- **Faster Reviews**: 5 minutes vs 30+ minutes
- **Easier Reverts**: Can undo specific changes
- **True Parallelism**: Multiple agents work without interference
- **Lower Risk**: Less lost work if something goes wrong

### Breaking Down Features

#### Bad Approach (Monolithic PR)
```
PR: Implement caching system
- Modified 8 files
- Added 500+ lines
- Touches core components
- High conflict potential
```

#### Good Approach (Granular PRs)
```
PR #1: Add cache interface
- 1 file: src/cache/ICache.ts
- 50 lines
- No dependencies

PR #2: Add cache implementation
- 1 file: src/cache/MemoryCache.ts
- 150 lines
- Depends on PR #1

PR #3: Wire cache to search
- 1 file: src/search/Search.ts
- 20 lines changed
- Depends on PR #2

PR #4: Wire cache to API
- 1 file: src/api/Client.ts
- 15 lines changed
- Depends on PR #2
```

### Dependency Management

When PRs depend on each other:

1. **Linear Dependencies**: PR B needs PR A merged first
   ```
   feature/add-interface → merge → feature/add-implementation
   ```

2. **Parallel Work**: Independent PRs can be worked simultaneously
   ```
   feature/update-docs     ←→ No conflicts
   feature/add-tests       ←→ Can merge in any order
   feature/fix-logging     ←→ Different files
   ```

3. **Stacked Branches**: For complex dependencies
   ```bash
   git checkout -b feature/step-1 develop
   # work...
   git checkout -b feature/step-2 feature/step-1
   # work building on step-1...
   ```

---

## Three-Phase Handoff Protocol

### Phase 1: Orchestrator Planning

The orchestrator (Opus) creates a detailed plan:

```markdown
## Task: Implement [Feature Name]

### Granular PR Breakdown:
1. PR #1: [Description]
   - Files: [specific files]
   - Dependencies: None
   - Size: ~X lines

2. PR #2: [Description]
   - Files: [specific files]
   - Dependencies: PR #1
   - Size: ~X lines

### Your Assignment: PR #1 ONLY
- Branch name: feature/specific-name
- Exact changes needed: [details]
- What NOT to do: [boundaries]

Please confirm your understanding.
```

### Phase 2: Agent Confirmation

The agent (Sonnet) responds with understanding:

```markdown
## My Understanding:

### I WILL:
- Create branch: feature/specific-name from develop
- Modify files: [list exact files]
- Make changes: [specific changes]
- PR title: "feat: [description]"

### I WILL NOT:
- [List boundaries]
- [What to avoid]

### Questions:
- [Any ambiguities]

Is this correct?
```

### Phase 3: Orchestrator Validation

The orchestrator confirms or corrects:

```markdown
## ✅ Confirmed with clarifications:

Your understanding is correct except:
- Correction 1: [specific fix]
- Answer to Q1: [answer]

Proceed with PR #1.
```

---

## Agent Instruction Templates

### Standard Feature Implementation

```markdown
## CRITICAL: GitFlow and Granular PR Requirements

### Pre-flight Checklist:
1. Run: `git status` - Ensure clean working directory
2. Run: `git branch --show-current` - Verify on develop
3. Run: `gh pr list --state open --json files` - Check for conflicts

### Your Task: [Specific PR Name]

You are implementing ONE GRANULAR PR:
- Branch: feature/[specific-name]
- Files: [exact file list]
- Changes: [specific changes]
- Size: Keep under 200 lines

### GitFlow Rules:
- Create branch FROM develop
- PR must target develop (NOT main)
- Run tests before creating PR

### Success Criteria:
- [ ] One conceptual change only
- [ ] All tests pass
- [ ] PR description includes issue number
- [ ] No unrelated changes

### Report back with:
1. PR URL
2. Files modified
3. Line count
4. Any issues encountered
```

### Hotfix Implementation

```markdown
## CRITICAL: This is a HOTFIX

### Hotfix Process:
1. Branch from MAIN (not develop)
2. Branch name: hotfix/[description]
3. Fix the specific issue ONLY
4. Create PR to main
5. Also merge to develop

### Your specific fix:
[Exact description]

### Commands to run:
```bash
git checkout main
git pull origin main
git checkout -b hotfix/[name]
# make changes
git add -A
git commit -m "hotfix: [description]"
git push -u origin hotfix/[name]
gh pr create --base main --title "hotfix: [description]"
```

Confirm understanding before proceeding.
```

---

## PR Review and Merge Protocol

### Before ANY Merge

1. **Wait for CI Checks**
   ```bash
   gh pr checks [PR-NUMBER]  # All must be ✓
   ```

2. **Review Security Audit**
   - Check for any security findings
   - Address critical/high issues immediately
   - Document medium/low issues for follow-up

3. **Read Review Comments**
   ```bash
   gh pr view [PR-NUMBER] --comments
   ```

4. **Report to Orchestrator**
   ```markdown
   ## PR [NUMBER] Review Summary
   
   ### CI Status
   - [ ] All checks passing
   - [ ] Test coverage maintained (96%+)
   - [ ] Build successful
   
   ### Security Audit
   - Findings: [none/list any]
   - Action needed: [yes/no]
   
   ### Review Comments
   - Reviewer requests: [list any]
   - Suggestions: [list any]
   
   ### Recommendation
   - Ready to merge: [yes/no]
   - Changes needed: [list if any]
   ```

5. **Only Merge After Approval**
   - Orchestrator confirms all issues addressed
   - No outstanding review requests
   - CI fully green

## Common Pitfalls

### Pitfall 1: Feature Branch to Main
**Wrong**: Creating PR from feature branch to main
**Right**: Feature → develop, then release → main
**Prevention**: Always check `--base` in PR creation

### Pitfall 2: Large PRs
**Wrong**: One PR with complete feature
**Right**: Multiple small PRs building the feature
**Prevention**: If touching >3 files, consider splitting

### Pitfall 3: Working from Stale Branch
**Wrong**: Creating branch without pulling latest
**Right**: Always pull before branching
**Prevention**: Make `git pull` part of branch creation

### Pitfall 4: Ignoring Conflicts
**Wrong**: Creating PR that conflicts with existing PRs
**Right**: Check open PRs before starting
**Prevention**: Run `gh pr list --json files` first

### Pitfall 5: Missing Dependencies
**Wrong**: Creating PR that needs unmerged code
**Right**: Wait for dependencies or stack branches
**Prevention**: Clearly document dependencies

### Pitfall 6: Premature Merging
**Wrong**: Merging as soon as PR is created
**Right**: Wait for CI, security audit, and review
**Prevention**: Follow PR Review Protocol above

---

## Examples

### Example 1: Memory Element Implementation

#### Orchestrator Plan:
```markdown
Task: Implement Memory Element

Granular PRs:
1. Memory interfaces (no dependencies)
2. BaseMemory class (needs #1)
3. FileBackend (needs #2)
4. MemoryManager (needs #2)
5. Tests (needs #2-4)
6. Wire to server (needs all)

Start with PR #1 only.
```

#### Agent Execution:
```bash
git checkout develop
git pull origin develop
git checkout -b feature/memory-interfaces
# Create src/types/memories/IMemory.ts
git add -A
git commit -m "feat(types): Add Memory element interfaces

- Add IMemory interface
- Add MemoryMetadata type
- Add RetentionPolicy type

Part of #477"
git push -u origin feature/memory-interfaces
gh pr create --base develop
```

### Example 2: Hotfix for Production Bug

#### Orchestrator Plan:
```markdown
HOTFIX: OAuth URL shows wrong link

1. Branch from main
2. Fix one line in GitHubAuthManager.ts
3. PR to main AND develop
```

#### Agent Execution:
```bash
git checkout main
git pull origin main
git checkout -b hotfix/oauth-documentation-url
# Fix the URL
git add -A
git commit -m "hotfix: Correct OAuth documentation URL

Fixes #480"
git push -u origin hotfix/oauth-documentation-url
gh pr create --base main --title "hotfix: Correct OAuth documentation URL"

# Also merge to develop
git checkout develop
git pull origin develop
git merge hotfix/oauth-documentation-url
git push origin develop
```

---

## Coordination Between Multiple Agents

### File Locking (Informal)
```markdown
Agent A: Working on src/cache/*
Agent B: Working on src/types/*
Agent C: Working on tests/*
Agent D: Working on docs/*
```

### Checking for Conflicts
```bash
# Before starting work
gh pr list --state open --json number,title,files | \
  jq '.[] | "\(.number): \(.title)\nFiles: \(.files | map(.path) | join(", "))\n"'
```

### Communication via PR Descriptions
```markdown
This PR modifies: src/cache/Cache.ts
Depends on: PR #123 (must merge first)
Conflicts with: None
Part of: Issue #456
```

---

## Success Metrics

1. **PR Size**: Average <100 lines changed
2. **Review Time**: <10 minutes per PR
3. **Conflict Rate**: <5% of PRs have conflicts
4. **Merge Time**: PRs merged within 2 hours
5. **Revert Rate**: <1% of PRs need reverting

---

## Process Improvements

This is a living document. Updates should be made when:
- New patterns emerge
- Problems are encountered and solved
- Tools or workflows change
- GitFlow process is refined

Last Updated: August 6, 2025