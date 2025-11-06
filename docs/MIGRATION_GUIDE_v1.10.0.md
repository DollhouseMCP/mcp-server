# Migration Guide: v1.10.0 - Element Source Priority

## Overview

Version 1.10.0 introduces **deterministic element source priority**, providing explicit control over the order in which element sources (local, GitHub, collection) are checked during search and installation operations.

**Release Date**: November 2025
**Breaking Changes**: None
**Migration Required**: Optional (recommended for advanced users)

## What Changed

### Before v1.10.0

- Sources were effectively searched in parallel with undefined order
- No user control over source precedence
- Inconsistent behavior across different operations
- No way to prefer one source over another

### After v1.10.0

- **Sequential search** with deterministic priority order: Local → GitHub → Collection
- **User-configurable** priority through configuration system
- **Early termination** optimization (stops at first match)
- **Fallback mechanisms** for resilient operation
- **Runtime overrides** for specific operations

## Backward Compatibility

### No Breaking Changes

**All existing code continues to work without modification.**

The default configuration matches expected behavior:
```typescript
{
  priority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
  stopOnFirst: true,
  checkAllForUpdates: false,
  fallbackOnError: true
}
```

### Behavior Changes

While not breaking, you may notice these behavior differences:

1. **Search is now deterministic**
   - Before: Pseudo-random order depending on timing
   - After: Always checks local → GitHub → collection

2. **Search may be faster**
   - Before: All sources checked in parallel
   - After: Stops at first match (unless `includeAll: true`)

3. **Local customizations always win**
   - Before: Could get GitHub or collection version randomly
   - After: Local version always returned first (if exists)

## Do I Need to Migrate?

### No Migration Required If:

- You want local customizations to take precedence (default behavior)
- You're okay with sequential search order
- You don't need to customize source priority
- Your code doesn't depend on parallel search timing

**→ For most users, no action needed. Everything works as expected.**

### Consider Migration If:

- You need to prioritize GitHub over local
- You want to always check collection first
- You relied on parallel search performance
- You have custom search logic that depends on source order
- You want to optimize for specific workflows

## Migration Steps

### Step 1: Verify Current Behavior

Before making changes, verify elements are found from expected sources:

```bash
# Search for an element
mcp__DollhouseMCP__search_all \
  --query "creative-writer" \
  --sources '["local", "github", "collection"]'
```

Check which source provided the result. If it's not what you expected, consider customizing priority.

### Step 2: Review Source Priority Configuration

View your current configuration:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action get \
  --setting source_priority
```

Default output:
```yaml
source_priority:
  priority:
    - local
    - github
    - collection
  stopOnFirst: true
  checkAllForUpdates: false
  fallbackOnError: true
```

### Step 3: Customize if Needed

Only customize if the default doesn't match your workflow.

#### Example: Prioritize GitHub Over Local

If you work across multiple machines and want GitHub to be source of truth:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.priority \
  --value '["github", "local", "collection"]'
```

#### Example: Always Check All Sources

If you want to see all versions for comparison:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.stopOnFirst \
  --value false
```

#### Example: Disable Fallback

If you want strict error handling (no fallback to next source):

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.fallbackOnError \
  --value false
```

### Step 4: Test Thoroughly

After customization, test search and installation:

```bash
# Test search
mcp__DollhouseMCP__search_all \
  --query "test-element" \
  --sources '["local", "github", "collection"]'

# Test installation
mcp__DollhouseMCP__install_collection_content \
  --path "library/personas/creative-writer.md"
```

Verify results match your expectations.

### Step 5: Update Application Code (if needed)

If you have custom code using the search API, you can now use new options:

**Before:**
```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeLocal: true,
  includeGitHub: true,
  includeCollection: true
});
```

**After (with source priority options):**
```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeLocal: true,
  includeGitHub: true,
  includeCollection: true,
  sourcePriority: [ElementSource.GITHUB, ElementSource.LOCAL],  // NEW
  stopOnFirst: false,  // NEW
  preferredSource: ElementSource.COLLECTION  // NEW
});
```

