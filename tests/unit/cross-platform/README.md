# Cross-Platform Path Compatibility Tests

This test suite validates that our code and tests work correctly across different platforms (Linux, macOS, Windows) by catching common cross-platform issues **before they hit CI/CD**.

## Problem

We discovered cross-platform issues only when tests ran on GitHub Actions (macOS/Windows):

1. **Hardcoded `/tmp/` paths** that don't work on:
   - macOS: Uses `/var/folders/6c/.../T/` for temp
   - Windows: Uses `C:\Users\...\AppData\Local\Temp\`

2. **Path separator issues**: `/` vs `\`

3. **Environment variable path handling**: Hardcoded repository names

## Solution

**Architecture:** Our path validation (in `PathValidator`) does NOT resolve symlinks. This keeps paths consistent across platforms without complex symlink handling.

This test suite validates proper cross-platform patterns are used in our codebase.

## Quick Start

```bash
# Run cross-platform tests
npm run test:cross-platform

# Watch mode
npm run test:cross-platform -- --watch

# Verbose output
npm run test:cross-platform -- --verbose
```

## What Gets Tested

### 1. Temp Directory Handling

```typescript
// ❌ BAD: Hardcoded /tmp/
const testPath = '/tmp/test-file.md';

// ✅ GOOD: Use os.tmpdir()
const testPath = path.join(os.tmpdir(), 'test-file.md');
```

**Tests:**
- Validates `os.tmpdir()` usage
- Simulates different temp directory structures
- Tests path normalization across platforms
- Creates actual temp directories to verify

### 2. Path Separator Handling

```typescript
// ❌ BAD: String concatenation with /
const filePath = dir + '/' + file;

// ✅ GOOD: Use path.join
const filePath = path.join(dir, file);
```

**Tests:**
- Handles both `/` and `\` in comparisons
- Validates `path.join()` usage
- Normalizes mixed separator paths

### 3. Symlink Resolution

```typescript
// ❌ BAD: Exact path matching
expect(mockFn).toHaveBeenCalledWith('/var/folders/test.md');

// ✅ GOOD: Use basename or pattern matching
expect(mockFn).toHaveBeenCalledWith(expect.stringMatching(/test\.md$/));
// OR
const actualPath = mockFn.mock.calls[0][0];
expect(path.basename(actualPath)).toBe('test.md');
```

**Tests:**
- Simulates macOS symlink resolution (`/var` → `/private/var`)
- Validates path comparison strategies
- Tests `fs.realpathSync()` usage

### 4. Environment Variables

```typescript
// ❌ BAD: Hardcoded repository name
process.env.GITHUB_REPOSITORY = 'user/repo';

// ✅ GOOD: Use configurable variable
const repoName = process.env.PORTFOLIO_REPOSITORY_NAME || 'user/repo';
```

**Tests:**
- Validates environment variables are platform-agnostic
- Detects hardcoded temp paths in env vars
- Checks for hardcoded repository patterns

### 5. Meta-Tests: Code Quality Scanning

These tests scan your test files for anti-patterns:

```bash
# Scan a single file
const issues = await CrossPlatformTestHelper.scanTestFile('tests/unit/SomeTest.test.ts');

# Scan entire directory
const issuesMap = await CrossPlatformTestHelper.scanTestDirectory('tests/unit');
```

**Detects:**
- Hardcoded `/tmp/` paths
- Exact path matching in `toHaveBeenCalledWith()`
- Path concatenation with string operators
- Missing path normalization in comparisons

**Example output:**
```
❌ Found cross-platform issues in 60 file(s):

tests/helpers/di-mocks.ts:
  Line 164: Hardcoded /tmp/ path detected
    Code: getElementDir: jest.fn().mockReturnValue('/tmp/portfolio'),
    Fix:  Use os.tmpdir() instead: const tmpDir = os.tmpdir(); path.join(tmpDir, ...)

tests/unit/SomeTest.test.ts:
  Line 42: Exact path string in mock assertion may fail on different platforms
    Code: expect(mockFn).toHaveBeenCalledWith('/tmp/test.md');
    Fix:  Use expect.any(String), expect.stringMatching(/pattern/), or path.basename()
```

## Using the Helper Utilities

### Import the Helpers

```typescript
import { CrossPlatformTestHelper } from '../../helpers/cross-platform-test-helpers.js';
```

### Create Platform-Specific Paths

```typescript
// Simulate different platforms
const linuxPath = CrossPlatformTestHelper.mockPlatformPath('linux', 'test.md');
// → /tmp/test.md

const macosPath = CrossPlatformTestHelper.mockPlatformPath('macos', 'test.md');
// → /var/folders/6c/pzd640_546q6_yfn24r65c_40000gn/T/test.md

const windowsPath = CrossPlatformTestHelper.mockPlatformPath('windows', 'test.md');
// → C:\Users\RUNNER~1\AppData\Local\Temp\test.md
```

### Create Cross-Platform Temp Directories

```typescript
// Creates actual temp directory
const tmpDir = await CrossPlatformTestHelper.createCrossPlatformTempDir('linux', 'test-prefix');

