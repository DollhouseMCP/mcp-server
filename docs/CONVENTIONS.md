# DollhouseMCP Naming Conventions & Style Guide

This document defines naming standards and style guidelines for files, memories, and other artifacts in the DollhouseMCP project.

## Session Note Memories

Session notes stored in the memory system (`~/.dollhouse/portfolio/memories/`) follow a structured naming convention for easy discovery and chronological organization.

### Naming Format

```
session-YYYY-MM-DD-{timeofday}-{topic-summary}-{qualifier}
```

### Components

- **Prefix**: Always `session-` (identifies as session notes)
- **Date**: ISO format `YYYY-MM-DD` (sortable, unambiguous)
- **Time of Day**: `morning`, `afternoon`, `evening`, `late-evening`
- **Topic**: Brief hyphenated summary of main focus (e.g., `issue-1211`, `v1913-release`, `sonarcloud-fixes`)
- **Qualifier** (optional): Additional context like `context`, `investigation`, `complete`, `status`

### Examples

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

### Required Fields

Session note memories must include these YAML fields:

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

### Search Flexibility

This naming format enables progressive specificity in searches:

- **By date**: `2025-09-30`
- **By time**: `morning`, `afternoon`, `evening`
- **By topic**: `issue-1211`, `memory-loading`, `sonarcloud`
- **By type**: `session-notes` (tag)
- **Full name**: `session-2025-09-30-morning-issue-1211`

---

## Session Note Documents

Session notes stored in the repository (`docs/development/`) use a different format optimized for visibility and version control.

### Naming Format

```
SESSION_NOTES_YYYY-MM-DD-{TOPIC}.md
```

### Components

- **Prefix**: Always `SESSION_NOTES_` (ALL CAPS for visibility in file listings)
- **Date**: ISO format `YYYY-MM-DD`
- **Topic**: ALL_CAPS_WITH_UNDERSCORES describing main focus

### Examples

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

### File Structure

Session note documents should follow this template:

```markdown
# Session Notes - [Full Date]

**Date**: September 30, 2025
**Time**: 10:15 AM - 11:00 AM (45 minutes)
**Focus**: [Main objective]
**Outcome**: ✅ [Result]

## Session Summary
[Overview of work completed]

## Work Sections
[Detailed breakdown of tasks, fixes, investigations]

## Key Learnings
[Technical and process insights gained]

## Next Session Priorities
[Clear handoff for continuation]
```

---

## Memory Naming (General Guidelines)

Non-session memories should use descriptive, hyphenated names that clearly indicate their purpose and scope.

### Topic-Based Memories

```yaml
# Format: {topic}-{subtopic}-{descriptor}
sonarcloud-rules-reference.yaml
sonarcloud-api-reference.yaml
project-context-v195.yaml
security-audit-process.yaml
```

### Technical Memories

```yaml
# Format: {system}-{component}-{purpose}
memory-auto-repair-mechanism.yaml
git-workflow-guidelines.yaml
docker-build-optimization.yaml
```

### Anti-Patterns

Avoid these naming patterns:

- **Random IDs**: `mem_1759077319164_w9m9fk56y` ❌
- **Generic names**: `notes.yaml`, `temp.yaml` ❌
- **Dates without topics**: `2025-09-30.yaml` ❌
- **Unclear abbreviations**: `sc-ref.yaml` ❌

---

## Tag Guidelines

Tags enable faceted search and categorization of memories and elements.

### Always Include

- **Content type**: `session-notes`, `reference`, `guide`, `context`
- **Main topics**: `issue-1211`, `memory-system`, `security`
- **Technical areas**: `docker`, `testing`, `ci-cd`

### Tag Format

- Use lowercase with hyphens: `session-notes`, `issue-1211`
- Be specific: `sonarcloud-fixes` not just `fixes`
- Include issue numbers: `issue-1211`, `pr-1212`
- Add context type: `investigation-context`, `release-notes`

### Example Tag Set

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

## Description Best Practices

Descriptions provide human-readable summaries for quick scanning and search results.

### Good Descriptions

- Start with action or summary: "Session work on...", "Reference for...", "Guide to..."
- Include key outcomes: "(fixed and merged)", "(investigation needed)"
- Be specific about scope: "Issue 1211" not just "bug fix"
- Mention next steps if relevant: "ready for next session", "needs investigation"

### Examples

```yaml
# Good examples:
description: Session work on Issue 1211 (fixed and merged) plus comprehensive investigation context for Issue 1213 memory loading bug

description: Complete reference for SonarCloud rules, patterns, and fixes - instant lookup for rule IDs and remediation strategies

description: Evening session completing PR #1106 and fixing CI failures from EnhancedIndexManager and Docker Hub authentication

# Bad examples:
description: Session notes                    ❌ Too generic
description: Fixed stuff                      ❌ No specifics
description: 2025-09-30                       ❌ Just a date
```

---

## Why These Conventions Matter

1. **Searchability**: Find memories by date, time, topic, or any combination
2. **Chronological Sorting**: ISO dates ensure proper ordering in file systems
3. **Context Clarity**: Topic in name means you know content before opening
4. **Future Proofing**: Consistent naming scales as count grows
5. **Progressive Specificity**: Search broadly or narrowly as needed
6. **Documentation**: Names serve as table of contents for history

---

## Commit Message Format

Follow conventional commits for clear, parseable git history:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `test:` - Test additions or changes
- `refactor:` - Code refactoring
- `style:` - Code style changes (formatting, semicolons, etc.)
- `chore:` - Build process or auxiliary tool changes

### Example

```bash
git commit -m "feat: add universal installer for multi-platform support

- Add platform detection logic
- Create configuration generators
- Add installation guides
- Update documentation

Fixes #123"
```

---

*This document defines naming and style standards for the DollhouseMCP project.*
*Last updated: October 8, 2025*
