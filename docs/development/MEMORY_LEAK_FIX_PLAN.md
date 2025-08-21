# Critical Memory Leak Fix Plan - PR #650

**Severity**: 🔴 CRITICAL  
**Issue**: Memory leak test failing with 6.1MB growth (6x over limit)  
**Impact**: Cannot merge PR until resolved  
**Orchestrator**: Opus 4.1  

## Problem Analysis

### Current Failure
```
Test: Metadata Detection - Performance Benchmarks › Memory Usage
Expected: < 1024 KB (1MB)
Actual: 6247 KB (6.1MB)
Location: test/__tests__/performance/metadata-detection.performance.test.ts:410
```

### Likely Causes (from Agent 3's changes)

1. **Buffer Pool Issues**
   - Buffers not being properly released
   - Pool growing without bounds
   - Statistics tracking accumulating data

2. **Metadata Cache Issues**
   - Cache not respecting MAX_CACHE_SIZE
   - Old entries not being evicted
   - Memory references preventing GC

3. **Performance Stats Accumulation**
   - Stats object growing with each operation
   - No cleanup between operations
   - Possible circular references

## Investigation Plan

### Step 1: Understand the Test
- Read the memory leak test to understand what it's doing
- Check how many operations it performs (1000 mentioned)
- Identify what's being measured

### Step 2: Isolate the Leak Source
- Check buffer pool implementation
- Review metadata cache logic
- Examine performance stats tracking
- Look for missing cleanup calls

### Step 3: Fix Implementation
- Add proper cleanup mechanisms
- Ensure buffers are released
- Fix cache eviction logic
- Clear statistics between operations

## Agent Deployment Strategy

### Memory Leak Specialist (Sonnet)
**Primary Mission**: Fix the 6MB memory leak

**Tasks**:
1. Read the failing test to understand the scenario
2. Analyze DefaultElementProvider.ts for memory issues
3. Focus on:
   - Buffer pool management (lines 276-295, 358-378)
   - Metadata cache (lines 421-450)
   - Performance stats (lines 386-418)
4. Identify where memory is not being released
5. Implement fixes:
   - Ensure buffer pool has size limits
   - Fix cache eviction
   - Add proper cleanup calls
   - Remove any accumulating data structures
6. Test the fix locally

**Success Criteria**:
- Memory growth < 1MB for 1000 operations
- No performance degradation
- All other tests still pass

## Technical Approach

### Priority Fixes to Check

1. **Buffer Pool Cleanup**
```typescript
// Ensure buffers are cleared properly
private releaseBuffer(buffer: Buffer): void {
  buffer.fill(0); // Clear sensitive data
  // Make sure buffer is actually reusable
  // Check if pool size is bounded
}
```

2. **Cache Eviction**
```typescript
// Verify LRU eviction works
if (metadataCache.size >= MAX_CACHE_SIZE) {
  // Must actually delete oldest entry
  // Ensure no references remain
}
```

3. **Stats Reset**
```typescript
// Clear accumulated stats
public static cleanup(): void {
  // Must reset ALL accumulated data
  // Check for any growing arrays/maps
}
```

## Validation Steps

1. Run the specific failing test:
```bash
npm test -- test/__tests__/performance/metadata-detection.performance.test.ts
```

2. Monitor memory usage during test:
- Before fix: 6247 KB growth
- After fix: Should be < 1024 KB

3. Ensure no regressions:
```bash
npm test
```

## Risk Mitigation

- Make minimal changes to fix only the leak
- Don't break existing functionality
- Preserve performance optimizations where possible
- Document every change with clear comments

## Timeline

- Investigation: 5 minutes
- Fix implementation: 10 minutes
- Testing: 5 minutes
- Total: 20 minutes

## Rollback Plan

If fix causes other issues:
1. Revert buffer pool changes
2. Disable caching temporarily
3. Remove performance stats if needed

The memory leak MUST be fixed before PR #650 can be merged.