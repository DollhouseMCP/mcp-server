# Element Sourcing Priority - Implementation Plan

## Overview

This document provides a comprehensive implementation plan for adding element sourcing priority to the DollhouseMCP MCP server. The feature will enforce a consistent order when searching for and installing elements across multiple sources (local portfolio, GitHub portfolio, and collection).

**Created**: November 5, 2025
**Status**: Planning
**Target Version**: 1.10.0

## Problem Statement

Currently, the system searches for elements across three sources without enforced priority:
- **Local Portfolio** (`~/.dollhouse/portfolio/`)
- **GitHub Portfolio** (user's personal GitHub repository)
- **Collection** (DollhouseMCP community collection)

### Issues with Current Architecture

1. **No Enforced Sourcing Order**: `UnifiedIndexManager.search()` executes searches in parallel, with no guaranteed priority
2. **Inconsistent Installation Behavior**: `ElementInstaller` only checks collection, ignoring local/GitHub
3. **Confusing User Experience**: Users don't know which source takes precedence
4. **No Configuration Options**: Cannot customize sourcing behavior
5. **Duplicate Handling Unclear**: When element exists in multiple sources, selection logic is based on scoring, not source priority

### Current Code Locations

**Key Files**:
- `/src/portfolio/UnifiedIndexManager.ts` - Unified search across sources (lines 228-364)
- `/src/collection/ElementInstaller.ts` - Element installation (lines 50-155)
- `/src/config/portfolioConfig.ts` - Portfolio configuration utilities
- `/src/config/constants.ts` - Application constants

**Current Behavior**:
```typescript
// UnifiedIndexManager.search() - Lines 284-322
// Searches sources in parallel with no enforced order
const searchPromises: Promise<UnifiedSearchResult[]>[] = [];
if (includeLocal) searchPromises.push(this.searchLocal(...));
if (includeGitHub) searchPromises.push(this.searchGitHub(...));
if (includeCollection) searchPromises.push(this.searchCollection(...));
```

## Requirements

### Functional Requirements

1. **FR-1: Enforced Source Priority**
   - System MUST check sources in order: Local → GitHub → Collection
   - Once an element is found in a source, searching MUST stop (unless override specified)
   - User MUST be able to see which source was used

2. **FR-2: Configurable Priority**
   - System MUST allow users to configure custom source priority order
   - Configuration MUST be persistent across sessions
   - Configuration MUST be validated for correctness

3. **FR-3: Override Mechanisms**
   - Users MUST be able to force search of all sources (for comparison)
   - Users MUST be able to specify preferred source for specific operations
   - System MUST support "update available" detection across sources

4. **FR-4: Installation Priority**
   - Installation MUST check sources in priority order
   - Installation MUST inform user if element exists in higher-priority source
   - Installation MUST support "force download from specific source"

5. **FR-5: Backward Compatibility**
   - Existing installations MUST continue working
   - Default behavior MUST match expected sourcing order (local → GitHub → collection)
   - API changes MUST be non-breaking

### Non-Functional Requirements

1. **NFR-1: Performance**
   - Source priority MUST NOT significantly impact search performance
   - Early termination MUST improve performance when element found early
   - Caching behavior MUST remain intact

2. **NFR-2: Maintainability**
   - Configuration logic MUST be centralized
   - Source priority MUST be easy to extend for new sources
   - Code MUST follow existing patterns and conventions

3. **NFR-3: Testing**
   - Test coverage MUST remain above 96%
   - All sourcing scenarios MUST be tested
   - Integration tests MUST verify end-to-end behavior

## Architecture Design

### 1. Centralized Source Configuration

Create a new configuration module for source priority:

**File**: `/src/config/sourcePriority.ts`

```typescript
/**
 * Element source priority configuration
 * Defines the order in which element sources are checked
 */

export enum ElementSource {
  LOCAL = 'local',
  GITHUB = 'github',
  COLLECTION = 'collection'
}

export interface SourcePriorityConfig {
  /** Ordered list of sources to check (first = highest priority) */
  priority: ElementSource[];

  /** Whether to stop searching after finding element in first source */
  stopOnFirst: boolean;

  /** Whether to check all sources for version comparison */
  checkAllForUpdates: boolean;

  /** Fallback behavior when primary source fails */
  fallbackOnError: boolean;
}

export const DEFAULT_SOURCE_PRIORITY: SourcePriorityConfig = {
  priority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
  stopOnFirst: true,
  checkAllForUpdates: false,
  fallbackOnError: true
};

/**
 * Get current source priority configuration
 * Priority order:
 * 1. User configuration (from config file)
 * 2. Environment variables (for testing)
 * 3. Default configuration
 */
export function getSourcePriorityConfig(): SourcePriorityConfig {
  // TODO: Implement config file reading
  // TODO: Implement environment variable support
  return DEFAULT_SOURCE_PRIORITY;
}

/**
 * Validate source priority configuration
 */
export function validateSourcePriority(config: SourcePriorityConfig): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check for duplicate sources
  const uniqueSources = new Set(config.priority);
  if (uniqueSources.size !== config.priority.length) {
    errors.push('Duplicate sources in priority list');
  }

  // Check for unknown sources
  const validSources = Object.values(ElementSource);
  for (const source of config.priority) {
    if (!validSources.includes(source)) {
      errors.push(`Unknown source: ${source}`);
    }
  }

  // Check for empty priority list
  if (config.priority.length === 0) {
    errors.push('Priority list cannot be empty');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Get source display name for user-facing messages
 */
export function getSourceDisplayName(source: ElementSource): string {
  const names: Record<ElementSource, string> = {
    [ElementSource.LOCAL]: 'Local Portfolio',
    [ElementSource.GITHUB]: 'GitHub Portfolio',
    [ElementSource.COLLECTION]: 'Community Collection'
  };
  return names[source];
}
```

### 2. Update UnifiedIndexManager

Modify `/src/portfolio/UnifiedIndexManager.ts` to respect source priority:

**Changes**:

1. **Add configuration property**:
```typescript
private sourcePriorityConfig: SourcePriorityConfig;

private constructor() {
  // ... existing code ...
  this.sourcePriorityConfig = getSourcePriorityConfig();
}
```

2. **Replace parallel search with sequential priority-based search**:
```typescript
/**
 * Enhanced search with source priority support
 */
public async search(searchOptions: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
  // ... existing validation code ...

  const config = this.sourcePriorityConfig;
  const enabledSources = this.getEnabledSourcesByPriority(searchOptions);

  const allResults: UnifiedSearchResult[] = [];

  // CHANGE: Search sources in priority order instead of parallel
  for (const source of enabledSources) {
    try {
      const sourceResults = await this.searchWithFallback(source, normalizedQuery, normalizedSearchOptions);

      if (sourceResults.length > 0) {
        allResults.push(...sourceResults);

        // CHANGE: Stop on first match if configured
        if (config.stopOnFirst && !searchOptions.includeAll) {
          logger.info(`Found results in ${source}, stopping search per priority config`);
          break;
        }
      }
    } catch (error) {
      if (config.fallbackOnError) {
        logger.warn(`Source ${source} failed, continuing to next source`, { error });
        continue;
      } else {
        throw error;
      }
    }
  }

  // ... existing processing code ...
}

/**
 * Get enabled sources ordered by priority
 */
private getEnabledSourcesByPriority(options: UnifiedSearchOptions): ElementSource[] {
  const config = this.sourcePriorityConfig;
  const enabledSources: ElementSource[] = [];

  for (const source of config.priority) {
    const isEnabled = this.isSourceEnabled(source, options);
    if (isEnabled) {
      enabledSources.push(source);
    }
  }

  return enabledSources;
}

/**
 * Check if a source is enabled for this search
 */
private isSourceEnabled(source: ElementSource, options: UnifiedSearchOptions): boolean {
  switch (source) {
    case ElementSource.LOCAL:
      return options.includeLocal !== false;
    case ElementSource.GITHUB:
      return options.includeGitHub !== false;
    case ElementSource.COLLECTION:
      return options.includeCollection === true;
    default:
      return false;
  }
}
```

3. **Add method to check for updates across all sources**:
```typescript
/**
 * Check if updates are available in other sources
 * Always checks all sources regardless of stopOnFirst setting
 */
public async checkForUpdates(elementName: string): Promise<{
  hasUpdate: boolean;
  currentSource: ElementSource;
  updateSource: ElementSource | null;
  currentVersion: string;
  updateVersion: string | null;
}> {
  const results = await this.search({
    query: elementName,
    includeLocal: true,
    includeGitHub: true,
    includeCollection: true,
    includeAll: true // Force search all sources
  });

  // Find element in highest priority source
  const priorityOrder = this.sourcePriorityConfig.priority;
  let current: UnifiedSearchResult | null = null;

  for (const source of priorityOrder) {
    const found = results.find(r => r.source === source && r.entry.name === elementName);
    if (found) {
      current = found;
      break;
    }
  }

  if (!current) {
    return {
      hasUpdate: false,
      currentSource: ElementSource.LOCAL,
      updateSource: null,
      currentVersion: 'unknown',
      updateVersion: null
    };
  }

  // Check if higher version exists in other sources
  let bestVersion = current.version || '0.0.0';
  let bestSource = current.source as ElementSource;

  for (const result of results) {
    if (result.entry.name === elementName && result.version) {
      if (this.compareVersions(result.version, bestVersion) > 0) {
        bestVersion = result.version;
        bestSource = result.source as ElementSource;
      }
    }
  }

  return {
    hasUpdate: bestSource !== current.source,
    currentSource: current.source as ElementSource,
    updateSource: bestSource !== current.source ? bestSource : null,
    currentVersion: current.version || 'unknown',
    updateVersion: bestSource !== current.source ? bestVersion : null
  };
}
```

### 3. Update ElementInstaller

Modify `/src/collection/ElementInstaller.ts` to check sources in priority order:

**Changes**:

1. **Add source priority support**:
```typescript
import { getSourcePriorityConfig, ElementSource, getSourceDisplayName } from '../config/sourcePriority.js';

export class ElementInstaller {
  private sourcePriorityConfig: SourcePriorityConfig;
  private unifiedIndexManager: UnifiedIndexManager;

  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
    this.portfolioManager = PortfolioManager.getInstance();
    this.sourcePriorityConfig = getSourcePriorityConfig();
    this.unifiedIndexManager = UnifiedIndexManager.getInstance();
  }

  /**
   * Install element from specified source
   * If source is not specified, checks sources in priority order
   */
  async installElement(options: {
    elementName: string;
    elementType: ElementType;
    preferredSource?: ElementSource;
    force?: boolean;
  }): Promise<InstallResult> {
    const { elementName, elementType, preferredSource, force } = options;

    // Step 1: Check if element already exists locally
    const localExists = await this.checkLocalElement(elementName, elementType);
    if (localExists && !force) {
      return {
        success: false,
        message: `Element already exists locally: ${elementName}`,
        source: ElementSource.LOCAL
      };
    }

    // Step 2: If preferred source specified, try that first
    if (preferredSource) {
      const result = await this.installFromSource(elementName, elementType, preferredSource);
      if (result.success) {
        return result;
      }

      if (!this.sourcePriorityConfig.fallbackOnError) {
        return result; // Return failure, don't try other sources
      }

      logger.info(`Preferred source ${preferredSource} failed, trying priority order`);
    }

    // Step 3: Try sources in priority order
    for (const source of this.sourcePriorityConfig.priority) {
      if (source === preferredSource) {
        continue; // Already tried
      }

      const result = await this.installFromSource(elementName, elementType, source);
      if (result.success) {
        return result;
      }
    }

    return {
      success: false,
      message: `Element not found in any source: ${elementName}`,
      source: null
    };
  }

  /**
   * Install element from specific source
   */
  private async installFromSource(
    elementName: string,
    elementType: ElementType,
    source: ElementSource
  ): Promise<InstallResult> {
    try {
      switch (source) {
        case ElementSource.LOCAL:
          // Already checked in installElement
          return {
            success: false,
            message: 'Element not in local source',
            source: ElementSource.LOCAL
          };

        case ElementSource.GITHUB:
          return await this.installFromGitHub(elementName, elementType);

        case ElementSource.COLLECTION:
          return await this.installFromCollection(elementName, elementType);

        default:
          return {
            success: false,
            message: `Unknown source: ${source}`,
            source: null
          };
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        source
      };
    }
  }

  // Implement installFromGitHub and installFromCollection methods
  // ...
}
```

### 4. Update Search Options Interface

Modify `UnifiedSearchOptions` to support priority override:

```typescript
export interface UnifiedSearchOptions {
  query: string;
  includeLocal?: boolean;
  includeGitHub?: boolean;
  includeCollection?: boolean;
  elementType?: ElementType;
  page?: number;
  pageSize?: number;
  sortBy?: 'relevance' | 'source' | 'name' | 'version';

  // NEW: Priority override options
  includeAll?: boolean;           // Force search all sources, ignore stopOnFirst
  preferredSource?: ElementSource; // Prefer specific source
  sourcePriority?: ElementSource[]; // Override default priority for this search
}
```

## Implementation Breakdown

### Phase 1: Core Infrastructure (4-6 hours)

**Tasks**:
1. Create `/src/config/sourcePriority.ts` with:
   - `ElementSource` enum
   - `SourcePriorityConfig` interface
   - `getSourcePriorityConfig()` function
   - `validateSourcePriority()` function
   - `getSourceDisplayName()` function

2. Add unit tests for configuration module:
   - Test default configuration
   - Test validation (valid and invalid configs)
   - Test display names

**Acceptance Criteria**:
- Configuration module exists with full TypeScript types
- Unit tests achieve >96% coverage
- Documentation includes examples

**Files to Create/Modify**:
- `src/config/sourcePriority.ts` (NEW)
- `test/__tests__/unit/config/sourcePriority.test.ts` (NEW)

### Phase 2: UnifiedIndexManager Updates (6-8 hours)

**Tasks**:
1. Add `sourcePriorityConfig` property to `UnifiedIndexManager`
2. Modify `search()` method to use sequential priority-based search
3. Add `getEnabledSourcesByPriority()` method
4. Add `isSourceEnabled()` method
5. Add `checkForUpdates()` method for cross-source version checking
6. Update `UnifiedSearchOptions` interface

**Acceptance Criteria**:
- Search respects source priority order
- `stopOnFirst` config stops search after first match
- `includeAll` option forces search of all sources
- All existing tests pass
- New tests cover priority behavior

**Files to Modify**:
- `src/portfolio/UnifiedIndexManager.ts`
- `test/__tests__/unit/portfolio/UnifiedIndexManager.test.ts`

### Phase 3: ElementInstaller Updates (4-6 hours)

**Tasks**:
1. Add `sourcePriorityConfig` property
2. Add `unifiedIndexManager` property for source checking
3. Implement `installElement()` method with priority support
4. Implement `installFromSource()` method
5. Implement `checkLocalElement()` helper
6. Implement `installFromGitHub()` method
7. Implement `installFromCollection()` method (refactor existing `installContent`)

**Acceptance Criteria**:
- Installation checks sources in priority order
- `preferredSource` option works
- Error handling respects `fallbackOnError` config
- All existing tests pass
- New tests cover installation priority

**Files to Modify**:
- `src/collection/ElementInstaller.ts`
- `test/__tests__/unit/collection/ElementInstaller.test.ts`

### Phase 4: Configuration API (3-4 hours)

**Tasks**:
1. Add `dollhouse_config` tool method for source priority configuration
2. Add validation and user-friendly error messages
3. Add persistence of user configuration
4. Update existing config tools to include source priority section

**Acceptance Criteria**:
- Users can view current source priority via MCP tool
- Users can modify source priority via MCP tool
- Invalid configurations are rejected with helpful errors
- Configuration persists across restarts

**Files to Modify**:
- `src/tools/config/dollhouseConfigTool.ts`
- `test/__tests__/unit/tools/config/dollhouseConfigTool.test.ts`

### Phase 5: Integration Tests (4-5 hours)

**Tasks**:
1. Create integration test for priority-based search
2. Create integration test for priority-based installation
3. Create integration test for update checking
4. Create integration test for fallback behavior
5. Create integration test for configuration persistence

**Acceptance Criteria**:
- End-to-end workflows verified
- All source priority scenarios covered
- Test coverage remains >96%
- Tests run in CI/CD pipeline

**Files to Create/Modify**:
- `test/__tests__/integration/source-priority.test.ts` (NEW)
- `test/__tests__/integration/element-installation-priority.test.ts` (NEW)

### Phase 6: Documentation (2-3 hours)

**Tasks**:
1. Update README with source priority explanation
2. Add user guide for configuring source priority
3. Add developer guide for extending source priority
4. Update API documentation
5. Add migration guide for users

**Acceptance Criteria**:
- Users understand source priority concept
- Users know how to configure source priority
- Developers know how to add new sources
- Migration path is clear

**Files to Create/Modify**:
- `README.md`
- `docs/USER_GUIDE.md`
- `docs/DEVELOPER_GUIDE.md`
- `docs/API.md`
- `docs/MIGRATION_GUIDE.md`

## Testing Strategy

### Unit Tests

**Coverage Target**: >96%

**Test Scenarios**:

1. **Configuration Module**:
   - Default configuration is valid
   - Custom configurations are validated correctly
   - Invalid configurations are rejected
   - Display names are correct

2. **UnifiedIndexManager**:
   - Sources searched in priority order
   - Search stops on first match when `stopOnFirst` is true
   - All sources searched when `includeAll` is true
   - Fallback works when source fails
   - Update checking works across all sources

3. **ElementInstaller**:
   - Installs from first available source in priority order
   - Preferred source is tried first
   - Fallback works when preferred source fails
   - Local check prevents duplicate installations

### Integration Tests

**Test Scenarios**:

1. **End-to-End Search**:
   - Element exists only in local → finds in local
   - Element exists in GitHub and collection → finds in GitHub (higher priority)
   - Element exists in all sources → finds in local (highest priority)
   - `includeAll` finds element in all sources

2. **End-to-End Installation**:
   - Install from collection when not in local/GitHub
   - Install from GitHub when not in local but available in GitHub
   - Reject installation when already in local
   - Force installation overwrites local

3. **Configuration Persistence**:
   - Configure custom priority → restart → priority persists
   - Invalid configuration → rejected → fallback to default
   - Reset configuration → returns to default

### Edge Cases

1. **All sources fail**: Graceful error handling
2. **Network timeout**: Fallback to cached data or next source
3. **Invalid source specified**: Clear error message
4. **Empty priority list**: Use default priority
5. **Circular dependencies**: Prevention mechanism

## Performance Considerations

### Expected Performance Impact

**Positive**:
- **Early termination**: When element found in first source, skip remaining sources (faster)
- **Reduced API calls**: Fewer GitHub API calls when element found locally

**Negative**:
- **Sequential search**: Loses parallelism benefits (slower when element in later source)

**Mitigation**:
- Keep caching behavior intact
- Add `includeAll` option for cases where parallel search is beneficial
- Make sequential search the default for consistency

### Performance Benchmarks

**Metrics to Track**:
- Average search time (local-only, GitHub-only, collection-only, all sources)
- Cache hit rate
- API call count
- Memory usage

**Targets**:
- Local search: < 10ms
- GitHub search: < 500ms
- Collection search: < 1000ms
- Search with early termination: 20-50% faster than current parallel search

## Backward Compatibility

### API Changes

**Breaking Changes**: None

**New Options** (backward compatible):
- `UnifiedSearchOptions.includeAll` - Optional, defaults to false
- `UnifiedSearchOptions.preferredSource` - Optional, defaults to undefined
- `UnifiedSearchOptions.sourcePriority` - Optional, defaults to undefined

**Behavior Changes**:
- Search order becomes deterministic (was pseudo-random due to parallel execution)
- Default behavior matches expected priority (local → GitHub → collection)
- Existing code continues to work without modifications

### Migration Path

**For Users**:
1. Existing installations continue working
2. Default priority matches expected behavior
3. No configuration changes required
4. Optional: Customize priority via configuration

**For Developers**:
1. New source priority system is opt-in
2. Existing search code continues working
3. Optional: Use new priority options for better control

## Estimated Effort

| Phase | Tasks | Estimated Time | Risk Level |
|-------|-------|----------------|------------|
| Phase 1: Core Infrastructure | Configuration module | 4-6 hours | Low |
| Phase 2: UnifiedIndexManager | Search priority implementation | 6-8 hours | Medium |
| Phase 3: ElementInstaller | Installation priority | 4-6 hours | Medium |
| Phase 4: Configuration API | User-facing config tools | 3-4 hours | Low |
| Phase 5: Integration Tests | End-to-end testing | 4-5 hours | Medium |
| Phase 6: Documentation | User and developer docs | 2-3 hours | Low |
| **Total** | | **23-32 hours** | **Medium** |

**Risk Areas**:
1. **Performance regression**: Sequential search may be slower in some cases
2. **Breaking changes**: Careful testing needed to ensure backward compatibility
3. **Configuration complexity**: Users may be confused by options

**Mitigation**:
1. Benchmark performance before/after, optimize as needed
2. Comprehensive testing with existing test suite
3. Clear documentation with examples

## Success Criteria

1. ✅ Sources are checked in priority order (local → GitHub → collection)
2. ✅ Configuration is centralized and easy to modify
3. ✅ Test coverage remains >96%
4. ✅ No breaking changes to existing API
5. ✅ Performance is equal or better than current implementation
6. ✅ Documentation is clear and comprehensive
7. ✅ Users can customize source priority
8. ✅ CI/CD pipeline passes all checks

## Future Enhancements

1. **Dynamic Priority**: Adjust priority based on network conditions, cache freshness
2. **Source Weights**: Allow weighting sources instead of strict priority
3. **Smart Caching**: Cache element locations for faster subsequent searches
4. **Source Health Monitoring**: Track source availability and adjust priority
5. **User Preferences**: Remember user's preferred sources per element type

## References

- [UnifiedIndexManager.ts](/src/portfolio/UnifiedIndexManager.ts) - Current unified search implementation
- [ElementInstaller.ts](/src/collection/ElementInstaller.ts) - Current installation logic
- [portfolioConfig.ts](/src/config/portfolioConfig.ts) - Portfolio configuration utilities
- [CONTRIBUTING.md](/CONTRIBUTING.md) - Development guidelines
- [CONVENTIONS.md](/docs/CONVENTIONS.md) - Coding conventions

---

**Next Steps**:
1. Review and approve this implementation plan
2. Create GitHub issues for each phase
3. Begin implementation with Phase 1
4. Iterate based on testing and feedback