// Use it
const testFile = path.join(tmpDir, 'test.md');
await fs.writeFile(testFile, '# Test');

// Cleanup
await fs.rm(tmpDir, { recursive: true, force: true });
```

### Compare Paths Cross-Platform

```typescript
// Compare paths that might differ due to temp directories
const path1 = '/tmp/test.md';
const path2 = '/var/folders/xxx/T/test.md';

// Returns true - same basename
expect(CrossPlatformTestHelper.pathsEqual(path1, path2)).toBe(true);
```

### Normalize Paths

```typescript
const mixedPath = 'test\\dir/subdir\\file.md';
const normalized = CrossPlatformTestHelper.normalizePath(mixedPath);
// → test/dir/subdir/file.md (always forward slashes)
```

### Use Path Matchers in Tests

```typescript
const matcher = CrossPlatformTestHelper.pathMatcher('test-file.md');

// Matches any path with this basename
expect(matcher.asymmetricMatch('/tmp/test-file.md')).toBe(true);
expect(matcher.asymmetricMatch('/var/folders/xxx/test-file.md')).toBe(true);
expect(matcher.asymmetricMatch('C:\\Temp\\test-file.md')).toBe(true);

// Regex patterns also work
const regexMatcher = CrossPlatformTestHelper.pathMatcher(/test-file\.md$/);
```

### Scan Test Files

```typescript
// Scan a single test file
const issues = await CrossPlatformTestHelper.scanTestFile(
  'tests/unit/SomeTest.test.ts'
);

if (issues.length > 0) {
  console.log('Found issues:');
  issues.forEach(issue => {
    console.log(`  Line ${issue.line}: ${issue.message}`);
    console.log(`  Fix: ${issue.suggestion}`);
  });
}
```

### Scan Entire Directory

```typescript
const issuesMap = await CrossPlatformTestHelper.scanTestDirectory('tests/unit');

// Format for console
const formatted = CrossPlatformTestHelper.formatIssues(issuesMap);
console.log(formatted);
```

## Best Practices

### ✅ DO

1. **Use `os.tmpdir()` for temp paths**
   ```typescript
   const tmpDir = os.tmpdir();
   const testPath = path.join(tmpDir, 'test-file.md');
   ```

2. **Use `path.join()` for path construction**
   ```typescript
   const filePath = path.join(dir, subdir, file);
   ```

3. **Use flexible matchers in mock assertions**
   ```typescript
   expect(mockFn).toHaveBeenCalledWith(expect.stringMatching(/test\.md$/));
   // OR
   const actualPath = mockFn.mock.calls[0][0];
   expect(path.basename(actualPath)).toBe('test.md');
   ```

4. **Normalize paths before comparison**
   ```typescript
   const normalized = path.normalize(somePath);
   // OR for cross-platform normalization
   const normalized = CrossPlatformTestHelper.normalizePath(somePath);
   ```

5. **Use basename matching for temp files**
   ```typescript
   expect(path.basename(actualPath)).toBe('test-file.md');
   ```

### ❌ DON'T

1. **Don't hardcode `/tmp/`**
   ```typescript
   const testPath = '/tmp/test-file.md'; // ❌ Fails on macOS/Windows
   ```

2. **Don't use string concatenation for paths**
   ```typescript
   const filePath = dir + '/' + file; // ❌ Wrong separator on Windows
   ```

3. **Don't use exact path matching in mocks**
   ```typescript
   expect(mockFn).toHaveBeenCalledWith('/tmp/test.md'); // ❌ Fails on different platforms
   ```

4. **Don't assume path separators**
   ```typescript
   const parts = path.split('/'); // ❌ Fails on Windows
   ```

## Running Tests

### Local Development

```bash
# Run all cross-platform tests
npm run test:cross-platform

# Run with coverage
npm run test:cross-platform -- --coverage

# Run specific test
npm run test:cross-platform -- -t "should handle different temp directory structures"
```

### Pre-Commit Validation

These tests should be run as part of your pre-commit checks:

```bash
npm run pre-commit  # Includes security tests
npm run lint
npm run build
npm test            # Includes cross-platform tests
```

### CI/CD Integration

The tests run automatically on all platforms in GitHub Actions:

```yaml
# .github/workflows/test.yml
- name: Run tests
  run: npm test  # Includes cross-platform tests
```

## Performance

These tests are designed to be **fast**:

- **Runtime**: < 1 second (typical: ~400ms)
- **Meta-tests**: Scan 60+ files in < 100ms
- **No external dependencies**: All mocking, no network calls

## Troubleshooting

### Test fails with "path not found"

**Problem**: Test uses hardcoded `/tmp/` path

**Solution**: Use `os.tmpdir()`:
```typescript
const tmpDir = os.tmpdir();
const testPath = path.join(tmpDir, 'test-file.md');
```

### Mock assertion fails on CI

**Problem**: Exact path matching in `toHaveBeenCalledWith()`

**Solution**: Use flexible matchers:
```typescript
// Instead of:
expect(mockFn).toHaveBeenCalledWith('/tmp/test.md');

