# Real GitHub Integration Tests

## Overview

These are **REAL** integration tests that perform actual GitHub API operations. Unlike mock tests, these tests:
- ✅ Actually upload files to GitHub
- ✅ Verify files exist by downloading them
- ✅ Test real error scenarios with actual API responses
- ✅ Validate the complete user flow end-to-end

## Setup

### 1. Create GitHub Personal Access Token

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Give it a descriptive name: "DollhouseMCP QA Testing"
4. Select scope: `repo` (full control of private repositories)
5. Generate and copy the token

### 2. Configure Test Environment

```bash
# Copy the example config
cp test/e2e/.env.test.local.example test/e2e/.env.test.local

# Edit the file with your token
nano test/e2e/.env.test.local
```

Required configuration:
```env
GITHUB_TEST_TOKEN=ghp_your_actual_token_here
GITHUB_TEST_REPO=yourusername/dollhouse-portfolio-test
GITHUB_TEST_USER=yourusername
```

### 3. Build the Project

```bash
npm run build
```

## Running Tests

### Run All Real Integration Tests

```bash
# Using npm script (recommended)
npm run test:e2e:real

# Or directly with Jest
npx jest test/e2e/real-github-integration.test.ts --verbose
```

### Run Specific Test Suites

```bash
# Single element upload tests only
npx jest test/e2e/real-github-integration.test.ts -t "Single Element Upload"

# Error code validation only
npx jest test/e2e/real-github-integration.test.ts -t "Error Code Validation"

# MCP tool flow tests
npx jest test/e2e/mcp-tool-flow.test.ts --verbose
```

### Run with Custom Configuration

```bash
# Override environment variables
GITHUB_TEST_TOKEN=ghp_xxx TEST_CLEANUP_AFTER=false npm run test:e2e:real

# Verbose logging for debugging
TEST_VERBOSE_LOGGING=true npm run test:e2e:real

# Use different test repository
GITHUB_TEST_REPO=myuser/my-test-repo npm run test:e2e:real
```

## Test Coverage

### 1. Single Element Upload Tests
- ✅ Upload persona to GitHub
- ✅ Verify file exists on GitHub
- ✅ Compare uploaded vs original content
- ✅ Verify URL is accessible (not 404)
- ✅ Handle null commit field (bug fix validation)

### 2. Error Code Validation
- `PORTFOLIO_SYNC_001`: Invalid/expired token
- `PORTFOLIO_SYNC_002`: Repository not found
- `PORTFOLIO_SYNC_003`: Permission denied
- `PORTFOLIO_SYNC_004`: Malformed response
- `PORTFOLIO_SYNC_005`: Network timeout
- `PORTFOLIO_SYNC_006`: Rate limit exceeded

### 3. Bulk Sync Prevention
- ✅ Verify only requested element uploads
- ✅ Private personas stay private
- ✅ No scanning of other directories

### 4. URL Extraction Fallbacks
- ✅ Standard response with commit.html_url
- ✅ Response with null commit field
- ✅ Minimal response data
- ✅ Unexpected response structure

### 5. Complete User Flow
Simulates exact user actions:
1. User has multiple personas (public + private)
2. User uploads only Ziggy persona
3. System uploads to GitHub
4. User verifies it's really there
5. Private personas remain private
6. URL is shareable and working

## Cleanup

### Automatic Cleanup
Tests automatically clean up after themselves if `TEST_CLEANUP_AFTER=true` (default).

### Manual Cleanup
Remove all test files from GitHub:

```bash
# Run cleanup utility
npx tsx test/e2e/cleanup-test-data.ts

# Or use npm script
npm run test:e2e:cleanup
```

## Debugging Failed Tests

### 1. Check Token Validity

```bash
# Test your token
curl -H "Authorization: Bearer YOUR_TOKEN" https://api.github.com/user
```

### 2. Enable Verbose Logging

```bash
TEST_VERBOSE_LOGGING=true npm run test:e2e:real
```

### 3. Disable Cleanup to Inspect Files

```bash
TEST_CLEANUP_AFTER=false npm run test:e2e:real
```

### 4. Check Rate Limits

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://api.github.com/rate_limit
```

## Error Codes Reference

| Code | Description | Common Causes | Fix |
|------|-------------|---------------|-----|
| PORTFOLIO_SYNC_001 | Auth failure | Invalid/expired token | Generate new token |
| PORTFOLIO_SYNC_002 | Repo not found | Wrong repo name | Check GITHUB_TEST_REPO |
| PORTFOLIO_SYNC_003 | Create failed | No permissions | Check token scopes |
| PORTFOLIO_SYNC_004 | Parse error | API changed | Update response parsing |
| PORTFOLIO_SYNC_005 | Network error | Connection issues | Check network/retry |
| PORTFOLIO_SYNC_006 | Rate limited | Too many requests | Wait or increase delays |

## CI/CD Integration

### GitHub Actions Setup

```yaml
name: Real Integration Tests

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build project
        run: npm run build
        
      - name: Run real integration tests
        env:
          GITHUB_TEST_TOKEN: ${{ secrets.GITHUB_TEST_TOKEN }}
          GITHUB_TEST_REPO: ${{ github.repository }}-test
          TEST_CLEANUP_AFTER: true
        run: npm run test:e2e:real
```

### Required Secrets
Add to repository secrets:
- `GITHUB_TEST_TOKEN`: Personal access token with repo scope

## Performance Benchmarks

Expected timings for operations:

| Operation | Expected Time | Max Time |
|-----------|--------------|----------|
| Single upload | 2-5 seconds | 10 seconds |
| File verification | 1-2 seconds | 5 seconds |
| URL check | 1-2 seconds | 5 seconds |
| Complete user flow | 15-30 seconds | 60 seconds |

## Troubleshooting

### "Repository not found"
- Ensure `GITHUB_TEST_REPO` format is `username/repo-name`
- Check token has access to create repositories

### "Rate limit exceeded"
- Default delay between operations: 1 second
- Increase with `TEST_RATE_LIMIT_DELAY_MS=2000`
- Check remaining: `curl -H "Authorization: Bearer TOKEN" https://api.github.com/rate_limit`

### "Timeout errors"
- Increase timeout: `TEST_TIMEOUT_MS=60000`
- Check network connectivity
- Verify GitHub status: https://status.github.com

### "Permission denied"
- Verify token scope includes `repo`
- Check repository permissions
- Ensure branch protection allows pushes

## Best Practices

1. **Always use test repositories** - Never run against production repos
2. **Clean up test data** - Use cleanup utilities or auto-cleanup
3. **Respect rate limits** - Add delays between operations
4. **Use unique prefixes** - Helps identify and clean test data
5. **Monitor token expiry** - Rotate tokens regularly
6. **Test in isolation** - Don't run while other tests use same repo

## Contributing

When adding new tests:
1. Use the test persona factory for consistent test data
2. Track uploaded files for cleanup
3. Add appropriate timeouts for long operations
4. Document new error codes
5. Update this README with new test coverage

## Support

For issues or questions:
1. Check existing issues: https://github.com/DollhouseMCP/mcp-server/issues
2. Review session notes in `docs/development/`
3. Contact the development team

---

*Remember: These are REAL tests that create REAL data on GitHub. Always use test repositories and clean up after testing!*