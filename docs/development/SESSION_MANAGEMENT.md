# Session Management Guide

This document outlines best practices for managing development sessions in DollhouseMCP, including note-taking, context preservation, and session continuity.

## Overview

DollhouseMCP uses a **dual approach** to session management - maintaining both traditional session notes in the repository and mirrored content in the memory system. This "belt and suspenders" strategy ensures context is preserved through multiple mechanisms.

## The Dual Approach

### 1. Session Note Documents (Primary)

Session notes in the repository serve as the **source of truth** for session work.

**Location**: `docs/development/SESSION_NOTES_YYYY-MM-DD-{TOPIC}.md`

**Purpose**:
- Version-controlled documentation of development work
- Human-readable record of decisions and implementations
- Searchable within the repository
- Part of the project's historical record

**Format**: See [CONVENTIONS.md](../CONVENTIONS.md#session-note-documents) for naming and structure.

### 2. Memory System (Backup)

Session notes are mirrored to the DollhouseMCP memory system for AI assistant context.

**Location**: `~/.dollhouse/portfolio/memories/YYYY-MM-DD/session-*.yaml`

**Purpose**:
- Provides context to AI assistants across sessions
- Enables semantic search and retrieval
- Supports session continuity for long-running work
- Backup of session information outside version control

**Format**: See [CONVENTIONS.md](../CONVENTIONS.md#session-note-memories) for naming and structure.

## Session Workflow

### Starting a New Session

1. **Create a session note document** in `docs/development/`:
   ```bash
   # Example filename
   docs/development/SESSION_NOTES_2025-10-08-MORNING-CLAUDE-MD-REFACTOR.md
   ```

2. **Use the session note template**:
   ```markdown
   # Session Notes - October 8, 2025

   **Date**: October 8, 2025
   **Time**: 9:00 AM - [End Time]
   **Focus**: Refactor CLAUDE.md into modular documentation
   **Outcome**: [To be filled]

   ## Session Summary
   [Brief overview]

   ## Work Completed
   [Detailed sections for each task]

   ## Key Learnings
   [Technical insights and gotchas]

   ## Next Session Priorities
   [Clear handoff]
   ```

3. **Document work as you go** - Update the session note in real-time rather than retrospectively

### During the Session

- **Keep session notes current**: Update as tasks complete, not at the end
- **Record decisions**: Document why choices were made, not just what was done
- **Note blockers**: Record any issues encountered and how they were resolved
- **Track time**: Update start/end times and note any breaks

### Ending a Session

1. **Complete the session note**:
   - Fill in outcome status (✅ Success, ⏸️ In Progress, ⚠️ Blocked)
   - Summarize key learnings
   - List clear next steps for continuation

2. **Mirror to memory system** using MCP tools:
   ```bash
   # Use the DollhouseMCP MCP tool (NEVER manually write YAML)
   mcp__dollhousemcp-capability-index__create_element \
     --type memories \
     --name "session-2025-10-08-morning-claude-md-refactor" \
     --description "Session work refactoring CLAUDE.md into modular docs" \
     --content "[Markdown summary of session work]"
   ```

3. **Commit session notes** to version control:
   ```bash
   git add docs/development/SESSION_NOTES_*.md
   git commit -m "docs: add session notes for CLAUDE.md refactoring"
   ```

## Best Practices

### Session Note Documents

- ✅ **Write during the session**, not after - Context is clearer in the moment
- ✅ **Be specific about outcomes** - "Fixed bug in X" not "Fixed stuff"
- ✅ **Include code references** - File paths and line numbers when relevant
- ✅ **Document dead ends** - What didn't work and why
- ✅ **Keep it scannable** - Use headers, lists, and formatting
- ❌ **Don't defer writing** - Real-time is better than retrospective
- ❌ **Don't be vague** - Future you needs specifics

### Memory System

- ✅ **Always use MCP tools** to create memories - Never manually write YAML
- ✅ **Include proper tags** - See [CONVENTIONS.md](../CONVENTIONS.md#tag-guidelines)
- ✅ **Write clear descriptions** - Summaries should be self-explanatory
- ✅ **Use consistent naming** - Follow the session naming convention
- ❌ **Don't manually edit memory YAML** - Use the MCP tools
- ❌ **Don't skip mirroring** - Both systems serve different purposes

### Session Continuity

For multi-session work:

1. **Reference previous session notes** at the start of each session
2. **Update "Next Session Priorities"** in the previous session note if plans change
3. **Create a session series** with consistent topic names:
   ```
   SESSION_NOTES_2025-10-08-CLAUDE-MD-REFACTOR-PART-1.md
   SESSION_NOTES_2025-10-09-CLAUDE-MD-REFACTOR-PART-2.md
   ```

## Critical: Memory Creation

**ALWAYS use DollhouseMCP MCP tools to create memories. NEVER manually write YAML files.**

### Why This Matters

- ✅ **MCP tools handle proper directory structure** - Creates date folders like `memories/2025-10-08/`
- ✅ **Automatic metadata generation** - Timestamps, versions, and validation
- ✅ **Proper YAML formatting** - Ensures parseable, valid YAML
- ✅ **Correct file permissions** - Files are created with appropriate access
- ❌ **Manual YAML writing** puts files in wrong locations and may miss metadata

### Correct Approach

```bash
# Use the MCP tool
mcp__dollhousemcp-capability-index__create_element \
  --type memories \
  --name "session-2025-10-08-morning-topic-summary" \
  --description "Brief description of session work" \
  --content "Markdown content here..."
```

### Incorrect Approach

```bash
# DON'T manually write YAML files
cat > ~/.dollhouse/portfolio/memories/my-memory.yaml  # ❌ WRONG
```

## Session Note vs. Memory: When to Use Each

| Use Case | Session Note Document | Memory System |
|----------|----------------------|---------------|
| **Version control** | ✅ Primary | ❌ No |
| **Human reading** | ✅ Optimized | ⚠️ Possible but not ideal |
| **AI assistant context** | ⚠️ Must be read explicitly | ✅ Automatic activation |
| **Long-term archival** | ✅ Source of truth | ✅ Backup |
| **Semantic search** | ❌ Limited | ✅ Designed for it |
| **Project documentation** | ✅ Part of repo | ❌ Local only |

## Session Types

### Standard Development Session

Focus on feature implementation, bug fixes, refactoring:
- Detailed technical notes
- Code references and line numbers
- Decision rationale
- Testing results

### Investigation Session

Focus on research, debugging, understanding:
- Questions and hypotheses
- Findings and discoveries
- Dead ends and why they didn't work
- Conclusions and next steps

### Planning Session

Focus on architecture, design, strategy:
- Requirements analysis
- Design decisions
- Trade-off evaluations
- Implementation roadmap

## Troubleshooting

### Session Note Not Committing

- Check that filename follows naming convention
- Ensure file is in `docs/development/`
- Verify no merge conflicts

### Memory Not Creating

- Verify you're using MCP tools, not manual YAML
- Check memory name follows hyphenated lowercase convention
- Ensure description and content are provided
- Check `~/.dollhouse/portfolio/memories/` exists

### Lost Session Context

If session notes weren't created:

1. **Reconstruct from git history**: `git log --oneline --since="2 days ago"`
2. **Check memory system**: `mcp__dollhousemcp-capability-index__search_portfolio --query "session-2025-10-08"`
3. **Review changed files**: `git diff --name-only`
4. **Write a retrospective session note** - Better late than never

## Examples

### Example: Successful Session

**docs/development/SESSION_NOTES_2025-10-08-MORNING-CLAUDE-MD-REFACTOR.md**:
```markdown
# Session Notes - October 8, 2025

**Date**: October 8, 2025
**Time**: 9:00 AM - 10:30 AM (90 minutes)
**Focus**: Refactor CLAUDE.md into modular documentation
**Outcome**: ✅ Completed initial refactoring

## Session Summary
Refactored the monolithic CLAUDE.md file into modular documentation:
- Created docs/CONVENTIONS.md for naming standards
- Created docs/development/SESSION_MANAGEMENT.md for this guide
- Plan to update CONTRIBUTING.md and slim down CLAUDE.md

## Work Completed

### 1. Created docs/CONVENTIONS.md
- Extracted all naming conventions from CLAUDE.md
- Added session note naming format
- Added memory naming guidelines
- Added tag and description best practices

### 2. Created docs/development/SESSION_MANAGEMENT.md
- Documented dual approach to session management
- Added session workflow guide
- Included troubleshooting section

## Key Learnings
- CONTRIBUTING.md already exists with good content
- Need to enhance it with architecture details
- CLAUDE.md should become a lightweight index, not a comprehensive guide

## Next Session Priorities
1. Update CONTRIBUTING.md with architecture overview
2. Refactor CLAUDE.md to lightweight index
3. Test the new structure
4. Create PR
```

**Mirrored Memory**:
```yaml
name: session-2025-10-08-morning-claude-md-refactor
description: Session work refactoring CLAUDE.md into modular documentation - created CONVENTIONS.md and SESSION_MANAGEMENT.md
version: 1.0.0
retention: permanent
tags:
  - session-notes
  - documentation
  - refactoring
  - claude-md
entries:
  - timestamp: 2025-10-08T09:00:00Z
    type: summary
    content: |
      Refactored CLAUDE.md into modular documentation structure:
      - Created docs/CONVENTIONS.md for naming standards
      - Created docs/development/SESSION_MANAGEMENT.md
      - Next: Update CONTRIBUTING.md and slim down CLAUDE.md
```

---

*This guide defines session management practices for the DollhouseMCP project.*
*Last updated: October 8, 2025*