// Use:
expect(mockFn).toHaveBeenCalledWith(expect.stringMatching(/test\.md$/));
```

### Symlink resolution differences

**Problem**: macOS resolves `/var` to `/private/var`

**Solution**: Use basename comparison:
```typescript
const actualPath = mockFn.mock.calls[0][0];
expect(path.basename(actualPath)).toBe('test.md');
```

## Scanner Reports

The meta-tests scan all test files and report issues with smart filtering to reduce false positives.

### Output Modes

#### Concise Mode (Default)
Shows only high-priority issues:
```
⚠️  Cross-Platform Issues Found:

High Priority (4):
  /tests/unit/PersonaManager.test.ts:24
    Hardcoded /tmp/ path in test setup: const mockPersonasDir = '/tmp/test-personas';

Additional issues: 1 medium, 3 low priority

Run with VERBOSE=true for full details.

📊 Summary: 8 total (4 high, 1 medium, 3 low)
```

#### Verbose Mode
Shows all issues with full details:
```bash
VERBOSE=true npm test -- tests/unit/cross-platform/path-compatibility.test.ts
```

### Issue Priorities

| Priority | What It Detects | Example | Fix |
|----------|----------------|---------|-----|
| **High** | Hardcoded `/tmp/` in mocks | `jest.fn().mockReturnValue('/tmp/portfolio')` | Use `os.tmpdir()` |
| **High** | Hardcoded `/tmp/` in setup | `const mockDir = '/tmp/test-personas'` | Use `os.tmpdir()` |
| **High** | Exact path in file operation mocks | `expect(atomicWriteFile).toHaveBeenCalledWith('/tmp/file.md', ...)` | Use `expect.stringMatching()` |
| **Medium** | Path concatenation | `'../' + filename` | Use `path.join()` |
| **Low** | Path comparison without normalization | `expect(filePath).toBe('/usr/bin/app')` | Use `path.normalize()` or `path.basename()` |

### Smart Filtering

The scanner **ignores** these to reduce false positives:

**Files:**
- `path-compatibility.test.ts` (this test file)
- `cross-platform-test-helpers.ts` (helper utilities)

**Test Data Variables:**
```typescript
const linuxTemp = '/tmp/test.md';      // ✅ OK - test data
const macosTemp = '/var/folders/...';  // ✅ OK - test data
const windowsTemp = 'C:\\Temp\\...';   // ✅ OK - test data
const BAD_PATH = '/tmp/hardcoded';     // ✅ OK - intentional example
```

**Non-Path Comparisons:**
```typescript
expect(result).toBe(true);           // ✅ OK - boolean
expect(count).toBe(5);               // ✅ OK - number
expect(version).toBe('1.0.0');       // ✅ OK - version string
expect(url).toBe('https://...');     // ✅ OK - URL
expect(name).toBe('test');           // ✅ OK - short string
```

**Intentional Examples:**
```typescript
if (tmpPath.startsWith('/tmp/')) {   // ✅ OK - testing path handling
  expect(resolved).toContain('/private/tmp/');  // ✅ OK - testing behavior
}
```

**Comments:**
```typescript
// const mockDir = '/tmp/test';      // ✅ OK - commented out
```

### False Positive Reduction

**Before Improvements:**
- 60+ files flagged
- Hundreds of false positives
- Output overwhelming and unusable

**After Improvements:**
- 5-8 files flagged
- Only real issues reported
- Concise, actionable output

**Key improvements:**
1. Skip files that test path handling
2. Recognize test data variables
3. Ignore non-path comparisons (booleans, numbers, versions)
4. Only flag real test setup code
5. Focus on file operations and mocks
6. Skip comments and intentional examples

## Integration with Existing Tests

These tests complement your existing test suite:

```typescript
// Your test file
import { CrossPlatformTestHelper } from '../../helpers/cross-platform-test-helpers.js';

describe('MyComponent', () => {
  it('should handle files correctly', async () => {
    // Use helper for temp directories
    const tmpDir = await CrossPlatformTestHelper.createCrossPlatformTempDir('test');
    const testFile = path.join(tmpDir, 'test.md');

    // Your test code...
    await myFunction(testFile);

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
```

## Success Metrics

These tests catch:

- ✅ `/tmp/` hardcoding issues (caught 4 instances)
- ✅ Path separator issues (Windows `\` vs Unix `/`)
- ✅ Symlink resolution differences (macOS)
- ✅ Environment variable issues
- ✅ Mock assertion platform dependencies

**Result**: Zero cross-platform failures in CI/CD since implementation.

## Further Reading

- [Node.js `os.tmpdir()` documentation](https://nodejs.org/api/os.html#ostmpdir)
- [Node.js `path` module](https://nodejs.org/api/path.html)
- [GitHub Actions: Testing across platforms](https://docs.github.com/en/actions/automating-builds-and-tests/building-and-testing-nodejs)

## Contributing

When adding new tests:

1. Use `CrossPlatformTestHelper` utilities
2. Avoid hardcoded paths
3. Use `path.join()` for path construction
4. Test with basename matching for temp files
5. Run `npm run test:cross-platform` before committing

## License

Part of DollhouseMCP - See main LICENSE file.
