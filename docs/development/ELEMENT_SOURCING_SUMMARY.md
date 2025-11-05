# Element Source Priority - Implementation Summary

**Created**: November 5, 2025
**Status**: Planning Complete - Ready for Implementation
**Target Version**: 1.10.0

## Executive Summary

A comprehensive implementation plan for adding element source priority to DollhouseMCP has been created and broken down into 6 GitHub issues. The feature will enforce a consistent order (Local Portfolio → GitHub Portfolio → Collection) when searching for and installing elements, ensuring local customizations always take precedence.

## Overview

### Problem Statement

Currently, DollhouseMCP searches for elements across three sources (local, GitHub, collection) in parallel with no enforced priority. This creates:
- Inconsistent behavior (search order is non-deterministic)
- User confusion (unclear which source takes precedence)
- Potential conflicts (remote versions may override local customizations)
- Poor user experience (can't configure source preferences)

### Solution

Implement a configurable source priority system that:
1. Checks sources sequentially in priority order (default: local → GitHub → collection)
2. Stops searching after finding element (early termination for performance)
3. Allows users to configure custom priority order
4. Provides fallback mechanisms for resilience
5. Maintains backward compatibility (no breaking changes)

## GitHub Issues Created

### Issue #1445: Create Element Source Priority Configuration System
**Labels**: `enhancement`, `area: elements`, `priority: high`
**URL**: https://github.com/DollhouseMCP/mcp-server/issues/1445
**Estimated Effort**: 4-6 hours
**Status**: Open
**Dependencies**: None (foundation issue)

**Description**: Create centralized configuration system with:
- `ElementSource` enum (LOCAL, GITHUB, COLLECTION)
- `SourcePriorityConfig` interface with priority order and behavior settings
- Configuration retrieval and validation functions
- Default configuration (local → GitHub → collection)
- Unit tests achieving >96% coverage

**Key Deliverables**:
- `src/config/sourcePriority.ts` (NEW)
- `test/__tests__/unit/config/sourcePriority.test.ts` (NEW)

---

### Issue #1446: Implement Source Priority in UnifiedIndexManager Search
**Labels**: `enhancement`, `area: elements`, `priority: high`
**URL**: https://github.com/DollhouseMCP/mcp-server/issues/1446
**Estimated Effort**: 6-8 hours
**Status**: Open
**Dependencies**: #1445

**Description**: Update `UnifiedIndexManager` to enforce source priority:
- Replace parallel search with sequential priority-based search
- Add early termination when element found (stopOnFirst)
- Add `includeAll` option to force search all sources
- Add `checkForUpdates()` method for cross-source version checking
- Add priority override options (preferredSource, sourcePriority)

**Key Changes**:
- Modify `src/portfolio/UnifiedIndexManager.ts` (lines 228-364)
- Add priority-aware helper methods
- Update `UnifiedSearchOptions` interface
- Comprehensive unit tests for priority scenarios

---

### Issue #1447: Update ElementInstaller to Respect Source Priority
**Labels**: `enhancement`, `area: elements`, `priority: high`
**URL**: https://github.com/DollhouseMCP/mcp-server/issues/1447
**Estimated Effort**: 4-6 hours
**Status**: Open
**Dependencies**: #1445, #1446

**Description**: Update `ElementInstaller` to check sources in priority order:
- Add `installElement()` method with source priority support
- Check local portfolio first to prevent duplicate installations
- Try sources in priority order (local → GitHub → collection)
- Support `preferredSource` option
- Support `force` option to overwrite local elements
- Maintain all existing security validations

**Key Changes**:
- Modify `src/collection/ElementInstaller.ts`
- Add GitHub portfolio installation support
- Refactor existing collection installation
- Preserve security fixes (validate-before-write, atomic operations)

---

### Issue #1448: Add User-Facing API for Source Priority Configuration
**Labels**: `enhancement`, `area: tooling`, `area: ux`, `priority: medium`
**URL**: https://github.com/DollhouseMCP/mcp-server/issues/1448
**Estimated Effort**: 3-4 hours
**Status**: Open
**Dependencies**: #1445, #1446, #1447

**Description**: Add MCP tool support for source priority configuration:
- View current source priority configuration
- Modify source priority order and settings
- Validate custom configurations with helpful errors
- Persist configuration to disk
- Include in export/import functionality
- Add to configuration wizard

**Key Changes**:
- Modify `src/tools/config/dollhouseConfigTool.ts`
- Add configuration persistence functions
- Add validation and error handling
- Update tests

---

### Issue #1449: Add Comprehensive Integration Tests for Element Source Priority
**Labels**: `area: testing`, `priority: high`, `type: task`
**URL**: https://github.com/DollhouseMCP/mcp-server/issues/1449
**Estimated Effort**: 4-5 hours
**Status**: Open
**Dependencies**: #1445, #1446, #1447, #1448

**Description**: Create comprehensive end-to-end tests:
- Search priority tests (5 scenarios)
- Installation priority tests (5 scenarios)
- Update checking tests (3 scenarios)
- Configuration persistence tests (3 scenarios)
- Fallback behavior tests (2 scenarios)
- Performance benchmarks

**Key Deliverables**:
- `test/__tests__/integration/source-priority.test.ts` (NEW)
- `test/__tests__/integration/element-installation-priority.test.ts` (NEW)
- Test helper utilities

---

### Issue #1450: Add Comprehensive Documentation for Element Source Priority Feature
**Labels**: `documentation`, `priority: medium`
**URL**: https://github.com/DollhouseMCP/mcp-server/issues/1450
**Estimated Effort**: 2-3 hours
**Status**: Open
**Dependencies**: #1445-#1449

**Description**: Create user and developer documentation:
- Update README with source priority overview
- Create User Guide section with configuration examples
- Create Developer Guide section for extending system
- Update API documentation
- Create Migration Guide for v1.10.0
- Include troubleshooting guide and common use cases

**Key Deliverables**:
- README.md updates
- docs/USER_GUIDE.md (new section)
- docs/DEVELOPER_GUIDE.md (new section)
- docs/API.md updates
- docs/MIGRATION_GUIDE.md (new section)

## Implementation Roadmap

### Dependency Graph

```
#1445 (Configuration) ← Foundation
   ↓
#1446 (UnifiedIndexManager) ← Core Search
   ↓
#1447 (ElementInstaller) ← Core Installation
   ↓
#1448 (Config API) ← User Interface
   ↓
#1449 (Integration Tests) ← Verification
   ↓
#1450 (Documentation) ← User Education
```

### Recommended Implementation Order

1. **Phase 1** (Week 1): Issues #1445, #1446
   - Create configuration system
   - Implement search priority
   - Verify basic functionality works

2. **Phase 2** (Week 2): Issues #1447, #1448
   - Implement installation priority
   - Add user-facing configuration API
   - Verify end-to-end workflows

3. **Phase 3** (Week 3): Issues #1449, #1450
   - Create comprehensive integration tests
   - Write documentation
   - Prepare for release

### Total Estimated Effort

| Phase | Issues | Hours | Risk Level |
|-------|--------|-------|------------|
| Phase 1 | #1445, #1446 | 10-14 | Medium |
| Phase 2 | #1447, #1448 | 7-10 | Medium |
| Phase 3 | #1449, #1450 | 6-8 | Low |
| **Total** | **6 issues** | **23-32 hours** | **Medium** |

**Timeline**: 3 weeks (assuming 8-12 hours/week)

## Technical Architecture

### Core Components

1. **Configuration Layer** (`src/config/sourcePriority.ts`)
   - ElementSource enum
   - SourcePriorityConfig interface
   - Configuration retrieval and validation

2. **Search Layer** (`src/portfolio/UnifiedIndexManager.ts`)
   - Sequential priority-based search
   - Early termination optimization
   - Fallback mechanisms

3. **Installation Layer** (`src/collection/ElementInstaller.ts`)
   - Source checking before installation
   - Priority-aware installation
   - Duplicate prevention

4. **Configuration API** (`src/tools/config/dollhouseConfigTool.ts`)
   - View and modify configuration
   - Persistence and validation
   - User-friendly error messages

### Default Configuration

```typescript
const DEFAULT_SOURCE_PRIORITY = {
  priority: ['local', 'github', 'collection'],
  stopOnFirst: true,
  checkAllForUpdates: false,
  fallbackOnError: true
};
```

### Search Flow

```
User searches for element "creative-writer"
   ↓
Check LOCAL portfolio
   ↓ (not found)
Check GITHUB portfolio
   ↓ (found!)
Return result from GitHub
(Collection NOT checked due to stopOnFirst: true)
```

### Installation Flow

```
User installs element "code-reviewer"
   ↓
Check LOCAL portfolio (prevent duplicates)
   ↓ (not found)
Try installing from GITHUB portfolio
   ↓ (found!)
Download, validate, install to LOCAL
   ↓
Success! Element now in local portfolio
```

## Success Criteria

### Functional Requirements
- ✅ Sources checked in configured priority order
- ✅ Search stops after first match (when stopOnFirst: true)
- ✅ Installation prevents duplicates in local portfolio
- ✅ Users can customize source priority
- ✅ Configuration persists across restarts

### Non-Functional Requirements
- ✅ No breaking API changes
- ✅ Test coverage remains >96%
- ✅ Performance equal or better (early termination)
- ✅ Clear documentation for users and developers
- ✅ All CI/CD checks pass

## Key Decisions

### 1. Sequential vs. Parallel Search
**Decision**: Sequential with early termination
**Rationale**:
- Provides deterministic, predictable behavior
- Enables early termination optimization
- Simplifies reasoning about source priority
- Minor performance trade-off mitigated by caching

### 2. Default Priority Order
**Decision**: Local → GitHub → Collection
**Rationale**:
- Respects user customizations (local always wins)
- Matches user expectations
- Prevents remote versions from overriding local work
- GitHub as middle tier (personal but remote)

### 3. Backward Compatibility
**Decision**: No breaking changes, opt-in features
**Rationale**:
- Existing code continues working
- Default behavior matches expected behavior
- Users can adopt gradually
- Reduces migration friction

### 4. Configuration Complexity
**Decision**: Simple defaults, advanced options available
**Rationale**:
- Most users don't need to configure (defaults work)
- Power users have full control
- Progressive disclosure of complexity
- Clear documentation for both levels

## Risk Assessment

### Medium Risks

1. **Performance Regression**
   - **Risk**: Sequential search slower than parallel for elements in later sources
   - **Mitigation**: Early termination, caching, benchmarking, `includeAll` option
   - **Likelihood**: Medium
   - **Impact**: Medium

2. **Breaking Changes**
   - **Risk**: Changing search order may break code depending on current behavior
   - **Mitigation**: Comprehensive testing, backward compatibility focus
   - **Likelihood**: Low
   - **Impact**: High

3. **Configuration Complexity**
   - **Risk**: Users confused by options, misconfigure priority
   - **Mitigation**: Clear documentation, validation with helpful errors, sane defaults
   - **Likelihood**: Medium
   - **Impact**: Low

### Low Risks

1. **Test Coverage**
   - **Risk**: Complex logic may be hard to test comprehensively
   - **Mitigation**: Integration tests, unit tests, edge case coverage
   - **Likelihood**: Low
   - **Impact**: Medium

2. **Documentation Quality**
   - **Risk**: Users may not understand feature without good docs
   - **Mitigation**: Multiple documentation levels, examples, troubleshooting
   - **Likelihood**: Low
   - **Impact**: Medium

## Performance Expectations

### Expected Improvements
- **Early termination**: 20-50% faster when element in first source
- **API call reduction**: ~50% fewer GitHub API calls when element found locally
- **Cache utilization**: Better cache hit rates due to deterministic behavior

### Expected Trade-offs
- **Sequential overhead**: Slightly slower when element in later source
- **Memory**: Negligible increase for configuration storage

### Benchmarking Plan
- Measure search time: local-only, GitHub-only, collection-only, all sources
- Compare parallel vs. sequential search performance
- Track API call counts before/after
- Monitor cache hit rates
- Measure memory usage

## Future Enhancements

Potential improvements for future versions:

1. **Smart Source Selection**
   - Learn user preferences over time
   - Adjust priority based on element type
   - Predict likely source for faster search

2. **Dynamic Priority**
   - Adjust based on network conditions
   - Deprioritize slow/unavailable sources
   - Automatic failover for reliability

3. **Source Health Monitoring**
   - Track source availability and latency
   - Provide user feedback about source status
   - Automatic source degradation when unhealthy

4. **Weighted Priority**
   - Allow weighting instead of strict ordering
   - Enable probabilistic source selection
   - Support A/B testing different priorities

5. **Element-Level Overrides**
   - Pin specific elements to specific sources
   - Per-element type priority
   - User preferences for individual elements

## Related Documentation

- **Implementation Plan**: `/docs/development/ELEMENT_SOURCING_IMPLEMENTATION_PLAN.md`
- **Architecture**: `/docs/development/ARCHITECTURE.md` (update required)
- **Contributing**: `/CONTRIBUTING.md`
- **Conventions**: `/docs/CONVENTIONS.md`

## Issue References

- Configuration: https://github.com/DollhouseMCP/mcp-server/issues/1445
- UnifiedIndexManager: https://github.com/DollhouseMCP/mcp-server/issues/1446
- ElementInstaller: https://github.com/DollhouseMCP/mcp-server/issues/1447
- Config API: https://github.com/DollhouseMCP/mcp-server/issues/1448
- Integration Tests: https://github.com/DollhouseMCP/mcp-server/issues/1449
- Documentation: https://github.com/DollhouseMCP/mcp-server/issues/1450

## Next Steps

### For Implementation

1. **Review and approve** this plan and all GitHub issues
2. **Assign issues** to developers (or self if solo)
3. **Start with #1445** (foundation configuration system)
4. **Follow dependency order** to avoid blockers
5. **Test incrementally** after each issue
6. **Update issues** with progress and findings

### For Project Management

1. **Add to project board** (if applicable)
2. **Set milestones** for v1.10.0 release
3. **Track progress** weekly
4. **Communicate updates** to stakeholders
5. **Plan release** after #1450 complete

### For Testing

1. **Create test plan** based on #1449 requirements
2. **Set up test environments** (local, GitHub, collection mocks)
3. **Prepare test data** (sample elements, configurations)
4. **Run performance benchmarks** before/after
5. **Document test results** in issues

## Conclusion

The element source priority feature is fully planned and ready for implementation. With 6 well-defined GitHub issues, comprehensive documentation, and a clear roadmap, the feature can be implemented systematically over 3 weeks.

The feature will significantly improve user experience by providing:
- **Predictable behavior**: Sources always checked in same order
- **User control**: Customizable source priority
- **Better performance**: Early termination optimization
- **Conflict prevention**: Local customizations always respected

All issues are tagged appropriately, have clear acceptance criteria, and include detailed implementation guidance. The dependency graph ensures logical implementation order, and comprehensive testing will verify correctness.

**Status**: ✅ Planning Complete - Ready to Begin Implementation

---

*Created by: Implementation Planning Agent*
*Date: November 5, 2025*
*Version: 1.0*