## Common Migration Scenarios

### Scenario 1: Offline Development

**Problem**: Working without internet, don't want to wait for GitHub/collection timeouts.

**Solution**: Configure local-only priority:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.priority \
  --value '["local"]'
```

Or use search options:
```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeLocal: true,
  includeGitHub: false,
  includeCollection: false
});
```

### Scenario 2: Multi-Machine Development

**Problem**: Work across multiple machines, want GitHub as source of truth.

**Solution**: Prioritize GitHub over local:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.priority \
  --value '["github", "local", "collection"]'
```

### Scenario 3: Element Discovery

**Problem**: Browsing community elements, don't want local results interfering.

**Solution**: Use preferred source for discovery searches:

```typescript
const results = await unifiedIndex.search({
  query: '*',
  preferredSource: ElementSource.COLLECTION
});
```

### Scenario 4: Version Comparison

**Problem**: Want to see all versions across all sources.

**Solution**: Disable early termination:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.stopOnFirst \
  --value false
```

Or use `includeAll` option:
```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeAll: true  // Returns results from all sources
});
```

## Common Issues and Solutions

### Issue 1: Search seems slower after upgrade

**Symptoms**: Search takes longer than before upgrade.

**Cause**: Early termination should actually make searches faster. Slowness likely from other factors.

**Solutions**:

1. Verify `stopOnFirst` is enabled (default):
   ```bash
   mcp__DollhouseMCP__dollhouse_config --action get --setting source_priority.stopOnFirst
   ```

2. Check network connectivity if using GitHub or collection

3. Rebuild local index:
   ```bash
   mcp__DollhouseMCP__reload_elements --type personas
   ```

### Issue 2: Element not found after upgrade

**Symptoms**: Search returns no results for element that exists.

**Cause**: Source is not included in search or priority order excludes it.

**Solutions**:

1. Check which sources are enabled:
   ```bash
   mcp__DollhouseMCP__dollhouse_config --action get --setting source_priority
   ```

2. Try searching all sources:
   ```typescript
   const results = await unifiedIndex.search({
     query: 'missing-element',
     includeAll: true
   });
   ```

3. Verify element location:
   ```bash
   ls ~/.dollhouse/portfolio/personas/
   ```

### Issue 3: Installation fails with "already exists"

**Symptoms**: Installing element fails even though you don't see it.

**Cause**: Element exists in local portfolio.

**Solutions**:

1. List local elements:
   ```bash
   mcp__DollhouseMCP__list_elements --type personas
   ```

2. Delete local element first:
   ```bash
   mcp__DollhouseMCP__delete_element --name "element-name" --type personas
   ```

3. Or use force installation (when available)

### Issue 4: Wrong version being used

**Symptoms**: Local changes not reflected, old version appears.

**Cause**: Source priority may be misconfigured or local version is in different location.

**Solutions**:

1. Verify local is first in priority:
   ```bash
   mcp__DollhouseMCP__dollhouse_config --action get --setting source_priority.priority
   ```

2. Rebuild local index:
   ```bash
   mcp__DollhouseMCP__reload_elements --type personas
   ```

3. Check element filename matches:
   ```bash
   find ~/.dollhouse/portfolio -name "*element-name*"
   ```

### Issue 5: Configuration not persisting

**Symptoms**: Configuration changes don't persist across restarts.

**Cause**: Configuration file may not be writable or in wrong location.

**Solutions**:

1. Check config file exists:
   ```bash
   ls -la ~/.dollhouse/config.yml
   ```

2. Verify file permissions:
   ```bash
   chmod 644 ~/.dollhouse/config.yml
   ```

3. Use environment variable as temporary workaround:
   ```bash
   export SOURCE_PRIORITY='{"priority":["local","github","collection"],"stopOnFirst":true}'
   ```

## Rollback Plan

If you encounter issues, you can easily roll back:

### Option 1: Reset Configuration

Reset source priority to defaults:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action reset \
  --section source_priority
```

### Option 2: Manual Configuration Edit

