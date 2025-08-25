# Release v1.6.0 Preparation Plan

**Date**: August 19, 2025  
**Current State**: develop branch, 89 commits ahead of main  
**Version**: Updating from v1.5.2 to v1.6.0  

## Executive Summary

This document consolidates all preparation tasks for the v1.6.0 release, including documentation updates, tool consolidation analysis, and specific improvements requested for this release cycle.

## Current Status

### Repository State
- **Branch**: develop (89 commits ahead of main)
- **Uncommitted Documentation**: Major updates from August 18 session
  - README.md (353 insertions)
  - API_REFERENCE.md (1027 changes - complete rewrite)
  - ARCHITECTURE.md (582 insertions)
  - MIGRATION_GUIDE_v1.6.0.md (new file)
  - package.json (version bump to 1.6.0)

### Open Issues
- **#628**: Documentation Update Required (tracking issue)
- **#629**: QA Testing Process (comprehensive testing framework)
- **#546**: Tool Consolidation Analysis (high priority)
- **#512**: Index.ts Refactoring (medium priority)

## Immediate Tasks for This Session

### 1. Documentation Updates

#### Create Feature Branch and Commit
- [ ] Create branch: `feature/documentation-v1.6.0`
- [ ] Commit all existing documentation changes
- [ ] Create PR to develop
- [ ] Link PR to Issue #628

#### README Modifications
- [ ] **REMOVE** Auto-Update "Enterprise-Grade" badge
  - Rationale: Feature doesn't feel enterprise-grade, will be removed soon
- [ ] **ADD** View Counter badge for visibility metrics
- [ ] **KEEP** Enterprise-Grade Security badge (legitimate, backed by work)

### 2. Collection Repository Tasks

#### Create Issue for Collection Updates
- [ ] Create issue for adding view counter to collection README
- [ ] Create issue for index exclusions

#### Index Modifications Needed
- [ ] Remove from display when MCP server queries:
  - Tools
  - Memories
  - Ensembles
  - Prompts (if indexed)
- [ ] Implementation: Add `.indexignore` or similar mechanism
- [ ] Keep indexed but hidden until MCP server supports them

### 3. Tool Removal Analysis

Based on agent research findings:

#### Issue #546 Status - Tool Consolidation
**CRITICAL**: Must complete Phase 1 analysis before removing ANY tools

**Current Tool Count**: ~64 tools in 7 categories
- Element Tools (16) - New generic system
- Persona Tools (19) - Legacy for backward compatibility  
- Collection Tools (10 + 5 deprecated aliases already removed)
- Auth Tools (4)
- Update Tools (5)
- User Tools (3)
- Config Tools (2)

#### Auto-Update System Decision
**FINDING**: No evidence of planned auto-update removal in previous discussions

However, based on user's current assessment:
- Auto-update doesn't work well
- Not enterprise-grade as advertised
- Planned for removal
- Not a core feature set

**ACTION NEEDED**:
- [ ] Create specific issue for auto-update tool removal
- [ ] Document rationale for removal
- [ ] Plan migration path for users

### 4. Pre-Release Cleanup

#### High Priority for v1.6.0
- [ ] Remove auto-update tools (5 tools)
- [ ] Remove auto-update documentation badge
- [ ] Update tool count in documentation
- [ ] Clean up related documentation

#### Tool Categories to Keep
- ✅ Element Tools (core new system)
- ✅ Collection Tools (core marketplace)
- ✅ Auth Tools (needed for GitHub)
- ✅ User Tools (basic functionality)
- ✅ Config Tools (essential)
- ⚠️ Persona Tools (keep for backward compatibility)

## Refactoring Context

### Successful Past Refactoring
- Issue #44: Reduced index.ts from 3000+ to 1314 lines (56% reduction)
- Issue #548: Removed deprecated marketplace aliases
- Issue #290: Transformed to portfolio system

### Current Refactoring Priorities
1. **Issue #546**: Tool consolidation (requires analysis first)
2. **Issue #512**: Continue index.ts modularization
3. **Issue #318**: Persona-to-Element migration

## Release v1.6.0 Checklist

### Must Complete Before Release
- [ ] Documentation PR merged (all v1.6.0 updates)
- [ ] Auto-update tools removed (if proceeding)
- [ ] Collection index hiding non-supported elements
- [ ] View counters added to READMEs
- [ ] All tests passing
- [ ] Migration guide complete and accurate

### Nice to Have
- [ ] Issue #512 progress (index.ts refactoring)
- [ ] Performance benchmarking baseline
- [ ] QA testing framework Phase 1

## Issues to Create

### 1. Auto-Update Tool Removal
**Title**: Remove auto-update system (5 tools) - not core functionality
**Priority**: High (for v1.6.0)
**Rationale**: 
- Doesn't work reliably
- Not enterprise-grade despite claims
- Not core MCP functionality
- Reduces tool count by ~8%

### 2. Collection Index Filtering
**Title**: Hide unsupported element types from MCP server queries
**Repository**: DollhouseMCP/collection
**Priority**: High (for v1.6.0)
**Elements to hide**: tools, memories, ensembles, prompts

### 3. Add View Counters
**Title**: Add GitHub view counter badges to READMEs
**Repositories**: Both mcp-server and collection
**Priority**: Medium

## Next Steps Order

1. **Create documentation branch and commit changes**
2. **Create issues for tracking**
3. **Remove auto-update badge from README**
4. **Add view counter to README**
5. **Create PR for documentation**
6. **Create auto-update removal issue with plan**
7. **Create collection repository issues**

## Success Criteria for v1.6.0

This release should be:
- ✅ Stable and reliable (no sketchy features)
- ✅ Well-documented with migration guide
- ✅ Focused on core MCP functionality
- ✅ Ready for active promotion to users
- ✅ Clean tool set without experimental features

## Notes

- This is the release for inviting people to use actively
- Focus on stability over feature count
- Remove/hide anything questionable or unreliable
- Keep working features prominent
- Ensure smooth user experience

---

*This plan consolidates findings from multiple agent searches and current session requirements*