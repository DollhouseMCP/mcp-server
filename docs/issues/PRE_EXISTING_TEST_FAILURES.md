# Pre-Existing Test Failures

## Date Identified: September 8, 2025

### GitHubPortfolioIndexer Tests

**File**: `test/__tests__/unit/portfolio/GitHubPortfolioIndexer.test.ts`

**Failing Tests**:
1. `should fetch fresh data when cache is stale` - Returns 'unknown' instead of 'testuser'
2. `should fetch repository content using REST API` - Returns 'unknown' instead of 'testuser'
3. `should handle non-existent portfolio repository` - Returns 'unknown' instead of 'testuser'

**Root Cause**: 
The PortfolioRepoManager mock was missing the `githubRequest` method. This was partially fixed by adding it to the mock, but there are still some failures that need deeper investigation.

**Status**: Pre-existing issue, not caused by the portfolio download UX improvements.

**TypeScript Issues**:
- `global` is not defined (lines 290, 291, 362)
- `GitHubIndexEntry` is imported but never used (line 36)

These test failures existed before the changes made in the portfolio download UX improvement session and should be addressed in a separate fix.