# Version Storage Approach - Dual Location Pattern

## Overview
This document explains the current dual-location version storage pattern in DollhouseMCP elements and the rationale behind keeping versions synchronized between `element.version` and `element.metadata.version`.

## Current Implementation

### Two Storage Locations

#### 1. `element.version`
- **Location**: Top-level property on BaseElement class
- **Definition**: Part of the IElement interface
- **Purpose**: The architectural design's intended location for version storage
- **Usage**: Primary source for version information in the element system

#### 2. `element.metadata.version`
- **Location**: Within the metadata object
- **Definition**: Part of IElementMetadata interface
- **Purpose**: Legacy compatibility and YAML frontmatter storage
- **Usage**: Used by some managers and expected in YAML files

## Why This Duplication Exists

### Historical Evolution
1. **Original Design**: Versions were stored in metadata as part of YAML frontmatter
2. **Element System Introduction**: BaseElement added `version` as a top-level property
3. **Transition Period**: Both locations needed to maintain backwards compatibility
4. **Current State**: Synchronization ensures both locations have the same value

### Code Example
```typescript
// BaseElement constructor shows the duplication
constructor(type: ElementType, metadata: Partial<IElementMetadata> = {}) {
    this.version = metadata.version || '1.0.0';  // Sets element.version
    this.metadata = {
        version: metadata.version,  // Also keeps in metadata
        // ... other metadata fields
    };
}
```

## Synchronization Strategy

### When Editing Elements
The `editElement` function keeps both locations synchronized:

```typescript
// When directly editing version
if (field === 'version' || field === 'metadata.version') {
    element.version = versionString;
    if (element.metadata) {
        element.metadata.version = versionString;
    }
}

// When auto-incrementing for other edits
element.version = incrementedVersion;
if (element.metadata) {
    element.metadata.version = element.version;
}
```

### When Saving Elements
Managers ensure version is included in saved metadata:

```typescript
// SkillManager.save()
if (element.version) {
    cleanMetadata.version = element.version;
}
```

## Problems with Current Approach

1. **Confusion**: Developers unsure which location is authoritative
2. **Synchronization Overhead**: Must remember to update both locations
3. **Testing Complexity**: Need to verify both locations remain in sync
4. **Maintenance Burden**: More code to maintain synchronization

## Benefits of Current Approach

1. **Backwards Compatibility**: Existing elements continue to work
2. **No Breaking Changes**: No migration required for users
3. **Flexible Reading**: Code can read from either location
4. **Gradual Migration Path**: Can transition to single source later

## Future Direction (Issue #592)

### Target State
- Single source of truth: `element.version` only
- Remove `version` from IElementMetadata interface
- All managers read/write from `element.version`

### Migration Plan
1. **Phase 1** (Current): Maintain synchronization
2. **Phase 2**: Update all managers to prefer `element.version`
3. **Phase 3**: Deprecate `metadata.version` with warnings
4. **Phase 4**: Remove `metadata.version` in major version update

### Backwards Compatibility
During migration, when loading elements:
```typescript
if (!element.version && element.metadata?.version) {
    element.version = element.metadata.version;
}
```

## Implementation Guidelines

### For New Code
1. Always read from `element.version` when possible
2. Always write to both locations for compatibility
3. Include version synchronization in tests

### For Existing Code
1. When refactoring, prefer `element.version`
2. Maintain synchronization until migration complete
3. Add comments explaining dual-storage pattern

## Testing Requirements

### Version Persistence Tests
- Verify version saves correctly to disk
- Verify version loads correctly from disk
- Verify both locations stay synchronized

### Edge Cases
- Missing version in one location
- Different versions in each location (prefer `element.version`)
- Version format validation

## Security Considerations

- Version strings are validated before storage
- Invalid versions are rejected with clear errors
- No injection risks from version manipulation

## Performance Impact

- Minimal: Two property assignments per version update
- No additional I/O operations
- Negligible memory overhead

## Conclusion

The dual-storage pattern is a transitional solution that maintains compatibility while the codebase evolves. While not ideal architecturally, it provides a safe path forward without breaking existing functionality. The synchronization overhead is acceptable given the benefits of backwards compatibility and will be removed in a future refactor (tracked in Issue #592).

---

*Last Updated: August 2025*
*Related Issues: #592 (Consolidation refactor), #593 (Version persistence fix)*