Edit `~/.dollhouse/config.yml` directly:

```yaml
source_priority:
  priority:
    - local
    - github
    - collection
  stopOnFirst: true
  checkAllForUpdates: false
  fallbackOnError: true
```

### Option 3: Use Environment Override

Temporarily override with environment variable:

```bash
export SOURCE_PRIORITY='{"priority":["local","github","collection"],"stopOnFirst":true,"checkAllForUpdates":false,"fallbackOnError":true}'
```

## Testing Your Migration

After migration, test these scenarios:

### Test 1: Search finds local version first

```bash
# Create local element
mcp__DollhouseMCP__create_element \
  --type personas \
  --name "test-element" \
  --description "Test element"

# Search should find local version
mcp__DollhouseMCP__search_all \
  --query "test-element"
```

Expected: Results show source as "local"

### Test 2: Installation respects priority

```bash
# Try installing element that exists locally
mcp__DollhouseMCP__install_collection_content \
  --path "library/personas/creative-writer.md"
```

Expected: Error indicating element already exists (found in local)

### Test 3: Custom priority works

```typescript
// Search with custom priority
const results = await unifiedIndex.search({
  query: 'creative-writer',
  sourcePriority: [ElementSource.COLLECTION, ElementSource.LOCAL]
});
```

Expected: Collection version returned first (if exists in collection)

## Performance Considerations

### Sequential vs. Parallel

**Before v1.10.0**: Parallel search across all sources
- Pro: Potentially lower latency
- Con: Higher resource usage, inconsistent order

**After v1.10.0**: Sequential search with early termination
- Pro: Lower resource usage, predictable behavior
- Con: Higher latency if element in last source

**Recommendation**: Default sequential is better for most cases. Only consider parallel if:
- You always need results from all sources
- You have high-latency sources
- You're willing to handle more complex deduplication

### Optimization Tips

1. **Enable early termination** (default):
   - Stops at first match
   - Significantly faster for common searches

2. **Order sources by frequency**:
   - Put most frequently used source first
   - e.g., if you mostly use local, keep local first

3. **Cache source availability**:
   - System caches source status
   - Unavailable sources skipped quickly

4. **Use specific source searches**:
   - If you know which source has element, use `preferredSource`

## New Features You Can Use

### Runtime Priority Override

Search with temporary custom priority:

```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  sourcePriority: [ElementSource.COLLECTION, ElementSource.LOCAL]  // Just for this search
});
```

### Preferred Source

Force checking specific source first:

```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  preferredSource: ElementSource.GITHUB  // Check GitHub first
});
```

### Include All Sources

Get results from all sources for comparison:

```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeAll: true  // Don't stop at first match
});
```

### Configurable Fallback

Control what happens when source fails:

```bash
# Disable fallback (strict mode)
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.fallbackOnError \
  --value false
```

## Related Documentation

- [User Guide](USER_GUIDE.md#understanding-element-sources-and-priority) - Detailed usage guide
- [Developer Guide](DEVELOPER_GUIDE.md#element-source-priority-system) - Implementation details
- [API Reference](API_REFERENCE.md#element-source-priority-api-v1100) - Complete API documentation

## Getting Help

If you encounter issues during migration:

1. **Check documentation**: Review the guides above
2. **GitHub Issues**: [Report problems](https://github.com/DollhouseMCP/mcp-server/issues)
3. **Discussions**: [Ask questions](https://github.com/DollhouseMCP/mcp-server/discussions)
4. **Rollback**: Reset to defaults if needed (see [Rollback Plan](#rollback-plan))

## Summary

- **No breaking changes**: Everything works without modification
- **Default behavior**: Local → GitHub → Collection (matches expectations)
- **Optional migration**: Only customize if default doesn't fit your workflow
- **Easy rollback**: Reset to defaults anytime
- **New capabilities**: Runtime overrides, preferred sources, configurable fallback

Most users don't need to do anything. The system works better out of the box. Advanced users can customize for specific workflows.

---

*Last updated: 2025-11-06*
*Version: 1.10.0*
