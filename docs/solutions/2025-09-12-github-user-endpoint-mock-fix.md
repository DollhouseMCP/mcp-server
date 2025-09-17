# Solution: GitHub /user Endpoint Mock Required After Issue #913

**Date Discovered**: September 12, 2025  
**Issue**: Tests failing with "Failed to get GitHub username"  
**Root Cause**: Issue #913 fix changed authentication behavior  
**Solution**: Add `/user` endpoint mock to all affected tests  

---

## Problem Description

After Issue #913 was fixed, `PortfolioRepoManager.saveElement()` now correctly calls `getUsername()` to use the authenticated GitHub user's username instead of incorrectly using the element's author field. This prevents personas from using their author name as a GitHub username.

### Error Message
```
Failed to get GitHub username

  629 |     const response = await this.githubRequest('/user');
  630 |     if (!response || !response.login) {
> 631 |       throw new Error('Failed to get GitHub username');
```

---

## Root Cause

The fix for Issue #913 added this critical change:
```javascript
// BEFORE (incorrect - used element author)
const username = element.metadata.author;

// AFTER (correct - uses authenticated user)
const username = await this.getUsername();
```

The `getUsername()` method makes a real API call to `/user`:
```javascript
private async getUsername(): Promise<string> {
  const response = await this.githubRequest('/user');
  if (!response || !response.login) {
    throw new Error('Failed to get GitHub username');
  }
  return response.login;
}
```

---

## Solution

Add the `/user` endpoint mock to ALL tests that use `PortfolioRepoManager.saveElement()`:

### For Simple Mock Setup
```javascript
// Add this as the FIRST mock (before file existence check)
mockFetch.mockResolvedValueOnce({
  ok: true,
  status: 200,
  json: async () => ({ login: 'testuser' })
} as Response);
```

### For mockImplementation Setup
```javascript
mockFetch.mockImplementation(async (url, options) => {
  const urlString = url.toString();
  
  // Mock get authenticated user (needed after Issue #913 fix)
  if (urlString.includes('/user')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ login: 'testuser' })
    } as Response;
  }
  
  // ... rest of mock implementation
});
```

---

## Files Commonly Affected

1. **Unit Tests**
   - `test/__tests__/unit/portfolio/PortfolioRepoManager.test.ts`
   - Any test calling `saveElement()` or `createPortfolio()`

2. **QA Tests**
   - `test/__tests__/qa/portfolio-single-upload.qa.test.ts`
   - `test/__tests__/qa/upload-ziggy-demo.test.ts`
   - Any portfolio upload demos

3. **E2E Tests**
   - `test/e2e/real-github-integration.test.ts`
   - Any test doing real GitHub operations

---

## How to Identify This Issue

### Symptoms
1. Test fails with "Failed to get GitHub username"
2. Error occurs at line 631 in PortfolioRepoManager.ts
3. Test was working before Issue #913 fix
4. Test uses `PortfolioRepoManager.saveElement()`

### Quick Check
```bash
# Find all tests that might need this fix
grep -r "saveElement\|createPortfolio" test/ --include="*.test.ts"

# Check if they mock /user endpoint
grep -r "'/user'" test/ --include="*.test.ts"
```

---

## Complete Fix Example

```javascript
it('should save element to portfolio with user consent', async () => {
  const consent = true;
  const commitUrl = 'https://github.com/testuser/dollhouse-portfolio/commit/abc123';
  
  // CRITICAL: Mock /user endpoint FIRST (Issue #913 fix)
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ login: 'testuser' })
  } as Response);
  
  // Then mock file existence check
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 404,
    json: async () => ({ message: 'Not Found' })
  } as Response);
  
  // Finally mock file creation
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 201,
    json: async () => ({
      commit: { html_url: commitUrl }
    })
  } as Response);

  const url = await manager.saveElement(mockElement, consent);
  expect(url).toBe(commitUrl);
});
```

---

## Prevention

### When Adding Auth Changes
1. Search for ALL tests using the changed methods
2. Update mocks to match new API call patterns
3. Document the mock requirements in test comments

### Test Pattern
Always comment why the `/user` mock is needed:
```javascript
// Mock get authenticated user (needed after Issue #913 fix)
// This prevents using element author as GitHub username
mockFetch.mockResolvedValueOnce({
  ok: true,
  status: 200,
  json: async () => ({ login: 'testuser' })
} as Response);
```

---

## Related Issues

- **Issue #913**: Security fix to use authenticated user instead of element author
- **PR #939**: Fixed Extended Node Compatibility tests with this solution
- **Pattern**: Similar to previous persona author authentication issues

---

## Keywords for Search

- "Failed to get GitHub username"
- "PortfolioRepoManager getUsername"
- "/user endpoint mock"
- "Issue #913"
- "element author GitHub username"

---

*This is a known, solved issue. Apply the solution above when encountered.*