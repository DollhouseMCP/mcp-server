# CI Environment Variables

This document lists environment variables that can be configured in CI/CD pipelines to customize test behavior.

## Test Configuration

### `TOOLCACHE_THRESHOLD_MS`

**Purpose**: Controls the performance threshold for ToolCache tests.

**Default Values**:
- Windows: `2` (2ms)
- Other platforms: `1` (1ms)

**Usage**: Set this variable when CI runners are slower than expected and causing false test failures.

**Example in GitHub Actions**:
```yaml
- name: Run tests
  env:
    TOOLCACHE_THRESHOLD_MS: 3  # Increase threshold to 3ms for slower runners
  run: npm test
```

**Example in Local Testing**:
```bash
# For debugging slow test environments
TOOLCACHE_THRESHOLD_MS=5 npm test
```

**When to Adjust**:
- If you see failures in `test/__tests__/unit/utils/ToolCache.test.ts` with errors like "Expected: < 1, Received: 1.05"
- When running tests on resource-constrained CI runners
- During local development on slower machines

## Standard CI Variables

### `CI`

**Purpose**: Indicates the code is running in a CI environment.

**Effect**:
- Skips certain flaky tests that don't work well in parallel CI runs
- Example: `real-github-integration.test.ts` skips tests that conflict with concurrent runs

**Set by**: Most CI systems set this automatically (GitHub Actions, CircleCI, Jenkins, etc.)

### `NODE_OPTIONS`

**Purpose**: Configure Node.js runtime options.

**Common Settings**:
```bash
NODE_OPTIONS="--max-old-space-size=4096 --experimental-vm-modules"
```

### `TEST_PERSONAS_DIR`

**Purpose**: Specifies the directory for test personas.

**Default**: `./test-personas`

**Usage**: Set when running tests in different environments or with custom test data locations.

## Troubleshooting

### Performance Test Failures

If you see consistent failures in performance tests:

1. Check if the failures are platform-specific (Windows tends to be slower)
2. Try increasing `TOOLCACHE_THRESHOLD_MS`:
   ```bash
   TOOLCACHE_THRESHOLD_MS=5 npm test
   ```
3. If the issue persists in CI, update the workflow file to set the environment variable

### GitHub API 409 Conflicts

These occur when multiple CI runs try to modify the same test repository simultaneously. The affected tests are automatically skipped when `CI=true`.

## Adding New Environment Variables

When adding new environment variables for test configuration:

1. Use descriptive names with appropriate suffixes (e.g., `_MS` for milliseconds, `_TIMEOUT` for timeouts)
2. Document the variable in this file
3. Provide sensible defaults in the code
4. Add examples for both CI and local usage

---

*Last Updated: September 2025*