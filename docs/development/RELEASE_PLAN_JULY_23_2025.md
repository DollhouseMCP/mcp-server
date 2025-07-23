# Release Planning Document - July 23, 2025

## Executive Summary

This document outlines the prioritized issues and release plan for DollhouseMCP following the completion of the element system (PR #359). The focus is on ensuring a stable release with no critical failures, proper default content, and seamless integration with the Dollhouse MCP collection.

## Critical Issues Discovered

### 1. **No Default Content in NPM Package** 🚨
- **Issue**: #369 (newly created)
- **Problem**: The `data/personas/` directory exists but isn't included in the npm package
- **Impact**: New installations have no content, leading to poor first experience
- **Fix**: Update `package.json` files field to include `data/personas/**/*.md`

### 2. **Empty Directory Handling** 🚨
- **Issue**: #370 (newly created)
- **Problem**: System may error when element directories are empty or missing
- **Impact**: Users see errors instead of helpful empty state messages
- **Fix**: Add graceful handling to all element managers

## Complete Issue List by Priority

### 🔴 **CRITICAL - Release Blockers**

| Issue | Title | Impact | Effort |
|-------|-------|--------|--------|
| #369 | Include default personas in npm package | No content on install | 5 min |
| #370 | Handle empty element directories gracefully | Errors on empty dirs | 1 hour |
| #103 | Create Test Personas Directory for CI | CI failures | 30 min |

### 🟠 **HIGH - Security & Bugs**

| Issue | Title | Impact | Effort |
|-------|-------|--------|--------|
| #206 | Information Disclosure via Error Messages | Security leak | 2 hours |
| #254 | Implement audit logging for security ops | No security tracking | 4 hours |
| #266 | Add error handling for shouldSuppress | Potential crashes | 1 hour |
| #226 | Fix PathValidator atomic write test | Test failures | 2 hours |
| #361 | Fix EnsembleManager test mock setup | Test failures | 1 hour |

### 🟡 **MEDIUM - Collection Integration**

| Issue | Title | Impact | Effort |
|-------|-------|--------|--------|
| #345 | Collection Integration for all elements | Limited to personas | 4 hours |
| #283 | Validate collection repository structure | Integration issues | 2 hours |
| #281 | Add tool versioning | Breaking changes | 3 hours |
| #282 | Backward compatibility aliases | Migration pain | 2 hours |

### 🟢 **MEDIUM - User Experience**

| Issue | Title | Impact | Effort |
|-------|-------|--------|--------|
| #360 | Clarify activation strategies | User confusion | 1 hour |
| #367 | Improve error messages | Hard debugging | 2 hours |
| #347 | Author anonymization | Privacy concerns | 3 hours |
| #348 | Token usage analytics | No usage tracking | 4 hours |

### 🔵 **LOWER - Enhancements**

| Issue | Title | Impact | Effort |
|-------|-------|--------|--------|
| #302/303 | File locking/atomic operations | Concurrent access | 4 hours |
| #364 | YAML bomb detection | Security edge case | 3 hours |
| #365 | Cross-platform path validation | Platform issues | 2 hours |
| #366 | Plain YAML support | API confusion | 2 hours |
| #368 | Configurable resource limits | Flexibility | 2 hours |

## Recommended Release Strategy

### Phase 1: Critical Fixes (1 day)
1. **Fix #369** - Add default personas to package.json
2. **Fix #370** - Add empty directory handling
3. **Fix #103** - Ensure CI has test personas
4. **Test fresh installation flow**

### Phase 2: Security & Stability (2 days)
1. **Fix #206** - Sanitize error messages
2. **Fix #266** - Add error handling
3. **Run security audit**
4. **Test error scenarios**

### Phase 3: Collection Integration (2 days)
1. **Review #345** - Ensure basic collection support works
2. **Test with Dollhouse MCP collection**
3. **Document any limitations**

### Phase 4: Release Preparation (1 day)
1. Update CHANGELOG.md
2. Bump version number
3. Create release notes
4. Test npm package locally
5. Test on fresh system

## Testing Checklist

### Fresh Installation Testing
- [ ] npm install works without errors
- [ ] Default personas are available
- [ ] All element types can be listed without errors
- [ ] Empty directories show helpful messages
- [ ] No security warnings in logs

### Collection Integration Testing
- [ ] Can browse collection
- [ ] Can install personas from collection
- [ ] Can install other element types (if supported)
- [ ] Error handling for missing elements
- [ ] Proper attribution handling

### Error Scenario Testing
- [ ] Missing directories handled gracefully
- [ ] Permission denied handled gracefully
- [ ] Corrupted files show clear errors
- [ ] No sensitive paths in error messages
- [ ] No stack traces exposed to users

## Quick Implementation Guide

### Fix #369: Include Default Personas
```json
// package.json
"files": [
  "dist/**/*.js",
  "dist/**/*.d.ts",
  "dist/**/*.d.ts.map",
  "data/personas/**/*.md",  // ADD THIS LINE
  "!dist/__tests__/**",
  "!dist/**/*.test.*",
  "README.md",
  "LICENSE",
  "CHANGELOG.md"
]
```

### Fix #370: Handle Empty Directories
```typescript
// In each manager's list() method
async list(): Promise<Element[]> {
  try {
    const files = await fs.readdir(this.baseDir);
    // ... existing code
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Directory doesn't exist - this is fine
      logger.debug(`Directory ${this.baseDir} does not exist, returning empty list`);
      return [];
    }
    // Real error - log and throw
    logger.error(`Failed to list ${this.elementType}:`, error);
    throw error;
  }
}
```

### Fix #206: Sanitize Error Messages
```typescript
// Before
throw new Error(`Failed to load persona from ${fullPath}: ${error.message}`);

// After
throw new Error(`Failed to load persona: ${error.message}`);
// Log full details internally
logger.error(`Failed to load persona from ${fullPath}:`, error);
```

## Success Criteria

1. **No Crashes**: Fresh install works without any errors
2. **Default Content**: Users have 5 personas to start with
3. **Graceful Empty States**: Clear messages when no content exists
4. **Collection Ready**: Can browse and install from collection
5. **Secure**: No sensitive information in error messages
6. **Tested**: All scenarios pass on Mac/Linux/Windows

## Timeline Estimate

- **Minimum viable release**: 2-3 days (Phase 1 + critical Phase 2)
- **Recommended release**: 5-6 days (Phases 1-3)
- **Full release**: 7-8 days (All phases)

## Post-Release Priorities

1. Full collection integration (#345)
2. Security audit system (#254, #265)
3. Performance optimizations (#341)
4. Advanced features (Cast of Characters #363)

---
*Document created: July 23, 2025*
*Next review: Before release*