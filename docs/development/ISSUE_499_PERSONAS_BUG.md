# Issue: Claude Desktop Reports 499 Personas

## Problem Description
Claude Desktop is reporting "499 personas" including "test personas created during security testing", even though:
1. The test data safety mechanism is working correctly (confirmed via testing)
2. Only 6 personas exist in `data/personas/`
3. Only 31 total .md files exist in the entire `data/` directory

## Evidence

### Test Data Safety Working
```javascript
Test 1: Default behavior in development mode
- isTestDataLoadingEnabled: false
- isDevelopmentMode: true
```

### File Counts
- `data/personas/`: 6 files
- `data/*/*.md`: 31 files total
- Not even close to 499

## The Number 499
- Suspiciously close to 500 (common limit)
- Suggests hitting a hard limit somewhere
- Not a real count of actual files

## Theories

### Theory 1: Old Cached Data
Claude Desktop might be reading personas that were previously copied to `~/.dollhouse/portfolio/personas/` before the safety mechanism was implemented.

**Action**: Check and clean the portfolio directory

### Theory 2: Claude Desktop Bug
Claude Desktop itself might have a bug where it's:
- Generating phantom personas
- Miscounting
- Reading from wrong location
- Hitting a 500 item limit and showing 499

### Theory 3: Test Data Generation
Some test or process might be generating personas dynamically that aren't saved to disk.

## What's Working
- ✅ DefaultElementProvider correctly detects development mode
- ✅ Test data loading is disabled by default
- ✅ Can be enabled with `DOLLHOUSE_LOAD_TEST_DATA=true`
- ✅ No test data is being copied to portfolio

## What's Not Working
- ❌ Claude Desktop still "sees" 499 personas
- ❌ Claude Desktop mentions "test personas created during security testing"
- ❌ These phantom personas are visible to the end user

## Next Steps

1. **Check portfolio directory** - Count actual personas in `~/.dollhouse/portfolio/personas/`
2. **Clear portfolio** - Remove all test personas if they exist
3. **Restart Claude Desktop** - Clear any caches
4. **File bug report** - If issue persists, this is a Claude Desktop bug

## Workaround
For now, users should:
1. Manually clean their portfolio directory
2. Restart Claude Desktop
3. Only the legitimate personas should remain

---
*Issue discovered: August 11, 2025*