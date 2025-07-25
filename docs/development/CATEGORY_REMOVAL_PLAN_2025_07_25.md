# Comprehensive Plan: Category Removal & Versioning System
**Date**: July 25, 2025  
**Status**: Ready for Implementation  
**Context**: Low (~5%) - Save this document for next session

## Overview
Transform the DollhouseMCP ecosystem to use a flat directory structure with Git-based versioning, removing category folders while maintaining organization through tags and implementing fork-based variant management.

## Key Design Decisions

### 1. Directory Structure Change
**FROM**: `library/{type}/{category}/{file}.md`  
**TO**: `library/{type}/{file}.md`

### 2. Filename Convention
**Format**: `{descriptive-name}_{author}.md`

Examples:
- `project-proposal_dollhousemcp.md`
- `project-proposal-startup_alice.md` (fork/variant)
- `creative-writer_dollhousemcp.md`
- `debug-detective-strict_bob.md` (variant)

### 3. Versioning Philosophy
- **Minor changes**: Git commits to same file
- **Major variants**: Create new file (fork)
- **No version numbers**: Git history is the version system
- **Stable filenames**: Once created, names never change

---

## Phase 1: Validation Updates (45 min)

### Collection Repository (`DollhouseMCP-Collection`)
1. **Update src/validators/content-validator.ts**:
   ```typescript
   // Line 33 - Make category optional
   category: z.enum(['creative', 'educational', 'gaming', 'personal', 'professional']).optional(),
   ```
   - Keep enum values for backward compatibility
   - All schemas already have `.passthrough()` in PR #73

2. **Update test/integration/setup.ts**:
   ```typescript
   // Line 106 - Remove category from path
   const filePath = join(libraryDir, fixture.type, fixture.filename);
   
   // Remove line 33 - Don't create category directories
   // await mkdir(join(testLibraryDir, type, 'test-category'), { recursive: true });
   ```

### MCP Server Repository (`DollhouseMCP`)
1. **Update src/persona/PersonaValidator.ts**:
   - Make category optional in validation
   - Remove VALID_CATEGORIES enforcement

2. **Update src/config/constants.ts**:
   - Comment out or remove VALID_CATEGORIES export

3. **Update src/collection/CollectionBrowser.ts**:
   - Remove category navigation level (lines 110-115)
   - Update URL building (lines 40-41)
   - Go directly from type to files

---

## Phase 2: Update Existing PRs (1.5 hours)

### PRs to Update:
- **PR #73**: Main PR with all 26 elements
- **PR #80**: Skills (7 files) - Part 2/5
- **PR #81**: Templates (9 files) - Part 3/5  
- **PR #82**: Agents/Memories (7 files) - Part 4/5
- **PR #83**: Ensembles (4 files) - Part 5/5

### For Each PR:
1. **Move files**:
   ```bash
   # Example for templates
   git mv library/templates/business/*.md library/templates/
   git mv library/templates/professional/*.md library/templates/
   ```

2. **Resolve naming conflicts**:
   - `business/report.md` → `report-business_{author}.md`
   - `professional/report.md` → `report-executive_{author}.md`

3. **Update unique IDs** to include type prefix:
   - Current: `project-proposal_20250715-100300_dollhousemcp`
   - New: `template_project-proposal_dollhousemcp_20250715-100300`

4. **Remove empty directories**:
   ```bash
   find library -type d -empty -delete
   ```

---

## Phase 3: MCP Tool Updates (30 min)

### Update Collection Tools:
1. **src/server/tools/CollectionTools.ts**:
   - Remove category parameter from browse_collection
   - Update tool descriptions

2. **src/collection/PersonaSubmitter.ts**:
   - Line 21: Keep category in metadata (optional)

### Update PR #287:
- Keep backward compatibility aliases
- Update deprecated tool descriptions

---

## Phase 4: Git History Browsing (Future - 2-3 days)

### New MCP Tools to Implement:

1. **get_element_history**
   ```typescript
   // Show commit history for element
   get_element_history("project-proposal_alice.md", { limit: 10 })
   ```

2. **get_element_version**
   ```typescript
   // Get specific version by commit
   get_element_version("project-proposal_alice.md", { commit: "abc123" })
   ```

3. **compare_element_versions**
   ```typescript
   // Show diff between versions
   compare_element_versions("project-proposal_alice.md", {
     from: "abc123",
     to: "def456"
   })
   ```

### Implementation Approach:
- **Collection**: Use GitHub Commits API
- **Local Portfolio**: Execute git commands via child_process
- **Security**: Sanitize all inputs to prevent injection
- **Performance**: Add caching layer for history queries

### Metadata Enhancement:
```yaml
---
name: Project Proposal - Startup Version
author: alice
forked_from:
  file: project-proposal_dollhousemcp.md
  commit: abc123  # Specific version forked from
---
```

---

## Implementation Timeline

### Today (Half Day):
1. **Hour 1**: Phase 1 - Update validators
2. **Hour 2**: Phase 2 - Update PRs  
3. **Hour 3+**: 
   - Phase 3 - Quick MCP updates
   - Continue Part 3 Templates work

### Tomorrow:
- Test and merge updated PRs
- Handle any validation issues
- Begin Phase 4 planning

### Next Week:
- Implement Git history browsing tools
- Full integration testing

---

## Commands for Next Session

```bash
# Start on collection repo
cd /Users/mick/Developer/MCP-Servers/DollhouseMCP-Collection
git checkout main
git pull

# Check PR statuses
gh pr list --state open

# Start with validation updates
code src/validators/content-validator.ts

# For updating PRs (example)
gh pr checkout 81
git mv library/templates/business/*.md library/templates/
git mv library/templates/professional/*.md library/templates/
```

---

## Benefits Summary

1. **Cleaner Structure**: No empty category folders
2. **Git-Native Versioning**: Embraces Git's model
3. **Stable References**: Filenames never change
4. **Better Discovery**: Flexible tags over rigid categories
5. **Natural Variants**: Fork model for major changes
6. **Future-Proof**: Foundation for Git history tools

---

## Notes for Next Session

- We chose Option B (direct to final structure) to avoid double work
- Security validation only needs to be done once
- Start with validators to avoid branch protection issues
- Keep category as optional metadata for compatibility
- Fork model means one file = one evolution path

---

*Session ended at low context (~5%). This document contains everything needed to implement the plan.*