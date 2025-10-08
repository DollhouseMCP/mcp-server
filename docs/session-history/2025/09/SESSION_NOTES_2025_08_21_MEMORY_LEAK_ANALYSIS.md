# Session Notes - August 21, 2025 - Memory Leak Analysis & Lessons Learned

**Date**: August 21, 2025  
**Time**: Morning/Afternoon session  
**Branch**: `feature/metadata-based-test-detection`  
**PR**: #650  
**Status**: ⚠️ NEEDS REVERT - Wrong approach taken to fix memory leak  

## Critical Issue Summary

### The Problem
- Memory leak test failing with 6.1MB growth (6x over 1MB limit)
- Test: `metadata-detection.performance.test.ts:410`
- Calls `readMetadataOnly()` 1000 times on same file

### What We Did Wrong ❌

**Took a shortcut by replacing SecureYamlParser with yaml.load**
- Commit: c140c21
- This "fixed" the memory leak but broke security
- Caused 3 test failures (zero-width characters no longer blocked)
- **This was the WRONG approach**

### Why This Was Wrong

1. **SecureYamlParser is proven**: It's been in the codebase for months without memory leaks
2. **Security regression**: yaml.load allows dangerous content through
3. **Missed the real issue**: The leak is in the NEW caching/pooling code, not the parser
4. **Previous evidence**: Multiple PRs have proven we need SecureYamlParser for security

## What Actually Needs to Happen

### Step 1: Revert the Wrong Fix
```bash
git revert c140c21
# This will restore SecureYamlParser usage
# Keep the test cleanup additions (those were good)
```

### Step 2: Proper Root Cause Analysis

#### The REAL memory leak is likely in one of these areas:

**1. Metadata Cache Key Generation**
```typescript
// Line 424 in DefaultElementProvider.ts
const cacheKey = filePath;
```
- Is this creating unique keys for the same file?
- Are we getting 1000 cache entries for 1 file?
- Check: Log cache.size after each operation

**2. Cache Eviction Logic**
```typescript
// Line 469-475
if (DefaultElementProvider.metadataCache.size >= DefaultElementProvider.MAX_CACHE_SIZE) {
  const firstKey = DefaultElementProvider.metadataCache.keys().next().value;
  DefaultElementProvider.metadataCache.delete(firstKey);
}
```
- Is this actually working?
- Is the cache growing beyond MAX_CACHE_SIZE?
- Check: Log eviction events

**3. Buffer Pool Not Releasing**
```typescript
// The buffer should be released in finally block
} finally {
  await fd.close();
  this.releaseBuffer(buffer);
}
```
- Is releaseBuffer being called in ALL paths?
- Are there early returns missing the release?
- Check: Add logging to track buffer pool size

**4. Performance Stats Accumulation**
```typescript
private static bufferPoolStats = { hits: 0, misses: 0, created: 0 };
```
- These counters keep growing
- But do they reference any objects that prevent GC?
- Check: Are there any arrays or objects growing?

**5. File Descriptor Leaks**
- Is `fd.close()` being called in all error paths?
- Are we leaking file descriptors?
- Check: Track open file descriptors

### Step 3: Proper Debugging Approach

#### Add Diagnostic Logging (temporarily)
```typescript
private async readMetadataOnly(filePath: string, retries = 2): Promise<any | null> {
  console.log(`[MEMORY DEBUG] Cache size: ${DefaultElementProvider.metadataCache.size}`);
  console.log(`[MEMORY DEBUG] Buffer pool size: ${DefaultElementProvider.bufferPool.length}`);
  console.log(`[MEMORY DEBUG] Cache keys: ${Array.from(DefaultElementProvider.metadataCache.keys()).join(', ')}`);
  
  // Rest of method...
}
```

#### Run Just the Failing Test
```bash
npm test -- test/__tests__/performance/metadata-detection.performance.test.ts --testNamePattern="should not leak memory"
```

#### Analyze the Output
- Is cache size growing to 1000?
- Are buffer pool stats showing 1000s of creates?
- Are the cache keys all the same or different?

### Step 4: Likely Solutions (After Proper Analysis)

**If cache keys are duplicating:**
```typescript
// Normalize the cache key
const cacheKey = path.resolve(filePath);
```

**If cache isn't working:**
```typescript
// Fix the mtime comparison
if (cached && Math.floor(cached.mtime) === Math.floor(stats.mtimeMs) && cached.size === stats.size) {
```

**If buffers aren't releasing:**
```typescript
// Ensure release in all paths
try {
  // ... file operations
} catch (error) {
  this.releaseBuffer(buffer); // Add this
  throw error;
} finally {
  this.releaseBuffer(buffer);
}
```

**If SecureYamlParser IS the issue (unlikely):**
- Create a single instance and reuse it
- Clear any internal caches it might have
- Check if it's creating new validator instances

## Lessons Learned

### 1. Don't Replace Proven Components
- SecureYamlParser has been working for months
- If it had a memory leak, we'd have seen it before
- The leak appeared after NEW code was added

### 2. Analyze Before Acting
- Should have added logging first
- Should have identified WHERE memory was growing
- Should have proven which component was leaking

### 3. Security > Performance
- Never compromise security for performance
- yaml.load is dangerous and we know this
- SecureYamlParser exists for good reasons

### 4. Static Properties Need Care
- Static caches/pools persist across test instances
- Need proper bounds and cleanup
- Test isolation is critical

## Correct Diagnostic Process

1. **Add detailed logging** to track cache size, buffer pool size, etc.
2. **Run the specific test** in isolation
3. **Analyze the logs** to see what's growing
4. **Fix the specific issue** without breaking security
5. **Verify the fix** doesn't break other tests
6. **Clean up** diagnostic logging

## What NOT to Do

❌ Don't replace SecureYamlParser with yaml.load  
❌ Don't assume the memory leak is in existing code  
❌ Don't make security trade-offs for performance  
❌ Don't commit without understanding root cause  

## Next Session Actions

1. **Revert commit c140c21** (restore SecureYamlParser)
2. **Keep the test cleanup changes** (those were correct)
3. **Add diagnostic logging** to understand the leak
4. **Run the memory leak test** in isolation
5. **Identify the actual cause** (likely cache or buffer pool)
6. **Fix the real issue** without compromising security
7. **Verify all tests pass**
8. **Remove diagnostic logging**
9. **Commit with proper explanation**

## Important Code Locations

- Memory leak test: `test/__tests__/performance/metadata-detection.performance.test.ts:380-410`
- DefaultElementProvider: `src/portfolio/DefaultElementProvider.ts`
- Cache implementation: Lines 420-480
- Buffer pool: Lines 323-350
- SecureYamlParser: `src/security/secureYamlParser.ts`

## Key Metrics to Track

- Cache size after each operation (should be 1, not 1000)
- Buffer pool size (should be bounded by MAX_POOL_SIZE)
- Buffer creates count (should be minimal, not 1000)
- Memory growth (should be <1MB for 1000 ops)

## The Right Mental Model

The test is calling the SAME file 1000 times. This means:
- Cache should have 1 entry
- Buffer pool should reuse the same buffers
- Memory should be nearly flat

If memory is growing 6MB, something is creating 1000 of something when it should create 1.

---

**Remember**: The memory leak appeared AFTER adding the new caching and buffer pool code. The leak is almost certainly in that new code, NOT in SecureYamlParser which has been stable for months.